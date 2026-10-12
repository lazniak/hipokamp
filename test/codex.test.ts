// Rollouty Codexa: tłumaczenie linii na tury Claude Code, skrypty `exec` (komendy, łatki, MCP), granice tur,
// historia zaimportowana z innego agenta, wątki podagentów i szukanie rolloutu po id wątku.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexHookFiles,
  codexState,
  findCodexRollout,
  fromCodex,
  isCodexSubagent,
  isCodexTranscript,
  listCodexRollouts,
  patchCalls,
  readJsString,
  scriptCalls,
  shellTool,
} from "../src/capture/codex.ts";
import { digestTurn } from "../src/capture/digest.ts";
import { countsAsPrompt, readTurns } from "../src/capture/transcript.ts";
import * as X from "./fixtures/capture/codex.ts";

const home = mkdtempSync(join(tmpdir(), "hipokamp-codex-"));
const prev = process.env.CODEX_HOME;
process.env.CODEX_HOME = join(home, "codex");
const day = join(home, "codex", "sessions", "2026", "10", "05");
mkdirSync(day, { recursive: true });

afterAll(() => {
  if (prev === undefined) Reflect.deleteProperty(process.env, "CODEX_HOME");
  else process.env.CODEX_HOME = prev;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

const ids = {
  main: "01a10000-0000-7000-8000-000000000001",
  open: "01a10000-0000-7000-8000-000000000002",
  imp: "01a10000-0000-7000-8000-000000000003",
  sub: "01a10000-0000-7000-8000-000000000004",
};

function write(id: string, rows: object[]): string {
  const p = join(day, X.rolloutName(id));
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return p;
}

const read = (p: string, id: string, final: boolean | "complete" = "complete") =>
  readTurns(p, id, 0, { window: 1 << 20, maxWindow: 1 << 24, final });

describe("rollout Codexa jako tury", () => {
  const p = write(ids.main, X.session(ids.main));
  const b = read(p, ids.main);
  const [t1, t2] = b.turns;

  test("rozpoznanie pliku i dwie tury bez kontekstu doklejanego przez Codexa", () => {
    expect(isCodexTranscript(p)).toBe(true);
    expect(isCodexTranscript("C:/x/.claude/projects/D--x/0b1c2d3e-0000-4000-8000-000000000000.jsonl")).toBe(false);
    expect(b.turns.map((t) => t.kind)).toEqual(["human", "human"]);
    expect(t1.prompt).toBe("napraw test logowania w aplikacji demo");
    expect(b.turns.some((t) => /environment_context|AGENTS\.md/.test(t.prompt))).toBe(false);
    expect(b.offset).toBe(b.size);
  });

  test("model i katalog z turn_context, klucz tury z id wiadomości", () => {
    expect(t1.model).toBe("gpt-test");
    expect(t1.cwd).toBe("D:\\code\\demo");
    expect(t1.key).toBe("msg_p1");
    expect(t1.texts).toEqual(["Sprawdzam test i poprawiam moduł app.", "Test logowania przechodzi po zmianie w src/app.ts."]);
  });

  test("skrypt exec: komenda z kodem wyjścia, łatka (nowy i zmieniony plik), MCP", () => {
    const names = t1.tools.map((c) => c.name);
    // powłoka z rolloutu (<shell>powershell</shell>), nie z systemu, na którym działa hipokamp
    expect(names).toEqual(["PowerShell", "Write", "Edit", "mcp__plugin_hipokamp_hipokamp__search"]);
    const [sh, add, upd] = t1.tools;
    expect(sh.input.command).toBe("bun test src\\app.test.ts");
    expect(sh.isError).toBe(true);
    expect(add.input.file_path).toBe("D:/code/demo/src/nowy.ts");
    expect(add.structured).toEqual({ type: "create", filePath: "D:/code/demo/src/nowy.ts" });
    // względna ścieżka z łatki idzie od katalogu rolloutu (Windows), na każdym systemie
    expect(upd.input.file_path).toBe("D:\\code\\demo\\src\\app.ts");
  });

  test("streszczenie tury: pliki, nowy plik, błąd komendy", () => {
    const d = digestTurn(t1, { project: "demo", n: 1, privateTools: [], maxNarrativeChars: 1400 });
    expect(d.skip).toBe(false);
    // klucze względne do katalogu rolloutu (Windows), także gdy hipokamp działa na Linuksie
    expect(d.obs?.files_modified).toEqual(["src/nowy.ts", "src/app.ts"]);
  });

  test("przerwana tura i podagent jako Agent", () => {
    expect(t2.interrupted).toBe(true);
    expect(t2.tools.map((c) => [c.name, c.input.description])).toEqual([["Agent", "csv_export"]]);
    expect(b.turns.filter(countsAsPrompt).length).toBe(2);
  });

  test("tura bez task_complete czeka (nadrabianie), Stop z final=true ją zamyka", () => {
    const rows = X.session(ids.open).slice(0, 11); // bez task_complete pierwszej tury
    const q = write(ids.open, rows);
    const waiting = read(q, ids.open, "complete");
    expect(waiting.turns.length).toBe(0);
    expect(waiting.offset).toBeLessThan(waiting.size);
    expect(read(q, ids.open, true).turns.length).toBe(1);
  });
});

describe("pliki Codexa", () => {
  test("historia zaimportowana z innego agenta nie wraca drugi raz", () => {
    const p = write(ids.imp, X.imported(ids.imp));
    const b = read(p, ids.imp);
    expect(b.turns.map((t) => t.prompt)).toEqual(["pierwsze własne pytanie w Codexie"]);
  });

  test("wątek podagenta pomijany na liście, rollout znajdowany po id wątku", () => {
    const sub = write(ids.sub, [X.sessionMeta(ids.sub, "D:\\code\\demo", { subagent: { other: "guardian" } })]);
    expect(isCodexSubagent(sub)).toBe(true);
    const listed = listCodexRollouts().map((f) => f.sessionId);
    expect(listed).toContain(ids.main);
    expect(listed).not.toContain(ids.sub);
    expect(findCodexRollout(ids.main)).toBe(join(day, X.rolloutName(ids.main)));
    expect(findCodexRollout("01a1ffff-0000-7000-8000-000000000000")).toBeNull();
    expect(findCodexRollout("../../etc")).toBeNull();
  });
});

describe("powłoka z rolloutu, nie z systemu hipokampa (T-38)", () => {
  const cmd = 'text(await tools.exec_command({cmd:"ls"}));';
  test("nazwa powłoki jako narzędzie Claude Code", () => {
    for (const n of ["powershell", "PowerShell", "pwsh", "pwsh.exe", "cmd"]) expect(shellTool(n)).toBe("PowerShell");
    for (const n of ["bash", "zsh", "sh", "/bin/bash", "fish"]) expect(shellTool(n)).toBe("Bash");
    for (const n of [undefined, null, "", "  ", 3]) expect(shellTool(n)).toBeNull();
  });

  test("bez powłoki w rolloucie: styl katalogu, zapisana powłoka wygrywa", () => {
    expect(scriptCalls(cmd, { cwd: "/home/jan/demo", shell: null })[0].name).toBe("Bash");
    expect(scriptCalls(cmd, { cwd: "D:\\code\\demo", shell: null })[0].name).toBe("PowerShell");
    expect(scriptCalls(cmd, { cwd: "/home/jan/demo", shell: "PowerShell" })[0].name).toBe("PowerShell");
    expect(scriptCalls(cmd, { cwd: "D:\\code\\demo", shell: "Bash" })[0].name).toBe("Bash");
  });

  test("<shell> w kontekście środowiska i world_state ustawiają powłokę odczytu", () => {
    const bashEnv = "<environment_context>\n  <cwd>D:\\code\\demo</cwd>\n  <shell>bash</shell>\n</environment_context>";
    const st = codexState(join(tmpdir(), "hipokamp-test-brak.jsonl"));
    fromCodex(X.user(X.T0, "m1", bashEnv), st);
    const [call] = fromCodex(X.functionCall(X.T0 + 1, "c1", "exec_command", { cmd: "ls" }), st);
    expect(call.message.content[0].name).toBe("Bash"); // katalog Windows, ale rollout mówi bash
    // wynik: kod wyjścia liczony dla powłoki z rolloutu
    const [res] = fromCodex(X.functionOutput(X.T0 + 2, "c1", '{"exit_code":2}'), st);
    expect(res.message.content[0].is_error).toBe(true);

    const st2 = codexState(join(tmpdir(), "hipokamp-test-brak.jsonl"));
    const ws = {
      timestamp: new Date(X.T0).toISOString(),
      type: "world_state",
      payload: { full: true, state: { environments: { environments: { local: { cwd: "/srv/x", shell: "powershell" } } } } },
    };
    expect(fromCodex(ws, st2)).toEqual([]);
    expect(st2.shell).toBe("PowerShell");
  });

  test("okno od środka pliku bierze powłokę z początku rolloutu", () => {
    const id = "01a10000-0000-7000-8000-000000000005";
    const bashEnv = "<environment_context>\n  <cwd>D:\\code\\demo</cwd>\n  <shell>bash</shell>\n</environment_context>";
    const head = [
      X.sessionMeta(id, X.CWD),
      X.taskStarted(X.T0 + 1, "t1"),
      X.user(X.T0 + 2, "m1", bashEnv, "pierwsza prośba o listę plików w katalogu"),
      X.turnContext(X.T0 + 3, X.CWD),
      X.assistant(X.T0 + 4, "Lista plików jest w katalogu demo, nic nie zmieniałem."),
      X.taskComplete(X.T0 + 5, "t1"),
    ];
    const p = write(id, [
      ...head,
      X.taskStarted(X.T0 + 6, "t2"),
      X.user(X.T0 + 7, "m2", "druga prośba: pokaż pliki w katalogu src"),
      X.turnContext(X.T0 + 8, X.CWD),
      X.functionCall(X.T0 + 9, "c1", "exec_command", { cmd: "ls src" }),
      X.functionOutput(X.T0 + 10, "c1", '{"exit_code":0}'),
      X.assistant(X.T0 + 11, "W katalogu src są pliki aplikacji i testy."),
      X.taskComplete(X.T0 + 12, "t2"),
    ]);
    const offset = Buffer.byteLength(`${head.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const b = readTurns(p, id, offset, { window: 1 << 20, maxWindow: 1 << 24, final: "complete" });
    expect(b.turns.map((t) => t.prompt)).toEqual(["druga prośba: pokaż pliki w katalogu src"]);
    // katalog Windows i (na Windows) system mówią PowerShell, ale rollout od początku mówi bash
    expect(b.turns[0].tools.map((t) => t.name)).toEqual(["Bash"]);
  });
});

describe("skrypty exec", () => {
  test("napisy JS: ucieczki, apostrofy, szablony", () => {
    expect(readJsString(String.raw`"a\\b\n\"c\" \u0105"`, 0)?.value).toBe('a\\b\n"c" ą');
    expect(readJsString("'x' + y", 0)).toEqual({ value: "x", end: 3 });
    // wstawienie ${…} w szablonie zostaje tekstem (nie wykonujemy skryptu)
    const tpl = `a $${"{b}"} c`;
    expect(readJsString(`\`${tpl}\``, 0)?.value).toBe(tpl);
    expect(readJsString("zmienna", 0)).toBeNull();
  });

  test("łatka w zmiennej, view_image, wyszukiwanie WWW; czysty JS bez wywołań", () => {
    const code = [
      'const p = "*** Begin Patch\\n*** Delete File: stare.ts\\n*** End Patch";',
      "await tools.apply_patch(p);",
      'await tools.view_image({path:"D:/x/zrzut.png"});',
      'await tools.web__run({search_query:[{q:"bun sqlite wal"}]});',
    ].join("\n");
    const calls = scriptCalls(code, { cwd: "D:\\code\\demo" });
    expect(calls.map((c) => c.name)).toEqual(["Edit", "Read", "WebSearch"]);
    expect(calls[0].input.file_path).toBe("D:\\code\\demo\\stare.ts");
    expect(calls[2].input.query).toBe("bun sqlite wal");
    expect(scriptCalls("text(ALL_TOOLS.filter(x => /mcp/.test(x.name)))", { cwd: null })).toEqual([]);
  });

  test("hook PostToolUse: pliki z łatki w skrypcie exec i z apply_patch, bez usuniętych", () => {
    const base = { session_id: ids.main, cwd: X.CWD, hook_event_name: "PostToolUse" };
    // skrypt jak w rolloucie: komenda, łatka (nowy i zmieniony plik), MCP; tool_input jako napis albo { code }
    for (const tool_input of [X.SCRIPT, { code: X.SCRIPT }]) {
      const files = codexHookFiles({ ...base, tool_name: "exec", tool_input });
      expect(files.map((f) => [f.path.replace(/\\/g, "/"), f.changed])).toEqual([
        ["D:/code/demo/src/nowy.ts", true],
        ["D:/code/demo/src/app.ts", true],
      ]);
    }
    // usunięty plik nie dostaje ostrzeżenia „plik zmieniony” (nie ma czego czytać); usunięty i dodany od nowa zostaje
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Delete File: b.ts\n*** End Patch";
    expect(codexHookFiles({ ...base, tool_name: "apply_patch", tool_input: { command: patch } }).map((f) => f.path)).toEqual([
      "D:\\code\\demo\\a.ts",
    ]);
    const readd = "*** Begin Patch\n*** Delete File: b.ts\n*** Add File: b.ts\n+nowa\n*** End Patch";
    expect(codexHookFiles({ ...base, tool_name: "apply_patch", tool_input: { command: readd } })).toEqual([
      { path: "D:\\code\\demo\\b.ts", changed: true },
    ]);
    // w transkrypcie usunięcie nadal jest zmianą pliku (Edit)
    expect(patchCalls(patch, { cwd: null }).map((c) => c.name)).toEqual(["Edit", "Edit"]);
    // komend powłoki hook Codexa nie dostaje (matcher apply_patch|exec): heredoc w Bash nie jest czytany
    const heredoc = `apply_patch <<'EOF'\n${patch}\nEOF`;
    expect(codexHookFiles({ ...base, tool_name: "Bash", tool_input: { command: heredoc } })).toEqual([]);
  });

  test("hook PostToolUse: obraz to odczyt, ta sama ścieżka raz, najwyżej max plików", () => {
    const view = codexHookFiles({
      cwd: X.CWD,
      tool_name: "exec",
      tool_input: 'await tools.view_image({path:"D:/x/zrzut.png"});',
    });
    expect(view).toEqual([{ path: "D:/x/zrzut.png", changed: false }]);
    const many = Array.from({ length: 6 }, (_, i) => `*** Update File: f${i}.ts`).join("\n");
    const twice = "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: SRC/A.ts\n*** End Patch";
    expect(codexHookFiles({ cwd: null, tool_name: "apply_patch", tool_input: { command: many } })).toHaveLength(3);
    expect(codexHookFiles({ cwd: null, tool_name: "apply_patch", tool_input: { command: twice } })).toHaveLength(1);
    expect(codexHookFiles({ cwd: null, tool_name: "Edit", tool_input: { file_path: "D:/x/y.ts" } })).toEqual([
      { path: "D:/x/y.ts", changed: true },
    ]);
    expect(codexHookFiles({ tool_name: "exec", tool_input: { code: "text(1)" } })).toEqual([]);
  });

  // Ścieżka względna z łatki idzie od katalogu rolloutu w stylu tego katalogu (Windows albo POSIX), nie systemu,
  // na którym działa hipokamp: te same wyniki na Windows i na Linuksie
  const patchOf = (...files: string[]) =>
    `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}`).join("\n")}\n*** End Patch`;
  const patched = (cwd: string | null, ...files: string[]) =>
    patchCalls(patchOf(...files), { cwd }).map((c) => c.input.file_path as string);

  test("rollout z Windows (Codex Desktop), także czytany na Linuksie: ścieżki od katalogu D:\\…", () => {
    expect(patched("D:\\code\\demo", "src/a.ts", "..\\b.ts", "D:/x/c.ts", "\\\\srv\\share\\d.ts", "\\e.ts")).toEqual([
      "D:\\code\\demo\\src\\a.ts",
      "D:\\code\\b.ts",
      "D:/x/c.ts",
      "\\\\srv\\share\\d.ts",
      "D:\\e.ts",
    ]);
  });

  test("rollout z WSL albo Linuksa, także czytany na Windows: ścieżki od katalogu /…, bez wymyślonej litery dysku", () => {
    expect(patched("/home/dev/demo", "src/a.ts", "../b.ts", "/abs/c.ts", "D:/x/d.ts")).toEqual([
      "/home/dev/demo/src/a.ts",
      "/home/dev/b.ts",
      "/abs/c.ts",
      "D:/x/d.ts",
    ]);
  });

  test("hook dostaje cwd i łatkę z tej samej maszyny: wynik jak przy zapisie tury, w obu stylach", () => {
    const hook = (cwd: string) =>
      codexHookFiles({ cwd, tool_name: "apply_patch", tool_input: { command: patchOf("src/a.ts") } }).map((f) => f.path);
    expect(hook("D:\\code\\demo")).toEqual(["D:\\code\\demo\\src\\a.ts"]);
    expect(hook("/home/dev/demo")).toEqual(["/home/dev/demo/src/a.ts"]);
  });

  test("łatka z przeniesieniem pliku", () => {
    const calls = patchCalls("*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** End Patch", { cwd: null });
    expect(calls.map((c) => [c.name, c.input.file_path])).toEqual([
      ["Edit", "a.ts"],
      ["Edit", "b.ts"],
    ]);
  });
});

describe("instalacja w Codexie", () => {
  test("hooki dopisane na końcu (cudze zostają na swoich pozycjach), MCP raz, rollback sprząta", async () => {
    process.env.HIPOKAMP_HOME ??= join(home, "hipokamp");
    const { paths } = await import("../src/config.ts");
    if (!paths.backups().includes(tmpdir()) && !paths.backups().includes("hipokamp-"))
      throw new Error("instalacja: kopie muszą iść do katalogu testowego");
    const { installCodex, uninstallCodex } = await import("../src/install/harness.ts");
    const cx = join(home, "codex");
    const foreign = { matcher: "", hooks: [{ type: "command", command: "inne-narzedzie start", timeout: 10 }] };
    const stopForeign = { hooks: [{ type: "command", command: "inne-narzedzie stop", timeout: 5 }] };
    writeFileSync(join(cx, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [foreign], Stop: [stopForeign] } }));
    writeFileSync(join(cx, "config.toml"), "[projects.'d:/x']\ntrust_level = \"trusted\"\n");
    const log: string[] = [];
    const first = installCodex({ dryRun: false, log: (m) => log.push(m), bunPath: "C:/bun/bun.exe" });
    const second = installCodex({ dryRun: false, log: (m) => log.push(m), bunPath: "C:/bun/bun.exe" });
    expect(first).toEqual({ hooks: true, mcp: true });
    expect(second).toEqual({ hooks: false, mcp: false });
    const doc = JSON.parse(await Bun.file(join(cx, "hooks.json")).text());
    expect(doc.hooks.SessionStart[0]).toEqual(foreign);
    expect(doc.hooks.Stop[0]).toEqual(stopForeign);
    expect(doc.hooks.Stop[1].hooks[0].command).toMatch(/hook\.ts" stop codex$/);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/hook\.ts" prompt codex$/);
    // przypominanie przy pliku: Codex zmienia pliki łatką, więc matcher na apply_patch i skrypt exec
    expect(doc.hooks.PostToolUse[0]).toMatchObject({ matcher: "apply_patch|exec" });
    expect(doc.hooks.PostToolUse[0].hooks[0].command).toMatch(/hook\.ts" post-tool codex$/);
    const toml = await Bun.file(join(cx, "config.toml")).text();
    expect(toml.match(/\[mcp_servers\.hipokamp\]/g)?.length).toBe(1);
    expect(toml).toContain("trust_level");

    uninstallCodex({ dryRun: false, log: (m) => log.push(m) });
    const after = JSON.parse(await Bun.file(join(cx, "hooks.json")).text());
    expect(after.hooks).toEqual({ SessionStart: [foreign], Stop: [stopForeign] });
    const toml2 = await Bun.file(join(cx, "config.toml")).text();
    expect(toml2).not.toContain("mcp_servers.hipokamp");
    expect(toml2).toContain("trust_level");
  });
});
