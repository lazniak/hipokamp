// Budowanie kontekstu: start sesji, przypomnienie przy prompcie, przypomnienie przy pliku.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { TextEmbedder } from "../index/embedder.ts";
import { log } from "../log.ts";
import type { Observation, Summary } from "../types.ts";
import { fileKey } from "../util/paths.ts";
import { estimateTokens, oneLine, sha1, truncate } from "../util/text.ts";
import { activations, ignorePenalty } from "./activation.ts";
import { filesInText, spread } from "./graph.ts";
import { emptyStages, type PromptTimes, recordPromptTimes, roundTimes } from "./profile.ts";
import { hybridSearch } from "./search.ts";
import { type Candidate, selectUnderBudget } from "./select.ts";
import { staleness } from "./stale.ts";
import { openWorkState, renderWorkState } from "./workstate.ts";

export interface ContextResult {
  text: string;
  ids: number[];
  tokens: number;
  /** koszt w tokenach każdej wstrzykniętej notatki (klucz: id), do recordInjections po stronie hooka */
  costs?: Record<number, number>;
  /** kanał pliku z record=false: klucz pliku, który hook oznaczy jako pokazany razem z zapisem wstrzyknięcia */
  fileKey?: string;
  debug?: Record<string, unknown>;
}

/** Faktów w pełnym wpisie: start sesji i pierwsza pozycja przy prompcie. Render i koszt liczą tyle samo. */
const START_FACTS = 4;
const PROMPT_FACTS = 3;

/** Koszt pełnego wpisu (wybór liczy koszt wiersza indeksu, pełne wpisy mają rezerwę z góry). */
const fullCost = (c: Candidate, facts: number) => estimateTokens(fullEntry(c.obs, c.stale, facts)) + 1;

/** Najwyżej maxTokens: odcina linie od końca i dopisuje wskazówkę, gdzie jest reszta. */
function fitLines(text: string, maxTokens: number, more: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && estimateTokens([...lines, more].join("\n")) > maxTokens) lines.pop();
  return [...lines, more].join("\n");
}

const TYPE_BOOST: Record<string, number> = {
  preference: 1,
  decision: 0.9,
  gotcha: 0.9,
  bugfix: 0.6,
  feature: 0.45,
  refactor: 0.35,
  change: 0.3,
  discovery: 0.25,
};

/** Dziennik decyzji przypomnień (logs/recall-RRRR-MM-DD.jsonl); błąd zapisu nigdy nie psuje hooka. */
function logRecall(entry: Record<string, unknown>): void {
  try {
    appendFileSync(join(paths.logs(), `recall-${fmtDate(Date.now())}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch {}
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function indexLine(o: Observation, stale = false): string {
  return `#${o.id} ${fmtDate(o.created_at).slice(5)} [${o.type}] ${truncate(oneLine(o.title), 110)}${stale ? " ⚠plik zmieniony" : ""}`;
}

export function fullEntry(o: Observation, stale = false, maxFacts = 4): string {
  const facts = o.facts.slice(0, maxFacts).map((f) => `  - ${truncate(oneLine(f), 170)}`);
  const files = o.files_modified.length
    ? `  - pliki: ${o.files_modified
        .slice(0, 4)
        .map((f) => (f.length > 70 ? `…${f.slice(-69)}` : f))
        .join(", ")}`
    : "";
  return [indexLine(o, stale), ...facts, files].filter(Boolean).join("\n");
}

function summaryLine(s: Summary): string {
  const req = truncate(oneLine(s.request ?? ""), 110);
  const done = truncate(oneLine(s.completed ?? ""), 140);
  return `- ${fmtDate(s.created_at).slice(5)}: ${req}${done ? ` → ${done}` : ""}`;
}

interface ScoreInputs {
  rel?: Map<number, number>;
  conf?: Map<number, number>;
  spread?: Map<number, number>;
  cwd: string | null;
  /** projekt cwd: ścieżek notatek z innych projektów nie porównujemy z plikami tego repo */
  project: string;
  weights: { rel: number; act: number; spread: number; imp: number; type: number };
}

function scoreAll(repo: Repo, obs: Observation[], inp: ScoreInputs): Candidate[] {
  const act = activations(repo, obs);
  const vecs = repo.getVectorsQ8(obs.map((o) => o.id));
  const w = inp.weights;
  return obs.map((o) => {
    const why: string[] = [];
    const rel = inp.rel?.get(o.id) ?? 0;
    const sp = inp.spread?.get(o.id) ?? 0;
    const a = act.get(o.id) ?? 0;
    const st = o.project.toLowerCase() === inp.project.toLowerCase() ? staleness(o, inp.cwd) : { stale: false };
    let score = w.rel * rel + w.act * a + w.spread * sp + w.imp * o.importance + w.type * (TYPE_BOOST[o.type] ?? 0.3);
    score -= ignorePenalty(o);
    if (st.stale) score -= 0.08;
    if (o.status !== "active") score -= 0.3;
    if (rel > 0.5) why.push(`trafność ${rel.toFixed(2)}`);
    if (sp > 0.3) why.push(`powiązane pliki ${sp.toFixed(2)}`);
    if (a > 0.6) why.push(`świeże/używane ${a.toFixed(2)}`);
    // koszt wiersza indeksu: tak trafia do kontekstu większość notatek; pełne wpisy kanały liczą osobno (fullCost)
    const tokens = estimateTokens(indexLine(o, st.stale)) + 1;
    return { obs: o, score, tokens, vec: vecs.get(o.id), why, stale: st.stale };
  });
}

// ---------------------------------------------------------------- start sesji

export async function sessionStartContext(
  repo: Repo,
  embedder: TextEmbedder | null,
  args: { project: string; sessionId?: string | null; cwd?: string | null; budget?: number; record?: boolean },
): Promise<ContextResult> {
  const cfg = loadConfig().context;
  const budget = args.budget ?? cfg.sessionStartBudget;
  const parts: string[] = [];
  let used = 0;

  const header = `# Pamięć: ${args.project} (hipokamp)`;
  parts.push(header);
  used += estimateTokens(header);

  // 1. otwarte listy pracy (work state): zawsze na górze, to „pamięć robocza”; najwyżej 40% budżetu
  const ws = openWorkState(repo, args.project);
  if (ws.length) {
    const t = fitLines(renderWorkState(ws, 12), Math.floor(budget * 0.4), "- … (reszta: work_state_read)");
    parts.push(t);
    used += estimateTokens(t);
  }

  // 2. ostatnie sesje (1 linia każda), najwyżej 25% budżetu
  const sums = repo.recentSummaries(args.project, cfg.recentSessions);
  if (sums.length) {
    const t = fitLines(["## Ostatnie sesje", ...sums.map(summaryLine)].join("\n"), Math.floor(budget * 0.25), "- …");
    parts.push(t);
    used += estimateTokens(t);
  }

  // 3. kandydaci: świeże + ważne + powiązane z „ukrytym zapytaniem” (następne kroki, otwarte zadania)
  // pamięć automatyczna Claude Code (source 'automemory', PR #10) poza kandydatami startu, bo Claude Code i tak wczytuje
  // MEMORY.md; odrzucona w zapytaniach, więc nie zajmuje miejsc w limitach 150 i 120 (zostaje w wyszukiwaniu i przy prompcie)
  const recent = repo.recentObservations(args.project, 150, { excludeSources: ["automemory"] });
  const important = (
    repo.db
      .query(
        "SELECT * FROM observations WHERE project = ? COLLATE NOCASE AND status = 'active' AND source <> 'automemory' AND importance >= 0.55 ORDER BY created_at DESC LIMIT 120",
      )
      .all(args.project) as any[]
  ).map((r) => repo.getObservation(r.id)!);
  const implicit = [sums[0]?.next_steps, ...ws.flatMap((l) => l.items.filter((i) => i.status !== "done").map((i) => i.task))]
    .filter(Boolean)
    .join("\n");
  const rel = new Map<number, number>();
  const extra: Observation[] = [];
  if (implicit.trim()) {
    const hits = await hybridSearch(repo, embedder, implicit.slice(0, 1200), {
      project: args.project,
      limit: 40,
      useVectors: !!embedder,
    });
    for (const h of hits) rel.set(h.id, h.rel * Math.max(0.4, h.conf));
    extra.push(...repo.getObservations(hits.map((h) => h.id)));
  }
  const recentFiles = [...new Set(recent.slice(0, 30).flatMap((o) => o.files_modified))].slice(0, 30);
  const sp = spread(repo, args.project, { files: recentFiles });
  const byId = new Map<number, Observation>();
  // trafienia „ukrytego zapytania” to wyszukiwanie: tu automemory odpada po fakcie (PR #10)
  for (const o of [...recent, ...important, ...extra]) if (o && o.source !== "automemory") byId.set(o.id, o);

  const cands = scoreAll(repo, [...byId.values()], {
    rel,
    spread: sp,
    cwd: args.cwd ?? null,
    project: args.project,
    weights: implicit
      ? { rel: 0.3, act: 0.28, spread: 0.12, imp: 0.22, type: 0.08 }
      : { rel: 0, act: 0.4, spread: 0.15, imp: 0.35, type: 0.1 },
  });
  const footer =
    'Szczegóły: get_observations([id]); szukanie: search("…"); kontekst wokół: timeline(anchor=id). ⚠ = plik zmieniony po notatce, sprawdź kod.';
  // wybór liczy koszt wiersza indeksu; najlepsze N (pełne wpisy z faktami) dostaje różnicę jako rezerwę z góry
  const reserve = [...cands]
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.fullCount)
    .reduce((s, c) => s + Math.max(0, fullCost(c, START_FACTS) - c.tokens), 0);
  const room = budget - used - estimateTokens(`## Najważniejsze teraz\n## Indeks pamięci\n${footer}`) - 4;
  const selected =
    room > 0 ? selectUnderBudget(cands, { budget: Math.max(room - reserve, Math.floor(room / 2)), maxItems: 40 }) : [];
  // najlepsze N z faktami, reszta jako indeks (chronologicznie, łatwiej czytać)
  let full = [...selected].sort((a, b) => b.score - a.score).slice(0, cfg.fullCount);
  const fullIds = new Set(full.map((c) => c.obs.id));
  let rest = selected.filter((c) => !fullIds.has(c.obs.id)).sort((a, b) => b.score - a.score);
  const render = (): string => {
    const out = [...parts];
    const idx = [...rest].sort((a, b) => b.obs.created_at - a.obs.created_at);
    if (full.length) out.push(["## Najważniejsze teraz", ...full.map((c) => fullEntry(c.obs, c.stale, START_FACTS))].join("\n"));
    if (idx.length) out.push(["## Indeks pamięci", ...idx.map((c) => indexLine(c.obs, c.stale))].join("\n"));
    if (full.length || idx.length) out.push(footer);
    return out.join("\n\n");
  };
  // gdy całość przekracza budżet: najpierw odpadają najsłabsze wiersze indeksu, potem najsłabszy pełny wpis
  // schodzi do indeksu (i może odpaść w następnym kroku)
  let text = render();
  while (estimateTokens(text) > budget && (full.length || rest.length)) {
    if (rest.length) rest = rest.slice(0, -1);
    else {
      rest = full.slice(-1);
      full = full.slice(0, -1);
    }
    text = render();
  }
  const chosen = [...full, ...rest];
  const costs: Record<number, number> = {};
  for (const c of full) costs[c.obs.id] = fullCost(c, START_FACTS);
  for (const c of rest) costs[c.obs.id] = c.tokens;
  const ids = chosen.map((c) => c.obs.id);
  if (args.sessionId && ids.length && args.record !== false)
    repo.recordInjections(args.sessionId, ids, "start", new Map(ids.map((id) => [id, costs[id]])));
  return {
    text,
    ids,
    tokens: estimateTokens(text),
    costs,
    debug: { candidates: cands.length, chosen: chosen.length, full: full.length, implicit: !!implicit },
  };
}

// ---------------------------------------------------------------- prompt (just-in-time)

const TRIVIAL =
  /^(ok|okej|okay|tak|nie|dzięki|dzieki|thx|thanks|super|git|dobra|jasne|kontynuuj|continue|dalej|go|yes|no|y|n)[\s.!?]*$/i;

/** Trafienie z innego projektu musi mieć co najmniej taką pewność; lokalne tak pewne zwalnia z globalnego FTS. */
const GLOBAL_MIN_CONF = 0.75;

export async function promptContext(
  repo: Repo,
  embedder: TextEmbedder | null,
  /** preview: podgląd z CLI, bez zapisu wstrzyknięć i logu decyzji; zamiast null zwraca powód. */
  args: { project: string; sessionId: string; prompt: string; cwd?: string | null; preview?: boolean; record?: boolean },
): Promise<ContextResult | null> {
  const cfg = loadConfig().context;
  const p = args.prompt.trim();
  if (!cfg.promptRecall || p.length < 12 || TRIVIAL.test(p) || /^\/\S+$/.test(p)) return null;
  const t0 = performance.now();
  const tm = emptyStages();
  const q = p.length > 1500 ? `${p.slice(0, 1000)}\n${p.slice(-400)}` : p;
  const already = repo.injectedIds(args.sessionId);
  // wektor zapytania raz, dla wyszukiwania lokalnego i (w razie potrzeby) globalnego; błąd modelu to samo FTS
  let qv: Float32Array | null = null;
  if (embedder) {
    const t = performance.now();
    try {
      [qv] = await embedder.embed([q], "query");
    } catch (e) {
      log.warn("wektor zapytania nieudany, przypomnienie tylko z FTS", e);
    }
    tm.embed += performance.now() - t;
  }
  const useVec = !!qv;
  const local = await hybridSearch(repo, useVec ? embedder : null, q, {
    project: args.project,
    limit: 24,
    useVectors: useVec,
    queryVector: qv,
    timings: tm,
  });
  // inne projekty: KNN bez partycji bieżącego projektu (jego trafienia już są) zawsze, bo wektor zapytania już jest,
  // a mocne trafienie obce bywa lepsze od średniego lokalnego. Globalne FTS (najdroższy etap) tylko przy słabym
  // lokalnym: żadna niewstrzyknięta notatka projektu nie ma pewności, jakiej i tak wymagamy od trafienia obcego
  const localTop = local.reduce((m, h) => (already.has(h.id) ? m : Math.max(m, h.conf)), 0);
  const runGlobal = useVec && localTop < GLOBAL_MIN_CONF;
  const global = useVec
    ? await hybridSearch(repo, embedder, q, {
        excludeProject: args.project,
        limit: 12,
        useVectors: true,
        queryVector: qv,
        timings: tm,
        skipFts: !runGlobal,
      })
    : [];
  const tRank = performance.now();
  const relMap = new Map<number, number>();
  const confMap = new Map<number, number>();
  for (const h of local) {
    relMap.set(h.id, h.rel);
    confMap.set(h.id, h.conf);
  }
  for (const h of global) {
    if (relMap.has(h.id)) continue;
    // inne projekty: tylko mocne trafienia
    if (h.conf < GLOBAL_MIN_CONF) continue;
    relMap.set(h.id, h.rel * 0.7);
    confMap.set(h.id, h.conf * 0.9);
  }
  const ids = [...relMap.keys()].filter((id) => !already.has(id));
  // log decyzji (także „would-have-fired” pod progiem) do strojenia progów: bez treści promptu
  const best = ids
    .map((id) => ({ id, conf: Number((confMap.get(id) ?? 0).toFixed(3)) }))
    .sort((a, b) => b.conf - a.conf)
    .slice(0, 5);
  /** Czas etapów do logu decyzji, profilu workera (/api/health) i podglądu. */
  const times = (): PromptTimes => ({
    ...tm,
    rank: tm.rank + (performance.now() - tRank),
    total: performance.now() - t0,
    global: runGlobal,
  });
  const note = (outcome: string, ms: PromptTimes, fired: number[] = []) => {
    if (args.preview) return;
    recordPromptTimes(ms);
    logRecall({
      at: Date.now(),
      session: args.sessionId,
      project: args.project,
      len: p.length,
      hash: sha1(p).slice(0, 12),
      vectors: useVec,
      min: cfg.promptMinScore,
      best,
      outcome,
      fired,
      ms: roundTimes(ms),
    });
  };
  const miss = (outcome: string): ContextResult | null => {
    const ms = times();
    note(outcome, ms);
    return args.preview
      ? { text: "", ids: [], tokens: 0, debug: { outcome, best, min: cfg.promptMinScore, vectors: useVec, ms: roundTimes(ms) } }
      : null;
  };
  if (!ids.length) return miss(local.length || global.length ? "już-wstrzyknięte" : "brak-kandydatów");
  const top = Math.max(...ids.map((id) => confMap.get(id) ?? 0));
  if (top < cfg.promptMinScore) return miss("poniżej-progu");
  const files = filesInText(p).map((f) => fileKey(f, args.cwd ?? null));
  const sp = files.length ? spread(repo, args.project, { files }) : new Map<number, number>();
  const obs = repo.getObservations(ids);
  const cands = scoreAll(repo, obs, {
    rel: relMap,
    spread: sp,
    cwd: args.cwd ?? null,
    project: args.project,
    weights: { rel: 0.55, act: 0.12, spread: 0.13, imp: 0.15, type: 0.05 },
  }).filter((c) => (confMap.get(c.obs.id) ?? 0) >= cfg.promptMinScore * 0.85);
  // pierwsza (najlepsza) z faktami, reszta jednym wierszem; wybór liczy wiersze, pierwsza ma rezerwę na fakty
  const header = "Pamięć powiązana z tą prośbą (hipokamp; szczegóły: get_observations):";
  const lead = cands.reduce<Candidate | null>((m, c) => (!m || c.score > m.score ? c : m), null);
  const reserve = lead ? Math.max(0, fullCost(lead, PROMPT_FACTS) - lead.tokens) : 0;
  const room = cfg.promptBudget - estimateTokens(header) - 1;
  const picked =
    room > 0
      ? selectUnderBudget(cands, { budget: Math.max(room - reserve, Math.floor(room / 2)), maxItems: 5, diversity: 0.6 }).sort(
          (a, b) => b.score - a.score,
        )
      : [];
  if (!picked.length) return miss("pusty-wybór");
  // najsłabsze odpadają, dopóki tekst nie zmieści się w budżecie; w ostateczności pierwsza też jednym wierszem
  const render = (list: Candidate[], firstFull: boolean) =>
    [
      header,
      ...list.map((c, i) => (i === 0 && firstFull ? fullEntry(c.obs, c.stale, PROMPT_FACTS) : indexLine(c.obs, c.stale))),
    ].join("\n");
  let chosen = picked;
  let firstFull = true;
  let text = render(chosen, true);
  while (estimateTokens(text) > cfg.promptBudget && chosen.length > 1) {
    chosen = chosen.slice(0, -1);
    text = render(chosen, true);
  }
  if (estimateTokens(text) > cfg.promptBudget) {
    firstFull = false;
    text = render(chosen, false);
  }
  const out = chosen.map((c) => c.obs.id);
  const costs: Record<number, number> = Object.fromEntries(
    chosen.map((c, i) => [c.obs.id, i === 0 && firstFull ? fullCost(c, PROMPT_FACTS) : c.tokens]),
  );
  // record=false: kontekst idzie do hooka, który zapisze wstrzyknięcie dopiero po odebraniu odpowiedzi
  const ms = times();
  note(args.record === false ? "zwrócone" : "wstrzyknięte", ms, out);
  if (!args.preview && args.record !== false)
    repo.recordInjections(args.sessionId, out, "prompt", new Map(out.map((id) => [id, costs[id]])));
  return {
    text,
    ids: out,
    tokens: estimateTokens(text),
    costs,
    debug: { top, best, ms: roundTimes(ms) },
  };
}
// ---------------------------------------------------------------- plik (PostToolUse Read/Edit)

const FILE_TYPES = new Set(["gotcha", "decision", "bugfix", "preference"]);

export function fileContext(
  repo: Repo,
  args: { project: string; sessionId: string; filePath: string; cwd?: string | null; record?: boolean },
): ContextResult | null {
  const cfg = loadConfig().context;
  if (!cfg.fileRecall) return null;
  const key = fileKey(args.filePath, args.cwd ?? null);
  const ent = repo.entityIds("file", args.project, [key]).get(key);
  if (!ent) return null;
  // record=false (natywny hook): plik oznaczamy i wstrzyknięcie zapisujemy dopiero po potwierdzeniu, że wynik dotarł
  const record = args.record !== false;
  const rows = repo.db
    .query(
      `SELECT o.id FROM obs_entities oe JOIN observations o ON o.id = oe.obs_id
       WHERE oe.entity_id = ? AND o.status = 'active' AND (o.importance >= 0.45 OR o.type IN ('gotcha','decision','bugfix','preference'))
       ORDER BY o.created_at DESC LIMIT 30`,
    )
    .all(ent.id) as { id: number }[];
  if (!rows.length) return null;
  if (record ? !repo.markFileInjected(args.sessionId, key) : repo.fileInjected(args.sessionId, key)) return null;
  const already = repo.injectedIds(args.sessionId);
  const obs = repo.getObservations(rows.map((r) => r.id)).filter((o) => !already.has(o.id));
  if (!obs.length) return null;
  const cands = scoreAll(repo, obs, {
    cwd: args.cwd ?? null,
    project: args.project,
    weights: { rel: 0, act: 0.35, spread: 0, imp: 0.4, type: 0.25 },
  }).map((c) => ({
    ...c,
    score: c.score + (FILE_TYPES.has(c.obs.type) ? 0.1 : 0),
  }));
  // kanał pliku pokazuje same wiersze indeksu, więc i wybór liczy ich koszt; nagłówek też waży
  const header = `Pamięć o pliku ${key}:`;
  const room = cfg.fileBudget - estimateTokens(header) - 1;
  if (room <= 0) return null;
  let chosen = selectUnderBudget(cands, { budget: room, maxItems: 3, minScore: 0.35 });
  if (!chosen.length) return null;
  const render = (list: Candidate[]) => [header, ...list.map((c) => indexLine(c.obs, c.stale))].join("\n");
  let text = render(chosen);
  while (estimateTokens(text) > cfg.fileBudget && chosen.length > 1) {
    chosen = chosen.slice(0, -1);
    text = render(chosen);
  }
  const ids = chosen.map((c) => c.obs.id);
  const costs: Record<number, number> = Object.fromEntries(chosen.map((c) => [c.obs.id, c.tokens]));
  if (!record) return { text, ids, tokens: estimateTokens(text), costs, fileKey: key };
  repo.recordInjections(args.sessionId, ids, "file", new Map(ids.map((id) => [id, costs[id]])));
  return { text, ids, tokens: estimateTokens(text), costs };
}
