// Spike: sqlite-vec w bun:sqlite na Windows + rozgrzany brute force w JS.
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

const N = 110_000, D = 1024;
const db = new Database(":memory:");
const path = sqliteVec.getLoadablePath();
console.log("vec path", path);
db.loadExtension(path);
console.log("vec_version", (db.query("select vec_version() v").get() as any).v);

db.run(`create virtual table v using vec0(id integer primary key, emb int8[${D}] distance_metric=cosine)`);
const ins = db.prepare("insert into v(id, emb) values (?, vec_int8(?))");
const buf = new Int8Array(D);
let t = performance.now();
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) buf[d] = (Math.random() * 254 - 127) | 0;
    ins.run(i + 1, new Uint8Array(buf.buffer.slice(0)));
  }
})();
console.log("insert 110k int8 ms", Math.round(performance.now() - t));
const q = new Int8Array(D);
for (let d = 0; d < D; d++) q[d] = (Math.random() * 254 - 127) | 0;
const knn = db.prepare("select id, distance from v where emb match vec_int8(?) and k = 50");
for (let r = 0; r < 3; r++) {
  t = performance.now();
  const rows = knn.all(new Uint8Array(q.buffer.slice(0)));
  console.log("knn int8 k=50 ms", (performance.now() - t).toFixed(1), rows.length);
}

// bit (binary) quantization
db.run(`create virtual table b using vec0(id integer primary key, emb bit[${D}])`);
const insb = db.prepare("insert into b(id, emb) values (?, vec_bit(?))");
const bb = new Uint8Array(D / 8);
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < bb.length; d++) bb[d] = (Math.random() * 256) | 0;
    insb.run(i + 1, bb.slice());
  }
})();
const qb = new Uint8Array(D / 8);
for (let d = 0; d < qb.length; d++) qb[d] = (Math.random() * 256) | 0;
const knnb = db.prepare("select id, distance from b where emb match vec_bit(?) and k = 200");
for (let r = 0; r < 3; r++) {
  t = performance.now();
  knnb.all(qb);
  console.log("knn bit k=200 ms", (performance.now() - t).toFixed(1));
}

// rozgrzany JS brute force (f32, 384 i 1024)
for (const dim of [384, 1024]) {
  const fm = new Float32Array(N * dim);
  for (let i = 0; i < fm.length; i++) fm[i] = Math.random() - 0.5;
  const fq = new Float32Array(dim);
  for (let i = 0; i < dim; i++) fq[i] = Math.random() - 0.5;
  const sc = new Float32Array(N);
  const run = () => {
    for (let n = 0; n < N; n++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      const off = n * dim;
      for (let d = 0; d < dim; d += 4) {
        s0 += fm[off + d] * fq[d];
        s1 += fm[off + d + 1] * fq[d + 1];
        s2 += fm[off + d + 2] * fq[d + 2];
        s3 += fm[off + d + 3] * fq[d + 3];
      }
      sc[n] = s0 + s1 + s2 + s3;
    }
  };
  for (let r = 0; r < 4; r++) {
    t = performance.now();
    run();
    console.log(`js f32 ${dim}d warm run ${r} ms`, (performance.now() - t).toFixed(1));
  }
}
