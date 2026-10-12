// Spike: lokalne embeddingi w Bun na Windows (transformers.js + onnxruntime-node).
import { env, pipeline } from "@huggingface/transformers";
import { join } from "path";

env.cacheDir = join(process.env.USERPROFILE!, ".hipokamp", "models");
const model = process.argv[2] ?? "Xenova/multilingual-e5-small";
const dtype = (process.argv[3] ?? "q8") as any;

let t = performance.now();
const extractor = await pipeline("feature-extraction", model, { dtype, device: "cpu" });
console.log("load ms", Math.round(performance.now() - t), model, dtype);

const texts = [
  "query: jak naprawić zakleszczenie portu workera claude-mem na Windows",
  "passage: Orphaned LISTEN socket makes isPortInUse a false proof of worker liveness",
  "passage: Dodano obsługę płatności Stripe w panelu klienta",
  "passage: hook blocked prompt after 3 consecutive failures",
  "passage: Port 37777 trzymany przez martwy PID, watchdog ubija proces",
];
t = performance.now();
const out = await extractor(texts, { pooling: "mean", normalize: true });
console.log("embed 5 ms", Math.round(performance.now() - t), "dims", out.dims);
const v = out.tolist() as number[][];
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
for (let i = 1; i < v.length; i++) console.log("sim q~", i, dot(v[0], v[i]).toFixed(3));

// throughput
const batch = Array.from({ length: 256 }, (_, i) => `passage: obserwacja numer ${i} o refaktorze modułu auth i plikach src/auth/${i}.ts oraz błędzie TS2345`);
t = performance.now();
for (let i = 0; i < batch.length; i += 64) await extractor(batch.slice(i, i + 64), { pooling: "mean", normalize: true });
const ms = performance.now() - t;
console.log("256 texts ms", Math.round(ms), "=> per text", (ms / 256).toFixed(2), "ms");
console.log("rss MB", Math.round(process.memoryUsage().rss / 1e6));
