// Klient workera dla hooków, MCP i CLI. Każde wywołanie ma twardy timeout — pamięć nigdy nie blokuje pracy.
// Każde wywołanie przechodzi wyzwanie i odpowiedź (auth.ts, T-17): proces na porcie workera bez dowodu klucza
// użytkownika to dla klienta niedziałający worker, więc treść (prompt, zapytanie) do niego nie idzie.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { DATA_DIR, loadConfig, paths } from "../config.ts";
import { authedFetch, handshake, KEY_FILE, loadKey } from "./auth.ts";

/** Plik klucza workera: `<dane>/state/worker.key` (T-17). */
export const keyPath = (): string => join(paths.state(), KEY_FILE);

/**
 * Wywołanie workera z uwierzytelnieniem; null, gdy worker nie działa, nie odpowiedział w limicie (wspólnym dla
 * wyzwania i żądania), odpowiedział błędem albo nie przeszedł wyzwania. Brak pliku klucza: klient go tworzy (ACL
 * nadaje spawnWorker przed startem workera), a worker czyta nowy klucz przy następnym wyzwaniu.
 */
export async function call<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T | null> {
  const key = loadKey(keyPath());
  if (!key) return null;
  const c = loadConfig();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    // bez przekierowań (authedFetch): obcy proces na porcie workera nie przeniesie promptu ani payloadu pod inny
    // adres (307 powtarza POST z treścią); odpowiedź 3xx to jak niedziałający worker
    const res = await authedFetch({
      base: `http://${c.host}:${c.port}`,
      port: c.port,
      key,
      path,
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    if (!res?.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface Health {
  app: string;
  ok: boolean;
  pid: number;
  version: string;
  uptimeS: number;
  embedder: { loaded: boolean; device: string; model: string };
  /** opóźnienie pętli zdarzeń: ostatnia próbka i maksimum z ostatniej minuty (starszy worker ich nie ma) */
  eventLoopLagMs?: number;
  eventLoopLagMaxMs?: number;
  pendingJobs?: number;
}

/** Zdrowie uwierzytelnionego workera; null także dla procesu, który nie przeszedł wyzwania. */
export async function health(timeoutMs = 400): Promise<Health | null> {
  const h = await call<Health>("/api/health", { timeoutMs });
  return h && h.app === "hipokamp" ? h : null;
}

export function workerScript(): string {
  return join(import.meta.dir, "main.ts");
}

/**
 * Czy ktoś nasłuchuje na porcie workera. Połączenie TCP przyjmuje system, więc odpowiada też worker zajęty długą
 * pracą (np. wektory dla setek notatek), który nie zdąży z /api/health w limicie hooka.
 */
export function portOpen(timeoutMs = 250): Promise<boolean> {
  const c = loadConfig();
  return new Promise((resolve) => {
    const s = connect({ host: c.host, port: c.port });
    const done = (ok: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** worker.lock.json: PID, port, chwila startu i wersja procesu, który ostatnio wystartował z tym katalogiem danych. */
export function readLock(): { pid: number; port: number; startedAt?: number; version?: string } | null {
  try {
    const j = JSON.parse(readFileSync(paths.lock(), "utf8"));
    if (!Number.isInteger(j?.pid) || !Number.isInteger(j?.port)) return null;
    return { ...j, startedAt: Number.isFinite(j.startedAt) ? j.startedAt : undefined };
  } catch {
    return null;
  }
}

/**
 * Co jest na porcie workera (doctor, status, stop, restart, naprawa, start serwera MCP):
 * - `ok`: worker z kluczem użytkownika;
 * - `none`: port wolny;
 * - `legacy`: starszy worker bez /api/auth z TEGO katalogu danych: zdrowie bez uwierzytelnienia mówi „hipokamp”, a PID
 *   i port zgadzają się z worker.lock.json. Nikt mu nie ufa; zatrzymać go wolno dopiero po sprawdzeniu linii poleceń
 *   i chwili utworzenia procesu względem `startedAt` z pliku blokady (legacy.ts);
 * - `unverified`: coś słucha, ale nie przeszło wyzwania (obcy proces, inny klucz, worker zbyt zajęty, by odpowiedzieć).
 *   `lockPid`: PID z worker.lock.json dla tego portu (zawieszony worker do zatrzymania z CLI, po sprawdzeniu procesu).
 */
export type WorkerProbe =
  | { state: "ok"; health: Health }
  | { state: "none" }
  | { state: "legacy"; pid: number; version: string; startedAt?: number }
  | { state: "unverified"; reason: string; lockPid?: number; startedAt?: number };

/** Opis stanu z probeWorker do status, stop i doctor. */
export function describeWorker(p: WorkerProbe): string {
  const port = loadConfig().port;
  switch (p.state) {
    case "ok": {
      const h = p.health;
      return `działa (pid ${h.pid}, ${h.uptimeS}s, model ${h.embedder.loaded ? `załadowany/${h.embedder.device}` : "uśpiony"})`;
    }
    case "none":
      return "nie działa (wstanie przy pierwszym hooku)";
    case "legacy":
      return `starsza wersja ${p.version} bez uwierzytelnienia (pid ${p.pid}): hooki jej nie ufają i pracują bez wektorów; hipokamp restart`;
    case "unverified":
      return `na porcie ${port} odpowiada proces, który nie przeszedł wyzwania klucza (${p.reason}): hooki go nie używają${p.lockPid ? `; worker.lock.json: pid ${p.lockPid}, hipokamp restart zatrzyma go, jeśli to worker` : "; sprawdź, co słucha na tym porcie"}`;
  }
}

export async function probeWorker(timeoutMs = 800): Promise<WorkerProbe> {
  const h = await health(timeoutMs);
  if (h) return { state: "ok", health: h };
  if (!(await portOpen())) return { state: "none" };
  const c = loadConfig();
  const base = `http://${c.host}:${c.port}`;
  const lock = readLock();
  const mine = lock && lock.port === c.port ? lock : null;
  const lockPid = mine?.pid;
  const startedAt = mine?.startedAt;
  const key = loadKey(keyPath());
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (!key) return { state: "unverified", reason: "brak klucza workera", lockPid, startedAt };
    const hs = await handshake(base, c.port, key, ctrl.signal);
    if (hs.ok)
      return { state: "unverified", reason: "wyzwanie przeszło, ale zdrowie nie przyszło w limicie", lockPid, startedAt };
    if (hs.status !== 404) return { state: "unverified", reason: hs.reason, lockPid, startedAt };
    // starszy worker nie zna /api/auth (404); zdrowie bez uwierzytelnienia tylko do rozpoznania, nie do zaufania
    const r = await fetch(`${base}/api/health`, { headers: { "x-hipokamp-bg": "1" }, signal: ctrl.signal, redirect: "manual" });
    const j: any = r.ok ? await r.json().catch(() => null) : null;
    if (j?.app === "hipokamp" && Number.isInteger(j.pid) && j.pid === lockPid)
      return { state: "legacy", pid: j.pid, version: String(j.version ?? "?"), startedAt };
    return { state: "unverified", reason: "brak /api/auth, a zdrowie nie zgadza się z worker.lock.json", lockPid, startedAt };
  } catch {
    return { state: "unverified", reason: "brak odpowiedzi w limicie", lockPid, startedAt };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Startuje workera w tle (odłączony, bez okna, logi do pliku), o ile port jest wolny: zajęty worker nie odpowiada
 * na zdrowie, ale żyje, a drugi i tak padłby na zajętym porcie. Czeka tylko na sprawdzenie portu. Przed startem
 * klucz workera: istnieje, a na Windows ma ACL tylko dla użytkownika (icacls raz na klucz, wszystko najwyżej 1,5 s,
 * bo woła to także hook; po nieudanej próbie następna za 10 min; worker sam procesów nie uruchamia). Wyjątek od
 * terminu: gdy po zdjęciu dziedziczenia klucza nie da się przeczytać, `icacls /reset` (przywrócenie dostępu) ma
 * własny limit 5 s, więc w tym jednym, awaryjnym przypadku hook może czekać do ok. 6,5 s.
 */
export async function spawnWorker(): Promise<void> {
  if (process.env.HIPOKAMP_NO_WORKER) return; // testy i tryb tylko-FTS
  if (await portOpen()) return;
  try {
    if (loadKey(keyPath())) (await import("./keyacl.ts")).hardenKeyOnce(keyPath());
  } catch {}
  try {
    const log = openSync(join(paths.logs(), "worker-stdio.log"), "a");
    const bun = process.execPath && existsSync(process.execPath) ? process.execPath : "bun";
    // cwd w katalogu danych: worker żyje godzinami, a Windows nie pozwala usunąć katalogu (np. worktree), który jest cwd procesu
    const child = spawn(bun, [workerScript()], {
      cwd: DATA_DIR,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...process.env, HIPOKAMP_SPAWNED: "1" },
    });
    child.unref();
    closeSync(log); // dziecko ma własną kopię deskryptora; serwer MCP nie gubi go przy każdym starcie workera
  } catch {
    // brak workera = tylko brak wektorów i podglądu; hooki działają dalej
  }
}

/** Upewnia się, że worker działa; opcjonalnie czeka na gotowość. */
export async function ensureWorker(waitMs = 0): Promise<Health | null> {
  const h = await health();
  if (h) return h;
  await spawnWorker();
  return waitWorker(waitMs);
}

/** Czeka na zdrowie (uwierzytelnionego) workera najwyżej `waitMs`, bez startowania nowego. */
export async function waitWorker(waitMs: number): Promise<Health | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await Bun.sleep(250);
    const x = await health(300);
    if (x) return x;
  }
  return null;
}

/**
 * Dla procesów, które mogą chwilę poczekać (start serwera MCP, wyszukiwanie bez workera): worker działa, startuje,
 * a starszy worker bez uwierzytelnienia z tego katalogu danych (kod zaktualizowany bez restartu) jest zatrzymywany
 * i zastępowany nowym, po sprawdzeniu linii poleceń procesu (legacy.ts). Hooki tego nie robią: mają limit czasu,
 * a do wyjścia starego workera z bezczynności pracują bez niego (kontekst z FTS).
 */
export async function wakeWorker(): Promise<WorkerProbe> {
  if (process.env.HIPOKAMP_NO_WORKER) return { state: "none" };
  const p = await probeWorker();
  if (p.state === "legacy") {
    const { stopVerifiedWorker } = await import("./legacy.ts");
    if (await stopVerifiedWorker(p.pid, p.startedAt)) await spawnWorker();
  } else if (p.state === "none") await spawnWorker();
  return p;
}
