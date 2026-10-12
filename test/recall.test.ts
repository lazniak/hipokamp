// Jakość przypominania: przeterminowanie po treści (T-07), zastępowanie po kluczu (T-06), ścieżka promptu z pomiarem
// etapów (T-15) i statystyki progu (T-03, `hipokamp recall-stats`).
// Osobny proces z katalogiem „hipokamp-test” jak w projects.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie,
// a sen, log decyzji i log workera piszą do katalogu danych.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_RECALL_CHILD";

if (!process.env[CHILD]) {
  test("jakość przypominania (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/recall.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47991",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `recall: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy jakości przypominania nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, DEFAULTS, claudeDir, configPath, loadConfig, paths } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test") || !claudeDir().includes("hipokamp-test"))
    throw new Error("recall: HIPOKAMP_HOME i CLAUDE_CONFIG_DIR muszą wskazywać katalog testowy");
  const { getMeta, openDb } = await import("../src/db/db.ts");
  const { pruneLogs } = await import("../src/log.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const { contentDigest, fingerprint, FINGERPRINT_HASH_MAX, parseFingerprint } = await import("../src/util/git.ts");
  const { fileChanged, staleness } = await import("../src/recall/stale.ts");
  const { obsLine } = await import("../src/mcp/format.ts");
  const S = await import("../src/core/supersede.ts");
  const { remember } = await import("../src/core/remember.ts");
  const { sleep, sleepStatus } = await import("../src/consolidate/sleep.ts");
  const { ftsSearch } = await import("../src/index/fts.ts");
  const { toBits, toQ8 } = await import("../src/index/embedder.ts");
  const { vectorSearch } = await import("../src/index/vectors.ts");
  const { promptContext } = await import("../src/recall/context.ts");
  const { promptProfile, resetPromptProfile } = await import("../src/recall/profile.ts");
  const { recallStats, formatRecallStats } = await import("../src/recall/recallstats.ts");
  type RepoT = InstanceType<typeof Repo>;
  type Obs = import("../src/types.ts").Observation;
  mkdirSync(paths.logs(), { recursive: true });

  const DAY = 86_400_000;
  let seq = 0;
  const file = (name: string) => join(DATA_DIR, `${++seq}-${name}`);
  const memRepo = () => new Repo(openDb({ path: ":memory:", vectors: false }));

  // ------------------------------------------------------------ T-07

  describe("przeterminowanie po treści (T-07)", () => {
    const dir = join(DATA_DIR, "proj-stale");
    mkdirSync(dir, { recursive: true });
    const created = Date.now() - 10 * 60_000;
    /** Plik, jego odcisk z chwili notatki i notatka, która go zmieniła. */
    const setup = (name: string, body: string, fp?: (abs: string) => string) => {
      const abs = join(dir, name);
      writeFileSync(abs, body);
      const past = new Date(created - 60_000);
      utimesSync(abs, past, past);
      const print = fp ? fp(abs) : fingerprint(abs)!;
      const o = { files_modified: [name], fingerprints: { [name]: print }, created_at: created } as unknown as Obs;
      return { abs, o, print };
    };
    const touch = (abs: string) => {
      const now = new Date();
      utimesSync(abs, now, now);
    };

    test("odcisk ma skrót treści do 1 MB, większy plik zostaje przy mtime:rozmiar", () => {
      const { print } = setup("maly.ts", "export const x = 1;\n");
      expect(print).toMatch(/^\d+:\d+:x[0-9a-f]{16}$/);
      expect(parseFingerprint(print).hash).toBe(contentDigest(join(dir, "maly.ts")));
      const big = join(dir, "duzy.bin");
      writeFileSync(big, Buffer.alloc(FINGERPRINT_HASH_MAX + 1, 7));
      expect(fingerprint(big)).toMatch(/^\d+:\d+$/);
      expect(parseFingerprint("1700000000000:42")).toEqual({ mtime: 1700000000000, size: 42, hash: null });
    });

    test("git checkout (sam mtime) nie unieważnia notatki, zmiana treści tak", () => {
      const a = setup("a.ts", "const a = 1;\n");
      touch(a.abs);
      expect(staleness(a.o, dir).stale).toBe(false);

      const b = setup("b.ts", "const b = 1;\n");
      writeFileSync(b.abs, "const b = 2;\n"); // ten sam rozmiar, inna treść
      expect(staleness(b.o, dir)).toMatchObject({ stale: true, changed: ["b.ts"] });

      // inny rozmiar przy starym mtime (np. kopia z zachowaniem dat): treść inna, więc zmieniony
      const c = setup("c.ts", "const c = 1;\n");
      writeFileSync(c.abs, "const c = 100;\n");
      utimesSync(c.abs, new Date(created - 60_000), new Date(created - 60_000));
      expect(staleness(c.o, dir).stale).toBe(true);

      // zmiana i powrót do tej samej treści: nie zmieniony
      const d = setup("d.ts", "const d = 1;\n");
      writeFileSync(d.abs, "const d = 9;\n");
      writeFileSync(d.abs, "const d = 1;\n");
      expect(staleness(d.o, dir).stale).toBe(false);
    });

    test("stary format odcisku (mtime:rozmiar) i brak odcisku działają po mtime jak dotąd", () => {
      const old = setup("e.ts", "const e = 1;\n", (abs) => {
        const st = statSync(abs);
        return `${Math.round(st.mtimeMs)}:${st.size}`;
      });
      touch(old.abs);
      expect(staleness(old.o, dir).stale).toBe(true);

      const none = setup("f.ts", "const f = 1;\n");
      const o = { ...none.o, fingerprints: null } as Obs;
      touch(none.abs);
      expect(staleness(o, dir).stale).toBe(true);
    });

    test("chwilowy błąd odczytu nie zostaje w pamięci jako zmiana pliku", () => {
      const g = setup("g.ts", "const g = 1;\n");
      const now = { mtime: Date.now(), size: statSync(g.abs).size };
      // plik chwilowo nieczytelny (tu: katalog w jego miejscu, jak blokada pliku na Windows): wynik jak po mtime
      rmSync(g.abs);
      mkdirSync(g.abs);
      expect(fileChanged(g.abs, now, g.print, created)).toBe(true);
      // po odblokowaniu ta sama treść: niezmieniony (wcześniejszy błąd nie siedzi w pamięci podręcznej)
      rmSync(g.abs, { recursive: true });
      writeFileSync(g.abs, "const g = 1;\n");
      expect(fileChanged(g.abs, now, g.print, created)).toBe(false);
    });

    test("limit bajtów czytanych na jedno wywołanie: ponad nim mtime i rozmiar", () => {
      const h = setup("h.ts", "const h = 1;\n");
      touch(h.abs);
      // budżet 0: treści nie czytamy, więc dotknięty plik wygląda na zmieniony (stara reguła mtime)
      expect(staleness(h.o, dir, 0).stale).toBe(true);
      expect(staleness(h.o, dir).stale).toBe(false);
    });
  });

  // ------------------------------------------------------------ T-06

  describe("zastępowanie po kluczu (T-06)", () => {
    test("remember z kluczem zastępuje starszą decyzję albo preferencję projektu, nic więcej", () => {
      const repo = memRepo();
      const a = remember(repo, { project: "p", text: "Repozytoria trzymamy na GitHubie.", key: "Hosting repo" });
      const other = remember(repo, { project: "inny", text: "Repozytoria inny trzyma na GitLabie.", key: "hosting repo" });
      const gotcha = remember(repo, {
        project: "p",
        type: "gotcha",
        text: "Gitea wymaga logowania OAuth w Menedżerze poświadczeń.",
        key: "hosting repo",
      });
      const b = remember(repo, {
        project: "p",
        type: "preference",
        text: "Repozytoria zakładamy na Gitea, nie na GitHubie.",
        key: "  HOSTING   repo! ",
      });
      expect(b.supersededByKey).toEqual([a.id]);
      const old = repo.getObservation(a.id)!;
      expect(old.status).toBe("superseded");
      expect(old.superseded_by).toBe(b.id);
      expect(old.valid_until).toBeGreaterThan(0);
      expect((old.meta?.supersede as any)?.reason).toBe("klucz");
      // inny projekt i inny typ (pułapka) zostają
      expect(repo.getObservation(other.id)!.status).toBe("active");
      expect(repo.getObservation(gotcha.id)!.status).toBe("active");
      // zastąpiona nie wraca w wyszukiwaniu
      expect(ftsSearch(repo.db, "GitHubie repozytoria", { project: "p" }).map((h) => h.id)).not.toContain(a.id);
      // bez klucza i bez supersedes nic się nie zmienia
      const c = remember(repo, { project: "p", text: "Decyzja bez klucza o hostingu repozytoriów." });
      expect(c.supersededByKey).toBeUndefined();
      expect(repo.getObservation(b.id)!.status).toBe("active");
      // jawne supersedes działa jak dotąd
      const d = remember(repo, { project: "p", text: "Nowa decyzja zamiast tej bez klucza.", supersedes: c.id });
      expect(d.superseded).toBe(c.id);
      expect(repo.getObservation(c.id)!.status).toBe("superseded");
    });

    test("cofnięcie: notatka wraca jako aktywna, a sen nie zastąpi jej drugi raz sam", () => {
      const repo = memRepo();
      const a = remember(repo, { project: "p", text: "Port workera to 47777.", key: "port workera" });
      const b = remember(repo, { project: "p", text: "Port workera to 47778.", key: "port workera" });
      expect(repo.getObservation(a.id)!.status).toBe("superseded");
      // przywracanie w repo (forget z undo): tylko notatki zastąpione, reszta bez zmian
      expect(repo.restoreSuperseded([a.id, b.id, 999_999])).toEqual([a.id]);
      const back = repo.getObservation(a.id)!;
      expect(back.status).toBe("active");
      expect(back.superseded_by).toBeNull();
      expect(back.valid_until).toBeNull();
      expect((back.meta?.supersede_undone as any)?.by).toBe(b.id);
      expect(back.meta?.key).toBe("port workera");
      expect(repo.restoreSuperseded([a.id])).toEqual([]);
      // ta sama treść drugi raz z kluczem: deduplikacja zwraca istniejącą notatkę i nie zastępuje jej samej sobą
      const again = remember(repo, { project: "p", text: "Port workera to 47778.", key: "port workera" });
      expect(again.id).toBe(b.id);
      expect(again.supersededByKey).toEqual([a.id]);
      expect(repo.getObservation(b.id)!.status).toBe("active");
      // powtórzenie starszej treści (deduplikacja zwraca starszy numer) to teraz najnowszy stan: zastępuje nowszą
      expect(repo.restoreSuperseded([a.id])).toEqual([a.id]);
      const re = remember(repo, { project: "p", text: "Port workera to 47777.", key: "port workera" });
      expect(re.id).toBe(a.id);
      expect(re.supersededByKey).toEqual([b.id]);
      expect(repo.keyedObservations("p", "port workera", ["decision"])).toEqual([a.id]);
    });

    test("równoległe remember z tym samym kluczem: starsza nie zastępuje nowszej", () => {
      // przeplot dwóch sesji: obie wstawiły notatkę, potem każda zastępuje „inne” z tym samym kluczem
      const repo = memRepo();
      const ins = (text: string) =>
        repo.insertObservation({
          session_id: null,
          project: "p",
          type: "decision",
          title: text,
          narrative: text,
          created_at: Date.now(),
          source: "agent",
          meta: { key: "port workera" },
        }).id;
      const a = ins("Port workera to 1.");
      const b = ins("Port workera to 2.");
      expect(S.supersedeByKey(repo, a, "p", "port workera", "decision")).toEqual([]);
      expect(S.supersedeByKey(repo, b, "p", "port workera", "decision")).toEqual([a]);
      expect(repo.getObservation(b)!.status).toBe("active");
      expect(repo.getObservation(a)!).toMatchObject({ status: "superseded", superseded_by: b });
    });

    test("remember z kluczem z dwóch procesów naraz: dokładnie jedna aktywna wersja, zero odsyłaczy donikąd", async () => {
      // Gwarancja z remember.ts (zapis i zastąpienie w jednej transakcji IMMEDIATE) na prawdziwym pliku bazy: dwa procesy
      // po 20 wywołań z tym samym kluczem (pisownia klucza i projektu różna, decyzje i preferencje, powtórki treści, czyli
      // deduplikacja i ponowne potwierdzenie). Bez transakcji ten test zwykle też przechodzi: przeplot wymaga trafienia
      // w okno między odczytem listy klucza a zastąpieniem; deterministycznie ten przeplot sprawdza test wyżej
      // („starsza nie zastępuje nowszej”) i test zastąpienia w repo (zastępująca musi być aktywna).
      const path = file("race.db");
      new Repo(openDb({ path })).db.close();
      const script = join(DATA_DIR, "race-remember.ts");
      writeFileSync(
        script,
        [
          `const { openDb } = await import(${JSON.stringify(join(import.meta.dir, "../src/db/db.ts"))});`,
          `const { Repo } = await import(${JSON.stringify(join(import.meta.dir, "../src/db/repo.ts"))});`,
          `const { remember } = await import(${JSON.stringify(join(import.meta.dir, "../src/core/remember.ts"))});`,
          `const repo = new Repo(openDb({ path: ${JSON.stringify(path)} }));`,
          "const tag = process.argv[2];",
          "const type = (i) => (i % 3 ? 'decision' : 'preference');",
          "for (let i = 0; i < 20; i++) {",
          "  remember(repo, { project: i % 2 ? 'P' : 'p', type: type(i), text: 'Wersja ' + tag + '-' + i + ' ustalenia o kluczu.', key: 'Wyścig klucza!' });",
          "  if (i % 5 === 4) remember(repo, { project: 'p', type: type(i - 4), text: 'Wersja ' + tag + '-' + (i - 4) + ' ustalenia o kluczu.', key: 'wyscig klucza' });",
          "}",
          "repo.db.close();",
        ].join("\n"),
      );
      const procs = ["a", "b"].map((tag) =>
        Bun.spawn([process.execPath, script, tag], { env: process.env as Record<string, string>, stderr: "pipe" }),
      );
      expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0]);
      const db = openDb({ path, readonly: true });
      const rows = db.query("SELECT id, status, superseded_by FROM observations ORDER BY id").all() as {
        id: number;
        status: string;
        superseded_by: number | null;
      }[];
      db.close();
      expect(rows.length).toBeGreaterThanOrEqual(40);
      expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
      // każda zastąpiona prowadzi łańcuchem odsyłaczy do istniejącej, aktywnej wersji
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const r of rows.filter((x) => x.status === "superseded")) {
        let cur = r;
        for (let n = 0; cur.status === "superseded" && n < rows.length; n++) {
          const next = byId.get(cur.superseded_by ?? -1);
          expect(next).toBeDefined();
          cur = next!;
        }
        expect(cur.status).toBe("active");
      }
    }, 60_000);

    test("zastąpienie w repo: obie notatki aktywne w tej samej transakcji", () => {
      const repo = memRepo();
      const ins = (text: string) =>
        repo.insertObservation({
          session_id: null,
          project: "p",
          type: "decision",
          title: text,
          narrative: text,
          created_at: Date.now(),
          source: "agent",
        }).id;
      const a = ins("Kopie bazy trzymamy tydzień.");
      const b = ins("Kopie bazy trzymamy miesiąc.");
      // zastępująca już nieaktywna (zarchiwizowana, scalona, zastąpiona): starsza zostaje, bez odsyłacza donikąd
      repo.setStatus(b, "archived");
      expect(repo.supersedeObservation(a, b, { reason: "test" })).toBe(false);
      expect(repo.getObservation(a)!).toMatchObject({ status: "active", superseded_by: null });
      repo.setStatus(b, "active");
      expect(repo.supersedeObservation(a, a, { reason: "test" })).toBe(false);
      expect(repo.supersedeObservation(a, b, { reason: "test" })).toBe(true);
      expect(repo.getObservation(a)!).toMatchObject({ status: "superseded", superseded_by: b });
      expect(repo.supersedeObservation(a, b, { reason: "test" })).toBe(false);
    });

    // własna narracja każdej notatki: ten sam tytuł bez niej to duplikat treści (deduplikacja zwróciłaby tę samą notatkę)
    let tura = 0;
    const digest = (repo: RepoT, o: Partial<Obs> & { title: string; created_at: number }) => {
      const r = repo.insertObservation({
        session_id: null,
        project: "p",
        type: "decision",
        source: "digest",
        facts: [],
        concepts: ["trade-off"],
        narrative: `Prośba z tury ${++tura}`,
        ...o,
      } as any);
      expect(r.duplicateOf).toBeUndefined();
      return r.id;
    };

    type SupOpts = NonNullable<Parameters<typeof S.supersedeSimilar>[2]>;
    const sup = async (repo: RepoT, since: number, opts: SupOpts = {}) => (await S.supersedeSimilar(repo, since, opts)).length;

    const unit = (k: number) => {
      const v = new Float32Array(1024);
      v[k] = 1;
      return toQ8(v);
    };
    /** Wektor o cosinusie `c` z unit(1). */
    const near = (c: number) => {
      const v = new Float32Array(1024);
      v[1] = c;
      v[2] = Math.sqrt(1 - c * c);
      return toQ8(v);
    };
    /** Wektory z mapy; `dflt`: każda notatka bez wpisu dostaje ten wektor (cosinus 1 między nimi). */
    const mockVectors = (repo: RepoT, dflt?: Int8Array) => {
      const vecs = new Map<number, Int8Array>();
      (repo as any).getVectorsQ8 = (ids: number[]) =>
        new Map(
          ids.flatMap((i): [number, Int8Array][] => {
            const v = vecs.get(i) ?? dflt;
            return v ? [[i, v]] : [];
          }),
        );
      return vecs;
    };

    test("digest bez wektorów: łańcuch szablonowych decyzji nie zastępuje się (model włączony czeka, wyłączony tylko przy wspólnym pliku)", async () => {
      // scenariusz z recenzji: sześć różnych spraw z tym samym szablonowym tytułem i wspólnym pojęciem
      const topics = [
        "maski wielokątne w Composerze",
        "trzaski audio NDI w Rooms",
        "kursor programowy na DISPLAY",
        "strzałka Zostaw obsa",
        "normalizator wyjścia Rooms",
        "przełączanie mówcy w Hybrid",
      ];
      const chain = (repo: RepoT, t0: number, files: string[] = []) =>
        topics.map((t, i) =>
          digest(repo, {
            project: "alpha-cast",
            title: "Zmiany są w gotowym buildzie.",
            narrative: `Prośba: ${t}\n\nZmiany są w gotowym buildzie. ${t}.`,
            concepts: ["trade-off", "build", t.split(" ")[0]],
            files_modified: files,
            created_at: t0 + i * DAY,
          }),
        );
      const repo = memRepo();
      const t0 = Date.now() - 10 * DAY;
      const ids = chain(repo, t0);
      // model włączony, wektorów brak (zaległość liczenia): pary czekają na następny sen
      const waiting: number[] = [];
      expect(await sup(repo, t0 - DAY, { embed: true, onPending: (at) => waiting.push(at) })).toBe(0);
      expect(waiting).toHaveLength(5);
      // wektor tylko po jednej stronie pary też czeka
      const vecs = mockVectors(repo);
      vecs.set(ids[0], unit(1));
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      // model wyłączony: bez wspólnego zmienionego pliku nic
      expect(await sup(repo, t0 - DAY, { embed: false })).toBe(0);
      for (const id of ids) expect(repo.getObservation(id)!.status).toBe("active");
      // model wyłączony i wspólny zmieniony plik: niemal ten sam tytuł wystarcza, łańcuch zostaje łańcuchem
      const repo2 = memRepo();
      const ids2 = chain(repo2, t0, ["src/composer/build.ts"]);
      expect(await sup(repo2, t0 - DAY, { embed: false })).toBe(5);
      for (let i = 0; i < 5; i++) expect(repo2.getObservation(ids2[i])!.superseded_by).toBe(ids2[i + 1]);
      expect(repo2.getObservation(ids2[5])!.status).toBe("active");
    });

    test("digest przy wyłączonym modelu: to samo pytanie albo niemal ten sam tytuł, zawsze ze wspólnym zmienionym plikiem", async () => {
      const repo = memRepo();
      const t0 = Date.now() - 30 * DAY;
      const question = "Decyzja: Gdzie zakładamy nowe repozytoria projektu Omega na serwerze?";
      // tytuł podobny (Jaccard 0,67) i to samo pytanie: dość, gdy obie zmieniały ten sam plik
      const q1 = digest(repo, {
        title: "Hosting repozytoriów projektu omega",
        facts: [`${question} → GitHub`],
        concepts: ["trade-off", "hosting"],
        files_modified: ["docs/hosting.md"],
        created_at: t0,
      });
      const q2 = digest(repo, {
        title: "Hosting repozytoriów projektu omega na serwerze VPS",
        facts: [`${question} → Gitea na VPS`, "Decyzja: Czy migrować historię? → Tak"],
        concepts: ["trade-off", "hosting"],
        files_modified: ["docs/hosting.md"],
        created_at: t0 + DAY,
      });
      // to samo bez pliku: za mało
      const n1 = digest(repo, {
        title: "Hosting repozytoriów projektu delta",
        facts: [`${question} → GitHub`],
        concepts: ["trade-off", "hosting"],
        created_at: t0,
      });
      digest(repo, {
        title: "Hosting repozytoriów projektu delta na serwerze VPS",
        facts: [`${question} → Gitea na VPS`],
        concepts: ["trade-off", "hosting"],
        created_at: t0 + DAY,
      });
      const p1 = digest(repo, {
        type: "preference",
        title: "Ustalono domyślny próg przypominania promptów w konfiguracji",
        files_modified: ["src/config.ts"],
        created_at: t0,
      });
      const p2 = digest(repo, {
        type: "preference",
        title: "Ustalono domyślny próg przypominania promptów w konfiguracji workera",
        files_modified: ["src/config.ts", "src/worker/main.ts"],
        created_at: t0 + DAY,
      });
      // luźno podobny tytuł (Jaccard 0,6 do 0,8) o tym samym pliku: bez wektorów za mało
      const l1 = digest(repo, { title: "Decyzja worker hook procesów potomnych", files_modified: ["src/z.ts"], created_at: t0 });
      digest(repo, {
        title: "Decyzja worker hook procesów potomnych bez gniazd",
        files_modified: ["src/z.ts"],
        created_at: t0 + DAY,
      });
      expect(await sup(repo, t0 - DAY, { embed: false })).toBe(2);
      expect(repo.getObservation(q1)!).toMatchObject({ status: "superseded", superseded_by: q2 });
      expect(repo.getObservation(p1)!).toMatchObject({ status: "superseded", superseded_by: p2 });
      expect((repo.getObservation(q1)!.meta?.supersede as any)?.reason).toBe("to samo pytanie i plik (bez wektorów)");
      expect((repo.getObservation(p1)!.meta?.supersede as any)?.reason).toBe("niemal ten sam tytuł i plik (bez wektorów)");
      for (const id of [q2, n1, l1]) expect(repo.getObservation(id)!.status).toBe("active");
      // drugi przebieg nic nie zmienia
      expect(await sup(repo, t0 - DAY, { embed: false })).toBe(0);
    });

    test("digest: ogólne pytanie (AskUserQuestion „Jak chcesz kontynuować?”) nie łączy różnych tematów nawet przy tej samej treści", async () => {
      const repo = memRepo();
      mockVectors(repo, unit(1)); // cosinus 1 dla każdej pary: odrzucają same reguły
      const t0 = Date.now() - 10 * DAY;
      const a = digest(repo, {
        title: "Migracja bazy klientów na Postgres 17 w oknie serwisowym",
        facts: ["Decyzja: Jak chcesz kontynuować? → Opcja A: migracja w nocy", "Plan: dump, restore, przełączenie DNS"],
        concepts: ["trade-off", "postgres", "migracja"],
        files_read: ["db/schema.sql"],
        created_at: t0,
      });
      const b = digest(repo, {
        title: "Refaktor kolejki zadań",
        facts: ["Decyzja: Czy mam kontynuować? → Tak"],
        files_modified: ["src/worker/jobs.ts"],
        created_at: t0,
      });
      const many = [1, 2, 3, 4].map((i) =>
        digest(repo, {
          title: `Ustalenie numer ${i} w zupełnie innej sprawie`,
          facts: ["Decyzja: Jak chcesz kontynuować? → Dalej"],
          created_at: t0 - i * DAY,
        }),
      );
      digest(repo, {
        title: "Nowy panel administracyjny wdrożony na produkcję",
        facts: ["Decyzja: Jak chcesz kontynuować? → Wdrażaj teraz"],
        concepts: ["trade-off", "panel", "deploy"],
        files_read: ["deploy.sh"],
        created_at: t0 + DAY,
      });
      digest(repo, {
        title: "Naprawa limitu czasu hooka",
        facts: ["Decyzja: Czy mam kontynuować? → Tak", "Decyzja: Commit? → Tak"],
        files_modified: ["src/worker/jobs.ts", "src/hooks/run.ts"],
        created_at: t0 + DAY,
      });
      expect(await sup(repo, t0 - DAY / 2, { embed: true })).toBe(0);
      for (const id of [a, b, ...many]) expect(repo.getObservation(id)!.status).toBe("active");
      expect(S.isSpecificQuestion("Jak chcesz kontynuować?")).toBe(false);
      expect(S.isSpecificQuestion("Czy mam kontynuować?")).toBe(false);
      expect(S.isSpecificQuestion("Którą bazę danych wybrać dla serwisu klientów?")).toBe(true);
    });

    test("digest: numery w tytułach (PR, wersja) i pliki tylko czytane nie łączą notatek nawet przy tej samej treści", async () => {
      const repo = memRepo();
      mockVectors(repo, unit(1));
      const t0 = Date.now() - 10 * DAY;
      const pr = digest(repo, {
        title: "Recenzja PR #5: werdykt popraw przed merge",
        concepts: ["trade-off", "recenzja", "merge"],
        created_at: t0,
      });
      digest(repo, {
        title: "Recenzja PR #6: werdykt popraw przed merge",
        concepts: ["trade-off", "recenzja", "merge"],
        created_at: t0 + DAY,
      });
      const ver = digest(repo, {
        title: "Wydanie wersji 1.4 klienta mobilnego na produkcję",
        concepts: ["trade-off", "wydanie"],
        files_modified: ["package.json"],
        created_at: t0,
      });
      digest(repo, {
        title: "Wydanie wersji 1.5 klienta mobilnego na produkcję",
        concepts: ["trade-off", "wydanie"],
        files_modified: ["package.json", "CHANGELOG.md"],
        created_at: t0 + DAY,
      });
      // jedyna wspólna rzecz to CLAUDE.md i TASKS.md, które czyta każda sesja
      const read = digest(repo, {
        title: "Ustalono kolejność pracy nad zadaniami agentów",
        files_read: ["CLAUDE.md", "TASKS.md"],
        created_at: t0,
      });
      digest(repo, {
        title: "Ustalono kolejność pracy nad zadaniami agentów",
        files_read: ["CLAUDE.md", "TASKS.md"],
        created_at: t0 + DAY,
      });
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      for (const id of [pr, ver, read]) expect(repo.getObservation(id)!.status).toBe("active");
      expect(S.titleNumbers("Recenzja PR #5")).not.toBe(S.titleNumbers("Recenzja PR #6"));
    });

    test("digest: precyzja ponad recall (bez wspólnego tematu, praca na innych plikach, inny projekt, inne pytanie, podmiana nazwy)", async () => {
      const repo = memRepo();
      mockVectors(repo, unit(1));
      const t0 = Date.now() - 30 * DAY;
      const pairs: [number, number][] = [];
      const pair = (a: Partial<Obs> & { title: string }, b: Partial<Obs> & { title: string }) => {
        pairs.push([digest(repo, { created_at: t0, ...a }), digest(repo, { created_at: t0 + DAY, ...b })]);
      };
      // ten sam tytuł, ale nic wspólnego poza pojęciem typu (trade-off ma każda decyzja)
      pair({ title: "Worker bez procesów potomnych na Windows" }, { title: "Worker bez procesów potomnych na Windows" });
      // starsza zmieniała plik, którego nowsza nie dotyka: zastąpienie schowałoby tamtą pracę
      pair(
        { title: "Ustalono format odcisków plików notatek", files_modified: ["src/util/git.ts"], concepts: ["odciski"] },
        { title: "Ustalono format odcisków plików notatek", concepts: ["odciski"] },
      );
      // inny projekt
      pair(
        { title: "Ustalono format odcisków plików notatek", files_modified: ["src/y.ts"] },
        { title: "Ustalono format odcisków plików notatek", files_modified: ["src/y.ts"], project: "inny" },
      );
      // inne pytanie do użytkownika
      pair(
        { title: "Pytanie A", facts: ["Decyzja: Który model wektorów wybrać do indeksu notatek? → bge-m3"] },
        { title: "Pytanie B", facts: ["Decyzja: Który port sieciowy dostaje proces workera? → 47777"] },
      );
      // podmiana nazwy (inne repo, projekt, preset): dwie różne decyzje, choć tytuł i treść prawie te same
      const main = { concepts: ["trade-off", "main", "gitea"] };
      pair(
        { title: "Gałąź main chroniona w repo hipokamp, tylko przez PR", ...main },
        { title: "Gałąź main chroniona w repo sklep, tylko przez PR", ...main },
      );
      const key = { concepts: ["trade-off", "openrouter", "klucz"] };
      pair(
        { title: "Klucz OpenRouter dla projektu alpha utworzony z limitem miesięcznym", ...key },
        { title: "Klucz OpenRouter dla projektu beta utworzony z limitem miesięcznym", ...key },
      );
      const preset = { concepts: ["trade-off", "preset", "kamera"] };
      pair(
        { title: "Preset kamery Studio zapisany w rejestrze presetów", ...preset },
        { title: "Preset kamery Biuro zapisany w rejestrze presetów", ...preset },
      );
      // to samo konkretne pytanie, ale o inne repo (odpowiedź „Tak” nie zawiera nazwy: weto zostaje)
      const q = "Decyzja: Czy przenieść repozytorium na Gitea z pełną historią i tagami? → Tak";
      pair(
        { title: "Repo hipokamp przeniesione na Gitea z pełną historią.", facts: [q], concepts: ["trade-off", "gitea"] },
        { title: "Repo sklep przeniesione na Gitea z pełną historią.", facts: [q], concepts: ["trade-off", "gitea"] },
      );
      // cofnięte zastąpienie nie wraca
      const undone = digest(repo, {
        title: "Ustalono nazwę gałęzi zadań agentów",
        files_modified: ["TASKS.md"],
        created_at: t0,
        meta: { supersede_undone: { by: 1 } },
      });
      digest(repo, { title: "Ustalono nazwę gałęzi zadań agentów", files_modified: ["TASKS.md"], created_at: t0 + DAY });
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      for (const [a] of pairs) expect(repo.getObservation(a)!.status).toBe("active");
      expect(repo.getObservation(undone)!.status).toBe("active");
      // weto podmiany nazwy: nazwa własna, słowo za „repo”/„projektu”, identyfikator; zwykłe słowo i sama liczba nie
      expect(S.nameSwap("Preset kamery Studio zapisany", "Preset kamery Biuro zapisany")).toBe(true);
      expect(S.nameSwap("Deploy projektu alpha na VPS", "Deploy projektu beta na VPS")).toBe(true);
      expect(S.nameSwap("Worker na vps-main", "Worker na vps-dev")).toBe(true);
      expect(S.nameSwap("Commity piszemy po polsku", "Commity piszemy po angielsku")).toBe(false);
      expect(S.nameSwap("Port workera to 47777", "Port workera to 47778")).toBe(false);
      expect(S.nameSwap("Raport gotowy", "Raport poranny gotowy na czas")).toBe(false);
      // znane projekty: odmiana, mała litera, ł; ta sama nazwa w innej odmianie to nie podmiana; krótkie nazwy pomijane
      const stems = S.projectStems(["hipokamp", "sklep", "łódź-app", "omega/ui"]);
      expect(S.nameSwap("Worker hipokampa słucha", "Worker sklepu słucha")).toBe(false);
      expect(S.nameSwap("Worker hipokampa słucha", "Worker sklepu słucha", stems)).toBe(true);
      expect(S.nameSwap("Deploy hipokamp na VPS", "Deploy hipokampa na VPS", stems)).toBe(false);
      expect(S.nameSwap("Deploy na łodzi", "Deploy na hipokampie", stems)).toBe(true);
      expect(S.nameSwap("Deploy na łodzi", "Deploy na hipokampie")).toBe(false);
      expect(S.nameSwap("Gałąź chroniona w repo hipokamp", "Gałąź chroniona w sklepie", stems)).toBe(true);
      expect(S.nameSwap("Gałąź chroniona w repo sklep", "Gałąź chroniona w sklepie", stems)).toBe(false);
      expect(S.nameSwap("Okno ui szare", "Okno ux szare", stems)).toBe(false);
      expect(S.nameSwap("Commity piszemy po polsku", "Commity piszemy po angielsku", stems)).toBe(false);
    });

    test("digest: weto nazw znanych projektów małą literą i odmienionych (pary z trzeciej recenzji)", async () => {
      const repo = memRepo();
      mockVectors(repo, unit(1)); // cosinus 1: odrzuca samo weto
      const t0 = Date.now() - 10 * DAY;
      // znane projekty z sesji (w prawdziwej bazie: sesje, aliasy katalogów, scalenia)
      for (const p of ["hipokamp", "sklep"])
        repo.upsertSession({ id: `s-${p}`, project: p, cwd: `D:/code/${p}`, started_at: t0 - 5 * DAY });
      const main = { concepts: ["trade-off", "main", "gitea"] };
      // ta sama decyzja innymi słowami (ten sam projekt): przechodzi
      const sameRepo = digest(repo, {
        title: "Gałąź main chroniona w repo hipokamp, tylko przez PR",
        ...main,
        created_at: t0 - DAY,
      });
      const olders: number[] = [];
      const pair = (a: string, b: string, more: Partial<Obs>) => {
        olders.push(digest(repo, { title: a, ...more, created_at: t0 }));
        digest(repo, { title: b, ...more, created_at: t0 + DAY });
      };
      pair("Gałąź main chroniona w hipokampie, tylko przez PR", "Gałąź main chroniona w sklepie, tylko przez PR", main);
      pair("Worker hipokampa słucha tylko na localhost", "Worker sklepu słucha tylko na localhost", {
        concepts: ["trade-off", "worker", "localhost"],
      });
      pair("Deploy hipokamp na VPS przez ansible i docker", "Deploy sklep na VPS przez ansible i docker", {
        concepts: ["trade-off", "deploy", "vps", "docker"],
      });
      const plan = await S.supersedeSimilar(repo, t0 - DAY / 2, { dryRun: true, embed: true });
      // jedyna para: „w repo hipokamp” → „w hipokampie”; „w sklepie” nie zastępuje ani hipokampa, ani starszej o nim
      expect(plan.map((p) => [p.older, p.newerTitle])).toEqual([[sameRepo, "Gałąź main chroniona w hipokampie, tylko przez PR"]]);
      for (const id of olders) expect(plan.some((p) => p.older === id)).toBe(false);
    });

    test("digest: na drodze pytania nazwa będąca nową odpowiedzią nie wetuje (GitHub → Gitea, Qwen-4.6 → Qwen-5.3)", async () => {
      const repo = memRepo();
      const vecs = mockVectors(repo, near(0.8)); // cosinus 0,8 z unit(1): ponad 0,75 pytania, pod 0,85 tytułu
      for (const p of ["hipokamp", "sklep"])
        repo.upsertSession({ id: `q-${p}`, project: p, cwd: `D:/code/${p}`, started_at: Date.now() - 40 * DAY });
      const t0 = Date.now() - 10 * DAY;
      const ok: [number, number][] = [];
      const pair = (q: string, a: [string, string], b: [string, string], type = "decision") => {
        const x = digest(repo, { type, title: a[0], facts: [`Decyzja: ${q} → ${a[1]}`], created_at: t0 });
        const y = digest(repo, { type, title: b[0], facts: [`Decyzja: ${q} → ${b[1]}`], created_at: t0 + DAY });
        vecs.set(x, unit(1));
        ok.push([x, y]);
      };
      pair(
        "Gdzie zakładamy nowe repozytoria projektów Omega?",
        ["Repozytoria trzymamy na GitHub", "GitHub"],
        ["Repozytoria trzymamy na Gitea", "Gitea"],
      );
      pair(
        "Który model ustawić na stałe w MCP tool-x dla workerów?",
        ["Model w MCP tool-x to Qwen-4.6", "Qwen-4.6"],
        ["Model w MCP tool-x to Qwen-5.3", "Qwen-5.3"],
      );
      pair(
        "Który model wektorów wybrać do indeksu notatek?",
        ["Wektory liczy model bge-m3", "bge-m3"],
        ["Wektory liczy model e5-small", "e5-small"],
      );
      // spójność z wetem nazw projektów: projekt w odpowiedzi to nowa wartość, nie inne repo
      pair(
        "Gdzie trzymamy kopie zapasowe kluczy API projektów?",
        ["Kopie kluczy API trzymamy w hipokampie", "w hipokampie"],
        ["Kopie kluczy API trzymamy w sklepie", "w sklepie"],
      );
      // preferencja bez pytania: nazwa w tytule nadal wetuje (zmiana wartości: remember z key)
      const sh = { type: "preference", concepts: ["pattern", "shell"] };
      const p1 = digest(repo, { ...sh, title: "Domyślny shell w terminalu Windows to PowerShell", created_at: t0 });
      const p2 = digest(repo, { ...sh, title: "Domyślny shell w terminalu Windows to Bash", created_at: t0 + DAY });
      vecs.set(p1, unit(1));
      vecs.set(p2, unit(1)); // cosinus 1: odrzuca samo weto
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(4);
      for (const [x, y] of ok) expect(repo.getObservation(x)!.superseded_by).toBe(y);
      expect(repo.getObservation(p1)!.status).toBe("active");
    });

    test("digest z wektorami: podobny tytuł wymaga cosinusa ≥ 0,85, para bez obu wektorów czeka", async () => {
      const repo = memRepo();
      const vecs = mockVectors(repo);
      const t0 = Date.now() - 10 * DAY;
      const base = { title: "Ustalono domyślny budżet kontekstu startowego sesji", concepts: ["trade-off", "budżet"] };
      const a = digest(repo, { ...base, created_at: t0 });
      const b = digest(repo, { ...base, created_at: t0 + DAY });
      vecs.set(a, unit(1));
      const waiting: number[] = [];
      expect(await sup(repo, t0 - DAY, { embed: true, onPending: (at) => waiting.push(at) })).toBe(0);
      expect(waiting).toEqual([t0 + DAY]);
      vecs.set(b, unit(2)); // cosinus 0: inna treść mimo tytułu
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      vecs.set(b, near(0.8));
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      vecs.set(b, near(0.9));
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(1);
      expect(repo.getObservation(a)!.superseded_by).toBe(b);
    });

    test("digest z wektorami: to samo konkretne pytanie wystarcza z cosinusem ≥ 0,75, także przy innej liczbie w tytule", async () => {
      const repo = memRepo();
      const vecs = mockVectors(repo);
      const t0 = Date.now() - 10 * DAY;
      const q = "Decyzja: Który model ustawić na stałe w MCP tool-x dla workerów?";
      const a = digest(repo, { title: "Ustawiłem model Qwen-4.6 w MCP tool-x.", facts: [`${q} → Qwen-4.6`], created_at: t0 });
      const b = digest(repo, {
        title: "Zmieniłem model w MCP tool-x na Qwen-5.3-Flash.",
        facts: [`${q} → Qwen-5.3-Flash`],
        created_at: t0 + DAY,
      });
      vecs.set(a, unit(1));
      vecs.set(b, unit(4)); // to samo pytanie, ale treść o czym innym: bez zastąpienia
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      vecs.set(b, near(0.7));
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(0);
      vecs.set(b, near(0.78));
      const plan = await S.supersedeSimilar(repo, t0 - DAY, { dryRun: true, embed: true });
      expect(plan).toMatchObject([{ older: a, newer: b, reason: "to samo pytanie" }]);
      expect(plan[0].cos).toBeCloseTo(0.78, 1);
      expect(repo.getObservation(a)!.status).toBe("active"); // próba nic nie zapisuje
      expect(await sup(repo, t0 - DAY, { embed: true })).toBe(1);
    });

    test("digest: nowa notatka pasująca do więcej niż 3 starszych nie zastępuje żadnej (czekające na wektory też się liczą)", async () => {
      const repo = memRepo();
      mockVectors(repo, unit(1));
      const t0 = Date.now() - 10 * DAY;
      const base = { title: "Ustalono domyślny katalog kopii zapasowych bazy", concepts: ["trade-off", "kopie"] };
      const olders = [1, 2, 3, 4].map((i) => digest(repo, { ...base, created_at: t0 - i * DAY }));
      const b = digest(repo, { ...base, created_at: t0 + DAY });
      expect(await sup(repo, t0, { embed: true })).toBe(0);
      // trzy z wektorami i jedna bez: 3 trafienia + 1 czekająca > 3, dalej nic
      const vecs = mockVectors(repo);
      for (const id of [...olders.slice(0, 3), b]) vecs.set(id, unit(1));
      expect(await sup(repo, t0, { embed: true })).toBe(0);
      for (const id of olders) expect(repo.getObservation(id)!.status).toBe("active");
      // dokładnie trzy pasujące: wszystkie trzy zastąpione
      mockVectors(repo, unit(1));
      repo.setStatus(olders[3], "archived");
      expect(await sup(repo, t0, { embed: true })).toBe(3);
      for (const id of olders.slice(0, 3)) expect(repo.getObservation(id)!.superseded_by).toBe(b);
    });

    /** Sen czyta konfigurację z pliku przy każdym przebiegu (loadConfig(true)): testy piszą config.json i go sprzątają. */
    const withConfig = async (over: Record<string, unknown>, fn: () => Promise<void>) => {
      const p = configPath();
      const before = existsSync(p) ? readFileSync(p, "utf8") : null;
      writeFileSync(p, JSON.stringify(over));
      try {
        await fn();
      } finally {
        if (before === null) rmSync(p, { force: true });
        else writeFileSync(p, before);
        loadConfig(true);
      }
    };
    // numery notatek powtarzają się między bazami testów, a katalog logów jest wspólny: para po numerze i tytule
    const sleepLog = (older: number, title: string) =>
      readdirSync(paths.logs())
        .filter((f) => /^sleep-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .flatMap((f) => readFileSync(join(paths.logs(), f), "utf8").trim().split("\n"))
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.older === older && l.olderTitle === title);

    test("tryb zastępowania: bez wielkości liter i spacji, nieznana wartość to propose z ostrzeżeniem", () => {
      expect(DEFAULTS.consolidation.supersedeDigest).toBe("propose");
      for (const v of ["apply", "Apply", " APPLY ", true, "true"]) expect(S.supersedeMode(v)).toBe("apply");
      for (const v of [false, "off", " False"]) expect(S.supersedeMode(v)).toBe("off");
      for (const v of [undefined, "propose", "Propose", "zapisuj", "constructor", 1]) expect(S.supersedeMode(v)).toBe("propose");
      expect(S.supersedeModeWarning(undefined)).toBeNull();
      expect(S.supersedeModeWarning(" Apply")).toBeNull();
      expect(S.supersedeModeWarning("zapisuj")).toContain("nieznana wartość");
      expect(S.supersedeModeWarning("constructor")).toContain("nieznana wartość");
    });

    test("sen: domyślnie tylko propozycje w logu (bez powtórek), „apply” zastępuje, false wyłącza; jeden sen naraz", async () => {
      // sqlite-vec w tym połączeniu: sen pyta o obs_vec_bits, gdy proces ma wektory (test ścieżki promptu je ładuje)
      const repo = new Repo(openDb({ path: file("sleep.db"), vectors: true }));
      const t0 = Date.now() - 5 * DAY;
      const base = { title: "Ustalono domyślny próg przypominania promptów", files_modified: ["src/config.ts"] };
      const a = digest(repo, { ...base, created_at: t0 });
      const b = digest(repo, { ...base, created_at: t0 + DAY });
      // bez wektorów: wspólny plik i ten sam tytuł
      await withConfig({ embed: { enabled: false }, consolidation: { supersedeDigest: false } }, async () => {
        expect(await sleep(repo, { full: true })).toMatchObject({ superseded: 0, proposed: 0 });
        expect(sleepLog(a, base.title)).toHaveLength(0);
      });
      // plik bez klucza: domyślne „propose”; konfiguracja zmieniona w trakcie życia procesu działa od następnego snu
      await withConfig({ embed: { enabled: false } }, async () => {
        expect(await sleep(repo, { full: true })).toMatchObject({ superseded: 0, proposed: 1 });
        expect(repo.getObservation(a)!.status).toBe("active");
        expect(sleepLog(a, base.title)).toMatchObject([{ kind: "propose", newer: b, olderTitle: base.title }]);
        expect(sleepStatus(repo.db)).toContain("zaproponowane 1");
        // następny sen (okna nachodzą na siebie): ta sama para nie trafia do logu drugi raz
        expect(await sleep(repo, { full: true })).toMatchObject({ superseded: 0, proposed: 0 });
        expect(sleepLog(a, base.title)).toHaveLength(1);
      });
      await withConfig({ embed: { enabled: false }, consolidation: { supersedeDigest: " Apply" } }, async () => {
        expect(sleepStatus(repo.db)).toContain("zapis (apply)");
        // dwa sny naraz: drugi dostaje wynik pierwszego (jeden przebieg)
        const [r1, r2] = await Promise.all([sleep(repo, { full: true }), sleep(repo, { full: true })]);
        expect(r1).toBe(r2);
        expect(r1).toMatchObject({ superseded: 1, proposed: 0 });
        expect(repo.getObservation(a)!).toMatchObject({ status: "superseded", superseded_by: b });
        expect(sleepLog(a, base.title).map((l) => l.kind)).toEqual(["propose", "supersede"]);
      });
    });

    test("sen: para czekająca na wektory wraca w następnym śnie, choć jest starsza niż okno", async () => {
      const repo = new Repo(openDb({ path: file("sleep-pending.db"), vectors: true }));
      const t0 = Date.now() - 5 * DAY;
      const base = { title: "Ustalono domyślny limit kontekstu startowego sesji", concepts: ["trade-off", "kontekst"] };
      const a = digest(repo, { ...base, created_at: t0 });
      const b = digest(repo, { ...base, created_at: t0 + DAY });
      await withConfig({ consolidation: { supersedeDigest: "apply" } }, async () => {
        expect((await sleep(repo, { full: true })).superseded).toBe(0);
        expect(getMeta(repo.db, "supersede_pending_since")).toBe(String(t0 + DAY));
        // wektory doliczone (bez bitów: scalanie duplikatów ich nie widzi); zwykły sen ma okno 2 dni
        repo.putVector(a, "p", "test", unit(1), new Uint8Array(128), false);
        repo.putVector(b, "p", "test", near(0.9), new Uint8Array(128), false);
        expect((await sleep(repo)).superseded).toBe(1);
        expect(repo.getObservation(a)!.superseded_by).toBe(b);
        expect(getMeta(repo.db, "supersede_pending_since")).toBe("0");
      });
    });

    test("supersede --ids: tylko wskazane pary, z propozycji w logu albo z planu; obie notatki muszą być aktywne", async () => {
      const repo = memRepo();
      const t0 = Date.now() - 5 * DAY;
      const base = { title: "Ustalono domyślny czas życia linku transferu", concepts: ["trade-off", "transfer"] };
      const a = digest(repo, { ...base, created_at: t0 });
      const b = digest(repo, { ...base, created_at: t0 + DAY });
      const c = digest(repo, { title: "Inna sprawa bez propozycji", created_at: t0 });
      // propozycja ze snu sprzed tygodnia; plan na bieżącej bazie jej nie da (brak wektorów: para czeka)
      S.logPair(
        {
          older: a,
          newer: b,
          project: "p",
          type: "decision",
          reason: "podobny tytuł i treść",
          jaccard: 1,
          cos: 0.9,
          olderTitle: base.title,
          newerTitle: base.title,
        },
        "propose",
      );
      const r = await S.applySelected(repo, [a, c, 999_999], 10);
      expect(r.applied.map((p) => p.older)).toEqual([a]);
      expect(r.missing.sort()).toEqual([c, 999_999].sort());
      expect(repo.getObservation(a)!).toMatchObject({ status: "superseded", superseded_by: b });
      expect((repo.getObservation(a)!.meta?.supersede as any)?.manual).toBe(true);
      expect(repo.getObservation(c)!.status).toBe("active");
      expect(sleepLog(a, base.title).map((l) => l.kind)).toEqual(["propose", "supersede"]);
      // drugi raz: już nieaktywna
      expect(await S.applySelected(repo, [a], 10)).toMatchObject({ applied: [], skipped: [a] });
    });

    test("sen: wyjątek zwalnia blokadę, następny sen działa", async () => {
      const broken = new Repo(openDb({ path: file("sleep-broken.db") }));
      broken.db.close();
      await expect(sleep(broken)).rejects.toThrow();
      const ok = new Repo(openDb({ path: file("sleep-ok.db"), vectors: true }));
      expect(await sleep(ok)).toMatchObject({ merged: 0, superseded: 0, proposed: 0 });
    });

    test("przycinanie logów: dzienne logi po 14 dniach, dzienniki recall i sleep po 60, zapisy napraw z godziną zostają", () => {
      const day = (n: number) => {
        const d = new Date(Date.now() - n * DAY);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      const names = {
        oldLog: `worker-${day(20)}.log`,
        newLog: `worker-${day(5)}.log`,
        midJsonl: `recall-${day(20)}.jsonl`,
        oldJsonl: `recall-${day(70)}.jsonl`,
        oldSleep: `sleep-${day(70)}.jsonl`,
        midSleep: `sleep-${day(30)}.jsonl`,
        // przestoje pętli (stall, z #12) mają zwykłe 14 dni
        midStall: `stall-${day(20)}.jsonl`,
        repair: `repair-${day(400)}-10-00-00.jsonl`,
        // inne pliki .jsonl nie są dziennikami dziennymi tego modułu: zostają
        otherJsonl: `inny-${day(70)}.jsonl`,
        other: "notatka.txt",
      };
      for (const f of Object.values(names)) writeFileSync(join(paths.logs(), f), "{}\n");
      expect(pruneLogs()).toBe(4);
      const left = new Set(readdirSync(paths.logs()));
      for (const k of ["oldLog", "oldJsonl", "oldSleep", "midStall"] as const) expect(left.has(names[k])).toBe(false);
      for (const k of ["newLog", "midJsonl", "midSleep", "repair", "otherJsonl", "other"] as const)
        expect(left.has(names[k])).toBe(true);
    });

    test("wyszukiwanie z includeArchived pokazuje notatkę zastąpioną ze statusem i aktualną wersją", () => {
      const repo = memRepo();
      const a = remember(repo, { project: "p", text: "Kopie bazy trzymamy tydzień.", key: "kopie bazy" });
      const b = remember(repo, { project: "p", text: "Kopie bazy trzymamy miesiąc.", key: "kopie bazy" });
      expect(ftsSearch(repo.db, "kopie bazy trzymamy", { project: "p" }).map((h) => h.id)).toEqual([b.id]);
      const all = ftsSearch(repo.db, "kopie bazy trzymamy", { project: "p", includeArchived: true }).map((h) => h.id);
      expect(all.sort()).toEqual([a.id, b.id].sort());
      expect(obsLine(repo.getObservation(a.id)!)).toContain(`(superseded → #${b.id})`);
    });

    test("CLI supersede --dry-run pokazuje plan bez zapisu, --ids zastępuje tylko wskazane, bez flag wszystkie", () => {
      const db = openDb();
      const repo = new Repo(db);
      const t0 = Date.now() - 3 * DAY;
      const base = { title: "Ustalono domyślny katalog kopii zapasowych bazy", files_modified: ["src/core/backup.ts"] };
      const a = digest(repo, { ...base, created_at: t0 });
      const b = digest(repo, { ...base, created_at: t0 + DAY });
      const base2 = { title: "Ustalono domyślny limit rozmiaru logów workera", files_modified: ["src/log.ts"] };
      const c = digest(repo, { ...base2, created_at: t0 });
      const d = digest(repo, { ...base2, created_at: t0 + DAY });
      for (const [o, v] of [
        [a, unit(1)],
        [b, near(0.9)],
        [c, unit(1)],
        [d, near(0.9)],
      ] as const)
        repo.putVector(o, "p", "test", v, new Uint8Array(128), false);
      db.close();
      const cli = (...args: string[]) =>
        Bun.spawnSync([process.execPath, "src/cli.ts", "supersede", ...args], {
          cwd: join(import.meta.dir, ".."),
          env: process.env as Record<string, string>,
        });
      const dry = cli("--dry-run", "--json", "--days", "10");
      expect(dry.exitCode).toBe(0);
      const plan = JSON.parse(dry.stdout.toString()) as { older: number; newer: number; reason: string }[];
      expect(plan.map((p) => [p.older, p.newer]).sort()).toEqual(
        [
          [a, b],
          [c, d],
        ].sort(),
      );
      expect(plan[0].reason).toBe("podobny tytuł i treść");
      const status = (id: number) => {
        const x = openDb({ readonly: true });
        const s = new Repo(x).getObservation(id)!.status;
        x.close();
        return s;
      };
      expect([status(a), status(c)]).toEqual(["active", "active"]);
      // samo --ids bez numerów albo z błędnym numerem: błąd i nic nie zastąpione (nie „zastąp wszystko”)
      for (const bad of [["--ids"], ["--ids=x"], ["--ids", "--days", "10"]]) {
        const r = cli(...bad);
        expect(r.exitCode).toBe(1);
      }
      expect([status(a), status(c)]).toEqual(["active", "active"]);
      const only = cli("--ids", `#${c}`, "--days", "10");
      expect(only.exitCode).toBe(0);
      expect(only.stdout.toString()).toContain(`#${c} → #${d}`);
      expect([status(a), status(c)]).toEqual(["active", "superseded"]);
      const real = cli("--days", "10");
      expect(real.exitCode).toBe(0);
      expect(real.stdout.toString()).toContain(`#${a} → #${b}`);
      expect(status(a)).toBe("superseded");
    });
  });

  // ------------------------------------------------------------ T-15

  describe("ścieżka promptu: globalne FTS tylko przy słabym lokalnym, jeden wektor zapytania, czasy etapów (T-15)", () => {
    const repo = new Repo(openDb({ path: file("prompt.db"), vectors: true }));
    let s = 42;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32 - 0.5;
    };
    const randVec = () => {
      const v = new Float32Array(1024);
      let n = 0;
      for (let i = 0; i < v.length; i++) n += (v[i] = rnd()) ** 2;
      for (let i = 0; i < v.length; i++) v[i] /= Math.sqrt(n);
      return v;
    };
    const now = Date.now();
    const add = (project: string, title: string, v: Float32Array) => {
      const id = repo.insertObservation({
        session_id: null,
        project,
        type: "decision",
        title,
        narrative: title,
        importance: 0.7,
        created_at: now - DAY,
        source: "digest",
      }).id;
      repo.putVector(id, project, "test", toQ8(v), toBits(v), true);
      return id;
    };
    const topic = randVec();
    const foreignTopic = randVec();
    const local = add("lokalny", "Kolejka zadań workera z ponawianiem", topic);
    for (let i = 0; i < 6; i++) add("lokalny", `Notatka poboczna numer ${i} o czymś innym`, randVec());
    // ten sam temat w innym projekcie: stara ścieżka dokładała go zawsze, nowa tylko przy słabym lokalnym
    const foreignSame = add("obcy", "Kolejka zadań workera z ponawianiem w innym repo", topic);
    const foreignOnly = add("obcy", "Rotacja kluczy w sejfie", foreignTopic);
    let calls = 0;
    const embedder = (v: Float32Array) =>
      ({
        loaded: true,
        embed: async () => {
          calls++;
          return [v];
        },
      }) as any;
    const ask = async (v: Float32Array, session: string) =>
      promptContext(repo, embedder(v), {
        project: "lokalny",
        sessionId: session,
        prompt: "jak działała kolejka zadań z ponawianiem w workerze?",
        record: false,
      });

    test("vectorSearch i ftsSearch z excludeProject pomijają bieżący projekt", () => {
      const ids = vectorSearch(repo, topic, 10, { excludeProject: "LOKALNY" }).map((h) => h.id);
      expect(ids).toContain(foreignSame);
      expect(ids).not.toContain(local);
      const f = ftsSearch(repo.db, "kolejka zadań workera", { excludeProject: "lokalny" }).map((h) => h.id);
      expect(f).toContain(foreignSame);
      expect(f).not.toContain(local);
    });

    test("mocne lokalne: bez globalnego FTS, KNN innych projektów dalej działa, wektor zapytania liczony raz", async () => {
      resetPromptProfile();
      calls = 0;
      const r = await ask(topic, "s-mocne");
      expect(r?.ids).toContain(local);
      expect(r?.ids).toContain(foreignSame);
      expect(calls).toBe(1);
      const ms = (r!.debug as any).ms;
      expect(ms.global).toBe(false);
      for (const k of ["embed", "fts", "vec", "rank", "total"]) expect(ms[k]).toBeGreaterThanOrEqual(0);
      expect(ms.total + 0.2).toBeGreaterThanOrEqual(ms.fts + ms.vec);
    });

    test("słabe lokalne: globalne bez bieżącego projektu, nadal jeden wektor zapytania", async () => {
      calls = 0;
      const r = await ask(foreignTopic, "s-slabe");
      expect(calls).toBe(1);
      expect((r!.debug as any).ms.global).toBe(true);
      expect(r?.ids).toContain(foreignOnly);
    });

    test("czasy etapów w logu decyzji i w profilu workera", () => {
      const lines = readdirSync(paths.logs())
        .filter((f) => f.startsWith("recall-"))
        .flatMap((f) => readFileSync(join(paths.logs(), f), "utf8").trim().split("\n"))
        .map((l) => JSON.parse(l));
      const strong = lines.find((l) => l.session === "s-mocne");
      expect(strong.ms).toMatchObject({ global: false });
      expect(typeof strong.ms.embed).toBe("number");
      expect(lines.find((l) => l.session === "s-slabe").ms.global).toBe(true);
      const p = promptProfile()!;
      expect(p.n).toBe(2);
      expect(p.globalShare).toBe(0.5);
      expect(Object.keys(p.p95).sort()).toEqual(["embed", "fts", "rank", "total", "vec"]);
    });

    test("średnie lokalne (pewność ≥ 0,75) nie zasłania dużo lepszego trafienia z innego projektu", async () => {
      // wektor o zadanym cosinusie do zapytania: cos·q + sin·r (r prawie prostopadły, 1024 wymiary)
      const mix = (q: Float32Array, cos: number) => {
        const r = randVec();
        const v = new Float32Array(1024);
        let n = 0;
        for (let i = 0; i < v.length; i++) n += (v[i] = cos * q[i] + Math.sqrt(1 - cos * cos) * r[i]) ** 2;
        for (let i = 0; i < v.length; i++) v[i] /= Math.sqrt(n);
        return v;
      };
      const q = randVec();
      const mid = add("sredni", "Notatka lokalna o podobnym temacie", mix(q, 0.68)); // pewność ok. 0,82
      const strong = add("obcy", "Notatka z innego projektu dokładnie o tym", mix(q, 0.97));
      const r = await promptContext(repo, embedder(q), {
        project: "sredni",
        sessionId: "s-srednie",
        prompt: "co ustaliliśmy w tej sprawie wcześniej?",
        record: false,
      });
      expect(r?.ids).toContain(mid);
      expect(r?.ids).toContain(strong);
      expect((r!.debug as any).ms.global).toBe(false); // globalne FTS pominięte, globalne KNN nie
    });
  });

  // ------------------------------------------------------------ T-03

  describe("recall-stats: próg na logach decyzji (T-03)", () => {
    const NOW = Date.UTC(2026, 9, 20, 12);
    /** Syntetyczny dziennik: decyzje z wektorami w przedziałach pewności, część notatek pobrana po decyzji. */
    const scenario = (bands: { conf: number; n: number; fetched: number; outcome: string }[], spanDays = 15) => {
      const dir = join(DATA_DIR, `stats-${++seq}`);
      mkdirSync(dir, { recursive: true });
      const repo = memRepo();
      const total = bands.reduce((a, b) => a + b.n, 0);
      let i = 0;
      let id = 1000;
      const byDay = new Map<string, string[]>();
      for (const b of bands)
        for (let k = 0; k < b.n; k++) {
          const at = NOW - spanDays * DAY + Math.floor(((i++ + 0.5) / total) * spanDays * DAY);
          const obs = ++id;
          const fired = b.outcome === "poniżej-progu" ? [] : [obs];
          const e = {
            at,
            session: `s${i}`,
            project: "p",
            len: 40,
            hash: "x",
            vectors: true,
            min: 0.62,
            best: [{ id: obs, conf: b.conf }],
            outcome: b.outcome,
            fired,
          };
          const day = new Date(at).toISOString().slice(0, 10);
          byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)]);
          if (k < b.fetched) repo.logAccess([obs], "fetched", `s${i}`, at + 20 * 60_000);
          // pobranie przed decyzją i po oknie nie liczy się
          else {
            repo.logAccess([obs], "fetched", `s${i}`, at - 60_000);
            repo.logAccess([obs], "fetched", `s${i}`, at + 3 * 3_600_000);
          }
        }
      // decyzje bez wektorów (inna skala pewności) i bez kandydatów: poza analizą
      byDay.set("2026-10-19", [
        ...(byDay.get("2026-10-19") ?? []),
        JSON.stringify({
          at: NOW - DAY,
          session: "x",
          vectors: false,
          min: 0.62,
          best: [{ id: 1, conf: 0.9 }],
          outcome: "poniżej-progu",
        }),
        JSON.stringify({ at: NOW - DAY, session: "x", vectors: true, min: 0.62, best: [], outcome: "brak-kandydatów" }),
        "{uszkodzona linia",
      ]);
      for (const [day, lines] of byDay) writeFileSync(join(dir, `recall-${day}.jsonl`), `${lines.join("\n")}\n`);
      return recallStats(repo, { logsDir: dir, days: 30, windowMin: 60, threshold: 0.62, now: NOW });
    };

    test("obniża, gdy notatki tuż pod progiem i tak są pobierane", () => {
      const r = scenario([
        { conf: 0.6, n: 40, fetched: 16, outcome: "poniżej-progu" },
        { conf: 0.55, n: 40, fetched: 14, outcome: "poniżej-progu" },
        { conf: 0.5, n: 40, fetched: 2, outcome: "poniżej-progu" },
        { conf: 0.64, n: 40, fetched: 16, outcome: "zwrócone" },
        { conf: 0.8, n: 100, fetched: 40, outcome: "wstrzyknięte" },
      ]);
      expect(r.decisions).toBe(262);
      expect(r.withoutVectors).toBe(1);
      expect(r.below).toMatchObject({ n: 120, fetched: 32, sameSession: 32 });
      expect(r.fired).toEqual({ n: 140, used: 56 });
      const band = r.bands.find((b) => b.from === 0.57)!;
      expect(band).toMatchObject({ to: 0.62, below: 40, belowFetched: 16 });
      expect(r.recommendation).toMatchObject({ change: "obniż", threshold: 0.52 });
      const text = formatRecallStats(r);
      expect(text).toContain("Rekomendacja: obniż do 0.52");
      expect(text).toContain("← próg");
    });

    test("podnosi, gdy wstrzyknięć tuż nad progiem nikt nie pobiera", () => {
      const r = scenario([
        { conf: 0.6, n: 60, fetched: 1, outcome: "poniżej-progu" },
        { conf: 0.64, n: 40, fetched: 0, outcome: "zwrócone" },
        { conf: 0.69, n: 40, fetched: 1, outcome: "zwrócone" },
        { conf: 0.8, n: 100, fetched: 50, outcome: "zwrócone" },
      ]);
      expect(r.recommendation).toMatchObject({ change: "podnieś", threshold: 0.72 });
    });

    test("zostawia przy zgodnych danych, a przy małej próbie mówi, że danych za mało", () => {
      const keep = scenario([
        { conf: 0.6, n: 80, fetched: 4, outcome: "poniżej-progu" },
        { conf: 0.7, n: 150, fetched: 60, outcome: "zwrócone" },
      ]);
      expect(keep.recommendation.change).toBe("zostaw");
      expect(keep.recommendation.threshold).toBe(0.62);
      const few = scenario([{ conf: 0.6, n: 30, fetched: 20, outcome: "poniżej-progu" }], 3);
      expect(few.recommendation).toMatchObject({ change: "za mało danych", threshold: 0.62 });
    });

    test("decyzje zapisane przy innym progu (pole min) nie mieszają się z analizowanymi", () => {
      const dir = join(DATA_DIR, `stats-${++seq}`);
      mkdirSync(dir, { recursive: true });
      const at = NOW - DAY;
      const e = (min: number | undefined, conf: number, outcome: string) =>
        JSON.stringify({ at, session: "s", project: "p", vectors: true, min, best: [{ id: 1, conf }], outcome, fired: [] });
      writeFileSync(
        join(dir, `recall-${new Date(at).toISOString().slice(0, 10)}.jsonl`),
        `${[
          e(0.62, 0.6, "poniżej-progu"),
          e(0.62, 0.7, "zwrócone"),
          e(undefined, 0.6, "poniżej-progu"), // wpis bez pola: liczony do bieżącego progu
          e(0.55, 0.6, "zwrócone"),
          e(0.55, 0.58, "zwrócone"),
        ].join("\n")}\n`,
      );
      const opts = { logsDir: dir, days: 30, windowMin: 60, now: NOW };
      const r = recallStats(memRepo(), { ...opts, threshold: 0.62 });
      expect(r.decisions).toBe(3);
      expect(r.otherThreshold).toEqual({ n: 2, values: [0.55] });
      expect(r.below.n).toBe(2);
      expect(formatRecallStats(r)).toContain("Przy innym progu (0.55): 2 decyzji");
      const old = recallStats(memRepo(), { ...opts, threshold: 0.55 });
      expect(old.decisions).toBe(3); // 2 przy 0,55 i wpis bez pola
      expect(old.fired.n).toBe(0); // fired bez notatek nie liczy się jako wstrzyknięcie
      expect(old.outcomes).toEqual({ zwrócone: 2, "poniżej-progu": 1 });
    });

    test("CLI recall-stats --json na bazie tylko do odczytu", () => {
      openDb().close(); // baza w katalogu testowym (CLI otwiera ją tylko do odczytu)
      const r = Bun.spawnSync([process.execPath, "src/cli.ts", "recall-stats", "--json", "--days", "30"], {
        cwd: join(import.meta.dir, ".."),
        env: process.env as Record<string, string>,
      });
      expect(r.exitCode).toBe(0);
      const j = JSON.parse(r.stdout.toString());
      expect(j.threshold).toBe(0.62);
      expect(j.decisions).toBeGreaterThanOrEqual(2); // decyzje z testów ścieżki promptu
      expect(j.recommendation.change).toBe("za mało danych");
    });
  });
}
