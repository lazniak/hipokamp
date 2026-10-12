// Benchmark trafności na danych użytkownika (offline, bez etykiet ręcznych):
// dla sesji S zapytaniem jest jej pierwszy prompt, kandydatami notatki z TEGO projektu sprzed startu S,
// a „trafna” notatka to taka, która dotyczy plików, które S potem zmieniła (proxy przydatności).
// Porównujemy strategie: świeżość (jak domyślny kontekst claude-mem), FTS5 (claude-mem bez Chromy),
// sam wektor, hybryda RRF oraz pełny algorytm hipokampa (hybryda + aktywacja + graf + ważność + MMR).
import { loadConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { Embedder } from "../index/embedder.ts";
import { ftsSearch } from "../index/fts.ts";
import { cosQ8, dotQ8 } from "../index/vectors.ts";
import { activation } from "../recall/activation.ts";
import { calibrateCos } from "../recall/search.ts";
import type { Observation } from "../types.ts";

export interface Case {
  sessionId: string;
  project: string;
  startedAt: number;
  query: string;
  targetFiles: Set<string>;
}

export interface Metrics {
  hit: number;
  recall: number;
  ndcg: number;
  precision: number;
  ms: number;
}

const STRATS = ["recency", "fts", "vector", "hybrid", "hipokamp"] as const;
type Strat = (typeof STRATS)[number];

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

/** Porównanie plików odporne na ścieżki względne/absolutne: ostatnie 2 segmenty. */
export function fileTail(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean).slice(-2).join("/");
}

export function buildCases(repo: Repo, n: number, seed = 7): Case[] {
  const db = repo.db;
  // Notatki projektu sprzed startu sesji: jedna posortowana lista czasów na projekt i wyszukiwanie binarne. Wcześniej
  // podzapytanie z COLLATE NOCASE na każdą sesję przeglądało całą tabelę (indeks po project jest binarny): ponad 5 minut na
  // 114 tys. notatek. Zgodność jak w SQL: lower() w SQLite składa tylko ASCII, tak samo jak NOCASE.
  const times = new Map<string, number[]>();
  for (const r of db
    .query("SELECT lower(project) p, created_at c FROM observations WHERE status != 'merged' ORDER BY created_at")
    .all() as { p: string; c: number }[]) {
    const a = times.get(r.p);
    if (a) a.push(r.c);
    else times.set(r.p, [r.c]);
  }
  const rows = (
    db
      .query(
        `SELECT s.id, s.project, lower(s.project) lp, s.started_at, s.first_prompt
         FROM sessions s WHERE s.first_prompt IS NOT NULL AND length(s.first_prompt) >= 25`,
      )
      .all() as { id: string; project: string; lp: string; started_at: number; first_prompt: string }[]
  ).map((r) => ({ ...r, prior: countBefore(times.get(r.lp), r.started_at) }));
  const cases: Case[] = [];
  for (const r of rows) {
    if (r.prior < 150) continue;
    const files = new Set<string>();
    for (const o of db.query("SELECT files_modified FROM observations WHERE session_id = ?").all(r.id) as {
      files_modified: string;
    }[]) {
      try {
        for (const f of JSON.parse(o.files_modified)) files.add(fileTail(String(f)));
      } catch {}
    }
    if (!files.size) continue;
    cases.push({ sessionId: r.id, project: r.project, startedAt: r.started_at, query: r.first_prompt, targetFiles: files });
  }
  const rnd = seeded(seed);
  for (let i = cases.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }
  return cases.slice(0, n);
}

/** Ile elementów posortowanej listy jest mniejszych od x (wyszukiwanie binarne). */
function countBefore(sorted: number[] | undefined, x: number): number {
  if (!sorted) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (hi > lo) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export function relevant(o: Observation, target: Set<string>): boolean {
  for (const f of [...o.files_modified, ...o.files_read]) if (target.has(fileTail(f))) return true;
  return false;
}

export function metrics(ranked: Observation[], rel: Set<number>, k: number, ms: number): Metrics {
  const top = ranked.slice(0, k);
  const hits = top.filter((o) => rel.has(o.id)).length;
  let dcg = 0;
  top.forEach((o, i) => {
    if (rel.has(o.id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(k, rel.size); i++) idcg += 1 / Math.log2(i + 2);
  return {
    hit: hits > 0 ? 1 : 0,
    recall: rel.size ? hits / Math.min(k, rel.size) : 0,
    ndcg: idcg ? dcg / idcg : 0,
    precision: hits / k,
    ms,
  };
}

export async function runEval(
  repo: Repo,
  opts: { sessions: number; k: number; log: (m: string) => void },
): Promise<Record<Strat, Metrics>> {
  const { log } = opts;
  const k = opts.k;
  const cases = buildCases(repo, opts.sessions);
  log(`benchmark: ${cases.length} sesji (zapytanie = pierwszy prompt, trafne = notatki o plikach, które sesja zmieniła), k=${k}`);
  if (!cases.length) {
    log("za mało danych (potrzebne sesje z historią ≥150 notatek w projekcie). Najpierw import i backfill");
    return {} as any;
  }
  const embedder = new Embedder(loadConfig().embed, "query");
  const sum: Record<Strat, Metrics> = Object.fromEntries(
    STRATS.map((s) => [s, { hit: 0, recall: 0, ndcg: 0, precision: 0, ms: 0 }]),
  ) as any;
  let used = 0;

  for (const c of cases) {
    const pool = (
      repo.db
        .query(
          "SELECT * FROM observations WHERE project = ? COLLATE NOCASE AND created_at < ? AND status != 'merged' ORDER BY created_at DESC LIMIT 20000",
        )
        .all(c.project, c.startedAt) as any[]
    ).map((r) => repo.getObservation(r.id)!);
    const rel = new Set(pool.filter((o) => relevant(o, c.targetFiles)).map((o) => o.id));
    if (!rel.size) continue;
    used++;
    const byId = new Map(pool.map((o) => [o.id, o]));

    // 1. świeżość
    let t = performance.now();
    add(sum.recency, metrics(pool, rel, k, performance.now() - t));

    // 2. FTS (BM25)
    t = performance.now();
    const fts = ftsSearch(repo.db, c.query, { project: c.project, until: c.startedAt - 1, limit: 200 }).filter((h) =>
      byId.has(h.id),
    );
    add(
      sum.fts,
      metrics(
        fts.map((h) => byId.get(h.id)!),
        rel,
        k,
        performance.now() - t,
      ),
    );

    // 3. wektor (dokładny brute force po puli — bez przecieku przyszłości)
    t = performance.now();
    const [qv] = await embedder.embed([c.query.slice(0, 1500)], "query");
    const vecs = repo.getVectorsQ8(pool.map((o) => o.id));
    const vec = pool
      .filter((o) => vecs.has(o.id))
      .map((o) => ({ o, cos: dotQ8(vecs.get(o.id)!, qv) }))
      .sort((a, b) => b.cos - a.cos);
    add(
      sum.vector,
      metrics(
        vec.map((x) => x.o),
        rel,
        k,
        performance.now() - t,
      ),
    );

    // 4. hybryda RRF
    t = performance.now();
    const rrf = new Map<number, number>();
    fts.slice(0, 200).forEach((h, i) => {
      rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (61 + i));
    });
    vec.slice(0, 200).forEach((x, i) => {
      rrf.set(x.o.id, (rrf.get(x.o.id) ?? 0) + 1 / (61 + i));
    });
    const hyb = [...rrf.entries()].sort((a, b) => b[1] - a[1]);
    add(
      sum.hybrid,
      metrics(
        hyb.map(([id]) => byId.get(id)!),
        rel,
        k,
        performance.now() - t,
      ),
    );

    // 5. hipokamp: hybryda + aktywacja (stan na chwilę startu S) + graf z ostatnich sesji + ważność + typ, potem MMR
    t = performance.now();
    const maxR = Math.max(...hyb.map(([, s]) => s), 1e-9);
    const cosMap = new Map(vec.slice(0, 400).map((x) => [x.o.id, x.cos]));
    const recentFiles = new Set(pool.slice(0, 40).flatMap((o) => o.files_modified.map(fileTail)));
    const scored = hyb.slice(0, 300).map(([id, s]) => {
      const o = byId.get(id)!;
      const a = activation(o, [], c.startedAt);
      const sp = [...o.files_modified, ...o.files_read].some((f) => recentFiles.has(fileTail(f))) ? 1 : 0;
      const conf = calibrateCos(cosMap.get(id) ?? 0.35);
      const score = 0.45 * (s / maxR) + 0.15 * conf + 0.15 * a + 0.12 * sp + 0.13 * o.importance;
      return { o, score, v: vecs.get(id) };
    });
    scored.sort((a, b) => b.score - a.score);
    const picked: typeof scored = [];
    while (picked.length < k && scored.length) {
      let bi = 0;
      let bu = -Infinity;
      for (let i = 0; i < Math.min(scored.length, 60); i++) {
        const x = scored[i];
        let ms = 0;
        for (const p of picked) if (x.v && p.v) ms = Math.max(ms, cosQ8(x.v, p.v));
        const u = x.score * (1 - 0.35 * ms);
        if (u > bu) {
          bu = u;
          bi = i;
        }
      }
      picked.push(scored.splice(bi, 1)[0]);
    }
    add(
      sum.hipokamp,
      metrics(
        picked.map((x) => x.o),
        rel,
        k,
        performance.now() - t,
      ),
    );
  }

  log(`\nużyte sesje: ${used}\n`);
  log("strategia   Hit@k   Recall@k   nDCG@k   P@k     ms/zapytanie");
  for (const s of STRATS) {
    const m = sum[s];
    const d = Math.max(1, used);
    log(
      `${s.padEnd(10)}  ${pct(m.hit / d)}   ${pct(m.recall / d)}     ${pct(m.ndcg / d)}   ${pct(m.precision / d)}   ${(m.ms / d).toFixed(1)}`,
    );
  }
  const out = Object.fromEntries(STRATS.map((s) => [s, divide(sum[s], Math.max(1, used))])) as Record<Strat, Metrics>;
  return out;
}

function add(a: Metrics, b: Metrics): void {
  a.hit += b.hit;
  a.recall += b.recall;
  a.ndcg += b.ndcg;
  a.precision += b.precision;
  a.ms += b.ms;
}

function divide(a: Metrics, d: number): Metrics {
  return { hit: a.hit / d, recall: a.recall / d, ndcg: a.ndcg / d, precision: a.precision / d, ms: a.ms / d };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1).padStart(5)}%`;
}

export { basename };
