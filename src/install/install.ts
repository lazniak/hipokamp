// Instalacja jako plugin Claude Code (lokalny marketplace z tego repo) + opcjonalne zastąpienie claude-mem,
// hooki i MCP w Codexie oraz autostart workera (harness.ts), serwer MCP, hooki i plugin w innych harnessach
// (harnesses.ts).
// Wszystko odwracalne: kopie ustawień w ~/.hipokamp/backups/<czas>/, `hipokamp rollback` przywraca claude-mem.
// Marketplace zarejestrowany z innego katalogu (np. katalog roboczy zamiast worktree live, T-31) jest przepinany.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "../capture/harnesses.ts";
import { claudeDir, loadConfig, paths } from "../config.ts";
import { hooksModeFor, pluginHooks } from "../hooks/modes.ts";
import { ensureKey } from "../worker/auth.ts";
import { keyPath } from "../worker/client.ts";
import { DEFAULT_BUDGET_MS, hardenKeyOnce } from "../worker/keyacl.ts";
import { installAutostart, installCodex, uninstallAutostart, uninstallCodex } from "./harness.ts";
import {
  CODE_REPO,
  describeDiff,
  marketplaceDir,
  PLUGIN_ID,
  pluginCacheDiff,
  pluginInstallPath,
  samePath,
  treeDiff,
} from "./live.ts";
import { ensureNative } from "./native.ts";

const STATE = () => join(paths.state(), "install.json");

export type Log = (m: string) => void;

/** Uruchamia program bez powłoki (ścieżki ze spacjami i znakami `&` nie rozbijają poleceń).
 *  Shimy .cmd/.bat (np. claude z npm) idą przez cmd.exe z każdym argumentem w cudzysłowie. */
export function sh(
  args: string[],
  dry: boolean,
  log: Log,
  o: { cwd?: string; timeout?: number } = {},
): { ok: boolean; out: string } {
  log(`$ ${args.join(" ")}`);
  if (dry) return { ok: true, out: "" };
  const exe = Bun.which(args[0]) ?? args[0];
  let cmd = exe;
  let argv = args.slice(1);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    if (args.some((a) => /["%]/.test(a)))
      return { ok: false, out: `argument z " albo % nie przejdzie przez cmd.exe: ${args.join(" ")}` };
    cmd = process.env.ComSpec || "cmd.exe";
    argv = ["/d", "/s", "/c", `"${[exe, ...argv].map((a) => `"${a}"`).join(" ")}"`];
  }
  const r = spawnSync(cmd, argv, {
    cwd: o.cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: cmd !== exe,
    timeout: o.timeout ?? 120_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim();
  if (out) log(out.split("\n").slice(-6).join("\n"));
  return { ok: r.status === 0, out };
}

function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Generuje hooks.json (w trybie z config hooks.mode, src/hooks/modes.ts) i .mcp.json pluginu z absolutnymi
 *  ścieżkami do repo; `changed`: treść inna niż na dysku. Tryb rozstrzyga test dymny natywnego hooka z TEGO repo. */
export function writePluginFiles(
  bunPath = process.execPath,
  repo = CODE_REPO,
  hooksMode = hooksModeFor(loadConfig().hooks.mode, repo),
): { hooks: string; mcp: string; changed: boolean } {
  const bun = fwd(bunPath);
  const hooks = pluginHooks({ mode: hooksMode.mode, bun: bunPath, repo });
  const mcp = { mcpServers: { hipokamp: { command: bun, args: [fwd(join(repo, "src", "mcp", "server.ts"))], env: {} } } };
  const plugin = join(repo, "plugin");
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  const hp = join(plugin, "hooks", "hooks.json");
  const mp = join(plugin, ".mcp.json");
  const put = (p: string, text: string) => {
    if (existsSync(p) && readFileSync(p, "utf8") === text) return false;
    writeFileSync(p, text);
    return true;
  };
  const a = put(hp, `${JSON.stringify(hooks, null, 2)}\n`);
  const b = put(mp, `${JSON.stringify(mcp, null, 2)}\n`);
  return { hooks: hp, mcp: mp, changed: a || b };
}

/** Kopia ustawień Claude Code (settings.json, installed_plugins.json, known_marketplaces.json); zwraca katalog kopii. */
export function backup(log: Log): string {
  const dir = join(paths.backups(), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const f of ["settings.json", join("plugins", "installed_plugins.json"), join("plugins", "known_marketplaces.json")]) {
    const src = join(claudeDir(), f);
    if (existsSync(src)) copyFileSync(src, join(dir, f.replace(/[\\/]/g, "__")));
  }
  log(`kopia ustawień Claude Code: ${dir}`);
  return dir;
}

function readState(): any {
  try {
    return JSON.parse(readFileSync(STATE(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(s: any): void {
  mkdirSync(paths.state(), { recursive: true });
  writeFileSync(STATE(), JSON.stringify(s, null, 2));
}

function enabledPlugins(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8")).enabledPlugins ?? {};
  } catch {
    return {};
  }
}

const accepted = (r: { ok: boolean; out: string }) => r.ok || /already/i.test(r.out);

const installedPlugins = () => join(claudeDir(), "plugins", "installed_plugins.json");

/** Działa naprawdę: wpis w installed_plugins.json i włączony. Samo `enable` przechodzi też dla niezainstalowanego. */
const pluginActive = () => pluginInstallPath() !== null && enabledPlugins()[PLUGIN_ID] === true;

interface PluginSnapshot {
  entry: unknown;
  installPath: string;
  copy: string;
}

// antywirus albo indeksowanie potrafią na chwilę zablokować świeżo zapisany plik na Windows
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;

/** Operacja na plikach z ponowieniem przy chwilowej blokadzie (rename i cp nie mają własnego maxRetries). */
function retry<T>(fn: () => T, tries = 5, delayMs = 200): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e: any) {
      if (i >= tries || !TRANSIENT.has(e?.code)) throw e;
      Bun.sleepSync(delayMs * i);
    }
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function pluginEntry(): unknown {
  try {
    return JSON.parse(readFileSync(installedPlugins(), "utf8")).plugins?.[PLUGIN_ID];
  } catch {
    return undefined;
  }
}

/** Wpis pluginu w installed_plugins.json i kopia katalogu z cache, zrobione przed `plugin uninstall`. */
function snapshotPlugin(dir: string, log: Log): PluginSnapshot | null {
  const entry = pluginEntry();
  const ip = pluginInstallPath();
  if (!entry || !ip || !existsSync(ip)) return null;
  const copy = join(dir, "plugin-cache");
  retry(() => {
    rmSync(copy, RM);
    cpSync(ip, copy, { recursive: true });
  });
  log(`kopia pluginu z cache: ${copy}`);
  return { entry, installPath: ip, copy };
}

/** Stan sprzed próby dalej obowiązuje: ten sam wpis, plugin włączony, drzewo kopii w cache jak w kopii zapasowej. */
const untouched = (s: PluginSnapshot) =>
  sameJson(pluginEntry(), s.entry) && pluginActive() && existsSync(s.installPath) && treeDiff(s.copy, s.installPath).length === 0;

/**
 * Przywraca stan sprzed `plugin uninstall`: katalog kopii w cache, wpis w installed_plugins.json i włączenie. Katalog
 * jest kopiowany obok (`<wersja>.hipokamp-nowy`) i podmieniany zmianą nazwy, więc przerwana kopia nie zostawia pół
 * katalogu w miejscu, z którego Claude Code ładuje plugin.
 */
function restorePlugin(s: PluginSnapshot, run: (args: string[]) => { ok: boolean; out: string }, log: Log): boolean {
  if (untouched(s)) {
    log("kopia pluginu w cache i wpis są takie jak przed próbą");
    return true;
  }
  const next = `${s.installPath}.hipokamp-nowy`;
  const prev = `${s.installPath}.hipokamp-stary`;
  try {
    retry(() => {
      rmSync(next, RM);
      cpSync(s.copy, next, { recursive: true });
    });
    rmSync(prev, RM);
    const had = existsSync(s.installPath);
    if (had) retry(() => renameSync(s.installPath, prev));
    try {
      retry(() => renameSync(next, s.installPath));
    } catch (e) {
      if (had) retry(() => renameSync(prev, s.installPath));
      throw e;
    }
    try {
      rmSync(prev, RM);
    } catch {
      log(`do usunięcia ręcznie: ${prev}`);
    }
    const doc: any = (() => {
      try {
        return JSON.parse(readFileSync(installedPlugins(), "utf8"));
      } catch {
        return { version: 2, plugins: {} };
      }
    })();
    doc.plugins ??= {};
    doc.plugins[PLUGIN_ID] = s.entry;
    retry(() => writeFileSync(installedPlugins(), `${JSON.stringify(doc, null, 2)}\n`));
    log(`przywrócono kopię pluginu w ${s.installPath} i wpis w installed_plugins.json`);
  } catch (e) {
    try {
      rmSync(next, RM);
    } catch {}
    log(`nie udało się przywrócić kopii pluginu (${String(e).slice(0, 200)}); kopia sprzed próby: ${s.copy}`);
    return false;
  }
  run(["enable", PLUGIN_ID]);
  return untouched(s);
}

const FIX =
  "Naprawa: zamknij sesje Claude Code i powtórz hipokamp install; gdy dalej nie przejdzie, claude plugin uninstall hipokamp@hipokamp --keep-data, potem claude plugin install hipokamp@hipokamp pokażą błąd wprost (różnice kopii: hipokamp doctor)";

/**
 * Rejestruje lokalny marketplace `hipokamp` z katalogu `repo` i instaluje oraz włącza plugin. Najpierw
 * `claude plugin validate` repo i `plugin/`: zepsuty manifest kończy pracę bez żadnej zmiany. Marketplace
 * zarejestrowany z innego katalogu jest przepinany (remove, add). Kopia pluginu w cache Claude Code, której drzewo
 * różni się od `<repo>/plugin`, jest instalowana od nowa (Claude Code nie odświeża kopii tej samej wersji). Każda
 * nieudana zmiana wraca do stanu sprzed niej: użytkownik nie może zostać bez pamięci.
 */
export function registerPlugin(o: { repo: string; dryRun: boolean; log: Log; backupDir?: string }): {
  ok: boolean;
  relocatedFrom?: string;
  error?: string;
} {
  const { repo, dryRun, log } = o;
  const run = (args: string[]) => sh(["claude", "plugin", ...args], dryRun, log);
  const installEnable = () => {
    const ins = run(["install", PLUGIN_ID]);
    const en = run(["enable", PLUGIN_ID]);
    return accepted(ins) && accepted(en) && (dryRun || pluginActive());
  };
  // walidacja tylko czyta, więc także w próbie
  for (const p of [repo, join(repo, "plugin")])
    if (!sh(["claude", "plugin", "validate", p], false, log).ok)
      return { ok: false, error: `claude plugin validate ${p} nie przechodzi; niczego nie zmieniam` };
  // powrót do poprzedniego katalogu, gdy nowy się nie przyjmie: hooki ze starego katalogu są lepsze niż żadne;
  // `relocatedFrom` zostaje w wyniku tylko wtedy, gdy powrót nie wyszedł (install zapisze go w stanie)
  const restore = (from: string, why: string) => {
    log(`BŁĄD: ${why}; wracam do ${from}`);
    if (marketplaceDir() !== null) run(["marketplace", "remove", "hipokamp"]);
    const back = accepted(run(["marketplace", "add", from])) && installEnable();
    return back
      ? { ok: false, error: `${why}; plugin działa dalej z ${from}` }
      : {
          ok: false,
          relocatedFrom: from,
          error: `${why}; powrót do ${from} też nie wyszedł: sprawdź claude plugin list i powtórz hipokamp install w ${from}`,
        };
  };
  const cur = marketplaceDir();
  let relocatedFrom: string | undefined;
  if (cur === null) {
    if (!accepted(run(["marketplace", "add", repo]))) return { ok: false, error: `nie udało się dodać marketplace z ${repo}` };
  } else if (cur && !samePath(cur, repo)) {
    log(`marketplace hipokamp jest zarejestrowany z ${cur}; przepinam na ${repo}`);
    if (!run(["marketplace", "remove", "hipokamp"]).ok)
      return { ok: false, error: `nie udało się usunąć marketplace hipokamp (${cur}); niczego nie zmieniam` };
    relocatedFrom = cur;
    if (!accepted(run(["marketplace", "add", repo]))) return restore(cur, `nie udało się dodać marketplace z ${repo}`);
  } else if (!run(["marketplace", "update", "hipokamp"]).ok)
    return { ok: false, error: "claude plugin marketplace update hipokamp nie przeszedł; niczego nie zmieniam" };
  const fail = (why: string) => (relocatedFrom ? restore(relocatedFrom, why) : { ok: false, error: why });
  if (!installEnable()) return fail("plugin hipokamp nie jest zainstalowany i włączony (sprawdź claude plugin list)");
  if (dryRun) return { ok: true, relocatedFrom };
  const plugin = join(repo, "plugin");
  const diff = pluginCacheDiff(repo);
  if (diff?.length === 0) return { ok: true, relocatedFrom };
  log(
    `kopia pluginu w cache Claude Code różni się od ${plugin}${diff ? ` (${describeDiff(diff)})` : ""}; instaluję plugin od nowa`,
  );
  // przy przepięciu stanem sprzed próby jest stary katalog; bez przepięcia: kopia z cache i wpis w installed_plugins
  let snap: PluginSnapshot | null = null;
  if (!relocatedFrom)
    try {
      snap = snapshotPlugin(o.backupDir ?? join(paths.backups(), new Date().toISOString().replace(/[:.]/g, "-")), log);
    } catch (e) {
      return {
        ok: false,
        error: `nie udało się skopiować pluginu z cache przed ponowną instalacją (${String(e).slice(0, 160)}); niczego nie zmieniam. ${FIX}`,
      };
    }
  /** Ponowna instalacja się nie udała: powrót do stanu sprzed niej, w komunikacie komenda naprawcza. */
  const undo = (why: string) => {
    if (relocatedFrom) return restore(relocatedFrom, why);
    const back = !!snap && restorePlugin(snap, run, log);
    return {
      ok: false,
      error: back
        ? `${why}; plugin działa jak przed próbą (kopia w cache i wpis w installed_plugins.json jak wcześniej). ${FIX}`
        : `${why}; nie udało się przywrócić poprzedniej kopii pluginu${snap ? ` (leży w ${snap.copy})` : ""}. ${FIX}`,
    };
  };
  try {
    // nieudany uninstall zostawia wpis, a `install` odpowiada wtedy „already installed” bez podmiany kopii
    if (!run(["uninstall", PLUGIN_ID, "--keep-data"]).ok)
      return undo(`claude plugin uninstall ${PLUGIN_ID} nie przeszedł, więc kopii pluginu w cache nie da się odświeżyć`);
    if (!installEnable()) return undo("ponowna instalacja pluginu nie wyszła");
    const left = pluginCacheDiff(repo);
    if (left?.length !== 0)
      return undo(
        `po ponownej instalacji kopia pluginu w cache dalej różni się od ${plugin}${left ? ` (${describeDiff(left)})` : " (brak kopii)"}`,
      );
  } catch (e) {
    return undo(`nieoczekiwany błąd przy ponownej instalacji: ${String(e).slice(0, 200)}`);
  }
  return { ok: true, relocatedFrom };
}

/** Stan zadania Harmonogramu (Ready, Disabled, Running…; nazwy z wyliczenia, niezależne od języka systemu) albo null. */
function taskState(name: string): string | null {
  const r = sh(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-ScheduledTask -TaskName '${name}' -ErrorAction Stop).State`,
    ],
    false,
    () => {},
  );
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

/**
 * Instaluje plugin z katalogu `repo` (domyślnie ten, z którego działa kod; inny tylko w testach, bo Codex i autostart
 * zawsze wskazują kod bieżący). Zwraca false, gdy plugin nie działa albo claude-mem nie dał się wyłączyć.
 */
export async function install(o: {
  replace: boolean;
  dryRun: boolean;
  log: Log;
  codex?: boolean;
  /** Inne harnessy (false: żaden, np. w testach pluginu); `skipHarnesses`: flagi --no-<harness>. */
  harnesses?: boolean;
  skipHarnesses?: Partial<Record<Harness, boolean>>;
  autostart?: boolean;
  repo?: string;
}): Promise<boolean> {
  const { log, dryRun } = o;
  const repo = o.repo ?? CODE_REPO;
  // config czytany od nowa: install to jednorazowa komenda, a zmiana hooks.mode ma działać od razu
  const mode = loadConfig(true).hooks.mode;
  ensureNative({ repo, mode, log, dryRun });
  const hm = hooksModeFor(mode, repo);
  const files = dryRun ? { hooks: "(dry-run)", mcp: "(dry-run)" } : writePluginFiles(process.execPath, repo, hm);
  log(`plugin: ${join(repo, "plugin")}\n  hooks: ${files.hooks} (tryb ${hm.mode}: ${hm.reason})\n  mcp:   ${files.mcp}`);
  const bk = dryRun ? "(dry-run)" : backup(log);
  let reg: ReturnType<typeof registerPlugin>;
  try {
    reg = registerPlugin({ repo, dryRun, log, backupDir: dryRun ? undefined : bk });
  } catch (e) {
    reg = { ok: false, error: `nieoczekiwany błąd rejestracji pluginu: ${String(e).slice(0, 200)} (kopia ustawień: ${bk})` };
  }
  if (!reg.ok) {
    // przepięcie, z którego nie udało się wrócić: stary katalog musi zostać zapisany, inaczej nikt go nie odnajdzie
    if (reg.relocatedFrom && !dryRun)
      writeState({
        ...readState(),
        marketplace: { path: marketplaceDir(), previous: reg.relocatedFrom, relocatedAt: new Date().toISOString(), failed: true },
      });
    // bez działającego hipokampa nie ruszamy claude-mem: użytkownik nie może zostać bez pamięci
    log(`BŁĄD: ${reg.error}. claude-mem zostaje bez zmian.`);
    return false;
  }

  const prev = readState();
  const at = new Date().toISOString();
  const marketplace = reg.relocatedFrom
    ? { path: repo, previous: reg.relocatedFrom, relocatedAt: at }
    : { ...(prev.marketplace ?? {}), path: repo, failed: undefined };
  const state = { ...prev, repo, installedAt: at, backup: bk, marketplace };
  if (reg.relocatedFrom) log(`plugin przepięty z ${reg.relocatedFrom} na ${repo}; stary katalog zostaje na dysku bez zmian`);
  let ok = true;
  if (o.replace) {
    // stan sprzed PIERWSZEGO zastąpienia: kolejne instalacje (np. po aktualizacji) go nie nadpisują
    if (!prev.replaced)
      Object.assign(state, {
        claudeMemWasEnabled: enabledPlugins()["claude-mem@thedotmack"] === true,
        replacedAt: state.installedAt,
      });
    let cmOff = true;
    if (enabledPlugins()["claude-mem@thedotmack"] === true) {
      const d = sh(["claude", "plugin", "disable", "claude-mem@thedotmack"], dryRun, log);
      cmOff = dryRun || (d.ok && enabledPlugins()["claude-mem@thedotmack"] !== true);
    }
    // watchdog claude-mem nie ma już czego pilnować (i restartowałby cudzego workera); ruszamy go tylko, gdy był
    // włączony, żeby rollback nie włączył zadania wyłączonego wcześniej przez użytkownika (stan nieznany: jak włączony)
    const wd = taskState("claude-mem-watchdog");
    let wdOff = false;
    if (wd !== "Disabled") wdOff = sh(["schtasks", "/Change", "/TN", "claude-mem-watchdog", "/DISABLE"], dryRun, log).ok;
    Object.assign(state, { replaced: true, watchdogDisabled: prev.watchdogDisabled === true || wdOff });
    log(
      cmOff
        ? "claude-mem wyłączony (dane w ~/.claude-mem zostają nietknięte). Powrót: hipokamp rollback"
        : "UWAGA: nie udało się wyłączyć claude-mem, działają oba pluginy. Wyłącz ręcznie: claude plugin disable claude-mem@thedotmack",
    );
    if (!cmOff) ok = false;
  }
  // Codex: te same hooki i serwer MCP (sesje Codexa trafiają do tej samej pamięci)
  if (o.codex !== false && loadConfig().capture.codex) {
    installCodex({ dryRun, log });
    state.codex = true;
  }
  // klucz uwierzytelnienia workera (T-17) przed autostartem: powstaje tu, a nie w workerze, bo ACL tylko dla
  // bieżącego użytkownika ustawia icacls (proces potomny, w workerze zakazany)
  if (dryRun) log(`(dry-run) klucz workera: ${keyPath()} (tylko dla bieżącego użytkownika)`);
  else {
    try {
      const k = ensureKey(keyPath());
      const acl = hardenKeyOnce(keyPath(), true, DEFAULT_BUDGET_MS) ?? { ok: false, detail: "?" };
      log(`klucz workera ${k.created ? "utworzony" : "jest"}: ${keyPath()} (${acl.detail})`);
      if (!acl.ok) log("UWAGA: klucz workera czytelny nie tylko dla Ciebie; sprawdź uprawnienia katalogu danych");
    } catch (e) {
      log(`UWAGA: klucz workera: ${String(e).slice(0, 200)}`);
    }
  }
  // inne harnessy (Gemini CLI, Antigravity, Cursor, OpenCode, Claude Desktop): tylko wykryte i włączone
  if (o.harnesses !== false) {
    // błąd harnessu nie zatrzymuje instalacji: plugin i Codex są już podłączone, a ich stan musi trafić na dysk
    let done: Harness[] = [];
    try {
      done = (await import("./harnesses.ts")).installHarnesses({
        dryRun,
        log,
        skip: o.skipHarnesses,
        replaceClaudeMem: o.replace,
      });
    } catch (e) {
      log(`harnessy: BŁĄD (${String(e).slice(0, 200)}); reszta instalacji zostaje`);
    }
    state.harnesses = [...new Set([...(Array.isArray(prev.harnesses) ? prev.harnesses : []), ...done])];
  }
  if (o.autostart !== false && process.platform === "win32")
    state.autostart = installAutostart({ dryRun, log }) || prev.autostart === true;
  if (!dryRun) writeState(state);
  log("gotowe: działa od NOWYCH sesji Claude Code i Codexa (bieżące sesje mają stare hooki).");
  return ok;
}

export async function rollback(o: { dryRun: boolean; log: Log }): Promise<void> {
  const { log, dryRun } = o;
  const st = readState();
  const at = new Date().toISOString();
  if (st.codex === true) uninstallCodex({ dryRun, log });
  // harnessy z listy, a do tego hooki i pluginy claude-mem zdjęte przez instalację (wracają także wtedy, gdy instalacja
  // harnessu przerwała się po ich zdjęciu i harness nie trafił na listę)
  try {
    const hs = await import("./harnesses.ts");
    const list: Harness[] = Array.isArray(st.harnesses) ? st.harnesses : [];
    if (list.length || hs.harnessLeftovers()) hs.uninstallHarnesses({ dryRun, log, harnesses: list });
  } catch (e) {
    log(`harnessy: BŁĄD (${String(e).slice(0, 200)}); rollback idzie dalej`);
  }
  if (st.autostart === true) uninstallAutostart({ dryRun, log });
  if (st.replaced !== true) {
    sh(["claude", "plugin", "disable", "hipokamp@hipokamp"], dryRun, log);
    log("hipokamp wyłączony; nie zastępował claude-mem, więc nic więcej nie przywracam.");
    if (!dryRun) writeState({ ...st, rolledBackAt: at });
    return;
  }
  // przywracamy stan sprzed instalacji: claude-mem wyłączony wcześniej zostaje wyłączony. Najpierw włączamy
  // claude-mem i sprawdzamy, dopiero potem wyłączamy hipokamp: użytkownik nie może zostać bez pamięci
  if (st.claudeMemWasEnabled === true) {
    const r = sh(["claude", "plugin", "enable", "claude-mem@thedotmack"], dryRun, log);
    const ok = dryRun || ((r.ok || /already/i.test(r.out)) && enabledPlugins()["claude-mem@thedotmack"] === true);
    if (!ok) {
      log(
        "BŁĄD: nie udało się włączyć claude-mem (sprawdź `claude plugin list`). hipokamp zostaje włączony; popraw i powtórz hipokamp rollback.",
      );
      process.exitCode = 1;
      return;
    }
  }
  sh(["claude", "plugin", "disable", "hipokamp@hipokamp"], dryRun, log);
  const wdOk =
    st.watchdogDisabled === true ? sh(["schtasks", "/Change", "/TN", "claude-mem-watchdog", "/ENABLE"], dryRun, log).ok : true;
  log(
    st.claudeMemWasEnabled === true
      ? "przywrócono claude-mem (działa od nowych sesji). Dane hipokampa zostają w ~/.hipokamp."
      : "hipokamp wyłączony; claude-mem nie był włączony przed instalacją, więc zostaje wyłączony.",
  );
  if (!wdOk) log("UWAGA: nie udało się włączyć zadania claude-mem-watchdog; włącz je w Harmonogramie zadań.");
  if (!dryRun) writeState({ ...st, replaced: false, watchdogDisabled: st.watchdogDisabled === true && !wdOk, rolledBackAt: at });
}
