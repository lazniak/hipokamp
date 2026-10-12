// Spike: przepustowość bge-m3 na CPU vs DirectML (GPU) dla realistycznych tekstów obserwacji.
import { env, pipeline } from "@huggingface/transformers";
import { join } from "path";

env.cacheDir = join(process.env.USERPROFILE!, ".hipokamp", "models");
const device = (process.argv[2] ?? "cpu") as any;
const model = process.argv[3] ?? "Xenova/bge-m3";
const dtype = (process.argv[4] ?? "q8") as any;
let t = performance.now();
const ex = await pipeline("feature-extraction", model, { dtype, device });
console.log("load ms", Math.round(performance.now() - t), device, model, dtype);
const base =
  "Naprawiono zakleszczenie portu 37777: watchdog sprawdza /health, a gdy port trzyma martwy PID, ubija proces i zeruje licznik porażek w state/hook-failures.json. Pliki: C:/tools/guard/mem-watchdog.ps1, install-guard.ps1. Fixed hook blocking prompt after consecutive failures.";
const texts = Array.from({ length: 256 }, (_, i) => `${base} #${i}`);
await ex(texts.slice(0, 8), { pooling: "cls", normalize: true }); // warmup
for (const bs of [16, 64]) {
  t = performance.now();
  for (let i = 0; i < texts.length; i += bs) await ex(texts.slice(i, i + bs), { pooling: "cls", normalize: true });
  const ms = performance.now() - t;
  console.log(`batch ${bs}: ${(ms / texts.length).toFixed(2)} ms/text`);
}
t = performance.now();
await ex(["query: port zajęty przez martwy proces"], { pooling: "cls", normalize: true });
console.log("single query ms", (performance.now() - t).toFixed(1));
console.log("rss MB", Math.round(process.memoryUsage().rss / 1e6));
