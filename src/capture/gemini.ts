// Sesje Gemini CLI (~/.gemini/tmp/<projekt>/chats/session-*.jsonl) w kształcie linii Claude Code, jak rollouty
// Codexa: reszta zapisu (tury, streszczenie, nadrabianie) zostaje wspólna.
// Gemini CLI dopisuje linie: pierwsza to metadane sesji ({sessionId, projectHash, startTime, kind}), potem wiadomości
// {id, timestamp, type: user|gemini|info|error|warning, content, toolCalls, model}. Wiadomość modelu wraca w całości
// jeszcze raz, gdy dochodzą wywołania narzędzi i ich wyniki (to samo `id`), więc z każdej wersji bierzemy tylko to,
// czego wcześniejsze nie miały. Rekordy `$set` i `$patch` (tytuł, przepisanie historii) nie zmieniają tego, co już się
// wydarzyło: pomijamy je. `$rewindTo` (cofnięcie do wiadomości: ona i wszystko po niej znika z historii) daje znacznik
// `gemini-rewind`, a zapis (ingest) odsyła tury od tej wiadomości do archiwum. Podagenci piszą do chats/<id rodzica>/
// i mają kind: subagent. Starsze wersje zapisywały sesję jako jeden plik JSON (`session-*.json`, cały przepisywany
// przy każdej wiadomości, te same wiadomości w `messages`): czyta go tłumacz tekstowy w całości od początku pliku.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveIn } from "../util/paths.ts";
import type { Translator } from "./formats.ts";
import type { Line } from "./transcript.ts";

/** Katalog Gemini CLI (~/.gemini; HIPOKAMP_HARNESS_HOME zastępuje katalog domowy dla wszystkich harnessów). */
export function geminiDir(): string {
  return join(process.env.HIPOKAMP_HARNESS_HOME || homedir(), ".gemini");
}

const RE_CHAT = /[\\/]chats[\\/]session-[^\\/]+\.jsonl?$/i;

/** Starszy zapis sesji: jeden plik JSON (`session-*.json`). */
export const isGeminiJson = (path: string): boolean => /\.json$/i.test(path);

/** Plik sesji Gemini CLI (główny wątek; podagenci leżą piętro niżej i nie pasują do wzorca). */
export function isGeminiTranscript(path: string): boolean {
  return RE_CHAT.test(path);
}

/** Pierwsza linia pliku (metadane sesji) albo null. */
function firstLine(path: string): any {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0) return null;
    return JSON.parse(buf.toString("utf8", 0, nl).replace(/^﻿/, ""));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Początek pliku (do 64 KB) jako tekst albo "". */
function head(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

const metas = new Map<string, { sessionId: string | null; subagent: boolean }>();

/** Id sesji z metadanych (to samo, które hook dostaje jako session_id) i czy to wątek podagenta. */
export function geminiMeta(path: string): { sessionId: string | null; subagent: boolean } {
  const hit = metas.get(path);
  if (hit) return hit;
  let m: { sessionId: string | null; subagent: boolean };
  if (isGeminiJson(path)) {
    // starszy zapis: pola sesji przed listą wiadomości, bez parsowania całego pliku
    const top = head(path).split(/"messages"\s*:/)[0];
    const id = /"sessionId"\s*:\s*"([^"\\]+)"/.exec(top)?.[1] ?? null;
    m = { sessionId: /^\s*\{/.test(top) ? id : null, subagent: /"kind"\s*:\s*"subagent"/.test(top) };
  } else {
    const j = firstLine(path);
    m = { sessionId: typeof j?.sessionId === "string" && !j.type ? j.sessionId : null, subagent: j?.kind === "subagent" };
  }
  if (m.sessionId) metas.set(path, m);
  return m;
}

const roots = new Map<string, string | null>();

/** Katalog projektu z pliku `.project_root` w katalogu projektu Gemini CLI (starsze wersje go nie piszą: null). */
function projectRoot(path: string): string | null {
  const dir = dirname(dirname(path));
  if (roots.has(dir)) return roots.get(dir)!;
  let root: string | null = null;
  try {
    root = readFileSync(join(dir, ".project_root"), "utf8").trim() || null;
  } catch {}
  roots.set(dir, root);
  return root;
}

/**
 * Pliki sesji z ~/.gemini/tmp/<projekt>/chats (bez podagentów), klucz sesji z przedrostkiem `gemini:`. Sesja zapisana
 * w obu formatach (starszy `.json` i `.jsonl` po aktualizacji Gemini CLI) idzie raz, z pliku `.jsonl`.
 */
export function listGeminiChats(): { path: string; sessionId: string; size: number; mtime: number }[] {
  const out: { path: string; sessionId: string; size: number; mtime: number }[] = [];
  const tmp = join(geminiDir(), "tmp");
  let projects: string[] = [];
  try {
    projects = readdirSync(tmp);
  } catch {
    return out;
  }
  for (const p of projects) {
    const chats = join(tmp, p, "chats");
    let names: string[] = [];
    try {
      names = readdirSync(chats);
    } catch {
      continue;
    }
    const seen = new Set<string>();
    // .jsonl przed .json: ta sama sesja w obu formatach zostaje przy nowszym
    for (const f of names.sort((a, b) => Number(isGeminiJson(a)) - Number(isGeminiJson(b)))) {
      if (!/^session-.*\.jsonl?$/i.test(f)) continue;
      const path = join(chats, f);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        const m = geminiMeta(path);
        if (!m.sessionId || m.subagent || seen.has(m.sessionId)) continue;
        seen.add(m.sessionId);
        out.push({ path, sessionId: `gemini:${m.sessionId}`, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

// ── tłumaczenie linii ────────────────────────────────────────────────────────────────────────────────────

const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";

/** Stan tłumaczenia w obrębie jednego odczytu: co z każdej wiadomości już wyszło (wersje tej samej wiadomości). */
export interface GeminiState {
  cwd: string | null;
  seen: Map<string, { text: string; calls: Set<string>; results: Set<string> }>;
  /** Czas wiadomości użytkownika po id (znacznik `$rewindTo` niesie czas wiadomości, do której cofnięto). */
  users: Map<string, string>;
}

export function geminiState(path: string): GeminiState {
  return { cwd: projectRoot(path), seen: new Map(), users: new Map() };
}

/** Tekst z PartListUnion (napis, część albo lista części); części z wynikiem funkcji jako jego treść. */
function partsText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(partsText).filter(Boolean).join("\n");
  if (!c || typeof c !== "object") return "";
  const p = c as any;
  if (typeof p.text === "string" && !p.thought) return p.text;
  const r = p.functionResponse?.response;
  if (r) return typeof r.output === "string" ? r.output : typeof r.error === "string" ? r.error : JSON.stringify(r);
  return "";
}

const hasImage = (c: unknown): boolean =>
  Array.isArray(c) &&
  c.some((p: any) => typeof p?.inlineData?.mimeType === "string" && p.inlineData.mimeType.startsWith("image/"));

/** Narzędzie Gemini CLI jako narzędzie Claude Code (nazwa i pola, które czyta streszczenie). */
function toolCall(tc: any, cwd: string | null): { name: string; input: Record<string, any> } {
  const a = tc.args && typeof tc.args === "object" ? tc.args : tc.input && typeof tc.input === "object" ? tc.input : {};
  const fp = (v: unknown) => (typeof v === "string" && v ? resolveIn(cwd, v) : undefined);
  const name = String(tc.name ?? "");
  switch (name) {
    case "read_file":
      return { name: "Read", input: { file_path: fp(a.file_path ?? a.absolute_path ?? a.path) } };
    case "write_file":
      return { name: "Write", input: { file_path: fp(a.file_path ?? a.absolute_path) } };
    case "replace":
    case "edit":
      return { name: "Edit", input: { file_path: fp(a.file_path ?? a.absolute_path) } };
    case "run_shell_command":
      return { name: SHELL, input: { command: String(a.command ?? "") } };
    case "glob":
      return { name: "Glob", input: { pattern: a.pattern, path: a.path ?? a.dir_path } };
    case "search_file_content":
    case "grep_search":
    case "grep":
      return { name: "Grep", input: { pattern: a.pattern, path: a.path ?? a.dir_path } };
    case "list_directory":
      return { name: "LS", input: { path: a.path ?? a.dir_path } };
    case "web_fetch":
      return { name: "WebFetch", input: { url: a.url ?? String(a.prompt ?? "").match(/https?:\/\/\S+/)?.[0] } };
    case "google_web_search":
    case "web_search":
      return { name: "WebSearch", input: { query: a.query } };
    case "codebase_investigator":
    case "delegate_to_agent":
      return { name: "Agent", input: { description: String(a.objective ?? a.agent_name ?? a.task ?? name).slice(0, 200) } };
    default:
      return { name: mcpName(tc, name), input: a };
  }
}

/**
 * Narzędzie MCP w zapisie Claude Code (`mcp__<serwer>__<narzędzie>`), żeby capture.privateTools (`mcp__sejf__`)
 * i etykiety działały jak w Claude Code. Gemini CLI zapisuje gołą nazwę narzędzia (albo `serwer__narzędzie` przy
 * konflikcie nazw), a serwer jest w displayName: „<narzędzie> (<serwer> MCP Server)”.
 */
function mcpName(tc: any, name: string): string {
  const m = /^(.+?) \((.+) MCP Server\)$/.exec(String(tc.displayName ?? ""));
  if (m) {
    const tool = name.includes("__") ? name.slice(name.indexOf("__") + 2) : m[1];
    return `mcp__${m[2]}__${tool}`;
  }
  return name.indexOf("__") > 0 && !name.startsWith("mcp__") ? `mcp__${name}` : name;
}

/** Czy wywołanie ma już wynik (stary zapis: status; nowy: sam wynik). */
const finished = (tc: any): boolean => ["success", "error", "cancelled"].includes(String(tc.status ?? "")) || tc.result != null;

/** Linia sesji Gemini CLI jako zero lub więcej linii w kształcie Claude Code. */
export function fromGemini(j: any, st: GeminiState): any[] {
  if (!j || typeof j !== "object" || "$set" in j || "$patch" in j) return [];
  // cofnięcie: wiadomość `$rewindTo` i wszystkie po niej znikają z historii (czas, gdy ten odczyt ją widział)
  if ("$rewindTo" in j) {
    const target = typeof j.$rewindTo === "string" ? j.$rewindTo : "";
    return target ? [{ type: "gemini-rewind", target, timestamp: st.users.get(target) ?? null }] : [];
  }
  if (typeof j.sessionId === "string" && !j.type) return [{ type: "session-meta", timestamp: j.startTime, cwd: st.cwd }];
  const id = String(j.id ?? "");
  const at = j.timestamp;
  if (j.type === "user") {
    if (!id || st.seen.has(id)) return [];
    st.seen.set(id, { text: "", calls: new Set(), results: new Set() });
    if (typeof at === "string") st.users.set(id, at);
    const raw = j.displayContent ?? j.content;
    // treść plików dołączonych przez @ (Gemini CLI dokleja je do wiadomości) to nie słowa człowieka
    const text = partsText(raw)
      .replace(/\n*--- Content from referenced files ---[\s\S]*$/, "")
      .trim();
    const content: object[] = [];
    if (hasImage(j.content)) content.push({ type: "image" });
    if (text) content.push({ type: "text", text: commandLike(text) });
    return content.length ? [{ type: "user", uuid: id, timestamp: at, cwd: st.cwd, message: { role: "user", content } }] : [];
  }
  if (j.type !== "gemini" || !id) return []; // info, error, warning: komunikaty interfejsu
  let s = st.seen.get(id);
  if (!s) st.seen.set(id, (s = { text: "", calls: new Set(), results: new Set() }));
  const out: any[] = [];
  const blocks: object[] = [];
  const text = partsText(j.content).trim();
  if (text && text !== s.text && !s.text.startsWith(text)) {
    // nowa wersja wiadomości dopisała tekst: tylko przyrost
    blocks.push({ type: "text", text: s.text && text.startsWith(s.text) ? text.slice(s.text.length).trim() : text });
    s.text = text;
  }
  const calls: any[] = Array.isArray(j.toolCalls) ? j.toolCalls : [];
  for (const tc of calls) {
    const cid = String(tc?.id ?? "");
    if (!cid || s.calls.has(cid)) continue;
    s.calls.add(cid);
    blocks.push({ type: "tool_use", id: cid, ...toolCall(tc, st.cwd) });
  }
  if (blocks.length)
    out.push({
      type: "assistant",
      uuid: id,
      timestamp: at,
      cwd: st.cwd,
      message: { role: "assistant", model: j.model ?? null, content: blocks, stop_reason: null },
    });
  for (const tc of calls) {
    const cid = String(tc?.id ?? "");
    if (!cid || s.results.has(cid) || !finished(tc)) continue;
    s.results.add(cid);
    const res = partsText(tc.result) || String(tc.resultDisplay ?? "");
    const isError = tc.status === "error" || tc.status === "cancelled";
    const created = tc.name === "write_file" && /^Successfully created/i.test(res);
    out.push({
      type: "user",
      timestamp: tc.timestamp ?? at,
      cwd: st.cwd,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: cid, content: res, is_error: isError }] },
      toolUseResult: created ? { type: "create" } : undefined,
    });
  }
  return out;
}

/** Komenda z ukośnikiem (`/memory show`) jak komenda Claude Code: prompt bez numeru, gdy model nie odpowiada. */
function commandLike(text: string): string {
  const m = /^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m || text.includes("\n")) return text;
  return `<command-name>/${m[1]}</command-name><command-args>${m[2] ?? ""}</command-args>`;
}

/**
 * Tłumacz starszego zapisu (`session-*.json`, jeden obiekt JSON z listą `messages`): linie składane do końca pliku
 * i parsowane w całości, a każda wiadomość dostaje zakres bajtów od linii ze swoim `"id"` do następnej wiadomości.
 * Tylko odczyt od początku pliku: plik jest przepisywany w całości, więc jego ogon po wcześniejszym odczycie nie jest
 * JSON-em (dopisek po pełnym odczycie, gdy stara wersja CLI dalej pisze plik, nie wchodzi).
 */
/**
 * Starszy zapis `.json` to jeden obiekt przepisywany w całości przy każdej wiadomości, więc po odczycie dopisana tura
 * byłaby nie do odczytania (ogon to nie JSON). Plik czytamy dopiero po tylu godzinach ciszy: sesja jest wtedy
 * zamknięta, a jej wszystkie tury (też ostatnia) wchodzą za jednym razem.
 */
export const GEMINI_JSON_QUIET_MS = 12 * 3600_000;

export function geminiJsonTranslator(path: string): Translator {
  const st = geminiState(path);
  let quiet = false;
  try {
    quiet = Date.now() - statSync(path).mtimeMs >= GEMINI_JSON_QUIET_MS;
  } catch {}
  let raw: { text: string; start: number; end: number }[] = [];
  const flush = (): Line[] => {
    // plik jeszcze żyje: całość czeka (pendingFrom trzyma offset na początku)
    if (!quiet) return [];
    const rows = raw;
    raw = [];
    if (!rows.length || rows[0].start !== 0) return [];
    let rec: any;
    try {
      rec = JSON.parse(rows.map((r) => r.text).join("\n"));
    } catch {
      return [];
    }
    const msgs: any[] = Array.isArray(rec?.messages) ? rec.messages : [];
    // początek wiadomości: pierwsza linia z jej `"id": "<id>"` po początku poprzedniej
    const starts: number[] = [];
    let k = 0;
    for (const m of msgs) {
      const id = typeof m?.id === "string" ? JSON.stringify(m.id) : null;
      let at = k;
      while (id && at < rows.length && !(rows[at].text.includes(id) && /"id"\s*:/.test(rows[at].text))) at++;
      if (id && at < rows.length) k = at;
      starts.push(rows[k].start);
    }
    const end = rows[rows.length - 1].end;
    const out: Line[] = [];
    for (const json of fromGemini({ sessionId: String(rec?.sessionId ?? ""), startTime: rec?.startTime }, st))
      out.push({ json, start: 0, end: starts[0] ?? end });
    msgs.forEach((m, i) => {
      for (const json of fromGemini(m, st)) out.push({ json, start: starts[i], end: starts[i + 1] ?? end });
    });
    return out;
  };
  return {
    skipUntil: 0,
    text: (text, start, end) => {
      raw.push({ text, start, end });
      return [];
    },
    flush,
    // całość czeka na koniec pliku: offset nie przechodzi za początek, dopóki plik nie da się przeczytać w całości
    pendingFrom: () => (raw.length ? raw[0].start : null),
  };
}
