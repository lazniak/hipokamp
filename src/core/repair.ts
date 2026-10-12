// Naprawa danych po imporcie claude-mem, backfillu i nadrabianiu w wersji 0.1 (`hipokamp repair [--dry-run]`):
//  a) notatki i podsumowania claude-mem pominięte przy kolizji numerów (#id zajęty przez notatkę z backfillu),
//  b) notatki tur, które opisał już claude-mem, numery tur w notatkach i promptach (własnych i claude-mem, razem
//     z numerami promptów w notatkach i podsumowaniach claude-mem), prompty-duplikaty,
//  c) redakcja sekretów obecnymi regułami we wszystkich danych: z claude-mem (stary import bez clean()) i własnych
//     zapisanych starszymi regułami (teksty, ścieżki, klucze encji, listy pracy),
//  d) tury bez notatki w przeczytanych zakresach transkryptów: zgubione przez parser 0.1 albo pominięte numerem
//     claude-mem, choć claude-mem ich nie opisał (logika w capture/recover.ts),
//  e) klucze plików względem katalogu repo projektu (absolutne ścieżki z importu claude-mem, prefiksy worktree),
//     z łączeniem encji (core/filekeys.ts),
//  raport i dziennik JSONL każdej zmiany.
// Idempotentna: drugie uruchomienie nic nie zmienia. Próba tylko czyta (baza może być otwarta tylko do odczytu),
// a d) w próbie widzi numerację promptów i scalenia z b) tak, jak zapisałby je przebieg właściwy.
// Narzędzie serwisowe: SQL wprost jak w importerach; zapisy dotykające indeksów FTS i wektorów idą przez Repo.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PAIR_TOLERANCE_MS, pairByTextAndTime, promptKey } from "../capture/match.ts";
import {
  emptyRecoverReport,
  harnessTranscriptIndex,
  type RecoverReport,
  type RecoverView,
  recoverTurns,
} from "../capture/recover.ts";
import { clean } from "../capture/redact.ts";
import { countsAsPrompt, groupTurns, readLinesFrom, type TurnKind } from "../capture/transcript.ts";
import { claudeDir } from "../config.ts";
import { getMeta } from "../db/db.ts";
import { PROMPT_CM_BASE, PROMPT_SUBST_BASE, type Repo, substitutePromptN } from "../db/repo.ts";
import {
  claudeMemDbPath,
  cmPlacement,
  openClaudeMemFor,
  redDeep,
  rekeyedIds,
  storeObservation,
  storeSummary,
} from "../importers/claude-mem.ts";
import { cosQ8 } from "../index/vectors.ts";
import { isStopword, normKey } from "../util/text.ts";
import { emptyFileKeysReport, type FileKeysReport, normalizeFileKeys } from "./filekeys.ts";

export interface RepairOptions {
  dryRun?: boolean;
  /** Baza claude-mem (tylko odczyt); domyślnie CLAUDE_MEM_DB albo ~/.claude-mem/claude-mem.db. */
  cmDbPath?: string;
  /** Dziennik zmian JSONL (zapisywany tylko bez dryRun). */
  logPath?: string | null;
  log?: (m: string) => void;
  /** Każda zmiana i decyzja bez zmiany (np. scalenie odrzucone progiem podobieństwa), także w próbie: diagnostyka. */
  onEvent?: (e: Record<string, unknown>) => void;
}

export interface RepairReport {
  dryRun: boolean;
  reimport: { observations: number; summaries: number; source: boolean };
  dups: {
    sessions: number;
    missingTranscript: number;
    notes: number;
    unmatched: number;
    merged: number;
    /** Tura opisana przez claude-mem, ale żadna jego notatka nie jest dość podobna: obie zostają aktywne. */
    notSimilar: number;
    promptN: number;
    unmatchedPrompts: number;
    deletedPrompts: number;
    /** Prompty komend lokalnych (/model, /compact) ze starej numeracji: ingest nie daje im już numeru. */
    unnumberedPrompts: number;
    /** Własne prompty przeniesione na numer swojej tury. */
    renumberedPrompts: number;
    /** Prompty claude-mem przeniesione na numer swojej tury albo do zakresu PROMPT_CM_BASE (bez tury w transkrypcie). */
    cmPrompts: number;
    /** Własne prompty bez tury, których numer był potrzebny innemu promptowi: do zakresu zastępczego. */
    substitutes: number;
    /** Notatki i podsumowania claude-mem z numerem promptu przeniesionym razem z ich promptem. */
    cmNotes: number;
    /** Notatki i podsumowania claude-mem bez promptu w bazie, których numer wypada na numer tury: do PROMPT_CM_BASE. */
    cmOrphans: number;
    /** Dwa prompty chciały ten sam numer (zabezpieczenie; drugi idzie do zakresu zastępczego). */
    renumberConflicts: number;
    promptCount: number;
    /** Sesje, które hook zmienił między planem a zapisem: zostają bez zmian (następny przebieg je poprawi). */
    changedDuring: number;
  };
  clean: { observations: number; summaries: number; prompts: number; sessions: number; entities: number; workState: number };
  /** d) tury bez notatki w przeczytanych zakresach, zob. capture/recover.ts. */
  recover: RecoverReport;
  /** e) klucze plików względem repo projektu, zob. core/filekeys.ts. */
  fileKeys: FileKeysReport;
  /** Pierwsze id z każdego rodzaju zmiany i decyzji (do podglądu w próbie). */
  sample: Record<string, (number | string)[]>;
  changes: number;
  logFile: string | null;
  ms: number;
}

const OWN_SOURCES = "('backfill','live','digest')";

/**
 * Najniższe podobieństwo, przy którym notatka hipokampa powtarza notatkę claude-mem tej samej tury: cosinus
 * wektorów (bge-m3, q8) albo, bez wektorów, część rdzeni słów notatki hipokampa obecna w notatce claude-mem.
 * Poniżej progu obie notatki zostają (tura bywa opisana przez claude-mem kilkudziesięcioma notatkami o czym innym).
 * Próg wektorów z prawdziwych danych: ta sama treść po polsku i angielsku ≈ 0,79, inna treść tej samej tury do 0,75.
 */
export const MERGE_MIN = { vec: 0.78, words: 0.5 };

interface TurnInfo {
  n: number;
  numbered: boolean;
  key: string;
  kind: TurnKind;
  prompt: string;
  startedAt: number;
  endedAt: number;
  from: number;
  to: number;
}

/** Tury pliku transkryptu z numerami jak w ingest. Czytane partiami; tura zaczyna się w dokładnie jednej partii. */
function transcriptTurns(path: string): TurnInfo[] {
  const sid = basename(path).replace(/\.jsonl$/i, "");
  const out: TurnInfo[] = [];
  let off = 0;
  let n = 0;
  for (;;) {
    const { lines, end, size } = readLinesFrom(path, off);
    // reszta tury z poprzedniej partii wraca jako ciąg dalszy bez numeru, więc numeracja przez partie się zgadza
    for (const t of groupTurns(lines, sid, { final: true }).turns) {
      const num = countsAsPrompt(t);
      if (num) n++;
      out.push({
        n,
        numbered: num,
        key: t.key,
        kind: t.kind,
        prompt: t.prompt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        from: t.from,
        to: t.to,
      });
    }
    if (end >= size || end <= off) break;
    off = end;
  }
  return out;
}

const red = (s: string | null): string | null => (s == null ? null : clean(s));

function jsonArr(s: unknown): string[] {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Treść notatki do porównania. */
interface NoteText {
  id: number;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string;
  concepts: string;
}

/**
 * Rdzenie słów notatki (prefiks jak w FTS, więc fleksja nie rozbija porównania), bez liczb i stop-słów. Z tekstu po
 * redakcji jak w c): drugie uruchomienie widzi już przeredagowaną notatkę i musi dojść do tej samej decyzji.
 */
function stems(o: NoteText): Set<string> {
  const out = new Set<string>();
  const text = [clean(o.title), red(o.subtitle) ?? "", red(o.narrative) ?? "", ...jsonArr(o.facts).map(clean)].join(" ");
  for (const w of normKey(text).split(" ")) {
    if (w.length < 4 || isStopword(w) || /^\d+$/.test(w)) continue;
    out.add(w.slice(0, 6));
  }
  return out;
}

/** Jaka część rdzeni `own` jest w `other`: krótka notatka claude-mem nie pokrywa długiego opisu tury. */
function coverage(own: Set<string>, other: Set<string>): number {
  if (!own.size) return 0;
  let i = 0;
  for (const w of own) if (other.has(w)) i++;
  return i / own.size;
}

/** Czy c) zmieni pola, z których liczony jest wektor (wtedy go skasuje): taki wektor nie bierze udziału w decyzji. */
function passageNeedsClean(o: NoteText): boolean {
  return (
    clean(o.title) !== o.title ||
    red(o.subtitle) !== o.subtitle ||
    red(o.narrative) !== o.narrative ||
    jsonArr(o.facts).some((f) => clean(f) !== f) ||
    jsonArr(o.concepts).some((c) => clean(c) !== c)
  );
}

interface Match {
  id: number;
  score: number;
  by: "vec" | "words";
}

/**
 * Najbardziej podobna notatka claude-mem: cosinus wektorów, gdy obie je mają, inaczej rdzenie słów. Przy różnych
 * miarach wygrywa największy zapas ponad próg swojej miary.
 */
function bestMatch(own: NoteText, cands: NoteText[], vecs: Map<number, Int8Array>): Match | null {
  const qa = vecs.get(own.id);
  const sa = stems(own);
  let best: Match | null = null;
  for (const c of cands) {
    const qb = vecs.get(c.id);
    const m: Match =
      qa && qb ? { id: c.id, score: cosQ8(qa, qb), by: "vec" } : { id: c.id, score: coverage(sa, stems(c)), by: "words" };
    if (!best || m.score - MERGE_MIN[m.by] > best.score - MERGE_MIN[best.by]) best = m;
  }
  return best;
}

export function repair(repo: Repo, opts: RepairOptions = {}): RepairReport {
  const t0 = performance.now();
  const db = repo.db;
  const dry = !!opts.dryRun;
  const say = opts.log ?? (() => {});
  const rep: RepairReport = {
    dryRun: dry,
    reimport: { observations: 0, summaries: 0, source: false },
    dups: {
      sessions: 0,
      missingTranscript: 0,
      notes: 0,
      unmatched: 0,
      merged: 0,
      notSimilar: 0,
      promptN: 0,
      unmatchedPrompts: 0,
      deletedPrompts: 0,
      unnumberedPrompts: 0,
      renumberedPrompts: 0,
      cmPrompts: 0,
      substitutes: 0,
      cmNotes: 0,
      cmOrphans: 0,
      renumberConflicts: 0,
      promptCount: 0,
      changedDuring: 0,
    },
    clean: { observations: 0, summaries: 0, prompts: 0, sessions: 0, entities: 0, workState: 0 },
    recover: emptyRecoverReport(),
    fileKeys: emptyFileKeysReport(),
    sample: {},
    changes: 0,
    logFile: null,
    ms: 0,
  };
  const sample = (e: Record<string, unknown>) => {
    const s = (rep.sample[String(e.op)] ??= []);
    if (s.length < 12) s.push((e.id ?? e.session ?? e.cm_id) as number | string);
  };
  // dziennik: wpisy zbierane w transakcji, dopisywane do pliku po jej zatwierdzeniu
  let pending: Record<string, unknown>[] = [];
  const emit = (e: Record<string, unknown>) => {
    rep.changes++;
    sample(e);
    pending.push({ at: Date.now(), ...e });
    opts.onEvent?.(e);
  };
  /** Decyzja bez zmiany w bazie: tylko próbka id i podgląd, nie dziennik. */
  const decide = (e: Record<string, unknown>) => {
    sample(e);
    opts.onEvent?.(e);
  };
  const flush = () => {
    if (!dry && opts.logPath && pending.length) {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      appendFileSync(opts.logPath, `${pending.map((e) => JSON.stringify(e)).join("\n")}\n`);
      rep.logFile = opts.logPath;
    }
    pending = [];
  };
  /** Zapis w transakcji IMMEDIATE (blokada zapisu od razu, bez SQLITE_BUSY w połowie); w próbie tylko liczenie. */
  const write = (fn: () => void) => {
    try {
      if (dry) fn();
      else db.transaction(fn).immediate();
    } catch (e) {
      // transakcja wycofana: jej wpisy nie trafiają do dziennika
      pending = [];
      throw e;
    }
    flush();
  };

  reimportMissing(repo, opts.cmDbPath ?? claudeMemDbPath(), dry, rep, emit, write, say);
  // próba nic nie zapisuje, więc d) dostaje stan promptów i scaleń, jaki zostawiłoby b)
  const view: RecoverView = { prompts: new Map(), merged: new Set() };
  fixClaudeMemDuplicates(repo, dry, rep, emit, decide, write, say, view);
  cleanImported(db, repo, dry, rep, emit, write);
  // d) zapis jednej sesji w jednej transakcji
  rep.recover = recoverTurns(repo, { dryRun: dry, emit, write, view: dry ? view : undefined });
  rep.fileKeys = normalizeFileKeys(repo, { dryRun: dry, emit, write });

  rep.ms = Math.round(performance.now() - t0);
  return rep;
}

type Emit = (e: Record<string, unknown>) => void;
type Write = (fn: () => void) => void;

/** a) Notatki i podsumowania claude-mem, których nie ma w hipokampie (pominięte przy kolizji numerów). */
function reimportMissing(
  repo: Repo,
  cmPath: string,
  dry: boolean,
  rep: RepairReport,
  emit: Emit,
  write: Write,
  say: (m: string) => void,
) {
  const db = repo.db;
  if (!existsSync(cmPath)) {
    say(`a) brak bazy claude-mem (${cmPath}): ponowny import pominięty`);
    return;
  }
  rep.reimport.source = true;
  // numery promptów claude-mem przez sessions.meta.cm_n (przenumerowanie z b) poprzedniego przebiegu), klucze plików
  // względem repo projektu
  const src = openClaudeMemFor(repo, cmPath);
  try {
    for (const [table, cmTable, cursorKey] of [
      ["observations", "observations", "cm_last_obs_id"],
      ["summaries", "session_summaries", "cm_last_summary_id"],
    ] as const) {
      // tylko poniżej kursora: wyższe numery to zwykły następny import, nie skutek kolizji
      const cursor = Number(getMeta(db, cursorKey) ?? 0);
      if (!cursor) continue;
      const rekeyed = rekeyedIds(db, table);
      const cols =
        table === "observations" ? "id, created_at, created_at_epoch, content_hash" : "id, created_at, created_at_epoch";
      const missing = (src.db.query(`SELECT ${cols} FROM ${cmTable} WHERE id <= ? ORDER BY id`).all(cursor) as any[])
        .filter((r) => cmPlacement(db, table, r, rekeyed) !== "known")
        .map((r) => r.id as number);
      rep.reimport[table] = missing.length;
      if (!missing.length) continue;
      if (dry) {
        // próba ich nie wstawia (baza tylko do odczytu), więc b) ich nie widzi: raport mówi to wprost
        for (const id of missing) emit({ op: "reimport", table, cm_id: id });
        continue;
      }
      write(() => {
        for (let i = 0; i < missing.length; i += 500) {
          const chunk = missing.slice(i, i + 500);
          const rows = src.db
            .query(`SELECT * FROM ${cmTable} WHERE id IN (${chunk.map(() => "?").join(",")})`)
            .all(...chunk) as any[];
          for (const r of rows) {
            const s = table === "observations" ? storeObservation(repo, r, src, rekeyed) : storeSummary(repo, r, src, rekeyed);
            if (s.outcome !== "known") emit({ op: "reimport", table, cm_id: r.id, id: s.id, rekeyed: s.outcome === "rekeyed" });
          }
        }
      });
    }
  } finally {
    src.close();
  }
}

/** Katalogi projektów Claude Code (do szukania kopii transkryptu sesji po nazwie pliku); odświeżane w każdej naprawie. */
let projectDirs: string[] | null = null;
/** Pliki sesji Codexa i innych harnessów po kluczu sesji; odświeżane w każdej naprawie. */
let harnessFiles: Map<string, string> | null = null;
function findTranscripts(sessionId: string): string[] {
  harnessFiles ??= harnessTranscriptIndex();
  const h = harnessFiles.get(sessionId);
  // sesja innego harnessu (desktop:, gemini:…) nie ma kopii w katalogach Claude Code (a dwukropek w nazwie na
  // Windows to strumień alternatywny NTFS, nie plik)
  if (sessionId.includes(":")) return h ? [h] : [];
  if (!projectDirs) {
    const root = join(claudeDir(), "projects");
    try {
      projectDirs = readdirSync(root).map((d) => join(root, d));
    } catch {
      projectDirs = [];
    }
  }
  const out = projectDirs.map((d) => join(d, `${sessionId}.jsonl`)).filter((f) => existsSync(f));
  return h ? [...out, h] : out;
}

const fileSize = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

/**
 * Plik sesji (numery promptów i licznik): ze wszystkich kopii transkryptu (wznowienie w innym katalogu zostawia
 * starszą, krótszą kopię) najdłuższa, przy równej długości ta z transcript_path. coversOffset: sięga do offsetu,
 * do którego ingest przeczytał sesję (tylko wtedy licznik z niej jest wiarygodny).
 */
function sessionFile(
  s: { id: string; transcript_path: string | null; transcript_offset: number },
  refPaths: Iterable<string>,
): { path: string; coversOffset: boolean } | null {
  const name = `${s.id}.jsonl`.toLowerCase();
  const paths = new Set<string>();
  if (s.transcript_path) paths.add(s.transcript_path);
  for (const p of refPaths) if (basename(p).toLowerCase() === name) paths.add(p);
  for (const p of findTranscripts(s.id)) paths.add(p);
  const cands = [...paths].map((p) => ({ p, size: fileSize(p) })).filter((c) => c.size >= 0);
  if (!cands.length) return null;
  cands.sort((a, b) => b.size - a.size || Number(b.p === s.transcript_path) - Number(a.p === s.transcript_path));
  return { path: cands[0].p, coversOffset: cands[0].size >= s.transcript_offset };
}

interface PromptRow {
  id: number;
  n: number;
  text: string;
  created_at: number;
}

interface PromptPlan {
  /** Własne prompty do usunięcia: duplikat promptu claude-mem (cm) albo komenda lokalna bez numeru. */
  deletes: { p: PromptRow; t: TurnInfo; cm?: PromptRow }[];
  /** Zmiany numerów (własne i claude-mem). */
  moves: { p: PromptRow; to: number; kind: "own" | "subst" | "cm" }[];
  /** Numer docelowy każdego promptu, który zostaje (id → n). */
  final: Map<number, number>;
  /** Numery tur z numerem w pliku sesji. */
  reserved: Set<number>;
  conflicts: number;
  unmatched: number;
}

/**
 * Numeracja promptów sesji po naprawie. Poniżej PROMPT_SUBST_BASE tylko numery tur pliku sesji: własny prompt tury
 * (bez pary z promptem claude-mem) i prompt claude-mem sparowany z turą (tekst i czas) dostają numer tury. Prompt
 * claude-mem bez tury w zakresie czasu pliku (pobudka pętli, wiadomość innej sesji) i sparowany z turą bez numeru idzie
 * do PROMPT_CM_BASE + numer w claude-mem. Pozostałe zostają, chyba że ich numer jest potrzebny innemu promptowi
 * (prompt claude-mem także, gdy stoi na numerze tury): własny do zakresu zastępczego, claude-mem do PROMPT_CM_BASE.
 * Numer claude-mem (origOf) bierze się z sessions.meta.cm_n, więc drugi przebieg liczy te same numery.
 */
function planPrompts(a: {
  own: PromptRow[];
  cm: PromptRow[];
  fileTurns: TurnInfo[] | null;
  promptTurn: Map<PromptRow, TurnInfo>;
  turnToCm: Map<string, PromptRow>;
  origOf: (c: PromptRow) => number;
}): PromptPlan {
  const plan: PromptPlan = { deletes: [], moves: [], final: new Map(), reserved: new Set(), conflicts: 0, unmatched: 0 };
  const inFile = new Map<string, TurnInfo>();
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const t of a.fileTurns ?? []) {
    if (t.numbered) plan.reserved.add(t.n);
    if (!inFile.has(t.key)) inFile.set(t.key, t);
    if (t.startedAt) {
      first = Math.min(first, t.startedAt);
      last = Math.max(last, t.endedAt || t.startedAt);
    }
  }
  type Kind = "own" | "cm";
  const want: [PromptRow, number, Kind][] = [];
  const loose: [PromptRow, Kind][] = [];
  for (const p of a.own) {
    const t = a.promptTurn.get(p);
    if (!t) {
      plan.unmatched++;
      loose.push([p, "own"]);
      continue;
    }
    const cm = a.turnToCm.get(t.key);
    if (cm) plan.deletes.push({ p, t, cm });
    else if (!t.numbered) plan.deletes.push({ p, t });
    else want.push([p, t.n, "own"]);
  }
  const cmKey = new Map<PromptRow, string>();
  for (const [k, c] of a.turnToCm) cmKey.set(c, k);
  for (const c of a.cm) {
    const key = cmKey.get(c);
    const t = key !== undefined ? inFile.get(key) : undefined;
    if (!a.fileTurns) loose.push([c, "cm"]);
    else if (t) want.push([c, t.numbered ? t.n : PROMPT_CM_BASE + a.origOf(c), "cm"]);
    else if (key === undefined && c.created_at >= first - PAIR_TOLERANCE_MS && c.created_at <= last + PAIR_TOLERANCE_MS)
      want.push([c, PROMPT_CM_BASE + a.origOf(c), "cm"]);
    // sparowany z turą innej kopii transkryptu albo spoza zakresu czasu pliku: plik sesji o nim nic nie mówi
    else loose.push([c, "cm"]);
  }

  const used = new Set<number>();
  const kinds = new Map<number, Kind>();
  want.sort((x, y) => x[1] - y[1] || x[0].id - y[0].id);
  for (const [p, n, kind] of want) {
    kinds.set(p.id, kind);
    if (used.has(n)) {
      plan.conflicts++;
      loose.push([p, kind]);
      continue;
    }
    plan.final.set(p.id, n);
    used.add(n);
  }
  loose.sort((x, y) => x[0].n - y[0].n || x[0].id - y[0].id);
  const displaced: [PromptRow, Kind][] = [];
  for (const [p, kind] of loose) {
    kinds.set(p.id, kind);
    // własny prompt bez pary (np. z hooka, z innym zapisem tekstu) może stać na numerze swojej tury: zostaje, dopóki
    // numeru nie chce inny prompt; prompt claude-mem na numerze tury zawsze ustępuje (ingest dopisze tam prompt tury)
    if (used.has(p.n) || (kind === "cm" && p.n < PROMPT_SUBST_BASE && plan.reserved.has(p.n))) displaced.push([p, kind]);
    else {
      plan.final.set(p.id, p.n);
      used.add(p.n);
    }
  }
  for (const [p, kind] of displaced) {
    let n = kind === "own" ? substitutePromptN(p.n, used) : PROMPT_CM_BASE + a.origOf(p);
    if (used.has(n)) n = Math.max(PROMPT_CM_BASE, ...[...used].filter((x) => x >= PROMPT_CM_BASE)) + 1;
    plan.final.set(p.id, n);
    used.add(n);
  }
  for (const p of [...a.own, ...a.cm]) {
    const to = plan.final.get(p.id);
    if (to === undefined || to === p.n) continue;
    const kind = kinds.get(p.id) === "cm" ? "cm" : to < PROMPT_SUBST_BASE ? "own" : "subst";
    plan.moves.push({ p, to, kind });
  }
  return plan;
}

/**
 * b) Sesje przeczytane przez hipokamp (offset) albo z własnymi notatkami lub promptami (backfill, nadrabianie, hooki),
 * także bez danych z claude-mem: numeracja 0.1 myliła się i tam. Wszystkie od razu, a nie tylko z własnymi danymi:
 * d) dopisuje notatki do kolejnych sesji, więc drugi przebieg miałby inny zbiór sesji (brak idempotencji).
 * Duplikat pokrycia claude-mem: tura notatki to ten sam prompt co prompt claude-mem tej sesji (tekst i czas), a jedna
 * z aktywnych notatek claude-mem tego promptu mówi to samo (podobieństwo co najmniej MERGE_MIN) → merged z odsyłaczem
 * do najbardziej podobnej. Bez podobnej notatki (albo bez żadnej, np. obserwator na wyczerpanym limicie) obie zostają.
 * Numery tur liczone od nowa z transkryptu jak w ingest (we wszystkich notatkach, także scalonych); prompty-duplikaty
 * promptów claude-mem i prompty komend lokalnych ze starej numeracji są usuwane, pozostałe dostają numer swojej tury
 * (planPrompts), także prompty claude-mem: ich notatki i podsumowania idą za promptem, a sessions.meta.cm_n zapamiętuje
 * numer claude-mem → numer po naprawie (import po naprawie zapisuje pod nowym numerem, a prompt już obecny pomija).
 * Licznik promptów sesji i sessions.meta.n (od niego liczy ingest) zgadzają się z transkryptem.
 */
function fixClaudeMemDuplicates(
  repo: Repo,
  dry: boolean,
  rep: RepairReport,
  emit: Emit,
  decide: Emit,
  write: Write,
  say: (m: string) => void,
  view: RecoverView,
) {
  const db = repo.db;
  projectDirs = null;
  harnessFiles = null;
  const sessions = db
    .query(
      `SELECT s.id, s.transcript_path, s.transcript_offset, s.prompt_count,
         CASE WHEN json_valid(s.meta) THEN json_extract(s.meta, '$.n') END AS meta_n FROM sessions s
       WHERE s.transcript_offset > 0
         OR EXISTS (SELECT 1 FROM observations o WHERE o.session_id = s.id AND o.source IN ${OWN_SOURCES})
         OR EXISTS (SELECT 1 FROM prompts p WHERE p.session_id = s.id AND p.source != 'claude-mem')
       ORDER BY s.started_at, s.id`,
    )
    .all() as {
    id: string;
    transcript_path: string | null;
    transcript_offset: number;
    prompt_count: number;
    meta_n: number | null;
  }[];
  const turnCache = new Map<string, { list: TurnInfo[]; byKey: Map<string, TurnInfo[]> }>();
  const turnsOf = (path: string) => {
    let t = turnCache.get(path);
    if (!t) {
      const list = transcriptTurns(path);
      const byKey = new Map<string, TurnInfo[]>();
      for (const x of list) {
        const a = byKey.get(x.key);
        if (a) a.push(x);
        else byKey.set(x.key, [x]);
      }
      t = { list, byKey };
      turnCache.set(path, t);
    }
    return t;
  };
  /**
   * Tura notatki: po kluczu, a bez niego (ciąg dalszy, klucz z linii w środku tury) ta, w której zakresie leży.
   * Ten sam klucz bywa w pliku dwa razy (linia historii powtórzona w dalszej części transkryptu, inny numer tury):
   * wtedy wystąpienie, w którego zakresie zaczyna się notatka, a nie ostatnie.
   */
  const turnOf = (ref: { path: string; from: number }, key: string | null): TurnInfo | undefined => {
    const t = turnsOf(ref.path);
    const ks = key ? t.byKey.get(key) : undefined;
    if (ks?.length === 1) return ks[0];
    if (ks?.length) return ks.find((x) => ref.from >= x.from && ref.from < x.to) ?? ks[0];
    let lo = 0;
    let hi = t.list.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.list[mid].from <= ref.from) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const c = at >= 0 ? t.list[at] : undefined;
    return c && ref.from < c.to ? c : undefined;
  };

  const cmMaps = repo.cmPromptMaps();
  const promptRows = db.query("SELECT id, n, text, created_at, source FROM prompts WHERE session_id = ? ORDER BY n");
  for (const s of sessions) {
    const notes = db
      .query(
        `SELECT id, prompt_n, turn_key, transcript_ref, status, title, subtitle, narrative, facts, concepts FROM observations
         WHERE session_id = ? AND source IN ${OWN_SOURCES} ORDER BY id`,
      )
      .all(s.id) as (NoteText & {
      prompt_n: number | null;
      turn_key: string | null;
      transcript_ref: string | null;
      status: string;
    })[];
    const allPrompts = promptRows.all(s.id) as (PromptRow & { source: string })[];
    const own: PromptRow[] = allPrompts.filter((p) => p.source !== "claude-mem");
    const cmPrompts: PromptRow[] = allPrompts.filter((p) => p.source === "claude-mem");
    // pliki: transkrypty notatek (notatka z kopii historii w innym pliku ma numerację tamtego pliku) i plik sesji
    const refOf = new Map<number, { path: string; from: number }>();
    for (const o of notes) {
      try {
        const r = JSON.parse(o.transcript_ref ?? "null");
        if (typeof r?.path === "string") refOf.set(o.id, { path: r.path, from: Number(r.from) || 0 });
      } catch {}
    }
    const file = sessionFile(
      s,
      [...refOf.values()].map((r) => r.path),
    );
    // plik sesji zawsze, gdy jest (numeracja promptów claude-mem także w sesji bez własnych promptów); bez niego własne
    // prompty nie mają numerów tur, więc sesja czeka
    const needed = new Set<string>();
    if (file) needed.add(file.path);
    else if (own.length) needed.add("");
    for (const r of refOf.values()) needed.add(r.path);
    if ([...needed].some((p) => !p || !existsSync(p))) {
      rep.dups.missingTranscript++;
      continue;
    }
    rep.dups.sessions++;

    // aktywne notatki claude-mem według numeru promptu (kandydaci na cel scalenia)
    const cmNotes = new Map<number, NoteText[]>();
    for (const r of db
      .query(
        `SELECT id, prompt_n, title, subtitle, narrative, facts, concepts FROM observations
         WHERE session_id = ? AND source = 'claude-mem' AND status = 'active' AND prompt_n IS NOT NULL ORDER BY created_at, id`,
      )
      .all(s.id) as (NoteText & { prompt_n: number })[]) {
      const a = cmNotes.get(r.prompt_n);
      if (a) a.push(r);
      else cmNotes.set(r.prompt_n, [r]);
    }

    // tury wszystkich plików sesji ↔ prompty claude-mem. Parowanie na danych, których naprawa nie zmienia
    // (transkrypt i prompty claude-mem), więc drugie uruchomienie dobiera te same pary (idempotencja).
    const allTurns = new Map<string, TurnInfo>();
    for (const f of needed) for (const t of turnsOf(f).list) if (!allTurns.has(t.key)) allTurns.set(t.key, t);
    const turnToCm = pairByTextAndTime(
      [...allTurns.values()].map((t) => ({ item: t.key, key: promptKey(t.prompt), at: t.startedAt })),
      cmPrompts.map((p) => ({ item: p, key: promptKey(p.text), at: p.created_at })),
    );
    const noteTurns = new Map<number, TurnInfo>();
    for (const o of notes) {
      const ref = refOf.get(o.id);
      const t = ref ? turnOf(ref, o.turn_key) : undefined;
      if (t) noteTurns.set(o.id, t);
    }
    // wektory do porównania treści; wektor notatki, którą c) przeredaguje (i skasuje jej wektor), pomijamy: inaczej
    // drugie uruchomienie (już bez niego) mogłoby zdecydować inaczej
    const vecs = repo.getVectorsQ8([...notes.map((o) => o.id), ...[...cmNotes.values()].flat().map((c) => c.id)]);
    for (const c of [...notes, ...[...cmNotes.values()].flat()]) if (passageNeedsClean(c)) vecs.delete(c.id);
    // prompt z transkryptu ma czas i tekst swojej tury, więc para prompt ↔ tura jest dokładna (także tury bez numeru:
    // komendy lokalne, które wersja 0.1 numerowała i zapisywała jako prompty)
    const promptTurn = pairByTextAndTime(
      own.map((p) => ({ item: p, key: promptKey(p.text), at: p.created_at })),
      (file && own.length ? turnsOf(file.path).list.filter((t) => t.kind !== "task") : []).map((t) => ({
        item: t,
        key: promptKey(t.prompt),
        at: t.startedAt,
      })),
    );

    // plan numeracji promptów, w próbie i w przebiegu właściwym ten sam
    const cmMap = cmMaps.get(s.id) ?? new Map<number, number>();
    const cmInverse = new Map<number, number>();
    for (const [k, v] of cmMap) if (!cmInverse.has(v)) cmInverse.set(v, k);
    const origOf = (c: PromptRow) => cmInverse.get(c.n) ?? (c.n >= PROMPT_CM_BASE ? c.n - PROMPT_CM_BASE : c.n);
    const plan = planPrompts({
      own,
      cm: cmPrompts,
      fileTurns: file ? turnsOf(file.path).list : null,
      promptTurn,
      turnToCm,
      origOf,
    });
    rep.dups.unmatchedPrompts += plan.unmatched;
    rep.dups.renumberConflicts += plan.conflicts;
    // notatki i podsumowania claude-mem idą za swoim promptem (claudeMemDescribed łączy je numerem promptu)
    const cmMoved = new Map<number, number>();
    for (const m of plan.moves) if (m.kind === "cm") cmMoved.set(m.p.n, m.to);
    const cmRefs = [
      ...(
        db
          .query("SELECT id, prompt_n FROM observations WHERE session_id = ? AND source = 'claude-mem' AND prompt_n IS NOT NULL")
          .all(s.id) as { id: number; prompt_n: number }[]
      ).map((r) => ({ table: "observations" as const, ...r })),
      ...(
        db
          .query("SELECT id, prompt_n FROM summaries WHERE session_id = ? AND source = 'claude-mem' AND prompt_n IS NOT NULL")
          .all(s.id) as { id: number; prompt_n: number }[]
      ).map((r) => ({ table: "summaries" as const, ...r })),
    ];
    // notatka claude-mem bez promptu w bazie (prompt pominięty przy imporcie albo nigdy niezapisany) na numerze tury
    // albo numerze, który dostaje inny prompt: inaczej wyglądałaby na notatkę tamtego promptu
    const cmAt = new Set(cmPrompts.map((c) => c.n));
    const finals = new Set(plan.final.values());
    const cmRefMoves: { table: "observations" | "summaries"; id: number; from: number; to: number; orphan: boolean }[] = [];
    const orphanMap = new Map<number, number>();
    for (const r of cmRefs) {
      const moved = cmMoved.get(r.prompt_n);
      if (moved !== undefined) cmRefMoves.push({ table: r.table, id: r.id, from: r.prompt_n, to: moved, orphan: false });
      else if (
        !cmAt.has(r.prompt_n) &&
        r.prompt_n < PROMPT_SUBST_BASE &&
        (plan.reserved.has(r.prompt_n) || finals.has(r.prompt_n))
      ) {
        cmRefMoves.push({ table: r.table, id: r.id, from: r.prompt_n, to: PROMPT_CM_BASE + r.prompt_n, orphan: true });
        orphanMap.set(r.prompt_n, PROMPT_CM_BASE + r.prompt_n);
      }
    }
    // numer claude-mem → numer po naprawie (import po naprawie), bez wpisów tożsamościowych
    const nextMap = new Map(cmMap);
    for (const c of cmPrompts) {
      const to = plan.final.get(c.id) ?? c.n;
      if (to === origOf(c)) nextMap.delete(origOf(c));
      else nextMap.set(origOf(c), to);
    }
    for (const [k, v] of orphanMap) nextMap.set(k, v);
    const mapKey = (m: Map<number, number>) => JSON.stringify([...m].sort((a, b) => a[0] - b[0]));
    const mapChanged = mapKey(nextMap) !== mapKey(cmMap);
    const deleted = new Set(plan.deletes.map((d) => d.p.id));
    // w próbie d) widzi prompty sesji po b)
    if (dry && (plan.deletes.length || plan.moves.length))
      view.prompts?.set(
        s.id,
        allPrompts
          .filter((p) => !deleted.has(p.id))
          .map((p) => ({ n: plan.final.get(p.id) ?? p.n, text: p.text, created_at: p.created_at })),
      );
    const promptState = JSON.stringify(allPrompts.map((p) => [p.id, p.n]));

    const state = db.query(
      "SELECT transcript_offset, prompt_count, CASE WHEN json_valid(meta) THEN json_extract(meta, '$.n') END AS meta_n FROM sessions WHERE id = ?",
    );
    write(() => {
      // hooki piszą bez workera: tura dopisana między planem a zapisem zmienia offset i licznik w tej samej transakcji
      // co swój prompt i notatkę. Plan z dawnego stanu przenumerowałby jej prompt albo cofnął licznik, więc sesja
      // czeka na następny przebieg (sprawdzenie pod blokadą zapisu, więc nic nie wejdzie już przed zapisem)
      const now = state.get(s.id) as { transcript_offset: number; prompt_count: number; meta_n: number | null } | null;
      if (
        !now ||
        now.transcript_offset !== s.transcript_offset ||
        now.prompt_count !== s.prompt_count ||
        (now.meta_n ?? null) !== (s.meta_n ?? null) ||
        JSON.stringify((promptRows.all(s.id) as PromptRow[]).map((p) => [p.id, p.n])) !== promptState
      ) {
        rep.dups.changedDuring++;
        decide({ op: "session-changed", session: s.id });
        return;
      }
      for (const o of notes) {
        rep.dups.notes++;
        const t = noteTurns.get(o.id);
        if (!t) {
          rep.dups.unmatched++;
          continue;
        }
        const cm = turnToCm.get(t.key);
        const cands = cm ? (cmNotes.get(cm.n) ?? []) : [];
        if (o.status === "active" && cands.length) {
          const m = bestMatch(o, cands, vecs);
          const score = m ? Math.round(m.score * 1000) / 1000 : null;
          if (m && m.score >= MERGE_MIN[m.by]) {
            if (!dry) repo.mergeDuplicateInto(o.id, m.id, { repair: "cm-dup", true_n: t.n, similarity: score, by: m.by });
            else view.merged?.add(o.id);
            rep.dups.merged++;
            emit({ op: "cm-dup", id: o.id, into: m.id, session: s.id, true_n: t.n, cm_n: cm?.n, score, by: m.by });
          } else {
            rep.dups.notSimilar++;
            decide({ op: "cm-dup-kept", id: o.id, best: m?.id ?? null, session: s.id, cm_n: cm?.n, score, by: m?.by ?? null });
          }
        }
        // prawdziwy numer tury także w notatce scalonej (inaczej drugie uruchomienie poprawiałoby ją osobno)
        if (o.prompt_n !== t.n) {
          if (!dry) repo.setObservationPromptN(o.id, t.n);
          rep.dups.promptN++;
          emit({ op: "prompt-n", id: o.id, session: s.id, from: o.prompt_n, to: t.n });
        }
      }
      for (const { p, t, cm } of plan.deletes) {
        if (!dry) repo.deletePrompt(p.id);
        if (cm) {
          // ta sama wypowiedź jest już promptem z claude-mem (tekst zostaje tam)
          rep.dups.deletedPrompts++;
          emit({ op: "delete-prompt", id: p.id, session: s.id, n: p.n, true_n: t.n, cm_n: cm.n });
        } else {
          // komenda lokalna (/model, /compact) ze starej numeracji: ingest nie daje jej już numeru ani wiersza
          rep.dups.unnumberedPrompts++;
          emit({ op: "delete-prompt-unnumbered", id: p.id, session: s.id, n: p.n });
        }
      }
      // dwa etapy (najpierw numery ujemne, potem docelowe): zamiana numerów między promptami bez kolizji UNIQUE
      if (!dry) {
        for (const m of plan.moves) repo.renumberPrompt(m.p.id, -m.p.id);
        for (const m of plan.moves)
          if (!repo.renumberPrompt(m.p.id, m.to)) throw new Error(`repair: numer ${m.to} w sesji ${s.id} zajęty`);
      }
      for (const m of plan.moves) {
        if (m.kind === "own") rep.dups.renumberedPrompts++;
        else if (m.kind === "subst") rep.dups.substitutes++;
        else rep.dups.cmPrompts++;
        const op = m.kind === "own" ? "renumber-prompt" : m.kind === "subst" ? "substitute-prompt" : "renumber-cm-prompt";
        emit({ op, id: m.p.id, session: s.id, from: m.p.n, to: m.to });
      }
      for (const r of cmRefMoves) {
        if (!dry) {
          if (r.table === "observations") repo.setObservationPromptN(r.id, r.to);
          else repo.setSummaryPromptN(r.id, r.to);
        }
        if (r.orphan) rep.dups.cmOrphans++;
        else rep.dups.cmNotes++;
        emit({ op: r.orphan ? "cm-orphan" : "cm-prompt-n", table: r.table, id: r.id, session: s.id, from: r.from, to: r.to });
      }
      if (mapChanged) {
        if (!dry) repo.setSessionCmMap(s.id, nextMap);
        emit({ op: "cm-map", session: s.id, size: nextMap.size });
      }
      // ingest liczy kolejne tury od sessions.meta.n (bez niego od prompt_count): numer ostatniej tury przed offsetem,
      // do którego przeczytał sesję. Tylko z pliku, który do tego offsetu sięga.
      if (file?.coversOffset && s.transcript_offset > 0) {
        let count = 0;
        for (const t of turnsOf(file.path).list) {
          if (t.from >= s.transcript_offset) break;
          count = t.n;
        }
        if ((s.meta_n ?? s.prompt_count) !== count) {
          if (!dry) repo.setSessionPromptCount(s.id, count);
          rep.dups.promptCount++;
          emit({ op: "prompt-count", session: s.id, from: s.prompt_count, meta_n: s.meta_n, to: count });
        }
      }
    });
  }
  if (rep.dups.missingTranscript) say(`b) sesje bez transkryptu (pominięte): ${rep.dups.missingTranscript}`);
}

/**
 * c) Redakcja sekretów obecnymi regułami we wszystkich danych: z claude-mem (stary import kopiował teksty bez clean())
 * i własnych, zapisanych starszymi regułami (np. przed regułą „adres / hasło”). Teksty, ścieżki plików, pojęcia,
 * napisy w `observations.meta`, listy pracy, klucze encji grafu. FTS od nowa, wektor notatki ze zmienionym tekstem kasowany. Redakcja jest
 * idempotentna, więc drugi przebieg nic nie zmienia.
 */
function cleanImported(db: Database, repo: Repo, dry: boolean, rep: RepairReport, emit: Emit, write: Write) {
  // partiami po kluczu głównym (krótkie transakcje: hooki piszą w tym czasie)
  const pass = <R extends { id: number | string }>(select: string, start: number | string, fix: (r: R) => void) => {
    let last = start;
    for (;;) {
      const rows = db.query(select).all(last, 1000) as R[];
      if (!rows.length) break;
      write(() => {
        for (const r of rows) fix(r);
      });
      last = rows[rows.length - 1].id;
    }
  };
  const cleanList = (s: string): { list: string[]; changed: boolean } => {
    const raw = jsonArr(s);
    const list = raw.map(clean);
    return { list, changed: list.some((x, i) => x !== raw[i]) };
  };

  pass<{
    id: number;
    title: string;
    subtitle: string | null;
    narrative: string | null;
    facts: string;
    concepts: string;
    files_read: string;
    files_modified: string;
    text: string | null;
    meta: string | null;
  }>(
    "SELECT id, title, subtitle, narrative, facts, concepts, files_read, files_modified, text, meta FROM observations WHERE id > ? ORDER BY id LIMIT ?",
    -1,
    (r) => {
      const patch: {
        title?: string;
        subtitle?: string | null;
        narrative?: string | null;
        text?: string | null;
        facts?: string[];
        concepts?: string[];
        files_read?: string[];
        files_modified?: string[];
      } = {};
      if (clean(r.title) !== r.title) patch.title = clean(r.title);
      for (const k of ["subtitle", "narrative", "text"] as const) if (red(r[k]) !== r[k]) patch[k] = red(r[k]);
      for (const k of ["facts", "concepts", "files_read", "files_modified"] as const) {
        const c = cleanList(r[k]);
        if (c.changed) patch[k] = c.list;
      }
      // meta: każdy napis w środku (powód zapomnienia, wyniki LLM, ścieżki z importu, klucz tematu); klucze JSON-a
      // ustala kod. Zepsuty JSON zostaje bez zmian (nie ma czego bezpiecznie przepisać).
      let meta: Record<string, unknown> | null = null;
      if (r.meta) {
        try {
          const cur = JSON.parse(r.meta);
          const next = redDeep(cur);
          if (cur && typeof cur === "object" && JSON.stringify(next) !== JSON.stringify(cur))
            meta = next as Record<string, unknown>;
        } catch {}
      }
      const fields = [...Object.keys(patch), ...(meta ? ["meta"] : [])];
      if (!fields.length) return;
      if (!dry) {
        if (Object.keys(patch).length) repo.updateObservationContent(r.id, patch);
        // meta przeczytane przed zapisem: podmiana tylko, gdy w bazie jest dalej ta sama wartość (worker albo
        // `remember` mogły ją zmienić między odczytem strony a zapisem); inaczej następny repair
        if (meta && !repo.setObservationMeta(r.id, meta, r.meta)) {
          fields.pop();
          if (!fields.length) return;
        }
      }
      rep.clean.observations++;
      emit({ op: "clean", table: "observations", id: r.id, fields });
    },
  );

  const SUM = ["request", "investigated", "learned", "completed", "next_steps", "notes"] as const;
  pass<{ id: number; files_read: string; files_edited: string } & Record<(typeof SUM)[number], string | null>>(
    `SELECT id, ${SUM.join(", ")}, files_read, files_edited FROM summaries WHERE id > ? ORDER BY id LIMIT ?`,
    -1,
    (r) => {
      const patch: Partial<Record<(typeof SUM)[number], string | null>> & { files_read?: string[]; files_edited?: string[] } = {};
      for (const k of SUM) if (red(r[k]) !== r[k]) patch[k] = red(r[k]);
      for (const k of ["files_read", "files_edited"] as const) {
        const c = cleanList(r[k]);
        if (c.changed) patch[k] = c.list;
      }
      const fields = Object.keys(patch);
      if (!fields.length) return;
      if (!dry) repo.updateSummaryText(r.id, patch);
      rep.clean.summaries++;
      emit({ op: "clean", table: "summaries", id: r.id, fields });
    },
  );

  pass<{ id: number; text: string }>("SELECT id, text FROM prompts WHERE id > ? ORDER BY id LIMIT ?", -1, (r) => {
    const text = clean(r.text);
    if (text === r.text) return;
    if (!dry) repo.updatePromptText(r.id, text);
    rep.clean.prompts++;
    emit({ op: "clean", table: "prompts", id: r.id, fields: ["text"] });
  });

  pass<{ id: string; title: string | null; first_prompt: string | null }>(
    "SELECT id, title, first_prompt FROM sessions WHERE id > ? ORDER BY id LIMIT ?",
    "",
    (r) => {
      const fields = (["title", "first_prompt"] as const).filter((k) => red(r[k]) !== r[k]);
      if (!fields.length) return;
      if (!dry) repo.updateSessionText(r.id, Object.fromEntries(fields.map((k) => [k, red(r[k])])));
      rep.clean.sessions++;
      emit({ op: "clean", table: "sessions", session: r.id, fields });
    },
  );

  // klucze encji (ścieżki, adresy, pojęcia): także sprzed redakcji w imporcie; ten sam klucz po redakcji = scalenie
  pass<{ id: number; key: string }>("SELECT id, key FROM entities WHERE id > ? ORDER BY id LIMIT ?", -1, (r) => {
    const key = clean(r.key);
    if (key === r.key) return;
    if (!dry) repo.renameEntityKey(r.id, key);
    rep.clean.entities++;
    emit({ op: "clean", table: "entities", id: r.id, fields: ["key"] });
  });

  pass<{ id: number; fields: string }>("SELECT id, fields FROM work_state WHERE id > ? ORDER BY id LIMIT ?", -1, (r) => {
    let fields: unknown;
    try {
      fields = JSON.parse(r.fields);
    } catch {
      return;
    }
    const next = redDeep(fields);
    if (JSON.stringify(next) === JSON.stringify(fields)) return;
    if (!dry) repo.updateWorkStateFields(r.id, next as Record<string, unknown>);
    rep.clean.workState++;
    emit({ op: "clean", table: "work_state", id: r.id, fields: ["fields"] });
  });
}

/** Raport dla człowieka (CLI). */
export function formatRepairReport(r: RepairReport): string {
  const d = r.dups;
  const v = r.recover;
  const ids = (k: string) =>
    r.sample[k]?.length ? `  [${r.sample[k].join(", ")}${(r.sample[k].length ?? 0) >= 12 ? ", …" : ""}]` : "";
  return [
    `naprawa${r.dryRun ? " (próba: nic nie zapisano)" : ""}, ${Math.round(r.ms / 1000)} s`,
    `a) brakujące wpisy claude-mem (kolizje numerów): obserwacje ${r.reimport.observations}, podsumowania ${r.reimport.summaries}${r.reimport.source ? "" : " (brak bazy claude-mem)"}${ids("reimport")}`,
    `b) sesje przeczytane przez hipokamp albo z jego notatkami: ${d.sessions} sprawdzone, ${d.missingTranscript} bez transkryptu (pominięte)${d.changedDuring ? `, ${d.changedDuring} zmienione w trakcie (pominięte)` : ""}; notatki ${d.notes}, tura nieznaleziona ${d.unmatched}`,
    `   duplikaty tur opisanych przez claude-mem → merged: ${d.merged}${ids("cm-dup")}`,
    `   tura opisana przez claude-mem, ale treść inna (obie zostają): ${d.notSimilar}${ids("cm-dup-kept")}`,
    `   poprawione prompt_n notatek: ${d.promptN}${ids("prompt-n")}`,
    `   prompty-duplikaty promptów claude-mem do usunięcia: ${d.deletedPrompts}${ids("delete-prompt")} (prompty bez tury w transkrypcie: ${d.unmatchedPrompts})`,
    `   prompty komend lokalnych ze starej numeracji (bez numeru w ingest) do usunięcia: ${d.unnumberedPrompts}${ids("delete-prompt-unnumbered")}`,
    `   przenumerowane prompty: ${d.renumberedPrompts}${ids("renumber-prompt")}, licznik promptów sesji: ${d.promptCount}`,
    `   prompty claude-mem na numerze swojej tury albo w zakresie ${PROMPT_CM_BASE}+ (bez tury): ${d.cmPrompts}${ids("renumber-cm-prompt")}; notatki i podsumowania claude-mem za promptem: ${d.cmNotes}, bez promptu (do zakresu ${PROMPT_CM_BASE}+): ${d.cmOrphans}`,
    `   prompty bez tury, których numer był potrzebny innemu: do zakresu zastępczego ${PROMPT_SUBST_BASE}+: ${d.substitutes}${ids("substitute-prompt")}${d.renumberConflicts ? `; kolizje numerów docelowych: ${d.renumberConflicts}` : ""}`,
    `c) redakcja sekretów obecnymi regułami (dane z claude-mem i własne): notatki ${r.clean.observations}, podsumowania ${r.clean.summaries}, prompty ${r.clean.prompts}, sesje ${r.clean.sessions}, encje ${r.clean.entities}, listy pracy ${r.clean.workState}${ids("clean")}`,
    `d) tury bez notatki w przeczytanych zakresach (zgubione przez parser 0.1, pominięte numerem claude-mem): sesje ${v.sessions} sprawdzone, ${v.missingTranscript} bez transkryptu; tury ${v.turns}, bez notatki ${v.missing}`,
    `   odzyskane notatki: ${v.recovered} (tury z promptem ${v.byKind.human}, komendy ${v.byKind.command}, ciąg dalszy ${v.byKind.continuation}, powiadomienia ${v.byKind.task})${ids("recover")}`,
    `   pominięte: opisane przez claude-mem ${v.claudeMem}, opisane w notatce sąsiedniej tury ${v.covered}, bez skutku albo trywialne ${v.idle}, ta sama treść ${v.duplicates}`,
    `   dopisane prompty: ${v.prompts} (pod numerem zastępczym, bo numer tury zajmował prompt innej tury: ${v.promptsMoved}), pierwszy prompt sesji: ${v.firstPrompts}, podsumowania od nowa: ${v.summaries}`,
    `e) klucze plików względem katalogu repo projektu: encje ${r.fileKeys.entities} (połączone z istniejącą: ${r.fileKeys.merged}), notatki ${r.fileKeys.notes}, podsumowania ${r.fileKeys.summaries}${ids("file-key")}`,
    `zmian razem: ${r.changes}${r.logFile ? `, dziennik: ${r.logFile}` : ""}`,
    ...(r.dryRun && r.reimport.observations + r.reimport.summaries
      ? [
          "uwaga: próba nie wstawia wpisów z a), więc b) ich nie widzi: w przebiegu właściwym notatek claude-mem za promptem i zmian razem może być więcej (po naprawie druga próba pokaże 0)",
        ]
      : []),
  ].join("\n");
}
