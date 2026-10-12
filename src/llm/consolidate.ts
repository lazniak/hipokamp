// Opcjonalna konsolidacja lokalnym LLM (Ollama), domyślnie wyłączona (`consolidation.llm.enabled`). Dwa zadania:
// 1) sprzeczności: pary aktywnych decyzji i preferencji tego samego projektu o podobnej treści (cosinus wektorów,
//    bez wektorów wspólne słowa kluczowe) ocenia model; sprzeczność trafia do meta.llm.conflicts obu notatek
//    z odsyłaczem do drugiej i powodem;
// 2) lekcje: jedno zdanie „na przyszłość” dla najważniejszych notatek (meta.llm.lesson).
// Nigdy nie zmienia treści, typu, statusu ani ważności notatek: wyniki są dodatkowymi polami, widocznymi w
// get_observations i `hipokamp show`. Wsadowo, z limitem wywołań i czasu; worker uruchamia przebieg w bezczynności
// i przerywa go pierwszym żądaniem (AbortSignal). Nigdy w ścieżce hooka, nigdy sieć poza 127.0.0.1.
// Część snu: SQL wprost (wyjątek z CLAUDE.md), tylko odczyt kandydatów i dopisywanie pól meta.
import { clean } from "../capture/redact.ts";
import type { LlmConfig } from "../config.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { type Repo, rowToObservation } from "../db/repo.ts";
import { cosQ8 } from "../index/vectors.ts";
import { log } from "../log.ts";
import type { Observation } from "../types.ts";
import { slicer } from "../util/slice.ts";
import { keywords, normKey, oneLine, truncate } from "../util/text.ts";
import { type ChatFn, type ChatMessage, LlmTransportError, ollamaChat, parseJsonObject } from "./ollama.ts";

export interface LlmConflict {
  a: number;
  b: number;
  project: string;
  reason: string;
}

export interface LlmReport {
  model: string;
  calls: number;
  pairsChecked: number;
  conflicts: LlmConflict[];
  lessons: { id: number; text: string }[];
  ms: number;
  /** Dlaczego przebieg skończył się przed wyczerpaniem pracy (limit, przerwanie, błąd Ollamy). */
  stopped?: string;
}

export interface LlmRunOptions {
  signal?: AbortSignal;
  /** Atrapa modelu w testach; domyślnie Ollama z konfiguracji. */
  chat?: ChatFn;
  now?: () => number;
  /** Nadpisanie limitu wywołań (CLI `--max`). */
  maxCalls?: number;
}

const ABORTED = "przerwane (aktywność)";
const PAIRS_KEY = "llm_pairs_checked";
const MAX_PAIRS_KEPT = 5000;
/** Podobieństwo pary: od tego progu model ją ocenia; od 0,965 to już duplikat (scala go zwykły sen). */
const COS_MIN = 0.78;
const COS_DUP = 0.965;
/** Bez wektorów: wspólne rdzenie słów kluczowych (Jaccard). Próg niski, bo to tylko wstępne sito przed modelem. */
const JACCARD_MIN = 0.25;
/** Najwięcej notatek na projekt branych do par (najważniejsze): ogranicza kwadratową liczbę par. */
const PER_PROJECT = 120;
const CONFLICT_TYPES = ["decision", "preference"];
const LESSON_TYPES = ["decision", "gotcha", "bugfix", "preference"];

const SYSTEM: ChatMessage = {
  role: "system",
  content: "Oceniasz notatki z pamięci projektów programistycznych. Odpowiadasz wyłącznie jednym obiektem JSON.",
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const noteText = (o: Observation, max: number) =>
  `${oneLine(o.title)}\n${truncate([o.narrative ?? "", ...o.facts].join("\n").trim(), max)}`.trim();

/** Rdzenie słów kluczowych: bez ogonków i ucięte do 6 znaków („repozytoria” i „repozytorium” to jedno słowo). */
function kwSet(o: Observation): Set<string> {
  return new Set(keywords(`${o.title}\n${o.narrative ?? ""}`, 14).map((w) => normKey(w).slice(0, 6)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const w of a) if (b.has(w)) i++;
  return i / (a.size + b.size - i);
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function checkedPairs(repo: Repo): string[] {
  try {
    const v = JSON.parse(getMeta(repo.db, PAIRS_KEY) ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

type Candidate = { a: Observation; b: Observation; sim: number };

/** Porównań par w jednym kroku (między krokami worker oddaje pętlę zdarzeń). */
const PAIRS_PER_STEP = 4000;

/** Pary do oceny: ten sam projekt, ten sam rodzaj sprawy (decyzja albo preferencja), podobna treść, jeszcze nieoceniane. */
function* candidateSteps(repo: Repo, checked: Set<string>): Generator<void, Candidate[]> {
  // najważniejsze PER_PROJECT na projekt już w SQL (okno), żeby nie budować obiektów dla całej bazy
  const rows = repo.db
    .query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY lower(project) ORDER BY importance DESC, id DESC) rn
         FROM observations WHERE status = 'active' AND type IN (${CONFLICT_TYPES.map(() => "?").join(",")}) AND source <> 'llm'
       ) WHERE rn <= ? ORDER BY importance DESC, id DESC`,
    )
    .all(...CONFLICT_TYPES, PER_PROJECT) as any[];
  yield;
  const byProject = new Map<string, Observation[]>();
  for (const r of rows) {
    const o = rowToObservation(r);
    const k = o.project.toLowerCase();
    const list = byProject.get(k) ?? [];
    if (list.length < PER_PROJECT) list.push(o);
    byProject.set(k, list);
  }
  const out: Candidate[] = [];
  let work = 0;
  for (const list of byProject.values()) {
    if (list.length < 2) continue;
    const vecs = repo.getVectorsQ8(list.map((o) => o.id));
    const kws = new Map(list.map((o) => [o.id, kwSet(o)]));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (++work % PAIRS_PER_STEP === 0) yield;
        const [a, b] = list[i].id < list[j].id ? [list[i], list[j]] : [list[j], list[i]];
        if (checked.has(pairKey(a.id, b.id))) continue;
        const va = vecs.get(a.id);
        const vb = vecs.get(b.id);
        let sim: number;
        if (va && vb) {
          sim = cosQ8(va, vb);
          if (sim < COS_MIN || sim >= COS_DUP) continue;
        } else {
          sim = jaccard(kws.get(a.id)!, kws.get(b.id)!);
          if (sim < JACCARD_MIN) continue;
        }
        out.push({ a, b, sim });
      }
    yield;
  }
  return out.sort((x, y) => y.sim - x.sim);
}

/** Pary kandydatów naraz (CLI, testy). */
export function conflictCandidates(repo: Repo, checked: Set<string>): Candidate[] {
  const g = candidateSteps(repo, checked);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * Pary kandydatów porcjami z przerwami ze slicera (worker: przerwa co ok. 40 ms pracy); przerwanie kończy wcześniej
 * (pusta lista, a llmConsolidate nie zalicza wtedy przebiegu).
 */
export async function conflictCandidatesAsync(
  repo: Repo,
  checked: Set<string>,
  signal?: AbortSignal,
  pause = slicer(),
): Promise<Candidate[]> {
  const g = candidateSteps(repo, checked);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (signal?.aborted) return [];
    await pause();
  }
}

export function conflictPrompt(a: Observation, b: Observation): ChatMessage[] {
  return [
    SYSTEM,
    {
      role: "user",
      content: [
        `Projekt: ${a.project}`,
        `Notatka A (#${a.id}, ${day(a.created_at)}, ${a.type}): ${noteText(a, 700)}`,
        "",
        `Notatka B (#${b.id}, ${day(b.created_at)}, ${b.type}): ${noteText(b, 700)}`,
        "",
        "Czy A i B są ze sobą sprzeczne, czyli zalecają albo stwierdzają rzeczy, których nie da się stosować naraz?",
        "Różne tematy, uzupełnienie albo doprecyzowanie to NIE jest sprzeczność.",
        'Odpowiedz JSON: {"sprzeczne": true albo false, "powod": "jedno krótkie zdanie po polsku"}',
      ].join("\n"),
    },
  ];
}

export function lessonPrompt(o: Observation): ChatMessage[] {
  return [
    SYSTEM,
    {
      role: "user",
      content: [
        `Notatka z pamięci projektu ${o.project} (${o.type}, ${day(o.created_at)}): ${noteText(o, 1200)}`,
        "",
        "Napisz jedną lekcję na przyszłość wynikającą z tej notatki: jedno zdanie po polsku, najwyżej 160 znaków,",
        "konkretne (co robić albo czego unikać), bez wstępów i bez numerów notatek.",
        'Odpowiedz JSON: {"lekcja": "..."}',
      ].join("\n"),
    },
  ];
}

const truthy = (v: unknown) => v === true || (typeof v === "string" && /^(tak|true|yes)$/i.test(v.trim()));

/** Dopisuje pole do meta.llm notatki w transakcji (odczyt, zmiana, zapis); treść notatki bez zmian. */
function patchLlm(repo: Repo, id: number, fn: (llm: Record<string, any>) => void): void {
  repo.db
    .transaction(() => {
      const r = repo.db.query("SELECT meta FROM observations WHERE id = ?").get(id) as { meta: string | null } | null;
      if (!r) return;
      let meta: Record<string, any> = {};
      try {
        meta = JSON.parse(r.meta ?? "{}") ?? {};
      } catch {}
      const llm = typeof meta.llm === "object" && meta.llm ? meta.llm : {};
      fn(llm);
      meta.llm = llm;
      repo.db.run("UPDATE observations SET meta = ? WHERE id = ?", [JSON.stringify(meta), id]);
    })
    .immediate();
}

/** Notatki do lekcji: najważniejsze (ważność plus użycie), jeszcze bez lekcji. */
function lessonCandidates(repo: Repo, limit: number): Observation[] {
  if (limit <= 0) return [];
  return (
    repo.db
      .query(
        `SELECT * FROM observations WHERE status = 'active' AND type IN (${LESSON_TYPES.map(() => "?").join(",")}) AND source <> 'llm'
           AND json_extract(meta, '$.llm.lesson') IS NULL
         ORDER BY importance + MIN(access_count, 10) * 0.03 DESC, id DESC LIMIT ?`,
      )
      .all(...LESSON_TYPES, limit) as any[]
  ).map(rowToObservation);
}

/** Jeden przebieg konsolidacji. Każda ocena zapisuje się od razu, więc przerwany przebieg nie traci pracy. */
export async function llmConsolidate(repo: Repo, cfg: LlmConfig, opts: LlmRunOptions = {}): Promise<LlmReport> {
  const clock = opts.now ?? Date.now;
  const t0 = clock();
  const rep: LlmReport = { model: cfg.model, calls: 0, pairsChecked: 0, conflicts: [], lessons: [], ms: 0 };
  const finish = (stopped?: string, mark = true): LlmReport => {
    rep.ms = clock() - t0;
    if (stopped) rep.stopped = stopped;
    // przerwanie aktywnością nie liczy się jako przebieg: dokończy następna bezczynność
    if (mark) setMeta(repo.db, "last_llm_at", String(clock()));
    setMeta(repo.db, "last_llm_report", JSON.stringify({ ...rep, conflicts: rep.conflicts.length, lessons: rep.lessons.length }));
    log.info("sen z LLM", {
      model: rep.model,
      wywołania: rep.calls,
      sprzeczności: rep.conflicts.length,
      lekcje: rep.lessons.length,
      ms: rep.ms,
      stop: rep.stopped,
    });
    return rep;
  };
  if (!cfg.model.trim()) return finish("brak modelu (consolidation.llm.model)");
  let chat: ChatFn;
  try {
    chat = opts.chat ?? ollamaChat(cfg);
  } catch (e: any) {
    return finish(String(e?.message ?? e));
  }
  const maxCalls = Math.max(0, opts.maxCalls ?? cfg.maxCallsPerRun);
  const deadline = t0 + cfg.maxRunSec * 1000;
  const budgetLeft = (): string | null =>
    opts.signal?.aborted ? ABORTED : rep.calls >= maxCalls ? "limit wywołań" : clock() >= deadline ? "limit czasu" : null;
  const ask = async (messages: ChatMessage[]) => {
    rep.calls++;
    return parseJsonObject((await chat(messages, { signal: opts.signal, json: true })).content);
  };

  try {
    if (cfg.contradictions) {
      const checked = checkedPairs(repo);
      // przy włączonych lekcjach pary dostają połowę budżetu, a niewykorzystana reszta przechodzi na lekcje
      const cap = cfg.lessons ? Math.ceil(maxCalls / 2) : maxCalls;
      const pairs = await conflictCandidatesAsync(repo, new Set(checked), opts.signal);
      // przerwanie w trakcie liczenia par daje pustą listę: bez tego sprawdzenia przebieg kończyłby się jak udany
      // (last_llm_at), a sprzeczności czekałyby do następnego terminu (everyHours)
      if (opts.signal?.aborted) return finish(ABORTED, false);
      for (const { a, b } of pairs) {
        const stop = budgetLeft();
        if (stop) return finish(stop, stop !== ABORTED);
        if (rep.calls >= cap) break;
        const j = await ask(conflictPrompt(a, b));
        rep.pairsChecked++;
        checked.push(pairKey(a.id, b.id));
        setMeta(repo.db, PAIRS_KEY, JSON.stringify(checked.slice(-MAX_PAIRS_KEPT)));
        if (!j || !truthy(j.sprzeczne ?? j.contradiction ?? j.contradictory)) continue;
        const reason = truncate(oneLine(clean(String(j.powod ?? j.reason ?? ""))), 240) || "model uznał notatki za sprzeczne";
        const at = clock();
        const newer = Math.max(a.id, b.id);
        // powód (tekst modelu, na który wpływa treść obu notatek) tylko przy nowszej, przy starszej sam odsyłacz:
        // tekst wymuszony treścią jednej notatki nie pojawia się pod drugą
        for (const [self, other] of [
          [a, b],
          [b, a],
        ] as const)
          patchLlm(repo, self.id, (llm) => {
            const list = Array.isArray(llm.conflicts) ? llm.conflicts : [];
            if (!list.some((c: any) => c?.with === other.id))
              list.push({ with: other.id, newer, ...(self.id === newer ? { reason } : {}), model: cfg.model, at });
            llm.conflicts = list;
          });
        rep.conflicts.push({ a: a.id, b: b.id, project: a.project, reason });
      }
    }
    if (cfg.lessons) {
      // o jedną więcej niż zostało wywołań: wtedy limit, który zatrzymał pracę, trafia do raportu
      for (const o of lessonCandidates(repo, maxCalls - rep.calls + 1)) {
        const stop = budgetLeft();
        if (stop) return finish(stop, stop !== ABORTED);
        const j = await ask(lessonPrompt(o));
        const text = truncate(oneLine(clean(String(j?.lekcja ?? j?.lesson ?? ""))), 200);
        // pusta odpowiedź też się zapisuje (text: null): ta sama notatka nie wraca w każdym przebiegu
        patchLlm(repo, o.id, (llm) => {
          llm.lesson = { text: text || null, model: cfg.model, at: clock() };
        });
        if (text) rep.lessons.push({ id: o.id, text });
      }
    }
    // przerwanie po ostatnim wywołaniu (albo przy pustej liście lekcji) też nie zalicza przebiegu
    if (opts.signal?.aborted) return finish(ABORTED, false);
  } catch (e: any) {
    // Ollama nie działa albo nie zdążyła: przebieg zaliczony (bez ponawiania w każdej bezczynności); przerwanie nie
    if (e instanceof LlmTransportError) return opts.signal?.aborted ? finish(ABORTED, false) : finish(e.message);
    throw e;
  }
  return finish();
}
