// Test e2e serwera MCP: tymczasowa baza (osobny proces ziarna), prawdziwy klient MCP po stdio, bez workera (FTS).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RECALL_TRIGGERS } from "../src/mcp/tools.ts";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: home,
  HIPOKAMP_NO_WORKER: "1",
  HIPOKAMP_PORT: "47998",
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
};
let ids: { project: string; projDir: string; a: number; b: number; c: number; s: number };
let client: Client;
let slim: Client | undefined;

async function call(name: string, args: Record<string, unknown> = {}, via: Client = client): Promise<string> {
  const r = (await via.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const t = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
}

/** Znaki definicji, które klient bez leniwego ładowania wysyła modelowi: nazwa, opis, JSON Schema parametrów. */
function defsChars(tools: { name: string; description?: string; inputSchema: unknown }[]): number {
  return tools.reduce(
    (s, t) => s + JSON.stringify({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }).length,
    0,
  );
}

beforeAll(async () => {
  const seed = Bun.spawnSync([process.execPath, join(ROOT, "test", "fixtures", "seed.ts")], { env, cwd: ROOT });
  if (seed.exitCode !== 0) throw new Error(`seed: ${seed.stderr.toString()}`);
  ids = JSON.parse(seed.stdout.toString());
  env.CLAUDE_PROJECT_DIR = ids.projDir;
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src", "mcp", "server.ts")], env, cwd: ids.projDir }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  await slim?.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

describe("mcp", () => {
  test("narzędzia zgodne z claude-mem", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      "search",
      "timeline",
      "get_observations",
      "get_tool_uses",
      "important_workflow",
      "work_state_read",
      "work_state_write",
      "session_start_context",
      "build_corpus",
      "list_corpora",
      "prime_corpus",
      "query_corpus",
      "rebuild_corpus",
      "reprime_corpus",
      "smart_search",
      "smart_outline",
      "smart_unfold",
      "remember",
      "forget",
    ])
      expect(names).toContain(n);
  });

  test("search: polska fleksja, inne projekty, sesje i prompty", async () => {
    const t = await call("search", { query: "zakleszczenia workera" });
    expect(t).toContain(`#${ids.a}`);
    expect(t).toContain("tylko pełnotekstowo");
    expect(t).toContain(`S${ids.s}`);
    const other = await call("search", { query: "Gitea runner" });
    expect(other).toContain(`#${ids.c}`);
    expect(other).toContain("{inny}");
    const only = await call("search", { query: "Gitea runner", project: ids.project });
    expect(only).not.toContain(`#${ids.c}`);
    const byType = await call("search", { type: "decision" });
    expect(byType).toContain(`#${ids.b}`);
    expect(byType).not.toContain(`#${ids.a}`);
  });

  test("get_observations, timeline, get_tool_uses", async () => {
    const full = await call("get_observations", { ids: [ids.a, `S${ids.s}`, 999999] });
    expect(full).toContain("Naprawiono zakleszczenie workera");
    expect(full).toContain("Fakty:");
    expect(full).toContain("Następne kroki");
    expect(full).toContain("#999999");
    const json = JSON.parse(await call("get_observations", { ids: String(ids.b), format: "json" }));
    expect(json[0].title).toBe("Wybrano bge-m3 do embeddingów");
    const tl = await call("timeline", { anchor: ids.a, depth_before: 2, depth_after: 2 });
    expect(tl).toContain("KOTWICA");
    expect(tl).toContain(`#${ids.b}`);
    const raw = await call("get_tool_uses", { ids: [ids.a] });
    expect(raw).toContain("Bash");
    expect(raw).toContain("findstr 47777");
    expect(raw).toContain("LISTENING");
  });

  test("work state: odczyt, zapis, zamknięcie", async () => {
    expect(await call("work_state_read")).toContain("testy MCP");
    const w = await call("work_state_write", {
      list: "plan",
      fields: { task: "dokumentacja", status: "todo", plik: "README.md" },
    });
    expect(w).toContain("[todo] dokumentacja");
    expect(w).toContain("[doing] testy MCP");
    await call("work_state_write", { list: "plan", fields: { task: "testy MCP", status: "done" } });
    const r = await call("work_state_read", { list: "plan" });
    expect(r).not.toContain("testy MCP");
    expect(await call("work_state_write", { list: "plan", fields: { status: "done" } })).toContain("zamknięta");
    expect(await call("work_state_read")).toContain("Nic otwartego");
  });

  test("remember i forget", async () => {
    const r = await call("remember", { text: "Repozytoria zakładamy na Gitea, nie na GitHubie.", type: "preference" });
    const id = Number(r.match(/#(\d+)/)?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(await call("search", { query: "Gitea GitHub repozytoria", project: ids.project })).toContain(`#${id}`);
    expect(await call("forget", { ids: [id], reason: "test" })).toContain("Zarchiwizowane");
    expect(await call("search", { query: "Gitea GitHub repozytoria", project: ids.project })).not.toContain(`#${id}`);
    expect(await call("forget", { ids: [id], undo: true })).toContain("Przywrócone");
  });

  test("remember z kluczem zastępuje starszą decyzję, forget z undo ją przywraca", async () => {
    const id = async (t: string) => Number(t.match(/#(\d+)/)?.[1]);
    const a = await id(await call("remember", { text: "Budżet startowy kontekstu to 1600 tokenów.", key: "budżet startowy" }));
    const r = await call("remember", { text: "Budżet startowy kontekstu podnosimy do 2000 tokenów.", key: "Budzet startowy" });
    const b = await id(r);
    expect(r).toContain(`zastępuje #${a}`);
    const q = { query: "budżet startowy kontekstu tokenów", project: ids.project };
    const found = await call("search", q);
    expect(found).toContain(`#${b}`);
    expect(found).not.toContain(`#${a}`);
    // z includeArchived zastąpiona wraca ze statusem i odsyłaczem do aktualnej wersji
    expect(await call("search", { ...q, includeArchived: true })).toContain(`#${a}`);
    expect(await call("search", { ...q, includeArchived: true })).toContain(`(superseded → #${b})`);
    expect(await call("get_observations", { ids: [a] })).toContain(`status: superseded, aktualna wersja #${b}`);
    expect(await call("forget", { ids: [a], undo: true })).toContain(`Przywrócone: #${a}`);
    expect(await call("search", q)).toContain(`#${a}`);
  });

  test("korpusy bez LLM", async () => {
    expect(await call("build_corpus", { name: "demo", project: ids.project })).toContain('Korpus "demo"');
    expect(await call("list_corpora")).toContain("demo");
    expect(await call("prime_corpus", { name: "demo" })).toContain("Najważniejsze notatki");
    expect(await call("query_corpus", { name: "demo", question: "dlaczego zakleszczenie portu" })).toContain(`#${ids.a}`);
    expect(await call("rebuild_corpus", { name: "demo" })).toContain('Korpus "demo"');
  });

  test("smart_outline, smart_unfold, smart_search", async () => {
    const o = await call("smart_outline", { file_path: "src/app.ts" });
    expect(o).toContain("startWorker");
    expect(o).toContain("class Pool");
    expect(o).toContain("grow");
    expect(o).toContain("stopWorker");
    const u = await call("smart_unfold", { file_path: "src/app.ts", symbol_name: "startWorker" });
    expect(u).toContain("Startuje workera");
    expect(u).toContain("return url;");
    expect(u).not.toContain("class Pool");
    const m = await call("smart_unfold", { file_path: "src/app.ts", symbol_name: "Pool.grow" });
    expect(m).toContain("this.size += n");
    const s = await call("smart_search", { query: "worker" });
    expect(s).toContain("src/app.ts:7");
  });

  test("session_start_context i important_workflow", async () => {
    expect(await call("session_start_context")).toContain(`# Pamięć: ${ids.project}`);
    expect(await call("important_workflow")).toContain("get_observations");
  });
});

describe("mcp.tools = slim", () => {
  // drugi serwer na tej samej bazie, tryb z config.json (pierwszy już wczytał konfigurację bez tego klucza)
  const memory = (args: Record<string, unknown>) => call("memory", args, slim);

  beforeAll(async () => {
    // wielkość liter bez znaczenia (SLIM to slim, nie po cichu compat)
    writeFileSync(join(home, "config.json"), JSON.stringify({ mcp: { tools: "SLIM" } }));
    slim = new Client({ name: "test-slim", version: "0" });
    await slim.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "src", "mcp", "server.ts")],
        env,
        cwd: ids.projDir,
      }),
    );
  }, 30_000);

  test("4 narzędzia, reszta jako komendy memory; definicje co najmniej o połowę tańsze", async () => {
    const { tools } = await slim!.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "get_observations", "remember", "memory"]);
    const mem = tools.find((t) => t.name === "memory")!.description ?? "";
    for (const n of ["timeline(", "work_state_write(list, fields", "forget(ids", "smart_unfold(file_path, symbol_name)"])
      expect(mem).toContain(n);
    expect(JSON.stringify(tools)).not.toContain("platformSource");
    const full = await client.listTools();
    const ratio = defsChars(tools) / defsChars(full.tools);
    expect(ratio).toBeLessThan(0.5);
    expect(slim!.getInstructions()).toContain("memory(cmd");
    // obie wersje mówią, kiedy sięgać po pamięć, a nie tylko jak
    expect(slim!.getInstructions()).toContain(RECALL_TRIGGERS);
    expect(client.getInstructions()).toContain(RECALL_TRIGGERS);
    expect(client.getInstructions()).toContain("work_state_read");
  });

  test("search, get_observations i remember jak w compat", async () => {
    expect(await call("search", { query: "zakleszczenia workera" }, slim)).toContain(`#${ids.a}`);
    expect(await call("get_observations", { ids: [ids.b] }, slim)).toContain("Wybrano bge-m3");
    const r = await call("remember", { text: "Tryb slim zapisuje tak samo jak compat.", type: "decision" }, slim);
    expect(r).toMatch(/Zapamiętane jako #\d+/);
  });

  test("remember: supersedes tylko całkowite, jak w compat (2.5 to błąd, nie „zastępuje #2.5”)", async () => {
    const tools = (await slim!.listTools()).tools;
    const schema = tools.find((t) => t.name === "remember")!.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.supersedes.type).toBe("integer");
    const said = await call("remember", { text: "Notatka z ułamkowym numerem do zastąpienia.", supersedes: 2.5 }, slim).then(
      (t) => t,
      (e) => String(e),
    );
    expect(said).not.toContain("#2.5");
    expect(said).toMatch(/remember: .*(?:integer|int)/is);
  });

  test("memory: komenda z args, parametry płasko, help, złe parametry, nieznana komenda", async () => {
    expect(await memory({ cmd: "timeline", args: { anchor: ids.a, depth_before: 1, depth_after: 1 } })).toContain("KOTWICA");
    expect(await memory({ cmd: "get_tool_uses", ids: [ids.a] })).toContain("findstr 47777");
    expect(await memory({ cmd: "smart_outline", args: { file_path: "src/app.ts" } })).toContain("startWorker");
    expect(await memory({ cmd: "list_corpora" })).toBeString();
    const h = await memory({ cmd: "help", args: { cmd: "work_state_write" } });
    expect(h).toContain("## work_state_write");
    expect(h).toContain('"status": "done" closes the list');
    // błąd jako tekst: expect(promise).rejects w Bun czeka na obietnicę bez obsługi potoku procesu potomnego
    // (odpowiedź serwera nie dochodzi, aż minie 60 s limitu żądania w SDK)
    const error = (args: Record<string, unknown>) =>
      memory(args).then(
        () => "",
        (e) => String(e),
      );
    expect(await error({ cmd: "timeline", args: { depth_before: "dużo" } })).toMatch(/złe parametry[\s\S]*## timeline/);
    expect(await error({ cmd: "work_state_write", args: { list: "x" } })).toMatch(/fields/);
    expect(await error({ cmd: "nie_ma" })).toContain("Nie ma komendy nie_ma");
  });
});
