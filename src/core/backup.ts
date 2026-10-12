// Kopie bazy: VACUUM INTO daje spójny snapshot przy działającym WAL (hooki piszą dalej), plus retencja.
// Lokalnie i za darmo. Wysyłka na własny VPS to osobny krok (faza 2).
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";

export const backupDir = () => join(paths.backups(), "db");

/** Znacznik czasu do nazw plików (UTC, z sekundami). */
export const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

/** Nazwa, której jeszcze nie ma (także z -wal i -shm): sekundy i losowy przyrostek, więc dwie operacje
 *  w tej samej minucie nigdy się nie nadpiszą. */
function freshFile(dir: string, prefix: string, tag?: string): string {
  for (let i = 0; i < 20; i++) {
    const f = join(dir, `${prefix}-${stamp()}-${randomBytes(3).toString("hex")}${tag ? `-${tag}` : ""}.db`);
    if (![f, `${f}-wal`, `${f}-shm`].some((x) => existsSync(x))) return f;
  }
  throw new Error(`nie mogę wybrać wolnej nazwy pliku w ${dir}`);
}

export interface BackupOptions {
  keep?: number;
  tag?: string;
  dir?: string;
}

export function backupDb(db: Database, opts: BackupOptions = {}): { file: string; bytes: number; ms: number; removed: string[] } {
  const dir = opts.dir ?? backupDir();
  mkdirSync(dir, { recursive: true });
  const file = freshFile(dir, "hipokamp", opts.tag);
  const t0 = performance.now();
  try {
    db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (e) {
    // nieudana kopia zostawia pusty plik, który retencja wzięłaby za kopię
    try {
      unlinkSync(file);
    } catch {}
    throw e;
  }
  return { file, bytes: statSync(file).size, ms: Math.round(performance.now() - t0), removed: pruneBackups(dir, opts.keep ?? 7) };
}

/**
 * Kopia pliku bazy przez połączenie tylko do odczytu, bez migracji: pierwsze otwarcie do zapisu przez nowszą wersję
 * migruje schemat, więc kopia „przed zmianą” (`pre-repair`, `pre-project-merge`) musi powstać przed nim.
 * VACUUM INTO nie działa przy `query_only`, a samo otwarcie tylko do odczytu niczego w bazie nie zapisze.
 */
export function backupDbFile(
  path: string = paths.db(),
  opts: BackupOptions = {},
): { file: string; bytes: number; ms: number; removed: string[] } {
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return backupDb(db, opts);
  } finally {
    db.close();
  }
}

/** Ta sama kopia w osobnym wątku z własnym połączeniem (worker: VACUUM INTO nie zatrzymuje pętli zdarzeń). */
export function backupDbInThread(
  opts: BackupOptions & { dbPath?: string } = {},
  /** skrypt wątku (testy podstawiają wątek, który kończy się bez odpowiedzi) */
  threadUrl = new URL("./backup-thread.ts", import.meta.url).href,
): Promise<{ file: string; bytes: number; ms: number; removed: string[] }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(threadUrl);
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      w.terminate();
    };
    w.onmessage = (e) => {
      const { ok, error, ...r } = e.data;
      settle(() => (ok ? resolve(r) : reject(new Error(error))));
    };
    w.onerror = (e) => settle(() => reject(new Error(`wątek kopii: ${e.message ?? e}`)));
    // wątek skończył się bez odpowiedzi (awaria, zakończenie z zewnątrz): bez tego worker czekałby na zawsze,
    // a z nim blokada przebiegu okresowego (nadrabianie, sen)
    w.addEventListener("close", () => settle(() => reject(new Error("wątek kopii zakończył się bez wyniku"))));
    // ścieżki liczone tutaj, nie w wątku: Bun daje wątkowi środowisko z chwili startu procesu, więc HIPOKAMP_HOME
    // zmieniony później (testy) wskazałby w wątku inną bazę
    w.postMessage({ ...opts, dbPath: opts.dbPath ?? paths.db(), dir: opts.dir ?? backupDir() });
  });
}

export function listBackups(): { file: string; bytes: number; at: number }[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: join(dir, f), bytes: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

/** Kopia bez tagu (także w dawnym formacie bez sekund i przyrostka). */
const PLAIN_BACKUP = /^hipokamp-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})(-\d{2})?(-[0-9a-f]{6})?\.db$/;

/**
 * Retencja tylko zwykłych kopii: kopie z tagiem (np. pre-repair) zostają, aż ktoś usunie je ręcznie. Kolejność od
 * najstarszej: czas z nazwy (do sekundy), w tej samej sekundzie czas zapisu pliku, na końcu nazwa. Sama nazwa nie
 * wystarcza, bo losowy przyrostek ustawiał kopie z tej samej sekundy przypadkowo i retencja mogła usunąć najnowszą.
 */
function pruneBackups(dir: string, keep: number): string[] {
  const mtime = (f: string) => {
    try {
      return statSync(join(dir, f)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const files = readdirSync(dir)
    .map((f) => ({ f, m: PLAIN_BACKUP.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
    .map(({ f, m }) => ({ f, at: `${m[1]}${m[2] ?? ""}`, t: mtime(f) }))
    .sort((a, b) => cmp(a.at, b.at) || a.t - b.t || cmp(a.f, b.f))
    .map((x) => x.f);
  const old = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const f of old)
    try {
      unlinkSync(join(dir, f));
    } catch {}
  return old;
}

/** Przywraca kopię. Bieżąca baza (z plikami WAL) idzie najpierw do „pre-restore”. Worker musi być zatrzymany. */
export function restoreDb(src: string, opts: { dbPath?: string; dir?: string } = {}): { previous: string | null } {
  if (!existsSync(src)) throw new Error(`nie ma pliku ${src}`);
  const db = opts.dbPath ?? paths.db();
  const dir = opts.dir ?? backupDir();
  mkdirSync(dir, { recursive: true });
  // źródło z plikiem -wal (baza skopiowana w trakcie pracy, pre-restore): część transakcji jest tylko w WAL, sam plik
  // główny by je zgubił. Najpierw spójny obraz przez VACUUM INTO (źródło otwarte tylko do odczytu) i przywracamy obraz.
  let from = src;
  let snapshot: string | null = null;
  try {
    if (existsSync(`${src}-wal`)) {
      snapshot = freshFile(dir, "restore-src");
      const hadShm = existsSync(`${src}-shm`);
      const s = new Database(src, { readonly: true });
      try {
        s.run(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      } finally {
        s.close();
        // odczyt tworzy przy źródle plik -shm (indeks WAL); nie zostawiamy po sobie śladu
        if (!hadShm)
          try {
            unlinkSync(`${src}-shm`);
          } catch {}
      }
      from = snapshot;
    }
    let previous: string | null = null;
    // także osierocone -wal i -shm: zostawione obok przywróconej kopii zostałyby do niej dopisane
    const parts = ["", "-wal", "-shm"].filter((ext) => existsSync(db + ext));
    if (parts.length) {
      previous = freshFile(dir, "pre-restore");
      // renameSync na Windows nadpisuje cel bez pytania: freshFile gwarantuje, że celu (ani -wal, -shm) nie ma
      for (const ext of parts) renameSync(db + ext, previous + ext);
    }
    copyFileSync(from, db, constants.COPYFILE_EXCL);
    return { previous };
  } finally {
    if (snapshot)
      try {
        unlinkSync(snapshot);
      } catch {}
  }
}
