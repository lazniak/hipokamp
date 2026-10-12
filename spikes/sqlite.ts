// Spike: bun:sqlite — FTS5, trigram, loadExtension, wydajność brute-force wektorów w JS.
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
console.log("sqlite", (db.query("select sqlite_version() v").get() as any).v);
db.run("create virtual table t using fts5(title, body, tokenize='unicode61 remove_diacritics 2')");
db.run("insert into t values ('Zakleszczenie portu', 'Port 37777 trzymany przez martwy proces')");
console.log("fts5 ok", db.query("select title, bm25(t) s from t where t match 'zakleszczenie OR port'").all());
try {
  db.run("create virtual table tg using fts5(x, tokenize='trigram')");
  db.run("insert into tg values ('src/services/worker-service.ts')");
  console.log("trigram ok", db.query("select x from tg where tg match 'worker-serv'").all());
} catch (e) {
  console.log("trigram FAIL", String(e));
}
try {
  db.loadExtension("nonexistent_ext");
} catch (e) {
  console.log("loadExtension available? error:", String(e).slice(0, 120));
}

// brute force cosine na int8, 110k x 384
const N = 110_000, D = 384;
const mat = new Int8Array(N * D);
for (let i = 0; i < mat.length; i++) mat[i] = (Math.random() * 254 - 127) | 0;
const q = new Int8Array(D);
for (let i = 0; i < D; i++) q[i] = (Math.random() * 254 - 127) | 0;
const scores = new Float32Array(N);
let t = performance.now();
for (let n = 0; n < N; n++) {
  let s = 0;
  const off = n * D;
  for (let d = 0; d < D; d++) s += mat[off + d] * q[d];
  scores[n] = s;
}
console.log("int8 brute force 110k x 384 ms", (performance.now() - t).toFixed(1));

// float32
const fm = new Float32Array(N * D);
for (let i = 0; i < fm.length; i++) fm[i] = Math.random() - 0.5;
const fq = new Float32Array(D);
for (let i = 0; i < D; i++) fq[i] = Math.random() - 0.5;
t = performance.now();
for (let n = 0; n < N; n++) {
  let s = 0;
  const off = n * D;
  for (let d = 0; d < D; d++) s += fm[off + d] * fq[d];
  scores[n] = s;
}
console.log("f32 brute force 110k x 384 ms", (performance.now() - t).toFixed(1));

// binary (sign bits) hamming: 384 bits = 12 x u32
const W = D / 32;
const bm = new Uint32Array(N * W);
for (let i = 0; i < bm.length; i++) bm[i] = (Math.random() * 0xffffffff) >>> 0;
const bq = new Uint32Array(W);
for (let i = 0; i < W; i++) bq[i] = (Math.random() * 0xffffffff) >>> 0;
const pop = (x: number) => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
t = performance.now();
for (let n = 0; n < N; n++) {
  let h = 0;
  const off = n * W;
  for (let w = 0; w < W; w++) h += pop(bm[off + w] ^ bq[w]);
  scores[n] = h;
}
console.log("binary hamming 110k ms", (performance.now() - t).toFixed(1));
