// `hipokamp update`: aktualizacja worktree „live”, z którego działa plugin (T-31). Tylko szybkie przewinięcie do
// origin/main, zależności, gdy zmienił się lockfile, potem drugi etap już NOWYM kodem (osobny proces): natywny hook
// (przebudowa, gdy zmieniły się jego źródła albo wersja), pliki pluginu, odświeżenie kopii w cache Claude Code,
// restart workera i diagnoza. Odmawia przy niezacommitowanych zmianach i na
// innej gałęzi niż live/main: taki katalog nie jest „żywym” checkoutem, a update zrobiłby więcej szkody niż pożytku.
// Stan w ~/.hipokamp/state/update.json: drugi etap, który nie przeszedł, powtarza kolejne `hipokamp update`.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths } from "../config.ts";
import { ensureWorker, type Health, portOpen, probeWorker } from "../worker/client.ts";
import { backup, type Log, registerPlugin, sh, writePluginFiles } from "./install.ts";
import { CODE_REPO, git, gitCheckout, LIVE_BRANCHES, marketplaceDir, pluginCacheCurrent, samePath } from "./live.ts";
import { ensureNative } from "./native.ts";

interface UpdateState {
  repo: string;
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
}

const STATE = () => join(paths.state(), "update.json");

function readUpdateState(): UpdateState | null {
  try {
    return JSON.parse(readFileSync(STATE(), "utf8"));
  } catch {
    return null;
  }
}

function writeUpdateState(s: UpdateState): void {
  mkdirSync(paths.state(), { recursive: true });
  writeFileSync(STATE(), JSON.stringify(s, null, 2));
}

/** Zapisuje, że drugi etap aktualizacji `repo` do commitu `head` się udał. */
function markFinished(repo: string, head: string): void {
  const s = readUpdateState();
  if (s && !s.finishedAt && samePath(s.repo, repo) && s.to === head)
    writeUpdateState({ ...s, finishedAt: new Date().toISOString() });
}

/**
 * Zatrzymuje workera i czeka, aż zwolni port (trzyma otwarte biblioteki natywne z node_modules). Worker z kluczem
 * zatrzymuje po PID ze zdrowia; starszy worker bez uwierzytelnienia (T-17) i worker, który nie odpowiada na wyzwanie,
 * tylko po PID z worker.lock.json i sprawdzeniu linii poleceń oraz chwili utworzenia procesu (legacy.ts). Obcego
 * procesu na porcie nie rusza.
 */
export async function stopWorker(waitMs = 5_000): Promise<boolean> {
  const p = await probeWorker(800);
  if (p.state === "none") return true;
  const pid = p.state === "ok" ? p.health.pid : p.state === "legacy" ? p.pid : p.lockPid;
  if (pid === undefined) return false;
  // bez dowodu klucza PID pochodzi z worker.lock.json: zatrzymanie dopiero po sprawdzeniu linii poleceń i chwili
  // utworzenia procesu względem startedAt (PID mógł zostać przydzielony innemu procesowi)
  if (p.state !== "ok") return (await import("../worker/legacy.ts")).stopVerifiedWorker(pid, p.startedAt, waitMs);
  try {
    process.kill(pid);
  } catch {}
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await Bun.sleep(250);
    if (!(await portOpen())) return true;
  }
  return false;
}

/** Restart workera (jak `hipokamp restart`): nowy proces startuje z kodu katalogu, z którego działa ta komenda. */
export async function restartWorker(waitMs = 20_000): Promise<Health | null> {
  if (await portOpen()) {
    await stopWorker();
    await Bun.sleep(300);
  }
  return ensureWorker(waitMs);
}

const normCmd = (s: string) => {
  const r = s.replace(/\\/g, "/");
  return process.platform === "win32" ? r.toLowerCase() : r;
};

/** Ile z podanych linii poleceń to serwer MCP hipokampa uruchomiony z katalogu `top` (`bun …/src/mcp/server.ts`). */
export function mcpServersFrom(cmdlines: string[], top: string): number {
  const needle = normCmd(join(top, "src", "mcp", "server.ts"));
  return cmdlines.filter((c) => normCmd(c).includes(needle)).length;
}

/** Linie poleceń procesów bun (Windows: CIM przez PowerShell, Linux: /proc); pusta lista, gdy nie da się ich odczytać. */
function bunCommandLines(): string[] {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'bun%'\" | ForEach-Object { $_.CommandLine }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    return (r.stdout ?? "").split(/\r?\n/).filter((l) => l.trim());
  }
  try {
    return readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .map((d) => {
        try {
          return readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ");
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Drugi etap w osobnym procesie: po scaleniu pliki .ts na dysku są nowe, a ten proces ma w pamięci stary kod. */
const finishInNewCode = (top: string) => (from: string) =>
  spawnSync(process.execPath, [join(top, "src", "cli.ts"), "update", "--finish", from], {
    stdio: "inherit",
    windowsHide: true,
  }).status === 0;

export async function update(o: {
  dryRun: boolean;
  log: Log;
  /** katalog checkoutu; domyślnie ten, z którego działa kod */
  repo?: string;
  /** drugi etap po scaleniu (testy podstawiają własny); domyślnie `hipokamp update --finish` nowym kodem */
  finish?: (from: string) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const { log, dryRun } = o;
  const g = gitCheckout(o.repo ?? CODE_REPO);
  const refuse = (m: string) => {
    log(`odmawiam: ${m}`);
    return false;
  };
  if (!g.git) return refuse(`${g.top} nie jest checkoutem git; update działa w worktree live (docs/MIGRACJA.md)`);
  const top = g.top;
  if (!LIVE_BRANCHES.includes(g.branch))
    return refuse(
      `${top} stoi na ${g.branch === "HEAD" ? "odłączonym HEAD" : `gałęzi ${g.branch}`}; update aktualizuje tylko ${LIVE_BRANCHES.join(" albo ")}`,
    );
  if (g.dirty.length)
    return refuse(
      `niezacommitowane zmiany w ${top} (${g.dirty.length}):\n  ${g.dirty.slice(0, 10).join("\n  ")}${g.dirty.length > 10 ? "\n  …" : ""}\nW katalogu pluginu nie pracujemy; zmiany przenieś do osobnego worktree.`,
    );
  if (!git(top, ["remote", "get-url", "origin"]).ok) return refuse(`${top} nie ma zdalnego origin`);

  /** Drugi etap z zapisem stanu; po błędzie mówi, gdzie jest kod i jak dokończyć albo wrócić. */
  const runFinish = async (from: string, to: string) => {
    const prev = readUpdateState();
    if (!(prev && samePath(prev.repo, top) && prev.from === from && prev.to === to))
      writeUpdateState({ repo: top, from, to, startedAt: new Date().toISOString() });
    const ok = await (o.finish ?? finishInNewCode(top))(from);
    if (ok) markFinished(top, to);
    else
      log(
        `BŁĄD: drugi etap update nie przeszedł. Kod w ${top} jest już na ${to.slice(0, 8)}, poprzednio ${from.slice(0, 8)}.\n  dokończenie: hipokamp update (powtórzy drugi etap) albo hipokamp update --finish ${from}\n  powrót do poprzedniej wersji: git -C ${top} reset --keep ${from}, potem hipokamp install i hipokamp restart`,
      );
    return ok;
  };

  // fetch zmienia tylko origin/*, nie drzewo: także w próbie, żeby pokazać, co by przyszło
  if (!sh(["git", "-C", top, "fetch", "origin"], false, log).ok) {
    log("BŁĄD: git fetch origin nie przeszedł (sprawdź sieć i uprawnienia do origin)");
    return false;
  }
  const old = g.head;
  const target = git(top, ["rev-parse", "origin/main"]).out.trim();
  if (!target) return refuse("brak origin/main");
  if (target === old) {
    const last = readUpdateState();
    if (last && !last.finishedAt && samePath(last.repo, top) && last.to === old) {
      log(
        `poprzedni hipokamp update (${last.from.slice(0, 8)} → ${last.to.slice(0, 8)}) nie dokończył drugiego etapu; powtarzam go`,
      );
      if (dryRun) {
        log(`(dry-run) hipokamp update --finish ${last.from}`);
        return true;
      }
      return runFinish(last.from, old);
    }
    log(`już aktualne: ${g.branch} = origin/main (${old.slice(0, 8)})`);
    return true;
  }
  if (!git(top, ["merge-base", "--is-ancestor", "HEAD", "origin/main"]).ok)
    return refuse(
      `${g.branch} ma commity, których nie ma w origin/main, więc to nie jest szybkie przewinięcie. Sprawdź: git -C ${top} log --oneline origin/main..HEAD`,
    );
  const incoming = git(top, ["log", "--oneline", "--no-decorate", `${old}..${target}`])
    .out.split("\n")
    .filter(Boolean);
  log(`nowe commity (${incoming.length}):\n  ${incoming.slice(0, 20).join("\n  ")}${incoming.length > 20 ? "\n  …" : ""}`);
  const changed = git(top, ["diff", "--name-only", old, target]).out.split("\n").filter(Boolean);
  const deps = changed.some((f) => f === "bun.lock" || f === "package.json");
  if (deps) {
    // ostrzeżenie, nie odmowa: na Linuksie i bez zmian bibliotek natywnych bun install przejdzie mimo otwartych sesji
    const mcp = mcpServersFrom(bunCommandLines(), top);
    if (mcp)
      log(
        `UWAGA: działa ${mcp} serwerów MCP hipokampa z ${top} (otwarte sesje Claude Code albo Codexa). Na Windows trzymają biblioteki natywne z node_modules, więc bun install może nie przejść; update wtedy wróci do ${old.slice(0, 8)}. Najpewniej: zamknij sesje, potem hipokamp update.`,
      );
  }
  const native = changed.some((f) => f.startsWith("native/hook/"));
  if (dryRun) {
    log(
      `(dry-run) git merge --ff-only origin/main${deps ? ", hipokamp stop, bun install --frozen-lockfile" : ""}${native ? ", przebudowa natywnego hooka (gdy jest Go)" : ""}, pliki pluginu, restart workera, doctor`,
    );
    return true;
  }
  if (!sh(["git", "-C", top, "merge", "--ff-only", "origin/main"], false, log).ok) {
    log("BŁĄD: git merge --ff-only origin/main nie przeszedł; drzewo zostaje na starym commicie");
    return false;
  }
  if (deps) {
    // worker trzyma otwarte biblioteki natywne (ONNX Runtime, sqlite-vec), których bun install nie podmieni na Windows
    if (!(await stopWorker())) log("UWAGA: worker nie zatrzymał się; bun install może nie podmienić bibliotek natywnych");
    const bunInstall = () =>
      sh([process.execPath, "install", "--frozen-lockfile"], false, log, { cwd: top, timeout: 600_000 }).ok;
    if (!bunInstall()) {
      // hooki uruchamiają pliki z tego katalogu, a nowy kod bez swoich zależności by nie wstał: wracamy od razu,
      // a node_modules (mogło zostać w połowie nowe) odtwarzamy ze starego lockfile
      const back = sh(["git", "-C", top, "reset", "--keep", old], false, log).ok;
      const depsBack = back && bunInstall();
      await ensureWorker();
      log(
        back
          ? `BŁĄD: bun install nie przeszedł; drzewo wróciło do ${old.slice(0, 8)}${depsBack ? "" : ", ale zależności starej wersji też się nie odtworzyły"}. Na Windows biblioteki natywne z node_modules trzymają też serwery MCP otwartych sesji: zamknij sesje Claude Code i Codexa, hipokamp stop, potem hipokamp update.`
          : `BŁĄD: bun install nie przeszedł i nie udało się wrócić do ${old.slice(0, 8)}: git -C ${top} reset --keep ${old}, potem bun install --frozen-lockfile`,
      );
      return false;
    }
  } else log("zależności bez zmian (bun.lock i package.json nietknięte)");
  return runFinish(old, target);
}

/**
 * Drugi etap update (`hipokamp update --finish <sha>`), już nowym kodem: pliki pluginu, odświeżenie kopii pluginu w
 * cache Claude Code (gdy marketplace wskazuje ten katalog, a pliki pluginu się zmieniły albo kopia jest nieaktualna;
 * wcześniej kopia ustawień Claude Code), restart workera i diagnoza. false: rejestracja albo restart nie wyszły.
 */
export async function finishUpdate(o: {
  log: Log;
  /** commit sprzed scalenia */
  from?: string;
  repo?: string;
  restart?: () => Promise<unknown>;
  doctor?: (log: Log) => Promise<void>;
}): Promise<boolean> {
  const { log } = o;
  const repo = o.repo ?? CODE_REPO;
  // natywny hook: nowe źródła (native/hook/) albo nowa NATIVE_VERSION (test dymny) = przebudowa, zanim hooks.json
  // wybierze tryb. Stary plik z nowym kodem TS odpada w teście dymnym (wersja), więc bez Go albo po nieudanej budowie
  // tryb spada do command; między scaleniem a tym etapem stary plik rozmawia jeszcze ze starym workerem (restart niżej)
  const nativeSrc = o.from ? git(repo, ["diff", "--name-only", o.from, "HEAD", "--", "native/hook"]).out.trim() : "";
  ensureNative({ repo, mode: loadConfig(true).hooks.mode, log, changed: nativeSrc !== "" });
  const files = writePluginFiles(process.execPath, repo);
  log(`pliki pluginu ${files.changed ? "zaktualizowane" : "bez zmian"}: ${files.hooks}, ${files.mcp}`);
  const touched = o.from
    ? git(repo, ["diff", "--name-only", o.from, "HEAD", "--", "plugin", ".claude-plugin"]).out.split("\n").filter(Boolean)
    : [];
  let ok = true;
  const mk = marketplaceDir();
  if (!mk || !samePath(mk, repo))
    log(`! plugin jest zarejestrowany z ${mk || "(brak)"}, nie z ${repo}: przepnij go komendą hipokamp install w tym katalogu`);
  else if (files.changed || touched.length || !pluginCacheCurrent(repo)) {
    log("pliki pluginu się zmieniły: odświeżam rejestrację w Claude Code (hooki, skille i MCP od nowych sesji)");
    const r = registerPlugin({ repo, dryRun: false, log, backupDir: backup(log) });
    if (!r.ok) log(`BŁĄD: ${r.error}`);
    ok = r.ok;
  }
  const w = await (o.restart ?? (() => restartWorker()))();
  log(w ? "worker działa na nowym kodzie" : "BŁĄD: worker nie wstał: hipokamp logs");
  if (!w) ok = false;
  await (
    o.doctor ??
    (async (l: Log) => {
      const { doctor } = await import("./doctor.ts");
      await doctor(l);
    })
  )(log);
  if (ok) markFinished(repo, git(repo, ["rev-parse", "HEAD"]).out.trim());
  return ok;
}
