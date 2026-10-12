// Koszt definicji narzędzi MCP w tokenach, compat wobec slim (mcp.tools). Liczy to, co klient wysyła modelowi przy
// każdym zapytaniu, gdy nie ładuje schematów leniwie: nazwę, opis i JSON Schema parametrów (bez title i annotations),
// plus instrukcje serwera. Osobno sam spis nazw, który Claude Code pokazuje modelowi przy ToolSearch (schematy
// dociąga na żądanie). Tokenizera Claude nie ma lokalnie: dwa przybliżenia, znaki/3,5 i znaki/3,2 (estimateTokens).
// Serwer startuje na pustej bazie tymczasowej (hipokamp-test-*), bez workera; prawdziwa baza nie jest dotykana.
// Użycie: bun spikes/mcp-tools-cost.ts [--json]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(import.meta.dir, "..");
const PREFIX = "mcp__plugin_hipokamp_hipokamp__"; // nazwa narzędzia z pluginu w Claude Code

interface ModeCost {
  mode: string;
  tools: { name: string; chars: number }[];
  chars: number;
  instructions: number;
  names: number;
}

async function measure(mode: string, home: string): Promise<ModeCost> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HIPOKAMP_HOME: home,
    HIPOKAMP_NO_WORKER: "1",
    HIPOKAMP_PORT: "1",
    HIPOKAMP_MCP_TOOLS: mode,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
  };
  const client = new Client({ name: "cost", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src", "mcp", "server.ts")], env, cwd: home }),
  );
  try {
    const { tools } = await client.listTools();
    const per = tools.map((t) => ({
      name: t.name,
      chars: JSON.stringify({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }).length,
    }));
    return {
      mode,
      tools: per,
      chars: per.reduce((s, t) => s + t.chars, 0),
      instructions: (client.getInstructions() ?? "").length,
      names: tools.reduce((s, t) => s + PREFIX.length + t.name.length + 1, 0),
    };
  } finally {
    await client.close();
  }
}

const tok = (chars: number) => `${Math.round(chars / 3.5)}-${Math.ceil(chars / 3.2)}`;

const home = mkdtempSync(join(tmpdir(), "hipokamp-test-cost-"));
mkdirSync(join(home, "claude"), { recursive: true });
try {
  const compat = await measure("compat", home);
  const slim = await measure("slim", home);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ compat, slim }, null, 1));
  else {
    for (const m of [compat, slim]) {
      console.log(`\n## ${m.mode}: ${m.tools.length} narzędzi`);
      for (const t of m.tools) console.log(`${t.name.padEnd(22)} ${String(t.chars).padStart(5)} zn.  ~${tok(t.chars)} tok.`);
      console.log(`definicje razem:        ${String(m.chars).padStart(5)} zn.  ~${tok(m.chars)} tok.`);
      console.log(`instrukcje serwera:     ${String(m.instructions).padStart(5)} zn.  ~${tok(m.instructions)} tok.`);
      console.log(`same nazwy (ToolSearch):${String(m.names).padStart(5)} zn.  ~${tok(m.names)} tok.`);
    }
    const all = (m: ModeCost) => m.chars + m.instructions;
    console.log(
      `\nslim wobec compat: definicje ${Math.round((100 * slim.chars) / compat.chars)}%, z instrukcjami ${Math.round((100 * all(slim)) / all(compat))}%, nazwy ${Math.round((100 * slim.names) / compat.names)}%`,
    );
  }
} finally {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
}
