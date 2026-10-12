// Strona bazy przy synchronizacji: zbieranie własnych zmian do wysłania i stosowanie operacji z huba.
// Wyjątek od zasady „SQL tylko w repo.ts” (jak importery): sync wstawia wiersze z numerami innych komputerów, pilnuje
// licznika sqlite_sequence i prowadzi własne tabele (migracja synchronizacji w schema.ts: sync_map, sync_sessions,
// sync_status, sync_status_at). Notatki, prompty, podsumowania i wpisy list pracy wstawia przez Repo (FTS, encje),
// a własny SQL tylko czyta albo zmienia to, czego Repo nie ma (status z dowolnym celem scalenia, sesja z cudzymi
// polami, rejestry).
//
// Model (docs/SYNC.md): operacje są idempotentne (drugi raz nic nie zmieniają), notatki niezmienne, a status notatki
// to rejestr LWW: wygrywa późniejszy zegar hybrydowy, remis rozstrzyga numer urządzenia (część zegara). Każde pole
// tekstowe (poza content_hash, a gid i zegar mają sztywny format) przechodzi przez clean() przy wysyłce i przy
// odbiorze: urządzenie ze starszymi regułami albo bez redakcji nie rozniesie sekretu po innych bazach. Operacja z sieci
// przechodzi pełną kontrolę typów pól (OP_SCHEMA) i stosuje się w osobnym SAVEPOINT: zła operacja jest odrzucana,
// a reszta wpisu i odbiór idą dalej.
import { hostname } from "node:os";
import { z } from "zod";
import { clean } from "../capture/redact.ts";
import { getMeta, setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { NATIVE_ID_BASE } from "../db/schema.ts";
import type { EntityRef, NewObservation } from "../types.ts";
import { sha1 } from "../util/text.ts";
import { MAX_DEVICE, validDevice } from "./protocol.ts";

/** Przestrzeń numerów notatek i podsumowań urządzenia: 100 mln numerów na urządzenie. */
export const DEVICE_SPAN = 100_000_000;

/**
 * Własne numery urządzenia. Urządzenie 1 (to, na którym zrobiono `sync init`, zwykle stacja główna) zostaje przy
 * dotychczasowych numerach od 10 000 001; urządzenie n ≥ 2 dostaje n·10⁸ + 1 … (n+1)·10⁸, więc z numeru widać źródło.
 * Numer spoza 1 … MAX_DEVICE (np. podany przez hub) nie ma przestrzeni: wyjątek, zanim cokolwiek zmieni licznik.
 */
export function idRange(device: number): { lo: number; hi: number } {
  if (!validDevice(device)) throw new Error(`niepoprawny numer urządzenia: ${String(device).slice(0, 24)}`);
  if (device === 1) return { lo: NATIVE_ID_BASE + 1, hi: DEVICE_SPAN };
  return { lo: device * DEVICE_SPAN + 1, hi: (device + 1) * DEVICE_SPAN };
}

// ---------- numery urządzeń znane tej bazie ----------

const MAXDEV_KEY = "sync_max_device";
const OWN_KEY = "sync_own_devices";

/** Numery, pod którymi ta baza była w grupie (ostatni to obecny). */
export function ownDevices(repo: Repo): number[] {
  try {
    const v = JSON.parse(getMeta(repo.db, OWN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => validDevice(x)) : [];
  } catch {
    return [];
  }
}

/**
 * Najwyższy numer urządzenia znany tej bazie z huba: własne numery, urządzenia z odebranych wpisów, z listy urządzeń
 * i z zatwierdzeń. `deep`: także pochodzenie wierszy w mapie gid i sesji (pełny przegląd, tylko przy dołączaniu).
 */
export function knownMaxDevice(repo: Repo, deep = false): number {
  let m = Math.max(0, Number(getMeta(repo.db, MAXDEV_KEY) ?? 0) || 0, ...ownDevices(repo));
  if (deep) {
    const q = (sql: string) => (repo.db.query(sql).get() as { m: number | null } | null)?.m ?? 0;
    m = Math.max(m, q("SELECT MAX(origin) m FROM sync_map"), q("SELECT MAX(origin) m FROM sync_sessions"));
  }
  return Math.min(m, MAX_DEVICE);
}

/** Ta baza zna urządzenie o tym numerze (z odpowiedzi huba). */
export function noteDevice(repo: Repo, n: number): void {
  if (validDevice(n) && n > (Number(getMeta(repo.db, MAXDEV_KEY) ?? 0) || 0)) setMeta(repo.db, MAXDEV_KEY, String(n));
}

/**
 * Najniższy numer urządzenia, jaki ta baza może przyjąć przy dołączaniu: jej licznik notatek musi się zmieścić w
 * przestrzeni numeru (baza, która była już urządzeniem n, ma licznik w n·10⁸ …), a numer musi być większy od każdego,
 * jaki zna z wcześniejszej przynależności.
 */
export function minDeviceFor(repo: Repo): number {
  const s = Math.max(seqOf(repo, "observations"), seqOf(repo, "summaries"));
  return Math.min(MAX_DEVICE, Math.max(2, Math.ceil(s / DEVICE_SPAN) - 1, knownMaxDevice(repo, true) + 1));
}

/** Licznik notatek albo podsumowań poza przestrzenią numerów urządzenia (opis problemu) albo null. */
export function ownRangeProblem(repo: Repo, device: number): string | null {
  const { lo, hi } = idRange(device);
  for (const t of ["observations", "summaries"]) {
    const s = seqOf(repo, t);
    if (s > hi) return `licznik ${t} (${s}) poza przestrzenią numerów urządzenia ${device} (${lo}…${hi})`;
  }
  return null;
}

/**
 * Członkostwo tej bazy pod numerem `device` (init albo dołączenie). Ta sama baza dołączona drugi raz pod nowym
 * numerem (hub przywrócony z kopii zapomniał ją, odcięcie i powrót): własne wiersze z poprzednich numerów tracą wpis
 * w mapie gid i idą do huba jeszcze raz pod nowym numerem (gid z prefiksem nadawcy, inaczej odbiorcy by je odrzucili),
 * a własne sesje dostają nowe pochodzenie. Odbiorcy, którzy już je mają, rozpoznają je po numerze i treści (jeden
 * wiersz), więc nic się nie dubluje, a hub odzyskuje to, co zgubił.
 * Przy okazji identyfikator instalacji (`newInstall`, zob. foreignInstallId) dostaje nowy, gdy baza przyszła
 * z innego komputera.
 */
export function adoptMembership(repo: Repo, device: number, host = hostname()): { rows: number; newInstall: boolean } {
  idRange(device);
  return repo.db
    .transaction(() => {
      const newInstall = foreignInstallId(repo, host);
      if (newInstall) repo.db.run("DELETE FROM meta WHERE k = ?", [INSTALL_KEY]);
      const prev = ownDevices(repo).filter((d) => d !== device);
      let rows = 0;
      if (prev.length) {
        const list = prev.map(() => "?").join(",");
        rows = repo.db.run(
          `DELETE FROM sync_map WHERE origin IN (${list}) AND kind IN ('obs', 'prompt', 'sum', 'ws')`,
          prev,
        ).changes;
        repo.db.run(`UPDATE sync_sessions SET origin = ?, hash = '', hlc = NULL WHERE origin IN (${list})`, [device, ...prev]);
      }
      setMeta(repo.db, OWN_KEY, JSON.stringify([...ownDevices(repo).filter((d) => d !== device), device]));
      noteDevice(repo, device);
      return { rows, newInstall };
    })
    .immediate();
}

/** Klucz identyfikatora instalacji w `meta` (src/importers/automemory.ts, machineId). */
const INSTALL_KEY = "install_id";

/**
 * Czy `meta.install_id` należy do innego komputera: baza przyszła stamtąd (kopia `~/.hipokamp`, przywrócenie
 * z kopii) i dołącza do grupy. Pamięć automatyczna (#10) rozpoznaje swoje notatki po tym identyfikatorze, więc dwa
 * komputery z tym samym archiwizowałyby i zastępowały nawzajem swoje notatki pod tą samą ścieżką (a statusy szłyby
 * przez hub). Identyfikator jest „nasz”, gdy choć jedna notatka pamięci automatycznej z nim ma nazwę tego komputera;
 * bez takich notatek nowy nic nie kosztuje (nie ma czego dublować). Nie numer urządzenia: identyfikator wchodzi do
 * `content_hash`, więc zmiana na tym samym komputerze zdublowałaby każdy plik przy następnym imporcie.
 */
export function foreignInstallId(repo: Repo, host: string): boolean {
  const mid = getMeta(repo.db, INSTALL_KEY);
  if (!mid) return false;
  const me = clean(host.toLowerCase()).toLowerCase();
  const mine = repo.db
    .query(
      // json_valid: zepsute meta (np. z importu) nie może przerwać dołączania
      "SELECT 1 FROM observations WHERE source = 'automemory' AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.automemory.install') = ? AND lower(json_extract(meta, '$.automemory.host')) = ? END LIMIT 1",
    )
    .get(mid, me);
  return !mine;
}

// ---------- zegar hybrydowy (HLC) ----------

/** Zegar jako napis porównywalny leksykograficznie: czas ms, licznik, numer urządzenia (remis rozstrzyga urządzenie). */
export function hlcString(wall: number, counter: number, device: number): string {
  return `${String(Math.max(0, Math.trunc(wall))).padStart(15, "0")}.${String(counter).padStart(6, "0")}.${String(device).padStart(6, "0")}`;
}

export function parseHlc(h: string): { wall: number; counter: number; device: number } | null {
  const m = /^(\d{15})\.(\d{6})\.(\d{6})$/.exec(h);
  return m ? { wall: Number(m[1]), counter: Number(m[2]), device: Number(m[3]) } : null;
}

const HLC_KEY = "sync_hlc";

/**
 * Najdalej tyle zegar z sieci może wyprzedzać czas odbiorcy. Dalszy (zegar urządzenia przestawiony o lata albo
 * złośliwy członek grupy) wygrałby każdy konflikt statusu na zawsze i przesunął zegary wszystkich urządzeń, więc
 * operacja z takim zegarem jest odrzucana (`rejected`), a zegar odbiorcy stoi.
 */
export const MAX_CLOCK_AHEAD_MS = 86_400_000;

/** Zegar zapisany w meta tej bazy (każda baza ma swój: kopia bazy z innej maszyny nie myli zegarów). */
export class Hlc {
  constructor(
    private readonly repo: Repo,
    private readonly device: number,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): { wall: number; counter: number } {
    const p = parseHlc(`${getMeta(this.repo.db, HLC_KEY) ?? ""}.000000`);
    return p ? { wall: p.wall, counter: p.counter } : { wall: 0, counter: 0 };
  }

  private write(wall: number, counter: number): void {
    setMeta(this.repo.db, HLC_KEY, `${String(wall).padStart(15, "0")}.${String(counter).padStart(6, "0")}`);
  }

  /** Zegar zmiany lokalnej; `at` to czas samej zmiany (np. updated_at), nie chwila wysyłki. */
  tick(at?: number): string {
    const s = this.read();
    const pt = Math.max(at ?? this.now(), 0);
    let wall: number;
    let counter: number;
    if (pt > s.wall) {
      wall = pt;
      counter = 0;
    } else {
      wall = s.wall;
      counter = s.counter + 1;
    }
    this.write(wall, counter);
    return hlcString(wall, counter, this.device);
  }

  /** Zegar z sieci poprawny i nie dalej niż MAX_CLOCK_AHEAD_MS przed czasem tej maszyny. */
  plausible(h: string): boolean {
    const p = parseHlc(h);
    return !!p && p.wall <= this.now() + MAX_CLOCK_AHEAD_MS;
  }

  /** Zegar odebrany z innego urządzenia: późniejsza zmiana lokalna dostanie zegar większy od niego. */
  observe(h: string): void {
    if (!this.plausible(h)) return;
    const p = parseHlc(h)!;
    const s = this.read();
    if (p.wall > s.wall || (p.wall === s.wall && p.counter > s.counter)) this.write(p.wall, p.counter);
  }
}

// ---------- ostrzeżenia zegara (T-37) ----------

const CLOCK_REJECTED_KEY = "sync_clock_rejected";

/** Ślad operacji odrzuconych za zegar z przyszłości: bez niego odbiorca z zegarem w tył gubi statusy po cichu. */
export interface ClockRejected {
  count: number;
  firstAt: number;
  lastAt: number;
  /** Najdalszy odrzucony zegar (czas ms). */
  maxWall: number;
}

export function readClockRejected(repo: Repo): ClockRejected | null {
  try {
    const r = JSON.parse(getMeta(repo.db, CLOCK_REJECTED_KEY) || "null");
    return r && Number.isFinite(r.count) && r.count > 0 ? r : null;
  } catch {
    return null;
  }
}

/**
 * Ślad odrzuceń jednego wpisu (w transakcji kursora). `replace`: pierwszy wpis odbioru od początku dziennika, który
 * zastępuje dotychczasowy ślad (te same operacje przyjdą jeszcze raz), a bez odrzuceń go czyści; inaczej dopisuje.
 */
export function traceClockRejected(repo: Repo, count: number, maxWall: number, at: number, replace: boolean): void {
  const prev = replace ? null : readClockRejected(repo);
  if (count <= 0) {
    if (replace) setMeta(repo.db, CLOCK_REJECTED_KEY, "");
    return;
  }
  const next: ClockRejected = {
    count: (prev?.count ?? 0) + count,
    firstAt: prev?.firstAt ?? at,
    lastAt: at,
    maxWall: Math.max(prev?.maxWall ?? 0, maxWall),
  };
  setMeta(repo.db, CLOCK_REJECTED_KEY, JSON.stringify(next));
}

/** O ile zapamiętany zegar tej bazy (sync_hlc) wyprzedza zegar systemowy (ms; ujemne: nie wyprzedza). */
export function hlcAheadMs(repo: Repo, now = Date.now()): number {
  const p = parseHlc(`${getMeta(repo.db, HLC_KEY) ?? ""}.000000`);
  return p ? p.wall - now : Number.NEGATIVE_INFINITY;
}

const fmtAt = (t: number) => new Date(t).toLocaleString("pl-PL");
const fmtSpan = (ms: number) => (ms >= 2 * 86_400_000 ? `${Math.round(ms / 86_400_000)} dni` : `${Math.round(ms / 3_600_000)} h`);

/**
 * Ostrzeżenia zegara synchronizacji z instrukcją naprawy (sync status, doctor, log workera). `ahead`: zapamiętany zegar
 * wyprzedza czas systemowy ponad MAX_CLOCK_AHEAD_MS, więc zmiany statusu i wersje sesji z tego urządzenia odrzucają
 * wszyscy, a `resync` nic nie da (zegar hybrydowy się nie cofa). `rejected`: ten komputer odrzucił operacje z zegarem
 * z przyszłości; gdy to jego zegar się spóźniał, po poprawce odzyskuje je `sync pull --full`.
 */
export function clockWarnings(repo: Repo, now = Date.now()): { kind: "ahead" | "rejected"; text: string }[] {
  const out: { kind: "ahead" | "rejected"; text: string }[] = [];
  const ahead = hlcAheadMs(repo, now);
  if (ahead > MAX_CLOCK_AHEAD_MS) {
    const wall = now + ahead;
    out.push({
      kind: "ahead",
      text: `zegar synchronizacji tej bazy (sync_hlc, ${fmtAt(wall)}) wyprzedza zegar systemowy (${fmtAt(now)}) o ${fmtSpan(ahead)}: inne komputery odrzucają zmiany statusu i wersje sesji z tego urządzenia (granica: doba). Gdy data systemu jest zła (spóźnia się), popraw ją, a zmiany z innych komputerów odrzucone w tym czasie odzyska hipokamp sync pull --full. Gdy jest dobra, zegar był wcześniej przestawiony w przód: zapamiętany zegar się nie cofa, zmiany z tego urządzenia zaczną przechodzić od ${fmtAt(wall - MAX_CLOCK_AHEAD_MS)}, a hipokamp sync resync tego nie przyspieszy. Zmiany odrzucone do tej pory same nie wrócą: po tej dacie wyślij je ponownie przez hipokamp sync resync na tym urządzeniu albo odbierz przez hipokamp sync pull --full na pozostałych (docs/SYNC.md, sekcja 3)`,
    });
  }
  const rej = readClockRejected(repo);
  if (rej)
    out.push({
      kind: "rejected",
      text: `odebrane operacje z zegarem ponad dobę przed zegarem tej maszyny odrzucone: ${rej.count} (od ${fmtAt(rej.firstAt)}, ostatnio ${fmtAt(rej.lastAt)}, najdalszy zegar ${fmtAt(rej.maxWall)}). Gdy spóźnia się zegar tej maszyny (teraz ${fmtAt(now)}), popraw go i uruchom hipokamp sync pull --full: odbiór od początku przyjmie odrzucone zmiany statusu i wersje sesji. Gdy spieszy się zegar nadawcy, popraw go tam (docs/SYNC.md, sekcja 3)`,
    });
  return out;
}

// ---------- operacje ----------

export interface SessionFields {
  project: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  first_prompt: string | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number | null;
  prompt_count: number;
  model: string | null;
  status: string;
}

export interface ObsFields {
  session_id: string | null;
  project: string;
  prompt_n: number | null;
  type: string;
  tier: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  text: string | null;
  created_at: number;
  importance: number;
  source: string;
  content_hash: string | null;
  turn_key: string | null;
  git_head: string | null;
  meta: Record<string, unknown> | null;
}

export interface SummaryFields {
  session_id: string | null;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  files_read: string[];
  files_edited: string[];
  prompt_n: number | null;
  created_at: number;
  source: string;
  meta: Record<string, unknown> | null;
}

/**
 * Ślad decyzji, która zmieniła status notatki (pola `meta`), jadący razem ze statusem w operacji `status` i w rejestrze
 * LWW: zapomnienie (`forgotten_at`, `forget_reason`), przywrócenie z archiwum snu (`restored_at`: sen drugiego
 * komputera nie odłoży notatki z powrotem do archiwum) i cofnięte zastąpienie (`undone_at`, w meta
 * `supersede_undone`: sen nie zastąpi notatki drugi raz). Bez nich przywrócona notatka wracałaby do archiwum z innego
 * komputera (jego sen nie wie, że człowiek zdecydował inaczej). Numer notatki z `supersede_undone.by` jest lokalny,
 * więc jedzie tylko czas.
 */
export interface StatusIntent {
  forgotten_at?: number;
  forget_reason?: string;
  restored_at?: number;
  undone_at?: number;
}

/**
 * Operacja dziennika (treść wpisu po odszyfrowaniu). `g` = gid: „urządzenie źródłowe:numer u źródła”; notatkę,
 * prompt, podsumowanie i wpis listy pracy przyjmujemy tylko od urządzenia, które jest źródłem gid. Sesja ma zegar
 * wersji `h` (starsza wersja nie nadpisze nowszej). Status niesie ślad decyzji `m` (StatusIntent; brak pola: meta
 * odbiorcy bez zmian).
 */
export type Op =
  | { t: "session"; sid: string; h?: string; f: SessionFields }
  | { t: "obs"; g: string; o: ObsFields; e: [string, string, string][] }
  | {
      t: "status";
      g: string;
      h: string;
      s: string;
      into: string | null;
      by: string | null;
      until: number | null;
      m?: StatusIntent | null;
    }
  | { t: "prompt"; g: string; sid: string; project: string; n: number; text: string; at: number; src: string }
  | { t: "sum"; g: string; rep: boolean; s: SummaryFields }
  | {
      t: "ws";
      g: string;
      project: string;
      list: string;
      fields: Record<string, unknown>;
      at: number;
      src: string;
      cm: number | null;
    };

/** Co zapisać lokalnie po potwierdzeniu przez hub (dopiero wtedy wiersz liczy się jako wysłany). */
export type Mark =
  | { k: "map"; kind: "obs" | "prompt" | "sum" | "ws"; gid: string; local: number }
  | { k: "sess"; sid: string; hash: string; h: string }
  | {
      k: "status";
      gid: string;
      hlc: string;
      s: string;
      into: string | null;
      by: string | null;
      until: number | null;
      m: StatusIntent | null;
    };

const J = (s: unknown): any => {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const arr = (s: unknown): string[] => {
  const v = J(s);
  return Array.isArray(v) ? v.map(String) : [];
};

// --- redakcja pól tekstowych (clean: sekrety i <private>), przy wysyłce i przy odbiorze
const cl = (s: unknown): string | null => (s === null || s === undefined ? null : clean(String(s)));
const clArr = (a: unknown): string[] => (Array.isArray(a) ? a.map((x) => clean(String(x))) : []);
function clDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return clean(v);
  if (depth > 20 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => clDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clDeep(x, depth + 1)]));
}
/** Obiekt JSON po redakcji: całość jako tekst (łapie też „"token": "…"”), a gdy wynik nie jest JSON-em, pole po polu. */
function clObj<T extends Record<string, unknown>>(v: unknown): T | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = JSON.stringify(v);
  const c = clean(s);
  if (c === s) return v as T;
  try {
    const p = JSON.parse(c);
    if (p && typeof p === "object" && !Array.isArray(p)) return p as T;
  } catch {}
  return clDeep(v) as T;
}

/**
 * Klucze `meta`, które opisują tę maszynę (katalog startowy sesji i jego werdykt, kotwica i numer tury w transkrypcie,
 * ścieżki i offsety, wyniki lokalnego LLM z numerami notatek tej bazy), oraz wartości wyglądające na ścieżkę
 * bezwzględną na dysku: nie jadą do huba i nie wchodzą z niego. `sessions.meta` (tam są `root`, `rootProject`,
 * `anchor`, `n`) nie jedzie wcale (SESSION_KEYS). `llm` (src/llm/consolidate.ts: sprzeczności z numerami notatek,
 * lekcje) liczy każda maszyna z włączonym LLM sama, jak wektory.
 */
const LOCAL_META_KEYS = new Set([
  "llm",
  "root",
  "rootProject",
  "anchor",
  "n",
  "cwd",
  "offset",
  "transcript",
  "transcriptPath",
  "transcript_path",
  "transcript_ref",
  "fingerprints",
]);
const LOCAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:home|Users|root|mnt|tmp|var|opt|srv|private)\/)/;

function stripLocal(x: unknown, depth = 0): unknown {
  if (typeof x === "string") return LOCAL_PATH_RE.test(x) ? undefined : x;
  if (depth > 20 || x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map((y) => stripLocal(y, depth + 1)).filter((y) => y !== undefined);
  return Object.fromEntries(
    Object.entries(x)
      .filter(([k]) => !LOCAL_META_KEYS.has(k))
      .map(([k, y]) => [k, stripLocal(y, depth + 1)])
      .filter(([, y]) => y !== undefined),
  );
}

/** `meta` notatki albo podsumowania do dziennika i z dziennika: bez śladów maszyny, po redakcji. */
const syncMeta = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? clObj(stripLocal(v)) : null;

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Ślad decyzji (StatusIntent) z `meta` notatki albo z operacji z sieci: tylko znane pola o poprawnym typie, powód po
 * redakcji (pisze go model, to dane z transkryptu) i ucięty jak w Repo.forgetObservations.
 */
function intentOf(meta: unknown, fromOp = false): StatusIntent {
  const m = typeof meta === "string" ? J(meta) : meta;
  const out: StatusIntent = {};
  if (!m || typeof m !== "object" || Array.isArray(m)) return out;
  const forgotten = finite(m.forgotten_at);
  if (forgotten !== undefined) out.forgotten_at = forgotten;
  if (typeof m.forget_reason === "string" && m.forget_reason) out.forget_reason = clean(m.forget_reason).slice(0, 300);
  const restored = finite(m.restored_at);
  if (restored !== undefined) out.restored_at = restored;
  if (fromOp) {
    const undone = finite(m.undone_at);
    if (undone !== undefined) out.undone_at = undone;
  } else if (m.supersede_undone) out.undone_at = finite(m.supersede_undone?.at) ?? 0;
  return out;
}

const intentJson = (m: StatusIntent | null | undefined): string | null => (m ? JSON.stringify(m) : null);

/** Porównywalna postać śladu decyzji (stała kolejność pól). */
const traceKey = (x: StatusIntent): string =>
  JSON.stringify([x.forgotten_at ?? null, x.forget_reason ?? null, x.restored_at ?? null, x.undone_at ?? null]);

/** Grupy pól śladu w meta notatki: zapomnienie (czas i powód razem), przywrócenie, cofnięte zastąpienie. */
const TRACE_GROUPS = [["forgotten_at", "forget_reason"], ["restored_at"], ["supersede_undone"]] as const;

/**
 * Ślad decyzji ze zwycięskiej zmiany statusu w `meta` notatki, reszta meta bez zmian. Bez `m` (starszy zapis rejestru)
 * meta zostaje. Zmiana stanu (`merge` false): grupy pól ustawione dokładnie jak u źródła (brak = usunięcie, np.
 * przywrócenie zdejmuje zapomnienie). Ten sam stan co lokalnie (`merge`: np. forget tutaj i równoległe archiwum snu
 * gdzie indziej): grupa z sieci zastępuje lokalną, brakująca zostaje, więc decyzja człowieka nie znika przez cudzy sen;
 * rejestr dostaje ślad z sieci, a różnicę wyśle stąd zbieranie statusów (changesOf). Cofnięte zastąpienie zachowuje
 * lokalny odsyłacz `by`, gdy ta baza już je ma (czas z sieci).
 */
function applyIntent(repo: Repo, local: number, m: StatusIntent | null | undefined, merge = false): void {
  if (!m) return;
  const r = repo.db.query("SELECT meta FROM observations WHERE id = ?").get(local) as { meta: string | null } | null;
  if (!r) return;
  const cur = J(r.meta);
  const meta: Record<string, unknown> = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
  const keys = TRACE_GROUPS.flat();
  const snap = () => JSON.stringify(keys.map((k) => meta[k] ?? null));
  const before = snap();
  const undone = meta.supersede_undone;
  const x = intentOf(m, true);
  const incoming = [x.forgotten_at !== undefined || !!x.forget_reason, x.restored_at !== undefined, x.undone_at !== undefined];
  TRACE_GROUPS.forEach((g, i) => {
    if (!merge || incoming[i]) for (const k of g) delete meta[k];
  });
  if (x.forgotten_at !== undefined) meta.forgotten_at = x.forgotten_at;
  if (x.forget_reason) meta.forget_reason = x.forget_reason;
  if (x.restored_at !== undefined) meta.restored_at = x.restored_at;
  if (x.undone_at !== undefined)
    meta.supersede_undone = undone && typeof undone === "object" ? { ...undone, at: x.undone_at } : { at: x.undone_at };
  if (snap() !== before) repo.db.run("UPDATE observations SET meta = ? WHERE id = ?", [JSON.stringify(meta), local]);
}

export const gid = (device: number, id: number | string) => `${device}:${id}`;
export const gidNumber = (g: string): number => Number(g.slice(g.indexOf(":") + 1));
export const gidOrigin = (g: string): number => Number(g.slice(0, g.indexOf(":")));
/** gid: „urządzenie:numer”, po przywróceniu kopii bazy z przyrostkiem „~n” (ownGid). */
const GID_RE = /^[1-9]\d{0,5}:[1-9]\d{0,15}(?:~[1-9]\d{0,5})?$/;
export const validGid = (g: unknown): g is string => typeof g === "string" && GID_RE.test(g);

/** Porządek gid: urządzenie, numer, przyrostek (liczbowo). Ten sam na każdej maszynie. */
function compareGid(a: string, b: string): number {
  const key = (g: string) => {
    const [dev, rest] = g.split(":");
    const [n, sfx] = (rest ?? "").split("~");
    return [Number(dev), Number(n), Number(sfx ?? 0)];
  };
  const x = key(a);
  const y = key(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const SESSION_KEYS: (keyof SessionFields)[] = [
  "project",
  "cwd",
  "git_branch",
  "title",
  "first_prompt",
  "started_at",
  "ended_at",
  "last_activity_at",
  "prompt_count",
  "model",
  "status",
];

export function sessionHash(f: SessionFields): string {
  return sha1(JSON.stringify(SESSION_KEYS.map((k) => f[k] ?? null))).slice(0, 20);
}

/** Pola sesji do dziennika: każdy tekst po redakcji (tytuł, pierwszy prompt, ścieżka, model mogą zawierać sekret). */
function sessionFields(r: any): SessionFields {
  return {
    project: clean(String(r.project ?? "")),
    cwd: cl(r.cwd),
    git_branch: cl(r.git_branch),
    title: cl(r.title),
    first_prompt: cl(r.first_prompt),
    started_at: Number(r.started_at) || 0,
    ended_at: r.ended_at ?? null,
    last_activity_at: r.last_activity_at ?? null,
    prompt_count: Number(r.prompt_count) || 0,
    model: cl(r.model),
    status: clean(String(r.status ?? "active")) || "active",
  };
}

/**
 * Encje grafu notatki po redakcji klucza (polecenie albo adres z sekretem zostaje bez niego); encja, z której po
 * redakcji nie zostaje nic poza znacznikiem, jest pomijana. Rodzaj i rola tylko ze znanych zbiorów.
 */
function cleanEntities(e: unknown): [string, string, string][] {
  if (!Array.isArray(e)) return [];
  const out: [string, string, string][] = [];
  for (const x of e) {
    if (!Array.isArray(x) || !ENTITY_KINDS.has(x[0]) || !ENTITY_ROLES.has(x[2]) || typeof x[1] !== "string") continue;
    const key = clean(x[1]);
    if (!key.replace(/\[REDACTED[^\]]*\]/g, "").trim()) continue;
    out.push([x[0], key, x[2]]);
  }
  return out;
}

/** Liczniki własnych numerów notatek i podsumowań (sqlite_sequence). */
export const ownSeq = (repo: Repo) => ({ obs: seqOf(repo, "observations"), sum: seqOf(repo, "summaries") });

const seqOf = (repo: Repo, table: string): number =>
  (repo.db.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | null)?.seq ?? 0;

function setSeq(repo: Repo, table: string, v: number): void {
  if (repo.db.query("SELECT 1 FROM sqlite_sequence WHERE name = ?").get(table))
    repo.db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", [v, table]);
  else repo.db.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [table, v]);
}

/**
 * Licznik notatek i podsumowań w przestrzeni numerów urządzenia (przy `sync init/join` i przed każdą synchronizacją).
 * Licznik powyżej przestrzeni to błąd: znaczy, że ta baza nadawała numery jako inne urządzenie.
 */
export function ensureOwnRange(repo: Repo, device: number): void {
  const { lo } = idRange(device);
  repo.db
    .transaction(() => {
      const problem = ownRangeProblem(repo, device);
      if (problem)
        throw new Error(
          `${problem}: ta baza nadawała numery jako inne urządzenie. Naprawa: hipokamp sync leave --yes, potem hipokamp sync join --server <adres> (dołączenie prosi o numer, w którego przestrzeni mieści się licznik)`,
        );
      for (const t of ["observations", "summaries"]) if (seqOf(repo, t) < lo - 1) setSeq(repo, t, lo - 1);
    })
    .immediate();
}

const mapGet = (repo: Repo, kind: string, g: string): number | null =>
  (repo.db.query("SELECT local_id FROM sync_map WHERE kind = ? AND gid = ?").get(kind, g) as { local_id: number } | null)
    ?.local_id ?? null;

/** Wiersz o tym gid jest znany hubowi (wysłany stąd albo przyjęty z huba). */
export const isMapped = (repo: Repo, kind: string, g: string): boolean => mapGet(repo, kind, g) !== null;

const mapPut = (repo: Repo, kind: string, g: string, local: number) =>
  repo.db.run("INSERT OR IGNORE INTO sync_map (kind, gid, local_id, origin) VALUES (?, ?, ?, ?)", [kind, g, local, gidOrigin(g)]);

/**
 * gid własnego wiersza. Po przywróceniu kopii bazy numer mógł dostać inny wiersz niż ten, który hub już zna pod
 * „urządzenie:numer” (pull --full przywraca tamten pod nowym numerem): wtedy gid z przyrostkiem ~n, a odbiorcy
 * nadają mu własny numer.
 */
function ownGid(repo: Repo, kind: string, device: number, id: number): string {
  let g = gid(device, id);
  for (let n = 1; mapGet(repo, kind, g) !== null; n++) g = `${device}:${id}~${n}`;
  return g;
}

/**
 * gid notatki lokalnej w odnośnikach (cel scalenia, następca, wybór w cyklu scaleń). Notatka może mieć tu kilka gid:
 * urządzenie dołączone ponownie wysyła swoje wiersze jeszcze raz pod nowym, wyższym numerem, a samo zna już tylko
 * nowy gid (stary zna tylko ten, kto odebrał go wcześniej). Wybór: najwyższy numer pochodzenia (najnowsza tożsamość,
 * numery urządzeń nigdy nie wracają), przy remisie najmniejszy gid (dwie notatki z jednego urządzenia na jednym wierszu).
 */
const gidOf = (repo: Repo, local: number | null): string | null => {
  if (!local) return null;
  const all = (repo.db.query("SELECT gid FROM sync_map WHERE kind = 'obs' AND local_id = ?").all(local) as { gid: string }[]).map(
    (r) => r.gid,
  );
  return all.length ? all.sort((a, b) => gidOrigin(b) - gidOrigin(a) || compareGid(a, b))[0] : null;
};

/** gid własnego wiersza już znanego hubowi (ponowna wysyłka po cofnięciu dziennika huba idzie pod tym samym gid). */
const ownMapped = (repo: Repo, kind: string, local: number, device: number): string | null => {
  const all = (
    repo.db.query("SELECT gid FROM sync_map WHERE kind = ? AND local_id = ? AND origin = ?").all(kind, local, device) as {
      gid: string;
    }[]
  ).map((r) => r.gid);
  return all.length ? all.sort(compareGid)[0] : null;
};

// ---------- wysyłka: zbieranie własnych zmian ----------

export interface CollectCursor {
  /** Ostatni przejrzany numer w tabeli (prompty, notatki, podsumowania, listy pracy); DONE = tabela przejrzana. */
  prompt: number;
  obs: number;
  sum: number;
  ws: number;
  /** Przegląd sesji: ostatnie przejrzane id sesji (porządek id w SQL); null = przejrzane. */
  sess: string | null;
  /** Tryb ponownej wysyłki: ostatni rejestr statusu już wysłany (porządek gid w SQL); null = rejestry przejrzane. */
  reg: string | null;
  /** Przegląd statusów notatek nieaktywnych: ostatni przejrzany numer notatki; DONE = przejrzane. */
  stat: number;
  /** Przegląd rejestrów nieaktywnych przy aktywnej notatce: ostatni przejrzany gid; null = przejrzane. */
  react: string | null;
}

/** Koniec przeglądu tabeli w kursorze zbierania. */
const DONE = Number.MAX_SAFE_INTEGER;
/** Numerów na kawałek przeglądu (zakres po kluczu głównym: kilka ms także przy 100 tys. wierszy). */
const SCAN_IDS = 4000;
/** Sesji na zapytanie przeglądu (budżet czasu i tak sprawdzany po każdej sesji). */
const SCAN_SESSIONS = 256;

export const newCursor = (): CollectCursor => ({
  prompt: 0,
  obs: 0,
  sum: 0,
  ws: 0,
  sess: "",
  reg: "",
  stat: 0,
  react: "",
});

export interface Batch {
  ops: Op[];
  marks: Mark[];
  bytes: number;
  /**
   * Zbieranie przerwane (pełna partia, koniec budżetu czasu albo wiersze tej partii muszą trafić do huba przed
   * statusami): wołać dalej z tym samym kursorem. Pusta partia bez `more` = nic więcej do wysłania.
   */
  more: boolean;
}

/** Filtr projektów wyłączonych z synchronizacji (sync.excludeProjects). */
function excludeSql(exclude: string[]): { sql: string; params: string[] } {
  const ex = exclude.map((p) => p.toLowerCase()).filter(Boolean);
  return ex.length ? { sql: ` AND lower(project) NOT IN (${ex.map(() => "?").join(",")})`, params: ex } : { sql: "", params: [] };
}

/**
 * Następna partia własnych zmian do wysłania, najwyżej ok. `maxBytes` JSON-u. Kolejność: sesje, prompty, notatki,
 * podsumowania, listy pracy, statusy (status dopiero dla notatki już potwierdzonej przez hub, więc wiersze zebrane
 * w tym wywołaniu idą do huba i zostają zatwierdzone przed przeglądem statusów). Tabele przegląda zakresami numerów
 * (SCAN_IDS) od kursora. `budgetMs`: po tylu ms (i co najmniej jednym kawałku pracy) wraca z tym, co ma (`more`),
 * a wywołujący oddaje pętlę zdarzeń i woła dalej; worker nie stoi wtedy na przeglądzie dużej bazy (100 tys. notatek,
 * w tym 30 tys. nieaktywnych: ok. 270 ms jednym ciągiem). `resend`: także własne wiersze już znane hubowi (pod tym
 * samym gid), wszystkie własne sesje i wszystkie rejestry statusów: odbudowa po cofnięciu dziennika huba
 * (hipokamp sync resync). `clock`: zegar budżetu (domyślnie performance.now; test podaje licznik, żeby sprawdzić
 * kawałkowanie bez zależności od szybkości maszyny).
 */
export function collectBatch(
  repo: Repo,
  device: number,
  hlc: Hlc,
  cur: CollectCursor,
  opts: { maxBytes: number; exclude: string[]; resend?: boolean; budgetMs?: number; clock?: () => number },
): Batch {
  const b: Batch = { ops: [], marks: [], bytes: 0, more: false };
  const clock = opts.clock ?? (() => performance.now());
  const t0 = clock();
  const budget = opts.budgetMs ?? Number.POSITIVE_INFINITY;
  let worked = false;
  /** Pełna partia albo (po co najmniej jednym kawałku pracy) koniec budżetu czasu: reszta w następnym wywołaniu. */
  const enough = () => b.bytes >= opts.maxBytes || (worked && clock() - t0 >= budget);
  const pause = (): Batch => {
    b.more = true;
    return b;
  };
  const add = (op: Op, ...marks: Mark[]) => {
    b.ops.push(op);
    b.marks.push(...marks);
    b.bytes += JSON.stringify(op).length + 1;
  };
  const ex = excludeSql(opts.exclude);
  const db = repo.db;
  const resend = !!opts.resend;

  // sesje: przegląd własnych po id, kawałkami od kursora, wysyłka tylko zmienionych (skrót pól). Redakcja pól i skrót
  // to praca na każdą sesję (przy 5 tys. sesji z długim pierwszym promptem ponad 300 ms), więc budżet sprawdzany po
  // każdej. Jeden zegar wersji na wywołanie (sesja jest w nim najwyżej raz, następna wersja pójdzie w późniejszej).
  let h: string | null = null;
  while (cur.sess !== null) {
    const rows = db
      .query(
        `SELECT s.*, x.hash AS sync_hash FROM sessions s LEFT JOIN sync_sessions x ON x.id = s.id
         WHERE s.id > ? AND (x.id IS NULL OR x.origin = ?)${ex.sql} ORDER BY s.id LIMIT ${SCAN_SESSIONS}`,
      )
      .all(cur.sess, device, ...ex.params) as any[];
    worked = true;
    for (const r of rows) {
      const f = sessionFields(r);
      const hash = sessionHash(f);
      cur.sess = r.id as string;
      if (hash !== r.sync_hash || resend) {
        h ??= hlc.tick();
        add({ t: "session", sid: clean(r.id), h, f }, { k: "sess", sid: r.id, hash, h });
      }
      if (enough()) return pause();
    }
    if (rows.length < SCAN_SESSIONS) cur.sess = null;
    else if (enough()) return pause();
  }

  /** Górna granica kawałka przeglądu: SCAN_IDS-ty numer po kursorze albo koniec tabeli. */
  const upper = (table: string, after: number): number =>
    (
      db.query(`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT 1 OFFSET ${SCAN_IDS - 1}`).get(after) as {
        id: number;
      } | null
    )?.id ?? DONE;
  const unsent = (table: string, kind: string, after: number, upTo: number) =>
    db
      .query(
        `SELECT * FROM ${table} t WHERE t.id > ? AND t.id <= ? AND (NOT EXISTS (SELECT 1 FROM sync_map m WHERE m.kind = '${kind}' AND m.local_id = t.id)${
          resend ? ` OR EXISTS (SELECT 1 FROM sync_map m WHERE m.kind = '${kind}' AND m.local_id = t.id AND m.origin = ?)` : ""
        })${ex.sql} ORDER BY t.id`,
      )
      .all(after, upTo, ...(resend ? [device] : []), ...ex.params) as any[];
  const gidFor = (kind: string, id: number) => (resend && ownMapped(repo, kind, id, device)) || ownGid(repo, kind, device, id);
  /** Niewysłane wiersze tabeli od kursora, zakresami numerów; true = przerwane (partia pełna albo koniec budżetu). */
  const scan = (table: string, kind: "prompt" | "obs" | "sum" | "ws", emit: (r: any) => void): boolean => {
    while (cur[kind] < DONE) {
      const upTo = upper(table, cur[kind]);
      for (const r of unsent(table, kind, cur[kind], upTo)) {
        emit(r);
        cur[kind] = r.id;
        worked = true;
        if (enough()) return true;
      }
      cur[kind] = upTo;
      worked = true;
      if (enough()) return true;
    }
    return false;
  };

  if (
    scan("prompts", "prompt", (r) => {
      const g = gidFor("prompt", r.id);
      add(
        {
          t: "prompt",
          g,
          sid: clean(r.session_id),
          project: clean(r.project),
          n: r.n,
          text: clean(r.text),
          at: r.created_at,
          src: clean(r.source),
        },
        { k: "map", kind: "prompt", gid: g, local: r.id },
      );
    })
  )
    return pause();

  const ents = db.query(
    "SELECT e.kind, e.key, oe.role FROM obs_entities oe JOIN entities e ON e.id = oe.entity_id WHERE oe.obs_id = ?",
  );
  if (
    scan("observations", "obs", (r) => {
      const g = gidFor("obs", r.id);
      // bez śladów tej maszyny: odciski plików (mtime) i zakres transkryptu dotyczą jej dysku, liczniki użycia jej pracy;
      // content_hash zostaje (deduplikacja u odbiorcy), każdy tekst po redakcji
      const o: ObsFields = {
        session_id: cl(r.session_id),
        project: clean(r.project),
        prompt_n: r.prompt_n,
        type: clean(r.type),
        tier: clean(r.tier),
        title: clean(r.title),
        subtitle: cl(r.subtitle),
        narrative: cl(r.narrative),
        facts: clArr(arr(r.facts)),
        concepts: clArr(arr(r.concepts)),
        files_read: clArr(arr(r.files_read)),
        files_modified: clArr(arr(r.files_modified)),
        text: cl(r.text),
        created_at: r.created_at,
        importance: r.importance,
        source: clean(r.source),
        content_hash: r.content_hash,
        turn_key: cl(r.turn_key),
        git_head: cl(r.git_head),
        meta: syncMeta(J(r.meta)),
      };
      const e = cleanEntities(
        (ents.all(r.id) as { kind: string; key: string; role: string }[]).map((x) => [x.kind, x.key, x.role]),
      );
      add({ t: "obs", g, o, e }, { k: "map", kind: "obs", gid: g, local: r.id });
    })
  )
    return pause();

  if (
    scan("summaries", "sum", (r) => {
      const g = gidFor("sum", r.id);
      const s: SummaryFields = {
        session_id: cl(r.session_id),
        project: clean(r.project),
        request: cl(r.request),
        investigated: cl(r.investigated),
        learned: cl(r.learned),
        completed: cl(r.completed),
        next_steps: cl(r.next_steps),
        notes: cl(r.notes),
        files_read: clArr(arr(r.files_read)),
        files_edited: clArr(arr(r.files_edited)),
        prompt_n: r.prompt_n,
        created_at: r.created_at,
        source: clean(r.source),
        meta: syncMeta(J(r.meta)),
      };
      // podsumowanie „digest” jest zastępowane przy każdym końcu sesji (replaceSessionSummary): odbiorca też zastępuje
      add({ t: "sum", g, rep: r.source === "digest", s }, { k: "map", kind: "sum", gid: g, local: r.id });
    })
  )
    return pause();

  if (
    scan("work_state", "ws", (r) => {
      const g = gidFor("ws", r.id);
      add(
        {
          t: "ws",
          g,
          project: clean(r.project),
          list: clean(r.list_name),
          fields: clObj(J(r.fields)) ?? {},
          at: r.created_at,
          src: clean(r.source),
          cm: r.cm_id ?? null,
        },
        { k: "map", kind: "ws", gid: g, local: r.id },
      );
    })
  )
    return pause();

  // statusy tylko dla notatek znanych hubowi: wiersze zebrane w tym wywołaniu najpierw idą i zostają zatwierdzone
  if (b.ops.length) return pause();

  // ponowna wysyłka: wszystkie znane rejestry statusów z ich zegarami i śladem decyzji (hub mógł zgubić także cudze),
  // stronami po gid
  while (resend && cur.reg !== null) {
    const regs = db
      .query(
        "SELECT s.* FROM sync_status s WHERE s.gid > ? AND EXISTS (SELECT 1 FROM sync_map m WHERE m.kind = 'obs' AND m.gid = s.gid) ORDER BY s.gid LIMIT 500",
      )
      .all(cur.reg) as any[];
    if (!regs.length) {
      cur.reg = null;
      break;
    }
    for (const r of regs) {
      cur.reg = r.gid;
      const m = J(r.intent) as StatusIntent | null;
      add(
        { t: "status", g: r.gid, h: r.hlc, s: r.status, into: r.into_gid, by: r.by_gid, until: r.valid_until, m },
        { k: "status", gid: r.gid, hlc: r.hlc, s: r.status, into: r.into_gid, by: r.by_gid, until: r.valid_until, m },
      );
      worked = true;
      if (enough()) return pause();
    }
  }

  // statusy: notatki, których stan różni się od rejestru (brak rejestru = aktywna); tylko notatki znane hubowi.
  // Zegar z chwili zmiany statusu (sync_status_at), nie z updated_at (podbijają je też powtórki treści). Kawałek w jednej
  // transakcji: zegar (meta sync_hlc) zapisuje się przy każdej zmianie. Zwraca ostatnią zmianę, gdy partia się zapełniła.
  const emit = (changes: StatusChange[]): StatusChange | null =>
    db.transaction((): StatusChange | null => {
      for (const c of changes) {
        const h = hlc.tick(c.changed_at);
        add(
          { t: "status", g: c.gid, h, s: c.status, into: c.into, by: c.by, until: c.until, m: c.m },
          { k: "status", gid: c.gid, hlc: h, s: c.status, into: c.into, by: c.by, until: c.until, m: c.m },
        );
        if (b.bytes >= opts.maxBytes) return c;
      }
      return null;
    })();
  // nieaktywne lokalnie, zakresami numerów notatek. Przy pełnej partii kursor wraca przed ostatnią notatkę: po
  // zatwierdzeniu jej rejestry są równe stanowi, a pozostałe gid tej notatki nie przepadną
  while (cur.stat < DONE) {
    const upTo = upper("observations", cur.stat);
    const last = emit(inactiveIn(repo, cur.stat, upTo));
    cur.stat = last ? last.local - 1 : upTo;
    worked = true;
    if (last || enough()) return pause();
  }
  // aktywne lokalnie z nieaktywnym rejestrem (przywrócone tutaj), zakresami rejestrów po gid
  while (cur.react !== null) {
    const upTo =
      (
        db.query(`SELECT gid FROM sync_status WHERE gid > ? ORDER BY gid LIMIT 1 OFFSET ${SCAN_IDS - 1}`).get(cur.react) as {
          gid: string;
        } | null
      )?.gid ?? null;
    const last = emit(reactivatedIn(repo, cur.react, upTo));
    cur.react = last ? last.gid : upTo;
    worked = true;
    if (last || enough()) return pause();
  }
  return b;
}

interface StatusChange {
  gid: string;
  local: number;
  status: string;
  into: string | null;
  by: string | null;
  until: number | null;
  /** Ślad decyzji z meta notatki (zapomnienie, przywrócenie, cofnięte zastąpienie). */
  m: StatusIntent;
  /** Chwila zmiany statusu (sync_status_at; dla zmian sprzed `sync init` updated_at). */
  changed_at: number;
}

const STATUS_COLS = `o.id, o.status, o.merged_into, o.superseded_by, o.valid_until, o.meta, COALESCE(a.at, o.updated_at) AS changed_at,
  m.gid, s.status AS rs, s.into_gid, s.by_gid, s.valid_until AS ru, s.intent AS ri`;

/**
 * Wiersze, w których stan lokalny różni się od rejestru LWW, albo stan ten sam, ale ślad decyzji inny (ślad połączony
 * przy odbiorze, applyIntent z `merge`, albo rejestr sprzed śladu): zmiana do wysłania.
 */
function changesOf(repo: Repo, rows: any[]): StatusChange[] {
  const out: StatusChange[] = [];
  for (const r of rows) {
    const c = localStatus(repo, r);
    const m = intentOf(r.meta);
    if (
      sameStatus(repo, c, { status: r.rs ?? "active", into: r.into_gid ?? null, by: r.by_gid ?? null, until: r.ru ?? null }) &&
      traceKey(m) === traceKey(intentOf(r.ri, true))
    )
      continue;
    out.push({ gid: r.gid, local: r.id, ...c, m, changed_at: r.changed_at });
  }
  return out;
}

/**
 * Nieaktywne notatki znane hubowi z numerami w (`after`, `upTo`], ze stanem innym niż rejestr. Zakres po kluczu
 * głównym: wyszukania w mapie i rejestrze tylko dla nieaktywnych.
 */
function inactiveIn(repo: Repo, after: number, upTo: number): StatusChange[] {
  return changesOf(
    repo,
    repo.db
      .query(
        // bez wierszy na pewno równych rejestrowi (ten sam stan i ważność, cel scalenia albo następca pod gid rejestru
        // i bez drugiego gid, bez śladu decyzji po obu stronach): przy dziesiątkach tysięcy scalonych notatek JS
        // dostaje tylko kandydatów, resztę (cel bez gid albo z kilkoma, ślad) rozstrzygają sameStatus i traceKey
        `SELECT ${STATUS_COLS}
         FROM observations o CROSS JOIN sync_map m ON m.kind = 'obs' AND m.local_id = o.id
         LEFT JOIN sync_status s ON s.gid = m.gid LEFT JOIN sync_status_at a ON a.obs_id = o.id
         WHERE o.id > ? AND o.id <= ? AND o.status != 'active'
           AND NOT (s.gid IS NOT NULL AND s.status = o.status AND o.valid_until IS s.valid_until
             AND (s.intent IS NULL OR s.intent = '{}')
             AND (o.meta IS NULL OR (instr(o.meta, '"forgotten_at"') = 0 AND instr(o.meta, '"forget_reason"') = 0
               AND instr(o.meta, '"restored_at"') = 0 AND instr(o.meta, '"supersede_undone"') = 0))
             AND CASE WHEN o.status = 'merged' THEN s.into_gid IS NOT NULL
               AND EXISTS (SELECT 1 FROM sync_map x WHERE x.kind = 'obs' AND x.gid = s.into_gid AND x.local_id = o.merged_into)
               AND (SELECT COUNT(*) FROM sync_map x WHERE x.kind = 'obs' AND x.local_id = o.merged_into) = 1
               ELSE s.into_gid IS NULL END
             AND CASE WHEN o.status = 'superseded' THEN s.by_gid IS NOT NULL
               AND EXISTS (SELECT 1 FROM sync_map x WHERE x.kind = 'obs' AND x.gid = s.by_gid AND x.local_id = o.superseded_by)
               AND (SELECT COUNT(*) FROM sync_map x WHERE x.kind = 'obs' AND x.local_id = o.superseded_by) = 1
               ELSE s.by_gid IS NULL END)
         ORDER BY o.id, m.gid`,
      )
      .all(after, upTo) as any[],
  );
}

/**
 * Aktywne notatki z nieaktywnym rejestrem o gid w (`after`, `upTo`] (null: do końca), czyli przywrócone tutaj.
 * CROSS JOIN trzyma kolejność (rejestr, mapa, notatka) także bez statystyk (ANALYZE): inaczej planista bierze mapę
 * i czyta ją do końca przy każdym kawałku. Tak samo w inactiveIn (notatka przed mapą).
 */
function reactivatedIn(repo: Repo, after: string, upTo: string | null): StatusChange[] {
  return changesOf(
    repo,
    repo.db
      .query(
        `SELECT ${STATUS_COLS}
         FROM sync_status s CROSS JOIN sync_map m ON m.kind = 'obs' AND m.gid = s.gid CROSS JOIN observations o ON o.id = m.local_id
         LEFT JOIN sync_status_at a ON a.obs_id = o.id
         WHERE s.gid > ?1 AND s.gid <= ?2 AND s.status != 'active' AND o.status = 'active'
         ORDER BY s.gid`,
      )
      .all(after, upTo ?? "￿") as any[], // gid to ASCII: U+FFFF jest za każdym (porównanie bajtów UTF-8)
  );
}

/** Wszystkie zmiany statusu do wysłania naraz (sync status, testy). */
export function statusChanges(repo: Repo): StatusChange[] {
  return [...inactiveIn(repo, Number.MIN_SAFE_INTEGER, DONE), ...reactivatedIn(repo, "", null)];
}

/** Chwila ostatniej zmiany statusu notatki (wyzwalacz tr_sync_status_at; dawniejsze zmiany: updated_at). */
const statusChangedAt = (repo: Repo, local: number): number =>
  (
    repo.db
      .query(
        "SELECT COALESCE((SELECT at FROM sync_status_at WHERE obs_id = o.id), o.updated_at) t FROM observations o WHERE o.id = ?",
      )
      .get(local) as { t: number } | null
  )?.t ?? 0;

function localStatus(
  repo: Repo,
  r: { status: string; merged_into: number | null; superseded_by: number | null; valid_until: number | null },
) {
  return {
    status: r.status,
    into: r.status === "merged" ? gidOf(repo, r.merged_into) : null,
    by: r.status === "superseded" ? gidOf(repo, r.superseded_by) : null,
    until: r.status === "active" ? null : (r.valid_until ?? null),
  };
}

/** Stan lokalny równy rejestrowi. Cel scalenia, którego ta baza jeszcze nie ma, nie liczy się jako różnica. */
function sameStatus(
  repo: Repo,
  local: { status: string; into: string | null; by: string | null; until: number | null },
  reg: { status: string; into: string | null; by: string | null; until: number | null },
): boolean {
  if (local.status !== reg.status) return false;
  const ref = (l: string | null, r: string | null) => l === r || (l === null && r !== null && mapGet(repo, "obs", r) === null);
  return ref(local.into, reg.into) && ref(local.by, reg.by) && (local.until ?? null) === (reg.until ?? null);
}

/** Zapis potwierdzonej partii: od teraz te wiersze są znane hubowi. */
export function commitMarks(repo: Repo, device: number, marks: Mark[]): void {
  repo.db
    .transaction(() => {
      for (const m of marks) {
        if (m.k === "map") mapPut(repo, m.kind, m.gid, m.local);
        else if (m.k === "sess")
          repo.db.run(
            "INSERT INTO sync_sessions (id, origin, hash, hlc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, hlc = excluded.hlc WHERE sync_sessions.origin = excluded.origin",
            [m.sid, device, m.hash, m.h],
          );
        else putStatus(repo, m);
      }
    })
    .immediate();
}

function putStatus(
  repo: Repo,
  m: {
    gid: string;
    hlc: string;
    s: string;
    into: string | null;
    by: string | null;
    until: number | null;
    m?: StatusIntent | null;
  },
): void {
  repo.db.run(
    `INSERT INTO sync_status (gid, hlc, status, into_gid, by_gid, valid_until, intent) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(gid) DO UPDATE SET hlc = excluded.hlc, status = excluded.status, into_gid = excluded.into_gid,
       by_gid = excluded.by_gid, valid_until = excluded.valid_until, intent = excluded.intent WHERE excluded.hlc > sync_status.hlc`,
    [m.gid, m.hlc, m.s, m.into, m.by, m.until, intentJson(m.m)],
  );
}

/** Ile zmian czeka na wysyłkę (sync status). */
export function pendingCounts(repo: Repo, device: number, exclude: string[]): Record<string, number> {
  const ex = excludeSql(exclude);
  const one = (table: string, kind: string) =>
    (
      repo.db
        .query(
          `SELECT COUNT(*) c FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM sync_map m WHERE m.kind = '${kind}' AND m.local_id = t.id)${ex.sql}`,
        )
        .get(...ex.params) as { c: number }
    ).c;
  const sessions = (
    repo.db
      .query(
        `SELECT s.*, x.hash AS sync_hash FROM sessions s LEFT JOIN sync_sessions x ON x.id = s.id WHERE (x.id IS NULL OR x.origin = ?)${ex.sql}`,
      )
      .all(device, ...ex.params) as any[]
  ).filter((r) => sessionHash(sessionFields(r)) !== r.sync_hash).length;
  return {
    sessions,
    prompts: one("prompts", "prompt"),
    observations: one("observations", "obs"),
    summaries: one("summaries", "sum"),
    workState: one("work_state", "ws"),
    statuses: statusChanges(repo).length,
  };
}

// ---------- odbiór: stosowanie operacji ----------

export interface ApplyStats {
  sessions: number;
  prompts: number;
  observations: number;
  summaries: number;
  workState: number;
  statuses: number;
  /** Operacje już znane (powtórka) albo przegrane z nowszym zegarem. */
  skipped: number;
  /** Operacje odrzucone: zły gid albo wiersz podpisany jako cudzy (gid z innego urządzenia niż nadawca wpisu). */
  rejected: number;
  /** Z odrzuconych: zegar ponad MAX_CLOCK_AHEAD_MS przed czasem tej maszyny (T-37: ślad w meta, ostrzeżenie). */
  future: number;
  /** Najdalszy taki zegar (czas ms), 0 = brak. */
  futureMax: number;
}

export const emptyStats = (): ApplyStats => ({
  sessions: 0,
  prompts: 0,
  observations: 0,
  summaries: 0,
  workState: 0,
  statuses: 0,
  skipped: 0,
  rejected: 0,
  future: 0,
  futureMax: 0,
});

const ENTITY_KINDS = new Set(["file", "dir", "concept", "command", "url", "tool", "symbol"]);
const ENTITY_ROLES = new Set(["read", "modified", "concept", "mentioned"]);
const OBS_STATUSES = new Set(["active", "merged", "superseded", "archived"]);

/** Wszystkie operacje wpisu naraz (w transakcji wywołującego); odbiór stosuje je kawałkami (applySlice). */
export function applyOps(
  repo: Repo,
  device: number,
  hlc: Hlc,
  ops: Op[],
  from: number,
  stats: ApplyStats = emptyStats(),
): ApplyStats {
  applySlice(repo, device, hlc, ops, from, stats, 0, Number.POSITIVE_INFINITY);
  return stats;
}

/**
 * Stosuje operacje wpisu od `start`, dopóki nie minie `budgetMs` (co najmniej jedną), w transakcji wywołującego;
 * zwraca indeks następnej operacji. Odbiór dzieli duży wpis na kawałki z osobnymi transakcjami, żeby nie trzymać
 * bazy i pętli workera setkami ms (kursor idzie z ostatnim kawałkiem; przerwanie w środku = powtórka wpisu, operacje
 * są idempotentne). Licznik numerów (sqlite_sequence) wraca na koniec do własnej przestrzeni urządzenia: wstawienie
 * notatki z wyższym numerem innego komputera przesunęłoby go, a następna własna notatka dostałaby cudzy numer.
 */
export function applySlice(
  repo: Repo,
  device: number,
  hlc: Hlc,
  ops: Op[],
  from: number,
  stats: ApplyStats,
  start: number,
  budgetMs: number,
): number {
  const { lo, hi } = idRange(device);
  const own = { obs: seqOf(repo, "observations"), sum: seqOf(repo, "summaries") };
  if (own.obs < lo - 1 || own.obs > hi || own.sum < lo - 1 || own.sum > hi)
    throw new Error(`licznik numerów poza przestrzenią urządzenia ${device} (zob. ensureOwnRange)`);
  // numer dla wiersza z innego komputera: numer źródła, jeśli wolny i spoza własnej przestrzeni (ta jest
  // zarezerwowana na notatki tej maszyny); własny wiersz odtwarzany z huba (pull --full po przywróceniu kopii
  // bazy) wraca pod swój numer, a licznik nie cofa się poniżej niego
  const pick = (kind: "obs" | "sum", g: string, taken: boolean): number => {
    const cand = gidNumber(g);
    const valid = Number.isSafeInteger(cand) && cand > 0 && !taken;
    const inOwn = cand >= lo && cand <= hi;
    if (valid && gidOrigin(g) === device && inOwn) {
      own[kind] = Math.max(own[kind], cand);
      return cand;
    }
    return valid && !inOwn ? cand : ++own[kind];
  };
  const counter: Record<Op["t"], keyof ApplyStats> = {
    session: "sessions",
    obs: "observations",
    status: "statuses",
    prompt: "prompts",
    sum: "summaries",
    ws: "workState",
  };
  const one = (op: Op): boolean => {
    switch (op.t) {
      case "session":
        if (op.h) hlc.observe(op.h);
        return applySession(repo, device, op, from);
      case "obs":
        return applyObs(repo, op, pick);
      case "status":
        hlc.observe(op.h);
        return applyStatus(repo, device, op);
      case "prompt":
        return applyPrompt(repo, op);
      case "sum":
        return applySummary(repo, device, op, pick);
      case "ws":
        return applyWs(repo, op);
    }
  };
  const t0 = performance.now();
  let i = start;
  while (i < ops.length && (i === start || performance.now() - t0 < budgetMs)) {
    const raw = ops[i++];
    // pełna kontrola typów (treść z sieci, także od urządzenia z błędem albo złośliwego członka grupy) i pochodzenia:
    // wiersz (notatka, prompt, podsumowanie, lista pracy) wysyła tylko jego urządzenie źródłowe, inaczej urządzenie
    // mogłoby zająć cudzy gid i zablokować prawdziwy wiersz; status może zmienić każde urządzenie
    if (!OP_SCHEMA.safeParse(raw).success) {
      stats.rejected++;
      continue;
    }
    const op = raw as Op;
    if (op.t !== "session" && op.t !== "status" && gidOrigin(op.g) !== from) {
      stats.rejected++;
      continue;
    }
    // zegar wersji ponad dobę w przyszłości (MAX_CLOCK_AHEAD_MS): odrzucony, zanim wygra konflikty i przesunie zegar
    if ((op.t === "status" || op.t === "session") && op.h && !hlc.plausible(op.h)) {
      stats.rejected++;
      stats.future++;
      stats.futureMax = Math.max(stats.futureMax, parseHlc(op.h)?.wall ?? 0);
      continue;
    }
    // każda operacja w osobnym SAVEPOINT: błąd bazy przy jednej (ograniczenie, zły typ, który przeszedł kontrolę)
    // cofa tylko ją, a odbiór idzie dalej (inaczej jeden zatruty wpis zatrzymałby odbiór całej grupy na zawsze)
    try {
      if (repo.db.transaction(() => one(op))()) stats[counter[op.t]]++;
      else stats.skipped++;
    } catch {
      stats.rejected++;
    }
  }
  setSeq(repo, "observations", own.obs);
  setSeq(repo, "summaries", own.sum);
  return i;
}

// ---------- kontrola operacji z sieci ----------

const zs = z.string();
const zns = z.string().nullable();
const zn = z.number();
const znn = z.number().nullable();
const zint = z.number().int();
const zsa = z.array(z.string());
const zobj = z.custom<Record<string, unknown>>((v) => !!v && typeof v === "object" && !Array.isArray(v));
const zgid = z.string().regex(GID_RE);
const zhlc = z.string().regex(/^\d{15}\.\d{6}\.\d{6}$/);

/** Pełny kształt każdej operacji (typ każdego pola); nieznany rodzaj operacji też nie przechodzi. */
const OP_SCHEMA = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("session"),
    sid: zs.min(1),
    h: zhlc.optional(),
    f: z.object({
      project: zs,
      cwd: zns,
      git_branch: zns,
      title: zns,
      first_prompt: zns,
      started_at: zn,
      ended_at: znn,
      last_activity_at: znn,
      prompt_count: zn,
      model: zns,
      status: zs,
    }),
  }),
  z.object({
    t: z.literal("obs"),
    g: zgid,
    o: z.object({
      session_id: zns,
      project: zs,
      prompt_n: zint.nullable(),
      type: zs.min(1),
      tier: zns,
      title: zs,
      subtitle: zns,
      narrative: zns,
      facts: zsa,
      concepts: zsa,
      files_read: zsa,
      files_modified: zsa,
      text: zns,
      created_at: zn,
      importance: znn,
      source: zs.min(1),
      content_hash: zns,
      turn_key: zns,
      git_head: zns,
      meta: zobj.nullable(),
    }),
    e: z.array(z.tuple([zs, zs, zs])),
  }),
  z.object({
    t: z.literal("status"),
    g: zgid,
    h: zhlc,
    s: z.enum(["active", "merged", "superseded", "archived"]),
    into: zgid.nullable(),
    by: zgid.nullable(),
    until: znn,
    m: z
      .object({ forgotten_at: zn.optional(), forget_reason: zs.optional(), restored_at: zn.optional(), undone_at: zn.optional() })
      .nullable()
      .optional(),
  }),
  z.object({ t: z.literal("prompt"), g: zgid, sid: zs.min(1), project: zs, n: zint, text: zs, at: zn, src: zs }),
  z.object({
    t: z.literal("sum"),
    g: zgid,
    rep: z.boolean(),
    s: z.object({
      session_id: zns,
      project: zs,
      request: zns,
      investigated: zns,
      learned: zns,
      completed: zns,
      next_steps: zns,
      notes: zns,
      files_read: zsa,
      files_edited: zsa,
      prompt_n: zint.nullable(),
      created_at: zn,
      source: zs,
      meta: zobj.nullable(),
    }),
  }),
  z.object({ t: z.literal("ws"), g: zgid, project: zs, list: zs.min(1), fields: zobj, at: zn, src: zs, cm: zint.nullable() }),
]);

function applySession(repo: Repo, device: number, op: Extract<Op, { t: "session" }>, from: number): boolean {
  // identyfikator sesji też po redakcji (tak samo u nadawcy i w notatkach, które ją wskazują)
  const sid = clean(op.sid);
  const x = repo.db.query("SELECT origin, hash, hlc FROM sync_sessions WHERE id = ?").get(sid) as {
    origin: number;
    hash: string;
    hlc: string | null;
  } | null;
  if (x?.origin === device) return false;
  // sesja istnieje tu jako własna (np. ten sam import claude-mem na obu komputerach): nie nadpisujemy
  if (!x && repo.getSession(sid)) return false;
  // wersja nie nowsza od już przyjętej (powtórka dziennika od zera, wpis pominięty i dociągnięty później)
  const h = typeof op.h === "string" && parseHlc(op.h) ? op.h : null;
  if (x?.hlc && (!h || h <= x.hlc)) return false;
  const f = sessionFields(op.f);
  const hash = sessionHash(f);
  if (x?.hash === hash) {
    if (h) repo.db.run("UPDATE sync_sessions SET hlc = ? WHERE id = ?", [h, sid]);
    return false;
  }
  // sesja z innego komputera: bez ścieżki transkryptu (to jego dysk), źródło „sync”
  repo.db.run(
    `INSERT INTO sessions (id, project, cwd, git_branch, title, first_prompt, started_at, ended_at, last_activity_at,
       prompt_count, transcript_path, transcript_offset, source, model, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'sync', ?, ?)
     ON CONFLICT(id) DO UPDATE SET project = excluded.project, cwd = excluded.cwd, git_branch = excluded.git_branch,
       title = excluded.title, first_prompt = excluded.first_prompt, started_at = excluded.started_at,
       ended_at = excluded.ended_at, last_activity_at = excluded.last_activity_at, prompt_count = excluded.prompt_count,
       model = excluded.model, status = excluded.status`,
    [
      sid,
      repo.mergedProject(f.project),
      f.cwd,
      f.git_branch,
      f.title,
      f.first_prompt,
      f.started_at,
      f.ended_at,
      f.last_activity_at,
      f.prompt_count,
      f.model,
      f.status,
    ],
  );
  repo.db.run(
    "INSERT INTO sync_sessions (id, origin, hash, hlc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, hlc = excluded.hlc",
    [sid, x?.origin ?? from, hash, h],
  );
  return true;
}

function applyObs(
  repo: Repo,
  op: Extract<Op, { t: "obs" }>,
  pick: (kind: "obs" | "sum", g: string, taken: boolean) => number,
): boolean {
  if (mapGet(repo, "obs", op.g) !== null) return false;
  const o = op.o;
  const project = repo.mergedProject(clean(o.project));
  const turnKey = cl(o.turn_key);
  const db = repo.db;
  const link = (local: number) => {
    mapPut(repo, "obs", op.g, local);
    resolveRefs(repo, op.g, local);
    const reg = db.query("SELECT * FROM sync_status WHERE gid = ?").get(op.g) as any;
    if (reg) {
      setLocalStatus(repo, local, reg.status, reg.into_gid, reg.by_gid, reg.valid_until);
      applyIntent(repo, local, J(reg.intent));
    }
    breakMergeCycle(repo, local);
  };
  // ta sama tura (ten sam klucz transkryptu) albo ta sama notatka pod tym samym numerem (wspólny import claude-mem)
  if (turnKey) {
    const ex = db.query("SELECT id FROM observations WHERE turn_key = ?").get(turnKey) as { id: number } | null;
    if (ex) {
      link(ex.id);
      return false;
    }
  }
  const cand = gidNumber(op.g);
  const at = Number.isSafeInteger(cand)
    ? (db.query("SELECT content_hash, created_at FROM observations WHERE id = ?").get(cand) as {
        content_hash: string | null;
        created_at: number;
      } | null)
    : null;
  if (at && at.content_hash === o.content_hash && at.created_at === o.created_at) {
    link(cand);
    return false;
  }
  // identyczna treść w tym projekcie: jedna notatka (jak deduplikacja w insertObservation, ale bez podbijania powtórek)
  if (o.content_hash && o.source !== "claude-mem") {
    const dup = db
      .query("SELECT id FROM observations WHERE project = ? AND content_hash = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(project, o.content_hash) as { id: number } | null;
    if (dup) {
      link(dup.id);
      return false;
    }
  }
  const id = pick("obs", op.g, !!at);
  const entities: EntityRef[] = cleanEntities(op.e).map(([kind, key, role]) => ({ kind, key, role }) as EntityRef);
  // każdy tekst po redakcji (nadawca mógł mieć starsze reguły albo wyłączoną redakcję); content_hash nadawcy zostaje
  const n: NewObservation = {
    id,
    session_id: cl(o.session_id),
    project,
    prompt_n: o.prompt_n ?? null,
    type: clean(o.type),
    tier: (cl(o.tier) as NewObservation["tier"]) || "episodic",
    title: clean(String(o.title ?? "")),
    subtitle: cl(o.subtitle),
    narrative: cl(o.narrative),
    facts: clArr(o.facts),
    concepts: clArr(o.concepts),
    files_read: clArr(o.files_read),
    files_modified: clArr(o.files_modified),
    text: cl(o.text),
    created_at: Number(o.created_at) || 0,
    importance: typeof o.importance === "number" && Number.isFinite(o.importance) ? o.importance : 0.3,
    source: clean(o.source) as NewObservation["source"],
    content_hash: o.content_hash ?? null,
    turn_key: turnKey,
    status: "active",
    git_head: cl(o.git_head),
    meta: syncMeta(o.meta),
  };
  const r = repo.insertObservation(n, entities);
  link(r.id);
  return r.duplicateOf === undefined;
}

/** Notatka, na którą wskazywały rejestry (cel scalenia, następca), właśnie przyszła: uzupełniamy odnośniki. */
function resolveRefs(repo: Repo, g: string, local: number): void {
  repo.db.run(
    "UPDATE observations SET merged_into = ? WHERE status = 'merged' AND id IN (SELECT m.local_id FROM sync_status s JOIN sync_map m ON m.kind = 'obs' AND m.gid = s.gid WHERE s.into_gid = ?)",
    [local, g],
  );
  repo.db.run(
    "UPDATE observations SET superseded_by = ? WHERE status = 'superseded' AND id IN (SELECT m.local_id FROM sync_status s JOIN sync_map m ON m.kind = 'obs' AND m.gid = s.gid WHERE s.by_gid = ?)",
    [local, g],
  );
}

function setLocalStatus(
  repo: Repo,
  local: number,
  status: string,
  into: string | null,
  by: string | null,
  until: number | null,
): void {
  repo.db.run(
    "UPDATE observations SET status = ?, merged_into = ?, superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?",
    [
      status,
      status === "merged" && into ? mapGet(repo, "obs", into) : null,
      status === "superseded" && by ? mapGet(repo, "obs", by) : null,
      status === "active" ? null : until,
      Date.now(),
      local,
    ],
  );
  // powrót do aktywnych (np. przywrócenie po scaleniu na innym komputerze): sen skasował bity scalonej notatki, więc
  // wektor wraca do kolejki, jak w Repo.setStatus
  if (status === "active") repo.requeueVectors([local]);
}

/**
 * Scalenia z dwóch maszyn mogą zamknąć cykl (X w Y i Y w X: obie notatki znikają z przypominania). Cykl przerywa
 * notatka o najmniejszym gid w cyklu (ten sam wybór na każdej maszynie): wraca do stanu aktywnego, a ta zmiana idzie
 * dalej jak każda lokalna (najnowszy zegar), więc wszystkie maszyny kończą z tą samą aktywną notatką.
 */
function breakMergeCycle(repo: Repo, start: number): void {
  const q = repo.db.query("SELECT status, merged_into FROM observations WHERE id = ?");
  const path: number[] = [];
  let cur = start;
  for (let i = 0; i < 64; i++) {
    const r = q.get(cur) as { status: string; merged_into: number | null } | null;
    if (r?.status !== "merged" || !r.merged_into) return;
    path.push(cur);
    const k = path.indexOf(r.merged_into);
    if (k >= 0) {
      const cycle = path.slice(k).map((id) => ({ id, g: gidOf(repo, id) }));
      const keyed = cycle.filter((c) => c.g !== null) as { id: number; g: string }[];
      const survivor = keyed.length ? keyed.sort((a, b) => compareGid(a.g, b.g))[0].id : Math.min(...cycle.map((c) => c.id));
      repo.db.run("UPDATE observations SET status = 'active', merged_into = NULL, valid_until = NULL WHERE id = ?", [survivor]);
      repo.requeueVectors([survivor]); // jak w setLocalStatus: wraca bez bitów, wektor do przeliczenia
      return;
    }
    cur = r.merged_into;
  }
}

function applyStatus(repo: Repo, device: number, op: Extract<Op, { t: "status" }>): boolean {
  if (!OBS_STATUSES.has(op.s) || typeof op.h !== "string" || !parseHlc(op.h)) return false;
  if ((op.into !== null && !validGid(op.into)) || (op.by !== null && !validGid(op.by))) return false;
  const reg = repo.db.query("SELECT * FROM sync_status WHERE gid = ?").get(op.g) as any;
  if (reg && reg.hlc >= op.h) return false;
  const local = mapGet(repo, "obs", op.g);
  /** Notatka ma już ten stan (np. forget tutaj, archiwum snu tam): ślad decyzji łączony, nie zastępowany. */
  let same = false;
  if (local !== null) {
    const r = repo.db
      .query("SELECT status, merged_into, superseded_by, valid_until FROM observations WHERE id = ?")
      .get(local) as any;
    const cur = r ? localStatus(repo, r) : null;
    // zmiana lokalna jeszcze niewysłana (stan inny niż rejestr): liczy się z zegarem z chwili zmiany statusu
    if (
      cur &&
      !sameStatus(repo, cur, {
        status: reg?.status ?? "active",
        into: reg?.into_gid ?? null,
        by: reg?.by_gid ?? null,
        until: reg?.valid_until ?? null,
      }) &&
      hlcString(statusChangedAt(repo, local), 0, device) > op.h
    )
      return false;
    same = !!cur && sameStatus(repo, cur, { status: op.s, into: op.into, by: op.by, until: op.until });
  }
  // ślad decyzji po sprawdzeniu typów i redakcji powodu (intentOf), w rejestrze i w meta notatki
  const m = op.m ? intentOf(op.m, true) : null;
  putStatus(repo, { gid: op.g, hlc: op.h, s: op.s, into: op.into, by: op.by, until: op.until, m });
  if (local !== null) {
    setLocalStatus(repo, local, op.s, op.into, op.by, op.until);
    applyIntent(repo, local, m, same);
    breakMergeCycle(repo, local);
  }
  return true;
}

function applyPrompt(repo: Repo, op: Extract<Op, { t: "prompt" }>): boolean {
  if (mapGet(repo, "prompt", op.g) !== null) return false;
  const r = repo.insertTurnPrompt({
    session_id: clean(op.sid),
    project: repo.mergedProject(clean(op.project)),
    n: op.n,
    text: clean(String(op.text ?? "")),
    created_at: op.at,
    source: clean(op.src) || "sync",
  });
  mapPut(repo, "prompt", op.g, r.id);
  return true;
}

function applySummary(
  repo: Repo,
  device: number,
  op: Extract<Op, { t: "sum" }>,
  pick: (kind: "obs" | "sum", g: string, taken: boolean) => number,
): boolean {
  if (mapGet(repo, "sum", op.g) !== null) return false;
  // identyfikatory też po redakcji (tak samo jak u nadawcy i w sesji)
  const s = { ...op.s, session_id: cl(op.s.session_id), project: clean(op.s.project), source: clean(op.s.source) || "sync" };
  const db = repo.db;
  const cand = gidNumber(op.g);
  const at = Number.isSafeInteger(cand)
    ? (db.query("SELECT created_at FROM summaries WHERE id = ?").get(cand) as { created_at: number } | null)
    : null;
  // to samo podsumowanie pod tym samym numerem (wspólny import claude-mem)
  if (at && at.created_at === s.created_at) {
    mapPut(repo, "sum", op.g, cand);
    return false;
  }
  const start = s.source === "compact" ? (s.meta as { start?: unknown } | null)?.start : undefined;
  if (start !== undefined && s.session_id) {
    const ex = db
      .query("SELECT id FROM summaries WHERE session_id = ? AND source = 'compact' AND json_extract(meta, '$.start') = ?")
      .get(s.session_id, start as any) as { id: number } | null;
    if (ex) {
      mapPut(repo, "sum", op.g, ex.id);
      return false;
    }
  }
  const id = pick("sum", op.g, !!at);
  const row = {
    id,
    session_id: s.session_id ?? null,
    project: repo.mergedProject(s.project),
    request: cl(s.request),
    investigated: cl(s.investigated),
    learned: cl(s.learned),
    completed: cl(s.completed),
    next_steps: cl(s.next_steps),
    notes: cl(s.notes),
    files_read: clArr(s.files_read),
    files_edited: clArr(s.files_edited),
    prompt_n: s.prompt_n ?? null,
    created_at: Number(s.created_at) || 0,
    source: s.source,
    meta: syncMeta(s.meta),
  };
  // zastąpienie tylko w sesji z innego komputera (podsumowań własnej sesji nie ruszamy)
  const origin = s.session_id
    ? (db.query("SELECT origin FROM sync_sessions WHERE id = ?").get(s.session_id) as { origin: number } | null)?.origin
    : undefined;
  const foreignSession = !!s.session_id && (origin === undefined ? !repo.getSession(s.session_id) : origin !== device);
  const local =
    op.rep && s.session_id && foreignSession ? repo.replaceSessionSummary(s.session_id, row) : repo.insertSummary(row);
  mapPut(repo, "sum", op.g, local);
  return true;
}

function applyWs(repo: Repo, op: Extract<Op, { t: "ws" }>): boolean {
  if (mapGet(repo, "ws", op.g) !== null) return false;
  if (op.cm !== null && op.cm !== undefined) {
    const ex = repo.db.query("SELECT id FROM work_state WHERE cm_id = ?").get(op.cm) as { id: number } | null;
    if (ex) {
      mapPut(repo, "ws", op.g, ex.id);
      return false;
    }
  }
  const fields = clObj(op.fields) ?? {};
  const project = repo.mergedProject(clean(op.project));
  const list = clean(op.list);
  // ten sam wpis pod innym gid (urządzenie dołączone ponownie wysyła swoje wpisy jeszcze raz pod nowym numerem):
  // projekt, lista, czas i pola te same, więc to jeden wpis, nie nowy
  const same = repo.db
    .query("SELECT id FROM work_state WHERE project = ? AND list_name = ? AND created_at = ? AND fields = ? LIMIT 1")
    .get(project, list, op.at, JSON.stringify(fields)) as { id: number } | null;
  if (same) {
    mapPut(repo, "ws", op.g, same.id);
    return false;
  }
  const id = repo.appendWorkState(project, list, fields, op.at, clean(op.src) || "sync", op.cm ?? null);
  mapPut(repo, "ws", op.g, id);
  return true;
}
