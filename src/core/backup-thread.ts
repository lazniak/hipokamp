// Kopia bazy w osobnym wątku (Bun Worker, nie proces). VACUUM INTO na bazie rzędu setek MB trwa sekundy i nie da się
// go pociąć, a na wątku workera zatrzymałby hooki. backupDbFile: własne połączenie tylko do odczytu (przy WAL hooki
// piszą dalej), zamknięte jeszcze przed odpowiedzią, bo wątek główny zaraz potem kończy wątek (terminate), a zamknięcie
// po nim ścigałoby się z końcem wątku i zostawiało uchwyty pliku w procesie.
import { paths } from "../config.ts";
import { type BackupOptions, backupDbFile } from "./backup.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<BackupOptions & { dbPath?: string }>) => {
  const { dbPath, ...opts } = e.data;
  let msg: Record<string, unknown>;
  try {
    msg = { ok: true, ...backupDbFile(dbPath ?? paths.db(), opts) };
  } catch (err) {
    msg = { ok: false, error: String((err as Error)?.message ?? err) };
  }
  self.postMessage(msg);
};
