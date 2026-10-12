// Syntetyczne linie rolloutu Codexa (~/.codex/sessions/RRRR/MM/DD/rollout-*.jsonl). Kształty jak w prawdziwych
// plikach Codex Desktop: { timestamp, type, payload }, kontekst środowiska doklejany do wiadomości użytkownika,
// narzędzia wywoływane skryptem JS (custom tool `exec`), granice tur w event_msg.
const iso = (ms: number) => new Date(ms).toISOString();
const line = (at: number, type: string, payload: object) => ({ timestamp: iso(at), type, payload });

export const T0 = Date.parse("2026-10-05T08:00:00Z");

export const sessionMeta = (id: string, cwd: string, source: unknown = "vscode") =>
  line(T0, "session_meta", { id, session_id: id, cwd, originator: "Codex Desktop", source, git: { branch: "main" } });

export const taskStarted = (at: number, turn: string) => line(at, "event_msg", { type: "task_started", turn_id: turn });
export const taskComplete = (at: number, turn: string) =>
  line(at, "event_msg", { type: "task_complete", turn_id: turn, last_agent_message: null });
export const turnAborted = (at: number, turn: string) =>
  line(at, "event_msg", { type: "turn_aborted", turn_id: turn, reason: "interrupted" });
export const turnContext = (at: number, cwd: string, model = "gpt-test") =>
  line(at, "turn_context", { cwd, model, turn_id: "t" });
export const tokenCount = (at: number) => line(at, "event_msg", { type: "token_count", info: {} });

export const developer = (at: number, text: string) =>
  line(at, "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text }] });

/** Wiadomość użytkownika: kilka bloków tekstu (kontekst doklejany przez Codexa i właściwy prompt). */
export const user = (at: number, id: string, ...texts: string[]) =>
  line(at, "response_item", {
    type: "message",
    role: "user",
    id,
    content: texts.map((text) => ({ type: "input_text", text })),
  });

export const assistant = (at: number, text: string) =>
  line(at, "response_item", { type: "message", role: "assistant", id: `msg_${at}`, content: [{ type: "output_text", text }] });

export const exec = (at: number, callId: string, code: string) =>
  line(at, "response_item", { type: "custom_tool_call", name: "exec", call_id: callId, input: code });

export const execOutput = (at: number, callId: string, text: string, ok = true) =>
  line(at, "response_item", {
    type: "custom_tool_call_output",
    call_id: callId,
    output: [
      { type: "input_text", text: `Script ${ok ? "completed" : "failed"}\nWall time 0.1 seconds\nOutput:\n` },
      { type: "input_text", text },
    ],
  });

export const functionCall = (at: number, callId: string, name: string, args: object) =>
  line(at, "response_item", { type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) });

export const functionOutput = (at: number, callId: string, text: string) =>
  line(at, "response_item", { type: "function_call_output", call_id: callId, output: text });

export const ENV = "<environment_context>\n  <cwd>D:\\code\\demo</cwd>\n  <shell>powershell</shell>\n</environment_context>";

/** Skrypt `exec` jak u Codexa: komenda PowerShell i łatka z nowym i zmienionym plikiem w jednym wywołaniu. */
export const SCRIPT = [
  'text(await tools.exec_command({cmd:"bun test src\\\\app.test.ts", workdir:"D:\\\\code\\\\demo"}));',
  'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: D:/code/demo/src/nowy.ts\\n+export const x = 1;\\n*** Update File: src/app.ts\\n@@\\n-a\\n+b\\n*** End Patch"));',
  'text(await tools.mcp__plugin_hipokamp_hipokamp__search({query:"x"}));',
].join("\n");

export const CWD = "D:\\code\\demo";

/** Pełna sesja: dwie tury (druga przerwana), kontekst i instrukcje doklejone przez Codexa; `tag` zmienia treść. */
export function session(id: string, cwd = CWD, tag = "") {
  return [
    sessionMeta(id, cwd),
    taskStarted(T0 + 1000, "turn-1"),
    developer(T0 + 1100, "<app-context>instrukcje</app-context>"),
    user(T0 + 1200, "msg_ctx", ENV, "# AGENTS.md instructions for D:\\code\\demo\n<INSTRUCTIONS>…</INSTRUCTIONS>"),
    turnContext(T0 + 1300, cwd),
    user(T0 + 2000, `msg_p1${tag}`, `napraw test logowania w aplikacji demo${tag}`),
    assistant(T0 + 3000, "Sprawdzam test i poprawiam moduł app."),
    exec(T0 + 4000, "call_1", SCRIPT),
    execOutput(T0 + 5000, "call_1", '{"chunk_id":"a","exit_code":1,"output":"1 fail"}'),
    tokenCount(T0 + 5100),
    assistant(T0 + 6000, `Test logowania przechodzi po zmianie w src/app.ts.${tag}`),
    taskComplete(T0 + 6100, "turn-1"),
    taskStarted(T0 + 10_000, "turn-2"),
    turnContext(T0 + 10_100, cwd),
    user(T0 + 11_000, `msg_p2${tag}`, `teraz dodaj eksport raportu do CSV${tag}`),
    functionCall(T0 + 12_000, "call_2", "spawn_agent", { task_name: "csv_export", message: "gAAAA" }),
    functionOutput(T0 + 13_000, "call_2", "spawned"),
    turnAborted(T0 + 14_000, "turn-2"),
  ];
}

/** Początek pliku z historią zaimportowaną z innego agenta (Codex: tury external-import). */
export function imported(id: string) {
  return [
    sessionMeta(id, "D:\\code\\demo"),
    taskStarted(T0 + 100, "external-import-turn-1"),
    user(T0 + 200, "", "pytanie z Claude Code"),
    assistant(T0 + 300, "[external_agent_tool_call: Bash] description: x"),
    taskComplete(T0 + 400, "external-import-turn-1"),
    taskStarted(T0 + 500, "turn-native"),
    turnContext(T0 + 600, "D:\\code\\demo"),
    user(T0 + 700, "msg_native", "pierwsze własne pytanie w Codexie"),
    assistant(T0 + 800, "Odpowiedź Codexa."),
    taskComplete(T0 + 900, "turn-native"),
  ];
}

export const rolloutName = (id: string) => `rollout-2026-10-05T10-00-00-${id}.jsonl`;
