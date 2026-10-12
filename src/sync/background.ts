// Synchronizacja w tle (worker): tylko przy sync.enabled. Wyłączona nie ładuje klienta i nie otwiera żadnego
// połączenia sieciowego (test „brak ruchu przy enabled=false”).
import { refreshConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { log } from "../log.ts";
import type { backgroundSync } from "./client.ts";

export type SyncRound = Awaited<ReturnType<typeof backgroundSync>>;

/**
 * Ustawienia synchronizacji z config.json w chwili sprawdzenia: zmiana `sync.enabled` albo `sync.intervalMin` działa
 * od następnego cyklu workera, bez restartu (refreshConfig porównuje skrót treści pliku, zepsuty plik zostawia
 * poprzednią konfigurację). Klient czyta potem `loadConfig()` (np. `sync.excludeProjects`), czyli tę samą, świeżą.
 */
export function syncConfigFromFile(): { enabled: boolean; intervalMin: number } {
  return refreshConfig().sync;
}

export class SyncScheduler {
  private last = 0;
  private busy = false;
  /** Rodzaje ostrzeżeń zegara już zapisane w logu (T-37): raz, a ponownie dopiero po zniknięciu i powrocie. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly repo: Repo,
    private readonly cfg: () => { enabled: boolean; intervalMin: number } = syncConfigFromFile,
    private readonly now: () => number = Date.now,
    /** Katalog stanu (domyślnie ~/.hipokamp/state; testy dają katalog „komputera”). */
    private readonly stateDir?: string,
    /** Zapis ostrzeżenia do logu workera (test podmienia). */
    private readonly warn: (msg: string) => void = (m) => log.warn(m),
  ) {}

  /** Ostrzeżenia zegara z obiegu: nowy rodzaj idzie do logu raz, zniknięty jest zapominany. */
  private warnClock(list: { kind: string; text: string }[]): void {
    const now = new Set(list.map((w) => w.kind));
    for (const k of [...this.warned]) if (!now.has(k)) this.warned.delete(k);
    for (const w of list)
      if (!this.warned.has(w.kind)) {
        this.warned.add(w.kind);
        this.warn(`sync: ${w.text}`);
      }
  }

  /**
   * Jeden obieg, gdy włączona, nie trwa poprzedni i minął interwał; inaczej null (nic nie uruchomiono).
   * `wrap` opakowuje cały obieg (worker: `track("sync", …, { sliced: true })`, diagnostyka przestojów).
   */
  maybe(wrap: (run: () => Promise<SyncRound>) => Promise<SyncRound> = (run) => run()): Promise<SyncRound> | null {
    const c = this.cfg();
    if (!c.enabled || this.busy || this.now() - this.last < Math.max(1, c.intervalMin) * 60_000) return null;
    this.last = this.now();
    this.busy = true;
    let round: Promise<SyncRound>;
    try {
      round = wrap(() => import("./client.ts").then((m) => m.backgroundSync(this.repo, this.stateDir)));
    } catch (e) {
      round = Promise.reject(e);
    }
    return round
      .then((r) => {
        if (r) this.warnClock(r.clock ?? []);
        return r;
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
