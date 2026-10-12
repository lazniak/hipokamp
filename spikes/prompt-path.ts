// Spike: profil ścieżki promptu (T-15) na syntetycznej bazie o realistycznym rozmiarze. Nigdy na prawdziwej bazie:
// HIPOKAMP_HOME musi wskazywać katalog z „hipokamp-test” w nazwie.
//
//   HIPOKAMP_HOME=<tmp>/hipokamp-test-bench bun spikes/prompt-path.ts [--notes 40000] [--queries 60]
//     [--code <katalog src do porównania, np. kopia z origin/main>] [--real-embed] [--rebuild]
//
// Baza: notatki w kilkunastu projektach (rozmiary jak rozkład Zipfa), słowa i wektory z tematów (tematy własne projektu
// i wspólne), wektory int8 i binarne jak z bge-m3 (1024 wymiary), część notatek z historią dostępu. Zapytania: „mocne
// lokalne” (temat bieżącego projektu) i „słabe lokalne” (temat innego projektu). Wektor zapytania podaje sztuczny
// embedder (stały koszt ~0), a koszt prawdziwego bge-m3 na tych samych tekstach mierzy osobno `--real-embed`
// (model z HIPOKAMP_HOME/models). Wynik: mediana i p95 całości (stara i nowa ścieżka) oraz etapów nowej.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { Repo } from "../src/db/repo.ts";
import { Embedder, toBits, toQ8 } from "../src/index/embedder.ts";
import { ftsSearch } from "../src/index/fts.ts";
import { vectorSearch } from "../src/index/vectors.ts";

if (!DATA_DIR.includes("hipokamp-test")) throw new Error("HIPOKAMP_HOME musi wskazywać katalog testowy (hipokamp-test)");

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n: string) => argv.includes(`--${n}`);
const NOTES = Number(flag("notes", "40000"));
const QUERIES = Number(flag("queries", "60"));
const PROJECTS = 14;
const DIMS = 1024;
const DAY = 86_400_000;

let seed = 1234567;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const norm = (v: Float32Array) => {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
};
const randVec = () => norm(Float32Array.from({ length: DIMS }, gauss));
const mix = (c: Float32Array, a: number) => {
  const n = randVec();
  const b = Math.sqrt(1 - a * a);
  return norm(Float32Array.from(c, (x, i) => a * x + b * n[i]));
};

const SYL = "ka lo mer sto wi ne dra po zu ek ta ri ol bu mi sza cze go fen tor ul pra wy ko sel da nik ro mat ter".split(" ");
const word = () => Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => pick(SYL)).join("");
const GENERAL =
  "worker hook baza kolejka port proces sesja plik konfiguracja test wektor indeks zapytanie wynik błąd naprawa zmiana funkcja moduł serwer klient token limit czas pamięć notatka projekt repo gałąź commit build deploy schemat migracja odczyt zapis cache model próg ranking budżet kontekst prompt narzędzie podgląd log raport".split(
    " ",
  );
const TYPES = ["change", "change", "feature", "bugfix", "discovery", "discovery", "decision", "refactor", "gotcha", "preference"];

// tematy: po 18 własnych na projekt + 24 wspólne; każdy temat ma słowa i środek w przestrzeni wektorów
const topics = Array.from({ length: PROJECTS * 18 + 24 }, () => ({ words: Array.from({ length: 12 }, word), c: randVec() }));
const own = (p: number) => topics.slice(p * 18, p * 18 + 18).map((_, i) => p * 18 + i);
const shared = Array.from({ length: 24 }, (_, i) => PROJECTS * 18 + i);
const zipf = Array.from({ length: PROJECTS }, (_, i) => 1 / (i + 1) ** 0.9);
const zsum = zipf.reduce((a, b) => a + b, 0);
const projectOf = () => {
  let r = rnd() * zsum;
  for (let i = 0; i < PROJECTS; i++) if ((r -= zipf[i]) <= 0) return i;
  return PROJECTS - 1;
};
const pname = (p: number) => `Projekt${String.fromCharCode(65 + p)}`;
const text = (t: number, n: number, share = 0.55) =>
  Array.from({ length: n }, () => (rnd() < share ? pick(topics[t].words) : pick(GENERAL))).join(" ");

const dbPath = join(DATA_DIR, "bench.db");
if (has("rebuild") && existsSync(dbPath)) for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
const fresh = !existsSync(dbPath);
const repo = new Repo(openDb({ path: dbPath, vectors: true }));

if (fresh) {
  const t0 = performance.now();
  const now = Date.now();
  const files = Array.from({ length: PROJECTS }, (_, p) => Array.from({ length: 200 }, (_, i) => `src/${pname(p)}/m${i}.ts`));
  const batch = 2000;
  for (let i = 0; i < NOTES; i += batch) {
    repo.db.transaction(() => {
      for (let j = i; j < Math.min(NOTES, i + batch); j++) {
        const p = projectOf();
        const t = rnd() < 0.85 ? pick(own(p)) : pick(shared);
        const fm = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(files[p]));
        const concepts = Array.from({ length: 4 }, () => pick(topics[t].words));
        const created = now - Math.floor(rnd() * 365 * DAY);
        const { id } = repo.insertObservation(
          {
            session_id: `s${Math.floor(j / 12)}`,
            project: pname(p),
            prompt_n: (j % 12) + 1,
            type: pick(TYPES),
            title: text(t, 6 + Math.floor(rnd() * 5)),
            subtitle: text(t, 8, 0.4),
            narrative: text(t, 40 + Math.floor(rnd() * 50), 0.35),
            facts: Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => text(t, 10, 0.4)),
            concepts,
            files_modified: fm,
            created_at: created,
            importance: Math.round((0.25 + rnd() * 0.55) * 1000) / 1000,
            source: "digest",
          },
          [
            ...fm.map((k) => ({ kind: "file" as const, key: k, role: "modified" as const })),
            ...concepts.map((k) => ({ kind: "concept" as const, key: k, role: "concept" as const })),
          ],
        );
        const v = mix(topics[t].c, 0.75);
        repo.putVector(id, pname(p), "bench", toQ8(v), toBits(v), true);
        if (rnd() < 0.1)
          repo.logAccess(
            [id],
            "fetched",
            null,
            created + Math.floor(rnd() * (now - created)),
          );
      }
    })();
  }
  console.log(`baza: ${NOTES} notatek w ${PROJECTS} projektach, ${Math.round((performance.now() - t0) / 1000)} s`);
} else console.log(`baza: ${(repo.db.query("SELECT COUNT(*) c FROM observations").get() as { c: number }).c} notatek (istniejąca)`);

// zapytania: połowa z tematu bieżącego projektu (mocne lokalne), połowa z tematu innego projektu (słabe lokalne)
const sizes = repo.db.query("SELECT project, COUNT(*) c FROM observations GROUP BY project ORDER BY c DESC").all() as {
  project: string;
  c: number;
}[];
console.log(`projekty: ${sizes.map((s) => `${s.project} ${s.c}`).join(", ")}`);
interface Q {
  kind: "mocne" | "słabe";
  project: string;
  text: string;
  v: Float32Array;
}
const queries: Q[] = [];
for (let i = 0; i < QUERIES; i++) {
  const p = i % 2 === 0 ? 0 : 1 + (i % (PROJECTS - 1)); // największy projekt i reszta po kolei
  const strong = i % 4 < 2;
  const t = strong ? pick(own(p)) : pick(own((p + 3) % PROJECTS));
  queries.push({
    kind: strong ? "mocne" : "słabe",
    project: pname(p),
    text: `${text(t, 10, 0.5)} jak to było ostatnio?`,
    v: mix(topics[t].c, 0.9),
  });
}

const fakeEmbedder = (v: Float32Array) => ({ loaded: true, embed: async () => [v] }) as any;
type Ctx = typeof import("../src/recall/context.ts");
const load = async (dir: string): Promise<Ctx> => {
  // stara kopia kodu ma własny moduł db.ts: bez loadVectors jej wyszukiwanie wektorowe byłoby wyłączone
  const db = await import(join(dir, "db", "db.ts"));
  db.loadVectors(repo.db);
  return import(join(dir, "recall", "context.ts"));
};
const NEW = await load(join(import.meta.dir, "..", "src"));
const OLD = flag("code") ? await load(flag("code")!) : null;

const q50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.5)] ?? 0;
const q95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] ?? 0;
const f = (x: number) => x.toFixed(1).padStart(6);

const run = async (ctx: Ctx, q: Q, i: number) => {
  const t = performance.now();
  const r = await ctx.promptContext(repo, fakeEmbedder(q.v), {
    project: q.project,
    sessionId: `bench-${i}-${Math.random()}`,
    prompt: q.text,
    cwd: null,
    preview: true,
  });
  return { ms: performance.now() - t, r };
};

// rozgrzewka obu ścieżek (cache stron SQLite, JIT)
for (let i = 0; i < 6; i++) {
  await run(NEW, queries[i % queries.length], i);
  if (OLD) await run(OLD, queries[i % queries.length], i);
}

const res: Record<string, { old: number[]; new: number[]; stages: Record<string, number[]>; global: number; ids: number }> = {};
for (const kind of ["mocne", "słabe"]) res[kind] = { old: [], new: [], stages: {}, global: 0, ids: 0 };
const ROUNDS = 3;
for (let round = 0; round < ROUNDS; round++)
  for (const [i, q] of queries.entries()) {
    const slot = res[q.kind];
    // kolejność na zmianę: żadna ścieżka nie korzysta stale z rozgrzanej pamięci podręcznej drugiej
    const first = (round + i) % 2 === 0;
    if (OLD && !first) slot.old.push((await run(OLD, q, i)).ms);
    const n = await run(NEW, q, i);
    slot.new.push(n.ms);
    const ms = (n.r?.debug as any)?.ms;
    if (ms) {
      for (const k of ["embed", "fts", "vec", "rank", "total"]) (slot.stages[k] ??= []).push(ms[k]);
      if (ms.global) slot.global++;
    }
    slot.ids += n.r?.ids.length ?? 0;
    if (OLD && first) slot.old.push((await run(OLD, q, i)).ms);
  }

console.log(`\nzapytania: ${QUERIES} × ${ROUNDS} przebiegi; czas w ms (mediana / p95)\n`);
console.log("rodzaj   ścieżka       całość           embed      FTS        wektory    ranking   globalne");
for (const [kind, s] of Object.entries(res)) {
  if (!s.new.length) continue;
  if (s.old.length) console.log(`${kind.padEnd(8)} przed      ${f(q50(s.old))} /${f(q95(s.old))}`);
  const st = (k: string) => `${f(q50(s.stages[k] ?? []))} /${f(q95(s.stages[k] ?? []))}`;
  console.log(
    `${kind.padEnd(8)} po         ${f(q50(s.new))} /${f(q95(s.new))}  ${st("embed")} ${st("fts")} ${st("vec")} ${st("rank")}   ${s.global}/${s.new.length}`,
  );
}

// etapy starej ścieżki z osobna: FTS i KNN w projekcie oraz globalnie (stara ścieżka robiła zawsze oba)
const prim: Record<string, number[]> = {};
const time = (k: string, fn: () => unknown) => {
  const t = performance.now();
  fn();
  (prim[k] ??= []).push(performance.now() - t);
};
for (const q of queries) {
  time("FTS w projekcie (pula 96)", () => ftsSearch(repo.db, q.text, { project: q.project, limit: 96 }));
  time("FTS globalnie (pula 60)", () => ftsSearch(repo.db, q.text, { limit: 60 }));
  time("FTS globalnie bez projektu (pula 60)", () => ftsSearch(repo.db, q.text, { excludeProject: q.project, limit: 60 }));
  time("KNN w projekcie (k 96, partycja)", () => vectorSearch(repo, q.v, 96, { project: q.project }));
  time("KNN globalnie (k 60)", () => vectorSearch(repo, q.v, 60));
  time("KNN globalnie bez partycji projektu (k 60)", () => vectorSearch(repo, q.v, 60, { excludeProject: q.project }));
}
console.log("\nprymitywy (mediana / p95 ms):");
for (const [k, xs] of Object.entries(prim)) console.log(`  ${k.padEnd(44)} ${f(q50(xs))} /${f(q95(xs))}`);

if (has("real-embed")) {
  const e = new Embedder(loadConfig().embed, "query");
  await e.embed(["rozgrzewka modelu"], "query");
  const xs: number[] = [];
  for (const [i, q] of queries.entries()) {
    const t = performance.now();
    await e.embed([`${q.text} ${i}`], "query");
    xs.push(performance.now() - t);
  }
  const long: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    await e.embed([`${Array.from({ length: 220 }, () => pick(GENERAL)).join(" ")} ${i}`], "query");
    long.push(performance.now() - t);
  }
  console.log(`\nbge-m3 (q8, CPU), wektor zapytania: krótki prompt ${f(q50(xs))} /${f(q95(xs))} ms, długi (~1500 znaków) ${f(q50(long))} /${f(q95(long))} ms`);
  await e.dispose();
}
