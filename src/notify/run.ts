#!/usr/bin/env bun
// Proces wysyłki powiadomień: podnosi go hook Stop (odłączony, bez okna), gdy w oknie są notatki do powiadomienia.
// Czeka na okno limitu częstości (w tym czasie hooki nie startują drugiego: blokada w pliku), wysyła zbiorczo i kończy.
// Bazę otwiera tylko na czas przebiegu: czekając, nie trzyma pliku bazy (restore, backup). Nie słucha na żadnym porcie
// i nie jest dzieckiem workera.
import { ensureDataDirs, loadConfig } from "../config.ts";
import { openDb } from "../db/db.ts";
import { Repo } from "../db/repo.ts";
import { initLog, log } from "../log.ts";
import { notifyLoop } from "./notify.ts";

initLog("notify");
try {
  ensureDataDirs();
  const r = await notifyLoop(async (fn) => {
    const db = openDb({ vectors: false });
    try {
      return await fn(new Repo(db));
    } finally {
      db.close();
    }
  }, loadConfig().notify);
  if (r.sent) log.info("powiadomienie wysłane", { notatki: r.count, kanały: r.delivered, błędy: r.failed.length });
  else if (r.failed.length) log.warn("powiadomienie niedoręczone", r.failed);
} catch (e) {
  log.error("proces powiadomień padł", e);
} finally {
  process.exit(0);
}
