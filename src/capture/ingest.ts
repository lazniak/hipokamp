// Ingest transkryptu: od zapamiętanego offsetu → tury → obserwacje (w jednej transakcji).
// Idempotentne: klucz tury = uuid linii promptu; offset przesuwany optymistycznie (CAS).
import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { type Config, isExcludedTranscript, loadConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { log } from "../log.ts";
import type { Session } from "../types.ts";
import { fingerprint, gitHead } from "../util/git.ts";
import { fileKey, isProjectRoot, projectFromCwd, samePath } from "../util/paths.ts";
import { oneLine, truncate } from "../util/text.ts";
import { digestTurn } from "./digest.ts";
import { isSubagentTranscript } from "./formats.ts";
import { COWORK_PROJECT, type CoworkSession, coworkCwd, coworkSession } from "./harnesses.ts";
import { claudeMemDescribed } from "./match.ts";
import { turnPlace } from "./place.ts";
import { clean } from "./redact.ts";
import { storeCompactSummary } from "./summary.ts";
import {
  adoptSession,
  alignToLine,
  anchorBefore,
  compactSummaries,
  countsAsPrompt,
  type Line,
  type LineAnchor,
  offsetAfterAnchor,
  readLinesFrom,
  readTurns,
  sessionMeta,
} from "./transcript.ts";

/** Limit pamięci na jeden odczyt: dłuższa tura jest czytana partiami tej wielkości, dłuższa linia jest pomijana. */
export const MAX_WINDOW = 256 * 1024 * 1024;

export interface IngestRequest {
  sessionId: string;
  transcriptPath: string;
  cwd?: string | null;
  /**
   * Czy wolno zamknąć ostatnią turę: true (Stop / SessionEnd), false (czeka na dalsze linie), "complete" (tylko gdy
   * transkrypt pokazuje jej koniec, zob. lastTurnComplete: nadrabianie i backfill, gdzie cisza nie znaczy końca tury).
   */
  final: boolean | "complete";
  source?: "live" | "backfill";
  /** Początkowe okno odczytu (hook nie mieli 50 MB); rośnie dwukrotnie, gdy tura się w nim nie mieści. */
  maxBytes?: number;
  /** Do ilu bajtów może urosnąć okno (domyślnie MAX_WINDOW). */
  windowCap?: number;
  /**
   * Koniec czytanego zakresu (bajt w pliku): dalej plik traktujemy, jakby się tam kończył, także przy turze czytanej
   * partiami. Worker podaje go, żeby zapis tury na jego pętli nie wyszedł ponad próg (src/hooks/handle.ts). Gdy plik
   * jest dłuższy niż granica, `final` nie obowiązuje: tura przy granicy czeka na następny odczyt.
   */
  limit?: number;
}

export interface IngestResult {
  turns: number;
  inserted: number[];
  skipped: number;
  duplicates: number;
  offset: number;
  done: boolean;
  project: string | null;
}

const isMessage = (l: Line) => l.json?.type === "user" || l.json?.type === "assistant";

const isExcludedProject = (cfg: Config, project: string) =>
  cfg.capture.excludeProjects.some((p) => p.toLowerCase() === project.toLowerCase());

/** sessions.meta jako obiekt (pusty przy braku albo błędnym JSON). */
function sessionMetaObject(sess: Session): Record<string, unknown> {
  try {
    const o = JSON.parse(sess.meta ?? "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** Kotwica zapisana z offsetem; ważna tylko dla niego (naprawa zmienia offset bez kotwicy) i tylko z uuid. */
function storedAnchor(meta: Record<string, unknown>, offset: number): LineAnchor | null {
  const a = meta.anchor as Partial<LineAnchor> | null | undefined;
  if (!a || typeof a.at !== "number" || typeof a.len !== "number" || typeof a.uuid !== "string" || a.off !== offset) return null;
  return { at: a.at, len: a.len, uuid: a.uuid, type: a.type ?? null, off: a.off };
}

/** mtime pliku w ms albo null (nie istnieje). */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Sesja Cowork bez katalogu wybranego przez użytkownika: katalog piaskownicy dostaje alias projektu `cowork` (raz),
 * zamiast projektu z nazwy piaskownicy („outputs”, nazwa sesji). Tylko gdy aliasu nie ma albo jest gołym wynikiem
 * reguły dla tego katalogu: alias jawny (import, ręczny) i alias po `project merge` (źródło `rule:N`, ale inny projekt
 * niż z reguły) zostają.
 */
export function aliasCowork(repo: Repo, s: CoworkSession): void {
  if (s.folders.length || !s.cwd) return;
  const a = repo.projectAlias(s.cwd);
  if (!a || (a.source.startsWith("rule") && a.project === projectFromCwd(s.cwd)))
    repo.setProjectAlias(s.cwd, COWORK_PROJECT, "cowork");
}

/**
 * Cofnięcia historii (znacznik `gemini-rewind` z Gemini CLI `$rewindTo`) w przeczytanym zakresie: pozycja znacznika
 * i chwila, od której tury znikają (czas cofniętej wiadomości, a gdy ten odczyt jej nie widział: czas notatki jej
 * tury zapisanej wcześniej). Bez jednego i drugiego cofnięcie zostaje w logu.
 */
export function rewindsIn(repo: Repo, sessionId: string, lines: Line[], upTo: number): { pos: number; from: number }[] {
  const out: { pos: number; from: number }[] = [];
  for (const l of lines) {
    if (l.json?.type !== "gemini-rewind" || l.end > upTo) continue;
    const t = typeof l.json.timestamp === "string" ? Date.parse(l.json.timestamp) : Number.NaN;
    const from = Number.isFinite(t) ? t : repo.turnObservationTime(sessionId, String(l.json.target));
    if (from !== null) out.push({ pos: l.start, from });
    else log.info("cofnięcie do wiadomości bez czasu i bez notatki: pomijam", { session: sessionId.slice(0, 16) });
  }
  return out;
}

/** Tura cofnięta (przed znacznikiem cofnięcia i nie starsza niż cofnięta wiadomość): bez promptu i bez notatki. */
export function isRewound(rewinds: { pos: number; from: number }[], t: { to: number; startedAt: number }): boolean {
  return rewinds.some((r) => t.to <= r.pos && (t.startedAt || 0) >= r.from);
}

/** Początek transkryptu do pierwszej wiadomości: pierwsza linia bywa długa (wklejony obraz), więc okno rośnie. */
function readHead(path: string, cap: number): { lines: Line[] } {
  for (let win = 256 * 1024; ; win = Math.min(win * 4, cap)) {
    const head = readLinesFrom(path, 0, win);
    if (win >= cap || win >= head.size || head.lines.some(isMessage)) return head;
  }
}

/**
 * Cytowanie „#id” liczy się tylko dla notatek, które ta sesja widziała przed końcem tury: wstrzyknięte albo pobrane
 * i zwrócone w wyszukiwaniu. „PR #1” czy „issue #42” w odpowiedzi to nie użycie pamięci.
 * SQL poza repo.ts: zapytanie potrzebne tylko tutaj.
 */
function seenInSession(db: Database, sessionId: string, ids: number[], until: number): number[] {
  const marks = ids.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT obs_id FROM injections WHERE session_id = ? AND at <= ? AND obs_id IN (${marks})
       UNION
       SELECT obs_id FROM access_log WHERE session_id = ? AND at <= ? AND kind IN ('fetched','search_hit') AND obs_id IN (${marks})`,
    )
    .all(sessionId, until, ...ids, sessionId, until, ...ids) as { obs_id: number }[];
  return rows.map((r) => r.obs_id);
}

export function ingestTranscript(repo: Repo, req: IngestRequest): IngestResult {
  const cfg = loadConfig();
  const out: IngestResult = { turns: 0, inserted: [], skipped: 0, duplicates: 0, offset: 0, done: true, project: null };
  if (!req.transcriptPath || !existsSync(req.transcriptPath) || isExcludedTranscript(req.transcriptPath, cfg)) return out;
  // wątek podagenta (Codex: strażnik zgód, thread_spawn; Gemini CLI): jego praca jest w wątku głównym
  if (isSubagentTranscript(req.transcriptPath)) return out;
  const cap = Math.max(req.windowCap ?? MAX_WINDOW, 1);
  // Cowork (Claude Desktop): cwd w piaskownicy sesji to katalog wybrany przez użytkownika albo projekt `cowork`
  const cowork = req.sessionId.startsWith("desktop:") ? coworkSession(req.transcriptPath) : null;
  if (cowork) aliasCowork(repo, cowork);
  const place = (cwd: string | null | undefined): string | null => (cowork ? coworkCwd(cowork, cwd ?? null) : (cwd ?? null));

  let sess = repo.getSession(req.sessionId);
  // katalog startowy sesji (cwd pierwszych linii transkryptu): podstawa projektu tur w podkatalogach (turnPlace)
  let startDir: string | null | undefined;
  if (!sess) {
    const head = readHead(req.transcriptPath, cap);
    // transkrypt z samymi metadanymi (tytuł, nazwa agenta, bez wiadomości): nie zakładamy pustej sesji
    if (!head.lines.some(isMessage)) return out;
    const meta = sessionMeta(head.lines);
    const cwd = place(req.cwd ?? meta.cwd);
    startDir = place(meta.cwd) ?? cwd;
    const project = repo.resolveProject(cwd);
    // sesja wykluczonego projektu: bez pustego wiersza w sessions
    if (isExcludedProject(cfg, project)) {
      out.project = project;
      return out;
    }
    repo.upsertSession({
      id: req.sessionId,
      project,
      cwd,
      git_branch: meta.gitBranch,
      title: meta.title,
      started_at: meta.startedAt || Date.now(),
      transcript_path: req.transcriptPath,
      source: req.source ?? "live",
    });
    sess = repo.getSession(req.sessionId)!;
  }
  out.project = sess.project;
  if (isExcludedProject(cfg, sess.project)) return out;

  const startOffset = sess.transcript_offset ?? 0;
  const smeta = sessionMetaObject(sess);
  if (startDir === undefined)
    startDir = place("root" in smeta ? (smeta.root as string | null) : sessionMeta(readHead(req.transcriptPath, cap).lines).cwd);
  // offset dotyczy pliku z sessions.transcript_path. Sesja wznowiona w innym katalogu ma nowy plik z tą samą
  // historią, ale nie zawsze bajt w bajt: czytamy od końca odpowiednika ostatniej przeczytanej linii (kotwica),
  // a bez niego offset starej kopii wyrównujemy do granicy linii nowego pliku
  let from = startOffset;
  if (startOffset > 0 && !samePath(sess.transcript_path, req.transcriptPath)) {
    // starsza kopia niż plik sesji (nadrabianie i backfill widzą obie): sesja zostaje przy nowszym pliku. Powrót
    // do starej kopii gubiłby postęp w nowej, a jej tury czytały się potem drugi raz
    const current = sess.transcript_path ? mtimeOf(sess.transcript_path) : null;
    const candidate = mtimeOf(req.transcriptPath);
    if (current !== null && candidate !== null && candidate < current) {
      out.offset = startOffset;
      return out;
    }
    const anchor = storedAnchor(smeta, startOffset);
    const anchored = anchor ? offsetAfterAnchor(req.transcriptPath, anchor) : null;
    const aligned = anchored ?? alignToLine(req.transcriptPath, startOffset);
    if (aligned === null) {
      out.offset = startOffset;
      return out;
    }
    if (aligned !== startOffset)
      log.info("transkrypt sesji w nowym pliku: offset przeniesiony", {
        session: req.sessionId.slice(0, 8),
        from: startOffset,
        to: aligned,
        by: anchored === null ? "granica linii" : "kotwica",
      });
    from = aligned;
  }
  // granica odczytu przed końcem pliku: koniec zakresu to nie koniec transkryptu, więc tury przy niej nie zamykamy
  // (Stop zamknąłby turę uciętą na granicy linii w jej środku, a reszta poszłaby jako ciąg dalszy)
  let final = req.final;
  if (req.limit !== undefined) {
    try {
      if (statSync(req.transcriptPath).size > req.limit) final = false;
    } catch {}
  }
  const batch = readTurns(req.transcriptPath, req.sessionId, from, {
    window: req.maxBytes ?? 48 * 1024 * 1024,
    maxWindow: cap,
    final,
    limit: req.limit,
  });
  const { lines, turns } = batch;
  // sesja innego harnessu ma klucz z przedrostkiem (`desktop:`, `gemini:`…), a linie (Cowork) niosą goły uuid
  adoptSession(req.sessionId, turns);
  if (cowork) for (const t of turns) t.cwd = place(t.cwd);
  const newOffset = batch.offset;
  // cofnięcie historii (Gemini CLI `$rewindTo`): wcześniej zapisane tury od cofniętej wiadomości idą do archiwum,
  // a tury tego odczytu sprzed znacznika z tej chwili i późniejsze nie trafiają do pamięci
  const rewinds = rewindsIn(repo, req.sessionId, lines, newOffset);
  const rewound = (t: { to: number; startedAt: number }) => isRewound(rewinds, t);
  out.done = batch.end >= batch.size;
  const root = startDir ?? null;
  // werdykt katalogu startowego (projekt czy kontener projektów) liczony raz na sesję i zapisany w meta: hooki go
  // tylko czytają, bez skanowania podkatalogów
  const rootProject =
    !!root && ("root" in smeta && typeof smeta.rootProject === "boolean" ? smeta.rootProject : isProjectRoot(root) === true);
  // projekt i katalog kluczy każdej tury przed transakcją: sprawdzanie katalogów nie trzyma blokady zapisu bazy
  const places = turns.map((t) =>
    turnPlace(repo, cfg.capture.excludeProjects, root, t.cwd, sess!.project, { rootIsProject: rootProject }),
  );
  // kotwica nowego offsetu: tylko odczyt ostatniej linii przed nim (do 1 MB), poza transakcją
  const anchor = anchorBefore(req.transcriptPath, newOffset);
  // tury opisane już przez claude-mem (import): bez drugiej notatki. Dopasowanie po tekście i czasie, nie po numerze
  // (claude-mem numeruje też pobudki pętli i wiadomości agentów, a prompt bez notatki nie jest opisem), zob. match.ts
  const cm = claudeMemDescribed(repo, req.sessionId, turns);

  let n = 0;
  let lastAt = sess.last_activity_at ?? 0;
  let committed = false;
  const excludedRanges: [number, number][] = [];
  const db = repo.db;
  // IMMEDIATE: blokada zapisu od razu (czeka busy_timeout); DEFERRED po odczycie CAS dostawał SQLITE_BUSY bez czekania
  db.transaction(() => {
    // CAS: ktoś inny (backfill/drugi hook) mógł już przesunąć offset
    const cur = db
      .query(
        "SELECT transcript_offset, prompt_count, CASE WHEN json_valid(meta) THEN json_extract(meta, '$.n') END n FROM sessions WHERE id = ?",
      )
      .get(req.sessionId) as { transcript_offset: number; prompt_count: number; n: number | null };
    if (cur.transcript_offset !== startOffset) {
      out.offset = cur.transcript_offset;
      return;
    }
    // numer tury liczymy z transkryptu: od jego początku od zera, dalej od sessions.meta.n zapisanego razem z offsetem.
    // prompt_count po imporcie claude-mem to jego licznik, nie numer przeczytanej tury: liczenie od niego przesuwało
    // numery promptów i notatek. Sesje czytane przed wprowadzeniem meta.n nie mają go: wtedy prompt_count (jak dotąd).
    n = startOffset === 0 ? 0 : (cur.n ?? cur.prompt_count ?? 0);
    for (const r of rewinds) {
      const ids = repo.archiveRewoundTurns(req.sessionId, r.from, r.pos);
      if (ids.length) log.info("cofnięcie historii: notatki tur do archiwum", { session: req.sessionId.slice(0, 16), ids });
    }
    for (const [i, turn] of turns.entries()) {
      out.turns++;
      // tura cofnięta jeszcze przed zapisem: bez promptu, bez notatki i bez numeru (jej prompt nie istnieje w historii)
      if (rewound(turn)) {
        out.skipped++;
        continue;
      }
      // numer jak w claude-mem, zob. countsAsPrompt
      const isPrompt = countsAsPrompt(turn);
      if (isPrompt) n++;
      const place = places[i];
      const project = place.project;
      // tura w katalogu wykluczonego projektu (sesja zaczęta gdzie indziej): bez promptu i bez notatki
      if (isExcludedProject(cfg, project)) {
        excludedRanges.push([turn.from, turn.to]);
        out.skipped++;
        continue;
      }
      // prompt już zapisany przez claude-mem (ta sama wypowiedź): bez drugiego wiersza. Numer zajęty przez prompt
      // innej tury (wznowiona sesja z importu claude-mem): prompt pod numerem zastępczym, nie przepada
      if (isPrompt && !cm.paired.has(turn.key)) {
        repo.insertTurnPrompt({
          session_id: req.sessionId,
          project,
          n,
          text: truncate(clean(turn.prompt), 8000),
          created_at: turn.startedAt || Date.now(),
          source: req.source ?? "live",
        });
      }
      if (n === 1 && turn.kind === "human") {
        db.run("UPDATE sessions SET first_prompt = COALESCE(first_prompt, ?) WHERE id = ?", [
          truncate(oneLine(clean(turn.prompt)), 500),
          req.sessionId,
        ]);
      }
      lastAt = Math.max(lastAt, turn.endedAt || 0);
      if (cm.described.has(turn.key)) {
        out.skipped++;
        continue;
      }
      // klucze plików od katalogu projektu tury (w podkatalogu bez repo: od katalogu startowego, zob. turnPlace)
      const d = digestTurn(place.keyCwd === turn.cwd ? turn : { ...turn, cwd: place.keyCwd }, {
        project,
        n,
        privateTools: cfg.capture.privateTools,
        maxNarrativeChars: cfg.capture.maxNarrativeChars,
      });
      if (d.cited.length) {
        const at = turn.endedAt || Date.now();
        const seen = seenInSession(db, req.sessionId, d.cited, at);
        if (seen.length) repo.logAccess(seen, "cited", req.sessionId, at);
      }
      if (d.skip) {
        out.skipped++;
        continue;
      }
      // odciski plików i HEAD — do wykrywania notatek przeterminowanych przez późniejsze zmiany kodu
      const fps: Record<string, string> = {};
      for (const abs of d.modifiedAbs.slice(0, 40)) {
        const fp = fingerprint(abs);
        if (fp) fps[fileKey(abs, place.keyCwd)] = fp;
      }
      d.obs.fingerprints = Object.keys(fps).length ? fps : null;
      d.obs.git_head = gitHead(turn.cwd);
      d.obs.transcript_ref = { path: req.transcriptPath, from: turn.from, to: turn.to };
      if (req.source === "backfill") d.obs.source = "backfill";
      const r = repo.insertObservation(d.obs, d.entities);
      if (r.duplicateOf) out.duplicates++;
      else out.inserted.push(r.id);
    }
    // podsumowania kompakcji z przetworzonego zakresu (idempotentnie po offsecie linii), bez tur wykluczonych
    const kept = lines.filter((l) => l.end <= newOffset && !excludedRanges.some(([a, b]) => l.start >= a && l.end <= b));
    for (const cs of compactSummaries(kept)) storeCompactSummary(repo, req.sessionId, sess!.project, cs);
    // ścieżka i kotwica razem z offsetem: offset zawsze dotyczy pliku z transcript_path
    db.run(
      `UPDATE sessions SET transcript_offset = ?, transcript_path = ?, prompt_count = MAX(prompt_count, ?),
         last_activity_at = MAX(COALESCE(last_activity_at,0), ?),
         meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.n', ?, '$.anchor', json(?), '$.root', ?,
           '$.rootProject', json(?))
       WHERE id = ?`,
      [newOffset, req.transcriptPath, n, lastAt, n, JSON.stringify(anchor), root, JSON.stringify(rootProject), req.sessionId],
    );
    out.offset = newOffset;
    committed = true;
  }).immediate();
  if (committed && batch.batched && newOffset > from)
    log.info("tura dłuższa niż limit okna: przeczytana partiami", {
      session: req.sessionId.slice(0, 8),
      from,
      to: newOffset,
      capMb: Math.round(cap / 1048576),
    });
  if (committed && batch.skipped)
    log.warn("linia transkryptu dłuższa niż limit okna: pominięta", {
      session: req.sessionId.slice(0, 8),
      from: batch.skipped.from,
      to: batch.skipped.to,
      mb: Math.round((batch.skipped.to - batch.skipped.from) / 1048576),
    });
  if (out.inserted.length)
    log.info("ingest", {
      session: req.sessionId.slice(0, 8),
      project: out.project,
      turns: out.turns,
      inserted: out.inserted.length,
      skipped: out.skipped,
    });
  return out;
}
