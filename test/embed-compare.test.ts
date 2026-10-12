// Porównanie modeli wektorów (T-04): pooling kubełkowej ścieżki masowej, wybór próbki z przypadków `hipokamp eval`,
// ranking i metryki jak w produkcji, bootstrap. Bez modeli i bez sieci (wektory syntetyczne), bazy w pamięci.
// Osobny proces z katalogiem „hipokamp-test” jak w recall.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_EMBEDCMP_CHILD";

if (!process.env[CHILD]) {
  test("porównanie modeli wektorów (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/embed-compare.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47992",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `embed-compare: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy porównania modeli nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
} else {
  const { DATA_DIR } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test")) throw new Error("embed-compare: HIPOKAMP_HOME musi wskazywać katalog testowy");
  const { DEFAULTS } = await import("../src/config.ts");
  const { openDb } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const { buildCases, metrics, relevant } = await import("../src/eval/eval.ts");
  const C = await import("../src/eval/embed-compare.ts");
  const { hiddenStates, poolHidden, toBits, toQ8 } = await import("../src/index/embedder.ts");
  const { dotQ8 } = await import("../src/index/vectors.ts");
  type Obs = import("../src/types.ts").Observation;

  const norm = (v: number[]): Float32Array => {
    const f = Float32Array.from(v);
    const n = Math.sqrt(f.reduce((s, x) => s + x * x, 0)) || 1;
    return f.map((x) => x / n) as Float32Array;
  };

  describe("poolHidden: pooling ścieżki masowej", () => {
    // partia 2 tekstów, seq 3, dim 2; wiersz 1 ma ostatni token dopełnieniem
    const data = Float32Array.from([
      // tekst 0: tokeny (1,0) (0,1) (1,1)
      1, 0, 0, 1, 1, 1,
      // tekst 1: tokeny (2,0) (0,2) (9,9) - ostatni to dopełnienie
      2, 0, 0, 2, 9, 9,
    ]);
    const mask = BigInt64Array.from([1n, 1n, 1n, 1n, 1n, 0n]);

    test("CLS: pierwszy token wiersza, norma 1", () => {
      const v0 = poolHidden(data, 0, 3, 2, null, "cls");
      expect(Array.from(v0)).toEqual([1, 0]);
      const v1 = poolHidden(data, 1, 3, 2, mask, "cls");
      expect(Array.from(v1)).toEqual([1, 0]);
      const w = poolHidden(Float32Array.from([3, 4, 0, 0]), 0, 2, 2, null, "cls");
      expect(w[0]).toBeCloseTo(0.6, 6);
      expect(w[1]).toBeCloseTo(0.8, 6);
    });

    test("średnia: pomija dopełnienie (attention_mask) i normalizuje", () => {
      const v0 = poolHidden(data, 0, 3, 2, mask, "mean"); // (2/3, 2/3) po normie
      expect(v0[0]).toBeCloseTo(Math.SQRT1_2, 6);
      expect(v0[1]).toBeCloseTo(Math.SQRT1_2, 6);
      const v1 = poolHidden(data, 1, 3, 2, mask, "mean"); // ((2+0)/2, (0+2)/2) = (1,1): dopełnienie (9,9) poza średnią
      expect(v1[0]).toBeCloseTo(Math.SQRT1_2, 6);
      expect(v1[1]).toBeCloseTo(Math.SQRT1_2, 6);
      const noMask = poolHidden(data, 1, 3, 2, Float32Array.from([1, 1, 1, 1, 1, 1]), "mean");
      expect(noMask[0]).toBeCloseTo(11 / Math.hypot(11, 11), 6);
    });

    test("średnia bez maski liczy wszystkie tokeny", () => {
      const v = poolHidden(Float32Array.from([2, 0, 0, 2]), 0, 2, 2, null, "mean");
      expect(v[0]).toBeCloseTo(Math.SQRT1_2, 6);
      expect(v[1]).toBeCloseTo(Math.SQRT1_2, 6);
    });

    test("hiddenStates: last_hidden_state, logits albo token_embeddings (arctic), inaczej czytelny błąd", () => {
      const t = { to: () => ({ dims: [1, 1, 1], data: new Float32Array(1) }) };
      expect(hiddenStates({ last_hidden_state: t })).toBe(t);
      expect(hiddenStates({ logits: t })).toBe(t);
      expect(hiddenStates({ token_embeddings: t, sentence_embedding: {} })).toBe(t);
      expect(() => hiddenStates({ sentence_embedding: t })).toThrow(/sentence_embedding/);
    });

    test("wektor zerowy nie daje NaN", () => {
      const v = poolHidden(new Float32Array(4), 0, 2, 2, null, "cls");
      expect(Array.from(v)).toEqual([0, 0]);
    });
  });

  describe("lista modeli", () => {
    test("klucze, wymiary, prefiksy i pooling z kart modeli", () => {
      expect(new Set(C.MODELS.map((m) => m.key)).size).toBe(C.MODELS.length);
      const bge = C.modelSpec("bge-m3");
      expect(bge.model).toBe(DEFAULTS.embed.model);
      expect(bge.dims).toBe(DEFAULTS.embed.dims);
      expect(bge.pooling).toBe(DEFAULTS.embed.pooling);
      expect(`${bge.queryPrefix}${bge.passagePrefix}`).toBe(`${DEFAULTS.embed.queryPrefix}${DEFAULTS.embed.passagePrefix}`);
      const arctic = C.modelSpec("arctic-m-v2");
      expect([arctic.dims, arctic.pooling, arctic.queryPrefix, arctic.passagePrefix]).toEqual([768, "cls", "query: ", ""]);
      for (const k of ["e5-small", "e5-base"]) {
        const e = C.modelSpec(k);
        expect([e.pooling, e.queryPrefix, e.passagePrefix]).toEqual(["mean", "query: ", "passage: "]);
      }
      expect(C.modelSpec("e5-small").dims).toBe(384);
      expect(() => C.modelSpec("nie-ma")).toThrow();
    });

    test("embedConfigFor podmienia model i zostawia urządzenie i partie jak produkcja", () => {
      const cfg = C.embedConfigFor(C.modelSpec("e5-base"), DEFAULTS.embed);
      expect(cfg).toMatchObject({
        model: "Xenova/multilingual-e5-base",
        dims: 768,
        pooling: "mean",
        queryPrefix: "query: ",
        passagePrefix: "passage: ",
      });
      expect(cfg.bulkBatch).toBe(DEFAULTS.embed.bulkBatch);
      expect(cfg.bulkDevice).toBe(DEFAULTS.embed.bulkDevice);
      expect(cfg.dtype).toBe(DEFAULTS.embed.dtype);
    });
  });

  describe("metryki", () => {
    const rng = C.seeded(5);
    test("rankMetrics = metrics z eval.ts (hit, recall, nDCG) dla losowych rankingów", () => {
      for (let t = 0; t < 40; t++) {
        const ids = Array.from({ length: 30 }, (_, i) => i + 1);
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        const rel = new Set(ids.filter(() => rng() < 0.2).slice(0, 1 + Math.floor(rng() * 8)));
        if (!rel.size) rel.add(ids[3]);
        const mine = C.rankMetrics(ids, rel);
        const stubs = ids.map((id) => ({ id }) as unknown as Obs);
        const m5 = metrics(stubs, rel, 5, 0);
        const m10 = metrics(stubs, rel, 10, 0);
        expect(mine.hit5).toBe(m5.hit);
        expect(mine.hit10).toBe(m10.hit);
        expect(mine.rec5).toBeCloseTo(m5.recall, 12);
        expect(mine.rec10).toBeCloseTo(m10.recall, 12);
        expect(mine.ndcg10).toBeCloseTo(m10.ndcg, 12);
      }
    });

    test("MRR@10: pierwsza trafna w pierwszej dziesiątce", () => {
      const ids = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 100];
      expect(C.rankMetrics(ids, new Set([7])).mrr10).toBeCloseTo(1 / 3, 12);
      expect(C.rankMetrics(ids, new Set([100])).mrr10).toBe(0);
      expect(C.rankMetrics(ids, new Set([9, 7])).mrr10).toBe(1);
    });

    test("randomBaseline: wzory zamknięte i zgodność z symulacją", () => {
      const one = C.randomBaseline(10, 1);
      expect(one.hit5).toBeCloseTo(0.5, 12);
      expect(one.hit10).toBeCloseTo(1, 12);
      expect(one.rec5).toBeCloseTo(0.5, 12);
      const h10 = Array.from({ length: 10 }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0);
      expect(one.mrr10).toBeCloseTo(h10 / 10, 12);
      // N = 100, R = 20: średnia z wielu losowych kolejności
      const N = 100;
      const R = 20;
      const rel = new Set(Array.from({ length: R }, (_, i) => i));
      const r = C.seeded(9);
      const acc = { hit5: 0, rec10: 0, ndcg10: 0, mrr10: 0 };
      const T = 6000;
      for (let t = 0; t < T; t++) {
        const ids = Array.from({ length: N }, (_, i) => i);
        for (let i = N - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        const m = C.rankMetrics(ids, rel);
        acc.hit5 += m.hit5;
        acc.rec10 += m.rec10;
        acc.ndcg10 += m.ndcg10;
        acc.mrr10 += m.mrr10;
      }
      const e = C.randomBaseline(N, R);
      expect(acc.hit5 / T).toBeCloseTo(e.hit5, 1);
      expect(acc.rec10 / T).toBeCloseTo(e.rec10, 1);
      expect(acc.ndcg10 / T).toBeCloseTo(e.ndcg10, 1);
      expect(acc.mrr10 / T).toBeCloseTo(e.mrr10, 1);
      expect(Math.abs(acc.hit5 / T - e.hit5)).toBeLessThan(0.02);
    });

    test("agregacja: średnia po przypadkach i po projektach", () => {
      const mk = (project: string, v: number): import("../src/eval/embed-compare.ts").CaseResult => {
        const k = { hit5: v, hit10: v, rec5: v, rec10: v, ndcg10: v, mrr10: v };
        return { sessionId: `${project}${v}`, project, vector: k, hybrid: k };
      };
      const rs = [mk("a", 1), mk("a", 1), mk("a", 1), mk("a", 0), mk("b", 0)];
      const ag = C.aggregate(rs, (r) => r.vector.hit5);
      expect(ag.micro).toBeCloseTo(0.6, 12);
      expect(ag.macro).toBeCloseTo((0.75 + 0) / 2, 12);
      expect(ag.perProject.get("a")).toEqual({ n: 4, value: 0.75 });
    });

    test("bootstrap sparowany: deterministyczny, zero dla identycznych, dodatnia dolna granica dla stałej przewagi", () => {
      const base = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 1 : 0));
      const same = C.pairedBootstrap(base, base, { seed: 3 });
      expect(same).toEqual({ diff: 0, lo: 0, hi: 0 });
      const better = base.map((x) => Math.min(1, x + (x === 0 ? 0.5 : 0)));
      const a = C.pairedBootstrap(base, better, { seed: 3 });
      expect(a).toEqual(C.pairedBootstrap(base, better, { seed: 3 }));
      expect(a.diff).toBeCloseTo((20 / 60) * 0.5 * 2, 6);
      expect(a.lo).toBeGreaterThan(0);
      expect(a.lo).toBeLessThanOrEqual(a.diff);
      expect(a.hi).toBeGreaterThanOrEqual(a.diff);
      expect(() => C.pairedBootstrap([1], [1, 2])).toThrow();
    });
  });

  describe("wektory i ranking", () => {
    test("truncateNormalize: pierwsze współrzędne i norma 1", () => {
      const t = C.truncateNormalize(Float32Array.from([3, 4, 12, 0]), 2);
      expect(t.length).toBe(2);
      expect(t[0]).toBeCloseTo(0.6, 6);
      expect(t[1]).toBeCloseTo(0.8, 6);
    });

    test("hamming zlicza różnice bitów", () => {
      expect(C.hamming(Uint8Array.from([0b1111_0000, 0]), Uint8Array.from([0b0000_1111, 0b1]))).toBe(9);
      expect(C.hamming(Uint8Array.from([255, 255]), Uint8Array.from([255, 255]))).toBe(0);
    });

    test("storeVector = toQ8 i toBits z embeddera", () => {
      const v = norm([0.5, -0.5, 0.5, -0.5, 0.1, 0.2, -0.3, 0.4]);
      const s = C.storeVector(v);
      expect(Array.from(s.q8)).toEqual(Array.from(toQ8(v)));
      expect(Array.from(s.bits)).toEqual(Array.from(toBits(v)));
    });

    test("rankPool: q8 i f32 dają ten sam porządek na wyraźnych różnicach, prefiltr binarny zawęża do kandydatów", () => {
      const q = norm([1, 0, 0, 0, 0, 0, 0, 0]);
      const vecs = new Map<number, ReturnType<typeof C.storeVector>>();
      // notatka i: im mniejsze i, tym bliżej zapytania
      for (let i = 0; i < 10; i++) vecs.set(i, C.storeVector(norm([1 - i * 0.1, i * 0.1, 0.05, 0, 0, 0, 0, 0.02 * i])));
      const pool = [...vecs.keys()].reverse();
      expect(C.rankPool(pool, vecs, q, "f32").slice(0, 3)).toEqual([0, 1, 2]);
      expect(C.rankPool(pool, vecs, q, "q8").slice(0, 3)).toEqual([0, 1, 2]);
      expect(C.rankPool(pool, vecs, q, "bits").length).toBe(10);
      const many = new Map<number, ReturnType<typeof C.storeVector>>();
      const r = C.seeded(1);
      for (let i = 0; i < 900; i++) many.set(i, C.storeVector(norm(Array.from({ length: 16 }, () => r() - 0.5))));
      const ranked = C.rankPool([...many.keys()], many, norm(Array.from({ length: 16 }, () => r() - 0.5)), "bits");
      expect(ranked.length).toBe(C.BITS_CANDIDATES);
      // wynik prefiltru jest posortowany malejąco po int8
      const qv = norm(Array.from({ length: 16 }, () => 0.1));
      const sorted = C.rankPool([...many.keys()], many, qv, "bits");
      const sc = sorted.map((id) => dotQ8(many.get(id)!.q8, qv));
      expect([...sc].sort((a, b) => b - a)).toEqual(sc);
    });

    test("pula bez wektora notatki jest pomijana, jak w eval.ts", () => {
      const vecs = new Map([[1, C.storeVector(norm([1, 0, 0, 0]))]]);
      expect(C.rankPool([1, 2, 3], vecs, norm([1, 0, 0, 0]), "q8")).toEqual([1]);
    });

    test("hybridRank: RRF dwóch list (FTS pierwszy w remisie), pozycje 61 + i", () => {
      // 1 i 3 mają tę samą sumę (1/61 + 1/63), środkowa jest niżej (wypukłość), remis rozstrzyga kolejność wstawiania
      expect(C.hybridRank([1, 2, 3], [3, 2, 1])).toEqual([1, 3, 2]);
      expect(C.hybridRank([5], [])).toEqual([5]);
      expect(C.hybridRank([], [7, 8])).toEqual([7, 8]);
      // obie listy: trafienie w obu bije trafienie tylko w jednej
      expect(C.hybridRank([1, 2], [3, 1])[0]).toBe(1);
    });
  });

  describe("wybór próbki z przypadków eval", () => {
    const T0 = 1_700_000_000_000;
    const MIN = 60_000;
    /** Trzy projekty: Alfa (220 notatek, zapisana też jako ALFA w sesjach), Beta (160), Gamma (40, za mało na przypadek). */
    function fixture() {
      const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
      const note = (
        project: string,
        i: number,
        file: string,
        at: number,
        extra: Partial<import("../src/types.ts").NewObservation> = {},
      ) =>
        repo.insertObservation({
          session_id: null,
          project,
          type: "change",
          title: `Zmiana ${project} ${i}`,
          narrative: `Opis ${project} ${i} plik ${file}`,
          files_modified: [`src/${project.toLowerCase()}/${file}`],
          created_at: at,
          source: "agent",
          ...extra,
        });
      for (let i = 0; i < 220; i++) note("alfa", i, `f${i % 8}.ts`, T0 + i * MIN);
      for (let i = 0; i < 160; i++) note("beta", i, `g${i % 5}.ts`, T0 + i * MIN);
      for (let i = 0; i < 40; i++) note("gamma", i, `h${i % 4}.ts`, T0 + i * MIN);
      note("alfa", 999, "f1.ts", T0 + 10 * MIN, { status: "merged", title: "scalona", narrative: "scalona" });
      // sesje: pierwszy prompt (>= 25 znaków) i notatka sesji z plikiem, który sesja zmieniła
      const session = (id: string, project: string, at: number, file: string, prompt: string) => {
        repo.upsertSession({ id, project, started_at: at, first_prompt: prompt });
        note(project.toLowerCase(), 1000 + at, file, at + 5 * MIN, { session_id: id });
      };
      for (let j = 0; j < 6; j++)
        session(
          `A${j}`,
          j % 2 ? "ALFA" : "alfa",
          T0 + 1000 * MIN + j * 100 * MIN,
          `f${j}.ts`,
          `popraw plik f${j}.ts w module alfa, szybko`,
        );
      for (let j = 0; j < 4; j++)
        session(`B${j}`, "beta", T0 + 1000 * MIN + j * 100 * MIN, `g${j}.ts`, `zmień g${j}.ts w module beta, proszę`);
      for (let j = 0; j < 2; j++)
        session(`G${j}`, "gamma", T0 + 1000 * MIN + j * 100 * MIN, `h${j}.ts`, `popraw h${j}.ts w module gamma, proszę`);
      return repo;
    }
    /** Odpowiednik dawnego SQL z COLLATE NOCASE: liczba notatek projektu sprzed startu sesji, bez scalonych. */
    const priorSql = (repo: InstanceType<typeof Repo>, project: string, at: number) =>
      (
        repo.db
          .query(
            "SELECT COUNT(*) c FROM observations o WHERE o.project = ? COLLATE NOCASE AND o.created_at < ? AND o.status != 'merged'",
          )
          .get(project, at) as { c: number }
      ).c;

    test("buildCases: te same przypadki co dawne podzapytanie (NOCASE), sesje bez historii pomijane", () => {
      const repo = fixture();
      const cases = buildCases(repo, 1e9);
      const ids = cases.map((c) => c.sessionId).sort();
      expect(ids).toEqual(["A0", "A1", "A2", "A3", "A4", "A5", "B0", "B1", "B2", "B3"]);
      const sessions = repo.db.query("SELECT id, project, started_at FROM sessions").all() as {
        id: string;
        project: string;
        started_at: number;
      }[];
      const expected = sessions
        .filter((s) => priorSql(repo, s.project, s.started_at) >= 150)
        .map((s) => s.id)
        .sort();
      expect(ids).toEqual(expected);
      for (const c of cases) expect(c.targetFiles.size).toBe(1);
    });

    const opts = { maxPool: 400, maxNotes: 1000, maxCasesPerProject: 4, minCasesPerProject: 2, seed: 7 };
    const sampleOf = (o = opts) => {
      const repo = fixture();
      return C.selectSample(repo.db, buildCases(repo, 1e9), o);
    };

    test("pule, trafne i FTS: pula = notatki projektu sprzed startu (bez scalonych), trafne = pliki sesji", () => {
      const repo = fixture();
      const s = C.selectSample(repo.db, buildCases(repo, 1e9), opts);
      expect(new Set(s.cases.map((c) => c.project))).toEqual(new Set(["alfa", "beta"]));
      expect(s.cases.filter((c) => c.project === "alfa").length).toBe(4);
      const byId = new Map(s.notes.map((n) => [n.id, n]));
      for (const c of s.cases) {
        const start = c.startedAt;
        const expectedPool = (
          repo.db
            .query(
              "SELECT id FROM observations WHERE project = ? COLLATE NOCASE AND created_at < ? AND status != 'merged' ORDER BY created_at DESC",
            )
            .all(c.project, start) as { id: number }[]
        ).map((r) => r.id);
        expect(c.poolIds).toEqual(expectedPool);
        expect(c.poolIds.length).toBeLessThanOrEqual(opts.maxPool);
        for (const id of c.poolIds) expect(byId.has(id)).toBe(true);
        // trafne: notatki puli o pliku, który zmieniła sesja (nazwa z promptu)
        const file = /(f\d|g\d)\.ts/.exec(c.query)![0];
        const rel = c.poolIds.filter((id) => repo.getObservation(id)!.files_modified.some((f) => f.endsWith(`/${file}`)));
        expect([...c.relIds].sort()).toEqual([...rel].sort());
        expect(c.relIds.length).toBeGreaterThan(0);
        for (const id of c.relIds) expect(relevant(repo.getObservation(id)!, new Set([`${c.project}/${file}`]))).toBe(true);
        // FTS tylko po puli
        for (const id of c.ftsIds) expect(c.poolIds).toContain(id);
        expect(c.query.length).toBeLessThanOrEqual(1500);
      }
      // tekst notatki jak w produkcji (passageText)
      const first = s.notes[0];
      expect(first.text).toContain("Zmiana");
    });

    test("próbka jest deterministyczna, a skrót zmienia się z ziarnem i treścią", () => {
      const a = sampleOf();
      const b = sampleOf();
      expect(b.hash).toBe(a.hash);
      expect(b.cases.map((c) => c.sessionId)).toEqual(a.cases.map((c) => c.sessionId));
      const other = sampleOf({ ...opts, seed: 99, maxCasesPerProject: 3 });
      expect(other.hash).not.toBe(a.hash);
      const changed = C.sampleHash(
        a.notes.map((n, i) => (i === 0 ? { ...n, text: `${n.text}!` } : n)),
        a.cases,
      );
      expect(changed).not.toBe(a.hash);
      expect(C.sampleHash(a.notes, a.cases)).toBe(a.hash);
    });

    test("budżet notatek: projekt, który się nie mieści, jest pomijany, limit puli odcina przypadki", () => {
      const tight = sampleOf({ ...opts, maxNotes: 230 });
      expect(new Set(tight.cases.map((c) => c.project))).toEqual(new Set(["alfa"]));
      expect(tight.notes.length).toBeLessThanOrEqual(230);
      // pula Alfa to 220 + numer sesji: limit 222 zostawia tylko pierwsze przypadki
      const small = sampleOf({ ...opts, maxPool: 222, minCasesPerProject: 1 });
      for (const c of small.cases) expect(c.poolIds.length).toBeLessThanOrEqual(222);
      expect(small.cases.length).toBeLessThan(sampleOf().cases.length);
      expect(sampleOf({ ...opts, minCasesPerProject: 5 }).cases.map((c) => c.project)).not.toContain("beta");
    });
  });

  describe("ocena na próbce", () => {
    test("scoreCases: trafne notatki o tym samym pliku wygrywają, hybryda i warianty kwantyzacji działają", () => {
      const T0 = 1_700_000_000_000;
      const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
      for (let i = 0; i < 200; i++)
        repo.insertObservation({
          session_id: null,
          project: "p",
          type: "change",
          title: `Zmiana ${i}`,
          narrative: `notatka ${i} o module m${i % 8}`,
          files_modified: [`src/p/f${i % 8}.ts`],
          created_at: T0 + i * 60_000,
          source: "agent",
        });
      for (let j = 0; j < 3; j++) {
        repo.upsertSession({
          id: `S${j}`,
          project: "p",
          started_at: T0 + 500 * 60_000 + j * 600_000,
          first_prompt: `popraw plik f${j}.ts w module m${j} teraz`,
        });
        repo.insertObservation({
          session_id: `S${j}`,
          project: "p",
          type: "change",
          title: `Sesja ${j}`,
          files_modified: [`src/p/f${j}.ts`],
          created_at: T0 + 500 * 60_000 + j * 600_000 + 60_000,
          source: "agent",
        });
      }
      const sample = C.selectSample(repo.db, buildCases(repo, 1e9), {
        maxPool: 1000,
        maxNotes: 1000,
        maxCasesPerProject: 10,
        minCasesPerProject: 1,
        seed: 1,
      });
      expect(sample.cases.length).toBe(3);
      // wektory: oś = numer pliku, mały szum; zapytanie = oś pliku sesji
      const rnd = C.seeded(3);
      const dims = 24;
      const axis = (k: number, noise: number) =>
        norm(Array.from({ length: dims }, (_, d) => (d === k ? 1 : 0) + (rnd() - 0.5) * noise));
      const fileOf = (id: number) => Number(/f(\d)\.ts/.exec(repo.getObservation(id)!.files_modified[0])![1]);
      const vecs = new Map<number, ReturnType<typeof C.storeVector>>();
      for (const n of sample.notes) vecs.set(n.id, C.storeVector(axis(fileOf(n.id), 0.4)));
      const queries = sample.cases.map((c) => axis(Number(/f(\d)\.ts/.exec(c.query)![1]), 0.2));
      for (const quant of ["q8", "f32", "bits"] as const) {
        const rs = C.scoreCases(sample, vecs, queries, quant);
        expect(rs.length).toBe(3);
        for (const r of rs) {
          expect(r.vector.hit5).toBe(1);
          expect(r.vector.rec5).toBeGreaterThan(0.9);
          expect(r.hybrid.hit5).toBe(1);
          expect(r.vector.mrr10).toBeGreaterThan(0.9);
        }
      }
      // zapytania z przypadkowych osi: wyniki gorsze niż trafione
      const wrong = sample.cases.map((c) => axis((Number(/f(\d)\.ts/.exec(c.query)![1]) + 4) % 8, 0.2));
      const bad = C.scoreCases(sample, vecs, wrong, "q8");
      expect(C.aggregate(bad, (r) => r.vector.hit5).micro).toBeLessThan(1);
      expect(() => C.scoreCases(sample, vecs, queries.slice(1), "q8")).toThrow();
    });
  });
}
