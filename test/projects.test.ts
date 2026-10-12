// Scalanie projektów (`hipokamp project`): wiersze we wszystkich tabelach, kolizje encji, wektory, idempotencja,
// próba tylko do odczytu, pisownie, mapowanie w resolveProject, klucze złożone z claude-mem i CLI.
// Osobny proces z katalogiem „hipokamp-test” jak w integrity.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHILD = "HIPOKAMP_PROJECTS_CHILD";

if (!process.env[CHILD]) {
  test("scalanie projektów (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/projects.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47993",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `projects: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy scalania projektów nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, claudeDir, paths } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test") || !claudeDir().includes("hipokamp-test"))
    throw new Error("projekty: HIPOKAMP_HOME i CLAUDE_CONFIG_DIR muszą wskazywać katalog testowy");
  const { closeShared, getDb, getMeta, openDb } = await import("../src/db/db.ts");
  const { contentHash, mapMergedProject, parseProjectMerges, Repo } = await import("../src/db/repo.ts");
  const P = await import("../src/core/projects.ts");
  const { backupDir } = await import("../src/core/backup.ts");
  const { ftsSearch } = await import("../src/index/fts.ts");
  const { normPath, PROJECT_RULE, UNKNOWN_PROJECT } = await import("../src/util/paths.ts");
  type RepoT = InstanceType<typeof Repo>;

  const DIMS = 1024;
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 8, 1);
  let seq = 0;
  const file = (name: string) => join(DATA_DIR, `${++seq}-${name}`);
  const freshRepo = () => new Repo(openDb({ path: file("p.db"), vectors: true }));
  const bitsWith = (...on: number[]) => {
    const b = new Uint8Array(DIMS / 8);
    for (const i of on) b[i >> 3] |= 1 << (i & 7);
    return b;
  };
  /** sqlite-vec w połączeniu tylko do odczytu (jak próba w CLI: samo rozszerzenie, bez zapisu do meta). */
  const loadVec = (db: Database) => {
    const sqliteVec = require("sqlite-vec") as typeof import("sqlite-vec");
    db.loadExtension(sqliteVec.getLoadablePath());
  };
  const merges = (db: Database) => JSON.parse(getMeta(db, "project_merges") ?? "{}");
  const count = (db: Database, table: string, project: string) =>
    (db.query(`SELECT COUNT(*) c FROM ${table} WHERE project = ?`).get(project) as { c: number }).c;
  const TABLES = [
    "sessions",
    "prompts",
    "observations",
    "summaries",
    "work_state",
    "entities",
    "obs_entities",
    "project_aliases",
    "corpora",
    "meta",
  ];
  /** Cała treść tabel z kluczem projektu (z wektorami binarnymi): porównanie przed i po. */
  const snapshot = (db: Database) =>
    JSON.stringify([
      ...TABLES.map((t) => db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()),
      db.query("SELECT obs_id, project, hex(emb) h FROM obs_vec_bits ORDER BY obs_id").all(),
    ]);

  /** Notatka z encjami (pliki w zakresie projektu, pojęcie wspólne) i opcjonalnie wektorem. */
  const note = (
    repo: RepoT,
    project: string,
    o: {
      title: string;
      files?: string[];
      session?: string | null;
      at?: number;
      vec?: number;
      source?: "backfill" | "claude-mem";
      hash?: string;
      status?: "active" | "archived";
    },
  ) => {
    const files = o.files ?? [];
    const { id } = repo.insertObservation(
      {
        session_id: o.session ?? null,
        project,
        type: "change",
        title: o.title,
        narrative: `${o.title}.`,
        files_modified: files,
        concepts: ["cache"],
        created_at: o.at ?? T0,
        source: o.source ?? "backfill",
        content_hash: o.hash,
        status: o.status,
      },
      [
        ...files.map((key) => ({ kind: "file" as const, key, role: "modified" as const })),
        { kind: "concept" as const, key: "cache", role: "concept" as const },
      ],
    );
    if (o.vec !== undefined) repo.putVector(id, project, "test", new Int8Array(DIMS).fill(1), bitsWith(o.vec), true);
    return id;
  };

  /** Źródło „Stary” we wszystkich tabelach, cel „Repo” z kolidującą encją pliku, obcy projekt „Inny”. */
  function seed(repo: RepoT) {
    const db = repo.db;
    repo.upsertSession({ id: "s-stary", project: "Stary", cwd: null, started_at: T0, last_activity_at: T0 + DAY });
    repo.upsertSession({ id: "s-repo", project: "Repo", cwd: null, started_at: T0 + DAY });
    repo.insertPrompt({ session_id: "s-stary", project: "Stary", n: 1, text: "napraw kolejkę zadań", created_at: T0 });
    repo.insertPrompt({ session_id: "s-stary", project: "Stary", n: 2, text: "dodaj test kolejki", created_at: T0 + 1000 });
    const r1 = note(repo, "Repo", {
      title: "Port workera w konfiguracji",
      files: ["src/a.ts"],
      session: "s-repo",
      at: T0 + DAY,
      vec: 3,
    });
    const a = note(repo, "Stary", {
      title: "Kolejka zadań gubiła wpisy przy restarcie",
      files: ["src/a.ts", "src/stary.ts"],
      session: "s-stary",
      at: T0 + 2 * DAY,
      vec: 1,
    });
    const b = note(repo, "Stary", {
      title: "Test kolejki pokrywa restart workera",
      files: ["src/a.ts"],
      session: "s-stary",
      at: T0 + 3 * DAY,
      vec: 2,
    });
    const c = note(repo, "Stary", { title: "Archiwalna notatka o starym API", session: "s-stary", status: "archived" });
    const d = note(repo, "Stary", { title: "Notatka z claude-mem o kolejce", source: "claude-mem", hash: "cm-hash-1" });
    const x = note(repo, "Inny", { title: "Inny projekt też ma src/a.ts", files: ["src/a.ts"], vec: 4 });
    repo.insertSummary({
      session_id: "s-stary",
      project: "Stary",
      request: "kolejka zadań",
      investigated: null,
      learned: null,
      completed: "kolejka naprawiona",
      next_steps: null,
      notes: null,
      files_read: [],
      files_edited: ["src/a.ts"],
      prompt_n: 2,
      created_at: T0 + DAY,
      source: "digest",
    });
    repo.appendWorkState("Stary", "todo", { "testy kolejki": "otwarte" }, T0);
    repo.setProjectAlias(join(DATA_DIR, "katalog-stary"), "Stary", PROJECT_RULE);
    const corpus = db.prepare(
      "INSERT INTO corpora (name, description, filters, obs_ids, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)",
    );
    corpus.run("kolejka", JSON.stringify({ project: "Stary", limit: 20 }), JSON.stringify([a, b]), T0, T0);
    corpus.run("inny", JSON.stringify({ project: "Inny", limit: 20 }), "[]", T0, T0);
    return { a, b, c, d, r1, x };
  }

  describe("merge", () => {
    test("przenosi wiersze we wszystkich tabelach z kluczem projektu", () => {
      const repo = freshRepo();
      const ids = seed(repo);
      const r = P.mergeProject(repo.db, "Stary", "Repo");
      for (const t of ["sessions", "prompts", "observations", "summaries", "work_state", "project_aliases", "entities"])
        expect(count(repo.db, t, "Stary")).toBe(0);
      expect(count(repo.db, "sessions", "Repo")).toBe(2);
      expect(count(repo.db, "prompts", "Repo")).toBe(2);
      expect(count(repo.db, "observations", "Repo")).toBe(5);
      expect(count(repo.db, "summaries", "Repo")).toBe(1);
      expect(count(repo.db, "work_state", "Repo")).toBe(1);
      expect(count(repo.db, "project_aliases", "Repo")).toBe(1);
      expect(r.plans[0].counts).toEqual({
        sessions: 1,
        prompts: 2,
        observations: 4,
        active: 3,
        summaries: 1,
        workState: 1,
        aliases: 1,
        entities: 1,
        entitiesMerged: 1,
        links: 2,
        vectors: 2,
        hashes: 3,
        corpora: 1,
        fileKeys: 0,
      });
      // FTS nie ma kolumny projektu (filtr przez wiersz notatki): wyszukiwanie w kluczu docelowym od razu je widzi
      expect(ftsSearch(repo.db, "kolejka restart", { project: "Repo" }).map((h) => h.id)).toEqual(
        expect.arrayContaining([ids.a, ids.b]),
      );
      expect(ftsSearch(repo.db, "kolejka restart", { project: "Stary" })).toEqual([]);
      const filters = (name: string) =>
        JSON.parse((repo.db.query("SELECT filters FROM corpora WHERE name = ?").get(name) as { filters: string }).filters);
      expect(filters("kolejka")).toEqual({ project: "Repo", limit: 20 });
      expect(filters("inny")).toEqual({ project: "Inny", limit: 20 });
      expect(count(repo.db, "observations", "Inny")).toBe(1);
      expect(merges(repo.db)).toEqual({ stary: "Repo" });
      // hash treści: własne notatki od nowa z kluczem docelowym (tam działa deduplikacja), hash z claude-mem bez zmian
      const hashOf = (id: number) =>
        (repo.db.query("SELECT content_hash h FROM observations WHERE id = ?").get(id) as { h: string }).h;
      expect(hashOf(ids.d)).toBe("cm-hash-1");
      const o = repo.getObservation(ids.a)!;
      expect(hashOf(ids.a)).toBe(contentHash({ project: "Repo", title: o.title, narrative: o.narrative, facts: o.facts }));
      const again = repo.insertObservation({
        session_id: null,
        project: "Repo",
        type: "change",
        title: o.title,
        narrative: o.narrative,
        created_at: T0 + 9 * DAY,
        source: "backfill",
      });
      expect(again.duplicateOf).toBe(ids.a);
    });

    test("kolizja encji: powiązania przepięte, df zsumowane, większe last_seen_at", () => {
      const repo = freshRepo();
      const ids = seed(repo);
      const ent = (project: string, key: string) =>
        repo.db
          .query("SELECT id, df, last_seen_at FROM entities WHERE kind = 'file' AND project = ? AND key = ?")
          .get(project, key) as { id: number; df: number; last_seen_at: number } | null;
      const src = ent("Stary", "src/a.ts")!;
      const dst = ent("Repo", "src/a.ts")!;
      const only = ent("Stary", "src/stary.ts")!;
      const concept = repo.db.query("SELECT id, df FROM entities WHERE kind = 'concept' AND key = 'cache'").get() as {
        id: number;
        df: number;
      };
      expect([src.df, dst.df]).toEqual([2, 1]);
      expect(src.last_seen_at).toBeGreaterThan(dst.last_seen_at);
      // powiązanie, które cel już ma (ta sama notatka i rola), nie może zablokować przepięcia
      repo.db.run("INSERT INTO obs_entities (obs_id, entity_id, role) VALUES (?, ?, 'modified')", [ids.r1, src.id]);
      const r = P.mergeProject(repo.db, "Stary", "Repo");
      expect(r.plans[0].counts).toMatchObject({ entities: 1, entitiesMerged: 1, links: 3 });
      expect(repo.db.query("SELECT 1 FROM entities WHERE id = ?").get(src.id)).toBeNull();
      const after = ent("Repo", "src/a.ts")!;
      expect(after).toEqual({ id: dst.id, df: 3, last_seen_at: src.last_seen_at });
      const linked = (eid: number) =>
        (
          repo.db.query("SELECT obs_id FROM obs_entities WHERE entity_id = ? ORDER BY obs_id").all(eid) as { obs_id: number }[]
        ).map((x) => x.obs_id);
      expect(linked(dst.id)).toEqual([ids.r1, ids.a, ids.b].sort((p, q) => p - q));
      expect(linked(src.id)).toEqual([]);
      // encja bez kolizji: ten sam wiersz z nowym projektem; obcy projekt i pojęcie wspólne bez zmian
      expect(ent("Repo", "src/stary.ts")?.id).toBe(only.id);
      expect(ent("Inny", "src/a.ts")?.df).toBe(1);
      expect(repo.db.query("SELECT id, df FROM entities WHERE id = ?").get(concept.id)).toEqual(concept);
    });

    test("kolizja encji, gdy ta sama notatka jest przy obu: df od nowa z powiązań, nie suma (T-26)", () => {
      const repo = freshRepo();
      const ids = seed(repo);
      // notatka celu powiązana też z encją źródła tak jak przy zapisie (linkEntities podbija df)
      repo.linkEntities(ids.r1, "Stary", [{ kind: "file", key: "src/a.ts", role: "read" }], T0 + 4 * DAY);
      const ent = (project: string) =>
        repo.db.query("SELECT id, df FROM entities WHERE kind = 'file' AND project = ? AND key = 'src/a.ts'").get(project) as {
          id: number;
          df: number;
        };
      expect([ent("Stary").df, ent("Repo").df]).toEqual([3, 1]);
      P.mergeProject(repo.db, "Stary", "Repo");
      const after = ent("Repo");
      // r1, a, b: suma dałaby 4
      expect(after.df).toBe(3);
      expect(
        (repo.db.query("SELECT COUNT(DISTINCT obs_id) c FROM obs_entities WHERE entity_id = ?").get(after.id) as { c: number }).c,
      ).toBe(3);
    });

    test("klucze plików źródła względem repo celu: ścieżki absolutne i prefiks worktree łączą się z encją repo (T-27)", () => {
      const repo = freshRepo();
      const root = join(DATA_DIR, `merge-klucze-${++seq}`, "Repo");
      mkdirSync(join(root, ".git"), { recursive: true });
      repo.upsertSession({ id: "s-repo", project: "Repo", cwd: root, started_at: T0 });
      const dst = note(repo, "Repo", { title: "Plik a w repo", files: ["src/a.ts"], session: "s-repo" });
      const abs = normPath(join(root, ".claude", "worktrees", "wt1", "src", "a.ts"));
      const src = note(repo, "Repo/wt1", {
        title: "Plik a z worktree",
        files: [abs, ".claude/worktrees/wt1/src/b.ts"],
        source: "claude-mem",
        hash: "cm-klucze",
      });
      const ro = openDb({ path: repo.db.filename, readonly: true });
      loadVec(ro);
      const dry = P.mergeProject(ro, "Repo/wt1", "Repo", { dryRun: true });
      ro.close();
      const r = P.mergeProject(repo.db, "Repo/wt1", "Repo");
      expect(r.plans[0].counts).toEqual(dry.plans[0].counts);
      // dwie encje z nowym kluczem (src/a.ts łączy się z encją repo, src/b.ts przechodzi) i lista plików jednej notatki
      expect(r.plans[0].counts).toMatchObject({ fileKeys: 3, entities: 1, entitiesMerged: 1 });
      expect(repo.getObservation(src)?.files_modified).toEqual(["src/a.ts", "src/b.ts"]);
      const files = repo.db.query("SELECT key, df FROM entities WHERE kind = 'file' AND project = 'Repo' ORDER BY key").all() as {
        key: string;
        df: number;
      }[];
      expect(files).toEqual([
        { key: "src/a.ts", df: 2 },
        { key: "src/b.ts", df: 1 },
      ]);
      expect(repo.getObservation(dst)?.files_modified).toEqual(["src/a.ts"]);
      expect(P.formatMergeReport(r)).toContain("klucze plików względem repo");
      expect(P.mergeProject(repo.db, "Repo/wt1", "Repo").changes).toBe(0);
    });

    test("wektory przechodzą do partycji celu bez zmiany bitów", () => {
      const repo = freshRepo();
      const ids = seed(repo);
      const vec = (id: number) =>
        repo.db.query("SELECT project, hex(emb) h FROM obs_vec_bits WHERE obs_id = ?").get(id) as {
          project: string;
          h: string;
        } | null;
      const before = vec(ids.a)!;
      expect(before.project).toBe("stary");
      P.mergeProject(repo.db, "Stary", "Repo");
      expect(vec(ids.a)).toEqual({ project: "repo", h: before.h });
      expect(vec(ids.b)?.project).toBe("repo");
      expect(vec(ids.x)?.project).toBe("inny");
      const knn = (project: string) =>
        (
          repo.db
            .query("SELECT obs_id FROM obs_vec_bits WHERE emb MATCH vec_bit(?) AND k = 10 AND project = ?")
            .all(bitsWith(1), project) as { obs_id: number }[]
        ).map((x) => x.obs_id);
      expect(knn("repo").sort((p, q) => p - q)).toEqual([ids.r1, ids.a, ids.b].sort((p, q) => p - q));
      expect(knn("stary")).toEqual([]);
      expect(repo.db.query("SELECT COUNT(*) c FROM obs_vectors").get()).toEqual({ c: 4 });
    });

    test("idempotencja: drugie uruchomienie nic nie zmienia, dziennik tylko z pierwszego", () => {
      const repo = freshRepo();
      seed(repo);
      const logPath = file("merge.jsonl");
      const first = P.mergeProject(repo.db, "Stary", "Repo", { logPath });
      expect(first.logFile).toBe(logPath);
      const snap = snapshot(repo.db);
      const again = P.mergeProject(repo.db, "stary", "Repo", { logPath });
      expect(again.changes).toBe(0);
      expect(again.logFile).toBeNull();
      expect(snapshot(repo.db)).toBe(snap);
      const log = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(log[0]).toMatchObject({ op: "merge", from: "Stary", into: "Repo", sources: ["Stary"] });
      expect(new Set(log.map((e) => e.op))).toEqual(
        new Set(["merge", "move", "entity-rename", "entity-merge", "vectors", "content-hash", "corpus", "meta"]),
      );
      expect(log.filter((e) => e.op === "move").map((e) => e.table)).toEqual([
        "sessions",
        "prompts",
        "observations",
        "summaries",
        "work_state",
        "project_aliases",
      ]);
    });

    test("próba na bazie tylko do odczytu nic nie zmienia i przewiduje zapis", () => {
      const repo = freshRepo();
      seed(repo);
      const before = snapshot(repo.db);
      const ro = openDb({ path: repo.db.filename, readonly: true });
      loadVec(ro);
      // query_only: każda próba zapisu w próbie skończyłaby się błędem
      expect(ro.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
      const dry = P.mergeProject(ro, "Stary", "Repo", { dryRun: true, logPath: file("dry.jsonl") });
      ro.close();
      expect(dry.dryRun).toBe(true);
      expect(dry.logFile).toBeNull();
      expect(snapshot(repo.db)).toBe(before);
      expect(P.formatMergeReport(dry)).toContain("próba: nic nie zapisano");
      const real = P.mergeProject(repo.db, "Stary", "Repo");
      expect(real.plans[0].counts).toEqual(dry.plans[0].counts);
      expect(real.plans[0].merges).toEqual(dry.plans[0].merges);
      expect(real.changes).toBe(dry.changes);
    });

    test("bez sqlite-vec zapis jest przerywany w całości, a próba podaje wektory jako nieznane", () => {
      const repo = freshRepo();
      seed(repo);
      const before = snapshot(repo.db);
      const plain = openDb({ path: repo.db.filename, vectors: false });
      try {
        expect(() => P.mergeProject(plain, "Stary", "Repo")).toThrow("sqlite-vec");
        expect(P.mergeProject(plain, "Stary", "Repo", { dryRun: true }).plans[0].counts.vectors).toBeNull();
      } finally {
        plain.close();
      }
      expect(snapshot(repo.db)).toBe(before);
    });

    test("from bez względu na wielkość liter, cel w istniejącej pisowni, ujednolicenie pisowni", () => {
      const repo = freshRepo();
      note(repo, "Stary", { title: "Pierwsza pisownia", vec: 1 });
      note(repo, "STARY", { title: "Druga pisownia", vec: 2 });
      repo.upsertSession({ id: "s-male", project: "stary", started_at: T0 });
      note(repo, "Repo", { title: "Cel" });
      const r = P.mergeProject(repo.db, "sTaRy", "repo");
      const p = r.plans[0];
      expect(p.into).toBe("Repo");
      expect([...p.sources].sort()).toEqual(["STARY", "Stary", "stary"]);
      expect(p.notes.join(" ")).toContain("„Repo”");
      for (const s of ["Stary", "STARY", "stary"]) {
        expect(count(repo.db, "observations", s)).toBe(0);
        expect(count(repo.db, "sessions", s)).toBe(0);
      }
      expect(count(repo.db, "observations", "Repo")).toBe(3);
      expect(repo.db.query("SELECT DISTINCT project FROM obs_vec_bits").all()).toEqual([{ project: "repo" }]);
      expect(merges(repo.db)).toEqual({ stary: "Repo" });
      // nazwy różne tylko wielkością liter: podana pisownia ujednolica pozostałe, partycja wektorów bez zmian
      note(repo, "ALFA", { title: "Alfa wersalikami", vec: 5 });
      note(repo, "alfa", { title: "Alfa małymi" });
      const c = P.mergeProject(repo.db, "alfa", "Alfa");
      expect([...c.plans[0].sources].sort()).toEqual(["ALFA", "alfa"]);
      expect(c.plans[0].counts.vectors).toBe(0);
      expect(count(repo.db, "observations", "Alfa")).toBe(2);
      expect(merges(repo.db)).toEqual({ alfa: "Alfa", stary: "Repo" });
    });

    test("łańcuch scaleń, cel scalony wcześniej, odwrócenie i błędy", () => {
      const repo = freshRepo();
      for (const k of ["A", "B", "C", "D"]) note(repo, k, { title: `Notatka projektu ${k}` });
      P.mergeProject(repo.db, "A", "B");
      P.mergeProject(repo.db, "B", "C");
      expect(merges(repo.db)).toEqual({ a: "C", b: "C" });
      // cel scalony wcześniej: scalenie do „A” trafia do jego celu
      const d = P.mergeProject(repo.db, "D", "A");
      expect(d.plans[0].into).toBe("C");
      expect(merges(repo.db)).toEqual({ a: "C", b: "C", d: "C" });
      // odwrócenie: „A” był scalony do „C”, teraz „C” do „A”
      const rev = P.mergeProject(repo.db, "C", "A");
      expect(rev.plans[0].into).toBe("A");
      expect(rev.plans[0].notes.join(" ")).toContain("odwrócenie");
      expect(merges(repo.db)).toEqual({ b: "A", c: "A", d: "A" });
      expect(count(repo.db, "observations", "A")).toBe(4);
      // błędy wywołania nic nie zmieniają
      note(repo, "E", { title: "Notatka projektu E" });
      const snap = snapshot(repo.db);
      expect(() => P.mergeProject(repo.db, "Nieznany", "A")).toThrow(P.ProjectError);
      expect(() => P.mergeProject(repo.db, "A", "A")).toThrow(P.ProjectError);
      expect(() => P.mergeProject(repo.db, " ", "A")).toThrow(P.ProjectError);
      expect(() => P.mergeProject(repo.db, "C", "E")).toThrow("już scalony do „A”");
      expect(snapshot(repo.db)).toBe(snap);
    });
  });

  describe("mapowanie przez scalenia", () => {
    test("resolveProject: nowa sesja w katalogu scalonego klucza trafia do klucza docelowego", () => {
      const repo = freshRepo();
      const dir = join(DATA_DIR, `katalogi-${seq}`, "Stary");
      mkdirSync(dir, { recursive: true });
      expect(repo.resolveProject(dir)).toBe("Stary");
      note(repo, "Stary", { title: "Notatka w starym kluczu" });
      note(repo, "Repo", { title: "Notatka klucza docelowego" });
      P.mergeProject(repo.db, "Stary", "Repo");
      const alias = (p: string) =>
        repo.db.query("SELECT project, source FROM project_aliases WHERE cwd = ?").get(normPath(p).toLowerCase());
      // alias reguły przeniesiony razem z pamięcią
      expect(alias(dir)).toEqual({ project: "Repo", source: PROJECT_RULE });
      expect(repo.resolveProject(dir)).toBe("Repo");
      // alias starszej reguły liczony od nowa: reguła daje „Stary”, do tabeli trafia klucz po scaleniach
      const dir2 = join(DATA_DIR, `katalogi-${seq}`, "inne", "Stary");
      mkdirSync(dir2, { recursive: true });
      repo.db.run("INSERT INTO project_aliases (cwd, project, source, seen_at) VALUES (?, 'stary-alias', 'rule', 0)", [
        normPath(dir2).toLowerCase(),
      ]);
      expect(repo.resolveProject(dir2)).toBe("Repo");
      expect(alias(dir2)).toEqual({ project: "Repo", source: PROJECT_RULE });
      // alias z claude-mem ze starym kluczem (np. ponowny import) też prowadzi do celu
      const dir3 = join(DATA_DIR, `katalogi-${seq}`, "z-claude-mem");
      repo.setProjectAlias(dir3, "Stary", "claude-mem");
      expect(repo.resolveProject(dir3)).toBe("Repo");
      expect(repo.resolveProject("")).toBe(UNKNOWN_PROJECT);
      // funkcje dla importu
      expect(P.mergedProject(repo.db, "STARY")).toBe("Repo");
      const map = P.projectMapper(repo.db);
      expect([map("stary"), map("Repo"), map("Inny")]).toEqual(["Repo", "Repo", "Inny"]);
    });

    test("odczyt scaleń jest odporny na zepsuty wpis, nazwy jak w Object.prototype i pętle", () => {
      expect(parseProjectMerges("{zepsuty").size).toBe(0);
      expect(parseProjectMerges('["a"]').size).toBe(0);
      expect(parseProjectMerges('{"a": 1, "b": ""}').size).toBe(0);
      expect(mapMergedProject(new Map(), "constructor")).toBe("constructor");
      expect(mapMergedProject(parseProjectMerges('{"__proto__": "X", "Constructor": "Y"}'), "constructor")).toBe("Y");
      expect(mapMergedProject(parseProjectMerges('{"__proto__": "X"}'), "__proto__")).toBe("X");
      // pętla z ręcznej edycji kończy się po limicie kroków
      expect(["A", "B"]).toContain(mapMergedProject(parseProjectMerges('{"a": "B", "b": "A"}'), "A"));
    });
  });

  /** Transkrypt JSONL z podanymi liniami. */
  const writeJsonl = (path: string, lines: unknown[]) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  };

  describe("--worktrees", () => {
    test("cel z transkryptu, z reguły i klucze pominięte; próba i zapis", () => {
      const repo = freshRepo();
      const base = join(DATA_DIR, `code-${++seq}`);
      // worktree repozytorium „Repo”: plik .git z gitdir w .git/worktrees/wt1 repozytorium głównego
      mkdirSync(join(base, "Repo", ".git", "worktrees", "wt1"), { recursive: true });
      const wt = join(base, "Repo", ".claude", "worktrees", "wt1");
      mkdirSync(join(wt, "src"), { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(base, "Repo", ".git", "worktrees", "wt1")}\n`);
      const sidWt = "aaaaaaaa-1111-2222-3333-444444444444";
      const sidGone = "bbbbbbbb-1111-2222-3333-444444444444";
      const projects = join(claudeDir(), "projects");
      const iso = new Date(T0).toISOString();
      // początek transkryptu bez cwd (metadane harnessu, kolejka), cwd dopiero w linii wiadomości (podkatalog worktree)
      writeJsonl(join(projects, "D--code-Repo--claude-worktrees-wt1", `${sidWt}.jsonl`), [
        { type: "bridge-session", sessionId: sidWt },
        { type: "queue-operation", operation: "enqueue", sessionId: sidWt, timestamp: iso },
        {
          type: "user",
          uuid: "u1",
          sessionId: sidWt,
          cwd: join(wt, "src"),
          timestamp: iso,
          message: { role: "user", content: "x" },
        },
      ]);
      // transkrypt istnieje, ale katalogu worktree już nie ma: cel z reguły („Inne” jest w bazie)
      writeJsonl(join(projects, "D--code-Inne--claude-worktrees-zniknal", `${sidGone}.jsonl`), [
        {
          type: "user",
          uuid: "u1",
          sessionId: sidGone,
          cwd: join(base, "Inne", ".claude", "worktrees", "zniknal"),
          timestamp: iso,
          message: { role: "user", content: "x" },
        },
      ]);
      const cmSession = (id: string, project: string) =>
        repo.upsertSession({ id, project, cwd: null, started_at: T0, source: "claude-mem" });
      cmSession(sidWt, "Repo/wt1");
      const w1 = note(repo, "Repo/wt1", {
        title: "Licencje: klucz publiczny w aplikacji",
        files: ["apps/hub/a.ts"],
        session: sidWt,
        source: "claude-mem",
        hash: "cm-wt-1",
        vec: 1,
      });
      repo.insertPrompt({
        session_id: sidWt,
        project: "Repo/wt1",
        n: 1,
        text: "zbuduj licencje",
        created_at: T0,
        source: "claude-mem",
      });
      cmSession(sidGone, "Inne/zniknal");
      note(repo, "Inne/zniknal", {
        title: "Notatka ze zniknietego worktree",
        session: sidGone,
        source: "claude-mem",
        hash: "cm-2",
      });
      note(repo, "Inne", { title: "Zwykły klucz Inne" });
      note(repo, "Super/sub/mod", { title: "Notatka submodułu", source: "claude-mem", hash: "cm-3" });
      note(repo, "Brak/x", { title: "Repo spoza bazy", source: "claude-mem", hash: "cm-4" });

      const by = Object.fromEntries(P.worktreeTargets(repo.db).map((t) => [t.key, t]));
      expect(Object.keys(by).sort()).toEqual(["Brak/x", "Inne/zniknal", "Repo/wt1", "Super/sub/mod"]);
      expect(by["Repo/wt1"]).toMatchObject({ target: "Repo", source: "transkrypt" });
      expect(by["Repo/wt1"].evidence).toContain(sidWt.slice(0, 8));
      expect(by["Inne/zniknal"]).toMatchObject({ target: "Inne", source: "reguła" });
      expect(by["Super/sub/mod"]).toMatchObject({ target: null, source: null });
      expect(by["Super/sub/mod"].evidence).toContain("więcej niż jeden ukośnik");
      expect(by["Brak/x"]).toMatchObject({ target: null, source: null });
      expect(by["Brak/x"].evidence).toContain("„Brak” nie istnieje");

      const before = snapshot(repo.db);
      const ro = openDb({ path: repo.db.filename, readonly: true });
      loadVec(ro);
      const dry = P.mergeWorktrees(ro, { dryRun: true });
      ro.close();
      expect(snapshot(repo.db)).toBe(before);
      expect(dry.plans.map((p) => [p.from, p.into])).toEqual([
        ["Inne/zniknal", "Inne"],
        ["Repo/wt1", "Repo"],
      ]);
      const text = P.formatMergeReport(dry);
      expect(text).toContain("„Repo/wt1” do „Repo”, źródło celu: transkrypt");
      expect(text).toContain("źródło celu: reguła");
      expect(text).toContain("pominięte: 2");

      const real = P.mergeWorktrees(repo.db, { logPath: file("wt.jsonl") });
      expect(real.plans.map((p) => p.counts)).toEqual(dry.plans.map((p) => p.counts));
      expect(real.plans[1].counts).toMatchObject({
        sessions: 1,
        prompts: 1,
        observations: 1,
        entities: 1,
        vectors: 1,
        hashes: 0,
      });
      expect(repo.getObservation(w1)?.project).toBe("Repo");
      expect(repo.getSession(sidWt)?.project).toBe("Repo");
      expect(repo.getSession(sidGone)?.project).toBe("Inne");
      expect(
        (
          repo.db.query("SELECT DISTINCT project FROM observations WHERE project LIKE '%/%' ORDER BY 1").all() as {
            project: string;
          }[]
        ).map((x) => x.project),
      ).toEqual(["Brak/x", "Super/sub/mod"]);
      expect(merges(repo.db)).toEqual({ "inne/zniknal": "Inne", "repo/wt1": "Repo" });
      // nowa sesja w katalogu worktree: klucz repo, jak przed scaleniem
      expect(repo.resolveProject(wt)).toBe("Repo");
      expect(P.mergedProject(repo.db, "Repo/wt1")).toBe("Repo");

      const again = P.mergeWorktrees(repo.db);
      expect(again.changes).toBe(0);
      expect(again.worktrees?.filter((t) => !t.target).map((t) => t.key)).toEqual(["Brak/x", "Super/sub/mod"]);
    });

    test("bez katalogu: cel z reguły tylko dla ścieżki worktree; submoduł i klucz bez śladu zostają", () => {
      const repo = freshRepo();
      const base = join(DATA_DIR, `code-${++seq}`);
      const sidSub = "cccccccc-1111-2222-3333-444444444444";
      // submoduł: katalog sesji leży w katalogu repo (i już go nie ma)
      writeJsonl(join(claudeDir(), "projects", "D--code-Glowne-sub", `${sidSub}.jsonl`), [
        {
          type: "user",
          uuid: "u1",
          sessionId: sidSub,
          cwd: join(base, "Glowne", "sub"),
          timestamp: new Date(T0).toISOString(),
          message: { role: "user", content: "x" },
        },
      ]);
      repo.upsertSession({ id: sidSub, project: "Glowne/sub", cwd: null, started_at: T0, source: "claude-mem" });
      note(repo, "Glowne/sub", { title: "Notatka submodułu", session: sidSub, source: "claude-mem", hash: "cm-s1" });
      note(repo, "Glowne/bezsladu", { title: "Klucz bez sesji", source: "claude-mem", hash: "cm-s2" });
      note(repo, "Glowne", { title: "Zwykły klucz Glowne" });
      const by = Object.fromEntries(P.worktreeTargets(repo.db).map((t) => [t.key, t]));
      for (const k of ["Glowne/sub", "Glowne/bezsladu"]) {
        expect(by[k]).toMatchObject({ target: null, source: null });
        expect(by[k].evidence).toContain("brak dowodu, że to worktree");
      }
    });
  });

  describe("lista", () => {
    test("pisownie, klucze złożone, same aliasy i klucz scalony, którego wiersze wróciły", () => {
      const repo = freshRepo();
      note(repo, "Stary", { title: "Pierwsza", at: T0 });
      note(repo, "STARY", { title: "Druga", at: T0 + DAY });
      note(repo, "Stary", { title: "Trzecia", at: T0 + 2 * DAY });
      note(repo, "Repo/wt", { title: "Z worktree", at: T0 });
      repo.setProjectAlias(join(DATA_DIR, "tylko-alias"), "TylkoAlias", PROJECT_RULE);
      let list = P.listProjects(repo.db);
      const by = (k: string) => list.find((p) => p.key === k)!;
      expect(by("Stary")).toMatchObject({
        spellings: ["Stary", "STARY"],
        observations: 3,
        active: 3,
        composite: false,
        mergedInto: null,
        lastActivity: T0 + 2 * DAY,
      });
      expect(by("Repo/wt").composite).toBe(true);
      expect(by("TylkoAlias")).toMatchObject({ aliases: 1, observations: 0, lastActivity: null });
      expect(list[0].key).toBe("Stary");
      const text = P.formatProjectList(list);
      expect(text).toContain("pisownie: Stary, STARY");
      expect(text).toContain("złożony");
      expect(text).toContain("tylko aliasy katalogów");
      expect(text).toContain("hipokamp project merge --worktrees --dry-run");
      // cel bez wierszy to zmiana nazwy: tylko z rename (literówka w <into> nie przenosi projektu po cichu)
      expect(() => P.mergeProject(repo.db, "Stary", "Stray")).toThrow("--rename");
      P.mergeProject(repo.db, "Repo/wt", "Repo", { rename: true });
      note(repo, "Repo/wt", { title: "Po ponownym imporcie" });
      list = P.listProjects(repo.db);
      expect(by("Repo/wt").mergedInto).toBe("Repo");
    });

    test("--suspicious: fragmenty słów i katalogi zbiorcze z claude-mem do oceny; repo o krótkiej nazwie nie; nic nie scala (T-25)", () => {
      const repo = freshRepo();
      const base = join(DATA_DIR, `podejrzane-${++seq}`);
      const keys = ["prze", "do", "we", "dod", "stw", "prz", "System32", "code"];
      for (const k of keys) {
        repo.upsertSession({ id: `s-${k}`, project: k, cwd: join(base, k), started_at: T0, source: "claude-mem" });
        note(repo, k, { title: `Notatka klucza ${k}`, session: `s-${k}`, source: "claude-mem", hash: `cm-${k}` });
      }
      note(repo, "prze", { title: "Druga notatka klucza prze", source: "claude-mem", hash: "cm-prze-2", at: T0 + DAY });
      // prawdziwe repo o krótkiej nazwie (katalog sesji to korzeń repo „cli”)
      const cli = join(base, "cli");
      mkdirSync(join(cli, ".git"), { recursive: true });
      repo.upsertSession({ id: "s-cli", project: "cli", cwd: cli, started_at: T0, source: "claude-mem" });
      note(repo, "cli", { title: "Narzędzie cli", session: "s-cli", source: "claude-mem", hash: "cm-cli" });
      note(repo, "Repo", { title: "Zwykły klucz", source: "claude-mem", hash: "cm-repo" });
      // krótki klucz bez danych z claude-mem: to nie błąd importu
      note(repo, "abc", { title: "Własna notatka" });
      const before = snapshot(repo.db);
      const list = P.suspiciousProjects(repo.db);
      expect(list.map((p) => p.key).sort()).toEqual([...keys].sort());
      expect(list[0]).toMatchObject({ key: "prze", observations: 2, claudeMem: 2, sessions: 1 });
      expect(list[0].titles).toEqual(["Druga notatka klucza prze", "Notatka klucza prze"]);
      expect(list.find((p) => p.key === "System32")?.why).toContain("katalog systemowy");
      expect(list.find((p) => p.key === "do")?.why).toContain("krótki fragment");
      const text = P.formatSuspicious(list);
      expect(text).toContain("podejrzane klucze z importu claude-mem: 8");
      expect(text).toContain("hipokamp project merge <klucz> <cel> --dry-run");
      expect(text).toContain(normPath(join(base, "prze")).split("/").at(-1)!);
      expect(snapshot(repo.db)).toBe(before);
      expect(merges(repo.db)).toEqual({});
    });
  });

  describe("serwer MCP", () => {
    test("otwarta sesja widzi nowy klucz po project merge bez restartu (T-25)", async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const home = join(DATA_DIR, `mcp-${++seq}`);
      const dir = join(home, "McpStary");
      mkdirSync(dir, { recursive: true });
      const env = {
        ...(process.env as Record<string, string>),
        HIPOKAMP_HOME: home,
        CLAUDE_PROJECT_DIR: dir,
        HIPOKAMP_NO_WORKER: "1",
      };
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(import.meta.dir, "..", "src", "mcp", "server.ts")],
          env,
          cwd: dir,
        }),
      );
      try {
        const write = async (task: string) => {
          const r = (await client.callTool({
            name: "work_state_write",
            arguments: { list: "zadania", fields: { task, status: "todo" } },
          })) as {
            isError?: boolean;
          };
          expect(r.isError ?? false).toBe(false);
        };
        await write("przed scaleniem");
        const db = openDb({ path: join(home, "hipokamp.db"), vectors: true });
        try {
          const projects = () =>
            (db.query("SELECT project FROM work_state ORDER BY id").all() as { project: string }[]).map((r) => r.project);
          expect(projects()).toEqual(["McpStary"]);
          P.mergeProject(db, "McpStary", "McpCel", { rename: true });
          await write("po scaleniu");
          expect(projects()).toEqual(["McpCel", "McpCel"]);
        } finally {
          db.close();
        }
      } finally {
        await client.close();
      }
    }, 60_000);
  });

  describe("CLI", () => {
    test("próba bez zapisu, zapis z kopią i dziennikiem, drugi raz bez zmian, błędy wywołania", () => {
      const db = getDb();
      expect(db.filename).toBe(paths.db());
      const ids = seed(new Repo(db));
      const out: string[] = [];
      const cli = (...args: string[]) => {
        out.length = 0;
        const code = P.projectCommand(args, (m) => out.push(m));
        return { code, text: out.join("\n") };
      };
      const backups = () => (existsSync(backupDir()) ? readdirSync(backupDir()) : []);
      const logs = () =>
        existsSync(paths.logs()) ? readdirSync(paths.logs()).filter((f) => f.startsWith("project-merge-")) : [];
      try {
        const before = snapshot(db);
        let r = cli("merge", "Stary", "Repo", "--dry-run");
        expect(r.code).toBe(0);
        expect(r.text).toContain("próba: nic nie zapisano");
        expect(r.text).toContain("wektory 2");
        expect(snapshot(db)).toBe(before);
        expect(backups()).toEqual([]);
        expect(logs()).toEqual([]);

        r = cli("list", "--json");
        expect(r.code).toBe(0);
        expect((JSON.parse(r.text) as { key: string }[]).map((p) => p.key)).toEqual(
          expect.arrayContaining(["Stary", "Repo", "Inny"]),
        );
        expect(cli("list").text).toContain("projekty: 3");
        r = cli("list", "--suspicious");
        expect(r.code).toBe(0);
        expect(r.text).toContain("podejrzane klucze z importu claude-mem: 0");
        expect(JSON.parse(cli("list", "--suspicious", "--json").text)).toEqual([]);

        r = cli("merge", "Stary", "Repo");
        expect(r.code).toBe(0);
        expect(r.text).toContain("kopia przed scaleniem");
        expect(backups().filter((f) => f.includes("pre-project-merge")).length).toBe(1);
        expect(logs().length).toBe(1);
        expect(count(db, "observations", "Stary")).toBe(0);
        expect(new Repo(db).getObservation(ids.a)?.project).toBe("Repo");

        r = cli("merge", "Stary", "Repo");
        expect(r.code).toBe(0);
        expect(r.text).toContain("nic do zmiany");
        expect(backups().length).toBe(1);

        const after = snapshot(db);
        for (const args of [
          [],
          ["zrób"],
          ["list", "x"],
          ["list", "--dry-run"],
          ["merge", "Stary"],
          ["merge", "Nieznany", "Repo"],
          ["merge", "Repo", "Repo"],
          ["merge", "Repo", "Inny", "--dryrun"],
          ["merge", "--worktrees", "Repo"],
        ])
          expect(cli(...args).code).toBe(1);
        expect(snapshot(db)).toBe(after);
        expect(cli("help").code).toBe(0);
      } finally {
        closeShared();
      }
    });
  });
}
