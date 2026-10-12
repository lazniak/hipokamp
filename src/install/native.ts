// Natywny hook w `hipokamp install` i `hipokamp update` (T-22, T-31): budowa przez scripts/build-native.* (vet, testy,
// build, test dymny z wersją, podmiana działającego pliku), gdy hooks.mode go chce (auto, native), a plik nie
// przechodzi testu dymnego (brak, stara wersja) albo zmieniły się jego źródła. W worktree live nikt nie buduje ręcznie
// (docs/MIGRACJA.md), więc robią to te dwie komendy. Nic tu nie przerywa instalacji: bez Go albo po nieudanej budowie
// tryb spada do command (hooksModeFor po teście dymnym), a hooki działają dalej przez Buna.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HooksMode } from "../config.ts";
import { hookTsOf, nativeHookPath, nativeSmoke } from "../hooks/modes.ts";

type Log = (m: string) => void;

/** Skrypt budowy dla tej platformy i program, który go uruchomi; null, gdy nie ma czym. */
export function nativeBuildCommand(repo: string): string[] | null {
  if (process.platform === "win32") {
    const ps = Bun.which("pwsh") ?? Bun.which("powershell");
    return ps
      ? [ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "build-native.ps1")]
      : null;
  }
  const bash = Bun.which("bash");
  return bash ? [bash, join(repo, "scripts", "build-native.sh")] : null;
}

// w worktree live nie budujemy ręcznie: podpowiedź to zawsze komenda hipokampa, która zbuduje sama
const NEED_GO = "zainstaluj Go (https://go.dev/dl/) i powtórz hipokamp install";

/**
 * Buduje natywny hook w `repo`, gdy tryb go chce, a plik nie przechodzi testu dymnego albo `changed` (zmienione źródła
 * w native/hook/ albo NATIVE_VERSION od ostatniej wersji). Zwraca, czy plik po wszystkim przechodzi test dymny.
 * `go`: ścieżka do Go (testy podstawiają null, żeby sprawdzić drogę bez Go).
 */
export function ensureNative(o: {
  repo: string;
  mode: HooksMode;
  log: Log;
  dryRun?: boolean;
  changed?: boolean;
  go?: string | null;
}): boolean {
  const { repo, log } = o;
  if (o.mode !== "auto" && o.mode !== "native") return false;
  const exe = nativeHookPath(repo);
  const smoke = () => nativeSmoke(exe, hookTsOf(repo));
  const before = smoke();
  if (before.ok && !o.changed) return true;
  const why = before.ok ? "źródła natywnego hooka się zmieniły" : before.reason;
  const go = o.go === undefined ? Bun.which("go") : o.go;
  const script = nativeBuildCommand(repo);
  if (!existsSync(join(repo, "native", "hook", "main.go")) || !script || !existsSync(script[script.length - 1])) {
    if (o.mode === "native") log(`! natywny hook: ${why}, a w ${repo} nie ma źródeł albo skryptu budowy; hooki przez Buna`);
    return before.ok;
  }
  if (!go) {
    // auto bez Go to zwykła sytuacja (Go jest opcjonalne): bez alarmu, chyba że stary plik zostaje ze starymi źródłami
    if (before.ok) log(`! natywny hook: ${why}, a nie ma Go, więc zostaje stary plik (${before.reason}); ${NEED_GO}`);
    else
      log(
        `${o.mode === "native" ? "! " : ""}natywny hook: ${why}; nie ma Go, więc hooki idą przez Buna (opcjonalnie: ${NEED_GO})`,
      );
    return before.ok;
  }
  if (o.dryRun) {
    log(`(dry-run) natywny hook: ${why}; zbudowałbym: ${script.join(" ")}`);
    return before.ok;
  }
  log(`natywny hook: ${why}; buduję (${script.join(" ")})`);
  const r = spawnSync(script[0], script.slice(1), { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim();
  const after = smoke();
  if (r.status === 0 && after.ok) {
    log(`natywny hook zbudowany: ${exe} (${after.reason})`);
    return true;
  }
  log(
    `! budowa natywnego hooka nie wyszła (kod ${r.status ?? "?"}): ${out.split("\n").slice(-4).join(" | ").slice(0, 400)}. ${after.ok ? "Zostaje poprzedni plik" : "Hooki idą przez Buna"}; po naprawie: hipokamp install`,
  );
  return after.ok;
}
