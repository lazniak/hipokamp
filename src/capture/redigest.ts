// Ponowny skrót tury dla istniejących notatek hipokampa (po poprawkach w digest.ts działa wstecz).
// Źródłem jest zakres bajtów transkryptu zapisany przy notatce; notatki z claude-mem i z `remember` nie mają go i zostają.
import { existsSync } from "node:fs";
import { loadConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { log } from "../log.ts";
import type { Observation } from "../types.ts";
import { digestTurn } from "./digest.ts";
import { groupTurns, readLinesFrom } from "./transcript.ts";

export interface RedigestOptions {
  /** Konkretne notatki; bez tego: podejrzane tytuły (XML powiadomień, komunikaty o limitach). */
  ids?: number[];
  /** Wszystkie notatki hipokampa z odnośnikiem do transkryptu. */
  all?: boolean;
  dryRun?: boolean;
  limit?: number;
  onChange?: (o: Observation, next: { title: string; subtitle: string | null }) => void;
}

export interface RedigestResult {
  checked: number;
  updated: number;
  unchanged: number;
  missingTranscript: number;
  skipped: number;
}

const SUSPICIOUS = `(title LIKE '<%' OR title LIKE '%usage credits%' OR title LIKE 'API Error%' OR title LIKE '%limit reached%'
  OR subtitle LIKE 'Powiadomienie:%task-id%' OR subtitle LIKE '<%')`;

export function redigest(repo: Repo, opts: RedigestOptions = {}): RedigestResult {
  const cfg = loadConfig().capture;
  const res: RedigestResult = { checked: 0, updated: 0, unchanged: 0, missingTranscript: 0, skipped: 0 };
  const where = ["source IN ('digest','backfill','live')", "transcript_ref IS NOT NULL", "status = 'active'"];
  const params: number[] = [];
  if (opts.ids?.length) {
    where.push(`id IN (${opts.ids.map(() => "?").join(",")})`);
    params.push(...opts.ids);
  } else if (!opts.all) where.push(SUSPICIOUS);
  const rows = repo.db
    .query(`SELECT id FROM observations WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
    .all(...params, opts.limit ?? 1_000_000) as { id: number }[];

  for (const { id } of rows) {
    const o = repo.getObservation(id);
    const ref = o?.transcript_ref;
    if (!o || !ref) continue;
    res.checked++;
    if (!existsSync(ref.path)) {
      res.missingTranscript++;
      continue;
    }
    const { lines } = readLinesFrom(ref.path, ref.from, Math.max(1, ref.to - ref.from));
    const { turns } = groupTurns(lines, o.session_id ?? "", { final: true });
    const turn = turns.find((t) => t.key === o.turn_key) ?? turns[0];
    if (!turn) {
      res.skipped++;
      continue;
    }
    const d = digestTurn(turn, {
      project: o.project,
      n: o.prompt_n ?? 0,
      privateTools: cfg.privateTools,
      maxNarrativeChars: cfg.maxNarrativeChars,
    });
    // tura uznana dziś za trywialną: nie kasujemy notatki, zostawiamy ją do decyzji snu
    if (d.skip || !d.obs) {
      res.skipped++;
      continue;
    }
    const n = d.obs;
    if (n.title === o.title && n.subtitle === o.subtitle && n.narrative === o.narrative) {
      res.unchanged++;
      continue;
    }
    opts.onChange?.(o, { title: n.title, subtitle: n.subtitle ?? null });
    // ważność nie spada: powtórzenia (+0,05) i scalenia we śnie (+0,04) podniosły ją ponad bazę skrótu.
    // Hash treści przelicza updateObservationContent (nowa identyczna tura trafi w deduplikację).
    if (!opts.dryRun)
      repo.updateObservationContent(id, {
        title: n.title,
        subtitle: n.subtitle,
        narrative: n.narrative,
        facts: n.facts,
        concepts: n.concepts,
        type: n.type,
        importance: Math.max(o.importance, n.importance ?? 0),
      });
    res.updated++;
  }
  if (res.updated && !opts.dryRun) log.info("redigest", res);
  return res;
}
