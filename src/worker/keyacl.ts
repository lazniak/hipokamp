// Uprawnienia klucza workera (T-17): tylko bieżący użytkownik. POSIX: plik 0600 i katalog 0700 (auth.ts, bez
// procesów). Windows: ACL przez icacls, czyli procesy potomne, więc NIGDY w workerze (zasada 2). Woła to klient
// tuż przed startem workera (spawnWorker: hook, serwer MCP, CLI, także restart w `hipokamp update`) i
// `hipokamp install`; `hipokamp doctor` tylko sprawdza. Klucz, który utworzył sam worker (start ręczny), dostaje ACL
// przy najbliższej z tych okazji; do tego czasu chroni go ACL katalogu domowego (profil użytkownika Windows nie jest
// czytelny dla innych kont).
//
// Programy z System32 po pełnej ścieżce: hooki działają w Git Bash, gdzie `whoami` z PATH to coreutils (nie zna
// `/user`). Wszystkie wywołania jednej operacji dzielą twardy termin (w hooku 1,5 s), a sprawdzenie idzie po SID
// (`icacls /save`, SDDL), nie po nazwie konta: nazwa z konsoli zależy od strony kodowej i języka systemu.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readKey, restrictPosix } from "./auth.ts";

const WIN = process.platform === "win32";
const SYS32 = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");
const ICACLS = join(SYS32, "icacls.exe");
const WHOAMI = join(SYS32, "whoami.exe");

/** Domyślny termin całej operacji poza hookiem (doctor, install): mieści trzy próby `whoami` i icacls (T-45). */
export const DEFAULT_BUDGET_MS = 15_000;
/** Próby `whoami /user` poza terminem hooka (T-45): zaraz po restarcie workera pojedyncze wywołanie raz zawiodło. */
export const WHOAMI_TRIES = 3;
/** Przerwa przed kolejną próbą: 200 ms, potem 400 ms (zawsze w granicach terminu operacji). */
const WHOAMI_PAUSE_MS = 200;
/** Część terminu operacji zostawiona na icacls (nadanie i sprawdzenie ACL), której próby whoami nie zjedzą. */
const ICACLS_RESERVE_MS = 3000;
/** Termin w hooku i przy starcie workera z klienta: pierwsze nadanie ACL to ok. 0,2 do 0,5 s (pomiar 2026-10-06). */
export const HOOK_BUDGET_MS = 1500;
/** Po nieudanej próbie następna dopiero po tym czasie (znacznik `<klucz>.acl-fail`), żeby hook nie płacił co raz. */
export const RETRY_AFTER_MS = 10 * 60_000;

/** Termin wspólny dla wszystkich procesów jednej operacji: każde wywołanie dostaje tylko resztę czasu. */
class Deadline {
  private readonly until: number;
  constructor(readonly ms: number) {
    this.until = Date.now() + ms;
  }
  left(): number {
    return this.until - Date.now();
  }
}

/** Program z terminem; null, gdy termin już minął albo program nie skończył się w nim. */
function run(cmd: string, args: string[], dl: Deadline): { status: number | null; stdout: string } | null {
  const left = dl.left();
  if (left < 50) return null;
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: left, shell: false });
  if (r.error || r.signal) return null;
  return { status: r.status, stdout: r.stdout ?? "" };
}

let mySid: string | undefined;

/** Jedno wywołanie `whoami`: wynik albo powód porażki (do komunikatu w doctor). */
export type WhoamiRun = { status: number | null; stdout: string } | { why: string };

function whoamiOnce(timeoutMs: number): WhoamiRun {
  const r = spawnSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    shell: false,
  });
  if (r.error) return { why: (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "limit czasu" : String(r.error) };
  if (r.signal) return { why: `przerwane (${r.signal})` };
  return { status: r.status, stdout: r.stdout ?? "" };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Plan prób whoami dla terminu operacji (T-45). W terminie hooka (do HOOK_BUDGET_MS) jedna próba z całym terminem
 * jak dotąd: hook nie czeka na ponowienia, a po porażce następna próba i tak idzie dopiero za RETRY_AFTER_MS.
 * Poza hookiem (doctor, install) WHOAMI_TRIES prób, a limit jednej to reszta terminu po odjęciu zapasu na icacls i
 * przerw, podzielona na próby: nawet trzy zawieszone próby zostawiają icacls ICACLS_RESERVE_MS.
 */
export function whoamiPlan(budgetMs: number): { tries: number; tryMs: number } {
  if (budgetMs <= HOOK_BUDGET_MS) return { tries: 1, tryMs: budgetMs };
  const pauses = WHOAMI_PAUSE_MS * ((WHOAMI_TRIES * (WHOAMI_TRIES - 1)) / 2);
  return { tries: WHOAMI_TRIES, tryMs: Math.max(50, Math.floor((budgetMs - ICACLS_RESERVE_MS - pauses) / WHOAMI_TRIES)) };
}

/**
 * SID z `whoami /user /fo csv /nh` z ponowieniem (T-45): do `plan.tries` prób, każda najwyżej `plan.tryMs` i tylko
 * w pozostałym czasie operacji, z rosnącą przerwą. `once` i `pause` podmienia test. Zwraca SID albo powód ostatniej
 * porażki z liczbą prób.
 */
export function lookupSid(
  once: (timeoutMs: number) => WhoamiRun,
  left: () => number,
  plan: { tries: number; tryMs: number },
  pause: (ms: number) => void = sleepSync,
): { sid: string } | { why: string } {
  let why = "termin minął przed wywołaniem";
  let made = 0;
  for (let i = 0; i < plan.tries; i++) {
    if (i > 0) {
      const wait = Math.min(WHOAMI_PAUSE_MS * i, left() - 50);
      if (wait < 0) break;
      pause(wait);
    }
    const t = Math.min(plan.tryMs, left());
    if (t < 50) break;
    made++;
    const r = once(t);
    if ("why" in r) {
      why = r.why;
      continue;
    }
    const m = /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/m.exec(r.stdout);
    if (m) return { sid: m[1] };
    why = r.status === 0 ? "brak SID w wyniku" : `kod ${r.status ?? "?"}`;
  }
  return { why: `${why}, prób: ${made}` };
}

/** SID bieżącego użytkownika (zapamiętany w procesie po sukcesie) albo powód porażki do komunikatu. */
function currentSid(dl: Deadline): { sid: string } | { why: string } {
  if (mySid) return { sid: mySid };
  const r = lookupSid(whoamiOnce, () => dl.left(), whoamiPlan(dl.ms));
  if ("sid" in r) mySid = r.sid;
  return r;
}

const noSid = (why: string): AclState => ({ ok: false, detail: `nie znam SID bieżącego użytkownika (whoami /user: ${why})` });

export interface Ace {
  type: string;
  flags: string;
  rights: string;
  sid: string;
}

/**
 * DACL z SDDL (`icacls <plik> /save`: nazwa pliku, potem linia `D:<flagi>(A;flagi;prawa;;;SID)…`). `protected`:
 * flaga P, czyli bez dziedziczenia z katalogu. Konta wbudowane mają skróty (SY, BA), zwykłe konta pełny SID.
 */
export function parseSddl(text: string): { protected: boolean; aces: Ace[] } | null {
  const m = /D:([A-Z]*)((?:\([^()]*\))*)/.exec(text);
  if (!m) return null;
  const aces = [...m[2].matchAll(/\(([^()]*)\)/g)].map((x) => {
    const f = x[1].split(";");
    return { type: f[0] ?? "", flags: f[1] ?? "", rights: f[2] ?? "", sid: f[5] ?? "" };
  });
  return { protected: m[1].includes("P"), aces };
}

export interface AclState {
  ok: boolean;
  detail: string;
}

/**
 * Ocena DACL: jedyne wpisy zezwalające należą do `sid`, żaden nie jest dziedziczony (flaga ID), a dziedziczenie z
 * katalogu jest wyłączone (P). Wpisy odmowy niczego nie otwierają, więc nie przeszkadzają.
 */
export function judgeDacl(acl: { protected: boolean; aces: Ace[] } | null, sid: string): AclState {
  if (!acl) return { ok: false, detail: "nie umiem odczytać ACL (SDDL)" };
  const allow = acl.aces.filter((a) => a.type === "A");
  const others = allow.filter((a) => a.sid !== sid);
  const inherited = acl.aces.some((a) => a.flags.includes("ID"));
  const ok = allow.length > 0 && !others.length && !inherited && acl.protected;
  if (ok) return { ok, detail: "tylko bieżący użytkownik" };
  const list = acl.aces.map(
    (a) => `${a.sid === sid ? "ty" : a.sid}:${a.type}:${a.rights}${a.flags.includes("ID") ? "(dziedziczony)" : ""}`,
  );
  return {
    ok,
    detail: `wpisy: ${list.join(", ") || "brak"}${acl.protected ? "" : ", dziedziczenie z katalogu włączone"}`,
  };
}

/** Czy klucz czyta tylko bieżący użytkownik: POSIX bez bitów grupy i innych, Windows po SID z `icacls /save`. */
export function checkKeyAcl(file: string, budgetMs = DEFAULT_BUDGET_MS): AclState {
  if (!WIN) {
    try {
      const mode = statSync(file).mode & 0o777;
      return { ok: (mode & 0o077) === 0, detail: `tryb ${mode.toString(8).padStart(3, "0")}` };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }
  return checkWin(file, new Deadline(budgetMs));
}

function checkWin(file: string, dl: Deadline): AclState {
  const who = currentSid(dl);
  if ("why" in who) return noSid(who.why);
  const sid = who.sid;
  // zrzut ACL obok klucza (katalog stanu tylko dla użytkownika), unikalna nazwa, zawsze sprzątany
  const out = join(dirname(file), `.acl-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    const r = run(ICACLS, [file, "/save", out], dl);
    if (!r) return { ok: false, detail: "icacls /save: limit czasu" };
    if (r.status !== 0) return { ok: false, detail: `icacls /save: kod ${r.status ?? "?"}` };
    const raw = readFileSync(out);
    // icacls zapisuje UTF-16LE (bez BOM)
    return judgeDacl(parseSddl(raw.toString(raw[1] === 0 ? "utf16le" : "utf8")), sid);
  } catch (e) {
    return { ok: false, detail: String(e) };
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}

/**
 * ACL klucza tylko dla bieżącego użytkownika. Windows: najpierw jawne pełne prawo dla użytkownika (po SID), dopiero
 * potem zdjęcie dziedziczenia, więc nieudany pierwszy krok nie zostawia pliku bez dostępu; gdy po zmianie klucza nie
 * da się przeczytać, dziedziczenie wraca (`/reset`). Wszystko w jednym terminie `budgetMs`.
 */
export function hardenKey(file: string, budgetMs = DEFAULT_BUDGET_MS): AclState {
  if (!WIN) {
    restrictPosix(file);
    return checkKeyAcl(file);
  }
  const dl = new Deadline(budgetMs);
  const who = currentSid(dl);
  if ("why" in who) return noSid(who.why);
  const sid = who.sid;
  const g = run(ICACLS, [file, "/grant:r", `*${sid}:F`], dl);
  if (!g) return { ok: false, detail: "icacls /grant: limit czasu" };
  if (g.status !== 0) return { ok: false, detail: `icacls /grant: kod ${g.status ?? "?"}` };
  const i = run(ICACLS, [file, "/inheritance:r"], dl);
  if (!i) return { ok: false, detail: "icacls /inheritance:r: limit czasu albo przerwane" };
  if (i.status !== 0) return { ok: false, detail: `icacls /inheritance:r: kod ${i.status ?? "?"}` };
  if (!readKey(file)) {
    // bez terminu: przywrócenie dostępu ważniejsze niż czas hooka, a /reset na jednym pliku to kilkadziesiąt ms
    spawnSync(ICACLS, [file, "/reset"], { windowsHide: true, timeout: 5000 });
    return { ok: false, detail: "po zmianie ACL klucz był nieczytelny, przywrócono dziedziczenie" };
  }
  return checkWin(file, dl);
}

const fingerprint = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32);

/**
 * hardenKey raz na klucz: znacznik `<klucz>.acl` z odciskiem treści klucza. Start workera nie płaci więc za icacls
 * (ok. 0,2 do 0,5 s na Windows przy pierwszym razie) za każdym razem, a nowy klucz (np. po uszkodzeniu) dostaje ACL
 * od nowa. Nieudana próba zostawia znacznik `<klucz>.acl-fail` (odcisk i czas): ten sam klucz próbuje się ponownie
 * dopiero po RETRY_AFTER_MS, więc hook nie płaci przy każdym zdarzeniu. `force` (install): zawsze, bez patrzenia na
 * znaczniki. null: pominięte, bo znacznik pasuje.
 */
export function hardenKeyOnce(file: string, force = false, budgetMs = HOOK_BUDGET_MS): AclState | null {
  const mark = `${file}.acl`;
  const fail = `${file}.acl-fail`;
  try {
    const fp = fingerprint(file);
    if (!force) {
      try {
        if (readFileSync(mark, "utf8").trim() === fp) return null;
      } catch {}
      try {
        const f = JSON.parse(readFileSync(fail, "utf8"));
        if (f?.fp === fp && Date.now() - Number(f.at) < RETRY_AFTER_MS) return null;
      } catch {}
    }
    const st = hardenKey(file, budgetMs);
    if (st.ok) {
      writeFileSync(mark, `${fp}\n`);
      try {
        unlinkSync(fail);
      } catch {}
    } else writeFileSync(fail, JSON.stringify({ fp, at: Date.now(), detail: st.detail }));
    return st;
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
