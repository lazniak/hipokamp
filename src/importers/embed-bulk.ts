// Masowe liczenie wektorów (import, backfill): GPU przez DirectML, partie po 64, z postępem.
import { loadConfig } from "../config.ts";
import { setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { Embedder } from "../index/embedder.ts";
import { embedBatch } from "../worker/embedloop.ts";

export async function bulkEmbed(
  repo: Repo,
  opts: {
    device?: string;
    dtype?: string;
    batch?: number;
    max?: number;
    onProgress?: (done: number, total: number, perSec: number) => void;
  } = {},
): Promise<{ done: number; ms: number; device: string }> {
  const cfg = loadConfig();
  const ecfg = {
    ...cfg.embed,
    ...(opts.device ? { bulkDevice: opts.device } : {}),
    ...(opts.dtype ? { bulkDtype: opts.dtype } : {}),
  };
  const emb = new Embedder(ecfg, "bulk");
  const total = Math.min(repo.countMissingVectors(), opts.max ?? Number.POSITIVE_INFINITY);
  const batch = opts.batch ?? cfg.embed.bulkBatch;
  const t0 = performance.now();
  let done = 0;
  while (done < total) {
    // worker nie liczy w tym czasie (unikamy podwójnej pracy i walki o CPU/GPU)
    setMeta(repo.db, "bulk_embed_until", String(Date.now() + 5 * 60_000));
    // okno 8 partii: embedder sortuje je po długości, więc partie trafiają w krótkie kubełki
    const n = await embedBatch(repo, emb, Math.min(batch * 8, total - done));
    if (!n) break;
    done += n;
    opts.onProgress?.(done, total, done / ((performance.now() - t0) / 1000));
  }
  setMeta(repo.db, "bulk_embed_until", "0");
  return { done, ms: Math.round(performance.now() - t0), device: emb.device };
}
