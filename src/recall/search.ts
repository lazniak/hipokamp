// Wyszukiwanie hybrydowe: BM25 (FTS5) + wektory (bge-m3) → Reciprocal Rank Fusion.
import type { Repo } from "../db/repo.ts";
import type { TextEmbedder } from "../index/embedder.ts";
import { ftsSearch } from "../index/fts.ts";
import { vectorSearch } from "../index/vectors.ts";
import { log } from "../log.ts";
import type { Observation } from "../types.ts";
import { normKey, tokens } from "../util/text.ts";
import type { StageTimes } from "./profile.ts";

export interface SearchOptions {
  project?: string | null;
  /** Bez notatek tego projektu (globalne szukanie po lokalnym: trafienia projektu już są). */
  excludeProject?: string | null;
  limit?: number;
  types?: string[];
  since?: number;
  until?: number;
  includeArchived?: boolean;
  /** false: tylko FTS (np. gdy worker z modelem nie działa). */
  useVectors?: boolean;
  /** Gotowy wektor zapytania: ścieżka promptu liczy go raz dla wyszukiwania lokalnego i globalnego. */
  queryVector?: Float32Array | null;
  /** Czas etapów w ms (dopisywany): embedding, FTS, wektory, scalanie (do `rank`). */
  timings?: StageTimes;
  /**
   * Bez FTS, same wektory (ścieżka promptu: globalne szukanie przy mocnym lokalnym, FTS to najdroższy etap).
   * `rel` w tej samej skali co z obiema listami: trafienie tylko z wektorów dostaje najwyżej połowę, jak wtedy, gdy
   * FTS by go nie znalazł.
   */
  skipFts?: boolean;
}

export interface Hit {
  id: number;
  /** RRF znormalizowany do 0..1 (pozycja w rankingu). */
  rel: number;
  /** Pewność trafienia 0..1 (cosinus albo pokrycie słów zapytania) — do progów wstrzykiwania. */
  conf: number;
  cos: number | null;
  bm25: number | null;
}

const RRF_K = 60;

export async function hybridSearch(
  repo: Repo,
  embedder: TextEmbedder | null,
  q: string,
  opts: SearchOptions = {},
): Promise<Hit[]> {
  const limit = opts.limit ?? 20;
  const pool = Math.max(60, limit * 4);
  const tm = opts.timings;
  // przerwa przed FTS (na dużej bazie do ok. 0,2 s synchronicznie): prompt szuka w projekcie i zaraz globalnie,
  // a bez niej koniec pierwszego wyszukiwania i FTS drugiego szłyby jednym blokiem pętli zdarzeń workera
  await new Promise((r) => setTimeout(r, 0));
  // zegar etapów od końca przerwy: czekanie na pętlę zdarzeń to nie koszt FTS
  let t = performance.now();
  const lap = (k: keyof StageTimes) => {
    const now = performance.now();
    if (tm) tm[k] += now - t;
    t = now;
  };
  const fts = opts.skipFts
    ? []
    : ftsSearch(repo.db, q, {
        project: opts.project,
        excludeProject: opts.excludeProject,
        limit: pool,
        types: opts.types,
        since: opts.since,
        until: opts.until,
        includeArchived: opts.includeArchived,
      });
  lap("fts");
  let vec: { id: number; cos: number }[] = [];
  if (embedder && opts.useVectors !== false && q.trim().length > 2) {
    try {
      const qv = opts.queryVector ?? (await embedder.embed([q], "query"))[0];
      lap("embed");
      vec = vectorSearch(repo, qv, pool, {
        project: opts.project,
        excludeProject: opts.excludeProject,
        includeArchived: opts.includeArchived,
      });
      if (opts.types?.length || opts.since || opts.until) {
        const obs = new Map(repo.getObservations(vec.map((v) => v.id)).map((o) => [o.id, o]));
        vec = vec.filter((v) => {
          const o = obs.get(v.id);
          if (!o) return false;
          if (opts.types?.length && !opts.types.includes(o.type)) return false;
          if (opts.since && o.created_at < opts.since) return false;
          if (opts.until && o.created_at > opts.until) return false;
          return true;
        });
      }
      lap("vec");
    } catch (e) {
      log.warn("wyszukiwanie wektorowe nieudane, tylko FTS", e);
      t = performance.now();
    }
  }
  const acc = new Map<number, Hit & { s: number }>();
  fts.forEach((h, i) => {
    acc.set(h.id, { id: h.id, rel: 0, conf: 0, cos: null, bm25: h.bm25, s: 1 / (RRF_K + i + 1) });
  });
  vec.forEach((h, i) => {
    const cur = acc.get(h.id);
    if (cur) {
      cur.s += 1 / (RRF_K + i + 1);
      cur.cos = h.cos;
    } else acc.set(h.id, { id: h.id, rel: 0, conf: 0, cos: h.cos, bm25: null, s: 1 / (RRF_K + i + 1) });
  });
  const lists = (fts.length || opts.skipFts ? 1 : 0) + (vec.length ? 1 : 0);
  const maxS = lists / (RRF_K + 1);
  const hits = [...acc.values()].sort((a, b) => b.s - a.s).slice(0, Math.max(limit, 40));
  // pewność: cosinus (skalibrowany dla bge-m3) albo pokrycie słów zapytania
  const qTerms = [...new Set(tokens(normKey(q)))];
  const needText = hits.filter((h) => h.cos === null).map((h) => h.id);
  const texts = new Map(
    repo
      .getObservations(needText)
      .map((o) => [o.id, normKey(`${o.title} ${o.subtitle ?? ""} ${o.facts.join(" ")} ${o.concepts.join(" ")}`)]),
  );
  for (const h of hits) {
    h.rel = maxS > 0 ? h.s / maxS : 0;
    if (h.cos !== null) h.conf = calibrateCos(h.cos);
    else {
      const txt = texts.get(h.id) ?? "";
      const covered = qTerms.filter((w) => txt.includes(w.slice(0, Math.max(4, Math.ceil(w.length * 0.72))))).length;
      h.conf = qTerms.length ? (covered / qTerms.length) * 0.85 : 0;
    }
  }
  lap("rank");
  return hits.slice(0, limit).map(({ s: _s, ...h }) => h);
}

/** bge-m3: cos ~0.35 = szum, ~0.55 = luźny związek, ≥0.7 = mocne dopasowanie → mapowanie na 0..1. */
export function calibrateCos(cos: number): number {
  return Math.max(0, Math.min(1, (cos - 0.35) / 0.4));
}

export function loadHits(repo: Repo, hits: Hit[]): { hit: Hit; obs: Observation }[] {
  const obs = new Map(repo.getObservations(hits.map((h) => h.id)).map((o) => [o.id, o]));
  return hits.filter((h) => obs.has(h.id)).map((h) => ({ hit: h, obs: obs.get(h.id)! }));
}
