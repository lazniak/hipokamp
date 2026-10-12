// Integralność danych: kolizje numerów przy imporcie claude-mem, przestrzeń numerów, sen, kopie, redigest,
// pętla wektorów, `hipokamp repair`, diagnostyka przestojów pętli workera i praca w tle pocięta na kawałki
// (nadrabianie, sen, przebudowa FTS, kopia w wątku). Wszystko w katalogu tymczasowym z „hipokamp-test” w nazwie.
// bun test dzieli moduły między plikami testów: config.ts mógł już zapamiętać prawdziwy HIPOKAMP_HOME
// (np. po unit.test.ts). Dlatego przypadki biegną w osobnym procesie z własnym środowiskiem (ten sam plik).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHILD = "HIPOKAMP_INTEGRITY_CHILD";

if (!process.env[CHILD]) {
  test("integralność danych (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/integrity.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47994",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      // wynik procesu potomnego w wyjściu całego zestawu
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `integrity: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy integralności nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, claudeDir } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test") || !claudeDir().includes("hipokamp-test"))
    throw new Error("integralność: HIPOKAMP_HOME i CLAUDE_CONFIG_DIR muszą wskazywać katalog testowy");
  const { getMeta, openDb, setMeta } = await import("../src/db/db.ts");
  const { MIGRATIONS, NATIVE_ID_BASE } = await import("../src/db/schema.ts");
  const { contentHash, PROMPT_CM_BASE, PROMPT_SUBST_BASE, Repo, substitutePromptN } = await import("../src/db/repo.ts");
  const { fileKey, normPath } = await import("../src/util/paths.ts");
  const { importClaudeMem } = await import("../src/importers/claude-mem.ts");
  const { mergeDuplicates } = await import("../src/consolidate/sleep.ts");
  const { backupDb, restoreDb } = await import("../src/core/backup.ts");
  const { redigest } = await import("../src/capture/redigest.ts");
  const { clean } = await import("../src/capture/redact.ts");
  const { digestTurn } = await import("../src/capture/digest.ts");
  const { groupTurns, readLinesFrom } = await import("../src/capture/transcript.ts");
  const { embedBatch } = await import("../src/worker/embedloop.ts");
  const { repair } = await import("../src/core/repair.ts");
  const { ingestTranscript } = await import("../src/capture/ingest.ts");
  const { getToolUses } = await import("../src/mcp/tooluses.ts");
  const { ftsSearch, ftsSearchPrompts } = await import("../src/index/fts.ts");
  type RepoT = InstanceType<typeof Repo>;

  const DAY = 86_400_000;
  // sztuczny klucz składany w locie (alfabet i cyfry): skaner sekretów nie widzi go w źródle
  const FAKE_TOKEN = `${String.fromCharCode(...Array.from({ length: 26 }, (_, i) => 97 + i))}0123`;
  const FAKE_KEY = `sk-or-v1-${FAKE_TOKEN}`;
  let seq = 0;
  const file = (name: string) => join(DATA_DIR, `${++seq}-${name}`);
  const freshRepo = (vectors = false) => new Repo(openDb({ path: file("h.db"), vectors }));

  /** Minimalna baza claude-mem: tylko tabele i kolumny czytane przez importer. */
  function fakeClaudeMem(path: string): Database {
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT, memory_session_id TEXT,
        project TEXT, user_prompt TEXT, started_at_epoch INTEGER, completed_at_epoch INTEGER, status TEXT,
        prompt_counter INTEGER, custom_title TEXT, observed_model TEXT, cwd TEXT);
      CREATE TABLE user_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT, prompt_number INTEGER,
        prompt_text TEXT, created_at_epoch INTEGER);
      CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, text TEXT,
        type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
        prompt_number INTEGER, discovery_tokens INTEGER, created_at TEXT, created_at_epoch INTEGER, content_hash TEXT,
        generated_by_model TEXT, relevance_count INTEGER, merged_into_project TEXT, agent_type TEXT,
        occurrence_count INTEGER, last_reinforced TEXT);
      CREATE TABLE session_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT,
        request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, files_read TEXT, files_edited TEXT,
        notes TEXT, prompt_number INTEGER, discovery_tokens INTEGER, created_at TEXT, created_at_epoch INTEGER,
        merged_into_project TEXT);
      CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, list_name TEXT, fields TEXT,
        created_at TEXT, created_at_epoch INTEGER);
    `);
    return db;
  }
  const cmSession = (cm: Database, sid: string, at: number, extra: { counter?: number; firstPrompt?: string } = {}) =>
    cm.run(
      "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at_epoch, status, prompt_counter, cwd) VALUES (?, ?, 'demo', ?, ?, 'completed', ?, NULL)",
      [sid, `mem-${sid}`, extra.firstPrompt ?? "start", at, extra.counter ?? 0],
    );
  const cmObs = (
    cm: Database,
    o: { id: number; sid: string; title: string; narrative?: string; prompt: number; at: number },
  ): void => {
    cm.run(
      "INSERT INTO observations (id, memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified, prompt_number, created_at_epoch, content_hash, occurrence_count, relevance_count) VALUES (?, ?, 'demo', 'bugfix', ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?, 1, 0)",
      [o.id, `mem-${o.sid}`, o.title, o.narrative ?? "opis", o.prompt, o.at, `h${o.id}`],
    );
  };
  const cmSummary = (cm: Database, id: number, sid: string, at: number, request: string) =>
    cm.run(
      "INSERT INTO session_summaries (id, memory_session_id, project, request, files_read, files_edited, created_at_epoch) VALUES (?, ?, 'demo', ?, '[]', '[]', ?)",
      [id, `mem-${sid}`, request, at],
    );
  const native = (repo: RepoT, o: { id?: number; title: string; at: number; session?: string | null }) =>
    repo.insertObservation({
      id: o.id,
      session_id: o.session ?? null,
      project: "demo",
      type: "change",
      title: o.title,
      narrative: `${o.title} (opis)`,
      created_at: o.at,
      source: "backfill",
    }).id;
  const seqOf = (repo: RepoT, name: string) =>
    (repo.db.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name) as { seq: number } | null)?.seq ?? 0;

  describe("przestrzeń numerów", () => {
    test("nowa baza: notatki i podsumowania hipokampa od NATIVE_ID_BASE + 1", () => {
      const repo = freshRepo();
      expect(seqOf(repo, "observations")).toBeGreaterThanOrEqual(10_000_000);
      expect(seqOf(repo, "summaries")).toBeGreaterThanOrEqual(10_000_000);
      expect(native(repo, { title: "Pierwsza notatka", at: Date.now() })).toBeGreaterThan(10_000_000);
      const s = repo.insertSummary({
        session_id: null,
        project: "demo",
        request: "r",
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        files_read: [],
        files_edited: [],
        prompt_n: null,
        created_at: Date.now(),
        source: "digest",
      });
      expect(s).toBeGreaterThan(10_000_000);
    });

    test("migracja istniejącej bazy podnosi licznik; jawne numery claude-mem go nie obniżają", () => {
      const path = file("v2.db");
      const raw = new Database(path, { create: true });
      raw.exec(MIGRATIONS[0]);
      raw.exec(MIGRATIONS[1]);
      raw.run("INSERT INTO meta (k, v) VALUES ('schema_version', '2')");
      raw.run(
        "INSERT INTO observations (id, project, type, title, created_at, updated_at, source) VALUES (114866, 'demo', 'change', 'x', 1, 1, 'backfill')",
      );
      raw.close();
      const repo = new Repo(openDb({ path }));
      expect(getMeta(repo.db, "schema_version")).toBe(String(MIGRATIONS.length));
      expect(seqOf(repo, "observations")).toBe(NATIVE_ID_BASE);
      expect(seqOf(repo, "summaries")).toBe(NATIVE_ID_BASE);
      repo.insertObservation({
        id: 114900,
        session_id: null,
        project: "demo",
        type: "change",
        title: "cm",
        created_at: 2,
        source: "claude-mem",
      });
      expect(native(repo, { title: "Nowa po migracji", at: 3 })).toBe(NATIVE_ID_BASE + 1);
    });

    test("numer zastępczy promptu z osobnego zakresu: nie zajmuje numeru późniejszej tury (T-29)", () => {
      const repo = freshRepo();
      const sid = "s-zastepczy";
      repo.upsertSession({ id: sid, project: "demo", started_at: 1 });
      // prompt claude-mem innej tury (pobudka pętli) na numerze 2
      repo.insertPrompt({
        session_id: sid,
        project: "demo",
        n: 2,
        text: "pobudka pętli",
        created_at: 1000,
        source: "claude-mem",
      });
      const add = (n: number, text: string, at: number) =>
        repo.insertTurnPrompt({ session_id: sid, project: "demo", n, text, created_at: at, source: "live" }).n;
      expect(add(1, "pierwsza tura", 500)).toBe(1);
      expect(add(2, "druga tura", 2000)).toBe(PROMPT_SUBST_BASE + 2);
      // dawniej numer zastępczy był pierwszym wolnym za ostatnim (3), więc trzecia tura szła pod 4
      expect(add(3, "trzecia tura", 3000)).toBe(3);
      // ta sama tura przeczytana drugi raz: bez drugiego wiersza
      expect(add(2, "druga tura", 2000)).toBe(PROMPT_SUBST_BASE + 2);
      // numer zastępczy zajęty: pierwszy wolny za ostatnim zastępczym, dalej poniżej PROMPT_CM_BASE
      repo.insertPrompt({ session_id: sid, project: "demo", n: 4, text: "inna", created_at: 1, source: "claude-mem" });
      repo.insertPrompt({ session_id: sid, project: "demo", n: PROMPT_SUBST_BASE + 4, text: "zajęty", created_at: 1 });
      expect(add(4, "czwarta tura", 4000)).toBe(PROMPT_SUBST_BASE + 5);
      expect(substitutePromptN(7, [PROMPT_CM_BASE + 7])).toBe(PROMPT_SUBST_BASE + 7);
      expect(PROMPT_SUBST_BASE + 5).toBeLessThan(PROMPT_CM_BASE);
    });
  });

  describe("import claude-mem", () => {
    test("kolizja numeru: obie notatki zostają, kursor niczego nie pomija, ponowny import nie dubluje", async () => {
      const cmPath = file("cm.db");
      const cm = fakeClaudeMem(cmPath);
      const t0 = Date.now() - 3 * DAY;
      cmSession(cm, "s-imp", t0);
      cmObs(cm, { id: 1, sid: "s-imp", title: "Pierwsza z claude-mem", prompt: 1, at: t0 + 1000 });
      cmObs(cm, { id: 2, sid: "s-imp", title: "Druga z claude-mem", prompt: 1, at: t0 + 2000 });
      cmSummary(cm, 1, "s-imp", t0 + 3000, "Podsumowanie 1");
      const repo = freshRepo();
      await importClaudeMem(repo, { dbPath: cmPath });
      expect(getMeta(repo.db, "cm_last_obs_id")).toBe("2");

      // backfill (sprzed migracji numerów) zajął kolejne numery; claude-mem nadaje te same swoim nowym notatkom
      const bf = native(repo, { id: 3, title: "Notatka z backfillu", at: t0 + 4000 });
      repo.db.run(
        "INSERT INTO summaries (id, project, created_at, source, files_read, files_edited) VALUES (2, 'demo', ?, 'digest', '[]', '[]')",
        [t0 + 4000],
      );
      cmObs(cm, {
        id: 3,
        sid: "s-imp",
        title: "Trzecia z claude-mem",
        narrative: `klucz ${FAKE_KEY} w opisie`,
        prompt: 2,
        at: t0 + 5000,
      });
      cmObs(cm, { id: 4, sid: "s-imp", title: "Czwarta z claude-mem", prompt: 2, at: t0 + 6000 });
      cmSummary(cm, 2, "s-imp", t0 + 7000, "Podsumowanie 2");

      const dry = await importClaudeMem(repo, { dbPath: cmPath, dryRun: true });
      expect(dry.observationsRekeyed).toBe(1);
      expect(dry.observations).toBe(1);
      expect(repo.db.query("SELECT COUNT(*) c FROM observations").get()).toEqual({ c: 3 });

      const st = await importClaudeMem(repo, { dbPath: cmPath });
      expect(st.observationsRekeyed).toBe(1);
      expect(st.observations).toBe(1);
      expect(st.summariesRekeyed).toBe(1);
      expect(getMeta(repo.db, "cm_last_obs_id")).toBe("4");
      const kept = repo.getObservation(bf)!;
      expect(kept.source).toBe("backfill");
      expect(kept.title).toBe("Notatka z backfillu");
      const moved = repo.db.query("SELECT id FROM observations WHERE json_extract(meta, '$.cm_id') = 3").get() as { id: number };
      expect(moved.id).toBeGreaterThan(NATIVE_ID_BASE);
      const o = repo.getObservation(moved.id)!;
      expect(o.source).toBe("claude-mem");
      expect(o.title).toBe("Trzecia z claude-mem");
      // tekst z claude-mem przechodzi przez clean()
      expect(o.narrative).not.toContain(FAKE_TOKEN);
      expect(o.narrative).toContain("[REDACTED");
      expect(repo.getObservation(4)?.title).toBe("Czwarta z claude-mem");
      const sum = repo.db.query("SELECT id, request FROM summaries WHERE json_extract(meta, '$.cm_id') = 2").get() as any;
      expect(sum.id).toBeGreaterThan(NATIVE_ID_BASE);
      expect(sum.request).toBe("Podsumowanie 2");

      // pełny import od zera: wszystko rozpoznane jako już zaimportowane (także notatka pod nowym numerem)
      setMeta(repo.db, "cm_last_obs_id", "0");
      setMeta(repo.db, "cm_last_summary_id", "0");
      const again = await importClaudeMem(repo, { dbPath: cmPath });
      expect(again.observations + again.observationsRekeyed).toBe(0);
      expect(again.observationsKnown).toBe(4);
      expect(again.summaries + again.summariesRekeyed).toBe(0);
      expect(repo.db.query("SELECT COUNT(*) c FROM observations").get()).toEqual({ c: 5 });

      // get_tool_uses dla notatki pod nowym numerem czyta wywołania jej numeru w claude-mem (meta.cm_id)
      cm.exec(`CREATE TABLE tool_uses (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER, tool_use_id TEXT,
        tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER, content_session_id TEXT,
        prompt_number INTEGER)`);
      cm.run(
        "INSERT INTO tool_uses (observation_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch) VALUES (3, 'toolu_cm3', 'Grep', '{}', 'wynik trzeciej', ?)",
        [t0 + 5000],
      );
      cm.run(
        "INSERT INTO tool_uses (observation_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch) VALUES (4, 'toolu_cm4', 'Read', '{}', 'wynik czwartej', ?)",
        [t0 + 6000],
      );
      const prevCm = process.env.CLAUDE_MEM_DB;
      process.env.CLAUDE_MEM_DB = cmPath;
      try {
        const out = getToolUses(repo, [moved.id]);
        expect(out).toContain("wynik trzeciej");
        expect(out).not.toContain("wynik czwartej");
      } finally {
        process.env.CLAUDE_MEM_DB = prevCm;
      }
      cm.close();
    });

    test("scalony klucz: import zapisuje sesje, prompty, notatki, podsumowania, listy i aliasy pod kluczem celu", async () => {
      const cmPath = file("cm-scalony.db");
      const cm = fakeClaudeMem(cmPath);
      const t0 = Date.now() - 2 * DAY;
      cmSession(cm, "s-sc", t0);
      cm.run("UPDATE sdk_sessions SET cwd = ? WHERE content_session_id = 's-sc'", [join(DATA_DIR, "demo-wt")]);
      cm.run(
        "INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES ('s-sc', 1, 'start', ?)",
        [t0 + 500],
      );
      cmObs(cm, { id: 7, sid: "s-sc", title: "Notatka scalonego klucza", prompt: 1, at: t0 + 1000 });
      cmSummary(cm, 8, "s-sc", t0 + 2000, "podsumowanie scalonego klucza");
      cm.run(
        "INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (1, 'DEMO', 'zadania', '{\"task\":\"x\"}', ?)",
        [t0 + 3000],
      );
      cm.close();
      const repo = freshRepo();
      setMeta(repo.db, "project_merges", JSON.stringify({ demo: "Cel" }));
      await importClaudeMem(repo, { dbPath: cmPath });
      const keys = (table: string) =>
        (repo.db.query(`SELECT DISTINCT project FROM ${table}`).all() as { project: string }[]).map((r) => r.project);
      for (const table of ["sessions", "prompts", "observations", "summaries", "work_state", "project_aliases"])
        expect([table, keys(table)]).toEqual([table, ["Cel"]]);
      expect(repo.resolveProject(join(DATA_DIR, "demo-wt"))).toBe("Cel");
    });
  });

  // wektory do testów snu: q8 i bity ustawiane osobno (bity sterują sąsiadami, q8 cosinusem)
  const DIMS = 1024;
  const q8Fill = (v: number) => new Int8Array(DIMS).fill(v);
  const q8One = (i: number) => {
    const q = new Int8Array(DIMS);
    q[i] = 127;
    return q;
  };
  const bitsWith = (...on: number[]) => {
    const b = new Uint8Array(DIMS / 8);
    for (const i of on) b[i >> 3] |= 1 << (i & 7);
    return b;
  };
  const vecNote = (repo: RepoT, o: { title: string; type: string; at: number; q8: Int8Array; bits: Uint8Array }) => {
    const { id } = repo.insertObservation({
      session_id: null,
      project: "demo",
      type: o.type,
      title: o.title,
      narrative: `${o.title}: ${o.at}`,
      created_at: o.at,
      source: "digest",
    });
    repo.putVector(id, "demo", "test", o.q8, o.bits, true);
    return id;
  };

  describe("sen", () => {
    test("scala dwie identyczne notatki (sąsiedzi przez vec_bit)", async () => {
      const repo = freshRepo(true);
      const now = Date.now();
      const title = "Naprawiono zakleszczenie portu workera";
      const x = vecNote(repo, { title, type: "bugfix", at: now - 2 * DAY, q8: q8Fill(4), bits: bitsWith(1, 2, 3) });
      const y = vecNote(repo, { title, type: "bugfix", at: now - DAY, q8: q8Fill(4), bits: bitsWith(1, 2, 3) });
      expect(await mergeDuplicates(repo, now - 10 * DAY)).toBe(1);
      expect(repo.getObservation(x)?.status).toBe("merged");
      expect(repo.getObservation(x)?.merged_into).toBe(y);
      expect(repo.getObservation(y)?.status).toBe("active");
      expect(repo.getObservation(y)?.occurrence_count).toBe(2);
    });

    test("nie scala do notatki już scalonej (łańcuch A → B → C)", async () => {
      const repo = freshRepo(true);
      const now = Date.now();
      const title = "Poprawiono wyciek pamięci w kolejce zadań";
      // C = zera; B = C + 3 bity; A = B + 4 bity; wypełniacze o 2 bity od C (inny typ): C nie widzi B ani A,
      // B widzi C (bliżej) i A
      const c = vecNote(repo, { title, type: "bugfix", at: now - DAY, q8: q8Fill(4), bits: bitsWith() });
      const b = vecNote(repo, { title, type: "bugfix", at: now - 2 * DAY, q8: q8Fill(4), bits: bitsWith(0, 1, 2) });
      const a = vecNote(repo, { title, type: "bugfix", at: now - 3 * DAY, q8: q8Fill(4), bits: bitsWith(0, 1, 2, 3, 4, 5, 6) });
      for (let i = 0; i < 12; i++)
        vecNote(repo, {
          title: `Wypełniacz ${i} bez związku`,
          type: "discovery",
          at: now - 5 * DAY,
          q8: q8One(10 + i),
          bits: bitsWith(100 + 2 * i, 101 + 2 * i),
        });
      repo.logAccess([a], "fetched", null, now - 3 * DAY);
      expect(await mergeDuplicates(repo, now - 10 * DAY)).toBe(2);
      expect(repo.getObservation(b)?.merged_into).toBe(c);
      expect(repo.getObservation(a)?.merged_into).toBe(c);
      expect(repo.getObservation(c)?.status).toBe("active");
      expect(repo.getObservation(c)?.occurrence_count).toBe(3);
      // ślady dostępu A trafiają do aktywnej notatki, nie do scalonej B
      expect(repo.db.query("SELECT obs_id FROM access_log").all()).toEqual([{ obs_id: c }]);
    });
  });

  describe("kopie", () => {
    test("dwa przywrócenia w tej samej minucie zachowują obie kopie pre-restore", () => {
      const dir = file("restore");
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, "live.db");
      const backups = join(dir, "kopie");
      writeFileSync(dbPath, "v0");
      writeFileSync(`${dbPath}-wal`, "wal0");
      writeFileSync(join(dir, "src1.db"), "v1");
      writeFileSync(join(dir, "src2.db"), "v2");
      const r1 = restoreDb(join(dir, "src1.db"), { dbPath, dir: backups });
      const r2 = restoreDb(join(dir, "src2.db"), { dbPath, dir: backups });
      expect(r1.previous).not.toBe(r2.previous);
      expect(readFileSync(r1.previous!, "utf8")).toBe("v0");
      expect(readFileSync(`${r1.previous}-wal`, "utf8")).toBe("wal0");
      expect(readFileSync(r2.previous!, "utf8")).toBe("v1");
      expect(readFileSync(dbPath, "utf8")).toBe("v2");
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
    });

    test("dwie kopie w tej samej sekundzie nie kolidują", () => {
      const repo = freshRepo();
      const dir = file("kopie");
      const a = backupDb(repo.db, { dir, keep: 5 });
      const b = backupDb(repo.db, { dir, keep: 5 });
      expect(a.file).not.toBe(b.file);
      expect(statSync(a.file).size).toBeGreaterThan(0);
      expect(statSync(b.file).size).toBeGreaterThan(0);
    });
  });

  /** Transkrypt JSONL z turami: prompt, opcjonalnie narzędzie, odpowiedź. Komenda lokalna (/model): bez odpowiedzi modelu. */
  type T = { uuid: string; prompt: string; at: number; answer: string; task?: boolean; tool?: string; local?: boolean };
  function writeTranscript(path: string, sid: string, turns: T[], append = false): void {
    const ts = (t: number) => new Date(t).toISOString();
    const lines: any[] = [];
    for (const t of turns) {
      if (t.local) {
        const [name, ...args] = t.prompt.split(" ");
        lines.push({
          type: "user",
          uuid: t.uuid,
          sessionId: sid,
          cwd: DATA_DIR,
          timestamp: ts(t.at),
          message: {
            role: "user",
            content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args.join(" ")}</command-args>`,
          },
        });
        lines.push({
          type: "user",
          uuid: `${t.uuid}-o`,
          sessionId: sid,
          timestamp: ts(t.at + 500),
          message: { role: "user", content: `<local-command-stdout>${t.answer}</local-command-stdout>` },
        });
        continue;
      }
      lines.push({
        type: "user",
        uuid: t.uuid,
        sessionId: sid,
        cwd: DATA_DIR,
        timestamp: ts(t.at),
        ...(t.task ? { origin: { kind: "task-notification" } } : {}),
        message: {
          role: "user",
          content: t.task ? `<task-notification><summary>${t.prompt}</summary></task-notification>` : t.prompt,
        },
      });
      if (t.tool) {
        lines.push({
          type: "assistant",
          uuid: `${t.uuid}-a`,
          sessionId: sid,
          timestamp: ts(t.at + 1000),
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `tool-${t.uuid}`, name: "Bash", input: { command: t.tool } }],
          },
        });
        lines.push({
          type: "user",
          uuid: `${t.uuid}-r`,
          sessionId: sid,
          timestamp: ts(t.at + 2000),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${t.uuid}`, content: "ok" }] },
        });
      }
      lines.push({
        type: "assistant",
        uuid: `${t.uuid}-z`,
        sessionId: sid,
        timestamp: ts(t.at + 3000),
        message: { role: "assistant", content: [{ type: "text", text: t.answer }] },
      });
    }
    (append ? appendFileSync : writeFileSync)(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }
  const turnsOf = (path: string, sid: string) => groupTurns(readLinesFrom(path, 0).lines, sid, { final: true }).turns;

  describe("redigest", () => {
    test("zachowuje podbitą ważność i przelicza hash treści", () => {
      const repo = freshRepo();
      const sid = "s-redigest";
      const path = file(`${sid}.jsonl`);
      writeTranscript(path, sid, [
        {
          uuid: "r1",
          prompt: "napraw zakleszczenie portu 47777 w workerze",
          at: Date.now() - DAY,
          tool: "netstat -ano",
          answer: "Port trzymał osierocony proces potomny; worker nie ma już dzieci.",
        },
      ]);
      const [turn] = turnsOf(path, sid);
      const d = digestTurn(turn, { project: "demo", n: 1, privateTools: [], maxNarrativeChars: 1400 });
      const stale = {
        ...d.obs,
        title: "<task-notification> stary tytuł",
        transcript_ref: { path, from: turn.from, to: turn.to },
      };
      const id = repo.insertObservation(stale).id;
      // dwa powtórzenia tej samej treści: +0,05 każde
      for (const k of ["p1", "p2"]) repo.insertObservation({ ...stale, turn_key: k });
      const boosted = repo.getObservation(id)!.importance;
      expect(boosted).toBeCloseTo(Math.min(1, d.obs.importance! + 0.1), 5);
      const r = redigest(repo, { ids: [id] });
      expect(r.updated).toBe(1);
      const o = repo.getObservation(id)!;
      expect(o.title).not.toContain("<task-notification>");
      expect(o.importance).toBeCloseTo(boosted, 5);
      expect(o.content_hash).toBe(contentHash({ project: o.project, title: o.title, narrative: o.narrative, facts: o.facts }));
      // nowa identyczna tura trafia w deduplikację zamiast tworzyć nową notatkę
      const again = repo.insertObservation({ ...d.obs, turn_key: "nowa-tura" });
      expect(again.duplicateOf).toBe(id);
    });
  });

  describe("pętla wektorów", () => {
    test("nie zapisuje wektora notatki zmienionej albo usuniętej w trakcie liczenia", async () => {
      const repo = freshRepo(true);
      const now = Date.now();
      const changed = native(repo, { title: "Notatka zmieniana w trakcie", at: now });
      const purged = native(repo, { title: "Notatka sesji usuwanej w trakcie", at: now, session: "s-purge" });
      const steady = native(repo, { title: "Notatka bez zmian", at: now });
      const seen: string[][] = [];
      let first = true;
      const fake = {
        modelId: "fake",
        embed: async (texts: string[]) => {
          seen.push(texts);
          if (first) {
            first = false;
            repo.updateObservationContent(changed, { title: "Nowy tytuł po redigest" });
            repo.purgeSessions(["s-purge"]);
          }
          return texts.map(() => new Float32Array(DIMS).fill(1 / 32));
        },
      };
      expect(await embedBatch(repo, fake, 16)).toBe(3);
      const has = (id: number) => !!repo.db.query("SELECT 1 FROM obs_vectors WHERE obs_id = ?").get(id);
      const hasBits = (id: number) => !!repo.db.query("SELECT 1 FROM obs_vec_bits WHERE obs_id = ?").get(id);
      expect(has(steady) && hasBits(steady)).toBe(true);
      expect(has(changed) || hasBits(changed)).toBe(false);
      expect(has(purged) || hasBits(purged)).toBe(false);
      // następna partia liczy już z nowej treści
      expect(await embedBatch(repo, fake, 16)).toBe(1);
      expect(seen[1].join("\n")).toContain("Nowy tytuł po redigest");
      expect(has(changed)).toBe(true);
    });
  });

  describe("repair", () => {
    test("kolizje, duplikaty tur claude-mem, numeracja, redakcja; próba nic nie zmienia; drugi przebieg nic nie robi", async () => {
      const S = "11111111-2222-3333-4444-555555555555";
      const t0 = Date.now() - 2 * DAY;
      const projects = join(claudeDir(), "projects", "D--demo");
      mkdirSync(projects, { recursive: true });
      const tpath = join(projects, `${S}.jsonl`);
      // prompt u2 z kluczem: claude-mem trzymał go surowo (redakcja w c), backfill zapisał po clean()
      const p2raw = `dodaj test dla modułu sesji ${FAKE_KEY}`;
      writeTranscript(tpath, S, [
        {
          uuid: "u1",
          prompt: "napraw zakleszczenie portu 47777",
          at: t0,
          tool: "netstat -ano",
          answer: "Port trzymał osierocony proces.",
        },
        { uuid: "u2", prompt: p2raw, at: t0 + 60_000, answer: "Dodałem test sesji w pliku sesja.test.ts." },
        {
          uuid: "n1",
          prompt: "Zadanie w tle zakończone",
          at: t0 + 120_000,
          task: true,
          tool: "git log -1",
          answer: "Commit jest na main.",
        },
        { uuid: "u3", prompt: "zrób refaktor modułu pamięci", at: t0 + 180_000, answer: "Refaktor modułu pamięci gotowy." },
        {
          uuid: "u4",
          prompt: "uruchom testy jednostkowe",
          at: t0 + 240_000,
          tool: "bun test",
          answer: "Wszystkie testy przeszły.",
        },
      ]);
      const turns = new Map(turnsOf(tpath, S).map((t) => [t.key, t]));

      // claude-mem: dwa prompty, notatka dla promptu 1; jego #2 powstał po imporcie, gdy numer zajął backfill
      const cmPath = file("cm-repair.db");
      const cm = fakeClaudeMem(cmPath);
      cmSession(cm, S, t0, { counter: 2, firstPrompt: `zacznij, klucz ${FAKE_KEY}` });
      cm.run("INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, 1, ?, ?)", [
        S,
        "napraw zakleszczenie portu 47777",
        t0 + 2000,
      ]);
      cm.run("INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, 2, ?, ?)", [
        S,
        p2raw,
        t0 + 63_000,
      ]);
      cmObs(cm, { id: 1, sid: S, title: "Port 47777 trzymał osierocony proces", prompt: 1, at: t0 + 30_000 });
      cmSummary(cm, 1, S, t0 + 300_000, "Naprawa portu");
      const repo = freshRepo(true);
      await importClaudeMem(repo, { dbPath: cmPath });

      // stan po błędach v0.1: backfill numerował tury od prompt_count z claude-mem (2), zajął #2,
      // a stary importer pominął notatkę claude-mem #2 i przesunął kursor
      const ref = (k: string) => ({ path: tpath, from: turns.get(k)!.from, to: turns.get(k)!.to });
      const own = (k: string, n: number, title: string, id?: number) =>
        repo.insertObservation({
          id,
          session_id: S,
          project: "demo",
          prompt_n: n,
          type: "change",
          title,
          narrative: `${title}.`,
          created_at: turns.get(k)!.endedAt,
          source: "backfill",
          turn_key: k,
          transcript_ref: ref(k),
        }).id;
      const dup = own("u1", 3, "Port trzymał osierocony proces", 2);
      const n2 = own("u2", 4, "Dodałem test sesji");
      const nt = own("n1", 4, "Commit jest na main");
      const n3 = own("u3", 5, "Refaktor modułu pamięci gotowy");
      const n4 = own("u4", 6, "Wszystkie testy przeszły");
      const ownPrompt = (n: number, text: string, k: string) =>
        repo.insertPrompt({ session_id: S, project: "demo", n, text, created_at: turns.get(k)!.startedAt, source: "backfill" })!;
      const p3 = ownPrompt(3, "napraw zakleszczenie portu 47777", "u1");
      const p4 = ownPrompt(4, clean(p2raw), "u2");
      const p5 = ownPrompt(5, "zrób refaktor modułu pamięci", "u3");
      const p6 = ownPrompt(6, "uruchom testy jednostkowe", "u4");
      repo.setTranscriptProgress(S, statSync(tpath).size, 6, t0 + 250_000);
      cmObs(cm, { id: 2, sid: S, title: "Worker bez procesów potomnych", prompt: 1, at: t0 + 40_000 });
      setMeta(repo.db, "cm_last_obs_id", "2");
      // stary importer kopiował teksty bez clean(): sekret w prompcie, notatce, podsumowaniu i sesji
      const cmPrompt2 = (repo.db.query("SELECT id FROM prompts WHERE session_id = ? AND n = 2").get(S) as { id: number }).id;
      repo.updatePromptText(cmPrompt2, p2raw);
      expect(ftsSearchPrompts(repo.db, FAKE_TOKEN).map((h) => h.id)).toEqual([cmPrompt2]);
      repo.updateObservationContent(1, { narrative: `Opis z kluczem ${FAKE_KEY}` });
      repo.putVector(1, "demo", "test", q8Fill(4), bitsWith(1), true);
      repo.updateSummaryText(1, { learned: `token=${FAKE_KEY}` });
      repo.db.run("UPDATE sessions SET first_prompt = ? WHERE id = ?", [`zacznij, klucz ${FAKE_KEY}`, S]);
      expect(ftsSearch(repo.db, FAKE_TOKEN).map((h) => h.id)).toContain(1);

      const snapshot = () =>
        JSON.stringify([
          repo.db.query("SELECT id, status, prompt_n, merged_into, meta, narrative FROM observations ORDER BY id").all(),
          repo.db.query("SELECT id, n, text FROM prompts ORDER BY id").all(),
          repo.db.query("SELECT id, prompt_count, first_prompt FROM sessions ORDER BY id").all(),
          repo.db.query("SELECT id, learned FROM summaries ORDER BY id").all(),
        ]);
      const before = snapshot();

      // próba na połączeniu tylko do odczytu
      const ro = openDb({ path: repo.db.filename, readonly: true });
      const dry = repair(new Repo(ro), { dryRun: true, cmDbPath: cmPath, logPath: file("dry.jsonl") });
      ro.close();
      expect(dry.reimport.observations).toBe(1);
      expect(dry.dups.merged).toBe(1);
      // 5 notatek z numeracją przesuniętą o 2 (licznik claude-mem), także ta scalona
      expect(dry.dups.promptN).toBe(5);
      expect(dry.dups.deletedPrompts).toBe(2);
      expect(dry.dups.renumberedPrompts).toBe(2);
      expect(dry.dups.promptCount).toBe(1);
      expect(dry.clean.prompts).toBe(1);
      expect(dry.logFile).toBeNull();
      expect(snapshot()).toBe(before);

      const logPath = join(DATA_DIR, "logs", "repair-test.jsonl");
      const r = repair(repo, { cmDbPath: cmPath, logPath });
      // próba przewidziała dokładnie to, co zrobił przebieg właściwy
      expect(r.dups).toEqual(dry.dups);
      expect(r.clean).toEqual(dry.clean);
      expect(r.changes).toBe(dry.changes);
      // a) notatka claude-mem #2 wraca pod nowym numerem
      expect(r.reimport.observations).toBe(1);
      const back = repo.db.query("SELECT id, title FROM observations WHERE json_extract(meta, '$.cm_id') = 2").get() as any;
      expect(back.id).toBeGreaterThan(NATIVE_ID_BASE);
      expect(back.title).toBe("Worker bez procesów potomnych");
      // b) tura u1 była już opisana przez claude-mem: merged z odsyłaczem do notatki claude-mem promptu 1
      const d = repo.getObservation(dup)!;
      expect(d.status).toBe("merged");
      expect(repo.getObservation(d.merged_into!)?.source).toBe("claude-mem");
      expect(repo.getObservation(d.merged_into!)?.prompt_n).toBe(1);
      expect(d.meta).toMatchObject({ repair: "cm-dup", true_n: 1 });
      expect(d.prompt_n).toBe(1);
      // tura u2: claude-mem ma prompt, ale nie ma notatki, więc notatka zostaje (z prawdziwym numerem)
      expect(repo.getObservation(n2)).toMatchObject({ status: "active", prompt_n: 2 });
      expect(repo.getObservation(nt)).toMatchObject({ status: "active", prompt_n: 2 });
      expect(repo.getObservation(n3)?.prompt_n).toBe(3);
      expect(repo.getObservation(n4)?.prompt_n).toBe(4);
      // prompty: duplikaty promptów claude-mem usunięte, reszta z prawdziwym numerem, licznik sesji zgodny
      const prompts = repo.db.query("SELECT id, n, source FROM prompts WHERE session_id = ? ORDER BY n").all(S) as any[];
      expect(prompts.map((p) => [p.n, p.source])).toEqual([
        [1, "claude-mem"],
        [2, "claude-mem"],
        [3, "backfill"],
        [4, "backfill"],
      ]);
      expect(prompts.map((p) => p.id).slice(2)).toEqual([p5, p6]);
      expect(prompts.map((p) => p.id)).not.toContain(p3);
      expect(prompts.map((p) => p.id)).not.toContain(p4);
      expect(repo.getSession(S)?.prompt_count).toBe(4);
      // c) redakcja z FTS zsynchronizowanym, stary wektor skasowany (worker przeliczy)
      expect(repo.getObservation(1)?.narrative).not.toContain(FAKE_TOKEN);
      expect(ftsSearch(repo.db, FAKE_TOKEN).map((h) => h.id)).not.toContain(1);
      expect(repo.db.query("SELECT 1 FROM obs_vectors WHERE obs_id = 1").get()).toBeNull();
      expect(ftsSearchPrompts(repo.db, FAKE_TOKEN)).toEqual([]);
      expect(repo.getSession(S)?.first_prompt).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(repo.db.query("SELECT learned FROM summaries WHERE id = 1").get())).not.toContain(FAKE_TOKEN);
      // d) dziennik: każda zmiana jako linia JSON, bez treści
      const log = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(log.length).toBe(r.changes);
      expect(new Set(log.map((e) => e.op))).toEqual(
        new Set(["reimport", "cm-dup", "prompt-n", "delete-prompt", "renumber-prompt", "prompt-count", "clean"]),
      );
      expect(readFileSync(logPath, "utf8")).not.toContain(FAKE_TOKEN);

      // drugi przebieg: nic do zrobienia
      const again = repair(repo, { cmDbPath: cmPath, logPath });
      expect(again.changes).toBe(0);
      expect(again.reimport.observations + again.dups.merged + again.dups.promptN + again.dups.deletedPrompts).toBe(0);
      cm.close();
    });
  });

  /**
   * Sesja po błędach v0.1 w świeżej bazie: transkrypt w projects/<dir>, import claude-mem (sesja, prompty, notatki),
   * notatki i prompty backfillu z podanymi numerami, offset na końcu transkryptu.
   */
  async function brokenSession(o: {
    sid: string;
    dir: string;
    turns: T[];
    /** prompty claude-mem: [tura, numer w claude-mem] */
    cmPrompts: [string, number][];
    /** notatki claude-mem z numerem promptu, który claude-mem dał turze */
    cmNotes?: { id: number; turn: string; title: string; after?: number }[];
    /** notatki backfillu: [tura, prompt_n, tytuł, inna kopia transkryptu, z której ją opisano] */
    ownNotes?: [string, number, string, string?][];
    /** prompty backfillu: [tura, n] */
    ownPrompts?: [string, number][];
    promptCount: number;
    vectors?: boolean;
    /** dodatkowe wiersze w bazie claude-mem przed importem */
    cmExtra?: (cm: Database, turns: Map<string, ReturnType<typeof turnsOf>[number]>) => void;
  }) {
    const tpath = join(claudeDir(), "projects", o.dir, `${o.sid}.jsonl`);
    mkdirSync(dirname(tpath), { recursive: true });
    writeTranscript(tpath, o.sid, o.turns);
    const turnsIn = (p: string) => new Map(turnsOf(p, o.sid).map((t) => [t.key, t]));
    const turns = turnsIn(tpath);
    const cmPath = file("cm.db");
    const cm = fakeClaudeMem(cmPath);
    cmSession(cm, o.sid, turns.get(o.turns[0].uuid)!.startedAt, { counter: Math.max(0, ...o.cmPrompts.map(([, n]) => n)) });
    const cmN = new Map(o.cmPrompts);
    for (const [u, n] of o.cmPrompts)
      cm.run("INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)", [
        o.sid,
        n,
        turns.get(u)!.prompt,
        turns.get(u)!.startedAt + 2000,
      ]);
    for (const c of o.cmNotes ?? [])
      cmObs(cm, {
        id: c.id,
        sid: o.sid,
        title: c.title,
        prompt: cmN.get(c.turn)!,
        at: turns.get(c.turn)!.startedAt + (c.after ?? 20_000),
      });
    o.cmExtra?.(cm, turns);
    cm.close();
    const repo = freshRepo(o.vectors);
    await importClaudeMem(repo, { dbPath: cmPath });
    const notes = new Map<string, number>();
    for (const [u, n, title, other] of o.ownNotes ?? []) {
      const t = (other ? turnsIn(other) : turns).get(u)!;
      const { id } = repo.insertObservation({
        session_id: o.sid,
        project: "demo",
        prompt_n: n,
        type: "change",
        title,
        narrative: `${title}.`,
        created_at: t.endedAt,
        source: "backfill",
        turn_key: u,
        transcript_ref: { path: other ?? tpath, from: t.from, to: t.to },
      });
      notes.set(u, id);
    }
    const prompts = new Map<string, number>();
    for (const [u, n] of o.ownPrompts ?? []) {
      const t = turns.get(u)!;
      prompts.set(
        u,
        repo.insertPrompt({
          session_id: o.sid,
          project: "demo",
          n,
          text: t.prompt,
          created_at: t.startedAt,
          source: "backfill",
        })!,
      );
    }
    repo.setTranscriptProgress(o.sid, statSync(tpath).size, o.promptCount, turns.get(o.turns.at(-1)!.uuid)!.endedAt);
    return { repo, cmPath, tpath, sid: o.sid, note: (u: string) => notes.get(u)!, prompt: (u: string) => prompts.get(u)! };
  }
  const sessionPrompts = (repo: RepoT, sid: string) =>
    repo.db.query("SELECT id, n, source FROM prompts WHERE session_id = ? ORDER BY n").all(sid) as {
      id: number;
      n: number;
      source: string;
    }[];
  const counter = (repo: RepoT, sid: string) =>
    repo.db.query("SELECT prompt_count, json_extract(meta, '$.n') n FROM sessions WHERE id = ?").get(sid);
  const T0 = Date.now() - 2 * DAY;
  const work: T[] = [
    { uuid: "u1", prompt: "napraw port workera", at: T0, answer: "Port trzymał osierocony proces." },
    { uuid: "u2", prompt: "dodaj test sesji", at: T0 + 60_000, answer: "Test sesji dodany." },
    { uuid: "u3", prompt: "zrób refaktor modułu pamięci", at: T0 + 120_000, answer: "Refaktor gotowy." },
    { uuid: "u4", prompt: "uruchom testy jednostkowe", at: T0 + 180_000, answer: "Testy przeszły." },
  ];

  describe("repair b): podobieństwo, licznik, kopie transkryptu, numeracja", () => {
    test("scala tylko z podobną notatką claude-mem tej tury (wektory albo słowa); niepodobna zostaje aktywna", async () => {
      const s = await brokenSession({
        sid: "aaaaaaaa-1111-4111-8111-000000000001",
        dir: "D--podobne",
        vectors: true,
        turns: work.slice(0, 3),
        cmPrompts: [
          ["u1", 1],
          ["u2", 2],
          ["u3", 3],
        ],
        cmNotes: [
          { id: 1, turn: "u1", title: "Worker trzymał port 47777 przez osierocony proces potomny", after: 20_000 },
          // najnowsza notatka tury mówi o czym innym: dawniej cel scalenia
          { id: 2, turn: "u1", title: "Zmieniono kolor przycisków w panelu ustawień", after: 40_000 },
          { id: 3, turn: "u2", title: "Naprawiono logowanie przez OAuth w panelu" },
          { id: 4, turn: "u3", title: "Refactored the memory module storage layer" },
        ],
        ownNotes: [
          ["u1", 1, "Port 47777 trzymał osierocony proces workera"],
          ["u2", 2, "Dodano test modułu sesji"],
          ["u3", 3, "Przebudowano warstwę zapisu modułu pamięci"],
        ],
        promptCount: 3,
      });
      // ta sama treść po polsku i angielsku: słowa się nie pokrywają, wektory tak
      s.repo.putVector(s.note("u3"), "demo", "test", q8One(5), bitsWith(5), true);
      s.repo.putVector(4, "demo", "test", q8One(5), bitsWith(5), true);
      const r = repair(s.repo, { cmDbPath: s.cmPath });
      expect(r.dups.merged).toBe(2);
      expect(r.dups.notSimilar).toBe(1);
      const o1 = s.repo.getObservation(s.note("u1"))!;
      expect(o1.status).toBe("merged");
      expect(o1.merged_into).toBe(1);
      expect(o1.meta).toMatchObject({ repair: "cm-dup", true_n: 1, by: "words" });
      const o2 = s.repo.getObservation(s.note("u2"))!;
      expect(o2.status).toBe("active");
      expect(o2.merged_into ?? null).toBeNull();
      const o3 = s.repo.getObservation(s.note("u3"))!;
      expect(o3.merged_into).toBe(4);
      expect(o3.meta).toMatchObject({ by: "vec", similarity: 1 });
      expect(r.sample["cm-dup-kept"]).toEqual([s.note("u2")]);
    });

    test("licznik promptów i sessions.meta.n razem: ingest numeruje dalej od prawdziwego numeru tury", async () => {
      const s = await brokenSession({
        sid: "aaaaaaaa-1111-4111-8111-000000000002",
        dir: "D--licznik",
        turns: work.slice(0, 3),
        cmPrompts: [
          ["u1", 1],
          ["u2", 2],
        ],
        // backfill liczył od licznika claude-mem (2): tury 1, 2, 3 dostały 3, 4, 5
        ownNotes: [["u3", 5, "Refaktor modułu pamięci gotowy"]],
        ownPrompts: [
          ["u1", 3],
          ["u2", 4],
          ["u3", 5],
        ],
        promptCount: 5,
      });
      // ingest zapisuje numer ostatniej tury w meta.n razem z offsetem i od niego liczy dalej
      s.repo.db.run("UPDATE sessions SET meta = json_set(COALESCE(meta, '{}'), '$.n', 5) WHERE id = ?", [s.sid]);
      const r = repair(s.repo, { cmDbPath: s.cmPath });
      expect(r.dups.promptCount).toBe(1);
      expect(counter(s.repo, s.sid)).toEqual({ prompt_count: 3, n: 3 });
      writeTranscript(s.tpath, s.sid, [work[3]], true);
      ingestTranscript(s.repo, { sessionId: s.sid, transcriptPath: s.tpath, final: true });
      expect(sessionPrompts(s.repo, s.sid).map((p) => p.n)).toEqual([1, 2, 3, 4]);
      expect(counter(s.repo, s.sid)).toEqual({ prompt_count: 4, n: 4 });
    });

    test("powtórzony klucz tury: notatka zostaje przy wystąpieniu, w którego zakresie się zaczyna", () => {
      const repo = freshRepo();
      const sid = "aaaaaaaa-1111-4111-8111-00000000000d";
      const tpath = join(claudeDir(), "projects", "D--powtorka", `${sid}.jsonl`);
      mkdirSync(dirname(tpath), { recursive: true });
      // linia historii powtórzona dalej w pliku: ten sam uuid promptu wraca jako tura 3
      writeTranscript(tpath, sid, [work[0], work[1], { ...work[0], at: T0 + 240_000 }]);
      const list = turnsOf(tpath, sid);
      expect(list.filter((t) => t.key === "u1").length).toBe(2);
      const first = list[0];
      repo.upsertSession({ id: sid, project: "demo", started_at: T0, transcript_path: tpath, source: "backfill" });
      const { id } = repo.insertObservation({
        session_id: sid,
        project: "demo",
        prompt_n: 1,
        type: "change",
        title: "Port trzymał osierocony proces workera",
        narrative: "Port trzymał osierocony proces workera.",
        created_at: first.endedAt,
        source: "backfill",
        turn_key: "u1",
        transcript_ref: { path: tpath, from: first.from, to: first.to },
      });
      repo.setTranscriptProgress(sid, statSync(tpath).size, 3, list.at(-1)!.endedAt);
      repair(repo, { cmDbPath: file("brak.db") });
      expect(repo.getObservation(id)!.prompt_n).toBe(1);
      expect(repair(repo, { cmDbPath: file("brak.db") }).changes).toBe(0);
    });

    test("plik sesji: najdłuższa kopia transkryptu, nie pierwszy odnośnik notatki", async () => {
      const sid = "aaaaaaaa-1111-4111-8111-000000000003";
      // starsza, krótsza kopia (sesja wznowiona w innym katalogu); notatka z niej jest pierwsza
      const old = join(claudeDir(), "projects", "D--stara-kopia", `${sid}.jsonl`);
      mkdirSync(dirname(old), { recursive: true });
      writeTranscript(old, sid, work.slice(0, 2));
      const s = await brokenSession({
        sid,
        dir: "D--nowa-kopia",
        turns: work,
        cmPrompts: [
          ["u1", 1],
          ["u2", 2],
        ],
        ownNotes: [
          ["u1", 3, "Port trzymał osierocony proces", old],
          ["u3", 5, "Refaktor modułu pamięci gotowy"],
          ["u4", 6, "Wszystkie testy przeszły"],
        ],
        ownPrompts: [
          ["u1", 3],
          ["u2", 4],
          ["u3", 5],
          ["u4", 6],
        ],
        promptCount: 6,
      });
      const r = repair(s.repo, { cmDbPath: s.cmPath });
      expect(r.dups.unmatchedPrompts).toBe(0);
      expect(sessionPrompts(s.repo, s.sid).map((p) => [p.n, p.source])).toEqual([
        [1, "claude-mem"],
        [2, "claude-mem"],
        [3, "backfill"],
        [4, "backfill"],
      ]);
      expect(s.repo.getObservation(s.note("u1"))?.prompt_n).toBe(1);
      expect(s.repo.getObservation(s.note("u3"))?.prompt_n).toBe(3);
      expect(s.repo.getObservation(s.note("u4"))?.prompt_n).toBe(4);
      expect(counter(s.repo, s.sid)).toEqual({ prompt_count: 4, n: 4 });
    });

    test("komendy lokalne ze starej numeracji znikają; prompt claude-mem na numerze innej tury idzie na numer swojej (T-20)", async () => {
      // A: /model między turami miał numer i wiersz w prompts; ingest nie daje mu już ani jednego, ani drugiego
      const a = await brokenSession({
        sid: "aaaaaaaa-1111-4111-8111-000000000004",
        dir: "D--komendy",
        turns: [
          work[0],
          { uuid: "m1", prompt: "/model claude-opus-5", at: T0 + 30_000, answer: "Set model to claude-opus-5", local: true },
          work[1],
          work[2],
        ],
        cmPrompts: [["u1", 1]],
        ownNotes: [
          ["u2", 4, "Dodano test modułu sesji"],
          ["u3", 5, "Refaktor modułu pamięci gotowy"],
        ],
        ownPrompts: [
          ["u1", 2],
          ["m1", 3],
          ["u2", 4],
          ["u3", 5],
        ],
        promptCount: 5,
      });
      const ra = repair(a.repo, { cmDbPath: a.cmPath });
      expect(ra.dups).toMatchObject({ deletedPrompts: 1, unnumberedPrompts: 1, renumberedPrompts: 2, renumberConflicts: 0 });
      expect(sessionPrompts(a.repo, a.sid).map((p) => [p.n, p.source])).toEqual([
        [1, "claude-mem"],
        [2, "backfill"],
        [3, "backfill"],
      ]);
      expect(a.repo.getObservation(a.note("u2"))?.prompt_n).toBe(2);
      expect(a.repo.getObservation(a.note("u3"))?.prompt_n).toBe(3);
      expect(counter(a.repo, a.sid)).toEqual({ prompt_count: 3, n: 3 });

      // B: claude-mem nie zapisał promptu u3, więc u4 ma u niego numer 3, czyli prawdziwy numer u3. Dawniej cała sesja
      // zostawała bez zmian numeracji; teraz prompt claude-mem idzie na numer swojej tury razem z notatką
      // i podsumowaniem, a notatka claude-mem bez promptu na numerze tury do zakresu PROMPT_CM_BASE
      const sidB = "aaaaaaaa-1111-4111-8111-000000000005";
      const b = await brokenSession({
        sid: sidB,
        dir: "D--konflikt",
        turns: work,
        cmPrompts: [
          ["u1", 1],
          ["u2", 2],
          ["u4", 3],
        ],
        cmNotes: [{ id: 1, turn: "u4", title: "Testy jednostkowe przeszły w całości" }],
        cmExtra: (cm, turns) => {
          // notatka do promptu 4, którego claude-mem nie zapisał (np. pobudka pętli po u4), i podsumowanie promptu 3
          cmObs(cm, {
            id: 2,
            sid: sidB,
            title: "Pętla sprawdziła stan kolejki",
            prompt: 4,
            at: turns.get("u4")!.endedAt + 60_000,
          });
          cm.run(
            "INSERT INTO session_summaries (id, memory_session_id, project, request, files_read, files_edited, prompt_number, created_at_epoch) VALUES (1, ?, 'demo', 'testy', '[]', '[]', 3, ?)",
            [`mem-${sidB}`, turns.get("u4")!.endedAt + 90_000],
          );
        },
        ownNotes: [["u3", 6, "Refaktor modułu pamięci gotowy"]],
        ownPrompts: [
          ["u1", 4],
          ["u2", 5],
          ["u3", 6],
          ["u4", 7],
        ],
        promptCount: 7,
      });
      const cmNoteN = (id: number) => b.repo.getObservation(id)?.prompt_n;
      const summaryN = () =>
        (b.repo.db.query("SELECT prompt_n FROM summaries WHERE id = 1").get() as { prompt_n: number }).prompt_n;
      const cmMap = () => b.repo.cmPromptMaps().get(b.sid);
      expect([cmNoteN(1), cmNoteN(2), summaryN()]).toEqual([3, 4, 3]);
      const ro = openDb({ path: b.repo.db.filename, readonly: true });
      const dry = repair(new Repo(ro), { dryRun: true, cmDbPath: b.cmPath });
      ro.close();
      const rb = repair(b.repo, { cmDbPath: b.cmPath });
      // próba przewiduje przebieg właściwy, także odzysk tur (d) na numeracji po b)
      expect(rb.dups).toEqual(dry.dups);
      expect(rb.recover).toEqual(dry.recover);
      expect(rb.changes).toBe(dry.changes);
      expect(rb.dups).toMatchObject({
        renumberConflicts: 0,
        deletedPrompts: 3,
        renumberedPrompts: 1,
        cmPrompts: 1,
        cmNotes: 2,
        cmOrphans: 1,
        substitutes: 0,
        promptN: 1,
        promptCount: 1,
      });
      expect(sessionPrompts(b.repo, b.sid).map((p) => [p.n, p.source])).toEqual([
        [1, "claude-mem"],
        [2, "claude-mem"],
        [3, "backfill"],
        [4, "claude-mem"],
      ]);
      expect(b.repo.getObservation(b.note("u3"))?.prompt_n).toBe(3);
      // notatka i podsumowanie idą za promptem u4, notatka bez promptu nie wygląda na notatkę u4
      expect([cmNoteN(1), cmNoteN(2), summaryN()]).toEqual([4, PROMPT_CM_BASE + 4, 4]);
      expect(cmMap()).toEqual(
        new Map([
          [3, 4],
          [4, PROMPT_CM_BASE + 4],
        ]),
      );
      expect(counter(b.repo, b.sid)).toEqual({ prompt_count: 4, n: 4 });
      // get_tool_uses szuka w claude-mem po jego numerze promptu
      expect([
        b.repo.cmOrigPromptN(b.sid, 4),
        b.repo.cmOrigPromptN(b.sid, PROMPT_CM_BASE + 4),
        b.repo.cmOrigPromptN(b.sid, 1),
      ]).toEqual([3, 4, 1]);
      const settled = JSON.stringify([sessionPrompts(b.repo, b.sid), cmNoteN(1), cmNoteN(2), summaryN(), [...(cmMap() ?? [])]]);
      expect(repair(b.repo, { cmDbPath: b.cmPath }).changes).toBe(0);

      // ponowny import od zera: prompt pod nowym numerem nie wraca pod starym, nowe notatki idą pod nowe numery
      for (const k of ["cm_last_prompt_id", "cm_last_obs_id", "cm_last_summary_id"]) setMeta(b.repo.db, k, "0");
      const cm = new Database(b.cmPath);
      const u4 = turnsOf(b.tpath, b.sid).find((t) => t.key === "u4")!;
      cmObs(cm, { id: 3, sid: b.sid, title: "Druga notatka promptu 3 w claude-mem", prompt: 3, at: u4.endedAt + 100_000 });
      cmObs(cm, { id: 4, sid: b.sid, title: "Druga notatka promptu 4 w claude-mem", prompt: 4, at: u4.endedAt + 110_000 });
      cm.close();
      const st = await importClaudeMem(b.repo, { dbPath: b.cmPath });
      expect(st.prompts).toBe(0);
      expect(st.promptsKnown).toBe(3);
      expect(st.observations).toBe(2);
      expect([cmNoteN(3), cmNoteN(4)]).toEqual([4, PROMPT_CM_BASE + 4]);
      expect(JSON.stringify([sessionPrompts(b.repo, b.sid), cmNoteN(1), cmNoteN(2), summaryN(), [...(cmMap() ?? [])]])).toBe(
        settled,
      );
      expect(repair(b.repo, { cmDbPath: b.cmPath }).changes).toBe(0);
    });

    test("sesja z aplikacji desktop: pierwszy prompt na numerze 1, prompty claude-mem na numerach swoich tur (T-24)", async () => {
      // claude-mem nie widział pierwszej tury (prompt desktop z <system-reminder>), więc dalsze tury mają u niego numery
      // o 1 za małe. A: poprzednia naprawa dopisała prompt pierwszej tury pod numerem zastępczym (3)
      const a = await brokenSession({
        sid: "aaaaaaaa-1111-4111-8111-00000000000e",
        dir: "D--desktop-a",
        turns: work.slice(0, 3),
        cmPrompts: [
          ["u2", 1],
          ["u3", 2],
        ],
        cmNotes: [{ id: 1, turn: "u2", title: "Test modułu sesji dodany do zestawu" }],
        ownPrompts: [["u1", 3]],
        promptCount: 3,
      });
      // B: pierwsza tura bez promptu w bazie: odzysk (d) dopisuje go pod numerem 1, także w próbie
      const b = await brokenSession({
        sid: "aaaaaaaa-1111-4111-8111-00000000000f",
        dir: "D--desktop-b",
        turns: work.slice(0, 3),
        cmPrompts: [
          ["u2", 1],
          ["u3", 2],
        ],
        promptCount: 3,
      });
      for (const s of [a, b]) {
        const ro = openDb({ path: s.repo.db.filename, readonly: true });
        const dry = repair(new Repo(ro), { dryRun: true, cmDbPath: s.cmPath });
        ro.close();
        const r = repair(s.repo, { cmDbPath: s.cmPath });
        expect(r.dups).toEqual(dry.dups);
        expect(r.recover).toEqual(dry.recover);
        expect(r.recover.promptsMoved).toBe(0);
        const prompts = sessionPrompts(s.repo, s.sid);
        expect(prompts.map((p) => [p.n, p.source])).toEqual([
          [1, "backfill"],
          [2, "claude-mem"],
          [3, "claude-mem"],
        ]);
        expect(repair(s.repo, { cmDbPath: s.cmPath }).changes).toBe(0);
      }
      expect(sessionPrompts(a.repo, a.sid)[0].id).toBe(a.prompt("u1"));
      expect(a.repo.getObservation(1)?.prompt_n).toBe(2);
    });

    test("odzyskana notatka ma odciski plików z transkryptu: czas wyniku zapisu, nie wywołania (T-24)", () => {
      const repo = freshRepo();
      const sid = "aaaaaaaa-1111-4111-8111-000000000010";
      const tpath = join(claudeDir(), "projects", "D--odciski", `${sid}.jsonl`);
      mkdirSync(dirname(tpath), { recursive: true });
      // katalog projektu poza katalogiem tymczasowym (pliki tymczasowe digest pomija); nic tam nie jest zapisywane
      const proj = normPath(join(DATA_DIR.slice(0, 3), "hipokamp-test-odciski", "projekt"));
      const target = `${proj}/src/plik.ts`;
      const content = "export const x = 1;\n";
      const iso = (t: number) => new Date(T0 + t).toISOString();
      const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: sid, cwd: proj, ...o });
      writeFileSync(
        tpath,
        `${[
          line({ type: "user", uuid: "f1", timestamp: iso(0), message: { role: "user", content: "dodaj stałą x w pliku" } }),
          line({
            type: "assistant",
            uuid: "f1-a",
            timestamp: iso(1000),
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tool-w", name: "Write", input: { file_path: target, content } }],
            },
          }),
          // zapis czekał na zgodę: wynik 5 minut po wywołaniu
          line({
            type: "user",
            uuid: "f1-r",
            timestamp: iso(301_000),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-w", content: "ok" }] },
            toolUseResult: { type: "create", filePath: target },
          }),
          line({
            type: "assistant",
            uuid: "f1-z",
            timestamp: iso(302_000),
            message: { role: "assistant", content: [{ type: "text", text: "Dodałem stałą x w pliku src/plik.ts." }] },
          }),
        ].join("\n")}\n`,
      );
      repo.upsertSession({ id: sid, project: "demo", started_at: T0, transcript_path: tpath, source: "backfill" });
      repo.setTranscriptProgress(sid, statSync(tpath).size, 1, T0 + 302_000);
      const r = repair(repo, { cmDbPath: file("brak.db") });
      expect(r.recover.recovered).toBe(1);
      const o = repo.db.query("SELECT id FROM observations WHERE turn_key = 'f1'").get() as { id: number };
      const note = repo.getObservation(o.id)!;
      // klucz jak przy zapisie tury (katalog testowy może leżeć w repo nadrzędnym)
      const key = fileKey(target, proj);
      expect(note.files_modified).toEqual([key]);
      expect(note.fingerprints).toEqual({ [key]: `${T0 + 301_000}:${Buffer.byteLength(content)}` });
    });
  });

  describe("kopie: WAL i retencja", () => {
    test("przywrócenie kopii z plikiem -wal: transakcje z WAL zostają, przy źródle nie zostaje -shm", () => {
      const dir = file("restore-wal");
      mkdirSync(dir, { recursive: true });
      const live = join(dir, "zywa.db");
      const w = new Database(live, { create: true });
      w.run("PRAGMA journal_mode = WAL");
      w.run("CREATE TABLE t (x INTEGER)");
      w.run("PRAGMA wal_checkpoint(TRUNCATE)");
      for (let i = 0; i < 50; i++) w.run("INSERT INTO t VALUES (?)", [i]);
      // kopia bazy w trakcie pracy: wiersze tylko w -wal
      const src = join(dir, "kopia.db");
      copyFileSync(live, src);
      copyFileSync(`${live}-wal`, `${src}-wal`);
      w.close();
      const dbPath = join(dir, "hipokamp.db");
      writeFileSync(dbPath, "stara");
      const backups = join(dir, "kopie");
      const r = restoreDb(src, { dbPath, dir: backups });
      const back = new Database(dbPath, { readonly: true });
      expect(back.query("SELECT COUNT(*) c FROM t").get()).toEqual({ c: 50 });
      back.close();
      expect(readFileSync(r.previous!, "utf8")).toBe("stara");
      expect(existsSync(`${src}-wal`)).toBe(true);
      expect(existsSync(`${src}-shm`)).toBe(false);
      expect(readdirSync(backups).filter((f) => f.startsWith("restore-src"))).toEqual([]);
    });

    test("retencja: kopie z tagiem zostają, zwykłe (także w dawnym formacie nazwy) są przycinane", () => {
      const repo = freshRepo();
      const dir = file("kopie-retencja");
      const tagged = backupDb(repo.db, { dir, keep: 2, tag: "pre-repair" });
      // starsza kopia przed naprawą i zwykła kopia w dawnym formacie nazwy (bez sekund i przyrostka)
      const oldTagged = join(dir, "hipokamp-2020-01-01-00-00-00-abcdef-pre-repair.db");
      renameSync(tagged.file, oldTagged);
      const oldPlain = join(dir, "hipokamp-2020-01-01-00-00.db");
      copyFileSync(oldTagged, oldPlain);
      for (let i = 0; i < 3; i++) backupDb(repo.db, { dir, keep: 2 });
      const left = readdirSync(dir).filter((f) => f.endsWith(".db"));
      expect(left).toContain("hipokamp-2020-01-01-00-00-00-abcdef-pre-repair.db");
      expect(left).not.toContain("hipokamp-2020-01-01-00-00.db");
      expect(left.filter((f) => !f.includes("pre-repair")).length).toBe(2);
    });

    test("retencja: kopie z tej samej sekundy w kolejności zapisu, nie losowego przyrostka (T-26)", () => {
      const repo = freshRepo();
      const dir = file("kopie-sekunda");
      mkdirSync(dir, { recursive: true });
      // przyrostek starszej kopii jest „większy”: sama nazwa ustawiłaby je odwrotnie i usunęła nowszą
      const older = "hipokamp-2020-01-01-00-00-00-ffffff.db";
      const newer = "hipokamp-2020-01-01-00-00-00-000000.db";
      for (const [f, ms] of [
        [older, 100],
        [newer, 900],
      ] as const) {
        writeFileSync(join(dir, f), f);
        const t = new Date(Date.UTC(2020, 0, 1, 0, 0, 0, ms));
        utimesSync(join(dir, f), t, t);
      }
      const r = backupDb(repo.db, { dir, keep: 2 });
      expect(r.removed).toEqual([older]);
      expect(readdirSync(dir).sort()).toEqual([newer, r.file.split(/[\\/]/).at(-1)!].sort());
    });
  });

  describe("redakcja ścieżek, pojęć, kluczy encji i list pracy", () => {
    test("import: ścieżki plików, pojęcia i klucze encji przez clean(), także kolumna plików w FTS", async () => {
      const cmPath = file("cm-sciezki.db");
      const cm = fakeClaudeMem(cmPath);
      const t0 = Date.now() - DAY;
      cmSession(cm, "s-sciezki", t0);
      cm.run(
        "INSERT INTO observations (id, memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified, prompt_number, created_at_epoch, content_hash, occurrence_count, relevance_count) VALUES (1, 'mem-s-sciezki', 'demo', 'bugfix', 'Raport z odnośnikiem', 'opis', '[]', ?, ?, ?, 1, ?, 'h1', 1, 0)",
        [
          JSON.stringify([`klucz ${FAKE_KEY}`]),
          JSON.stringify([`raport.html?token=${FAKE_TOKEN}`, `notes/${FAKE_KEY}.md`]),
          JSON.stringify([`src/${FAKE_KEY}.ts`]),
          t0,
        ],
      );
      cm.run(
        "INSERT INTO session_summaries (id, memory_session_id, project, request, files_read, files_edited, created_at_epoch) VALUES (1, 'mem-s-sciezki', 'demo', 'r', ?, ?, ?)",
        [JSON.stringify([`notes/${FAKE_KEY}.md`]), JSON.stringify([`src/${FAKE_KEY}.ts`]), t0],
      );
      cm.close();
      const repo = freshRepo();
      await importClaudeMem(repo, { dbPath: cmPath });
      const o = repo.getObservation(1)!;
      expect(o.files_read.length).toBe(2);
      expect(JSON.stringify([o.files_read, o.files_modified, o.concepts])).not.toContain(FAKE_TOKEN);
      const keys = (repo.db.query("SELECT key FROM entities").all() as { key: string }[]).map((e) => e.key);
      expect(keys.length).toBe(4);
      expect(keys.join("\n")).not.toContain(FAKE_TOKEN);
      expect(ftsSearch(repo.db, FAKE_TOKEN)).toEqual([]);
      expect(JSON.stringify(repo.db.query("SELECT files_read, files_edited FROM summaries").all())).not.toContain(FAKE_TOKEN);
    });

    test("repair c): surowe ścieżki, pojęcia, klucze encji (ze scaleniem) i listy pracy ze starego importu", () => {
      const repo = freshRepo();
      const t0 = Date.now() - DAY;
      const otherKey = `sk-or-v1-${[...FAKE_TOKEN].reverse().join("")}`;
      // stary import: ścieżki, pojęcia, klucze encji i listy pracy bez clean()
      const a = repo.insertObservation(
        {
          session_id: null,
          project: "demo",
          type: "bugfix",
          title: "Raport z odnośnikiem",
          narrative: "opis",
          concepts: [`klucz ${FAKE_KEY}`],
          files_read: [`notes/${FAKE_KEY}.md`],
          files_modified: [`src/${FAKE_KEY}.ts`],
          created_at: t0,
          source: "claude-mem",
        },
        [
          { kind: "file", key: `notes/${FAKE_KEY}.md`, role: "read" },
          { kind: "file", key: `src/${FAKE_KEY}.ts`, role: "modified" },
        ],
      ).id;
      const b = repo.insertObservation(
        {
          session_id: null,
          project: "demo",
          type: "bugfix",
          title: "Druga notatka",
          narrative: "opis",
          files_read: [`notes/${otherKey}.md`],
          created_at: t0,
          source: "claude-mem",
        },
        [{ kind: "file", key: `notes/${otherKey}.md`, role: "read" }],
      ).id;
      repo.insertSummary({
        session_id: null,
        project: "demo",
        request: "r",
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        files_read: [`notes/${FAKE_KEY}.md`],
        files_edited: [],
        prompt_n: null,
        created_at: t0,
        source: "claude-mem",
      });
      repo.appendWorkState("demo", "zadania", { task: `klucz ${FAKE_KEY}`, status: "todo" }, t0, "claude-mem", 7);
      expect(ftsSearch(repo.db, FAKE_TOKEN).map((h) => h.id)).toContain(a);
      const dump = () =>
        JSON.stringify([
          repo.db.query("SELECT concepts, files_read, files_modified FROM observations ORDER BY id").all(),
          repo.db.query("SELECT files_read, files_edited FROM summaries ORDER BY id").all(),
          repo.db.query("SELECT kind, key, df FROM entities ORDER BY id").all(),
          repo.db.query("SELECT obs_id, entity_id FROM obs_entities ORDER BY obs_id, entity_id").all(),
          repo.db.query("SELECT fields FROM work_state ORDER BY id").all(),
        ]);
      const before = dump();
      const ro = openDb({ path: repo.db.filename, readonly: true });
      const dry = repair(new Repo(ro), { dryRun: true, cmDbPath: file("brak.db") });
      ro.close();
      expect(dump()).toBe(before);
      const r = repair(repo, { cmDbPath: file("brak.db") });
      expect(r.clean).toEqual(dry.clean);
      expect(r.clean).toMatchObject({ observations: 2, summaries: 1, entities: 3, workState: 1 });
      const after = dump();
      expect(after).not.toContain(FAKE_TOKEN);
      expect(after).not.toContain(otherKey);
      expect(ftsSearch(repo.db, FAKE_TOKEN)).toEqual([]);
      // dwa klucze po redakcji równe: jedna encja z powiązaniami obu notatek, df sumą
      const notes = repo.db.query("SELECT id, df FROM entities WHERE key LIKE 'notes/%'").all() as { id: number; df: number }[];
      expect(notes.length).toBe(1);
      expect(notes[0].df).toBe(2);
      expect(repo.db.query("SELECT obs_id FROM obs_entities WHERE entity_id = ? ORDER BY obs_id").all(notes[0].id)).toEqual([
        { obs_id: a },
        { obs_id: b },
      ]);
      expect(repair(repo, { cmDbPath: file("brak.db") }).changes).toBe(0);
    });

    test("repair c): scalenie encji po redakcji liczy df z powiązań, gdy notatka była przy obu kluczach (T-26)", () => {
      const repo = freshRepo();
      const t0 = Date.now() - DAY;
      const otherKey = `sk-or-v1-${[...FAKE_TOKEN].reverse().join("")}`;
      const k1 = `notes/${FAKE_KEY}.md`;
      const k2 = `notes/${otherKey}.md`;
      const obs = (title: string, ents: { key: string; role: "read" | "modified" }[]) =>
        repo.insertObservation(
          { session_id: null, project: "demo", type: "bugfix", title, narrative: "opis", created_at: t0, source: "claude-mem" },
          ents.map((e) => ({ kind: "file" as const, ...e })),
        ).id;
      const both = obs("Notatka przy obu kluczach", [
        { key: k1, role: "read" },
        { key: k2, role: "modified" },
      ]);
      const one = obs("Notatka przy pierwszym kluczu", [{ key: k1, role: "read" }]);
      const df = () => repo.db.query("SELECT df FROM entities WHERE key LIKE 'notes/%' ORDER BY id").all();
      expect(df()).toEqual([{ df: 2 }, { df: 1 }]);
      repair(repo, { cmDbPath: file("brak.db") });
      // dwie notatki przy jednej encji: suma dałaby 3
      expect(df()).toEqual([{ df: 2 }]);
      const e = repo.db.query("SELECT id FROM entities WHERE key LIKE 'notes/%'").get() as { id: number };
      expect(
        (repo.db.query("SELECT DISTINCT obs_id FROM obs_entities WHERE entity_id = ? ORDER BY obs_id").all(e.id) as any[]).map(
          (r) => r.obs_id,
        ),
      ).toEqual([both, one].sort((a, b) => a - b));
      expect(repair(repo, { cmDbPath: file("brak.db") }).changes).toBe(0);
    });

    test("repair c): dane własne zapisane starszymi regułami (adres / hasło) też idą przez obecne reguły", () => {
      const repo = freshRepo();
      const t0 = Date.now() - DAY;
      const secret = "KoTeK7@2!q";
      const raw = `konto ola@firma.pl / ${secret} na produkcji`;
      repo.upsertSession({ id: "s-wlasna", project: "demo", started_at: t0, source: "live" });
      repo.db.run("UPDATE sessions SET first_prompt = ? WHERE id = 's-wlasna'", [raw]);
      repo.insertObservation({
        session_id: "s-wlasna",
        project: "demo",
        type: "change",
        title: "Logowanie do panelu",
        narrative: raw,
        facts: [raw],
        created_at: t0,
        source: "digest",
      });
      repo.insertPrompt({ session_id: "s-wlasna", project: "demo", n: 1, text: raw, created_at: t0, source: "live" });
      repo.appendWorkState("demo", "zadania", { task: raw, status: "todo" }, t0, "live");
      const dump = () =>
        JSON.stringify([
          repo.db.query("SELECT narrative, facts FROM observations").all(),
          repo.db.query("SELECT text FROM prompts").all(),
          repo.db.query("SELECT first_prompt FROM sessions").all(),
          repo.db.query("SELECT fields FROM work_state").all(),
        ]);
      expect(dump()).toContain(secret);
      const r = repair(repo, { cmDbPath: file("brak.db") });
      expect(r.clean).toMatchObject({ observations: 1, prompts: 1, sessions: 1, workState: 1 });
      expect(dump()).not.toContain(secret);
      expect(dump()).toContain("ola@firma.pl / [REDACTED:login]");
      expect(ftsSearch(repo.db, "KoTeK7")).toEqual([]);
      expect(repair(repo, { cmDbPath: file("brak.db") }).changes).toBe(0);
    });

    test("ważność: powtórki podbijają ją tylko dwa razy; migracja 5 cofa nadmiar z 0.1", () => {
      const repo = freshRepo();
      const note = (title: string) =>
        repo.insertObservation({
          session_id: null,
          project: "nasluch",
          prompt_n: null,
          type: "discovery",
          title,
          narrative: "Sprawdzenie nowych wiadomości, brak zmian.",
          importance: 0.3,
          created_at: Date.now(),
          source: "digest",
        });
      const first = note("Pobudka kolejki").id;
      for (let i = 0; i < 6; i++) expect(note("Pobudka kolejki").duplicateOf).toBe(first);
      const row = repo.db.query("SELECT occurrence_count, importance FROM observations WHERE id = ?").get(first) as {
        occurrence_count: number;
        importance: number;
      };
      expect(row.occurrence_count).toBe(7);
      expect(row.importance).toBeCloseTo(0.4, 6);

      // baza w wersji 4 ze stanem z 0.1: sufit po 500 powtórkach, 5 powtórek bez sufitu, notatki, których to nie dotyczy
      const path = file("v4.db");
      const raw = new Database(path, { create: true });
      for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m);
      raw.run("INSERT INTO meta (k, v) VALUES ('schema_version', '4')");
      const add = raw.prepare(
        "INSERT INTO observations (id, project, type, title, importance, occurrence_count, created_at, updated_at, source) VALUES (?, 'demo', ?, ?, ?, ?, 1, 1, ?)",
      );
      add.run(1, "discovery", "Powtarzany prompt", 1, 500, "backfill");
      add.run(2, "discovery", "Pobudka pętli", 0.43, 5, "backfill");
      add.run(3, "decision", "Decyzja powtórzona", 0.72, 3, "backfill");
      add.run(4, "discovery", "Notatka claude-mem", 0.9, 5, "claude-mem");
      add.run(5, "decision", "Zapamiętana decyzja", 1, 5, "agent");
      raw.close();
      const migrated = new Repo(openDb({ path }));
      expect(getMeta(migrated.db, "schema_version")).toBe(String(MIGRATIONS.length));
      const imp = (id: number) =>
        (migrated.db.query("SELECT importance FROM observations WHERE id = ?").get(id) as { importance: number }).importance;
      // sufit: baza typu discovery 0,28 + 0,10; bez sufitu: 0,43 - 4 × 0,05 + 0,10
      expect(imp(1)).toBeCloseTo(0.38, 6);
      expect(imp(2)).toBeCloseTo(0.33, 6);
      expect(imp(3)).toBe(0.72);
      expect(imp(4)).toBe(0.9);
      // ważność nadana świadomie (remember) zostaje
      expect(imp(5)).toBe(1);
    });

    test("migracje: kilka procesów naraz otwiera starą bazę przy zajętym zapisie; każda migracja raz", async () => {
      const path = file("v2-wyscig.db");
      const raw = new Database(path, { create: true });
      raw.run("PRAGMA journal_mode = WAL");
      raw.exec(MIGRATIONS[0]);
      raw.exec(MIGRATIONS[1]);
      raw.run("INSERT INTO meta (k, v) VALUES ('schema_version', '2')");
      const add = raw.prepare(
        "INSERT INTO observations (id, project, type, title, importance, occurrence_count, created_at, updated_at, source) VALUES (?, 'demo', 'discovery', ?, ?, ?, 1, 1, 'backfill')",
      );
      add.run(1, "Sufit po powtórkach", 1, 500);
      add.run(2, "Powtórki bez sufitu", 0.43, 5);
      const script = file("otworz.ts");
      writeFileSync(
        script,
        `import { openDb } from ${JSON.stringify(join(import.meta.dir, "..", "src", "db", "db.ts"))};\nopenDb({ path: process.argv[2] }).close();\n`,
      );
      // inny proces trzyma zapis (sen, naprawa, duży ingest), a w tym czasie startuje kilka procesów hipokampa
      raw.run("BEGIN IMMEDIATE");
      const procs = Array.from({ length: 6 }, () =>
        Bun.spawn([process.execPath, script, path], { env: process.env, stdout: "pipe", stderr: "pipe" }),
      );
      await Bun.sleep(1500);
      raw.run("COMMIT");
      const codes = await Promise.all(procs.map((p) => p.exited));
      const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
      expect([codes, errs.filter(Boolean)]).toEqual([[0, 0, 0, 0, 0, 0], []]);
      const imp = (id: number) =>
        (raw.query("SELECT importance FROM observations WHERE id = ?").get(id) as { importance: number }).importance;
      expect(imp(1)).toBeCloseTo(0.38, 6);
      expect(imp(2)).toBeCloseTo(0.33, 6);
      expect(getMeta(raw, "schema_version")).toBe(String(MIGRATIONS.length));
      expect(
        (raw.query("SELECT COUNT(*) c FROM pragma_table_info('work_state') WHERE name = 'cm_id'").get() as { c: number }).c,
      ).toBe(1);
      raw.close();
    });

    test("listy pracy: ponowny import od zera nie dubluje wpisów; wpis sprzed numeru claude-mem dostaje numer", async () => {
      const cmPath = file("cm-listy.db");
      const cm = fakeClaudeMem(cmPath);
      const t0 = Date.now() - DAY;
      const ws = (id: number, fields: Record<string, unknown>, at: number) =>
        cm.run(
          "INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (?, 'demo', 'zadania', ?, ?)",
          [id, JSON.stringify(fields), at],
        );
      ws(1, { task: "pierwsze", status: "todo" }, t0);
      ws(2, { task: `klucz ${FAKE_KEY}`, status: "doing" }, t0 + 1000);
      cm.close();
      const repo = freshRepo();
      const count = () => (repo.db.query("SELECT COUNT(*) c FROM work_state").get() as { c: number }).c;
      expect((await importClaudeMem(repo, { dbPath: cmPath })).workState).toBe(2);
      expect(JSON.stringify(repo.db.query("SELECT fields FROM work_state").all())).not.toContain(FAKE_TOKEN);
      // import od zera: oba wpisy rozpoznane
      setMeta(repo.db, "cm_last_ws_id", "0");
      const again = await importClaudeMem(repo, { dbPath: cmPath });
      expect(again.workState).toBe(0);
      expect(count()).toBe(2);
      // wpis z importu sprzed migracji 4 (bez numeru): kolejny import od zera nadaje mu numer zamiast dopisać kopię
      repo.db.run("UPDATE work_state SET cm_id = NULL WHERE cm_id = 1");
      setMeta(repo.db, "cm_last_ws_id", "0");
      const third = await importClaudeMem(repo, { dbPath: cmPath });
      expect(third.workStateKnown).toBe(2);
      expect(repo.db.query("SELECT cm_id FROM work_state ORDER BY id").all()).toEqual([{ cm_id: 1 }, { cm_id: 2 }]);
    });
  });

  describe("klucze plików względem repo (T-27)", () => {
    /** Repo „Studio” z istniejącym worktree (plik .git) i ścieżką worktree, którego już nie ma. */
    const studio = () => {
      const base = join(DATA_DIR, `studio-${++seq}`);
      const root = join(base, "Studio");
      mkdirSync(join(root, ".git", "worktrees", "wt1"), { recursive: true });
      const wt = join(root, ".claude", "worktrees", "wt1");
      mkdirSync(join(wt, "src"), { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "wt1")}\n`);
      const abs = (...p: string[]) => normPath(join(root, ...p));
      return { root, abs, outside: normPath(join(base, "poza", "x.ts")) };
    };
    const fileEnts = (repo: RepoT, project: string) =>
      repo.db.query("SELECT key, df FROM entities WHERE kind = 'file' AND project = ? ORDER BY key").all(project) as {
        key: string;
        df: number;
      }[];

    test("import claude-mem: ścieżki absolutne i z prefiksem worktree względem repo projektu", async () => {
      const s = studio();
      const repo = freshRepo();
      // sesja hipokampa w repo (z niej korzeń projektu) i jej notatka o src/a.ts
      repo.upsertSession({ id: "s-live", project: "Studio", cwd: s.root, started_at: Date.now() - DAY, source: "live" });
      repo.insertObservation(
        {
          session_id: "s-live",
          project: "Studio",
          type: "change",
          title: "Zmiana w src/a.ts",
          narrative: "opis",
          files_modified: ["src/a.ts"],
          created_at: Date.now() - DAY,
          source: "digest",
        },
        [{ kind: "file", key: "src/a.ts", role: "modified" }],
      );
      const cmPath = file("cm-klucze.db");
      const cm = fakeClaudeMem(cmPath);
      const t0 = Date.now() - DAY / 2;
      // sesja claude-mem bez katalogu: fileKey zostawiał ścieżki absolutne
      cm.run(
        "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at_epoch, status, prompt_counter, cwd) VALUES ('s-cm', 'mem-s-cm', 'Studio', ?, 'completed', 1, NULL)",
        [t0],
      );
      cm.run(
        "INSERT INTO observations (id, memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified, prompt_number, created_at_epoch, content_hash, occurrence_count, relevance_count) VALUES (1, 'mem-s-cm', 'Studio', 'change', 'Pliki repo i worktree', 'opis', '[]', '[]', ?, ?, 1, ?, 'h-klucze', 1, 0)",
        [
          JSON.stringify([".claude/worktrees/wt1/src/d.ts"]),
          JSON.stringify([
            s.abs("src", "a.ts"),
            s.abs(".claude", "worktrees", "wt1", "src", "b.ts"),
            s.abs(".claude", "worktrees", "zniknal", "src", "c.ts"),
            s.outside,
          ]),
          t0 + 1000,
        ],
      );
      cm.close();
      await importClaudeMem(repo, { dbPath: cmPath });
      const o = repo.getObservation(1)!;
      expect(o.files_modified).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", s.outside]);
      expect(o.files_read).toEqual(["src/d.ts"]);
      // encja src/a.ts wspólna z notatką sesji hipokampa
      expect(fileEnts(repo, "Studio")).toEqual([
        { key: s.outside, df: 1 },
        { key: "src/a.ts", df: 2 },
        { key: "src/b.ts", df: 1 },
        { key: "src/c.ts", df: 1 },
        { key: "src/d.ts", df: 1 },
      ]);
    });

    test("repair e): klucze ze starego importu (encje ze scaleniem, listy, odciski, FTS); próba = zapis; drugi raz nic", () => {
      const s = studio();
      const repo = freshRepo();
      const at = Date.now() - DAY;
      repo.upsertSession({ id: "s-live", project: "Studio", cwd: s.root, started_at: at, source: "live" });
      const add = (project: string, title: string, files: string[], extra: Record<string, unknown> = {}) =>
        repo.insertObservation(
          {
            session_id: null,
            project,
            type: "change",
            title,
            narrative: "opis",
            files_modified: files,
            created_at: at,
            source: "claude-mem",
            ...extra,
          },
          files.map((key) => ({ kind: "file" as const, key, role: "modified" as const })),
        ).id;
      const live = add("Studio", "Notatka hipokampa o src/a.ts", ["src/a.ts"], { source: "digest" });
      // claude-mem sklejał czasem katalog worktree ze ścieżką absolutną: po zdjęciu prefiksu worktree wychodzi znów
      // ścieżka absolutna, którą trzeba sprowadzić w tym samym przebiegu (próba na kopii bazy: drugi przebieg dawał 2)
      const glued = `${s.abs(".claude", "worktrees", "zniknal")}/${s.abs("src", "e.ts")}`;
      // worktree w katalogu obok repo („Studio.wt/<nazwa>”), którego już nie ma
      const sibling = normPath(join(s.root, "..", "Studio.wt", "feature-x", "src", "f.ts"));
      const old = add(
        "Studio",
        "Stary import z kluczami absolutnymi",
        [s.abs("src", "a.ts"), s.abs(".claude", "worktrees", "zniknal", "src", "c.ts"), s.outside, glued, sibling],
        { fingerprints: { [s.abs("src", "a.ts")]: "1000:5" } },
      );
      // inny projekt: plik repo Studio nie jest jego plikiem, klucz zostaje
      const other = add("Inny", "Inny projekt o tym samym pliku", [s.abs("src", "a.ts")]);
      repo.insertSummary({
        session_id: null,
        project: "Studio",
        request: "r",
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        files_read: [],
        files_edited: [s.abs(".claude", "worktrees", "wt1", "src", "b.ts")],
        prompt_n: null,
        created_at: at,
        source: "claude-mem",
      });
      expect(ftsSearch(repo.db, "zniknal").map((h) => h.id)).toContain(old);
      const dump = () =>
        JSON.stringify([
          repo.db.query("SELECT id, files_modified, fingerprints FROM observations ORDER BY id").all(),
          repo.db.query("SELECT files_edited FROM summaries ORDER BY id").all(),
          repo.db.query("SELECT project, key, df FROM entities ORDER BY id").all(),
        ]);
      const before = dump();
      const ro = openDb({ path: repo.db.filename, readonly: true });
      const dry = repair(new Repo(ro), { dryRun: true, cmDbPath: file("brak.db") });
      ro.close();
      expect(dump()).toBe(before);
      const logPath = file("repair-e.jsonl");
      const r = repair(repo, { cmDbPath: file("brak.db"), logPath });
      expect(r.fileKeys).toEqual(dry.fileKeys);
      expect(r.fileKeys).toEqual({ entities: 4, merged: 1, notes: 1, summaries: 1 });
      // dziennik: stary i nowy klucz przy każdej zmianie (scalenie encji jest nieodwracalne)
      const log = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((e) => e.op === "file-key");
      const entA = log.find((e) => e.table === "entities" && e.from === s.abs("src", "a.ts"));
      expect(entA).toMatchObject({ to: "src/a.ts" });
      expect(typeof entA.into).toBe("number");
      expect(log.find((e) => e.table === "entities" && e.from === glued)).toMatchObject({ to: "src/e.ts", into: null });
      const noteLog = log.find((e) => e.table === "observations" && e.id === old);
      expect(noteLog.from).toEqual([
        s.abs("src", "a.ts"),
        s.abs(".claude", "worktrees", "zniknal", "src", "c.ts"),
        glued,
        sibling,
      ]);
      expect(noteLog.to).toEqual(["src/a.ts", "src/c.ts", "src/e.ts", "src/f.ts"]);
      expect(log.find((e) => e.table === "summaries")).toMatchObject({
        from: [s.abs(".claude", "worktrees", "wt1", "src", "b.ts")],
        to: ["src/b.ts"],
      });
      const o = repo.getObservation(old)!;
      expect(o.files_modified).toEqual(["src/a.ts", "src/c.ts", s.outside, "src/e.ts", "src/f.ts"]);
      expect(o.fingerprints).toEqual({ "src/a.ts": "1000:5" });
      expect(repo.getObservation(other)?.files_modified).toEqual([s.abs("src", "a.ts")]);
      expect(fileEnts(repo, "Studio")).toEqual([
        { key: s.outside, df: 1 },
        { key: "src/a.ts", df: 2 },
        { key: "src/c.ts", df: 1 },
        { key: "src/e.ts", df: 1 },
        { key: "src/f.ts", df: 1 },
      ]);
      expect(fileEnts(repo, "Inny")).toEqual([{ key: s.abs("src", "a.ts"), df: 1 }]);
      expect(JSON.parse((repo.db.query("SELECT files_edited FROM summaries").get() as any).files_edited)).toEqual(["src/b.ts"]);
      // FTS z kolumną plików od nowa
      expect(ftsSearch(repo.db, "zniknal").map((h) => h.id)).not.toContain(old);
      expect(repo.getObservation(live)?.files_modified).toEqual(["src/a.ts"]);
      const again = repair(repo, { cmDbPath: file("brak.db") });
      expect(again.fileKeys).toEqual({ entities: 0, merged: 0, notes: 0, summaries: 0 });
      expect(again.changes).toBe(0);
    });

    test("katalog zbiorczy (wiele repo, domowy, tymczasowy, System32) nie jest korzeniem; później scalenie z repo poprawia klucz", async () => {
      const { isGenericDir, isProjectContainer, isProjectRoot } = await import("../src/util/paths.ts");
      const { mergeProject } = await import("../src/core/projects.ts");
      const { homedir } = await import("node:os");
      // „D:/code”: katalog z trzema repozytoriami, sesja otwarta w nim dostała klucz projektu „code”
      const code = join(DATA_DIR, `zbiorczy-${++seq}`, "code");
      for (const r of ["alpha", "beta", "gamma"]) mkdirSync(join(code, r, ".git"), { recursive: true });
      const abs = normPath(join(code, "alpha", "README.md"));
      // ta sama reguła co dla katalogu startowego sesji (place.ts): kontener, nie projekt
      expect(isProjectContainer(code)).toBe(true);
      expect(isProjectRoot(code)).toBe(false);
      expect(isProjectContainer(join(code, "alpha"))).toBe(false);
      expect(isGenericDir(join(code, "alpha"))).toBe(false);
      // katalogi systemu Windows i korzeń dysku tylko na Windows (na Linuksie „C:\Windows” to ścieżka względna);
      // korzeń systemu plików na każdym systemie
      const system =
        process.platform === "win32"
          ? [process.env.SystemRoot || "C:\\Windows", join(process.env.SystemRoot || "C:\\Windows", "System32"), "D:\\"]
          : ["/"];
      for (const d of [homedir(), tmpdir(), ...system]) expect([d, isProjectContainer(d)]).toEqual([d, true]);
      // dwa repo to jeszcze nie katalog zbiorczy
      const two = join(DATA_DIR, `dwa-${++seq}`, "projekt");
      for (const r of ["a", "b"]) mkdirSync(join(two, r, ".git"), { recursive: true });
      expect(isProjectContainer(two)).toBe(false);

      const repo = freshRepo();
      const at = Date.now() - DAY;
      repo.upsertSession({ id: "s-code", project: "code", cwd: code, started_at: at, source: "live" });
      const id = repo.insertObservation(
        {
          session_id: null,
          project: "code",
          type: "change",
          title: "README alpha",
          narrative: "opis",
          files_modified: [abs],
          created_at: at,
          source: "claude-mem",
        },
        [{ kind: "file", key: abs, role: "modified" }],
      ).id;
      // bez wykluczenia: klucz względem „code” („alpha/README.md”), którego ręczne scalenie z alpha już nie poprawi
      const r = repair(repo, { cmDbPath: file("brak.db") });
      expect(r.fileKeys).toEqual({ entities: 0, merged: 0, notes: 0, summaries: 0 });
      expect(repo.getObservation(id)?.files_modified).toEqual([abs]);
      expect(fileEnts(repo, "code")).toEqual([{ key: abs, df: 1 }]);
      // ręczne scalenie z właściwym repo: klucz względem repo alpha
      repo.upsertSession({ id: "s-alpha", project: "alpha", cwd: join(code, "alpha"), started_at: at, source: "live" });
      mergeProject(repo.db, "code", "alpha");
      expect(repo.getObservation(id)?.files_modified).toEqual(["README.md"]);
      expect(fileEnts(repo, "alpha")).toEqual([{ key: "README.md", df: 1 }]);
    });
  });

  describe("kopia przed migracją schematu (T-25)", () => {
    test("repair i project merge robią kopię z bazy w starej wersji, zanim otwarcie do zapisu ją zmigruje", async () => {
      const version = (path: string) => {
        const d = new Database(path, { readonly: true });
        try {
          return (d.query("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string }).v;
        } finally {
          d.close();
        }
      };
      const oldDb = (home: string) => {
        mkdirSync(home, { recursive: true });
        const raw = new Database(join(home, "hipokamp.db"), { create: true });
        for (const m of MIGRATIONS.slice(0, -1)) raw.exec(m);
        raw.run("INSERT INTO meta (k, v) VALUES ('schema_version', ?)", [String(MIGRATIONS.length - 1)]);
        for (const p of ["Stary", "Repo"])
          raw.run(
            "INSERT INTO observations (project, type, title, created_at, updated_at, source) VALUES (?, 'change', ?, 1, 1, 'backfill')",
            [p, `notatka ${p}`],
          );
        raw.close();
      };
      const run = async (home: string, ...args: string[]) => {
        const p = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
          cwd: join(import.meta.dir, ".."),
          env: { ...(process.env as Record<string, string>), HIPOKAMP_HOME: home, CLAUDE_MEM_DB: join(home, "brak.db") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        return { code: await p.exited, out: `${out}\n${err}` };
      };
      for (const [tag, args] of [
        ["pre-repair", ["repair"]],
        ["pre-project-merge", ["project", "merge", "Stary", "Repo"]],
      ] as const) {
        const home = file(`stara-baza-${tag}`);
        oldDb(home);
        const r = await run(home, ...args);
        expect([tag, r.code]).toEqual([tag, 0]);
        const dir = join(home, "backups", "db");
        const copy = readdirSync(dir).find((f) => f.includes(tag));
        expect(copy).toBeDefined();
        expect(version(join(dir, copy!))).toBe(String(MIGRATIONS.length - 1));
        expect(version(join(home, "hipokamp.db"))).toBe(String(MIGRATIONS.length));
      }
    }, 60_000);
  });

  test("próba przy brakujących wpisach claude-mem (krok a): raport mówi, że liczby b) mogą się różnić", async () => {
    const { formatRepairReport } = await import("../src/core/repair.ts");
    const rep = repair(freshRepo(), { dryRun: true, cmDbPath: file("brak.db") });
    const note = "próba nie wstawia wpisów z a)";
    expect(formatRepairReport(rep)).not.toContain(note);
    const missing = { observations: 2, summaries: 1, source: true };
    expect(formatRepairReport({ ...rep, reimport: missing })).toContain(note);
    expect(formatRepairReport({ ...rep, dryRun: false, reimport: missing })).not.toContain(note);
  });

  describe("najpierw repair, potem sync", () => {
    test("ślad synchronizacji: meta.sync_hub, plik stanu albo wiersze sync_map", async () => {
      const { syncInUse } = await import("../src/core/sync-guard.ts");
      const state = file("state");
      mkdirSync(state, { recursive: true });
      const repo = freshRepo();
      expect(syncInUse(repo.db, state)).toBeNull();
      writeFileSync(join(state, "sync.json"), "{}");
      expect(syncInUse(repo.db, state)).toContain("sync.json");
      rmSync(join(state, "sync.json"));
      // tabelę zakłada migracja synchronizacji (docs/SYNC.md); pusta nie jest śladem
      expect(repo.db.query("SELECT 1 FROM sqlite_master WHERE name = 'sync_map'").get()).toBeTruthy();
      expect(syncInUse(repo.db, state)).toBeNull();
      repo.db.run("INSERT INTO sync_map (kind, gid, local_id, origin) VALUES ('obs', '1:1', 1, 1)");
      expect(syncInUse(repo.db, state)).toContain("wymienione");
      setMeta(repo.db, "sync_hub", "hub-abc");
      expect(syncInUse(repo.db, state)).toContain("hub-abc");
    });

    test("repair i project merge po synchronizacji: odmowa bez --force-sync-warning (bez kopii i zmian); próba ostrzega", async () => {
      const home = file("sync-home");
      mkdirSync(home, { recursive: true });
      const repo = new Repo(openDb({ path: join(home, "hipokamp.db") }));
      for (const p of ["Stary", "Repo"])
        repo.insertObservation({
          session_id: null,
          project: p,
          type: "change",
          title: `notatka ${p}`,
          created_at: Date.now() - DAY,
          source: "backfill",
        });
      setMeta(repo.db, "sync_hub", "hub-test");
      repo.db.close();
      const run = async (...args: string[]) => {
        const p = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
          cwd: join(import.meta.dir, ".."),
          env: { ...(process.env as Record<string, string>), HIPOKAMP_HOME: home, CLAUDE_MEM_DB: join(home, "brak.db") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        return { code: await p.exited, out: `${out}\n${await new Response(p.stderr).text()}` };
      };
      const kopie = () => (existsSync(join(home, "backups", "db")) ? readdirSync(join(home, "backups", "db")) : []);
      const projects = () => {
        const d = new Database(join(home, "hipokamp.db"), { readonly: true });
        try {
          return (d.query("SELECT DISTINCT project FROM observations ORDER BY project").all() as { project: string }[]).map(
            (r) => r.project,
          );
        } finally {
          d.close();
        }
      };
      for (const args of [["repair"], ["project", "merge", "Stary", "Repo"]]) {
        const r = await run(...args);
        expect([args.join(" "), r.code]).toEqual([args.join(" "), 1]);
        expect(r.out).toContain("najpierw repair");
        expect(r.out).toContain("--force-sync-warning");
        expect(kopie()).toEqual([]);
      }
      expect(projects()).toEqual(["Repo", "Stary"]);
      for (const args of [
        ["repair", "--dry-run"],
        ["project", "merge", "Stary", "Repo", "--dry-run"],
      ]) {
        const r = await run(...args);
        expect([args.join(" "), r.code]).toEqual([args.join(" "), 0]);
        expect(r.out).toContain("UWAGA: baza jest połączona z hubem synchronizacji (hub-test)");
      }
      expect(kopie()).toEqual([]);
      // świadoma decyzja: zapis z flagą (z kopią przed zmianą)
      const m = await run("project", "merge", "Stary", "Repo", "--force-sync-warning");
      expect(m.code).toBe(0);
      expect(projects()).toEqual(["Repo"]);
      const r = await run("repair", "--force-sync-warning");
      expect(r.code).toBe(0);
      expect(kopie().filter((f) => f.includes("pre-project-merge")).length).toBe(1);
      expect(kopie().filter((f) => f.includes("pre-repair")).length).toBe(1);
    }, 60_000);
  });

  describe("repair przy działającym workerze", () => {
    test("bez --dry-run odmowa (kod 1, bez kopii i zmian); próba działa", async () => {
      const home = file("cli-home");
      mkdirSync(home, { recursive: true });
      openDb({ path: join(home, "hipokamp.db") }).close();
      // udawany worker: tylko /api/health
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname === "/api/health"
            ? Response.json({ app: "hipokamp", ok: true, pid: 1, version: "test", uptimeS: 1, embedder: {} })
            : new Response("brak", { status: 404 }),
      });
      const run = async (...args: string[]) => {
        const p = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...(process.env as Record<string, string>),
            HIPOKAMP_HOME: home,
            HIPOKAMP_PORT: String(server.port),
            CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        return { code: await p.exited, out };
      };
      try {
        // proces bez klucza i bez worker.lock.json (T-17): odmowa z komunikatem, że hipokamp stop go nie zatrzyma
        const obcy = await run("repair");
        expect(obcy.out).toContain("hipokamp stop go nie zatrzyma");
        expect(obcy.code).toBe(1);
        // worker z blokady tego katalogu danych (np. zajęty albo starszy): zwykła prośba o zatrzymanie
        writeFileSync(join(home, "worker.lock.json"), JSON.stringify({ pid: 1, port: server.port, startedAt: Date.now() }));
        const r = await run("repair");
        expect(r.out).toContain("Worker działa");
        expect(r.code).toBe(1);
        const kopie = join(home, "backups", "db");
        expect(existsSync(kopie) ? readdirSync(kopie) : []).toEqual([]);
        const dry = await run("repair", "--dry-run");
        expect(dry.code).toBe(0);
        expect(dry.out).toContain("próba");
      } finally {
        server.stop(true);
      }
    }, 60_000);
  });

  describe("scalenie a ślady użycia", () => {
    test("mergeDuplicateInto przenosi wstrzyknięcia i inject_count (bez kolizji klucza wstrzyknięć)", () => {
      const repo = freshRepo();
      const now = Date.now();
      const dup = native(repo, { title: "Duplikat tury", at: now });
      const into = native(repo, { title: "Notatka claude-mem tej tury", at: now });
      repo.recordInjections(
        "s1",
        [dup, into],
        "start",
        new Map([
          [dup, 30],
          [into, 40],
        ]),
      );
      repo.recordInjections("s2", [dup], "prompt", new Map([[dup, 50]]));
      repo.logAccess([dup], "fetched", "s2", now);
      repo.mergeDuplicateInto(dup, into, { repair: "cm-dup" });
      const t = repo.getObservation(into)!;
      expect(t.inject_count).toBe(3);
      expect(t.access_count).toBe(1);
      expect(repo.db.query("SELECT session_id, obs_id, channel, tokens FROM injections ORDER BY session_id").all()).toEqual([
        { session_id: "s1", obs_id: into, channel: "start", tokens: 40 },
        { session_id: "s2", obs_id: into, channel: "prompt", tokens: 50 },
      ]);
      // sesja, która widziała duplikat, nie dostanie celu drugi raz
      expect(repo.injectedIds("s2").has(into)).toBe(true);
    });

    test("sen: scalenie przenosi wstrzyknięcia na notatkę docelową", async () => {
      const repo = freshRepo(true);
      const now = Date.now();
      const title = "Naprawiono wyciek uchwytów w pętli wektorów";
      const x = vecNote(repo, { title, type: "bugfix", at: now - 2 * DAY, q8: q8Fill(4), bits: bitsWith(1, 2, 3) });
      const y = vecNote(repo, { title, type: "bugfix", at: now - DAY, q8: q8Fill(4), bits: bitsWith(1, 2, 3) });
      repo.recordInjections("s1", [x], "start", new Map([[x, 25]]));
      expect(await mergeDuplicates(repo, now - 10 * DAY)).toBe(1);
      expect(repo.getObservation(x)?.merged_into).toBe(y);
      expect(repo.getObservation(y)?.inject_count).toBe(1);
      expect(repo.db.query("SELECT obs_id, tokens FROM injections").all()).toEqual([{ obs_id: y, tokens: 25 }]);
    });
  });

  /** Licznik obrotów pętli zdarzeń w trakcie pracy: praca pocięta oddaje sterowanie, jednolita nie. */
  function loopTicks(): { stop: () => { ticks: number; maxGapMs: number } } {
    let ticks = 0;
    let maxGapMs = 0;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      ticks++;
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 2);
    return {
      stop: () => {
        clearInterval(t);
        return { ticks, maxGapMs: Math.round(maxGapMs) };
      },
    };
  }
  /** Losowy wektor (q8 i bity znaku) z ziarna: notatki bez duplikatów, sen ma czego szukać, ale nic nie scala. */
  function randomVec(seed: number): { q8: Int8Array; bits: Uint8Array } {
    // mulberry32: kolejne ziarna dają niezależne ciągi (proste LCG z ziaren 1, 2, 3 dawało wektory niemal równe)
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // wektor jednostkowy skwantowany jak toQ8 (cosQ8 zakłada normę 1): losowe pary mają cosinus bliski 0
    const v = Array.from({ length: DIMS }, () => next() - 0.5);
    const norm = Math.hypot(...v);
    const q8 = new Int8Array(DIMS);
    const bits = new Uint8Array(DIMS / 8);
    for (let i = 0; i < DIMS; i++) {
      q8[i] = Math.round((v[i] / norm) * 127) || 1;
      if (q8[i] > 0) bits[i >> 3] |= 1 << (i & 7);
    }
    return { q8, bits };
  }

  describe("diagnostyka przestojów pętli", () => {
    test("próbka powyżej 1 s: linia JSON z trasami i zadaniami okna, winowajca w zdrowiu, bez treści zapytań", async () => {
      const lag = await import("../src/worker/lag.ts");
      const logDir = join(DATA_DIR, "logs");
      mkdirSync(logDir, { recursive: true });
      const stallLines = () =>
        readdirSync(logDir)
          .filter((f) => f.startsWith("stall-"))
          .flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean))
          .map((l) => JSON.parse(l));
      expect(lag.routeName("GET", "/api/observation/10000123")).toBe("GET /api/observation/:id");
      expect(lag.routeName("GET", "/api/session/abc-1")).toBe("GET /api/session/:id");
      expect(lag.routeName("GET", "/assets/x.css")).toBe("GET (podgląd)");
      const r = lag.begin("trasa", lag.routeName("POST", "/api/context/prompt"));
      lag.end(r);
      expect(
        lag.track("kopia (VACUUM INTO)", () => {
          const until = performance.now() + 20;
          while (performance.now() < until) {}
          return 7;
        }),
      ).toBe(7);
      expect(await lag.track("wektory: liczenie", async () => 3)).toBe(3);
      // praca w osobnym wątku trwa przez cały przestój, ale nie blokuje pętli: nie może być winowajcą
      const thread = lag.begin("zadanie", "wektory w wątku", true);
      const sen = lag.begin("zadanie", "sen");
      // przestój 1,5 s, który zaczął się po starcie snu: sen ma największą część wspólną
      lag.sample(1500, performance.now() + 1600);
      const lines = stallLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].lagMs).toBe(1500);
      expect(lines[0].culprit).toBe("sen");
      expect(lines[0].routes.map((x: any) => x.name)).toEqual(["POST /api/context/prompt"]);
      expect(lines[0].tasks.map((x: any) => x.name).sort()).toEqual([
        "kopia (VACUUM INTO)",
        "sen",
        "wektory w wątku",
        "wektory: liczenie",
      ]);
      expect(lines[0].tasks.find((x: any) => x.name === "sen").running).toBe(true);
      expect(lines[0].tasks.find((x: any) => x.name === "wektory w wątku").thread).toBe(true);
      lag.end(sen);
      lag.end(thread);
      let h = lag.lagHealth();
      expect(h.eventLoopStalls).toBe(1);
      expect(h.eventLoopLagMaxMs).toBe(1500);
      expect(h.lagCulprit).toMatchObject({ name: "sen", kind: "zadanie", lagMs: 1500 });
      expect(h.backgroundTasks["kopia (VACUUM INTO)"]).toMatchObject({ runs: 1 });
      expect(h.backgroundTasks["kopia (VACUUM INTO)"].lastMs).toBeGreaterThanOrEqual(19);
      expect(h.backgroundTasks.sen.runs).toBe(1);
      // przestój 0,3 s bez śledzonej pracy w oknie: winowajca „nieśledzone”, bez linii w logu (próg 1 s)
      lag.sample(300, performance.now() + 60_000);
      h = lag.lagHealth();
      expect(h.lagCulprit?.name).toContain("nieśledzone");
      expect(h.lagCulprit?.lagMs).toBe(300);
      expect(stallLines()).toHaveLength(1);
      // krótka próbka nie zmienia winowajcy
      lag.sample(20);
      expect(lag.lagHealth().lagCulprit?.lagMs).toBe(300);
    });

    test("zadanie pocięte: winę dostaje kawałek synchroniczny, a nie całe trwanie zadania", async () => {
      const lag = await import("../src/worker/lag.ts");
      const { breathe } = await import("../src/util/slice.ts");
      const busy = (ms: number) => {
        const until = performance.now() + ms;
        while (performance.now() < until) {}
      };
      // prawdziwe zadanie z przerwą: kawałki 30 i 10 ms, najdłuższy w statystykach
      await lag.track(
        "przebudowa FTS",
        async () => {
          busy(30);
          await breathe();
          busy(10);
        },
        { sliced: true },
      );
      const st = lag.lagHealth().backgroundTasks["przebudowa FTS"];
      expect(st.sliceMs).toBeGreaterThanOrEqual(29);
      expect(st.sliceMs).toBeLessThan(st.lastMs);

      // nadrabianie trwa przez cały przestój, ale jego kawałki są krótkie: winna jest trasa, która trwała w przestoju
      const nad = lag.begin("zadanie", "nadrabianie", false, true);
      const t = performance.now();
      lag.slice("nadrabianie", t - 3000, t - 2960);
      const route = lag.begin("trasa", "GET /api/search");
      lag.sample(1200, t + 1300);
      expect(lag.lagHealth().lagCulprit).toMatchObject({ name: "GET /api/search", kind: "trasa" });
      // kawałek nadrabiania na cały przestój: on jest winny (na pewno synchroniczny), mimo trwającej trasy
      lag.slice("nadrabianie", t + 100, t + 1300);
      lag.sample(1200, t + 1300);
      expect(lag.lagHealth().lagCulprit).toMatchObject({ name: "nadrabianie", kind: "zadanie" });
      const logDir = join(DATA_DIR, "logs");
      const last = readdirSync(logDir)
        .filter((f) => f.startsWith("stall-"))
        .flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean))
        .map((l) => JSON.parse(l))
        .pop();
      expect(last.culprit).toBe("nadrabianie");
      expect(last.tasks.find((x: any) => x.name === "nadrabianie")).toMatchObject({ sliced: true, sliceMs: 1200 });
      lag.end(route);
      lag.end(nad);
    });

    test("czekanie poza kawałkiem (waitOutside: sieć synchronizacji): oczekiwanie nie liczy się jako kawałek zadania", async () => {
      const lag = await import("../src/worker/lag.ts");
      const { waitOutside } = await import("../src/util/slice.ts");
      const busy = (ms: number) => {
        const until = performance.now() + ms;
        while (performance.now() < until) {}
      };
      await lag.track(
        "sync (test)",
        async () => {
          busy(10);
          await waitOutside(Bun.sleep(120));
          busy(10);
        },
        { sliced: true },
      );
      const st = lag.lagHealth().backgroundTasks["sync (test)"];
      expect(st.lastMs).toBeGreaterThanOrEqual(130);
      expect(st.sliceMs).toBeLessThan(60);
      expect(await waitOutside(Promise.resolve(7))).toBe(7); // poza zadaniem pociętym zwykłe await
    });

    test("logi przestojów (stall-*.jsonl) mają tę samą retencję co dzienne logi, inne dzienniki zostają", async () => {
      const { pruneLogs } = await import("../src/log.ts");
      const logDir = join(DATA_DIR, "logs");
      mkdirSync(logDir, { recursive: true });
      // dzienniki decyzji przypomnień i snu sprzed 30 dni: własna, dłuższa retencja (60 dni), nie te 14
      const d30 = new Date(Date.now() - 30 * 86_400_000);
      const day30 = `${d30.getFullYear()}-${String(d30.getMonth() + 1).padStart(2, "0")}-${String(d30.getDate()).padStart(2, "0")}`;
      const files = [
        "stall-2020-01-01.jsonl",
        "worker-2020-01-01.log",
        "stall-2999-01-01.jsonl",
        "inny-2020-01-01.txt",
        `recall-${day30}.jsonl`,
        `sleep-${day30}.jsonl`,
      ];
      for (const f of files) writeFileSync(join(logDir, f), "{}\n");
      pruneLogs(14);
      const left = readdirSync(logDir);
      expect(left).not.toContain("stall-2020-01-01.jsonl");
      expect(left).not.toContain("worker-2020-01-01.log");
      for (const f of ["stall-2999-01-01.jsonl", "inny-2020-01-01.txt", `recall-${day30}.jsonl`, `sleep-${day30}.jsonl`])
        expect(left).toContain(f);
    });
  });

  describe("praca w tle pocięta na kawałki", () => {
    /** Transkrypt ok. `mb` MB: tury z promptem, trzema wywołaniami Bash z długim wynikiem i odpowiedzią. */
    function bigTranscript(path: string, sid: string, mb: number, at: number): void {
      const lines: string[] = [];
      let t = at;
      const ts = () => new Date((t += 1000)).toISOString();
      const filler = (n: number, k: number) => `wynik ${k} `.repeat(Math.ceil(n / 9)).slice(0, n);
      for (let turn = 0; lines.join("\n").length < mb * 1024 * 1024; turn++) {
        lines.push(
          JSON.stringify({
            type: "user",
            uuid: `${sid}-u${turn}`,
            sessionId: sid,
            cwd: join(DATA_DIR, "duzy-projekt"),
            timestamp: ts(),
            message: { role: "user", content: `zadanie numer ${turn}: sprawdź port workera i pętlę zdarzeń` },
          }),
        );
        for (let k = 0; k < 3; k++) {
          const id = `toolu_${sid.slice(-4)}_${turn}_${k}`;
          lines.push(
            JSON.stringify({
              type: "assistant",
              uuid: `${sid}-a${turn}-${k}`,
              sessionId: sid,
              timestamp: ts(),
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id, name: "Bash", input: { command: `grep -rn wzorzec${turn}` } }],
              },
            }),
            JSON.stringify({
              type: "user",
              uuid: `${sid}-r${turn}-${k}`,
              sessionId: sid,
              timestamp: ts(),
              message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: filler(6000, turn) }] },
            }),
          );
        }
        lines.push(
          JSON.stringify({
            type: "assistant",
            uuid: `${sid}-e${turn}`,
            sessionId: sid,
            timestamp: ts(),
            message: {
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text: `Tura ${turn}: port trzymał osierocony proces, naprawione i sprawdzone testem.` }],
            },
          }),
        );
      }
      writeFileSync(path, `${lines.join("\n")}\n`);
    }

    test("nadrabianie: okna po 1 MB z oddechem, ten sam wynik co jeden przebieg", async () => {
      const { catchUp, catchUpSliced } = await import("../src/worker/catchup.ts");
      const { utimesSync } = await import("node:fs");
      const dir = join(claudeDir(), "projects", "D--duzy-projekt");
      mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 10 * 60_000);
      try {
        for (let i = 0; i < 3; i++) {
          const sid = `11111111-2222-4333-8444-00000000000${i}`;
          const p = join(dir, `${sid}.jsonl`);
          bigTranscript(p, sid, 1.6, Date.now() - 3_600_000);
          utimesSync(p, old, old);
        }
        const sliced = freshRepo();
        const probe = loopTicks();
        const a = await catchUpSliced(sliced);
        const { ticks } = probe.stop();
        // 3 pliki po 1,6 MB: co najmniej dwa okna na plik, oddech po każdym oknie i po każdym pliku
        expect(ticks).toBeGreaterThanOrEqual(6);
        expect(a.files).toBeGreaterThanOrEqual(3);
        for (let i = 0; i < 3; i++) expect(sliced.getSession(`11111111-2222-4333-8444-00000000000${i}`)).toBeTruthy();
        expect(a.inserted).toBeGreaterThan(30);
        const whole = freshRepo();
        const b = catchUp(whole);
        expect(b).toEqual(a);
        const titles = (r: RepoT) =>
          (r.db.query("SELECT title FROM observations ORDER BY created_at, title").all() as { title: string }[]).map(
            (x) => x.title,
          );
        expect(titles(sliced)).toEqual(titles(whole));
        // drugi przebieg niczego nie dokłada (offsety w bazie)
        expect((await catchUpSliced(sliced)).inserted).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test("sen i przebudowa FTS oddają sterowanie co ok. 40 ms i dają ten sam wynik", async () => {
      const { sleep } = await import("../src/consolidate/sleep.ts");
      const repo = freshRepo(true);
      const now = Date.now();
      repo.db.run("BEGIN");
      for (let i = 0; i < 1500; i++) {
        const { q8, bits } = randomVec(i + 1);
        vecNote(repo, { title: `Notatka numer ${i} o pętli workera`, type: "discovery", at: now - (i % 90) * DAY, q8, bits });
      }
      repo.db.run("COMMIT");
      let probe = loopTicks();
      const rep = await sleep(repo, { full: true });
      let r = probe.stop();
      expect(rep.merged).toBe(0);
      expect(r.ticks).toBeGreaterThanOrEqual(3);
      repo.db.run("DELETE FROM meta WHERE k = 'fts_version'");
      expect(repo.ftsOutdated()).toBe(true);
      probe = loopTicks();
      // krótkie notatki indeksują się szybko: budżet 2 ms zamiast domyślnych 40, żeby było co ciąć
      const during: unknown[] = [];
      const done = await repo.reindexFts({
        sliceMs: 2,
        batch: 500,
        onProgress: () => during.push(repo.db.query("SELECT v FROM observations_fts_config WHERE k = 'automerge'").get()),
      });
      r = probe.stop();
      expect(done.observations).toBe(1500);
      expect(r.ticks).toBeGreaterThanOrEqual(5);
      expect(repo.ftsOutdated()).toBe(false);
      // scalanie automatyczne FTS5 (sekundy przy zatwierdzeniu na dużym indeksie) wyłączone na czas przebudowy...
      expect(during.length).toBe(3);
      for (const v of during) expect(v).toEqual({ v: 0 });
      // ...i przywrócone na końcu
      for (const t of ["observations_fts", "prompts_fts", "summaries_fts"])
        expect(repo.db.query(`SELECT k, v FROM ${t}_config WHERE k IN ('automerge', 'crisismerge') ORDER BY k`).all()).toEqual([
          { k: "automerge", v: 4 },
          { k: "crisismerge", v: 16 },
        ]);
      expect(ftsSearch(repo.db, "notatka numer 1234", { limit: 3 }).length).toBeGreaterThan(0);

      // błąd w środku przebudowy (np. SQLITE_BUSY): scalanie wraca do domyślnych, wersja zostaje stara
      repo.db.run("DELETE FROM meta WHERE k = 'fts_version'");
      await expect(
        repo.reindexFts({
          batch: 500,
          onProgress: () => {
            throw new Error("database is locked");
          },
        }),
      ).rejects.toThrow("database is locked");
      expect(repo.ftsOutdated()).toBe(true);
      for (const t of ["observations_fts", "prompts_fts", "summaries_fts"])
        expect(repo.db.query(`SELECT k, v FROM ${t}_config WHERE k IN ('automerge', 'crisismerge') ORDER BY k`).all()).toEqual([
          { k: "automerge", v: 4 },
          { k: "crisismerge", v: 16 },
        ]);
    }, 60_000);

    test("kopia w osobnym wątku: spójny plik, retencja jak w backupDb", async () => {
      const { backupDbInThread } = await import("../src/core/backup.ts");
      const dir = file("kopie-watek");
      const dbPath = file("zrodlo.db");
      const repo = new Repo(openDb({ path: dbPath }));
      for (let i = 0; i < 50; i++) native(repo, { title: `Notatka do kopii ${i}`, at: Date.now() - i * 1000 });
      const a = await backupDbInThread({ dir, keep: 2, dbPath });
      expect(a.bytes).toBeGreaterThan(0);
      const copy = new Database(a.file, { readonly: true });
      expect((copy.query("SELECT COUNT(*) c FROM observations").get() as { c: number }).c).toBe(50);
      copy.close();
      await backupDbInThread({ dir, keep: 2, dbPath });
      const c = await backupDbInThread({ dir, keep: 2, dbPath });
      expect(c.removed).toHaveLength(1);
      expect(readdirSync(dir).filter((f) => f.endsWith(".db"))).toHaveLength(2);
      await expect(backupDbInThread({ dir, dbPath: file("nie-ma.db") })).rejects.toThrow();
      // wątek kończy się bez odpowiedzi: obietnica odrzucona (bez tego blokada przebiegu okresowego wisiałaby na zawsze)
      const silent = file("watek-bez-odpowiedzi.ts");
      writeFileSync(silent, "process.exit(0);\n");
      const t0 = performance.now();
      await expect(backupDbInThread({ dir, dbPath }, Bun.pathToFileURL(silent).href)).rejects.toThrow("bez wyniku");
      expect(performance.now() - t0).toBeLessThan(5000);
    });
  });

  describe("wątki embeddingów: kształty DirectML, zapytania obok zaległości, limity", () => {
    test("masowo na GPU tylko kształty (bulkBatch, 128/256/512), także dla zimnego startu i reszty zlecenia", async () => {
      const { loadConfig } = await import("../src/config.ts");
      const { Embedder } = await import("../src/index/embedder.ts");
      const { chunkSize } = await import("../src/index/embed-chunks.ts");
      const run = async (device: string, chunks: string[][]) => {
        const shapes: string[] = [];
        const e = new Embedder({ ...loadConfig().embed, bulkDevice: device, bulkBatch: 64, pooling: "cls" }, "bulk");
        // atrapa tokenizera i modelu: długość w tokenach = liczba słów, model zapisuje kształt wejścia
        const tok = (t: string | string[], o: { max_length: number; padding?: string }) =>
          Array.isArray(t)
            ? { input_ids: { dims: [t.length, o.max_length] } }
            : { input_ids: { dims: [1, Math.min(o.max_length, t.split(" ").length)] } };
        const model = async (inp: { input_ids: { dims: number[] } }) => {
          const [b, l] = inp.input_ids.dims;
          shapes.push(`${b}x${l}`);
          const dims = [b, l, 8];
          return { last_hidden_state: { to: () => ({ dims, data: new Float32Array(b * l * 8).fill(1) }) } };
        };
        (e as unknown as { raw: unknown }).raw = { tok, model };
        for (const c of chunks) expect((await e.embed(c, "passage")).length).toBe(c.length);
        return shapes;
      };
      // kawałki tak, jak tnie je wątek: zlecenie 130 tekstów różnej długości, od najkrótszych
      const texts = Array.from({ length: 130 }, (_, i) => "słowo ".repeat(20 + i * 3).trim());
      const job = { texts, kind: "passage" as const, mode: "bulk" as const, order: texts.map((_, i) => i), next: 0 };
      const chunks: string[][] = [];
      while (job.next < texts.length) {
        const n = chunkSize(job, "dml", 64);
        expect(n === 64 || job.next + n === texts.length).toBe(true);
        chunks.push(job.order.slice(job.next, job.next + n).map((i) => texts[i]));
        job.next += n;
      }
      expect(chunks.map((c) => c.length)).toEqual([64, 64, 2]);
      const dml = await run("dml", [[texts[0]], texts.slice(0, 63), ...chunks]);
      expect(new Set(dml.map((s) => s.split("x")[0]))).toEqual(new Set(["64"]));
      for (const s of dml) expect([128, 256, 512]).toContain(Number(s.split("x")[1]));
      // CPU: kształt bez znaczenia, liczy się czas, więc bez dopełniania do 64
      expect(await run("cpu", [[texts[0]]])).toEqual(["1x128"]);
      // na CPU kawałek po budżecie znaków (ok. jedna długa notatka)
      expect(chunkSize({ ...job, next: 0 }, "cpu", 64)).toBeLessThan(64);
    });

    test("zapytanie nie czeka na kawałek masowy, limit czasu, porzucenie zawieszonego wątku", async () => {
      const { loadConfig } = await import("../src/config.ts");
      const { ThreadEmbedder, EmbedTimeoutError } = await import("../src/index/embed-client.ts");
      // model zastępczy w wątkach: 40 ms na tekst, blokuje wątek synchronicznie jak ONNX
      process.env.HIPOKAMP_FAKE_EMBED_MS = "40";
      const cfg = loadConfig().embed;
      const emb = new ThreadEmbedder(cfg);
      let bulk: Promise<Float32Array[]> | null = null;
      try {
        // oba wątki rozgrzane przed pomiarem (zimny start wątku to nie to, co mierzymy)
        await emb.embed(["rozgrzewka"], "query");
        await emb.embed(["rozgrzewka"], "passage", { mode: "bulk" });
        // zaległość: kawałek 64 tekstów (2,6 s) w wątku masowym; zapytanie idzie swoim wątkiem
        bulk = emb.embed(
          Array.from({ length: 128 }, (_, i) => `zaległa notatka ${i}`),
          "passage",
          { mode: "bulk" },
        );
        await Bun.sleep(150);
        let t = performance.now();
        const [qv] = await emb.embed(["czy worker liczy wektory w wątku"], "query");
        expect(qv.length).toBe(cfg.dims);
        expect(performance.now() - t).toBeLessThan(800);
        expect(emb.device).toBe("fake");
        // limit czasu: wołający dostaje błąd od razu, a spóźniony wynik trafia do pamięci podręcznej zapytań
        const q2 = "drugie zapytanie z limitem";
        await expect(emb.embed([q2], "query", { timeoutMs: 1 })).rejects.toBeInstanceOf(EmbedTimeoutError);
        await Bun.sleep(300);
        t = performance.now();
        await emb.embed([q2], "query", { timeoutMs: 50 });
        expect(performance.now() - t).toBeLessThan(50);
        expect((await bulk).length).toBe(128);
      } finally {
        // odrzucenie po dispose() nie może wypaść jako nieobsłużone w następnym teście
        bulk?.catch(() => {});
        emb.dispose();
      }
      // wątek, który stoi w liczeniu dłużej niż próg swojej roli: zlecenie dostaje błąd, następne idzie nowym wątkiem;
      // po trzech porzuceniach w godzinie rola jest wyłączona (szybki błąd zamiast kolejnych wątków z modelem)
      const hung = new ThreadEmbedder(cfg, { hangMs: 300, bulkHangMs: 300 });
      // krótkie teksty to jeden kawałek (budżet znaków): n × 40 ms synchronicznie w wątku
      const block = (n: number, mode: "query" | "bulk" = "query") =>
        hung.embed(
          Array.from({ length: n }, (_, i) => `n${i}`),
          "passage",
          { mode },
        );
      try {
        const t = performance.now();
        await expect(block(100)).rejects.toThrow("nie odpowiada");
        expect(performance.now() - t).toBeLessThan(2500);
        const [v] = await hung.embed(["po porzuceniu"], "query");
        expect(v.length).toBe(cfg.dims);
        // wątek masowy ma własny próg i licznik porzuceń
        await expect(block(64, "bulk")).rejects.toThrow("nie odpowiada");
        expect(hung.bulkDisabled).toBe(false);
        expect(hung.disabled.zapytania).toBeUndefined();
        await expect(block(20)).rejects.toThrow("nie odpowiada");
        await expect(block(20)).rejects.toThrow("nie odpowiada");
        expect(hung.disabled.zapytania).toContain("wyłączony do restartu workera");
        const t2 = performance.now();
        await expect(hung.embed(["po wyłączeniu"], "query")).rejects.toThrow("wektory wyłączone");
        expect(performance.now() - t2).toBeLessThan(50);
        expect(hung.bulkDisabled).toBe(false);
      } finally {
        hung.dispose();
        delete process.env.HIPOKAMP_FAKE_EMBED_MS;
      }
    }, 30_000);
  });

  describe("sen: osierocone wektory binarne (T-08)", () => {
    test("usuwa bity notatek usuniętych i scalonych, archiwum i zastąpione zostają, drugi przebieg 0, licznik w status", async () => {
      const { sleep, pruneOrphanVectors } = await import("../src/consolidate/sleep.ts");
      const { vectorSearch } = await import("../src/index/vectors.ts");
      const home = file("t08-home");
      mkdirSync(home, { recursive: true });
      const repo = new Repo(openDb({ path: join(home, "hipokamp.db"), vectors: true }));
      const now = Date.now();
      const vecs = new Map<number, { q8: Int8Array; bits: Uint8Array }>();
      const mk = (i: number, title: string) => {
        const v = randomVec(100 + i);
        const id = vecNote(repo, { title, type: "decision", at: now - (i + 1) * DAY, ...v });
        vecs.set(id, v);
        return id;
      };
      const active = [0, 1, 2].map((i) => mk(i, `Aktywna decyzja ${i}`));
      const merged = mk(3, "Scalona notatka");
      const archived = mk(4, "Zarchiwizowana notatka");
      const superseded = mk(5, "Zastąpiona notatka");
      const deleted = mk(6, "Usunięta notatka");
      const merged2 = mk(7, "Druga scalona notatka");
      repo.setStatus(merged, "merged", { mergedInto: active[0] });
      repo.setStatus(merged2, "merged", { mergedInto: active[0] });
      repo.setStatus(archived, "archived");
      repo.setStatus(superseded, "superseded", { supersededBy: active[1] });
      // usunięcie wiersza bez sprzątania wektora (np. przez połączenie bez sqlite-vec): bit zostaje sierotą
      repo.db.run("DELETE FROM observations WHERE id = ?", [deleted]);
      const bitsOf = (id: number) => !!repo.db.query("SELECT 1 FROM obs_vec_bits WHERE obs_id = ?").get(id);
      const queued = () => repo.missingVectors(100).map((r) => r.id);
      expect(repo.countOrphanVectorBits()).toBe(3);
      // partia mniejsza niż tabela: kolejne kawałki od ostatniego id
      expect(repo.orphanVectorBits(0, 3).last).not.toBeNull();

      const statusLine = async () => {
        const p = Bun.spawn([process.execPath, "src/cli.ts", "status"], {
          cwd: join(import.meta.dir, ".."),
          env: { ...(process.env as Record<string, string>), HIPOKAMP_HOME: home, HIPOKAMP_PORT: "47989" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
        return out;
      };
      const before = await statusLine();
      expect(before).toContain("osierocone 3");
      expect(before).toContain("sen:      jeszcze nie było");

      const rep = await sleep(repo, { full: true });
      expect(rep.orphanVectors).toBe(3);
      expect(rep.requeuedVectors).toBe(0);
      for (const id of [merged, merged2, deleted]) expect(bitsOf(id)).toBe(false);
      // archiwum i zastąpione zachowują bity: wyszukiwanie z archiwum bierze kandydatów z wektorów
      for (const id of [...active, archived, superseded]) {
        expect(bitsOf(id)).toBe(true);
        expect(repo.getVectorsQ8([id]).has(id)).toBe(true);
      }
      expect(repo.countOrphanVectorBits()).toBe(0);
      expect(await pruneOrphanVectors(repo)).toBe(0);
      const second = await sleep(repo);
      expect(second.orphanVectors).toBe(0);
      expect(second.requeuedVectors).toBe(0);
      expect(JSON.parse(getMeta(repo.db, "last_sleep_report") ?? "{}").orphanVectors).toBe(0);
      const after = await statusLine();
      expect(after).toContain("osierocone 0");
      expect(after).toContain("usunięte osierocone wektory 0, do przeliczenia 0");

      // archiwum wraca do aktywnych surowym UPDATE (jak w innym kodzie): bity są, nic do przeliczenia
      repo.db.run("UPDATE observations SET status = 'active' WHERE id = ?", [archived]);
      const q = new Float32Array(vecs.get(archived)!.q8);
      expect(vectorSearch(repo, q, 3, { project: "demo" })[0]?.id).toBe(archived);

      // rozbicie scalenia przez setStatus: bitów nie ma, więc wektor wraca do kolejki i po przeliczeniu jest w wyszukiwaniu
      repo.setStatus(merged, "active");
      expect(repo.getVectorsQ8([merged]).has(merged)).toBe(false);
      expect(queued()).toContain(merged);
      repo.putVector(merged, "demo", "test", vecs.get(merged)!.q8, vecs.get(merged)!.bits, true);
      expect(bitsOf(merged)).toBe(true);
      expect(vectorSearch(repo, new Float32Array(vecs.get(merged)!.q8), 3, { project: "demo" })[0]?.id).toBe(merged);

      // rozbicie scalenia surowym UPDATE (bez setStatus): naprawia to następny sen
      repo.db.run("UPDATE observations SET status = 'active' WHERE id = ?", [merged2]);
      expect(repo.getVectorsQ8([merged2]).has(merged2)).toBe(true);
      expect(queued()).not.toContain(merged2);
      const healed = await sleep(repo);
      expect(healed.requeuedVectors).toBe(1);
      expect(healed.orphanVectors).toBe(0);
      expect(queued()).toContain(merged2);
      repo.putVector(merged2, "demo", "test", vecs.get(merged2)!.q8, vecs.get(merged2)!.bits, true);
      expect((await sleep(repo)).requeuedVectors).toBe(0);
      // notatka z bitami nie wraca do kolejki
      expect(repo.requeueVectors([...active, merged2])).toBe(0);

      // notatka przywrócona między wyszukaniem a usunięciem nie traci bitów
      repo.setStatus(merged2, "merged", { mergedInto: active[0] });
      const { ids } = repo.orphanVectorBits(0, 100);
      expect(ids).toEqual([merged2]);
      repo.db.run("UPDATE observations SET status = 'active' WHERE id = ?", [merged2]);
      expect(repo.deleteOrphanVectorBits(ids)).toBe(0);
      expect(bitsOf(merged2)).toBe(true);

      // przywrócenie z podglądu i MCP (restoreObservations): zastąpiona bez bitów wraca do kolejki jak przy setStatus,
      // scalona zostaje scalona
      repo.db.run("DELETE FROM obs_vec_bits WHERE obs_id = ?", [superseded]);
      repo.setStatus(merged2, "merged", { mergedInto: active[0] });
      expect(repo.restoreObservations([superseded, merged2])).toEqual([superseded]);
      const back = repo.getObservation(superseded)!;
      expect([back.status, back.superseded_by, back.valid_until]).toEqual(["active", null, null]);
      expect(queued()).toContain(superseded);
      expect(repo.getObservation(merged2)!.status).toBe("merged");
    }, 60_000);
  });
}
