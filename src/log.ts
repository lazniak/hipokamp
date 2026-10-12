// Logi do pliku dziennego (worker ma stdio ignorowane — bez tego awarie byłyby niediagnozowalne).
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";
let component = "main";
let echo = false;

export function initLog(name: string, toStderr = false): void {
  component = name;
  echo = toStderr;
  try {
    mkdirSync(paths.logs(), { recursive: true });
  } catch {}
}

function file(): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join(paths.logs(), `${component}-${day}.log`);
}

function write(level: Level, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra === undefined ? "" : ` ${safeJson(extra)}`}\n`;
  try {
    appendFileSync(file(), line);
  } catch {}
  if (echo) process.stderr.write(line);
}

function safeJson(x: unknown): string {
  try {
    if (x instanceof Error) return JSON.stringify({ error: x.message, stack: x.stack?.split("\n").slice(0, 4).join(" | ") });
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => process.env.HIPOKAMP_DEBUG && write("DEBUG", m, e),
  info: (m: string, e?: unknown) => write("INFO", m, e),
  warn: (m: string, e?: unknown) => write("WARN", m, e),
  error: (m: string, e?: unknown) => write("ERROR", m, e),
};

/** Dzienniki czytane później przez narzędzia: decyzje przypomnień (`recall-stats`) i pary snu (`supersede --ids`). */
const LONG_JOURNALS = /^(recall|sleep)-\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Kasuje dzienne logi `*-RRRR-MM-DD.log` i przestoje pętli `stall-RRRR-MM-DD.jsonl` starsze niż `keepDays`, a dzienniki
 * decyzji przypomnień i par snu (`recall-…jsonl`, `sleep-…jsonl`) starsze niż `keepJournalDays`. Inne pliki (zapisy
 * napraw z godziną w nazwie: repair-…, project-merge-…) zostają. Zwraca liczbę skasowanych plików.
 */
export function pruneLogs(keepDays = 14, keepJournalDays = 60): number {
  let n = 0;
  try {
    const now = Date.now();
    for (const f of readdirSync(paths.logs())) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})\.log$/) ?? f.match(/^(?:stall|recall|sleep)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const keep = (LONG_JOURNALS.test(f) ? keepJournalDays : keepDays) * 86_400_000;
      const day = new Date(m[1]).getTime();
      if (!Number.isFinite(day) || day >= now - keep) continue;
      try {
        unlinkSync(join(paths.logs(), f));
        n++;
      } catch {}
    }
  } catch {}
  return n;
}
