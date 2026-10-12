// Oś czasu wokół kotwicy: obserwacje, prompty i podsumowania z tego samego projektu, chronologicznie.
import type { Repo } from "../db/repo.ts";
import { rowToObservation, rowToSummary } from "../db/repo.ts";
import type { Observation, Summary } from "../types.ts";

export type TimelineItem =
  | { kind: "observation"; at: number; obs: Observation; anchor?: boolean }
  | { kind: "prompt"; at: number; id: number; session_id: string; project: string; n: number; text: string }
  | { kind: "summary"; at: number; summary: Summary };

export function timeline(
  repo: Repo,
  args: {
    anchor?: number | null;
    at?: number | null;
    project?: string | null;
    before?: number;
    after?: number;
    withPrompts?: boolean;
    withSummaries?: boolean;
  },
): { anchor: Observation | null; items: TimelineItem[] } {
  const before = Math.max(0, Math.min(50, Math.trunc(args.before ?? 6)));
  const after = Math.max(0, Math.min(50, Math.trunc(args.after ?? 6)));
  const anchor = args.anchor ? repo.getObservation(args.anchor) : null;
  const at = anchor?.created_at ?? args.at ?? Date.now();
  const project = args.project ?? anchor?.project ?? null;
  const pw = project ? "AND project = ? COLLATE NOCASE" : "";
  const pp = project ? [project] : [];
  const db = repo.db;
  // porządek po krotce (created_at, id): import partią daje wiele notatek z tym samym czasem co kotwica
  const aid = anchor?.id ?? null;
  const prevCond = aid ? "(created_at < ? OR (created_at = ? AND id < ?))" : "created_at <= ?";
  const nextCond = aid ? "(created_at > ? OR (created_at = ? AND id > ?))" : "created_at > ?";
  const cut = aid ? [at, at, aid] : [at];
  const prev = (
    db
      .query(`SELECT * FROM observations WHERE status = 'active' AND ${prevCond} ${pw} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...cut, ...pp, before) as any[]
  ).map(rowToObservation);
  const next = (
    db
      .query(`SELECT * FROM observations WHERE status = 'active' AND ${nextCond} ${pw} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...cut, ...pp, after) as any[]
  ).map(rowToObservation);
  const items: TimelineItem[] = [
    ...prev.map((o) => ({ kind: "observation" as const, at: o.created_at, obs: o })),
    ...(anchor ? [{ kind: "observation" as const, at: anchor.created_at, obs: anchor, anchor: true }] : []),
    ...next.map((o) => ({ kind: "observation" as const, at: o.created_at, obs: o })),
  ];
  const lo = prev.length ? prev[prev.length - 1].created_at : at;
  const hi = next.length ? next[next.length - 1].created_at : at;
  if (args.withPrompts !== false) {
    const ps = db
      .query(
        `SELECT id, session_id, project, n, text, created_at FROM prompts WHERE created_at BETWEEN ? AND ? ${pw} ORDER BY created_at LIMIT 40`,
      )
      .all(lo, hi, ...pp) as any[];
    for (const p of ps)
      items.push({
        kind: "prompt",
        at: p.created_at,
        id: p.id,
        session_id: p.session_id,
        project: p.project,
        n: p.n,
        text: p.text,
      });
  }
  if (args.withSummaries !== false) {
    const ss = (
      db
        .query(`SELECT * FROM summaries WHERE created_at BETWEEN ? AND ? ${pw} ORDER BY created_at LIMIT 10`)
        .all(lo, hi, ...pp) as any[]
    ).map(rowToSummary);
    for (const s of ss) items.push({ kind: "summary", at: s.created_at, summary: s });
  }
  const idOf = (x: TimelineItem) => (x.kind === "observation" ? x.obs.id : x.kind === "prompt" ? x.id : x.summary.id);
  items.sort((a, b) => a.at - b.at || idOf(a) - idOf(b));
  return { anchor, items };
}
