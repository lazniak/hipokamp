// Pełnotekstowe FTS5 z „rdzeniowaniem przez prefiks” — tani zamiennik stemmera dla polskiej fleksji
// (zakleszczenie / zakleszczenia / zakleszczeniu → "zakleszcz"*). Indeks prefiksowy 3-6 znaków.
import type { Database } from "bun:sqlite";
import { isStopword, normKey } from "../util/text.ts";

export interface FtsHit {
  id: number;
  bm25: number;
}

/** Buduje bezpieczne wyrażenie MATCH (OR po tokenach, prefiksy dla długich słów). */
export function buildMatch(q: string, maxTerms = 14): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of normKey(q).split(/\s+/)) {
    const w = raw.trim();
    if (!w || w.length < 2 || isStopword(w) || seen.has(w)) continue;
    seen.add(w);
    if (/^\d+$/.test(w)) terms.push(`"${w}"`);
    else if (w.length >= 7) terms.push(`"${w.slice(0, Math.max(5, Math.ceil(w.length * 0.72)))}"*`);
    else if (w.length >= 4) terms.push(`"${w}"*`);
    else terms.push(`"${w}"`);
    if (terms.length >= maxTerms) break;
  }
  return terms.length ? terms.join(" OR ") : null;
}

/** BM25 (niższy = lepszy w SQLite; zwracamy dodatni score: im większy, tym lepiej). */
export function ftsSearch(
  db: Database,
  q: string,
  opts: {
    project?: string | null;
    /** Bez notatek tego projektu (wyszukiwanie globalne po lokalnym). */
    excludeProject?: string | null;
    limit?: number;
    types?: string[];
    since?: number;
    until?: number;
    includeArchived?: boolean;
  } = {},
): FtsHit[] {
  const m = buildMatch(q);
  if (!m) return [];
  const where = ["observations_fts MATCH ?"];
  const params: any[] = [m];
  // includeArchived: archiwum i notatki zastąpione nowszymi (scalone nie: ich treść żyje w celu scalenia)
  where.push(opts.includeArchived ? "o.status IN ('active','archived','superseded')" : "o.status = 'active'");
  if (opts.project) {
    where.push("o.project = ? COLLATE NOCASE");
    params.push(opts.project);
  }
  if (opts.excludeProject) {
    where.push("o.project != ? COLLATE NOCASE");
    params.push(opts.excludeProject);
  }
  if (opts.types?.length) {
    where.push(`o.type IN (${opts.types.map(() => "?").join(",")})`);
    params.push(...opts.types);
  }
  if (opts.since) {
    where.push("o.created_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    where.push("o.created_at <= ?");
    params.push(opts.until);
  }
  params.push(opts.limit ?? 100);
  try {
    const rows = db
      .query(
        `SELECT o.id AS id, bm25(observations_fts, 4.0, 1.5, 1.0, 1.6, 2.0, 1.3) AS s
         FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
         WHERE ${where.join(" AND ")} ORDER BY s LIMIT ?`,
      )
      .all(...params) as { id: number; s: number }[];
    return rows.map((r) => ({ id: r.id, bm25: -r.s }));
  } catch {
    return [];
  }
}

export interface SideSearchOpts {
  project?: string | null;
  since?: number;
  until?: number;
  /** relevance: BM25; date_desc / date_asc: wszystkie trafienia po czasie (MCP orderBy). */
  order?: "relevance" | "date_desc" | "date_asc";
  limit?: number;
  offset?: number;
}

/** FTS po podsumowaniach sesji albo promptach: zakres dat, kierunek i przesunięcie liczy SQL, nie klient. */
function ftsSide(db: Database, table: "summaries" | "prompts", q: string, opts: SideSearchOpts): { id: number; bm25: number }[] {
  const m = buildMatch(q);
  if (!m) return [];
  const fts = `${table}_fts`;
  const where = [`${fts} MATCH ?`];
  const params: any[] = [m];
  if (opts.project) {
    where.push("t.project = ? COLLATE NOCASE");
    params.push(opts.project);
  }
  if (opts.since) {
    where.push("t.created_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    where.push("t.created_at <= ?");
    params.push(opts.until);
  }
  const order =
    opts.order === "date_asc" ? "t.created_at ASC, t.id ASC" : opts.order === "date_desc" ? "t.created_at DESC, t.id DESC" : "b";
  params.push(Math.max(1, opts.limit ?? 20), Math.max(0, opts.offset ?? 0));
  try {
    return (
      db
        .query(
          `SELECT t.id AS id, bm25(${fts}) AS b FROM ${fts} JOIN ${table} t ON t.id = ${fts}.rowid
           WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(...params) as { id: number; b: number }[]
    ).map((r) => ({ id: r.id, bm25: -r.b }));
  } catch {
    return [];
  }
}

export function ftsSearchSummaries(db: Database, q: string, opts: SideSearchOpts = {}): { id: number; bm25: number }[] {
  return ftsSide(db, "summaries", q, opts);
}

export function ftsSearchPrompts(db: Database, q: string, opts: SideSearchOpts = {}): { id: number; bm25: number }[] {
  return ftsSide(db, "prompts", q, opts);
}
