// Klucze plików względem katalogu repo. Import claude-mem zostawiał część ścieżek absolutnych (sesja bez katalogu,
// plik w worktree, którego już nie ma), a pliki worktree aplikacji desktop bywały zapisane z prefiksem
// `.claude/worktrees/<nazwa>/` względem repo głównego. Takie klucze nie łączą się z encjami plików repo, więc ani
// przypominanie przy pliku, ani graf ich nie widzą. Normalizacja: klucz absolutny wewnątrz katalogu projektu staje się
// względny (jak fileKey przy zapisie tury), a prefiks worktree znika (worktree dzieli pamięć z repo). Pliki spoza
// projektu zostają absolutne.
// Korzenie projektu: katalogi jego sesji i aliasów (w repo git korzeń worktree i repo głównego), a dla pojedynczego
// pliku repo, w którym leży, o ile to repo tego projektu, albo worktree w katalogu `<projekt>.wt/<nazwa>` obok repo
// (też gdy go już nie ma). Katalog sesji, którego już nie ma, liczy się tylko wtedy, gdy repo nad nim należy do
// projektu albo sam wygląda na katalog projektu lub worktree (nazwa jak projekt, rodzic `worktrees`, rodzic
// `<projekt>.wt` albo `<projekt>-wt`). Kontener projektów (domowy, tymczasowy, `D:/code` z wieloma repo, `System32`)
// nigdy nie jest korzeniem: ta sama reguła co dla katalogu startowego sesji (isProjectContainer w util/paths.ts).
// Inaczej sesja otwarta w `D:/code` (klucz `code`) zrobiłaby z `D:/code/tool-x/README.md` klucz `tool-x/README.md`,
// którego późniejsze ręczne `project merge code tool-x` już by nie poprawiło.
// Używane przy imporcie claude-mem, w `hipokamp project merge` i w kroku e) `hipokamp repair`. SQL poza repo.ts: odczyty
// potrzebne tylko tutaj.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { clean } from "../capture/redact.ts";
import { getMeta } from "../db/db.ts";
import { mapMergedProject, PROJECT_MERGES_KEY, parseProjectMerges, type Repo } from "../db/repo.ts";
import { basenameOf, gitRoot, isGenericDir, isProjectContainer, normPath, projectFromCwd } from "../util/paths.ts";

const RE_ABS = /^(?:[a-z]:\/|\/)/i;
const RE_WORKTREE = /^\.claude\/worktrees\/[^/]+\/(.+)$/i;

/** Korzeń kluczy plików: repo poza katalogiem ogólnym, a poza repo katalog, który nie jest kontenerem projektów. */
const keyRoot = (dir: string, inRepo: boolean): boolean => (inRepo ? !isGenericDir(dir) : isProjectContainer(dir) === false);

/** Klucz, który normalizacja może zmienić (absolutny albo z prefiksem worktree). */
export const fileKeyCandidate = (key: string): boolean => RE_ABS.test(key) || RE_WORKTREE.test(key);

const low = (s: string) => s.toLowerCase();
const normDir = (p: string) => low(normPath(p));

export interface FileKeyNormalizer {
  /**
   * Klucz pliku względem katalogu projektu (pierwszy z `projects`; pozostałe to klucze, które do niego trafiają, np.
   * źródła scalenia). Bez zmiany, gdy plik leży poza projektem albo nie da się ustalić korzenia.
   */
  norm(key: string, projects: string | string[]): string;
}

export function fileKeyNormalizer(db: Database): FileKeyNormalizer {
  const merges = parseProjectMerges(getMeta(db, PROJECT_MERGES_KEY));
  const alias = db.query("SELECT project FROM project_aliases WHERE cwd = ?");
  const dirsOf = db.query(
    `SELECT DISTINCT cwd FROM sessions WHERE project = ?1 COLLATE NOCASE AND cwd IS NOT NULL AND cwd != ''
     UNION SELECT cwd FROM project_aliases WHERE project = ?1 COLLATE NOCASE`,
  );
  const dirProject = new Map<string, string>();
  /** Projekt katalogu (małymi literami): alias, a bez niego reguła, w obu przypadkach po scaleniach. */
  const projectOfDir = (dir: string): string => {
    const k = normDir(dir);
    let p = dirProject.get(k);
    if (p === undefined) {
      const a = alias.get(k) as { project: string } | null;
      p = low(mapMergedProject(merges, a?.project ?? projectFromCwd(dir)));
      dirProject.set(k, p);
    }
    return p;
  };
  /** Katalog, którego już nie ma, a który wygląda na katalog projektu albo jego worktree. */
  const projectLike = (dir: string, p: string): boolean => {
    const base = low(basenameOf(dir));
    const parent = low(basenameOf(dirname(dir)));
    return base === p || parent === "worktrees" || (parent.startsWith(p) && /^[.\-_]/.test(parent.slice(p.length)));
  };
  const roots = new Map<string, string[]>();
  const rootsOf = (p: string): string[] => {
    let out = roots.get(p);
    if (out) return out;
    const set = new Set<string>();
    const addRepo = (g: { root: string; mainRoot: string }) => {
      for (const r of [g.root, g.mainRoot]) if (keyRoot(r, true)) set.add(normDir(r));
    };
    for (const { cwd } of dirsOf.all(p) as { cwd: string }[]) {
      const g = gitRoot(cwd);
      if (existsSync(cwd)) {
        // jak fileKey przy zapisie tury: korzeń worktree i repo głównego, a poza repo sam katalog (nie zbiorczy)
        if (g) addRepo(g);
        else if (keyRoot(cwd, false)) set.add(normDir(cwd));
      } else if (g && projectOfDir(g.mainRoot) === p) addRepo(g);
      else if (!g && projectLike(cwd, p) && keyRoot(cwd, false)) set.add(normDir(cwd));
    }
    out = [...set];
    roots.set(p, out);
    return out;
  };
  /** Repo, w którym leży plik, jeśli należy do jednego z projektów (korzeń najgłębszy: worktree, jeśli jest). */
  const fileRoot = (path: string, ps: string[]): string | null => {
    // ścieżka POSIX na Windows rozwiązałaby się względem bieżącego dysku
    if (process.platform === "win32" && path.startsWith("/")) return null;
    const g = gitRoot(dirname(path));
    return g && ps.includes(projectOfDir(g.mainRoot)) && keyRoot(g.root, true) ? normDir(g.root) : null;
  };
  return {
    norm(key, projects) {
      const ps = (Array.isArray(projects) ? projects : [projects]).filter(Boolean).map(low);
      /** Ścieżka absolutna względem korzenia projektu; null, gdy plik leży poza projektem albo korzenia nie ma. */
      const relative = (abs: string): string | null => {
        const n = normPath(abs);
        const l = low(n);
        // wielkie litery spoza ASCII potrafią zmienić długość napisu: wtedy bez zmiany
        if (l.length !== n.length) return null;
        let best = "";
        for (const p of ps) for (const r of rootsOf(p)) if (r.length > best.length && l.startsWith(`${r}/`)) best = r;
        if (!best) {
          const r = fileRoot(n, ps);
          if (r && l.startsWith(`${r}/`)) best = r;
        }
        if (!best) {
          // worktree w katalogu obok repo, którego już nie ma: „<projekt>.wt/<nazwa>/…” (też -wt, _wt)
          const segs = l.split("/");
          for (let i = 1; i < segs.length - 2; i++) {
            const m = /^(.+)[.\-_]wt$/.exec(segs[i]);
            if (m && ps.includes(m[1])) {
              best = segs.slice(0, i + 2).join("/");
              break;
            }
          }
        }
        return best ? n.slice(best.length + 1) : null;
      };
      // do skutku: claude-mem sklejał czasem katalog worktree ze ścieżką absolutną
      // („<repo>/.claude/worktrees/x/D:/code/<repo>/plik”), więc po zdjęciu prefiksu worktree może wyjść znów
      // ścieżka absolutna. Jeden przebieg zostawiłby ją drugiemu (brak idempotencji naprawy).
      let k = key;
      for (let i = 0; i < 8; i++) {
        const prev = k;
        if (RE_ABS.test(k)) k = relative(k) ?? k;
        for (let wt = RE_WORKTREE.exec(k); wt; wt = RE_WORKTREE.exec(k)) k = wt[1];
        if (k === prev) break;
      }
      // klucz jak przy zapisie (clean po fileKey): redakcja jest idempotentna, więc naprawa c) go nie ruszy
      return k === key ? key : clean(k);
    },
  };
}

/** Lista kluczy po normalizacji, bez powtórzeń (kolejność pierwszego wystąpienia). */
export function normFileList(nz: FileKeyNormalizer, list: string[], projects: string | string[]): string[] {
  return [...new Set(list.map((k) => nz.norm(k, projects)))];
}

/** Odciski plików pod nowymi kluczami (dwa stare klucze na jeden nowy: zostaje pierwszy). */
export function normFingerprints(
  nz: FileKeyNormalizer,
  fps: Record<string, string> | null,
  projects: string | string[],
): Record<string, string> | null {
  if (!fps) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fps)) {
    const n = nz.norm(k, projects);
    if (!(n in out)) out[n] = v;
  }
  return out;
}

export interface FileKeysReport {
  /** Encje plików i katalogów z nowym kluczem; z nich scalone z istniejącą encją tego klucza. */
  entities: number;
  merged: number;
  notes: number;
  summaries: number;
}

export const emptyFileKeysReport = (): FileKeysReport => ({ entities: 0, merged: 0, notes: 0, summaries: 0 });

const arr = (s: unknown): string[] => {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Zmienione klucze listy do dziennika: `from[i]` stał się `to[i]`. */
function changedKeys(nz: FileKeyNormalizer, lists: string[][], project: string): { from: string[]; to: string[] } {
  const from: string[] = [];
  const to: string[] = [];
  for (const k of new Set(lists.flat())) {
    const n = nz.norm(k, project);
    if (n !== k) {
      from.push(k);
      to.push(n);
    }
  }
  return { from, to };
}

/**
 * e) `hipokamp repair`: klucze plików względem katalogu repo w encjach, listach plików notatek (z odciskami i FTS)
 * i podsumowań. Encja, której nowy klucz już istnieje w projekcie, łączy się z nią (powiązania przechodzą, `df` od
 * nowa z powiązań). Próba symuluje łączenia w pamięci, więc liczby są te same co w przebiegu właściwym. Drugi przebieg
 * nic nie zmienia: klucz po normalizacji jest względny albo zostaje bez zmian.
 */
export function normalizeFileKeys(
  repo: Repo,
  opts: { dryRun?: boolean; emit?: (e: Record<string, unknown>) => void; write?: (fn: () => void) => void } = {},
): FileKeysReport {
  const db = repo.db;
  const dry = !!opts.dryRun;
  const emit = opts.emit ?? (() => {});
  const write = opts.write ?? ((fn: () => void) => (dry ? fn() : db.transaction(fn).immediate()));
  const rep = emptyFileKeysReport();
  const nz = fileKeyNormalizer(db);

  // encje: plan na pełnym obrazie kluczy (łączenia w kolejności id, jak renameEntityKey w przebiegu właściwym)
  const ents = db
    .query("SELECT id, kind, project, key FROM entities WHERE kind IN ('file', 'dir') AND project != '' ORDER BY id")
    .all() as { id: number; kind: string; project: string; key: string }[];
  const at = new Map<string, number>();
  const slot = (e: { kind: string; project: string }, key: string) => `${e.kind}\u0000${e.project}\u0000${key}`;
  for (const e of ents) at.set(slot(e, e.key), e.id);
  const plan: { id: number; from: string; key: string; into: number | null }[] = [];
  for (const e of ents) {
    if (!fileKeyCandidate(e.key)) continue;
    const key = nz.norm(e.key, e.project);
    if (key === e.key) continue;
    const other = at.get(slot(e, key));
    at.delete(slot(e, e.key));
    if (other === undefined) at.set(slot(e, key), e.id);
    plan.push({ id: e.id, from: e.key, key, into: other ?? null });
  }
  for (let i = 0; i < plan.length; i += 500) {
    const chunk = plan.slice(i, i + 500);
    write(() => {
      for (const p of chunk) {
        if (!dry) repo.renameEntityKey(p.id, p.key);
        rep.entities++;
        if (p.into !== null) rep.merged++;
        // stary i nowy klucz w dzienniku: scalenie encji jest nieodwracalne, więc każdą zmianę da się sprawdzić
        emit({ op: "file-key", table: "entities", id: p.id, from: p.from, to: p.key, into: p.into });
      }
    });
  }

  // listy plików notatek i podsumowań (z odciskami pod nowymi kluczami), partiami po kluczu głównym
  const pass = <R extends { id: number }>(select: string, fix: (r: R) => void) => {
    let last = -1;
    for (;;) {
      const rows = db.query(select).all(last, 1000) as R[];
      if (!rows.length) break;
      write(() => {
        for (const r of rows) fix(r);
      });
      last = rows[rows.length - 1].id;
    }
  };
  pass<{ id: number; project: string; files_read: string; files_modified: string; fingerprints: string | null }>(
    `SELECT id, project, files_read, files_modified, fingerprints FROM observations
     WHERE id > ? AND (files_read != '[]' OR files_modified != '[]') ORDER BY id LIMIT ?`,
    (r) => {
      const read = arr(r.files_read);
      const mod = arr(r.files_modified);
      if (!read.some(fileKeyCandidate) && !mod.some(fileKeyCandidate)) return;
      const nread = normFileList(nz, read, r.project);
      const nmod = normFileList(nz, mod, r.project);
      if (sameList(read, nread) && sameList(mod, nmod)) return;
      let fps: Record<string, string> | null = null;
      try {
        fps = r.fingerprints ? JSON.parse(r.fingerprints) : null;
      } catch {}
      if (!dry)
        repo.updateObservationFiles(r.id, {
          files_read: nread,
          files_modified: nmod,
          fingerprints: normFingerprints(nz, fps, r.project),
        });
      rep.notes++;
      emit({ op: "file-key", table: "observations", id: r.id, ...changedKeys(nz, [read, mod], r.project) });
    },
  );
  pass<{ id: number; project: string; files_read: string; files_edited: string }>(
    `SELECT id, project, files_read, files_edited FROM summaries
     WHERE id > ? AND (files_read != '[]' OR files_edited != '[]') ORDER BY id LIMIT ?`,
    (r) => {
      const read = arr(r.files_read);
      const ed = arr(r.files_edited);
      if (!read.some(fileKeyCandidate) && !ed.some(fileKeyCandidate)) return;
      const nread = normFileList(nz, read, r.project);
      const ned = normFileList(nz, ed, r.project);
      if (sameList(read, nread) && sameList(ed, ned)) return;
      if (!dry) repo.updateSummaryText(r.id, { files_read: nread, files_edited: ned });
      rep.summaries++;
      emit({ op: "file-key", table: "summaries", id: r.id, ...changedKeys(nz, [read, ed], r.project) });
    },
  );
  return rep;
}
