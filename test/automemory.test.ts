// Pamięć automatyczna Claude Code (`import-automemory`) i eksport do vaulta (`export-vault`): rozbiór frontmattera,
// mapowanie rodzajów, klucz projektu (sesja, transkrypt, sesje katalogu, ścieżka z nazwy katalogu), redakcja,
// idempotencja, zmiana pliku przez supersedes, usunięcie i powrót pliku, identyfikator instalacji, sekrety w każdym
// polu, poza kontekstem startowym, nadrabianie w workerze (krok syncAutoMemory z oddawaniem pętli), CLI.
// Wszystko na kopiach w katalogu testowym: prawdziwe ~/.claude nie jest czytane.
// Osobny proces z katalogiem „hipokamp-test” jak w projects.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";

const CHILD = "HIPOKAMP_AUTOMEMORY_CHILD";

if (!process.env[CHILD]) {
  test("pamięć automatyczna i eksport do vaulta (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/automemory.test.ts"], {
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
          .map((l) => `automemory: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy pamięci automatycznej nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, DEFAULTS, claudeDir, loadConfig } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test") || !claudeDir().includes("hipokamp-test"))
    throw new Error("automemory: HIPOKAMP_HOME i CLAUDE_CONFIG_DIR muszą wskazywać katalog testowy");
  const { openDb, closeShared, getMeta } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const A = await import("../src/importers/automemory.ts");
  const { exportVault, safeName } = await import("../src/core/vault.ts");
  const { sessionStartContext } = await import("../src/recall/context.ts");
  const { hybridSearch } = await import("../src/recall/search.ts");
  const { normPath } = await import("../src/util/paths.ts");
  const J = await import("./fixtures/capture/jsonl.ts");
  type RepoT = InstanceType<typeof Repo>;

  let seq = 0;
  const fresh = (): RepoT => new Repo(openDb({ path: join(DATA_DIR, `${++seq}-a.db`), vectors: false }));
  // import ręczny (CLI) odczytuje ścieżkę z nazwy katalogu; worker tego nie robi
  const imp = (repo: RepoT, o: Parameters<typeof A.importAutoMemory>[1] = {}) => A.importAutoMemory(repo, { decode: true, ...o });
  // sekrety składane w czasie testu: skaner sekretów przy wysyłce nie widzi ich w pliku
  const fakeKey = ["sk", "ant", "api03", "x".repeat(28)].join("-");
  const fakeGh = ["gh", "p_", "Q7w".repeat(12)].join("");
  const fakeAws = ["AK", "IA", "QWERTYUIOP234567"].join("");
  /** Identyfikator sesji Claude Code (UUID); inne wartości originSessionId import odrzuca. */
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const SA = uuid(1);

  const feedback = (session: string) => `---
name: feedback-krotko
description: "Użytkownik chce krócej i prościej (28.09.2026) — ścieżka C:\\\\Users\\\\x"
metadata:
  node_type: memory
  type: feedback
  originSessionId: ${session}
  modified: 2026-09-28T21:06:26.752Z
---

Użytkownik o opisach: przegadane. <private>tajne dane klienta</private> Klucz testowy ${fakeKey} w notatce.

**Why:** długie odcinki, widz nie słyszy korzyści.
**How to apply:** najpierw korzyść, potem pokaz; krótkie zdania.
`;
  const project = `---\r\nname: galaz-w-worktree\r\ndescription: Praca na gałęzi w osobnym worktree na dysku C\r\nmetadata:\r\n  type: project\r\n---\r\n\r\nNowe gałęzie rób w osobnym worktree, nigdy przez checkout w głównym katalogu.\r\n`;
  const discovery = `---
name: repo-na-nas
description: Repozytorium demo leży na udziale sieciowym
type: project
---

Katalog C:\\code\\demo jest pusty, a pliki projektu leżą w \\\\nas\\share na serwerze NAS.
`;
  const reference = `---
name: deploy-staging
description: 'Instrukcja wdrożenia: serwer ''staging'' i skrypt deploy.sh'
type: reference
---

Wdrożenie przez scripts/deploy.sh na serwerze staging.
`;
  const user = `---
name: o-mnie
description: Użytkownik woli odpowiedzi po polsku
type: user
---

Rozmowa po polsku, kod zgodnie z konwencją repo.
`;

  /** Katalog `projects` z kilkoma projektami: każdy test dostaje własny korzeń. */
  function fixture() {
    const root = join(DATA_DIR, `projects-${++seq}`);
    const write = (dir: string, name: string, text: string) => {
      mkdirSync(join(root, dir, "memory"), { recursive: true });
      writeFileSync(join(root, dir, "memory", name), text);
      return join(root, dir, "memory", name);
    };
    // Alfa: projekt z sesji wpisanej we frontmatterze; indeks MEMORY.md daje tytuł
    const fa = write("C--alfa", "feedback-krotko.md", feedback(SA));
    write("C--alfa", "MEMORY.md", "- [Odcinki: krócej i po ludzku](feedback-krotko.md) — przegadane\n");
    write("C--alfa", "o-mnie.md", user);
    // Beta: bez sesji w bazie, projekt z cwd najnowszego transkryptu w katalogu
    const fb = write("C--beta", "galaz-w-worktree.md", project);
    const betaCwd = join(DATA_DIR, "work", "Beta");
    writeFileSync(
      join(root, "C--beta", "t-beta.jsonl"),
      `${JSON.stringify(J.userPrompt({ sessionId: "t-beta", cwd: betaCwd }, Date.now(), "cześć"))}\n`,
    );
    // Gamma: projekt z sesji, których transkrypty leżą w tym katalogu
    const fc = write("C--gamma", "repo-na-nas.md", discovery);
    write("C--gamma", "deploy-staging.md", reference);
    // Delta: tylko nazwa katalogu, odczytana jako istniejąca ścieżka
    const deltaDir = join(DATA_DIR, "work", "Delta.app");
    mkdirSync(deltaDir, { recursive: true });
    const deltaName = deltaDir.replace(/[^A-Za-z0-9]/g, "-");
    const fd = write(deltaName, "o-mnie.md", user);
    // nieznany projekt: brak sesji, transkryptu i ścieżki
    write("Q--nie-ma-takiego-katalogu", "x.md", user);
    return { root, fa, fb, fc, fd, deltaName };
  }

  function seedSessions(repo: RepoT, root: string) {
    repo.upsertSession({ id: SA, project: "Alfa", cwd: null, started_at: Date.now() - 86_400_000 });
    repo.upsertSession({
      id: "g1",
      project: "Gamma",
      cwd: null,
      started_at: Date.now() - 3_600_000,
      transcript_path: join(root, "C--gamma", "g1.jsonl"),
    });
  }

  const byFile = (repo: RepoT, file: string) =>
    (
      repo.db
        .query(
          "SELECT id, status, superseded_by FROM observations WHERE source = 'automemory' AND lower(json_extract(meta, '$.automemory.file')) = ? ORDER BY id",
        )
        .all(normPath(file).toLowerCase()) as { id: number; status: string; superseded_by: number | null }[]
    ).map((r) => ({ ...r, o: repo.getObservation(r.id)! }));
  const countAm = (repo: RepoT) =>
    (repo.db.query("SELECT COUNT(*) c FROM observations WHERE source = 'automemory'").get() as { c: number }).c;

  describe("rozbiór plików", () => {
    test("frontmatter: metadata zagnieżdżone, cudzysłowy, CRLF, brak frontmattera", () => {
      const a = A.parseMemory(feedback("s1"));
      expect(a.name).toBe("feedback-krotko");
      expect(a.type).toBe("feedback");
      expect(a.originSessionId).toBe("s1");
      expect(a.description).toBe("Użytkownik chce krócej i prościej (28.09.2026) — ścieżka C:\\Users\\x");
      expect(a.modified).toBe(Date.parse("2026-09-28T21:06:26.752Z"));
      expect(a.body.startsWith("Użytkownik o opisach")).toBe(true);
      const b = A.parseMemory(project);
      expect(b.type).toBe("project");
      expect(b.body).toBe("Nowe gałęzie rób w osobnym worktree, nigdy przez checkout w głównym katalogu.");
      expect(A.parseMemory(reference).description).toBe("Instrukcja wdrożenia: serwer 'staging' i skrypt deploy.sh");
      const none = A.parseMemory("# Sam tekst\n\nbez frontmattera");
      expect(none.type).toBe("");
      expect(none.body).toBe("# Sam tekst\n\nbez frontmattera");
    });

    test("rodzaje: user i feedback → preference, project → decision albo discovery, reference → reference", () => {
      expect(A.kindOf("user", "cokolwiek")).toBe("preference");
      expect(A.kindOf("feedback", "cokolwiek")).toBe("preference");
      expect(A.kindOf("reference", "nigdy")).toBe("reference");
      expect(A.kindOf("project", A.parseMemory(project).body)).toBe("decision");
      expect(A.kindOf("project", "**Why:** bo tak")).toBe("decision");
      expect(A.kindOf("project", A.parseMemory(discovery).body)).toBe("discovery");
    });

    test("indeks MEMORY.md i fakty Why / How to apply", () => {
      const t = A.indexTitles("- [Tytuł A](a.md) — opis\n- [Tytuł B](Sub/B.MD)\n- bez linku\n");
      expect(t.get("a.md")).toBe("Tytuł A");
      expect(t.get("b.md")).toBe("Tytuł B");
      expect(A.memoryFacts(A.parseMemory(feedback("s")).body)).toEqual([
        "Dlaczego: długie odcinki, widz nie słyszy korzyści.",
        "Jak stosować: najpierw korzyść, potem pokaz; krótkie zdania.",
      ]);
    });

    test("nazwa katalogu projektu odczytana jako istniejąca ścieżka (także z kropką w nazwie)", () => {
      const dir = join(DATA_DIR, "dekod", "Moje.Repo", "pod-katalog");
      mkdirSync(dir, { recursive: true });
      expect(normPath(A.decodeProjectDir(dir.replace(/[^A-Za-z0-9]/g, "-")) ?? "")).toBe(normPath(dir));
      expect(A.decodeProjectDir("Q--nie-ma-takiego-katalogu")).toBeNull();
      expect(A.decodeProjectDir("bez-dysku")).toBeNull();
    });
  });

  describe("import", () => {
    test("plan nic nie zapisuje, import tworzy notatki z kanonicznymi rodzajami, projektem i redakcją", () => {
      const repo = fresh();
      const { root, fa, fb, fc, fd, deltaName } = fixture();
      seedSessions(repo, root);
      // bez odczytu nazwy katalogu (tryb workera) projekt Delty jest nieznany
      const noDecode = A.importAutoMemory(repo, { root });
      expect([noDecode.inserted, noDecode.skipped]).toEqual([5, 2]);
      expect(noDecode.items.find((i) => i.file === normPath(fd))?.reason).toContain("import ręczny");
      const plan = imp(repo, { root });
      expect(countAm(repo)).toBe(0);
      expect(plan.inserted).toBe(6);
      expect(plan.skipped).toBe(1);
      expect(plan.items.find((i) => i.action === "pominięta")?.reason).toContain("projektu");
      // plan nie zapisuje też ścieżek odczytanych z nazw katalogów
      expect(getMeta(repo.db, "automemory_dirs")).toBeNull();

      const rep = imp(repo, { root, apply: true });
      expect(rep.inserted).toBe(6);
      expect(countAm(repo)).toBe(6);
      // ścieżka z nazwy katalogu zapamiętana: worker zna projekt bez przeszukiwania dysku
      expect(A.dirProjectResolver(repo, root)(deltaName)).toEqual({ project: "Delta.app", via: "ścieżka" });
      expect(A.dirProjectResolver(fresh(), root)(deltaName).project).toBeNull();

      const a = byFile(repo, fa)[0].o;
      expect(a.type).toBe("preference");
      expect(a.project).toBe("Alfa");
      expect(a.session_id).toBe(SA);
      expect(a.title).toBe("Odcinki: krócej i po ludzku");
      expect(a.subtitle).toContain("Użytkownik chce krócej");
      expect(a.tier).toBe("semantic");
      expect(a.created_at).toBe(Date.parse("2026-09-28T21:06:26.752Z"));
      expect(a.narrative).not.toContain(fakeKey);
      expect(a.narrative).toContain("[REDACTED");
      expect(a.narrative).not.toContain("tajne dane klienta");
      expect(a.facts[0]).toStartWith("Dlaczego:");
      // plik pamięci nie jest plikiem projektu: bez files_modified (bez linii „pliki: …/memory/x.md” w kontekście)
      expect(a.files_modified).toEqual([]);
      expect(a.fingerprints ?? null).toBeNull();
      expect((a.meta as any).automemory.file).toBe(normPath(fa));
      expect((a.meta as any).automemory.install).toBe(A.machineId(repo.db));
      expect((a.meta as any).automemory.session).toBe(SA);
      expect((a.meta as any).automemory.type).toBe("feedback");

      const b = byFile(repo, fb)[0].o;
      expect([b.type, b.project]).toEqual(["decision", "Beta"]);
      const c = byFile(repo, fc)[0].o;
      expect([c.type, c.project]).toEqual(["discovery", "Gamma"]);
      expect(byFile(repo, join(root, "C--gamma", "memory", "deploy-staging.md"))[0].o.type).toBe("reference");
      expect(byFile(repo, fd)[0].o.project).toBe("Delta.app");
      // plik pamięci nie jest encją pliku: notatka nie wraca przy każdym odczycie pliku przez Claude
      expect(
        (
          repo.db
            .query("SELECT COUNT(*) c FROM obs_entities oe JOIN entities e ON e.id = oe.entity_id WHERE e.kind = 'file'")
            .get() as {
            c: number;
          }
        ).c,
      ).toBe(0);
    });

    test("idempotencja, zmiana przez supersedes, usunięcie do archiwum i powrót pliku", () => {
      const repo = fresh();
      const { root, fa, fc } = fixture();
      seedSessions(repo, root);
      imp(repo, { root, apply: true });
      const again = imp(repo, { root, apply: true });
      expect([again.inserted, again.updated, again.unchanged]).toEqual([0, 0, 6]);
      expect(countAm(repo)).toBe(6);

      // zmiana treści: nowa notatka, poprzednia superseded ze wskazaniem nowej, liczba aktywnych bez zmian
      writeFileSync(fa, feedback(SA).replace("przegadane", "przegadane i za długie"));
      const ch = imp(repo, { root, apply: true });
      expect(ch.updated).toBe(1);
      const [old, cur] = byFile(repo, fa);
      expect(old.status).toBe("superseded");
      expect(old.superseded_by).toBe(cur.id);
      expect(cur.status).toBe("active");
      expect(cur.o.narrative).toContain("za długie");
      expect(imp(repo, { root, apply: true }).updated).toBe(0);

      // plik usunięty z istniejącego katalogu memory: archiwum; wraca z tą samą treścią: przywrócona
      const text = readFileSync(fc, "utf8");
      unlinkSync(fc);
      const rm = imp(repo, { root, apply: true });
      expect(rm.archived).toBe(1);
      expect(byFile(repo, fc)[0].status).toBe("archived");
      writeFileSync(fc, text);
      const back = imp(repo, { root, apply: true });
      expect(back.restored).toBe(1);
      expect(byFile(repo, fc).map((x) => x.status)).toEqual(["active"]);

      // cały katalog projektu zniknął (sprzątanie): wspomnienia zostają
      rmSync(join(root, "C--gamma"), { recursive: true, force: true });
      expect(imp(repo, { root, apply: true }).archived).toBe(0);
      expect(byFile(repo, fc)[0].status).toBe("active");
    });

    test("forget ręczny jest respektowany; ręczne przywrócenie nie wraca do archiwum przy pełnym skanie", () => {
      const repo = fresh();
      const { root, fa, fc } = fixture();
      seedSessions(repo, root);
      imp(repo, { root, apply: true });
      const a = byFile(repo, fa)[0];
      repo.setStatus(a.id, "archived"); // forget
      writeFileSync(fa, feedback(SA).replace("przegadane", "przegadane, inna wersja"));
      const r = imp(repo, { root, apply: true });
      expect([r.inserted, r.updated, r.restored]).toEqual([0, 0, 0]);
      expect(r.items.find((i) => i.prevId === a.id)?.reason).toContain("forget");
      expect(byFile(repo, fa).map((x) => x.status)).toEqual(["archived"]);

      unlinkSync(fc);
      expect(imp(repo, { root, apply: true }).archived).toBe(1);
      const c = byFile(repo, fc)[0];
      repo.setStatus(c.id, "active"); // przywrócenie w podglądzie
      expect(imp(repo, { root, apply: true }).archived).toBe(0);
      expect(byFile(repo, fc)[0].status).toBe("active");
    });

    test("notatka zastąpiona przez remember(supersedes) nie wraca przy pełnym imporcie", () => {
      const repo = fresh();
      const { root, fb } = fixture();
      seedSessions(repo, root);
      imp(repo, { root, apply: true });
      const b = byFile(repo, fb)[0];
      const newer = repo.insertObservation({
        session_id: null,
        project: "Beta",
        type: "decision",
        title: "Gałęzie jednak w głównym katalogu",
        narrative: "Zmiana decyzji: worktree tylko przy pracy równoległej.",
        created_at: Date.now(),
        source: "agent",
      }).id;
      repo.setStatus(b.id, "superseded", { supersededBy: newer, validUntil: Date.now() });
      const r = imp(repo, { root, apply: true });
      expect([r.inserted, r.updated, r.restored]).toEqual([0, 0, 0]);
      expect(r.items.find((i) => i.prevId === b.id)?.reason).toContain(`#${newer}`);
      expect(byFile(repo, fb).map((x) => x.status)).toEqual(["superseded"]);
      // zmiana pliku też jej nie wskrzesza (decyzja użytkownika wygrywa)
      writeFileSync(fb, `${readFileSync(fb, "utf8")}\nDopisek.\n`);
      expect(imp(repo, { root, apply: true }).inserted).toBe(0);
    });

    test("notatka innej instalacji (synchronizacja) o tej samej ścieżce nie jest zastępowana ani archiwizowana", () => {
      const repo = fresh();
      const { root, fa } = fixture();
      seedSessions(repo, root);
      imp(repo, { root, apply: true });
      const a = byFile(repo, fa)[0];
      // jak po synchronizacji: ta sama ścieżka, inna instalacja
      // (skrót treści notatki innej instalacji zawiera jej identyfikator, więc też jest inny)
      repo.db.run(
        "UPDATE observations SET meta = json_set(meta, '$.automemory.install', 'inna-instalacja'), content_hash = 'z-innej-instalacji' WHERE id = ?",
        [a.id],
      );
      expect(imp(repo, { root, apply: true }).inserted).toBe(1);
      unlinkSync(fa);
      imp(repo, { root, apply: true });
      const all = byFile(repo, fa);
      expect(all.length).toBe(2);
      expect(all.find((x) => x.id === a.id)?.status).toBe("active");
      expect(all.at(-1)?.status).toBe("archived");
    });

    test("zmiana nazwy komputera nie dubluje notatek; notatki sprzed identyfikatora instalacji są przejmowane", () => {
      const repo = fresh();
      const { root } = fixture();
      seedSessions(repo, root);
      imp(repo, { root, apply: true });
      const active = () =>
        (
          repo.db.query("SELECT COUNT(*) c FROM observations WHERE source = 'automemory' AND status = 'active'").get() as {
            c: number;
          }
        ).c;
      expect(active()).toBe(6);
      // komputer zmienił nazwę (albo ~/.hipokamp przeniesiono): identyfikator instalacji zostaje
      repo.db.run(
        "UPDATE observations SET meta = json_set(meta, '$.automemory.host', 'stara-nazwa') WHERE source = 'automemory'",
      );
      const r = imp(repo, { root, apply: true });
      expect([r.inserted, r.unchanged]).toEqual([0, 6]);
      expect(active()).toBe(6);
      // notatki z wersji bez identyfikatora (tylko nazwa tego komputera): przejęte, bez duplikatów
      repo.db.run(
        `UPDATE observations SET meta = json_set(json_remove(meta, '$.automemory.install'), '$.automemory.host', ?) WHERE source = 'automemory'`,
        [hostname().toLowerCase()],
      );
      const r2 = imp(repo, { root, apply: true });
      expect([r2.inserted, r2.unchanged]).toEqual([0, 6]);
      const installs = repo.db
        .query("SELECT DISTINCT json_extract(meta, '$.automemory.install') i FROM observations WHERE source = 'automemory'")
        .all() as { i: string }[];
      expect(installs).toEqual([{ i: A.machineId(repo.db)! }]);
    });

    test("sekret w nazwie z frontmattera i w nazwie pliku nie trafia do tytułu, meta ani klucza", () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      const md = join(root, "C--sekret", "memory");
      mkdirSync(md, { recursive: true });
      repo.upsertSession({ id: uuid(7), project: "Sekret", cwd: null, started_at: Date.now() });
      // treść „OK.” nie daje nagłówka, więc tytułem zastępczym jest name albo nazwa pliku
      writeFileSync(join(md, "a.md"), `---\nname: klucz ${fakeKey}\ntype: feedback\noriginSessionId: ${uuid(7)}\n---\n\nOK.\n`);
      const tokName = `${["tok", "en"].join("")}=${"Z9x".repeat(5)}`;
      writeFileSync(join(md, `${tokName}.md`), `---\ntype: feedback\noriginSessionId: ${uuid(7)}\n---\n\nTak.\n`);
      const plan = A.formatMemoryReport(A.importAutoMemory(repo, { root }), { apply: false, all: true });
      expect(plan).not.toContain(fakeKey);
      expect(plan).not.toContain("Z9xZ9x");
      const rep = A.importAutoMemory(repo, { root, apply: true });
      expect(rep.inserted).toBe(2);
      const dump = JSON.stringify([
        repo.db.query("SELECT * FROM observations WHERE source = 'automemory'").all(),
        repo.db.query("SELECT key FROM entities").all(),
      ]);
      expect(dump).not.toContain(fakeKey);
      expect(dump).not.toContain("Z9xZ9x");
      expect(dump).toContain("[REDACTED");
      // klucz po redakcji jest stały: drugi przebieg bez zmian, usunięcie pliku nadal archiwizuje
      expect(A.importAutoMemory(repo, { root, apply: true }).unchanged).toBe(2);
      unlinkSync(join(md, `${tokName}.md`));
      expect(A.importAutoMemory(repo, { root, apply: true }).archived).toBe(1);
    });

    test("sekret w każdym polu pliku (frontmatter, nagłówek, nazwa pliku i katalogu) nie trafia do żadnej tabeli bazy", async () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      const secrets = [fakeKey, fakeGh, fakeAws];
      const variants = (x: string) => [x, x.toLowerCase(), x.toUpperCase()];
      const S = uuid(9);
      repo.upsertSession({ id: S, project: "Sejfowy", cwd: null, started_at: Date.now() });
      let n = 0;
      for (const sec of secrets) {
        const dir = `C--proj-${sec}`;
        const md = join(root, dir, "memory");
        mkdirSync(md, { recursive: true });
        // zwykły plik katalogu daje projekt (sesja), plik z sekretami korzysta z niego („katalog”)
        writeFileSync(join(md, "zwykly.md"), `---\ntype: user\noriginSessionId: ${S}\n---\n\nZwykła treść ${++n}.\n`);
        writeFileSync(join(md, "MEMORY.md"), `- [Tytuł ${sec}](plik-${sec}.md) — opis ${sec}\n`);
        writeFileSync(
          join(md, `plik-${sec}.md`),
          [
            "---",
            `name: ${sec}`,
            `description: opis ${sec}`,
            `type: ${sec}`,
            `originSessionId: ${sec}`,
            `modified: ${sec}`,
            `cokolwiek: ${sec}`,
            "metadata:",
            `  type: ${sec}`,
            `  originSessionId: ${sec}`,
            `  node_type: ${sec}`,
            "---",
            "",
            `# Nagłówek ${sec}`,
            "",
            `Treść ${sec} i **Why:** ${sec}`,
            `**How to apply:** ${sec}`,
            "",
          ].join("\n"),
        );
        // drugi plik: tylko frontmatter z sekretem, treść bez nagłówka (tytuły zastępcze)
        writeFileSync(join(md, `${sec}.md`), `---\nname: ${sec}\ntype: ${sec}\noriginSessionId: ${sec}\n---\n\nOK.\n`);
        // trzeci: bez wpisu w indeksie, więc tytułem jest opis z frontmattera
        writeFileSync(join(md, "z-opisu.md"), `---\ndescription: opis ${sec}\ntype: user\n---\n\nTreść bez nagłówka.\n`);
      }
      const rep = imp(repo, { root, apply: true });
      expect(rep.inserted).toBe(12);
      // klucz pliku to ścieżka z dopiskiem `#skrót`
      const fromDescription = rep.items.filter((i) => i.file.includes("/z-opisu.md")).map((i) => i.title ?? "");
      expect(fromDescription.length).toBe(3);
      for (const t of fromDescription) expect(t).toStartWith("opis [REDACTED");
      const cfg = loadConfig();
      cfg.capture.autoMemory = true;
      try {
        A.resetAutoMemorySeen(repo);
        await A.syncAutoMemory(repo, { root });
      } finally {
        cfg.capture.autoMemory = null;
      }
      const tables = (repo.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (t) => t.name,
      );
      let dump = "";
      for (const t of tables) {
        try {
          dump += JSON.stringify(repo.db.query(`SELECT * FROM "${t}"`).all());
        } catch {}
      }
      for (const sec of secrets) for (const v of variants(sec)) expect(dump).not.toContain(v);
      expect(dump).toContain("[REDACTED");
      // rodzaj spoza białej listy i sesja, która nie jest UUID: nie trafiają do meta
      const metas = (repo.db.query("SELECT meta FROM observations WHERE source = 'automemory'").all() as { meta: string }[]).map(
        (r) => JSON.parse(r.meta).automemory,
      );
      expect(metas.filter((m) => m.type !== null && m.type !== "user")).toEqual([]);
      expect(metas.filter((m) => m.session !== null && m.session !== S)).toEqual([]);
    });

    test("sekret w ścieżce projektu (nazwa katalogu, cwd transkryptu) nie trafia do aliasów ani do pliku bazy", () => {
      const path = join(DATA_DIR, `${++seq}-sciezka.db`);
      const repo = new Repo(openDb({ path, vectors: false }));
      const root = join(DATA_DIR, `projects-${++seq}`);
      // 1) ścieżka odczytana z nazwy katalogu (istniejący katalog z sekretem w nazwie)
      const secretDir = join(DATA_DIR, "work", `proj-${fakeKey}`);
      mkdirSync(secretDir, { recursive: true });
      const encoded = secretDir.replace(/[^A-Za-z0-9]/g, "-");
      mkdirSync(join(root, encoded, "memory"), { recursive: true });
      writeFileSync(join(root, encoded, "memory", "a.md"), user);
      // 2) cwd z transkryptu katalogu
      mkdirSync(join(root, "C--z-transkryptem", "memory"), { recursive: true });
      writeFileSync(join(root, "C--z-transkryptem", "memory", "b.md"), reference);
      writeFileSync(
        join(root, "C--z-transkryptem", "t.jsonl"),
        `${JSON.stringify(J.userPrompt({ sessionId: "t-sek", cwd: join(DATA_DIR, "work", `cwd-${fakeKey}`) }, Date.now(), "hej"))}\n`,
      );
      const r = imp(repo, { root, apply: true });
      expect(r.inserted).toBe(2);
      expect(r.items.map((i) => i.via).sort()).toEqual(["transkrypt", "ścieżka"].sort());
      for (const i of r.items) expect(i.project ?? "").not.toContain(fakeKey);
      const aliases = JSON.stringify(repo.db.query("SELECT * FROM project_aliases").all());
      expect(aliases).not.toContain(fakeKey);
      expect(getMeta(repo.db, "automemory_dirs") ?? "").not.toContain(fakeKey);
      // surowe bajty pliku bazy i dziennika WAL
      const raw = [path, `${path}-wal`]
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p).toString("latin1"))
        .join("");
      expect(raw.length).toBeGreaterThan(0);
      expect(raw).not.toContain(fakeKey);
      repo.db.close();
    });

    test("sekret rozcięty znacznikiem kodu (sklejany przez zdjęcie Markdown) nie trafia do tytułu, faktów ani encji", () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      const md = join(root, "C--rozciety", "memory");
      mkdirSync(md, { recursive: true });
      const S = uuid(31);
      repo.upsertSession({ id: S, project: "Rozciety", cwd: null, started_at: Date.now() });
      const [head, mid, ...tail] = fakeKey.split("-");
      const split = `${head}-${mid}-\`${tail[0]}\`-${tail.slice(1).join("-")}`;
      expect(split).not.toBe(fakeKey);
      writeFileSync(
        join(md, "rozciety.md"),
        `---\ntype: project\noriginSessionId: ${S}\n---\n\nZawsze używaj klucza ${split} w testach integracyjnych.\n\n**Why:** klucz ${split} działa tylko lokalnie.\n`,
      );
      expect(imp(repo, { root, apply: true }).inserted).toBe(1);
      const dump = JSON.stringify([
        repo.db.query("SELECT title, subtitle, facts, concepts FROM observations WHERE source = 'automemory'").all(),
        repo.db.query("SELECT * FROM entities").all(),
        repo.db.query("SELECT * FROM observations_fts").all(),
      ]);
      expect(dump).not.toContain(fakeKey);
      const { id } = repo.db.query("SELECT id FROM observations WHERE source = 'automemory'").get() as { id: number };
      const o = repo.getObservation(id)!;
      expect(o.title).toContain("[REDACTED");
      expect(o.facts.join(" ")).toContain("[REDACTED");
    });

    test("import ręczny i worker naraz: druga strona widzi zapis pierwszej jako bez zmian (bez powtórki, bez fałszywego remember)", () => {
      const path = join(DATA_DIR, `${++seq}-wyscig.db`);
      const one = new Repo(openDb({ path, vectors: false }));
      const two = new Repo(openDb({ path, vectors: false }));
      const root = join(DATA_DIR, `projects-${++seq}`);
      const md = join(root, "C--wyscig", "memory");
      mkdirSync(md, { recursive: true });
      const S = uuid(41);
      one.upsertSession({ id: S, project: "Wyscig", cwd: null, started_at: Date.now() });
      const files = Array.from({ length: 8 }, (_, i) => join(md, `m${i}.md`));
      const write = (v: string) => {
        for (const [i, f] of files.entries())
          writeFileSync(f, `---\ntype: user\noriginSessionId: ${S}\n---\n\nPreferencja ${i}, wersja ${v}.\n`);
      };
      // przebieg „workera” zatrzymany po odczycie plików (mapa notatek już zbudowana), wtedy cały import „ręczny”
      const race = () => {
        const g = A.importSteps(one, { root, apply: true });
        g.next();
        g.next();
        const other = A.importAutoMemory(two, { root, apply: true });
        let r = g.next();
        while (!r.done) r = g.next();
        return { mine: r.value, other };
      };
      write("1");
      const a = race();
      expect(a.other.inserted).toBe(8);
      expect([a.mine.inserted, a.mine.unchanged, a.mine.skipped]).toEqual([0, 8, 0]);
      const rows = one.db
        .query("SELECT occurrence_count n, importance FROM observations WHERE source = 'automemory' AND status = 'active'")
        .all() as { n: number; importance: number }[];
      expect(rows.length).toBe(8);
      expect(rows.every((x) => x.n === 1 && x.importance === 0.75)).toBe(true);
      // zmiana plików: druga strona zapisuje nowe wersje i zastępuje stare; ta strona nie widzi „remember”
      write("2");
      const b = race();
      expect(b.other.updated).toBe(8);
      expect([b.mine.updated, b.mine.unchanged, b.mine.skipped]).toEqual([0, 8, 0]);
      expect(b.mine.items.some((i) => (i.reason ?? "").includes("spoza tego pliku"))).toBe(false);
      expect(countAm(one)).toBe(16);
      one.db.close();
      two.db.close();
    });

    test("plik większy niż limit jest pomijany bez czytania, z powodem w raporcie", () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      const md = join(root, "C--duzy", "memory");
      mkdirSync(md, { recursive: true });
      repo.upsertSession({ id: uuid(3), project: "Duzy", cwd: null, started_at: Date.now() });
      writeFileSync(join(md, "maly.md"), user.replace("type: user", `type: user\noriginSessionId: ${uuid(3)}`));
      writeFileSync(join(md, "duzy.md"), `---\ntype: project\n---\n\n${"Zawsze tak rób. ".repeat(20_000)}`);
      // indeks MEMORY.md ponad limit też nie jest czytany (tytuł z opisu)
      writeFileSync(join(md, "MEMORY.md"), `- [Tytuł z indeksu](maly.md)\n${"x".repeat(300 * 1024)}`);
      const t0 = performance.now();
      const rep = A.importAutoMemory(repo, { root, apply: true });
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(rep.inserted).toBe(1);
      expect(rep.items.find((i) => i.file.endsWith("duzy.md") && !i.file.endsWith("maly.md"))?.reason).toContain("za duży");
      expect(rep.items.find((i) => i.file.endsWith("maly.md"))?.title).toBe("Użytkownik woli odpowiedzi po polsku");
    });

    test("dowiązania i junction prowadzące poza korzeń są pomijane", () => {
      const root = join(DATA_DIR, `projects-${++seq}`);
      mkdirSync(join(root, "C--ok", "memory"), { recursive: true });
      writeFileSync(join(root, "C--ok", "memory", "a.md"), user);
      const kind = process.platform === "win32" ? "junction" : "dir";
      // katalog memory jako junction na katalog poza korzeniem
      const outside = join(DATA_DIR, `poza-${seq}`);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "tajne.md"), user);
      mkdirSync(join(root, "C--zly"), { recursive: true });
      symlinkSync(outside, join(root, "C--zly", "memory"), kind);
      // cały katalog projektu jako junction poza korzeń
      const outProj = join(DATA_DIR, `poza-projekt-${seq}`);
      mkdirSync(join(outProj, "memory"), { recursive: true });
      writeFileSync(join(outProj, "memory", "b.md"), user);
      symlinkSync(outProj, join(root, "C--zly2"), kind);
      expect(A.listMemoryFiles(root).map((f) => basename(f.path))).toEqual(["a.md"]);
    });

    // dowiązanie do pliku na Windows wymaga uprawnień (trybu dewelopera); w CI na Linuksie działa zawsze
    const fileLinks = (() => {
      const dir = join(DATA_DIR, `link-probe-${++seq}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a"), "x");
      try {
        symlinkSync(join(dir, "a"), join(dir, "b"), "file");
        return true;
      } catch {
        return false;
      }
    })();
    test.skipIf(!fileLinks)("dowiązania symboliczne do plików poza korzeniem (wspomnienie i MEMORY.md) są pomijane", () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      const md = join(root, "C--linki", "memory");
      mkdirSync(md, { recursive: true });
      const S = uuid(51);
      repo.upsertSession({ id: S, project: "Linki", cwd: null, started_at: Date.now() });
      const outside = join(DATA_DIR, `poza-pliki-${seq}`);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "tajne.md"), `---\ntype: user\noriginSessionId: ${S}\n---\n\nTajna treść spoza projects.\n`);
      writeFileSync(join(outside, "MEMORY.md"), "- [Tytuł spoza projects](zwykly.md)\n");
      writeFileSync(
        join(md, "zwykly.md"),
        `---\ndescription: Opis zwykłego\ntype: user\noriginSessionId: ${S}\n---\n\nZwykła treść.\n`,
      );
      symlinkSync(join(outside, "tajne.md"), join(md, "link.md"), "file");
      symlinkSync(join(outside, "MEMORY.md"), join(md, "MEMORY.md"), "file");
      expect(A.listMemoryFiles(root).map((f) => basename(f.path))).toEqual(["zwykly.md"]);
      const rep = imp(repo, { root, apply: true });
      expect(rep.inserted).toBe(1);
      // tytuł z opisu, nie z indeksu spoza katalogu
      expect(rep.items.find((i) => i.file.endsWith("zwykly.md"))?.title).toBe("Opis zwykłego");
    });

    test("kontekst startowy: wiele wspomnień nie wypycha własnych notatek projektu z limitów kandydatów", async () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      const md = join(root, "C--tlum", "memory");
      mkdirSync(md, { recursive: true });
      const S = uuid(51);
      repo.upsertSession({ id: S, project: "Tlum", cwd: null, started_at: Date.now() });
      // starsza własna notatka projektu, potem 160 świeższych wspomnień (więcej niż limity 150 i 120)
      repo.insertObservation({
        session_id: null,
        project: "Tlum",
        type: "decision",
        title: "Wydania tylko z gałęzi release",
        narrative: "Każde wydanie powstaje z gałęzi release po przeglądzie.",
        importance: 0.6,
        created_at: Date.now() - 10 * 86_400_000,
        source: "agent",
      });
      for (let i = 0; i < 160; i++)
        writeFileSync(
          join(md, `w${i}.md`),
          `---
type: user
originSessionId: ${S}
---

Ulubiony kolor numer ${i}.
`,
        );
      expect(imp(repo, { root, apply: true }).inserted).toBe(160);
      const ctx = await sessionStartContext(repo, null, { project: "Tlum", budget: 1600, record: false });
      expect(ctx.text).toContain("Wydania tylko z gałęzi release");
      expect(ctx.text).not.toContain("Ulubiony kolor");
    });

    test("kontekst startowy pomija pamięć automatyczną (Claude Code wczytuje MEMORY.md), wyszukiwanie ją znajduje", async () => {
      const repo = fresh();
      const { root, fb } = fixture();
      seedSessions(repo, root);
      imp(repo, { root, apply: true });
      repo.insertObservation({
        session_id: null,
        project: "Beta",
        type: "decision",
        title: "Testy uruchamiamy przed każdym PR",
        narrative: "Bramka lint, typecheck i testy przed PR.",
        importance: 0.6,
        created_at: Date.now(),
        source: "agent",
      });
      const ctx = await sessionStartContext(repo, null, { project: "Beta", budget: 1600, record: false });
      expect(ctx.text).toContain("Testy uruchamiamy przed każdym PR");
      expect(ctx.text).not.toContain("worktree");
      expect(ctx.text).not.toContain("/memory/");
      const hits = await hybridSearch(repo, null, "worktree gałęzie", { project: "Beta", limit: 5 });
      expect(hits.map((h) => h.id)).toContain(byFile(repo, fb)[0].id);
    });

    test("ten sam plik w dwóch katalogach to dwie notatki; projekt wykluczony jest pomijany", () => {
      const repo = fresh();
      const root = join(DATA_DIR, `projects-${++seq}`);
      for (const d of ["C--jeden", "C--dwa"]) {
        mkdirSync(join(root, d, "memory"), { recursive: true });
        const sid = uuid(d === "C--jeden" ? 11 : 12);
        writeFileSync(join(root, d, "memory", "o-mnie.md"), user.replace("type: user", `type: user\noriginSessionId: ${sid}`));
        repo.upsertSession({ id: sid, project: d === "C--jeden" ? "Jeden" : "sejf", cwd: null, started_at: Date.now() });
      }
      const cfg = loadConfig();
      cfg.capture.excludeProjects = ["sejf"];
      try {
        const r = A.importAutoMemory(repo, { root, apply: true });
        expect(r.inserted).toBe(1);
        expect(r.items.find((i) => i.action === "pominięta")?.reason).toContain("wykluczony");
      } finally {
        cfg.capture.excludeProjects = [];
      }
      const r2 = A.importAutoMemory(repo, { root, apply: true });
      expect(r2.inserted).toBe(1);
      expect(countAm(repo)).toBe(2);
    });

    test("nadrabianie w workerze: domyślnie dopiero po imporcie ręcznym, stan skanu w meta, false nie czyta nic", async () => {
      const repo = fresh();
      A.resetAutoMemorySeen(repo);
      const projects = join(claudeDir(), "projects");
      mkdirSync(join(projects, "C--wrk", "memory"), { recursive: true });
      const f = join(projects, "C--wrk", "memory", "o-mnie.md");
      writeFileSync(f, user.replace("type: user", `type: user\noriginSessionId: ${uuid(5)}`));
      repo.upsertSession({ id: uuid(5), project: "Wrk", cwd: null, started_at: Date.now() });
      const cfg = loadConfig();
      const step = () => A.catchUpAutoMemory(repo, cfg);
      try {
        expect(DEFAULTS.capture.autoMemory).toBeNull();
        expect(cfg.capture.autoMemory).toBeNull();
        // domyślnie: nic, dopóki użytkownik nie zrobi pierwszego importu ręcznego
        expect(A.autoMemoryState(repo.db, cfg).on).toBe(false);
        expect(await step()).toBe(0);
        expect(countAm(repo)).toBe(0);
        A.markAutoMemoryApplied(repo);
        // jawne false wygrywa także po imporcie ręcznym; napis "false" działa tak samo, inny napis wyłącza z ostrzeżeniem
        cfg.capture.autoMemory = false;
        expect(await step()).toBe(0);
        (cfg.capture as any).autoMemory = "false";
        expect(A.autoMemoryState(repo.db, cfg).invalid).toBeFalsy();
        expect(await step()).toBe(0);
        (cfg.capture as any).autoMemory = "tak";
        expect(A.autoMemoryState(repo.db, cfg)).toMatchObject({ on: false, invalid: true });
        (cfg.capture as any).autoMemory = "true";
        expect(A.autoMemoryState(repo.db, cfg)).toMatchObject({ on: true });
        expect(A.autoMemoryState(repo.db, cfg).invalid).toBeFalsy();
        cfg.capture.autoMemory = null;
        expect(A.autoMemoryState(repo.db, cfg).on).toBe(true);
        expect(await step()).toBe(1);
        // stan skanu w meta (przetrwa restart workera): bez zmian w plikach nic się nie czyta
        expect(JSON.parse(getMeta(repo.db, "automemory_seen")!)[normPath(f)]).toBeTruthy();
        expect(await step()).toBe(0);
        writeFileSync(f, `${readFileSync(f, "utf8")}\nDopisek.\n`);
        const later = new Date(Date.now() + 5_000);
        utimesSync(f, later, later);
        expect(await step()).toBe(1);
        expect(byFile(repo, f).map((x) => x.status)).toEqual(["superseded", "active"]);
        unlinkSync(f);
        expect(await step()).toBe(1);
        expect(byFile(repo, f).at(-1)?.status).toBe("archived");
      } finally {
        cfg.capture.autoMemory = null;
        rmSync(join(projects, "C--wrk"), { recursive: true, force: true });
      }
    });

    test("worker: 300 plików przy 100 tys. notatek bez blokady pętli dłuższej niż 250 ms", async () => {
      const repo = fresh();
      const S = uuid(21);
      repo.upsertSession({ id: S, project: "Duza", cwd: null, started_at: Date.now() });
      const ins = repo.db.prepare(
        "INSERT INTO observations (id, session_id, project, type, tier, title, narrative, facts, concepts, files_read, files_modified, created_at, updated_at, importance, source, content_hash, status) VALUES (?, NULL, 'Duza', 'change', 'episodic', ?, ?, '[]', '[]', '[]', '[]', ?, ?, 0.3, 'digest', ?, 'active')",
      );
      const now = Date.now();
      const filler = "x".repeat(200);
      repo.db.transaction(() => {
        for (let i = 1; i <= 100_000; i++) ins.run(i, `notatka ${i}`, filler, now - i * 1000, now, `h${i}`);
      })();
      const root = join(DATA_DIR, `projects-${++seq}`);
      for (let d = 0; d < 30; d++) {
        const md = join(root, `C--duza-${d}`, "memory");
        mkdirSync(md, { recursive: true });
        for (let f = 0; f < 10; f++)
          writeFileSync(
            join(md, `m${f}.md`),
            `---\ntype: feedback\noriginSessionId: ${S}\n---\n\nZawsze rób ${d}-${f} i nigdy inaczej.\n`,
          );
      }
      // rozgrzanie (JIT, zapytania, pamięć podręczna plików) na osobnym katalogu: pomiar dotyczy pracy, nie startu
      const warm = join(DATA_DIR, `projects-${++seq}`);
      for (let f = 0; f < 16; f++) {
        mkdirSync(join(warm, "C--rozgrzewka", "memory"), { recursive: true });
        writeFileSync(
          join(warm, "C--rozgrzewka", "memory", `w${f}.md`),
          `---\ntype: user\noriginSessionId: ${S}\n---\n\nRozgrzewka ${f}.\n`,
        );
      }
      expect((await A.syncAutoMemory(repo, { root: warm })).inserted).toBe(16);
      A.resetAutoMemorySeen(repo);
      let last = performance.now();
      let maxGap = 0;
      const iv = setInterval(() => {
        const t = performance.now();
        maxGap = Math.max(maxGap, t - last);
        last = t;
      }, 5);
      const t0 = performance.now();
      const rep = await A.syncAutoMemory(repo, { root });
      const end = performance.now();
      clearInterval(iv);
      // odcinek od ostatniego ticku do końca pracy też jest blokadą (praca bez oddawania pętli to jeden odcinek)
      maxGap = Math.max(maxGap, end - last);
      const total = end - t0;
      expect(rep.inserted).toBe(300);
      // najdłuższa blokada: najwyżej 250 ms albo ćwierć całości (wolny, obciążony CI); bez oddawania pętli blokada to
      // cała praca, więc oba progi padają. Całość do 5 s: skan całej tabeli przy każdym pliku to kilkanaście sekund
      expect(maxGap).toBeLessThan(Math.max(250, total / 4));
      expect(total).toBeLessThan(5000);
      // drugi przebieg (stan w meta): nic do zrobienia
      expect((await A.syncAutoMemory(repo, { root })).inserted).toBe(0);
    }, 120_000);

    test("CLI: domyślnie plan na bazie tylko do odczytu, --apply zapisuje", () => {
      const { root } = fixture();
      const cli = (...args: string[]) => {
        const p = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
          cwd: join(import.meta.dir, ".."),
          env: process.env as Record<string, string>,
        });
        return { code: p.exitCode, text: `${p.stdout.toString()}${p.stderr.toString()}` };
      };
      openDb().close(); // baza CLI musi istnieć: plan otwiera ją tylko do odczytu
      const plan = cli("import-automemory", "--root", root);
      expect(plan.code).toBe(0);
      expect(plan.text).toContain("plan (nic nie zapisano");
      expect(plan.text).toContain("nowa");
      expect(plan.text).toContain("nadrabianie w workerze: czeka na pierwszy");
      closeShared();
      const db = openDb({ readonly: true });
      expect((db.query("SELECT COUNT(*) c FROM observations").get() as { c: number }).c).toBe(0);
      db.close();
      const done = cli("import-automemory", "--root", root, "--apply");
      expect(done.code).toBe(0);
      expect(done.text).toContain("zaimportowano");
      // próba na innym katalogu niż domyślny nie włącza dociągania w workerze
      expect(done.text).toContain("nadrabianie w workerze: czeka na pierwszy");
      expect(done.text).toContain("import z innego katalogu");
      const own = cli("import-automemory", "--apply");
      expect(own.code).toBe(0);
      expect(own.text).toContain("nadrabianie w workerze: po imporcie ręcznym");
      const db2 = openDb({ readonly: true });
      expect(
        (db2.query("SELECT COUNT(*) c FROM observations WHERE source = 'automemory'").get() as { c: number }).c,
      ).toBeGreaterThan(0);
      db2.close();
    });
  });

  describe("eksport do vaulta", () => {
    function notes(repo: RepoT) {
      const ins = (project: string, type: string, title: string, narrative: string) =>
        repo.insertObservation({
          session_id: null,
          project,
          type,
          title,
          narrative,
          created_at: Date.UTC(2026, 9, 1),
          source: "agent",
        }).id;
      return {
        d: ins("Repo", "decision", "Tylko HTTPS do gita: SSH wyłączone", `Bez SSH. Klucz ${fakeKey} nie trafia do eksportu.`),
        g: ins("Repo", "gotcha", 'Heredoc w Bash psuje \\n: "ścieżki" <a|b>', "Pisz plikiem."),
        f: ins("Repo", "feature", "Nowy widok", "Nie eksportujemy funkcji."),
        x: ins("../Zły:Projekt", "decision", "Decyzja w dziwnym projekcie", "Treść."),
      };
    }

    test("plik na notatkę: frontmatter, redakcja, tylko decyzje i pułapki, bezpieczne nazwy, idempotencja", () => {
      const repo = fresh();
      const ids = notes(repo);
      const dir = join(DATA_DIR, `vault-${++seq}`);
      const r = exportVault(repo, { dir });
      expect(r.notes).toBe(3);
      expect(r.written).toBe(3);
      const repoDir = join(dir, "Repo");
      const files = readdirSync(repoDir).sort();
      expect(files.length).toBe(2);
      expect(files.every((f) => !/[<>:"|?*]/.test(f))).toBe(true);
      const dec = readFileSync(join(repoDir, files.find((f) => f.startsWith(`${ids.d} `))!), "utf8");
      expect(dec.split("\n").slice(0, 2)).toEqual(["---", "hipokamp_export: true"]);
      expect(dec).toContain('type: "decision"');
      expect(dec).toContain("# Tylko HTTPS do gita: SSH wyłączone");
      expect(dec).not.toContain(fakeKey);
      expect(dec).toContain(`hipokamp #${ids.d}`);
      // dziwny klucz projektu nie wychodzi poza katalog vaulta
      expect(readdirSync(dir).sort()).toEqual([safeName("../Zły:Projekt"), "Repo"].sort());
      expect(existsSync(join(dir, "..", "Zły"))).toBe(false);

      const again = exportVault(repo, { dir });
      expect([again.written, again.unchanged]).toEqual([0, 3]);
    });

    test("cudzy plik o tej samej nazwie nie jest nadpisywany; plik zbiorczy na projekt; próba nic nie pisze", () => {
      const repo = fresh();
      notes(repo);
      const dir = join(DATA_DIR, `vault-${++seq}`);
      const dry = exportVault(repo, { dir, layout: "project", dryRun: true });
      expect(dry.written).toBe(2);
      expect(existsSync(dir)).toBe(false);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Repo.md"), "# Moja notatka\n\nNie ruszać.\n");
      const r = exportVault(repo, { dir, layout: "project" });
      expect(r.conflicts).toEqual([join(dir, "Repo.md")]);
      expect(readFileSync(join(dir, "Repo.md"), "utf8")).toBe("# Moja notatka\n\nNie ruszać.\n");
      const other = readFileSync(join(dir, `${safeName("../Zły:Projekt")}.md`), "utf8");
      expect(other).toContain("## #");
      expect(other).toContain("Decyzja w dziwnym projekcie");
      expect(() => exportVault(repo, { dir: "  " })).toThrow();
      expect(safeName("CON")).toBe("_CON");
      expect(safeName("..")).toBe("bez-nazwy");
    });

    test("projekty różniące się wielkością liter albo końcówką po ucięciu nie piszą do jednego pliku", () => {
      const repo = fresh();
      const long = "p".repeat(90);
      const projects = ["Repo", "repo", `${long}a`, `${long}b`];
      for (const p of projects)
        repo.insertObservation({
          session_id: null,
          project: p,
          type: "decision",
          title: `Decyzja w ${p.slice(-4)}`,
          narrative: `Treść dla ${p.slice(-4)}.`,
          created_at: Date.UTC(2026, 9, 1),
          source: "agent",
        });
      const dir = join(DATA_DIR, `vault-${++seq}`);
      const r = exportVault(repo, { dir, layout: "project" });
      expect(r.written).toBe(4);
      expect(r.conflicts).toEqual([]);
      expect(readdirSync(dir).length).toBe(4);
      const dir2 = join(DATA_DIR, `vault-${++seq}`);
      exportVault(repo, { dir: dir2 });
      expect(readdirSync(dir2).length).toBe(4);
      // ponowny eksport trafia w te same pliki
      expect(exportVault(repo, { dir, layout: "project" }).unchanged).toBe(4);
    });
  });
}
