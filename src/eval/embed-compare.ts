// Porównanie modeli wektorów na przypadkach z `hipokamp eval` (T-04). Tu tylko logika bez modeli i bez sieci:
// wybór próbki (te same notatki i zapytania dla każdego modelu), ranking jak w produkcji (int8 + opcjonalny prefiltr
// binarny), metryki, bootstrap. Liczenie wektorów i pomiary czasu i pamięci robi spikes/embed-eval.ts.
//
// Definicja przypadku jest ta z eval.ts (zapytanie = pierwszy prompt sesji, kandydaci = notatki projektu sprzed startu
// sesji, trafne = notatki o plikach zmienionych w sesji). Próbka bierze z niej tylko te przypadki, których pula nie
// przekracza `maxPool` notatek: pula i zbiór trafnych są dokładnie takie jak w `hipokamp eval`, nic nie jest
// dolosowywane ani wycinane, a liczba notatek do przeliczenia dla każdego modelu jest ograniczona.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { EmbedConfig } from "../config.ts";
import { rowToObservation } from "../db/repo.ts";
import { passageText, toBits, toQ8 } from "../index/embedder.ts";
import { ftsSearch } from "../index/fts.ts";
import { dotQ8 } from "../index/vectors.ts";
import { type Case, relevant } from "./eval.ts";

// ---------- modele ----------

export interface ModelSpec {
  key: string;
  label: string;
  /** Id w Hugging Face (transformers.js). */
  model: string;
  dims: number;
  pooling: "cls" | "mean";
  queryPrefix: string;
  passagePrefix: string;
  license: string;
  params: string;
}

/** Kandydaci T-04. Prefiksy i pooling z kart modeli: e5 `query: ` / `passage: ` + średnia, arctic `query: ` tylko przy zapytaniach + CLS. */
export const MODELS: ModelSpec[] = [
  {
    key: "bge-m3",
    label: "bge-m3 (obecny)",
    model: "Xenova/bge-m3",
    dims: 1024,
    pooling: "cls",
    queryPrefix: "",
    passagePrefix: "",
    license: "MIT",
    params: "568M",
  },
  {
    key: "arctic-m-v2",
    label: "snowflake-arctic-embed-m-v2.0",
    model: "Snowflake/snowflake-arctic-embed-m-v2.0",
    dims: 768,
    pooling: "cls",
    queryPrefix: "query: ",
    passagePrefix: "",
    license: "Apache-2.0",
    params: "305M",
  },
  {
    key: "e5-base",
    label: "multilingual-e5-base",
    model: "Xenova/multilingual-e5-base",
    dims: 768,
    pooling: "mean",
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    license: "MIT",
    params: "278M",
  },
  {
    key: "e5-small",
    label: "multilingual-e5-small",
    model: "Xenova/multilingual-e5-small",
    dims: 384,
    pooling: "mean",
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    license: "MIT",
    params: "118M",
  },
];

export function modelSpec(key: string): ModelSpec {
  const m = MODELS.find((x) => x.key === key);
  if (!m) throw new Error(`nieznany model „${key}” (dostępne: ${MODELS.map((x) => x.key).join(", ")})`);
  return m;
}

/** Konfiguracja embeddera dla modelu z listy: reszta (urządzenie, partie) z bazowej, żeby liczyć jak produkcja. */
export function embedConfigFor(spec: ModelSpec, base: EmbedConfig): EmbedConfig {
  return {
    ...base,
    model: spec.model,
    dims: spec.dims,
    pooling: spec.pooling,
    queryPrefix: spec.queryPrefix,
    passagePrefix: spec.passagePrefix,
  };
}

// ---------- próbka ----------

export interface SampleNote {
  id: number;
  project: string;
  /** Tekst do embeddingu, dokładnie ten co w produkcji (passageText). */
  text: string;
}

export interface SampleCase {
  sessionId: string;
  project: string;
  startedAt: number;
  /** Zapytanie już obcięte jak w eval.ts (1500 znaków). */
  query: string;
  /** Pula (notatki projektu sprzed startu, bez scalonych), od najnowszych jak w eval.ts. */
  poolIds: number[];
  relIds: number[];
  /** Ranking FTS5 (do 200) po puli: składnik hybrydy, taki sam dla każdego modelu. */
  ftsIds: number[];
}

export interface SampleOptions {
  /** Największa pula przypadku (liczba notatek projektu sprzed startu sesji). */
  maxPool: number;
  /** Budżet notatek do przeliczenia (suma po projektach). */
  maxNotes: number;
  maxCasesPerProject: number;
  /** Projekt z mniejszą liczbą przypadków pod limitem puli jest pomijany (za mało na średnią projektu). */
  minCasesPerProject: number;
  seed: number;
}

export interface Sample {
  options: SampleOptions;
  notes: SampleNote[];
  cases: SampleCase[];
  /** Skrót treści (notatki, zapytania, pule, trafne, FTS): dowód, że każdy model dostał to samo. */
  hash: string;
}

export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (hi > lo) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Wybiera próbkę z przypadków `buildCases`. SQL tylko do odczytu (jak eval.ts: ten moduł jest narzędziem benchmarku,
 * nie ścieżką zapisu): rozmiary pul z samych czasów, pełne wiersze tylko dla projektów i notatek, które trafiają do próbki.
 */
export function selectSample(db: Database, cases: Case[], opts: SampleOptions): Sample {
  const rnd = seeded(opts.seed);
  const byProject = new Map<string, Case[]>();
  for (const c of cases) {
    const k = c.project.toLowerCase();
    const a = byProject.get(k);
    if (a) a.push(c);
    else byProject.set(k, [c]);
  }

  interface Cand {
    c: Case;
    prior: number;
    rel: number[];
  }
  interface Proj {
    name: string;
    pool: ReturnType<typeof rowToObservation>[];
    cands: Cand[];
  }
  const projects: Proj[] = [];
  for (const name of [...byProject.keys()].sort()) {
    const pcases = byProject.get(name)!;
    const times = (
      db
        .query("SELECT created_at FROM observations WHERE project = ? COLLATE NOCASE AND status != 'merged' ORDER BY created_at")
        .all(pcases[0].project) as { created_at: number }[]
    ).map((r) => r.created_at);
    const under = pcases
      .map((c) => ({ c, prior: lowerBound(times, c.startedAt) }))
      .filter((x) => x.prior >= 1 && x.prior <= opts.maxPool);
    if (under.length < opts.minCasesPerProject) continue;
    const lastStart = Math.max(...under.map((x) => x.c.startedAt));
    const pool = (
      db
        .query(
          "SELECT * FROM observations WHERE project = ? COLLATE NOCASE AND created_at < ? AND status != 'merged' ORDER BY created_at DESC LIMIT 20000",
        )
        .all(pcases[0].project, lastStart) as any[]
    ).map(rowToObservation);
    const cands: Cand[] = [];
    for (const x of under) {
      // jak eval.ts: pusty zbiór trafnych = przypadek pomijany
      const rel = pool.filter((o) => o.created_at < x.c.startedAt && relevant(o, x.c.targetFiles)).map((o) => o.id);
      if (rel.length) cands.push({ ...x, rel });
    }
    if (cands.length >= opts.minCasesPerProject) projects.push({ name, pool, cands });
  }

  // projekty od najwyższej liczby przypadków; w projekcie losowy (ziarno) podzbiór, przycinany od największych pul, aż mieści się w budżecie
  projects.sort((a, b) => b.cands.length - a.cands.length || (a.name < b.name ? -1 : 1));
  const chosen: { proj: Proj; picked: Cand[] }[] = [];
  let total = 0;
  for (const proj of projects) {
    const shuffled = [...proj.cands];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let picked = shuffled.slice(0, opts.maxCasesPerProject);
    const need = () => Math.max(...picked.map((x) => x.prior));
    while (picked.length >= opts.minCasesPerProject && total + need() > opts.maxNotes) {
      const maxPrior = need();
      const drop = picked.findIndex((x) => x.prior === maxPrior);
      picked = picked.filter((_, i) => i !== drop);
    }
    if (picked.length < opts.minCasesPerProject) continue;
    total += need();
    chosen.push({ proj, picked });
  }

  const noteMap = new Map<number, SampleNote>();
  const out: SampleCase[] = [];
  for (const { proj, picked } of chosen) {
    const ordered = [...picked].sort((a, b) => a.c.startedAt - b.c.startedAt);
    for (const x of ordered) {
      const pool = proj.pool.filter((o) => o.created_at < x.c.startedAt);
      for (const o of pool) if (!noteMap.has(o.id)) noteMap.set(o.id, { id: o.id, project: proj.name, text: passageText(o) });
      const inPool = new Set(pool.map((o) => o.id));
      const fts = ftsSearch(db, x.c.query, { project: x.c.project, until: x.c.startedAt - 1, limit: 200 }).filter((h) =>
        inPool.has(h.id),
      );
      out.push({
        sessionId: x.c.sessionId,
        project: proj.name,
        startedAt: x.c.startedAt,
        query: x.c.query.slice(0, 1500),
        poolIds: pool.map((o) => o.id),
        relIds: x.rel,
        ftsIds: fts.map((h) => h.id),
      });
    }
  }
  const notes = [...noteMap.values()].sort((a, b) => a.id - b.id);
  return { options: opts, notes, cases: out, hash: sampleHash(notes, out) };
}

export function sampleHash(notes: SampleNote[], cases: SampleCase[]): string {
  const h = createHash("sha256");
  for (const n of notes) h.update(`${n.id}\u0000${n.text}\u0001`);
  for (const c of cases)
    h.update(
      `${c.sessionId}\u0000${c.query}\u0000${c.poolIds.join(",")}\u0000${c.relIds.join(",")}\u0000${c.ftsIds.join(",")}\u0001`,
    );
  return h.digest("hex");
}

// ---------- wektory i ranking ----------

/** Pierwsze `dims` współrzędnych i ponowna norma L2 (Matryoshka: arctic-m-v2 ma być użyteczny przy 256). */
export function truncateNormalize(v: Float32Array, dims: number): Float32Array {
  const t = v.slice(0, dims);
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i] * t[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < t.length; i++) t[i] /= n;
  return t;
}

/** Wektor notatki tak, jak leży w bazie: int8 (skala 127) i bity znaku (prefiltr sqlite-vec). */
export interface StoredVec {
  q8: Int8Array;
  bits: Uint8Array;
  f32?: Float32Array;
}

export function storeVector(v: Float32Array): StoredVec {
  return { q8: toQ8(v), bits: toBits(v), f32: v };
}

const POP = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POP[i] = POP[i >> 1] + (i & 1);

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += POP[a[i] ^ b[i]];
  return d;
}

export type Quant = "q8" | "f32" | "bits";

export interface KMetrics {
  hit5: number;
  hit10: number;
  rec5: number;
  rec10: number;
  ndcg10: number;
  mrr10: number;
}

/** Metryki jednego rankingu: te same wzory co `metrics` w eval.ts (hit, recall = trafienia / min(k, |trafne|), nDCG), plus MRR@10. */
export function rankMetrics(ranked: number[], rel: Set<number>): KMetrics {
  const at = (k: number) => {
    const top = ranked.slice(0, k);
    const hits = top.filter((id) => rel.has(id)).length;
    let dcg = 0;
    top.forEach((id, i) => {
      if (rel.has(id)) dcg += 1 / Math.log2(i + 2);
    });
    let idcg = 0;
    for (let i = 0; i < Math.min(k, rel.size); i++) idcg += 1 / Math.log2(i + 2);
    return { hit: hits > 0 ? 1 : 0, rec: rel.size ? hits / Math.min(k, rel.size) : 0, ndcg: idcg ? dcg / idcg : 0 };
  };
  const a5 = at(5);
  const a10 = at(10);
  const first = ranked.slice(0, 10).findIndex((id) => rel.has(id));
  return {
    hit5: a5.hit,
    hit10: a10.hit,
    rec5: a5.rec,
    rec10: a10.rec,
    ndcg10: a10.ndcg,
    mrr10: first >= 0 ? 1 / (first + 1) : 0,
  };
}

/**
 * Wartość oczekiwana metryk dla losowej kolejności puli (N notatek, R trafnych): pokazuje, ile z wyniku daje sam
 * rozmiar zbioru trafnych (w `hipokamp eval` trafnych jest zwykle kilkanaście procent puli, więc hit@5 szybko nasyca się).
 */
export function randomBaseline(poolSize: number, relSize: number): KMetrics {
  const N = poolSize;
  const R = Math.min(relSize, N);
  // prawdopodobieństwo, że pierwsze k pozycji nie zawiera trafnej
  const miss = (k: number) => {
    let p = 1;
    for (let i = 0; i < k; i++) p *= Math.max(0, N - R - i) / (N - i);
    return p;
  };
  const dcg = (k: number) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += 1 / Math.log2(i + 2);
    return (R / N) * s;
  };
  const idcg = (k: number) => {
    let s = 0;
    for (let i = 0; i < Math.min(k, R); i++) s += 1 / Math.log2(i + 2);
    return s;
  };
  let mrr = 0;
  for (let i = 1; i <= 10; i++) mrr += (miss(i - 1) * R) / (N - i + 1) / i;
  return {
    hit5: 1 - miss(5),
    hit10: 1 - miss(10),
    rec5: R ? (5 * R) / N / Math.min(5, R) : 0,
    rec10: R ? (10 * R) / N / Math.min(10, R) : 0,
    ndcg10: idcg(10) ? dcg(10) / idcg(10) : 0,
    mrr10: mrr,
  };
}

export interface CaseResult {
  sessionId: string;
  project: string;
  vector: KMetrics;
  hybrid: KMetrics;
}

/** Ilu kandydatów z prefiltru binarnego: jak `vectorSearch` przy limicie 20 (pula 80, nadpróbkowanie 8). */
export const BITS_CANDIDATES = 640;
const RRF_K = 60;

/**
 * Ranking wektorowy puli przypadku. `q8`: brute force po int8 jak `hipokamp eval`; `f32`: dokładny iloczyn
 * skalarny (bez kwantyzacji); `bits`: prefiltr Hamminga do `BITS_CANDIDATES`, potem int8, jak `vectorSearch` w produkcji.
 */
export function rankPool(poolIds: number[], vecs: Map<number, StoredVec>, q: Float32Array, quant: Quant): number[] {
  const have = poolIds.filter((id) => vecs.has(id));
  if (quant === "bits") {
    const qb = toBits(q);
    const cand = have
      .map((id) => ({ id, d: hamming(vecs.get(id)!.bits, qb) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, BITS_CANDIDATES);
    return cand
      .map((x) => ({ id: x.id, s: dotQ8(vecs.get(x.id)!.q8, q) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.id);
  }
  const score =
    quant === "q8"
      ? (id: number) => dotQ8(vecs.get(id)!.q8, q)
      : (id: number) => {
          const f = vecs.get(id)!.f32!;
          let s = 0;
          for (let i = 0; i < f.length; i++) s += f[i] * q[i];
          return s;
        };
  return have
    .map((id) => ({ id, s: score(id) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.id);
}

/** Hybryda jak w eval.ts (krok 4): RRF listy FTS i listy wektorowej (po 200), kolejność wstawiania rozstrzyga remisy. */
export function hybridRank(ftsIds: number[], vecIds: number[]): number[] {
  const rrf = new Map<number, number>();
  for (const list of [ftsIds.slice(0, 200), vecIds.slice(0, 200)])
    list.forEach((id, i) => {
      rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + 1 + i));
    });
  return [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function scoreCases(sample: Sample, vecs: Map<number, StoredVec>, queries: Float32Array[], quant: Quant): CaseResult[] {
  if (queries.length !== sample.cases.length) throw new Error("liczba wektorów zapytań różni się od liczby przypadków");
  return sample.cases.map((c, i) => {
    const rel = new Set(c.relIds);
    const vecIds = rankPool(c.poolIds, vecs, queries[i], quant);
    return {
      sessionId: c.sessionId,
      project: c.project,
      vector: rankMetrics(vecIds, rel),
      hybrid: rankMetrics(hybridRank(c.ftsIds, vecIds), rel),
    };
  });
}

// ---------- agregacja i statystyka ----------

export function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

/** Średnia po przypadkach (jak `hipokamp eval`) i średnia po projektach (każdy projekt tyle samo). */
export function aggregate(
  results: CaseResult[],
  pick: (r: CaseResult) => number,
): { micro: number; macro: number; perProject: Map<string, { n: number; value: number }> } {
  const per = new Map<string, number[]>();
  for (const r of results) {
    const a = per.get(r.project);
    if (a) a.push(pick(r));
    else per.set(r.project, [pick(r)]);
  }
  const perProject = new Map([...per.entries()].map(([p, a]) => [p, { n: a.length, value: mean(a) }]));
  return { micro: mean(results.map(pick)), macro: mean([...perProject.values()].map((x) => x.value)), perProject };
}

/** Różnica średnich (other − base) po tych samych przypadkach i 95% przedział percentylowy z losowania przypadków ze zwracaniem. */
export function pairedBootstrap(
  base: number[],
  other: number[],
  opts: { iters?: number; seed?: number } = {},
): { diff: number; lo: number; hi: number } {
  if (base.length !== other.length) throw new Error("pairedBootstrap: różna liczba przypadków");
  const n = base.length;
  const d = base.map((x, i) => other[i] - x);
  const rnd = seeded(opts.seed ?? 1);
  const iters = opts.iters ?? 2000;
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return {
    diff: mean(d),
    lo: means[Math.floor(0.025 * iters)] ?? 0,
    hi: means[Math.min(iters - 1, Math.floor(0.975 * iters))] ?? 0,
  };
}
