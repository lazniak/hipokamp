// Schemat bazy hipokampa. Migracje numerowane; stan w tabeli meta (schema_version).
// Zasady: żadnych tabel rosnących bez końca (logi dostępu i wstrzyknięć są przycinane w „śnie”),
// surowe logi narzędzi NIE są kopiowane — źródłem prawdy jest transkrypt (odwołanie transcript_ref).

/** Od tego numeru zaczynają się notatki i podsumowania hipokampa; niżej zostają numery z importu claude-mem. */
export const NATIVE_ID_BASE = 10_000_000;

export const MIGRATIONS: string[] = [
  // 1: rdzeń
  `
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    cwd TEXT,
    git_branch TEXT,
    title TEXT,
    first_prompt TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_activity_at INTEGER,
    prompt_count INTEGER NOT NULL DEFAULT 0,
    transcript_path TEXT,
    transcript_offset INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'live',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project, started_at DESC);
  CREATE INDEX IF NOT EXISTS ix_sessions_started ON sessions(started_at DESC);

  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    n INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    UNIQUE(session_id, n)
  );
  CREATE INDEX IF NOT EXISTS ix_prompts_created ON prompts(created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_prompts_project ON prompts(project, created_at DESC);

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project TEXT NOT NULL,
    prompt_n INTEGER,
    type TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'episodic',
    title TEXT NOT NULL,
    subtitle TEXT,
    narrative TEXT,
    facts TEXT NOT NULL DEFAULT '[]',
    concepts TEXT NOT NULL DEFAULT '[]',
    files_read TEXT NOT NULL DEFAULT '[]',
    files_modified TEXT NOT NULL DEFAULT '[]',
    text TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    importance REAL NOT NULL DEFAULT 0.3,
    source TEXT NOT NULL,
    content_hash TEXT,
    turn_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    merged_into INTEGER,
    superseded_by INTEGER,
    valid_until INTEGER,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_access_at INTEGER,
    inject_count INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    git_head TEXT,
    fingerprints TEXT,
    transcript_ref TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_obs_project ON observations(project, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_obs_created ON observations(created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_obs_session ON observations(session_id, prompt_n);
  CREATE INDEX IF NOT EXISTS ix_obs_type ON observations(type);
  CREATE INDEX IF NOT EXISTS ix_obs_status ON observations(status);
  CREATE INDEX IF NOT EXISTS ix_obs_hash ON observations(project, content_hash);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_obs_turn ON observations(turn_key) WHERE turn_key IS NOT NULL;

  CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    title, subtitle, narrative, facts, concepts, files,
    content='', contentless_delete=1,
    tokenize="unicode61 remove_diacritics 2", prefix='3 4 5 6'
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project TEXT NOT NULL,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    notes TEXT,
    files_read TEXT NOT NULL DEFAULT '[]',
    files_edited TEXT NOT NULL DEFAULT '[]',
    prompt_n INTEGER,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_sum_project ON summaries(project, created_at DESC);
  CREATE INDEX IF NOT EXISTS ix_sum_session ON summaries(session_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
    request, investigated, learned, completed, next_steps, notes,
    content='', contentless_delete=1,
    tokenize="unicode61 remove_diacritics 2", prefix='3 4 5 6'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
    text, content='', contentless_delete=1,
    tokenize="unicode61 remove_diacritics 2", prefix='3 4 5 6'
  );

  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    df INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER,
    UNIQUE(kind, project, key)
  );
  CREATE TABLE IF NOT EXISTS obs_entities (
    obs_id INTEGER NOT NULL,
    entity_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (obs_id, entity_id, role)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_oe_entity ON obs_entities(entity_id);

  CREATE TABLE IF NOT EXISTS obs_vectors (
    obs_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    q8 BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_log (
    obs_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_access_obs ON access_log(obs_id, at);

  CREATE TABLE IF NOT EXISTS injections (
    session_id TEXT NOT NULL,
    obs_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    at INTEGER NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, obs_id, channel)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_inj_at ON injections(at);

  CREATE TABLE IF NOT EXISTS file_injections (
    session_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_key)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    list_name TEXT NOT NULL,
    fields TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'live'
  );
  CREATE INDEX IF NOT EXISTS ix_ws_project ON work_state(project COLLATE NOCASE, list_name, id);

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status, id);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_pending ON jobs(kind, key) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS corpora (
    name TEXT PRIMARY KEY,
    description TEXT,
    filters TEXT NOT NULL,
    obs_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 2: aliasy projektów (cwd → nazwa projektu z claude-mem), żeby import i nowe sesje trafiały do tej samej pamięci
  `
  CREATE TABLE IF NOT EXISTS project_aliases (
    cwd TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'claude-mem',
    seen_at INTEGER
  );
  `,
  // 3: osobna przestrzeń numerów. claude-mem dalej nadaje kolejne #id (okres przejściowy), więc nowe notatki
  // hipokampa dostają numery od NATIVE_ID_BASE + 1 i nie zajmują numerów, które claude-mem nada później.
  `
  UPDATE sqlite_sequence SET seq = ${NATIVE_ID_BASE} WHERE name IN ('observations', 'summaries') AND seq < ${NATIVE_ID_BASE};
  INSERT INTO sqlite_sequence (name, seq) SELECT 'observations', ${NATIVE_ID_BASE}
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'observations');
  INSERT INTO sqlite_sequence (name, seq) SELECT 'summaries', ${NATIVE_ID_BASE}
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'summaries');
  `,
  // 4: numer wpisu listy pracy w claude-mem: ponowny import od zera rozpoznaje wpisy już skopiowane
  `
  ALTER TABLE work_state ADD COLUMN cm_id INTEGER;
  CREATE UNIQUE INDEX IF NOT EXISTS ux_ws_cm ON work_state(cm_id) WHERE cm_id IS NOT NULL;
  `,
  // 5: ważność podbita powtórkami w 0.1 (+0,05 przy każdej powtórce treści, aż do 1: prompt powtarzany setki
  // razy wypychał ważne notatki). Od tej wersji liczą się dwie pierwsze powtórki, więc notatki z więcej niż
  // trzema wystąpieniami wracają do bazy tury + 0,10. Baza: ważność minus dodatki powtórek, a gdy sufit 1 je zgubił,
  // baza typu z digestu 0.1 (TYPE_BASE w capture/digest.ts). Raz, przy aktualizacji: później takich notatek nie ma.
  // Tylko notatki z digestu (także backfill): ważność nadana świadomie (remember, import claude-mem) zostaje.
  `
  UPDATE observations SET importance = ROUND(MIN(importance,
    CASE WHEN importance < 1 AND importance - 0.05 * (occurrence_count - 1) >= 0.05
      THEN importance - 0.05 * (occurrence_count - 1)
      ELSE CASE type WHEN 'decision' THEN 0.62 WHEN 'preference' THEN 0.7 WHEN 'gotcha' THEN 0.55 WHEN 'bugfix' THEN 0.5
        WHEN 'feature' THEN 0.48 WHEN 'refactor' THEN 0.4 WHEN 'change' THEN 0.36 WHEN 'discovery' THEN 0.28 ELSE 0.3 END
    END + 0.1), 3)
  WHERE source IN ('digest', 'backfill') AND occurrence_count > 3;
  `,
  // 6: dziennik zmian statusu notatek dla strumienia SSE podglądu. Wyzwalacz łapie każdą zmianę, także z innych
  // procesów (MCP forget, CLI repair) i zbiorcze UPDATE snu, więc nikt nie musi pamiętać o powiadomieniu.
  // AUTOINCREMENT: numer wpisu jest kursorem strumienia i nie może wrócić do 1 po przycięciu dziennika.
  `
  CREATE TABLE IF NOT EXISTS status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obs_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_status_log_at ON status_log(at);
  CREATE TRIGGER IF NOT EXISTS tr_obs_status AFTER UPDATE OF status ON observations
    WHEN OLD.status IS NOT NEW.status
  BEGIN
    INSERT INTO status_log (obs_id, from_status, to_status, at)
      VALUES (NEW.id, OLD.status, NEW.status, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;
  `,
  // 7: synchronizacja między komputerami (src/sync, docs/SYNC.md). Puste, dopóki nikt nie uruchomi `hipokamp sync`.
  // sync_map: wiersz z hubu (albo własny już wysłany) → numer lokalny; gid = „urządzenie źródłowe:numer u źródła”.
  // sync_sessions: sesje znane hubowi (źródło, skrót pól i zegar wersji ostatnio wysłanej albo przyjętej).
  // sync_status: rejestry LWW statusów notatek (zegar hybrydowy zwycięskiej zmiany).
  // sync_status_at: chwila ostatniej zmiany statusu notatki (tylko status, cel scalenia, następca, ważność; nie
  //   powtórka treści ani inne podbicia updated_at). Zapisuje ją wyzwalacz, i to tylko po `sync init/join`.
  `
  CREATE TABLE IF NOT EXISTS sync_map (
    kind TEXT NOT NULL,
    gid TEXT NOT NULL,
    local_id INTEGER NOT NULL,
    origin INTEGER NOT NULL,
    PRIMARY KEY (kind, gid)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_sync_map_local ON sync_map(kind, local_id);
  CREATE TABLE IF NOT EXISTS sync_sessions (
    id TEXT PRIMARY KEY,
    origin INTEGER NOT NULL,
    hash TEXT NOT NULL,
    hlc TEXT
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS sync_status_at (obs_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TRIGGER IF NOT EXISTS tr_sync_status_at AFTER UPDATE OF status, merged_into, superseded_by, valid_until ON observations
  WHEN (OLD.status IS NOT NEW.status OR OLD.merged_into IS NOT NEW.merged_into OR OLD.superseded_by IS NOT NEW.superseded_by
        OR OLD.valid_until IS NOT NEW.valid_until)
    AND EXISTS (SELECT 1 FROM meta WHERE k = 'sync_hub')
  BEGIN
    INSERT INTO sync_status_at (obs_id, at) VALUES (NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      ON CONFLICT(obs_id) DO UPDATE SET at = excluded.at;
  END;
  CREATE TABLE IF NOT EXISTS sync_status (
    gid TEXT PRIMARY KEY,
    hlc TEXT NOT NULL,
    status TEXT NOT NULL,
    into_gid TEXT,
    by_gid TEXT,
    valid_until INTEGER
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_sync_status_into ON sync_status(into_gid) WHERE into_gid IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ix_sync_status_by ON sync_status(by_gid) WHERE by_gid IS NOT NULL;
  `,
  // 8: ślad decyzji przy rejestrze statusu (JSON, src/sync/store.ts StatusIntent): kiedy i dlaczego notatkę
  // zapomniano, kiedy przywrócono, czy cofnięto zastąpienie. Osobno od 7, bo bazy z pierwszą wersją synchronizacji
  // mają już tabelę bez tej kolumny. Rejestry sprzed migracji mają NULL: brak śladu, status bez zmian.
  // Odporna na bazy z pośrednich commitów PR #9, które mają już kolumnę `intent` (T-37): SQLite nie ma
  // `ADD COLUMN IF NOT EXISTS` ani warunkowego DDL, a migracje to sam SQL (db.ts), więc tabela jest przebudowana.
  // NATURAL LEFT JOIN z jednym wierszem `NULL AS intent` daje kolumnę `intent` w obu przypadkach: gdy tabela ją ma,
  // złączenie idzie po niej (warunek z NULL nigdy nie jest prawdziwy, LEFT zostawia wiersz z wartością z tabeli), gdy
  // nie ma, złączenie jest iloczynem z jednym wierszem i `intent` to NULL. Zwykła baza kończy tak jak po ALTER:
  // te same kolumny, wiersze i indeksy.
  `
  CREATE TABLE sync_status_v8 (
    gid TEXT PRIMARY KEY,
    hlc TEXT NOT NULL,
    status TEXT NOT NULL,
    into_gid TEXT,
    by_gid TEXT,
    valid_until INTEGER,
    intent TEXT
  ) WITHOUT ROWID;
  INSERT INTO sync_status_v8 (gid, hlc, status, into_gid, by_gid, valid_until, intent)
    SELECT gid, hlc, status, into_gid, by_gid, valid_until, intent FROM sync_status NATURAL LEFT JOIN (SELECT NULL AS intent);
  DROP TABLE sync_status;
  ALTER TABLE sync_status_v8 RENAME TO sync_status;
  CREATE INDEX IF NOT EXISTS ix_sync_status_into ON sync_status(into_gid) WHERE into_gid IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ix_sync_status_by ON sync_status(by_gid) WHERE by_gid IS NOT NULL;
  `,
];

/** Tabela wektorów binarnych (sqlite-vec) — wymiar zależy od modelu, więc tworzona dynamicznie. */
export function vecTableSql(dims: number): string {
  // partycja po projekcie: wyszukiwanie w obrębie projektu skanuje tylko jego wektory
  return `CREATE VIRTUAL TABLE IF NOT EXISTS obs_vec_bits USING vec0(obs_id INTEGER PRIMARY KEY, project TEXT PARTITION KEY, emb bit[${dims}])`;
}
