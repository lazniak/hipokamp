// Ziarno bazy do testu e2e MCP. Uruchamiane w osobnym procesie z HIPOKAMP_HOME = katalog tymczasowy,
// żeby nigdy nie dotknąć prawdziwej bazy. Wypisuje JSON z id utworzonych rekordów.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db/db.ts";
import { Repo } from "../../src/db/repo.ts";

const home = process.env.HIPOKAMP_HOME ?? "";
if (!home.includes("hipokamp-test")) throw new Error("seed: HIPOKAMP_HOME musi wskazywać katalog testowy");
const projDir = join(home, "demo");
mkdirSync(join(projDir, "src"), { recursive: true });
writeFileSync(
  join(projDir, "src", "app.ts"),
  [
    "// aplikacja demo",
    "export interface WorkerOpts {",
    "  port: number;",
    "}",
    "",
    "/** Startuje workera na podanym porcie. */",
    "export function startWorker(opts: WorkerOpts): string {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: to treść pliku źródłowego fixture, nie szablon
    "  const url = `http://127.0.0.1:${opts.port}`;",
    '  if (opts.port < 1024) throw new Error("port { zbyt niski");',
    "  return url;",
    "}",
    "",
    "export class Pool {",
    "  private size = 0;",
    "  grow(n: number): number {",
    "    this.size += n;",
    "    return this.size;",
    "  }",
    "}",
    "",
    "export const stopWorker = async (id: string) => id.length > 0;",
    "",
  ].join("\n"),
);

// transkrypt z jedną turą: prompt, wywołanie Bash, wynik, odpowiedź
const transcript = join(home, "t1.jsonl");
const ts = (s: number) => new Date(Date.now() - 3 * 86_400_000 + s * 1000).toISOString();
const lines = [
  {
    type: "user",
    uuid: "u1",
    sessionId: "s1",
    cwd: projDir,
    timestamp: ts(0),
    message: { role: "user", content: "napraw zakleszczenie workera" },
  },
  {
    type: "assistant",
    uuid: "a1",
    sessionId: "s1",
    timestamp: ts(5),
    message: {
      role: "assistant",
      model: "test",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "netstat -ano | findstr 47777" } }],
    },
  },
  {
    type: "user",
    uuid: "r1",
    sessionId: "s1",
    timestamp: ts(6),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "TCP 127.0.0.1:47777 LISTENING 4242" }],
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    sessionId: "s1",
    timestamp: ts(9),
    message: { role: "assistant", content: [{ type: "text", text: "Port trzymał osierocony proces." }] },
  },
];
writeFileSync(transcript, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

const repo = new Repo(openDb({ vectors: false }));
const project = repo.resolveProject(projDir);
const day = 86_400_000;
const now = Date.now();
repo.upsertSession({ id: "s1", project, cwd: projDir, started_at: now - 3 * day, transcript_path: transcript });
repo.insertPrompt({ session_id: "s1", project, n: 1, text: "napraw zakleszczenie workera", created_at: now - 3 * day });

const a = repo.insertObservation({
  session_id: "s1",
  project,
  prompt_n: 1,
  type: "bugfix",
  title: "Naprawiono zakleszczenie workera na porcie 47777",
  subtitle: "Osierocony proces trzymał gniazdo",
  narrative: "Worker nie startował, bo port 47777 trzymał martwy proces potomny. Dodano sprawdzanie właściciela portu.",
  facts: ["Port 47777 trzymał PID 4242", "Naprawa: brak procesów potomnych w workerze"],
  concepts: ["problem-solution", "worker"],
  files_modified: ["src/app.ts"],
  created_at: now - 3 * day,
  importance: 0.7,
  source: "digest",
  transcript_ref: { path: transcript, from: 0, to: statSync(transcript).size },
}).id;

const b = repo.insertObservation({
  session_id: "s1",
  project,
  prompt_n: 1,
  type: "decision",
  title: "Wybrano bge-m3 do embeddingów",
  narrative: "bge-m3 dobrze radzi sobie z polskim i angielskim, działa lokalnie.",
  facts: ["Model: Xenova/bge-m3"],
  concepts: ["trade-off"],
  created_at: now - 2 * day,
  importance: 0.8,
  source: "digest",
}).id;

const c = repo.insertObservation({
  session_id: null,
  project: "inny",
  type: "discovery",
  title: "Gitea Actions bez runnera",
  narrative: "Actions są włączone, ale runner nie jest zarejestrowany, więc CI trzeba odpalać lokalnie.",
  created_at: now - day,
  importance: 0.5,
  source: "digest",
}).id;

const s = repo.insertSummary({
  session_id: "s1",
  project,
  request: "Napraw zakleszczenie workera",
  investigated: "netstat, procesy potomne",
  learned: "Gniazdo dziedziczone przez dzieci",
  completed: "Worker bez procesów potomnych",
  next_steps: "Testy MCP",
  notes: null,
  files_read: [],
  files_edited: ["src/app.ts"],
  prompt_n: 1,
  created_at: now - 3 * day + 60_000,
  source: "digest",
});

repo.appendWorkState(project, "plan", { task: "testy MCP", status: "doing" });

process.stdout.write(JSON.stringify({ project, projDir, a, b, c, s }));
