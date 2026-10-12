#!/usr/bin/env bun
// Serwer MCP (stdio) hipokampa. Nazwy i parametry narzędzi jak w claude-mem: search, timeline, get_observations,
// get_tool_uses, work_state_read/write, session_start_context, important_workflow, korpusy i smart_*. Do tego
// remember i forget. Baza jest czytana lokalnie (SQLite WAL); worker potrzebny tylko do wektorów, a gdy nie działa,
// wyszukiwanie spada do FTS. Model embeddingów nigdy nie ładuje się w tym procesie (jedna kopia na maszynę, w workerze).
// mcp.tools = slim wystawia zamiast tego search, get_observations, remember i memory(cmd, args) (src/mcp/tools.ts).
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ensureDataDirs, loadConfig } from "../config.ts";
import { remember } from "../core/remember.ts";
import { openDb } from "../db/db.ts";
import { Repo, rowToObservation, rowToSummary } from "../db/repo.ts";
import { runHook } from "../hooks/handle.ts";
import { ftsSearchPrompts, ftsSearchSummaries } from "../index/fts.ts";
import { initLog, log } from "../log.ts";
import { sessionStartContext } from "../recall/context.ts";
import { type Hit, hybridSearch, loadHits } from "../recall/search.ts";
import { staleness } from "../recall/stale.ts";
import { timeline } from "../recall/timeline.ts";
import { readWorkState, type WsList } from "../recall/workstate.ts";
import type { Observation, Summary } from "../types.ts";
import { fileKey, normPath } from "../util/paths.ts";
import { oneLine, truncate } from "../util/text.ts";
import { VERSION } from "../version.ts";
import * as client from "../worker/client.ts";
import { smartOutline, smartSearch, smartUnfold } from "./code.ts";
import { buildCorpus, type CorpusDeps, listCorpora, primeCorpus, queryCorpus, rebuildCorpus } from "./corpus.ts";
import {
  fmtDay,
  obsJson,
  obsLine,
  obsMarkdown,
  type PromptRow,
  promptLine,
  summaryLine,
  summaryMarkdown,
  timelineMarkdown,
} from "./format.ts";
import { RECALL_TRIGGERS, SLIM_INSTRUCTIONS, toolRegistry } from "./tools.ts";
import { getToolUses } from "./tooluses.ts";

initLog("mcp", false);
ensureDataDirs();
const startCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// ponawianie przy zajętej bazie: budżet sprawdzany po nieudanej próbie, a jedna próba czeka do 5 s (busy_timeout),
// więc najgorzej ok. 15 s plus start procesu, w limicie połączenia klienta (Claude Code: 30 s); pierwsze żądanie
// initialize czeka w stdin, aż transport ruszy
const repo = new Repo(openDb({ vectors: false, busyRetryMs: 10_000 }));

const projectCache = new Map<string, { project: string; at: number }>();
let mergesSeen = repo.projectMerges();
/**
 * Projekt katalogu z pamięcią po katalogu (aliasy czytane od nowa co minutę). Scalenia (`hipokamp project merge`)
 * sprawdzane przy każdym wywołaniu (jeden odczyt meta): po ich zmianie pamięć znika, więc nowy klucz działa od
 * następnego wywołania narzędzia, bez restartu sesji.
 */
function projectOf(dir: string): string {
  const m = repo.projectMerges();
  if (m !== mergesSeen) {
    mergesSeen = m;
    projectCache.clear();
  }
  const k = normPath(dir).toLowerCase();
  const c = projectCache.get(k);
  if (c && Date.now() - c.at < 60_000) return c.project;
  const project = repo.resolveProject(dir);
  projectCache.set(k, { project, at: Date.now() });
  return project;
}

/**
 * Katalog i projekt sesji: liczone przed każdym narzędziem (locate), a nie raz przy starcie, bo sesja może zmienić
 * katalog (worktree, zmiana folderu w aplikacji desktop), a serwer MCP żyje dalej.
 */
let cwd = startCwd;
let currentProject = projectOf(cwd);
let rootsDir: string | null = null;
let rootsStale = true;

/** Katalog sesji od klienta MCP: Claude Code podaje go jako pierwszy root i zgłasza zmianę (roots/list_changed). */
async function sessionDir(): Promise<string> {
  if (rootsStale && mcp.server.getClientCapabilities()?.roots) {
    rootsStale = false;
    try {
      const { roots } = await mcp.server.listRoots(undefined, { timeout: 2000 });
      const uri = roots.find((r) => r.uri.startsWith("file:"))?.uri;
      rootsDir = uri ? fileURLToPath(uri) : null;
    } catch (e) {
      log.debug("roots/list bez odpowiedzi: katalog startowy", String(e));
    }
  }
  return rootsDir ?? startCwd;
}

async function locate(): Promise<void> {
  cwd = await sessionDir();
  currentProject = projectOf(cwd);
}
/** Projekt podany jawnie w narzędziu: przez scalenia (`hipokamp project merge`), żeby stary klucz nie wracał. */
const askedProject = (p: string | null | undefined): string | null => (p?.trim() ? repo.mergedProject(p.trim()) : null);

// ---------------------------------------------------------------- pomocnicze

type Out = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): Out => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): Out => ({ content: [{ type: "text", text: t }], isError: true });

async function run(name: string, f: () => Promise<Out> | Out): Promise<Out> {
  const t0 = performance.now();
  try {
    await locate();
    const r = await f();
    log.debug("narzędzie", { name, ms: Math.round(performance.now() - t0) });
    return r;
  } catch (e) {
    log.error(`narzędzie ${name} padło`, e);
    return fail(`Błąd hipokampa w ${name}: ${String(e).slice(0, 300)}`);
  }
}

function list(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

function normIds(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

function clampInt(v: unknown, lo: number, hi: number, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
}

/** ISO, YYYY-MM-DD (czas lokalny) albo epoch w sekundach lub milisekundach. */
function parseDate(v: unknown, endOfDay = false): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00"}`) : Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

let sessCache = { at: 0, id: null as string | null, project: "" };
/** MCP nie dostaje id sesji, więc bierzemy ostatnio aktywną sesję tego projektu (do sygnałów użycia notatek). */
function currentSession(): string | null {
  if (Date.now() - sessCache.at < 60_000 && sessCache.project === currentProject) return sessCache.id;
  const r = repo.db
    .query(
      "SELECT id FROM sessions WHERE project = ? COLLATE NOCASE AND started_at > ? ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1",
    )
    .get(currentProject, Date.now() - 86_400_000) as { id: string } | null;
  sessCache = { at: Date.now(), id: r?.id ?? null, project: currentProject };
  return sessCache.id;
}

const roots = new Map<string, string | null>();
/** Katalog projektu (do sprawdzania, czy pliki z notatki zmieniły się od jej powstania). */
function rootFor(project: string): string | null {
  const k = project.toLowerCase();
  if (k === currentProject.toLowerCase()) return cwd;
  if (!roots.has(k)) {
    const r = repo.db
      .query("SELECT cwd FROM sessions WHERE project = ? COLLATE NOCASE AND cwd IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .get(project) as {
      cwd: string;
    } | null;
    roots.set(k, r?.cwd ?? null);
  }
  return roots.get(k) ?? null;
}

const stOf = (o: Observation) => staleness(o, rootFor(o.project));
const sameProject = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function getSummaries(ids: number[]): Summary[] {
  if (!ids.length) return [];
  const rows = repo.db.query(`SELECT * FROM summaries WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
  const byId = new Map(rows.map((r) => [r.id as number, rowToSummary(r)]));
  return ids.map((i) => byId.get(i)).filter(Boolean) as Summary[];
}

function getPrompts(ids: number[]): PromptRow[] {
  if (!ids.length) return [];
  const rows = repo.db
    .query(`SELECT id, project, n, text, created_at FROM prompts WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as PromptRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i)).filter(Boolean) as PromptRow[];
}

interface SearchArgs {
  q: string;
  project?: string | null;
  types?: string[];
  since?: number;
  until?: number;
  limit: number;
  /** korpus: pula do 5000 notatek (zwykłe wyszukiwanie do 300) */
  corpus?: boolean;
  /** także archiwum i notatki zastąpione (ze statusem i odsyłaczem do aktualnej wersji w wyniku) */
  archived?: boolean;
}

/** Hybrydowo przez workera (BM25 + bge-m3); gdy worker nie odpowiada, lokalnie sam FTS. */
async function searchObs(a: SearchArgs): Promise<{ hits: { hit: Hit; obs: Observation }[]; vectors: boolean }> {
  const qs = new URLSearchParams({ q: a.q, limit: String(a.limit) });
  if (a.project) qs.set("project", a.project);
  if (a.types?.length) qs.set("type", a.types.join(","));
  if (a.since) qs.set("since", new Date(a.since).toISOString());
  if (a.until) qs.set("until", new Date(a.until).toISOString());
  if (a.corpus) qs.set("corpus", "1");
  if (a.archived) qs.set("archived", "1");
  const s = currentSession();
  if (s) qs.set("session", s);
  const r = await client.call<(Hit & { observation: Observation })[]>(`/api/search?${qs}`, { timeoutMs: 15_000 });
  if (r) return { hits: r.map(({ observation, ...hit }) => ({ hit, obs: observation })), vectors: true };
  const hits = await hybridSearch(repo, null, a.q, {
    project: a.project,
    limit: a.limit,
    types: a.types,
    since: a.since,
    until: a.until,
    useVectors: false,
    includeArchived: a.archived,
  });
  void client.wakeWorker().catch(() => {});
  return { hits: loadHits(repo, hits), vectors: false };
}

function listObservations(f: {
  project: string | null;
  types: string[];
  since?: number;
  until?: number;
  limit: number;
  asc: boolean;
  archived?: boolean;
}): Observation[] {
  const where = [f.archived ? "status IN ('active', 'archived', 'superseded')" : "status = 'active'"];
  const params: (string | number)[] = [];
  if (f.project) {
    where.push("project = ? COLLATE NOCASE");
    params.push(f.project);
  }
  if (f.types.length) {
    where.push(`type IN (${f.types.map(() => "?").join(",")})`);
    params.push(...f.types);
  }
  if (f.since) {
    where.push("created_at >= ?");
    params.push(f.since);
  }
  if (f.until) {
    where.push("created_at <= ?");
    params.push(f.until);
  }
  return (
    repo.db
      .query(`SELECT * FROM observations WHERE ${where.join(" AND ")} ORDER BY created_at ${f.asc ? "ASC" : "DESC"} LIMIT ?`)
      .all(...params, f.limit) as any[]
  ).map(rowToObservation);
}

const fmtVal = (v: unknown) => truncate(oneLine(typeof v === "string" ? v : JSON.stringify(v)), 300);

function renderList(l: WsList, withClosedItems: boolean): string {
  const lines = [`## ${l.name}${l.closed ? " (zamknięta)" : ""} · ${fmtDay(l.updatedAt)}`];
  for (const [k, v] of Object.entries(l.state)) if (k !== "status" || l.closed) lines.push(`- ${k}: ${fmtVal(v)}`);
  const items = l.items.filter((i) => withClosedItems || (i.status !== "done" && i.status !== "dropped"));
  if (items.length) {
    lines.push("Zadania:");
    for (const i of items) {
      const extra = Object.entries(i.fields)
        .filter(([k]) => k !== "status")
        .map(([k, v]) => `${k}=${fmtVal(v)}`)
        .join("; ");
      lines.push(`- [${i.status}] ${i.task}${extra ? ` (${extra})` : ""}`);
    }
  }
  const hidden = l.items.length - items.length;
  if (hidden > 0) lines.push(`(+${hidden} zamkniętych zadań, includeClosed=true je pokaże)`);
  return lines.join("\n");
}

const corpusDeps: CorpusDeps = {
  repo,
  search: async (q, o) =>
    (
      await searchObs({
        q,
        project: o.project ?? null,
        types: o.types,
        since: o.since,
        until: o.until,
        limit: o.limit,
        corpus: true,
      })
    ).hits.map((h) => h.obs.id),
  embedQuery: async (q) => {
    const r = await client.call<{ vector: number[] }>("/api/embed", { body: { text: q, kind: "query" }, timeoutMs: 15_000 });
    return r?.vector?.length ? Float32Array.from(r.vector) : null;
  },
};

// ---------------------------------------------------------------- serwer i narzędzia

const toolsMode = loadConfig().mcp.tools;
const mcp = new McpServer(
  { name: "hipokamp", version: VERSION },
  {
    instructions:
      toolsMode === "slim"
        ? SLIM_INSTRUCTIONS
        : `hipokamp: pamięć między sesjami (lokalna, darmowa). ${RECALL_TRIGGERS} Wznowienie pracy: work_state_read. Szukaj: search, potem timeline(anchor=ID), potem get_observations(ids=[...]); surowe wywołania narzędzi przez get_tool_uses tylko w ostateczności. Trwałe fakty i decyzje zapisuj od razu przez remember, listy zadań przez work_state_write.`,
  },
);
// zmiana katalogu sesji: następne narzędzie pyta klienta o rooty od nowa (zob. sessionDir)
mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
  rootsStale = true;
});
// rejestr w miejsce McpServer.registerTool: compat i narzędzia wewnętrzne (hook_*) od razu na serwer, w slim reszta
// czeka na server.finish() na końcu pliku
const server = toolRegistry(mcp, toolsMode);

const idsSchema = z.union([z.array(z.union([z.number(), z.string()])), z.string(), z.number()]);
const dateSchema = z.union([z.string(), z.number()]).optional();
const listSchema = z.union([z.string(), z.array(z.string())]).optional();

server.registerTool(
  "search",
  {
    title: "Search memory",
    description:
      "Step 1 of the memory workflow: search past work (observations, session summaries, user prompts) with hybrid keyword + semantic ranking. Returns a compact index with IDs (~20 tokens per result). Then use timeline(anchor=ID) for context and get_observations(ids=[...]) for details. Without project: all projects, current project ranked first.",
    inputSchema: {
      query: z.string().optional().describe("Search text, any language. Empty = filter-only listing, newest first."),
      limit: z.coerce.number().int().optional().describe("Max results (default 20, max 100)"),
      project: z.string().optional().describe("Restrict to one project (default: all projects, current one boosted)"),
      platformSource: z.string().optional().describe("Accepted for claude-mem compatibility; ignored"),
      type: z
        .string()
        .optional()
        .describe("observations | sessions | prompts, or an observation type (bugfix, feature, decision, gotcha, ...)"),
      obs_type: z.string().optional().describe("Observation type filter, comma-separated"),
      dateStart: dateSchema.describe("From date: ISO, YYYY-MM-DD or epoch"),
      dateEnd: dateSchema.describe("To date: ISO, YYYY-MM-DD or epoch"),
      offset: z.coerce.number().int().optional(),
      orderBy: z.string().optional().describe("relevance (default with query) | date_desc (default without) | date_asc"),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Also archived and superseded observations (marked with status and → current version)"),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("search", async () => {
      const q = (a.query ?? "").trim();
      const limit = clampInt(a.limit, 1, 100, 20);
      const offset = clampInt(a.offset, 0, 10_000, 0);
      const since = parseDate(a.dateStart);
      const until = parseDate(a.dateEnd, true);
      const project = askedProject(a.project);
      let kinds = new Set(["observations", "sessions", "prompts"]);
      let types = list(a.obs_type).map((t) => t.toLowerCase());
      const t = a.type?.trim().toLowerCase();
      if (t === "observations" || t === "sessions" || t === "prompts") kinds = new Set([t]);
      else if (t === "summaries") kinds = new Set(["sessions"]);
      else if (t) {
        kinds = new Set(["observations"]);
        types = [...types, ...list(t)];
      } else if (types.length) kinds = new Set(["observations"]);
      const order = a.orderBy?.toLowerCase() ?? (q ? "relevance" : "date_desc");
      const only = kinds.size === 1;
      const side = only ? limit : Math.min(5, limit);
      const view = project ?? currentProject;

      let obs: Observation[] = [];
      let vectors = true;
      if (kinds.has("observations")) {
        if (q) {
          const pool = Math.min(300, (limit + offset) * (project ? 1 : 3));
          const r = await searchObs({ q, project, types, since, until, limit: pool, archived: a.includeArchived });
          vectors = r.vectors;
          obs = r.hits
            .map(({ hit, obs: o }) => ({ o, s: hit.rel * (project || sameProject(o.project, currentProject) ? 1.25 : 1) }))
            .sort((x, y) => y.s - x.s)
            .map((x) => x.o);
        } else
          obs = listObservations({
            project,
            types,
            since,
            until,
            limit: limit + offset,
            asc: order === "date_asc",
            archived: a.includeArchived,
          });
        if (order === "date_desc") obs.sort((x, y) => y.created_at - x.created_at);
        else if (order === "date_asc") obs.sort((x, y) => x.created_at - y.created_at);
        obs = obs.slice(offset, offset + limit);
      }

      // sesje i prompty: daty, kierunek i przesunięcie liczy SQL; w trybie mieszanym strona N pokazuje kolejne pozycje
      const sideOffset = only ? offset : Math.floor(offset / limit) * side;
      const sideOrder: "relevance" | "date_desc" | "date_asc" =
        order === "date_asc" || order === "date_desc" ? order : q ? "relevance" : "date_desc";
      const sideOpts = { project, since, until, order: sideOrder, limit: side, offset: sideOffset };
      const listOpts = { project, since, until, asc: order === "date_asc", limit: side, offset: sideOffset };

      let sums: Summary[] = [];
      if (kinds.has("sessions"))
        sums = q ? getSummaries(ftsSearchSummaries(repo.db, q, sideOpts).map((h) => h.id)) : repo.listSummaries(listOpts);

      let prompts: PromptRow[] = [];
      if (kinds.has("prompts"))
        prompts = q ? getPrompts(ftsSearchPrompts(repo.db, q, sideOpts).map((h) => h.id)) : repo.listPrompts(listOpts);

      const scope = project ? `projekt ${project}` : `wszystkie projekty, najpierw ${currentProject}`;
      const fts = vectors ? "" : " · tylko pełnotekstowo (worker z wektorami nie działa)";
      const counts = [
        obs.length && `${obs.length} notatek`,
        sums.length && `${sums.length} sesji`,
        prompts.length && `${prompts.length} promptów`,
      ].filter(Boolean);
      if (!counts.length) return text(`Brak wyników${q ? ` dla "${truncate(q, 80)}"` : ""} (${scope})${fts}.`);
      const out = [`${q ? `Wyniki dla "${truncate(oneLine(q), 80)}"` : "Najnowsze"} (${scope}): ${counts.join(", ")}${fts}`];
      for (const o of obs) out.push(obsLine(o, { currentProject: view, stale: stOf(o).stale }));
      if (sums.length) out.push(only ? "" : "## Sesje", ...sums.map((s) => summaryLine(s, { currentProject: view })));
      if (prompts.length) out.push(only ? "" : "## Prompty", ...prompts.map((p) => promptLine(p, { currentProject: view })));
      out.push("Dalej: timeline(anchor=ID) albo get_observations(ids=[...]).");
      return text(out.filter((l, i) => l !== "" || i === 0).join("\n"));
    }),
);

server.registerTool(
  "timeline",
  {
    title: "Memory timeline",
    description:
      "Step 2: chronological context around an observation: what happened before and after, with user prompts and session summaries. anchor = observation ID (or S<id> for a session summary, P<id> for a prompt). Or give query to find the anchor. No anchor and no query = latest activity in the current project.",
    inputSchema: {
      anchor: z.union([z.number(), z.string()]).optional().describe("Observation ID, S<id> or P<id>"),
      query: z.string().optional().describe("Find the anchor by search when no ID is known"),
      depth_before: z.coerce.number().int().optional().describe("Items before the anchor (default 3)"),
      depth_after: z.coerce.number().int().optional().describe("Items after the anchor (default 3)"),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("timeline", async () => {
      let anchorId: number | null = null;
      let at: number | null = null;
      let project = askedProject(a.project);
      const raw = a.anchor !== undefined && a.anchor !== null ? String(a.anchor).trim() : "";
      if (raw) {
        const m = raw.match(/^([#SP]?)(\d+)$/i);
        if (!m) return fail(`Zła kotwica "${raw}". Podaj id notatki (np. 123), S<id> albo P<id>.`);
        const kind = m[1].toUpperCase();
        const id = Number(m[2]);
        if (kind === "S") {
          const s = getSummaries([id])[0];
          if (!s) return fail(`Nie ma podsumowania S${id}.`);
          at = s.created_at;
          project ??= s.project;
        } else if (kind === "P") {
          const p = getPrompts([id])[0];
          if (!p) return fail(`Nie ma promptu P${id}.`);
          at = p.created_at;
          project ??= p.project;
        } else {
          if (!repo.getObservation(id)) return fail(`Nie ma notatki #${id}.`);
          anchorId = id;
        }
      } else if (a.query?.trim()) {
        let first = (await searchObs({ q: a.query, project: project ?? currentProject, limit: 1 })).hits[0]?.obs;
        if (!first && !project) first = (await searchObs({ q: a.query, limit: 1 })).hits[0]?.obs;
        if (!first) return text(`Nic nie pasuje do "${truncate(a.query, 80)}".`);
        anchorId = first.id;
      }
      const before = clampInt(a.depth_before, 0, 50, 3);
      const after = clampInt(a.depth_after, 0, 50, 3);
      const tl = timeline(repo, { anchor: anchorId, at, project: project ?? (anchorId ? null : currentProject), before, after });
      if (!tl.items.length) return text("Pusta oś czasu.");
      const proj = tl.anchor?.project ?? project ?? currentProject;
      const title = anchorId
        ? `# Oś czasu wokół #${anchorId} · ${proj}`
        : `# Oś czasu ${raw ? `wokół ${raw}` : "(ostatnie)"} · ${proj}`;
      const staleIds = new Set<number>();
      for (const it of tl.items) if (it.kind === "observation" && stOf(it.obs).stale) staleIds.add(it.obs.id);
      return text(
        `${timelineMarkdown(tl.items, { title, currentProject: proj, staleIds })}\nSzczegóły: get_observations(ids=[...]).`,
      );
    }),
);

server.registerTool(
  "get_observations",
  {
    title: "Get observations",
    description:
      "Step 3: full details of observations by ID. Always batch 2+ IDs in one call. Accepts S<id> for session summaries. Shows when files mentioned in a note changed after it was written.",
    inputSchema: {
      ids: idsSchema.describe("Observation IDs, e.g. [123, 456]"),
      orderBy: z.string().optional().describe("date_desc | date_asc (default: order given)"),
      limit: z.coerce.number().int().optional(),
      project: z.string().optional(),
      format: z.enum(["markdown", "json"]).optional().describe("markdown (default, fewer tokens) or json"),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("get_observations", () => {
      const obsIds: number[] = [];
      const sumIds: number[] = [];
      const badIds: string[] = [];
      for (const r of normIds(a.ids)) {
        const m = r.match(/^([#S]?)(\d+)$/i);
        if (!m) badIds.push(r);
        else (m[1].toUpperCase() === "S" ? sumIds : obsIds).push(Number(m[2]));
      }
      let obs = repo.getObservations(obsIds);
      const missing = obsIds.filter((id) => !obs.some((o) => o.id === id));
      const only = askedProject(a.project);
      if (only) obs = obs.filter((o) => sameProject(o.project, only));
      if (a.orderBy === "date_asc") obs.sort((x, y) => x.created_at - y.created_at);
      else if (a.orderBy === "date_desc") obs.sort((x, y) => y.created_at - x.created_at);
      obs = obs.slice(0, clampInt(a.limit, 1, 200, 200));
      repo.logAccess(
        obs.map((o) => o.id),
        "fetched",
        currentSession(),
      );
      const sums = getSummaries(sumIds);
      if (a.format === "json") return text(JSON.stringify([...obs.map((o) => obsJson(o, stOf(o))), ...sums], null, 1));
      const parts = [...obs.map((o) => obsMarkdown(o, stOf(o))), ...sums.map(summaryMarkdown)];
      const notFound = [
        ...missing.map((i) => `#${i}`),
        ...sumIds.filter((i) => !sums.some((s) => s.id === i)).map((i) => `S${i}`),
        ...badIds,
      ];
      if (notFound.length) parts.push(`Nie znaleziono: ${notFound.join(", ")}`);
      return text(parts.join("\n\n") || "Brak notatek o podanych id.");
    }),
);

server.registerTool(
  "get_tool_uses",
  {
    title: "Raw tool uses",
    description:
      "Step 4, last resort: the original tool inputs and outputs behind observations, when the observation itself does not answer the question. Can be thousands of tokens. ids = observation IDs (or tool_use IDs).",
    inputSchema: {
      ids: idsSchema,
      limit: z.coerce.number().int().optional().describe("Max tool uses returned (default 20)"),
      project: z.string().optional(),
      contentSessionId: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("get_tool_uses", () =>
      text(
        getToolUses(repo, normIds(a.ids), {
          limit: a.limit,
          project: askedProject(a.project) ?? undefined,
          contentSessionId: a.contentSessionId,
        }),
      ),
    ),
);

server.registerTool(
  "important_workflow",
  {
    title: "Memory workflow",
    description: "How to search memory efficiently (3 layers, plus raw tool uses as a last resort).",
    annotations: { readOnlyHint: true },
  },
  async () =>
    run("important_workflow", () =>
      text(
        [
          "# Pamięć hipokampa: jak szukać",
          "1. search(query, limit=20, project?) daje indeks: #id, data, typ, tytuł, ~tokeny pełnej notatki. Bez project przeszukuje wszystkie projekty, bieżący pierwszy.",
          "2. timeline(anchor=ID, depth_before=3, depth_after=3) pokazuje, co działo się przed i po (z promptami i podsumowaniami sesji).",
          "3. get_observations(ids=[...]) daje pełne notatki, zawsze kilka id naraz. ⚠ przy notatce znaczy, że opisany plik zmienił się później: sprawdź kod, zanim zaufasz.",
          "4. get_tool_uses(ids=[...]) to surowe wejścia i wyjścia narzędzi, tylko gdy 1-3 nie wystarczą (tysiące tokenów).",
          "",
          "Zapis: remember(text, type=decision|preference|gotcha) dla trwałych faktów; forget(ids) archiwizuje błędne notatki.",
          "Listy zadań: work_state_write(list, fields) i work_state_read(); otwarte listy widać na starcie każdej sesji.",
          "Korpusy: build_corpus(name, filtry), potem query_corpus(name, pytanie) zwraca dowody, odpowiedź składasz sam.",
          "Dlaczego warstwy: indeks kosztuje ~20 tokenów na wynik, pełna notatka ~200-800. Filtruj, zanim pobierzesz.",
        ].join("\n"),
      ),
    ),
);

server.registerTool(
  "work_state_read",
  {
    title: "Read work state",
    description:
      "Read your to-do lists and tracked working state for this project. This is the canonical to-do list across sessions: open lists are also shown at the start of every session.",
    inputSchema: {
      list: z.string().optional().describe("One list by name (default: all)"),
      includeClosed: z.boolean().optional().describe("Include closed lists and finished items"),
      project: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("work_state_read", () => {
      const project = askedProject(a.project) ?? currentProject;
      let lists = readWorkState(repo, project, !!a.includeClosed);
      if (a.list) lists = lists.filter((l) => l.name === a.list);
      if (!lists.length)
        return text(
          a.list
            ? `Lista "${a.list}" w ${project}: ${a.includeClosed ? "nie istnieje" : "nic otwartego"}.`
            : `Nic otwartego dla ${project}. Podaj includeClosed=true, żeby zobaczyć zamknięte.`,
        );
      return text(lists.map((l) => renderList(l, !!a.includeClosed)).join("\n\n"));
    }),
);

server.registerTool(
  "work_state_write",
  {
    title: "Write work state",
    description:
      'Track to-do lists and working state across sessions. One list per to-do list or tracked thing. To-do item: fields {"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...details}. Other keys are list state: the latest value of each key wins, null clears a key, "status": "done" closes the list. Returns what is still open.',
    inputSchema: {
      list: z.string().min(1).describe("List name"),
      fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe("Fields to set"),
      project: z.string().optional(),
    },
  },
  async (a) =>
    run("work_state_write", () => {
      const project = askedProject(a.project) ?? currentProject;
      repo.appendWorkState(project, a.list, a.fields as Record<string, unknown>, Date.now(), "live");
      const l = readWorkState(repo, project, true).find((x) => x.name === a.list);
      if (!l) return text("Zapisane.");
      if (l.closed) return text(`Zapisane. Lista "${a.list}" zamknięta.`);
      return text(`Zapisane.\n${renderList(l, false)}`);
    }),
);

server.registerTool(
  "session_start_context",
  {
    title: "Session start context",
    description:
      "The memory context injected at session start: open work state, recent sessions, most relevant notes, index. Use it to refresh mid-session or to look at another project.",
    inputSchema: {
      project: z.string().optional(),
      projects: listSchema.describe("Several projects, comma-separated or array"),
      platformSource: z.string().optional().describe("Accepted for claude-mem compatibility; ignored"),
      full: z.boolean().optional().describe("Larger budget (about 4000 tokens)"),
      colors: z.boolean().optional().describe("Accepted for claude-mem compatibility; ignored"),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("session_start_context", async () => {
      const names = list(a.projects).length
        ? list(a.projects).map((p) => repo.mergedProject(p))
        : [askedProject(a.project) ?? currentProject];
      const budget = a.full ? 4000 : undefined;
      const parts: string[] = [];
      for (const project of names.slice(0, 5)) {
        const pcwd = sameProject(project, currentProject) ? cwd : rootFor(project);
        const qs = new URLSearchParams({ project, cwd: pcwd ?? "" });
        if (budget) qs.set("budget", String(budget));
        const r =
          (await client.call<{ text: string }>(`/api/context/start?${qs}`, { timeoutMs: 8000 })) ??
          (await sessionStartContext(repo, null, { project, cwd: pcwd, budget }));
        parts.push(r.text);
      }
      return text(parts.join("\n\n"));
    }),
);

server.registerTool(
  "remember",
  {
    title: "Remember",
    description:
      "Save a durable fact so future sessions get it: a decision with its reason, a user preference, a non-obvious gotcha. Stored with high importance and surfaced first. supersedes = ID of an older note that this one replaces. key = short topic name (e.g. 'repo hosting'): a newer decision or preference with the same key automatically replaces older ones in this project (undo: forget with undo=true).",
    inputSchema: {
      text: z.string().min(3).describe("The fact, in full sentences"),
      title: z.string().optional(),
      type: z.string().optional().describe("decision (default) | preference | gotcha | discovery | bugfix | feature | change"),
      facts: z.array(z.string()).optional(),
      files: z.array(z.string()).optional().describe("Related files"),
      importance: z.coerce.number().optional().describe("0.6-1.0 (default 0.8)"),
      supersedes: z.coerce.number().int().optional(),
      key: z.string().optional().describe("Topic key for decision/preference; same key = newer replaces older"),
      project: z.string().optional(),
    },
  },
  async (a) =>
    run("remember", () => {
      const r = remember(repo, {
        project: askedProject(a.project) ?? currentProject,
        text: a.text,
        title: a.title,
        type: a.type?.trim().toLowerCase() || undefined,
        facts: a.facts,
        files: a.files?.map((f) => fileKey(f, cwd)),
        session: currentSession(),
        importance: a.importance,
        supersedes: a.supersedes ?? null,
        key: a.key ?? null,
      });
      void client.call("/api/notify", { body: { kind: "remember" }, timeoutMs: 300 });
      const replaced = [...(r.superseded ? [r.superseded] : []), ...(r.supersededByKey ?? [])];
      return text(
        `Zapamiętane jako #${r.id}${replaced.length ? `, zastępuje ${replaced.map((i) => `#${i}`).join(", ")}` : ""}${r.supersededByKey?.length ? " (ten sam klucz; cofnięcie: forget z undo)" : ""}.`,
      );
    }),
);

server.registerTool(
  "forget",
  {
    title: "Forget",
    description:
      "Archive observations that are wrong or obsolete. Soft delete: hidden from search and context, reversible with undo=true (undo also restores a note replaced by a newer one with the same key).",
    inputSchema: { ids: idsSchema, reason: z.string().optional(), undo: z.boolean().optional() },
  },
  async (a) =>
    run("forget", () => {
      // ta sama ścieżka co „Zapomnij” i „Przywróć” w podglądzie (repo), zmiana statusu leci do podglądu przez SSE.
      // undo przywraca z archiwum i notatki zastąpione (klucz, sen, jawne supersedes); scalonych nie
      const ids = normIds(a.ids)
        .map((raw) => Number(raw.replace(/^#/, "")))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      const changed = a.undo ? repo.restoreObservations(ids) : repo.forgetObservations(ids, a.reason);
      if (changed.length) void client.call("/api/notify", { body: { kind: "status" }, timeoutMs: 300 });
      if (!changed.length) return text("Nic nie zmieniono (złe id albo już w tym stanie).");
      return text(`${a.undo ? "Przywrócone" : "Zarchiwizowane"}: ${changed.map((i) => `#${i}`).join(", ")}.`);
    }),
);

const corpusFilters = {
  project: z.string().optional(),
  types: listSchema,
  concepts: listSchema,
  files: listSchema,
  query: z.string().optional(),
  dateStart: dateSchema,
  dateEnd: dateSchema,
  limit: z.coerce.number().int().optional().describe("Max observations (default 500)"),
};

server.registerTool(
  "build_corpus",
  {
    title: "Build corpus",
    description:
      "Build a named knowledge corpus from memory filters (project, types, concepts, files, query, dates). Free: no LLM gets primed. prime_corpus gives an overview, query_corpus returns the best evidence and you answer from it.",
    inputSchema: { name: z.string().min(1), description: z.string().optional(), ...corpusFilters },
  },
  async (a) =>
    run("build_corpus", async () =>
      text(
        await buildCorpus(corpusDeps, a.name, a.description ?? null, {
          project: askedProject(a.project),
          types: list(a.types),
          concepts: list(a.concepts),
          files: list(a.files),
          query: a.query ?? null,
          since: parseDate(a.dateStart) ?? null,
          until: parseDate(a.dateEnd, true) ?? null,
          limit: clampInt(a.limit, 1, 5000, 500),
        }),
      ),
    ),
);

server.registerTool(
  "list_corpora",
  { title: "List corpora", description: "List knowledge corpora.", annotations: { readOnlyHint: true } },
  async () => run("list_corpora", () => text(listCorpora(repo))),
);

server.registerTool(
  "prime_corpus",
  {
    title: "Prime corpus",
    description:
      "Overview of a corpus to read into your own context (stats, top concepts, most important notes). Replaces claude-mem's paid LLM priming.",
    inputSchema: { name: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async (a) => run("prime_corpus", () => text(primeCorpus(repo, a.name))),
);

server.registerTool(
  "reprime_corpus",
  {
    title: "Reprime corpus",
    description: "Same as prime_corpus (nothing to reset: no LLM session is kept).",
    inputSchema: { name: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async (a) => run("reprime_corpus", () => text(primeCorpus(repo, a.name))),
);

server.registerTool(
  "query_corpus",
  {
    title: "Query corpus",
    description:
      "Ask a question against a corpus: returns the most relevant notes from it as evidence (keyword + semantic). Answer from the evidence and cite #IDs.",
    inputSchema: { name: z.string().min(1), question: z.string().min(2) },
    annotations: { readOnlyHint: true },
  },
  async (a) => run("query_corpus", async () => text(await queryCorpus(corpusDeps, a.name, a.question))),
);

server.registerTool(
  "rebuild_corpus",
  {
    title: "Rebuild corpus",
    description: "Re-run a corpus's saved filters to include new observations.",
    inputSchema: { name: z.string().min(1), force: z.boolean().optional() },
  },
  async (a) => run("rebuild_corpus", async () => text(await rebuildCorpus(corpusDeps, a.name))),
);

server.registerTool(
  "smart_search",
  {
    title: "Search code symbols",
    description:
      "Search code for symbols (functions, classes, types, methods) and text matches across a directory. Lightweight, no index needed. Project only (git root); hidden and secret files are skipped.",
    inputSchema: {
      query: z.string().min(1),
      path: z.string().optional().describe("Directory (default: project root)"),
      file_pattern: z.string().optional().describe("Glob, e.g. *.ts or src/**/*.py"),
      max_results: z.coerce.number().int().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    run("smart_search", () =>
      text(smartSearch(a.query, { path: a.path, filePattern: a.file_pattern, maxResults: a.max_results }, cwd)),
    ),
);

server.registerTool(
  "smart_outline",
  {
    title: "File outline",
    description:
      "Outline of a source file: symbols with line numbers (much cheaper than reading the whole file). Project files only.",
    inputSchema: { file_path: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async (a) => run("smart_outline", () => text(smartOutline(a.file_path, cwd))),
);

server.registerTool(
  "smart_unfold",
  {
    title: "Unfold symbol",
    description:
      "Source of one symbol (function, class, method, heading section) with line numbers, including its doc comment. Project files only.",
    inputSchema: { file_path: z.string().min(1), symbol_name: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async (a) => run("smart_unfold", () => text(smartUnfold(a.file_path, a.symbol_name, cwd))),
);

// ---------------------------------------------------------------- hooki przez MCP (hooks.mode = mcp)

// Claude Code woła te narzędzia z hooków typu mcp_tool zamiast startować proces Buna na każde zdarzenie. Wejście to
// pola payloadu hooka podstawione w hooks.json (src/hooks/modes.ts), logika ta sama co w hook.ts (handle.ts).
// Rejestrowane tylko w trybie mcp, żeby w innych trybach nie zajmowały miejsca na liście narzędzi modelu.
if (loadConfig().hooks.mode === "mcp") {
  /** Pole payloadu: niepodstawione `${…}` (pole, którego to zdarzenie nie ma) i pusty napis znaczą brak. */
  const hv = (v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return !s || /^\$\{[^}]*\}$/.test(s) ? undefined : s;
  };
  const field = z.unknown().optional();
  const base = { session_id: field, transcript_path: field, cwd: field };
  const hookTools: { tool: string; event: string; extra: Record<string, typeof field> }[] = [
    { tool: "hook_prompt", event: "prompt", extra: { prompt: field } },
    { tool: "hook_post_tool", event: "post-tool", extra: { tool_name: field, file_path: field, notebook_path: field } },
    { tool: "hook_stop", event: "stop", extra: {} },
    { tool: "hook_pre_compact", event: "pre-compact", extra: {} },
    { tool: "hook_session_end", event: "session-end", extra: {} },
  ];
  for (const h of hookTools)
    server.registerTool(
      h.tool,
      {
        title: `hipokamp hook ${h.event}`,
        description: "Internal: called by hipokamp's own Claude Code hooks (hooks.mode = mcp). Never call it yourself.",
        inputSchema: { ...base, ...h.extra },
      },
      async (a: Record<string, unknown>) => {
        const t0 = performance.now();
        try {
          const input = {
            session_id: hv(a.session_id),
            transcript_path: hv(a.transcript_path),
            cwd: hv(a.cwd),
            prompt: hv(a.prompt),
            tool_name: hv(a.tool_name),
            tool_input: { file_path: hv(a.file_path), notebook_path: hv(a.notebook_path) },
          };
          // strict: narzędzie może wywołać też model, więc transkrypt musi być transkryptem tej sesji. Projekt z cwd
          // payloadu, bez CLAUDE_PROJECT_DIR (to środowisko ze startu serwera MCP, nie zdarzenia); celowo bez run():
          // hook nie może czekać na pytania do klienta (listRoots) w środku tury
          const r = await runHook(h.event, input, { repo, cwd, strict: true });
          log.debug("hook mcp", { event: h.event, ms: Math.round(performance.now() - t0) });
          return text(r.output ? JSON.stringify(r.output) : "");
        } catch (e) {
          // jak hook Buna: błąd nie dociera do użytkownika, tura wróci z transkryptu (nadrabianie)
          log.error(`hook mcp ${h.event} padł (zignorowany)`, e);
          return text("");
        }
      },
    );
}

server.finish();
await mcp.connect(new StdioServerTransport());
log.info("mcp start", { project: currentProject, pid: process.pid });
// worker w tle daje wektory; nie czekamy na niego
// (starszy worker bez uwierzytelnienia z tego katalogu danych jest zastępowany nowym, T-17)
void client.wakeWorker().catch(() => {});
