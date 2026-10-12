// Import bazy wiedzy claude-mem (~/.claude-mem/claude-mem.db) — tylko odczyt źródła, przyrostowo.
// Zachowuje numery obserwacji (#id) i podsumowań, więc odwołania typu „#1234” dalej działają. Gdy numer jest już
// zajęty przez inną notatkę (claude-mem nadaje kolejne numery po imporcie), notatka dostaje nowy numer, a oryginał
// zostaje w meta.cm_id. Nic nie jest pomijane po cichu, kursor przesuwa się tylko nad zapisanymi wierszami.
// Każdy tekst przechodzi przez clean() (redakcja sekretów), jak tekst z transkryptu. Klucze plików liczone względem
// katalogu repo projektu (core/filekeys.ts). W sesjach przenumerowanych przez `hipokamp repair` prompty, notatki
// i podsumowania trafiają pod nowe numery (sessions.meta.cm_n), a prompt już zapisany pod innym numerem jest pomijany.
// Surowe tool_uses (145 tys. wierszy, większość objętości bazy) NIE są kopiowane — zostają w archiwum claude-mem.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clean } from "../capture/redact.ts";
import { fileKeyNormalizer } from "../core/filekeys.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { mapMergedProject, type Repo } from "../db/repo.ts";
import { log as fileLog } from "../log.ts";
import type { EntityRef, NewObservation, Summary } from "../types.ts";
import { fileKey, normPath } from "../util/paths.ts";
import { estimateTokens } from "../util/text.ts";

export interface ImportOptions {
  dbPath?: string;
  dryRun?: boolean;
  log?: (m: string) => void;
}

/** Baza claude-mem: CLAUDE_MEM_DB albo ~/.claude-mem/claude-mem.db. */
export function claudeMemDbPath(): string {
  return process.env.CLAUDE_MEM_DB || join(homedir(), ".claude-mem", "claude-mem.db");
}

/** Ujednolicenie typów generowanych przez LLM (ponad 700 wariantów) do zbioru kanonicznego; oryginał w meta. */
export function normalizeType(t: string): string {
  const x = (t ?? "").toLowerCase().trim();
  if (
    [
      "bugfix",
      "fix",
      "bug",
      "bug-fix",
      "defect",
      "fix-deployed",
      "resolution",
      "root-cause-identified",
      "hotfix",
      "error",
    ].includes(x)
  )
    return "bugfix";
  if (
    [
      "feature",
      "feature-enhancement",
      "feature-implementation",
      "feature-addition",
      "implementation",
      "implementation-complete",
      "enhancement",
      "create",
      "new-header",
      "ui-enhancement",
      "integration",
      "cli-integration",
      "build-integration",
    ].includes(x)
  )
    return "feature";
  if (
    [
      "refactor",
      "refactoring",
      "cleanup",
      "code-quality",
      "optimization",
      "final-optimization",
      "improvement",
      "refinement",
      "simplification",
    ].includes(x)
  )
    return "refactor";
  if (
    [
      "change",
      "modification",
      "code-change",
      "update",
      "state-change",
      "what-changed",
      "configuration",
      "deployment",
      "maintenance",
      "version-control",
      "commit",
      "documentation-update",
    ].includes(x)
  )
    return "change";
  if (["decision", "trade-off", "architecture", "specification", "spec_gap"].includes(x)) return "decision";
  if (["security_alert", "sensitive", "security_note", "critical-finding", "critical-issue", "gotcha", "warning"].includes(x))
    return "gotcha";
  if (
    [
      "discovery",
      "finding",
      "research-finding",
      "research-discovery",
      "reconnaissance",
      "inspection",
      "code-inspection",
      "analysis",
      "api-discovery",
      "diagnostic",
      "investigation",
      "how-it-works",
      "context",
      "info",
    ].includes(x)
  )
    return "discovery";
  if (
    x.includes("verif") ||
    x.includes("validat") ||
    x.includes("test") ||
    x.includes("audit") ||
    x.includes("review") ||
    x.includes("build") ||
    x.includes("success") ||
    x.includes("status") ||
    x.includes("checkpoint")
  )
    return "change";
  if (x.includes("fix") || x.includes("bug")) return "bugfix";
  if (x.includes("refactor")) return "refactor";
  if (x.includes("feature") || x.includes("implement")) return "feature";
  if (x.includes("decision")) return "decision";
  return "discovery";
}

const TYPE_IMPORTANCE: Record<string, number> = {
  decision: 0.62,
  gotcha: 0.58,
  bugfix: 0.48,
  feature: 0.45,
  refactor: 0.38,
  change: 0.33,
  discovery: 0.28,
};

function arr(s: unknown): string[] {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => x != null).map(String) : typeof v === "string" ? [v] : [];
  } catch {
    return s.split(/\n|,\s*/).filter(Boolean);
  }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** Redakcja pola z zachowaniem null (clean() zamienia brak wartości na pusty napis). */
const red = (s: unknown): string | null => (s == null ? null : clean(String(s)));

/**
 * Klucz encji grafu: redakcja przed i po normalizacji (małe litery). Pierwsza łapie wzorce zależne od wielkości liter,
 * druga ujednolica znacznik, więc klucz jest punktem stałym clean() i naprawa go nie rusza.
 */
const entityKey = (s: string): string => clean(clean(s).toLowerCase());

/** Redakcja wszystkich napisów w strukturze (pola list pracy). */
export function redDeep(v: unknown): unknown {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(redDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redDeep(x)]));
  return v;
}

type SessionInfo = { sid: string | null; project: string | null; cwd: string | null };

/** Otwarte źródło: baza claude-mem tylko do odczytu i mapowanie sesji (memory_session_id → content_session_id). */
export interface ClaudeMemSource {
  db: Database;
  sessions: any[];
  sidOf(memorySessionId: string): SessionInfo;
  /** Klucz projektu z claude-mem po scaleniach hipokampa (`hipokamp project merge`). */
  project(key: string | null | undefined): string;
  /** Numer promptu claude-mem w sesji po przenumerowaniu w `hipokamp repair` (sessions.meta.cm_n). */
  promptN(sessionId: string | null, n: number): number;
  /** Klucz pliku po fileKey i redakcji, względem katalogu repo projektu (core/filekeys.ts). */
  fileKey(file: string, cwd: string | null, project: string): string;
  close(): void;
}

export interface OpenClaudeMemOptions {
  /** Przenumerowania z naprawy (Repo.cmPromptMaps): sesja → numer claude-mem → numer w hipokampie. */
  promptMaps?: Map<string, Map<number, number>>;
  /** Normalizacja klucza pliku względem repo projektu (fileKeyNormalizer); bez niej sam fileKey. */
  normFile?: (key: string, project: string) => string;
}

/**
 * Źródło dla importu w bazie hipokampa: scalenia projektów (żeby import nie wskrzeszał scalonych kluczy), numery
 * promptów po naprawie i klucze plików względem repo.
 */
export function openClaudeMemFor(repo: Repo, path: string): ClaudeMemSource {
  const nz = fileKeyNormalizer(repo.db);
  return openClaudeMem(path, repo.projectMerges(), { promptMaps: repo.cmPromptMaps(), normFile: (k, p) => nz.norm(k, p) });
}

/** `merges`: scalenia projektów hipokampa (Repo.projectMerges), żeby import nie wskrzeszał scalonych kluczy. */
export function openClaudeMem(
  path: string,
  merges: Map<string, string> = new Map(),
  opts: OpenClaudeMemOptions = {},
): ClaudeMemSource {
  const db = new Database(path, { readonly: true });
  db.run("PRAGMA query_only = 1");
  const sessions = db.query("SELECT * FROM sdk_sessions ORDER BY id").all() as any[];
  const byMemory = new Map<string, { sid: string; project: string; cwd: string | null }>();
  const byContent = new Map<string, { project: string; cwd: string | null }>();
  for (const s of sessions) {
    if (s.memory_session_id) byMemory.set(s.memory_session_id, { sid: s.content_session_id, project: s.project, cwd: s.cwd });
    byContent.set(s.content_session_id, { project: s.project, cwd: s.cwd });
  }
  const sidOf = (memorySessionId: string): SessionInfo => {
    const m = byMemory.get(memorySessionId);
    if (m) return { sid: m.sid, project: m.project, cwd: m.cwd };
    const uuid = memorySessionId?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
    const c = uuid ? byContent.get(uuid) : undefined;
    return { sid: uuid, project: c?.project ?? null, cwd: c?.cwd ?? null };
  };
  const project = (key: string | null | undefined) => mapMergedProject(merges, key || "unknown");
  const maps = opts.promptMaps ?? new Map<string, Map<number, number>>();
  const promptN = (sid: string | null, n: number) => (sid ? maps.get(sid)?.get(n) : undefined) ?? n;
  const norm = opts.normFile ?? ((k: string) => k);
  const fileKeyOf = (file: string, cwd: string | null, p: string) => norm(clean(fileKey(file, cwd)), p);
  return { db, sessions, sidOf, project, promptN, fileKey: fileKeyOf, close: () => db.close() };
}

/** Czas utworzenia wiersza claude-mem (razem ze źródłem: tożsamość notatki przy ponownym imporcie). */
export const cmCreatedAt = (r: { created_at_epoch?: number | null; created_at?: string | null }): number =>
  r.created_at_epoch ?? (Date.parse(r.created_at ?? "") || 0);

/** Obserwacja claude-mem → notatka hipokampa: typ kanoniczny, encje grafu, redakcja sekretów. Bez numeru. */
export function convertObservation(r: any, src: ClaudeMemSource): { obs: NewObservation; ents: EntityRef[] } {
  const s = src.sidOf(r.memory_session_id);
  const project = src.project(r.merged_into_project || r.project || s.project);
  const cwd = s.cwd;
  const filesReadRaw = arr(r.files_read);
  const filesModRaw = arr(r.files_modified);
  // adresy mogą nieść dane logowania (użytkownik i hasło przed „@” hosta), ścieżki parametry (raport.html?token=...): wszystko
  // przez clean(), także klucze encji i kolumna plików w FTS
  const urls = [...filesReadRaw, ...filesModRaw].filter(isUrl);
  // klucz pliku względem repo projektu także bez katalogu sesji i z worktree, którego już nie ma (core/filekeys.ts)
  const filesRead = [...new Set(filesReadRaw.filter((f) => !isUrl(f)).map((f) => src.fileKey(f, cwd, project)))];
  const filesMod = [...new Set(filesModRaw.filter((f) => !isUrl(f)).map((f) => src.fileKey(f, cwd, project)))];
  const concepts = arr(r.concepts).map(clean);
  const type = normalizeType(r.type);
  const occ = Number(r.occurrence_count ?? 1);
  const relc = Number(r.relevance_count ?? 0);
  let importance = TYPE_IMPORTANCE[type] ?? 0.3;
  importance += Math.min(0.15, 0.04 * Math.log2(occ + relc));
  if (concepts.includes("gotcha")) importance += 0.08;
  const ents: EntityRef[] = [
    ...filesMod.map((k) => ({ kind: "file" as const, key: k, role: "modified" as const })),
    ...filesRead.filter((k) => !filesMod.includes(k)).map((k) => ({ kind: "file" as const, key: k, role: "read" as const })),
    ...concepts.map((c) => ({ kind: "concept" as const, key: entityKey(c), role: "concept" as const })),
    ...urls.slice(0, 5).map((u) => ({
      kind: "url" as const,
      key: clean(
        clean(u)
          .replace(/^https?:\/\//, "")
          .replace(/[?#].*$/, "")
          .replace(/\/+$/, ""),
      ),
      role: "mentioned" as const,
    })),
  ];
  const obs: NewObservation = {
    session_id: s.sid,
    project,
    prompt_n: r.prompt_number == null ? null : src.promptN(s.sid, r.prompt_number),
    type,
    tier: "episodic",
    title: clean(r.title || r.subtitle || (r.text ? String(r.text).slice(0, 100) : `obserwacja ${r.id}`)),
    subtitle: red(r.subtitle),
    narrative: red(r.narrative),
    facts: arr(r.facts).map(clean),
    concepts,
    files_read: [...filesRead, ...urls.filter((u) => filesReadRaw.includes(u)).map(clean)],
    files_modified: filesMod,
    text: red(r.text),
    created_at: cmCreatedAt(r),
    importance: Math.min(0.95, Math.round(importance * 1000) / 1000),
    source: "claude-mem",
    content_hash: r.content_hash ?? null,
    occurrence_count: occ,
    access_count: relc,
    last_access_at: r.last_reinforced ? Date.parse(r.last_reinforced) || null : null,
    meta: {
      cm_type: r.type,
      model: r.generated_by_model ?? null,
      discovery_tokens: r.discovery_tokens ?? 0,
      agent_type: r.agent_type ?? null,
      memory_session_id: r.memory_session_id,
    },
  };
  return { obs, ents };
}

/** Podsumowanie claude-mem → podsumowanie hipokampa (z redakcją sekretów). Bez numeru. */
export function convertSummary(
  r: any,
  src: ClaudeMemSource,
): Omit<Summary, "id"> & { id?: number; meta: Record<string, unknown> } {
  const s = src.sidOf(r.memory_session_id);
  const cwd = s.cwd;
  const project = src.project(r.merged_into_project || r.project || s.project);
  const file = (f: string) => (isUrl(f) ? clean(f) : src.fileKey(f, cwd, project));
  return {
    session_id: s.sid,
    project,
    request: red(r.request),
    investigated: red(r.investigated),
    learned: red(r.learned),
    completed: red(r.completed),
    next_steps: red(r.next_steps),
    notes: red(r.notes),
    files_read: arr(r.files_read).map(file),
    files_edited: arr(r.files_edited).map(file),
    prompt_n: r.prompt_number == null ? null : src.promptN(s.sid, r.prompt_number),
    created_at: cmCreatedAt(r),
    source: "claude-mem",
    meta: { discovery_tokens: r.discovery_tokens ?? 0 },
  };
}

type CmTable = "observations" | "summaries";

/** Numery claude-mem zapisane wcześniej pod nowym #id (meta.cm_id). */
export function rekeyedIds(db: Database, table: CmTable): Set<number> {
  const rows = db
    .query(
      `SELECT CAST(json_extract(meta, '$.cm_id') AS INTEGER) c FROM ${table} WHERE source = 'claude-mem' AND meta LIKE '%"cm_id"%'`,
    )
    .all() as { c: number | null }[];
  return new Set(rows.filter((r) => r.c != null).map((r) => r.c as number));
}

/**
 * Gdzie trafi wiersz claude-mem: `known` = ta sama notatka już jest (ten sam numer, źródło claude-mem i czas
 * utworzenia albo hash; albo zapisana wcześniej pod nowym numerem), `free` = numer wolny, `taken` = numer zajęty
 * przez inną notatkę (np. z backfillu): zapis pod nowym numerem.
 */
export function cmPlacement(db: Database, table: CmTable, r: any, rekeyed: Set<number>): "known" | "free" | "taken" {
  if (rekeyed.has(r.id)) return "known";
  const ex = db
    .query(
      `SELECT source, created_at, ${table === "observations" ? "content_hash" : "NULL AS content_hash"} FROM ${table} WHERE id = ?`,
    )
    .get(r.id) as { source: string; created_at: number; content_hash: string | null } | null;
  if (!ex) return "free";
  const same =
    ex.source === "claude-mem" && (ex.created_at === cmCreatedAt(r) || (!!r.content_hash && ex.content_hash === r.content_hash));
  return same ? "known" : "taken";
}

export interface Stored {
  outcome: "known" | "inserted" | "rekeyed";
  id: number | null;
}

/** Zapis obserwacji claude-mem: ten sam #id, a gdy numer zajęty przez inną notatkę, nowy numer i meta.cm_id. */
export function storeObservation(repo: Repo, r: any, src: ClaudeMemSource, rekeyed: Set<number>): Stored {
  const place = cmPlacement(repo.db, "observations", r, rekeyed);
  if (place === "known") return { outcome: "known", id: null };
  const { obs, ents } = convertObservation(r, src);
  if (place === "taken") obs.meta = { ...obs.meta, cm_id: r.id };
  else obs.id = r.id;
  const { id } = repo.insertObservation(obs, ents);
  if (place === "taken") rekeyed.add(r.id);
  return { outcome: place === "taken" ? "rekeyed" : "inserted", id };
}

/** Zapis podsumowania claude-mem (te same zasady numeru co obserwacje). */
export function storeSummary(repo: Repo, r: any, src: ClaudeMemSource, rekeyed: Set<number>): Stored {
  const place = cmPlacement(repo.db, "summaries", r, rekeyed);
  if (place === "known") return { outcome: "known", id: null };
  const s = convertSummary(r, src);
  if (place === "taken") s.meta = { ...s.meta, cm_id: r.id };
  else s.id = r.id;
  const id = repo.insertSummary(s);
  if (place === "taken") rekeyed.add(r.id);
  return { outcome: place === "taken" ? "rekeyed" : "inserted", id };
}

export async function importClaudeMem(repo: Repo, opts: ImportOptions = {}): Promise<Record<string, number>> {
  const log = opts.log ?? (() => {});
  const path = opts.dbPath ?? claudeMemDbPath();
  if (!existsSync(path)) {
    log(`brak bazy claude-mem: ${path}`);
    return {};
  }
  const src = openClaudeMemFor(repo, path);
  const cm = src.db;
  const db = repo.db;
  const t0 = performance.now();
  const stats: Record<string, number> = {
    sessions: 0,
    prompts: 0,
    promptsKnown: 0,
    promptsTaken: 0,
    observations: 0,
    observationsRekeyed: 0,
    observationsKnown: 0,
    summaries: 0,
    summariesRekeyed: 0,
    summariesKnown: 0,
    workState: 0,
    workStateKnown: 0,
    aliases: 0,
  };

  // --- sesje + aliasy projektów
  if (!opts.dryRun) {
    db.transaction(() => {
      for (const s of src.sessions) {
        repo.upsertSession({
          id: s.content_session_id,
          project: src.project(s.project),
          cwd: s.cwd ?? null,
          title: red(s.custom_title),
          first_prompt: s.user_prompt ? clean(s.user_prompt) : null,
          started_at: s.started_at_epoch,
          ended_at: s.completed_at_epoch ?? null,
          last_activity_at: s.completed_at_epoch ?? s.started_at_epoch,
          prompt_count: s.prompt_counter ?? 0,
          source: "claude-mem",
          model: s.observed_model ?? null,
          status: s.status === "active" ? "active" : "ended",
        });
        stats.sessions++;
        // klucz złożony repo/worktree (albo submoduł) bez aliasu: alias przykryłby regułę hipokampa, która daje
        // worktree klucz repo, i nowe notatki z tego katalogu poszłyby pod klucz złożony
        const key = s.project ? src.project(s.project) : null;
        if (s.cwd && key && !key.includes("/")) {
          repo.setProjectAlias(s.cwd, key, "claude-mem");
          stats.aliases++;
        }
      }
    })();
  }
  log(`sesje: ${src.sessions.length}`);

  // --- prompty
  const projectOf = new Map<string, string>(src.sessions.map((s) => [s.content_session_id, src.project(s.project)]));
  const lastPrompt = Number(getMeta(db, "cm_last_prompt_id") ?? 0);
  const prompts = cm
    .query(
      "SELECT id, content_session_id, prompt_number, prompt_text, created_at_epoch FROM user_prompts WHERE id > ? ORDER BY id",
    )
    .all(lastPrompt) as any[];
  if (!opts.dryRun && prompts.length) {
    db.transaction(() => {
      for (const p of prompts) {
        const text = clean(p.prompt_text ?? "");
        // ten sam prompt pod innym numerem (naprawa przenumerowała prompty claude-mem): ponowny import go nie dubluje
        if (repo.hasPrompt(p.content_session_id, text, p.created_at_epoch)) {
          stats.promptsKnown++;
          continue;
        }
        const id = repo.insertPrompt({
          session_id: p.content_session_id,
          project: projectOf.get(p.content_session_id) ?? src.project(null),
          n: src.promptN(p.content_session_id, p.prompt_number),
          text,
          created_at: p.created_at_epoch,
          source: "claude-mem",
        });
        if (id) stats.prompts++;
        else stats.promptsTaken++;
      }
      setMeta(db, "cm_last_prompt_id", String(prompts[prompts.length - 1].id));
    })();
  }
  log(
    `prompty: ${prompts.length}${stats.promptsKnown ? ` (już w bazie: ${stats.promptsKnown})` : ""}${stats.promptsTaken ? ` (numer w sesji już zajęty, pominięte: ${stats.promptsTaken})` : ""}`,
  );

  // --- obserwacje (partiami; id zachowane, kolizje pod nowym numerem)
  const rekeyedObs = rekeyedIds(db, "observations");
  const lastObs = Number(getMeta(db, "cm_last_obs_id") ?? 0);
  const total = (cm.query("SELECT COUNT(*) c FROM observations WHERE id > ?").get(lastObs) as { c: number }).c;
  log(`obserwacje do importu: ${total}`);
  const page = cm.query("SELECT * FROM observations WHERE id > ? ORDER BY id LIMIT 2000");
  const countObs = (o: Stored["outcome"]) =>
    stats[o === "known" ? "observationsKnown" : o === "rekeyed" ? "observationsRekeyed" : "observations"]++;
  let cursor = lastObs;
  while (true) {
    const rows = page.all(cursor) as any[];
    if (!rows.length) break;
    if (!opts.dryRun) {
      db.transaction(() => {
        for (const r of rows) countObs(storeObservation(repo, r, src, rekeyedObs).outcome);
        // każdy wiersz partii jest zapisany albo rozpoznany jako już zaimportowany; błąd cofa partię razem z kursorem
        setMeta(db, "cm_last_obs_id", String(rows[rows.length - 1].id));
      })();
    } else
      for (const r of rows) {
        const p = cmPlacement(db, "observations", r, rekeyedObs);
        countObs(p === "known" ? "known" : p === "taken" ? "rekeyed" : "inserted");
      }
    cursor = rows[rows.length - 1].id;
    log(`  … ${stats.observations + stats.observationsRekeyed + stats.observationsKnown}/${total}`);
  }
  if (stats.observationsRekeyed) {
    log(`obserwacje z zajętym numerem, zapisane pod nowym #id (oryginał w meta.cm_id): ${stats.observationsRekeyed}`);
    if (!opts.dryRun) fileLog.warn("import claude-mem: kolizje numerów obserwacji", { rekeyed: stats.observationsRekeyed });
  }

  // --- podsumowania sesji (id zachowane, kolizje pod nowym numerem)
  const rekeyedSum = rekeyedIds(db, "summaries");
  const lastSum = Number(getMeta(db, "cm_last_summary_id") ?? 0);
  const sums = cm.query("SELECT * FROM session_summaries WHERE id > ? ORDER BY id").all(lastSum) as any[];
  const countSum = (o: Stored["outcome"]) =>
    stats[o === "known" ? "summariesKnown" : o === "rekeyed" ? "summariesRekeyed" : "summaries"]++;
  if (!opts.dryRun && sums.length) {
    db.transaction(() => {
      for (const r of sums) countSum(storeSummary(repo, r, src, rekeyedSum).outcome);
      setMeta(db, "cm_last_summary_id", String(sums[sums.length - 1].id));
    })();
  } else if (opts.dryRun)
    for (const r of sums) {
      const p = cmPlacement(db, "summaries", r, rekeyedSum);
      countSum(p === "known" ? "known" : p === "taken" ? "rekeyed" : "inserted");
    }
  log(`podsumowania: ${sums.length}`);
  if (stats.summariesRekeyed) {
    log(`podsumowania z zajętym numerem, zapisane pod nowym #id (oryginał w meta.cm_id): ${stats.summariesRekeyed}`);
    if (!opts.dryRun) fileLog.warn("import claude-mem: kolizje numerów podsumowań", { rekeyed: stats.summariesRekeyed });
  }

  // --- work state (dziennik wpisów 1:1). Numer wpisu claude-mem w cm_id: ponowny import od zera niczego nie dubluje
  //     (stary wpis dopisany za nowszymi cofałby status listy)
  const lastWs = Number(getMeta(db, "cm_last_ws_id") ?? 0);
  const ws = cm.query("SELECT * FROM work_state_entries WHERE id > ? ORDER BY id").all(lastWs) as any[];
  if (!opts.dryRun && ws.length) {
    const byCm = db.query("SELECT id FROM work_state WHERE cm_id = ?");
    // wpis z importu sprzed zapisywania numeru: ten sam projekt, lista i czas; dostaje numer zamiast kopii
    const legacy = db.query(
      "SELECT id FROM work_state WHERE source = 'claude-mem' AND cm_id IS NULL AND project = ? AND list_name = ? AND created_at = ? ORDER BY id LIMIT 1",
    );
    db.transaction(() => {
      for (const w of ws) {
        if (byCm.get(w.id)) {
          stats.workStateKnown++;
          continue;
        }
        const project = src.project(w.project);
        const old = legacy.get(project, w.list_name, w.created_at_epoch) as { id: number } | null;
        if (old) {
          db.run("UPDATE work_state SET cm_id = ? WHERE id = ?", [w.id, old.id]);
          stats.workStateKnown++;
          continue;
        }
        let fields: Record<string, unknown> = {};
        try {
          fields = JSON.parse(w.fields);
        } catch {}
        repo.appendWorkState(
          project,
          w.list_name,
          redDeep(fields) as Record<string, unknown>,
          w.created_at_epoch,
          "claude-mem",
          w.id,
        );
        stats.workState++;
      }
      setMeta(db, "cm_last_ws_id", String(ws[ws.length - 1].id));
    })();
  }
  log(`work state: ${ws.length}`);

  // oszczędności: ile tokenów claude-mem wydał na „odkrycie” (do porównań kosztu)
  const disc = cm.query("SELECT COALESCE(SUM(discovery_tokens),0) t FROM observations").get() as { t: number };
  if (!opts.dryRun) {
    setMeta(db, "cm_imported_at", String(Date.now()));
    setMeta(db, "cm_discovery_tokens", String(disc.t));
  }
  src.close();
  stats.ms = Math.round(performance.now() - t0);
  log(`import ${opts.dryRun ? "(próba) " : ""}zakończony w ${Math.round(stats.ms / 1000)} s: ${JSON.stringify(stats)}`);
  log(`(suma discovery_tokens w claude-mem: ~${(disc.t / 1e6).toFixed(1)} mln)`);
  return stats;
}

export { estimateTokens, normPath };
