// Skąd naprawdę działa plugin (T-31). Claude Code trzyma kopię pluginu w cache, ale jej hooks.json i .mcp.json mają
// absolutne ścieżki do repo, z którego zrobiono `hipokamp install`. Ten katalog musi być czystym checkoutem gałęzi
// live albo main: zmiana gałęzi, niedokończona edycja czy błąd składni w nim od razu zmienia pamięć wszystkich sesji.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeDir } from "../config.ts";

/** Repo, z którego działa ten kod (komenda `hipokamp` po `bun link` albo `bun src/cli.ts`). */
export const CODE_REPO = resolve(import.meta.dir, "..", "..");
export const PLUGIN_ID = "hipokamp@hipokamp";
/** Gałęzie, z których wolno uruchamiać plugin i które aktualizuje `hipokamp update`. */
export const LIVE_BRANCHES = ["live", "main"];

/** Ta sama ścieżka mimo ukośników, końcowego separatora i (na Windows) wielkości liter. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => {
    const r = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Katalog lokalnego marketplace `hipokamp` z known_marketplaces.json: null, gdy wpisu nie ma, "" gdy jest bez ścieżki. */
export function marketplaceDir(claude = claudeDir()): string | null {
  const e = readJson(join(claude, "plugins", "known_marketplaces.json"))?.hipokamp;
  if (!e) return null;
  return e.source?.path ?? e.installLocation ?? "";
}

/** Kopia pluginu w cache Claude Code (installed_plugins.json w wersji 2: lista wpisów na zakres; w wersji 1: obiekt). */
export function pluginInstallPath(claude = claudeDir()): string | null {
  const p = readJson(join(claude, "plugins", "installed_plugins.json"))?.plugins?.[PLUGIN_ID];
  const list: any[] = Array.isArray(p) ? p : p ? [p] : [];
  const e = list.find((x) => x?.scope === "user") ?? list[0];
  return typeof e?.installPath === "string" ? e.installPath : null;
}

/** Repo, z którego hooki uruchamiają kod: ścieżka przed `/src/hooks/hook.ts` w komendach hooks.json katalogu pluginu. */
export function hooksRepo(pluginDir: string): string | null {
  const doc = readJson(join(pluginDir, "hooks", "hooks.json"));
  for (const groups of Object.values<any>(doc?.hooks ?? {}))
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const m = typeof h?.command === "string" ? h.command.match(/"([^"]+?)[\\/]src[\\/]hooks[\\/]hook\.ts"/) : null;
        if (m) return m[1];
      }
  return null;
}

export interface PluginLocation {
  /** katalog marketplace `hipokamp` (known_marketplaces.json) */
  marketplace: string | null;
  /** kopia pluginu w cache Claude Code (installed_plugins.json) */
  installPath: string | null;
  /** repo, którego kod naprawdę uruchamiają hooki (z hooks.json w kopii pluginu) */
  hooksRepo: string | null;
}

export function pluginLocation(claude = claudeDir()): PluginLocation {
  const installPath = pluginInstallPath(claude);
  return { marketplace: marketplaceDir(claude), installPath, hooksRepo: installPath ? hooksRepo(installPath) : null };
}

// śmieci systemu plików, które nie są częścią pluginu
const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Pliki drzewa: ścieżka względna z „/” → skrót sha256, null dla pliku, którego nie da się przeczytać (np. zablokowany
 * przez inny proces na Windows). Bez śmieci systemu plików i bez wpisów z kropką na najwyższym poziomie poza
 * `.claude-plugin/` i `.mcp.json`: w kopii pluginu w cache to dane Claude Code (`.in_use/` działających sesji,
 * `.orphaned_at` po `plugin uninstall`), nie pliki pluginu.
 */
function treeHashes(dir: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const walk = (d: string, rel: string) => {
    let ents: Dirent[];
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (JUNK.has(e.name)) continue;
      if (!rel && e.name.startsWith(".") && e.name !== ".claude-plugin" && e.name !== ".mcp.json") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else if (e.isFile()) {
        let h: string | null = null;
        try {
          h = createHash("sha256")
            .update(readFileSync(join(d, e.name)))
            .digest("hex");
        } catch {}
        out.set(r, h);
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Różnice drzewa `dst` względem `src`: „inny”, „brak” (jest tylko w `src`), „zbędny” (jest tylko w `dst`) i
 * „nieczytelny” (po którejś stronie nie da się go przeczytać, więc nie wiadomo, czy jest taki sam).
 */
export function treeDiff(src: string, dst: string): string[] {
  const a = treeHashes(src);
  const b = treeHashes(dst);
  const diff: string[] = [];
  for (const [f, h] of a) {
    if (!b.has(f)) diff.push(`brak: ${f}`);
    else if (h === null || b.get(f) === null) diff.push(`nieczytelny: ${f}`);
    else if (b.get(f) !== h) diff.push(`inny: ${f}`);
  }
  for (const f of b.keys()) if (!a.has(f)) diff.push(`zbędny: ${f}`);
  return diff;
}

/** Krótki opis listy różnic do komunikatu: liczba i pierwsze pozycje. */
export function describeDiff(diff: string[], max = 5): string {
  return `${diff.length}: ${diff.slice(0, max).join(", ")}${diff.length > max ? ", …" : ""}`;
}

/**
 * Różnice między `<repo>/plugin` a kopią pluginu w cache Claude Code (treeDiff). Claude Code nie odświeża kopii tej
 * samej wersji (`marketplace update`, `plugin install` i `plugin update` zostawiają ją bez zmian), więc zmieniony
 * hook, skill czy manifest wymaga instalacji od nowa.
 * null: pluginu nie ma w installed_plugins.json albo jego kopii na dysku.
 */
export function pluginCacheDiff(repo: string, claude = claudeDir()): string[] | null {
  const ip = pluginInstallPath(claude);
  if (!ip || !existsSync(ip)) return null;
  return treeDiff(join(repo, "plugin"), ip);
}

/** Czy kopia pluginu w cache ma dokładnie to samo drzewo co `<repo>/plugin` (pliki generowane, skille, manifest). */
export function pluginCacheCurrent(repo: string, claude = claudeDir()): boolean {
  return pluginCacheDiff(repo, claude)?.length === 0;
}

/**
 * git bez powłoki i bez logu; `out` to stdout bez końcowych białych znaków (początkowe zostają: `status --porcelain`).
 * GIT_OPTIONAL_LOCKS=0: `status` nie odświeża indeksu, więc diagnoza niczego w checkoucie pluginu nie zapisuje.
 */
export function git(dir: string, args: string[], timeout = 15_000): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trimEnd(),
    err: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim(),
  };
}

export interface Checkout {
  git: boolean;
  /** korzeń checkoutu (git rev-parse --show-toplevel) */
  top: string;
  /** gałąź; "HEAD" przy odłączonym HEAD */
  branch: string;
  head: string;
  /** wiersze `git status --porcelain`: zmiany śledzone i pliki nieśledzone (bez ignorowanych) */
  dirty: string[];
  /** ile commitów origin/main jest przed HEAD według ostatniego fetch; null bez origin/main */
  behind: number | null;
}

export function gitCheckout(dir: string): Checkout {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return { git: false, top: dir, branch: "", head: "", dirty: [], behind: null };
  const t = top.out.trim();
  const behind = git(t, ["rev-list", "--count", "HEAD..origin/main"]);
  return {
    git: true,
    top: t,
    branch: git(t, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim(),
    head: git(t, ["rev-parse", "HEAD"]).out.trim(),
    dirty: git(t, ["status", "--porcelain"])
      .out.split("\n")
      .filter((l) => l.trim()),
    behind: behind.ok ? Number(behind.out.trim()) : null,
  };
}

/**
 * Linie diagnozy dla `hipokamp doctor`: z którego katalogu działa plugin i czy to czysty checkout live/main.
 * Ostrzeżenia zaczynają się od „!”, wynik dobry od „✓”.
 */
export function liveCheck(o: { codeRepo?: string; claude?: string } = {}): string[] {
  const codeRepo = o.codeRepo ?? CODE_REPO;
  const loc = pluginLocation(o.claude ?? claudeDir());
  const run = loc.hooksRepo ?? (loc.marketplace || null);
  if (!run)
    return [`! nie wiem, z którego katalogu działa plugin (brak ${PLUGIN_ID} w installed_plugins.json): hipokamp install`];
  const out: string[] = [];
  if (loc.marketplace && loc.hooksRepo && !samePath(loc.marketplace, loc.hooksRepo))
    out.push(
      `! marketplace hipokamp wskazuje ${loc.marketplace}, a hooki kopii pluginu ${loc.hooksRepo}: hipokamp install w katalogu, z którego plugin ma działać`,
    );
  // sesje dostają hooki, skille i MCP z kopii w cache, nie z repo: kopia inna niż `plugin/` to inna pamięć niż w kodzie
  if (loc.marketplace && loc.installPath) {
    const diff = pluginCacheDiff(loc.marketplace, o.claude ?? claudeDir());
    const plugin = join(loc.marketplace, "plugin");
    if (diff === null) out.push(`! kopii pluginu nie ma na dysku (${loc.installPath}): hipokamp install w ${loc.marketplace}`);
    else if (diff.length)
      out.push(
        `! kopia pluginu w cache Claude Code (${loc.installPath}) różni się od ${plugin} (${describeDiff(diff)}): sesje mają inne hooki, skille albo MCP niż repo; hipokamp install w ${loc.marketplace}`,
      );
    else out.push(`✓ kopia pluginu w cache zgodna z ${plugin}`);
  }
  const g = gitCheckout(run);
  if (!g.git) out.push(`! plugin działa z ${run}, który nie jest checkoutem git (bez historii i bez powrotu)`);
  else {
    const where = `${run} (${g.branch === "HEAD" ? "odłączony HEAD" : `gałąź ${g.branch}`}, ${g.head.slice(0, 8)})`;
    if (!LIVE_BRANCHES.includes(g.branch))
      out.push(
        `! plugin działa z ${where}: to nie live ani main, więc zmiana gałęzi albo niedokończona edycja od razu zmienia pamięć wszystkich sesji. Przepnij na worktree live (docs/MIGRACJA.md, „Worktree live”)`,
      );
    else if (g.dirty.length)
      out.push(
        `! plugin działa z ${where} z niezacommitowanymi zmianami (${g.dirty.length}, np. ${g.dirty[0].trim()}): każda edycja tu od razu zmienia pamięć wszystkich sesji`,
      );
    else
      out.push(
        `✓ plugin działa z czystego checkoutu ${where}${g.branch === "main" ? "; zalecany osobny worktree live (docs/MIGRACJA.md)" : ""}`,
      );
    if (g.behind) out.push(`! ${g.behind} commitów za origin/main (stan z ostatniego fetch): hipokamp update`);
  }
  if (!samePath(codeRepo, run))
    out.push(`! komenda hipokamp działa z ${codeRepo}, a plugin z ${run}: bun link w katalogu pluginu`);
  return out;
}
