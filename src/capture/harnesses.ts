// Inne harnessy niż Claude Code i Codex: gdzie mają konfigurację i sesje, czy są na tej maszynie, które pliki
// sesji idą do nadrabiania i backfillu, i jak ich hooki mówią do hook.ts. Klucz sesji ma przedrostek harnessu
// (`gemini:`, `cursor:`, `opencode:`, `desktop:`), więc nie koliduje z sesjami Claude Code i Codexa.
// Zapis: Gemini CLI (hooki i ~/.gemini/tmp/*/chats), Cursor (hooki i agent-transcripts), OpenCode (plugin hipokampa
// pisze transkrypt w kształcie Claude Code), Claude Desktop (sesje Cowork to transkrypty Claude Code).
// Antigravity: tylko serwer MCP (rozmowy w SQLite z blobami protobuf, log w katalogu .system_generated bez opisu).
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Config, DATA_DIR, type HarnessSwitches, isExcludedTranscript, loadConfig, paths } from "../config.ts";
import { isSubdir, samePath } from "../util/paths.ts";
import { cursorDir, cursorHookFile, findCursorTranscript, listCursorTranscripts } from "./cursor.ts";
import { geminiDir, listGeminiChats } from "./gemini.ts";
import { PRUNED_FILE } from "./opencode-plugin.ts";

export const HARNESSES = ["gemini", "antigravity", "cursor", "opencode", "claude-desktop"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Harnessy, których hooki wołają hook.ts (`bun hook.ts <zdarzenie> <harness>`). */
export type HookHarness = "gemini" | "cursor" | "opencode";

export const LABEL: Record<Harness, string> = {
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode",
  "claude-desktop": "Claude Desktop",
};

const KEY: Record<Harness, keyof HarnessSwitches> = {
  gemini: "gemini",
  antigravity: "antigravity",
  cursor: "cursor",
  opencode: "opencode",
  "claude-desktop": "claudeDesktop",
};

/** Przedrostek klucza sesji (Antigravity nie zapisuje sesji). */
export const PREFIX: Record<Exclude<Harness, "antigravity">, string> = {
  gemini: "gemini:",
  cursor: "cursor:",
  opencode: "opencode:",
  "claude-desktop": "desktop:",
};

/** Katalog domowy dla harnessów; HIPOKAMP_HARNESS_HOME go zastępuje (testy nigdy nie czytają prawdziwych). */
const home = () => process.env.HIPOKAMP_HARNESS_HOME || homedir();

/** Katalog konfiguracji OpenCode (XDG_CONFIG_HOME, jak sam OpenCode; także na Windows ~/.config/opencode). */
export function opencodeDir(): string {
  const h = process.env.HIPOKAMP_HARNESS_HOME;
  return join(h ? join(h, ".config") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

/** Katalog danych Claude Desktop (Windows: %APPDATA%\Claude, macOS: Application Support, Linux: ~/.config/Claude). */
export function claudeDesktopDir(): string {
  const h = process.env.HIPOKAMP_HARNESS_HOME;
  if (process.platform === "win32")
    return join(h ? join(h, "AppData", "Roaming") : process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude");
  if (process.platform === "darwin") return join(home(), "Library", "Application Support", "Claude");
  return join(h ? join(h, ".config") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude");
}

/** Pliki serwerów MCP Antigravity: aplikacja, jej wcześniejsza wersja i Antigravity CLI (te, których katalog jest). */
export function antigravityMcpFiles(): string[] {
  const g = geminiDir();
  return [join(g, "antigravity"), join(g, "antigravity-ide"), join(g, "config")]
    .filter(isDir)
    .map((d) => join(d, "mcp_config.json"));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Czy harness jest na tej maszynie: istnieje jego katalog konfiguracji. */
export function detected(h: Harness): boolean {
  switch (h) {
    case "gemini":
      return isFile(join(geminiDir(), "settings.json")) || isDir(join(geminiDir(), "tmp"));
    case "antigravity":
      return antigravityMcpFiles().length > 0;
    case "cursor":
      return isDir(cursorDir());
    case "opencode":
      return isDir(opencodeDir());
    case "claude-desktop":
      return isDir(claudeDesktopDir());
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Klucz harnessu w capture.harnesses. */
export const harnessKey = (h: Harness): keyof HarnessSwitches => KEY[h];

/** Stan instalacji harnessów (install/harnesses.ts): założone pliki i klucze, podłączone harnessy. */
export const harnessStateFile = () => join(paths.state(), "harness-files.json");

/** Harnessy podłączone przez `hipokamp install` i jeszcze nie odłączone rollbackiem. */
export function installedHarnesses(): Harness[] {
  try {
    const v = JSON.parse(readFileSync(harnessStateFile(), "utf8"))?.installed;
    return Array.isArray(v) ? HARNESSES.filter((h) => v.includes(h)) : [];
  } catch {
    return [];
  }
}

/**
 * Czy zapis sesji harnessu działa: przełącznik z config.json (true: zawsze, false: nigdy), a bez niego (null) dopiero
 * po `hipokamp install`, który go podłączył (sama obecność harnessu na maszynie nie wystarcza), i dopóki jest na maszynie.
 */
export function harnessOn(h: Harness, cfg: Config = loadConfig()): boolean {
  const v = cfg.capture.harnesses?.[KEY[h]];
  if (v === true) return true;
  if (v === false) return false;
  return detected(h) && installedHarnesses().includes(h);
}

/** Transkrypty sesji OpenCode pisze plugin hipokampa (src/capture/opencode-plugin.ts). */
export function opencodeTranscripts(): string {
  return join(DATA_DIR, "transcripts", "opencode");
}

type TranscriptFile = { path: string; sessionId: string; size: number; mtime: number };

/** Pliki `<katalog>/*.jsonl` z kluczem sesji `<przedrostek><nazwa pliku>`. */
function jsonlIn(dir: string, prefix: string, out: TranscriptFile[]): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const st = statSync(join(dir, f));
      if (st.isFile())
        out.push({ path: join(dir, f), sessionId: `${prefix}${f.slice(0, -6)}`, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
}

const dirs = (p: string): string[] => {
  try {
    return readdirSync(p).filter((d) => isDir(join(p, d)));
  } catch {
    return [];
  }
};

/**
 * Sesje Cowork z Claude Desktop: Claude Code w piaskownicy pisze transkrypty do
 * local-agent-mode-sessions/<konto>/<organizacja>/<sesja>/.claude/projects/<katalog>/<uuid>.jsonl (agent stały:
 * …/agent/<sesja>/.claude/…). Karta Code aplikacji pisze do ~/.claude/projects, które czyta zapis Claude Code.
 */
export function listDesktopTranscripts(): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const root = join(claudeDesktopDir(), "local-agent-mode-sessions");
  const projects = (d: string) => {
    for (const slug of dirs(join(d, ".claude", "projects")))
      jsonlIn(join(d, ".claude", "projects", slug), PREFIX["claude-desktop"], out);
  };
  for (const acct of dirs(root))
    for (const org of dirs(join(root, acct)))
      for (const s of dirs(join(root, acct, org))) {
        const d = join(root, acct, org, s);
        if (s === "agent") for (const a of dirs(d)) projects(join(d, a));
        else projects(d);
      }
  return out;
}

/** Sesja Cowork: katalog piaskownicy (cwd Claude Code w sesji), katalog sesji i katalogi wybrane przez użytkownika. */
export interface CoworkSession {
  cwd: string | null;
  root: string;
  folders: string[];
}

/** Projekt sesji Cowork bez katalogu wybranego przez użytkownika (alias katalogu piaskownicy). */
export const COWORK_PROJECT = "cowork";

const coworks = new Map<string, { mtime: number; s: CoworkSession | null }>();

/**
 * Sesja Cowork po pliku transkryptu …/<sesja local_…>/.claude/projects/<katalog>/<uuid>.jsonl: metadane Claude Desktop
 * leżą obok katalogu sesji (`<sesja>.json`: `cwd`, `userSelectedFolders`). null: to nie transkrypt Cowork albo brak
 * metadanych. Odczyt zapamiętany do zmiany pliku metadanych.
 */
export function coworkSession(transcriptPath: string): CoworkSession | null {
  const projects = dirname(dirname(transcriptPath));
  const claude = dirname(projects);
  const root = dirname(claude);
  if (basename(projects) !== "projects" || basename(claude) !== ".claude" || !/^local_/i.test(basename(root))) return null;
  const file = `${root}.json`;
  let mtime = -1;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {}
  const hit = coworks.get(root);
  if (hit && hit.mtime === mtime) return hit.s;
  let s: CoworkSession | null = null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const folders = (Array.isArray(j?.userSelectedFolders) ? j.userSelectedFolders : [])
      .map((f: any) => (typeof f === "string" ? f : f?.path))
      .filter((f: unknown): f is string => typeof f === "string" && !!f.trim());
    s = { cwd: typeof j?.cwd === "string" && j.cwd.trim() ? j.cwd : null, root, folders };
  } catch {}
  coworks.set(root, { mtime, s });
  return s;
}

/**
 * Katalog tury Cowork dla projektu i kluczy plików: cwd w piaskownicy (katalog sesji, `cwd` z metadanych albo ich
 * podkatalog; w maszynie wirtualnej `/sessions/<nazwa>`) to pierwszy katalog wybrany przez użytkownika, a bez niego
 * `cwd` piaskownicy sesji (projekt `cowork`, alias zakłada zapis). cwd spoza piaskownicy zostaje.
 */
export function coworkCwd(s: CoworkSession, cwd: string | null): string | null {
  const own = s.cwd ?? cwd;
  const inside =
    !cwd || samePath(cwd, s.root) || isSubdir(cwd, s.root) || (!!s.cwd && (samePath(cwd, s.cwd) || isSubdir(cwd, s.cwd)));
  if (!inside) return cwd;
  return s.folders[0] ?? own;
}

/**
 * Sprzątanie transkryptów pluginu OpenCode (kopie rozmów poza OpenCode): plik bez zmian od capture.opencodeKeepDays
 * dni (0: nigdy) znika, gdy zapis przeczytał go do końca (`consumed`) albo zapis OpenCode jest wyłączony (nikt go już
 * nie przeczyta). Nazwa i czas zmiany trafiają do PRUNED_FILE: wznowiona później sesja dostaje nowy plik tylko
 * z nowszymi wiadomościami (transcriptName). Zwraca liczbę usuniętych plików.
 */
export function pruneOpencodeTranscripts(
  cfg: Config,
  consumed: (sessionId: string, size: number) => boolean,
  now = Date.now(),
): number {
  const days = cfg.capture.opencodeKeepDays;
  if (!(days > 0)) return 0;
  const dir = opencodeTranscripts();
  const files: TranscriptFile[] = [];
  jsonlIn(dir, PREFIX.opencode, files);
  const on = harnessOn("opencode", cfg);
  const gone: Record<string, number> = {};
  for (const f of files) {
    if (now - f.mtime < days * 86_400_000 || (on && !consumed(f.sessionId, f.size))) continue;
    try {
      rmSync(f.path);
      gone[basename(f.path, ".jsonl")] = Math.round(f.mtime);
    } catch {}
  }
  const n = Object.keys(gone).length;
  if (!n) return 0;
  let pruned: Record<string, number> = {};
  try {
    pruned = JSON.parse(readFileSync(join(dir, PRUNED_FILE), "utf8")) ?? {};
  } catch {}
  writeFileSync(join(dir, PRUNED_FILE), `${JSON.stringify({ ...pruned, ...gone })}\n`);
  return n;
}

/** Pliki sesji włączonych harnessów do nadrabiania i backfillu (bez wykluczonych katalogów). */
export function listHarnessTranscripts(cfg: Config = loadConfig()): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  if (harnessOn("gemini", cfg)) out.push(...listGeminiChats());
  if (harnessOn("cursor", cfg)) out.push(...listCursorTranscripts());
  if (harnessOn("opencode", cfg)) jsonlIn(opencodeTranscripts(), PREFIX.opencode, out);
  if (harnessOn("claude-desktop", cfg)) out.push(...listDesktopTranscripts());
  return out.filter((f) => !isExcludedTranscript(f.path, cfg));
}

/**
 * Wejście hooka innego harnessu w kształcie Claude Code: klucz sesji z przedrostkiem, a w Cursorze id rozmowy
 * (`conversation_id`), katalog z `workspace_roots` i transkrypt znaleziony po id, gdy hook go nie podał.
 * Gemini CLI ma pola jak Claude Code (session_id, transcript_path, cwd, prompt, tool_input.file_path).
 */
export function hookInput(h: HookHarness, input: any): any {
  const out = input && typeof input === "object" ? { ...input } : {};
  if (h === "cursor") {
    out.session_id = out.conversation_id ?? out.session_id;
    out.cwd ??= Array.isArray(out.workspace_roots) ? out.workspace_roots[0] : undefined;
    if (!out.transcript_path && out.session_id)
      out.transcript_path = findCursorTranscript(String(out.session_id), out.cwd ? String(out.cwd) : null) ?? undefined;
    // postToolUse: ścieżka pliku pod nazwą z Claude Code (przypomnienie przy pliku czyta tool_input.file_path)
    if (out.tool_input && typeof out.tool_input === "object") {
      const fp = cursorHookFile(out.tool_name, out.tool_input, out.cwd ? String(out.cwd) : null);
      out.tool_input = fp ? { ...out.tool_input, file_path: fp } : { ...out.tool_input, file_path: undefined };
    }
  }
  if (h === "gemini" && out.tool_input && typeof out.tool_input === "object" && !out.tool_input.file_path)
    out.tool_input = { ...out.tool_input, file_path: out.tool_input.absolute_path ?? out.tool_input.path };
  const id = out.session_id ? String(out.session_id) : "";
  if (id && !id.startsWith(PREFIX[h])) out.session_id = `${PREFIX[h]}${id}`;
  return out;
}
