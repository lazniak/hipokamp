#!/usr/bin/env bun
// CI (T-12): odizolowane środowisko dla całego zadania. Testy same zakładają katalogi tymczasowe, ale runner w trybie
// host (np. na komputerze dewelopera) działa obok prawdziwej pamięci, więc obrona w głąb: HIPOKAMP_HOME,
// CLAUDE_CONFIG_DIR i CODEX_HOME w katalogu z „hipokamp-test” w nazwie, port inny niż worker użytkownika (47777),
// bez workera w tle. Zmienne trafiają do pliku $GITHUB_ENV (Gitea Actions używa tej samej nazwy), więc obowiązują
// w kolejnych krokach. Bez $GITHUB_ENV (uruchomienie ręczne) wypisuje je tylko na ekran.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "hipokamp-test-ci-"));
mkdirSync(join(home, "claude", "projects"), { recursive: true });
const vars: Record<string, string> = {
  HIPOKAMP_HOME: home,
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  CODEX_HOME: join(home, "codex"),
  // Gemini CLI, Cursor, OpenCode, Claude Desktop: pusty katalog domowy harnessów
  HIPOKAMP_HARNESS_HOME: join(home, "harness-home"),
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
  HIPOKAMP_PORT: "47990",
  HIPOKAMP_NO_WORKER: "1",
};
const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
