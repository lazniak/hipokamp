// Odzyskiwanie tur bez notatki w już przeczytanych zakresach transkryptów (`hipokamp repair`, sekcja d).
// Parser 0.1 gubił pracę głównego wątku bez nowego promptu na początku okna (ciąg dalszy po uwadze hooka Stop,
// wiadomość innej sesji, reszta tury uciętej na limicie okna) i prompty z aplikacji desktop z blokiem
// <system-reminder> na początku (zwykle pierwsza tura sesji). Backfill 0.1 pomijał też tury po numerze promptu
// claude-mem, także te, do których claude-mem nie ma notatki. Zakres [0, transcript_offset) czytamy obecnym parserem,
// numerujemy od zera jak przy czytaniu od początku i zapisujemy notatki tylko tur, których klucza nie ma w bazie
// i których nie opisał claude-mem (match.ts). Offset i licznik tur sesji (meta.n) zostają bez zmian, wektory policzy
// worker w tle. Odciski plików notatki odtwarzamy z transkryptu (czas wyniku ostatniego zapisu pliku w turze).
// SQL poza repo.ts: odczyty i jedna poprawka potrzebne tylko tutaj.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type Config, claudeDir, isExcludedTranscript, loadConfig } from "../config.ts";
import { contentHash, type Repo, substitutePromptN } from "../db/repo.ts";
import { fileKey, normPath } from "../util/paths.ts";
import { oneLine, truncate } from "../util/text.ts";
import { listCodexRollouts } from "./codex.ts";
import { digestTurn } from "./digest.ts";
import { coworkCwd, coworkSession, listHarnessTranscripts } from "./harnesses.ts";
import { isRewound, MAX_WINDOW, rewindsIn } from "./ingest.ts";
import { claudeMemDescribed, pairByTextAndTime, promptKey } from "./match.ts";
import { placedTurns } from "./place.ts";
import { clean } from "./redact.ts";
import { buildSessionSummary } from "./summary.ts";
import { adoptSession, countsAsPrompt, type Line, readLinesFrom, readTurns, type Turn, type TurnKind } from "./transcript.ts";

/**
 * Stan po wcześniejszych krokach naprawy, których próba nie zapisała (`hipokamp repair --dry-run`): bez niego próba
 * liczyłaby wolne numery promptów i duplikaty treści na starych danych i przewidywała co innego niż przebieg właściwy.
 */
export interface RecoverView {
  /** Prompty sesji po b) (numery i teksty). */
  prompts?: Map<string, { n: number; text: string; created_at: number }[]>;
  /** Notatki, które b) scaliłaby (w bazie próby nadal aktywne). */
  merged?: Set<number>;
}

export interface RecoverOptions {
  dryRun?: boolean;
  /** Wpis dziennika dla każdej zmiany (naprawa zapisuje je w JSONL). */
  emit?: (e: Record<string, unknown>) => void;
  /** Zapis zmian jednej sesji w transakcji (naprawa dopisuje po niej dziennik); w próbie tylko liczenie. */
  write?: (fn: () => void) => void;
  /** Podgląd decyzji dla każdej tury bez notatki (pomiary). */
  trace?: (turn: Turn, outcome: RecoverOutcome, sessionId: string) => void;
  /** Stan z wcześniejszych kroków naprawy w próbie (zob. RecoverView). */
  view?: RecoverView;
}

export type RecoverOutcome = "recovered" | "claude-mem" | "covered" | "idle" | "duplicate";

export interface RecoverReport {
  /** Sesje z przeczytanym zakresem i istniejącym transkryptem. */
  sessions: number;
  missingTranscript: number;
  /** Tury w przeczytanych zakresach i tury bez notatki (klucza tury nie ma w bazie). */
  turns: number;
  missing: number;
  recovered: number;
  byKind: Record<TurnKind, number>;
  /** Pominięte: opisane przez claude-mem, opisane w notatce sąsiedniej tury, bez skutku albo trywialne, duplikat treści. */
  claudeMem: number;
  covered: number;
  idle: number;
  duplicates: number;
  /** Tury w wykluczonych projektach (bez promptu i notatki). */
  excluded: number;
  prompts: number;
  /** Z nich pod numerem zastępczym: numer tury zajmował prompt innej tury (zwykle z claude-mem). */
  promptsMoved: number;
  firstPrompts: number;
  summaries: number;
}

export function emptyRecoverReport(): RecoverReport {
  return {
    sessions: 0,
    missingTranscript: 0,
    turns: 0,
    missing: 0,
    recovered: 0,
    byKind: { human: 0, command: 0, continuation: 0, task: 0 },
    claudeMem: 0,
    covered: 0,
    idle: 0,
    duplicates: 0,
    excluded: 0,
    prompts: 0,
    promptsMoved: 0,
    firstPrompts: 0,
    summaries: 0,
  };
}

/** Okno odczytu jak w backfillu; rośnie do MAX_WINDOW, gdy tura się nie mieści. */
const WINDOW = 48 * 1024 * 1024;

const nameKey = (p: string) => basename(p).toLowerCase();
const pathKey = (p: string) => normPath(p).toLowerCase();

const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Tura większa niż tyle bajtów: bez odcisków (drugi odczyt zakresu tylko dla czasów wyników). */
const FP_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Odciski plików zmienionych w turze (klucze jak w files_modified notatki), odtworzone z transkryptu: czas linii
 * z wynikiem ostatniego udanego zapisu pliku w turze (zapis czeka czasem na zgodę, więc czas wywołania byłby za
 * wczesny) i rozmiar treści przy Write. Stan pliku z chwili naprawy nic nie mówi o stanie po tamtej turze, a bez
 * odcisku przeterminowanie liczy się od końca tury, więc zmiany z dalszej części tej samej tury nie przeterminują notatki.
 */
export function turnFingerprints(path: string, turn: Turn, keys: string[]): Record<string, string> | null {
  if (!keys.length) return null;
  const want = new Set(keys);
  const last = new Map<string, { id: string; size: number | null }>();
  for (const t of turn.tools) {
    if (!WRITE_TOOLS.has(t.name) || t.isError) continue;
    const fp = t.input?.file_path ?? t.input?.notebook_path ?? t.structured?.filePath;
    if (typeof fp !== "string" || !fp) continue;
    const k = fileKey(fp, turn.cwd);
    if (!want.has(k)) continue;
    const content = t.name === "Write" ? t.input?.content : undefined;
    last.set(k, { id: t.id, size: typeof content === "string" ? Buffer.byteLength(content, "utf8") : null });
  }
  const len = turn.to - turn.from;
  if (!last.size || len <= 0 || len > FP_MAX_BYTES) return null;
  const ids = new Set([...last.values()].map((v) => v.id));
  const doneAt = new Map<string, number>();
  for (const l of readLinesFrom(path, turn.from, len).lines) {
    const c = l.json?.message?.content;
    if (l.json?.type !== "user" || !Array.isArray(c)) continue;
    const at = Date.parse(l.json.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    for (const b of c) if (b?.type === "tool_result" && ids.has(b.tool_use_id) && !b.is_error) doneAt.set(b.tool_use_id, at);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of last) {
    const at = doneAt.get(v.id);
    if (at) out[k] = `${at}:${v.size ?? ""}`;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Zakresy notatek w plikach transkryptu: po pełnej ścieżce, a osobno po nazwie pliku dla plików przeniesionych.
 * Kopie historii tej samej sesji w różnych katalogach mają różną treść, więc ich zakresów nie mieszamy.
 */
function noteRanges(repo: Repo): { byPath: Map<string, [number, number][]>; byName: Map<string, [number, number][]> } {
  const byPath = new Map<string, [number, number][]>();
  const byName = new Map<string, [number, number][]>();
  const add = (m: Map<string, [number, number][]>, k: string, r: [number, number]) => {
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  };
  for (const r of repo.db.query("SELECT transcript_ref FROM observations WHERE transcript_ref IS NOT NULL").all() as {
    transcript_ref: string;
  }[]) {
    try {
      const ref = JSON.parse(r.transcript_ref);
      if (typeof ref?.path !== "string" || !Number.isFinite(ref.from) || !Number.isFinite(ref.to)) continue;
      add(byPath, pathKey(ref.path), [ref.from, ref.to]);
      add(byName, nameKey(ref.path), [ref.from, ref.to]);
    } catch {}
  }
  return { byPath, byName };
}

/** Transkrypty Claude Code po nazwie pliku (sesja bez zapisanej ścieżki albo z przeniesionym plikiem); z kilku
 *  kopii historii sesji najdłuższa, jak w sessionFile naprawy. */
function transcriptIndex(): Map<string, string> {
  const out = new Map<string, string>();
  const sizes = new Map<string, number>();
  const root = join(claudeDir(), "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    try {
      for (const f of readdirSync(join(root, d))) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(root, d, f);
        let size = 0;
        try {
          size = statSync(p).size;
        } catch {
          continue;
        }
        const k = f.toLowerCase();
        if ((sizes.get(k) ?? -1) < size) {
          sizes.set(k, size);
          out.set(k, p);
        }
      }
    } catch {}
  }
  return out;
}

/**
 * Pliki sesji Codexa i innych harnessów (Gemini CLI, Cursor, OpenCode, Cowork) po kluczu sesji, dla sesji bez
 * zapisanej ścieżki albo z przeniesionym plikiem (transcriptIndex szuka tylko w katalogach Claude Code). Harnessy
 * włączone w konfiguracji, bez wykluczonych katalogów; z kilku kopii najdłuższa.
 */
export function harnessTranscriptIndex(cfg: Config = loadConfig()): Map<string, string> {
  const out = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const f of [...listCodexRollouts(), ...listHarnessTranscripts(cfg)]) {
    if ((sizes.get(f.sessionId) ?? -1) >= f.size) continue;
    sizes.set(f.sessionId, f.size);
    out.set(f.sessionId, f.path);
  }
  return out;
}

/**
 * Tury zakresu [0, limit). Okna 0.1 kończyły się na końcu opisanej tury (Stop), więc zakres tniemy na końcach
 * istniejących notatek: praca, która przyszła po nich bez nowego promptu, staje się ciągiem dalszym jak w obecnym
 * ingest. Bez cięć wpadłaby do tury sprzed niej, która ma już notatkę. Wewnątrz odcinka okna jak w readTurns.
 */
function rangeTurns(path: string, sessionId: string, limit: number, cuts: number[]): { turns: Turn[]; marks: Line[] } {
  const out: Turn[] = [];
  // znaczniki cofnięcia historii (Gemini CLI `$rewindTo`): tury przed nimi nie wracają jako odzyskane
  const marks: Line[] = [];
  const ends = [...new Set(cuts.filter((c) => c > 0 && c < limit)), limit].sort((a, b) => a - b);
  let off = 0;
  for (const end of ends) {
    while (off < end) {
      const b = readTurns(path, sessionId, off, { window: WINDOW, maxWindow: MAX_WINDOW, final: true, limit: end });
      // sesja innego harnessu (desktop:, gemini:…): notatka i prompt pod kluczem sesji, nie gołym uuid z linii (jak ingest)
      adoptSession(sessionId, b.turns);
      out.push(...b.turns);
      for (const l of b.lines) if (l.json?.type === "gemini-rewind") marks.push(l);
      if (b.offset <= off) break;
      off = b.offset;
    }
    off = Math.max(off, end);
  }
  return { turns: out, marks };
}

export function recoverTurns(repo: Repo, opts: RecoverOptions = {}): RecoverReport {
  const db = repo.db;
  const dry = !!opts.dryRun;
  const emit = opts.emit ?? (() => {});
  const write = opts.write ?? ((fn: () => void) => (dry ? fn() : db.transaction(fn).immediate()));
  const cfg = loadConfig();
  const rep = emptyRecoverReport();
  const excludedProject = (p: string) => cfg.capture.excludeProjects.some((x) => x.toLowerCase() === p.toLowerCase());
  const ranges = noteRanges(repo);
  let index: Map<string, string> | null = null;
  let harness: Map<string, string> | null = null;
  const hasKey = db.query("SELECT 1 FROM observations WHERE turn_key = ?");
  const sameContentQ = db.query("SELECT id FROM observations WHERE project = ? AND content_hash = ? AND status = 'active'");
  const merged = opts.view?.merged;
  const sameContent = (project: string, hash: string) =>
    (sameContentQ.all(project, hash) as { id: number }[]).some((r) => !merged?.has(r.id));
  const hashes = new Set<string>();
  const projects = new Map<string, string>();

  const sessions = db
    .query(
      "SELECT id, project, transcript_path, transcript_offset, first_prompt FROM sessions WHERE transcript_offset > 0 ORDER BY started_at, id",
    )
    .all() as {
    id: string;
    project: string;
    transcript_path: string | null;
    transcript_offset: number;
    first_prompt: string | null;
  }[];

  for (const s of sessions) {
    let path = s.transcript_path && existsSync(s.transcript_path) ? s.transcript_path : null;
    // sesja innego harnessu nie ma kopii w katalogach Claude Code
    if (!path && !s.id.includes(":")) {
      index ??= transcriptIndex();
      path = index.get(`${s.id}.jsonl`.toLowerCase()) ?? null;
    }
    if (!path) {
      harness ??= harnessTranscriptIndex(cfg);
      path = harness.get(s.id) ?? null;
    }
    if (!path) {
      rep.missingTranscript++;
      continue;
    }
    // transkrypty obserwatora claude-mem i wykluczone projekty: jak w ingest, wcale
    if (isExcludedTranscript(path, cfg) || excludedProject(s.project)) continue;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      rep.missingTranscript++;
      continue;
    }
    rep.sessions++;
    const limit = Math.min(s.transcript_offset, size);
    const fileRanges = ranges.byPath.get(pathKey(path)) ?? ranges.byName.get(nameKey(path)) ?? [];
    const read = rangeTurns(
      path,
      s.id,
      limit,
      fileRanges.map((r) => r[1]),
    );
    // cofnięte tury (jak w ingest): bez promptu, bez notatki i bez numeru
    const rewinds = rewindsIn(repo, s.id, read.marks, limit);
    const turns = read.turns.filter((t) => !isRewound(rewinds, t));
    // Cowork (Claude Desktop): katalog piaskownicy to katalog wybrany przez użytkownika albo projekt `cowork`, jak w ingest
    const cowork = s.id.startsWith("desktop:") ? coworkSession(path) : null;
    if (cowork) for (const t of turns) t.cwd = coworkCwd(cowork, t.cwd ?? null);
    if (!turns.length) continue;
    rep.turns += turns.length;
    const { described } = claudeMemDescribed(repo, s.id, turns);
    // prompty sesji: zajęte numery i teksty (ta sama wypowiedź: tekst i czas jak przy parowaniu z claude-mem); w próbie
    // naprawy po b), którego próba nie zapisała
    const rows =
      opts.view?.prompts?.get(s.id) ??
      (db.query("SELECT n, text, created_at FROM prompts WHERE session_id = ?").all(s.id) as {
        n: number;
        text: string;
        created_at: number;
      }[]);
    const slots = new Set(rows.map((r) => r.n));
    const promptTurns: { turn: Turn; n: number; project: string }[] = [];

    const prompts: { n: number; turnN: number; project: string; text: string; at: number }[] = [];
    const notes: { turn: Turn; n: number; obs: any; entities: any[] }[] = [];
    let firstPrompt: string | null = null;
    let n = 0;
    for (const turn of placedTurns(repo, cfg.capture.excludeProjects, s.id, turns)) {
      const isPrompt = countsAsPrompt(turn);
      if (isPrompt) n++;
      let project = s.project;
      if (turn.cwd) {
        project = projects.get(turn.cwd) ?? repo.resolveProject(turn.cwd);
        projects.set(turn.cwd, project);
      }
      if (excludedProject(project)) {
        rep.excluded++;
        continue;
      }
      if (isPrompt) promptTurns.push({ turn, n, project });
      if (n === 1 && turn.kind === "human" && s.first_prompt == null && firstPrompt == null)
        firstPrompt = truncate(oneLine(clean(turn.prompt)), 500);
      if (hasKey.get(turn.key)) continue;
      rep.missing++;
      const outcome = ((): RecoverOutcome => {
        if (described.has(turn.key)) return "claude-mem";
        // 0.1 czytał okno w całości i dokleił pracę tury z nierozpoznanym promptem do tury przed nią
        if (fileRanges.some(([a, b]) => a <= turn.from && turn.to <= b)) return "covered";
        const d = digestTurn(turn, {
          project,
          n,
          privateTools: cfg.capture.privateTools,
          maxNarrativeChars: cfg.capture.maxNarrativeChars,
        });
        if (d.skip) return "idle";
        // ta sama treść co istniejąca notatka: naprawa jej nie wzmacnia (to nie jest nowe powtórzenie)
        const hash = contentHash({ project: d.obs.project, title: d.obs.title, narrative: d.obs.narrative, facts: d.obs.facts });
        if (hashes.has(`${d.obs.project}\n${hash}`) || sameContent(d.obs.project, hash)) return "duplicate";
        hashes.add(`${d.obs.project}\n${hash}`);
        // odciski plików z chwili naprawy nie mówią nic o stanie po tamtej turze: odtworzone z transkryptu, a gdzie
        // się nie da, przeterminowanie liczy się od czasu notatki. HEAD z tamtej chwili jest nie do odtworzenia.
        d.obs.fingerprints = turnFingerprints(path, turn, d.obs.files_modified ?? []);
        d.obs.git_head = null;
        d.obs.transcript_ref = { path, from: turn.from, to: turn.to };
        d.obs.source = "backfill";
        d.obs.content_hash = hash;
        d.obs.meta = { ...d.obs.meta, repair: "recover" };
        notes.push({ turn, n, obs: d.obs, entities: d.entities });
        return "recovered";
      })();
      if (outcome === "recovered") {
        rep.recovered++;
        rep.byKind[turn.kind]++;
      } else if (outcome === "claude-mem") rep.claudeMem++;
      else if (outcome === "covered") rep.covered++;
      else if (outcome === "idle") rep.idle++;
      else rep.duplicates++;
      opts.trace?.(turn, outcome, s.id);
    }
    // prompt tylko, gdy tej wypowiedzi nie ma w sesji (np. jako promptu claude-mem); pod numerem tury, a gdy ten
    // zajmuje prompt innej tury, pod numerem zastępczym z osobnego zakresu (jak w ingest), żeby tekst nie przepadł
    const known = pairByTextAndTime(
      promptTurns.map((p) => ({ item: p, key: promptKey(p.turn.prompt), at: p.turn.startedAt })),
      rows.map((r) => ({ item: r, key: promptKey(r.text), at: r.created_at })),
    );
    for (const p of promptTurns) {
      if (known.has(p)) continue;
      const n = slots.has(p.n) ? substitutePromptN(p.n, slots) : p.n;
      slots.add(n);
      prompts.push({
        n,
        turnN: p.n,
        project: p.project,
        text: truncate(clean(p.turn.prompt), 8000),
        at: p.turn.startedAt || p.turn.endedAt || Date.now(),
      });
    }
    rep.prompts += prompts.length;
    rep.promptsMoved += prompts.filter((p) => p.n !== p.turnN).length;
    if (firstPrompt) rep.firstPrompts++;
    const rebuild =
      notes.length > 0 && !!db.query("SELECT 1 FROM summaries WHERE session_id = ? AND source = 'digest'").get(s.id);
    if (rebuild) rep.summaries++;
    if (!notes.length && !prompts.length && !firstPrompt) continue;

    write(() => {
      for (const p of prompts) {
        const r = dry
          ? null
          : repo.insertTurnPrompt({
              session_id: s.id,
              project: p.project,
              n: p.n,
              text: p.text,
              created_at: p.at,
              source: "backfill",
            });
        emit({ op: "recover-prompt", id: r?.id ?? null, session: s.id, n: r?.n ?? p.n, turn_n: p.turnN });
      }
      if (firstPrompt) {
        if (!dry) db.run("UPDATE sessions SET first_prompt = COALESCE(first_prompt, ?) WHERE id = ?", [firstPrompt, s.id]);
        emit({ op: "first-prompt", session: s.id });
      }
      for (const x of notes) {
        const r = dry ? null : repo.insertObservation(x.obs, x.entities);
        // klucz tury mógł się pojawić w międzyczasie (hook tej samej sesji): wtedy nic nie dopisano
        if (r?.duplicateOf) continue;
        emit({ op: "recover", id: r?.id ?? null, session: s.id, turn_key: x.turn.key, kind: x.turn.kind, n: x.n });
      }
      if (rebuild) {
        const id = dry ? null : buildSessionSummary(repo, s.id);
        emit({ op: "summary", id, session: s.id });
      }
    });
  }
  return rep;
}
