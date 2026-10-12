// Ścieżki i projekty: normalizacja ścieżek Windows/POSIX, korzeń repozytorium, klucz projektu.
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

/** Klucz dla pustego katalogu i korzenia POSIX (jak w claude-mem). */
export const UNKNOWN_PROJECT = "unknown-project";
/** Wersja reguły projectFromCwd: zmiana unieważnia wyliczone wcześniej aliasy (project_aliases.source = "rule:N"). */
export const PROJECT_RULE = "rule:2";
// znaczniki projektu poza repozytorium, jak w claude-mem (katalog ze znacznikiem = korzeń projektu)
const MARKERS = [".claude-mem-project", ".claude-mem.json"];

/**
 * Ścieżka w stylu Windows (litera dysku albo UNC `\\serwer\…`), niezależnie od systemu, na którym działa hipokamp:
 * transkrypt albo hook mógł powstać na innym systemie (Windows i WSL).
 */
export function isWinPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
}

/**
 * Ścieżka `p` względem katalogu `base` według stylu `base` (Windows albo POSIX), a nie systemu hipokampa: `resolve()`
 * dokleiłby `D:\code\x` do katalogu procesu na Linuksie, a dla `/home/x` wymyśliłby literę dysku na Windows.
 * Ścieżka już bezwzględna (dowolnego stylu) zostaje bez zmian; baza bez znanego stylu (pusta, względna): `resolve()`.
 */
export function resolveIn(base: string | null | undefined, p: string): string {
  const t = p.trim();
  const b = base?.trim();
  if (!b || isWinPath(t) || t.startsWith("/")) return t;
  if (isWinPath(b)) return win32.resolve(b, t);
  return b.startsWith("/") ? posix.resolve(b, t) : resolve(b, t);
}

/**
 * System, według którego liczymy ścieżki: zwykle ten, na którym działa hipokamp. HIPOKAMP_PATH_PLATFORM (win32,
 * darwin, linux) wymusza inny, żeby testy sprawdziły zachowanie każdego systemu na jednej maszynie; funkcje niżej
 * przyjmują go też parametrem.
 */
export function pathPlatform(): NodeJS.Platform {
  const f = process.env.HIPOKAMP_PATH_PLATFORM;
  return f === "win32" || f === "darwin" || f === "linux" ? f : process.platform;
}

/**
 * Ukośniki do przodu, mała litera dysku, bez końcowego ukośnika. Na Windows także ścieżka Git Bash z jednoliterowym
 * katalogiem (/d/code → d:/code); na Linuksie i macOS /d/code to zwykły katalog i zostaje.
 */
export function normPath(p: string, plat: NodeJS.Platform = pathPlatform()): string {
  let s = p.trim().replace(/\\/g, "/");
  s = s.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  if (plat === "win32") s = s.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toLowerCase()}:/`);
  if (s.length > 3) s = s.replace(/\/+$/, "");
  return s;
}

/**
 * Klucz do porównań ścieżek: normPath, a wielkość liter bez znaczenia tam, gdzie system plików jej nie rozróżnia
 * (Windows i domyślnie macOS), oraz w ścieżce Windows z innej maszyny (litera dysku, UNC). Na Linuksie /home/Jan
 * i /home/jan to dwa różne katalogi.
 */
export function pathKey(p: string, plat: NodeJS.Platform = pathPlatform()): string {
  const n = normPath(p, plat);
  return plat === "win32" || plat === "darwin" || /^[a-z]:(\/|$)/.test(n) || n.startsWith("//") ? n.toLowerCase() : n;
}

/**
 * Ścieżka bezwzględna według systemu `plat` (na tym samym systemie: resolve()). Ścieżkę Windows poza Windows liczymy
 * po windowsowemu, zamiast doklejać ją do katalogu procesu.
 */
function absFor(p: string, plat: NodeJS.Platform): string {
  if (plat === "win32" ? process.platform === "win32" : process.platform !== "win32" && !isWinPath(p)) return resolve(p);
  return (plat === "win32" || isWinPath(p) ? win32 : posix).resolve(p);
}

/** Ta sama ścieżka po normalizacji (wielkość liter jak w pathKey). */
export function samePath(
  a: string | null | undefined,
  b: string | null | undefined,
  plat: NodeJS.Platform = pathPlatform(),
): boolean {
  return !!a && !!b && pathKey(absFor(a, plat), plat) === pathKey(absFor(b, plat), plat);
}

/** Czy `dir` leży wewnątrz katalogu `base` (podkatalog na dowolnej głębokości, nie sam `base`). */
export function isSubdir(dir: string, base: string, plat: NodeJS.Platform = pathPlatform()): boolean {
  const d = pathKey(absFor(dir, plat), plat);
  const b = pathKey(absFor(base, plat), plat);
  return d.startsWith(b.endsWith("/") ? b : `${b}/`) && d.length > b.length;
}

export function basenameOf(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1);
}

/**
 * Katalog Windows na systemie innym niż Windows (dane z innej maszyny): nie ma jak go sprawdzić, a `resolve()` dokleiłby
 * go do katalogu procesu i `gitRoot` znalazłby jego repo (zły projekt, zapisany potem w aliasach).
 */
const foreignWin = (p: string): boolean => pathPlatform() !== "win32" && isWinPath(p.trim());

const rootCache = new Map<string, { root: string; mainRoot: string } | null>();

/**
 * Korzeń repozytorium git dla katalogu (z obsługą worktree: `.git` jako plik → wspólny korzeń repo).
 * Zwraca null, gdy katalog nie jest w repo.
 */
export function gitRoot(cwd: string): { root: string; mainRoot: string } | null {
  if (foreignWin(cwd)) return null;
  const key = normPath(cwd);
  if (rootCache.has(key)) return rootCache.get(key)!;
  let dir = resolve(cwd);
  let found: { root: string; mainRoot: string } | null = null;
  for (let i = 0; i < 40; i++) {
    const g = join(dir, ".git");
    if (existsSync(g)) {
      try {
        if (statSync(g).isDirectory()) found = { root: dir, mainRoot: dir };
        else {
          // worktree: "gitdir: D:/code/repo/.git/worktrees/nazwa"
          const m = readFileSync(g, "utf8").match(/gitdir:\s*(.+)/);
          const gitdir = m ? resolve(dir, m[1].trim()) : "";
          const wt = gitdir.replace(/\\/g, "/").match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
          found = { root: dir, mainRoot: wt ? wt[1] : dir };
        }
      } catch {
        found = { root: dir, mainRoot: dir };
      }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  rootCache.set(key, found);
  return found;
}

/** Nazwa katalogu jako klucz: korzeń dysku Windows daje drive-C, korzeń POSIX unknown-project. */
function dirKey(dir: string): string {
  const base = (isWinPath(dir) ? win32 : posix).basename(dir);
  if (base) return base;
  const drive = dir.match(/^([A-Za-z]):[\\/]*$/);
  return drive ? `drive-${drive[1].toUpperCase()}` : UNKNOWN_PROJECT;
}

const claudeConfigDir = () => pathKey(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
const stopDirs = () => new Set([pathKey(homedir()), pathKey(tmpdir()), claudeConfigDir()]);

/**
 * Katalog, który nie bywa korzeniem projektu: domowy, tymczasowy, konfiguracji Claude albo korzeń dysku (te same
 * wyjątki co przy szukaniu znacznika projektu).
 */
export function isGenericDir(dir: string): boolean {
  const d = resolve(dir);
  return dirname(d) === d || stopDirs().has(pathKey(d));
}

// pliki, po których katalog poza repo rozpoznajemy jako projekt (manifest narzędzi albo instrukcje dla Claude)
const MANIFESTS = new Set([
  "package.json",
  "deno.json",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "cargo.toml",
  "composer.json",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "claude.md",
]);
const MANIFEST_EXT = [".sln", ".csproj"];
// monorepo bez gita: katalog z tymi plikami (albo z `workspaces` w package.json, `[workspace]` w Cargo.toml) to jeden
// projekt, a jego pakiety nie mają własnej tożsamości
const WORKSPACE_FILES = new Set(["pnpm-workspace.yaml", "go.work", "lerna.json"]);
// tożsamość podkatalogu przy wykrywaniu kontenera: stałe nazwy sprawdzane przez existsSync, bez listowania dzieci
const CHILD_SIGNS = [".git", ...MARKERS, "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "CLAUDE.md", ".claude"];
// ilu podkatalogów najwyżej szukamy podprojektów: pierwszych według nazwy (kolejność listingu zależy od systemu plików:
// NTFS alfabetycznie, ext4 według skrótu nazwy), więc wynik jest ten sam na każdym systemie
const CHILD_SCAN = 64;
/** Porządek nazw niezależny od systemu i ustawień regionalnych: porównanie kodów znaków. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const DIR_TTL = 60_000;
type ManifestKind = "workspace" | "manifest" | "claude" | null;
const manifestCache = new Map<string, { at: number; v: ManifestKind }>();

function cached<T>(m: Map<string, { at: number; v: T }>, dir: string, f: () => T): T {
  const key = pathKey(resolve(dir));
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < DIR_TTL) return hit.v;
  const v = f();
  if (m.size > 2000) m.clear();
  m.set(key, { at: Date.now(), v });
  return v;
}

function readSmall(path: string): string {
  try {
    return statSync(path).size < 512 * 1024 ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * Czy katalog wygląda na projekt: "workspace" (monorepo: pnpm-workspace.yaml, go.work, lerna.json, `workspaces`
 * w package.json, `[workspace]` w Cargo.toml), "manifest" (package.json, pyproject.toml, go.mod, Cargo.toml, *.sln,
 * CLAUDE.md…), "claude" (sam katalog `.claude/`, który Claude Code zakłada w każdym katalogu startu z zapisanymi
 * zgodami), null. Jeden listing katalogu.
 */
export function projectManifest(dir: string): ManifestKind {
  return cached(manifestCache, dir, () => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    let kind: ManifestKind = null;
    for (const n of names) {
      const l = n.toLowerCase();
      if (WORKSPACE_FILES.has(l)) return "workspace";
      if (l === "package.json" && /"workspaces"\s*:/.test(readSmall(join(dir, n)))) return "workspace";
      if (l === "cargo.toml" && /^\s*\[workspace\]/m.test(readSmall(join(dir, n)))) return "workspace";
      if (MANIFESTS.has(l) || MANIFEST_EXT.some((e) => l.endsWith(e))) kind = "manifest";
      else if (l === ".claude" && !kind) kind = "claude";
    }
    return kind;
  });
}

/**
 * Ile podkatalogów (do `limit`) ma własną tożsamość projektu (repo, znacznik, manifest): pierwsze CHILD_SCAN dzieci
 * według nazwy (byName, nie kolejność listingu), każde przez existsSync stałych nazw (także junction i symlink).
 * null: skończył się czas (`deadline`, ms z performance.now()), wynik nieznany.
 */
export function childProjects(dir: string, limit: number, deadline = Number.POSITIVE_INFINITY): number | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const names = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .sort(byName)
    .slice(0, CHILD_SCAN);
  let found = 0;
  for (const name of names) {
    if (performance.now() > deadline) return null;
    const c = join(dir, name);
    if (CHILD_SIGNS.some((s) => existsSync(join(c, s))) && ++found >= limit) break;
  }
  return found;
}

/**
 * Czy katalog startowy sesji jest projektem, do którego należą jego podkatalogi bez własnej tożsamości (T-23).
 * Tak: monorepo (workspace). Nie: katalog domowy, tymczasowy, konfiguracji Claude, korzeń dysku, katalog bez
 * manifestu i kontener projektów (np. D:\code): z samym `.claude/` taki, w którym jest choć jeden podprojekt,
 * z manifestem od 3 podprojektów. null: skończył się czas (`deadline`).
 */
export function isProjectRoot(dir: string, deadline?: number): boolean | null {
  if (isGenericDir(dir)) return false;
  const m = projectManifest(dir);
  if (!m) return false;
  if (m === "workspace") return true;
  const c = isProjectContainer(dir, deadline);
  return c === null ? null : !c;
}

/** Katalog systemu Windows albo wnętrze konfiguracji Claude: nigdy projekt (np. klucz `System32` z importu). */
function isSystemDir(dir: string): boolean {
  const n = pathKey(resolve(dir));
  const win = pathKey(process.env.SystemRoot || process.env.windir || "C:\\Windows");
  const claude = claudeConfigDir();
  return n === win || n.startsWith(`${win}/`) || n.startsWith(`${claude}/`);
}

/**
 * Kontener projektów, a nie projekt: katalog ogólny (isGenericDir), katalog systemu Windows, wnętrze konfiguracji
 * Claude albo katalog z podprojektami (repo, znacznik, manifest): z samym `.claude/` od 1, poza tym od 3 (np.
 * D:\code). Monorepo (workspace) nie jest kontenerem. Ta sama reguła dla katalogu startowego sesji (isProjectRoot,
 * place.ts) i dla korzeni kluczy plików w naprawie (core/filekeys.ts). null: skończył się czas (`deadline`).
 */
export function isProjectContainer(dir: string, deadline?: number): boolean | null {
  if (isGenericDir(dir) || isSystemDir(dir)) return true;
  const m = projectManifest(dir);
  if (m === "workspace") return false;
  const limit = m === "claude" ? 1 : 3;
  const n = childProjects(dir, limit, deadline);
  return n === null ? null : n >= limit;
}

/**
 * Najbliższy przodek ze znacznikiem projektu (tylko poza repo). Jak w claude-mem: do 64 poziomów, bez sprawdzania
 * katalogu domowego, tymczasowego, konfiguracji Claude i korzenia; wewnątrz konfiguracji Claude znaczniki nie działają.
 */
export function markerRoot(dir: string): string | null {
  const claude = claudeConfigDir();
  const n = pathKey(dir);
  if (n === claude || n.startsWith(`${claude}/`)) return null;
  const stops = stopDirs();
  let d = dir;
  for (let i = 0; i < 64; i++) {
    const up = dirname(d);
    if (up === d || stops.has(pathKey(d))) return null;
    if (MARKERS.some((m) => existsSync(join(d, m)))) return d;
    d = up;
  }
  return null;
}

/**
 * Nazwa projektu dla cwd, zgodna z kluczami claude-mem (tryb ścieżkowy): nazwa korzenia repo, poza repo katalog
 * ze znacznikiem albo sam katalog. Różnica zamierzona: worktree dostaje klucz repo (claude-mem: repo/worktree),
 * bo w hipokampie worktree dzieli pamięć z repo.
 */
export function projectFromCwd(cwd: string | null | undefined): string {
  if (!cwd?.trim()) return UNKNOWN_PROJECT;
  const raw = cwd.trim();
  if (foreignWin(raw)) return dirKey(raw);
  const dir = resolve(raw === "~" || /^~[\\/]/.test(raw) ? join(homedir(), raw.slice(1)) : raw);
  const g = gitRoot(dir);
  if (g) return dirKey(g.mainRoot);
  return dirKey(markerRoot(dir) ?? dir);
}

/** Klucz pliku: względny do korzenia projektu, jeśli plik jest w środku; inaczej znormalizowany absolutny. */
export function fileKey(file: string, cwd: string | null | undefined): string {
  const f = normPath(file);
  if (!cwd) return f;
  const g = gitRoot(cwd);
  const roots = g ? [g.root, g.mainRoot] : [cwd];
  const fk = pathKey(file);
  for (const r of roots) {
    const nr = `${pathKey(r)}/`;
    if (fk.startsWith(nr)) return f.slice(nr.length);
  }
  return f;
}

/** Rozwiązuje klucz pliku z powrotem do ścieżki absolutnej (dla sprawdzania przeterminowania). */
export function absFromKey(key: string, cwd: string | null | undefined): string {
  if (/^[a-z]:\//i.test(key) || key.startsWith("/")) return key;
  const g = cwd ? gitRoot(cwd) : null;
  return normPath(join(g ? g.root : (cwd ?? "."), key));
}
