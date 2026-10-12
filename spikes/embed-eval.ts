// Spike (T-04): porównanie modeli wektorów na przypadkach z `hipokamp eval`: jakość (hit@5/10, recall, nDCG, MRR),
// czas liczenia (GPU DirectML i CPU), rozmiar modelu i wektora, szczyt RAM.
//
// Wszystko na KOPII danych: HIPOKAMP_HOME musi wskazywać katalog z „hipokamp-test” w nazwie, z kopią bazy
// (hipokamp.db, np. VACUUM INTO z połączenia tylko do odczytu). Modele lądują w <HIPOKAMP_HOME>/models, więc prawdziwy
// katalog modeli nie jest ruszany. Pierwsze użycie modelu pobiera go z Hugging Face (jednorazowo).
//
//   bun spikes/embed-eval.ts prepare [--max-pool 2000] [--max-notes 10000] [--per-project 30] [--min-cases 3] [--seed 7]
//   bun spikes/embed-eval.ts embed <model> [--bulk-device dml] [--bulk-dtype fp16] [--allow-fallback]
//   bun spikes/embed-eval.ts cpu <model> [--notes 192] [--queries 30] [--reps 3]
//   bun spikes/embed-eval.ts check <model> [--notes 24]    (ścieżka kubełkowa kontra pipeline, CPU q8)
//   bun spikes/embed-eval.ts score [model ...]
//
// Modele: bge-m3, arctic-m-v2, e5-base, e5-small (src/eval/embed-compare.ts). Każdy model liczy się w osobnym procesie
// (szczyt RAM), jeden naraz, z tą samą próbką (skrót w wynikach: ten sam dla wszystkich).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadConfig, paths } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { Repo } from "../src/db/repo.ts";
import {
  type CaseResult,
  MODELS,
  type Quant,
  type Sample,
  type StoredVec,
  aggregate,
  embedConfigFor,
  mean,
  modelSpec,
  pairedBootstrap,
  randomBaseline,
  rankMetrics,
  scoreCases,
  seeded,
  selectSample,
  storeVector,
  truncateNormalize,
} from "../src/eval/embed-compare.ts";
import { buildCases } from "../src/eval/eval.ts";
import { CPU_CHUNK_CHARS, type ChunkJob, chunkSize } from "../src/index/embed-chunks.ts";
import { Embedder, toBits } from "../src/index/embedder.ts";

if (!DATA_DIR.includes("hipokamp-test")) throw new Error("embed-eval: HIPOKAMP_HOME musi wskazywać katalog z „hipokamp-test” w nazwie (kopia danych)");
const WORK = join(DATA_DIR, "embed-compare");
mkdirSync(WORK, { recursive: true });
const [cmd = "", ...rest] = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : def;
};
const has = (name: string): boolean => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--") && rest[i - 1] !== "--allow-fallback"));
const MB = 1e6;

const samplePath = () => join(WORK, "sample.json");
const loadSample = (): Sample => JSON.parse(readFileSync(samplePath(), "utf8")) as Sample;

/** Szczyt RSS procesu: próbkowanie co 100 ms (między partiami) i licznik systemu, jeśli runtime go podaje. */
function peakTracker() {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 100);
  return {
    peak(): number {
      peak = Math.max(peak, process.memoryUsage().rss);
      try {
        const ru = (process as any).resourceUsage?.();
        if (ru?.maxRSS) peak = Math.max(peak, ru.maxRSS * 1024 > 1e12 ? ru.maxRSS : ru.maxRSS * 1024);
      } catch {}
      return peak;
    },
    stop() {
      clearInterval(t);
    },
  };
}

/** Pliki modelu w pamięci podręcznej dla danego dtype (rozmiar na dysku). */
function modelFiles(model: string, dtype: string): { file: string; bytes: number }[] {
  const dir = join(paths.models(), ...model.split("/"), "onnx");
  const stem = dtype === "fp32" ? "model" : dtype === "q8" ? "model_quantized" : `model_${dtype}`;
  const out: { file: string; bytes: number }[] = [];
  for (const f of [`${stem}.onnx`, `${stem}.onnx_data`]) {
    const p = join(dir, f);
    if (existsSync(p)) out.push({ file: f, bytes: statSync(p).size });
  }
  return out;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

// ---------- prepare ----------

function prepare(): void {
  const db = openDb({ path: join(DATA_DIR, "hipokamp.db"), readonly: true });
  try {
    const repo = new Repo(db);
    let t = performance.now();
    const all = buildCases(repo, 1e9);
    console.log(`przypadki eval: ${all.length} w ${Math.round(performance.now() - t)} ms`);
    t = performance.now();
    const sample = selectSample(db, all, {
      maxPool: Number(flag("max-pool", "2000")),
      maxNotes: Number(flag("max-notes", "10000")),
      maxCasesPerProject: Number(flag("per-project", "30")),
      minCasesPerProject: Number(flag("min-cases", "3")),
      seed: Number(flag("seed", "7")),
    });
    writeFileSync(samplePath(), JSON.stringify(sample));
    const per = new Map<string, { cases: number; maxPool: number; rel: number[] }>();
    for (const c of sample.cases) {
      const e = per.get(c.project) ?? { cases: 0, maxPool: 0, rel: [] };
      e.cases++;
      e.maxPool = Math.max(e.maxPool, c.poolIds.length);
      e.rel.push(c.relIds.length);
      per.set(c.project, e);
    }
    console.log(`próbka: ${sample.cases.length} przypadków, ${sample.notes.length} notatek, ${per.size} projektów, skrót ${sample.hash.slice(0, 16)} (${Math.round(performance.now() - t)} ms)`);
    for (const [p, e] of [...per.entries()].sort((a, b) => b[1].cases - a[1].cases))
      console.log(`  ${p}: przypadków ${e.cases}, największa pula ${e.maxPool}, trafnych mediana ${pct(e.rel, 0.5)}`);
    const pools = sample.cases.map((c) => c.poolIds.length);
    const rels = sample.cases.map((c) => c.relIds.length);
    console.log(`pula: mediana ${pct(pools, 0.5)}, p90 ${pct(pools, 0.9)}; trafnych: mediana ${pct(rels, 0.5)}, p90 ${pct(rels, 0.9)}; trafne/pula mediana ${(pct(sample.cases.map((c) => c.relIds.length / c.poolIds.length), 0.5) * 100).toFixed(1)}%`);
    const lens = sample.notes.map((n) => n.text.length);
    console.log(`teksty notatek (znaki): mediana ${pct(lens, 0.5)}, p90 ${pct(lens, 0.9)}; zapytań: mediana ${pct(sample.cases.map((c) => c.query.length), 0.5)}`);
  } finally {
    db.close();
  }
}

// ---------- embed ----------

async function embed(): Promise<void> {
  const key = positional[0];
  const spec = modelSpec(key);
  const sample = loadSample();
  const base = loadConfig().embed;
  const cfg = {
    ...embedConfigFor(spec, base),
    bulkDevice: flag("bulk-device", base.bulkDevice),
    bulkDtype: flag("bulk-dtype", base.bulkDtype),
    device: flag("query-device", base.device),
    dtype: flag("query-dtype", base.dtype),
  };
  const tracker = peakTracker();
  console.log(`${key}: ${spec.model}, masowo ${cfg.bulkDevice}/${cfg.bulkDtype}, zapytania ${cfg.device}/${cfg.dtype}, notatek ${sample.notes.length}, zapytań ${sample.cases.length}`);

  const bulk = new Embedder(cfg, "bulk");
  let t = performance.now();
  await bulk.ready();
  const loadMs = performance.now() - t;
  const used = { device: bulk.device, dtype: bulk.dtype };
  if (!has("allow-fallback") && (used.device !== cfg.bulkDevice || used.dtype !== cfg.bulkDtype))
    throw new Error(`model przeszedł na ${used.device}/${used.dtype} zamiast ${cfg.bulkDevice}/${cfg.bulkDtype} (--allow-fallback, jeśli to zamierzone)`);

  // kolejność jak w produkcji: od najkrótszych tekstów, partie po bulkBatch
  const order = sample.notes.map((_, i) => i).sort((a, b) => sample.notes[a].text.length - sample.notes[b].text.length);
  const bs = cfg.bulkBatch;
  // rozgrzewka: plan DirectML liczy się raz na kształt (kubełek 128/256/512), więc kilka pełnych partii z różnych długości
  t = performance.now();
  for (const p of [0.05, 0.3, 0.6, 0.9, 0.99]) {
    const at = Math.min(order.length - bs, Math.floor(p * order.length));
    await bulk.embed(order.slice(Math.max(0, at), Math.max(0, at) + bs).map((i) => sample.notes[i].text), "passage");
  }
  const warmupMs = performance.now() - t;

  const noteVecs: Float32Array[] = new Array(sample.notes.length);
  t = performance.now();
  const batchMs: number[] = [];
  for (let i = 0; i < order.length; i += bs) {
    const idx = order.slice(i, i + bs);
    const t1 = performance.now();
    const vs = await bulk.embed(idx.map((j) => sample.notes[j].text), "passage");
    batchMs.push(performance.now() - t1);
    idx.forEach((j, b) => {
      noteVecs[j] = vs[b];
    });
    if ((i / bs) % 20 === 0) {
      console.log(`  ${Math.min(order.length, i + bs)}/${order.length} notatek, ${((performance.now() - t) / 1000).toFixed(0)} s`);
    }
  }
  const bulkMs = performance.now() - t;
  const rssAfterBulk = tracker.peak();
  console.log(`notatki: ${(sample.notes.length / (bulkMs / 1000)).toFixed(1)} /s (${(bulkMs / 1000).toFixed(0)} s), rozgrzewka ${(warmupMs / 1000).toFixed(1)} s, ładowanie ${(loadMs / 1000).toFixed(1)} s`);

  // zapytania: jak produkcja (model zapytań, CPU q8), a dodatkowo tym samym modelem co notatki (spójność dtype)
  const qTexts = sample.cases.map((c) => c.query);
  t = performance.now();
  const qBulk: Float32Array[] = [];
  for (let i = 0; i < qTexts.length; i += bs) qBulk.push(...(await bulk.embed(qTexts.slice(i, i + bs), "query")));
  const qBulkMs = performance.now() - t;
  await bulk.dispose();

  const qEmb = new Embedder(cfg, "query");
  t = performance.now();
  await qEmb.ready();
  const qLoadMs = performance.now() - t;
  t = performance.now();
  const qVecs: Float32Array[] = [];
  // po jednym zapytaniu, jak produkcja (bez dopełniania do najdłuższego w partii: arctic jest wrażliwy na dopełnienie)
  for (const q of qTexts) qVecs.push(...(await qEmb.embed([q], "query")));
  const qMs = performance.now() - t;
  const queryUsed = { device: qEmb.device, dtype: qEmb.dtype };
  await qEmb.dispose();
  const peakRss = tracker.peak();
  tracker.stop();

  const dims = noteVecs[0].length;
  const buf = new Float32Array((noteVecs.length + qVecs.length + qBulk.length) * dims);
  [...noteVecs, ...qVecs, ...qBulk].forEach((v, i) => buf.set(v, i * dims));
  writeFileSync(join(WORK, `vec-${key}.f32`), new Uint8Array(buf.buffer));
  const meta = {
    key,
    model: spec.model,
    dims,
    sampleHash: sample.hash,
    notes: sample.notes.length,
    queries: sample.cases.length,
    bulk: used,
    query: queryUsed,
    loadMs: Math.round(loadMs),
    warmupMs: Math.round(warmupMs),
    bulkMs: Math.round(bulkMs),
    notesPerSec: +(sample.notes.length / (bulkMs / 1000)).toFixed(2),
    batchMsMedian: Math.round(pct(batchMs, 0.5)),
    queryLoadMs: Math.round(qLoadMs),
    queriesMs: Math.round(qMs),
    queriesBulkMs: Math.round(qBulkMs),
    rssAfterBulkMB: Math.round(rssAfterBulk / MB),
    peakRssMB: Math.round(peakRss / MB),
    files: { bulk: modelFiles(spec.model, used.dtype), query: modelFiles(spec.model, queryUsed.dtype) },
    at: new Date().toISOString(),
  };
  writeFileSync(join(WORK, `embed-${key}.json`), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
}

// ---------- cpu ----------

async function cpuBench(): Promise<void> {
  const key = positional[0];
  const spec = modelSpec(key);
  const sample = loadSample();
  const base = loadConfig().embed;
  const cfg = { ...embedConfigFor(spec, base), bulkDevice: "cpu", bulkDtype: "q8", device: "cpu", dtype: "q8" };
  const nNotes = Number(flag("notes", "192"));
  const nQ = Number(flag("queries", "30"));
  const reps = Number(flag("reps", "3"));
  const tracker = peakTracker();

  // te same notatki dla każdego modelu (ziarno stałe, nie zależy od modelu)
  const rnd = seeded(11);
  const idx = sample.notes.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const texts = idx.slice(0, nNotes).map((i) => sample.notes[i].text);

  const bulk = new Embedder(cfg, "bulk");
  let t = performance.now();
  await bulk.ready();
  const loadMs = performance.now() - t;
  const run = async (): Promise<number> => {
    // jak wątek embeddingów workera na CPU: od najkrótszych, kawałki po budżecie znaków (CPU_CHUNK_CHARS)
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    const job: ChunkJob = { texts, kind: "passage", mode: "bulk", order, next: 0 };
    const t0 = performance.now();
    while (job.next < order.length) {
      const n = chunkSize(job, "cpu", cfg.bulkBatch);
      await bulk.embed(order.slice(job.next, job.next + n).map((i) => texts[i]), "passage");
      job.next += n;
    }
    return performance.now() - t0;
  };
  await run(); // rozgrzewka
  const times: number[] = [];
  for (let r = 0; r < reps; r++) times.push(await run());
  await bulk.dispose();
  const bulkMedianMs = pct(times, 0.5);

  const q = new Embedder(cfg, "query");
  t = performance.now();
  await q.ready();
  const qLoadMs = performance.now() - t;
  const qs = sample.cases.slice(0, nQ).map((c) => c.query);
  await q.embed([qs[0] + " rozgrzewka"], "query");
  const lat: number[] = [];
  for (const s of qs) {
    const t0 = performance.now();
    await q.embed([s], "query");
    lat.push(performance.now() - t0);
  }
  await q.dispose();
  const peak = tracker.peak();
  tracker.stop();
  const meta = {
    key,
    device: "cpu/q8",
    notes: texts.length,
    chars: Math.round(mean(texts.map((x) => x.length))),
    cpuChunkChars: CPU_CHUNK_CHARS,
    loadMs: Math.round(loadMs),
    repsMs: times.map(Math.round),
    notesPerSec: +(texts.length / (bulkMedianMs / 1000)).toFixed(2),
    queryLoadMs: Math.round(qLoadMs),
    queryP50Ms: +pct(lat, 0.5).toFixed(1),
    queryP95Ms: +pct(lat, 0.95).toFixed(1),
    peakRssMB: Math.round(peak / MB),
    files: modelFiles(spec.model, "q8"),
    at: new Date().toISOString(),
  };
  writeFileSync(join(WORK, `cpu-${key}.json`), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
}

// ---------- check ----------

/** Zgodność ścieżek: kubełkowa (masowa, poolHidden) kontra pipeline transformers.js na CPU q8, ten sam model i teksty. */
async function check(): Promise<void> {
  const key = positional[0];
  const spec = modelSpec(key);
  const sample = loadSample();
  const base = loadConfig().embed;
  const cfg = { ...embedConfigFor(spec, base), bulkDevice: "cpu", bulkDtype: "q8", device: "cpu", dtype: "q8" };
  const texts = sample.notes.slice(0, Number(flag("notes", "24"))).map((n) => n.text);
  const bulk = new Embedder(cfg, "bulk");
  const a = await bulk.embed(texts, "passage");
  await bulk.dispose();
  const pipe = new Embedder(cfg, "query");
  const b = await pipe.embed(texts, "passage");
  await pipe.dispose();
  const cos = a.map((v, i) => v.reduce((s, x, j) => s + x * b[i][j], 0));
  console.log(`${key}: ścieżka kubełkowa vs pipeline, ${texts.length} notatek: cosinus min ${Math.min(...cos).toFixed(5)}, średnio ${mean(cos).toFixed(5)}`);
}

// ---------- score ----------

interface EmbedMeta {
  key: string;
  dims: number;
  sampleHash: string;
  bulk: { device: string; dtype: string };
  query: { device: string; dtype: string };
  loadMs: number;
  notesPerSec: number;
  rssAfterBulkMB: number;
  peakRssMB: number;
  files: { bulk: { file: string; bytes: number }[]; query: { file: string; bytes: number }[] };
}

function readVectors(key: string, sample: Sample): { notes: Float32Array[]; queries: Float32Array[]; queriesBulk: Float32Array[]; meta: EmbedMeta } {
  const meta = JSON.parse(readFileSync(join(WORK, `embed-${key}.json`), "utf8")) as EmbedMeta;
  if (meta.sampleHash !== sample.hash) throw new Error(`${key}: wektory liczone na innej próbce (${meta.sampleHash.slice(0, 12)} ≠ ${sample.hash.slice(0, 12)})`);
  const raw = readFileSync(join(WORK, `vec-${key}.f32`));
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const d = meta.dims;
  const cut = (from: number, n: number) => Array.from({ length: n }, (_, i) => all.slice((from + i) * d, (from + i + 1) * d));
  const nN = sample.notes.length;
  const nQ = sample.cases.length;
  return { notes: cut(0, nN), queries: cut(nN, nQ), queriesBulk: cut(nN + nQ, nQ), meta };
}

const f1 = (x: number) => (x * 100).toFixed(1);
const sign = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(1);

function score(): void {
  const sample = loadSample();
  const keys = (positional.length ? positional : MODELS.map((m) => m.key)).filter((k) => existsSync(join(WORK, `embed-${k}.json`)));
  if (!keys.length) throw new Error("brak wyników `embed`");
  const ids = sample.notes.map((n) => n.id);

  interface Variant {
    name: string;
    dims: number;
    vector: Map<Quant, CaseResult[]>;
    notesVec: Map<number, StoredVec>;
    queries: Float32Array[];
  }
  const variants: Variant[] = [];
  const fullRobust = ["q8", "f32", "bits"] as Quant[];
  const mk = (name: string, notes: Float32Array[], queries: Float32Array[], quants: Quant[]): Variant => {
    const m = new Map<number, StoredVec>();
    ids.forEach((id, i) => m.set(id, storeVector(notes[i])));
    return { name, dims: notes[0].length, vector: new Map(quants.map((q) => [q, scoreCases(sample, m, queries, q)])), notesVec: m, queries };
  };
  const metas = new Map<string, EmbedMeta>();
  for (const k of keys) {
    const v = readVectors(k, sample);
    metas.set(k, v.meta);
    variants.push(mk(k, v.notes, v.queries, fullRobust));
    variants.push(mk(`${k} (zapytania ${v.meta.bulk.dtype}/${v.meta.bulk.device})`, v.notes, v.queriesBulk, ["q8"]));
    if (k === "arctic-m-v2") {
      variants.push(mk("arctic-m-v2 MRL 256", v.notes.map((x) => truncateNormalize(x, 256)), v.queries.map((x) => truncateNormalize(x, 256)), fullRobust));
    }
  }

  // kontrola ścieżki: wektory bge-m3 z bazy (policzone przez produkcję) i zapytania z tego samego modelu zapytań
  let storedCheck = "";
  if (keys.includes("bge-m3")) {
    const db = openDb({ path: join(DATA_DIR, "hipokamp.db"), readonly: true });
    try {
      const repo = new Repo(db);
      const q8 = repo.getVectorsQ8(ids);
      const v = readVectors("bge-m3", sample);
      const m = new Map<number, StoredVec>();
      let cosSum = 0;
      let cosMin = 1;
      let n = 0;
      ids.forEach((id, i) => {
        const s = q8.get(id);
        if (!s) return;
        m.set(id, { q8: s, bits: toBits(s) });
        const f = v.notes[i];
        let dot = 0;
        let na = 0;
        for (let j = 0; j < f.length; j++) {
          dot += (s[j] / 127) * f[j];
          na += (s[j] / 127) ** 2;
        }
        const c = dot / Math.sqrt(na || 1);
        cosSum += c;
        cosMin = Math.min(cosMin, c);
        n++;
      });
      storedCheck = `kontrola: wektory bge-m3 z bazy (${n}/${ids.length} notatek): cosinus ze świeżo policzonymi średnio ${(cosSum / n).toFixed(4)}, minimum ${cosMin.toFixed(4)}`;
      variants.push({ name: "bge-m3 (wektory z bazy)", dims: 1024, vector: new Map([["q8", scoreCases(sample, m, v.queries, "q8")]]), notesVec: m, queries: v.queries });
    } finally {
      db.close();
    }
  }

  // odniesienia: ranking losowy (wartość oczekiwana) i sam FTS5 (BM25) z próbki
  const baselines: Variant[] = [
    {
      name: "losowy (wartość oczekiwana)",
      dims: 0,
      vector: new Map([["q8", sample.cases.map((c) => ({ sessionId: c.sessionId, project: c.project, vector: randomBaseline(c.poolIds.length, c.relIds.length), hybrid: randomBaseline(c.poolIds.length, c.relIds.length) }))]]),
      notesVec: new Map(),
      queries: [],
    },
    {
      name: "FTS5 (BM25)",
      dims: 0,
      vector: new Map([["q8", sample.cases.map((c) => { const m = rankMetrics(c.ftsIds, new Set(c.relIds)); return { sessionId: c.sessionId, project: c.project, vector: m, hybrid: m }; })]]),
      notesVec: new Map(),
      queries: [],
    },
  ];
  const base = variants.find((v) => v.name === "bge-m3");
  const main = variants.filter((v) => keys.includes(v.name) || v.name === "arctic-m-v2 MRL 256");
  const lines: string[] = [];
  const nCases = sample.cases.length;
  lines.push(`Próbka: ${nCases} przypadków, ${new Set(sample.cases.map((c) => c.project)).size} projektów, ${sample.notes.length} notatek, skrót ${sample.hash.slice(0, 16)}`);
  if (storedCheck) lines.push(storedCheck);
  lines.push("");

  const metricsDef: [string, (r: CaseResult) => number, "vector" | "hybrid"][] = [];
  const table = (title: string, strat: "vector" | "hybrid", quant: Quant, vs: Variant[]) => {
    lines.push(`### ${title}`, "");
    lines.push("| model | wymiary | hit@5 | Δ hit@5 vs bge-m3 [95% CI] | hit@10 | recall@5 | recall@10 | nDCG@10 | MRR@10 | hit@5 średnia po projektach |");
    lines.push("|---|---:|---:|---|---:|---:|---:|---:|---:|---:|");
    for (const v of vs) {
      const rs = v.vector.get(quant);
      if (!rs) continue;
      const get = (f: (k: CaseResult[typeof strat]) => number) => rs.map((r) => f(r[strat]));
      const a = (f: (k: CaseResult[typeof strat]) => number) => aggregate(rs, (r) => f(r[strat]));
      const h5 = a((k) => k.hit5);
      let delta = "baza";
      const b = base?.vector.get(quant);
      if (b && v !== base) {
        const bb = pairedBootstrap(b.map((r) => r[strat].hit5), get((k) => k.hit5));
        delta = `${sign(bb.diff)} pp [${sign(bb.lo)}; ${sign(bb.hi)}]`;
      }
      lines.push(
        `| ${v.name} | ${v.dims || "–"} | ${f1(h5.micro)} | ${delta} | ${f1(a((k) => k.hit10).micro)} | ${f1(a((k) => k.rec5).micro)} | ${f1(a((k) => k.rec10).micro)} | ${f1(a((k) => k.ndcg10).micro)} | ${f1(a((k) => k.mrr10).micro)} | ${f1(h5.macro)} |`,
      );
    }
    lines.push("");
  };
  void metricsDef;
  table("Jakość: sam wektor (int8, brute force po puli, jak `hipokamp eval`), %", "vector", "q8", [...baselines, ...main, ...variants.filter((v) => v.name === "bge-m3 (wektory z bazy)")]);
  table("Jakość: hybryda FTS5 + wektor (RRF), %", "hybrid", "q8", main);

  const deltaTable = (title: string, strat: "vector" | "hybrid") => {
    lines.push(`### ${title}`, "");
    lines.push("Różnica względem bge-m3 w punktach procentowych [95% CI z losowania przypadków ze zwracaniem, 2000 powtórzeń]; `*` = przedział nie obejmuje zera.", "");
    const cols: [string, (k: CaseResult["vector"]) => number][] = [
      ["hit@5", (k) => k.hit5],
      ["hit@10", (k) => k.hit10],
      ["recall@10", (k) => k.rec10],
      ["nDCG@10", (k) => k.ndcg10],
      ["MRR@10", (k) => k.mrr10],
    ];
    lines.push(`| model | ${cols.map((c) => c[0]).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
    const b = base?.vector.get("q8");
    for (const v of [...main, ...variants.filter((x) => x.name.startsWith("bge-m3 ("))]) {
      if (v === base || !b) continue;
      const rs = v.vector.get("q8");
      if (!rs) continue;
      const cells = cols.map(([, f]) => {
        const bb = pairedBootstrap(b.map((r) => f(r[strat])), rs.map((r) => f(r[strat])));
        return `${sign(bb.diff)} [${sign(bb.lo)}; ${sign(bb.hi)}]${bb.lo > 0 || bb.hi < 0 ? " *" : ""}`;
      });
      lines.push(`| ${v.name} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  };
  deltaTable("Różnice względem bge-m3: sam wektor", "vector");
  deltaTable("Różnice względem bge-m3: hybryda FTS5 + wektor", "hybrid");
  lines.push("Wiersze „bge-m3 (…)” to poziom szumu: ten sam model z zapytaniami w innym dtype albo z wektorami z bazy (część policzona na CPU q8, część na GPU fp16).", "");
  lines.push("### Przypadki, w których model wygrywa z bge-m3 / przegrywa / remisuje (nDCG@10, 94 przypadki)", "");
  lines.push("| model | sam wektor | hybryda |", "|---|---|---|");
  for (const v of main) {
    if (v === base || !base) continue;
    const wl = (strat: "vector" | "hybrid") => {
      let w = 0;
      let l = 0;
      const b = base.vector.get("q8")!;
      v.vector.get("q8")!.forEach((r, i) => {
        const d = r[strat].ndcg10 - b[i][strat].ndcg10;
        if (d > 1e-9) w++;
        else if (d < -1e-9) l++;
      });
      return `${w} / ${l} / ${b.length - w - l}`;
    };
    lines.push(`| ${v.name} | ${wl("vector")} | ${wl("hybrid")} |`);
  }
  lines.push("");

  lines.push("### Wrażliwość na kwantyzację (sam wektor, hit@5 / hit@10, %)", "");
  lines.push("| model | float32 | int8 (produkcja) | prefiltr binarny 640 + int8 (produkcja `vectorSearch`) |", "|---|---|---|---|");
  for (const v of main) {
    const c = (q: Quant) => {
      const rs = v.vector.get(q);
      return rs ? `${f1(mean(rs.map((r) => r.vector.hit5)))} / ${f1(mean(rs.map((r) => r.vector.hit10)))}` : "–";
    };
    lines.push(`| ${v.name} | ${c("f32")} | ${c("q8")} | ${c("bits")} |`);
  }
  lines.push("");
  lines.push("### Zapytania liczone tym samym modelem co notatki (fp16 DirectML) zamiast modelu zapytań (CPU q8), sam wektor, hit@5 / hit@10, %", "");
  lines.push("| model | zapytania CPU q8 (produkcja) | zapytania jak notatki |", "|---|---|---|");
  for (const k of keys) {
    const a = variants.find((v) => v.name === k)!.vector.get("q8")!;
    const bv = variants.find((v) => v.name.startsWith(`${k} (zapytania`))!.vector.get("q8")!;
    const c = (rs: CaseResult[]) => `${f1(mean(rs.map((r) => r.vector.hit5)))} / ${f1(mean(rs.map((r) => r.vector.hit10)))}`;
    lines.push(`| ${k} | ${c(a)} | ${c(bv)} |`);
  }
  lines.push("");

  const projects = [...new Set(sample.cases.map((c) => c.project))].sort();
  const counts = new Map(projects.map((p) => [p, sample.cases.filter((c) => c.project === p).length]));
  const perProject = (title: string, strat: "vector" | "hybrid", pick: (k: CaseResult["vector"]) => number) => {
    lines.push(`### ${title}`, "");
    lines.push(`| model | ${projects.map((p) => `${p} (${counts.get(p)})`).join(" | ")} |`, `|---|${projects.map(() => "---:").join("|")}|`);
    for (const v of main) {
      const ag = aggregate(v.vector.get("q8")!, (r) => pick(r[strat]));
      lines.push(`| ${v.name} | ${projects.map((p) => f1(ag.perProject.get(p)?.value ?? 0)).join(" | ")} |`);
    }
    lines.push("");
  };
  perProject("Hit@5 (sam wektor) w projektach, %", "vector", (k) => k.hit5);
  perProject("nDCG@10 (sam wektor) w projektach, %", "vector", (k) => k.ndcg10);
  perProject("Hit@5 (hybryda) w projektach, %", "hybrid", (k) => k.hit5);
  perProject("nDCG@10 (hybryda) w projektach, %", "hybrid", (k) => k.ndcg10);

  // rozkład cosinusów: do rekalibracji calibrateCos (szum ok. 0,35 i mocne dopasowanie ok. 0,7 to wartości bge-m3) i promptMinScore
  lines.push("### Rozkład cosinusów zapytanie–notatka (do rekalibracji `calibrateCos` i `promptMinScore`)", "");
  lines.push("| model | mediana puli | p90 puli | p99 puli | najlepsza notatka (mediana po przypadkach) | najlepsza trafna (mediana) |", "|---|---:|---:|---:|---:|---:|");
  for (const v of main) {
    const all: number[] = [];
    const top: number[] = [];
    const topRel: number[] = [];
    sample.cases.forEach((c, i) => {
      const q = v.queries[i];
      const rel = new Set(c.relIds);
      let best = -1;
      let bestRel = -1;
      for (const id of c.poolIds) {
        const f = v.notesVec.get(id)?.f32;
        if (!f) continue;
        let s = 0;
        for (let j = 0; j < f.length; j++) s += f[j] * q[j];
        all.push(s);
        if (s > best) best = s;
        if (rel.has(id) && s > bestRel) bestRel = s;
      }
      top.push(best);
      topRel.push(bestRel);
    });
    lines.push(`| ${v.name} | ${pct(all, 0.5).toFixed(3)} | ${pct(all, 0.9).toFixed(3)} | ${pct(all, 0.99).toFixed(3)} | ${pct(top, 0.5).toFixed(3)} | ${pct(topRel, 0.5).toFixed(3)} |`);
  }
  lines.push("");

  // koszt
  lines.push("### Koszt", "");
  lines.push("| model | plik modelu do notatek (fp16) | plik modelu do zapytań (q8) | wektor na notatkę (int8 + bity) | 113,8 tys. notatek | notatki/s GPU (DML fp16) | notatki/s CPU (q8) | ~czas 113,8 tys. na GPU | zapytanie CPU p50 / p95 | RAM szczyt (proces z GPU) | RAM szczyt (CPU) | ładowanie GPU |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|");
  const TOTAL = 113831;
  for (const k of keys) {
    const m = metas.get(k)!;
    const cpuPath = join(WORK, `cpu-${k}.json`);
    const cpu = existsSync(cpuPath) ? JSON.parse(readFileSync(cpuPath, "utf8")) : null;
    const sz = (fs: { bytes: number }[]) => `${Math.round(fs.reduce((s, f) => s + f.bytes, 0) / MB)} MB`;
    const perNote = m.dims + Math.ceil(m.dims / 8);
    lines.push(
      `| ${k} | ${sz(m.files.bulk)} | ${sz(m.files.query)} | ${perNote} B | ${(perNote * TOTAL / MB).toFixed(0)} MB | ${m.notesPerSec.toFixed(1)} | ${cpu ? cpu.notesPerSec.toFixed(2) : "–"} | ${(TOTAL / m.notesPerSec / 60).toFixed(0)} min | ${cpu ? `${cpu.queryP50Ms} / ${cpu.queryP95Ms} ms` : "–"} | ${m.rssAfterBulkMB} MB | ${cpu ? `${cpu.peakRssMB} MB` : "–"} | ${(m.loadMs / 1000).toFixed(1)} s |`,
    );
  }
  lines.push("");
  const out = lines.join("\n");
  writeFileSync(join(WORK, "wyniki.md"), out);
  console.log(out);
}

switch (cmd) {
  case "prepare":
    prepare();
    break;
  case "embed":
    await embed();
    break;
  case "cpu":
    await cpuBench();
    break;
  case "check":
    await check();
    break;
  case "score":
    score();
    break;
  default:
    console.log("użycie: bun spikes/embed-eval.ts prepare | embed <model> | cpu <model> | check <model> | score [model ...]  (modele: " + MODELS.map((m) => m.key).join(", ") + ")");
}
