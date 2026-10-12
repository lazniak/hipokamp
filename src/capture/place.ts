// Projekt tury i katalog, od którego liczą się klucze jej plików (T-23). Ta sama reguła przy zapisie (ingest, naprawa)
// i przy odczycie (hooki: przypominanie przy pliku, przeterminowanie), żeby klucz zapisany i szukany był ten sam.
import { dirname, resolve } from "node:path";
import type { Repo } from "../db/repo.ts";
import { gitRoot, isProjectRoot, isSubdir, markerRoot, projectManifest, samePath } from "../util/paths.ts";
import type { Turn } from "./transcript.ts";

export interface TurnPlace {
  project: string;
  /** Katalog, od którego liczą się klucze plików (null: brak cwd). */
  keyCwd: string | null;
}

export interface PlaceOpts {
  /** Werdykt katalogu startowego zapisany w `sessions.meta.rootProject` (hooki nie skanują go od nowa). */
  rootIsProject?: boolean | null;
  /** Twardy limit czasu skanowania podkatalogów (ms z performance.now()); po nim katalog nie jest bazą. */
  deadline?: number;
  /** Tylko katalog kluczy (odczyt w hooku): bez liczenia projektu katalogu bazowego. */
  keysOnly?: boolean;
}

/** Limit czasu sprawdzania katalogów w hooku (prompt, użycie pliku, start sesji). */
export const HOOK_SCAN_MS = 20;

/**
 * Projekt tury w katalogu `cwd` sesji zaczętej w `root`. Zwykle z katalogu tury. Podkatalog bez własnej tożsamości
 * (repo, znacznik, jawny alias, manifest) należy do najbliższego projektu nad nim, ale nie wyżej niż katalog startowy:
 * monorepo (workspace) nad nim, katalog z manifestem pomiędzy (`cd Kompas/src` w sesji zaczętej w D:\code) albo sam
 * katalog startowy, jeśli ten jest projektem, a nie kontenerem projektów (isProjectRoot). Klucze plików liczą się
 * wtedy od tego katalogu: reguła z cwd dałaby podkatalogowi własny projekt, a temu samemu plikowi dwa klucze
 * (`skrypty/deploy.sh` i `deploy.sh`). Katalog startowy, nie `sessions.cwd`: tamten nadpisuje każdy SessionStart.
 */
export function turnPlace(
  repo: Repo,
  excluded: string[],
  root: string | null | undefined,
  cwd: string | null | undefined,
  fallback: string,
  opts: PlaceOpts = {},
): TurnPlace {
  if (!cwd) return { project: fallback, keyCwd: null };
  const own = repo.resolveProject(cwd);
  const base = baseDir(repo, excluded, own, cwd, root, opts);
  if (!base) return { project: own, keyCwd: cwd };
  return { project: opts.keysOnly ? own : repo.resolveProject(base), keyCwd: base };
}

/** sessions.meta sesji: katalog startowy i jego werdykt (zapisuje ingest). */
export function sessionRoot(repo: Repo, sessionId: string | null | undefined): { root?: string | null; rootProject?: boolean } {
  try {
    const meta = JSON.parse((sessionId && repo.getSession(sessionId)?.meta) || "{}");
    return {
      root: typeof meta?.root === "string" || meta?.root === null ? meta.root : undefined,
      rootProject: typeof meta?.rootProject === "boolean" ? meta.rootProject : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Katalog, od którego odczyt (hooki) liczy klucze plików w `cwd`: ta sama reguła co przy zapisie, z katalogiem
 * startowym i jego werdyktem z `sessions.meta` (bez skanowania), a przed pierwszym zapisem z `CLAUDE_PROJECT_DIR`
 * i skanem z limitem czasu HOOK_SCAN_MS.
 */
export function keyBase(
  repo: Repo,
  excluded: string[],
  sessionId: string | null | undefined,
  cwd: string | null,
  projectDir: string | null | undefined,
): string | null {
  if (!cwd) return cwd;
  const m = sessionRoot(repo, sessionId);
  const root = typeof m.root === "string" ? m.root : projectDir?.trim() || null;
  const rootIsProject = typeof m.root === "string" ? m.rootProject : undefined;
  const deadline = performance.now() + HOOK_SCAN_MS;
  return turnPlace(repo, excluded, root, cwd, "", { rootIsProject, deadline, keysOnly: true }).keyCwd;
}

/**
 * Werdykt katalogu startowego zapisany już przy starcie sesji (hook SessionStart), żeby hooki pierwszej tury, przed
 * pierwszym zapisem, też go tylko czytały. Raz na sesję (nie nadpisuje zapisanego), z limitem czasu `ms`; po nim
 * werdykt policzy ingest.
 */
export function rememberRoot(repo: Repo, sessionId: string, root: string | null | undefined, ms: number): void {
  if (!sessionId || !root || sessionRoot(repo, sessionId).root !== undefined) return;
  const v = isProjectRoot(root, performance.now() + ms);
  if (v !== null) repo.setSessionRoot(sessionId, root, v);
}

/**
 * Tury z katalogiem bazowym zamiast cwd (dla naprawy: projekt i klucze plików liczone z `cwd` tury dają wtedy to
 * samo co ingest). Katalog startowy z `sessions.meta.root`, a dla sesji czytanych przed jego zapisem z pierwszej tury.
 */
export function placedTurns(repo: Repo, excluded: string[], sessionId: string, turns: Turn[]): Turn[] {
  const m = sessionRoot(repo, sessionId);
  const root = typeof m.root === "string" ? m.root : (turns[0]?.cwd ?? null);
  const opts = { rootIsProject: typeof m.root === "string" ? m.rootProject : undefined };
  return turns.map((t) => {
    const keyCwd = turnPlace(repo, excluded, root, t.cwd, "", opts).keyCwd;
    return keyCwd === t.cwd ? t : { ...t, cwd: keyCwd };
  });
}

/** Katalog bazowy tury w podkatalogu (zob. turnPlace) albo null, gdy tura zostaje przy swoim katalogu. */
function baseDir(
  repo: Repo,
  excluded: string[],
  own: string,
  cwd: string,
  root: string | null | undefined,
  opts: PlaceOpts,
): string | null {
  if (!root || !isSubdir(cwd, root) || gitRoot(cwd)) return null;
  // prywatność: podkatalog o kluczu wykluczonym zostaje wykluczony
  if (excluded.some((p) => p.toLowerCase() === own.toLowerCase())) return null;
  const marker = markerRoot(cwd);
  if (marker && isSubdir(marker, root)) return null;
  // jawny alias (np. z importu claude-mem) to własna tożsamość; alias reguły nie
  const source = repo.projectAliasSource(cwd);
  if (source && !source.startsWith("rule")) return null;
  // monorepo bez gita (workspace) nad cwd, do katalogu startowego włącznie: jeden projekt, pakiety bez tożsamości
  const chain: string[] = [];
  for (let d = resolve(cwd); isSubdir(d, root); d = dirname(d)) chain.push(d);
  for (const d of [...chain, resolve(root)]) if (projectManifest(d) === "workspace") return samePath(d, cwd) ? null : d;
  // najbliższy katalog z manifestem między cwd a katalogiem startowym: granica tożsamości, wyżej nie idziemy.
  // Bazą zostaje tylko projekt, nie kontener projektów z samym `.claude/` (np. D:\code w sesji zaczętej w D:\)
  for (const d of chain) {
    if (projectManifest(d)) return !samePath(d, cwd) && isProjectRoot(d, opts.deadline) === true ? d : null;
  }
  const rootIsProject = opts.rootIsProject ?? isProjectRoot(root, opts.deadline);
  return rootIsProject === true ? root : null;
}
