// Ziarno bazy do testów trybów hooków (command, mcp, native). Osobny proces z HIPOKAMP_HOME = katalog tymczasowy,
// żeby nigdy nie dotknąć prawdziwej bazy. Notatki mają powiązania z plikami (przypominanie przy pliku).
// Wypisuje JSON z id utworzonych rekordów.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db/db.ts";
import { Repo } from "../../src/db/repo.ts";

const home = process.env.HIPOKAMP_HOME ?? "";
if (!home.includes("hipokamp-test")) throw new Error("hooks-seed: HIPOKAMP_HOME musi wskazywać katalog testowy");
const projDir = join(home, "demo");
mkdirSync(join(projDir, "src"), { recursive: true });
writeFileSync(join(projDir, "src", "app.ts"), "export const port = 47777;\n");
writeFileSync(join(projDir, "src", "db.ts"), "export const wal = true;\n");

const repo = new Repo(openDb({ vectors: false }));
const project = repo.resolveProject(projDir);
const now = Date.now();
const day = 86_400_000;

const a = repo.insertObservation(
  {
    session_id: null,
    project,
    type: "bugfix",
    title: "Naprawiono zakleszczenie workera na porcie 47777",
    narrative: "Worker nie startował, bo port 47777 trzymał martwy proces potomny. Sprawdzanie portu w src/app.ts.",
    facts: ["Port 47777 trzymał martwy proces", "Naprawa w src/app.ts"],
    files_modified: ["src/app.ts"],
    created_at: now - 3 * day,
    importance: 0.75,
    source: "digest",
  },
  [{ kind: "file", key: "src/app.ts", role: "modified" }],
).id;

const b = repo.insertObservation(
  {
    session_id: null,
    project,
    type: "decision",
    title: "Baza w trybie WAL, zapis bez workera",
    narrative: "Hook pisze wprost do SQLite w trybie WAL, worker liczy tylko wektory.",
    facts: ["journal_mode = WAL"],
    files_modified: ["src/db.ts"],
    created_at: now - 2 * day,
    importance: 0.8,
    source: "digest",
  },
  [{ kind: "file", key: "src/db.ts", role: "modified" }],
).id;

process.stdout.write(JSON.stringify({ project, projDir, a, b }));
