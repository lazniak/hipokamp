// Podgląd formatów pól w bazie claude-mem (tylko odczyt, skrócone wartości).
import { Database } from "bun:sqlite";
import { join } from "node:path";

const db = new Database(join(process.env.USERPROFILE!, ".claude-mem", "claude-mem.db"), { readonly: true });
const cut = (v: unknown, n = 140) => (typeof v === "string" ? (v.length > n ? `${v.slice(0, n)}…(${v.length})` : v) : v);
const o = db.query("SELECT * FROM observations ORDER BY id DESC LIMIT 2").all() as any[];
for (const r of o) console.log(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v)])));
console.log(db.query("SELECT MIN(id) mi, MAX(id) ma, MIN(created_at_epoch) e0, MAX(created_at_epoch) e1 FROM observations").get());
console.log(db.query("SELECT * FROM sdk_sessions ORDER BY id DESC LIMIT 1").get());
console.log(db.query("SELECT * FROM session_summaries ORDER BY id DESC LIMIT 1").all().map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v, 90)]))));
console.log(db.query("SELECT * FROM user_prompts ORDER BY id DESC LIMIT 1").all().map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v, 60)]))));
console.log(db.query("SELECT project, COUNT(*) c FROM observations GROUP BY project ORDER BY c DESC LIMIT 12").all());
console.log(db.query("SELECT type, COUNT(*) c FROM observations GROUP BY type ORDER BY c DESC").all());
console.log(db.query("SELECT * FROM work_state_entries ORDER BY id DESC LIMIT 2").all().map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v, 160)]))));
console.log(db.query("SELECT COUNT(*) c, COUNT(DISTINCT memory_session_id) s FROM observations WHERE merged_into_project IS NOT NULL").get());
console.log(db.query("SELECT COUNT(*) c FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE s.id IS NULL").get());
