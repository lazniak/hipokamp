// T-42: `hipokamp repair` dla sesji innego harnessu (klucz z przedrostkiem: desktop:, gemini:, cursor:, opencode:).
// Odzysk tur (krok d) czytał tury z sessionId z linii, a Cowork pisze w liniach goły uuid: odzyskana notatka trafiała
// do sesji, której nie ma w bazie. Osobny proces z katalogiem „hipokamp-test” jak w projects.test.ts.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_REPAIR_HARNESS_CHILD";

if (!process.env[CHILD]) {
  test("repair: sesje innych harnessów (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/repair-harness.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47985",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      if (r.exitCode !== 0) throw new Error(`testy naprawy sesji harnessów nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
} else {
  const { DATA_DIR } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test")) throw new Error("repair-harness: HIPOKAMP_HOME musi wskazywać katalog testowy");
  const { writeFileSync, statSync } = await import("node:fs");
  const { openDb } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const { repair } = await import("../src/core/repair.ts");
  const J = await import("./fixtures/capture/jsonl.ts");

  test("Cowork (desktop:): odzyskane notatki i prompty pod kluczem sesji, nie gołym uuid z linii", () => {
    const repo = new Repo(openDb({ path: join(DATA_DIR, "h.db"), vectors: false }));
    const uuid = "bbbbbbbb-2222-4222-8222-000000000001";
    const sid = `desktop:${uuid}`;
    const cwd = join(DATA_DIR, "demo");
    mkdirSync(cwd, { recursive: true });
    const c = { sessionId: uuid, cwd };
    const T0 = Date.parse("2026-10-05T08:00:00Z");
    const tpath = join(DATA_DIR, "cowork", `${uuid}.jsonl`);
    mkdirSync(join(DATA_DIR, "cowork"), { recursive: true });
    writeFileSync(
      tpath,
      J.jsonl([
        ...J.fullTurn(c, T0, 1, "napraw konfigurację serwera kopii", "Konfiguracja serwera kopii naprawiona, test przechodzi."),
        ...J.fullTurn(c, T0 + 60_000, 2, "dodaj raport tygodniowy kopii", "Raport tygodniowy kopii dodany do harmonogramu."),
      ]),
    );
    // sesja przeczytana do końca, ale bez notatek i promptów (np. zapis przerwany): krok d ma je odzyskać
    repo.upsertSession({ id: sid, project: "demo", started_at: T0, transcript_path: tpath, source: "backfill" } as any);
    repo.setTranscriptProgress(sid, statSync(tpath).size, 2, T0 + 64_000);
    const cm = join(DATA_DIR, "brak-claude-mem.db");
    const r = repair(repo, { cmDbPath: cm });
    expect(r.recover.recovered).toBe(2);
    const bySession = (id: string, table: "observations" | "prompts") =>
      (repo.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id) as { n: number }).n;
    expect(bySession(sid, "observations")).toBe(2);
    expect(bySession(uuid, "observations")).toBe(0);
    expect(bySession(sid, "prompts")).toBe(2);
    expect(bySession(uuid, "prompts")).toBe(0);
    // drugi przebieg nic nie zmienia
    expect(repair(repo, { cmDbPath: cm }).changes).toBe(0);
  });

  test("Codex bez zapisanej ścieżki rolloutu: plik znaleziony po id wątku w CODEX_HOME", async () => {
    const X = await import("./fixtures/capture/codex.ts");
    const { codexHome } = await import("../src/capture/codex.ts");
    const repo = new Repo(openDb({ path: join(DATA_DIR, "c.db"), vectors: false }));
    const id = "cccccccc-3333-4333-8333-000000000001";
    const dir = join(codexHome(), "sessions", "2026", "10", "05");
    mkdirSync(dir, { recursive: true });
    const tpath = join(dir, X.rolloutName(id));
    writeFileSync(tpath, J.jsonl(X.session(id)));
    repo.upsertSession({ id, project: "demo", started_at: X.T0, source: "backfill" } as any);
    repo.setTranscriptProgress(id, statSync(tpath).size, 2, X.T0 + 14_000);
    const r = repair(repo, { cmDbPath: join(DATA_DIR, "brak-claude-mem.db") });
    expect(r.recover.missingTranscript).toBe(0);
    expect(r.recover.sessions).toBe(1);
    const notes = repo.db.query("SELECT transcript_ref FROM observations WHERE session_id = ?").all(id) as {
      transcript_ref: string;
    }[];
    expect(notes.length).toBeGreaterThan(0);
    expect(JSON.parse(notes[0].transcript_ref).path).toBe(tpath);
  });
}
