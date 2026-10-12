// Porządek w kluczach projektów: `hipokamp project list|merge` (odpowiednik `claude-mem project merge`).
// Scalenie przenosi całą pamięć klucza (wszystkie pisownie, bez względu na wielkość liter) pod inny klucz. Wiersze są
// przepisywane, a nie aliasowane jak w claude-mem (merged_into_project), więc każdy odczyt po projekcie widzi je od razu.
// Plan liczą te same zapytania w próbie (baza tylko do odczytu) i w przebiegu właściwym (w tej samej transakcji
// BEGIN IMMEDIATE co zapis), więc próba pokazuje to, co zostanie zrobione. Drugie uruchomienie nic nie zmienia.
// Scalenia zostają w meta.project_merges; Repo.resolveProject kieruje przez nie nowe sesje do celu.
// Klucze plików źródła liczą się przy tym względem repo celu (core/filekeys.ts), więc plik worktree łączy się z encją
// tego pliku w repo. Kopia pre-project-merge powstaje z połączenia tylko do odczytu, przed migracjami schematu.
// `--worktrees`: klucze złożone `repo/worktree` z importu claude-mem (hipokamp daje worktree klucz repo).
// `list --suspicious`: podejrzane klucze z importu claude-mem do ręcznej oceny (nic nie jest scalane automatycznie).
// Narzędzie serwisowe: SQL wprost jak w repair; mapowanie kluczy żyje w repo.ts (ścieżka hooków).
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLinesFrom, sessionMeta } from "../capture/transcript.ts";
import { claudeDir, loadConfig, paths } from "../config.ts";
import { getDb, getMeta, openDb, setMeta } from "../db/db.ts";
import { contentHash, mapMergedProject, PROJECT_MERGES_KEY, parseProjectMerges, Repo, rowToObservation } from "../db/repo.ts";
import { basenameOf, gitRoot, normPath, projectFromCwd, UNKNOWN_PROJECT } from "../util/paths.ts";
import { oneLine, truncate } from "../util/text.ts";
import { backupDbFile, backupDir, stamp } from "./backup.ts";
import { fileKeyCandidate, fileKeyNormalizer, normFileList, normFingerprints } from "./filekeys.ts";
import { FORCE_SYNC_FLAG, syncInUse, syncWarning } from "./sync-guard.ts";

/** Błąd wywołania (zły klucz, brak projektu): CLI wypisuje komunikat i kończy kodem 1, baza bez zmian. */
export class ProjectError extends Error {}

const low = (s: string) => s.toLowerCase();
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- scalenia w meta (mapowanie dla importu)

/** Scalenia projektów z meta.project_merges: klucz małymi literami → projekt docelowy. */
export function projectMerges(db: Database): Map<string, string> {
  return parseProjectMerges(getMeta(db, PROJECT_MERGES_KEY));
}

/** Klucz projektu po scaleniach (jednorazowo; w pętli lepiej projectMapper). */
export function mergedProject(db: Database, project: string): string {
  return mapMergedProject(projectMerges(db), project);
}

/** Funkcja mapująca klucze przez scalenia, np. dla importu claude-mem; scalenia czytane raz, przy jej tworzeniu. */
export function projectMapper(db: Database): (project: string) => string {
  const m = projectMerges(db);
  return (project) => mapMergedProject(m, project);
}

const serializeMerges = (m: Map<string, string>) => JSON.stringify(Object.fromEntries([...m].sort((a, b) => cmpStr(a[0], b[0]))));

// ---------------------------------------------------------------- klucze w bazie

/** Liczby wierszy jednej pisowni klucza (dokładny napis z bazy). */
interface KeyStats {
  observations: number;
  active: number;
  sessions: number;
  prompts: number;
  summaries: number;
  workState: number;
  entities: number;
  aliases: number;
  last: number;
}

const COUNTED = ["observations", "active", "sessions", "prompts", "summaries", "workState", "entities", "aliases"] as const;

const emptyStats = (): KeyStats => ({
  observations: 0,
  active: 0,
  sessions: 0,
  prompts: 0,
  summaries: 0,
  workState: 0,
  entities: 0,
  aliases: 0,
  last: 0,
});

function addStats(to: KeyStats, s: KeyStats): void {
  for (const k of COUNTED) to[k] += s[k];
  to.last = Math.max(to.last, s.last);
}

/**
 * Każda pisownia klucza we wszystkich tabelach z kolumną projektu. Encje tylko w zakresie projektu (pliki, katalogi):
 * pojęcia, narzędzia i adresy mają pusty projekt i są wspólne. Ostatnia aktywność bez aliasów (seen_at to odczyt).
 */
function keyStats(db: Database): Map<string, KeyStats> {
  const out = new Map<string, KeyStats>();
  const add = (field: (typeof COUNTED)[number], sql: string) => {
    for (const r of db.query(sql).all() as { p: string; c: number; a?: number | null; last?: number | null }[]) {
      let s = out.get(r.p);
      if (!s) out.set(r.p, (s = emptyStats()));
      s[field] += r.c;
      if (r.a) s.active += r.a;
      if (r.last && r.last > s.last) s.last = r.last;
    }
  };
  add(
    "observations",
    "SELECT project p, COUNT(*) c, SUM(status = 'active') a, MAX(created_at) last FROM observations GROUP BY project",
  );
  add(
    "sessions",
    "SELECT project p, COUNT(*) c, MAX(COALESCE(last_activity_at, started_at)) last FROM sessions GROUP BY project",
  );
  add("prompts", "SELECT project p, COUNT(*) c, MAX(created_at) last FROM prompts GROUP BY project");
  add("summaries", "SELECT project p, COUNT(*) c, MAX(created_at) last FROM summaries GROUP BY project");
  add("workState", "SELECT project p, COUNT(*) c, MAX(created_at) last FROM work_state GROUP BY project");
  add("entities", "SELECT project p, COUNT(*) c FROM entities WHERE project != '' GROUP BY project");
  add("aliases", "SELECT project p, COUNT(*) c FROM project_aliases GROUP BY project");
  return out;
}

/** Pisownie pogrupowane bez względu na wielkość liter; pierwsza to główna (najwięcej notatek, potem sesji). */
function bySpelling(keys: Map<string, KeyStats>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of keys.keys()) {
    const g = out.get(low(k));
    if (g) g.push(k);
    else out.set(low(k), [k]);
  }
  const weight = (k: string) => {
    const s = keys.get(k)!;
    return [s.observations, s.sessions, s.prompts + s.summaries + s.workState + s.entities + s.aliases];
  };
  for (const g of out.values())
    g.sort((x, y) => {
      const a = weight(x);
      const b = weight(y);
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || cmpStr(x, y);
    });
  return out;
}

// ---------------------------------------------------------------- lista

export interface ProjectInfo {
  /** Pisownia główna (najwięcej notatek). */
  key: string;
  spellings: string[];
  /** Klucz złożony z `/`: `repo/worktree` (albo `repo/submoduł`) z importu claude-mem. */
  composite: boolean;
  /** Klucz jest już scalony do innego, a jego wiersze wróciły (np. ponowny import claude-mem). */
  mergedInto: string | null;
  observations: number;
  active: number;
  sessions: number;
  prompts: number;
  summaries: number;
  workState: number;
  entities: number;
  aliases: number;
  lastActivity: number | null;
}

export function listProjects(db: Database): ProjectInfo[] {
  const keys = keyStats(db);
  const merges = projectMerges(db);
  const out: ProjectInfo[] = [];
  for (const [l, sp] of bySpelling(keys)) {
    const s = emptyStats();
    for (const k of sp) addStats(s, keys.get(k)!);
    const to = mapMergedProject(merges, sp[0]);
    const { last, ...counts } = s;
    out.push({
      key: sp[0],
      spellings: sp,
      composite: sp[0].includes("/"),
      mergedInto: low(to) !== l ? to : null,
      ...counts,
      lastActivity: last || null,
    });
  }
  return out.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || cmpStr(a.key, b.key));
}

function day(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatProjectList(list: ProjectInfo[]): string {
  const composite = list.filter((p) => p.composite).length;
  const lines = [
    `projekty: ${list.length}${composite ? `, klucze złożone (repo/worktree z claude-mem): ${composite}` : ""}`,
    `${"aktywne".padStart(8)}  ${"sesje".padStart(6)}  ${"ostatnio".padEnd(10)}  projekt`,
  ];
  for (const p of list) {
    const empty = !p.observations && !p.sessions && !p.prompts && !p.summaries && !p.workState;
    const marks = [
      p.spellings.length > 1 ? `pisownie: ${p.spellings.join(", ")}` : "",
      p.composite ? "złożony" : "",
      p.mergedInto ? `scalony do „${p.mergedInto}”, wiersze wróciły` : "",
      empty ? (p.aliases ? "tylko aliasy katalogów" : "bez notatek") : "",
    ].filter(Boolean);
    lines.push(
      `${String(p.active).padStart(8)}  ${String(p.sessions).padStart(6)}  ${(p.lastActivity ? day(p.lastActivity) : "brak").padEnd(10)}  ${p.key}${marks.length ? `  [${marks.join("; ")}]` : ""}`,
    );
  }
  if (composite) lines.push("", "klucze złożone scala: hipokamp project merge --worktrees --dry-run, potem bez --dry-run");
  return lines.join("\n");
}

// ---------------------------------------------------------------- podejrzane klucze z importu

/** Nazwy katalogów, które nie są nazwą projektu: katalog systemowy albo zbiorczy (wiele repo w środku). */
const GENERIC_DIRS = new Set([
  "system32",
  "syswow64",
  "windows",
  "code",
  "src",
  "users",
  "home",
  "tmp",
  "temp",
  "desktop",
  "documents",
  "downloads",
  "projects",
  "repos",
  "repositories",
  "dev",
  "work",
  "appdata",
]);

export interface SuspiciousProject {
  key: string;
  spellings: string[];
  why: string;
  observations: number;
  active: number;
  /** Notatki z importu claude-mem. */
  claudeMem: number;
  sessions: number;
  lastActivity: number | null;
  /** Najnowsze tytuły aktywnych notatek (do oceny, czyja to pamięć). */
  titles: string[];
  /** Katalogi sesji (do 5). */
  dirs: string[];
}

/**
 * Klucze z importu claude-mem, które wyglądają na błąd przypisania, a nie na projekt: krótki fragment słowa (do 4 małych
 * liter, np. `prze`, `do`, `we`) albo katalog systemowy lub zbiorczy (`System32`, `code`). Tylko lista do oceny przez
 * człowieka: nic nie jest scalane automatycznie. Krótki klucz, którego katalog sesji jest korzeniem repo o tej nazwie,
 * to zwykły projekt (np. `cli`), więc go nie ma.
 */
export function suspiciousProjects(db: Database): SuspiciousProject[] {
  const keys = keyStats(db);
  const out: SuspiciousProject[] = [];
  for (const [l, sp] of bySpelling(keys)) {
    const key = sp[0];
    const why = GENERIC_DIRS.has(l)
      ? "katalog systemowy albo zbiorczy (wiele repo w środku)"
      : /^\p{Ll}{1,4}$/u.test(key)
        ? "krótki fragment słowa (do 4 małych liter)"
        : null;
    if (!why) continue;
    const marks = sp.map(() => "?").join(",");
    const cm = (
      db.query(`SELECT COUNT(*) c FROM observations WHERE project IN (${marks}) AND source = 'claude-mem'`).get(...sp) as {
        c: number;
      }
    ).c;
    const cmSessions = (
      db.query(`SELECT COUNT(*) c FROM sessions WHERE project IN (${marks}) AND source = 'claude-mem'`).get(...sp) as {
        c: number;
      }
    ).c;
    if (!cm && !cmSessions) continue;
    const dirs = (
      db
        .query(`SELECT DISTINCT cwd FROM sessions WHERE project IN (${marks}) AND cwd IS NOT NULL AND cwd != '' ORDER BY cwd`)
        .all(...sp) as { cwd: string }[]
    ).map((r) => r.cwd);
    if (
      !GENERIC_DIRS.has(l) &&
      dirs.some((d) => {
        const g = existsSync(d) ? gitRoot(d) : null;
        return !!g && low(normPath(g.mainRoot)) === low(normPath(d)) && low(basenameOf(g.mainRoot)) === l;
      })
    )
      continue;
    const s = emptyStats();
    for (const k of sp) addStats(s, keys.get(k)!);
    const titles = (
      db
        .query(
          `SELECT title FROM observations WHERE project IN (${marks}) AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 3`,
        )
        .all(...sp) as { title: string }[]
    ).map((r) => r.title);
    out.push({
      key,
      spellings: sp,
      why,
      observations: s.observations,
      active: s.active,
      claudeMem: cm,
      sessions: s.sessions,
      lastActivity: s.last || null,
      titles,
      dirs: dirs.slice(0, 5),
    });
  }
  return out.sort((a, b) => b.observations - a.observations || cmpStr(a.key, b.key));
}

export function formatSuspicious(list: SuspiciousProject[]): string {
  const lines = [
    `podejrzane klucze z importu claude-mem: ${list.length} (nic nie jest scalane automatycznie, opis: docs/MIGRACJA.md)`,
  ];
  for (const p of list) {
    lines.push(
      "",
      `„${p.key}”${p.spellings.length > 1 ? ` (pisownie: ${p.spellings.join(", ")})` : ""}: notatki ${p.observations} (aktywne ${p.active}, z claude-mem ${p.claudeMem}), sesje ${p.sessions}, ostatnio ${p.lastActivity ? day(p.lastActivity) : "brak"}`,
      `  powód: ${p.why}`,
    );
    if (p.dirs.length) lines.push(`  katalogi sesji: ${p.dirs.join("; ")}`);
    for (const t of p.titles) lines.push(`  · ${truncate(oneLine(t), 110)}`);
  }
  if (list.length)
    lines.push(
      "",
      "scalenie ręczne jednego klucza: hipokamp project merge <klucz> <cel> --dry-run, potem bez --dry-run",
      "klucz, który jest prawdziwym projektem, zostaje (lista go dalej pokazuje, nic się z nim nie dzieje)",
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------- plan scalenia

export interface MergeCounts {
  sessions: number;
  prompts: number;
  observations: number;
  /** W tym aktywne (reszta: scalone, archiwum). */
  active: number;
  summaries: number;
  workState: number;
  /** Aliasy katalogów (project_aliases) wskazujące źródło. */
  aliases: number;
  /** Encje przemianowane na cel (bez kolizji). */
  entities: number;
  /** Encje scalone z istniejącą encją celu (UNIQUE kind, project, key): powiązania przepięte, df od nowa z powiązań. */
  entitiesMerged: number;
  /**
   * Klucze plików względem repo celu (core/filekeys.ts): encje z nowym kluczem (przemianowane albo scalone po nowym
   * kluczu) oraz notatki i podsumowania z nowymi listami plików.
   */
  fileKeys: number;
  /** Powiązania obs_entities przepięte z encji scalonych. */
  links: number;
  /** Wektory binarne przeniesione do partycji celu; null: sqlite-vec niedostępny (tylko w próbie). */
  vectors: number | null;
  /** Hash treści liczony z kluczem projektu (deduplikacja w insertObservation), policzony od nowa z celem. */
  hashes: number;
  /** Korpusy z filtrem projektu wskazującym źródło. */
  corpora: number;
}

export interface MergePlan {
  from: string;
  into: string;
  /** Pisownie źródła w bazie (wszystkie trafiają do celu). */
  sources: string[];
  notes: string[];
  counts: MergeCounts;
  /** meta.project_merges przed i po (JSON z kluczami w kolejności). */
  merges: { before: string; after: string };
  ids: {
    sessions: string[];
    prompts: number[];
    observations: number[];
    summaries: number[];
    work_state: number[];
    project_aliases: string[];
  };
  renames: number[];
  /** Nowe klucze encji przemianowanych (klucz pliku względem repo celu). */
  rekeys: { id: number; key: string }[];
  entityMerges: { id: number; into: number; df: number; last: number | null }[];
  /** Notatki i podsumowania źródła z nowymi listami plików. */
  noteFiles: { id: number; files_read: string[]; files_modified: string[]; fingerprints: Record<string, string> | null }[];
  summaryFiles: { id: number; files_read: string[]; files_edited: string[] }[];
  vectors: number[];
  hashes: { id: number; hash: string }[];
  corpora: { name: string; filters: string }[];
}

/** Stan planowania: w próbie kolejne plany serii widzą skutki poprzednich (symulacja), w zapisie stan z bazy. */
interface PlanState {
  keys: Map<string, KeyStats>;
  merges: Map<string, string>;
  /** Encje celu: dokładna pisownia projektu → (kind, key) → id. */
  ents: Map<string, Map<string, number>>;
  vec: "none" | "ok" | "unavailable";
}

/** obs_vec_bits w tym połączeniu: brak tabeli (nic do przeniesienia), działa albo moduł vec0 niezaładowany. */
function vecState(db: Database): PlanState["vec"] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obs_vec_bits'").get()) return "none";
  try {
    db.query("SELECT project FROM obs_vec_bits WHERE obs_id = 0").get();
    return "ok";
  } catch {
    return "unavailable";
  }
}

function initState(db: Database): PlanState {
  return { keys: keyStats(db), merges: projectMerges(db), ents: new Map(), vec: vecState(db) };
}

const entKey = (kind: string, key: string) => `${kind}\u0000${key}`;

function targetEntities(db: Database, st: PlanState, into: string): Map<string, number> {
  let m = st.ents.get(into);
  if (!m) {
    m = new Map();
    for (const r of db.query("SELECT id, kind, key FROM entities WHERE project = ?").all(into) as {
      id: number;
      kind: string;
      key: string;
    }[])
      m.set(entKey(r.kind, r.key), r.id);
    st.ents.set(into, m);
  }
  return m;
}

/** Liczba zmian planu (wiersze i operacje); 0 = nic do zrobienia. */
function planChanges(p: MergePlan): number {
  const c = p.counts;
  return (
    c.sessions +
    c.prompts +
    c.observations +
    c.summaries +
    c.workState +
    c.aliases +
    c.entities +
    c.entitiesMerged +
    c.fileKeys +
    (c.vectors ?? 0) +
    c.hashes +
    c.corpora +
    (p.merges.before === p.merges.after ? 0 : 1)
  );
}

interface ObsRow {
  id: number;
  project: string;
  status: string;
  title: string;
  narrative: string | null;
  facts: string;
  content_hash: string | null;
  files_read: string;
  files_modified: string;
  fingerprints: string | null;
}

/**
 * Plan scalenia `from` do `into` (same odczyty). Cel: klucz scalony wcześniej wskazuje swój cel (chyba że to odwrócenie:
 * cel był scalony do źródła), a cel istniejący w innej pisowni zachowuje istniejącą. Gdy nazwy różnią się tylko
 * wielkością liter, podana pisownia ujednolica pozostałe. null: źródła już nie ma (tylko seria `--worktrees`).
 */
function planMerge(
  db: Database,
  st: PlanState,
  fromArg: string,
  intoArg: string,
  missingOk: boolean,
  rename: boolean,
): MergePlan | null {
  const from = fromArg.trim();
  const given = intoArg.trim();
  if (!from || !given) throw new ProjectError("podaj oba klucze: hipokamp project merge <from> <into>");
  if (from === given) throw new ProjectError(`„${from}” i „${given}” to ten sam klucz`);
  const lf = low(from);
  const spell = bySpelling(st.keys);
  const notes: string[] = [];
  let into = mapMergedProject(st.merges, given);
  if (low(into) === lf && low(given) !== lf) {
    notes.push(`odwrócenie wcześniejszego scalenia: „${given}” był scalony do „${into}”`);
    into = given;
  } else if (low(into) !== low(given)) notes.push(`„${given}” jest już scalony do „${into}”, więc cel to „${into}”`);
  if (low(into) !== lf) {
    const ex = spell.get(low(into)) ?? [];
    if (ex.length && !ex.includes(into)) {
      notes.push(`cel istnieje w bazie jako „${ex[0]}”, zostaje ta pisownia`);
      into = ex[0];
    }
  }
  // cel bez żadnego wiersza: scalenie to zmiana nazwy klucza, a literówka w <into> przeniosłaby cały projekt
  const known = (k: string) =>
    !!(spell.get(low(k)) ?? []).length || st.merges.has(low(k)) || [...st.merges.values()].some((v) => low(v) === low(k));
  if (!rename && low(into) !== lf && !known(into))
    throw new ProjectError(
      `nie ma projektu „${into}” w bazie, więc to byłaby zmiana nazwy klucza. Sprawdź pisownię (hipokamp project list) albo dodaj --rename`,
    );
  const all = spell.get(lf) ?? [];
  if (!all.length) {
    const cur = st.merges.get(lf);
    const now = cur === undefined ? null : mapMergedProject(st.merges, cur);
    if (now === null || low(now) !== low(into)) {
      if (missingOk) return null;
      throw new ProjectError(
        now === null
          ? `nie ma projektu „${from}” w bazie (lista: hipokamp project list)`
          : `„${from}” jest już scalony do „${now}”`,
      );
    }
  }
  const sources = all.filter((s) => s !== into);
  const marks = sources.map(() => "?").join(",");
  const select = <T>(cols: string, table: string, order = "id"): T[] =>
    sources.length
      ? (db.query(`SELECT ${cols} FROM ${table} WHERE project IN (${marks}) ORDER BY ${order}`).all(...sources) as T[])
      : [];

  const sessions = select<{ id: string }>("id", "sessions").map((r) => r.id);
  const prompts = select<{ id: number }>("id", "prompts").map((r) => r.id);
  const summaries = select<{ id: number }>("id", "summaries").map((r) => r.id);
  const workState = select<{ id: number }>("id", "work_state").map((r) => r.id);
  const aliases = select<{ cwd: string }>("cwd", "project_aliases", "cwd").map((r) => r.cwd);
  const obs = select<ObsRow>(
    "id, project, status, title, narrative, facts, content_hash, files_read, files_modified, fingerprints",
    "observations",
  );
  // klucze plików względem repo celu: katalogi sesji celu i źródeł (te ostatnie przechodzą do celu)
  const nz = fileKeyNormalizer(db);
  const scope = [into, ...sources];
  const normKey = (kind: string, key: string) =>
    (kind === "file" || kind === "dir") && fileKeyCandidate(key) ? nz.norm(key, scope) : key;
  const noteFiles: MergePlan["noteFiles"] = [];
  for (const o of obs) {
    const read = jsonList(o.files_read);
    const mod = jsonList(o.files_modified);
    if (!read.some(fileKeyCandidate) && !mod.some(fileKeyCandidate)) continue;
    const nread = normFileList(nz, read, scope);
    const nmod = normFileList(nz, mod, scope);
    if (JSON.stringify([read, mod]) === JSON.stringify([nread, nmod])) continue;
    let fps: Record<string, string> | null = null;
    try {
      fps = o.fingerprints ? JSON.parse(o.fingerprints) : null;
    } catch {}
    noteFiles.push({ id: o.id, files_read: nread, files_modified: nmod, fingerprints: normFingerprints(nz, fps, scope) });
  }
  const summaryFiles: MergePlan["summaryFiles"] = [];
  for (const s of select<{ id: number; files_read: string; files_edited: string }>("id, files_read, files_edited", "summaries")) {
    const read = jsonList(s.files_read);
    const ed = jsonList(s.files_edited);
    if (!read.some(fileKeyCandidate) && !ed.some(fileKeyCandidate)) continue;
    const nread = normFileList(nz, read, scope);
    const ned = normFileList(nz, ed, scope);
    if (JSON.stringify([read, ed]) !== JSON.stringify([nread, ned]))
      summaryFiles.push({ id: s.id, files_read: nread, files_edited: ned });
  }

  // hash treści z kluczem projektu (insertObservation deduplikuje po projekcie i hashu) liczony od nowa z celem;
  // hash z claude-mem nie zależy od klucza (to tożsamość importu), więc zostaje
  const hashes: MergePlan["hashes"] = [];
  for (const o of obs) {
    const facts = rowToObservation(o).facts;
    if (o.content_hash !== contentHash({ project: o.project, title: o.title, narrative: o.narrative, facts })) continue;
    const hash = contentHash({ project: into, title: o.title, narrative: o.narrative, facts });
    if (hash !== o.content_hash) hashes.push({ id: o.id, hash });
  }

  // encje: UNIQUE(kind, project, key). Kolizja z encją celu (także przemianowaną wcześniej w tym planie) = scalenie.
  // Klucz pliku źródła najpierw względem repo celu, więc plik worktree łączy się z encją tego pliku w repo
  const tmap = targetEntities(db, st, into);
  const renames: number[] = [];
  const rekeys: MergePlan["rekeys"] = [];
  const entityMerges: MergePlan["entityMerges"] = [];
  let entityKeys = 0;
  for (const e of select<{ id: number; kind: string; key: string; df: number; last_seen_at: number | null }>(
    "id, kind, key, df, last_seen_at",
    "entities",
  )) {
    const key = normKey(e.kind, e.key);
    if (key !== e.key) entityKeys++;
    const k = entKey(e.kind, key);
    const t = tmap.get(k);
    if (t === undefined) {
      renames.push(e.id);
      if (key !== e.key) rekeys.push({ id: e.id, key });
      tmap.set(k, e.id);
    } else entityMerges.push({ id: e.id, into: t, df: e.df, last: e.last_seen_at });
  }
  let links = 0;
  for (let i = 0; i < entityMerges.length; i += 500) {
    const chunk = entityMerges.slice(i, i + 500).map((e) => e.id);
    links += (
      db.query(`SELECT COUNT(*) c FROM obs_entities WHERE entity_id IN (${chunk.map(() => "?").join(",")})`).get(...chunk) as {
        c: number;
      }
    ).c;
  }

  // wektory binarne: partycja to projekt małymi literami (putVector); po jednym wierszu (zapytanie po obs_id jest
  // punktowe, filtr po partycji bez MATCH skanuje całą tabelę)
  const part = low(into);
  const vectors: number[] = [];
  let vecCount: number | null = 0;
  if (obs.length && st.vec === "ok") {
    const q = db.query("SELECT project FROM obs_vec_bits WHERE obs_id = ?");
    for (const o of obs) {
      const r = q.get(o.id) as { project: string } | null;
      if (r && r.project !== part) vectors.push(o.id);
    }
    vecCount = vectors.length;
  } else if (obs.length && st.vec === "unavailable") vecCount = null;

  const corpora: MergePlan["corpora"] = [];
  for (const c of db.query("SELECT name, filters FROM corpora ORDER BY name").all() as { name: string; filters: string }[]) {
    let f: any;
    try {
      f = JSON.parse(c.filters);
    } catch {
      continue;
    }
    if (f && typeof f.project === "string" && low(f.project) === lf && f.project !== into)
      corpora.push({ name: c.name, filters: JSON.stringify({ ...f, project: into }) });
  }

  // scalenia płaskie: wpisy wskazujące źródło wskazują odtąd cel; cel scalony gdzie indziej staje się kluczem głównym
  const m = new Map(st.merges);
  const li = low(into);
  const cur = m.get(li);
  if (cur !== undefined && low(cur) !== li) m.delete(li);
  for (const [k, v] of m) if (low(v) === lf) m.set(k, into);
  m.set(lf, into);

  return {
    from,
    into,
    sources,
    notes,
    counts: {
      sessions: sessions.length,
      prompts: prompts.length,
      observations: obs.length,
      active: obs.filter((o) => o.status === "active").length,
      summaries: summaries.length,
      workState: workState.length,
      aliases: aliases.length,
      entities: renames.length,
      entitiesMerged: entityMerges.length,
      fileKeys: entityKeys + noteFiles.length + summaryFiles.length,
      links,
      vectors: vecCount,
      hashes: hashes.length,
      corpora: corpora.length,
    },
    merges: { before: serializeMerges(st.merges), after: serializeMerges(m) },
    ids: {
      sessions,
      prompts,
      observations: obs.map((o) => o.id),
      summaries,
      work_state: workState,
      project_aliases: aliases,
    },
    renames,
    rekeys,
    entityMerges,
    noteFiles,
    summaryFiles,
    vectors,
    hashes,
    corpora,
  };
}

function jsonList(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Próba serii: skutki planu w stanie (klucze, scalenia), żeby następny plan liczył się jak po zapisie. */
function simulate(st: PlanState, p: MergePlan): void {
  st.merges = parseProjectMerges(p.merges.after);
  if (!p.sources.length) return;
  const moved = emptyStats();
  for (const s of p.sources) {
    const k = st.keys.get(s);
    if (k) addStats(moved, k);
    st.keys.delete(s);
  }
  moved.entities -= p.counts.entitiesMerged;
  const t = st.keys.get(p.into) ?? emptyStats();
  addStats(t, moved);
  st.keys.set(p.into, t);
}

/** Zapis planu (w transakcji wołającego). Liczba zmienionych wierszy musi zgadzać się z planem, inaczej wycofanie. */
function applyMerge(db: Database, p: MergePlan): void {
  if (p.sources.length) {
    const marks = p.sources.map(() => "?").join(",");
    for (const [table, ids] of Object.entries(p.ids)) {
      const n = db.run(`UPDATE ${table} SET project = ? WHERE project IN (${marks})`, [p.into, ...p.sources]).changes;
      if (n !== ids.length) throw new Error(`scalanie: ${table} zmienione ${n}, w planie ${ids.length}`);
    }
  }
  // projekt i nowy klucz jedną instrukcją: encja celu o starym (absolutnym) kluczu nie może zablokować zmiany projektu
  const rekey = new Map(p.rekeys.map((r) => [r.id, r.key]));
  for (const id of p.renames) {
    const key = rekey.get(id);
    if (key === undefined) db.run("UPDATE entities SET project = ? WHERE id = ?", [p.into, id]);
    else db.run("UPDATE entities SET project = ?, key = ? WHERE id = ?", [p.into, key, id]);
  }
  const repo = new Repo(db);
  const targets = new Set<number>();
  for (const e of p.entityMerges) {
    // powiązanie, które cel już ma (ta sama notatka i rola), zostaje na encji źródłowej i znika razem z nią
    db.run("UPDATE OR IGNORE obs_entities SET entity_id = ? WHERE entity_id = ?", [e.into, e.id]);
    db.run("DELETE FROM obs_entities WHERE entity_id = ?", [e.id]);
    db.run("UPDATE entities SET last_seen_at = COALESCE(MAX(last_seen_at, ?), last_seen_at, ?) WHERE id = ?", [
      e.last,
      e.last,
      e.into,
    ]);
    db.run("DELETE FROM entities WHERE id = ?", [e.id]);
    targets.add(e.into);
  }
  // df od nowa z powiązań: notatka powiązana z obiema encjami liczy się raz (suma df liczyłaby ją dwa razy)
  for (const id of targets) repo.recountEntityDf(id);
  for (const f of p.noteFiles) repo.updateObservationFiles(f.id, f);
  for (const s of p.summaryFiles) repo.updateSummaryText(s.id, { files_read: s.files_read, files_edited: s.files_edited });
  if (p.vectors.length) {
    // vec0 nie zmienia klucza partycji („UPDATE on partition key columns are not supported yet”):
    // odczyt bitów, usunięcie i wstawienie w partycji celu
    const get = db.query("SELECT emb FROM obs_vec_bits WHERE obs_id = ?");
    const part = low(p.into);
    for (const id of p.vectors) {
      const r = get.get(id) as { emb: Uint8Array } | null;
      if (!r) throw new Error(`scalanie: brak wektora #${id}`);
      db.run("DELETE FROM obs_vec_bits WHERE obs_id = ?", [id]);
      db.run("INSERT INTO obs_vec_bits (obs_id, project, emb) VALUES (?, ?, vec_bit(?))", [id, part, r.emb]);
    }
  }
  for (const h of p.hashes) db.run("UPDATE observations SET content_hash = ? WHERE id = ?", [h.hash, h.id]);
  for (const c of p.corpora) db.run("UPDATE corpora SET filters = ? WHERE name = ?", [c.filters, c.name]);
  if (p.merges.after !== p.merges.before) setMeta(db, PROJECT_MERGES_KEY, p.merges.after);
}

/** Dziennik: identyfikatory każdej zmiany (bez treści), wystarczą do ręcznego cofnięcia. */
function logEntries(p: MergePlan): Record<string, unknown>[] {
  const base = { at: Date.now(), from: p.from, into: p.into };
  const out: Record<string, unknown>[] = [{ op: "merge", ...base, sources: p.sources, counts: p.counts }];
  for (const [table, ids] of Object.entries(p.ids)) if (ids.length) out.push({ op: "move", ...base, table, ids });
  if (p.renames.length) out.push({ op: "entity-rename", ...base, ids: p.renames });
  if (p.entityMerges.length)
    out.push({ op: "entity-merge", ...base, merged: p.entityMerges.map((e) => ({ id: e.id, into: e.into, df: e.df })) });
  if (p.counts.fileKeys)
    out.push({
      op: "file-keys",
      ...base,
      entities: p.rekeys.map((r) => r.id),
      observations: p.noteFiles.map((f) => f.id),
      summaries: p.summaryFiles.map((s) => s.id),
    });
  if (p.vectors.length) out.push({ op: "vectors", ...base, partition: low(p.into), ids: p.vectors });
  if (p.hashes.length) out.push({ op: "content-hash", ...base, ids: p.hashes.map((h) => h.id) });
  if (p.corpora.length) out.push({ op: "corpus", ...base, names: p.corpora.map((c) => c.name) });
  if (p.merges.after !== p.merges.before)
    out.push({
      op: "meta",
      ...base,
      key: PROJECT_MERGES_KEY,
      before: JSON.parse(p.merges.before),
      after: JSON.parse(p.merges.after),
    });
  return out;
}

// ---------------------------------------------------------------- przebieg

export interface MergeOptions {
  dryRun?: boolean;
  /** Dziennik zmian JSONL (zapisywany tylko bez dryRun, po zatwierdzeniu transakcji). */
  logPath?: string | null;
  /** Katalog transkryptów dla `--worktrees` (domyślnie <konfiguracja Claude>/projects). */
  projectsDir?: string;
  /** Zgoda na cel, którego nie ma w bazie (zmiana nazwy klucza); `--worktrees` jej nie potrzebuje. */
  rename?: boolean;
}

export interface MergeReport {
  dryRun: boolean;
  plans: MergePlan[];
  /** Tylko `--worktrees`: cel każdego klucza złożonego albo powód pominięcia. */
  worktrees: WorktreeTarget[] | null;
  changes: number;
  logFile: string | null;
  ms: number;
}

/** W próbie plany na symulowanym stanie; inaczej plan i zapis każdego scalenia w jednej transakcji BEGIN IMMEDIATE. */
function execute(db: Database, pairs: [string, string][], opts: MergeOptions, worktrees: WorktreeTarget[] | null): MergeReport {
  const t0 = performance.now();
  const dry = !!opts.dryRun;
  let plans: MergePlan[] = [];
  const run = () => {
    plans = [];
    let st = initState(db);
    for (const [from, into] of pairs) {
      const p = planMerge(db, st, from, into, worktrees !== null, worktrees !== null || !!opts.rename);
      if (!p) continue;
      plans.push(p);
      if (dry) simulate(st, p);
      else if (planChanges(p)) {
        if (p.counts.vectors === null)
          throw new ProjectError("sqlite-vec niedostępny: wektory zostałyby w partycji starego klucza, scalanie przerwane");
        applyMerge(db, p);
        st = initState(db);
      }
    }
  };
  if (dry) run();
  else db.transaction(run).immediate();
  const changed = plans.filter((p) => planChanges(p) > 0);
  const changes = changed.reduce((n, p) => n + planChanges(p), 0);
  let logFile: string | null = null;
  if (!dry && opts.logPath && changes) {
    mkdirSync(dirname(opts.logPath), { recursive: true });
    appendFileSync(
      opts.logPath,
      `${changed
        .flatMap(logEntries)
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    logFile = opts.logPath;
  }
  return { dryRun: dry, plans, worktrees, changes, logFile, ms: Math.round(performance.now() - t0) };
}

/** Scala całą pamięć projektu `from` (wszystkie pisownie) do `into`. */
export function mergeProject(db: Database, from: string, into: string, opts: MergeOptions = {}): MergeReport {
  return execute(db, [[from, into]], opts, null);
}

/** Scala klucze złożone `repo/worktree` z importu claude-mem z kluczem, który hipokamp liczy dziś (worktreeTargets). */
export function mergeWorktrees(db: Database, opts: MergeOptions = {}): MergeReport {
  // cele przed transakcją: czytanie transkryptów nie trzyma blokady zapisu
  const targets = worktreeTargets(db, opts);
  const pairs = targets.filter((t) => t.target).map((t) => [t.key, t.target!] as [string, string]);
  return execute(db, pairs, opts, targets);
}

// ---------------------------------------------------------------- klucze złożone z claude-mem

export interface WorktreeTarget {
  /** Klucz złożony (pisownia główna). */
  key: string;
  /** Klucz docelowy; null = pominięty (powód w `evidence`). */
  target: string | null;
  source: "sesja" | "transkrypt" | "reguła" | null;
  evidence: string;
}

/** cwd z pierwszych linii transkryptu; okno rośnie, bo początek bywa samymi metadanymi (kolejka, metadane harnessu). */
export function transcriptCwd(path: string): string | null {
  for (let win = 256 * 1024; ; win *= 4) {
    let head: ReturnType<typeof readLinesFrom>;
    try {
      head = readLinesFrom(path, 0, win);
    } catch {
      return null;
    }
    const cwd = sessionMeta(head.lines).cwd;
    if (typeof cwd === "string" && cwd.trim()) return cwd;
    if (win >= head.size || win >= 16 * 1024 * 1024) return null;
  }
}

/** Transkrypt sesji po nazwie pliku w katalogach projektów Claude Code (jak w repair). */
function transcriptFinder(root: string): (sessionId: string) => string | null {
  let dirs: string[] | null = null;
  return (sid) => {
    // identyfikator z bazy trafia do ścieżki: tylko znaki identyfikatora sesji
    if (!/^[\w-]+$/.test(sid)) return null;
    if (!dirs) {
      try {
        dirs = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(root, d.name));
      } catch {
        dirs = [];
      }
    }
    for (const d of dirs) {
      const f = join(d, `${sid}.jsonl`);
      if (existsSync(f)) return f;
    }
    return null;
  };
}

/**
 * Cel każdego klucza złożonego K (z `/`), czyli klucz, który hipokamp policzyłby dziś dla jego katalogu:
 * a) katalog sesji K (kolumna cwd albo pierwsze linie transkryptu `<id sesji>.jsonl`), jeśli istnieje: projectFromCwd;
 * b) bez katalogu: część przed jedynym `/`, o ile istnieje w bazie jako zwykły klucz i ścieżka katalogu sesji wygląda
 *    na worktree (ostatni człon to druga część klucza, a katalog nadrzędny nie jest katalogiem repo, jak w submodule);
 * c) inaczej K zostaje, z powodem (np. submoduł `repo/a/b`).
 */
export function worktreeTargets(db: Database, opts: { projectsDir?: string } = {}): WorktreeTarget[] {
  const spell = bySpelling(keyStats(db));
  const find = transcriptFinder(opts.projectsDir ?? join(claudeDir(), "projects"));
  const out: WorktreeTarget[] = [];
  for (const [l, sp] of [...spell].sort((a, b) => cmpStr(a[0], b[0]))) {
    if (!l.includes("/")) continue;
    const key = sp[0];
    const found = new Map<string, Omit<WorktreeTarget, "key">>();
    const seen: string[] = [];
    const consider = (cwd: string | null, source: "sesja" | "transkrypt", what: string): boolean => {
      if (cwd?.trim()) seen.push(cwd.trim());
      if (!cwd?.trim() || !existsSync(cwd)) return false;
      const target = projectFromCwd(cwd);
      if (target === UNKNOWN_PROJECT || low(target) === l) return false;
      if (!found.has(low(target))) found.set(low(target), { target, source, evidence: `${what}, katalog ${cwd}` });
      return true;
    };
    const sessions = db
      .query(
        `SELECT id, cwd, transcript_path FROM sessions WHERE project IN (${sp.map(() => "?").join(",")}) ORDER BY started_at, id`,
      )
      .all(...sp) as { id: string; cwd: string | null; transcript_path: string | null }[];
    for (const s of sessions) {
      if (consider(s.cwd, "sesja", `sesja ${s.id.slice(0, 8)}`)) continue;
      const path = s.transcript_path && existsSync(s.transcript_path) ? s.transcript_path : find(s.id);
      if (path) consider(transcriptCwd(path), "transkrypt", `transkrypt sesji ${s.id.slice(0, 8)}`);
    }
    if (found.size === 1) {
      out.push({ key, ...[...found.values()][0] });
      continue;
    }
    if (found.size > 1) {
      const all = [...found.values()].map((f) => `„${f.target}”`).join(", ");
      out.push({ key, target: null, source: null, evidence: `katalogi sesji wskazują różne cele: ${all}` });
      continue;
    }
    const parts = key.split("/");
    const base = parts.length === 2 && parts[0].trim() ? spell.get(low(parts[0])) : undefined;
    // worktree claude-mem ma klucz `repo/<nazwa katalogu worktree>`, a submoduł `repo/<ścieżka w repo>`: katalog
    // submodułu leży w katalogu repo, worktree poza nim (np. .claude/worktrees/<nazwa>)
    const wt = base
      ? seen.find((c) => low(basenameOf(c)) === low(parts[1]) && low(basenameOf(dirname(c))) !== low(parts[0]))
      : undefined;
    if (base && wt) {
      out.push({
        key,
        target: base[0],
        source: "reguła",
        evidence: `„${base[0]}” istnieje w bazie jako zwykły klucz, a katalog sesji ${wt} (już go nie ma) to worktree`,
      });
      continue;
    }
    const why =
      parts.length > 2
        ? "więcej niż jeden ukośnik (np. submoduł repo/a/b) i brak katalogu, z którego da się policzyć klucz"
        : !parts[0].trim()
          ? "pusta część przed ukośnikiem"
          : base
            ? `brak dowodu, że to worktree: żaden katalog sesji nie istnieje ani nie wygląda na worktree „${parts[0]}”`
            : `brak transkryptu z istniejącym katalogiem, a „${parts[0]}” nie istnieje w bazie jako zwykły klucz`;
    out.push({ key, target: null, source: null, evidence: why });
  }
  return out;
}

// ---------------------------------------------------------------- raport

function planLines(p: MergePlan): string[] {
  const c = p.counts;
  const out: string[] = [];
  if (p.sources.length > 1 || (p.sources.length === 1 && p.sources[0] !== p.from))
    out.push(`  pisownie źródła: ${p.sources.join(", ")}`);
  for (const n of p.notes) out.push(`  ${n}`);
  out.push(
    `  sesje ${c.sessions}, prompty ${c.prompts}, notatki ${c.observations} (aktywne ${c.active}), podsumowania ${c.summaries}, stan pracy ${c.workState}, aliasy katalogów ${c.aliases}`,
    `  encje: przemianowane ${c.entities}, scalone z encjami celu ${c.entitiesMerged} (powiązania ${c.links}); klucze plików względem repo ${c.fileKeys}; wektory ${c.vectors ?? "nieznane (brak sqlite-vec)"}, hash treści ${c.hashes}, korpusy ${c.corpora}`,
    `  meta.project_merges: ${p.merges.before === p.merges.after ? "bez zmian" : `„${low(p.from)}” wskazuje „${p.into}”`}`,
  );
  return out;
}

export function formatMergeReport(r: MergeReport): string {
  const lines = [`scalanie projektów${r.dryRun ? " (próba: nic nie zapisano)" : ""}, ${Math.round(r.ms / 1000)} s`];
  if (r.worktrees) {
    if (!r.worktrees.length) lines.push("brak kluczy złożonych (repo/worktree)");
    for (const t of r.worktrees) {
      const p = t.target ? r.plans.find((x) => x.from === t.key) : undefined;
      if (p) lines.push(`„${t.key}” do „${p.into}”, źródło celu: ${t.source} (${t.evidence})`, ...planLines(p));
    }
    const skipped = r.worktrees.filter((t) => !t.target);
    if (skipped.length) lines.push(`pominięte: ${skipped.length}`, ...skipped.map((t) => `  „${t.key}”: ${t.evidence}`));
  } else for (const p of r.plans) lines.push(`„${p.from}” do „${p.into}”`, ...planLines(p));
  lines.push(`zmian razem: ${r.changes}${r.logFile ? `, dziennik: ${r.logFile}` : ""}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- CLI

const USAGE = [
  "Użycie:",
  "  hipokamp project list [--json]                    klucze projektów z liczbami, pisownie, klucze złożone",
  "  hipokamp project list --suspicious [--json]       podejrzane klucze z importu claude-mem (do ręcznej oceny)",
  "  hipokamp project merge <from> <into> [--dry-run] [--rename]",
  "                                                    przenosi całą pamięć projektu pod inny klucz; --rename: cel jeszcze nie istnieje",
  "  hipokamp project merge --worktrees [--dry-run]    scala klucze repo/worktree z importu claude-mem",
  `  po pierwszym hipokamp sync scalenie tylko z ${FORCE_SYNC_FLAG} (najpierw porządki, potem sync)`,
].join("\n");

/** Baza tylko do odczytu jak w `repair --dry-run` (bez migracji, query_only), z sqlite-vec do liczenia wektorów. */
function openReadOnly(): Database {
  if (!existsSync(paths.db())) throw new ProjectError(`brak bazy: ${paths.db()}`);
  const db = openDb({ readonly: true });
  if ((db.query("PRAGMA query_only").get() as { query_only: number } | null)?.query_only !== 1) {
    db.close();
    throw new Error("próba: połączenie z bazą nie jest tylko do odczytu");
  }
  try {
    // samo rozszerzenie: loadVectors zapisuje model wektorów w meta
    const sqliteVec = require("sqlite-vec") as typeof import("sqlite-vec");
    db.loadExtension(sqliteVec.getLoadablePath());
  } catch {}
  return db;
}

/** `hipokamp project <list|merge> ...`; zwraca kod wyjścia. Próba i lista nigdy nie piszą do bazy. */
export function projectCommand(args: string[], say: (m: string) => void = (m) => console.log(m)): number {
  const flags = args.filter((a) => a.startsWith("--"));
  const [sub, ...pos] = args.filter((a) => !a.startsWith("--"));
  const usage = (msg: string) => {
    say(`${msg}\n\n${USAGE}`);
    return 1;
  };
  if (sub === "help" || sub === "-h" || flags.includes("--help")) {
    say(USAGE);
    return 0;
  }
  if (sub !== "list" && sub !== "merge") return usage(sub ? `nieznane polecenie: project ${sub}` : "podaj polecenie");
  const allowed = sub === "list" ? ["--json", "--suspicious"] : ["--dry-run", "--worktrees", "--rename", FORCE_SYNC_FLAG];
  const bad = flags.filter((f) => !allowed.includes(f));
  if (bad.length) return usage(`nieznana opcja: ${bad.join(", ")}`);
  const worktrees = flags.includes("--worktrees");
  if (sub === "list" && pos.length) return usage("list nie przyjmuje argumentów");
  if (sub === "merge" && (worktrees ? pos.length !== 0 : pos.length !== 2))
    return usage(worktrees ? "--worktrees nie przyjmuje kluczy" : "podaj dwa klucze: <from> <into>");
  const iso = <T extends { lastActivity: number | null }>(p: T) => ({
    ...p,
    lastActivity: p.lastActivity ? new Date(p.lastActivity).toISOString() : null,
  });
  try {
    if (sub === "list") {
      const db = openReadOnly();
      try {
        const json = flags.includes("--json");
        if (flags.includes("--suspicious")) {
          const list = suspiciousProjects(db);
          say(json ? JSON.stringify(list.map(iso), null, 2) : formatSuspicious(list));
        } else {
          const list = listProjects(db);
          say(json ? JSON.stringify(list.map(iso), null, 2) : formatProjectList(list));
        }
      } finally {
        db.close();
      }
      return 0;
    }
    const rename = flags.includes("--rename");
    const merge = (db: Database, o: MergeOptions) =>
      worktrees ? mergeWorktrees(db, o) : mergeProject(db, pos[0], pos[1], { ...o, rename });
    if (flags.includes("--dry-run")) {
      const db = openReadOnly();
      try {
        const sync = syncInUse(db);
        if (sync) say(syncWarning("project merge", sync, false));
        say(formatMergeReport(merge(db, { dryRun: true })));
      } finally {
        db.close();
      }
      say(`bez --dry-run: najpierw kopia pre-project-merge w ${backupDir()}, dziennik w ${paths.logs()}`);
      return 0;
    }
    // plan i kopia na połączeniu tylko do odczytu, zanim cokolwiek otworzy bazę do zapisu: pierwsze takie otwarcie
    // przez nowszą wersję robi migracje schematu, a kopia pre-project-merge ma być sprzed nich
    const ro = openReadOnly();
    try {
      // najpierw porządki, potem sync: zmiany zapisanych wierszy nie docierają do innych komputerów (core/sync-guard.ts)
      const sync = flags.includes(FORCE_SYNC_FLAG) ? null : syncInUse(ro);
      if (sync) {
        say(syncWarning("project merge", sync, true));
        return 1;
      }
      const pre = merge(ro, { dryRun: true });
      if (!pre.changes) {
        say(`${formatMergeReport({ ...pre, dryRun: false })}\nnic do zmiany`);
        return 0;
      }
    } finally {
      ro.close();
    }
    const b = backupDbFile(paths.db(), { keep: loadConfig().backup.keep, tag: "pre-project-merge" });
    say(`kopia przed scaleniem: ${b.file}`);
    // zapis jak w repair: wspólne połączenie (WAL, worker może działać); plan liczony od nowa w transakcji zapisu
    const db = getDb();
    say(formatMergeReport(merge(db, { logPath: join(paths.logs(), `project-merge-${stamp()}.jsonl`) })));
    if (!worktrees) say("otwarte sesje Claude Code widzą nowy klucz od następnego wywołania narzędzia hipokampa");
    return 0;
  } catch (e) {
    if (e instanceof ProjectError) {
      say(e.message);
      return 1;
    }
    throw e;
  }
}
