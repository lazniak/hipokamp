// Spike: gdzie ucieka czas w embedBatch na prawdziwej bazie: zapytanie, model czy zapis (obs_vectors + vec0).
import { loadConfig } from "../src/config.ts";
import { getDb, hasVectors } from "../src/db/db.ts";
import { Repo } from "../src/db/repo.ts";
import { Embedder, passageText, toBits, toQ8 } from "../src/index/embedder.ts";

const repo = new Repo(getDb());
const cfg = loadConfig();
const emb = new Embedder({ ...cfg.embed, bulkDevice: "dml", bulkDtype: "fp16" }, "bulk");
for (let round = 0; round < 3; round++) {
  let t = performance.now();
  const rows = repo.missingVectors(64);
  const tq = performance.now() - t;
  t = performance.now();
  const vecs = await emb.embed(rows.map(passageText), "passage");
  const te = performance.now() - t;
  t = performance.now();
  const withBits = hasVectors();
  repo.db.transaction(() => {
    rows.forEach((r, i) => {
      repo.putVector(r.id, r.project, emb.modelId, toQ8(vecs[i]), toBits(vecs[i]), withBits);
    });
  })();
  const tw = performance.now() - t;
  console.log(`partia ${rows.length}: zapytanie ${tq.toFixed(0)} ms, model ${te.toFixed(0)} ms, zapis ${tw.toFixed(0)} ms (bity: ${withBits})`);
}
