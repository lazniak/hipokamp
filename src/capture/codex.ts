// Transkrypty Codexa (~/.codex/sessions/RRRR/MM/DD/rollout-*.jsonl) w kształcie linii Claude Code.
// Reszta zapisu (tury, streszczenie, nadrabianie) zostaje wspólna: tłumaczymy tylko linie.
// Codex pisze { timestamp, type, payload }: wiadomości i wywołania narzędzi to response_item, granice tur to
// event_msg task_started / task_complete / turn_aborted, model i katalog niesie turn_context przed promptem.
// Narzędzia Codex wywołuje głównie skryptem JS (custom tool `exec`): `tools.exec_command({cmd})`,
// `tools.apply_patch("*** Begin Patch …")`, `tools.mcp__serwer__narzędzie(…)`; z niego wyciągamy komendy i pliki.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isWinPath, resolveIn } from "../util/paths.ts";

/** Katalog Codexa (honoruje CODEX_HOME, jak sam Codex). */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

const RE_ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Plik rollout Codexa (po nazwie: transkrypty Claude Code to `<uuid>.jsonl`). */
export function isCodexTranscript(path: string): boolean {
  return RE_ROLLOUT.test(basename(path));
}

/** Id wątku Codexa z nazwy pliku: to samo, które hook dostaje jako session_id. */
export function codexSessionId(path: string): string | null {
  return basename(path).match(RE_ROLLOUT)?.[1] ?? null;
}

/** Stan tłumaczenia w obrębie jednego odczytu (model i katalog z turn_context, wywołania czekające na wynik). */
export interface CodexState {
  model: string | null;
  cwd: string | null;
  /** Powłoka z rolloutu (`<shell>` w kontekście środowiska, `world_state`), nazwa narzędzia jak w Claude Code. */
  shell?: ShellTool | null;
  /** Koniec historii zaimportowanej z innego agenta (tury „external-import”): te linie już są w jego transkryptach. */
  importEnd: number;
  pending: Map<string, InnerCall[]>;
}

interface InnerCall {
  id: string;
  name: string;
  input: Record<string, any>;
  /** Wynik ustrukturyzowany jak `toolUseResult` w Claude Code (np. type: 'create' dla nowego pliku). */
  structured: Record<string, any> | null;
  /** Usunięcie pliku łatką (Delete File): w transkrypcie jak Edit, przypomnienie przy pliku go pomija. */
  deleted?: boolean;
}

export function codexState(path: string): CodexState {
  return { model: null, cwd: null, shell: initialShell(path), importEnd: importPrefixEnd(path), pending: new Map() };
}

// ── czytanie linii bez trzymania pliku w pamięci ──────────────────────────────────────────────────────────

/** Kolejne linie od początku pliku (także dłuższe niż bufor); `cb` zwraca false, żeby przerwać. */
function eachLine(path: string, cb: (raw: string, end: number) => boolean): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let carry: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return;
      let s = 0;
      for (let i = buf.indexOf(0x0a, 0); i >= 0 && i < n; i = buf.indexOf(0x0a, s)) {
        const part = buf.subarray(s, i);
        const raw = carry.length ? Buffer.concat([...carry, part]).toString("utf8") : part.toString("utf8");
        carry = [];
        if (!cb(raw, pos + i + 1)) return;
        s = i + 1;
      }
      if (s < n) carry.push(Buffer.from(buf.subarray(s, n)));
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
}

const importEnds = new Map<string, number>();

/**
 * Codex importuje sesje innych agentów (np. Claude Code) jako tury `external-import-turn-*` na początku pliku.
 * Ich treść już jest w pamięci z oryginalnego transkryptu, więc pomijamy wszystko do końca ostatniej takiej tury.
 */
export function importPrefixEnd(path: string): number {
  const hit = importEnds.get(path);
  if (hit !== undefined) return hit;
  let end = 0;
  let inImport = false;
  let n = 0;
  eachLine(path, (raw, lineEnd) => {
    n++;
    if (raw.includes('"type":"turn_context"')) return false;
    if (raw.includes('"type":"task_started"') || raw.includes('"type":"task_complete"')) {
      let j: any;
      try {
        j = JSON.parse(raw);
      } catch {
        return true;
      }
      const imported = String(j.payload?.turn_id ?? "").startsWith("external-import");
      if (j.payload?.type === "task_started") {
        if (!imported) return false;
        inImport = true;
      } else if (imported && inImport) end = lineEnd;
    }
    // stary format bez granic tur: nie skanujemy całego pliku
    return inImport || n < 64;
  });
  importEnds.set(path, end);
  return end;
}

const shells = new Map<string, ShellTool | null>();
const SHELL_SCAN_LINES = 200;

/**
 * Powłoka z początku rolloutu (`<shell>` w kontekście środowiska pierwszej wiadomości albo `world_state`). Odczyt
 * okna od środka pliku tych linii nie widzi, a bez nich komenda dostawała nazwę narzędzia ze stylu katalogu albo
 * z systemu, więc ta sama sesja miała różne nazwy w różnych oknach. Wynik pamiętany po ścieżce; brak trafienia tylko
 * po przejrzeniu SHELL_SCAN_LINES linii (krótszy plik jeszcze rośnie i kontekst może dopiero dojść).
 */
export function initialShell(path: string): ShellTool | null {
  const hit = shells.get(path);
  if (hit !== undefined) return hit;
  const st: CodexState = { model: null, cwd: null, shell: null, importEnd: 0, pending: new Map() };
  let n = 0;
  eachLine(path, (raw) => {
    n++;
    if (raw.includes("<shell>") || raw.includes('"world_state"')) {
      try {
        fromCodex(JSON.parse(raw), st);
      } catch {}
    }
    return !st.shell && n < SHELL_SCAN_LINES;
  });
  if (st.shell || n >= SHELL_SCAN_LINES) shells.set(path, st.shell ?? null);
  return st.shell ?? null;
}

const subagents = new Map<string, boolean>();

/** Wątek podagenta (strażnik zgód, thread_spawn): jego praca należy do wątku głównego, nie osobna sesja. */
export function isCodexSubagent(path: string): boolean {
  const hit = subagents.get(path);
  if (hit !== undefined) return hit;
  let sub = false;
  eachLine(path, (raw) => {
    try {
      const src = JSON.parse(raw)?.payload?.source;
      sub = !!src && typeof src === "object" && "subagent" in src;
    } catch {}
    return false;
  });
  subagents.set(path, sub);
  return sub;
}

/** Pliki rollout z ~/.codex/sessions (RRRR/MM/DD) i archived_sessions, bez wątków podagentów. */
export function listCodexRollouts(): { path: string; sessionId: string; size: number; mtime: number }[] {
  const out: { path: string; sessionId: string; size: number; mtime: number }[] = [];
  const add = (dir: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of names) {
      const id = codexSessionId(f);
      if (!id) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.isFile() && !isCodexSubagent(p)) out.push({ path: p, sessionId: id, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  };
  const walk = (dir: string, depth: number) => {
    if (depth === 0) return add(dir);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const d of names) if (/^\d+$/.test(d)) walk(join(dir, d), depth - 1);
  };
  walk(join(codexHome(), "sessions"), 3);
  add(join(codexHome(), "archived_sessions"));
  return out;
}

/** Rollout wątku po jego id (hook Codexa nie zawsze podaje transcript_path); najpierw najnowsze dni. */
export function findCodexRollout(sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const desc = (dir: string) => {
    try {
      return readdirSync(dir)
        .filter((d) => /^\d+$/.test(d))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  const root = join(codexHome(), "sessions");
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        try {
          const f = readdirSync(dir).find((n) => n.toLowerCase().endsWith(suffix));
          if (f) return join(dir, f);
        } catch {}
      }
  return null;
}

// ── tłumaczenie linii ────────────────────────────────────────────────────────────────────────────────────

type ShellTool = "PowerShell" | "Bash";

/** Nazwa powłoki z rolloutu jako narzędzie Claude Code (powershell, pwsh, cmd → PowerShell; bash, zsh, sh… → Bash). */
export function shellTool(name: unknown): ShellTool | null {
  if (typeof name !== "string" || !name.trim()) return null;
  return /^(?:powershell|pwsh|cmd)(?:\.exe)?$/i.test(name.trim()) ? "PowerShell" : "Bash";
}

/**
 * Narzędzie powłoki dla komendy z rolloutu: powłoka zapisana w rolloucie, bez niej styl katalogu (ścieżka Windows:
 * PowerShell), a na końcu system, na którym działa hipokamp. Rollout z innej maszyny (kopia, synchronizacja) nie
 * zmienia więc nazwy narzędzia, a rdzenie komend (naprawiony błąd, efekt) liczą się tak samo na każdym systemie.
 */
function shellOf(st: Partial<Pick<CodexState, "cwd" | "shell">>): ShellTool {
  if (st.shell) return st.shell;
  if (st.cwd) return isWinPath(st.cwd) ? "PowerShell" : st.cwd.startsWith("/") ? "Bash" : hostShell();
  return hostShell();
}
const hostShell = (): ShellTool => (process.platform === "win32" ? "PowerShell" : "Bash");
const isShell = (name: string) => name === "PowerShell" || name === "Bash";
const RE_ENV_SHELL = /<shell>\s*([^<\s]+)\s*<\/shell>/;

/** Bloki doklejane przez Codexa do wiadomości użytkownika: kontekst środowiska, instrukcje, stan interfejsu. */
const RE_INJECTED =
  /^\s*(<environment_context|<codex_internal_context|# AGENTS\.md instructions|<recommended_plugins|<external_codex_apps_|<codex_apps_|<in-app-browser-context|<turn_aborted>|# Files mentioned by the user|<user_instructions>|<app-context>|<skills_instructions>|<permissions instructions>|<collaboration_mode>|<multi_agent_)/;

/** Wywołania, które nic nie mówią o pracy (czekanie na komórkę skryptu, lista agentów). */
const SKIP_CALLS = new Set(["wait", "sleep", "list_agents", "write_stdin", "send_message", "followup_task"]);

const assistantLine = (timestamp: unknown, st: CodexState, content: object[], stop: string | null, uuid?: string) => ({
  type: "assistant",
  uuid,
  timestamp,
  cwd: st.cwd,
  message: { role: "assistant", model: st.model, content, stop_reason: stop },
});

const userLine = (timestamp: unknown, st: CodexState, content: object[], extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp,
  cwd: st.cwd,
  message: { role: "user", content },
  ...extra,
});

/** Linia rollout Codexa jako zero lub więcej linii w kształcie Claude Code. */
export function fromCodex(j: any, st: CodexState): any[] {
  const p = j?.payload ?? {};
  const at = j?.timestamp;
  switch (j?.type) {
    case "session_meta":
      return [{ type: "session-meta", timestamp: at, cwd: p.cwd ?? null, gitBranch: p.git?.branch ?? null }];
    case "world_state": {
      // nowszy Codex: stan środowisk (environments.environments.local.shell) w pełnym zrzucie stanu
      const envs = p.state?.environments?.environments;
      const sh = envs && typeof envs === "object" ? shellTool((envs.local ?? Object.values(envs)[0])?.shell) : null;
      if (sh) st.shell = sh;
      return [];
    }
    case "turn_context":
      if (p.cwd) st.cwd = p.cwd;
      if (p.model) st.model = p.model;
      return [{ type: "turn-context", timestamp: at, cwd: p.cwd ?? null }];
    case "event_msg":
      // koniec tury: jak odpowiedź z end_turn w Claude Code (lastTurnComplete), przerwanie jak znacznik użytkownika
      if (p.type === "task_complete") return [assistantLine(at, st, [], "end_turn")];
      if (p.type === "turn_aborted") return [userLine(at, st, [{ type: "text", text: "[Request interrupted by user]" }])];
      return [];
    case "response_item":
      return responseItem(p, at, st);
    default:
      return [];
  }
}

function responseItem(p: any, at: unknown, st: CodexState): any[] {
  switch (p.type) {
    case "message": {
      if (p.role === "user") return userMessage(p, at, st);
      if (p.role !== "assistant") return []; // developer: instrukcje systemowe
      const text = (p.content ?? [])
        .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      return text ? [assistantLine(at, st, [{ type: "text", text }], null, p.id)] : [];
    }
    case "custom_tool_call":
    case "function_call": {
      const calls = toolCalls(p, st);
      if (!calls.length) return [];
      st.pending.set(String(p.call_id), calls);
      const content = calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }));
      return [assistantLine(at, st, content, "tool_use")];
    }
    case "custom_tool_call_output":
    case "function_call_output":
      return toolResults(p, at, st);
    default:
      return []; // reasoning (szyfrowane), agent_message, compaction
  }
}

function userMessage(p: any, at: unknown, st: CodexState): any[] {
  const content: object[] = [];
  let task: string | null = null;
  let meta = false;
  for (const c of p.content ?? []) {
    if (c?.type === "input_image") {
      content.push({ type: "image" });
      continue;
    }
    if (c?.type !== "input_text" || typeof c.text !== "string") continue;
    let t: string = c.text;
    const goal = t.match(/^\s*<codex_internal_context source="goal">[\s\S]*?<objective>\s*([\s\S]*?)\s*<\/objective>/);
    if (goal) {
      task = `Kontynuacja celu: ${goal[1]}`;
      continue;
    }
    // obraz wklejony w Codexie: <image name=…> przed blokiem input_image i </image> po nim
    if (/^\s*<image name=/.test(t) || /^\s*<\/image>\s*$/.test(t)) continue;
    if (RE_INJECTED.test(t)) {
      const sh = /^\s*<environment_context/.test(t) ? shellTool(t.match(RE_ENV_SHELL)?.[1]) : null;
      if (sh) st.shell = sh;
      continue;
    }
    if (/^\s*<subagent_notification>/.test(t)) {
      task = t.trim();
      continue;
    }
    if (/^\s*<send_user_message_question_reply>/.test(t)) meta = true;
    const voice = t.match(/^\s*<realtime_delegation>[\s\S]*?<input>([\s\S]*?)<\/input>/);
    if (voice) t = voice[1];
    const img = t.match(/^\s*\[external unsupported block: image\]\s*/);
    if (img) {
      content.push({ type: "image" });
      t = t.slice(img[0].length);
    }
    if (t.trim()) content.push({ type: "text", text: t });
  }
  // powiadomienie (wynik podagenta, pobudka celu) otwiera turę jak <task-notification>, bez numeru promptu
  if (task) return [userLine(at, st, [{ type: "text", text: task }], { uuid: p.id, origin: { kind: "task-notification" } })];
  if (!content.length) return [];
  return [userLine(at, st, content, { uuid: p.id, ...(meta ? { isMeta: true } : {}) })];
}

function parseArgs(raw: unknown): any {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toolCalls(p: any, st: CodexState): InnerCall[] {
  const callId = String(p.call_id ?? p.id ?? "");
  const name = String(p.name ?? "");
  let calls: Omit<InnerCall, "id">[] = [];
  if (p.type === "custom_tool_call" && name === "exec") calls = scriptCalls(String(p.input ?? ""), st);
  else if (name === "apply_patch") {
    const a = p.type === "custom_tool_call" ? String(p.input ?? "") : String(parseArgs(p.arguments).input ?? "");
    calls = patchCalls(a, st);
  } else if (!SKIP_CALLS.has(name)) {
    const a = parseArgs(p.arguments ?? p.input);
    if (name === "js" || name === "exec") calls = scriptCalls(String(a.code ?? a.input ?? a.script ?? ""), st);
    else if (name === "exec_command" && typeof a.cmd === "string")
      calls = [{ name: shellOf(st), input: { command: a.cmd }, structured: null }];
    else if (name === "shell" && a.command)
      calls = [
        {
          name: shellOf(st),
          input: { command: Array.isArray(a.command) ? a.command.join(" ") : String(a.command) },
          structured: null,
        },
      ];
    else if (name === "spawn_agent")
      calls = [{ name: "Agent", input: { description: String(a.task_name ?? a.agent_type ?? "agent") }, structured: null }];
    else if (name === "request_user_input_async" || name === "request_user_input")
      calls = [
        {
          name: "AskUserQuestion",
          input: { questions: (a.questions ?? []).map((q: any) => ({ question: String(q.title ?? q.question ?? "") })) },
          structured: null,
        },
      ];
    else if (name) calls = [{ name, input: typeof a === "object" && a ? a : {}, structured: null }];
  }
  // ostatnie wywołanie dostaje id wywołania Codexa: do niego trafia wynik, gdy odpowiedź przyjdzie w innym oknie
  return calls.map((c, i) => ({ ...c, id: i === calls.length - 1 ? callId : `${callId}:${i}` }));
}

/** Napis JS od pozycji `i` (", ' albo `) po rozwinięciu sekwencji ucieczki; null, gdy to nie napis. */
export function readJsString(code: string, i: number): { value: string; end: number } | null {
  const q = code[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  let k = i + 1;
  while (k < code.length) {
    const ch = code[k];
    if (ch === q) return { value: out, end: k + 1 };
    if (ch === "\\") {
      const n = code[k + 1];
      k += 2;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "0") out += "\0";
      else if (n === "u") {
        const braced = code[k] === "{";
        const e = braced ? code.indexOf("}", k) : k + 4;
        const cp = Number.parseInt(code.slice(braced ? k + 1 : k, e), 16);
        if (Number.isFinite(cp)) out += String.fromCodePoint(cp);
        k = braced ? e + 1 : e;
      } else if (n === "x") {
        const cp = Number.parseInt(code.slice(k, k + 2), 16);
        if (Number.isFinite(cp)) out += String.fromCharCode(cp);
        k += 2;
      } else if (n === "\r" || n === "\n") {
        if (n === "\r" && code[k] === "\n") k++;
      } else if (n !== undefined) out += n;
      continue;
    }
    if (q === "`" && ch === "$" && code[k + 1] === "{") {
      const e = code.indexOf("}", k);
      if (e < 0) return null;
      out += code.slice(k, e + 1);
      k = e + 1;
      continue;
    }
    out += ch;
    k++;
  }
  return null;
}

/** Wartość napisowa klucza `key:` w argumentach wywołania (od `from` do `until`). */
function keyString(code: string, from: number, until: number, key: string): string | null {
  const re = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*`, "g");
  re.lastIndex = from;
  const m = re.exec(code);
  if (!m || m.index >= until) return null;
  return readJsString(code, m.index + m[0].length)?.value ?? null;
}

const RE_TOOL = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;

/** Wywołania narzędzi ze skryptu `exec`: komendy powłoki, łatki, obrazy, MCP. Czysty JS (np. ALL_TOOLS) pomijamy. */
export function scriptCalls(code: string, st: Pick<CodexState, "cwd" | "shell">): Omit<InnerCall, "id">[] {
  const out: Omit<InnerCall, "id">[] = [];
  const found = [...code.matchAll(RE_TOOL)];
  const seenPatches = new Set<number>();
  found.forEach((m, idx) => {
    const name = m[1];
    const from = m.index + m[0].length;
    const until = found[idx + 1]?.index ?? code.length;
    if (name === "exec_command") {
      const cmd = keyString(code, from, until, "cmd");
      if (cmd) out.push({ name: shellOf(st), input: { command: cmd }, structured: null });
    } else if (name === "apply_patch") {
      const at = code.slice(from).search(/\S/);
      const lit = at >= 0 ? readJsString(code, from + at) : null;
      if (lit) {
        seenPatches.add(from + at);
        out.push(...patchCalls(lit.value, st));
      } else {
        // łatka w zmiennej: bierzemy napisy zaczynające się od nagłówka łatki
        for (const pm of code.matchAll(/["'`]\*\*\* Begin Patch/g)) {
          if (seenPatches.has(pm.index)) continue;
          seenPatches.add(pm.index);
          const s = readJsString(code, pm.index);
          if (s) out.push(...patchCalls(s.value, st));
        }
      }
    } else if (name === "view_image") {
      const path = keyString(code, from, until, "path");
      if (path) out.push({ name: "Read", input: { file_path: absPath(path, st.cwd) }, structured: null });
    } else if (name === "web__run") {
      const url = code.slice(from, until).match(/https?:\/\/[^\s"'`\\]+/)?.[0];
      const q = url ? null : keyString(code, from, until, "q");
      if (url) out.push({ name: "WebFetch", input: { url }, structured: null });
      else if (q) out.push({ name: "WebSearch", input: { query: q }, structured: null });
    } else if (name.startsWith("mcp__")) {
      out.push({ name, input: {}, structured: null });
    }
  });
  return out;
}

// względną ścieżkę z łatki liczymy według stylu katalogu rolloutu (Windows albo POSIX), nie systemu, na którym działa
// hipokamp: rollout z Windows czytany na Linuksie (i odwrotnie, WSL) nie może dostać ścieżki doklejonej do katalogu procesu
const absPath = (p: string, cwd: string | null): string => resolveIn(cwd, p);

/** Łatka Codexa (*** Add/Update/Delete File: ścieżka): nowy plik jak Write z type 'create', zmiana jak Edit. */
export function patchCalls(patch: string, st: Pick<CodexState, "cwd">): Omit<InnerCall, "id">[] {
  const out: Omit<InnerCall, "id">[] = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm)) {
    const fp = absPath(m[2] ?? m[3], st.cwd);
    if (m[1] === "Add") out.push({ name: "Write", input: { file_path: fp }, structured: { type: "create", filePath: fp } });
    else if (m[1] === "Delete") out.push({ name: "Edit", input: { file_path: fp }, structured: null, deleted: true });
    else out.push({ name: "Edit", input: { file_path: fp }, structured: null });
  }
  return out;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join("\n") : "");

/**
 * Pliki z wejścia hooka PostToolUse Codexa (przypominanie przy pliku). Codex zmienia pliki łatką, więc
 * `tool_input.file_path` zwykle nie ma: `apply_patch` niesie łatkę w `tool_input.command`, a skrypt `exec` ma ją
 * w napisie JS (jak przy zapisie tury). Instalator rejestruje hook z matcherem `apply_patch|exec`, więc komend
 * powłoki (Bash) tu nie ma. Zmieniony = z łatki; usunięty plik (Delete File) pomijamy: nie ma już czego czytać.
 */
export function codexHookFiles(input: any, max = 3): { path: string; changed: boolean }[] {
  const name = String(input?.tool_name ?? "");
  const ti = input?.tool_input;
  const st = { cwd: typeof input?.cwd === "string" && input.cwd ? input.cwd : null };
  const field = (...keys: string[]) => asText(typeof ti === "string" ? ti : keys.map((k) => ti?.[k]).find((v) => v != null));
  let calls: Omit<InnerCall, "id">[] = [];
  if (name === "apply_patch") calls = patchCalls(field("command", "input", "patch"), st);
  else if (name === "exec" || name === "js") calls = scriptCalls(field("code", "input", "script", "source"), st);
  else if (ti && typeof ti === "object" && (ti.file_path || ti.notebook_path)) {
    const fp = absPath(String(ti.file_path ?? ti.notebook_path), st.cwd);
    calls = [
      { name: /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? "Edit" : "Read", input: { file_path: fp }, structured: null },
    ];
  }
  const out = new Map<string, { path: string; changed: boolean }>();
  const norm = (p: unknown) => String(p).replace(/\\/g, "/").toLowerCase();
  // plik, którego ostatnią operacją jest usunięcie (Delete File bez późniejszego Add File)
  const gone = new Map<string, boolean>();
  for (const c of calls) if (typeof c.input.file_path === "string") gone.set(norm(c.input.file_path), c.deleted === true);
  for (const c of calls) {
    const fp = typeof c.input.file_path === "string" ? c.input.file_path : "";
    if (!fp || (c.name !== "Write" && c.name !== "Edit" && c.name !== "Read")) continue;
    const k = norm(fp);
    if (gone.get(k)) continue;
    const changed = c.name !== "Read";
    const prev = out.get(k);
    if (prev) prev.changed ||= changed;
    else if (out.size < max) out.set(k, { path: fp, changed });
  }
  return [...out.values()];
}

function outputText(o: unknown): string {
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n");
  if (o && typeof o === "object" && typeof (o as any).content === "string") return (o as any).content;
  return "";
}

/** Wynik wywołania: osobna linia na każde wewnętrzne wywołanie (Claude Code ma jedną linię na wynik). */
function toolResults(p: any, at: unknown, st: CodexState): any[] {
  const callId = String(p.call_id ?? "");
  const text = outputText(p.output);
  const failed = /^\s*Script failed/.test(text);
  const calls = st.pending.get(callId);
  st.pending.delete(callId);
  if (!calls) return [userLine(at, st, [{ type: "tool_result", tool_use_id: callId, content: text, is_error: failed }])];
  // kody wyjścia komend w kolejności wywołań (wynik exec_command wypisany przez text())
  const codes = [...text.matchAll(/"exit_code"\s*:\s*(-?\d+)/g)].map((m) => Number(m[1]));
  const shells = calls.filter((c) => isShell(c.name));
  const byCode = codes.length === shells.length;
  return calls.map((c, i) => {
    const last = i === calls.length - 1;
    const code = isShell(c.name) && byCode ? codes[shells.indexOf(c)] : null;
    const isError = code !== null ? code !== 0 : last && failed;
    return userLine(
      at,
      st,
      [{ type: "tool_result", tool_use_id: c.id, content: isError || last ? text : "", is_error: isError }],
      {
        toolUseResult: c.structured ?? undefined,
      },
    );
  });
}
