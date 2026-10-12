// Rejestr narzędzi MCP (src/mcp/tools.ts) w procesie: bez bazy, bez workera, bez katalogu danych.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpTools } from "../src/config.ts";
import { INTERNAL_META, toolRegistry } from "../src/mcp/tools.ts";

const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Serwer z trzema narzędziami: zwykłym (timeline), wewnętrznym po prefiksie i wewnętrznym po _meta. */
function build(mode: McpTools) {
  const mcp = new McpServer({ name: "t", version: "0" });
  const reg = toolRegistry(mcp, mode);
  const plain = reg.registerTool(
    "timeline",
    { description: "context", inputSchema: { anchor: z.string().optional() } },
    async () => ok("tl"),
  );
  const hook = reg.registerTool(
    "hook_prompt",
    { description: "Internal hook", inputSchema: { prompt: z.unknown().optional() } },
    async (a: { prompt?: unknown }) => ok(`hook:${String(a.prompt)}`),
  );
  reg.registerTool("ping_internal", { description: "Internal by meta", _meta: { [INTERNAL_META]: true } }, async () =>
    ok("pong"),
  );
  return { mcp, reg, plain, hook };
}

async function connect(mcp: McpServer): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

describe("rejestr narzędzi", () => {
  test("slim: narzędzia wewnętrzne pod własną nazwą, poza memory i help", async () => {
    const { mcp, reg, hook } = build("slim");
    expect(typeof hook.disable).toBe("function"); // wewnętrzne mają prawdziwy uchwyt od razu
    reg.finish();
    const client = await connect(mcp);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["hook_prompt", "memory", "ping_internal"]);
    const memory = tools.find((t) => t.name === "memory")!;
    expect(memory.description).toContain("timeline(");
    expect(memory.description).not.toContain("hook_prompt");
    expect(memory.description).not.toContain("ping_internal");
    // hook wołany po nazwie działa jak w compat
    expect(textOf(await client.callTool({ name: "hook_prompt", arguments: { prompt: "x" } }))).toBe("hook:x");
    expect(textOf(await client.callTool({ name: "ping_internal", arguments: {} }))).toBe("pong");
    // przez memory ich nie ma, help ich nie wymienia
    const viaMemory = await client.callTool({ name: "memory", arguments: { cmd: "hook_prompt" } });
    expect(viaMemory.isError).toBe(true);
    expect(textOf(viaMemory)).toContain("Nie ma komendy hook_prompt");
    const help = textOf(await client.callTool({ name: "memory", arguments: { cmd: "help" } }));
    expect(help).toContain("## timeline");
    expect(help).not.toContain("hook_prompt");
    expect(help).not.toContain("ping_internal");
    await client.close();
  });

  test("compat: wszystko osobno, uchwyty prawdziwe", async () => {
    const { mcp, reg, plain } = build("compat");
    expect(typeof plain.disable).toBe("function");
    reg.finish();
    const client = await connect(mcp);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["hook_prompt", "ping_internal", "timeline"]);
    expect([...reg.defs.keys()]).toEqual(["timeline"]);
    await client.close();
  });

  test("slim: uchwyt zwykłego narzędzia rzuca czytelny błąd zamiast udawać obiekt", () => {
    const { plain } = build("slim");
    expect(() => plain.disable()).toThrow(/dopiero w finish\(\)/);
  });

  for (const mode of ["compat", "slim"] as const) {
    test(`${mode}: ta sama nazwa dwa razy i rejestracja po finish() to błąd`, () => {
      const { reg } = build(mode);
      expect(() => reg.registerTool("timeline", { description: "again" }, async () => ok(""))).toThrow(/już jest/);
      expect(() => reg.registerTool("hook_prompt", { description: "again" }, async () => ok(""))).toThrow(/już jest/);
      reg.finish();
      expect(() => reg.registerTool("later", { description: "late" }, async () => ok(""))).toThrow(/po finish\(\)/);
      expect(() => reg.registerTool("hook_late", { description: "late" }, async () => ok(""))).toThrow(/po finish\(\)/);
      expect(() => reg.finish()).toThrow();
    });
  }
});
