// Zatrzymanie workera, któremu klient nie ufa (T-17): starszy worker bez /api/auth (kod zaktualizowany bez restartu,
// np. git pull w katalogu pluginu) albo zawieszony worker, który nie odpowiada na wyzwanie. Do wyjścia z bezczynności
// (do 180 min) trzymałby port, a hooki pracowałyby bez wektorów. Zatrzymać wolno tylko własny proces: PID i chwila
// startu przychodzą z worker.lock.json tego katalogu danych (client.ts: probeWorker), a tutaj dodatkowo:
// - linia poleceń procesu musi być `bun …/src/worker/main.ts`;
// - proces musi powstać przed chwilą startu z pliku blokady (`startedAt` zapisuje worker po imporcie modułów). PID
//   z pliku blokady mógł dostać inny proces, także inny worker (`bun … src/worker/main.ts` innego projektu albo
//   katalogu danych), ale każdy taki proces powstał dopiero po wyjściu tamtego workera, czyli po jego `startedAt`.
// Procesy potomne z tego pliku (PowerShell na Windows, `ps` na macOS): tylko CLI, `hipokamp update` i serwer MCP
// (wakeWorker, stop, restart), nigdy worker. Hook tego pliku nie woła; hook uruchamia procesy tylko przez spawnWorker
// (sam worker oraz icacls i whoami z keyacl.ts, z terminem 1,5 s).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { portOpen } from "./client.ts";

/** Zapas na zegar i zaokrąglenia czasu utworzenia procesu (ps: pełne sekundy). */
const CLOCK_SLACK_MS = 1500;

/** Linia poleceń i chwila utworzenia procesu (ms od epoki; null, gdy nieznana); null, gdy procesu nie ma. */
export function processInfo(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (!cmd) return null;
      // pole 22 (starttime) w taktach od startu systemu; USER_HZ w interfejsie /proc to zawsze 100 na Linuksie
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      return { cmd, createdMs: Number.isFinite(ticks) && btime ? btime * 1000 + ticks * 10 : null };
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { @{ cmd = $p.CommandLine; created = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
    const sys = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");
    const r = spawnSync(
      join(sys, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      },
    );
    try {
      const j = JSON.parse((r.stdout ?? "").trim());
      return typeof j?.cmd === "string" && j.cmd
        ? { cmd: j.cmd, createdMs: Number.isFinite(j.created) ? j.created : null }
        : null;
    } catch {
      return null;
    }
  }
  // macOS i inne: `ps`, czas startu w stałym formacie przy LC_ALL=C („Tue Oct  6 14:16:01 2026”, 24 znaki)
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C" },
  });
  const line = r.status === 0 ? (r.stdout ?? "").trim() : "";
  if (line.length <= 24) return null;
  const t = Date.parse(line.slice(0, 24));
  return { cmd: line.slice(24).trim(), createdMs: Number.isFinite(t) ? t : null };
}

/** Linia poleceń procesu; null, gdy procesu nie ma albo nie da się jej odczytać. */
export const commandLineOf = (pid: number): string | null => processInfo(pid)?.cmd ?? null;

/** Proces workera hipokampa: Bun uruchomiony z `src/worker/main.ts` (dowolny katalog repo). */
export const isWorkerCommand = (cmd: string): boolean =>
  /\bbun(\.exe)?\b/i.test(cmd) && /(^|[\\/\s"'])src[\\/]worker[\\/]main\.ts(["'\s]|$)/i.test(cmd);

/**
 * Czy proces mógł zapisać plik blokady ze `startedAt`: powstał nie później niż wtedy (z zapasem na zegar). Proces
 * utworzony później dostał PID po tamtym workerze. Bez czasu utworzenia albo bez `startedAt`: odmowa.
 */
export function startedBeforeLock(createdMs: number | null, startedAt: number | undefined): boolean {
  if (createdMs === null || !Number.isFinite(createdMs)) return false;
  if (startedAt === undefined || !Number.isFinite(startedAt)) return false;
  return createdMs <= startedAt + CLOCK_SLACK_MS;
}

/**
 * Pary PID i startedAt, które na pewno nie są tym workerem (zła linia poleceń albo proces utworzony po startedAt):
 * bez ponownego PowerShella. Brak odpowiedzi (PowerShell przekroczył czas, nieczytelny czas utworzenia) się nie
 * zapisuje, więc długowieczny serwer MCP spróbuje jeszcze raz.
 */
const notWorker = new Set<string>();

export type ProcessInfo = { cmd: string; createdMs: number | null };

/**
 * Zatrzymuje proces `pid`, o ile jego linia poleceń to worker hipokampa, a powstał przed `startedAt` z
 * worker.lock.json, i czeka, aż port się zwolni. false: to nie ten worker albo nie da się tego teraz sprawdzić
 * (proces zostaje nietknięty), procesu już nie ma albo port nie zwolnił się w `waitMs`. `probe`: odczyt procesu
 * (testy podstawiają awarię).
 */
export async function stopVerifiedWorker(
  pid: number,
  startedAt: number | undefined,
  waitMs = 5000,
  probe: (pid: number) => ProcessInfo | null = processInfo,
): Promise<boolean> {
  const seen = `${pid}:${startedAt}`;
  if (notWorker.has(seen)) return false;
  const info = probe(pid);
  if (!info) return false;
  const definitelyOther =
    !isWorkerCommand(info.cmd) || (info.createdMs !== null && !startedBeforeLock(info.createdMs, startedAt));
  if (definitelyOther) {
    notWorker.add(seen);
    return false;
  }
  if (!startedBeforeLock(info.createdMs, startedAt)) return false; // czas utworzenia nieznany: odmowa bez zapamiętania
  try {
    process.kill(pid);
  } catch {}
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!(await portOpen())) return true;
    await Bun.sleep(250);
  }
  return !(await portOpen());
}
