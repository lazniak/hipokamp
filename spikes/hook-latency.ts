// Pomiar opóźnienia hooków (p50/p95) w trybach hooks.mode: command (proces Buna), native (plik wykonywalny Go,
// zapasowo Bun) i mcp (narzędzie hook_* w działającym serwerze MCP), z workerem i bez niego.
// Zawsze na bazie testowej: katalog tymczasowy z „hipokamp-test” w nazwie, syntetyczne notatki, własny worker na
// wolnym porcie (bez modelu wektorów), sprzątany na końcu. Prawdziwa baza (~/.hipokamp) nie jest dotykana.
// Ścieżka mcp jest mierzona po stronie klienta MCP (wywołanie narzędzia w procesie serwera uruchomionego testowo):
// bez narzutu samego Claude Code, którego nie da się zmierzyć poza nim.
// Użycie: bun spikes/hook-latency.ts [powtórzenia=15] [--modes command,native,mcp] [--notes 3000] [--hook <hook.ts>]
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const N = Number(argv.find((a) => /^\d+$/.test(a)) ?? 15);
const MODES = flag("modes", "command,native,mcp").split(",");
const NOTES = Number(flag("notes", "3000"));
const ROOT = join(import.meta.dir, "..");
const HOOK = flag("hook", join(ROOT, "src", "hooks", "hook.ts"));
const NATIVE = join(ROOT, "native", "hook", process.platform === "win32" ? "hipokamp-hook.exe" : "hipokamp-hook");

// baza testowa: zmienne środowiskowe ustawiamy, ZANIM jakikolwiek moduł hipokampa policzy katalog danych
const home = mkdtempSync(join(tmpdir(), "hipokamp-test-bench-"));
const freePort = () => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
};
const port = freePort();
const projDir = join(home, "proj");
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: home,
  HIPOKAMP_PORT: String(port),
  CLAUDE_PROJECT_DIR: projDir,
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  CODEX_HOME: join(home, "codex"),
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
};
Object.assign(process.env, env);
mkdirSync(join(home, "claude", "projects"), { recursive: true });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ port, embed: { enabled: false }, backup: { enabled: false }, hooks: { mode: "mcp" } }),
);

// ---------------------------------------------------------------- ziarno: syntetyczne notatki z plikami
const { openDb } = await import("../src/db/db.ts");
const { Repo } = await import("../src/db/repo.ts");
const repo = new Repo(openDb({ vectors: false }));
let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const FILES = Array.from({ length: 40 }, (_, i) => `src/${pick(["worker", "hooks", "db", "recall", "capture"])}/plik${i}.ts`);
const WORDS =
  "worker port zakleszczenie gniazdo proces hook prompt kontekst wektor indeks transkrypt tura notatka sesja baza migracja schemat zapytanie ranking budżet podgląd strumień kopia sen scalanie projekt klucz ścieżka".split(
    " ",
  );
const TYPES = ["bugfix", "feature", "decision", "gotcha", "discovery", "change"];
const DAY = 86_400_000;
mkdirSync(join(projDir, "src"), { recursive: true });
const project = repo.resolveProject(projDir);
repo.db.transaction(() => {
  for (let i = 0; i < NOTES; i++) {
    const f = pick(FILES);
    const words = Array.from({ length: 14 }, () => pick(WORDS));
    repo.insertObservation(
      {
        session_id: null,
        project,
        type: pick(TYPES),
        title: `${words.slice(0, 5).join(" ")} (${i})`,
        narrative: `${words.join(" ")}. Zmiana w ${f}.`,
        facts: [`${words[2]} ${words[3]} w ${f}`],
        files_modified: [f],
        created_at: Date.now() - Math.floor(rnd() * 120) * DAY,
        importance: 0.3 + rnd() * 0.6,
        source: "digest",
      },
      [{ kind: "file", key: f, role: "modified" }],
    );
  }
})();

// transkrypt sesji do Stop: przed każdym pomiarem dopisujemy nową turę, więc każdy Stop ma co zapisać
const stopSession = "0b1c2d3e-0000-4000-8000-00000000be0c";
// pod <CLAUDE_CONFIG_DIR>/projects: worker i serwer MCP przyjmują tylko transkrypty spod katalogów Claude Code i Codexa
mkdirSync(join(home, "claude", "projects", "bench"), { recursive: true });
const transcript = join(home, "claude", "projects", "bench", `${stopSession}.jsonl`);
writeFileSync(transcript, "");
let turn = 0;
function appendTurn(): void {
  const t = Date.now();
  turn++;
  const lines = [
    { type: "user", uuid: `u${turn}`, sessionId: stopSession, cwd: projDir, timestamp: new Date(t).toISOString(), message: { role: "user", content: `sprawdź, czemu worker nie startuje (${turn})` } },
    {
      type: "assistant",
      uuid: `a${turn}`,
      sessionId: stopSession,
      timestamp: new Date(t + 1000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: `Worker nie startował, bo port trzymał martwy proces (${turn}).` }], stop_reason: "end_turn" },
    },
  ];
  appendFileSync(transcript, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

// ---------------------------------------------------------------- przypadki
let uniq = 0;
const sid = () => `bench-${Date.now()}-${++uniq}`;
type Case = { event: string; payload: () => Record<string, unknown> };
const CASES: Case[] = [
  { event: "session-start", payload: () => ({ session_id: sid(), cwd: projDir, source: "startup" }) },
  { event: "prompt", payload: () => ({ session_id: sid(), cwd: projDir, prompt: "dlaczego worker nie startuje, port zajęty przez martwy proces?" }) },
  {
    event: "post-tool",
    payload: () => ({ session_id: sid(), cwd: projDir, tool_name: "Read", tool_input: { file_path: join(projDir, FILES[3]) } }),
  },
  {
    event: "stop",
    payload: () => {
      appendTurn();
      return { session_id: stopSession, transcript_path: transcript, cwd: projDir };
    },
  },
];

async function timeProcess(cmd: string[], payload: unknown, extra: Record<string, string> = {}): Promise<number> {
  const t = performance.now();
  const p = Bun.spawn(cmd, { stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "pipe", env: { ...env, ...extra }, cwd: projDir });
  await new Response(p.stdout).text();
  await p.exited;
  return performance.now() - t;
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const rows: string[] = [];
function report(mode: string, worker: string, event: string, xs: number[]): void {
  const line = `| ${mode} | ${worker} | ${event} | ${pct(xs, 0.5).toFixed(0)} | ${pct(xs, 0.95).toFixed(0)} |`;
  rows.push(line);
  console.log(line);
}

async function measure(mode: string, worker: string, run: (c: Case) => Promise<number>, skip: string[] = []): Promise<void> {
  for (const c of CASES) {
    if (skip.includes(c.event)) continue;
    await run(c); // rozgrzewka (pamięć podręczna plików, połączenie)
    const xs: number[] = [];
    for (let i = 0; i < N; i++) xs.push(await run(c));
    report(mode, worker, c.event, xs);
  }
}

const down = { HIPOKAMP_NO_WORKER: "1" };
const bunCase = (extra: Record<string, string>) => (c: Case) => timeProcess([process.execPath, HOOK, c.event], c.payload(), extra);
const nativeCase = (extra: Record<string, string>) => (c: Case) =>
  timeProcess([NATIVE, "--bun", process.execPath, "--hook-ts", HOOK, c.event], c.payload(), extra);

async function mcpRun(worker: string): Promise<void> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "bench", version: "0" });
  const e = worker === "brak" ? { ...env, ...down } : env;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src", "mcp", "server.ts")], env: e, cwd: projDir }));
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  const tool = (ev: string) => `hook_${ev.replace(/-/g, "_")}`;
  if (!tools.has(tool("prompt"))) {
    console.log("mcp: serwer nie ma narzędzi hook_* (kod sprzed T-02), pomijam");
    await client.close();
    return;
  }
  await measure(
    "mcp",
    worker,
    async (c) => {
      const p = c.payload() as Record<string, any>;
      const args: Record<string, unknown> = { ...p, file_path: p.tool_input?.file_path };
      delete args.tool_input;
      const t = performance.now();
      await client.callTool({ name: tool(c.event), arguments: args });
      return performance.now() - t;
    },
    ["session-start"], // SessionStart przy starcie sesji nie może iść przez MCP (serwery jeszcze nie działają)
  );
  await client.close();
}

console.log(`baza testowa: ${home}\nnotatek: ${NOTES}, powtórzeń: ${N}, port: ${port}\n`);
console.log("| tryb | worker | zdarzenie | p50 ms | p95 ms |\n|---|---|---|---|---|");
{
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore" }).exited;
    xs.push(performance.now() - t);
  }
  report("start procesu", "-", "bun -e 0", xs);
  if (existsSync(NATIVE)) {
    const ys: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      await Bun.spawn([NATIVE, "--smoke"], { stdout: "ignore" }).exited;
      ys.push(performance.now() - t);
    }
    report("start procesu", "-", "hipokamp-hook --smoke", ys);
  }
}

const hasNative = existsSync(NATIVE);
if (MODES.includes("native") && !hasNative) console.log(`native: brak ${NATIVE} (scripts/build-native), pomijam`);

// bez workera: tylko ścieżka awaryjna (hooki go nie podnoszą: HIPOKAMP_NO_WORKER)
if (MODES.includes("command")) await measure("command", "brak", bunCase(down));
if (MODES.includes("native") && hasNative) await measure("native", "brak", nativeCase(down));
if (MODES.includes("mcp")) await mcpRun("brak");

// z workerem (własny proces na porcie testowym)
const worker = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], { env, cwd: home, stdout: "ignore", stderr: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try {
      // statyczny podgląd: /api/* bez ciasteczka albo klucza to 401 (T-34)
      up = (await fetch(`http://127.0.0.1:${port}/`)).ok;
    } catch {}
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("worker testowy nie wstał");
  if (MODES.includes("command")) await measure("command", "działa", bunCase({}));
  if (MODES.includes("native") && hasNative) await measure("native", "działa", nativeCase({}));
  if (MODES.includes("mcp")) await mcpRun("działa");
} finally {
  worker.kill();
  await worker.exited;
  repo.db.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
}
console.log(`\nbaza testowa usunięta (${home})`);
