// Podłączenie hipokampa poza pluginem Claude Code: hooki i serwer MCP w Codexie oraz autostart workera (Windows).
// Zmiany idempotentne, z kopią plików w ~/.hipokamp/backups/<czas>/; rollback je cofa.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexHome } from "../capture/codex.ts";
import { paths } from "../config.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const TASK = "hipokamp-worker";

type Log = (m: string) => void;

const fwd = (p: string) => p.replace(/\\/g, "/");

/** Zdarzenia Codexa, które obsługujemy: kontekst na start, przypomnienie przy prompcie i przy pliku, zapis po turze.
 *  Pliki Codex zmienia łatką (`apply_patch`, także w skrypcie `exec`): ścieżki wyciąga capture/codex.ts. */
const CODEX_EVENTS: { event: string; arg: string; timeout: number; matcher?: string }[] = [
  { event: "SessionStart", arg: "session-start", timeout: 15, matcher: "startup|resume|clear|compact" },
  { event: "UserPromptSubmit", arg: "prompt", timeout: 10 },
  { event: "PostToolUse", arg: "post-tool", timeout: 8, matcher: "apply_patch|exec" },
  { event: "Stop", arg: "stop", timeout: 30 },
];

const isOurs = (group: any) =>
  Array.isArray(group?.hooks) &&
  group.hooks.some((h: any) => typeof h?.command === "string" && /hipokamp/i.test(h.command) && /hook\.ts/.test(h.command));

function backupFile(src: string, name: string, log: Log): void {
  const dir = join(paths.backups(), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, name));
  log(`kopia: ${join(dir, name)}`);
}

const RE_MCP_BLOCK = /^\[mcp_servers\.hipokamp\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;

/**
 * Hooki hipokampa w ~/.codex/hooks.json (dopisane na końcu list, żeby nie przesuwać zaufanych wpisów innych
 * narzędzi: Codex pamięta zaufanie po pozycji) i serwer MCP w config.toml. Nowe hooki Codex pokaże do
 * zatwierdzenia przy następnym starcie; tego potwierdzenia nie omijamy.
 */
export function installCodex(o: { dryRun: boolean; log: Log; bunPath?: string }): { hooks: boolean; mcp: boolean } {
  const { log, dryRun } = o;
  const home = codexHome();
  const res = { hooks: false, mcp: false };
  if (!existsSync(home)) {
    log("Codex: brak katalogu ~/.codex, pomijam.");
    return res;
  }
  const bun = fwd(o.bunPath ?? process.execPath);
  const hookCmd = (arg: string) => `"${bun}" "${fwd(join(REPO, "src", "hooks", "hook.ts"))}" ${arg} codex`;

  const hp = join(home, "hooks.json");
  let doc: any = { hooks: {} };
  try {
    if (existsSync(hp)) doc = JSON.parse(readFileSync(hp, "utf8"));
  } catch (e) {
    log(`Codex: nie czytam ${hp} (${String(e).slice(0, 120)}); hooków nie zmieniam.`);
    return res;
  }
  doc.hooks ??= {};
  for (const e of CODEX_EVENTS) {
    const group = {
      ...(e.matcher ? { matcher: e.matcher } : {}),
      hooks: [{ type: "command", command: hookCmd(e.arg), timeout: e.timeout }],
    };
    const list: any[] = Array.isArray(doc.hooks[e.event]) ? doc.hooks[e.event] : (doc.hooks[e.event] = []);
    const i = list.findIndex(isOurs);
    if (i < 0) list.push(group);
    else if (JSON.stringify(list[i]) !== JSON.stringify(group)) list[i] = group;
    else continue;
    res.hooks = true;
  }
  if (res.hooks) {
    log(`Codex: hooki hipokampa w ${hp}`);
    if (!dryRun) {
      if (existsSync(hp)) backupFile(hp, "codex__hooks.json", log);
      writeFileSync(hp, `${JSON.stringify(doc, null, 2)}\n`);
    }
  }

  const cp = join(home, "config.toml");
  const toml = existsSync(cp) ? readFileSync(cp, "utf8") : "";
  const block = [
    "[mcp_servers.hipokamp]",
    `command = '${o.bunPath ?? process.execPath}'`,
    `args = ['${join(REPO, "src", "mcp", "server.ts")}']`,
    "startup_timeout_sec = 30",
    "",
  ].join("\n");
  const cur = toml.match(RE_MCP_BLOCK)?.[0];
  if (cur?.trim() !== block.trim()) {
    res.mcp = true;
    log(`Codex: serwer MCP hipokamp w ${cp}`);
    if (!dryRun) {
      if (existsSync(cp)) backupFile(cp, "codex__config.toml", log);
      const next = cur ? toml.replace(RE_MCP_BLOCK, block) : `${toml}${toml && !toml.endsWith("\n") ? "\n" : ""}\n${block}`;
      writeFileSync(cp, next);
    }
  }
  if (!res.hooks && !res.mcp) log("Codex: hooki i MCP hipokampa już są.");
  else if (res.hooks) log("Codex: przy następnym starcie zatwierdź nowe hooki (Codex pyta o zaufanie do zmienionych hooków).");
  return res;
}

/** Usuwa hooki i serwer MCP hipokampa z Codexa (rollback). */
export function uninstallCodex(o: { dryRun: boolean; log: Log }): void {
  const { log, dryRun } = o;
  const home = codexHome();
  const hp = join(home, "hooks.json");
  if (existsSync(hp)) {
    try {
      const doc = JSON.parse(readFileSync(hp, "utf8"));
      let n = 0;
      for (const ev of Object.keys(doc.hooks ?? {})) {
        const list = doc.hooks[ev];
        if (!Array.isArray(list)) continue;
        const kept = list.filter((g: any) => !isOurs(g));
        n += list.length - kept.length;
        if (kept.length) doc.hooks[ev] = kept;
        else delete doc.hooks[ev];
      }
      if (n) {
        log(`Codex: usuwam ${n} hooki hipokampa z ${hp}`);
        if (!dryRun) {
          backupFile(hp, "codex__hooks.json", log);
          writeFileSync(hp, `${JSON.stringify(doc, null, 2)}\n`);
        }
      }
    } catch (e) {
      log(`Codex: nie czytam ${hp} (${String(e).slice(0, 120)}); usuń hooki hipokampa ręcznie.`);
    }
  }
  const cp = join(home, "config.toml");
  if (existsSync(cp)) {
    const toml = readFileSync(cp, "utf8");
    if (RE_MCP_BLOCK.test(toml)) {
      log(`Codex: usuwam serwer MCP hipokamp z ${cp}`);
      if (!dryRun) {
        backupFile(cp, "codex__config.toml", log);
        writeFileSync(cp, toml.replace(RE_MCP_BLOCK, ""));
      }
    }
  }
}

function powershell(script: string, dryRun: boolean, log: Log): boolean {
  log(`$ powershell: ${script.split("\n")[0]}…`);
  if (dryRun) return true;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0 && out) log(out.split("\n").slice(-4).join("\n"));
  return r.status === 0;
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Zadanie Harmonogramu „hipokamp-worker”: worker startuje przy logowaniu, bez okna konsoli. Razem z
 * workerIdleExitMin = 0 worker działa stale (nadrabianie sesji wszystkich harnessów i panel bez czekania na hook).
 */
export function installAutostart(o: { dryRun: boolean; log: Log; bunPath?: string }): boolean {
  if (process.platform !== "win32") {
    o.log("autostart: tylko Windows (na innych systemach worker wstaje z pierwszym hookiem).");
    return false;
  }
  const vbs = join(REPO, "scripts", "ukryty-start.vbs");
  const args = `//B //Nologo "${vbs}" "${o.bunPath ?? process.execPath}" "${join(REPO, "src", "cli.ts")}"`;
  const ok = powershell(
    [
      `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psq(args)}`,
      "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
      "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0",
      `Register-ScheduledTask -TaskName ${psq(TASK)} -Action $a -Trigger $t -Settings $s -Description 'hipokamp: worker pamięci przy logowaniu' -Force | Out-Null`,
    ].join("; "),
    o.dryRun,
    o.log,
  );
  o.log(ok ? `autostart: zadanie ${TASK} (przy logowaniu, bez okna)` : `UWAGA: nie udało się zarejestrować zadania ${TASK}`);
  return ok;
}

export function uninstallAutostart(o: { dryRun: boolean; log: Log }): void {
  if (process.platform !== "win32") return;
  powershell(`Unregister-ScheduledTask -TaskName ${psq(TASK)} -Confirm:$false -ErrorAction SilentlyContinue`, o.dryRun, o.log);
}
