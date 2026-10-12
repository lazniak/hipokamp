// Wyszukiwanie wektorowe: kandydaci z wektorów binarnych (sqlite-vec, Hamming, ~20 ms / 110k)
// + dokładne przeliczenie kandydatów na int8 (cosinus). Klasyczne „binary + rescoring”.
import type { Database } from "bun:sqlite";
import { hasVectors } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { toBits } from "./embedder.ts";

export interface VecHit {
  id: number;
  cos: number;
}

export function vectorSearch(
  repo: Repo,
  q: Float32Array,
  k: number,
  /** excludeProject: bez partycji tego projektu (wyszukiwanie globalne po lokalnym: KNN pomija jego wektory). */
  opts: { project?: string | null; excludeProject?: string | null; oversample?: number; includeArchived?: boolean } = {},
): VecHit[] {
  if (!hasVectors()) return [];
  const db: Database = repo.db;
  const kk = Math.min(4096, Math.max(160, k * (opts.oversample ?? 8)));
  // klucz partycji jest małymi literami (putVector); vec0 przyjmuje na nim = i != w samym KNN
  const part = opts.project
    ? { sql: " AND project = ?", v: [opts.project.toLowerCase()] }
    : opts.excludeProject
      ? { sql: " AND project != ?", v: [opts.excludeProject.toLowerCase()] }
      : { sql: "", v: [] };
  let cands: { obs_id: number }[];
  try {
    cands = db
      .query(`SELECT obs_id FROM obs_vec_bits WHERE emb MATCH vec_bit(?) AND k = ?${part.sql}`)
      .all(toBits(q), kk, ...part.v) as { obs_id: number }[];
  } catch {
    return [];
  }
  if (!cands.length) return [];
  let ids = cands.map((c) => c.obs_id);
  // tylko aktywne (zarchiwizowane/scalone nie wracają w zwykłym wyszukiwaniu); includeArchived jak w FTS
  const statuses = opts.includeArchived ? "('active','archived','superseded')" : "('active')";
  const active = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db
      .query(`SELECT id FROM observations WHERE id IN (${chunk.map(() => "?").join(",")}) AND status IN ${statuses}`)
      .all(...chunk) as { id: number }[])
      active.add(r.id);
  }
  ids = ids.filter((i) => active.has(i));
  const vecs = repo.getVectorsQ8(ids);
  const hits: VecHit[] = [];
  for (const [id, v] of vecs) hits.push({ id, cos: dotQ8(v, q) });
  hits.sort((a, b) => b.cos - a.cos);
  return hits.slice(0, k);
}

export function dotQ8(v: Int8Array, q: Float32Array): number {
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0;
  const n = Math.min(v.length, q.length) & ~3;
  for (let i = 0; i < n; i += 4) {
    s0 += v[i] * q[i];
    s1 += v[i + 1] * q[i + 1];
    s2 += v[i + 2] * q[i + 2];
    s3 += v[i + 3] * q[i + 3];
  }
  return (s0 + s1 + s2 + s3) / 127;
}

export function cosQ8(a: Int8Array, b: Int8Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s / (127 * 127);
}
