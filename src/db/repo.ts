// Warstwa dostępu do danych. Jedyne miejsce, które zna SQL tabel domenowych.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { PROMPT_CM_BASE, PROMPT_SUBST_BASE } from "../../viewer/prompt-number.js";
import { clean } from "../capture/redact.ts";
import type { EntityRef, NewObservation, Observation, Session, Summary } from "../types.ts";
import { basenameOf, normPath, PROJECT_RULE, projectFromCwd, UNKNOWN_PROJECT } from "../util/paths.ts";
import { breathe } from "../util/slice.ts";
import { estimateTokens, foldFts, sha1, truncate } from "../util/text.ts";

/** Wersja zawartości indeksów FTS; zmiana wymusza przebudowę (reindexFts) w workerze albo CLI. */
export const FTS_VERSION = "2";
const FTS_TABLES = ["observations_fts", "prompts_fts", "summaries_fts"];

/** Ten sam tekst promptu w sesji w takim odstępie czasu to ten sam prompt (jak PAIR_TOLERANCE_MS w capture/match.ts). */
const SAME_PROMPT_MS = 10 * 60_000;

/**
 * Numery promptów w sesji: poniżej PROMPT_SUBST_BASE tylko numery tur z transkryptu. Numer zastępczy promptu tury,
 * której numer zajmuje prompt innej tury: PROMPT_SUBST_BASE + numer tury (gdy i ten zajęty, pierwszy wolny za
 * ostatnim zastępczym). Numery claude-mem bez tury w transkrypcie (pobudki pętli, wiadomości innych sesji) po
 * naprawie: PROMPT_CM_BASE + numer claude-mem. Zakresy rozłączne, więc numer zastępczy nigdy nie zajmie numeru
 * późniejszej tury tej sesji. Stałe i etykiety wspólne z podglądem: viewer/prompt-number.js.
 */
export { PROMPT_CM_BASE, PROMPT_SUBST_BASE };

/** Numer zastępczy promptu tury `turnN`, gdy jej numer jest zajęty; `taken`: numery zajęte w sesji. */
export function substitutePromptN(turnN: number, taken: Iterable<number>): number {
  const set = taken instanceof Set ? (taken as Set<number>) : new Set(taken);
  const want = PROMPT_SUBST_BASE + turnN;
  if (want < PROMPT_CM_BASE && !set.has(want)) return want;
  let top = PROMPT_SUBST_BASE;
  for (const n of set) if (n > top && n < PROMPT_CM_BASE) top = n;
  return top + 1;
}

const J = (x: unknown) => JSON.stringify(x ?? null);
/** meta jako obiekt JSON do json_set: pusta albo zepsuta kolumna (ręczna edycja) daje {}, a nie błąd całej zmiany. */
const META_OBJECT = "CASE WHEN json_valid(meta) THEN CASE WHEN json_type(meta) = 'object' THEN meta ELSE '{}' END ELSE '{}' END";

/** Wpis dziennika zmian statusu (tabela status_log). */
export interface StatusChange {
  id: number;
  obs_id: number;
  from_status: string | null;
  to_status: string;
  at: number;
}

/** Statusy listy najnowszych w podglądzie: aktywne albo archiwum (zapomniane, odłożone przez sen, zastąpione). */
export const RECENT_STATUSES = ["active", "archived", "superseded"] as const;
export type RecentStatus = (typeof RECENT_STATUSES)[number];
const arr = (s: unknown): string[] => {
  if (Array.isArray(s)) return s.map(String);
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
  } catch {
    return [s];
  }
};
const obj = <T>(s: unknown): T | null => {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export function rowToObservation(r: any): Observation {
  return {
    ...r,
    facts: arr(r.facts),
    concepts: arr(r.concepts),
    files_read: arr(r.files_read),
    files_modified: arr(r.files_modified),
    fingerprints: obj(r.fingerprints),
    transcript_ref: obj(r.transcript_ref),
    meta: obj(r.meta),
  };
}

export function rowToSummary(r: any): Summary {
  return { ...r, files_read: arr(r.files_read), files_edited: arr(r.files_edited) };
}

/** Treść do FTS: pliki dodatkowo jako same nazwy (lepsze trafienia po „config.ts”). */
export function ftsRow(o: {
  title: string;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string[];
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
}): string[] {
  const files = [...(o.files_modified ?? []), ...(o.files_read ?? [])];
  const fileText = [...new Set([...files, ...files.map(basenameOf)])].join(" ");
  return [o.title, o.subtitle ?? "", o.narrative ?? "", (o.facts ?? []).join("\n"), (o.concepts ?? []).join(" "), fileText].map(
    foldFts,
  );
}

const summaryFtsRow = (s: {
  request?: string | null;
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
  next_steps?: string | null;
  notes?: string | null;
}) => [s.request, s.investigated, s.learned, s.completed, s.next_steps, s.notes].map((x) => foldFts(x ?? ""));

export function observationTokens(o: {
  title: string;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string[];
}): number {
  return estimateTokens([o.title, o.subtitle, o.narrative, ...(o.facts ?? [])].filter(Boolean).join("\n"));
}

export function contentHash(o: { project: string; title: string; narrative?: string | null; facts?: string[] }): string {
  return sha1([o.project, o.title, o.narrative ?? "", (o.facts ?? []).join("|")].join("\u0001")).slice(0, 20);
}

/** Klucz w meta ze scaleniami projektów (`hipokamp project merge`): JSON {klucz małymi literami: projekt docelowy}. */
export const PROJECT_MERGES_KEY = "project_merges";

/** Scalenia z meta; zepsuty wpis to brak scaleń (hook nie może się na nim wywrócić). */
export function parseProjectMerges(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, to] of Object.entries(v)) if (typeof to === "string" && to.trim()) out.set(k.toLowerCase(), to);
  } catch {}
  return out;
}

/** Klucz po scaleniach. Tablica jest płaska (merge ją spłaszcza); pętla z limitem tylko na wypadek ręcznej edycji. */
export function mapMergedProject(merges: Map<string, string>, project: string): string {
  let p = project;
  for (let i = 0; i < 8; i++) {
    const next = merges.get(p.toLowerCase());
    if (next === undefined || next === p) break;
    p = next;
  }
  return p;
}

export class Repo {
  /** Scalenia projektów z meta, parsowane tylko po zmianie wpisu (resolveProject woła je przy każdym hooku). */
  private merges: { raw: string | null; map: Map<string, string> } = { raw: null, map: new Map() };

  constructor(readonly db: Database) {}

  // ---------- sesje ----------

  /** Ścieżka transkryptu ustawia się tylko pustej: potem zmienia ją ingest razem z offsetem, który do niej należy. */
  upsertSession(s: Partial<Session> & { id: string; project: string; started_at: number }): void {
    this.db.run(
      `INSERT INTO sessions (id, project, cwd, git_branch, title, first_prompt, started_at, ended_at, last_activity_at,
         prompt_count, transcript_path, transcript_offset, source, model, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project = excluded.project,
         cwd = COALESCE(excluded.cwd, sessions.cwd),
         git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
         title = COALESCE(excluded.title, sessions.title),
         first_prompt = COALESCE(sessions.first_prompt, excluded.first_prompt),
         started_at = MIN(sessions.started_at, excluded.started_at),
         last_activity_at = MAX(COALESCE(sessions.last_activity_at, 0), COALESCE(excluded.last_activity_at, 0)),
         transcript_path = COALESCE(sessions.transcript_path, excluded.transcript_path),
         model = COALESCE(excluded.model, sessions.model)`,
      [
        s.id,
        s.project,
        s.cwd ?? null,
        s.git_branch ?? null,
        s.title ?? null,
        s.first_prompt ?? null,
        s.started_at,
        s.ended_at ?? null,
        s.last_activity_at ?? s.started_at,
        s.prompt_count ?? 0,
        s.transcript_path ?? null,
        s.transcript_offset ?? 0,
        s.source ?? "live",
        s.model ?? null,
        s.status ?? "active",
      ],
    );
  }

  getSession(id: string): Session | null {
    return (this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session) ?? null;
  }

  setTranscriptProgress(id: string, offset: number, promptCount: number, lastActivity: number): void {
    this.db.run(
      "UPDATE sessions SET transcript_offset = ?, prompt_count = MAX(prompt_count, ?), last_activity_at = MAX(COALESCE(last_activity_at,0), ?) WHERE id = ?",
      [offset, promptCount, lastActivity, id],
    );
  }

  endSession(id: string, at: number): void {
    this.db.run("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?", [at, id]);
  }

  /** Katalog startowy sesji i jego werdykt (projekt czy kontener) w sessions.meta, tylko gdy jeszcze go nie ma. */
  setSessionRoot(id: string, root: string, rootProject: boolean): void {
    this.db.run(
      `UPDATE sessions SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.root', ?, '$.rootProject', json(?))
       WHERE id = ? AND (meta IS NULL OR NOT json_valid(meta) OR json_type(meta, '$.root') IS NULL)`,
      [root, JSON.stringify(rootProject), id],
    );
  }

  recentSessions(project: string | null, limit: number): Session[] {
    return (
      project
        ? this.db
            .query("SELECT * FROM sessions WHERE project = ? COLLATE NOCASE ORDER BY started_at DESC LIMIT ?")
            .all(project, limit)
        : this.db.query("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit)
    ) as Session[];
  }

  // ---------- prompty ----------

  ftsOutdated(): boolean {
    const r = this.db.query("SELECT v FROM meta WHERE k = 'fts_version'").get() as { v: string } | null;
    return r?.v !== FTS_VERSION;
  }

  /**
   * Przebudowa FTS partiami (krótkie transakcje: hooki piszą w tym czasie bez czekania). Transakcja kończy się po
   * `sliceMs` pracy, potem oddech dla pętli zdarzeń workera. Ciężka praca FTS5 jest przy zatwierdzeniu: scalanie
   * segmentów (automerge, crisismerge) trwało do 6 s na jedną transakcję (40 tys. notatek: 80 s, przestoje workera
   * do 14 s). Na czas przebudowy scalanie automatyczne jest wyłączone, a po każdej tabeli idzie scalanie przyrostowe
   * małymi krokami z oddechem (40 tys. notatek: ok. 23 s, transakcja i krok najwyżej ok. 0,2 s). Ustawienia wracają
   * do domyślnych FTS5 w `finally` (także po błędzie), a przerwana przebudowa zostawia starą FTS_VERSION.
   */
  async reindexFts(
    opts: { batch?: number; sliceMs?: number; onProgress?: (table: string, done: number) => void } = {},
  ): Promise<{ observations: number; prompts: number; summaries: number }> {
    const batch = opts.batch ?? 3000;
    const sliceMs = opts.sliceMs ?? 40;
    const done = { observations: 0, prompts: 0, summaries: 0 };
    const setFts = (t: string, k: string, v: number) => this.db.run(`INSERT INTO ${t}(${t}, rank) VALUES(?, ?)`, [k, v]);
    for (const t of FTS_TABLES) {
      setFts(t, "automerge", 0);
      setFts(t, "crisismerge", 1000);
    }
    /** Scalanie przyrostowe: po 32 strony na krok, aż krok nic nie zmieni. */
    const merge = async (t: string) => {
      const changes = this.db.query("SELECT total_changes() c");
      for (;;) {
        const before = (changes.get() as { c: number }).c;
        setFts(t, "merge", 32);
        if ((changes.get() as { c: number }).c - before < 2) break;
        await breathe();
      }
    };
    try {
      await this.reindexPasses(opts, batch, sliceMs, done, merge);
      this.db.run("INSERT INTO meta(k, v) VALUES ('fts_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [FTS_VERSION]);
    } finally {
      // także po błędzie (SQLITE_BUSY, przerwanie): bez tego hooki pisałyby dalej bez scalania segmentów
      this.ftsMergeDefaults();
    }
    return done;
  }

  /** Domyślne scalanie segmentów FTS5 (automerge 4, crisismerge 16); worker ustawia je też przy starcie. */
  ftsMergeDefaults(): void {
    for (const t of FTS_TABLES) {
      this.db.run(`INSERT INTO ${t}(${t}, rank) VALUES('automerge', 4)`);
      this.db.run(`INSERT INTO ${t}(${t}, rank) VALUES('crisismerge', 16)`);
    }
  }

  private async reindexPasses(
    opts: { onProgress?: (table: string, done: number) => void },
    batch: number,
    sliceMs: number,
    done: { observations: number; prompts: number; summaries: number },
    merge: (t: string) => Promise<void>,
  ): Promise<void> {
    const pass = async (table: keyof typeof done, select: string, write: (r: any) => void) => {
      let last = 0;
      for (;;) {
        const rows = this.db.query(select).all(last, batch) as any[];
        if (!rows.length) break;
        for (let i = 0; i < rows.length; ) {
          const t0 = performance.now();
          this.db.transaction(() => {
            while (i < rows.length) {
              write(rows[i++]);
              if (performance.now() - t0 > sliceMs) break;
            }
          })();
          await breathe(); // oddech dla pętli zdarzeń workera (API odpowiada w trakcie)
        }
        last = rows[rows.length - 1].id;
        done[table] += rows.length;
        opts.onProgress?.(table, done[table]);
      }
      await merge(`${table}_fts`);
    };
    await pass(
      "observations",
      "SELECT id, title, subtitle, narrative, facts, concepts, files_read, files_modified FROM observations WHERE id > ? ORDER BY id LIMIT ?",
      (r) => {
        this.db.run("DELETE FROM observations_fts WHERE rowid = ?", [r.id]);
        this.db.run(
          "INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            r.id,
            ...ftsRow({
              ...r,
              facts: arr(r.facts),
              concepts: arr(r.concepts),
              files_read: arr(r.files_read),
              files_modified: arr(r.files_modified),
            }),
          ],
        );
      },
    );
    await pass("prompts", "SELECT id, text FROM prompts WHERE id > ? ORDER BY id LIMIT ?", (r) => {
      this.db.run("DELETE FROM prompts_fts WHERE rowid = ?", [r.id]);
      this.db.run("INSERT INTO prompts_fts(rowid, text) VALUES (?, ?)", [r.id, foldFts(r.text ?? "")]);
    });
    await pass(
      "summaries",
      "SELECT id, request, investigated, learned, completed, next_steps, notes FROM summaries WHERE id > ? ORDER BY id LIMIT ?",
      (r) => {
        this.db.run("DELETE FROM summaries_fts WHERE rowid = ?", [r.id]);
        this.db.run(
          "INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [r.id, ...summaryFtsRow(r)],
        );
      },
    );
  }

  /** Usuwa sesje razem z notatkami, promptami, podsumowaniami i indeksami (np. transkrypty automatów). */
  purgeSessions(ids: string[]): { sessions: number; observations: number } {
    let observations = 0;
    this.db.transaction(() => {
      for (const sid of ids) {
        const obsIds = (this.db.query("SELECT id FROM observations WHERE session_id = ?").all(sid) as { id: number }[]).map(
          (r) => r.id,
        );
        for (const id of obsIds) {
          this.db.run("DELETE FROM observations_fts WHERE rowid = ?", [id]);
          this.db.run(
            "UPDATE entities SET df = MAX(0, df - 1) WHERE id IN (SELECT entity_id FROM obs_entities WHERE obs_id = ?)",
            [id],
          );
          this.db.run("DELETE FROM obs_entities WHERE obs_id = ?", [id]);
          this.db.run("DELETE FROM access_log WHERE obs_id = ?", [id]);
          this.db.run("DELETE FROM injections WHERE obs_id = ?", [id]);
          this.deleteVector(id);
          this.db.run("DELETE FROM observations WHERE id = ?", [id]);
        }
        observations += obsIds.length;
        for (const { id } of this.db.query("SELECT id FROM prompts WHERE session_id = ?").all(sid) as { id: number }[])
          this.db.run("DELETE FROM prompts_fts WHERE rowid = ?", [id]);
        for (const { id } of this.db.query("SELECT id FROM summaries WHERE session_id = ?").all(sid) as { id: number }[])
          this.db.run("DELETE FROM summaries_fts WHERE rowid = ?", [id]);
        this.db.run("DELETE FROM prompts WHERE session_id = ?", [sid]);
        this.db.run("DELETE FROM summaries WHERE session_id = ?", [sid]);
        this.db.run("DELETE FROM injections WHERE session_id = ?", [sid]);
        this.db.run("DELETE FROM file_injections WHERE session_id = ?", [sid]);
        this.db.run("DELETE FROM access_log WHERE session_id = ?", [sid]);
        this.db.run("DELETE FROM sessions WHERE id = ?", [sid]);
      }
    })();
    return { sessions: ids.length, observations };
  }

  insertPrompt(p: {
    session_id: string;
    project: string;
    n: number;
    text: string;
    created_at: number;
    source?: string;
  }): number | null {
    const r = this.db
      .query(
        `INSERT INTO prompts (session_id, project, n, text, created_at, source) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, n) DO NOTHING RETURNING id`,
      )
      .get(p.session_id, p.project, p.n, p.text, p.created_at, p.source ?? "live") as { id: number } | null;
    if (r) this.db.run("INSERT INTO prompts_fts(rowid, text) VALUES (?, ?)", [r.id, foldFts(p.text)]);
    return r?.id ?? null;
  }

  /**
   * Prompt tury pod jej numerem, a gdy ten numer zajmuje prompt innej tury (claude-mem numerował też pobudki pętli
   * i wiadomości doręczone w trakcie tury), pod numerem zastępczym (substitutePromptN): tekst nie ginie, a numery
   * dalszych tur zostają wolne. Notatka tury zostaje przy numerze tury z transkryptu. Ten sam tekst w tej sesji
   * w tolerancji czasu to ten sam prompt (drugi odczyt tej samej tury): bez drugiego wiersza.
   */
  insertTurnPrompt(p: { session_id: string; project: string; n: number; text: string; created_at: number; source?: string }): {
    id: number;
    n: number;
  } {
    const id = this.insertPrompt(p);
    if (id) return { id, n: p.n };
    const same = this.db
      .query("SELECT id, n FROM prompts WHERE session_id = ? AND text = ? AND ABS(created_at - ?) <= ? ORDER BY n LIMIT 1")
      .get(p.session_id, p.text, p.created_at, SAME_PROMPT_MS) as { id: number; n: number } | null;
    if (same) return same;
    const taken = (
      this.db.query("SELECT n FROM prompts WHERE session_id = ? AND n >= ?").all(p.session_id, PROMPT_SUBST_BASE) as {
        n: number;
      }[]
    ).map((r) => r.n);
    const n = substitutePromptN(p.n, taken);
    return { id: this.insertPrompt({ ...p, n }) as number, n };
  }

  /** Ten sam prompt już jest w sesji (tekst i czas utworzenia), pod dowolnym numerem: import claude-mem po naprawie. */
  hasPrompt(sessionId: string, text: string, createdAt: number): boolean {
    return !!this.db
      .query("SELECT 1 FROM prompts WHERE session_id = ? AND created_at = ? AND text = ? LIMIT 1")
      .get(sessionId, createdAt, text);
  }

  /**
   * Przenumerowania claude-mem z naprawy (sessions.meta.cm_n: numer claude-mem → numer w hipokampie), żeby import
   * zapisywał prompty, notatki i podsumowania claude-mem tych sesji pod nowymi numerami, a nie pod starymi.
   */
  cmPromptMaps(): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    for (const r of this.db
      .query(
        "SELECT id, json_extract(meta, '$.cm_n') m FROM sessions WHERE json_valid(meta) AND json_extract(meta, '$.cm_n') IS NOT NULL",
      )
      .all() as { id: string; m: string | null }[]) {
      const v = obj<Record<string, unknown>>(r.m);
      if (!v || typeof v !== "object") continue;
      const m = new Map<number, number>();
      for (const [k, to] of Object.entries(v))
        if (Number.isInteger(Number(k)) && Number.isInteger(to)) m.set(Number(k), to as number);
      if (m.size) out.set(r.id, m);
    }
    return out;
  }

  /**
   * Numer promptu w claude-mem dla numeru w hipokampie (odwrotność sessions.meta.cm_n): get_tool_uses szuka wywołań
   * w claude-mem po jego numerze promptu, a naprawa mogła go zmienić.
   */
  cmOrigPromptN(sessionId: string, n: number): number {
    const r = this.db
      .query("SELECT json_extract(meta, '$.cm_n') m FROM sessions WHERE id = ? AND json_valid(meta)")
      .get(sessionId) as { m: string | null } | null;
    const v = obj<Record<string, unknown>>(r?.m ?? null);
    if (v && typeof v === "object")
      for (const [k, to] of Object.entries(v)) if (to === n && Number.isInteger(Number(k))) return Number(k);
    return n >= PROMPT_CM_BASE ? n - PROMPT_CM_BASE : n;
  }

  /** Zapis przenumerowań claude-mem sesji (zob. cmPromptMaps); klucze w kolejności numerów. */
  setSessionCmMap(id: string, map: Map<number, number>): void {
    const v = Object.fromEntries([...map].sort((a, b) => a[0] - b[0]).map(([k, to]) => [String(k), to]));
    this.db.run(
      "UPDATE sessions SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.cm_n', json(?)) WHERE id = ?",
      [JSON.stringify(v), id],
    );
  }

  /** Numer promptu w podsumowaniu (naprawa numeracji claude-mem). */
  setSummaryPromptN(id: number, n: number): void {
    this.db.run("UPDATE summaries SET prompt_n = ? WHERE id = ?", [n, id]);
  }

  /** Nowa treść promptu (np. po redakcji sekretów) z przeindeksowaniem FTS. */
  updatePromptText(id: number, text: string): void {
    this.db.transaction(() => {
      this.db.run("UPDATE prompts SET text = ? WHERE id = ?", [text, id]);
      this.db.run("DELETE FROM prompts_fts WHERE rowid = ?", [id]);
      this.db.run("INSERT INTO prompts_fts(rowid, text) VALUES (?, ?)", [id, foldFts(text)]);
    })();
  }

  deletePrompt(id: number): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM prompts_fts WHERE rowid = ?", [id]);
      this.db.run("DELETE FROM prompts WHERE id = ?", [id]);
    })();
  }

  /** Zmiana numeru promptu w sesji; false, gdy numer jest zajęty (UNIQUE(session_id, n)). */
  renumberPrompt(id: number, n: number): boolean {
    return this.db.run("UPDATE OR IGNORE prompts SET n = ? WHERE id = ?", [n, id]).changes > 0;
  }

  /** Licznik promptów sesji razem z sessions.meta.n (numer ostatniej przeczytanej tury, od niego liczy ingest). */
  setSessionPromptCount(id: string, n: number): void {
    this.db.run(
      "UPDATE sessions SET prompt_count = ?, meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.n', ?) WHERE id = ?",
      [n, n, id],
    );
  }

  updateSessionText(id: string, patch: { title?: string | null; first_prompt?: string | null }): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db.run("UPDATE sessions SET title = ?, first_prompt = ? WHERE id = ?", [
      patch.title !== undefined ? patch.title : cur.title,
      patch.first_prompt !== undefined ? patch.first_prompt : cur.first_prompt,
      id,
    ]);
  }

  // ---------- obserwacje ----------

  /**
   * Wstawia obserwację. Duplikat treści w tym samym projekcie (ten sam hash) nie tworzy nowego wiersza,
   * tylko wzmacnia istniejący (occurrence_count++) — powtórzenie to sygnał ważności.
   */
  insertObservation(o: NewObservation, entities: EntityRef[] = []): { id: number; duplicateOf?: number } {
    const facts = o.facts ?? [];
    const hash = o.content_hash ?? contentHash({ project: o.project, title: o.title, narrative: o.narrative, facts });
    if (o.turn_key) {
      const ex = this.db.query("SELECT id FROM observations WHERE turn_key = ?").get(o.turn_key) as { id: number } | null;
      if (ex) return { id: ex.id, duplicateOf: ex.id };
    }
    if (o.source !== "claude-mem") {
      const dup = this.db
        .query(
          "SELECT id FROM observations WHERE project = ? AND content_hash = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        )
        .get(o.project, hash) as { id: number } | null;
      if (dup) {
        // powtórka podbija ważność tylko dwa razy (najwyżej +0,10): rutyna powtarzana setki razy (pobudki pętli, cykliczny
        // prompt) nie może wypchnąć z kontekstu notatek ważnych; CASE widzi licznik sprzed zwiększenia
        this.db.run(
          "UPDATE observations SET occurrence_count = occurrence_count + 1, updated_at = ?, importance = CASE WHEN occurrence_count < 3 THEN MIN(1, importance + 0.05) ELSE importance END WHERE id = ?",
          [o.created_at, dup.id],
        );
        return { id: dup.id, duplicateOf: dup.id };
      }
    }
    const tokens = observationTokens({ title: o.title, subtitle: o.subtitle, narrative: o.narrative, facts });
    const row = this.db
      .query(
        // numer z licznika sqlite_sequence, a nie max(id) + 1: notatki z innych komputerów (src/sync) mają wyższe
        // numery, a licznik wskazuje własną przestrzeń numerów tej maszyny. Bez synchronizacji to samo co AUTOINCREMENT.
        `INSERT INTO observations (id, session_id, project, prompt_n, type, tier, title, subtitle, narrative, facts, concepts,
           files_read, files_modified, text, created_at, updated_at, importance, source, content_hash, turn_key, status,
           occurrence_count, access_count, last_access_at, tokens, git_head, fingerprints, transcript_ref, meta)
         VALUES (COALESCE(?, (SELECT seq + 1 FROM sqlite_sequence WHERE name = 'observations')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        o.id ?? null,
        o.session_id,
        o.project,
        o.prompt_n ?? null,
        o.type,
        o.tier ?? "episodic",
        o.title,
        o.subtitle ?? null,
        o.narrative ?? null,
        J(facts),
        J(o.concepts ?? []),
        J(o.files_read ?? []),
        J(o.files_modified ?? []),
        o.text ?? null,
        o.created_at,
        o.created_at,
        o.importance ?? 0.3,
        o.source,
        hash,
        o.turn_key ?? null,
        o.status ?? "active",
        o.occurrence_count ?? 1,
        o.access_count ?? 0,
        o.last_access_at ?? null,
        tokens,
        o.git_head ?? null,
        o.fingerprints ? J(o.fingerprints) : null,
        o.transcript_ref ? J(o.transcript_ref) : null,
        o.meta ? J(o.meta) : null,
      ) as { id: number };
    this.db.run(
      "INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.id, ...ftsRow({ ...o, facts })],
    );
    if (entities.length) this.linkEntities(row.id, o.project, entities, o.created_at);
    return { id: row.id };
  }

  /**
   * Aktualizacja treści z przeindeksowaniem FTS. Hash treści liczony od nowa jak w insertObservation (inaczej nowa
   * identyczna tura minie deduplikację). Zmiana pól, z których liczony jest wektor, kasuje wektor (worker przeliczy).
   */
  updateObservationContent(
    id: number,
    patch: Partial<
      Pick<
        Observation,
        | "title"
        | "subtitle"
        | "narrative"
        | "facts"
        | "concepts"
        | "type"
        | "importance"
        | "text"
        | "files_read"
        | "files_modified"
      >
    >,
  ): void {
    const cur = this.getObservation(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    const passageChanged =
      next.title !== cur.title ||
      next.subtitle !== cur.subtitle ||
      next.narrative !== cur.narrative ||
      J(next.facts) !== J(cur.facts) ||
      J(next.concepts) !== J(cur.concepts);
    this.db.transaction(() => {
      this.db.run(
        "UPDATE observations SET title = ?, subtitle = ?, narrative = ?, facts = ?, concepts = ?, files_read = ?, files_modified = ?, type = ?, importance = ?, text = ?, tokens = ?, content_hash = ?, updated_at = ? WHERE id = ?",
        [
          next.title,
          next.subtitle,
          next.narrative,
          J(next.facts),
          J(next.concepts),
          J(next.files_read),
          J(next.files_modified),
          next.type,
          next.importance,
          next.text ?? null,
          observationTokens(next),
          contentHash({ project: next.project, title: next.title, narrative: next.narrative, facts: next.facts }),
          Date.now(),
          id,
        ],
      );
      this.db.run("DELETE FROM observations_fts WHERE rowid = ?", [id]);
      this.db.run(
        "INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, ...ftsRow(next)],
      );
      if (passageChanged) this.deleteVector(id);
    })();
  }

  /** Poprawka numeru promptu notatki (naprawa numeracji tur). */
  setObservationPromptN(id: number, n: number): void {
    this.db.run("UPDATE observations SET prompt_n = ? WHERE id = ?", [n, id]);
  }

  /**
   * Notatka-duplikat innej (np. tej samej tury opisanej przez claude-mem): status merged, ślady użycia przechodzą
   * na notatkę docelową, powód w meta. Ważność i licznik powtórzeń celu bez zmian (to nie jest powtórzenie treści).
   */
  mergeDuplicateInto(id: number, into: number, metaPatch: Record<string, unknown>): void {
    this.db.transaction(() => {
      const dup = this.db.query("SELECT meta FROM observations WHERE id = ?").get(id) as { meta: string | null } | null;
      if (!dup) return;
      this.setStatus(id, "merged", { mergedInto: into });
      this.db.run("UPDATE observations SET meta = ? WHERE id = ?", [
        J({ ...(obj<Record<string, unknown>>(dup.meta) ?? {}), ...metaPatch }),
        id,
      ]);
      this.moveUsage(id, into);
    })();
  }

  /**
   * Ślady użycia notatki przechodzą na inną (scalenie): licznik i czas dostępu, log dostępu, a także wstrzyknięcia,
   * żeby sesja, która widziała duplikat, nie dostała celu drugi raz.
   */
  moveUsage(from: number, into: number): void {
    this.db.transaction(() => {
      const u = this.db.query("SELECT access_count, last_access_at, inject_count FROM observations WHERE id = ?").get(from) as {
        access_count: number;
        last_access_at: number | null;
        inject_count: number;
      } | null;
      if (!u) return;
      this.db.run(
        "UPDATE observations SET access_count = access_count + ?, last_access_at = MAX(COALESCE(last_access_at, 0), ?), inject_count = inject_count + ? WHERE id = ?",
        [u.access_count, u.last_access_at ?? 0, u.inject_count, into],
      );
      this.db.run("UPDATE access_log SET obs_id = ? WHERE obs_id = ?", [into, from]);
      this.db.run(
        "INSERT OR IGNORE INTO injections (session_id, obs_id, channel, at, tokens) SELECT session_id, ?, channel, at, tokens FROM injections WHERE obs_id = ?",
        [into, from],
      );
      this.db.run("DELETE FROM injections WHERE obs_id = ?", [from]);
    })();
  }

  setStatus(
    id: number,
    status: Observation["status"],
    opts: { mergedInto?: number; supersededBy?: number; validUntil?: number } = {},
  ): void {
    this.db.run(
      "UPDATE observations SET status = ?, merged_into = COALESCE(?, merged_into), superseded_by = COALESCE(?, superseded_by), valid_until = COALESCE(?, valid_until), updated_at = ? WHERE id = ?",
      [status, opts.mergedInto ?? null, opts.supersededBy ?? null, opts.validUntil ?? null, Date.now(), id],
    );
    // powrót ze scalenia (bity skasował sen): wektor do przeliczenia; sen łapie też powroty surowym UPDATE
    if (status === "active" && this.hasTable("obs_vec_bits")) this.requeueVectors([id]);
  }

  /**
   * Podmienia całe `meta` notatki (redakcja w `hipokamp repair`; scalanie pól to patchObservationMeta), tylko gdy
   * w bazie jest dalej `prev` (surowy JSON przeczytany przed redakcją). false: ktoś zmienił meta w międzyczasie
   * (np. `remember` dopisał klucz tematu), zapis pominięty, następny `repair` zredaguje nową wartość.
   */
  setObservationMeta(id: number, meta: Record<string, unknown>, prev: string | null): boolean {
    return this.db.run("UPDATE observations SET meta = ? WHERE id = ? AND meta IS ?", [J(meta), id, prev]).changes > 0;
  }

  /** Dopisuje pola do meta notatki (np. klucz tematu przy powtórzonym `remember`). */
  patchObservationMeta(id: number, patch: Record<string, unknown>): void {
    const r = this.db.query("SELECT meta FROM observations WHERE id = ?").get(id) as { meta: string | null } | null;
    if (!r) return;
    this.db.run("UPDATE observations SET meta = ? WHERE id = ?", [
      J({ ...(obj<Record<string, unknown>>(r.meta) ?? {}), ...patch }),
      id,
    ]);
  }

  // ---------- zastępowanie po kluczu (core/supersede.ts) ----------

  /**
   * Aktywne notatki projektu danego typu z jawnym kluczem tematu (`meta.key`), od najstarszej. Zakres po ix_obs_type
   * (plus przy `status` wyłącza ix_obs_status, który bez statystyk wygrywał i czytał całą tabelę).
   */
  keyedObservations(project: string, key: string, types: string[]): number[] {
    return (
      this.db
        .query(
          `SELECT id FROM observations WHERE project = ? COLLATE NOCASE AND +status = 'active'
             AND type IN (${types.map(() => "?").join(",")}) AND json_valid(meta) AND json_extract(meta, '$.key') = ?
           ORDER BY created_at, id`,
        )
        .all(project, ...types, key) as { id: number }[]
    ).map((r) => r.id);
  }

  /**
   * Znane nazwy projektów (sen: weto podmiany nazwy w tytułach): klucze sesji, projekty aliasów i ostatni człon ich
   * katalogów (nazwa repo), klucze i cele scaleń. Bez czytania notatek: indeks sesji i małe tabele.
   */
  projectNames(): string[] {
    const out = (
      this.db.query("SELECT DISTINCT project p FROM sessions UNION SELECT project FROM project_aliases").all() as { p: string }[]
    ).map((r) => r.p);
    for (const r of this.db.query("SELECT cwd FROM project_aliases").all() as { cwd: string }[])
      out.push(
        r.cwd
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ?? "",
      );
    const merges = this.db.query("SELECT v FROM meta WHERE k = ?").get(PROJECT_MERGES_KEY) as { v: string } | null;
    for (const [from, into] of parseProjectMerges(merges?.v)) out.push(from, into);
    return out.filter(Boolean);
  }

  /**
   * Strona aktywnych notatek z digestu (także backfill) jednego typu, wszystkie projekty, o numerach mniejszych niż
   * `beforeId`, od najwyższego numeru: same numery, projekt i data (sen). Zakres po ix_obs_type (typ, rowid), plus
   * przy `status` wyłącza ix_obs_status, który bez statystyk (ANALYZE) wygrywał i czytał całą tabelę. Koszt to
   * liczba decyzji albo preferencji, nie całej tabeli, i jedno przejście dla wszystkich projektów (sen grupuje je sam,
   * bez wielkości liter; zapytanie na grupę z `project = ? COLLATE NOCASE` czytało całą tabelę za każdym razem).
   */
  keyedDigestRefsPage(type: string, beforeId: number, limit: number): { id: number; project: string; created_at: number }[] {
    return this.db
      .query(
        `SELECT id, project, created_at FROM observations WHERE type = ? AND id < ? AND +status = 'active'
           AND source IN ('digest', 'backfill') ORDER BY id DESC LIMIT ?`,
      )
      .all(type, beforeId, limit) as { id: number; project: string; created_at: number }[];
  }

  /**
   * Notatka zastąpiona nowszą: status `superseded`, `superseded_by`, `valid_until`, powód w `meta.supersede`.
   * Obie notatki czytane w transakcji: zastępowana musi być aktywna i zastępująca też (inaczej odsyłacz wskazywałby
   * notatkę, której nie ma w wyszukiwaniu, a zastąpiona zniknęłaby bez następcy). false, gdy nic nie zmieniono.
   * Ślady użycia zostają: to inna treść.
   */
  supersedeObservation(id: number, by: number, info: Record<string, unknown>): boolean {
    return this.db
      .transaction((): boolean => {
        const st = this.db.query("SELECT status, meta FROM observations WHERE id = ?");
        const r = st.get(id) as { status: string; meta: string | null } | null;
        if (r?.status !== "active" || id === by) return false;
        if ((st.get(by) as { status: string } | null)?.status !== "active") return false;
        const now = Date.now();
        const meta = { ...(obj<Record<string, unknown>>(r.meta) ?? {}), supersede: { by, at: now, ...info } };
        this.db.run(
          "UPDATE observations SET status = 'superseded', superseded_by = ?, valid_until = ?, updated_at = ?, meta = ? WHERE id = ?",
          [by, now, now, J(meta), id],
        );
        return true;
      })
      .immediate();
  }

  /**
   * Cofnięcie zastąpienia (forget z undo, obok przywracania z archiwum): notatki `superseded` (klucz, sen, jawne
   * supersedes) wracają jako aktywne, bez `superseded_by` i `valid_until`. W `meta.supersede_undone` zostaje, kto je
   * zastąpił: sen nie zastąpi ich drugi raz sam (jawny klucz w `remember` może). Inne stany bez zmian. Zwraca
   * przywrócone numery (kolejność wejścia, bez powtórzeń).
   */
  restoreSuperseded(ids: number[]): number[] {
    const changed: number[] = [];
    this.db
      .transaction(() => {
        for (const id of new Set(ids)) if (this.unsupersede(id)) changed.push(id);
      })
      .immediate();
    return changed;
  }

  /** Jedna notatka `superseded` z powrotem jako aktywna (wywołujący trzyma transakcję). false: inny stan. */
  private unsupersede(id: number): boolean {
    const r = this.db.query("SELECT status, superseded_by, meta FROM observations WHERE id = ?").get(id) as {
      status: string;
      superseded_by: number | null;
      meta: string | null;
    } | null;
    if (r?.status !== "superseded") return false;
    const { supersede: _s, ...rest } = obj<Record<string, unknown>>(r.meta) ?? {};
    const meta = { ...rest, supersede_undone: { by: r.superseded_by, at: Date.now() } };
    this.db.run(
      "UPDATE observations SET status = 'active', superseded_by = NULL, valid_until = NULL, updated_at = ?, meta = ? WHERE id = ?",
      [Date.now(), J(meta), id],
    );
    // jak w setStatus: gdyby bity zniknęły, wektor wraca do kolejki (sen przycina dziś tylko usunięte i scalone)
    if (this.hasTable("obs_vec_bits")) this.requeueVectors([id]);
    return true;
  }

  /**
   * Zapomnienie (MCP forget, podgląd): aktywne notatki idą do archiwum. meta.forgotten_at znaczy archiwum z ręki
   * człowieka albo modelu (nie snu), powód trafia do meta.forget_reason po redakcji sekretów: pisze go model, więc to
   * dane z transkryptu. Miękko: numer #id i treść zostają. Notatki w innym stanie (scalone, zastąpione, już
   * w archiwum) bez zmian. Zwraca zmienione id.
   */
  forgetObservations(ids: number[], reason?: string | null): number[] {
    const cleaned = clean(reason).trim();
    const why = cleaned ? truncate(cleaned, 300) : null;
    return this.changeStatus(ids, "active", "archived", (id) => {
      this.db.run(
        `UPDATE observations SET meta = CASE WHEN ?1 IS NULL THEN json_set(${META_OBJECT}, '$.forgotten_at', ?2)
           ELSE json_set(${META_OBJECT}, '$.forgotten_at', ?2, '$.forget_reason', ?1) END WHERE id = ?3`,
        [why, Date.now(), id],
      );
    });
  }

  /**
   * Cofnięcie historii w harnessie (Gemini CLI `$rewindTo`): aktywne notatki tur sesji z chwili `from` i późniejsze
   * idą do archiwum ze znacznikiem meta.rewound_at (numer #id i treść zostają, przywraca restoreObservations).
   * Bez własnej transakcji: woła go zapis tury w swojej. Zwraca zmienione id.
   */
  archiveRewoundTurns(sessionId: string, from: number, pos: number, at = Date.now()): number[] {
    // tylko tury przed znacznikiem w transkrypcie (koniec tury nie dalej niż znacznik): tura zapisana po cofnięciu
    // (nowa odpowiedź na poprawiony prompt) zostaje, nawet gdy jej czas jest późniejszy niż cofnięta wiadomość
    const ids = (
      this.db
        .query(
          "SELECT id FROM observations WHERE session_id = ? AND status = 'active' AND turn_key IS NOT NULL AND created_at >= ? AND (CASE WHEN json_valid(transcript_ref) THEN json_extract(transcript_ref, '$.to') END) <= ? ORDER BY id",
        )
        .all(sessionId, from, pos) as { id: number }[]
    ).map((r) => r.id);
    for (const id of ids) {
      this.setStatus(id, "archived");
      this.db.run(`UPDATE observations SET meta = json_set(${META_OBJECT}, '$.rewound_at', ?) WHERE id = ?`, [at, id]);
    }
    return ids;
  }

  /** Czas notatki tury o kluczu `turnKey` w sesji (cofnięcie do tury przeczytanej wcześniejszym odczytem) albo null. */
  turnObservationTime(sessionId: string, turnKey: string): number | null {
    const r = this.db
      .query("SELECT created_at FROM observations WHERE session_id = ? AND turn_key = ?")
      .get(sessionId, turnKey) as { created_at: number } | null;
    return r?.created_at ?? null;
  }

  /**
   * Przywrócenie (MCP forget z undo, podgląd): jedna ścieżka dla archiwum i notatek zastąpionych, scalone bez zmian.
   * Z archiwum: po zapomnieniu (meta.forgotten_at) to cofnięcie, znika znacznik i powód, a meta wraca do stanu sprzed
   * zapomnienia; po archiwum snu meta.restored_at chroni notatkę przed ponowną archiwizacją w następnym śnie (człowiek
   * zdecydował, że ma zostać). Zastąpiona wraca jak w restoreSuperseded. Obie drogi oddają wektor do kolejki, gdy
   * brakuje mu bitów. Zwraca przywrócone numery (kolejność wejścia, bez powtórzeń).
   */
  restoreObservations(ids: number[]): number[] {
    const st = this.db.query("SELECT status FROM observations WHERE id = ?");
    const changed: number[] = [];
    this.db
      .transaction(() => {
        for (const id of new Set(ids)) {
          const status = (st.get(id) as { status: string } | null)?.status;
          if (status === "superseded") {
            if (this.unsupersede(id)) changed.push(id);
            continue;
          }
          if (status !== "archived") continue;
          this.setStatus(id, "active");
          this.db.run(
            `UPDATE observations SET meta = CASE WHEN json_extract(${META_OBJECT}, '$.forgotten_at') IS NOT NULL
               THEN json_remove(${META_OBJECT}, '$.forgotten_at', '$.forget_reason')
               ELSE json_remove(json_set(${META_OBJECT}, '$.restored_at', ?), '$.forget_reason') END WHERE id = ?`,
            [Date.now(), id],
          );
          changed.push(id);
        }
      })
      .immediate();
    return changed;
  }

  /** Zmiana statusu from → to w jednej transakcji, kolejność i duplikaty id jak w wejściu (pierwsze wystąpienie). */
  private changeStatus(
    ids: number[],
    from: Observation["status"],
    to: Observation["status"],
    after: (id: number) => void,
  ): number[] {
    const st = this.db.query("SELECT status FROM observations WHERE id = ?");
    const changed: number[] = [];
    this.db
      .transaction(() => {
        for (const id of new Set(ids)) {
          if ((st.get(id) as { status: string } | null)?.status !== from) continue;
          this.setStatus(id, to);
          after(id);
          changed.push(id);
        }
      })
      .immediate();
    return changed;
  }

  // ---------- dziennik zmian statusu (wyzwalacz tr_obs_status, migracja 6) ----------

  /** Ostatni nadany numer zmiany statusu (z sqlite_sequence: przycięty do zera dziennik nie cofa kursora). */
  maxStatusChangeId(): number {
    return (
      this.db
        .query(
          "SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'status_log'), 0), COALESCE((SELECT MAX(id) FROM status_log), 0)) m",
        )
        .get() as { m: number }
    ).m;
  }

  /** Zmiany statusu po numerze `afterId` (kursor strumienia), najwyżej do `upTo`, od najstarszej. */
  statusChangesSince(afterId: number, limit: number, upTo = Number.MAX_SAFE_INTEGER): StatusChange[] {
    return this.db
      .query("SELECT id, obs_id, from_status, to_status, at FROM status_log WHERE id > ? AND id <= ? ORDER BY id LIMIT ?")
      .all(afterId, upTo, limit) as StatusChange[];
  }

  /**
   * Numery własnych notatek po `afterId` (kursor strumienia), najwyżej do `upTo` i do licznika sqlite_sequence,
   * rosnąco. Notatki z innych komputerów (src/sync) mają numery z przestrzeni urządzenia źródłowego, często wyższe od
   * licznika: nie przestawiają kursora strumienia (inaczej własne nowe notatki poniżej nich nigdy by nie wyszły),
   * podgląd pokazuje je po odświeżeniu. Bez licznika (pusta tabela) granicą jest samo `upTo`.
   */
  observationIdsAfter(afterId: number, limit: number, upTo = Number.MAX_SAFE_INTEGER): number[] {
    return (
      this.db
        .query(
          "SELECT id FROM observations WHERE id > ? AND id <= MIN(?, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'observations'), ?)) ORDER BY id LIMIT ?",
        )
        .all(afterId, upTo, upTo, limit) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Dziennik rośnie z każdą zmianą statusu; strumieniowi wystarczy świeża część (przycina sen). */
  pruneStatusLog(olderThan: number): number {
    return this.db.run("DELETE FROM status_log WHERE at < ?", [olderThan]).changes;
  }

  getObservation(id: number): Observation | null {
    const r = this.db.query("SELECT * FROM observations WHERE id = ?").get(id);
    return r ? rowToObservation(r) : null;
  }

  getObservations(ids: number[]): Observation[] {
    if (!ids.length) return [];
    const rows = this.db.query(`SELECT * FROM observations WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
    const byId = new Map((rows as any[]).map((r) => [r.id, rowToObservation(r)]));
    return ids.map((i) => byId.get(i)).filter(Boolean) as Observation[];
  }

  recentObservations(
    project: string | null,
    limit: number,
    opts: { before?: number; beforeId?: number; types?: string[]; status?: RecentStatus[]; excludeSources?: string[] } = {},
  ): Observation[] {
    // archiwum w podglądzie to ta sama lista z innymi statusami (zapomniane, odłożone przez sen, zastąpione); stałe
    // w SQL z białej listy, nie parametry: plan zapytania zostaje taki sam jak dla samych aktywnych
    const statuses = [...new Set(opts.status?.filter((s) => RECENT_STATUSES.includes(s)) ?? [])];
    const list = statuses.length ? statuses : ["active"];
    const where = [list.length === 1 ? `status = '${list[0]}'` : `status IN (${list.map((s) => `'${s}'`).join(", ")})`];
    const params: any[] = [];
    if (project) {
      where.push("project = ? COLLATE NOCASE");
      params.push(project);
    }
    // kursor (created_at, id): notatki z tym samym czasem (import, backfill) nie giną między stronami
    if (opts.before && opts.beforeId) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(opts.before, opts.before, opts.beforeId);
    } else if (opts.before) {
      where.push("created_at < ?");
      params.push(opts.before);
    }
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => "?").join(",")})`);
      params.push(...opts.types);
    }
    // w zapytaniu, nie po nim: odrzucone źródła nie zajmują miejsc w limicie
    if (opts.excludeSources?.length) {
      where.push(`source NOT IN (${opts.excludeSources.map(() => "?").join(",")})`);
      params.push(...opts.excludeSources);
    }
    params.push(limit);
    return (
      this.db
        .query(`SELECT * FROM observations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params) as any[]
    ).map(rowToObservation);
  }

  sessionObservations(sessionId: string): Observation[] {
    return (
      this.db
        .query("SELECT * FROM observations WHERE session_id = ? AND status = 'active' ORDER BY created_at, id")
        .all(sessionId) as any[]
    ).map(rowToObservation);
  }

  /**
   * Notatka przyszła z innego komputera (synchronizacja, src/sync): w mapie gid ma wpis z cudzym pochodzeniem i żadnego
   * z własnym (numery, pod którymi ta baza była w grupie: meta.sync_own_devices). Bez synchronizacji mapa jest pusta.
   * Ta sama treść zapisana tu i przysłana (deduplikacja przy odbiorze) liczy się jako przysłana, dopóki ta baza jej nie
   * wyśle: wysyłka pomija wiersz, który ma już gid.
   */
  isForeignObservation(id: number): boolean {
    const r = this.db
      .query(
        `SELECT COUNT(*) n, COALESCE(SUM(origin IN (SELECT j.value FROM meta, json_each(CASE WHEN json_valid(meta.v) THEN meta.v ELSE '[]' END) j
                                         WHERE meta.k = 'sync_own_devices')), 0) own
         FROM sync_map WHERE kind = 'obs' AND local_id = ?`,
      )
      .get(id) as { n: number; own: number };
    return r.n > 0 && r.own === 0;
  }

  /** Najwyższy własny numer notatki: licznik sqlite_sequence (notatki z innych komputerów mogą mieć wyższe numery). */
  maxObservationId(): number {
    return (
      this.db
        .query(
          "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'observations'), (SELECT MAX(id) FROM observations), 0) m",
        )
        .get() as { m: number }
    ).m;
  }

  /**
   * Notatki do powiadomień: utworzone od chwili `since` (indeks dat), aktywne, wybrane typy i źródła, minimalna
   * ważność; najnowsze pierwsze. Plusy przed kolumnami wyłączają indeksy typu i statusu: okno czasu jest małe, a skan
   * po statusie objąłby bazę. Okno po dacie, nie po numerze: numery z innych urządzeń (synchronizacja) nie przesuwają
   * niczego ponad lokalne notatki.
   */
  observationsCreatedSince(
    since: number,
    f: { types: string[]; sources: string[]; minImportance: number; limit: number },
  ): Observation[] {
    if (!f.types.length || !f.sources.length) return [];
    const rows = this.db
      .query(
        `SELECT * FROM observations WHERE created_at >= ? AND +status = 'active' AND +importance >= ?
           AND +type IN (${f.types.map(() => "?").join(",")}) AND +source IN (${f.sources.map(() => "?").join(",")})
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(since, f.minImportance, ...f.types, ...f.sources, f.limit) as any[];
    return rows.map(rowToObservation);
  }

  // ---------- encje (graf) ----------

  linkEntities(obsId: number, project: string, ents: EntityRef[], at: number): void {
    const up = this.db.query(
      `INSERT INTO entities (kind, project, key, df, last_seen_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(kind, project, key) DO UPDATE SET df = df + 1, last_seen_at = MAX(COALESCE(last_seen_at,0), excluded.last_seen_at)
       RETURNING id`,
    );
    const link = this.db.query("INSERT OR IGNORE INTO obs_entities (obs_id, entity_id, role) VALUES (?, ?, ?)");
    const seen = new Set<string>();
    for (const e of ents) {
      const k = `${e.kind}|${e.key}|${e.role}`;
      if (seen.has(k) || !e.key) continue;
      seen.add(k);
      const scope = e.kind === "concept" || e.kind === "tool" || e.kind === "url" ? "" : project;
      const { id } = up.get(e.kind, scope, e.key, at) as { id: number };
      link.run(obsId, id, e.role);
    }
  }

  /**
   * Nowy klucz encji (np. po redakcji sekretu, klucz pliku względem repo). Gdy encja z takim kluczem już jest,
   * powiązania przechodzą na nią, a jej `df` liczy się od nowa z powiązań (notatka powiązana z obiema liczy się raz).
   * Zwraca encję, która została (scalona: id celu).
   */
  renameEntityKey(id: number, key: string): number {
    return this.db.transaction(() => {
      const e = this.db.query("SELECT kind, project, df, last_seen_at FROM entities WHERE id = ?").get(id) as {
        kind: string;
        project: string;
        df: number;
        last_seen_at: number | null;
      } | null;
      if (!e) return id;
      const other = this.db
        .query("SELECT id FROM entities WHERE kind = ? AND project = ? AND key = ? AND id != ?")
        .get(e.kind, e.project, key, id) as { id: number } | null;
      if (!other) {
        this.db.run("UPDATE entities SET key = ? WHERE id = ?", [key, id]);
        return id;
      }
      this.db.run(
        "INSERT OR IGNORE INTO obs_entities (obs_id, entity_id, role) SELECT obs_id, ?, role FROM obs_entities WHERE entity_id = ?",
        [other.id, id],
      );
      this.db.run("DELETE FROM obs_entities WHERE entity_id = ?", [id]);
      this.db.run("UPDATE entities SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?) WHERE id = ?", [
        e.last_seen_at ?? 0,
        other.id,
      ]);
      this.recountEntityDf(other.id);
      this.db.run("DELETE FROM entities WHERE id = ?", [id]);
      return other.id;
    })();
  }

  /**
   * `df` encji od nowa: liczba różnych notatek z powiązaniem (po scaleniu encji, gdy ta sama notatka była powiązana
   * z obiema, suma `df` liczyłaby ją dwa razy).
   */
  recountEntityDf(id: number): void {
    this.db.run("UPDATE entities SET df = (SELECT COUNT(DISTINCT obs_id) FROM obs_entities WHERE entity_id = ?1) WHERE id = ?1", [
      id,
    ]);
  }

  /** Nowe listy plików notatki (np. klucze względem repo) z przeindeksowaniem FTS; odciski pod nowymi kluczami. */
  updateObservationFiles(
    id: number,
    patch: { files_read: string[]; files_modified: string[]; fingerprints: Record<string, string> | null },
  ): void {
    const cur = this.getObservation(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db.transaction(() => {
      this.db.run("UPDATE observations SET files_read = ?, files_modified = ?, fingerprints = ? WHERE id = ?", [
        J(next.files_read),
        J(next.files_modified),
        next.fingerprints ? J(next.fingerprints) : null,
        id,
      ]);
      this.db.run("DELETE FROM observations_fts WHERE rowid = ?", [id]);
      this.db.run(
        "INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, ...ftsRow(next)],
      );
    })();
  }

  entityIds(kind: string, project: string, keys: string[]): Map<string, { id: number; df: number }> {
    const out = new Map<string, { id: number; df: number }>();
    if (!keys.length) return out;
    const scope = kind === "concept" || kind === "tool" || kind === "url" ? "" : project;
    const rows = this.db
      .query(`SELECT id, key, df FROM entities WHERE kind = ? AND project = ? AND key IN (${keys.map(() => "?").join(",")})`)
      .all(kind, scope, ...keys) as { id: number; key: string; df: number }[];
    for (const r of rows) out.set(r.key, { id: r.id, df: r.df });
    return out;
  }

  // ---------- podsumowania ----------

  insertSummary(s: Omit<Summary, "id"> & { id?: number; meta?: Record<string, unknown> | null }): number {
    const r = this.db
      .query(
        // numer z licznika jak w insertObservation (własna przestrzeń numerów maszyny przy synchronizacji)
        `INSERT INTO summaries (id, session_id, project, request, investigated, learned, completed, next_steps, notes,
           files_read, files_edited, prompt_n, created_at, source, meta)
         VALUES (COALESCE(?, (SELECT seq + 1 FROM sqlite_sequence WHERE name = 'summaries')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        s.id ?? null,
        s.session_id,
        s.project,
        s.request,
        s.investigated,
        s.learned,
        s.completed,
        s.next_steps,
        s.notes,
        J(s.files_read),
        J(s.files_edited),
        s.prompt_n,
        s.created_at,
        s.source,
        s.meta ? J(s.meta) : null,
      ) as { id: number };
    this.db.run(
      "INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [r.id, ...summaryFtsRow(s)],
    );
    return r.id;
  }

  /** Nowa treść pól podsumowania (np. po redakcji sekretów) z przeindeksowaniem FTS. */
  updateSummaryText(
    id: number,
    patch: Partial<
      Pick<Summary, "request" | "investigated" | "learned" | "completed" | "next_steps" | "notes" | "files_read" | "files_edited">
    >,
  ): void {
    const row = this.db.query("SELECT * FROM summaries WHERE id = ?").get(id);
    if (!row) return;
    const next = { ...rowToSummary(row), ...patch };
    this.db.transaction(() => {
      this.db.run(
        "UPDATE summaries SET request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ?, notes = ?, files_read = ?, files_edited = ? WHERE id = ?",
        [
          next.request,
          next.investigated,
          next.learned,
          next.completed,
          next.next_steps,
          next.notes,
          J(next.files_read),
          J(next.files_edited),
          id,
        ],
      );
      this.db.run("DELETE FROM summaries_fts WHERE rowid = ?", [id]);
      this.db.run(
        "INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, ...summaryFtsRow(next)],
      );
    })();
  }

  /** Zastępuje podsumowanie sesji (live: przy każdym SessionEnd budujemy od nowa; sync: numer z komputera źródłowego). */
  replaceSessionSummary(sessionId: string, s: Omit<Summary, "id"> & { id?: number }): number {
    const old = this.db.query("SELECT id FROM summaries WHERE session_id = ? AND source = ?").all(sessionId, s.source) as {
      id: number;
    }[];
    for (const o of old) {
      this.db.run("DELETE FROM summaries WHERE id = ?", [o.id]);
      this.db.run("DELETE FROM summaries_fts WHERE rowid = ?", [o.id]);
    }
    return this.insertSummary(s);
  }

  /** Najnowsze podsumowania, jedno na sesję (sesja z kompakcjami ma ich kilka: bierzemy najświeższe). */
  recentSummaries(project: string | null, limit: number): Summary[] {
    const where = project ? "WHERE project = ? COLLATE NOCASE" : "";
    const rows = this.db
      .query(
        `SELECT * FROM summaries WHERE id IN (
           SELECT MAX(id) FROM summaries ${where} GROUP BY COALESCE(session_id, 'id:' || id)
         ) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...(project ? [project] : []), limit);
    return (rows as any[]).map(rowToSummary);
  }

  /** Lista podsumowań (jedno na sesję) z zakresem dat, kierunkiem i przesunięciem w SQL (MCP search bez zapytania). */
  listSummaries(o: {
    project: string | null;
    since?: number;
    until?: number;
    asc?: boolean;
    limit: number;
    offset?: number;
  }): Summary[] {
    const inner = o.project ? "WHERE project = ? COLLATE NOCASE" : "";
    const where: string[] = [];
    const params: (string | number)[] = o.project ? [o.project] : [];
    if (o.since) {
      where.push("created_at >= ?");
      params.push(o.since);
    }
    if (o.until) {
      where.push("created_at <= ?");
      params.push(o.until);
    }
    const dir = o.asc ? "ASC" : "DESC";
    const rows = this.db
      .query(
        `SELECT * FROM summaries WHERE id IN (
           SELECT MAX(id) FROM summaries ${inner} GROUP BY COALESCE(session_id, 'id:' || id)
         )${where.length ? ` AND ${where.join(" AND ")}` : ""} ORDER BY created_at ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.max(1, o.limit), Math.max(0, o.offset ?? 0));
    return (rows as any[]).map(rowToSummary);
  }

  /** Lista promptów z zakresem dat, kierunkiem i przesunięciem w SQL. */
  listPrompts(o: { project: string | null; since?: number; until?: number; asc?: boolean; limit: number; offset?: number }): {
    id: number;
    project: string;
    n: number;
    text: string;
    created_at: number;
  }[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (o.project) {
      where.push("project = ? COLLATE NOCASE");
      params.push(o.project);
    }
    if (o.since) {
      where.push("created_at >= ?");
      params.push(o.since);
    }
    if (o.until) {
      where.push("created_at <= ?");
      params.push(o.until);
    }
    const dir = o.asc ? "ASC" : "DESC";
    return this.db
      .query(
        `SELECT id, project, n, text, created_at FROM prompts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.max(1, o.limit), Math.max(0, o.offset ?? 0)) as any[];
  }

  // ---------- wektory ----------

  putVector(obsId: number, project: string, model: string, q8: Int8Array, bits: Uint8Array, withBits: boolean): void {
    this.db.run(
      "INSERT INTO obs_vectors (obs_id, model, q8, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(obs_id) DO UPDATE SET model = excluded.model, q8 = excluded.q8, created_at = excluded.created_at",
      [obsId, model, new Uint8Array(q8.buffer, q8.byteOffset, q8.byteLength), Date.now()],
    );
    if (withBits) {
      this.db.run("DELETE FROM obs_vec_bits WHERE obs_id = ?", [obsId]);
      this.db.run("INSERT INTO obs_vec_bits (obs_id, project, emb) VALUES (?, ?, vec_bit(?))", [
        obsId,
        project.toLowerCase(),
        bits,
      ]);
    }
  }

  deleteVector(obsId: number): void {
    this.db.run("DELETE FROM obs_vectors WHERE obs_id = ?", [obsId]);
    try {
      this.db.run("DELETE FROM obs_vec_bits WHERE obs_id = ?", [obsId]);
    } catch {}
  }

  private hasTable(name: string): boolean {
    return !!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  /**
   * Wiersze obs_vec_bits sieroce (notatka usunięta albo scalona) z kawałka od `afterId` w górę. Notatki zarchiwizowane
   * i zastąpione zachowują bity: wyszukiwanie z archiwum (`includeArchived`) bierze je z wektorów, a przywrócone
   * surowym UPDATE nie zostają bez bitów. Scalona notatka wraca tylko przez rozbicie scalenia (rzadko), a wtedy
   * `setStatus` albo sen (`activeWithoutBits`) przelicza jej wektor.
   * Czyta tabelę cienia vec0 `obs_vec_bits_rowids` (rowid = obs_id, zwykłe B-drzewo: kawałek 2000 wierszy to kilka ms;
   * pełny skan vec0 to ok. 150 ms na 110 tys.). Bez tej tabeli (inny układ sqlite-vec) jeden pełny skan vec0.
   * `last` = ostatnie przejrzane id albo null (koniec tabeli).
   */
  orphanVectorBits(afterId: number, limit: number): { ids: number[]; last: number | null } {
    if (!this.hasTable("obs_vec_bits_rowids")) {
      const rows = this.db
        .query(
          "SELECT b.obs_id id FROM obs_vec_bits b LEFT JOIN observations o ON o.id = b.obs_id WHERE b.obs_id > ? AND (o.id IS NULL OR o.status = 'merged')",
        )
        .all(afterId) as { id: number }[];
      return { ids: rows.map((r) => r.id), last: null };
    }
    const rows = this.db
      .query(
        "SELECT r.rowid id, o.status FROM obs_vec_bits_rowids r LEFT JOIN observations o ON o.id = r.rowid WHERE r.rowid > ? ORDER BY r.rowid LIMIT ?",
      )
      .all(afterId, limit) as { id: number; status: string | null }[];
    return {
      ids: rows.filter((r) => r.status === null || r.status === "merged").map((r) => r.id),
      last: rows.length < limit ? null : rows[rows.length - 1].id,
    };
  }

  /** Liczba osieroconych wierszy obs_vec_bits (jak wyżej); null, gdy w bazie nie ma tabeli wektorów binarnych. */
  countOrphanVectorBits(): number | null {
    if (!this.hasTable("obs_vec_bits")) return null;
    const sql = this.hasTable("obs_vec_bits_rowids")
      ? "SELECT COUNT(*) c FROM obs_vec_bits_rowids r LEFT JOIN observations o ON o.id = r.rowid WHERE o.id IS NULL OR o.status = 'merged'"
      : "SELECT COUNT(*) c FROM obs_vec_bits b LEFT JOIN observations o ON o.id = b.obs_id WHERE o.id IS NULL OR o.status = 'merged'";
    try {
      return (this.db.query(sql).get() as { c: number }).c;
    } catch {
      return null; // vec0 niezaładowany w tym połączeniu
    }
  }

  /**
   * Usuwa wiersze obs_vec_bits (zawsze przez vec0, nigdy z tabel cienia), o ile notatka nadal jest usunięta albo
   * scalona: między wyszukaniem a usunięciem mogła wrócić. Zwraca liczbę usuniętych.
   */
  deleteOrphanVectorBits(ids: number[]): number {
    const status = this.db.query("SELECT status FROM observations WHERE id = ?");
    const del = this.db.query("DELETE FROM obs_vec_bits WHERE obs_id = ?");
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        const s = (status.get(id) as { status: string } | null)?.status;
        if (s !== undefined && s !== "merged") continue;
        if (del.run(id).changes > 0) n++;
      }
    })();
    return n;
  }

  /**
   * Aktywne notatki z wektorem q8, ale bez wiersza bitów (kawałek od `afterId`): wróciły ze scalenia albo zostały
   * przywrócone surowym UPDATE, a wyszukiwanie wektorowe ich nie widzi (kandydaci idą z bitów). Null, gdy w bazie
   * nie ma wektorów binarnych.
   */
  activeWithoutBits(afterId: number, limit: number): { ids: number[]; last: number | null } | null {
    if (!this.hasTable("obs_vec_bits")) return null;
    const probe = this.hasTable("obs_vec_bits_rowids")
      ? "SELECT 1 FROM obs_vec_bits_rowids r WHERE r.rowid = v.obs_id"
      : "SELECT 1 FROM obs_vec_bits b WHERE b.obs_id = v.obs_id";
    let rows: { id: number; bad: number }[];
    try {
      rows = this.db
        .query(
          `SELECT v.obs_id id, o.status = 'active' AND NOT EXISTS (${probe}) bad FROM obs_vectors v
           JOIN observations o ON o.id = v.obs_id WHERE v.obs_id > ? ORDER BY v.obs_id LIMIT ?`,
        )
        .all(afterId, limit) as { id: number; bad: number }[];
    } catch {
      return null; // vec0 niezaładowany w tym połączeniu
    }
    return {
      ids: rows.filter((r) => r.bad).map((r) => r.id),
      last: rows.length < limit ? null : rows[rows.length - 1].id,
    };
  }

  /**
   * Wektor do przeliczenia: kasuje q8 aktywnej notatki bez wiersza bitów, a pętla wektorów liczy go od nowa razem
   * z bitami. Przeliczenie, a nie bity z q8: składowe bliskie zera mają q8 = 0, więc bity z q8 różniłyby się od
   * oryginału w ok. 5% pozycji. Zwraca liczbę notatek oddanych do przeliczenia.
   */
  requeueVectors(ids: number[]): number {
    if (!ids.length) return 0;
    let bits: { get: (id: number) => unknown };
    try {
      bits = this.db.query("SELECT 1 FROM obs_vec_bits WHERE obs_id = ?");
    } catch {
      return 0; // vec0 niezaładowany w tym połączeniu (CLI bez sqlite-vec): naprawi to sen w workerze
    }
    const st = this.db.query("SELECT status FROM observations WHERE id = ?");
    const del = this.db.query("DELETE FROM obs_vectors WHERE obs_id = ?");
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        if ((st.get(id) as { status: string } | null)?.status !== "active") continue;
        if (bits.get(id)) continue;
        n += del.run(id).changes;
      }
    })();
    return n;
  }

  /** Obserwacje bez wektora (kolejka embeddingów bez osobnej tabeli zadań). */
  missingVectors(limit: number): {
    id: number;
    project: string;
    title: string;
    subtitle: string | null;
    narrative: string | null;
    facts: string;
    concepts: string;
  }[] {
    return this.db
      .query(
        // po kluczu głównym od najnowszych: bez sortowania całej tabeli (0,7 s przy 110 tys. wierszy)
        `SELECT o.id, o.project, o.title, o.subtitle, o.narrative, o.facts, o.concepts FROM observations o
         WHERE o.status IN ('active','archived') AND NOT EXISTS (SELECT 1 FROM obs_vectors v WHERE v.obs_id = o.id)
         ORDER BY o.id DESC LIMIT ?`,
      )
      .all(limit) as any[];
  }

  /** Bieżące pola, z których liczony jest wektor (sprawdzenie przed zapisem: notatka mogła się zmienić albo zniknąć). */
  vectorSources(ids: number[]): Map<
    number,
    {
      id: number;
      project: string;
      title: string;
      subtitle: string | null;
      narrative: string | null;
      facts: string;
      concepts: string;
    }
  > {
    const out = new Map<number, any>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of this.db
        .query(
          `SELECT id, project, title, subtitle, narrative, facts, concepts FROM observations WHERE id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk) as any[])
        out.set(r.id, r);
    }
    return out;
  }

  countMissingVectors(): number {
    return (
      this.db
        .query(
          "SELECT COUNT(*) c FROM observations o LEFT JOIN obs_vectors v ON v.obs_id = o.id WHERE v.obs_id IS NULL AND o.status IN ('active','archived')",
        )
        .get() as {
        c: number;
      }
    ).c;
  }

  getVectorsQ8(ids: number[]): Map<number, Int8Array> {
    const out = new Map<number, Int8Array>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .query(`SELECT obs_id, q8 FROM obs_vectors WHERE obs_id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk) as {
        obs_id: number;
        q8: Uint8Array;
      }[];
      for (const r of rows) out.set(r.obs_id, new Int8Array(r.q8.buffer, r.q8.byteOffset, r.q8.byteLength));
    }
    return out;
  }

  // ---------- dostęp / wstrzyknięcia (wzmacnianie) ----------

  logAccess(
    ids: number[],
    kind: "fetched" | "cited" | "search_hit" | "injected",
    sessionId: string | null,
    at = Date.now(),
  ): void {
    if (!ids.length) return;
    const ins = this.db.query("INSERT INTO access_log (obs_id, at, kind, session_id) VALUES (?, ?, ?, ?)");
    const bump =
      kind === "injected"
        ? this.db.query("UPDATE observations SET inject_count = inject_count + 1 WHERE id = ?")
        : this.db.query("UPDATE observations SET access_count = access_count + 1, last_access_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const id of ids) {
        ins.run(id, at, kind, sessionId);
        if (kind === "injected") bump.run(id);
        else bump.run(at, id);
      }
    })();
  }

  accessTimes(ids: number[]): Map<number, { at: number; kind: string }[]> {
    const out = new Map<number, { at: number; kind: string }[]>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .query(
          `SELECT obs_id, at, kind FROM access_log WHERE obs_id IN (${chunk.map(() => "?").join(",")}) AND kind != 'injected'`,
        )
        .all(...chunk) as {
        obs_id: number;
        at: number;
        kind: string;
      }[];
      for (const r of rows) {
        let a = out.get(r.obs_id);
        if (!a) out.set(r.obs_id, (a = []));
        a.push({ at: r.at, kind: r.kind });
      }
    }
    return out;
  }

  /** Ślady jednego rodzaju (np. `fetched`) dla notatek z przedziału czasu: do statystyk progu (recall-stats). */
  accessEvents(
    ids: number[],
    kind: string,
    since: number,
    until: number,
  ): { obs_id: number; at: number; session_id: string | null }[] {
    const out: { obs_id: number; at: number; session_id: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      out.push(
        ...(this.db
          .query(
            `SELECT obs_id, at, session_id FROM access_log WHERE kind = ? AND at >= ? AND at <= ?
               AND obs_id IN (${chunk.map(() => "?").join(",")})`,
          )
          .all(kind, since, until, ...chunk) as { obs_id: number; at: number; session_id: string | null }[]),
      );
    }
    return out;
  }

  recordInjections(
    sessionId: string,
    ids: number[],
    channel: "start" | "prompt" | "file",
    tokensEach: Map<number, number>,
  ): void {
    const now = Date.now();
    const ins = this.db.query(
      "INSERT OR IGNORE INTO injections (session_id, obs_id, channel, at, tokens) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      for (const id of ids) ins.run(sessionId, id, channel, now, tokensEach.get(id) ?? 0);
    })();
    this.logAccess(ids, "injected", sessionId, now);
  }

  injectedIds(sessionId: string): Set<number> {
    return new Set(
      (this.db.query("SELECT DISTINCT obs_id FROM injections WHERE session_id = ?").all(sessionId) as { obs_id: number }[]).map(
        (r) => r.obs_id,
      ),
    );
  }

  markFileInjected(sessionId: string, fileKey: string): boolean {
    const r = this.db
      .query("INSERT OR IGNORE INTO file_injections (session_id, file_key, at) VALUES (?, ?, ?) RETURNING session_id")
      .get(sessionId, fileKey, Date.now());
    return !!r;
  }

  /** Czy przypomnienie o pliku już poszło w tej sesji (bez oznaczania: natywny hook oznacza po potwierdzeniu). */
  fileInjected(sessionId: string, fileKey: string): boolean {
    return !!this.db.query("SELECT 1 FROM file_injections WHERE session_id = ? AND file_key = ?").get(sessionId, fileKey);
  }

  // ---------- work state (zgodne z claude-mem) ----------

  appendWorkState(
    project: string,
    list: string,
    fields: Record<string, unknown>,
    at = Date.now(),
    source = "live",
    cmId: number | null = null,
  ): number {
    const r = this.db
      .query(
        "INSERT INTO work_state (project, list_name, fields, created_at, source, cm_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(project, list, J(fields), at, source, cmId) as { id: number };
    return r.id;
  }

  /** Nowa treść wpisu listy pracy (np. po redakcji sekretów). */
  updateWorkStateFields(id: number, fields: Record<string, unknown>): void {
    this.db.run("UPDATE work_state SET fields = ? WHERE id = ?", [J(fields), id]);
  }

  /** Wpisy w kolejności czasu (wpis z innego komputera dostaje późniejszy numer, ale wygrywa późniejsza zmiana). */
  workStateEntries(project: string): { id: number; list_name: string; fields: Record<string, unknown>; created_at: number }[] {
    return (
      this.db
        .query(
          "SELECT id, list_name, fields, created_at FROM work_state WHERE project = ? COLLATE NOCASE ORDER BY created_at, id",
        )
        .all(project) as any[]
    ).map((r) => ({
      ...r,
      fields: obj<Record<string, unknown>>(r.fields) ?? {},
    }));
  }

  /** Wszystkie wpisy list pracy ze wszystkich projektów (podgląd: zbiorcze TODO), od najstarszego. */
  workStateAll(): { id: number; project: string; list_name: string; fields: Record<string, unknown>; created_at: number }[] {
    return (
      this.db.query("SELECT id, project, list_name, fields, created_at FROM work_state ORDER BY created_at, id").all() as any[]
    ).map((r) => ({
      ...r,
      fields: obj<Record<string, unknown>>(r.fields) ?? {},
    }));
  }

  /**
   * Notatki (aktywne) i sesje na dzień, czas lokalny maszyny, dla ostatnich `days` dni łącznie z dzisiejszym.
   * Dni bez ruchu są uzupełnione zerami, więc wynik ma zawsze `days` pozycji od najstarszego dnia.
   * Granice dni liczy JS (T-50): `'localtime'` SQLite bierze strefę z biblioteki C, a ta przy ustawionym `TZ`
   * (Windows) potrafi się różnić od strefy JS, z której są etykiety dni. Każda granica liczona osobno z daty
   * (`new Date(r, m, d)`), nie krokiem 24 h ani od poprzedniej: zmiana czasu w zakresie nie przesuwa dni, a w strefach,
   * gdzie północ dnia zmiany nie istnieje (Hawana, Santiago), tylko ten dzień zaczyna się o 01:00.
   */
  activityByDay(days: number): { day: string; notes: number; sessions: number }[] {
    const n = Math.max(1, Math.min(90, Math.floor(days) || 14));
    const now = new Date();
    const [y, m, d0] = [now.getFullYear(), now.getMonth(), now.getDate() - (n - 1)];
    const edge = (i: number) => new Date(y, m, d0 + i);
    const bounds: [string, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const d = edge(i);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      bounds.push([day, d.getTime(), edge(i + 1).getTime()]);
    }
    // po jednym zakresie na dzień (indeksy ix_obs_created i ix_sessions_started), kolejność dni z listy
    return this.db
      .query(
        `SELECT d.value ->> 0 day,
           (SELECT COUNT(*) FROM observations WHERE status = 'active'
              AND created_at >= d.value ->> 1 AND created_at < d.value ->> 2) notes,
           (SELECT COUNT(*) FROM sessions WHERE started_at >= d.value ->> 1 AND started_at < d.value ->> 2) sessions
         FROM json_each(?1) d ORDER BY d.key`,
      )
      .all(JSON.stringify(bounds)) as { day: string; notes: number; sessions: number }[];
  }

  // ---------- zadania ----------

  enqueueJob(kind: string, key: string, payload: unknown): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO jobs (kind, key, payload, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(kind, key) WHERE status = 'pending' DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [kind, key, J(payload), now, now],
    );
  }

  claimJob(): { id: number; kind: string; key: string; payload: any; attempts: number } | null {
    return this.db.transaction(() => {
      const r = this.db
        .query("SELECT id, kind, key, payload, attempts FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1")
        .get() as any;
      if (!r) return null;
      this.db.run("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", [Date.now(), r.id]);
      return { ...r, payload: obj(r.payload) };
    })();
  }

  finishJob(id: number): void {
    this.db.run("DELETE FROM jobs WHERE id = ?", [id]);
  }

  failJob(id: number, err: string, retry: boolean): void {
    this.db.run("UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?", [
      retry ? "pending" : "failed",
      err.slice(0, 2000),
      Date.now(),
      id,
    ]);
  }

  /** Po awarii workera zadania w stanie running wracają do kolejki. */
  requeueStale(): void {
    this.db.run("UPDATE jobs SET status = 'pending' WHERE status = 'running'");
  }

  // ---------- projekty ----------

  /**
   * Nazwa projektu dla cwd: alias (np. z importu claude-mem) ma pierwszeństwo przed regułą z katalogu. Na końcu
   * jeden krok mapowania przez scalenia (`hipokamp project merge`): klucz scalony zapisuje się w docelowym.
   */
  resolveProject(cwd: string | null | undefined): string {
    if (!cwd?.trim()) return this.mergedProject(UNKNOWN_PROJECT);
    const key = normPath(cwd).toLowerCase();
    const a = this.db.query("SELECT project, source FROM project_aliases WHERE cwd = ?").get(key) as {
      project: string;
      source: string;
    } | null;
    // wynik starszej reguły liczymy od nowa, ale tylko dla istniejącego katalogu: usunięty worktree dałby teraz
    // własną nazwę zamiast nazwy repo, więc zostaje to, co policzono, kiedy jeszcze był
    if (a && (!a.source.startsWith("rule") || a.source === PROJECT_RULE || !existsSync(cwd)))
      return this.mergedProject(a.project);
    // alias reguły zapisuje klucz już po scaleniach: tabela mówi, gdzie trafia pamięć z tego katalogu
    const p = this.mergedProject(projectFromCwd(cwd));
    try {
      this.db.run(
        "INSERT INTO project_aliases (cwd, project, source, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(cwd) DO UPDATE SET project = excluded.project, source = excluded.source, seen_at = excluded.seen_at WHERE project_aliases.source LIKE 'rule%'",
        [key, p, PROJECT_RULE, Date.now()],
      );
    } catch {}
    return p;
  }

  /** Scalenia projektów (meta.project_merges): klucz małymi literami → projekt docelowy. */
  projectMerges(): Map<string, string> {
    const raw = (this.db.query("SELECT v FROM meta WHERE k = ?").get(PROJECT_MERGES_KEY) as { v: string } | null)?.v ?? null;
    if (raw !== this.merges.raw) this.merges = { raw, map: parseProjectMerges(raw) };
    return this.merges.map;
  }

  /** Projekt docelowy klucza scalonego do innego; klucz bez scalenia zostaje bez zmian. */
  mergedProject(project: string): string {
    return mapMergedProject(this.projectMerges(), project);
  }

  /** Alias katalogu: projekt i źródło („rule:N” po regule albo po scaleniu, inne to jawna nazwa) albo null. */
  projectAlias(cwd: string): { project: string; source: string } | null {
    return (
      (this.db.query("SELECT project, source FROM project_aliases WHERE cwd = ?").get(normPath(cwd).toLowerCase()) as {
        project: string;
        source: string;
      } | null) ?? null
    );
  }

  /** Źródło aliasu katalogu („rule:N” to wynik reguły z katalogu, inne to jawna nazwa, np. z importu claude-mem). */
  projectAliasSource(cwd: string): string | null {
    const r = this.db.query("SELECT source FROM project_aliases WHERE cwd = ?").get(normPath(cwd).toLowerCase()) as {
      source: string;
    } | null;
    return r?.source ?? null;
  }

  setProjectAlias(cwd: string, project: string, source = "claude-mem"): void {
    this.db.run(
      "INSERT INTO project_aliases (cwd, project, source, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(cwd) DO UPDATE SET project = excluded.project, source = excluded.source",
      [normPath(cwd).toLowerCase(), project, source, Date.now()],
    );
  }

  // ---------- statystyki ----------

  stats(): Record<string, number> {
    const one = (sql: string) => (this.db.query(sql).get() as { c: number }).c;
    return {
      observations: one("SELECT COUNT(*) c FROM observations"),
      active: one("SELECT COUNT(*) c FROM observations WHERE status = 'active'"),
      sessions: one("SELECT COUNT(*) c FROM sessions"),
      summaries: one("SELECT COUNT(*) c FROM summaries"),
      prompts: one("SELECT COUNT(*) c FROM prompts"),
      projects: one("SELECT COUNT(DISTINCT project) c FROM observations"),
      vectors: one("SELECT COUNT(*) c FROM obs_vectors"),
      entities: one("SELECT COUNT(*) c FROM entities"),
      injections: one("SELECT COUNT(*) c FROM injections"),
      pendingJobs: one("SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')"),
      failedJobs: one("SELECT COUNT(*) c FROM jobs WHERE status = 'failed'"),
    };
  }
}
