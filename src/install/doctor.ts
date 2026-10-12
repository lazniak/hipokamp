// Diagnoza: czy wszystko, od czego zależy pamięć, działa — i czy nic nie może zablokować promptu.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Config, claudeDir, loadConfig, paths } from "../config.ts";
import { sleepStatus } from "../consolidate/sleep.ts";
import { supersedeModeWarning } from "../core/supersede.ts";
import { getDb, hasVectors } from "../db/db.ts";
import { Repo } from "../db/repo.ts";
import { checkPluginHooks, hooksModeFor } from "../hooks/modes.ts";
import { describeWorker, keyPath, probeWorker, type WorkerProbe } from "../worker/client.ts";
import { checkKeyAcl } from "../worker/keyacl.ts";
import { liveCheck, pluginCacheDiff, pluginInstallPath, pluginLocation } from "./live.ts";

/**
 * Hooki, które naprawdę uruchamia Claude Code: hooks.json z kopii pluginu w cache (nie z repo), z trybem, testem
 * dymnym natywnego pliku i różnicą względem `<repo>/plugin` (pluginCacheDiff). Zmiana hooks.mode w config działa
 * dopiero po `hipokamp install`: wtedy powstaje nowy hooks.json i nowa kopia w cache. null: pluginu nie ma w cache
 * (zgłasza to liveCheck).
 */
export function hooksCheck(claude = claudeDir()): { ok: boolean; line: string } | null {
  const loc = pluginLocation(claude);
  if (!loc.installPath) return null;
  const hk = checkPluginHooks(join(loc.installPath, "hooks", "hooks.json"));
  const repo = loc.marketplace || loc.hooksRepo;
  if (!repo) return { ok: hk.ok, line: `${hk.reason} (kopia pluginu w cache)` };
  const stale = (pluginCacheDiff(repo, claude) ?? []).filter((d) => /: hooks\/hooks\.json$/.test(d));
  if (stale.length)
    return {
      ok: false,
      line: `${hk.reason}, ale hooks.json w cache różni się od ${join(repo, "plugin", "hooks", "hooks.json")} (${stale.join(", ")}): sesje mają stare hooki; hipokamp install`,
    };
  if (!hk.ok) return { ok: false, line: hk.reason };
  const want = hooksModeFor(loadConfig().hooks.mode, repo);
  if (hk.mode && want.mode !== hk.mode)
    return {
      ok: false,
      line: `${hk.reason}, a hooks.mode w config daje tryb ${want.mode} (${want.reason}): zmiana działa po hipokamp install`,
    };
  return { ok: hk.ok, line: `${hk.reason} (kopia pluginu w cache)` };
}

/** Czy ustawione kanały powiadomień potrzebują procesu (toast, command); doctor rozstrzyga wtedy tryb hooków. */
function processChannels(cfg: Config): string[] {
  return cfg.notify?.enabled ? cfg.notify.channels.filter((c) => c === "toast" || c === "command") : [];
}

/**
 * Kanały powiadomień z procesem (toast, command) działają tylko wtedy, gdy Stop obsługuje proces hooka Buna. Przy
 * hooku natywnym (`hooks.mode` native albo auto, które wybrało natywny) Stop obsługuje worker, a w trybie mcp serwer
 * MCP; oba nie uruchamiają procesów (zasada 2), więc doręczają tylko file i webhook.
 * `resolvedMode`: tryb faktycznie użyty (`hooksModeFor`); `auto`, które spadło do `command`, nie ostrzega. Bez niego
 * liczymy z ustawienia, a `auto` ostrzega zawsze (może wybrać natywny).
 */
export function notifyModeWarning(cfg: Config, resolvedMode?: string): string | null {
  const withProcess = processChannels(cfg);
  const mode = resolvedMode ?? (cfg as { hooks?: { mode?: string } }).hooks?.mode;
  if (!withProcess.length || (mode !== "native" && mode !== "auto" && mode !== "mcp")) return null;
  const where = mode === "mcp" ? "serwer MCP" : "worker";
  return `powiadomienia: kanały ${withProcess.join(", ")} nie działają przy hooks.mode = ${mode} (Stop obsługuje ${where}, który nie uruchamia procesów); działają file i webhook, a toast i command tylko w trybie command`;
}

/** Limit jednego etapu sondy workera w doctor (zdrowie, potem wyzwanie klucza) i przerwa przed kolejną próbą (T-45). */
export const PROBE_TIMEOUT_MS = 2500;
const PROBE_PAUSE_MS = 1000;
/** Wspólny termin wszystkich prób sondy z przerwami: doctor czeka na workera najwyżej tyle (T-45). */
export const PROBE_BUDGET_MS = 9000;

/**
 * Sonda workera z ponowieniem (T-45): zaraz po restarcie (drugi etap `hipokamp update`) pętla workera stoi ok. 1 s
 * na ładowaniu modelu, więc jedna sonda z limitem 800 ms zgłaszała „nie przeszedł wyzwania klucza (brak odpowiedzi
 * w limicie)”, a doctor chwilę później był czysty. Do `tries` prób, ponawiane tylko przy braku odpowiedzi w limicie
 * (wolny worker); brak workera i odrzucone wyzwanie wracają od razu. probeWorker daje limit osobno zdrowiu i
 * wyzwaniu, więc próba trwa najwyżej dwa limity: limit próby to mniejsze z PROBE_TIMEOUT_MS i połowy reszty
 * wspólnego terminu PROBE_BUDGET_MS (próby, przerwy i oba etapy razem najwyżej ok. 9 s). `probe`, `pause` i `now`
 * podmienia test.
 */
export async function probeWorkerPatient(
  probe: (timeoutMs: number) => Promise<WorkerProbe> = probeWorker,
  pause: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
  tries = 3,
  now: () => number = Date.now,
): Promise<WorkerProbe> {
  const until = now() + PROBE_BUDGET_MS;
  let p: WorkerProbe = { state: "none" };
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      if (until - now() < PROBE_PAUSE_MS + 600) break;
      await pause(PROBE_PAUSE_MS);
    }
    const t = Math.min(PROBE_TIMEOUT_MS, Math.floor((until - now()) / 2));
    if (t < 300) break;
    p = await probe(t);
    if (p.state !== "unverified" || !/w limicie/.test(p.reason)) return p;
  }
  return p;
}

export async function doctor(log: (m: string) => void): Promise<void> {
  const ok = (b: boolean, m: string) => log(`${b ? "✓" : "✗"} ${m}`);
  const cfg = loadConfig();
  ok(true, `bun ${Bun.version}, platforma ${process.platform}`);
  ok(
    existsSync(paths.db()),
    `baza: ${paths.db()}${existsSync(paths.db()) ? ` (${(statSync(paths.db()).size / 1e6).toFixed(1)} MB)` : ""}`,
  );
  const db = getDb();
  ok(hasVectors(), `sqlite-vec ${hasVectors() ? "załadowany" : "NIEDOSTĘPNY, tylko FTS"}`);
  const r = new Repo(db);
  const s = r.stats();
  ok(s.observations > 0, `notatki: ${s.observations}, wektory: ${s.vectors}, brakujące wektory: ${r.countMissingVectors()}`);
  const integrity = (db.query("PRAGMA quick_check").get() as any)?.quick_check;
  ok(integrity === "ok", `spójność bazy: ${integrity}`);
  ok(true, `sen: ${sleepStatus(db)}`);
  const modeWarning = supersedeModeWarning(cfg.consolidation.supersedeDigest);
  if (modeWarning) log(`! ${modeWarning}`);
  const probe = await probeWorkerPatient();
  const h = probe.state === "ok" ? probe.health : null;
  ok(
    !!h,
    h
      ? `worker: pid ${h.pid}, model ${h.embedder.model} (${h.embedder.loaded ? h.embedder.device : "uśpiony"})${h.eventLoopLagMs === undefined ? "" : `, pętla ${h.eventLoopLagMs} ms (max ${h.eventLoopLagMaxMs} ms w minucie), zadania ${h.pendingJobs}`}`
      : `worker: ${describeWorker(probe)}`,
  );
  // klucz uwierzytelnienia workera (T-17): tylko dla bieżącego użytkownika
  const kf = keyPath();
  if (existsSync(kf)) {
    const acl = checkKeyAcl(kf);
    ok(acl.ok, `klucz workera ${kf}: ${acl.detail}${acl.ok ? "" : " (naprawia hipokamp install)"}`);
  } else log("· klucz workera: jeszcze nie utworzony (powstanie przy pierwszym hooku albo starcie workera)");
  // pętla zablokowana na sekundy to worker, który odpowiada hookom po ich limicie czasu
  if (h?.eventLoopLagMaxMs !== undefined && h.eventLoopLagMaxMs > 1000)
    log(`! pętla workera stała ${h.eventLoopLagMaxMs} ms w ostatniej minucie (hooki czekają najwyżej 1,6 do 1,8 s)`);
  // winowajca ostatniego przestoju od 200 ms (starszy worker go nie podaje); szczegóły w logs/stall-RRRR-MM-DD.jsonl
  const culprit = (h as { lagCulprit?: { name: string; lagMs: number; agoS: number } | null } | null)?.lagCulprit;
  if (culprit && culprit.lagMs > 1000)
    log(`! ostatni przestój ${culprit.lagMs} ms (${culprit.agoS} s temu): ${culprit.name}, szczegóły w logs/stall-*.jsonl`);
  // wątek embeddingów wyłączony po zawieszeniach: działa bez wektorów (albo bez liczenia masowego) do restartu workera
  const off = (h as { embedderDisabled?: Record<string, string> } | null)?.embedderDisabled ?? {};
  for (const why of Object.values(off)) log(`! ${why} (hipokamp restart przywraca)`);
  const settings = join(claudeDir(), "settings.json");
  try {
    const j = JSON.parse(readFileSync(settings, "utf8"));
    const ep = j.enabledPlugins ?? {};
    // samo enabledPlugins nie wystarcza: `claude plugin enable` przechodzi też dla niezainstalowanego pluginu
    const installed = pluginInstallPath() !== null;
    ok(
      ep["hipokamp@hipokamp"] === true && installed,
      `plugin hipokamp ${!installed ? "NIEZAINSTALOWANY (brak w installed_plugins.json: sesje bez hooków i MCP), hipokamp install" : ep["hipokamp@hipokamp"] ? "zainstalowany i włączony" : "niewłączony"}`,
    );
    const cm = ep["claude-mem@thedotmack"] === true;
    log(`${cm ? "!" : "✓"} claude-mem ${cm ? "WŁĄCZONY: dwa systemy pamięci naraz (podwójny kontekst)" : "wyłączony"}`);
  } catch {
    ok(false, "nie mogę odczytać ~/.claude/settings.json");
  }
  // katalog, z którego hooki uruchamiają kod: musi być czystym checkoutem live/main (T-31)
  for (const l of liveCheck()) log(l);
  const hk = hooksCheck();
  if (hk) ok(hk.ok, hk.line);
  // klucze synchronizacji (docs/SYNC.md): na Windows poza profilem użytkownika tryb 0600 nic nie chroni
  const syncWarn = (await import("../sync/client.ts")).secretFileWarning();
  if (syncWarn) log(`! ${syncWarn}`);
  // zegar synchronizacji (T-37): przy włączonej synchronizacji w tle, bez sieci (tylko meta tej bazy)
  if (cfg.sync.enabled) for (const w of (await import("../sync/store.ts")).clockWarnings(r)) log(`! synchronizacja: ${w.text}`);
  const spool = join(paths.spool(), "pending.jsonl");
  ok(!existsSync(spool), existsSync(spool) ? "w kolejce awaryjnej są wpisy (worker je przetworzy)" : "kolejka awaryjna pusta");
  ok(
    true,
    `budżety: start ${cfg.context.sessionStartBudget} tok., prompt ${cfg.context.promptBudget} tok., plik ${cfg.context.fileBudget} tok.`,
  );
  ok(true, "hooki: zawsze exit 0 (pamięć nigdy nie blokuje promptu), koszt LLM: 0 zł");
  // inne harnessy: serwer MCP, hooki, plugin i pliki sesji (tylko odczyt konfiguracji)
  for (const l of (await import("./harnesses.ts")).harnessReport()) log(l);
  // integracje opcjonalne: stan widoczny, zanim cokolwiek zrobią same
  const { autoMemoryState } = await import("../importers/automemory.ts");
  const am = autoMemoryState(db, cfg);
  log(
    `${am.invalid ? "!" : am.on ? "✓" : "·"} pamięć automatyczna Claude Code w workerze: ${am.on ? "włączona" : "wyłączona"} (${am.why})`,
  );
  log(
    `· powiadomienia: ${cfg.notify.enabled ? `włączone, kanały ${cfg.notify.channels.join(", ") || "brak"}` : "wyłączone (notify.enabled)"}`,
  );
  // tryb rozstrzygnięty (test dymny natywnego pliku) tylko wtedy, gdy kanały z procesem w ogóle są ustawione
  const nw = notifyModeWarning(cfg, processChannels(cfg).length ? hooksModeFor(cfg.hooks.mode).mode : undefined);
  if (nw) log(`! ${nw}`);
  const llm = cfg.consolidation.llm;
  log(
    `· lokalny LLM w śnie: ${llm?.enabled ? `włączony, ${llm.model || "model nieustawiony"} pod ${llm.baseUrl}` : "wyłączony (consolidation.llm.enabled)"}`,
  );
}
