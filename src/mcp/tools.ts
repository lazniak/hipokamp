// Zestaw narzędzi MCP według mcp.tools. compat: każde narzędzie osobno, nazwy, parametry i opisy jak w claude-mem.
// slim: search, get_observations i remember z krótkimi opisami oraz memory(cmd, args) dla reszty. Komendy memory to
// nazwy narzędzi compat z tymi samymi parametrami, a pełny opis komendy daje memory(cmd="help"). Dla klientów, które
// wysyłają wszystkie schematy w każdym zapytaniu (Claude Code ładuje je leniwie przez ToolSearch, więc tam compat
// kosztuje głównie nazwy). Narzędzia wewnętrzne (hook_* albo _meta["hipokamp/internal"]) są w obu trybach osobno
// pod własną nazwą, bo wołają je hooki, nie model.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpTools } from "../config.ts";

type Out = { content: { type: "text"; text: string }[]; isError?: boolean };
type Shape = Record<string, z.ZodType>;

export interface ToolDef {
  config: {
    title?: string;
    description?: string;
    inputSchema?: Shape;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  cb: (...args: any[]) => Out | Promise<Out>;
}

/** Znacznik w _meta narzędzia wewnętrznego (alternatywa dla prefiksu hook_). */
export const INTERNAL_META = "hipokamp/internal";

/**
 * Narzędzie wewnętrzne: wołane przez własne hooki hipokampa po nazwie (hook_*, albo _meta["hipokamp/internal"]), więc
 * w każdym trybie trafia na serwer od razu pod własną nazwą i nie ma go w memory ani w help.
 */
export const isInternal = (name: string, config: ToolDef["config"]) =>
  name.startsWith("hook_") || config._meta?.[INTERNAL_META] === true;

export interface ToolRegistry {
  /** Narzędzia zwykłe (bez wewnętrznych) w kolejności rejestracji. */
  defs: Map<string, ToolDef>;
  /** Jak McpServer.registerTool. compat i narzędzia wewnętrzne: od razu na serwer; slim: definicja czeka na finish. */
  registerTool: McpServer["registerTool"];
  /** Wystawia zestaw slim (w compat nic nie dokłada). Potem registerTool rzuca błąd. */
  finish(): void;
}

// W slim narzędzie trafia na serwer w finish() pod inną postacią albo jako komenda memory, więc RegisteredTool nie
// istnieje w chwili rejestracji. Zamiast undefined udającego obiekt: wyraźny błąd przy pierwszym użyciu.
function noHandle(name: string): RegisteredTool {
  return new Proxy({} as RegisteredTool, {
    get(_, p) {
      if (typeof p === "symbol" || p === "then") return undefined;
      throw new Error(
        `registerTool(${name}): w trybie mcp.tools=slim narzędzie trafia na serwer dopiero w finish(), uchwyt RegisteredTool nie istnieje (pole ${String(p)}).`,
      );
    },
  });
}

/** Rejestr podstawiany w miejsce McpServer.registerTool, żeby ten sam kod definicji obsłużył compat i slim. */
export function toolRegistry(mcp: McpServer, mode: McpTools): ToolRegistry {
  const defs = new Map<string, ToolDef>();
  const names = new Set<string>();
  let closed = false;
  const registerTool = ((name: string, config: ToolDef["config"], cb: ToolDef["cb"]) => {
    if (closed) throw new Error(`registerTool(${name}) po finish(): zestaw narzędzi jest już na serwerze.`);
    if (names.has(name)) throw new Error(`registerTool(${name}): narzędzie o tej nazwie już jest.`);
    names.add(name);
    if (mode !== "slim" || isInternal(name, config)) {
      if (!isInternal(name, config)) defs.set(name, { config, cb });
      return mcp.registerTool(name, config as any, cb as any); // typy sprawdzono w miejscu definicji (server.ts)
    }
    defs.set(name, { config, cb });
    return noHandle(name);
  }) as McpServer["registerTool"];
  const finish = () => {
    if (closed) throw new Error("finish() drugi raz.");
    closed = true;
    if (mode === "slim") registerSlim(mcp, defs, names);
  };
  return { defs, registerTool, finish };
}

/**
 * Kiedy sięgać po pamięć (obie wersje instrukcji). Bez tego model szukał tylko na wyraźną prośbę: narzędzia hipokampa
 * wywoływała tylko mała część sesji (ok. jedna na osiem), mimo że wstrzyknięty kontekst wskazywał trafne notatki.
 */
export const RECALL_TRIGGERS =
  "Sięgaj sam, bez proszenia, zanim odpowiesz albo zaczniesz: pytanie o wcześniejszą pracę, ustalenie lub decyzję („jak ostatnio”, „co ustaliliśmy”), wznowienie zadania, błąd, który mógł już być, decyzja projektowa w obszarze z historią. Kontekst wstrzyknięty przez hooki to tylko indeks.";

export const SLIM_INSTRUCTIONS = `hipokamp: pamięć między sesjami. ${RECALL_TRIGGERS} search, potem get_observations(ids). Reszta przez memory(cmd, args): cmd to nazwa narzędzia claude-mem (timeline, work_state_read, work_state_write, smart_outline…), args jego parametry; memory(cmd="help", args={cmd}) daje pełny opis. Trwałe fakty i decyzje od razu: remember.`;

const ids = z.union([z.array(z.union([z.number(), z.string()])), z.string(), z.number()]);
const date = z.union([z.string(), z.number()]).optional();
const num = z.coerce.number().optional();

// Parametry narzędzi z góry w trybie slim: krótszy opis albo null, czyli pominięty (platformSource działa tylko dla
// zgodności z claude-mem, obs_type dubluje type).
// Parametry spoza listy (np. dopisane później w compat) przechodzą bez zmian. limit i offset bez .int() (w JSON Schema
// to para minimum/maximum przy każdym polu): handler i tak przycina je przez clampInt. Numery notatek (supersedes)
// mają .int() jak w compat, bo idą do bazy bez zaokrąglania.
const SLIM: Record<string, { description: string; params: Record<string, z.ZodType | null> }> = {
  search: {
    description: "Search past work: notes, sessions, prompts. Index of #IDs; then get_observations.",
    params: {
      query: z.string().optional().describe("Empty = newest first"),
      limit: num,
      project: z.string().optional().describe("Default: all, current first"),
      platformSource: null,
      type: z.string().optional().describe("observations|sessions|prompts or note type (bugfix, decision…)"),
      obs_type: null,
      dateStart: date.describe("ISO, YYYY-MM-DD or epoch"),
      dateEnd: date,
      offset: num,
      orderBy: z.string().optional().describe("relevance|date_desc|date_asc"),
    },
  },
  get_observations: {
    description: "Full notes by #ID (batch several); S<id> = session summary. Warns if a mentioned file changed since.",
    params: {
      ids,
      orderBy: z.string().optional().describe("date_desc|date_asc"),
      limit: num,
      project: z.string().optional(),
      format: z.enum(["markdown", "json"]).optional(),
    },
  },
  remember: {
    description: "Save a durable fact for future sessions: decision with reason, preference, gotcha.",
    params: {
      text: z.string().min(3),
      title: z.string().optional(),
      type: z.string().optional().describe("decision|preference|gotcha|discovery|bugfix|feature|change"),
      facts: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      importance: z.coerce.number().optional().describe("0.6-1.0"),
      supersedes: z.coerce.number().int().optional().describe("ID of the note this replaces"),
      project: z.string().optional(),
    },
  },
};

// po co jest komenda memory (bez wpisu: title narzędzia)
const PURPOSE: Record<string, string> = {
  timeline: "context around a note: ID, S<id>, P<id>",
  get_tool_uses: "raw tool I/O behind notes, last resort",
  important_workflow: "how to search memory",
  work_state_read: "to-do lists across sessions",
  work_state_write: 'item: fields {task, status: todo|doing|done|dropped}, other keys = list state, {status:"done"} closes',
  session_start_context: "start-of-session context",
  forget: "archive notes, undo=true restores",
  build_corpus: "named topic corpus from filters",
  list_corpora: "",
  prime_corpus: "corpus overview",
  reprime_corpus: "",
  query_corpus: "evidence notes for a question",
  rebuild_corpus: "",
  smart_search: "code symbols and text in the project",
  smart_outline: "symbols of a file with lines",
  smart_unfold: "source of one symbol, Class.method ok",
};

const isOptional = (s: z.ZodType) => s.safeParse(undefined).success;
// parametry przyjmowane tylko dla zgodności z claude-mem (opis kończy się na "ignored") nie zajmują miejsca w slim
const ignored = (s: z.ZodType) => /\bignored\b/i.test(s.description ?? "");

function slimShape(name: string, shape: Shape | undefined): Shape | undefined {
  const over = SLIM[name]?.params ?? {};
  if (!shape) return undefined;
  const out: Shape = {};
  for (const [k, s] of Object.entries(shape)) {
    if (k in over) {
      const o = over[k];
      if (o) out[k] = o;
    } else if (!ignored(s)) out[k] = s;
  }
  return out;
}

const signature = (shape: Shape | undefined) =>
  Object.entries(shape ?? {})
    .filter(([, s]) => !ignored(s))
    .map(([k, s]) => `${k}${isOptional(s) ? "?" : ""}`)
    .join(", ");

/** Pełny opis komend (help): opis compat i parametry z opisami. */
function help(defs: Map<string, ToolDef>, which?: unknown): string {
  const names = typeof which === "string" && defs.has(which) ? [which] : [...defs.keys()];
  return names
    .map((n) => {
      const d = defs.get(n)!;
      const params = Object.entries(d.config.inputSchema ?? {})
        .filter(([, s]) => !ignored(s))
        .map(([k, s]) => `- ${k}${isOptional(s) ? " (opcjonalny)" : ""}${s.description ? `: ${s.description}` : ""}`);
      return [`## ${n}`, d.config.description ?? "", ...(params.length ? ["Parametry:", ...params] : [])].join("\n");
    })
    .join("\n\n");
}

const fail = (t: string): Out => ({ content: [{ type: "text", text: t }], isError: true });

/** Zestaw slim na serwerze MCP: narzędzia z SLIM z krótkimi opisami i memory dla reszty. */
function registerSlim(mcp: McpServer, defs: Map<string, ToolDef>, taken: Set<string>): void {
  const reg = (
    name: string,
    config: Omit<ToolDef["config"], "inputSchema"> & { inputSchema?: Shape | z.ZodType },
    cb: ToolDef["cb"],
  ) => mcp.registerTool(name, config as any, cb as any); // typy sprawdzono w miejscu definicji (server.ts)
  if (taken.has("memory")) throw new Error("Nazwa memory jest zajęta przez zestaw slim.");
  const rest: string[] = [];
  for (const [name, d] of defs) {
    const s = SLIM[name];
    if (s) reg(name, { ...d.config, description: s.description, inputSchema: slimShape(name, d.config.inputSchema) }, d.cb);
    else rest.push(name);
  }
  if (!rest.length) return;
  const list = rest
    .map((n) => {
      const what = PURPOSE[n] ?? defs.get(n)?.config.title;
      return `${n}(${signature(defs.get(n)?.config.inputSchema)})${what ? ` ${what}` : ""}`;
    })
    .join("; ");
  reg(
    "memory",
    {
      title: "Memory tools",
      // lista komend tylko w opisie: enum w schemacie powtórzyłby wszystkie nazwy drugi raz
      description: `Other hipokamp tools: cmd = name, args = its parameters (? optional); cmd="help", args={cmd} gives full docs. ${list}`,
      inputSchema: z.object({ cmd: z.string(), args: z.object({}).loose().optional() }).loose(),
    },
    async (a: { cmd: string; args?: Record<string, unknown> } & Record<string, unknown>, extra: unknown) => {
      // parametry przyjmujemy też płasko obok cmd (modele czasem pomijają args)
      const { cmd, args, ...flat } = a;
      const given = { ...flat, ...(args ?? {}) };
      if (cmd === "help") return { content: [{ type: "text", text: help(defs, given.cmd) }] };
      const d = defs.get(cmd);
      if (!d) return fail(`Nie ma komendy ${cmd}. Są: ${rest.join(", ")}, help.`);
      if (!d.config.inputSchema) return d.cb(extra);
      const r = z.object(d.config.inputSchema).safeParse(given);
      if (!r.success) return fail(`memory ${cmd}: złe parametry.\n${z.prettifyError(r.error)}\n\n${help(defs, cmd)}`);
      return d.cb(r.data, extra);
    },
  );
}
