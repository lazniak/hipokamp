// Podłączenie innych harnessów (Gemini CLI, Antigravity, Cursor, OpenCode, Claude Desktop): serwer MCP hipokampa
// w ich konfiguracji, hooki zapisu sesji (Gemini CLI, Cursor) i plugin OpenCode. Jak w Codexie (harness.ts): zmiana
// idempotentna, kopia pliku w ~/.hipokamp/backups/<czas>/ przed zapisem, harnessu bez katalogu konfiguracji nie
// ruszamy, a rollback zdejmuje tylko wpisy hipokampa. Pliki JSON i JSONC zmieniamy punktowo (jsonedit.ts): cudze
// wpisy, komentarze i wcięcia zostają, a zdjęcie wpisu oddaje plik w poprzedniej postaci.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cursorDir, listCursorTranscripts } from "../capture/cursor.ts";
import { geminiDir, listGeminiChats } from "../capture/gemini.ts";
import {
  antigravityMcpFiles,
  claudeDesktopDir,
  detected,
  HARNESSES,
  type Harness,
  harnessKey,
  harnessOn,
  harnessStateFile,
  LABEL,
  listDesktopTranscripts,
  opencodeDir,
  opencodeTranscripts,
} from "../capture/harnesses.ts";
import { configPath, DATA_DIR, loadConfig, paths } from "../config.ts";
import { appendAt, getAt, insertAt, readJsonc, removeAt, removeFromArray, setAt } from "./jsonedit.ts";

type Log = (m: string) => void;

const REPO = resolve(import.meta.dir, "..", "..");
const WIN = process.platform === "win32";
const fwd = (p: string) => p.replace(/\\/g, "/");

/** Hooki Gemini CLI: zdarzenie, argument hook.ts, limit czasu (ms), matcher. */
const GEMINI_HOOKS: { event: string; arg: string; timeout: number; matcher?: string }[] = [
  { event: "SessionStart", arg: "session-start", timeout: 15_000 },
  { event: "BeforeAgent", arg: "prompt", timeout: 10_000 },
  { event: "AfterTool", arg: "post-tool", timeout: 8_000, matcher: "read_file|write_file|replace" },
  { event: "AfterAgent", arg: "stop", timeout: 30_000 },
  { event: "PreCompress", arg: "pre-compact", timeout: 30_000 },
  { event: "SessionEnd", arg: "session-end", timeout: 10_000 },
];

/** Hooki Cursora (limit w sekundach): kontekst na start, przypomnienie przy pliku (`postToolUse` przyjmuje
 *  `additional_context`; matcher to wyrażenie na nazwie narzędzia, Cursor nie dokleja kotwic, więc są w nim: bez nich
 *  łapałby TodoWrite; Delete pomijamy, przypomnienie o usuniętym pliku nic nie da), zapis po turze i na koniec. Prompt
 *  kontekstu nie przyjmuje (beforeSubmitPrompt tylko przepuszcza albo blokuje), więc go nie rejestrujemy. */
const CURSOR_HOOKS: { event: string; arg: string; timeout: number; matcher?: string }[] = [
  { event: "sessionStart", arg: "session-start", timeout: 15 },
  { event: "postToolUse", arg: "post-tool", timeout: 8, matcher: "^(Read|Write|StrReplace|Edit|read_file|search_replace)$" },
  { event: "stop", arg: "stop", timeout: 30 },
  { event: "sessionEnd", arg: "session-end", timeout: 10 },
];

const isOursCmd = (c: unknown) => typeof c === "string" && /hipokamp/i.test(c) && /hook\.ts/.test(c);
const oursIn = (v: any) => Array.isArray(v?.hooks) && v.hooks.some((h: any) => isOursCmd(h?.command));
/**
 * Wpis Cursora ({command}) hipokampa albo grupa Gemini CLI ({matcher, hooks: [...]}) z samymi hookami hipokampa.
 * Grupa z cudzymi hookami nie jest nasza: schodzi z niej tylko nasz hook (stripMixed), a grupa zostaje.
 */
const isOurs = (v: any) =>
  isOursCmd(v?.command) || (Array.isArray(v?.hooks) && v.hooks.length > 0 && v.hooks.every((h: any) => isOursCmd(h?.command)));

/** Nasz hook z grup Gemini CLI zdarzenia `ev`, w których są też cudze: grupa zostaje na swoim miejscu. */
function stripMixed(t: string, ev: string): string {
  const list = getAt(t, ["hooks", ev]);
  if (!Array.isArray(list)) return t;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isOurs(list[i]) || !oursIn(list[i])) continue;
    t = removeFromArray(
      t,
      ["hooks", ev, String(i), "hooks"],
      (h) => isOursCmd(h?.command),
      () => false,
    ).text;
  }
  return t;
}

interface Ctx {
  dryRun: boolean;
  log: Log;
  bun: string;
  /** Katalog kopii tej instalacji (jeden na przebieg). */
  backupDir: string;
  /** Pliki już obsłużone przez rollback w tym przebiegu (przywracanie hooków claude-mem ich nie powtarza). */
  seen?: Set<string>;
  /** --replace-claude-mem: hooki claude-mem w harnessach (Cursor) schodzą razem z claude-mem. */
  replaceClaudeMem?: boolean;
}

/**
 * Testy z katalogiem „hipokamp-test” nigdy nie piszą do prawdziwej konfiguracji harnessów: plik spoza katalogu
 * testowego przy testowym HIPOKAMP_HOME jest odrzucany (zabezpieczenie na wypadek testu bez podmienionego HOME).
 */
function allowed(file: string, log: Log): boolean {
  if (!DATA_DIR.includes("hipokamp-test") || file.includes("hipokamp-test")) return true;
  log(`pomijam ${file}: testowy HIPOKAMP_HOME, a plik leży poza katalogiem testowym`);
  return false;
}

/**
 * Stan instalacji (state/harness-files.json): co instalacja założyła albo nadpisała, więc rollback oddaje
 * konfigurację w postaci sprzed instalacji, i które harnessy podłączyła (zapis ich sesji rusza dopiero po instalacji).
 */
interface Made {
  /** Pliki założone przez instalację: rollback usuwa je, gdy nic w nich nie zostało. */
  files: string[];
  /** Klucze założone przez instalację (obiekty, tablice, `version` w hooks.json Cursora); cudzych pustych nie ruszamy. */
  keys: Record<string, string[][]>;
  /** Wpisy serwera MCP zapisane przez instalację; wpis hipokamp dopisany wcześniej ręcznie rollback zostawia. */
  owned: Record<string, string[][]>;
  /** Wpisy serwera MCP sprzed instalacji, które instalacja nadpisała: rollback oddaje ich wartość. */
  prior: Record<string, { path: string[]; value: unknown }[]>;
  /** Pliki puste (same odstępy) przed instalacją: rollback oddaje ich treść, gdy dokument znów jest pusty. */
  blank: Record<string, string>;
  /** Harnessy podłączone przez `hipokamp install` (bez późniejszego rollbacku). */
  installed: string[];
  /** Cudze hooki zdjęte przez instalację (claude-mem przy --replace-claude-mem): rollback dopisuje je z powrotem. */
  removed: Record<string, { event: string; index: number; value: unknown }[]>;
  /** Cudze pliki przeniesione przez instalację do kopii (plugin claude-mem w OpenCode): rollback odkłada je na miejsce. */
  moved: { from: string; to: string }[];
}

/** Co jedna zmiana pliku założyła albo nadpisała (zbiera `edit` w editFile, trafia do stanu instalacji). */
interface Note {
  keys: string[][];
  owned: string[][];
  prior: { path: string[]; value: unknown }[];
  removed: { event: string; index: number; value: unknown }[];
}

function readMade(): Made {
  let v: any = null;
  try {
    v = JSON.parse(readFileSync(harnessStateFile(), "utf8"));
  } catch {}
  const rec = (x: any) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  const strs = (x: any): string[] => (Array.isArray(x) ? x.filter((s: unknown) => typeof s === "string") : []);
  return {
    files: strs(v?.files),
    keys: rec(v?.keys),
    owned: rec(v?.owned),
    prior: rec(v?.prior),
    blank: rec(v?.blank),
    installed: strs(v?.installed),
    removed: rec(v?.removed),
    moved: Array.isArray(v?.moved) ? v.moved.filter((x: any) => typeof x?.from === "string" && typeof x?.to === "string") : [],
  };
}

function writeMade(m: Made): void {
  mkdirSync(paths.state(), { recursive: true });
  writeFileSync(harnessStateFile(), `${JSON.stringify(m, null, 2)}\n`);
}

const pathKey = (p: string[]) => p.join("\u0000");
const hasPath = (list: string[][] | undefined, p: string[]) => !!list?.some((k) => pathKey(k) === pathKey(p));

function addPaths(rec: Record<string, string[][]>, file: string, add: string[][]): void {
  if (!add.length) return;
  const list = (rec[file] ??= []);
  for (const p of add) if (!hasPath(list, p)) list.push(p);
}

/** Klucze ścieżki (od pierwszego do `upTo`-tego), których w dokumencie jeszcze nie ma: dopisanie wpisu je założy. */
function missing(t: string, path: string[], upTo: number, made: string[][]): void {
  for (let d = 1; d <= upTo; d++) if (getAt(t, path.slice(0, d)) === undefined) made.push(path.slice(0, d));
}

/** Dokument bez żadnego klucza (`{}`, pusty plik). */
function isEmptyDoc(t: string): boolean {
  try {
    const d = readJsonc(t);
    return !!d && typeof d === "object" && !Array.isArray(d) && !Object.keys(d).length;
  } catch {
    return false;
  }
}

/** Kopia pliku przed pierwszym zapisem w tym przebiegu (drugi zapis tego samego pliku: kopia zostaje sprzed pierwszego). */
function backupOnce(c: Ctx, file: string): void {
  mkdirSync(c.backupDir, { recursive: true });
  const name = fwd(file)
    .replace(/^[A-Za-z]:/, "")
    .replace(/[/:]+/g, "__")
    .replace(/^_+/, "");
  if (!existsSync(join(c.backupDir, name))) copyFileSync(file, join(c.backupDir, name));
}

/**
 * Zapis pliku konfiguracji. Plik tylko do odczytu zostaje (błąd). Zwykły plik przez plik tymczasowy i rename, więc
 * przerwany zapis nie zostawia połowy pliku (gdy system nie pozwala podmienić pliku, np. otwartego w innym programie
 * na Windows, zapis w miejscu). Dowiązanie zapisujemy w miejscu: zostaje dowiązaniem, zmienia się jego cel.
 */
function writeSafe(file: string, text: string): void {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
    return;
  }
  const st = statSync(file);
  if (!(st.mode & 0o200)) throw new Error("plik tylko do odczytu");
  if (lstatSync(file).isSymbolicLink()) {
    writeFileSync(file, text);
    return;
  }
  const tmp = `${file}.hipokamp-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: st.mode & 0o777 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (!["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException)?.code ?? "")) throw e;
    writeFileSync(file, text);
  }
}

/**
 * Zmiana pliku konfiguracji przez `edit` (tekst → tekst; `note` zbiera założone i nadpisane wpisy): kopia przed
 * zapisem, nic przy braku zmian albo błędzie (błąd odczytu, składni albo zapisu trafia do logu, plik bez zmian).
 * Założony plik, klucze i wpisy trafiają do stanu instalacji. Wynik: true (zmieniony), false (bez zmian), null (błąd
 * albo plik odrzucony, już w logu).
 */
function editFile(c: Ctx, file: string, label: string, edit: (text: string, note: Note) => string): boolean | null {
  if (!allowed(file, c.log)) return null;
  const had = existsSync(file);
  let text = "";
  let next: string;
  const note: Note = { keys: [], owned: [], prior: [], removed: [] };
  try {
    if (had) text = readFileSync(file, "utf8");
    next = edit(text, note);
  } catch (e) {
    c.log(`${label}: nie czytam ${file} (${String(e).slice(0, 120)}); nie zmieniam`);
    return null;
  }
  if (next === text) return false;
  if (c.dryRun) return true;
  try {
    if (had) backupOnce(c, file);
    writeSafe(file, next);
  } catch (e) {
    c.log(`${label}: BŁĄD zapisu ${file} (${String(e).slice(0, 160)}); plik bez zmian`);
    return null;
  }
  const blank = had && !text.trim();
  if (!had || blank || note.keys.length || note.owned.length || note.prior.length || note.removed.length) {
    const m = readMade();
    if (!had && !m.files.includes(file)) m.files.push(file);
    if (blank && m.blank[file] === undefined) m.blank[file] = text;
    addPaths(m.keys, file, note.keys);
    addPaths(m.owned, file, note.owned);
    for (const p of note.prior) {
      const list = (m.prior[file] ??= []);
      if (!list.some((x) => pathKey(x.path) === pathKey(p.path))) list.push(p);
    }
    for (const r of note.removed) {
      const list = (m.removed[file] ??= []);
      // wpis rozróżnia zdarzenie, pozycja i wartość: dwa identyczne hooki (inna pozycja) i nowy hook claude-mem zdjęty
      // przy kolejnej instalacji z pozycji już zapisanej (inna wartość) to osobne wpisy, rollback odda wszystkie
      if (!list.some((x) => x.event === r.event && x.index === r.index && same(x.value, r.value))) list.push(r);
    }
    writeMade(m);
  }
  return true;
}

/** Opis zmiany do logu: w próbie z przedrostkiem i bez zapisu, przy zapisie z miejscem kopii (gdy plik już był). */
function plan(c: Ctx, label: string, file: string, what: string, had: boolean): string {
  if (c.dryRun)
    return `(próba) ${label}: ${file}: ${what}${had ? `; kopia przed zapisem do ${c.backupDir}` : "; plik powstanie"}`;
  return `${label}: ${file}: ${what}`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Wpis serwera MCP pod ścieżką kluczy. Wpis o tej nazwie sprzed instalacji (dopisany
 * ręcznie) z inną wartością jest zastępowany, a jego wartość trafia do stanu (rollback ją oddaje); taki sam zostaje.
 */
function putMcp(c: Ctx, file: string, label: string, path: string[], entry: unknown): void {
  const owned = hasPath(readMade().owned[file], path);
  const had = existsSync(file);
  let what = "";
  const changed = editFile(c, file, label, (t, note) => {
    const cur = getAt(t, path);
    if (same(cur, entry)) return t;
    if (cur === undefined) {
      missing(t, path, path.length - 1, note.keys);
      what = `dopisuje ${path.join(".")}`;
    } else if (!owned) {
      note.prior.push({ path, value: cur });
      what = `zastępuje ${path.join(".")} sprzed instalacji (rollback odda poprzednią wartość)`;
    } else what = `odświeża ${path.join(".")} (nowa ścieżka Buna albo repo)`;
    note.owned.push(path);
    return setAt(t, path, entry);
  });
  if (changed) c.log(plan(c, label, file, what, had));
  if (changed !== null)
    c.log(changed ? `${label}: serwer MCP hipokamp w ${file}` : `${label}: serwer MCP hipokampa już jest (${file})`);
}

/** Hooki hipokampa w tablicach `hooks.<zdarzenie>` (na końcu list: cudze wpisy zostają na swoich pozycjach). */
function putHooks(
  c: Ctx,
  file: string,
  label: string,
  groups: { event: string; value: unknown }[],
  init?: (t: string, made: string[][]) => string,
) {
  const had = existsSync(file);
  const added: string[] = [];
  const replaced: string[] = [];
  const changed = editFile(c, file, label, (t, note) => {
    const before = t;
    let touched = false;
    if (init) t = init(t, note.keys);
    for (const g of groups) {
      const path = ["hooks", g.event];
      const list = getAt(t, path);
      const arr: any[] = Array.isArray(list) ? list : [];
      const mine = arr.filter(isOurs);
      const mixed = arr.some((v) => !isOurs(v) && oursIn(v));
      if (!mixed && mine.length === 1 && same(mine[0], g.value)) continue;
      (mine.length || mixed ? replaced : added).push(g.event);
      missing(t, path, path.length, note.keys);
      // stary wpis hipokampa (inna ścieżka repo albo Buna, nasz hook w cudzej grupie) schodzi, pusta lista zostaje
      t = stripMixed(t, g.event);
      t = removeFromArray(t, path, isOurs, () => false).text;
      t = appendAt(t, path, g.value);
      touched = true;
    }
    // same klucze z init (np. `version`) bez zmiany hooków to nie zmiana pliku
    return touched ? t : before;
  });
  if (changed) {
    const what = [
      added.length ? `dopisuje hooki ${added.join(", ")}` : "",
      replaced.length ? `podmienia stare hooki hipokampa ${replaced.join(", ")}` : "",
    ];
    c.log(plan(c, label, file, what.filter(Boolean).join("; "), had));
  }
  if (changed !== null) c.log(changed ? `${label}: hooki hipokampa w ${file}` : `${label}: hooki hipokampa już są (${file})`);
}

/**
 * Hook claude-mem (wtyczka thedotmack) w hooks.json Cursora: wąsko, po skrypcie workera claude-mem i trybie
 * `hook cursor`, żeby nie zdjąć cudzych skryptów o podobnej nazwie (claude-memo-sync.js, claude-mem-db-backup.js).
 */
export const isClaudeMemHook = (v: any) =>
  typeof v?.command === "string" &&
  /thedotmack[\\/]+plugin[\\/]+scripts[\\/]+worker-service\.cjs"?\s+hook\s+cursor\b/i.test(v.command) &&
  !/hipokamp/i.test(v.command);

/**
 * Zdejmuje hooki claude-mem z hooks.json Cursora (`--replace-claude-mem`: claude-mem wyłączony, a jego hooki w Cursorze
 * wołałyby nieżywego workera). Kopia pliku przed zapisem, zdjęte wpisy w stanie instalacji, rollback je dopisuje;
 * puste listy zdarzeń zostają (rollback dopisze do nich).
 */
function stripClaudeMem(c: Ctx, file: string, label: string): void {
  if (!existsSync(file)) return;
  const gone: string[] = [];
  const changed = editFile(c, file, label, (t, note) => {
    const h = getAt(t, ["hooks"]);
    if (!h || typeof h !== "object" || Array.isArray(h)) return t;
    for (const ev of Object.keys(h)) {
      const list = getAt(t, ["hooks", ev]);
      if (!Array.isArray(list)) continue;
      list.forEach((v, index) => {
        if (!isClaudeMemHook(v)) return;
        note.removed.push({ event: ev, index, value: v });
        gone.push(ev);
      });
      t = removeFromArray(t, ["hooks", ev], isClaudeMemHook, () => false).text;
    }
    return t;
  });
  if (changed) {
    const by = [...new Set(gone)].map(
      (ev) => `${ev}${gone.filter((g) => g === ev).length > 1 ? `×${gone.filter((g) => g === ev).length}` : ""}`,
    );
    c.log(plan(c, label, file, `zdejmuje ${gone.length} hooków claude-mem (${by.join(", ")}); rollback je przywróci`, true));
  }
}

/**
 * Klucze założone przez instalację, które zostały puste: kontenery od najgłębszych, potem skalary (`version`
 * w hooks.json Cursora) tylko jako ostatni klucz swojego obiektu: gdy zostały cudze hooki, `version` zostaje z nimi.
 */
function dropMadeKeys(t: string, ours: string[][], prune: (p: string[]) => boolean): string {
  const sorted = [...ours].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    const v = getAt(t, p);
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v) ? !v.length : !Object.keys(v).length) t = removeAt(t, p, prune);
  }
  for (const p of sorted) {
    const v = getAt(t, p);
    if (v === undefined || (v !== null && typeof v === "object")) continue;
    const parent = p.length > 1 ? getAt(t, p.slice(0, -1)) : readJsonc(t);
    if (parent && typeof parent === "object" && Object.keys(parent).length === 1) t = removeAt(t, p, prune);
  }
  return t;
}

/**
 * Zdejmuje wpisy hipokampa (serwer MCP pod ścieżką, hooki we wszystkich zdarzeniach) i klucze założone przez
 * instalację. Wpis MCP sprzed instalacji wraca do swojej wartości, a taki, którego instalacja nie pisała, zostaje.
 */
function strip(c: Ctx, file: string, label: string, mcpPath: string[] | null, hooks: boolean): void {
  if (!existsSync(file)) {
    // plik ze zdjętymi hookami zniknął: nie ma ich gdzie oddać, wpis w stanie nie może zostać na zawsze
    const gone = readMade();
    if (gone.removed[file]) {
      c.log(`${c.dryRun ? "(próba) " : ""}${label}: ${file} nie istnieje; zdjętych hooków claude-mem nie ma gdzie przywrócić`);
      if (!c.dryRun) {
        delete gone.removed[file];
        writeMade(gone);
      }
    }
    return;
  }
  const m = readMade();
  const ours = m.keys[file] ?? [];
  const isOursKey = (p: string[]) => hasPath(ours, p);
  const prior = mcpPath ? (m.prior[file] ?? []).find((x) => pathKey(x.path) === pathKey(mcpPath)) : undefined;
  const owned = !!mcpPath && hasPath(m.owned[file], mcpPath);
  let left = "";
  let kept = false;
  let restored = 0;
  c.seen?.add(file);
  const changed = editFile(c, file, label, (t) => {
    restored = 0;
    if (mcpPath && getAt(t, mcpPath) !== undefined) {
      if (prior) t = setAt(t, mcpPath, prior.value);
      else if (owned) t = removeAt(t, mcpPath, isOursKey);
      else kept = true;
    }
    if (hooks) {
      const h = getAt(t, ["hooks"]);
      if (h && typeof h === "object")
        for (const ev of Object.keys(h)) {
          t = stripMixed(t, ev);
          t = removeFromArray(t, ["hooks", ev], isOurs, isOursKey).text;
        }
    }
    // cudze hooki zdjęte przez instalację (claude-mem) wracają na swoje pozycje, wstawiane punktowo (komentarze
    // i reszta listy zostają); hooka, który już jest (np. claude-mem dopisał go sam), nie dublujemy
    const back = new Map<string, { index: number; value: unknown }[]>();
    for (const r of m.removed[file] ?? []) back.set(r.event, [...(back.get(r.event) ?? []), r]);
    for (const [ev, rs] of back) {
      const cur = getAt(t, ["hooks", ev]);
      const have: unknown[] = Array.isArray(cur) ? cur : [];
      const left = [...have];
      const missing = [...rs]
        .sort((a, b) => a.index - b.index)
        .filter((r) => {
          const i = left.findIndex((v) => same(v, r.value));
          if (i < 0) return true;
          left.splice(i, 1);
          return false;
        });
      for (const r of missing) t = insertAt(t, ["hooks", ev], Math.max(0, r.index), r.value);
      restored += missing.length;
    }
    t = dropMadeKeys(t, ours, isOursKey);
    // plik pusty przed instalacją (same odstępy) wraca do swojej treści
    if (m.blank[file] !== undefined && isEmptyDoc(t)) t = m.blank[file];
    left = t;
    return t;
  });
  if (kept) c.log(`${label}: wpis ${mcpPath?.join(".")} w ${file} nie pochodzi z instalacji, zostawiam`);
  if (changed) c.log(`${label}: usuwam wpisy hipokampa z ${file}`);
  if (changed && restored) c.log(`${label}: przywracam ${restored} hooków claude-mem w ${file}`);
  // zdjęte hooki już są w pliku (nic do dopisania): wpis w stanie niczego nie oddaje
  if (!c.dryRun && changed === false && m.removed[file]) {
    const now = readMade();
    delete now.removed[file];
    writeMade(now);
  }
  if (c.dryRun || !changed) return;
  // plik założony przez instalację, w którym nic nie zostało: znika
  if (m.files.includes(file) && isEmptyDoc(left)) {
    try {
      rmSync(file);
      c.log(`${label}: usuwam pusty plik ${file} (założyła go instalacja)`);
      forgetMade(file);
    } catch (e) {
      c.log(`${label}: BŁĄD usuwania ${file} (${String(e).slice(0, 160)})`);
    }
    return;
  }
  const now = readMade();
  const keys = (now.keys[file] ?? []).filter((p) => getAt(left, p) !== undefined);
  if (keys.length) now.keys[file] = keys;
  else delete now.keys[file];
  if (mcpPath) {
    const o = (now.owned[file] ?? []).filter((k) => pathKey(k) !== pathKey(mcpPath));
    if (o.length) now.owned[file] = o;
    else delete now.owned[file];
    const p = (now.prior[file] ?? []).filter((x) => pathKey(x.path) !== pathKey(mcpPath));
    if (p.length) now.prior[file] = p;
    else delete now.prior[file];
  }
  if (now.blank[file] !== undefined && left === now.blank[file]) delete now.blank[file];
  delete now.removed[file];
  writeMade(now);
}

/** Plik założony przez instalację znika ze stanu (plugin OpenCode usunięty przy rollbacku). */
function forgetMade(file: string): void {
  const m = readMade();
  if (
    !m.files.includes(file) &&
    !m.keys[file] &&
    !m.owned[file] &&
    !m.prior[file] &&
    m.blank[file] === undefined &&
    !m.removed[file]
  )
    return;
  m.files = m.files.filter((f) => f !== file);
  delete m.keys[file];
  delete m.owned[file];
  delete m.prior[file];
  delete m.blank[file];
  delete m.removed[file];
  writeMade(m);
}

/** Harnessy podłączone (install) albo odłączone (rollback): od tego zależy zapis ich sesji przy `null` w config. */
function markInstalled(hs: Harness[], on: boolean): void {
  if (!hs.length) return;
  const m = readMade();
  const set = new Set(m.installed);
  for (const h of hs) on ? set.add(h) : set.delete(h);
  const next = HARNESSES.filter((h) => set.has(h));
  if (same(next, m.installed)) return;
  m.installed = next;
  writeMade(m);
}

const hookCmd = (c: Ctx, arg: string, h: string) =>
  `${WIN ? "& " : ""}"${fwd(c.bun)}" "${fwd(join(REPO, "src", "hooks", "hook.ts"))}" ${arg} ${h}`;
const mcpEntry = (c: Ctx) => ({ command: fwd(c.bun), args: [fwd(join(REPO, "src", "mcp", "server.ts"))] });

/** Plik konfiguracji OpenCode: istniejący opencode.json albo opencode.jsonc, inaczej nowy opencode.json. */
function opencodeConfig(): string {
  const d = opencodeDir();
  for (const f of ["opencode.json", "opencode.jsonc"]) if (existsSync(join(d, f))) return join(d, f);
  return join(d, "opencode.json");
}

/** Plik pluginu hipokampa: katalog plugins/ (albo starszy plugin/, gdy tylko on jest). */
function opencodePluginFile(): string {
  const d = opencodeDir();
  const dir = !existsSync(join(d, "plugins")) && existsSync(join(d, "plugin")) ? "plugin" : "plugins";
  return join(d, dir, "hipokamp.js");
}

const PLUGIN_MARK = "// hipokamp: zapis sesji OpenCode";

/** Pluginy claude-mem w katalogach pluginów OpenCode (plugins/ i starszy plugin/): obok hipokampa dają podwójny zapis
 *  i podwójny kontekst. */
function claudeMemPlugins(): string[] {
  const out: string[] = [];
  for (const dir of ["plugins", "plugin"]) {
    const d = join(opencodeDir(), dir);
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) if (/^claude-mem.*\.(?:m?js|ts)$/i.test(n)) out.push(join(d, n));
  }
  return out;
}

/** Przenosi plik (rename, a między dyskami kopia i usunięcie). */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EXDEV") throw e;
    copyFileSync(from, to);
    rmSync(from);
  }
}

/**
 * `--replace-claude-mem`: plugin claude-mem w OpenCode wędruje do kopii tej instalacji (OpenCode ładuje wszystko
 * z katalogu pluginów, więc samo wyłączenie nie wystarcza). Przeniesienie trafia do stanu, rollback odkłada plik.
 */
function moveClaudeMemPlugins(c: Ctx, label: string): void {
  for (const from of claudeMemPlugins()) {
    if (!allowed(from, c.log)) continue;
    const to = join(c.backupDir, "opencode-plugins", basename(from));
    if (c.dryRun) {
      c.log(`(próba) ${label}: ${from}: przenosi plugin claude-mem do ${to}; rollback go odłoży`);
      continue;
    }
    try {
      moveFile(from, to);
    } catch (e) {
      c.log(`${label}: BŁĄD przenoszenia ${from} (${String(e).slice(0, 160)}); plugin zostaje`);
      continue;
    }
    const m = readMade();
    m.moved = [...m.moved.filter((x) => x.from !== from), { from, to }];
    writeMade(m);
    c.log(`${label}: plugin claude-mem przeniesiony z ${from} do ${to}; rollback go odłoży`);
  }
}

/** Rollback: pliki przeniesione przez instalację wracają na miejsce (gdy miejsce jest wolne). */
function restoreMoved(c: Ctx): void {
  const m = readMade();
  if (!m.moved.length) return;
  const keep: { from: string; to: string }[] = [];
  for (const x of m.moved) {
    if (!allowed(x.from, c.log)) {
      keep.push(x);
      continue;
    }
    if (!existsSync(x.to)) {
      c.log(`claude-mem: brak kopii ${x.to}; ${x.from} nie wraca`);
      continue;
    }
    if (existsSync(x.from)) {
      c.log(`claude-mem: ${x.from} już jest, kopia zostaje w ${x.to}`);
      continue;
    }
    c.log(`${c.dryRun ? "(próba) " : ""}claude-mem: odkładam ${x.to} na miejsce (${x.from})`);
    if (c.dryRun) {
      keep.push(x);
      continue;
    }
    try {
      moveFile(x.to, x.from);
    } catch (e) {
      c.log(`claude-mem: BŁĄD odkładania ${x.from} (${String(e).slice(0, 160)})`);
      keep.push(x);
    }
  }
  if (c.dryRun) return;
  m.moved = keep;
  writeMade(m);
}

/**
 * Plik pluginu OpenCode: moduł hipokampa ładowany dynamicznie przy starcie pluginu, więc brak repo (przeniesione,
 * usunięte) albo błąd w nim wyłącza tylko zapis sesji, a OpenCode działa dalej.
 */
function opencodePluginSource(c: Ctx): string {
  const opts = {
    dir: fwd(opencodeTranscripts()),
    bun: fwd(c.bun),
    hook: fwd(join(REPO, "src", "hooks", "hook.ts")),
    config: fwd(configPath()),
    privateTools: loadConfig().capture.privateTools,
    ...(process.env.HIPOKAMP_HOME ? { home: fwd(DATA_DIR) } : {}),
  };
  return [
    `${PLUGIN_MARK} w pamięci hipokampa. Plik zapisał \`hipokamp install\`, usuwa go \`hipokamp rollback\`.`,
    "// Tylko eksport domyślny: OpenCode woła każdy eksport modułu jako plugin. Moduł hipokampa ładowany przy starcie",
    "// pluginu: gdy go nie ma albo ma błąd, plugin nic nie robi, a OpenCode działa dalej.",
    `const opts = ${JSON.stringify(opts)};`,
    "export default async function hipokamp(ctx) {",
    "  try {",
    `    const m = await import(${JSON.stringify(pathToFileURL(join(REPO, "src", "capture", "opencode-plugin.ts")).href)});`,
    "    return await m.default(opts)(ctx);",
    "  } catch {",
    "    return {};",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Dopisuje hipokamp do jednego harnessu; false, gdy harnessu nie ma na tej maszynie. */
function installOne(c: Ctx, h: Harness): boolean {
  const label = LABEL[h];
  if (!detected(h)) {
    c.log(`${label}: nie ma na tej maszynie, pomijam.`);
    return false;
  }
  switch (h) {
    case "gemini": {
      const f = join(geminiDir(), "settings.json");
      putMcp(c, f, label, ["mcpServers", "hipokamp"], mcpEntry(c));
      putHooks(
        c,
        f,
        label,
        GEMINI_HOOKS.map((e) => ({
          event: e.event,
          value: {
            ...(e.matcher ? { matcher: e.matcher } : {}),
            hooks: [{ name: "hipokamp", type: "command", command: hookCmd(c, e.arg, "gemini"), timeout: e.timeout }],
          },
        })),
      );
      break;
    }
    case "antigravity":
      for (const f of antigravityMcpFiles()) putMcp(c, f, label, ["mcpServers", "hipokamp"], mcpEntry(c));
      break;
    case "cursor": {
      putMcp(c, join(cursorDir(), "mcp.json"), label, ["mcpServers", "hipokamp"], mcpEntry(c));
      if (c.replaceClaudeMem) stripClaudeMem(c, join(cursorDir(), "hooks.json"), label);
      putHooks(
        c,
        join(cursorDir(), "hooks.json"),
        label,
        CURSOR_HOOKS.map((e) => ({
          event: e.event,
          value: { command: hookCmd(c, e.arg, "cursor"), timeout: e.timeout, ...(e.matcher ? { matcher: e.matcher } : {}) },
        })),
        (t, made) => {
          if (getAt(t, ["version"]) !== undefined) return t;
          made.push(["version"]);
          return setAt(t, ["version"], 1);
        },
      );
      break;
    }
    case "opencode": {
      const entry = { type: "local", command: [fwd(c.bun), fwd(join(REPO, "src", "mcp", "server.ts"))], enabled: true };
      const cfg = opencodeConfig();
      putMcp(c, cfg, label, ["mcp", "hipokamp"], entry);
      const pf = opencodePluginFile();
      if (c.replaceClaudeMem) moveClaudeMemPlugins(c, label);
      const had = existsSync(pf);
      const changed = editFile(c, pf, label, () => opencodePluginSource(c));
      if (changed)
        c.log(plan(c, label, pf, had ? "odświeża plugin hipokampa" : "zapisuje plugin hipokampa (zapis sesji i kontekst)", had));
      if (changed !== null)
        c.log(changed ? `${label}: plugin zapisu sesji ${pf}` : `${label}: plugin hipokampa już jest (${pf})`);
      break;
    }
    case "claude-desktop":
      putMcp(c, join(claudeDesktopDir(), "claude_desktop_config.json"), label, ["mcpServers", "hipokamp"], mcpEntry(c));
      break;
  }
  return true;
}

/**
 * Serwer MCP, hooki i plugin hipokampa w każdym wykrytym i włączonym harnessie (capture.harnesses i `skip`
 * z flag --no-<harness>). Zwraca harnessy, w których hipokamp jest podłączony (do rollbacku); od tej chwili zapis
 * ich sesji działa także przy `null` w capture.harnesses. Błąd jednego harnessu nie zatrzymuje pozostałych.
 */
export function installHarnesses(o: {
  dryRun: boolean;
  log: Log;
  bunPath?: string;
  skip?: Partial<Record<Harness, boolean>>;
  /** --replace-claude-mem: zdejmuje też hooki claude-mem z Cursora i plugin claude-mem z OpenCode, z kopią i rollbackiem. */
  replaceClaudeMem?: boolean;
}): Harness[] {
  const cfg = loadConfig();
  const c: Ctx = {
    dryRun: o.dryRun,
    log: o.log,
    bun: o.bunPath ?? process.execPath,
    backupDir: join(paths.backups(), new Date().toISOString().replace(/[:.]/g, "-")),
    replaceClaudeMem: o.replaceClaudeMem,
  };
  if (o.dryRun) o.log("harnessy (próba): plan zmian per plik poniżej, nic nie zapisuję");
  const done: Harness[] = [];
  for (const h of HARNESSES) {
    if (o.skip?.[h]) continue;
    if (cfg.capture.harnesses?.[harnessKey(h)] === false) {
      o.log(`${LABEL[h]}: wyłączony w config (capture.harnesses), pomijam.`);
      continue;
    }
    try {
      if (installOne(c, h)) done.push(h);
    } catch (e) {
      o.log(`${LABEL[h]}: BŁĄD (${String(e).slice(0, 160)}); pomijam ten harness`);
    }
  }
  if (!o.dryRun) markInstalled(done, true);
  if (done.includes("gemini") || done.includes("cursor") || done.includes("opencode"))
    o.log("harnessy: nowe hooki i plugin działają od nowych sesji (Gemini CLI, Cursor, OpenCode po restarcie).");
  if (!o.dryRun && done.length && existsSync(c.backupDir)) o.log(`kopie plików harnessów: ${c.backupDir}`);
  return done;
}

/**
 * Zdejmuje hipokamp z podanych harnessów (rollback): serwer MCP, hooki, plugin; reszta plików zostaje. Błąd jednego
 * harnessu trafia do logu, a rollback idzie dalej.
 */
export function uninstallHarnesses(o: { dryRun: boolean; log: Log; harnesses: Harness[] }): void {
  const c: Ctx = {
    dryRun: o.dryRun,
    log: o.log,
    bun: process.execPath,
    backupDir: join(paths.backups(), new Date().toISOString().replace(/[:.]/g, "-")),
    seen: new Set(),
  };
  const off: Harness[] = [];
  for (const h of o.harnesses) {
    const label = LABEL[h];
    try {
      uninstallOne(c, h, label);
      off.push(h);
    } catch (e) {
      o.log(`${label}: BŁĄD (${String(e).slice(0, 160)}); idę dalej`);
    }
  }
  // cudze wpisy zdjęte i pliki przeniesione przez instalację wracają niezależnie od listy harnessów: błąd instalacji
  // po zdjęciu hooków claude-mem zostawia harness poza listą, a zdjęte hooki i tak muszą wrócić
  try {
    for (const file of Object.keys(readMade().removed)) if (!c.seen?.has(file)) strip(c, file, "claude-mem", null, false);
    restoreMoved(c);
  } catch (e) {
    o.log(`claude-mem: BŁĄD przywracania (${String(e).slice(0, 160)})`);
  }
  if (!o.dryRun) markInstalled(off, false);
}

/** Czy rollback ma coś do zrobienia w harnessach poza listą podłączonych (zdjęte hooki, przeniesione pliki). */
export function harnessLeftovers(): boolean {
  const m = readMade();
  return Object.keys(m.removed).length > 0 || m.moved.length > 0;
}

function uninstallOne(c: Ctx, h: Harness, label: string): void {
  switch (h) {
    case "gemini":
      strip(c, join(geminiDir(), "settings.json"), label, ["mcpServers", "hipokamp"], true);
      break;
    case "antigravity":
      for (const f of antigravityMcpFiles()) strip(c, f, label, ["mcpServers", "hipokamp"], false);
      break;
    case "cursor":
      strip(c, join(cursorDir(), "mcp.json"), label, ["mcpServers", "hipokamp"], false);
      strip(c, join(cursorDir(), "hooks.json"), label, null, true);
      break;
    case "opencode": {
      strip(c, opencodeConfig(), label, ["mcp", "hipokamp"], false);
      const pf = opencodePluginFile();
      if (existsSync(pf) && allowed(pf, c.log) && readFileSync(pf, "utf8").startsWith(PLUGIN_MARK)) {
        c.log(`${label}: usuwam plugin ${pf}`);
        if (!c.dryRun) {
          try {
            mkdirSync(c.backupDir, { recursive: true });
            copyFileSync(pf, join(c.backupDir, "opencode__hipokamp.js"));
            rmSync(pf);
            forgetMade(pf);
          } catch (e) {
            c.log(`${label}: BŁĄD usuwania ${pf} (${String(e).slice(0, 160)})`);
          }
        }
      }
      break;
    }
    case "claude-desktop":
      strip(c, join(claudeDesktopDir(), "claude_desktop_config.json"), label, ["mcpServers", "hipokamp"], false);
      break;
  }
}

/** Wartość z pliku JSONC albo undefined (brak pliku, błąd składni). */
function peek(file: string, path: string[]): any {
  try {
    return getAt(readFileSync(file, "utf8"), path);
  } catch {
    return undefined;
  }
}

/** Stan harnessów dla `hipokamp doctor`: czy są, czy włączone, serwer MCP, hooki, plugin, liczba plików sesji. */
export function harnessReport(): string[] {
  const cfg = loadConfig();
  const out: string[] = [];
  const hooksIn = (file: string, events: string[]) =>
    events.filter((ev) => {
      const l = peek(file, ["hooks", ev]);
      return Array.isArray(l) && l.some(isOurs);
    }).length;
  for (const h of HARNESSES) {
    const label = LABEL[h];
    if (!detected(h)) {
      out.push(`· ${label}: nie ma na tej maszynie`);
      continue;
    }
    if (cfg.capture.harnesses?.[harnessKey(h)] === false) {
      out.push(`· ${label}: wyłączony (capture.harnesses)`);
      continue;
    }
    if (!harnessOn(h, cfg)) {
      out.push(`· ${label}: wykryty, niepodłączony (hipokamp install)`);
      continue;
    }
    const parts: string[] = [];
    let ok = true;
    const mcp = (file: string, path = ["mcpServers", "hipokamp"]) => {
      const has = peek(file, path) !== undefined;
      ok &&= has;
      return has;
    };
    switch (h) {
      case "gemini": {
        const f = join(geminiDir(), "settings.json");
        const n = hooksIn(
          f,
          GEMINI_HOOKS.map((e) => e.event),
        );
        ok &&= n === GEMINI_HOOKS.length;
        parts.push(mcp(f) ? "MCP" : "brak MCP", `hooki ${n}/${GEMINI_HOOKS.length}`, `sesje: ${listGeminiChats().length} plików`);
        break;
      }
      case "antigravity": {
        const files = antigravityMcpFiles();
        const n = files.filter((f) => peek(f, ["mcpServers", "hipokamp"]) !== undefined).length;
        ok &&= n > 0;
        parts.push(`MCP w ${n}/${files.length} plikach`, "bez zapisu sesji (zamknięty format)");
        break;
      }
      case "cursor": {
        const n = hooksIn(
          join(cursorDir(), "hooks.json"),
          CURSOR_HOOKS.map((e) => e.event),
        );
        ok &&= n === CURSOR_HOOKS.length;
        const h = peek(join(cursorDir(), "hooks.json"), ["hooks"]);
        const cm =
          h && typeof h === "object"
            ? Object.values(h).reduce((a: number, l) => a + (Array.isArray(l) ? l.filter(isClaudeMemHook).length : 0), 0)
            : 0;
        ok &&= !cm;
        parts.push(
          mcp(join(cursorDir(), "mcp.json")) ? "MCP" : "brak MCP",
          `hooki ${n}/${CURSOR_HOOKS.length}`,
          ...(cm ? [`${cm} hooków claude-mem obok (podwójny zapis; hipokamp install --replace-claude-mem)`] : []),
          `sesje: ${listCursorTranscripts().length} plików`,
        );
        break;
      }
      case "opencode": {
        const plugin = existsSync(opencodePluginFile());
        ok &&= plugin;
        const cfgFile = opencodeConfig();
        let n = 0;
        try {
          n = readdirSync(opencodeTranscripts()).filter((f) => f.endsWith(".jsonl")).length;
        } catch {}
        const cm = claudeMemPlugins();
        ok &&= !cm.length;
        parts.push(
          mcp(cfgFile, ["mcp", "hipokamp"]) ? "MCP" : "brak MCP",
          plugin ? "plugin" : "brak pluginu",
          ...(cm.length
            ? [
                `plugin claude-mem obok (${cm.map((p) => basename(p)).join(", ")}: podwójny zapis i kontekst; hipokamp install --replace-claude-mem)`,
              ]
            : []),
          `sesje: ${n} plików`,
        );
        break;
      }
      case "claude-desktop":
        parts.push(
          mcp(join(claudeDesktopDir(), "claude_desktop_config.json")) ? "MCP" : "brak MCP",
          `sesje Cowork: ${listDesktopTranscripts().length} plików`,
        );
        break;
    }
    out.push(`${ok ? "✓" : "!"} ${label}: ${parts.join(", ")}${ok ? "" : " (hipokamp install)"}`);
  }
  return out;
}
