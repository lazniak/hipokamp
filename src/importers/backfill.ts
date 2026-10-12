// Backfill z transkryptów Claude Code (~/.claude/projects/*/*.jsonl), Codexa (~/.codex/sessions/**/rollout-*.jsonl)
// i innych harnessów (capture/harnesses.ts): odtwarza pamięć z sesji, których nikt nie zapisał (np. gdy claude-mem
// stał na cooldownie albo worker był martwy).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listCodexRollouts } from "../capture/codex.ts";
import { listHarnessTranscripts } from "../capture/harnesses.ts";
import { type IngestRequest, ingestTranscript } from "../capture/ingest.ts";
import { buildSessionSummary } from "../capture/summary.ts";
import { claudeDir, isExcludedTranscript, loadConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { Session } from "../types.ts";

/** Sprząta sesje z wykluczonych katalogów, które trafiły do bazy wcześniej (np. przed dodaniem wykluczenia). */
export function purgeExcludedSessions(repo: Repo): { sessions: number; observations: number } {
  const pats = loadConfig().capture.excludeTranscriptDirs.filter(Boolean);
  if (!pats.length) return { sessions: 0, observations: 0 };
  const where = pats.map(() => "lower(replace(transcript_path, '\\', '/')) LIKE ?").join(" OR ");
  const ids = (
    repo.db
      .query(`SELECT id FROM sessions WHERE transcript_path IS NOT NULL AND (${where})`)
      .all(...pats.map((p) => `%${p.toLowerCase()}%`)) as { id: string }[]
  ).map((r) => r.id);
  return ids.length ? repo.purgeSessions(ids) : { sessions: 0, observations: 0 };
}

export interface TranscriptFile {
  path: string;
  sessionId: string;
  size: number;
  mtime: number;
}

/**
 * Transkrypty do nadrabiania i backfillu: Claude Code, a bez jawnego katalogu także Codex (capture.codex) i inne
 * harnessy (capture.harnesses: Gemini CLI, Cursor, OpenCode, Claude Desktop).
 */
export function listTranscripts(root?: string): TranscriptFile[] {
  const out = listClaudeTranscripts(root ?? join(claudeDir(), "projects"));
  const cfg = loadConfig();
  if (!root && cfg.capture.codex) for (const f of listCodexRollouts()) if (!isExcludedTranscript(f.path)) out.push(f);
  if (!root) out.push(...listHarnessTranscripts(cfg));
  return out.sort((a, b) => a.mtime - b.mtime);
}

function listClaudeTranscripts(root: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dp = join(root, d);
    if (isExcludedTranscript(dp)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dp);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = statSync(join(dp, f));
        if (!st.isFile()) continue;
        out.push({ path: join(dp, f), sessionId: f.slice(0, -6), size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

/** Po tylu godzinach ciszy sesję uznajemy za przerwaną (awaria, zamknięte okno): ostatnia tura idzie do zapisu, jaka jest. */
export const CRASH_QUIET_MS = 12 * 3_600_000;
/** SessionEnd ustawia ended_at chwilę przed ostatnimi liniami metadanych; zapis dużo późniejszy = sesję wznowiono. */
const ENDED_SLACK_MS = 2 * 60_000;

/**
 * Kiedy nadrabianie i backfill zamykają ostatnią turę. Cisza to nie koniec tury: długi Bash, agent, Workflow albo
 * pytanie o zgodę milkną na minuty, a wynik i odpowiedź przychodzą później już bez linii promptu. Bez ended_at
 * i bez 12 h ciszy tura zamyka się więc tylko wtedy, gdy transkrypt pokazuje jej koniec ("complete").
 */
export function lastTurnFinal(sess: Session | null, f: TranscriptFile, now = Date.now()): true | "complete" {
  if (sess?.ended_at && sess.ended_at + ENDED_SLACK_MS >= f.mtime) return true;
  return now - f.mtime > CRASH_QUIET_MS ? true : "complete";
}

/** Jedno wywołanie ingestu czyta jedno okno; backfill dociąga plik do końca albo do tury w toku. */
function ingestToEnd(repo: Repo, req: IngestRequest, from: number): { project: string | null; inserted: number } {
  let r = ingestTranscript(repo, req);
  let inserted = r.inserted.length;
  for (let prev = from; !r.done && r.offset > prev; ) {
    prev = r.offset;
    r = ingestTranscript(repo, req);
    inserted += r.inserted.length;
  }
  return { project: r.project, inserted };
}

export interface BackfillOptions {
  since?: number;
  project?: string;
  limit?: number;
  onProgress?: (done: number, total: number, file: TranscriptFile, inserted: number) => void;
}

export function backfill(
  repo: Repo,
  opts: BackfillOptions = {},
): { files: number; inserted: number; skippedCovered: number; bytes: number; purged: number } {
  const purged = purgeExcludedSessions(repo).sessions;
  const all = listTranscripts().filter((f) => !opts.since || f.mtime >= opts.since);
  const files = opts.limit ? all.slice(-opts.limit) : all;
  let inserted = 0;
  let skippedCovered = 0;
  let bytes = 0;
  const now = Date.now();
  files.forEach((f, i) => {
    const sess = repo.getSession(f.sessionId);
    if (sess && sess.transcript_offset >= f.size) {
      opts.onProgress?.(i + 1, files.length, f, 0);
      return;
    }
    if (opts.project && sess && sess.project.toLowerCase() !== opts.project.toLowerCase()) return;
    // sesja świeża (ktoś w niej pracuje) — nie zamykamy ostatniej tury; starsza jak w nadrabianiu
    const active = now - f.mtime < 3 * 60_000;
    // tury opisane już przez claude-mem pomija sam ingest (dopasowanie po tekście i czasie, capture/match.ts)
    const cmCovered = coveredByClaudeMem(repo, f.sessionId);
    const r = ingestToEnd(
      repo,
      {
        sessionId: f.sessionId,
        transcriptPath: f.path,
        final: active ? false : lastTurnFinal(sess, f, now),
        source: "backfill",
      },
      sess?.transcript_offset ?? 0,
    );
    if (opts.project && r.project && r.project.toLowerCase() !== opts.project.toLowerCase()) return;
    if (cmCovered) skippedCovered++;
    inserted += r.inserted;
    bytes += f.size;
    if (!active && r.inserted) buildSessionSummary(repo, f.sessionId);
    opts.onProgress?.(i + 1, files.length, f, r.inserted);
  });
  return { files: files.length, inserted, skippedCovered, bytes, purged };
}

/** Do którego promptu sesja ma notatki z importu claude-mem (0 = wcale); do statystyki backfillu. */
export function coveredByClaudeMem(repo: Repo, sessionId: string): number {
  const r = repo.db
    .query("SELECT MAX(prompt_n) m FROM observations WHERE session_id = ? AND source = 'claude-mem'")
    .get(sessionId) as { m: number | null };
  return r?.m ?? 0;
}
