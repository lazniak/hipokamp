// Smoke test: ingest kilku prawdziwych transkryptów do tymczasowej bazy i podgląd jakości obserwacji.
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIPOKAMP_HOME = mkdtempSync(join(tmpdir(), "hipokamp-smoke-"));
const { openDb } = await import("../src/db/db.ts");
const { Repo } = await import("../src/db/repo.ts");
const { ingestTranscript } = await import("../src/capture/ingest.ts");
const { buildSessionSummary } = await import("../src/capture/summary.ts");

const db = openDb({ vectors: true });
const repo = new Repo(db);
const root = join(process.env.USERPROFILE!, ".claude", "projects");
const files: { p: string; m: number; s: number; sid: string }[] = [];
for (const d of readdirSync(root)) {
  try {
    for (const f of readdirSync(join(root, d))) {
      if (!f.endsWith(".jsonl")) continue;
      const st = statSync(join(root, d, f));
      files.push({ p: join(root, d, f), m: st.mtimeMs, s: st.size, sid: f.replace(/\.jsonl$/, "") });
    }
  } catch {}
}
files.sort((a, b) => b.m - a.m);
// po jednej sesji z różnych projektów (interaktywne mają wiele tur)
const seenDir = new Set<string>();
const pick = files
  .filter((f) => f.s > 1_000_000 && f.s < 15_000_000)
  .filter((f) => {
    const d = f.p.split(/[\\/]/).slice(-2, -1)[0];
    if (seenDir.has(d)) return false;
    seenDir.add(d);
    return true;
  })
  .slice(1, Number(process.argv[2] ?? 6));
const t0 = performance.now();
let bytes = 0;
for (const f of pick) {
  const r = ingestTranscript(repo, { sessionId: f.sid, transcriptPath: f.p, final: true, source: "backfill" });
  buildSessionSummary(repo, f.sid);
  bytes += f.s;
  console.log(`${f.sid.slice(0, 8)} ${(f.s / 1e6).toFixed(1)}MB project=${r.project} turns=${r.turns} inserted=${r.inserted.length} skipped=${r.skipped}`);
}
const ms = performance.now() - t0;
console.log(`ingest ${(bytes / 1e6).toFixed(1)} MB in ${Math.round(ms)} ms (${((bytes / 1e6) / (ms / 1000)).toFixed(1)} MB/s)`);
const rows = db.query("SELECT id, type, importance, title, subtitle, facts, files_modified, concepts FROM observations ORDER BY id DESC LIMIT 14").all() as any[];
for (const r of rows) {
  console.log(`\n#${r.id} [${r.type} ${r.importance}] ${r.title}\n   prośba: ${String(r.subtitle).slice(0, 110)}\n   facts: ${JSON.parse(r.facts).slice(0, 3).join(" | ").slice(0, 300)}\n   files: ${JSON.parse(r.files_modified).slice(0, 4).join(", ")}\n   concepts: ${JSON.parse(r.concepts).join(", ")}`);
}
const s = db.query("SELECT * FROM summaries ORDER BY id DESC LIMIT 1").get() as any;
console.log("\nSUMMARY:", { request: s?.request?.slice(0, 150), completed: s?.completed?.slice(0, 250), next: s?.next_steps?.slice(0, 200), learned: s?.learned?.slice(0, 200) });
console.log("stats", repo.stats());
