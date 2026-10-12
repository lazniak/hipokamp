// Korpusy o nazwach i parametrach z claude-mem, ale bez płatnego „knowledge agenta”.
// Korpus = zapisany filtr + lista notatek. prime_corpus zwraca streszczenie korpusu, query_corpus zwraca dowody
// (najtrafniejsze notatki z korpusu), a odpowiedź składa agent, który pyta. Zero dodatkowych wywołań LLM.
import type { Repo } from "../db/repo.ts";
import { buildMatch } from "../index/fts.ts";
import { dotQ8 } from "../index/vectors.ts";
import type { Observation } from "../types.ts";
import { oneLine, truncate } from "../util/text.ts";
import { fmtDay, obsLine } from "./format.ts";

export interface CorpusFilters {
  project?: string | null;
  types?: string[];
  concepts?: string[];
  files?: string[];
  query?: string | null;
  since?: number | null;
  until?: number | null;
  limit: number;
}

export interface CorpusDeps {
  repo: Repo;
  /** Id notatek z wyszukiwania hybrydowego (worker albo lokalny FTS). */
  search: (
    q: string,
    o: { project?: string | null; types?: string[]; since?: number; until?: number; limit: number },
  ) => Promise<number[]>;
  /** Wektor zapytania z workera; null, gdy worker nie działa (wtedy sam FTS). */
  embedQuery: (q: string) => Promise<Float32Array | null>;
}

interface CorpusRow {
  name: string;
  description: string | null;
  filters: string;
  obs_ids: string;
  created_at: number;
  updated_at: number;
}

const RRF_K = 60;

function getRow(repo: Repo, name: string): CorpusRow | null {
  return (repo.db.query("SELECT * FROM corpora WHERE name = ?").get(name) as CorpusRow | null) ?? null;
}

/** Warunki SQL dla filtrów niezależnych od zapytania tekstowego. */
function sqlFilters(f: CorpusFilters): { where: string[]; params: (string | number)[] } {
  const where = ["o.status = 'active'"];
  const params: (string | number)[] = [];
  if (f.project) {
    where.push("o.project = ? COLLATE NOCASE");
    params.push(f.project);
  }
  if (f.types?.length) {
    where.push(`o.type IN (${f.types.map(() => "?").join(",")})`);
    params.push(...f.types);
  }
  if (f.since) {
    where.push("o.created_at >= ?");
    params.push(f.since);
  }
  if (f.until) {
    where.push("o.created_at <= ?");
    params.push(f.until);
  }
  if (f.concepts?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(o.concepts) c WHERE lower(c.value) IN (${f.concepts.map(() => "lower(?)").join(",")}))`,
    );
    params.push(...f.concepts);
  }
  if (f.files?.length) {
    const one =
      "(EXISTS (SELECT 1 FROM json_each(o.files_modified) x WHERE x.value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_read) x WHERE x.value LIKE ?))";
    where.push(`(${f.files.map(() => one).join(" OR ")})`);
    for (const file of f.files) {
      const pat = `%${file.replace(/\\/g, "/")}%`;
      params.push(pat, pat);
    }
  }
  return { where, params };
}

export async function selectCorpusIds(deps: CorpusDeps, f: CorpusFilters): Promise<number[]> {
  const { where, params } = sqlFilters(f);
  const db = deps.repo.db;
  if (f.query?.trim()) {
    const found = await deps.search(f.query, {
      project: f.project,
      types: f.types,
      since: f.since ?? undefined,
      until: f.until ?? undefined,
      limit: f.limit,
    });
    if (!found.length) return [];
    const ok = new Set(
      (
        db
          .query(`SELECT o.id FROM observations o WHERE ${where.join(" AND ")} AND o.id IN (SELECT value FROM json_each(?))`)
          .all(...params, JSON.stringify(found)) as { id: number }[]
      ).map((r) => r.id),
    );
    return found.filter((id) => ok.has(id));
  }
  return (
    db
      .query(`SELECT o.id FROM observations o WHERE ${where.join(" AND ")} ORDER BY o.importance DESC, o.created_at DESC LIMIT ?`)
      .all(...params, f.limit) as { id: number }[]
  ).map((r) => r.id);
}

export async function buildCorpus(deps: CorpusDeps, name: string, description: string | null, f: CorpusFilters): Promise<string> {
  const ids = await selectCorpusIds(deps, f);
  const now = Date.now();
  deps.repo.db.run(
    `INSERT INTO corpora(name, description, filters, obs_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description, filters = excluded.filters, obs_ids = excluded.obs_ids, updated_at = excluded.updated_at`,
    [name, description, JSON.stringify(f), JSON.stringify(ids), now, now],
  );
  return `${describe(deps.repo, name, description, ids)}\nGotowe bez LLM. Dalej: prime_corpus("${name}") daje przegląd, query_corpus("${name}", pytanie) zwraca dowody.`;
}

export async function rebuildCorpus(deps: CorpusDeps, name: string): Promise<string> {
  const row = getRow(deps.repo, name);
  if (!row) return `Nie ma korpusu "${name}". Utwórz go przez build_corpus.`;
  return buildCorpus(deps, name, row.description, JSON.parse(row.filters) as CorpusFilters);
}

export function listCorpora(repo: Repo): string {
  const rows = repo.db.query("SELECT * FROM corpora ORDER BY updated_at DESC").all() as CorpusRow[];
  if (!rows.length) return "Brak korpusów. Utwórz przez build_corpus(name, ...filtry).";
  return [
    "Korpusy:",
    ...rows.map((r) => {
      const all = JSON.parse(r.obs_ids) as number[];
      const n = activeIds(repo, all).length;
      const gone = all.length - n ? ` (${all.length - n} nieaktywnych, rebuild_corpus odświeży)` : "";
      return `- ${r.name}: ${n} notatek${gone}, aktualizacja ${fmtDay(r.updated_at)}${r.description ? ` · ${truncate(oneLine(r.description), 100)}` : ""}`;
    }),
  ].join("\n");
}

/** Tylko notatki wciąż aktywne: po forget albo scaleniu przez sen korpus nie podaje ich jako dowodów. */
function activeIds(repo: Repo, ids: number[]): number[] {
  if (!ids.length) return [];
  const ok = new Set(
    (
      repo.db
        .query("SELECT id FROM observations WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(ids)) as { id: number }[]
    ).map((r) => r.id),
  );
  return ids.filter((id) => ok.has(id));
}

function describe(repo: Repo, name: string, description: string | null, allIds: number[]): string {
  if (!allIds.length) return `Korpus "${name}": 0 notatek (filtry nic nie zwróciły).`;
  const ids = activeIds(repo, allIds);
  if (!ids.length) return `Korpus "${name}": 0 aktywnych notatek (zapomniane albo scalone; rebuild_corpus go odświeży).`;
  const obs = repo.getObservations(ids);
  const dates = obs.map((o) => o.created_at).sort((a, b) => a - b);
  const types = histogram(obs.map((o) => o.type));
  const projects = histogram(obs.map((o) => o.project));
  return [
    `Korpus "${name}": ${obs.length} notatek, ${fmtDay(dates[0])} do ${fmtDay(dates[dates.length - 1])}`,
    description ? `Opis: ${oneLine(description)}` : "",
    `Typy: ${types
      .slice(0, 8)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
    projects.length > 1
      ? `Projekty: ${projects
          .slice(0, 6)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")}`
      : `Projekt: ${projects[0][0]}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function histogram(xs: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Przegląd korpusu do wczytania przez agenta (zamiast „primowania” osobnej sesji LLM). */
export function primeCorpus(repo: Repo, name: string, maxItems = 40): string {
  const row = getRow(repo, name);
  if (!row) return `Nie ma korpusu "${name}". Utwórz go przez build_corpus.`;
  const ids = activeIds(repo, JSON.parse(row.obs_ids) as number[]);
  const obs = repo.getObservations(ids);
  const now = Date.now();
  // ważność z lekką premią za świeżość (półokres 30 dni)
  const ranked = obs
    .map((o) => ({ o, s: o.importance + 0.3 * Math.exp(-(now - o.created_at) / (30 * 86_400_000)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, maxItems)
    .map((x) => x.o);
  const concepts = histogram(obs.flatMap((o) => o.concepts.map((c) => c.toLowerCase())));
  const files = histogram(obs.flatMap((o) => o.files_modified));
  const out = [describe(repo, name, row.description, ids)];
  if (concepts.length)
    out.push(
      `Najczęstsze koncepty: ${concepts
        .slice(0, 12)
        .map(([k, n]) => `${k} (${n})`)
        .join(", ")}`,
    );
  if (files.length)
    out.push(
      `Najczęściej zmieniane pliki: ${files
        .slice(0, 8)
        .map(([k, n]) => `${k} (${n})`)
        .join(", ")}`,
    );
  out.push("", `## Najważniejsze notatki (${ranked.length} z ${obs.length})`, ...ranked.map((o) => obsLine(o)));
  out.push("", `Pytania: query_corpus("${name}", pytanie). Szczegóły: get_observations(ids=[...]).`);
  return out.join("\n");
}

/** Dowody z korpusu dla pytania: RRF z BM25 (ograniczone do korpusu) i cosinusa bge-m3. */
export async function queryCorpus(deps: CorpusDeps, name: string, question: string, k = 8): Promise<string> {
  const row = getRow(deps.repo, name);
  if (!row) return `Nie ma korpusu "${name}". Utwórz go przez build_corpus.`;
  const ids = activeIds(deps.repo, JSON.parse(row.obs_ids) as number[]);
  if (!ids.length) return `Korpus "${name}" nie ma aktywnych notatek. Zmień filtry i użyj rebuild_corpus.`;
  const db = deps.repo.db;
  const score = new Map<number, number>();
  const m = buildMatch(question);
  if (m) {
    try {
      const fts = db
        .query(
          `SELECT rowid AS id, bm25(observations_fts, 4.0, 1.5, 1.0, 1.6, 2.0, 1.3) AS s FROM observations_fts
           WHERE observations_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?)) ORDER BY s LIMIT 60`,
        )
        .all(m, JSON.stringify(ids)) as { id: number }[];
      fts.forEach((h, i) => {
        score.set(h.id, (score.get(h.id) ?? 0) + 1 / (RRF_K + i));
      });
    } catch {
      // zła składnia zapytania: zostają wektory
    }
  }
  const qv = await deps.embedQuery(question);
  if (qv) {
    const vs = deps.repo.getVectorsQ8(ids);
    const vec = [...vs.entries()].map(([id, v]) => ({ id, cos: dotQ8(v, qv) })).sort((a, b) => b.cos - a.cos);
    vec.slice(0, 60).forEach((h, i) => {
      score.set(h.id, (score.get(h.id) ?? 0) + 1 / (RRF_K + i));
    });
  }
  let top = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (!top.length) top = ids;
  const obs = deps.repo.getObservations(top.slice(0, k));
  return [
    `Dowody z korpusu "${name}" (${obs.length} z ${ids.length}${qv ? "" : ", tylko pełnotekstowo"}) dla: "${truncate(oneLine(question), 160)}"`,
    "Odpowiedz na ich podstawie i cytuj #id. Brak odpowiedzi w dowodach = powiedz to wprost.",
    "",
    ...obs.map(evidence),
  ].join("\n");
}

function evidence(o: Observation): string {
  const out = [`### #${o.id} [${o.type}] ${fmtDay(o.created_at)} ${oneLine(o.title)}`];
  if (o.subtitle) out.push(oneLine(o.subtitle));
  if (o.narrative) out.push(truncate(oneLine(o.narrative), 600));
  out.push(...o.facts.slice(0, 5).map((f) => `- ${truncate(oneLine(f), 200)}`), "");
  return out.join("\n");
}
