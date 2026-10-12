// Deterministyczne podsumowanie sesji z jej obserwacji (pola zgodne z claude-mem session_summaries)
// oraz zapis darmowych podsumowań kompakcji Claude Code.
import type { Repo } from "../db/repo.ts";
import type { Observation } from "../types.ts";
import { oneLine, sentences, stripMarkdown, truncate } from "../util/text.ts";
import { clean } from "./redact.ts";
import type { CompactSummary } from "./transcript.ts";

type SummaryField = "request" | "investigated" | "learned" | "completed" | "next_steps";

/** Sekcje streszczenia kompakcji („1. Primary Request and Intent:” …) na pola podsumowania. */
const SECTIONS: [RegExp, SummaryField][] = [
  [/primary request|intent|prośb|cel /i, "request"],
  [/key technical|concepts|wnioski/i, "learned"],
  [/errors?|problem solving|bł[ęe]d/i, "investigated"],
  [/current work|bieżąca praca|completed/i, "completed"],
  [/pending|next step|następn/i, "next_steps"],
];

function splitSections(text: string): { heading: string; body: string }[] {
  const re = /^[ \t]*(?:\d+\.|#{1,4})[ \t]+([^\n:]{3,80}):?[ \t]*$/gm;
  const heads = [...text.matchAll(re)];
  return heads.map((m, i) => ({
    heading: m[1],
    body: text.slice((m.index ?? 0) + m[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length).trim(),
  }));
}

/** Zapisuje podsumowanie kompakcji jako podsumowanie sesji (idempotentnie: klucz to offset linii w transkrypcie). */
export function storeCompactSummary(repo: Repo, sessionId: string, project: string, cs: CompactSummary): number | null {
  const exists = repo.db
    .query("SELECT id FROM summaries WHERE session_id = ? AND source = 'compact' AND json_extract(meta, '$.start') = ?")
    .get(sessionId, cs.start);
  if (exists) return null;
  const text = clean(cs.text)
    .replace(/^This session is being continued from a previous conversation[^\n]*\n+/i, "")
    .replace(/^Summary:\s*/i, "");
  const f: Partial<Record<SummaryField, string>> = {};
  for (const { heading, body } of splitSections(text)) {
    const hit = SECTIONS.find(([re]) => re.test(heading));
    if (hit && body) f[hit[1]] = f[hit[1]] ? `${f[hit[1]]}\n${body}` : body;
  }
  return repo.insertSummary({
    session_id: sessionId,
    project,
    request: f.request ? truncate(f.request, 1500) : truncate(oneLine(text), 300),
    investigated: f.investigated ? truncate(f.investigated, 1500) : null,
    learned: f.learned ? truncate(f.learned, 1500) : null,
    completed: f.completed ? truncate(f.completed, 2000) : null,
    next_steps: f.next_steps ? truncate(f.next_steps, 1500) : null,
    notes: truncate(text, 12_000),
    files_read: [],
    files_edited: [],
    prompt_n: null,
    created_at: cs.at || Date.now(),
    source: "compact",
    meta: { start: cs.start },
  });
}

const RE_NEXT =
  /(następn\w* krok|nastepn\w* krok|next step|do zrobienia|todo|pozostaje|zostało|zostalo|kolejny krok|dalej:|potem:|follow[- ]?up|otwarte:|czeka na)/i;

function nextStepsFrom(obs: Observation[]): string | null {
  const out: string[] = [];
  for (const o of [...obs].reverse().slice(0, 4)) {
    const text = stripMarkdown(o.narrative ?? "");
    for (const s of sentences(text)) {
      // narracja z `remember` ma Markdown: sekret rozcięty emoji albo linkiem skleja się dopiero po stripMarkdown
      // (`, **, __ i ~~ skleja już clean(), patrz fakty w digest.ts)
      if (RE_NEXT.test(s)) out.push(truncate(clean(oneLine(s)), 200));
      if (out.length >= 3) break;
    }
    if (out.length >= 3) break;
  }
  return out.length ? out.join("\n") : null;
}

export function buildSessionSummary(repo: Repo, sessionId: string): number | null {
  const sess = repo.getSession(sessionId);
  if (!sess) return null;
  const obs = repo
    .sessionObservations(sessionId)
    .filter((o) => o.source === "digest" || o.source === "backfill" || o.source === "agent");
  if (!obs.length) return null;
  const filesRead = [...new Set(obs.flatMap((o) => o.files_read))].slice(0, 30);
  const filesEdited = [...new Set(obs.flatMap((o) => o.files_modified))].slice(0, 30);
  const modifying = obs.filter((o) => o.files_modified.length > 0);
  const discoveries = obs.filter((o) => o.type === "discovery").slice(-3);
  const learnedFacts = obs
    .flatMap((o) => o.facts.filter((f) => /^(Błąd|Decyzja|Do zapamiętania|Plan):/.test(f)))
    .concat(obs.filter((o) => o.type === "gotcha" || o.type === "decision" || o.type === "preference").map((o) => o.title))
    .slice(0, 6);
  const unresolved = obs.flatMap((o) => o.facts.filter((f) => f.startsWith("Błąd:") && !f.endsWith("(naprawiony)"))).slice(0, 3);

  return repo.replaceSessionSummary(sessionId, {
    session_id: sessionId,
    project: sess.project,
    request: truncate(oneLine(sess.first_prompt ?? obs[0].subtitle ?? obs[0].title), 400),
    investigated: discoveries.length
      ? discoveries.map((o) => o.title).join("; ")
      : filesRead.length
        ? `Pliki: ${filesRead.slice(0, 8).join(", ")}`
        : null,
    learned: learnedFacts.length ? learnedFacts.join("\n") : null,
    completed: modifying.length
      ? modifying
          .slice(-8)
          .map((o) => o.title)
          .join("; ")
      : obs
          .slice(-3)
          .map((o) => o.title)
          .join("; "),
    next_steps: nextStepsFrom(obs),
    notes: unresolved.length ? unresolved.join("\n") : null,
    files_read: filesRead,
    files_edited: filesEdited,
    prompt_n: sess.prompt_count,
    created_at: sess.last_activity_at ?? Date.now(),
    source: "digest",
  });
}
