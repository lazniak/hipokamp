// Formatowanie wyników narzędzi MCP: zwięzły markdown zamiast JSON-a (ta sama treść co w claude-mem, mniej tokenów).
// Linia indeksu ma ten sam kształt co w kontekście startowym: `#id MM-DD [typ] tytuł`.

import { promptRef } from "../../viewer/prompt-number.js";
import type { Staleness } from "../recall/stale.ts";
import type { TimelineItem } from "../recall/timeline.ts";
import type { Observation, Summary } from "../types.ts";
import { oneLine, truncate } from "../util/text.ts";

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Numer promptu w tekście: numer tury jak dotąd („prompt 3”), numer zastępczy jako numer jego tury, prompt
 * claude-mem bez tury z numerem z claude-mem (zakresy: viewer/prompt-number.js, ten sam podział co w podglądzie).
 */
export function promptLabel(n: number): string {
  const r = promptRef(n);
  if (r.kind === "cm") return `bez tury (claude-mem nr ${r.n})`;
  if (r.kind === "subst") return `prompt ${r.n} (numer zastępczy)`;
  return `prompt ${r.n}`;
}

export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** MM-DD w bieżącym roku, pełna data w innych latach. */
export function shortDay(ms: number, now = Date.now()): string {
  const d = fmtDay(ms);
  return d.startsWith(String(new Date(now).getFullYear())) ? d.slice(5) : d;
}

export interface LineOpts {
  /** Projekt bieżącej sesji — inne projekty dostają znacznik {projekt}. */
  currentProject?: string | null;
  stale?: boolean;
  anchor?: boolean;
  /** W osi czasu: sama godzina (data jest w nagłówku dnia). */
  timeOnly?: boolean;
}

const foreign = (project: string, current?: string | null) => !!current && project.toLowerCase() !== current.toLowerCase();
const when = (ms: number, timeOnly?: boolean) => (timeOnly ? fmtTime(ms) : shortDay(ms));

export function obsLine(o: Observation, opts: LineOpts = {}): string {
  const proj = foreign(o.project, opts.currentProject) ? ` {${o.project}}` : "";
  // nieaktywna (wyszukiwanie z includeArchived, oś czasu): status i aktualna wersja, jak w get_observations
  const target = o.status === "active" ? null : (o.merged_into ?? o.superseded_by);
  const status = o.status !== "active" ? ` (${o.status}${target ? ` → #${target}` : ""})` : "";
  const flags = `${opts.stale ? " ⚠plik zmieniony" : ""}${status}${opts.anchor ? " ◀ KOTWICA" : ""}`;
  return `- #${o.id} ${when(o.created_at, opts.timeOnly)} [${o.type}]${proj} ${truncate(oneLine(o.title), 120)}${flags} ~${o.tokens}`;
}

export function summaryLine(s: Summary, opts: LineOpts = {}): string {
  const proj = foreign(s.project, opts.currentProject) ? ` {${s.project}}` : "";
  const req = truncate(oneLine(s.request ?? ""), 120);
  const done = truncate(oneLine(s.completed ?? s.learned ?? ""), 160);
  return `- S${s.id} ${when(s.created_at, opts.timeOnly)} [sesja]${proj} ${req}${done ? ` | zrobione: ${done}` : ""}`;
}

export interface PromptRow {
  id: number;
  project: string;
  n: number;
  text: string;
  created_at: number;
}

export function promptLine(p: PromptRow, opts: LineOpts = {}): string {
  const proj = foreign(p.project, opts.currentProject) ? ` {${p.project}}` : "";
  return `- P${p.id} ${when(p.created_at, opts.timeOnly)} [${promptLabel(p.n)}]${proj} "${truncate(oneLine(p.text), 160)}"`;
}

/** Pełna notatka (warstwa 3: get_observations). */
export function obsMarkdown(o: Observation, st?: Staleness | null): string {
  const lines = [
    `## #${o.id} [${o.type}] ${fmtDay(o.created_at)} ${fmtTime(o.created_at)} · ${o.project}${o.prompt_n ? ` · ${promptLabel(o.prompt_n)}` : ""}`,
    `**${oneLine(o.title)}**`,
  ];
  if (o.subtitle) lines.push(oneLine(o.subtitle));
  const body = (o.narrative ?? o.text ?? "").trim();
  if (body) lines.push("", body);
  if (o.facts.length) lines.push("", "Fakty:", ...o.facts.map((f) => `- ${oneLine(f)}`));
  const extra = llmNoteLines(o.meta);
  if (extra.length) lines.push("", ...extra);
  const meta: string[] = [];
  if (o.files_modified.length) meta.push(`Pliki zmienione: ${o.files_modified.join(", ")}`);
  if (o.files_read.length)
    meta.push(
      `Pliki czytane: ${o.files_read.slice(0, 12).join(", ")}${o.files_read.length > 12 ? ` (+${o.files_read.length - 12})` : ""}`,
    );
  if (o.concepts.length) meta.push(`Koncepty: ${o.concepts.join(", ")}`);
  const status: string[] = [];
  if (o.status !== "active") {
    const target = o.merged_into ?? o.superseded_by;
    status.push(`status: ${o.status}${target ? `, aktualna wersja #${target}` : ""}`);
  }
  if (st?.changed.length) status.push(`⚠ od czasu notatki zmieniono: ${st.changed.join(", ")}`);
  if (st?.missing.length) status.push(`⚠ już nie istnieje: ${st.missing.join(", ")}`);
  if (o.occurrence_count > 1) status.push(`powtórzone ${o.occurrence_count}×`);
  if (status.length) meta.push(status.join(" · "));
  if (meta.length) lines.push("", ...meta);
  return lines.join("\n");
}

/**
 * Dodatkowe pola z opcjonalnej konsolidacji lokalnym LLM (meta.llm): lekcja i możliwe sprzeczności z innymi
 * notatkami. To dopisek z odsyłaczem, nie zamiennik treści notatki.
 */
export function llmNoteLines(meta: Record<string, unknown> | null): string[] {
  const llm = (meta as { llm?: any } | null)?.llm;
  if (!llm || typeof llm !== "object") return [];
  const out: string[] = [];
  if (llm.lesson?.text) {
    const model = llm.lesson.model ? `, ${llm.lesson.model}` : "";
    out.push(`Lekcja (lokalny LLM${model}): ${oneLine(String(llm.lesson.text))}`);
  }
  for (const c of Array.isArray(llm.conflicts) ? llm.conflicts : [])
    if (c?.with)
      out.push(
        c.reason
          ? `⚠ Możliwa sprzeczność z #${c.with} (lokalny LLM): ${oneLine(String(c.reason))}`
          : `⚠ Możliwa sprzeczność z #${c.with} (lokalny LLM; powód przy #${c.with})`,
      );
  return out;
}

export function summaryMarkdown(s: Summary): string {
  const out = [`## S${s.id} [sesja] ${fmtDay(s.created_at)} ${fmtTime(s.created_at)} · ${s.project}`];
  const add = (label: string, v: string | null) => {
    if (v?.trim()) out.push(`**${label}:** ${v.trim()}`);
  };
  add("Prośba", s.request);
  add("Zbadane", s.investigated);
  add("Wnioski", s.learned);
  add("Zrobione", s.completed);
  add("Następne kroki", s.next_steps);
  add("Uwagi", s.notes);
  if (s.files_edited.length) out.push(`Pliki zmienione: ${s.files_edited.join(", ")}`);
  return out.join("\n");
}

/** Notatka w kształcie zbliżonym do claude-mem (format=json); puste pola pomijamy. */
export function obsJson(o: Observation, st?: Staleness | null): Record<string, unknown> {
  const x: Record<string, unknown> = {
    id: o.id,
    session_id: o.session_id,
    project: o.project,
    type: o.type,
    title: o.title,
    subtitle: o.subtitle,
    narrative: o.narrative,
    text: o.text,
    facts: o.facts,
    concepts: o.concepts,
    files_read: o.files_read,
    files_modified: o.files_modified,
    prompt_number: o.prompt_n,
    // numer spoza zakresu tur (zastępczy albo claude-mem bez tury): czytelna etykieta obok liczby
    prompt_label: o.prompt_n && promptRef(o.prompt_n).kind !== "turn" ? promptLabel(o.prompt_n) : null,
    created_at: new Date(o.created_at).toISOString(),
    created_at_epoch: o.created_at,
    importance: Number(o.importance.toFixed(2)),
    source: o.source,
    status: o.status,
    merged_into: o.merged_into,
    superseded_by: o.superseded_by,
    occurrence_count: o.occurrence_count > 1 ? o.occurrence_count : null,
  };
  if (st && (st.changed.length || st.missing.length)) x.stale = { changed: st.changed, missing: st.missing };
  for (const [k, v] of Object.entries(x)) if (v === null || v === undefined || (Array.isArray(v) && !v.length)) delete x[k];
  return x;
}

/** Oś czasu pogrupowana po dniach, chronologicznie (jak timeline w claude-mem). */
export function timelineMarkdown(
  items: TimelineItem[],
  opts: { title: string; currentProject?: string | null; staleIds?: Set<number> },
): string {
  const out = [opts.title];
  let day = "";
  for (const it of items) {
    const d = fmtDay(it.at);
    if (d !== day) {
      out.push("", `### ${d}`);
      day = d;
    }
    const lo: LineOpts = { currentProject: opts.currentProject, timeOnly: true };
    if (it.kind === "observation") out.push(obsLine(it.obs, { ...lo, anchor: it.anchor, stale: opts.staleIds?.has(it.obs.id) }));
    else if (it.kind === "prompt")
      out.push(promptLine({ id: it.id, project: it.project, n: it.n, text: it.text, created_at: it.at }, lo));
    else out.push(summaryLine(it.summary, lo));
  }
  return out.join("\n");
}
