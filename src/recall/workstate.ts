// Work state: listy zadań i stanów zgodne z claude-mem (dziennik zdarzeń; najnowsza wartość klucza wygrywa).
import type { Repo } from "../db/repo.ts";
import { oneLine, truncate } from "../util/text.ts";

export interface WsItem {
  task: string;
  status: string;
  fields: Record<string, unknown>;
  updatedAt: number;
}

export interface WsList {
  name: string;
  closed: boolean;
  state: Record<string, unknown>;
  items: WsItem[];
  updatedAt: number;
}

/** Odtwarza stan list z dziennika wpisów. */
export function foldWorkState(entries: { list_name: string; fields: Record<string, unknown>; created_at: number }[]): WsList[] {
  const lists = new Map<string, WsList>();
  for (const e of entries) {
    let l = lists.get(e.list_name);
    if (!l) lists.set(e.list_name, (l = { name: e.list_name, closed: false, state: {}, items: [], updatedAt: e.created_at }));
    l.updatedAt = Math.max(l.updatedAt, e.created_at);
    const f = e.fields ?? {};
    if (typeof f.task === "string" && f.task.trim()) {
      const name = f.task.trim();
      let it = l.items.find((i) => i.task === name);
      if (!it) l.items.push((it = { task: name, status: "todo", fields: {}, updatedAt: e.created_at }));
      for (const [k, v] of Object.entries(f)) {
        if (k === "task") continue;
        if (v === null) delete it.fields[k];
        else it.fields[k] = v;
      }
      if (typeof f.status === "string") it.status = f.status;
      it.updatedAt = e.created_at;
      continue;
    }
    for (const [k, v] of Object.entries(f)) {
      if (v === null) delete l.state[k];
      else l.state[k] = v;
    }
    if (f.status === "done") l.closed = true;
    else if (typeof f.status === "string") l.closed = false;
  }
  return [...lists.values()];
}

export function readWorkState(repo: Repo, project: string, includeClosed = false): WsList[] {
  const lists = foldWorkState(repo.workStateEntries(project));
  return includeClosed ? lists : lists.filter((l) => !l.closed);
}

export interface WsProjectList extends WsList {
  project: string;
}

/**
 * Listy pracy ze wszystkich projektów (zbiorcze TODO w podglądzie). Projekty łączone bez względu na wielkość liter ASCII (jak NOCASE w SQLite),
 * nazwa pochodzi z najnowszego wpisu. Zamknięte listy tylko na życzenie; kolejność: najnowsza zmiana pierwsza.
 */
export function readAllWorkState(repo: Repo, includeClosed = false): WsProjectList[] {
  const byProject = new Map<string, { name: string; entries: ReturnType<Repo["workStateAll"]> }>();
  for (const e of repo.workStateAll()) {
    const key = e.project.replace(/[A-Z]/g, (c) => c.toLowerCase()); // jak COLLATE NOCASE w SQLite: tylko ASCII
    let p = byProject.get(key);
    if (!p) byProject.set(key, (p = { name: e.project, entries: [] }));
    p.name = e.project;
    p.entries.push(e);
  }
  const out: WsProjectList[] = [];
  for (const { name, entries } of byProject.values()) {
    for (const l of foldWorkState(entries)) if (includeClosed || !l.closed) out.push({ ...l, project: name });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Otwarte listy z otwartymi pozycjami (do kontekstu startowego). */
export function openWorkState(repo: Repo, project: string): WsList[] {
  return readWorkState(repo, project, false)
    .map((l) => ({ ...l, items: l.items.filter((i) => i.status !== "done" && i.status !== "dropped") }))
    .filter((l) => l.items.length || Object.keys(l.state).filter((k) => k !== "status").length);
}

export function renderWorkState(lists: WsList[], maxItems = 12): string {
  const out = ["## Praca w toku (work state)"];
  let n = 0;
  for (const l of lists) {
    const st = Object.entries(l.state)
      .filter(([k]) => k !== "status")
      .slice(0, 4)
      .map(([k, v]) => `${k}=${truncate(oneLine(typeof v === "string" ? v : JSON.stringify(v)), 80)}`)
      .join("; ");
    out.push(`- ${l.name}${st ? ` (${st})` : ""}`);
    for (const it of l.items) {
      if (n++ >= maxItems) break;
      out.push(`  - [${it.status}] ${truncate(oneLine(it.task), 120)}`);
    }
  }
  return out.join("\n");
}
