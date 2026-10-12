// Nadrabianie: hooki Stop i SessionEnd bywają ucięte (limit czasu SessionEnd, zamknięte okno, awaria).
// Transkrypt jest trwałą kolejką, a offset w bazie jej potwierdzeniem, więc worker co jakiś czas dociąga
// to, czego hooki nie zdążyły, i buduje brakujące podsumowania sesji.
import { pruneOpencodeTranscripts } from "../capture/harnesses.ts";
import { ingestTranscript } from "../capture/ingest.ts";
import { buildSessionSummary } from "../capture/summary.ts";
import { refreshConfig } from "../config.ts";
import { getMeta, setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { lastTurnFinal, listTranscripts } from "../importers/backfill.ts";
import { log } from "../log.ts";
import { breathe } from "../util/slice.ts";

/**
 * Klucz w meta: pliki, w których ostatnia próba nic nie przesunęła (tura w toku), jako ścieżka → rozmiar i tryb
 * zamykania przy próbie. W bazie, nie w procesie: worker wyłącza się po bezczynności, a po każdym starcie czytałby
 * takie pliki od nowa.
 */
const WAITING_KEY = "catchup_waiting";

function loadWaiting(repo: Repo): { raw: string; map: Map<string, string> } {
  const raw = getMeta(repo.db, WAITING_KEY) ?? "{}";
  try {
    const o = JSON.parse(raw);
    const map = new Map<string, string>();
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (typeof v === "string") map.set(k, v);
    return { raw, map };
  } catch {
    return { raw, map: new Map() };
  }
}

type CatchUpOpts = { windowHours?: number; quietMin?: number; maxFiles?: number };
type CatchUpResult = { files: number; inserted: number; summaries: number };

/** Okno odczytu jednego kroku: krok trwa dziesiątki ms, a plik i tak przechodzi do 24 MB na przebieg. */
const STEP_BYTES = 1024 * 1024;
const PASS_BYTES = 24 * 1024 * 1024;

export function catchUp(repo: Repo, opts: CatchUpOpts = {}): CatchUpResult {
  const res = { files: 0, inserted: 0, summaries: 0 };
  for (const _ of steps(repo, opts, res));
  return res;
}

/** Wersja dla workera: po każdym oknie transkryptu oddaje sterowanie pętli zdarzeń (hooki nie czekają na przebieg). */
export async function catchUpSliced(repo: Repo, opts: CatchUpOpts = {}): Promise<CatchUpResult> {
  const res = { files: 0, inserted: 0, summaries: 0 };
  for (const _ of steps(repo, opts, res)) await breathe();
  return res;
}

function* steps(repo: Repo, opts: CatchUpOpts, res: CatchUpResult): Generator<void> {
  const now = Date.now();
  const windowMs = (opts.windowHours ?? 48) * 3_600_000;
  const quietMs = (opts.quietMin ?? 3) * 60_000;
  const saved = loadWaiting(repo);
  const waiting = saved.map;
  const recent = listTranscripts().filter((f) => now - f.mtime <= windowMs);
  for (const f of recent) {
    if (res.files >= (opts.maxFiles ?? 20)) break;
    // tylko już ciche (w aktywnej sesji pracują hooki)
    if (now - f.mtime < quietMs) continue;
    const s = repo.getSession(f.sessionId);
    if (s && s.transcript_offset >= f.size) {
      waiting.delete(f.path);
      continue;
    }
    // ostatnia tura tylko skończona, po SessionEnd albo po 12 h ciszy (zob. lastTurnFinal)
    const final = lastTurnFinal(s, f, now);
    // plik bez zmian od próby, która nic nie dała: nie czytamy go od nowa co 10 minut i nie zjada limitu plików
    const stamp = `${f.size}:${final}`;
    if (waiting.get(f.path) === stamp) continue;
    const before = s?.transcript_offset ?? 0;
    // okna po 1 MB zamiast jednego na 24 MB: między nimi worker obsługuje hooki (offset w bazie to ciągłość)
    let r = ingestTranscript(repo, {
      sessionId: f.sessionId,
      transcriptPath: f.path,
      final,
      source: "live",
      maxBytes: STEP_BYTES,
    });
    let inserted = r.inserted.length;
    while (!r.done && r.offset - before < PASS_BYTES) {
      const at = r.offset;
      yield;
      r = ingestTranscript(repo, { sessionId: f.sessionId, transcriptPath: f.path, final, source: "live", maxBytes: STEP_BYTES });
      inserted += r.inserted.length;
      if (r.offset <= at) break;
    }
    res.files++;
    res.inserted += inserted;
    // bez nowych linii nic tu więcej nie zrobimy: zostaje tura w toku (okno doszło do końca) albo brak postępu
    if (r.offset < f.size && (r.done || r.offset <= before)) waiting.set(f.path, stamp);
    else waiting.delete(f.path);
    // tura domknięta po fakcie: podsumowanie zbudowane wcześniej (po 30 min ciszy) jeszcze jej nie zna
    // (SQL poza repo.ts: jedno sprawdzenie potrzebne tylko tutaj)
    if (
      inserted &&
      repo.db.query("SELECT 1 FROM summaries WHERE session_id = ? AND source = 'digest'").get(f.sessionId) &&
      buildSessionSummary(repo, f.sessionId)
    )
      res.summaries++;
    yield;
  }
  // pliki spoza okna nadrabiania już nie wrócą: ich wpisy wypadają, więc pamięć nie rośnie
  const inWindow = new Set(recent.map((f) => f.path));
  for (const p of [...waiting.keys()]) if (!inWindow.has(p)) waiting.delete(p);
  const raw = JSON.stringify(Object.fromEntries(waiting));
  if (raw !== saved.raw) setMeta(repo.db, WAITING_KEY, raw);
  // sesje bez podsumowania (SessionEnd ucięty albo nie przyszedł): po 30 min ciszy
  const rows = repo.db
    .query(
      `SELECT s.id FROM sessions s
       WHERE COALESCE(s.last_activity_at, s.started_at) BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM observations o WHERE o.session_id = s.id AND o.source IN ('digest','backfill','agent'))
         AND NOT EXISTS (SELECT 1 FROM summaries m WHERE m.session_id = s.id AND m.source = 'digest')
       LIMIT 20`,
    )
    .all(now - windowMs, now - 30 * 60_000) as { id: string }[];
  for (const r of rows) {
    if (buildSessionSummary(repo, r.id)) res.summaries++;
    yield;
  }
  // stare, przeczytane do końca transkrypty pluginu OpenCode (kopie rozmów poza OpenCode): capture.opencodeKeepDays
  const pruned = pruneOpencodeTranscripts(
    refreshConfig(),
    (id, size) => (repo.getSession(id)?.transcript_offset ?? -1) >= size,
    now,
  );
  if (pruned) log.info("nadrabianie: usunięte stare transkrypty OpenCode", { pruned });
  if (res.inserted || res.summaries) log.info("nadrabianie", res);
}
