// Inne harnessy (T-32, T-14): sesje Gemini CLI i Cursora (.txt i .jsonl) tłumaczone na tury, plugin OpenCode, sesje
// Cowork z Claude Desktop, zapis do pamięci z kluczem sesji z przedrostkiem, hooki i ich wyjście, punktowa edycja
// JSONC oraz install, ponowny install, próba i rollback w konfiguracji harnessów (cudze wpisy, komentarze i format
// zostają, rollback oddaje pliki bajt w bajt). Osobny proces: HOME, USERPROFILE, APPDATA, LOCALAPPDATA
// i XDG_CONFIG_HOME wskazują pusty katalog „hipokamp-test-…”, więc żaden test nie widzi prawdziwych ~/.gemini,
// ~/.cursor, ~/.config/opencode ani %APPDATA%\Claude (config.ts zapamiętuje HIPOKAMP_HOME przy imporcie).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const CHILD = "HIPOKAMP_HARNESS_CHILD";
const ROOT = join(import.meta.dir, "..");

if (!process.env[CHILD]) {
  test("inne harnessy (osobny proces, pusty katalog domowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const data = join(home, ".hipokamp");
    mkdirSync(data);
    writeFileSync(join(data, "config.json"), JSON.stringify({ embed: { enabled: false }, backup: { enabled: false } }));
    const set: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      // proces potomny sprawdza katalog domowy i usuwa ten skrót, żeby testować ścieżki z os.homedir()
      HIPOKAMP_HARNESS_HOME: home,
      HIPOKAMP_HOME: data,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
      HIPOKAMP_NO_WORKER: "1",
      HIPOKAMP_PORT: "47987",
      [CHILD]: "1",
    };
    // Windows: klucze środowiska bez rozróżniania wielkości liter; dwa warianty tego samego klucza to loteria
    const env = { ...(process.env as Record<string, string>) };
    const upper = new Set(Object.keys(set).map((k) => k.toUpperCase()));
    for (const k of Object.keys(env)) if (upper.has(k.toUpperCase())) delete env[k];
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/harnesses.test.ts"], { cwd: ROOT, env: { ...env, ...set } });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `harnessy: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy harnessów nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const HOME = homedir();
  for (const [k, v] of Object.entries({
    homedir: HOME,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }))
    if (!v?.includes("hipokamp-test")) throw new Error(`harnessy: ${k} musi wskazywać katalog testowy (${v})`);
  // ścieżki harnessów z os.homedir() (tu: katalog testowy), bez skrótu HIPOKAMP_HARNESS_HOME
  Reflect.deleteProperty(process.env, "HIPOKAMP_HARNESS_HOME");
  const C = await import("../src/config.ts");
  if (!C.DATA_DIR.includes("hipokamp-test") || !C.claudeDir().includes("hipokamp-test"))
    throw new Error("harnessy: HIPOKAMP_HOME i CLAUDE_CONFIG_DIR muszą wskazywać katalog testowy");
  const G = await import("../src/capture/gemini.ts");
  const K = await import("../src/capture/cursor.ts");
  const H = await import("../src/capture/harnesses.ts");
  const O = await import("../src/capture/opencode-plugin.ts");
  const F = await import("../src/capture/formats.ts");
  const E = await import("../src/install/jsonedit.ts");
  const IH = await import("../src/install/harnesses.ts");
  const T = await import("../src/capture/transcript.ts");
  const P = await import("../src/util/paths.ts");
  const PT = await import("../src/capture/private-tools.ts");
  const { getToolUses } = await import("../src/mcp/tooluses.ts");
  const { digestTurn } = await import("../src/capture/digest.ts");
  const { aliasCowork, ingestTranscript } = await import("../src/capture/ingest.ts");
  const { recoverTurns } = await import("../src/capture/recover.ts");
  const { listTranscripts } = await import("../src/importers/backfill.ts");
  const { openDb } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const X = await import("./fixtures/harness/formats.ts");
  const J = await import("./fixtures/capture/jsonl.ts");

  const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";
  const slash = (p: string | null | undefined) => (p ?? "").replace(/\\/g, "/").toLowerCase();
  const put = (p: string, text: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  const read = (p: string, id: string, final: boolean | "complete" = true) =>
    T.readTurns(p, id, 0, { window: 1 << 20, maxWindow: 1 << 24, final });
  const digest = (t: any) => digestTurn(t, { project: "demo", n: 1, privateTools: [], maxNarrativeChars: 1400 });
  const names = (t: any) => t.tools.map((c: any) => c.name);
  // .txt Cursora: ostatni blok domyka się dopiero w cichym pliku (TXT_QUIET_MS)
  const quiet = (p: string) => {
    const t = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  // sekret w kształcie klucza Anthropic, składany w locie (skaner sekretów nie widzi go w repo)
  const SECRET = ["sk", "ant", `api03${"Q7xZ".repeat(8)}`].join("-");

  // katalog projektu (istnieje: Cursor odtwarza go ze sluga po istniejących katalogach)
  const proj = join(HOME, "projekty", "demo-app");
  mkdirSync(proj, { recursive: true });
  // pliki w katalogu tymczasowym streszczenie pomija jako szum: do sprawdzenia kluczy plików tura idzie pod zwykłą ścieżkę
  const FAKE = "D:\\code\\demo-app";
  const relocate = (t: any) => {
    const move = (p: unknown) => (typeof p === "string" && slash(p).startsWith(slash(proj)) ? FAKE + p.slice(proj.length) : p);
    return {
      ...t,
      cwd: FAKE,
      tools: t.tools.map((c: any) => ({ ...c, input: { ...c.input, file_path: move(c.input.file_path) } })),
    };
  };

  describe("pusty katalog domowy", () => {
    test("ścieżki harnessów w katalogu testowym, nic nie wykryte, install niczego nie zakłada", () => {
      for (const d of [G.geminiDir(), K.cursorDir(), H.opencodeDir(), H.claudeDesktopDir()])
        expect(slash(d).startsWith(slash(HOME))).toBe(true);
      for (const h of H.HARNESSES) expect(H.detected(h)).toBe(false);
      expect(H.listHarnessTranscripts()).toEqual([]);
      expect(IH.harnessReport().every((l) => l.startsWith("· "))).toBe(true);
      const log: string[] = [];
      expect(IH.installHarnesses({ dryRun: false, log: (m) => log.push(m) })).toEqual([]);
      expect(log.filter((l) => l.includes("nie ma na tej maszynie")).length).toBe(H.HARNESSES.length);
      for (const d of [G.geminiDir(), K.cursorDir(), H.opencodeDir(), H.claudeDesktopDir()]) expect(existsSync(d)).toBe(false);
    });
  });

  describe("punktowa edycja JSONC", () => {
    const entry = { command: "C:/bun/bun.exe", args: ["D:/x/server.ts"] };
    const jsonc = [
      "{",
      "\t// ustawienia użytkownika",
      '\t"theme": "Default", /* motyw */',
      '\t"mcpServers": {',
      '\t\t"inny": { "command": "inny-serwer", "args": ["--x"] },',
      "\t},",
      "}",
      "",
    ].join("\n");

    test("dopisanie i zdjęcie wpisu: komentarze, tabulatory i przecinek na końcu zostają, powrót bajt w bajt", () => {
      const added = E.setAt(jsonc, ["mcpServers", "hipokamp"], entry);
      expect(added).toContain("\t// ustawienia użytkownika\n");
      expect(added).toContain("/* motyw */");
      expect(added).toContain('\t\t"hipokamp": {\n\t\t\t"command": "C:/bun/bun.exe",');
      expect(E.readJsonc(added)).toEqual({
        theme: "Default",
        mcpServers: { inny: { command: "inny-serwer", args: ["--x"] }, hipokamp: entry },
      });
      expect(E.getAt(added, ["mcpServers", "hipokamp", "args", "0"])).toBe("D:/x/server.ts");
      expect(E.getAt(added, ["mcpServers", "hipokamp", "args", "1"])).toBeUndefined();
      expect(E.removeAt(added, ["mcpServers", "hipokamp"])).toBe(jsonc);
      // zastąpienie wartości w jej miejscu
      const moved = E.setAt(added, ["mcpServers", "hipokamp"], { command: "bun" });
      expect(E.readJsonc(moved).mcpServers.hipokamp).toEqual({ command: "bun" });
      expect(E.removeAt(moved, ["mcpServers", "hipokamp"])).toBe(jsonc);
    });

    test("brakujące obiekty po drodze: zakładane i zdejmowane; cudzy pusty obiekt zostaje", () => {
      const one = '{"a": 1}';
      const two = E.setAt(one, ["b", "c"], 2);
      expect(two).toBe('{"a": 1, "b": {"c": 2}}');
      expect(E.removeAt(two, ["b", "c"])).toBe(one);
      // pusty obiekt, którego nie założyliśmy (prune: nie), zostaje pusty
      const crlf = '{\r\n  "mcpServers": {},\r\n  "x": true\r\n}\r\n';
      const withEntry = E.setAt(crlf, ["mcpServers", "hipokamp"], entry);
      expect(/(?<!\r)\n/.test(withEntry)).toBe(false);
      // pusty kontener w jednej linii: wpis w tej samej linii (zdjęcie oddaje `{}` bajt w bajt)
      expect(withEntry).toContain('"mcpServers": {"hipokamp": {"command": "C:/bun/bun.exe", "args": ["D:/x/server.ts"]}},\r\n');
      expect(E.removeAt(withEntry, ["mcpServers", "hipokamp"], () => false)).toBe(crlf);
      expect(E.readJsonc(E.removeAt(withEntry, ["mcpServers", "hipokamp"]))).toEqual({ x: true });
      // pusty plik: cały dokument
      expect(E.readJsonc(E.setAt("", ["mcpServers", "hipokamp"], entry))).toEqual({ mcpServers: { hipokamp: entry } });
      expect(() => E.readJsonc('{ "a": 1 "b": 2 }')).toThrow();
      expect(() => E.setAt("{ /* niezamknięty", ["a"], 1)).toThrow();
    });

    test("tablice: dopisanie na końcu, usunięcie po warunku, pusta tablica znika tylko wskazana", () => {
      const doc = '{\n  "hooks": {\n    "Stop": [\n      { "command": "inne" }\n    ]\n  }\n}\n';
      const ours = { command: "bun hipokamp/src/hooks/hook.ts stop" };
      const a = E.appendAt(doc, ["hooks", "Stop"], ours);
      const b = E.appendAt(a, ["hooks", "Start"], ours);
      expect(E.readJsonc(b).hooks).toEqual({ Stop: [{ command: "inne" }, ours], Start: [ours] });
      const isOurs = (v: any) => String(v?.command).includes("hipokamp");
      const r = E.removeFromArray(b, ["hooks", "Start"], isOurs);
      expect(r.removed).toBe(1);
      expect(E.removeFromArray(r.text, ["hooks", "Stop"], isOurs).text).toBe(doc);
      // bez zgody na usunięcie pusta tablica zostaje
      expect(E.readJsonc(E.removeFromArray(b, ["hooks", "Start"], isOurs, () => false).text).hooks.Start).toEqual([]);
    });

    test("pusty kontener z odstępami i komentarzami: treść między nawiasami zostaje, zdjęcie bajt w bajt", () => {
      const ours = { command: "bun hipokamp/src/hooks/hook.ts stop" };
      const objects = [
        '{"mcpServers": {}}',
        '{"mcpServers": { }}',
        '{\n  "mcpServers": {\n  }\n}\n',
        '{\n  "mcpServers": {\n    // tu dopisz serwery\n  }\n}\n',
        '{\n\t"mcpServers": { /* pusto */ }\n}\n',
        '{\r\n  "mcpServers": {\r\n    // komentarz\r\n  },\r\n  "x": 1\r\n}\r\n',
      ];
      for (const text of objects) {
        const added = E.setAt(text, ["mcpServers", "hipokamp"], entry);
        expect(E.readJsonc(added).mcpServers).toEqual({ hipokamp: entry });
        for (const c of ["// tu dopisz serwery", "/* pusto */", "// komentarz"]) if (text.includes(c)) expect(added).toContain(c);
        expect(E.removeAt(added, ["mcpServers", "hipokamp"], () => false)).toBe(text);
      }
      const arrays = [
        '{"hooks": {"Stop": []}}',
        '{\n  "hooks": {\n    "Stop": [\n    ]\n  }\n}\n',
        '{"hooks": {"Stop": [ /* x */ ]}}',
      ];
      for (const text of arrays) {
        const added = E.appendAt(text, ["hooks", "Stop"], ours);
        expect(E.readJsonc(added).hooks.Stop).toEqual([ours]);
        expect(
          E.removeFromArray(
            added,
            ["hooks", "Stop"],
            () => true,
            () => false,
          ).text,
        ).toBe(text);
      }
      // pusty dokument rozpisany na linie
      for (const text of ["{\n}\n", "{ }", "{\n  // pusty\n}\n"]) {
        const added = E.setAt(text, ["mcpServers", "hipokamp"], entry);
        expect(E.readJsonc(added)).toEqual({ mcpServers: { hipokamp: entry } });
        expect(E.removeAt(added, ["mcpServers", "hipokamp"])).toBe(text);
      }
    });

    test("powtórzony klucz: liczy się ostatni (jak w JSON.parse), także przy zapisie i usunięciu", () => {
      const dup = '{"a": {"x": 1}, "a": {"y": 2}}';
      expect(E.getAt(dup, ["a"])).toEqual({ y: 2 });
      expect(E.setAt(dup, ["a", "z"], 3)).toBe('{"a": {"x": 1}, "a": {"y": 2, "z": 3}}');
      expect(E.removeAt(E.setAt(dup, ["a", "z"], 3), ["a", "z"])).toBe(dup);
      expect(E.setAt('{"k": 1, "k": 2}', ["k"], 5)).toBe('{"k": 1, "k": 5}');
      // długa liczba i literały po długim napisie
      const long = `{"n": ${"9".repeat(80)}, "s": "${"x".repeat(100)}", "t": true}`;
      expect(E.getAt(long, ["t"])).toBe(true);
    });
  });

  // ── Gemini CLI ──────────────────────────────────────────────────────────────────────────────────────────
  const gChats = join(HOME, ".gemini", "tmp", "demo-hash", "chats");
  const gMain = join(gChats, "session-2026-10-05T09-00-0a1b2c3d.jsonl");
  const gSub = join(gChats, "session-2026-10-05T09-05-0a1b2c3e.jsonl");
  const SUB_ID = "0a1b2c3d-0000-4000-8000-00000000a002";

  describe("Gemini CLI: sesje z ~/.gemini/tmp/*/chats", () => {
    let b: ReturnType<typeof read>;
    beforeAll(() => {
      put(join(HOME, ".gemini", "tmp", "demo-hash", ".project_root"), proj);
      put(gMain, J.jsonl(X.geminiSession()));
      put(gSub, J.jsonl(X.geminiSession(SUB_ID, "subagent")));
      // podagent w katalogu rodzica: piętro niżej, poza wzorcem pliku sesji
      put(join(gChats, X.GEMINI_ID, "session-x.jsonl"), J.jsonl(X.geminiSession(SUB_ID, "subagent")));
      b = read(gMain, `gemini:${X.GEMINI_ID}`);
    });

    test("lista: klucz z przedrostkiem gemini:, bez podagentów; wykrycie po katalogu tmp", () => {
      expect(H.detected("gemini")).toBe(true);
      expect(G.isGeminiTranscript(gMain)).toBe(true);
      expect(G.isGeminiTranscript(join(gChats, X.GEMINI_ID, "session-x.jsonl"))).toBe(false);
      expect(G.listGeminiChats().map((f) => [f.sessionId, f.path])).toEqual([[`gemini:${X.GEMINI_ID}`, gMain]]);
      expect(F.isSubagentTranscript(gSub)).toBe(true);
      expect(F.isSubagentTranscript(gMain)).toBe(false);
    });

    test("tury: prompt, przyrost tekstu bez powtórek, narzędzia z wynikami, komenda z ukośnikiem", () => {
      const [t1, t2] = b.turns;
      expect(b.turns.map((t) => t.kind)).toEqual(["human", "command"]);
      expect(t1.prompt).toBe("dodaj moduł nowy i uruchom testy w projekcie demo");
      expect(t1.key).toBe("u1");
      expect(t1.model).toBe("gemini-test");
      expect(t1.texts).toEqual(["Czytam app.ts i dodaję moduł.", "Dodałem src/nowy.ts; jeden test nie przechodzi."]);
      expect(names(t1)).toEqual(["Read", "Write", SHELL]);
      expect(t1.tools.map((c) => c.isError)).toEqual([false, false, true]);
      expect(slash(t1.tools[0].input.file_path)).toBe(slash(join(proj, "src", "app.ts")));
      expect(t1.tools[0].result).toBe("export {}");
      expect(t1.tools[1].structured).toMatchObject({ type: "create" });
      expect(t2.prompt).toBe("/memory show");
      expect(slash(t1.cwd)).toBe(slash(proj));
    });

    test("streszczenie: nowy plik, bez tury trywialnej", () => {
      const d = digest(relocate(b.turns[0]));
      expect(d.skip).toBe(false);
      expect(d.obs?.files_modified).toEqual(["src/nowy.ts"]);
      expect(d.obs?.files_read).toEqual(["src/app.ts"]);
    });

    test("bez końca tury w pliku: nadrabianie czeka na następny prompt albo hook", () => {
      const waiting = read(gMain, `gemini:${X.GEMINI_ID}`, "complete");
      expect(waiting.turns.map((t) => t.prompt)).toEqual(["dodaj moduł nowy i uruchom testy w projekcie demo"]);
      expect(waiting.offset).toBeLessThan(waiting.size);
    });

    test("tura większa niż okno odczytu: wersje wiadomości po obu stronach granicy bez powtórek", () => {
      // każda wersja wiadomości powtarza wcześniejsze wyniki (po 300 KB): tura nie mieści się w oknie 1 MB
      const big = "x".repeat(300 * 1024);
      const call = (i: number) => ({
        id: `c${i}`,
        name: "read_file",
        args: { file_path: `src/f${i}.ts` },
        status: "success",
        result: [{ functionResponse: { response: { output: big } } }],
      });
      const lines: object[] = [
        { sessionId: "okno", projectHash: "demo", startTime: "2026-10-05T09:00:00Z", kind: "main" },
        { id: "u1", timestamp: "2026-10-05T09:00:01Z", type: "user", content: [{ text: "przeczytaj pliki f1..f4 i podsumuj" }] },
      ];
      for (let k = 1; k <= 4; k++)
        lines.push({
          id: "g1",
          timestamp: "2026-10-05T09:00:02Z",
          type: "gemini",
          content: "Czytam pliki.",
          toolCalls: Array.from({ length: k }, (_, i) => call(i + 1)),
        });
      lines.push({ id: "g2", timestamp: "2026-10-05T09:00:09Z", type: "gemini", content: "Podsumowanie: cztery pliki." });
      const f = put(join(gChats, "session-2026-10-05T10-00-0a1b2c3f.jsonl"), J.jsonl(lines));
      try {
        for (const win of [1 << 20, 64 << 20]) {
          const r = T.readTurns(f, "gemini:okno", 0, { window: win, maxWindow: 256 << 20, final: true });
          expect(r.turns.length).toBe(1);
          expect(r.turns[0].tools.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
          expect(r.turns[0].texts).toEqual(["Czytam pliki.", "Podsumowanie: cztery pliki."]);
        }
      } finally {
        rmSync(f);
      }
    });

    test("narzędzia MCP: goła nazwa z displayName i serwer__narzędzie jako mcp__serwer__narzędzie", () => {
      const f = put(join(gChats, "session-2026-10-05T11-00-0a1b2c40.jsonl"), J.jsonl(X.geminiPrivateSession("prywatna", SECRET)));
      try {
        const t = read(f, "gemini:prywatna").turns[0];
        expect(names(t)).toEqual(["mcp__sejf__write_env", "mcp__sejf__list_secrets"]);
      } finally {
        rmSync(f);
      }
    });

    test("wejście hooka: przedrostek klucza raz, absolute_path jako file_path", () => {
      const i = H.hookInput("gemini", { session_id: X.GEMINI_ID, tool_input: { absolute_path: "D:/x/a.ts" } });
      expect(i.session_id).toBe(`gemini:${X.GEMINI_ID}`);
      expect(i.tool_input.file_path).toBe("D:/x/a.ts");
      expect(H.hookInput("gemini", i).session_id).toBe(`gemini:${X.GEMINI_ID}`);
    });
  });

  // ── Cursor ──────────────────────────────────────────────────────────────────────────────────────────────
  const CURSOR2 = "0a1b2c3d-0000-4000-8000-00000000c002";
  const cDir = join(HOME, ".cursor", "projects", K.cursorSlug(proj), "agent-transcripts");
  const cTxt = join(cDir, `${X.CURSOR_ID}.txt`);
  const cJsonl = join(cDir, CURSOR2, `${CURSOR2}.jsonl`);

  describe("Cursor: transkrypty agenta (.txt i .jsonl)", () => {
    beforeAll(() => {
      quiet(put(cTxt, X.cursorTxt()));
      put(cJsonl, J.jsonl(X.cursorJsonl()));
    });

    test("slug katalogu w obie strony, lista z przedrostkiem cursor:, szukanie po id rozmowy", () => {
      expect(slash(K.slugToPath(K.cursorSlug(proj)))).toBe(slash(proj));
      expect(K.slugToPath("brak-takiego-katalogu-xyz")).toBeNull();
      // „..” i „.” w slugu nie wyprowadzają ścieżki poza katalog ze sluga
      const projekty = K.cursorSlug(join(HOME, "projekty"));
      expect(K.slugToPath(`${projekty}-..-projekty-demo-app`)).toBeNull();
      expect(K.slugToPath(`${projekty}---demo-app`)).toBeNull();
      expect(K.slugToPath(`${projekty}-demo-app-`)).toBeNull();
      const listed = K.listCursorTranscripts().map((f) => [f.sessionId, f.path]);
      expect(listed.sort()).toEqual(
        [
          [`cursor:${CURSOR2}`, cJsonl],
          [`cursor:${X.CURSOR_ID}`, cTxt],
        ].sort(),
      );
      expect(K.findCursorTranscript(X.CURSOR_ID, proj)).toBe(cTxt);
      expect(K.findCursorTranscript(CURSOR2, null)).toBe(cJsonl);
      expect(K.findCursorTranscript("../../etc", proj)).toBeNull();
    });

    test(".txt: bloki ról, myślenie pominięte, narzędzia z parametrami, dwie tury", () => {
      const b = read(cTxt, `cursor:${X.CURSOR_ID}`);
      expect(b.offset).toBe(b.size);
      const [t1, t2] = b.turns;
      expect(b.turns.map((t) => t.prompt)).toEqual([
        "napraw błąd w module demo, który psuje logowanie",
        "a teraz dopisz test regresji dla logowania",
      ]);
      expect(t1.texts).toEqual(["Sprawdzam moduł logowania.", "Poprawiłem warunek w src/login.ts."]);
      expect(names(t1)).toEqual(["Read", SHELL, "Edit"]);
      expect(t1.tools[1].input.command).toBe("bun test");
      expect(slash(t1.tools[2].input.file_path)).toBe(slash(join(proj, "src", "login.ts")));
      expect(names(t2)).toEqual(["Write"]);
      expect(slash(t1.cwd)).toBe(slash(proj));
      expect(digest(relocate(t1)).obs?.files_modified).toEqual(["src/login.ts"]);
    });

    test(".txt czytany oknem: niedomknięty blok czeka, offset na jego początku", () => {
      const text = X.cursorTxt();
      const at = (n: number) => {
        let i = -1;
        for (let k = 0; k < n; k++) i = text.indexOf("assistant:\n", i + 1);
        return Buffer.byteLength(text.slice(0, i));
      };
      const third = at(3);
      const head = T.readLinesFrom(cTxt, 0, third + 15);
      expect(head.end).toBe(third);
      expect(head.lines.map((l) => l.json.type)).toEqual(["user", "assistant", "assistant"]);
      const rest = T.readLinesFrom(cTxt, head.end);
      expect(rest.lines.map((l) => l.json.type)).toEqual(["assistant", "user", "assistant", "assistant"]);
      expect(rest.end).toBe(rest.size);
    });

    test(".txt dopisywany: tura czeka na następny prompt, odczyt od offsetu ją domyka", () => {
      const p = put(join(HOME, "kopie", "agent-transcripts", `${X.CURSOR_ID}.txt`), X.cursorTxt());
      const first = read(p, "cursor:kopia", "complete");
      expect(first.turns.length).toBe(1);
      appendFileSync(p, "\n\nuser:\n<user_query>\ndziękuję\n</user_query>");
      // plik jeszcze pisany: ostatni blok (prompt) czeka, więc tura przed nim też
      const opts = { window: 1 << 20, maxWindow: 1 << 24, final: "complete" as const };
      expect(T.readTurns(p, "cursor:kopia", first.offset, opts).turns).toEqual([]);
      quiet(p);
      const next = T.readTurns(p, "cursor:kopia", first.offset, opts);
      expect(next.turns.map((t) => t.prompt)).toEqual(["a teraz dopisz test regresji dla logowania"]);
      expect(next.turns[0].key).toBe(`cursor:kopia:${first.offset}`);
      // ostatni prompt bez odpowiedzi czeka dalej
      expect(next.offset).toBeLessThan(next.size);
    });

    test(".txt z blokiem w trakcie pisania: offset nie przechodzi za jego początek, aż plik ucichnie", () => {
      const p = put(
        join(HOME, "kopie2", "agent-transcripts", `${X.CURSOR_ID}.txt`),
        ["user:", "<user_query>", "napraw logowanie w module demo", "</user_query>", "", "assistant:", "Sprawdzam moduł."].join(
          "\n",
        ),
      );
      const opts = (final: boolean | "complete") => ({ window: 1 << 20, maxWindow: 1 << 24, final });
      // Stop przychodzi, a Cursor jeszcze dopisuje odpowiedź: nic nie idzie do pamięci, offset na początku tury
      const a = T.readTurns(p, "cursor:pisany", 0, opts(true));
      expect(a.turns).toEqual([]);
      expect(a.offset).toBe(0);
      appendFileSync(p, "\nPoprawiłem warunek w src/login.ts; DECYZJA: sesja trzymana w cookie httpOnly.");
      expect(T.readTurns(p, "cursor:pisany", a.offset, opts(true)).turns).toEqual([]);
      // plik ucichł: blok skończony, odpowiedź asystenta na końcu kończy turę (nadrabianie nie czeka 12 h)
      quiet(p);
      const b = T.readTurns(p, "cursor:pisany", a.offset, opts("complete"));
      expect(b.turns.map((t) => t.prompt)).toEqual(["napraw logowanie w module demo"]);
      expect(b.turns[0].texts.join("\n")).toContain("DECYZJA: sesja trzymana w cookie httpOnly.");
      expect(b.offset).toBe(b.size);
    });

    test(".txt i .jsonl ze slugiem, którego nie da się odtworzyć: projekt pod stałym kluczem ze sluga", () => {
      const slug = "d-code-dawno-usuniety-projekt";
      const p = quiet(put(join(HOME, ".cursor", "projects", slug, "agent-transcripts", "stary.txt"), X.cursorTxt()));
      try {
        const t = read(p, "cursor:stary").turns[0];
        expect(basename(t.cwd ?? "")).toBe(slug);
        expect(P.projectFromCwd(t.cwd)).toBe(slug);
      } finally {
        rmSync(join(HOME, ".cursor", "projects", slug), { recursive: true, force: true });
      }
    });

    test(".jsonl: role zamiast type, prompt z <user_query>, odpowiedź tekstowa", () => {
      const b = read(cJsonl, `cursor:${CURSOR2}`);
      expect(b.turns.map((t) => t.prompt)).toEqual(["opisz architekturę modułu płatności w demo", "dzięki"]);
      expect(b.turns[0].texts[0]).toStartWith("Moduł płatności ma trzy warstwy");
      expect(digest(b.turns[0]).skip).toBe(false);
      expect(slash(b.turns[0].cwd)).toBe(slash(proj));
    });

    test("wejście hooka: conversation_id, katalog z workspace_roots, transkrypt po id", () => {
      const i = H.hookInput("cursor", { conversation_id: X.CURSOR_ID, workspace_roots: [proj], hook_event_name: "stop" });
      expect(i.session_id).toBe(`cursor:${X.CURSOR_ID}`);
      expect(i.cwd).toBe(proj);
      expect(i.transcript_path).toBe(cTxt);
    });

    test("slug jak w Cursorze 2.6: ciąg myślników jako jeden, bez myślników na brzegach", () => {
      expect(K.cursorSlug("D:\\code\\a - b")).toBe("D-code-a-b");
      expect(K.cursorSlug("/home/u/proj.x/")).toBe("home-u-proj-x");
      const spaced = join(HOME, "projekty", "moja - apka");
      mkdirSync(spaced, { recursive: true });
      expect(slash(K.slugToPath(K.cursorSlug(spaced)))).toBe(slash(spaced));
    });

    test("wejście hooka postToolUse: plik z `path` (względny od projektu), narzędzia bez pliku bez file_path", () => {
      const base = { conversation_id: X.CURSOR_ID, workspace_roots: [proj], hook_event_name: "postToolUse" };
      const read = H.hookInput("cursor", { ...base, tool_name: "Read", tool_input: { path: "src/login.ts", offset: 1 } });
      expect(slash(read.tool_input.file_path)).toBe(slash(join(proj, "src", "login.ts")));
      expect(read.tool_input.offset).toBe(1);
      const edit = H.hookInput("cursor", { ...base, tool_name: "StrReplace", tool_input: { path: join(proj, "a.ts") } });
      expect(slash(edit.tool_input.file_path)).toBe(slash(join(proj, "a.ts")));
      // Grep i ReadLints mają katalog albo listę ścieżek: bez przypomnienia
      for (const [tool_name, tool_input] of [
        ["Grep", { pattern: "x", path: proj }],
        ["ReadLints", { paths: ["a.ts"] }],
        ["Shell", { command: "bun test", cwd: proj }],
      ] as const)
        expect(H.hookInput("cursor", { ...base, tool_name, tool_input }).tool_input.file_path).toBeUndefined();
    });
  });

  // ── Claude Desktop (Cowork) ─────────────────────────────────────────────────────────────────────────────
  const DESK = "0a1b2c3d-0000-4000-8000-00000000d001";
  const DESK2 = "0a1b2c3d-0000-4000-8000-00000000d002";
  const deskRoot = join(H.claudeDesktopDir(), "local-agent-mode-sessions");
  const dMain = join(deskRoot, "konto", "org", "local_sesja1", ".claude", "projects", "-sessions-demo", `${DESK}.jsonl`);
  const dAgent = join(deskRoot, "konto", "org", "agent", "a1", ".claude", "projects", "-sessions-agent", `${DESK2}.jsonl`);
  const cowork = (id: string) => {
    const c = { sessionId: id, cwd: proj };
    return J.jsonl([
      J.userPrompt(c, X.T0, "przygotuj raport z danych sprzedaży w demo"),
      J.toolCall(c, X.T0 + 1000, "t1", "python raport.py", "Liczę raport."),
      J.toolOutput(c, X.T0 + 2000, "t1", "ok"),
      J.reply(
        c,
        X.T0 + 3000,
        "Raport gotowy: sprzedaż wzrosła o 12% r/r, największy wzrost w regionie północnym; szczegóły w pliku raport.md w katalogu wyjściowym sesji.",
      ),
    ]);
  };

  describe("Claude Desktop: sesje Cowork", () => {
    beforeAll(() => {
      put(dMain, cowork(DESK));
      put(dAgent, cowork(DESK2));
    });

    test("sesje i agent stały, klucz z przedrostkiem desktop:", () => {
      expect(H.detected("claude-desktop")).toBe(true);
      expect(
        H.listDesktopTranscripts()
          .map((f) => [f.sessionId, f.path])
          .sort(),
      ).toEqual(
        [
          [`desktop:${DESK}`, dMain],
          [`desktop:${DESK2}`, dAgent],
        ].sort(),
      );
    });
  });

  // ── OpenCode ────────────────────────────────────────────────────────────────────────────────────────────
  const ocFile = join(H.opencodeTranscripts(), `${X.OPENCODE_ID}.jsonl`);

  describe("OpenCode: plugin zapisu sesji", () => {
    test("session.idle: zapis wiadomości w kształcie Claude Code, hook Stop, bez powtórek i podagentów", async () => {
      let msgs = X.opencodeMessages(proj, false);
      const client = {
        session: {
          get: async ({ path }: any) => ({
            data: path.id === "ses_sub" ? { id: "ses_sub", parentID: X.OPENCODE_ID } : { id: path.id },
          }),
          messages: async ({ path }: any) => ({
            data: path.id === X.OPENCODE_ID ? msgs : [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "x" }] }],
          }),
        },
      };
      const spawned: { cmd: string[]; stdin: any; env: Record<string, string> }[] = [];
      const plugin = await O.default({
        dir: H.opencodeTranscripts(),
        bun: "bun-test",
        hook: "hook.ts",
        spawn: (cmd, stdin, env) => spawned.push({ cmd, stdin: JSON.parse(stdin), env }),
      })({ client, directory: proj });
      const idle = (id: string) => plugin.event({ event: { type: "session.idle", properties: { sessionID: id } } });
      const lines = () =>
        readFileSync(ocFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));

      // odpowiedź jeszcze się pisze: tylko prompt
      await idle(X.OPENCODE_ID);
      expect(lines().map((l) => l.type)).toEqual(["user"]);
      msgs = X.opencodeMessages(proj, true);
      await idle(X.OPENCODE_ID);
      await idle(X.OPENCODE_ID);
      await idle("ses_sub");
      await plugin.event({ event: { type: "session.updated", properties: { sessionID: X.OPENCODE_ID } } });
      expect(lines().map((l) => [l.type, l.uuid])).toEqual([
        ["user", "msg_u1"],
        ["assistant", "msg_a1"],
        ["user", "msg_a1#wyniki"],
        ["assistant", "msg_a1#koniec"],
      ]);
      expect(existsSync(join(H.opencodeTranscripts(), "ses_sub.jsonl"))).toBe(false);
      expect(readFileSync(ocFile, "utf8")).not.toContain("TAJNE");
      expect(spawned.length).toBe(2);
      expect(spawned[1].cmd).toEqual(["bun-test", "hook.ts", "stop", "opencode"]);
      expect(spawned[1].stdin).toEqual({
        session_id: X.OPENCODE_ID,
        transcript_path: ocFile,
        cwd: proj,
        hook_event_name: "Stop",
      });
      expect(spawned[1].env.CLAUDE_PROJECT_DIR).toBe(proj);

      // plugin po restarcie OpenCode: zapisane wiadomości poznaje po pliku
      const again = await O.default({ dir: H.opencodeTranscripts(), spawn: () => spawned.push({} as any) })({
        client,
        directory: proj,
      });
      await again.event({ event: { type: "session.idle", properties: { sessionID: X.OPENCODE_ID } } });
      expect(lines().length).toBe(4);
    });

    test("transkrypt pluginu jako tura: narzędzia, błąd komendy, koniec tury, sejf bez treści", () => {
      const b = read(ocFile, `opencode:${X.OPENCODE_ID}`, "complete");
      expect(b.turns.length).toBe(1);
      const t = b.turns[0];
      expect(t.prompt).toBe("zmień port serwera demo na 8081 i uruchom testy");
      expect(names(t)).toEqual(["Read", "Edit", "Bash", "sejf_reveal_secret"]);
      expect(t.tools.map((c) => c.isError)).toEqual([false, false, true, false]);
      expect(t.tools[3].input).toEqual({});
      expect(t.texts).toEqual(["Port zmieniony na 8081 w server.ts; jeden test nie przechodzi."]);
      expect(digest(relocate(t)).obs?.files_modified).toEqual(["server.ts"]);
    });

    test("prywatność: clean() na tekstach, komendach i wynikach, privateTools z config.json, wyłączony harness nic nie pisze", async () => {
      const dir = join(HOME, "oc-prywatnosc");
      const cfg = join(HOME, "oc-config.json");
      writeFileSync(cfg, JSON.stringify({ capture: { privateTools: ["mcp__mojserwer__"] } }));
      const msgs = [
        { info: { id: "u1", role: "user", time: { created: X.T0 } }, parts: [{ type: "text", text: `użyj klucza ${SECRET}` }] },
        {
          info: { id: "a1", role: "assistant", time: { created: X.T0 + 1, completed: X.T0 + 2 }, finish: "stop" },
          parts: [
            {
              type: "tool",
              callID: "c1",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: `curl -H "x-api-key: ${SECRET}" demo` },
                output: `odpowiedź ${SECRET}`,
              },
            },
            {
              type: "tool",
              callID: "c2",
              tool: "mojserwer_pobierz",
              state: { status: "completed", input: { co: "tajne-wejscie" }, output: "tajny-wynik" },
            },
            { type: "text", text: `Gotowe, klucz ${SECRET} działa.` },
          ],
        },
      ];
      let calls = 0;
      const client = {
        session: {
          messages: async () => {
            calls++;
            return { data: msgs };
          },
        },
      };
      const plugin = await O.default({ dir, config: cfg })({ client, directory: proj });
      const idle = (p: any, id: string) => p.event({ event: { type: "session.idle", properties: { sessionID: id } } });
      await idle(plugin, "ses_p");
      const text = readFileSync(join(dir, "ses_p.jsonl"), "utf8");
      for (const s of [SECRET, "tajne-wejscie", "tajny-wynik"]) expect(text).not.toContain(s);
      expect(text).toContain("[REDACTED:anthropic-key]");
      expect(text).toContain("mojserwer_pobierz");
      // capture.harnesses.opencode: false (zmiana w config.json działa bez restartu OpenCode)
      writeFileSync(cfg, JSON.stringify({ capture: { harnesses: { opencode: false } } }));
      await idle(plugin, "ses_q");
      expect(existsSync(join(dir, "ses_q.jsonl"))).toBe(false);
      expect(calls).toBe(1);
      // OpenCode nie odpowiada: plugin nie wisi i nic nie pisze
      const hung = await O.default({ dir, timeoutMs: 50 })({
        client: { session: { get: () => new Promise(() => {}), messages: () => new Promise(() => {}) } },
        directory: proj,
      });
      const t0 = Date.now();
      await idle(hung, "ses_r");
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(existsSync(join(dir, "ses_r.jsonl"))).toBe(false);
      rmSync(dir, { recursive: true, force: true });
      rmSync(cfg);
    });

    test("sprzątanie: stary przeczytany transkrypt znika, wznowiona sesja ma nowy plik tylko z nowymi wiadomościami", async () => {
      const dir = H.opencodeTranscripts();
      const old = (Date.now() - 40 * 86_400_000) / 1000;
      const mk = (name: string, age: number | null) => {
        const p = put(join(dir, `${name}.jsonl`), '{"type":"user","uuid":"m0"}\n');
        if (age !== null) utimesSync(p, age, age);
        return p;
      };
      const cfg = C.loadConfig();
      const withOc = (opencode: boolean | null, keep = 30) => ({
        ...cfg,
        capture: { ...cfg.capture, opencodeKeepDays: keep, harnesses: { ...cfg.capture.harnesses, opencode } },
      });
      const files = ["ses_stary", "ses_nieprzeczytany", "ses_nowy"];
      try {
        mk("ses_stary", old);
        mk("ses_nieprzeczytany", old);
        mk("ses_nowy", null);
        const consumed = (id: string) => id !== "opencode:ses_nieprzeczytany";
        expect(H.pruneOpencodeTranscripts(withOc(true, 0), consumed)).toBe(0);
        expect(H.pruneOpencodeTranscripts(withOc(true), consumed)).toBe(1);
        expect(files.map((f) => existsSync(join(dir, `${f}.jsonl`)))).toEqual([false, true, true]);
        expect(existsSync(ocFile)).toBe(true);
        // zapis OpenCode wyłączony: nikt już nie przeczyta, więc stary plik znika też nieprzeczytany
        expect(H.pruneOpencodeTranscripts(withOc(false), () => false)).toBe(1);
        const pruned = JSON.parse(readFileSync(join(dir, O.PRUNED_FILE), "utf8"));
        expect(Object.keys(pruned).sort()).toEqual(["ses_nieprzeczytany", "ses_stary"]);

        // sesja wznowiona po sprzątnięciu: nowy plik ses_stary.2 tylko z wiadomościami nowszymi od sprzątniętego pliku
        const { name, after } = O.transcriptName(dir, "ses_stary");
        expect(name).toBe("ses_stary.2");
        expect(after).toBe(pruned.ses_stary);
        const msg = (id: string, created: number, text: string) => ({
          info: { id, role: "user", time: { created } },
          parts: [{ type: "text", text }],
        });
        const spawned: any[] = [];
        const plugin = await O.default({
          dir,
          bun: "bun-test",
          hook: "hook.ts",
          spawn: (_c, stdin) => spawned.push(JSON.parse(stdin)),
        })({
          client: {
            session: {
              messages: async () => ({ data: [msg("m0", after - 1000, "stary prompt"), msg("m1", Date.now(), "nowy prompt")] }),
            },
          },
          directory: proj,
        });
        await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_stary" } } });
        const lines = readFileSync(join(dir, "ses_stary.2.jsonl"), "utf8").trim().split("\n");
        expect(lines.map((l) => JSON.parse(l).uuid)).toEqual(["m1"]);
        expect(spawned[0].session_id).toBe("ses_stary.2");
      } finally {
        for (const f of [...files, "ses_stary.2"]) rmSync(join(dir, `${f}.jsonl`), { force: true });
        rmSync(join(dir, O.PRUNED_FILE), { force: true });
      }
    });

    test("kontekst: start w promptcie systemowym (stały), prompt w wiadomości użytkownika; limit i wyłączenie to cisza", async () => {
      const calls: { cmd: string[]; stdin: any; ms: number }[] = [];
      const out = (t: string) => JSON.stringify({ hookSpecificOutput: { additionalContext: t } });
      const run = async (cmd: string[], stdin: string, _env: Record<string, string>, ms: number) => {
        calls.push({ cmd, stdin: JSON.parse(stdin), ms });
        return cmd[2] === "session-start" ? out("# Pamięć projektu") : out(`przy prompcie: ${JSON.parse(stdin).prompt}`);
      };
      const cfg = join(HOME, "oc-kontekst.json");
      writeFileSync(cfg, "{}");
      const p: any = await O.default({ dir: join(HOME, "oc-kontekst"), bun: "bun-test", hook: "hook.ts", config: cfg, run })({
        client: {},
        directory: proj,
      });
      const msg = async (sessionID: string | undefined, text: string, extra: object[] = []) => {
        const o = {
          message: { id: "msg_1", sessionID },
          parts: [{ id: "prt_a1", sessionID, messageID: "msg_1", type: "text", text }, ...extra] as any[],
        };
        await p["chat.message"](sessionID ? { sessionID } : {}, o);
        return o.parts;
      };
      const system = async (input: object) => {
        const o = { system: ["podstawa"] };
        await p["experimental.chat.system.transform"](input, o);
        return o.system;
      };
      const parts = await msg("ses_k", "jak działa logowanie w demo?", [{ type: "text", text: "<plik>", synthetic: true }]);
      // przypomnienie jako syntetyczna część wiadomości użytkownika, za jej częścią (id sortuje się po niej)
      expect(parts.length).toBe(3);
      expect(parts[2]).toEqual({
        id: "prt_a1hk",
        sessionID: "ses_k",
        messageID: "msg_1",
        type: "text",
        text: "przy prompcie: jak działa logowanie w demo?",
        synthetic: true,
      });
      // prompt systemowy: tylko kontekst startu, ten sam przy każdej wiadomości (pamięć podręczna rozmowy działa)
      expect(await system({ sessionID: "ses_k" })).toEqual(["podstawa", "# Pamięć projektu"]);
      const parts2 = await msg("ses_k", "a rejestracja?");
      expect(parts2.at(-1).text).toBe("przy prompcie: a rejestracja?");
      expect(await system({ sessionID: "ses_k" })).toEqual(["podstawa", "# Pamięć projektu"]);
      expect(calls.map((c) => c.cmd[2])).toEqual(["session-start", "prompt", "prompt"]);
      expect(calls[0].cmd).toEqual(["bun-test", "hook.ts", "session-start", "opencode"]);
      expect(calls[1].stdin).toMatchObject({ session_id: "ses_k", cwd: proj, hook_event_name: "UserPromptSubmit" });
      expect(calls.map((c) => c.ms)).toEqual([8000, 5000, 5000]);
      // bez id sesji: nic nie trafia do modelu (ani do wiadomości, ani do promptu systemowego)
      calls.length = 0;
      expect((await msg(undefined, "pytanie bez sesji")).length).toBe(1);
      expect(await system({})).toEqual(["podstawa"]);
      expect(calls).toEqual([]);
      // sesja bez wiadomości w tym procesie: nic
      expect(await system({ sessionID: "ses_inna" })).toEqual(["podstawa"]);

      // hook, który nie odpowiada: wiadomość i model ruszają po limicie, bez kontekstu
      const hung: any = await O.default({
        dir: join(HOME, "oc-kontekst"),
        bun: "b",
        hook: "h",
        config: cfg,
        startTimeoutMs: 30,
        promptTimeoutMs: 30,
        run: () => new Promise(() => {}),
      })({ client: {}, directory: proj });
      const ho = { parts: [{ type: "text", text: "pytanie o moduł demo" }] };
      const t0 = Date.now();
      await hung["chat.message"]({ sessionID: "ses_h" }, ho);
      const o = { system: [] as string[] };
      await hung["experimental.chat.system.transform"]({ sessionID: "ses_h" }, o);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(o.system).toEqual([]);
      expect(ho.parts.length).toBe(1);
      // błędne wejście OpenCode nie wychodzi poza plugin
      await p["chat.message"](null, null);
      await p["experimental.chat.system.transform"](null, null);
      // capture.harnesses.opencode: false: bez hooków kontekstu
      writeFileSync(cfg, JSON.stringify({ capture: { harnesses: { opencode: false } } }));
      calls.length = 0;
      expect((await msg("ses_off", "jak działa logowanie w demo?")).length).toBe(1);
      expect(await system({ sessionID: "ses_off" })).toEqual(["podstawa"]);
      expect(calls).toEqual([]);
      rmSync(cfg);
    });

    test("łatka: plik na wpis, nowy jako Write", () => {
      const patch = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Delete File: c.ts\n*** End Patch";
      expect(O.opencodeTool("apply_patch", { patchText: patch }).map((c) => [c.name, c.input.file_path])).toEqual([
        ["Write", "a.ts"],
        ["Edit", "b.ts"],
        ["Edit", "c.ts"],
      ]);
    });
  });

  // ── zapis do pamięci ────────────────────────────────────────────────────────────────────────────────────
  describe("zapis do pamięci: ten sam potok co Claude Code i Codex", () => {
    const repo = new Repo(openDb());
    beforeAll(() => mkdirSync(H.opencodeDir(), { recursive: true }));
    const sessionsOf = (ids: number[]) =>
      repo.db.query(`SELECT DISTINCT session_id AS s FROM observations WHERE id IN (${ids.join(",") || "0"})`).all() as {
        s: string;
      }[];

    afterAll(() => rmSync(H.harnessStateFile(), { force: true }));

    test("zapis sesji harnessu rusza dopiero po install (null w config); true i false w config wygrywają", () => {
      // wykryte (katalogi są), ale niepodłączone: ani nadrabianie, ani backfill, ani hooki
      expect(H.listHarnessTranscripts()).toEqual([]);
      expect(listTranscripts().filter((f) => f.sessionId.includes(":"))).toEqual([]);
      expect(IH.harnessReport().filter((l) => l.endsWith("wykryty, niepodłączony (hipokamp install)")).length).toBe(4);
      const cfg = C.loadConfig();
      const on = { ...cfg, capture: { ...cfg.capture, harnesses: { ...cfg.capture.harnesses, gemini: true } } };
      expect(H.listHarnessTranscripts(on).map((f) => f.sessionId)).toEqual([`gemini:${X.GEMINI_ID}`]);
      // stan po `hipokamp install` (installHarnesses zapisuje podłączone harnessy)
      mkdirSync(C.paths.state(), { recursive: true });
      writeFileSync(H.harnessStateFile(), JSON.stringify({ installed: ["gemini", "cursor", "opencode", "claude-desktop"] }));
      expect(H.installedHarnesses()).toEqual(["gemini", "cursor", "opencode", "claude-desktop"]);
    });

    test("nadrabianie i backfill widzą sesje wszystkich podłączonych harnessów, przełącznik je wyłącza", () => {
      const ids = H.listHarnessTranscripts()
        .map((f) => f.sessionId)
        .sort();
      expect(ids).toEqual(
        [
          `cursor:${CURSOR2}`,
          `cursor:${X.CURSOR_ID}`,
          `desktop:${DESK}`,
          `desktop:${DESK2}`,
          `gemini:${X.GEMINI_ID}`,
          `opencode:${X.OPENCODE_ID}`,
        ].sort(),
      );
      expect(listTranscripts().filter((f) => f.sessionId.includes(":")).length).toBe(6);
      const cfg = C.loadConfig();
      const off = { ...cfg, capture: { ...cfg.capture, harnesses: { ...cfg.capture.harnesses, gemini: false, cursor: false } } };
      expect(H.listHarnessTranscripts(off).some((f) => /^(gemini|cursor):/.test(f.sessionId))).toBe(false);
      expect(H.harnessOn("gemini", off)).toBe(false);
      expect(
        H.harnessOn("antigravity", {
          ...cfg,
          capture: { ...cfg.capture, harnesses: { ...cfg.capture.harnesses, antigravity: true } },
        }),
      ).toBe(true);
    });

    const cases: [string, string, string][] = [
      ["Gemini CLI", `gemini:${X.GEMINI_ID}`, gMain],
      ["Cursor .txt", `cursor:${X.CURSOR_ID}`, cTxt],
      ["Claude Desktop", `desktop:${DESK}`, dMain],
    ];
    for (const [label, sessionId, path] of cases)
      test(`${label}: notatki z kluczem sesji z przedrostkiem, projekt z katalogu, drugi odczyt bez dubli`, () => {
        const r = ingestTranscript(repo, { sessionId, transcriptPath: path, cwd: proj, final: true });
        expect(r.inserted.length).toBeGreaterThan(0);
        expect(sessionsOf(r.inserted)).toEqual([{ s: sessionId }]);
        expect(r.project).toBe(basename(proj));
        expect(repo.getSession(sessionId)?.project).toBe(basename(proj));
        const again = ingestTranscript(repo, { sessionId, transcriptPath: path, cwd: proj, final: true });
        expect(again.inserted).toEqual([]);
      });

    const obsOf = (sid: string) =>
      repo.db.query("SELECT id, turn_key k, status s, meta m FROM observations WHERE session_id = ? ORDER BY id").all(sid) as {
        id: number;
        k: string;
        s: string;
        m: string | null;
      }[];

    test("Gemini CLI, starszy zapis .json: lista bez dubla z .jsonl, tury z całego pliku po ciszy, odczyt od offsetu nic nie dubluje", () => {
      const jsonId = "0a1b2c3d-0000-4000-8000-00000000a0j1";
      const f = put(join(gChats, "session-2026-01-05T09-00-0a1b2cj1.json"), X.geminiJsonRecord(jsonId));
      // ta sama sesja w obu formatach (po aktualizacji Gemini CLI): zostaje .jsonl
      const dupe = put(join(gChats, "session-2026-01-05T09-00-dupe.json"), X.geminiJsonRecord(X.GEMINI_ID, "d"));
      const old = (p: string) => {
        const t = new Date(Date.now() - G.GEMINI_JSON_QUIET_MS - 60_000);
        utimesSync(p, t, t);
      };
      try {
        // świeży plik (sesja może trwać, CLI przepisuje go w całości): całość czeka, offset zostaje na początku
        const fresh = read(f, `gemini:${jsonId}`);
        expect([fresh.turns.length, fresh.offset]).toEqual([0, 0]);
        old(f);
        expect(G.isGeminiTranscript(f)).toBe(true);
        const listed = G.listGeminiChats().map((x) => [x.sessionId, x.path]);
        expect(listed).toContainEqual([`gemini:${jsonId}`, f]);
        expect(listed.filter(([s]) => s === `gemini:${X.GEMINI_ID}`)).toEqual([[`gemini:${X.GEMINI_ID}`, gMain]]);
        const b = read(f, `gemini:${jsonId}`);
        expect(b.offset).toBe(b.size);
        expect(b.turns.map((t) => [t.key, t.prompt])).toEqual([
          ["j-u1", "popraw walidację formularza w module demo"],
          ["j-u2", "dopisz test walidacji pola email w demo"],
        ]);
        expect(names(b.turns[0])).toEqual(["Edit"]);
        expect(slash(b.turns[0].tools[0].input.file_path)).toBe(slash(join(proj, "src", "form.ts")));
        // zakresy wiadomości rosną i nie wychodzą poza plik
        expect(b.turns[0].to).toBeLessThanOrEqual(b.turns[1].from);
        // okno mniejsze niż plik: całość czeka (offset 0), aż odczyt obejmie cały plik
        const small = T.readLinesFrom(f, 0, 64);
        expect([small.lines.length, small.end]).toEqual([0, 0]);
        const r = ingestTranscript(repo, { sessionId: `gemini:${jsonId}`, transcriptPath: f, cwd: proj, final: true });
        expect(r.turns).toBe(2);
        expect(repo.getSession(`gemini:${jsonId}`)?.transcript_offset).toBe(b.size);
        // plik przepisany przez starą wersję CLI (dłuższy): ogon to nie JSON, nic nie wchodzi drugi raz
        writeFileSync(f, `${X.geminiJsonRecord(jsonId).trimEnd()}\n${" ".repeat(10)}\n`);
        old(f);
        expect(
          ingestTranscript(repo, { sessionId: `gemini:${jsonId}`, transcriptPath: f, cwd: proj, final: true }).inserted,
        ).toEqual([]);
      } finally {
        rmSync(f);
        rmSync(dupe);
      }
    });

    test("Gemini CLI, $rewindTo: cofnięta tura w jednym odczycie nie trafia do pamięci, przeczytana wcześniej idzie do archiwum", () => {
      const one = put(join(gChats, "session-2026-10-06T09-00-0a1b2cr1.jsonl"), J.jsonl(X.geminiRewindSession("rew-1", "r1")));
      const two = put(
        join(gChats, "session-2026-10-06T10-00-0a1b2cr2.jsonl"),
        J.jsonl(X.geminiRewindSession("rew-2", "r2", "before")),
      );
      try {
        const b = read(one, "gemini:rew-1");
        expect(b.lines.some((l) => l.json.type === "gemini-rewind" && l.json.target === "r1-u2")).toBe(true);
        const a = ingestTranscript(repo, { sessionId: "gemini:rew-1", transcriptPath: one, cwd: proj, final: true });
        expect(a.turns).toBe(3);
        expect(obsOf("gemini:rew-1").map((o) => [o.k, o.s])).toEqual([
          ["r1-u1", "active"],
          ["r1-u3", "active"],
        ]);
        const prompts = repo.db.query("SELECT n, text FROM prompts WHERE session_id = ? ORDER BY n").all("gemini:rew-1") as {
          n: number;
          text: string;
        }[];
        expect(prompts.map((p) => p.text).join("|")).not.toContain("kolejkę zdarzeń");
        // cofnięta tura nie zajmuje numeru: tura po cofnięciu ma numer 2
        expect(prompts.map((p) => p.n)).toEqual([1, 2]);
        expect(prompts[1].text).toContain("logowanie błędów");
        // naprawa (repair, odzysk tur bez notatki) też pomija cofniętą turę
        const traced: string[] = [];
        recoverTurns(repo, { dryRun: true, trace: (t, _o, sid) => sid === "gemini:rew-1" && traced.push(t.key) });
        expect(traced).not.toContain("r1-u2");

        // dwa odczyty: tury zapisane, potem cofnięcie dopisane do pliku
        ingestTranscript(repo, { sessionId: "gemini:rew-2", transcriptPath: two, cwd: proj, final: true });
        expect(obsOf("gemini:rew-2").map((o) => [o.k, o.s])).toEqual([
          ["r2-u1", "active"],
          ["r2-u2", "active"],
        ]);
        const rest = X.geminiRewindSession("rew-2", "r2").slice(X.geminiRewindSession("rew-2", "r2", "before").length);
        appendFileSync(two, J.jsonl(rest));
        ingestTranscript(repo, { sessionId: "gemini:rew-2", transcriptPath: two, cwd: proj, final: true });
        const after = obsOf("gemini:rew-2");
        expect(after.map((o) => [o.k, o.s])).toEqual([
          ["r2-u1", "active"],
          ["r2-u2", "archived"],
          ["r2-u3", "active"],
        ]);
        expect(JSON.parse(after[1].m ?? "{}").rewound_at).toBeGreaterThan(0);
        // archiwum sięga tylko do znacznika w pliku: tura po nim zostaje, nawet z późniejszym czasem
        const mark = read(two, "gemini:rew-2").lines.find((l) => l.json?.type === "gemini-rewind")!;
        const gone = repo.archiveRewoundTurns("gemini:rew-2", 0, mark.start);
        expect(gone).toEqual([after[0].id]);
        expect(obsOf("gemini:rew-2").map((o) => o.s)).toEqual(["archived", "archived", "active"]);
      } finally {
        rmSync(one);
        rmSync(two);
      }
    });

    test("Cowork: katalog piaskownicy to katalog wybrany przez użytkownika, bez niego projekt `cowork`", () => {
      const org = join(deskRoot, "konto", "org");
      const mk = (name: string, folders: string[]) => {
        const dir = join(org, name);
        const out = join(dir, "outputs");
        const id = `0a1b2c3d-0000-4000-8000-0000000${name.slice(-5)}`;
        const c = { sessionId: id, cwd: out };
        const p = put(
          join(dir, ".claude", "projects", K.cursorSlug(out), `${id}.jsonl`),
          J.jsonl([
            J.userPrompt(c, X.T0, "przygotuj zestawienie faktur za wrzesień w demo"),
            J.toolCall(c, X.T0 + 500, "t1", "python zestawienie.py", "Liczę zestawienie."),
            J.toolOutput(c, X.T0 + 700, "t1", "ok"),
            J.reply(c, X.T0 + 1000, "DECYZJA: zestawienie faktur trzymamy w arkuszu miesięcznym, jeden plik na miesiąc."),
          ]),
        );
        put(`${dir}.json`, JSON.stringify({ sessionId: name, cliSessionId: id, cwd: out, userSelectedFolders: folders }));
        return { p, id, out, dir };
      };
      const withFolder = mk("local_cw001", [proj]);
      const bare = mk("local_cw002", []);
      try {
        expect(H.coworkSession(withFolder.p)).toMatchObject({ folders: [proj] });
        expect(H.coworkSession(join(proj, "x.jsonl"))).toBeNull();
        expect(slash(H.coworkCwd(H.coworkSession(withFolder.p)!, join(withFolder.out, "sub")))).toBe(slash(proj));
        expect(H.coworkCwd(H.coworkSession(withFolder.p)!, "D:\\inny")).toBe("D:\\inny");
        const a = ingestTranscript(repo, { sessionId: `desktop:${withFolder.id}`, transcriptPath: withFolder.p, final: true });
        expect(a.project).toBe(basename(proj));
        expect(a.inserted.length).toBe(1);
        const b = ingestTranscript(repo, { sessionId: `desktop:${bare.id}`, transcriptPath: bare.p, final: true });
        expect(b.project).toBe("cowork");
        expect(repo.resolveProject(bare.out)).toBe("cowork");
        // naprawa: tura bez klucza liczy projekt jak ingest (katalog użytkownika, `cowork`), więc trafia na tę samą
        // treść (duplikat), a nie na nową notatkę w projekcie z nazwy piaskownicy
        const keys = repo.db
          .query("SELECT id, turn_key k, transcript_ref r FROM observations WHERE session_id IN (?, ?)")
          .all(`desktop:${withFolder.id}`, `desktop:${bare.id}`) as { id: number; k: string; r: string }[];
        expect(keys.length).toBe(2);
        // bez klucza i bez zakresu w transkrypcie: naprawa widzi turę jako brakującą
        repo.db.run("UPDATE observations SET turn_key = NULL, transcript_ref = NULL WHERE id IN (?, ?)", [
          keys[0].id,
          keys[1].id,
        ]);
        try {
          const out: string[] = [];
          recoverTurns(repo, {
            dryRun: true,
            trace: (_t, o, sid) =>
              sid.startsWith("desktop:") && [withFolder.id, bare.id].some((x) => sid.endsWith(x)) && out.push(o),
          });
          expect(out).toEqual(["duplicate", "duplicate"]);
        } finally {
          for (const k of keys)
            repo.db.run("UPDATE observations SET turn_key = ?, transcript_ref = ? WHERE id = ?", [k.k, k.r, k.id]);
        }
        // alias po `project merge` (źródło reguły, inny projekt niż z reguły) zostaje; goły wynik reguły dostaje `cowork`
        const merged = join(org, "local_cw003", "outputs");
        const plain = join(org, "local_cw004", "outputs");
        repo.setProjectAlias(merged, "faktury", "rule:2");
        repo.setProjectAlias(plain, P.projectFromCwd(plain), "rule:2");
        const s = (cwd: string) => ({ cwd, root: dirname(cwd), folders: [] as string[] });
        aliasCowork(repo, s(merged));
        aliasCowork(repo, s(plain));
        expect(repo.projectAlias(merged)).toEqual({ project: "faktury", source: "rule:2" });
        expect(repo.projectAlias(plain)).toEqual({ project: "cowork", source: "cowork" });
      } finally {
        rmSync(withFolder.dir, { recursive: true, force: true });
        rmSync(bare.dir, { recursive: true, force: true });
        rmSync(`${withFolder.dir}.json`);
        rmSync(`${bare.dir}.json`);
      }
    });

    test("narzędzia sejfu z Gemini CLI i Cursora bez wejścia i wyniku, sekret z promptu zamaskowany", () => {
      expect(PT.isPrivateTool("mcp_sejf_run_with_secrets", ["mcp__sejf__"])).toBe(true);
      expect(PT.isPrivateTool("sejf__list_secrets", ["mcp__sejf__"])).toBe(true);
      expect(PT.isPrivateTool("sejf_reveal_secret", ["mcp__sejf__"])).toBe(true);
      expect(PT.isPrivateTool("MCP__SEJF__STATUS", ["mcp__sejf__"])).toBe(true);
      expect(PT.isPrivateTool("mcp_sejfik_x", ["mcp__sejf__"])).toBe(false);
      expect(PT.isPrivateTool("Read", ["mcp__sejf__", ""])).toBe(false);
      const gf = put(
        join(gChats, "session-2026-10-05T12-00-0a1b2c41.jsonl"),
        J.jsonl(X.geminiPrivateSession("prywatna-g", SECRET)),
      );
      const cf = quiet(put(join(cDir, "prywatna-c.txt"), X.cursorPrivateTxt(SECRET)));
      try {
        for (const [sid, path] of [
          ["gemini:prywatna-g", gf],
          ["cursor:prywatna-c", cf],
        ]) {
          const r = ingestTranscript(repo, { sessionId: sid, transcriptPath: path, cwd: proj, final: true });
          expect(r.inserted.length).toBeGreaterThan(0);
          const prompts = repo.db.query("SELECT text FROM prompts WHERE session_id = ?").all(sid) as { text: string }[];
          expect(prompts.length).toBe(1);
          expect(prompts[0].text).toContain("[REDACTED:anthropic-key]");
          const rows = JSON.stringify([repo.db.query("SELECT * FROM observations WHERE session_id = ?").all(sid), prompts]);
          expect(rows).not.toContain(SECRET);
          expect(rows).not.toContain("bun run migrate");
          const uses = getToolUses(repo, r.inserted);
          for (const s of [SECRET, "bun run migrate", "KLUCZ_", "write_env", "list_secrets", "run_with_secrets"])
            expect(uses).not.toContain(s);
        }
      } finally {
        rmSync(gf);
        rmSync(cf);
      }
    });

    test("wątek podagenta Gemini CLI nie trafia do pamięci", () => {
      const r = ingestTranscript(repo, { sessionId: `gemini:${SUB_ID}`, transcriptPath: gSub, cwd: proj, final: true });
      expect(r.turns).toBe(0);
      expect(r.inserted).toEqual([]);
    });

    // hook.ts jak go wołają harnessy (osobny proces, środowisko katalogu testowego)
    const hook = (args: string[], input: object) => {
      const r = Bun.spawnSync([process.execPath, join(ROOT, "src", "hooks", "hook.ts"), ...args], {
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>) },
        stdin: new TextEncoder().encode(JSON.stringify(input)),
      });
      return { code: r.exitCode, out: r.stdout.toString().trim() };
    };
    const countFor = (sid: string) =>
      (repo.db.query("SELECT COUNT(*) AS n FROM observations WHERE session_id = ?").get(sid) as { n: number }).n;

    test("hook Stop z pluginu OpenCode i z Cursora (bez transcript_path): zapis z przedrostkiem, wyjście Cursora", () => {
      const oc = hook(["stop", "opencode"], {
        session_id: X.OPENCODE_ID,
        transcript_path: ocFile,
        cwd: proj,
        hook_event_name: "Stop",
      });
      expect(oc.code).toBe(0);
      expect(countFor(`opencode:${X.OPENCODE_ID}`)).toBeGreaterThan(0);
      const cu = hook(["stop", "cursor"], {
        conversation_id: CURSOR2,
        workspace_roots: [proj],
        hook_event_name: "stop",
        status: "completed",
      });
      expect(cu.code).toBe(0);
      expect(JSON.parse(cu.out || "null")).toEqual({});
      expect(countFor(`cursor:${CURSOR2}`)).toBeGreaterThan(0);
      expect(countFor(CURSOR2)).toBe(0);
    }, 60_000);

    test("hook startu sesji: kontekst w kształcie Gemini CLI i Cursora; harness wyłączony w config milczy", () => {
      const g = hook(["session-start", "gemini"], {
        session_id: "0a1b2c3d-0000-4000-8000-00000000a009",
        cwd: proj,
        hook_event_name: "SessionStart",
        source: "startup",
      });
      expect(g.code).toBe(0);
      const go = JSON.parse(g.out);
      expect(go.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(go.hookSpecificOutput.additionalContext).toContain("Pamięć");
      const cu = hook(["session-start", "cursor"], {
        conversation_id: "0a1b2c3d-0000-4000-8000-00000000c009",
        workspace_roots: [proj],
        hook_event_name: "sessionStart",
      });
      expect(cu.code).toBe(0);
      expect(JSON.parse(cu.out).additional_context).toContain("Pamięć");

      const cfgFile = join(C.DATA_DIR, "config.json");
      const before = readFileSync(cfgFile, "utf8");
      writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(before), capture: { harnesses: { gemini: false } } }));
      try {
        const off = hook(["session-start", "gemini"], { session_id: "x", cwd: proj, hook_event_name: "SessionStart" });
        expect(off).toEqual({ code: 0, out: "" });
      } finally {
        writeFileSync(cfgFile, before);
      }
    }, 60_000);

    test("plugin OpenCode z prawdziwym hook.ts: kontekst startu sesji w promptcie systemowym", async () => {
      const p: any = await O.default({
        dir: H.opencodeTranscripts(),
        bun: process.execPath,
        hook: join(ROOT, "src", "hooks", "hook.ts"),
        config: join(C.DATA_DIR, "config.json"),
        startTimeoutMs: 30_000,
      })({ client: {}, directory: proj });
      await p["chat.message"]({ sessionID: "ses_ctx" }, { parts: [{ type: "text", text: "ok" }] });
      const o = { system: [] as string[] };
      await p["experimental.chat.system.transform"]({ sessionID: "ses_ctx" }, o);
      expect(o.system.length).toBe(1);
      expect(o.system[0]).toContain("Pamięć");
    }, 60_000);

    test("hook postToolUse Cursora: wyjście w kształcie Cursora, plik spoza pamięci bez kontekstu", () => {
      const cu = hook(["post-tool", "cursor"], {
        conversation_id: X.CURSOR_ID,
        workspace_roots: [proj],
        hook_event_name: "postToolUse",
        tool_name: "Read",
        tool_input: { path: "src/nieznany.ts" },
        tool_output: "x",
      });
      expect(cu.code).toBe(0);
      expect(JSON.parse(cu.out)).toEqual({});
    }, 60_000);
  });

  // ── install i rollback ──────────────────────────────────────────────────────────────────────────────────
  describe("install i rollback w konfiguracji harnessów", () => {
    const BUN = "C:/bun/bun.exe";
    const files = {
      gemini: join(HOME, ".gemini", "settings.json"),
      antigravity: join(HOME, ".gemini", "antigravity", "mcp_config.json"),
      antigravityIde: join(HOME, ".gemini", "antigravity-ide", "mcp_config.json"),
      cursorMcp: join(HOME, ".cursor", "mcp.json"),
      cursorHooks: join(HOME, ".cursor", "hooks.json"),
      opencode: join(H.opencodeDir(), "opencode.jsonc"),
      plugin: join(H.opencodeDir(), "plugins", "hipokamp.js"),
      desktop: join(H.claudeDesktopDir(), "claude_desktop_config.json"),
    };
    const original: Record<string, string | null> = {
      gemini: [
        "{",
        "  // ustawienia użytkownika",
        '  "theme": "Default",',
        '  "mcpServers": {',
        '    "inny": { "command": "inny-serwer" },',
        "  },",
        '  "hooks": {',
        '    "AfterAgent": [',
        '      { "hooks": [{ "type": "command", "command": "inne-narzedzie stop" }] }',
        "    ]",
        "  }",
        "}",
        "",
      ].join("\n"),
      antigravity: '{\n\t"mcpServers": {}\n}\n',
      antigravityIde: null,
      cursorMcp: '{"mcpServers":{"inny":{"command":"x"}}}',
      cursorHooks: null,
      opencode: '{\n  "$schema": "https://opencode.ai/config.json",\n  // motyw\n  "theme": "system"\n}\n',
      plugin: null,
      desktop:
        '{\r\n  "mcpServers": {\r\n    "inny": {\r\n      "command": "x"\r\n    }\r\n  },\r\n  "preferences": {\r\n    "menuBarEnabled": false\r\n  }\r\n}\r\n',
    };
    const snapshot = () =>
      Object.fromEntries(Object.entries(files).map(([k, f]) => [k, existsSync(f) ? readFileSync(f, "utf8") : null]));
    const doc = (k: keyof typeof files) => E.readJsonc(readFileSync(files[k], "utf8"));
    const run = (o: { dryRun?: boolean; bunPath?: string; skip?: any } = {}) => {
      const log: string[] = [];
      const done = IH.installHarnesses({ dryRun: !!o.dryRun, log: (m) => log.push(m), bunPath: o.bunPath ?? BUN, skip: o.skip });
      return { done, log: log.join("\n") };
    };
    const ours = (l: any[]) => (Array.isArray(l) ? l.filter((v) => JSON.stringify(v).includes("hook.ts")) : []);

    test("przygotowanie: konfiguracje z cudzymi wpisami, komentarzami, tabulatorami i CRLF", () => {
      for (const [k, text] of Object.entries(original)) if (text !== null) put(files[k as keyof typeof files], text);
      mkdirSync(dirname(files.antigravityIde), { recursive: true });
      expect(snapshot()).toEqual(original);
      for (const h of H.HARNESSES) expect(H.detected(h)).toBe(true);
    });

    test("próba: lista zmian bez żadnego zapisu", () => {
      const r = run({ dryRun: true });
      expect(r.done).toEqual([...H.HARNESSES]);
      expect(snapshot()).toEqual(original);
      expect(existsSync(C.paths.backups()) && readdirSync(C.paths.backups()).length).toBeFalsy();
      expect(existsSync(join(C.paths.state(), "harness-files.json"))).toBe(false);
    });

    test("install: MCP, hooki i plugin dopisane, cudze wpisy i format zostają, kopie plików", () => {
      const r = run();
      expect(r.done).toEqual([...H.HARNESSES]);
      const g = doc("gemini");
      expect(g.theme).toBe("Default");
      expect(g.mcpServers.inny).toEqual({ command: "inny-serwer" });
      expect(g.mcpServers.hipokamp.command).toBe(BUN);
      expect(slash(g.mcpServers.hipokamp.args[0])).toBe(slash(join(ROOT, "src", "mcp", "server.ts")));
      expect(readFileSync(files.gemini, "utf8")).toContain("// ustawienia użytkownika");
      expect(Object.keys(g.hooks)).toEqual([
        "AfterAgent",
        "SessionStart",
        "BeforeAgent",
        "AfterTool",
        "PreCompress",
        "SessionEnd",
      ]);
      expect(g.hooks.AfterAgent[0].hooks[0].command).toBe("inne-narzedzie stop");
      expect(g.hooks.AfterAgent[1].hooks[0].command).toMatch(/hook\.ts" stop gemini$/);
      expect(g.hooks.AfterTool[0].matcher).toBe("read_file|write_file|replace");
      expect(g.hooks.BeforeAgent[0].hooks[0]).toMatchObject({ name: "hipokamp", type: "command", timeout: 10_000 });

      expect(readFileSync(files.antigravity, "utf8")).toStartWith(
        '{\n\t"mcpServers": {"hipokamp": {"command": "C:/bun/bun.exe", "args": [',
      );
      expect(doc("antigravityIde").mcpServers.hipokamp.command).toBe(BUN);

      expect(readFileSync(files.cursorMcp, "utf8")).toStartWith('{"mcpServers":{"inny":{"command":"x"},"hipokamp":{"command":');
      const ch = doc("cursorHooks");
      expect(ch.version).toBe(1);
      expect(Object.keys(ch.hooks)).toEqual(["sessionStart", "postToolUse", "stop", "sessionEnd"]);
      expect(ch.hooks.stop[0].command).toMatch(/hook\.ts" stop cursor$/);
      expect(ch.hooks.stop[0].timeout).toBe(30);
      expect(ch.hooks.postToolUse[0]).toMatchObject({ timeout: 8, matcher: expect.stringContaining("StrReplace") });
      expect(ch.hooks.postToolUse[0].command).toMatch(/hook\.ts" post-tool cursor$/);

      const oc = doc("opencode");
      expect(oc.theme).toBe("system");
      expect(oc.mcp.hipokamp).toMatchObject({ type: "local", enabled: true });
      expect(oc.mcp.hipokamp.command[0]).toBe(BUN);
      expect(readFileSync(files.opencode, "utf8")).toContain("// motyw");
      const plugin = readFileSync(files.plugin, "utf8");
      expect(plugin).toStartWith("// hipokamp: zapis sesji OpenCode");
      expect(plugin).toContain("src/capture/opencode-plugin.ts");
      expect(plugin).toContain('"hook":');
      expect(plugin).toContain('"privateTools":["mcp__sejf__"');
      expect(plugin).toContain(`"config":"${C.configPath().replace(/\\/g, "/")}"`);

      const desk = readFileSync(files.desktop, "utf8");
      expect(/(?<!\r)\n/.test(desk)).toBe(false);
      expect(doc("desktop").preferences).toEqual({ menuBarEnabled: false });
      expect(doc("desktop").mcpServers.hipokamp.command).toBe(BUN);

      // kopie plików, które były przed instalacją (pliki założone od zera kopii nie mają)
      const bk = readdirSync(C.paths.backups());
      expect(bk.length).toBe(1);
      expect(readdirSync(join(C.paths.backups(), bk[0])).length).toBe(5);
      expect(r.log).toContain("nowe hooki i plugin działają od nowych sesji");
    });

    test("plik pluginu OpenCode: moduł hipokampa ładowany dynamicznie, jego brak nie psuje OpenCode", async () => {
      const ctx = { client: {}, directory: proj };
      const mod = await import(pathToFileURL(files.plugin).href);
      expect(Object.keys(mod)).toEqual(["default"]);
      expect(typeof (await mod.default(ctx)).event).toBe("function");
      // repo przeniesione albo usunięte: import modułu pada, plugin zwraca pusty zestaw hooków
      const broken = join(dirname(files.plugin), "zepsuty.js");
      writeFileSync(broken, readFileSync(files.plugin, "utf8").replace("opencode-plugin.ts", "nie-ma-takiego.ts"));
      try {
        expect(await (await import(pathToFileURL(broken).href)).default(ctx)).toEqual({});
      } finally {
        rmSync(broken);
      }
      // wpisy installHarnesses: podłączone harnessy w stanie instalacji
      expect(H.installedHarnesses()).toEqual([...H.HARNESSES]);
    });

    test("doctor: każdy harness podłączony, z liczbą plików sesji", () => {
      const rep = IH.harnessReport();
      expect(rep.length).toBe(H.HARNESSES.length);
      expect(rep.every((l) => l.startsWith("✓ "))).toBe(true);
      expect(rep.find((l) => l.includes("Gemini CLI"))).toContain("hooki 6/6, sesje: 1 plików");
      expect(rep.find((l) => l.includes("Cursor"))).toContain("hooki 4/4, sesje: 2 plików");
      expect(rep.find((l) => l.includes("OpenCode"))).toContain("MCP, plugin, sesje: 1 plików");
      expect(rep.find((l) => l.includes("Antigravity"))).toContain("MCP w 2/2 plikach");
    });

    test("drugi install bez zmian; nowa ścieżka Buna podmienia wpisy zamiast je dublować", () => {
      const after = snapshot();
      const again = run();
      expect(snapshot()).toEqual(after);
      expect(again.log).toContain("hooki hipokampa już są");
      expect(again.log).toContain("serwer MCP hipokampa już jest");
      run({ bunPath: "D:/inny/bun.exe" });
      const g = doc("gemini");
      for (const ev of Object.keys(g.hooks)) expect(ours(g.hooks[ev]).length).toBe(1);
      expect(g.hooks.AfterAgent.length).toBe(2);
      expect(g.hooks.SessionEnd[0].hooks[0].command).toContain("D:/inny/bun.exe");
      expect(doc("cursorMcp").mcpServers.hipokamp.command).toBe("D:/inny/bun.exe");
      expect(ours(doc("cursorHooks").hooks.stop).length).toBe(1);
    });

    test("--no-<harness> i capture.harnesses: false pomijają harness", () => {
      expect(run({ dryRun: true, skip: { cursor: true } }).done).not.toContain("cursor");
      const cfgFile = join(C.DATA_DIR, "config.json");
      const before = readFileSync(cfgFile, "utf8");
      writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(before), capture: { harnesses: { opencode: false } } }));
      C.loadConfig(true);
      try {
        const r = run({ dryRun: true });
        expect(r.done).not.toContain("opencode");
        expect(r.log).toContain("OpenCode: wyłączony w config");
        expect(IH.harnessReport().find((l) => l.includes("OpenCode"))).toBe("· OpenCode: wyłączony (capture.harnesses)");
      } finally {
        writeFileSync(cfgFile, before);
        C.loadConfig(true);
      }
    });

    test("testowy HIPOKAMP_HOME nie pisze do konfiguracji spoza katalogu testowego", () => {
      const outside = mkdtempSync(join(tmpdir(), "hk-straznik-"));
      const prev = process.env.XDG_CONFIG_HOME;
      try {
        mkdirSync(join(outside, "opencode"));
        process.env.XDG_CONFIG_HOME = outside;
        const r = run({ skip: { gemini: true, antigravity: true, cursor: true, "claude-desktop": true } });
        expect(r.log).toContain("testowy HIPOKAMP_HOME, a plik leży poza katalogiem testowym");
        expect(readdirSync(join(outside, "opencode"))).toEqual([]);
      } finally {
        process.env.XDG_CONFIG_HOME = prev;
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test("rollback: próba bez zmian, potem pliki jak przed instalacją bajt w bajt, założone pliki znikają", () => {
      const installed = snapshot();
      const log: string[] = [];
      IH.uninstallHarnesses({ dryRun: true, log: (m) => log.push(m), harnesses: [...H.HARNESSES] });
      expect(snapshot()).toEqual(installed);
      expect(log.join("\n")).toContain("usuwam wpisy hipokampa");
      IH.uninstallHarnesses({ dryRun: false, log: (m) => log.push(m), harnesses: [...H.HARNESSES] });
      expect(snapshot()).toEqual(original);
      expect(JSON.parse(readFileSync(H.harnessStateFile(), "utf8"))).toEqual({
        files: [],
        keys: {},
        owned: {},
        prior: {},
        blank: {},
        installed: [],
        removed: {},
        moved: [],
      });
      // po rollbacku zapis sesji stoi (null w config): harness wykryty, ale niepodłączony
      expect(IH.harnessReport().every((l) => l.endsWith("wykryty, niepodłączony (hipokamp install)"))).toBe(true);
      expect(H.listHarnessTranscripts()).toEqual([]);
      // drugi rollback niczego nie zmienia
      IH.uninstallHarnesses({ dryRun: false, log: () => {}, harnesses: [...H.HARNESSES] });
      expect(snapshot()).toEqual(original);
    });

    const only = (...hs: string[]) => ({
      skip: Object.fromEntries(H.HARNESSES.filter((h) => !hs.includes(h)).map((h) => [h, true])),
    });
    const uninstall = (hs: any[]) => {
      const log: string[] = [];
      IH.uninstallHarnesses({ dryRun: false, log: (m) => log.push(m), harnesses: hs });
      return log.join("\n");
    };

    test("plik tylko do odczytu: błąd w logu, plik bez zmian, reszta instalacji i rollbacku idzie dalej", () => {
      chmodSync(files.cursorMcp, 0o444);
      try {
        const r = run(only("cursor", "claude-desktop"));
        expect(r.done).toEqual(["cursor", "claude-desktop"]);
        expect(r.log).toContain(`BŁĄD zapisu ${files.cursorMcp}`);
        expect(readFileSync(files.cursorMcp, "utf8")).toBe(original.cursorMcp!);
        expect(ours(doc("cursorHooks").hooks.stop).length).toBe(1);
        expect(doc("desktop").mcpServers.hipokamp.command).toBe(BUN);
        expect(H.installedHarnesses()).toEqual(["cursor", "claude-desktop"]);
      } finally {
        chmodSync(files.cursorMcp, 0o644);
      }
      chmodSync(files.cursorHooks, 0o444);
      try {
        const log = uninstall(["cursor", "claude-desktop"]);
        expect(log).toContain(`BŁĄD zapisu ${files.cursorHooks}`);
        // rollback poszedł dalej: Claude Desktop jak przed instalacją
        expect(readFileSync(files.desktop, "utf8")).toBe(original.desktop!);
      } finally {
        chmodSync(files.cursorHooks, 0o644);
      }
      uninstall(["cursor"]);
      expect(snapshot()).toEqual(original);
      expect(readdirSync(dirname(files.cursorHooks)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    test("Cursor: hooki dopisane przez użytkownika po instalacji zostają po rollbacku razem z `version`", () => {
      run(only("cursor"));
      const user = { command: "moj-linter --stop", timeout: 5 };
      writeFileSync(files.cursorHooks, E.appendAt(readFileSync(files.cursorHooks, "utf8"), ["hooks", "stop"], user));
      uninstall(["cursor"]);
      expect(doc("cursorHooks")).toEqual({ version: 1, hooks: { stop: [user] } });
      expect(readFileSync(files.cursorMcp, "utf8")).toBe(original.cursorMcp!);
      rmSync(files.cursorHooks);
    });

    test("Cursor, --replace-claude-mem: hooki claude-mem schodzą z kopią, próba pokazuje plan, rollback je oddaje", () => {
      const cm = (arg: string) => ({
        command: `& "C:\\\\bun\\\\bun.exe" "C:\\\\x\\\\.claude\\\\plugins\\\\marketplaces\\\\thedotmack\\\\plugin\\\\scripts\\\\worker-service.cjs" hook cursor ${arg}`,
      });
      const user = { command: "moj-linter --stop", timeout: 5 };
      // cudze skrypty o podobnej nazwie to nie claude-mem: zostają
      const memo = { command: "node C:/tools/claude-memo-sync.js" };
      const backup = { command: "node C:/tools/claude-mem-db-backup.js --stop" };
      expect([memo, backup, user].some(IH.isClaudeMemHook)).toBe(false);
      expect(IH.isClaudeMemHook(cm("summarize"))).toBe(true);
      const before = {
        version: 1,
        hooks: {
          beforeSubmitPrompt: [cm("session-init"), cm("context")],
          // dwa identyczne hooki: oba wracają
          afterMCPExecution: [cm("observation"), cm("observation")],
          afterShellExecution: [cm("observation")],
          afterFileEdit: [cm("file-edit")],
          stop: [cm("summarize"), user, memo, backup],
        },
      };
      // komentarz w liście (JSONC): rollback wstawia hooki punktowo, więc zostaje na miejscu
      // komentarz za nawiasem listy, która po zdjęciu zostaje pusta (`[ // kontekst`): po rollbacku dalej przed hookami
      const text = `${JSON.stringify(before, null, 2)}\n`
        .replace('"stop": [\n', '"stop": [\n      // moje hooki\n')
        .replace('"beforeSubmitPrompt": [\n', '"beforeSubmitPrompt": [ // kontekst\n')
        .replace('"afterFileEdit": [\n', '"afterFileEdit": [ // koniec edycji\n');
      expect(E.readJsonc(text)).toEqual(before);
      put(files.cursorHooks, text);
      const manual = { command: "stary-bun", args: ["D:/stary/server.ts"] };
      put(files.cursorMcp, `${JSON.stringify({ mcpServers: { hipokamp: manual } }, null, 2)}\n`);
      const go = (dryRun: boolean) => {
        const log: string[] = [];
        IH.installHarnesses({ dryRun, log: (m) => log.push(m), bunPath: BUN, replaceClaudeMem: true, ...only("cursor") });
        return log.join("\n");
      };
      const dry = go(true);
      expect(readFileSync(files.cursorHooks, "utf8")).toBe(text);
      expect(dry).toContain("harnessy (próba)");
      expect(dry).toContain(
        `(próba) Cursor: ${files.cursorHooks}: zdejmuje 7 hooków claude-mem (beforeSubmitPrompt×2, afterMCPExecution×2`,
      );
      expect(dry).toContain(`(próba) Cursor: ${files.cursorMcp}: zastępuje mcpServers.hipokamp sprzed instalacji`);
      expect(dry).toContain("dopisuje hooki sessionStart, postToolUse, stop, sessionEnd");
      go(false);
      const after = doc("cursorHooks");
      expect(JSON.stringify(after)).not.toContain("thedotmack");
      expect(after.hooks.stop.slice(0, 3)).toEqual([user, memo, backup]);
      expect(ours(after.hooks.stop).length).toBe(1);
      expect(after.hooks.beforeSubmitPrompt).toEqual([]);
      // matcher z kotwicami (bez nich łapałby TodoWrite), bez Delete
      const m = new RegExp(after.hooks.postToolUse[0].matcher);
      expect(["Read", "StrReplace", "read_file"].every((t) => m.test(t))).toBe(true);
      expect(["TodoWrite", "Delete", "ReadLints"].some((t) => m.test(t))).toBe(false);
      expect(JSON.parse(readFileSync(H.harnessStateFile(), "utf8")).removed[files.cursorHooks].length).toBe(7);
      // kopia pliku sprzed zmian (z hookami claude-mem)
      const bk = readdirSync(C.paths.backups()).sort().at(-1)!;
      expect(
        readFileSync(
          join(C.paths.backups(), bk, readdirSync(join(C.paths.backups(), bk)).find((f) => f.endsWith("hooks.json"))!),
          "utf8",
        ),
      ).toBe(text);
      // drugi install: nic do zdjęcia, plik bez zmian
      const snap = readFileSync(files.cursorHooks, "utf8");
      go(false);
      expect(readFileSync(files.cursorHooks, "utf8")).toBe(snap);
      // rollback bez Cursora na liście (instalacja przerwana po zdjęciu hooków): hooki claude-mem i tak wracają
      expect(IH.harnessLeftovers()).toBe(true);
      const left = uninstall([]);
      expect(left).toContain("przywracam 7 hooków claude-mem");
      expect(doc("cursorHooks").hooks.afterMCPExecution).toEqual([cm("observation"), cm("observation")]);
      expect(IH.harnessLeftovers()).toBe(false);
      // drugi rollback nie dubluje hooków, a zdejmuje nasze: plik bajt w bajt jak przed instalacją
      uninstall(["cursor"]);
      expect(readFileSync(files.cursorHooks, "utf8")).toBe(text);
      expect(doc("cursorMcp")).toEqual({ mcpServers: { hipokamp: manual } });
      expect(JSON.parse(readFileSync(H.harnessStateFile(), "utf8")).removed).toEqual({});
      // hook claude-mem dopisany ponownie przed rollbackiem (claude-mem sam się odtworzył) nie jest dublowany
      go(false);
      const now = readFileSync(files.cursorHooks, "utf8");
      put(files.cursorHooks, E.insertAt(now, ["hooks", "stop"], 0, cm("summarize")));
      uninstall(["cursor"]);
      expect(doc("cursorHooks")).toEqual(before);
      // nowy hook claude-mem na pozycji już zapisanej w stanie (inna wartość), zdjęty przy drugim install: rollback
      // oddaje oba
      go(false);
      put(files.cursorHooks, E.insertAt(readFileSync(files.cursorHooks, "utf8"), ["hooks", "stop"], 0, cm("nowy")));
      go(false);
      expect(JSON.stringify(doc("cursorHooks"))).not.toContain("thedotmack");
      expect(JSON.parse(readFileSync(H.harnessStateFile(), "utf8")).removed[files.cursorHooks].length).toBe(8);
      uninstall(["cursor"]);
      const back = doc("cursorHooks").hooks.stop;
      expect(back).toContainEqual(cm("nowy"));
      expect(back).toContainEqual(cm("summarize"));
      expect(back.length).toBe(5);
      // plik ze zdjętymi hookami zniknął: wpis w stanie schodzi z komunikatem, zamiast zostać na zawsze
      put(files.cursorHooks, text);
      go(false);
      rmSync(files.cursorHooks);
      expect(IH.harnessLeftovers()).toBe(true);
      expect(uninstall([])).toContain(`${files.cursorHooks} nie istnieje`);
      expect(IH.harnessLeftovers()).toBe(false);
      uninstall(["cursor"]);
      expect(doc("cursorMcp")).toEqual({ mcpServers: { hipokamp: manual } });
      put(files.cursorMcp, original.cursorMcp!);
    });

    test("OpenCode, --replace-claude-mem: plugin claude-mem do kopii, doctor ostrzega, rollback go odkłada", () => {
      const cmp = join(H.opencodeDir(), "plugins", "claude-mem.js");
      const body = "export default async () => ({}); // claude-mem\n";
      put(cmp, body);
      const go = (dryRun: boolean, replaceClaudeMem: boolean) => {
        const log: string[] = [];
        IH.installHarnesses({ dryRun, log: (m) => log.push(m), bunPath: BUN, replaceClaudeMem, ...only("opencode") });
        return log.join("\n");
      };
      go(false, false);
      expect(existsSync(cmp)).toBe(true);
      const warn = IH.harnessReport().find((l) => l.includes("OpenCode"))!;
      expect(warn).toContain("plugin claude-mem obok (claude-mem.js");
      expect(warn.startsWith("!")).toBe(true);
      const dry = go(true, true);
      expect(dry).toContain(`(próba) OpenCode: ${cmp}: przenosi plugin claude-mem do`);
      expect(existsSync(cmp)).toBe(true);
      go(false, true);
      expect(existsSync(cmp)).toBe(false);
      const st = JSON.parse(readFileSync(H.harnessStateFile(), "utf8"));
      expect(st.moved.length).toBe(1);
      expect(st.moved[0].from).toBe(cmp);
      expect(readFileSync(st.moved[0].to, "utf8")).toBe(body);
      expect(IH.harnessReport().find((l) => l.includes("OpenCode"))).not.toContain("claude-mem");
      // rollback: plugin wraca na miejsce, stan czysty
      const log = uninstall(["opencode"]);
      expect(log).toContain("odkładam");
      expect(readFileSync(cmp, "utf8")).toBe(body);
      expect(JSON.parse(readFileSync(H.harnessStateFile(), "utf8")).moved).toEqual([]);
      rmSync(cmp);
      put(files.opencode, original.opencode!);
    });

    test("Gemini CLI: nasz hook w cudzej grupie schodzi tylko z niej, grupa i cudze hooki zostają", () => {
      const legacy = { type: "command", command: '"D:/stary/bun.exe" "D:/stary/hipokamp/src/hooks/hook.ts" stop gemini' };
      const mixed = { hooks: [{ type: "command", command: "moj-linter --po-turze" }, legacy] };
      put(files.gemini, `${JSON.stringify({ hooks: { AfterAgent: [mixed] } }, null, 2)}\n`);
      run(only("gemini"));
      const g = doc("gemini");
      expect(g.hooks.AfterAgent[0]).toEqual({ hooks: [{ type: "command", command: "moj-linter --po-turze" }] });
      expect(ours(g.hooks.AfterAgent).length).toBe(1);
      expect(g.hooks.AfterAgent[1].hooks[0].command).toContain(BUN);
      uninstall(["gemini"]);
      expect(doc("gemini")).toEqual({
        hooks: { AfterAgent: [{ hooks: [{ type: "command", command: "moj-linter --po-turze" }] }] },
      });
      put(files.gemini, original.gemini!);
    });

    test("wpis hipokamp sprzed instalacji: inna wartość wraca po rollbacku, taka sama zostaje; pusty plik wraca bajt w bajt", () => {
      const manual = { command: "stary-bun", args: ["D:/stary/server.ts"] };
      put(files.desktop, `${JSON.stringify({ mcpServers: { hipokamp: manual } }, null, 2)}\n`);
      put(files.antigravityIde, "  \n");
      run(only("claude-desktop", "antigravity"));
      expect(doc("desktop").mcpServers.hipokamp.command).toBe(BUN);
      expect(doc("antigravityIde").mcpServers.hipokamp.command).toBe(BUN);
      uninstall(["claude-desktop", "antigravity"]);
      expect(doc("desktop")).toEqual({ mcpServers: { hipokamp: manual } });
      expect(readFileSync(files.antigravityIde, "utf8")).toBe("  \n");
      expect(readFileSync(files.antigravity, "utf8")).toBe(original.antigravity!);
      // taki sam wpis dopisany ręcznie: install go nie rusza, rollback też
      const same = { command: BUN, args: [join(ROOT, "src", "mcp", "server.ts").replace(/\\/g, "/")] };
      const text = `${JSON.stringify({ mcpServers: { hipokamp: same } }, null, 2)}\n`;
      put(files.desktop, text);
      expect(run(only("claude-desktop")).log).toContain("serwer MCP hipokampa już jest");
      expect(uninstall(["claude-desktop"])).toContain("nie pochodzi z instalacji, zostawiam");
      expect(readFileSync(files.desktop, "utf8")).toBe(text);
      put(files.desktop, original.desktop!);
      rmSync(files.antigravityIde);
      const st = JSON.parse(readFileSync(H.harnessStateFile(), "utf8"));
      expect([st.owned, st.prior, st.blank]).toEqual([{}, {}, {}]);
    });
  });
}
