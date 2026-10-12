// Trzyma blokadę zapisu bazy testowej przez podany czas (test transakcji IMMEDIATE w ingeście).
// Użycie: bun locker.ts <ścieżka bazy> <ms>; wypisuje „locked”, gdy blokada jest wzięta.
import { Database } from "bun:sqlite";

const path = process.argv[2] ?? "";
const ms = Number(process.argv[3] ?? 1500);
if (!path.includes("hipokamp-test")) throw new Error("locker: tylko baza testowa");
const db = new Database(path);
db.run("PRAGMA busy_timeout = 5000");
db.run("BEGIN IMMEDIATE");
db.run("INSERT INTO meta(k, v) VALUES ('test_lock', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(Date.now())]);
process.stdout.write("locked\n");
Bun.sleepSync(ms);
db.run("COMMIT");
db.close();
