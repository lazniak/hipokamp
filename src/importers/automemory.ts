// Import pamięci automatycznej Claude Code (`<konfiguracja Claude>/projects/<katalog>/memory/*.md`). Każdy plik to
// jedna trwała notatka (warstwa semantic, źródło `automemory`). Rodzaj z frontmattera (`type` na górze albo
// w `metadata`): user i feedback → preference, project → decision albo discovery (wg treści), reference → reference.
// MEMORY.md to indeks: sam nie jest notatką, ale tytuły jego linków są tytułami notatek.
// Idempotentnie: klucz pliku (ścieżka po redakcji sekretów), skrót treści i identyfikator instalacji w meta.automemory.
// Ten sam plik z tą samą treścią jest pomijany, zmieniona treść daje nową notatkę, a poprzednia dostaje status
// superseded ze wskazaniem nowej (jak remember z supersedes). Plik usunięty z istniejącego katalogu memory (Claude Code
// kasuje nieaktualne wspomnienia) przenosi notatkę do archiwum; usunięty cały katalog projektu niczego nie archiwizuje.
// Decyzje użytkownika wygrywają: notatka zapomniana ręcznie (forget) albo zastąpiona notatką spoza pliku (remember)
// nie wraca, a przywrócona ręcznie po usunięciu pliku nie wraca do archiwum. Notatki innych instalacji (synchronizacja)
// są poza importem tej instalacji.
// Do bazy trafia z pliku tylko to, co przeszło przez clean() albo białą listę: treść, opis, tytuł, nazwa, klucz pliku
// i nazwa katalogu przez clean(); rodzaj tylko z listy (user, feedback, project, reference); sesja tylko jako UUID.
// Praca jest pocięta na kroki (generator): worker oddaje pętlę zdarzeń między krokami, CLI i testy wykonują je naraz.
// Importer: SQL wprost (wyjątek z CLAUDE.md), tylko notatki automemory, meta i wyszukanie projektu po transkrypcie.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { clean } from "../capture/redact.ts";
import { type Config, claudeDir, isExcludedTranscript, loadConfig } from "../config.ts";
import { transcriptCwd } from "../core/projects.ts";
import { getMeta, setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { log } from "../log.ts";
import type { EntityRef } from "../types.ts";
import { normPath, projectFromCwd } from "../util/paths.ts";
import { slicer } from "../util/slice.ts";
import { headline, keywords, normKey, sha1, stripMarkdown, truncate } from "../util/text.ts";

/** Plik pamięci w katalogu projektu Claude Code. */
export interface MemoryFile {
  path: string;
  /** Nazwa katalogu projektu w `projects/` (np. `D--code-hipokamp`). */
  projectDir: string;
  size: number;
  mtime: number;
}

/** Plik pamięci po rozbiorze: pola frontmattera (płasko, `metadata.type` też jako `type`) i treść. Wartości surowe. */
export interface MemoryDoc {
  name: string;
  description: string;
  type: string;
  originSessionId: string;
  modified: number | null;
  body: string;
}

export type MemoryAction = "nowa" | "zmiana" | "przywrócona" | "bez zmian" | "pominięta" | "do archiwum";

export interface MemoryPlanItem {
  action: MemoryAction;
  /** Klucz pliku: ścieżka po redakcji sekretów (z krótkim skrótem, gdy redakcja coś zmieniła). */
  file: string;
  projectDir: string;
  project: string | null;
  /** Skąd klucz projektu: sesja z frontmattera, sesje katalogu, transkrypt, ścieżka odczytana z nazwy katalogu. */
  via?: string;
  type?: string;
  title?: string;
  reason?: string;
  /** Notatka, której dotyczy zmiana (poprzednia wersja, archiwum, przywrócenie). */
  prevId?: number;
}

export interface MemoryReport {
  files: number;
  inserted: number;
  updated: number;
  restored: number;
  archived: number;
  unchanged: number;
  skipped: number;
  items: MemoryPlanItem[];
  /** Klucze plików, których nie udało się przeczytać (nadrabianie spróbuje ponownie). */
  unread: string[];
}

const MAX_NARRATIVE = 4000;
/** Większych plików (także MEMORY.md) nie czytamy: wspomnienie to kilka kB, wielki plik blokowałby pętlę workera. */
export const MAX_FILE_BYTES = 256 * 1024;
const IMPORTANCE: Record<string, number> = { preference: 0.75, decision: 0.7, reference: 0.55, discovery: 0.5 };
/** Rodzaje wspomnień Claude Code; inna wartość pola `type` nie trafia nigdzie (biała lista). */
const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
/** Identyfikator sesji Claude Code; inna wartość `originSessionId` nie trafia nigdzie (biała lista). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Plików przetwarzanych w jednym kroku (między krokami worker oddaje pętlę zdarzeń). */
const STEP = 8;
/** Wierszy tabeli observations w jednym kroku przeglądu notatek automemory. */
const SCAN_BATCH = 20_000;
/** Pierwszy ręczny `import-automemory --apply` (włącza nadrabianie przy `capture.autoMemory = null`). */
const APPLIED_KEY = "automemory_applied_at";
/** Stan skanu nadrabiania: klucz pliku → mtime:rozmiar. */
const SEEN_KEY = "automemory_seen";
/** Ścieżki odczytane z nazw katalogów projektów (przeszukanie dysku tylko w CLI, worker korzysta z zapisanych). */
const DIRS_KEY = "automemory_dirs";
/** Stały identyfikator tej instalacji (baza w ~/.hipokamp), niezależny od nazwy komputera. */
const INSTALL_KEY = "install_id";

export function projectsRoot(): string {
  return join(claudeDir(), "projects");
}

/** Czy katalog to domyślny korzeń `projects` z konfiguracji Claude Code (tylko import z niego włącza nadrabianie). */
export function isDefaultRoot(root?: string): boolean {
  if (!root) return true;
  return normPath(resolve(root)).toLowerCase() === normPath(resolve(projectsRoot())).toLowerCase();
}

/**
 * Identyfikator tej instalacji: losowy, w `meta.install_id`, tworzony leniwie (`create`). Nazwa komputera może się
 * zmienić, a baza przejść na inny dysk; identyfikator zostaje. Wchodzi do `meta.automemory.install` i do
 * `content_hash`, więc nie wolno go podmieniać (np. na numer urządzenia z synchronizacji): wszystkie dotychczasowe
 * notatki stałyby się „obcą instalacją” i pierwszy import zdublowałby każdy plik.
 * Synchronizacja (dołączenie urządzenia): gdy baza przyszła z innego komputera (kopia `~/.hipokamp`, przywrócenie
 * z kopii na innym komputerze), `sync init/join` usuwa klucz z `meta` (`foreignInstallId` w src/sync/store.ts) i tu
 * powstaje nowy; inaczej dwa komputery z tym samym identyfikatorem archiwizowałyby i zastępowały nawzajem swoje notatki.
 */
export function machineId(db: Database, create = true): string | null {
  const v = getMeta(db, INSTALL_KEY);
  if (v || !create) return v;
  db.run("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING", [INSTALL_KEY, crypto.randomUUID()]);
  return getMeta(db, INSTALL_KEY);
}

/** Nazwa komputera: tylko do adopcji notatek zapisanych przed identyfikatorem instalacji. */
const thisHost = () => hostname().toLowerCase();

/**
 * Klucz pliku w pamięci: znormalizowana ścieżka po `clean()`. Gdy redakcja coś zmieniła (sekret w nazwie pliku albo
 * katalogu), dochodzi krótki skrót pełnej ścieżki, żeby dwa takie pliki nie skleiły się w jeden.
 */
export function memoryKey(path: string): string {
  const p = normPath(path);
  const c = clean(p);
  return c === p ? p : `${c}#${sha1(p).slice(0, 8)}`;
}

// ---------------------------------------------------------------- stan (meta)

/**
 * Czy worker dociąga pamięć automatyczną: jawna konfiguracja albo (domyślnie, `null`) pierwszy ręczny import
 * z domyślnego katalogu. Napisy "true"/"false" działają jak wartości logiczne; inna wartość: wyłączone z ostrzeżeniem.
 */
export function autoMemoryState(db: Database, cfg: Config = loadConfig()): { on: boolean; why: string; invalid?: boolean } {
  const v: unknown = cfg.capture.autoMemory;
  if (v === true || v === "true") return { on: true, why: "capture.autoMemory = true" };
  if (v === false || v === "false") return { on: false, why: "capture.autoMemory = false" };
  if (v !== null && v !== undefined)
    return {
      on: false,
      invalid: true,
      why: `nieznana wartość capture.autoMemory (${truncate(JSON.stringify(v), 40)}): użyj true, false albo null; do tego czasu wyłączone`,
    };
  const at = Number(getMeta(db, APPLIED_KEY) ?? 0);
  return at
    ? { on: true, why: `po imporcie ręcznym ${new Date(at).toLocaleString("pl-PL")}` }
    : { on: false, why: "czeka na pierwszy hipokamp import-automemory --apply (albo capture.autoMemory = true)" };
}

/** Zapamiętuje pierwszy ręczny import z domyślnego katalogu (CLI `--apply`): od teraz worker dociąga zmiany sam. */
export function markAutoMemoryApplied(repo: Repo, now = Date.now()): void {
  if (!getMeta(repo.db, APPLIED_KEY)) setMeta(repo.db, APPLIED_KEY, String(now));
}

function readJsonMeta(db: Database, k: string): Record<string, string> | null {
  try {
    const v = JSON.parse(getMeta(db, k) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pliki

const under = (p: string, root: string) => {
  const a = normPath(p).toLowerCase();
  const b = normPath(root).toLowerCase();
  return a.startsWith(b.endsWith("/") ? b : `${b}/`);
};

/**
 * Pliki `*.md` z katalogów `memory` wszystkich projektów (bez MEMORY.md i katalogów wykluczonych). Dowiązania
 * symboliczne i junction prowadzące poza korzeń są pomijane (katalog `memory` po rozwinięciu musi leżeć pod korzeniem,
 * pliki muszą być zwykłymi plikami), więc import nie czyta nic spoza `projects`.
 */
export function listMemoryFiles(root = projectsRoot()): MemoryFile[] {
  const out: MemoryFile[] = [];
  let realRoot: string;
  let dirs: string[] = [];
  try {
    realRoot = realpathSync(root);
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const md = join(root, d, "memory");
    if (isExcludedTranscript(md)) continue;
    let files: string[] = [];
    try {
      if (!under(realpathSync(md), realRoot)) continue;
      files = readdirSync(md);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".md") || f.toLowerCase() === "memory.md") continue;
      try {
        const st = lstatSync(join(md, f));
        if (st.isFile()) out.push({ path: join(md, f), projectDir: d, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/**
 * Frontmatter YAML w podzbiorze, jaki pisze Claude Code: `klucz: wartość` i jeden poziom zagnieżdżenia
 * (`metadata:` z wcięciem). Klucz zagnieżdżony wygrywa tylko wtedy, gdy na górze go nie ma. Wartości surowe:
 * walidację i redakcję robi `prepare`.
 */
export function parseMemory(text: string): MemoryDoc {
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const fm: Record<string, string> = {};
  let body = t;
  const m = t.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (m) {
    body = t.slice(m[0].length);
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\s*)([\w.-]+)\s*:\s*(.*)$/);
      if (!kv?.[3].trim()) continue;
      const key = kv[2];
      const val = unquote(kv[3]);
      if (!kv[1]) fm[key] = val;
      else if (fm[key] === undefined) fm[key] = val;
    }
  }
  const modified = fm.modified ? Date.parse(fm.modified) : Number.NaN;
  return {
    name: fm.name ?? "",
    description: fm.description ?? "",
    type: (fm.type ?? "").toLowerCase(),
    originSessionId: fm.originSessionId ?? "",
    modified: Number.isFinite(modified) ? modified : null,
    body: body.trim(),
  };
}

/** Tytuły z indeksu MEMORY.md: `- [Tytuł](plik.md) — opis` → nazwa pliku (małe litery) → tytuł. */
export function indexTitles(memoryMd: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of memoryMd.matchAll(/\[([^\]\n]+)\]\(([^)\s]+\.md)\)/gi)) {
    const file = basename(m[2]).toLowerCase();
    if (!out.has(file)) out.set(file, m[1].trim());
  }
  return out;
}

/**
 * Indeks MEMORY.md katalogu (bez czytania pliku większego niż limit). Tylko zwykły plik, jak dla wspomnień
 * (`listMemoryFiles`): dowiązanie symboliczne mogłoby prowadzić poza `projects`.
 */
function readIndex(memoryDir: string): Map<string, string> {
  const p = join(memoryDir, "MEMORY.md");
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return new Map();
    return indexTitles(readFileSync(p, "utf8"));
  } catch {
    return new Map();
  }
}

// słowa, po których wspomnienie typu project jest decyzją (ustalenie, reguła), a nie samym odkryciem (po normKey)
const DECISION_WORDS =
  /(?:^| )(?:decyzj|zdecydow|ustal|postanow|zasad|regul|zawsze|nigdy|nie wolno|nie uzywa|musi|musza|zamiast|wylacznie|tylko przez|why|how to apply|dlaczego|jak stosowac|decid|decision|always|never|must|rule|policy|instead)/;

/** Kanoniczny rodzaj notatki dla typu wspomnienia (nieznany typ: jak project). */
export function kindOf(type: string, text: string): string {
  if (type === "user" || type === "feedback") return "preference";
  if (type === "reference") return "reference";
  return DECISION_WORDS.test(normKey(text)) ? "decision" : "discovery";
}

/** `**Why:**` i `**How to apply:**` (albo polskie odpowiedniki) jako fakty notatki. */
export function memoryFacts(body: string): string[] {
  const out: string[] = [];
  const labels: [RegExp, string][] = [
    [/^(?:why|dlaczego)$/i, "Dlaczego"],
    [/^(?:how to apply|jak stosować|jak stosowac)$/i, "Jak stosować"],
  ];
  for (const m of body.matchAll(/\*\*([^*\n]{2,30}?):\*\*\s*([\s\S]*?)(?=\n\s*\n|\n\*\*[^*\n]{2,30}?:\*\*|$)/g)) {
    const label = labels.find(([re]) => re.test(m[1].trim()))?.[1];
    // clean() po stripMarkdown i przed ucięciem: sekret rozcięty znacznikiem kodu (`sk-ant-`api03`-…`) skleja się
    // dopiero po zdjęciu znaczników, a ucięty w połowie przestałby pasować do wzorca
    const text = clean(stripMarkdown(m[2]).replace(/\s+/g, " ").trim());
    if (label && text) out.push(`${label}: ${truncate(text, 300)}`);
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- klucz projektu

/**
 * Ścieżka katalogu z nazwy katalogu projektu Claude Code (każdy znak spoza [A-Za-z0-9] zamieniony na „-”, więc
 * zapis nie jest odwracalny): schodzimy po istniejących katalogach i porównujemy ich zakodowane nazwy. Synchroniczne
 * odczyty dysku: tylko w CLI (worker korzysta z wyników zapisanych w meta), najwyżej 200 odczytów katalogu.
 */
export function decodeProjectDir(name: string): string | null {
  const win = name.match(/^([A-Za-z])--(.*)$/);
  const posix = !win && name.startsWith("-") ? name.slice(1) : null;
  if (!win && posix === null) return null;
  const enc = (s: string) => s.replace(/[^A-Za-z0-9]/g, "-");
  // limit odczytanych katalogów: niejednoznaczne nazwy nie rozgałęzią przeszukiwania na cały dysk
  let reads = 0;
  const walk = (dir: string, rest: string, depth: number): string | null => {
    if (!rest) return dir;
    if (depth > 40 || ++reads > 200) return null;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return null;
    }
    // dłuższe nazwy najpierw: „a-b” wygrywa z „a”, gdy obie pasują do początku
    for (const e of entries.sort((a, b) => b.length - a.length)) {
      const x = enc(e);
      if (rest === x) return join(dir, e);
      if (rest.startsWith(`${x}-`)) {
        const r = walk(join(dir, e), rest.slice(x.length + 1), depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return win ? walk(`${win[1].toUpperCase()}:\\`, win[2], 0) : walk("/", posix!, 0);
}

/**
 * Klucz projektu dla katalogu `projects/<dir>`: jak dla sesji z tego katalogu (aliasy i scalenia w Repo). Bez
 * `decode` (worker) ścieżka z nazwy katalogu pochodzi tylko z wyników zapisanych wcześniej w meta: żadnego
 * przeszukiwania dysku (odłączony dysk sieciowy zawiesiłby worker).
 */
export function dirProjectResolver(
  repo: Repo,
  root: string,
  opts: { decode?: boolean } = {},
): ((dir: string) => { project: string | null; via: string }) & { decoded: Record<string, string> } {
  const cache = new Map<string, { project: string | null; via: string }>();
  const decoded: Record<string, string> = { ...(readJsonMeta(repo.db, DIRS_KEY) ?? {}) };
  const bySessions = repo.db.query(
    `SELECT project, COUNT(*) n FROM sessions WHERE instr(lower(replace(transcript_path, '\\', '/')), ?) > 0
     GROUP BY project ORDER BY n DESC, MAX(started_at) DESC LIMIT 1`,
  );
  // resolveProject zapisuje ścieżkę bez redakcji w project_aliases: ścieżka, którą clean() zmienia (sekret w nazwie
  // katalogu albo w cwd transkryptu), dostaje klucz liczony bez zapisu aliasu
  const projectOf = (p: string) => (clean(p) === p ? repo.resolveProject(p) : repo.mergedProject(projectFromCwd(p)));
  const resolveDir = (dir: string) => {
    const hit = cache.get(dir);
    if (hit) return hit;
    const dp = join(root, dir);
    let res: { project: string | null; via: string } = { project: null, via: "brak" };
    // 1) sesje z transkryptami w tym katalogu: klucz policzony przy zapisie (CLAUDE_PROJECT_DIR, aliasy)
    const s = bySessions.get(`${normPath(dp).toLowerCase()}/`) as { project: string } | null;
    if (s) res = { project: repo.mergedProject(s.project), via: "sesje" };
    else {
      // 2) cwd z najnowszego transkryptu katalogu, 3) ścieżka odczytana z nazwy katalogu
      let cwd: string | null = null;
      try {
        const newest = readdirSync(dp)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ f, m: statSync(join(dp, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0];
        if (newest) cwd = transcriptCwd(join(dp, newest.f));
      } catch {}
      if (cwd) res = { project: projectOf(cwd), via: "transkrypt" };
      else {
        let p: string | null = decoded[dir] ?? null;
        if (!p && opts.decode) {
          p = decodeProjectDir(dir);
          // do meta tylko wartości bez sekretów (nazwa katalogu i ścieżka przechodzą przez clean() bez zmian)
          if (p && clean(dir) === dir && clean(p) === p) decoded[dir] = p;
        }
        if (p) res = { project: projectOf(p), via: "ścieżka" };
      }
    }
    cache.set(dir, res);
    return res;
  };
  return Object.assign(resolveDir, { decoded });
}

// ---------------------------------------------------------------- notatki już zaimportowane

interface Imported {
  id: number;
  status: string;
  project: string;
  file: string;
  sha: string;
  removed: boolean;
  supersededBy: number | null;
}

/** Notatki automemory tej instalacji: klucz pliku (małe litery) → wersje, najnowsza pierwsza. */
interface Ctx {
  mid: string | null;
  byFile: Map<string, Imported[]>;
  /** Notatki zapisane przed identyfikatorem instalacji, z nazwą tego komputera: do adopcji przy zapisie. */
  adopt: number[];
}

function rowToImported(r: { id: number; status: string; project: string; superseded_by: number | null }, a: any): Imported {
  return {
    id: r.id,
    status: r.status,
    project: r.project,
    file: String(a.file),
    sha: String(a.sha ?? ""),
    removed: !!a.removed_at,
    supersededBy: r.superseded_by ?? null,
  };
}

/**
 * Jedno przejście po notatkach `source = 'automemory'` (bez indeksu po źródle: przegląd po zakresach numerów,
 * krok co SCAN_BATCH wierszy). Mapa żyje przez cały przebieg i jest aktualizowana w pamięci po każdym zapisie.
 */
function* scanImported(repo: Repo, mid: string | null): Generator<void, Ctx> {
  const host = thisHost();
  const ctx: Ctx = { mid, byFile: new Map(), adopt: [] };
  const boundary = repo.db.query("SELECT id FROM observations WHERE id > ? ORDER BY id LIMIT 1 OFFSET ?");
  const rows = repo.db.query(
    "SELECT id, status, project, superseded_by, meta FROM observations WHERE id > ? AND id <= ? AND source = 'automemory'",
  );
  let lo = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const b = boundary.get(lo, SCAN_BATCH - 1) as { id: number } | null;
    const hi = b?.id ?? Number.MAX_SAFE_INTEGER;
    for (const r of rows.all(lo, hi) as {
      id: number;
      status: string;
      project: string;
      superseded_by: number | null;
      meta: string | null;
    }[]) {
      let a: any = null;
      try {
        a = JSON.parse(r.meta ?? "null")?.automemory;
      } catch {}
      if (!a?.file) continue;
      // inna instalacja (synchronizacja): jej plik nie jest naszym plikiem, nawet przy tej samej ścieżce
      if (a.install) {
        if (a.install !== mid) continue;
      } else if (a.host && String(a.host).toLowerCase() !== host) continue;
      else ctx.adopt.push(r.id);
      const k = String(a.file).toLowerCase();
      const list = ctx.byFile.get(k) ?? [];
      list.unshift(rowToImported(r, a));
      ctx.byFile.set(k, list);
    }
    if (!b) break;
    lo = hi;
    yield;
  }
  for (const list of ctx.byFile.values()) list.sort((x, y) => y.id - x.id);
  return ctx;
}

/** Odświeża stan wersji pliku z bazy (po numerach): w międzyczasie forget, remember albo drugi proces. */
function refresh(repo: Repo, list: Imported[]): void {
  if (!list.length) return;
  const rows = repo.db
    .query(
      `SELECT id, status, superseded_by, json_extract(meta, '$.automemory.removed_at') removed FROM observations WHERE id IN (${list.map(() => "?").join(",")})`,
    )
    .all(...list.map((x) => x.id)) as { id: number; status: string; superseded_by: number | null; removed: number | null }[];
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const x of list) {
    const r = by.get(x.id);
    if (!r) continue;
    x.status = r.status;
    x.supersededBy = r.superseded_by ?? null;
    x.removed = r.removed != null;
  }
}

/** Bieżąca wersja pliku w pamięci: najnowsza notatka, która nie została zastąpiona. */
const currentOf = (list: Imported[] | undefined) => list?.find((x) => x.status !== "superseded");

const FORGOTTEN = "notatka zapomniana ręcznie (forget); po przywróceniu import znów ją śledzi";

function decide(list: Imported[] | undefined, sha: string): { action: MemoryAction; prevId?: number; reason?: string } {
  const cur = currentOf(list);
  if (!cur) {
    // wszystkie wersje zastąpione, ostatnia przez notatkę spoza tego pliku (remember z supersedes): decyzja
    // użytkownika, nie wskrzeszamy
    const last = list?.[0];
    if (last?.supersededBy != null && !list!.some((x) => x.id === last.supersededBy))
      return {
        action: "pominięta",
        prevId: last.id,
        reason: `zastąpiona notatką #${last.supersededBy} spoza tego pliku (np. remember); import jej nie wskrzesza`,
      };
    return { action: "nowa" };
  }
  // archiwum bez znacznika usunięcia pliku to decyzja użytkownika (forget): nie wskrzeszamy ani nie dokładamy wersji
  if (cur.status === "archived" && !cur.removed) return { action: "pominięta", prevId: cur.id, reason: FORGOTTEN };
  // usunięty plik wrócił z tą samą treścią (albo notatkę przywrócono ręcznie): znacznik usunięcia znika
  if (cur.sha === sha) return cur.removed ? { action: "przywrócona", prevId: cur.id } : { action: "bez zmian", prevId: cur.id };
  return { action: "zmiana", prevId: cur.id };
}

// ---------------------------------------------------------------- plan i zapis

interface Prepared {
  item: MemoryPlanItem;
  file?: MemoryFile;
  /** Pola po clean() i białej liście: tylko te trafiają do bazy. */
  doc?: { body: string; description: string; name: string; type: string | null; session: string | null; modified: number | null };
  sha?: string;
  title?: string;
  subtitle?: string | null;
  unread?: boolean;
}

interface ReadFile {
  f: MemoryFile;
  raw: string;
  doc: MemoryDoc | null;
  session: string | null;
  sessProject: string | null;
  error: string | null;
  big: boolean;
}

/** Plan dla podanych plików (bez zapisu), krokami. Dry-run i zapis liczą go tą samą funkcją. */
function* prepare(
  repo: Repo,
  files: MemoryFile[],
  resolveDir: (dir: string) => { project: string | null; via: string },
  ctx: Ctx,
): Generator<void, Prepared[]> {
  const cfg = loadConfig();
  const titles = new Map<string, Map<string, string>>();
  const out: Prepared[] = [];
  // pierwsze przejście: treść i sesja każdego pliku; projekt z sesji jednego wspomnienia obowiązuje cały katalog
  const read: ReadFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size > MAX_FILE_BYTES) read.push({ f, raw: "", doc: null, session: null, sessProject: null, error: null, big: true });
    else
      try {
        const raw = readFileSync(f.path, "utf8");
        const doc = parseMemory(raw);
        const session = UUID.test(doc.originSessionId) ? doc.originSessionId.toLowerCase() : null;
        const sess = session ? repo.getSession(session) : null;
        read.push({ f, raw, doc, session, sessProject: sess ? repo.mergedProject(sess.project) : null, error: null, big: false });
      } catch (e) {
        read.push({ f, raw: "", doc: null, session: null, sessProject: null, error: clean(String(e)).slice(0, 80), big: false });
      }
    if ((i + 1) % STEP === 0) yield;
  }
  // klucz: pełna ścieżka katalogu projektu (ten sam katalog pod innym korzeniem to inny projekt)
  const dirKey = (memoryFile: string) => normPath(dirname(dirname(memoryFile))).toLowerCase();
  const dirProject = new Map<string, string>();
  for (const x of ctx.byFile.values())
    for (const n of x) if (!dirProject.has(dirKey(n.file))) dirProject.set(dirKey(n.file), n.project);
  for (const r of read) if (r.sessProject) dirProject.set(dirKey(memoryKey(r.f.path)), r.sessProject);
  let i = 0;
  for (const { f, raw, doc, session, sessProject, error, big } of read) {
    if (++i % STEP === 0) yield;
    const key = memoryKey(f.path);
    const base: MemoryPlanItem = { action: "pominięta", file: key, projectDir: clean(f.projectDir), project: null };
    if (big) {
      out.push({
        item: { ...base, reason: `plik za duży (${Math.round(f.size / 1024)} KB, limit ${MAX_FILE_BYTES / 1024} KB)` },
      });
      continue;
    }
    if (!doc) {
      out.push({ item: { ...base, reason: `nie da się przeczytać: ${error}` }, unread: true });
      continue;
    }
    if (!doc.body && !doc.description) {
      out.push({ item: { ...base, reason: "pusty plik" } });
      continue;
    }
    // projekt: sesja z frontmattera (ta, w której powstało wspomnienie), sesja innego wspomnienia z tego katalogu
    // (albo notatka zaimportowana z niego wcześniej), wreszcie sam katalog projektu
    let project: string | null = sessProject;
    let via = "sesja";
    if (!project && dirProject.has(dirKey(key))) {
      project = dirProject.get(dirKey(key))!;
      via = "katalog";
    } else if (!project) ({ project, via } = resolveDir(f.projectDir));
    if (!project) {
      out.push({
        item: {
          ...base,
          via,
          reason: "nie da się ustalić projektu (brak sesji i transkryptu; ścieżkę z nazwy katalogu odczytuje import ręczny)",
        },
      });
      continue;
    }
    // klucz projektu z nazwy katalogu albo z cwd też przechodzi przez clean()
    project = clean(project);
    if (cfg.capture.excludeProjects.some((p) => p.toLowerCase() === project!.toLowerCase())) {
      out.push({ item: { ...base, project, via, reason: "projekt wykluczony (capture.excludeProjects)" } });
      continue;
    }
    if (!titles.has(f.projectDir)) titles.set(f.projectDir, readIndex(dirname(f.path)));
    // wszystko, co trafia do notatki (tytuł, meta, klucz), przechodzi przez clean() albo białą listę: także nazwa
    // z frontmattera i nazwa pliku, które są tytułem zastępczym
    const body = clean(doc.body);
    const description = clean(doc.description);
    const name = clean(doc.name);
    const type = MEMORY_TYPES.has(doc.type) ? doc.type : null;
    const fromIndex = titles.get(f.projectDir)?.get(basename(f.path).toLowerCase());
    // headline() zdejmuje znaczniki Markdown (sekret rozcięty znacznikiem kodu skleja się dopiero wtedy), więc
    // clean() idzie na gotowy tekst, przed ucięciem
    const title =
      truncate(clean(fromIndex ?? ""), 120) ||
      truncate(description, 120) ||
      truncate(clean(headline(body, 100_000)), 100) ||
      truncate(name, 120) ||
      truncate(clean(basename(f.path, ".md")), 120);
    const subtitle =
      description && description !== title && !title.startsWith(description.slice(0, 40))
        ? truncate(clean(description), 300)
        : null;
    const sha = sha1(raw.replace(/\r\n?/g, "\n")).slice(0, 20);
    const kind = kindOf(type ?? "", `${description}\n${body}`);
    const d = decide(ctx.byFile.get(key.toLowerCase()), sha);
    out.push({
      item: { ...base, ...d, project, via, type: kind, title },
      file: f,
      doc: { body, description, name, type, session, modified: doc.modified },
      sha,
      title,
      subtitle,
    });
  }
  return out;
}

/** Notatki plików, które zniknęły z żyjącego katalogu memory (pod tym korzeniem): do archiwum. */
function removedItems(ctx: Ctx, listed: Set<string>, root: string, only?: Set<string>): MemoryPlanItem[] {
  const out: MemoryPlanItem[] = [];
  const prefix = `${normPath(root).toLowerCase()}/`;
  for (const [k, list] of ctx.byFile) {
    if (listed.has(k) || !k.startsWith(prefix) || (only && !only.has(k))) continue;
    const cur = currentOf(list);
    // tylko aktywne; aktywna ze znacznikiem usunięcia to notatka przywrócona ręcznie: zostaje
    if (cur?.status !== "active" || cur.removed) continue;
    // cały katalog projektu zniknął (sprzątanie, usunięty scratch): wspomnienie zostaje w pamięci
    if (!existsSync(dirname(cur.file))) continue;
    if (existsSync(cur.file)) continue;
    out.push({
      action: "do archiwum",
      file: cur.file,
      projectDir: basename(dirname(dirname(cur.file))),
      project: null,
      prevId: cur.id,
      reason: "plik usunięty z katalogu memory",
    });
  }
  return out;
}

/** Skrót treści notatki z instalacji, pliku i treści: dwa identyczne pliki w dwóch katalogach to dwie notatki. */
const memoryHash = (mid: string, key: string, sha: string) =>
  sha1(`automemory\u0001${mid}\u0001${key.toLowerCase()}\u0001${sha}`).slice(0, 20);

function insertMemory(repo: Repo, p: Prepared, now: number, mid: string): { id: number; duplicateOf?: number } {
  const f = p.file!;
  const doc = p.doc!;
  const key = p.item.file;
  const created = Math.min(now, doc.modified ?? Math.round(f.mtime));
  // słowa kluczowe z treści po zdjęciu Markdown: takie, które clean() zmienia, odpadają (encje i FTS bez sekretów)
  const concepts = keywords(`${p.title}\n${doc.body}`, 6).filter((k) => clean(k) === k);
  const entities: EntityRef[] = concepts.map((k) => ({ kind: "concept", key: k, role: "concept" }));
  const sess = doc.session && repo.getSession(doc.session) ? doc.session : null;
  return repo.insertObservation(
    {
      session_id: sess,
      project: p.item.project!,
      type: p.item.type!,
      tier: "semantic",
      title: p.title!,
      subtitle: p.subtitle ?? null,
      narrative: truncate(doc.body, MAX_NARRATIVE) || null,
      facts: memoryFacts(doc.body),
      concepts,
      // plik pamięci nie jest „plikiem projektu”: bez files_modified (inaczej linia „pliki: …/memory/x.md”
      // w kontekście i przypominanie przy każdym odczycie pliku), zmiany pliku śledzi import
      files_modified: [],
      created_at: created,
      importance: IMPORTANCE[p.item.type!] ?? 0.6,
      source: "automemory",
      content_hash: memoryHash(mid, key, p.sha!),
      meta: {
        automemory: {
          file: key,
          sha: p.sha,
          install: mid,
          host: clean(thisHost()),
          name: doc.name || null,
          type: doc.type,
          dir: p.item.projectDir,
          session: doc.session,
        },
      },
    },
    entities,
  );
}

/**
 * Wersje tego pliku zapisane w międzyczasie przez drugi proces (import ręczny i worker naraz), których nie ma w mapie
 * z początku przebiegu: ta sama wersja po skrócie treści (indeks projekt + skrót) i nowsze wersje po łańcuchu
 * `superseded_by` (po numerach). Bez tego drugi zapis trafiłby w deduplikację (licznik powtórek i ważność w górę),
 * a zmieniony plik wyglądałby na zastąpiony przez `remember`.
 */
function pullConcurrent(repo: Repo, list: Imported[], key: string, mid: string, same?: { project: string; hash: string }): void {
  const k = key.toLowerCase();
  const add = (r: { id: number; status: string; project: string; superseded_by: number | null; meta: string | null } | null) => {
    if (!r || list.some((x) => x.id === r.id)) return false;
    let a: any = null;
    try {
      a = JSON.parse(r.meta ?? "null")?.automemory;
    } catch {}
    if (!a?.file || String(a.file).toLowerCase() !== k || a.install !== mid) return false;
    list.push(rowToImported(r, a));
    list.sort((x, y) => y.id - x.id);
    return true;
  };
  const cols = "SELECT id, status, project, superseded_by, meta FROM observations";
  if (same)
    add(
      repo.db
        .query(`${cols} WHERE project = ? AND content_hash = ? ORDER BY id DESC LIMIT 1`)
        .get(same.project, same.hash) as any,
    );
  const byId = repo.db.query(`${cols} WHERE id = ?`);
  for (let i = 0; i < 8; i++) {
    const last = list[0];
    if (last?.supersededBy == null || list.some((x) => x.id === last.supersededBy)) break;
    if (!add(byId.get(last.supersededBy) as any)) break;
  }
}

/**
 * Zapis jednej pozycji w transakcji IMMEDIATE; decyzja liczona od nowa na odświeżonym stanie wersji pliku (forget,
 * remember albo drugi proces mogły zdążyć). Mapa wersji w `ctx` aktualizowana w pamięci.
 */
function applyOne(repo: Repo, p: Prepared, now: number, ctx: Ctx): { action: MemoryAction; prevId?: number; reason?: string } {
  return repo.db
    .transaction((): { action: MemoryAction; prevId?: number; reason?: string } => {
      const it = p.item;
      const k = it.file.toLowerCase();
      const list = ctx.byFile.get(k) ?? [];
      refresh(repo, list);
      if (it.action === "do archiwum") {
        const cur = currentOf(list);
        if (!cur || cur.id !== it.prevId || cur.status !== "active" || cur.removed || existsSync(it.file))
          return { action: "bez zmian" };
        repo.setStatus(cur.id, "archived");
        repo.db.run("UPDATE observations SET meta = json_set(COALESCE(meta, '{}'), '$.automemory.removed_at', ?) WHERE id = ?", [
          now,
          cur.id,
        ]);
        cur.status = "archived";
        cur.removed = true;
        return { action: "do archiwum", prevId: cur.id };
      }
      if (!p.file || !p.sha || !ctx.mid) return { action: "pominięta", reason: "brak identyfikatora instalacji" };
      pullConcurrent(repo, list, it.file, ctx.mid, { project: it.project!, hash: memoryHash(ctx.mid, it.file, p.sha) });
      ctx.byFile.set(k, list);
      const d = decide(list, p.sha);
      if (d.action === "bez zmian" || d.action === "pominięta") return d;
      if (d.action === "przywrócona") {
        const cur = list.find((x) => x.id === d.prevId)!;
        if (cur.status !== "active") repo.setStatus(cur.id, "active");
        repo.db.run("UPDATE observations SET meta = json_remove(meta, '$.automemory.removed_at') WHERE id = ?", [cur.id]);
        cur.status = "active";
        cur.removed = false;
        return d;
      }
      const ins = insertMemory(repo, p, now, ctx.mid);
      // ta sama treść zapisana już inaczej (deduplikacja): nic nowego nie powstało
      if (ins.duplicateOf) return { action: "bez zmian", prevId: ins.duplicateOf, reason: "ta sama treść jest już w pamięci" };
      const id = ins.id;
      if (!list.some((x) => x.id === id))
        list.unshift({
          id,
          status: "active",
          project: p.item.project!,
          file: it.file,
          sha: p.sha,
          removed: false,
          supersededBy: null,
        });
      ctx.byFile.set(k, list);
      if (d.action === "zmiana" && d.prevId && d.prevId !== id) {
        const prev = list.find((x) => x.id === d.prevId);
        if (prev?.status === "active") {
          repo.setStatus(d.prevId, "superseded", { supersededBy: id, validUntil: now });
          prev.status = "superseded";
          prev.supersededBy = id;
        }
      }
      return d;
    })
    .immediate();
}

function emptyReport(): MemoryReport {
  return { files: 0, inserted: 0, updated: 0, restored: 0, archived: 0, unchanged: 0, skipped: 0, items: [], unread: [] };
}

function count(rep: MemoryReport, a: MemoryAction): void {
  if (a === "nowa") rep.inserted++;
  else if (a === "zmiana") rep.updated++;
  else if (a === "przywrócona") rep.restored++;
  else if (a === "do archiwum") rep.archived++;
  else if (a === "bez zmian") rep.unchanged++;
  else rep.skipped++;
}

export interface AutoMemoryOptions {
  /** Katalog `projects` (domyślnie z konfiguracji Claude Code). */
  root?: string;
  /** false = tylko plan (domyślnie), true = zapis. */
  apply?: boolean;
  /** Ograniczenie do tych plików (nadrabianie w workerze); bez niego: wszystkie pliki i usunięcia pod korzeniem. */
  files?: MemoryFile[];
  /** Klucze plików zniknięte od poprzedniego skanu (nadrabianie): tylko one są sprawdzane pod kątem archiwum. */
  gone?: string[];
  /**
   * Ścieżka z nazwy katalogu projektu przez przeszukanie dysku (CLI). Worker tego nie robi: korzysta z wyników
   * zapisanych przez import ręczny.
   */
  decode?: boolean;
  now?: number;
}

/**
 * Plan albo import krokami (generator): między krokami wywołujący może oddać pętlę zdarzeń. Eksport także dla testu
 * wyścigu (import ręczny i worker naraz).
 */
export function* importSteps(repo: Repo, opts: AutoMemoryOptions): Generator<void, MemoryReport> {
  const root = opts.root ?? projectsRoot();
  const now = opts.now ?? Date.now();
  const all = opts.files ?? listMemoryFiles(root);
  yield;
  // plan na bazie tylko do odczytu nie tworzy identyfikatora instalacji
  const mid = machineId(repo.db, !!opts.apply);
  const ctx = yield* scanImported(repo, mid);
  // notatki sprzed identyfikatora instalacji z nazwą tego komputera: przejmujemy je (zmiana nazwy komputera później
  // ich nie zgubi)
  if (opts.apply && mid && ctx.adopt.length) {
    const up = repo.db.query("UPDATE observations SET meta = json_set(meta, '$.automemory.install', ?) WHERE id = ?");
    repo.db.transaction(() => {
      for (const id of ctx.adopt) up.run(mid, id);
    })();
    yield;
  }
  const resolveDir = dirProjectResolver(repo, root, { decode: opts.decode });
  const before = getMeta(repo.db, DIRS_KEY);
  const prepared = yield* prepare(repo, all, resolveDir, ctx);
  // pełny przebieg sprawdza wszystkie usunięcia pod korzeniem, przyrostowy tylko pliki zniknięte od poprzedniego skanu
  const listed = new Set(all.map((f) => memoryKey(f.path).toLowerCase()));
  const only = opts.files ? new Set((opts.gone ?? []).map((g) => g.toLowerCase())) : undefined;
  for (const it of removedItems(ctx, listed, root, only)) prepared.push({ item: it });
  const rep = emptyReport();
  rep.files = all.length;
  let n = 0;
  for (const p of prepared) {
    let item = p.item;
    if (opts.apply && item.action !== "pominięta" && item.action !== "bez zmian") {
      // decyzja z transakcji (z powodem) zastępuje decyzję z planu: drugi proces albo forget mogły zdążyć
      const d = applyOne(repo, p, now, ctx);
      item = {
        ...item,
        action: d.action,
        prevId: d.prevId ?? item.prevId,
        reason: d.reason ?? (d.action === item.action ? item.reason : undefined),
      };
      if (++n % STEP === 0) yield;
    }
    count(rep, item.action);
    rep.items.push(item);
    if (p.unread) rep.unread.push(p.item.file);
  }
  // ścieżki odczytane z nazw katalogów: zapisane, żeby worker nie musiał przeszukiwać dysku
  const dirs = JSON.stringify(resolveDir.decoded);
  if (opts.apply && dirs !== (before ?? "{}")) setMeta(repo.db, DIRS_KEY, dirs);
  return rep;
}

/** Plan albo import pamięci automatycznej naraz (CLI, testy). Drugi przebieg bez zmian w plikach nic nie zmienia. */
export function importAutoMemory(repo: Repo, opts: AutoMemoryOptions = {}): MemoryReport {
  const g = importSteps(repo, opts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

// ---------------------------------------------------------------- nadrabianie w workerze

const stampOf = (f: MemoryFile) => `${Math.round(f.mtime)}:${f.size}`;

/**
 * Dociąga zmiany pamięci automatycznej (worker, przy nadrabianiu): czyta tylko pliki nowe albo zmienione od
 * poprzedniego skanu (stan w meta, przetrwa restart workera) i sprawdza pliki, które zniknęły. Między krokami oddaje
 * pętlę zdarzeń (`slicer`: przerwa co ok. 40 ms pracy), więc hooki dostają odpowiedź także przy dużej bazie. Plik, którego nie udało się
 * przeczytać, nie trafia do stanu, więc następny skan spróbuje ponownie. Same odczyty lokalnych plików, bez sieci
 * i bez przeszukiwania dysku.
 */
export async function syncAutoMemory(repo: Repo, opts: { root?: string } = {}): Promise<MemoryReport> {
  const root = opts.root ?? projectsRoot();
  const files = listMemoryFiles(root);
  const prev = readJsonMeta(repo.db, SEEN_KEY);
  const byKey = new Map(files.map((f) => [memoryKey(f.path), f]));
  const changed = prev ? files.filter((f) => prev[memoryKey(f.path)] !== stampOf(f)) : files;
  const gone = prev ? Object.keys(prev).filter((k) => !byKey.has(k)) : [];
  if (prev && !changed.length && !gone.length) return emptyReport();
  // bez zapisanego stanu: pełny przebieg (pliki i usunięcia), dalej tylko różnice
  const g = importSteps(repo, prev ? { root, apply: true, files: changed, gone } : { root, apply: true });
  // przerwa co ok. 40 ms pracy; w workerze (track sliced) każdy kawałek trafia do diagnostyki przestojów
  const pause = slicer();
  let r = g.next();
  while (!r.done) {
    await pause();
    r = g.next();
  }
  const rep = r.value;
  const unread = new Set(rep.unread);
  const next: Record<string, string> = {};
  for (const [k, f] of byKey) if (!unread.has(k)) next[k] = stampOf(f);
  setMeta(repo.db, SEEN_KEY, JSON.stringify(next));
  if (rep.inserted || rep.updated || rep.archived || rep.restored)
    log.info("pamięć automatyczna", {
      nowe: rep.inserted,
      zmienione: rep.updated,
      przywrócone: rep.restored,
      archiwum: rep.archived,
    });
  return rep;
}

/**
 * Krok nadrabiania w workerze (osobno od `catchUp` transkryptów): gdy pamięć automatyczna jest włączona
 * (`autoMemoryState`), dociąga zmiany z domyślnego katalogu. Zwraca liczbę zmienionych notatek; błąd tylko w logu.
 */
export async function catchUpAutoMemory(repo: Repo, cfg: Config = loadConfig()): Promise<number> {
  if (!autoMemoryState(repo.db, cfg).on) return 0;
  try {
    const m = await syncAutoMemory(repo);
    return m.inserted + m.updated + m.restored + m.archived;
  } catch (e) {
    log.error("nadrabianie: pamięć automatyczna", e);
    return 0;
  }
}

/** Tylko dla testów: zapomina stan skanu (jak przy pierwszym uruchomieniu). */
export function resetAutoMemorySeen(repo: Repo): void {
  repo.db.run("DELETE FROM meta WHERE k = ?", [SEEN_KEY]);
}

// ---------------------------------------------------------------- raport CLI

export function formatMemoryReport(rep: MemoryReport, opts: { apply: boolean; all?: boolean }): string {
  const lines: string[] = [];
  const shown = rep.items.filter((i) => opts.all || i.action !== "bez zmian");
  for (const i of shown.slice(0, opts.all ? shown.length : 60)) {
    const what = i.title ? `[${i.type}] ${truncate(i.title, 70)}` : "";
    const why = i.reason && i.action !== "do archiwum" ? (what ? ` (${i.reason})` : i.reason) : "";
    const where = `${i.projectDir}/${basename(i.file)}`;
    lines.push(
      `  ${i.action.padEnd(11)} ${what}${why}${i.project ? `  · ${i.project}${i.via ? ` (${i.via})` : ""}` : ""}${i.prevId ? `  · #${i.prevId}` : ""}  [${where}]`,
    );
  }
  if (shown.length > 60 && !opts.all) lines.push(`  … i ${shown.length - 60} więcej (--all pokazuje wszystko)`);
  const head = opts.apply ? "zaimportowano" : "plan (nic nie zapisano; --apply zapisuje)";
  lines.push(
    `${head}: plików ${rep.files}, nowe ${rep.inserted}, zmienione ${rep.updated}, przywrócone ${rep.restored}, do archiwum ${rep.archived}, bez zmian ${rep.unchanged}, pominięte ${rep.skipped}`,
  );
  return lines.join("\n");
}
