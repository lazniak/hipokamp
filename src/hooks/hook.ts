#!/usr/bin/env bun
// Jeden punkt wejścia dla wszystkich hooków Claude Code: `bun hook.ts <zdarzenie>`. Codex woła te same hooki
// z dopiskiem `codex` (`bun hook.ts stop codex`): wejście i wyjście ma zgodne z Claude Code, różni się transkryptem.
// Gemini CLI, Cursor i plugin OpenCode dopisują swoją nazwę: wejście tłumaczy capture/harnesses.ts (klucz sesji
// z przedrostkiem), a wyjście Cursora ma własny kształt (`additional_context`).
// Logika jest wspólna z serwerem MCP i workerem (handle.ts); ten plik to tryb command i zapas natywnego hooka.
// ZASADA: hook nigdy nie blokuje użytkownika. Zawsze exit 0, twarde limity czasu, żadnego exit 2.
// Zapis idzie bezpośrednio do SQLite (WAL) — worker jest potrzebny tylko do wektorów i podglądu.
import { ensureDataDirs, loadConfig } from "../config.ts";

const event = (process.argv[2] ?? "").toLowerCase();
const who = (process.argv[3] ?? "").toLowerCase();
const codex = who === "codex";
const harness = who === "gemini" || who === "cursor" || who === "opencode" ? who : null;
const started = performance.now();

/** Nazwa zdarzenia w wyjściu Gemini CLI (kontekst przyjmuje SessionStart, BeforeAgent i AfterTool). */
const GEMINI_EVENT: Record<string, string> = { "session-start": "SessionStart", prompt: "BeforeAgent", "post-tool": "AfterTool" };

async function readStdin(): Promise<any> {
  try {
    const raw = await Bun.stdin.text();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function localRepo() {
  const { openDb } = await import("../db/db.ts");
  const { Repo } = await import("../db/repo.ts");
  return new Repo(openDb({ vectors: false }));
}

async function main(): Promise<void> {
  let input = await readStdin();
  const cfg = loadConfig();
  if (harness) {
    const H = await import("../capture/harnesses.ts");
    if (!H.harnessOn(harness, cfg)) return;
    input = H.hookInput(harness, input);
  }
  ensureDataDirs();
  const repo = await localRepo();
  const { runHook } = await import("./handle.ts");
  const r = await runHook(event, input, {
    repo,
    codex,
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    // natywny hook uruchomił nas, bo worker nie odpowiedział: nie czekamy na niego drugi raz
    skipWorker: !!process.env.HIPOKAMP_HOOK_FALLBACK,
  });
  const ctx = r.output?.hookSpecificOutput.additionalContext;
  if (harness === "cursor") process.stdout.write(JSON.stringify(ctx ? { additional_context: ctx } : {}));
  else if (harness === "gemini" && r.output)
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { ...r.output.hookSpecificOutput, hookEventName: GEMINI_EVENT[event] ?? event } }),
    );
  else if (r.output) process.stdout.write(JSON.stringify(r.output));
}

try {
  await main();
} catch (e) {
  try {
    const { initLog, log } = await import("../log.ts");
    initLog("hook");
    log.error(`hook ${event} padł (zignorowany)`, e);
  } catch {}
} finally {
  if (process.env.HIPOKAMP_DEBUG) process.stderr.write(`[hipokamp] ${event} ${Math.round(performance.now() - started)} ms\n`);
  process.exit(0);
}
