// Spike: koszt zastępowania decyzji z digestu w śnie (T-06) i najdłuższa blokada pętli zdarzeń workera.
// Nigdy na prawdziwej bazie: HIPOKAMP_HOME musi wskazywać katalog z „hipokamp-test” w nazwie.
//
//   HIPOKAMP_HOME=<tmp>/hipokamp-test-bench bun spikes/sleep-supersede.ts [--code <katalog src do porównania>]
//     [--decisions 6000] [--filler 0] [--projects 3] [--rebuild]
//
// Baza: decyzje i preferencje z digestu w `--projects` projektach (udziały malejące, część notatek z inną wielkością
// liter w nazwie projektu) z 118 dni, tematy z własnymi słowami tytułów, pytaniami (ogólne „Jak chcesz kontynuować?”
// i konkretne), pojęciami, plikami i środkiem wektora. `--filler`: dodatkowe epizody (odkrycia, zmiany, poprawki),
// których sen nie zastępuje, ale które leżą w tej samej tabeli (rozmiar dużej bazy: ponad 100 tys. notatek).
// Przebiegi: sen dzienny (świeże z 2 dni, jak `last_sleep_at - 2 dni`), tydzień i pełny (120 dni, jak
// `hipokamp supersede --dry-run`). Każdy na świeżej kopii bazy, w trybie próby (bez zapisu, jak domyślne „propose”)
// i z zapisem. Mierzone: czas całości, najdłuższa przerwa między tyknięciami zegara co 1 ms (blokada pętli) i liczba
// przerw ponad 50 ms (pojedyncza przerwa w pełnym przebiegu to zwykle I/O: zimne strony świeżej kopii bazy albo
// automatyczny checkpoint WAL przy zapisie; stałe przerwy na każdą grupę to praca CPU albo zapytanie).
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config.ts";

if (!DATA_DIR.includes("hipokamp-test")) throw new Error("HIPOKAMP_HOME musi wskazywać katalog testowy (hipokamp-test)");

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n: string) => argv.includes(`--${n}`);
const DECISIONS = Number(flag("decisions", "6000"));
const FILLER = Number(flag("filler", "0"));
const NPROJ = Number(flag("projects", "3"));
const DIMS = 1024;
const DAY = 86_400_000;
const NOW = Date.now();

let seed = 7654321;
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

const VOCAB =
  "kolejka worker hook sesja pamięć wektor indeks ranking próg budżet kontekst prompt plik odcisk skrót treść sen scalanie archiwum zastępowanie klucz decyzja preferencja projekt gałąź commit migracja schemat baza zapytanie partycja embedding model port serwer klient token limit czas notatka repo build deploy cache narzędzie podgląd log raport kopia sejf hasło konfiguracja domyślny format nazwa katalog ścieżka proces gniazdo procesy potomne instalator autostart harmonogram wtyczka".split(
    " ",
  );
const GENERIC_Q = ["Jak chcesz kontynuować?", "Czy mam kontynuować?", "Który wariant wybierasz?", "Commit?"];
// 3 projekty: 60/30/10 % (jak pierwsza wersja spike'a); więcej: udziały malejące jak 1/k
const PROJECTS =
  NPROJ === 3
    ? [
        { name: "duzy", share: 0.6 },
        { name: "sredni", share: 0.3 },
        { name: "maly", share: 0.1 },
      ]
    : (() => {
        const w = Array.from({ length: NPROJ }, (_, k) => 1 / (k + 1));
        const s = w.reduce((a, b) => a + b, 0);
        return w.map((x, k) => ({ name: `projekt${k}`, share: x / s }));
      })();
// część notatek z inną wielkością liter (stare importy): sen grupuje projekty bez wielkości liter
const spell = (p: string) => (rnd() < 0.1 ? p[0].toUpperCase() + p.slice(1) : p);

const dbPath = join(
  DATA_DIR,
  FILLER || NPROJ !== 3 ? `sleep-bench-${DECISIONS}-${FILLER}-${NPROJ}.db` : "sleep-bench.db",
);
const code = flag("code") ?? join(import.meta.dir, "..", "src");
const { openDb } = await import(join(import.meta.dir, "..", "src", "db", "db.ts"));
const { Repo } = await import(join(import.meta.dir, "..", "src", "db", "repo.ts"));
const { toQ8 } = await import(join(import.meta.dir, "..", "src", "index", "embedder.ts"));

if (has("rebuild")) for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
if (!existsSync(dbPath)) {
  const t0 = performance.now();
  const repo = new Repo(openDb({ path: dbPath }));
  for (const p of PROJECTS) {
    const n = Math.round(DECISIONS * p.share);
    const topics = Array.from({ length: Math.max(40, Math.round(n / 6)) }, (_, i) => ({
      words: Array.from({ length: 5 + Math.floor(rnd() * 3) }, () => pick(VOCAB)),
      question: rnd() < 0.35 ? `Który ${pick(VOCAB)} ${pick(VOCAB)} wybrać dla ${pick(VOCAB)} ${pick(VOCAB)} ${i}?` : null,
      concepts: [pick(VOCAB), pick(VOCAB)],
      files: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => `src/${p.name}/${pick(VOCAB)}${Math.floor(rnd() * 40)}.ts`),
      c: randVec(),
    }));
    repo.db.transaction(() => {
      for (let j = 0; j < n; j++) {
        const t = topics[Math.floor(rnd() ** 1.6 * topics.length)];
        // tytuł z tematu z jednym lub dwoma słowami podmienionymi (ten sam temat: Jaccard zwykle 0,4 do 0,9)
        const words = [...t.words];
        for (let k = 0; k < 1 + Math.floor(rnd() * 2); k++) words[Math.floor(rnd() * words.length)] = pick(VOCAB);
        const facts = [`Decyzja: ${pick(GENERIC_Q)} → ${pick(VOCAB)}`];
        if (t.question && rnd() < 0.5) facts.push(`Decyzja: ${t.question} → ${pick(VOCAB)}`);
        const fm = rnd() < 0.5 ? [] : t.files.slice(0, 1 + Math.floor(rnd() * t.files.length));
        const { id } = repo.insertObservation({
          session_id: `s${j}`,
          project: spell(p.name),
          type: rnd() < 0.8 ? "decision" : "preference",
          title: `${words.join(" ")}${rnd() < 0.1 ? ` v${Math.floor(rnd() * 9)}` : ""}`,
          narrative: `Ustalenie ${j} w projekcie ${p.name}`,
          facts,
          concepts: ["trade-off", ...t.concepts],
          files_read: ["CLAUDE.md", "TASKS.md", ...t.files],
          files_modified: fm,
          created_at: NOW - 118 * DAY + Math.floor(rnd() * 118 * DAY),
          importance: 0.5,
          source: "digest",
        });
        repo.putVector(id, p.name, "bench", toQ8(mix(t.c, 0.85 + rnd() * 0.12)), new Uint8Array(DIMS / 8), false);
      }
    })();
  }
  // epizody (nie decyzje): ten sam rozkład projektów, z 400 dni (stara pamięć z importu też leży w tabeli)
  const FILLER_TYPES = ["discovery", "change", "bugfix", "feature", "refactor"];
  for (let done = 0; done < FILLER; done += 5000) {
    repo.db.transaction(() => {
      for (let j = done; j < Math.min(FILLER, done + 5000); j++) {
        let r = rnd();
        let p = PROJECTS[0];
        for (const q of PROJECTS) {
          if (r < q.share) {
            p = q;
            break;
          }
          r -= q.share;
        }
        repo.insertObservation({
          session_id: `f${j % 4000}`,
          project: spell(p.name),
          type: pick(FILLER_TYPES),
          title: Array.from({ length: 6 }, () => pick(VOCAB)).join(" "),
          narrative: `Epizod ${j}: ${Array.from({ length: 30 }, () => pick(VOCAB)).join(" ")}`,
          facts: [],
          concepts: [pick(VOCAB)],
          files_read: [],
          files_modified: rnd() < 0.3 ? [`src/${p.name}/${pick(VOCAB)}.ts`] : [],
          created_at: NOW - 400 * DAY + Math.floor(rnd() * 400 * DAY),
          importance: 0.4,
          source: "digest",
        });
      }
    })();
  }
  repo.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  repo.db.close();
  console.log(
    `baza: ${DECISIONS} decyzji i preferencji, ${FILLER} epizodów, ${PROJECTS.length} projektów, ${Math.round((performance.now() - t0) / 1000)} s`,
  );
}

// kod do pomiaru: bieżący albo kopia (--code); repo z tej samej kopii (stary kod ma inne metody repo)
const S = await import(join(code, "core", "supersede.ts"));
const R = await import(join(code, "db", "repo.ts"));
const D = await import(join(code, "db", "db.ts"));

const f = (x: number) => x.toFixed(0).padStart(7);
console.log(`kod: ${code}`);
{
  const db = D.openDb({ path: dbPath, readonly: true });
  const c = (sql: string) => (db.query(sql).get() as { c: number }).c;
  console.log(
    `notatki ${c("SELECT COUNT(*) c FROM observations")}, decyzje i preferencje ${c("SELECT COUNT(*) c FROM observations WHERE type IN ('decision','preference')")}`,
  );
  db.close();
}
const copies: string[] = [];
const rmCopy = (p: string) => {
  for (const s of ["", "-wal", "-shm"])
    try {
      rmSync(p + s, { force: true });
    } catch {
      console.log(`(nie usunięto ${p + s}: plik jeszcze otwarty)`);
    }
};
console.log("przebieg        tryb     świeże grupy   czas ms   blokada ms   przerwy>50ms   pary");
for (const [name, days] of [
  ["sen dzienny", 2],
  ["tydzień", 7],
  ["pełny 120 dni", 120],
] as const) {
  for (const dryRun of [true, false]) {
    // osobna kopia na przebieg: Windows trzyma plik zamkniętej bazy jeszcze chwilę (mmap)
    const copy = join(DATA_DIR, `sleep-bench-run-${days}-${dryRun ? "p" : "z"}.db`);
    rmCopy(copy);
    copyFileSync(dbPath, copy);
    const repo = new R.Repo(D.openDb({ path: copy }));
    const since = NOW - days * DAY;
    const fr = repo.db
      .query(
        "SELECT COUNT(*) c, COUNT(DISTINCT lower(project) || type) g FROM observations WHERE created_at >= ? AND type IN ('decision','preference')",
      )
      .get(since) as { c: number; g: number };
    // zegar co 1 ms: najdłuższa przerwa między tyknięciami = najdłuższy kawałek pracy bez oddania sterowania
    let last = performance.now();
    let maxGap = 0;
    let over50 = 0;
    const iv = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      if (t - last > 50) over50++;
      last = t;
    }, 1);
    await Bun.sleep(20);
    maxGap = 0;
    over50 = 0;
    last = performance.now();
    const t0 = performance.now();
    const r = await S.supersedeSimilar(repo, since, { dryRun });
    const ms = performance.now() - t0;
    maxGap = Math.max(maxGap, performance.now() - last);
    clearInterval(iv);
    const n = typeof r === "number" ? r : r.length;
    console.log(
      `${name.padEnd(15)} ${(dryRun ? "próba" : "zapis").padEnd(6)} ${String(fr.c).padStart(6)} ${String(fr.g).padStart(5)} ${f(ms)}   ${f(maxGap)}   ${String(over50).padStart(10)}   ${String(n).padStart(6)}`,
    );
    repo.db.close();
    copies.push(copy);
  }
}
Bun.gc(true);
await Bun.sleep(200);
for (const c of copies) rmCopy(c);
