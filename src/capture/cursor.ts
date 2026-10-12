// Transkrypty agenta Cursora w kształcie linii Claude Code (jak rollouty Codexa). Cursor pisze je do
// ~/.cursor/projects/<katalog jako slug>/agent-transcripts/: obecnie `<id>/<id>.jsonl` (linie jak w Claude Code, ale
// z `role` zamiast `type`, prompt w <user_query>, bez czasu i bez wywołań narzędzi), wcześniej `<id>.txt` (bloki
// `user:` / `assistant:` z [Tool call] Nazwa i parametrami `  klucz: wartość`, wyniki puste, bez czasu).
// Czasu w pliku nie ma: linie dostają czas zmiany pliku. Katalog projektu odtwarzamy ze sluga (zgadywanie po
// istniejących katalogach), a hook podaje go wprost (workspace_roots).
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveIn } from "../util/paths.ts";
import type { Translator } from "./formats.ts";
import type { Line } from "./transcript.ts";

/** Katalog Cursora (~/.cursor; HIPOKAMP_HARNESS_HOME zastępuje katalog domowy dla wszystkich harnessów). */
export function cursorDir(): string {
  return join(process.env.HIPOKAMP_HARNESS_HOME || homedir(), ".cursor");
}

const RE_TRANSCRIPT = /[\\/]agent-transcripts[\\/](?:[^\\/]+[\\/])?[^\\/]+\.(txt|jsonl)$/i;

export function isCursorTranscript(path: string): boolean {
  return RE_TRANSCRIPT.test(path);
}

/** Id rozmowy z nazwy pliku: to samo, które hook dostaje jako conversation_id. */
export const cursorSessionId = (path: string): string => basename(path).replace(/\.(txt|jsonl)$/i, "");

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Transkrypty z ~/.cursor/projects/*\/agent-transcripts, klucz sesji z przedrostkiem `cursor:`. */
export function listCursorTranscripts(): { path: string; sessionId: string; size: number; mtime: number }[] {
  const out: { path: string; sessionId: string; size: number; mtime: number }[] = [];
  const root = join(cursorDir(), "projects");
  let slugs: string[] = [];
  try {
    slugs = readdirSync(root);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(root, slug, "agent-transcripts");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const seen = new Set<string>();
    const add = (path: string) => {
      const id = cursorSessionId(path);
      if (!SAFE_ID.test(id) || seen.has(id)) return;
      try {
        const st = statSync(path);
        if (!st.isFile()) return;
        seen.add(id);
        out.push({ path, sessionId: `cursor:${id}`, size: st.size, mtime: st.mtimeMs });
      } catch {}
    };
    // nowy format (katalog rozmowy) przed starym, gdyby ta sama rozmowa była w obu
    for (const n of names) if (!/\.(txt|jsonl)$/i.test(n)) add(join(dir, n, `${n}.jsonl`));
    for (const n of names) if (/\.jsonl$/i.test(n)) add(join(dir, n));
    for (const n of names) if (/\.txt$/i.test(n)) add(join(dir, n));
  }
  return out;
}

/** Transkrypt rozmowy po id (hook bez transcript_path): najpierw katalog ze sluga cwd, potem wszystkie projekty. */
export function findCursorTranscript(id: string, cwd: string | null): string | null {
  if (!SAFE_ID.test(id)) return null;
  const root = join(cursorDir(), "projects");
  const candidates = (slug: string) => {
    const d = join(root, slug, "agent-transcripts");
    return [join(d, id, `${id}.jsonl`), join(d, `${id}.jsonl`), join(d, `${id}.txt`)];
  };
  if (cwd) for (const p of candidates(cursorSlug(cwd))) if (existsSync(p)) return p;
  let slugs: string[] = [];
  try {
    slugs = readdirSync(root);
  } catch {
    return null;
  }
  for (const s of slugs) for (const p of candidates(s)) if (existsSync(p)) return p;
  return null;
}

/**
 * Slug katalogu jak u Cursora (2.6, workspace-paths): każdy znak spoza liter i cyfr jako „-”, ciąg myślników jako
 * jeden, bez myślników na brzegach (`D:\code\a - b` → `D-code-a-b`).
 */
export function cursorSlug(dir: string): string {
  return dir
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Plik z wejścia narzędzia w hooku `postToolUse` Cursora (Read, Write, StrReplace…; Cursor podaje ścieżkę
 * w `path`, starsze narzędzia w `target_file` albo `file_path`), względna od katalogu projektu. Inne narzędzia: null.
 */
export function cursorHookFile(tool: unknown, input: unknown, cwd: string | null): string | null {
  const a = input && typeof input === "object" ? (input as Record<string, any>) : {};
  const name = String(tool ?? "");
  // usunięty plik: przypomnienie o nim nic nie da
  if (name === "Delete" || name === "delete_file") return null;
  const t = cursorTool(name, a, cwd);
  if (t.name !== "Read" && t.name !== "Write" && t.name !== "Edit") return null;
  return typeof t.input.file_path === "string" && t.input.file_path ? t.input.file_path : null;
}

const slugs = new Map<string, string | null>();

/** Slugi nazw w katalogu (slug małymi literami → nazwy), liczone raz na katalog: Temp ma dziesiątki tysięcy wpisów,
 *  a jeden slug sprawdza wiele długości członów. Ważne, dopóki nie zmieni się czas modyfikacji katalogu (nowy albo
 *  usunięty wpis), więc kolejne slugi kosztują jeden stat na poziom. */
const dirSlugs = new Map<string, { mtime: number; map: Map<string, string[]> }>();

function slugsIn(dir: string): Map<string, string[]> {
  let mtime = -1;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch {}
  const hit = dirSlugs.get(dir);
  if (hit && hit.mtime === mtime) return hit.map;
  const map = new Map<string, string[]>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) {
    if (/^\.+$/.test(n)) continue;
    const k = cursorSlug(n).toLowerCase();
    if (!k) continue;
    const l = map.get(k);
    if (l) l.push(n);
    else map.set(k, [n]);
  }
  if (dirSlugs.size > 256) dirSlugs.clear();
  dirSlugs.set(dir, { mtime, map });
  return map;
}

/**
 * Katalog ze sluga, po istniejących katalogach: „-” to separator albo ciąg znaków nazwy spoza liter i cyfr (myślnik,
 * kropka, spacja, ` - `), więc od każdego miejsca bierzemy najdłuższy katalog, którego slug to kolejne człony.
 * Pierwszy człon z jedną literą to dysk (Windows). null: nie da się odtworzyć (katalogu już nie ma).
 */
export function slugToPath(slug: string): string | null {
  if (slugs.has(slug)) return slugs.get(slug)!;
  const out = walkSlug(slug);
  slugs.set(slug, out);
  return out;
}

function walkSlug(slug: string): string | null {
  const tok = slug.split("-");
  let base: string;
  let i = 0;
  if (/^[A-Za-z]$/.test(tok[0]) && tok.length > 1 && existsSync(`${tok[0].toUpperCase()}:\\`)) {
    base = `${tok[0].toUpperCase()}:\\`;
    i = 1;
  } else base = "/";
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  let ok = tok.length <= 48 && tok.every(Boolean);
  while (ok && i < tok.length) {
    ok = false;
    // nazwy katalogów, których slug to kolejne człony (separatorem bywa każdy ciąg znaków spoza liter i cyfr)
    const names = slugsIn(base);
    for (let j = tok.length; j > i && !ok; j--) {
      const seg = tok.slice(i, j).join("-").toLowerCase();
      const hit = names.get(seg)?.find((n) => isDir(join(base, n)));
      if (hit) {
        base = join(base, hit);
        i = j;
        ok = true;
      }
    }
  }
  // wynik musi dawać z powrotem ten sam slug (wielkość liter bez znaczenia: dysk i katalogi Windows)
  return ok && cursorSlug(base).toLowerCase() === slug.toLowerCase() ? base : null;
}

/**
 * Katalog projektu transkryptu: …/projects/<slug>/agent-transcripts/[<id>/]<plik>. Slug, którego nie da się
 * odtworzyć (katalogu już nie ma), daje katalog Cursora tego projektu: projekt w pamięci ma wtedy stały klucz
 * ze sluga, a nie wspólny „nieznany”.
 */
function projectDir(path: string): string {
  let d = dirname(path);
  if (basename(d).toLowerCase() !== "agent-transcripts") d = dirname(d);
  const dir = dirname(d);
  return slugToPath(basename(dir)) ?? dir;
}

// ── tłumaczenie ──────────────────────────────────────────────────────────────────────────────────────────

const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";

/** Narzędzie Cursora jako narzędzie Claude Code (nazwa i pola, które czyta streszczenie). */
export function cursorTool(
  name: string,
  a: Record<string, any>,
  cwd: string | null,
): { name: string; input: Record<string, any> } {
  const fp = (v: unknown) => (typeof v === "string" && v ? resolveIn(cwd, v) : undefined);
  const file = fp(a.file_path ?? a.path ?? a.target_file ?? a.target_notebook);
  switch (name) {
    case "Read":
    case "read_file":
      return { name: "Read", input: { file_path: file } };
    case "Write":
    case "write":
      return { name: "Write", input: { file_path: file } };
    case "StrReplace":
    case "search_replace":
    case "Edit":
    case "MultiEdit":
    case "edit_file":
    case "EditNotebook":
    case "Delete":
    case "delete_file":
      return { name: "Edit", input: { file_path: file } };
    case "Shell":
    case "run_terminal_cmd":
      return { name: SHELL, input: { command: String(a.command ?? "") } };
    case "Grep":
    case "grep":
    case "codebase_search":
    case "SemanticSearch":
      return { name: "Grep", input: { pattern: a.pattern ?? a.query, path: a.path ?? a.target_directory } };
    case "Glob":
    case "glob_file_search":
    case "file_search":
      return { name: "Glob", input: { pattern: a.glob_pattern ?? a.pattern ?? a.query, path: a.target_directory } };
    case "LS":
    case "LS_DIR":
    case "list_dir":
      return { name: "LS", input: { path: a.path ?? a.target_directory } };
    case "WebSearch":
    case "web_search":
      return { name: "WebSearch", input: { query: a.search_term ?? a.query } };
    case "WebFetch":
    case "mcp_web_fetch":
      return { name: "WebFetch", input: { url: a.url } };
    case "Task":
      return { name: "Agent", input: { description: String(a.description ?? a.subagent_type ?? "agent") } };
    default:
      return { name, input: a };
  }
}

/** Prompt z bloku: treść <user_query> (Cursor dokleja obok pliki, reguły i stan edytora), bez znaczników. */
function userText(text: string): string {
  const q = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)].map((m) => m[1]);
  return (q.length ? q.join("\n\n") : text).trim();
}

/**
 * Plik .txt bez zmian od tylu ms: ostatni blok jest skończony. Wcześniej Cursor może go jeszcze dopisywać (bez nowego
 * nagłówka), więc blok przy końcu pliku czeka, a offset nie przechodzi za jego początek.
 */
export const TXT_QUIET_MS = 30_000;

/** Tłumacz jednego odczytu: .jsonl linia po linii, .txt bloki `user:` / `assistant:` składane z linii tekstu. */
export function cursorTranslator(path: string): Translator {
  const cwd = projectDir(path);
  let at: string | null = null;
  let quiet = false;
  try {
    const mtime = statSync(path).mtimeMs;
    at = new Date(mtime).toISOString();
    quiet = Date.now() - mtime >= TXT_QUIET_MS;
  } catch {}
  if (/\.jsonl$/i.test(path)) return { skipUntil: 0, json: (j) => fromCursorJson(j, cwd, at) };

  type Block = { role: "user" | "assistant"; start: number; end: number; lines: string[] };
  let block: Block | null = null;
  // wewnątrz <think> i <user_query> nagłówek roli to treść, nie granica bloku
  let quoted = false;
  const close = (): Line[] => {
    const b = block;
    block = null;
    if (!b) return [];
    const json = b.role === "user" ? txtUser(b.lines, cwd, at) : txtAssistant(b.lines, b.start, cwd, at);
    return json ? [{ json, start: b.start, end: b.end }] : [];
  };
  // koniec pliku: blok domykamy dopiero w cichym pliku. Odpowiedź asystenta na końcu cichego pliku kończy turę
  // (format nie zapisuje końca tury), więc nadrabianie nie czeka na nią 12 h
  const flush = (): Line[] => {
    const b = block;
    if (!quiet || !b) return [];
    const out = close();
    if (b.role !== "assistant") return out;
    const last = out[out.length - 1];
    if (last) last.json.message.stop_reason = "end_turn";
    else
      out.push({
        json: {
          type: "assistant",
          timestamp: at,
          cwd,
          message: { role: "assistant", model: null, content: [], stop_reason: "end_turn" },
        },
        start: b.start,
        end: b.end,
      });
    return out;
  };
  return {
    skipUntil: 0,
    text: (raw, start, end) => {
      const line = raw.replace(/\r$/, "");
      const head = !quoted && /^(user|assistant):\s*$/.exec(line);
      if (head) {
        const out = close();
        block = { role: head[1] as Block["role"], start, end, lines: [] };
        return out;
      }
      if (/<think>|<user_query>/.test(line) && !/<\/think>|<\/user_query>/.test(line)) quoted = true;
      else if (/<\/think>|<\/user_query>/.test(line)) quoted = false;
      if (block) {
        block.lines.push(line);
        block.end = end;
      }
      return [];
    },
    flush,
    pendingFrom: () => (block ? (block as Block).start : null),
  };
}

function txtUser(lines: string[], cwd: string | null, at: string | null): any {
  const text = userText(lines.join("\n"));
  if (!text) return null;
  return { type: "user", timestamp: at, cwd, message: { role: "user", content: [{ type: "text", text }] } };
}

function txtAssistant(lines: string[], start: number, cwd: string | null, at: string | null): any {
  const content: any[] = [];
  const texts: string[] = [];
  let mode: "text" | "think" | "call" = "text";
  let call: { name: string; args: Record<string, string>; last: string | null } | null = null;
  const endCall = () => {
    if (!call) return;
    // pusta linia przed [Tool result] to odstęp, nie dalszy ciąg wartości
    for (const k of Object.keys(call.args)) call.args[k] = call.args[k].trimEnd();
    content.push({ type: "tool_use", id: `${start}:${content.length}`, ...cursorTool(call.name, call.args, cwd) });
    call = null;
  };
  for (const l of lines) {
    if (mode === "think") {
      if (l.includes("</think>")) mode = "text";
      continue;
    }
    if (l.startsWith("<think>")) {
      if (!l.includes("</think>")) mode = "think";
      continue;
    }
    const tc = /^\[Tool call\]\s+(\S+)/.exec(l);
    if (tc) {
      endCall();
      call = { name: tc[1], args: {}, last: null };
      mode = "call";
      continue;
    }
    if (/^\[Tool result\]/.test(l)) {
      endCall();
      mode = "text";
      continue;
    }
    if (mode === "call" && call) {
      const c = call as { name: string; args: Record<string, string>; last: string | null };
      const kv = /^ {2}([a-z_]+):\s?(.*)$/.exec(l);
      if (kv) {
        c.args[kv[1]] = kv[2];
        c.last = kv[1];
      } else if (c.last && c.args[c.last].length < 2000) c.args[c.last] += `\n${l}`;
      continue;
    }
    texts.push(l);
  }
  endCall();
  const text = texts.join("\n").trim();
  if (text) content.unshift({ type: "text", text });
  if (!content.length) return null;
  return {
    type: "assistant",
    timestamp: at,
    cwd,
    message: { role: "assistant", model: null, content, stop_reason: null },
  };
}

/** Linia .jsonl Cursora (`role` zamiast `type`) w kształcie Claude Code; `turn_ended` jak koniec tury. */
function fromCursorJson(j: any, cwd: string | null, at: string | null): any[] {
  const role = j?.type ?? j?.role;
  const timestamp = j?.timestamp ?? at;
  if (role === "turn_ended")
    return [
      { type: "assistant", timestamp, cwd, message: { role: "assistant", model: null, content: [], stop_reason: "end_turn" } },
    ];
  if (role === "tool_result")
    return [
      {
        type: "user",
        timestamp,
        cwd,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: String(j.tool_use_id ?? j.id ?? ""), content: j.content ?? "" }],
        },
      },
    ];
  if (role !== "user" && role !== "assistant") return [];
  const raw = j.message?.content ?? j.content;
  const blocks: any[] = typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? raw : [];
  const content: any[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      const text = role === "user" ? userText(b.text) : b.text;
      if (text.trim()) content.push({ type: "text", text });
    } else if (b?.type === "tool_use") {
      const a = b.input && typeof b.input === "object" ? b.input : {};
      content.push({ type: "tool_use", id: String(b.id ?? ""), ...cursorTool(String(b.name ?? ""), a, cwd) });
    } else if (b?.type === "tool_result" || b?.type === "image") content.push(b);
  }
  if (!content.length) return [];
  if (role === "user") return [{ type: "user", uuid: j.id, timestamp, cwd, message: { role: "user", content } }];
  return [
    {
      type: "assistant",
      timestamp,
      cwd,
      message: { role: "assistant", model: j.model ?? j.message?.model ?? null, content, stop_reason: null },
    },
  ];
}
