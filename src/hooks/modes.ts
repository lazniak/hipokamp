// Tryby wywołania hooków (config hooks.mode) i hooks.json pluginu dla każdego z nich. Pomiary i rekomendacja:
// docs/ARCHITEKTURA.md, sekcja „Hooki: tryby wywołania”.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HooksMode } from "../config.ts";

const REPO = resolve(import.meta.dir, "..", "..");

/** Nazwa serwera MCP dołączonego do pluginu, jak widzi ją Claude Code (`plugin:<plugin>:<serwer>`). */
export const MCP_SERVER = "plugin:hipokamp:hipokamp";

/** Wersja natywnego hooka, której oczekuje ten kod: stała `version` w native/hook/main.go (podbijana razem). */
export const NATIVE_VERSION = 3;

export type ResolvedMode = Exclude<HooksMode, "auto">;

const fwd = (p: string) => p.replace(/\\/g, "/");
/** `${pole}` dla hooka mcp_tool: Claude Code podstawia pole z payloadu hooka. */
const v = (path: string) => `\${${path}}`;
/** Hook Buna w repo: zapas natywnego hooka i ścieżka, po której `hooksRepo()` (install/live.ts) poznaje repo. */
export const hookTsOf = (repo: string) => join(repo, "src", "hooks", "hook.ts");

/** Zdarzenia Claude Code obsługiwane przez hipokamp; `tool` = narzędzie MCP w trybie mcp (null: zawsze command). */
const EVENTS: { event: string; arg: string; timeout: number; matcher?: string; tool: string | null; input?: object }[] = [
  // SessionStart przy starcie sesji przychodzi, zanim serwery MCP działają: w trybie mcp zostaje command
  { event: "SessionStart", arg: "session-start", timeout: 15, matcher: "startup|resume|clear|compact", tool: null },
  { event: "UserPromptSubmit", arg: "prompt", timeout: 10, tool: "hook_prompt", input: { prompt: v("prompt") } },
  {
    event: "PostToolUse",
    arg: "post-tool",
    timeout: 8,
    matcher: "Read|Edit|Write|MultiEdit|NotebookEdit",
    tool: "hook_post_tool",
    input: { tool_name: v("tool_name"), file_path: v("tool_input.file_path"), notebook_path: v("tool_input.notebook_path") },
  },
  { event: "Stop", arg: "stop", timeout: 30, tool: "hook_stop" },
  { event: "PreCompact", arg: "pre-compact", timeout: 30, tool: "hook_pre_compact" },
  { event: "SessionEnd", arg: "session-end", timeout: 30, tool: "hook_session_end" },
];

export function nativeHookPath(repo = REPO): string {
  return join(repo, "native", "hook", process.platform === "win32" ? "hipokamp-hook.exe" : "hipokamp-hook");
}

/** hooks.json pluginu w repo (generowany przez `hipokamp install`, poza gitem). */
export function pluginHooksFile(repo = REPO): string {
  return join(repo, "plugin", "hooks", "hooks.json");
}

type Verdict = { ok: boolean; reason: string };

/** Ocena odpowiedzi `--smoke`: ten program, ta wersja, widzi hook Buna (zapas, gdy worker nie odpowiada). */
export function smokeVerdict(j: any, status: number | null): Verdict | null {
  if (j?.app !== "hipokamp-hook") return null;
  if (j.version !== NATIVE_VERSION)
    return {
      ok: false,
      reason: `wersja ${j.version ?? "?"}, ten kod oczekuje ${NATIVE_VERSION} (przebuduje go hipokamp install albo update)`,
    };
  if (j.hookTs !== true) return { ok: false, reason: `nie widzi hooka Buna (${j.hookTsPath})` };
  return status === 0 ? { ok: true, reason: `wersja ${j.version}` } : null;
}

/**
 * Test dymny natywnego hooka: `--smoke` ma odpowiedzieć w 5 s JSON-em z nazwą programu, wersją zgodną z
 * NATIVE_VERSION i znaleźć hook Buna, na który przełącza się, gdy worker nie odpowiada. Bez tego tryb native nie
 * trafia do hooks.json.
 */
export function nativeSmoke(exe = nativeHookPath(), hookTs = hookTsOf(REPO)): Verdict {
  if (!existsSync(exe)) return { ok: false, reason: `brak ${exe}` };
  const r = spawnSync(exe, ["--hook-ts", hookTs, "--smoke"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  try {
    const verdict = smokeVerdict(JSON.parse(r.stdout ?? ""), r.status);
    if (verdict) return verdict;
  } catch {}
  return { ok: false, reason: `test dymny nieudany (kod ${r.status ?? "?"}${r.error ? `, ${String(r.error)}` : ""})` };
}

/**
 * Tryb do hooks.json. auto = native, gdy plik jest zbudowany i przeszedł test dymny, inaczej command. Tryb mcp
 * nigdy nie jest wybierany sam: zależy od tego, czy serwer MCP sesji już się połączył (patrz ARCHITEKTURA.md).
 */
export function resolveHooksMode(mode: HooksMode, smoke: () => Verdict = nativeSmoke): { mode: ResolvedMode; reason: string } {
  if (mode === "command" || mode === "mcp") return { mode, reason: "z konfiguracji" };
  const s = smoke();
  if (s.ok) return { mode: "native", reason: `${mode === "auto" ? "auto: " : ""}natywny hook gotowy (${s.reason})` };
  return { mode: "command", reason: `${mode === "auto" ? "auto" : "native niedostępny"}: ${s.reason}, zostaje command` };
}

/** Tryb dla hooks.json repo `repo`: test dymny pliku z TEGO repo i jego hooka Buna (ścieżki w hooks.json idą do niego). */
export function hooksModeFor(mode: HooksMode, repo = REPO): { mode: ResolvedMode; reason: string } {
  return resolveHooksMode(mode, () => nativeSmoke(nativeHookPath(repo), hookTsOf(repo)));
}

/**
 * hooks.json pluginu dla trybu; ścieżki bezwzględne tej maszyny (plik nie trafia do repo).
 * Tryb native: `"<exe>" … || "<bun>" "<hook.ts>" …`. Natywny hook zawsze kończy się kodem 0, więc hook Buna rusza
 * tylko wtedy, gdy pliku nie da się uruchomić (usunięty, nie przebudowany po czyszczeniu): powłoka zwraca 126/127.
 * Komendy hooków i tak wymagają powłoki zgodnej z sh (na Windows Git Bash, jak w trybie command).
 */
export function pluginHooks(o: { mode: ResolvedMode; bun: string; repo?: string; nativeExe?: string }): object {
  const repo = o.repo ?? REPO;
  const bun = fwd(o.bun);
  const hookTs = fwd(hookTsOf(repo));
  const exe = fwd(o.nativeExe ?? nativeHookPath(repo));
  const viaBun = (arg: string) => `"${bun}" "${hookTs}" ${arg}`;
  const command = (arg: string) =>
    o.mode === "native" ? `"${exe}" --bun "${bun}" --hook-ts "${hookTs}" ${arg} || ${viaBun(arg)}` : viaBun(arg);
  const hooks: Record<string, object[]> = {};
  for (const e of EVENTS) {
    const h =
      o.mode === "mcp" && e.tool
        ? {
            type: "mcp_tool",
            server: MCP_SERVER,
            tool: e.tool,
            input: { session_id: v("session_id"), transcript_path: v("transcript_path"), cwd: v("cwd"), ...e.input },
            timeout: e.timeout,
          }
        : { type: "command", command: command(e.arg), timeout: e.timeout };
    hooks[e.event] = [{ ...(e.matcher ? { matcher: e.matcher } : {}), hooks: [h] }];
  }
  return { description: "hipokamp: przechwytywanie bez LLM i przypominanie (nigdy nie blokuje promptu)", hooks };
}

/**
 * Diagnoza zainstalowanego hooks.json (doctor): tryb, a dla native plik z komendy, jego test dymny i wersja.
 * Natywny hook, który zniknął albo się zestarzał, nie gubi zdarzeń (zapas `|| bun`), ale traci swoją szybkość.
 */
export function checkPluginHooks(file = pluginHooksFile()): Verdict & { mode?: ResolvedMode } {
  let j: any;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: `hooki: brak albo uszkodzony ${file} (uruchom: hipokamp install)` };
  }
  const handlers: any[] = Object.values(j?.hooks ?? {})
    .flat()
    .flatMap((g: any) => (Array.isArray(g?.hooks) ? g.hooks : []));
  const cmd = handlers.map((h) => (typeof h?.command === "string" ? h.command : "")).find((c) => / --bun "/.test(c));
  if (!cmd) {
    const mode = handlers.some((h) => h?.type === "mcp_tool") ? "mcp" : "command";
    return { ok: true, mode, reason: `hooki: tryb ${mode}` };
  }
  const exe = cmd.match(/^"([^"]+)"/)?.[1] ?? "";
  const hookTs = cmd.match(/--hook-ts "([^"]+)"/)?.[1] ?? hookTsOf(REPO);
  const s = nativeSmoke(exe, hookTs);
  if (s.ok) return { ok: true, mode: "native", reason: `hooki: tryb native, ${exe} (${s.reason})` };
  const spare = / \|\| "/.test(cmd) ? "zdarzenia obsługuje zapasowy hook Buna (wolniej)" : "BEZ zapasu: hooki nie działają";
  return {
    ok: false,
    mode: "native",
    reason: `hooki: tryb native, ale ${s.reason}; ${spare}. Napraw: hipokamp install (buduje natywny hook przez scripts/build-native, gdy jest Go; bez Go wraca do trybu command)`,
  };
}
