// Spike: przepustowość bge-m3 na DirectML przy prawdziwych tekstach notatek (różne długości).
// Hipoteza: DML przelicza plan dla każdego nowego kształtu wejścia, więc pipeline z dopełnieniem do najdłuższego
// w partii jest wolny. Porównanie: pipeline (stan obecny) vs tokenizer z dopełnieniem do stałych kubełków.
// Użycie: bun spikes/embed-shapes.ts [device=dml] [dtype=fp16] [n=384]
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { AutoModel, AutoTokenizer, env, pipeline } from "@huggingface/transformers";
import { passageText } from "../src/index/embedder.ts";

env.cacheDir = join(process.env.USERPROFILE ?? "", ".hipokamp", "models");
const device = (process.argv[2] ?? "dml") as any;
const dtype = (process.argv[3] ?? "fp16") as any;
const n = Number(process.argv[4] ?? 384);
const MODEL = "Xenova/bge-m3";

const db = new Database(join(process.env.USERPROFILE ?? "", ".hipokamp", "hipokamp.db"), { readonly: true });
const rows = db.query("SELECT title, subtitle, narrative, facts, concepts FROM observations ORDER BY random() LIMIT ?").all(n) as any[];
const texts = rows.map((r) => passageText(r));
console.log(`teksty: ${texts.length}, średnio ${Math.round(texts.reduce((a, t) => a + t.length, 0) / texts.length)} znaków`);

// A: pipeline jak w embedderze (dopełnienie do najdłuższego w partii)
{
  const ex = await pipeline("feature-extraction", MODEL, { dtype, device });
  await ex(texts.slice(0, 4), { pooling: "cls", normalize: true });
  const t = performance.now();
  for (let i = 0; i < texts.length; i += 64) await ex(texts.slice(i, i + 64), { pooling: "cls", normalize: true });
  console.log(`A pipeline, partia 64: ${((performance.now() - t) / texts.length).toFixed(1)} ms/tekst`);
  await (ex as any).dispose?.();
}

// B: tokenizer + model, sortowanie po długości i dopełnienie do kubełków 128/256/512
{
  const tok = await AutoTokenizer.from_pretrained(MODEL);
  const model = await AutoModel.from_pretrained(MODEL, { dtype, device });
  const BUCKETS = [128, 256, 512];
  const lens = texts.map((t) => (tok(t, { truncation: true, max_length: 512 }).input_ids as any).dims[1] as number);
  const order = texts.map((_, i) => i).sort((a, b) => lens[a] - lens[b]);
  const run = async (idx: number[], L: number) => {
    const batch = idx.map((i) => texts[i]);
    const inputs = tok(batch, { padding: "max_length", truncation: true, max_length: L });
    const out = await model(inputs);
    const h = out.last_hidden_state.to("float32");
    const [B, , H] = h.dims;
    const data = h.data as Float32Array;
    const vecs: Float32Array[] = [];
    for (let b = 0; b < B; b++) {
      const v = data.slice(b * h.dims[1] * H, b * h.dims[1] * H + H);
      let s = 0;
      for (const x of v) s += x * x;
      const norm = Math.sqrt(s) || 1;
      for (let k = 0; k < H; k++) v[k] /= norm;
      vecs.push(v);
    }
    return vecs;
  };
  // rozgrzewka każdego kubełka (plan DML liczony raz na kształt)
  for (const L of BUCKETS) await run(order.slice(0, 8), L);
  for (const bs of [16, 32, 64]) {
    const t = performance.now();
    let i = 0;
    while (i < order.length) {
      const L = BUCKETS.find((b) => b >= lens[order[Math.min(order.length - 1, i + bs - 1)]]) ?? 512;
      const idx = order.slice(i, i + bs);
      // stały rozmiar partii też jest kształtem: ostatnią niepełną dopełniamy powtórzeniem
      while (idx.length < bs) idx.push(idx[idx.length - 1]);
      await run(idx, L);
      i += bs;
    }
    console.log(`B kubełki, partia ${bs}: ${((performance.now() - t) / texts.length).toFixed(1)} ms/tekst`);
  }
  // zgodność z A: cosinus wektora z B i z pipeline dla jednego tekstu
  const ex = await pipeline("feature-extraction", MODEL, { dtype, device });
  const a = (await ex([texts[order[0]]], { pooling: "cls", normalize: true })).data as Float32Array;
  const [b] = await run([order[0]], BUCKETS.find((x) => x >= lens[order[0]]) ?? 512);
  let dot = 0;
  for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
  console.log(`zgodność A/B (cos): ${dot.toFixed(4)}`);
}
console.log("rss MB", Math.round(process.memoryUsage().rss / 1e6));
