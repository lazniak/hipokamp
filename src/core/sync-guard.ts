// Zasada „najpierw repair, potem sync”. `hipokamp repair` i `hipokamp project merge` zmieniają wiersze już zapisane
// (numery promptów, prompt_n notatek, klucze projektów i plików), a wysyłka do huba synchronizacji bierze tylko wiersze
// jeszcze niewysłane: naprawa po pierwszym `sync push` zostawiłaby na innych komputerach stare numery i ścieżki.
// Dlatego przy wykrytej synchronizacji obie komendy odmawiają zapisu bez `--force-sync-warning` (próba tylko ostrzega).
// SQL poza repo.ts: sprawdzenie tabeli modułu synchronizacji, która w tej bazie może jeszcze nie istnieć.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";
import { getMeta } from "../db/db.ts";

export const FORCE_SYNC_FLAG = "--force-sync-warning";

/** Ślad synchronizacji z hubem: powód (do komunikatu) albo null, gdy baza nigdy nie była synchronizowana. */
export function syncInUse(db: Database, stateDir: string = paths.state()): string | null {
  const hub = getMeta(db, "sync_hub");
  if (hub) return `baza jest połączona z hubem synchronizacji (${hub})`;
  if (existsSync(join(stateDir, "sync.json"))) return `jest konfiguracja synchronizacji (${join(stateDir, "sync.json")})`;
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_map'").get();
  if (table && db.query("SELECT 1 FROM sync_map LIMIT 1").get()) return "baza ma wiersze wymienione z hubem synchronizacji";
  return null;
}

/** Ostrzeżenie dla komendy `cmd` (repair, project merge); `refused`: zapis wstrzymany do decyzji użytkownika. */
export function syncWarning(cmd: string, reason: string, refused: boolean): string {
  return [
    `UWAGA: ${reason}.`,
    `  ${cmd} zmienia wiersze już zapisane (numery promptów, klucze projektów i plików), a synchronizacja wysyła tylko`,
    "  wiersze jeszcze niewysłane: inne komputery zostałyby ze starymi numerami i ścieżkami. Zasada: najpierw repair,",
    "  potem sync (docs/MIGRACJA.md).",
    refused
      ? `  Zapis wstrzymany. Jeśli świadomie naprawiasz bazę już zsynchronizowaną, powtórz z ${FORCE_SYNC_FLAG}.`
      : `  Próba niczego nie zapisuje; zapis bez ${FORCE_SYNC_FLAG} zostanie wstrzymany.`,
  ].join("\n");
}
