// Syntetyczne linie transkryptu Claude Code (JSONL) do testów zapisu. Kształty jak w prawdziwych plikach:
// osobne linie na wywołanie narzędzia i wynik, `stop_reason` na każdej linii odpowiedzi, metadane bez treści.
// uuid losowe jak w Claude Code: uuid promptu to klucz tury, a scenariusze dzielą jedną bazę.
const uid = () => crypto.randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();

export interface Ctx {
  sessionId: string;
  cwd: string;
}

export const metaLine = (sid: string, at: number) => ({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: iso(at),
  sessionId: sid,
});

export const userPrompt = (c: Ctx, at: number, content: string | object[]) => ({
  type: "user",
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: { role: "user", content },
});

export const toolCall = (c: Ctx, at: number, id: string, command: string, text?: string) => ({
  type: "assistant",
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: {
    role: "assistant",
    model: "test",
    stop_reason: "tool_use",
    content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name: "Bash", input: { command } }],
  },
});

export const toolOutput = (c: Ctx, at: number, id: string, content: string) => ({
  type: "user",
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  toolUseResult: { stdout: content, stderr: "", interrupted: false },
});

/** Edycja pliku narzędziem Edit (wywołanie i wynik z toolUseResult.filePath, jak w Claude Code). */
export const editCall = (c: Ctx, at: number, id: string, file: string, from: string, to: string) => ({
  type: "assistant",
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: {
    role: "assistant",
    model: "test",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: from, new_string: to } }],
  },
});

export const editOutput = (c: Ctx, at: number, id: string, file: string) => ({
  type: "user",
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `The file ${file} has been updated.` }] },
  toolUseResult: { filePath: file },
});

export const reply = (c: Ctx, at: number, text: string, stop = "end_turn") => ({
  type: "assistant",
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: { role: "assistant", model: "test", stop_reason: stop, content: [{ type: "text", text }] },
});

/** Linia meta użytkownika, np. „Stop hook feedback: …” (Claude Code pisze ją, gdy hook Stop blokuje koniec tury). */
export const metaUser = (c: Ctx, at: number, content: string) => ({
  type: "user",
  isMeta: true,
  uuid: uid(),
  sessionId: c.sessionId,
  cwd: c.cwd,
  timestamp: iso(at),
  message: { role: "user", content },
});

export const systemLine = (sid: string, at: number, subtype: string) => ({
  type: "system",
  subtype,
  uuid: uid(),
  timestamp: iso(at),
  sessionId: sid,
});

/** Komenda z ukośnikiem, jak zapisuje ją Claude Code. */
export const command = (c: Ctx, at: number, name: string, args = "") =>
  userPrompt(
    c,
    at,
    `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
  );

/** Prompt z aplikacji desktop: blok <system-reminder> przed słowami człowieka, origin human. */
export const desktopPrompt = (c: Ctx, at: number, text: string) => ({
  ...userPrompt(c, at, [
    {
      type: "text",
      text: "<system-reminder>\nThe user started this session without choosing a project folder.\n</system-reminder>",
    },
    { type: "text", text },
  ]),
  origin: { kind: "human" },
  promptSource: "sdk",
});

/** Pełna tura: prompt, Bash, wynik, odpowiedź końcowa (end_turn). */
export const fullTurn = (c: Ctx, at: number, n: number, ask: string, answer: string) => {
  const id = `toolu_${c.sessionId}_${n}`;
  return [
    userPrompt(c, at, ask),
    toolCall(c, at + 1000, id, `echo krok ${n}`),
    toolOutput(c, at + 2000, id, `krok ${n} ok`),
    reply(c, at + 3000, answer),
  ];
};

export const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
