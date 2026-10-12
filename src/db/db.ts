// Otwieranie bazy: WAL, busy_timeout, migracje, opcjonalnie sqlite-vec.
import { Database } from "bun:sqlite";
import { loadConfig, paths } from "../config.ts";
import { log } from "../log.ts";
import { MIGRATIONS, vecTableSql } from "./schema.ts";

export type DB = Database;

let shared: Database | null = null;
let vecLoaded = false;

export interface OpenOptions {
  path?: string;
  readonly?: boolean;
  /** Ładuje sqlite-vec (potrzebne workerowi i CLI; hookom nie). */
  vectors?: boolean;
  /**
   * Ile ms ponawiać otwarcie zajętej bazy. busy_timeout nie pomaga przy `SQLITE_BUSY_RECOVERY` (inny proces odtwarza
   * WAL, np. po restarcie workera): bez ponowienia serwer MCP padał przy starcie. Domyślnie 0, bo hooki mają twarde
   * limity czasu, a worker woli paść (duplikat czekający na bazę cofnąłby zadania działającego workera); ponawia
   * serwer MCP. Budżet sprawdzany po nieudanej próbie, a jedna próba czeka do 5 s (busy_timeout).
   */
  busyRetryMs?: number;
}

export function openDb(opts: OpenOptions = {}): Database {
  const path = opts.path ?? paths.db();
  const db = retryBusy(() => openOnce(path, opts), opts.busyRetryMs ?? 0);
  if (opts.vectors) loadVectors(db);
  return db;
}

function openOnce(path: string, opts: OpenOptions): Database {
  const db = new Database(path, opts.readonly ? { readonly: true } : { create: true, readwrite: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    // tylko odczyt podwójnie: flaga otwarcia i query_only (żadna ścieżka nie zapisze nawet przez pomyłkę)
    if (opts.readonly) db.run("PRAGMA query_only = 1");
    if (!opts.readonly) {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
      db.run("PRAGMA foreign_keys = OFF");
      db.run("PRAGMA temp_store = MEMORY");
      db.run("PRAGMA mmap_size = 268435456");
      migrate(db);
    }
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {}
    throw e;
  }
}

/** Zajęta baza: `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT` albo „database is locked”. */
export function isBusyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return (typeof code === "string" && code.startsWith("SQLITE_BUSY")) || /database is locked/i.test(String(e));
}

/** Ponawia `f` przy zajętej bazie, dopóki nie minie `budgetMs` (przerwy 100, 200… do 1000 ms); inny błąd od razu. */
export function retryBusy<T>(f: () => T, budgetMs: number, sleep: (ms: number) => void = Bun.sleepSync): T {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return f();
    } catch (e) {
      const left = deadline - Date.now();
      if (!isBusyError(e) || left <= 0) throw e;
      log.warn("baza zajęta przy otwieraniu, ponawiam", { attempt, error: String(e).slice(0, 160) });
      sleep(Math.min(100 * attempt, 1000, left));
    }
  }
}

/** Jedno współdzielone połączenie na proces (worker, MCP, CLI). */
export function getDb(opts: OpenOptions = {}): Database {
  if (!shared) shared = openDb({ vectors: true, ...opts });
  return shared;
}

export function closeShared(): void {
  try {
    shared?.close();
  } catch {}
  shared = null;
}

export function migrate(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  const version = () => Number((db.query("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string } | null)?.v ?? 0);
  // baza aktualna: bez blokady (hooki otwierają ją przy każdym zdarzeniu)
  if (version() >= MIGRATIONS.length) return;
  // po aktualizacji bazę otwiera naraz kilka procesów (hooki, MCP, worker). Wersja czytana i wszystkie migracje pod
  // jedną blokadą zapisu: każda migracja wykonuje się raz (4 i 5 nie są idempotentne), a następny proces czeka
  // (busy_timeout) i widzi już nową wersję. Wersja tylko w górę: starszy kod nie cofnie jej po nowszym.
  db.transaction(() => {
    let v = version();
    if (v >= MIGRATIONS.length) return;
    while (v < MIGRATIONS.length) db.exec(MIGRATIONS[v++]);
    db.run(
      "INSERT INTO meta(k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(meta.v AS INTEGER) < CAST(excluded.v AS INTEGER)",
      [String(v)],
    );
  }).immediate();
}

export function hasVectors(): boolean {
  return vecLoaded;
}

/** Ładuje sqlite-vec i pilnuje zgodności tabeli bitów z modelem z konfiguracji. */
export function loadVectors(db: Database): boolean {
  try {
    // import dynamiczny: hooki nie płacą za ten moduł
    const sqliteVec = require("sqlite-vec") as typeof import("sqlite-vec");
    db.loadExtension(sqliteVec.getLoadablePath());
    const cfg = loadConfig();
    const want = `${cfg.embed.model}|${cfg.embed.dims}`;
    const have = (db.query("SELECT v FROM meta WHERE k = 'vector_model'").get() as { v: string } | null)?.v;
    if (have && have !== want) {
      log.warn("model embeddingów zmieniony: kasuję wektory, trzeba przeliczyć (hipokamp embed)", { have, want });
      db.run("DROP TABLE IF EXISTS obs_vec_bits");
      db.run("DELETE FROM obs_vectors");
    }
    db.run(vecTableSql(cfg.embed.dims));
    db.run("INSERT INTO meta(k, v) VALUES ('vector_model', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [want]);
    vecLoaded = true;
    return true;
  } catch (e) {
    log.warn("sqlite-vec niedostępny, wyszukiwanie tylko pełnotekstowe", e);
    vecLoaded = false;
    return false;
  }
}

export function getMeta(db: Database, k: string): string | null {
  return (db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
}

export function setMeta(db: Database, k: string, v: string): void {
  db.run("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]);
}

/** Zmiana wartości tylko wtedy, gdy jest wciąż `expected` (null = klucza nie ma); false = ktoś zdążył pierwszy. */
export function casMeta(db: Database, k: string, expected: string | null, v: string): boolean {
  if (expected === null) return db.run("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING", [k, v]).changes > 0;
  return db.run("UPDATE meta SET v = ? WHERE k = ? AND v = ?", [v, k, expected]).changes > 0;
}
