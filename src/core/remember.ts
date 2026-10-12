// Jawne zapamiętanie (narzędzie MCP `remember`, API, CLI): pamięć semantyczna z wysoką ważnością.
import { clean } from "../capture/redact.ts";
import type { Repo } from "../db/repo.ts";
import { headline, keywords, truncate } from "../util/text.ts";
import { supersedeByKey, topicKey } from "./supersede.ts";

export interface RememberInput {
  project: string;
  text: string;
  title?: string;
  type?: string;
  facts?: string[];
  files?: string[];
  session?: string | null;
  importance?: number;
  /** id notatki, którą ta zastępuje (nowsza prawda unieważnia starszą). */
  supersedes?: number | null;
  /** Klucz tematu: decyzja albo preferencja z tym samym kluczem w projekcie zastępuje starsze (core/supersede.ts). */
  key?: string | null;
}

export function remember(repo: Repo, inp: RememberInput): { id: number; superseded?: number; supersededByKey?: number[] } {
  // zapis i zastąpienie w jednej transakcji: dwa równoległe `remember` z tym samym kluczem (dwie sesje) nie przeplotą się
  return repo.db.transaction(() => rememberTx(repo, inp)).immediate();
}

function rememberTx(repo: Repo, inp: RememberInput): { id: number; superseded?: number; supersededByKey?: number[] } {
  const text = clean(inp.text);
  // headline() przepuszcza tekst po clean() przez stripMarkdown: sekret rozcięty emoji albo linkiem (sk-ant-🔑api03-…)
  // skleja się dopiero w tytule, więc clean() jeszcze raz (`, **, __ i ~~ skleja już clean(), patrz fakty w digest.ts)
  const title = clean(inp.title ?? "") || clean(headline(text, 100)) || truncate(text, 100);
  const type = inp.type ?? "decision";
  const key = topicKey(clean(inp.key ?? ""));
  const now = Date.now();
  const { id, duplicateOf } = repo.insertObservation(
    {
      session_id: inp.session ?? null,
      project: inp.project,
      type,
      tier: "semantic",
      title,
      narrative: text,
      facts: (inp.facts ?? []).map(clean),
      concepts: keywords(text, 6),
      files_modified: inp.files ?? [],
      created_at: now,
      importance: Math.max(0.6, Math.min(1, inp.importance ?? 0.8)),
      source: "agent",
      meta: key ? { key } : null,
    },
    [
      ...(inp.files ?? []).map((f) => ({ kind: "file" as const, key: f, role: "mentioned" as const })),
      ...keywords(text, 6).map((k) => ({ kind: "concept" as const, key: k, role: "concept" as const })),
    ],
  );
  // ta sama treść drugi raz (deduplikacja): klucz trafia do istniejącej notatki, żeby następne zastąpienie ją widziało
  if (key && duplicateOf) repo.patchObservationMeta(id, { key });
  const byKey = key ? supersedeByKey(repo, id, inp.project, key, type, !!duplicateOf) : [];
  const out: { id: number; superseded?: number; supersededByKey?: number[] } = { id };
  if (byKey.length) out.supersededByKey = byKey;
  if (inp.supersedes && inp.supersedes !== id) {
    repo.setStatus(inp.supersedes, "superseded", { supersededBy: id, validUntil: now });
    out.superseded = inp.supersedes;
  }
  return out;
}
