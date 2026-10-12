// Scenariusze zapisu z transkryptu na prawdziwej bazie. test/capture.test.ts uruchamia je w osobnym procesie,
// bo bun test dzieli moduły między plikami, a config.ts zamraża HIPOKAMP_HOME przy pierwszym imporcie.
// Użycie: bun scenarios.ts <nazwa>; wypisuje JSON z wynikami do asercji.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { digestTurn } from "../../../src/capture/digest.ts";
import { type IngestRequest, ingestTranscript } from "../../../src/capture/ingest.ts";
import { keyBase, rememberRoot } from "../../../src/capture/place.ts";
import { recoverTurns } from "../../../src/capture/recover.ts";
import { buildSessionSummary } from "../../../src/capture/summary.ts";
import { groupTurns, readLinesFrom } from "../../../src/capture/transcript.ts";
import { ensureDataDirs, paths } from "../../../src/config.ts";
import { formatRepairReport, repair } from "../../../src/core/repair.ts";
import { getMeta, openDb } from "../../../src/db/db.ts";
import { Repo } from "../../../src/db/repo.ts";
import { backfill } from "../../../src/importers/backfill.ts";
import { childProjects, gitRoot, samePath } from "../../../src/util/paths.ts";
import { catchUp } from "../../../src/worker/catchup.ts";
import * as X from "./codex.ts";
import {
  type Ctx,
  command,
  desktopPrompt,
  editCall,
  editOutput,
  fullTurn,
  jsonl,
  metaLine,
  metaUser,
  reply,
  systemLine,
  toolCall,
  toolOutput,
  userPrompt,
} from "./jsonl.ts";

const home = process.env.HIPOKAMP_HOME ?? "";
if (!home.includes("hipokamp-test") || !paths.db().includes("hipokamp-test"))
  throw new Error("scenarios: HIPOKAMP_HOME musi wskazywać katalog testowy");
// jak hook: katalogi danych (logs/ dla ostrzeżeń ingestu) muszą istnieć
ensureDataDirs();

const repo = new Repo(openDb({ vectors: false }));
const db = repo.db;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Osobny katalog Claude Code na scenariusz: nadrabianie i backfill czytają wszystkie transkrypty z projects/. */
function claudeHome(name: string): string {
  const dir = join(home, `claude-${name}`);
  mkdirSync(join(dir, "projects", "D--test"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function writeTranscript(dir: string, sid: string, lines: object[]): string {
  const p = join(dir, "projects", "D--test", `${sid}.jsonl`);
  writeFileSync(p, jsonl(lines));
  return p;
}

/** mtime pliku sprzed `ms`: nadrabianie i backfill patrzą na ciszę. */
function quietFor(p: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(p, t, t);
}

function ctx(sid: string, dir: string): Ctx {
  const cwd = join(home, dir);
  mkdirSync(cwd, { recursive: true });
  return { sessionId: sid, cwd };
}

const notes = (sid: string) =>
  db
    .query(
      "SELECT prompt_n, project, source, title, narrative FROM observations WHERE session_id = ? AND source != 'claude-mem' ORDER BY prompt_n, id",
    )
    .all(sid) as { prompt_n: number; project: string; source: string; title: string; narrative: string }[];

const promptRows = (sid: string) =>
  db.query("SELECT n, project, source FROM prompts WHERE session_id = ? ORDER BY n").all(sid) as {
    n: number;
    project: string;
    source: string;
  }[];

const count = (sql: string, ...args: string[]) => (db.query(sql).get(...args) as { c: number }).c;

const offsetOf = (sid: string) => repo.getSession(sid)?.transcript_offset ?? 0;

/** Licznik tur hipokampa zapisany z offsetem (sessions.meta.n). */
const metaN = (sid: string) =>
  (db.query("SELECT json_extract(meta, '$.n') n FROM sessions WHERE id = ?").get(sid) as { n: number | null } | null)?.n ?? null;

const lineStart = (p: string, uuid: string) => readLinesFrom(p, 0).lines.find((l) => l.json.uuid === uuid)?.start ?? -1;
const lineEnd = (p: string, uuid: string) => readLinesFrom(p, 0).lines.find((l) => l.json.uuid === uuid)?.end ?? -1;

/** Osobna baza scenariusza: naprawa przegląda wszystkie sesje, a inne scenariusze piszą do wspólnej. */
const ownRepo = (name: string) => new Repo(openDb({ path: join(home, `${name}.db`) }));

/** Powiadomienie o zakończonym zadaniu w tle (osobna tura bez numeru promptu). */
const taskNote = (c: Ctx, at: number, summary: string) => ({
  ...userPrompt(c, at, `<task-notification><summary>${summary}</summary></task-notification>`),
  origin: { kind: "task-notification" },
});

/** Notatka, jaką zapisał ingest 0.1 przy Stop: tura z zakresu [from, to) pliku, numer z jego numeracji. */
function oldNote(r: Repo, p: string, sid: string, project: string, from: number, to: number, n: number): number {
  const [turn] = groupTurns(readLinesFrom(p, from, to - from).lines, sid, { final: true }).turns;
  const d = digestTurn(turn, { project, n, privateTools: [], maxNarrativeChars: 1400 });
  d.obs.transcript_ref = { path: p, from: turn.from, to: turn.to };
  return r.insertObservation(d.obs, d.entities).id;
}

/** Stan sesji po odczycie do końca pliku (offset, licznik promptów, meta.n). */
function readToEnd(r: Repo, sid: string, p: string, n: number, firstPrompt: string | null): void {
  r.setTranscriptProgress(sid, statSync(p).size, n, Date.now() - HOUR);
  r.db.run("UPDATE sessions SET meta = json_set(COALESCE(meta, '{}'), '$.n', ?), first_prompt = ? WHERE id = ?", [
    n,
    firstPrompt,
    sid,
  ]);
}

/** Prompty i notatki claude-mem sesji (jak po imporcie): prompt zapisany 3 s po linii promptu w transkrypcie. */
function cmData(r: Repo, sid: string, project: string, prompts: { n: number; text: string; at: number; note: boolean }[]) {
  for (const p of prompts) {
    r.insertPrompt({ session_id: sid, project, n: p.n, text: p.text, created_at: p.at + 3000, source: "claude-mem" });
    if (p.note)
      r.insertObservation({
        session_id: sid,
        project,
        prompt_n: p.n,
        type: "discovery",
        title: `Notatka claude-mem ${sid} ${p.n}`,
        created_at: p.at + 30_000,
        source: "claude-mem",
      });
  }
}

function logText(): string {
  try {
    return readdirSync(paths.logs())
      .map((f) => readFileSync(join(paths.logs(), f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

/** Kolejne wywołania ingestu (jak kolejne Stop) do braku postępu. */
function ingestUntilIdle(req: IngestRequest): { offset: number; inserted: number }[] {
  const calls: { offset: number; inserted: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const before = offsetOf(req.sessionId);
    const r = ingestTranscript(repo, req);
    calls.push({ offset: r.offset, inserted: r.inserted.length });
    if (r.offset <= before) break;
  }
  return calls;
}

/**
 * Stan po imporcie claude-mem: licznik promptów 3, prompty 1..3 (tekst jak w transkrypcie, zapisane 3 s po linii
 * promptu) i notatki z prompt_n 1..3; transkrypt ma 4 tury.
 */
function importedSession(sid: string, idBase: number): { c: Ctx; lines: object[] } {
  const c = ctx(sid, `demo-${sid}`);
  const t0 = Date.now() - 2 * 86_400_000;
  repo.upsertSession({
    id: sid,
    project: "demo-cm",
    cwd: c.cwd,
    started_at: t0,
    prompt_count: 3,
    source: "claude-mem",
    status: "ended",
  });
  for (let n = 1; n <= 3; n++) {
    repo.insertPrompt({
      session_id: sid,
      project: "demo-cm",
      n,
      text: `prośba ${n}: popraw moduł ${n}`,
      created_at: t0 + n * MIN + 3000,
      source: "claude-mem",
    });
    repo.insertObservation({
      id: idBase + n,
      session_id: sid,
      project: "demo-cm",
      prompt_n: n,
      type: "discovery",
      title: `Notatka claude-mem ${sid} ${n}`,
      created_at: t0 + n * MIN,
      source: "claude-mem",
    });
  }
  const lines: object[] = [metaLine(sid, t0)];
  for (let n = 1; n <= 4; n++)
    lines.push(
      ...fullTurn(c, t0 + n * MIN, n, `prośba ${n}: popraw moduł ${n}`, `Poprawiłem moduł ${n} w ${sid} i sprawdziłem wynik.`),
    );
  return { c, lines };
}

const scenarios: Record<string, () => unknown> = {
  // backfill sesji z importu claude-mem; druga sesja czytana oknami po ~1 turze (kolejne Stop, duży plik)
  numbering() {
    const dir = claudeHome("numbering");
    const sid = "cm-sesja";
    const p = writeTranscript(dir, sid, importedSession(sid, 7000).lines);
    quietFor(p, 86_400_000);
    const first = backfill(repo).inserted;
    const second = backfill(repo).inserted;

    const sid2 = "cm-okna";
    const p2 = join(home, `${sid2}.jsonl`);
    writeFileSync(p2, jsonl(importedSession(sid2, 7100).lines));
    const calls = ingestUntilIdle({ sessionId: sid2, transcriptPath: p2, final: true, maxBytes: 1200 });
    return {
      first,
      second,
      notes: notes(sid).map((o) => ({ prompt_n: o.prompt_n, source: o.source })),
      prompts: promptRows(sid).map((r) => ({ n: r.n, source: r.source })),
      promptCount: repo.getSession(sid)?.prompt_count,
      offset: offsetOf(sid),
      size: statSync(p).size,
      windows: {
        calls: calls.length,
        notes: notes(sid2).map((o) => o.prompt_n),
        prompts: promptRows(sid2).map((r) => r.n),
        promptCount: repo.getSession(sid2)?.prompt_count,
        offset: offsetOf(sid2),
        size: statSync(p2).size,
      },
    };
  },

  // tura z ośmioma wynikami po ~1,6 KB przy oknie 4 KB, po niej dwie zwykłe
  bigturn() {
    const sid = "duza-tura";
    const c = ctx(sid, "duza");
    const t0 = Date.now() - HOUR;
    const lines: object[] = [metaLine(sid, t0), userPrompt(c, t0 + 1000, "zbierz logi ze wszystkich usług i zrób raport")];
    for (let i = 0; i < 8; i++) {
      const id = `toolu_big_${i}`;
      lines.push(toolCall(c, t0 + 2000 + i * 100, id, `cat usluga-${i}.log`));
      lines.push(toolOutput(c, t0 + 2050 + i * 100, id, `usługa ${i}: ${"x".repeat(1600)}`));
    }
    lines.push(reply(c, t0 + 5000, "Raport gotowy: wszystkie usługi działają, usługa 3 ma ostrzeżenia."));
    lines.push(...fullTurn(c, t0 + 10_000, 2, "a teraz sprawdź wolne miejsce na dysku", "Dysk ma 40% wolnego miejsca."));
    lines.push(...fullTurn(c, t0 + 20_000, 3, "sprawdź jeszcze zużycie pamięci", "Pamięć w normie, 12 GB wolne."));
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(p, jsonl(lines));
    const turnBytes = Buffer.byteLength(jsonl(lines.slice(1, 19)));
    const calls = ingestUntilIdle({ sessionId: sid, transcriptPath: p, final: true, maxBytes: 4096, windowCap: 1024 * 1024 });
    return {
      turnBytes,
      calls,
      notes: notes(sid).map((o) => ({ prompt_n: o.prompt_n, narrative: o.narrative })),
      offset: offsetOf(sid),
      size: statSync(p).size,
    };
  },

  // granica odczytu (IngestRequest.limit, zapis tury w workerze) na końcu linii w środku tury przy Stop (final: true):
  // tura czeka na odczyt dalej, zamiast zamknąć się przy granicy; granica na końcu pliku zamyka ją normalnie
  readLimit() {
    const sid = "granica-odczytu";
    const c = ctx(sid, "granica");
    const t0 = Date.now() - HOUR;
    const lines: object[] = [metaLine(sid, t0), userPrompt(c, t0 + 1000, "przejrzyj trzy pliki konfiguracji i popraw porty")];
    for (let i = 0; i < 3; i++) {
      const id = `toolu_gr_${i}`;
      lines.push(toolCall(c, t0 + 2000 + i * 100, id, `cat config-${i}.json`));
      lines.push(toolOutput(c, t0 + 2050 + i * 100, id, `plik ${i}: port ${4000 + i}`));
    }
    lines.push(reply(c, t0 + 5000, "Porty poprawione we wszystkich trzech plikach konfiguracji."));
    // druga tura: odczyt bez granicy zamknąłby pierwszą jej promptem, więc test łapie też zignorowany `limit`
    lines.push(...fullTurn(c, t0 + 10_000, 2, "uruchom testy po zmianie portów", "Testy przechodzą na nowych portach."));
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(p, jsonl(lines));
    // koniec linii po pierwszym wyniku narzędzia: środek pierwszej tury
    const cut = Buffer.byteLength(jsonl(lines.slice(0, 4)));
    const req = { sessionId: sid, transcriptPath: p, final: true as const, maxBytes: 512 * 1024, windowCap: 1024 * 1024 };
    const atCut = ingestTranscript(repo, { ...req, limit: cut });
    const afterCut = { turns: atCut.turns, offset: offsetOf(sid), notes: notes(sid).length };
    const atEnd = ingestTranscript(repo, { ...req, limit: statSync(p).size });
    return {
      cut,
      size: statSync(p).size,
      afterCut,
      afterEnd: { turns: atEnd.turns, offset: offsetOf(sid) },
      notes: notes(sid).map((o) => o.narrative),
    };
  },

  // linia wyniku ~80 KB przy limicie okna 16 KB, w środku tury 2
  longline() {
    const sid = "dluga-linia";
    const c = ctx(sid, "dluga");
    const t0 = Date.now() - HOUR;
    const id = "toolu_long";
    const lines: object[] = [
      metaLine(sid, t0),
      ...fullTurn(c, t0 + 1000, 1, "sprawdź konfigurację serwera", "Konfiguracja serwera jest poprawna."),
      userPrompt(c, t0 + 10_000, "przeczytaj cały log błędów aplikacji"),
      toolCall(c, t0 + 11_000, id, "cat app-errors.log"),
      toolOutput(c, t0 + 12_000, id, `błąd: ${"y".repeat(40_000)}`),
      reply(c, t0 + 13_000, "Log przeczytany: dominują przekroczenia czasu bazy."),
      ...fullTurn(c, t0 + 20_000, 3, "zrestartuj usługę bazy danych", "Usługa bazy zrestartowana i działa."),
    ];
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(p, jsonl(lines));
    const calls = ingestUntilIdle({ sessionId: sid, transcriptPath: p, final: true, maxBytes: 4096, windowCap: 16 * 1024 });
    const log = logText();
    return {
      calls,
      notes: notes(sid).map((o) => ({ prompt_n: o.prompt_n, title: o.title, narrative: o.narrative })),
      offset: offsetOf(sid),
      size: statSync(p).size,
      loggedBatched: log.includes("przeczytana partiami"),
      warnedSkipped: log.includes("pominięta"),
    };
  },

  // T-19: tura dłuższa niż limit okna (24 wyniki po ~3 KB przy limicie 16 KB) w jednej notatce, z wynikiem i odpowiedzią
  longturn() {
    const sid = "dluga-tura";
    const c = ctx(sid, "dluga-tura");
    const t0 = Date.now() - HOUR;
    const lines: object[] = [metaLine(sid, t0), userPrompt(c, t0 + 1000, "przejrzyj logi wszystkich usług klastra")];
    for (let i = 0; i < 24; i++) {
      const id = `toolu_dluga_${i}`;
      lines.push(toolCall(c, t0 + 2000 + i * 100, id, `kubectl logs usluga-${i}`));
      lines.push(toolOutput(c, t0 + 2050 + i * 100, id, `usługa ${i}: ${"w".repeat(1500)}`));
    }
    lines.push(reply(c, t0 + 9000, "Przejrzane: usługa 17 gubi połączenia z bazą, reszta działa."));
    lines.push(...fullTurn(c, t0 + 20_000, 2, "zrestartuj usługę 17", "Usługa 17 zrestartowana, połączenia wróciły."));
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(p, jsonl(lines));
    const calls = ingestUntilIdle({ sessionId: sid, transcriptPath: p, final: true, maxBytes: 4096, windowCap: 16 * 1024 });
    const rows = db
      .query("SELECT prompt_n, narrative, json_extract(meta, '$.kind') kind FROM observations WHERE session_id = ? ORDER BY id")
      .all(sid) as { prompt_n: number; narrative: string; kind: string }[];
    return {
      turnBytes: Buffer.byteLength(jsonl(lines.slice(1, 51))),
      calls,
      notes: rows.map((o) => [o.prompt_n, o.kind]),
      narrative: rows[0]?.narrative ?? "",
      prompts: promptRows(sid).map((r) => r.n),
      offset: offsetOf(sid),
      size: statSync(p).size,
    };
  },

  // T-19: transkrypt z katalogu wykluczonego projektu (nadrabianie, backfill): bez pustego wiersza w sessions
  excludedSession() {
    const sid = "wykluczona-sesja";
    const c = ctx(sid, "sejf-sesja");
    repo.setProjectAlias(c.cwd, "sejf", "test");
    const t0 = Date.now() - HOUR;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([metaLine(sid, t0), ...fullTurn(c, t0 + MIN, 1, "zmień hasło do poczty w sejfie", "Hasło do poczty zmienione.")]),
    );
    const r = ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
    return { project: r.project, inserted: r.inserted.length, session: repo.getSession(sid) !== null };
  },

  // T-19: tura w toku po restarcie workera nie jest czytana od nowa (każde nadrabianie w osobnym procesie, jak worker
  // wyłączany po bezczynności); po nowych liniach czytana normalnie
  catchupRestart() {
    const dir = claudeHome("restart");
    const sid = "restart-workera";
    const c = ctx(sid, "restart");
    const t0 = Date.now() - 2 * HOUR;
    const id = "toolu_migracja";
    const p = writeTranscript(dir, sid, [
      metaLine(sid, t0),
      ...fullTurn(c, t0 + MIN, 1, "przygotuj migrację bazy klientów", "Migracja gotowa w pliku 0042_klienci.sql."),
      userPrompt(c, t0 + 2 * MIN, "uruchom migrację na kopii bazy"),
      toolCall(c, t0 + 2 * MIN + 1000, id, "bun run migrate --copy", "Uruchamiam migrację…"),
    ]);
    quietFor(p, 10 * MIN);
    const worker = () => {
      const r = Bun.spawnSync([process.execPath, import.meta.path, "catchupOnce"], {
        env: process.env as Record<string, string>,
      });
      if (r.exitCode !== 0) throw new Error(`catchupOnce: ${r.stderr.toString()}`);
      return JSON.parse(r.stdout.toString()) as { files: number; inserted: number };
    };
    const first = worker();
    const waitingAfterFirst = JSON.parse(getMeta(db, "catchup_waiting") ?? "{}");
    const restarted = worker();
    appendFileSync(
      p,
      jsonl([
        toolOutput(c, t0 + 9 * MIN, id, "migracja: 3 tabele zmienione"),
        reply(c, t0 + 9 * MIN + 1000, "Migracja przeszła na kopii: 3 tabele zmienione, dane spójne."),
      ]),
    );
    quietFor(p, 10 * MIN);
    const grown = worker();
    return {
      first: { files: first.files, inserted: first.inserted },
      waitingAfterFirst: Object.keys(waitingAfterFirst).some((k) => samePath(k, p)),
      restarted: { files: restarted.files, inserted: restarted.inserted },
      grown: { files: grown.files, inserted: grown.inserted },
      notes: notes(sid).map((o) => o.prompt_n),
      waitingAtEnd: getMeta(db, "catchup_waiting"),
    };
  },

  // jedno nadrabianie (catchupRestart uruchamia je w osobnych procesach)
  catchupOnce() {
    return catchUp(repo);
  },

  // T-23: `cd` do podkatalogu projektu bez repo zostaje w projekcie sesji; podkatalog z własną tożsamością (repo,
  // znacznik .claude-mem-project, alias z importu claude-mem) to osobny projekt, a podkatalog o kluczu wykluczonym
  // zostaje wykluczony
  turnProject() {
    const sid = "projekt-tury";
    const root = ctx(sid, "t23-projekt");
    // katalog startowy jest projektem (manifest), nie kontenerem projektów
    writeFileSync(join(root.cwd, "CLAUDE.md"), "# Projekt t23\n");
    const sub = ctx(sid, join("t23-projekt", "skrypty"));
    const nested = ctx(sid, join("t23-projekt", "biblioteka"));
    mkdirSync(join(nested.cwd, ".git"), { recursive: true });
    const secret = ctx(sid, join("t23-projekt", "hasla"));
    repo.setProjectAlias(secret.cwd, "sejf", "test");
    const marked = ctx(sid, join("t23-projekt", "modul", "src"));
    writeFileSync(join(home, "t23-projekt", "modul", ".claude-mem-project"), "");
    const imported = ctx(sid, join("t23-projekt", "stary"));
    repo.setProjectAlias(imported.cwd, "stary-klucz", "claude-mem");
    const t0 = Date.now() - HOUR;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        ...fullTurn(root, t0 + MIN, 1, "opisz strukturę katalogów projektu", "Projekt ma katalogi skrypty i biblioteka."),
        ...fullTurn(sub, t0 + 2 * MIN, 2, "popraw skrypt wdrożenia na serwer", "Skrypt wdrożenia poprawiony i sprawdzony."),
        ...fullTurn(nested, t0 + 3 * MIN, 3, "dodaj test do biblioteki dat", "Test biblioteki dat dodany i przechodzi."),
        ...fullTurn(secret, t0 + 4 * MIN, 4, "zmień hasło w pliku haseł", "Hasło w pliku haseł zmienione."),
        ...fullTurn(marked, t0 + 5 * MIN, 5, "uporządkuj importy w module", "Importy w module uporządkowane."),
        ...fullTurn(imported, t0 + 6 * MIN, 6, "sprawdź stary kod raportów", "Stary kod raportów sprawdzony, działa."),
      ]),
    );
    ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
    return {
      inRepo: gitRoot(root.cwd) !== null,
      session: repo.getSession(sid)?.project ?? null,
      notes: notes(sid).map((o) => [o.prompt_n, o.project]),
      prompts: promptRows(sid).map((x) => [x.n, x.project]),
    };
  },

  // T-23: sesja zaczęta w katalogu z wieloma projektami (jak D:\code) nie wchłania projektów bez repo. Podkatalog
  // z manifestem (package.json, CLAUDE.md) to projekt także głębiej (`cd Kompas/src`); katalog startowy bez manifestu,
  // z samym `.claude/` i podprojektem albo z manifestem i trzema podprojektami nie jest projektem swoich podkatalogów
  turnContainer() {
    const out: Record<string, unknown[]> = {};
    const t0 = Date.now() - HOUR;
    const run = (sid: string, turns: [Ctx, string][]) => {
      const p = join(home, `${sid}.jsonl`);
      writeFileSync(
        p,
        jsonl([
          metaLine(sid, t0),
          ...turns.flatMap(([c, what], i) =>
            fullTurn(c, t0 + (i + 1) * MIN, i + 1, `popraw ${what} (${sid})`, `Poprawione: ${what} (${sid}).`),
          ),
        ]),
      );
      ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
      out[sid] = notes(sid).map((o) => [o.prompt_n, o.project]);
    };
    // kontener bez manifestu: Kompas ma package.json i CLAUDE.md, notatki nic
    let sid = "kontener-goly";
    const kompas = ctx(sid, join("kontener", "Kompas"));
    writeFileSync(join(kompas.cwd, "package.json"), '{"name":"kompas"}');
    writeFileSync(join(kompas.cwd, "CLAUDE.md"), "# Kompas\n");
    run(sid, [
      [ctx(sid, "kontener"), "listę projektów"],
      [kompas, "build Kompasu"],
      [ctx(sid, join("kontener", "Kompas", "src")), "źródła Kompasu"],
      [ctx(sid, join("kontener", "notatki")), "notatki"],
    ]);
    // jak D:\code: sam `.claude/` i podprojekt z repo
    sid = "kontener-claude";
    const k2 = ctx(sid, "kontener-claude");
    mkdirSync(join(k2.cwd, ".claude"), { recursive: true });
    mkdirSync(join(k2.cwd, "Beta", ".git"), { recursive: true });
    run(sid, [
      [k2, "listę projektów"],
      [ctx(sid, join("kontener-claude", "szkice")), "szkice"],
    ]);
    // manifest i trzy podprojekty
    sid = "kontener-md";
    const k3 = ctx(sid, "kontener-md");
    writeFileSync(join(k3.cwd, "CLAUDE.md"), "# Wszystkie projekty\n");
    for (const name of ["Gamma", "Delta", "Epsilon"]) mkdirSync(join(k3.cwd, name, ".git"), { recursive: true });
    run(sid, [
      [k3, "listę projektów"],
      [ctx(sid, join("kontener-md", "brudnopis")), "brudnopis"],
    ]);
    // jak D:\code, ale podprojekt podpięty junctionem (Windows) albo dowiązaniem (Linux) z repo poza kontenerem
    sid = "kontener-junction";
    const k4 = ctx(sid, "kontener-junction");
    mkdirSync(join(k4.cwd, ".claude"), { recursive: true });
    mkdirSync(join(home, "repo-poza", ".git"), { recursive: true });
    symlinkSync(join(home, "repo-poza"), join(k4.cwd, "Zeta"), process.platform === "win32" ? "junction" : "dir");
    run(sid, [
      [k4, "listę projektów"],
      [ctx(sid, join("kontener-junction", "zapiski")), "zapiski"],
    ]);
    // monorepo bez gita: workspaces w package.json (układ płaski) i pnpm-workspace.yaml (packages/*); pakiety i katalogi
    // obok nich należą do monorepo
    sid = "monorepo-plaski";
    const m1 = ctx(sid, "mono-plaski");
    writeFileSync(join(m1.cwd, "package.json"), '{"name":"mono","workspaces":["web","api","shared"]}');
    for (const name of ["web", "api", "shared"])
      writeFileSync(join(ctx(sid, join("mono-plaski", name)).cwd, "package.json"), `{"name":"${name}"}`);
    run(sid, [
      [m1, "konfigurację monorepo"],
      [ctx(sid, join("mono-plaski", "scripts")), "skrypty monorepo"],
      [ctx(sid, join("mono-plaski", "web", "src")), "stronę monorepo"],
      [ctx(sid, join("mono-plaski", "api")), "api monorepo"],
    ]);
    sid = "monorepo-pnpm";
    const m2 = ctx(sid, "mono-pnpm");
    writeFileSync(join(m2.cwd, "package.json"), '{"name":"mono-pnpm"}');
    writeFileSync(join(m2.cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    for (const name of ["a", "b", "c", "d"])
      writeFileSync(join(ctx(sid, join("mono-pnpm", "packages", name)).cwd, "package.json"), `{"name":"${name}"}`);
    run(sid, [
      [m2, "konfigurację pnpm"],
      [ctx(sid, join("mono-pnpm", "packages", "a", "src")), "pakiet a"],
    ]);
    // hook czyta werdykt katalogu startowego z sessions.meta zamiast skanować: zapisany werdykt rozstrzyga
    const t23 = join(home, "werdykt-projekt");
    mkdirSync(join(t23, "skrypty"), { recursive: true });
    writeFileSync(join(t23, "CLAUDE.md"), "# Projekt t23\n");
    repo.upsertSession({ id: "werdykt-z-meta", project: "werdykt-projekt", cwd: t23, started_at: t0 });
    const verdict = (v: boolean) => {
      db.run("UPDATE sessions SET meta = json_object('root', ?, 'rootProject', json(?)) WHERE id = 'werdykt-z-meta'", [
        t23,
        JSON.stringify(v),
      ]);
      return samePath(keyBase(repo, [], "werdykt-z-meta", join(t23, "skrypty"), null), t23);
    };
    // skan z limitem czasu i limitem dzieci: po czasie wynik nieznany; widać pierwsze 64 podkatalogi według nazwy
    // (porównanie kodów znaków), niezależnie od kolejności listingu (NTFS alfabetycznie, ext4 według skrótu nazwy).
    // Katalogi zakładane od końca, repo na zadanym miejscu w porządku nazw
    const tree = (name: string, plain: number, repoDir: string) => {
      const d = join(home, name);
      for (let i = plain - 1; i >= 0; i--) mkdirSync(join(d, `p${String(i).padStart(2, "0")}`), { recursive: true });
      mkdirSync(join(d, repoDir, ".git"), { recursive: true });
      return childProjects(d, 1);
    };
    // start sesji zapisuje katalog startowy i werdykt raz (drugi start, np. wznowienie w podkatalogu, nie nadpisuje)
    repo.upsertSession({ id: "werdykt-start", project: "werdykt-projekt", cwd: t23, started_at: t0 });
    rememberRoot(repo, "werdykt-start", t23, 200);
    rememberRoot(repo, "werdykt-start", join(t23, "skrypty"), 200);
    const started = db.query("SELECT meta FROM sessions WHERE id = 'werdykt-start'").get() as { meta: string };
    const remembered = JSON.parse(started.meta);
    return {
      ...out,
      remembered: { root: samePath(remembered.root, t23), rootProject: remembered.rootProject },
      verdict: { project: verdict(true), container: verdict(false) },
      scan: {
        late: childProjects(t23, 3, performance.now() - 1),
        capped: {
          "repo 64. (p00..p62, p63-repo)": tree("granica-64", 63, "p63-repo"),
          "repo 65. (p00..p63, p64-repo)": tree("granica-65", 64, "p64-repo"),
          "repo 71. (p00..p69, zz-repo)": tree("szeroki", 70, "zz-repo"),
          "Zz-repo przed p00 (kody znaków, na NTFS za p63)": tree("wielka-litera", 64, "Zz-repo"),
        },
      },
    };
  },

  // T-23: klucze plików tury w podkatalogu liczone od katalogu startowego (ten sam plik, ten sam klucz), katalog
  // startowy z transkryptu, nie z sessions.cwd (SessionStart po `cd` go nadpisuje). Sesja zaczęta w katalogu domowym,
  // tymczasowym albo w korzeniu dysku nie wchłania podkatalogów. Projekt poza %TEMP%: digest pomija pliki tymczasowe
  turnFiles() {
    const proj = mkdtempSync(join(homedir(), "hipokamp-test-proj-"));
    try {
      const sid = "klucze-plikow";
      const root = { sessionId: sid, cwd: proj };
      const sub = { sessionId: sid, cwd: join(proj, "skrypty") };
      mkdirSync(sub.cwd, { recursive: true });
      writeFileSync(join(proj, "CLAUDE.md"), "# Projekt bez repo\n");
      const file = join(sub.cwd, "deploy.sh");
      writeFileSync(file, "echo wersja 1\n");
      const edit = (c: Ctx, at: number, n: number, ask: string, answer: string) => {
        const id = `toolu_${sid}_${n}`;
        return [
          userPrompt(c, at, ask),
          editCall(c, at + 1000, id, file, "echo wersja 1", `echo wersja ${n + 1}`),
          editOutput(c, at + 2000, id, file),
          reply(c, at + 3000, answer),
        ];
      };
      // SessionStart po wznowieniu w podkatalogu: wiersz sesji z cwd i projektem podkatalogu
      repo.upsertSession({ id: sid, project: repo.resolveProject(sub.cwd), cwd: sub.cwd, started_at: Date.now() - HOUR });
      const t0 = Date.now() - HOUR;
      const p = join(home, `${sid}.jsonl`);
      writeFileSync(
        p,
        jsonl([
          metaLine(sid, t0),
          ...edit(root, t0 + MIN, 1, "popraw skrypt wdrożenia w katalogu skrypty", "Skrypt wdrożenia poprawiony: wersja 2."),
          ...edit(sub, t0 + 2 * MIN, 2, "jeszcze raz popraw ten sam skrypt wdrożenia", "Skrypt wdrożenia poprawiony: wersja 3."),
        ]),
      );
      ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
      const rows = db
        .query("SELECT prompt_n, project, files_modified, fingerprints FROM observations WHERE session_id = ? ORDER BY prompt_n")
        .all(sid) as { prompt_n: number; project: string; files_modified: string; fingerprints: string | null }[];
      // odczyt tą samą regułą: hook po edycji pliku w podkatalogu szuka klucza `skrypty/deploy.sh`
      db.run("UPDATE observations SET importance = 0.9 WHERE session_id = ?", [sid]);
      const hook = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../src/hooks/hook.ts"), "post-tool"], {
        env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: proj },
        stdin: Buffer.from(JSON.stringify({ session_id: sid, cwd: sub.cwd, tool_name: "Read", tool_input: { file_path: file } })),
      });
      const recalled = hook.stdout.toString();
      // start sesji po /compact w podkatalogu: przeterminowanie od katalogu kluczy (plik zmieniony po notatkach).
      // Zmiana treści, nie samego mtime: odcisk ze skrótem treści (T-07) nie uznaje samego mtime za zmianę
      writeFileSync(file, "echo wersja 4\n");
      const later = (Date.now() + 60_000) / 1000;
      utimesSync(file, later, later);
      const start = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../src/hooks/hook.ts"), "session-start"], {
        env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: proj },
        stdin: Buffer.from(JSON.stringify({ session_id: sid, cwd: sub.cwd, source: "compact" })),
      });
      const startOut = start.stdout.toString();
      // naprawa (odzyskanie tur bez notatki) liczy projekt i klucze tą samą regułą: sesja przeczytana bez notatek
      // w osobnej bazie, bez meta.root (jak sesje sprzed tej zmiany: katalog startowy z pierwszej tury)
      const r2 = ownRepo("odzysk-t23");
      r2.upsertSession({ id: sid, project: parse(proj).base, cwd: proj, started_at: t0, transcript_path: p });
      readToEnd(r2, sid, p, 2, null);
      recoverTurns(r2);
      const recovered = (
        r2.db
          .query("SELECT prompt_n, project, files_modified FROM observations WHERE session_id = ? ORDER BY prompt_n")
          .all(sid) as { prompt_n: number; project: string; files_modified: string }[]
      ).map((o) => ({ n: o.prompt_n, project: o.project, files: JSON.parse(o.files_modified) }));
      r2.db.close();
      // sesje zaczęte w katalogu ogólnym (domowy, tymczasowy, korzeń dysku, konfiguracja Claude z CLAUDE.md), tura
      // w podkatalogu bez repo: projekt podkatalogu albo najbliższego projektu pod katalogiem ogólnym
      const generic: Record<string, string[]> = {};
      const config = claudeHome("t23-konfiguracja");
      writeFileSync(join(config, "CLAUDE.md"), "# Instrukcje globalne\n");
      const starts = { home: homedir(), tmp: tmpdir(), drive: parse(home).root, config };
      for (const [name, start] of Object.entries(starts)) {
        const gsid = `start-${name}`;
        const turnCwd =
          name === "home" ? sub.cwd : name === "config" ? join(config, "skills", "narzedzie") : join(home, "ogolny");
        mkdirSync(turnCwd, { recursive: true });
        const gp = join(home, `${gsid}.jsonl`);
        writeFileSync(
          gp,
          jsonl([
            metaLine(gsid, t0),
            ...fullTurn({ sessionId: gsid, cwd: start }, t0 + MIN, 1, "co jest w tym katalogu", "Kilka projektów i notatek."),
            ...fullTurn(
              { sessionId: gsid, cwd: turnCwd },
              t0 + 2 * MIN,
              2,
              `popraw opis projektu (${name})`,
              `Opis projektu poprawiony (${name}).`,
            ),
          ]),
        );
        ingestTranscript(repo, { sessionId: gsid, transcriptPath: gp, final: true });
        generic[name] = notes(gsid)
          .filter((o) => o.prompt_n === 2)
          .map((o) => o.project);
      }
      const stored = db.query("SELECT json_extract(meta, '$.root') r FROM sessions WHERE id = ?").get(sid) as { r: string };
      return {
        projectName: parse(proj).base,
        rootIsStart: samePath(stored.r, proj),
        recalled: recalled.includes("Pamięć o pliku skrypty/deploy.sh"),
        hookOut: recalled.slice(0, 300),
        staleAtStart: startOut.includes("⚠plik zmieniony"),
        startOut: startOut.slice(0, 400),
        recovered,
        notes: rows.map((o) => ({
          n: o.prompt_n,
          project: o.project,
          files: JSON.parse(o.files_modified),
          fingerprints: Object.keys(JSON.parse(o.fingerprints ?? "{}")),
        })),
        generic,
      };
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  },

  // T-28: sesja wznowiona w innym katalogu: nowy plik z tą samą historią, ale inną ostatnią linią metadanych.
  // Krótsza: offset starej kopii wypada w środku nowego promptu. Dłuższa: w środku nowej linii metadanych.
  movedTranscript() {
    const out: Record<string, unknown> = {};
    mkdirSync(join(home, "stara-kopia"), { recursive: true });
    mkdirSync(join(home, "nowa-kopia"), { recursive: true });
    for (const variant of ["krotsza", "dluzsza"] as const) {
      const sid = `przeniesiona-${variant}`;
      const c = ctx(sid, sid);
      const t0 = Date.now() - HOUR;
      const history = jsonl([
        metaLine(sid, t0),
        ...fullTurn(c, t0 + MIN, 1, `napraw logowanie w aplikacji ${variant}`, "Logowanie naprawione, sesje działają."),
      ]);
      const last = (text: string) => jsonl([{ type: "last-prompt", lastPrompt: text, sessionId: sid }]);
      const oldP = join(home, "stara-kopia", `${sid}.jsonl`);
      writeFileSync(oldP, history + last(`napraw logowanie ${"x".repeat(120)}`));
      ingestTranscript(repo, { sessionId: sid, transcriptPath: oldP, final: true });
      const offset = offsetOf(sid);
      const turn2 = fullTurn(c, t0 + 10 * MIN, 2, `dodaj reset hasła ${"przez e-mail ".repeat(12)}`, "Reset hasła dodany.");
      const newLast = variant === "krotsza" ? last("napraw") : last(`napraw logowanie ${"x".repeat(240)}`);
      const newP = join(home, "nowa-kopia", `${sid}.jsonl`);
      writeFileSync(newP, history + newLast + jsonl(turn2));
      const key = (turn2[0] as { uuid: string }).uuid;
      const r = ingestTranscript(repo, { sessionId: sid, transcriptPath: newP, final: true });
      out[variant] = {
        midPrompt: offset > lineStart(newP, key) && offset < lineEnd(newP, key),
        midMeta: offset > Buffer.byteLength(history) && offset < Buffer.byteLength(history + newLast),
        inserted: r.inserted.length,
        notes: (
          db
            .query("SELECT prompt_n, json_extract(meta, '$.kind') kind FROM observations WHERE session_id = ? ORDER BY id")
            .all(sid) as { prompt_n: number; kind: string }[]
        ).map((o) => [o.prompt_n, o.kind]),
        prompts: promptRows(sid).map((x) => x.n),
        atEnd: offsetOf(sid) === statSync(newP).size,
        path: samePath(repo.getSession(sid)?.transcript_path, newP),
      };
    }
    return out;
  },

  // T-28: ostatnia linia starej kopii dłuższa od swojej wersji w nowej o d bajtów. Gdy d przekracza długość promptu
  // po wznowieniu, offset starej kopii wypada za nim (albo za całą turą): wyrównanie do granicy linii gubiło prompt,
  // kotwica (początek i typ ostatniej przeczytanej linii) znajduje jej odpowiednik
  movedOvershoot() {
    const out: Record<string, unknown> = {};
    mkdirSync(join(home, "stara-kopia"), { recursive: true });
    mkdirSync(join(home, "nowa-kopia"), { recursive: true });
    for (const d of [100, 300, 450, 900]) {
      const sid = `nadmiar-${d}`;
      const c = ctx(sid, `n${d}`);
      const t0 = Date.now() - HOUR;
      const history = jsonl([
        metaLine(sid, t0),
        ...fullTurn(c, t0 + MIN, 1, "napisz raport kwartalny", "Raport kwartalny gotowy w raport.md."),
      ]);
      const last = (text: string) => jsonl([{ type: "last-prompt", lastPrompt: text, sessionId: sid }]);
      const oldP = join(home, "stara-kopia", `${sid}.jsonl`);
      writeFileSync(oldP, history + last(`dalej${"z".repeat(d)}`));
      ingestTranscript(repo, { sessionId: sid, transcriptPath: oldP, final: true });
      const offset = offsetOf(sid);
      const turn2 = fullTurn(c, t0 + 10 * MIN, 2, "dalej", "Dodałem do raportu sekcję o kosztach.");
      const newP = join(home, "nowa-kopia", `${sid}.jsonl`);
      writeFileSync(
        newP,
        history +
          last("dalej") +
          jsonl([...turn2, ...fullTurn(c, t0 + 20 * MIN, 3, "a teraz podsumuj raport", "Podsumowanie raportu dodane.")]),
      );
      ingestTranscript(repo, { sessionId: sid, transcriptPath: newP, final: true });
      out[d] = {
        pastPrompt: offset >= lineEnd(newP, (turn2[0] as { uuid: string }).uuid),
        notes: (
          db
            .query("SELECT prompt_n, json_extract(meta, '$.kind') kind FROM observations WHERE session_id = ? ORDER BY id")
            .all(sid) as { prompt_n: number; kind: string }[]
        ).map((o) => [o.prompt_n, o.kind]),
        prompts: promptRows(sid).map((x) => x.n),
        atEnd: offsetOf(sid) === statSync(newP).size,
      };
    }
    return out;
  },

  // T-28: nadrabianie widzi obie kopie wznowionej sesji. Stara (ostatnia linia dłuższa o d bajtów niż wszystko, co
  // nowa dopisała po wznowieniu) ma rozmiar większy niż offset nowej, ale sesja nie wraca do niej: inaczej offset
  // i kotwica dotyczyłyby starej kopii, a następny Stop w nowej czytałby turę 2 drugi raz
  movedCatchup() {
    const out: Record<string, unknown> = {};
    for (const d of [1700, 2500]) {
      const dir = claudeHome(`kopie-${d}`);
      const sid = `wznowiona-${d}`;
      const c = ctx(sid, `w${d}`);
      mkdirSync(join(dir, "projects", "D--stary"), { recursive: true });
      mkdirSync(join(dir, "projects", "D--nowy"), { recursive: true });
      const t0 = Date.now() - 3 * HOUR;
      const history = jsonl([
        metaLine(sid, t0),
        ...fullTurn(c, t0 + MIN, 1, "napisz raport kwartalny", "Raport kwartalny gotowy."),
      ]);
      const last = (text: string) => jsonl([{ type: "last-prompt", lastPrompt: text, sessionId: sid }]);
      const oldP = join(dir, "projects", "D--stary", `${sid}.jsonl`);
      writeFileSync(oldP, history + last(`dalej${"z".repeat(d)}`));
      ingestTranscript(repo, { sessionId: sid, transcriptPath: oldP, final: true });
      const newP = join(dir, "projects", "D--nowy", `${sid}.jsonl`);
      writeFileSync(newP, history + last("dalej") + jsonl(fullTurn(c, t0 + 10 * MIN, 2, "dalej", "Dodałem sekcję o kosztach.")));
      ingestTranscript(repo, { sessionId: sid, transcriptPath: newP, final: true });
      const bigger = statSync(oldP).size > offsetOf(sid);
      quietFor(oldP, HOUR);
      quietFor(newP, 10 * MIN);
      catchUp(repo);
      const afterCatchup = samePath(repo.getSession(sid)?.transcript_path, newP);
      appendFileSync(newP, jsonl(fullTurn(c, t0 + 30 * MIN, 3, "a teraz podsumuj raport", "Podsumowanie dodane.")));
      ingestTranscript(repo, { sessionId: sid, transcriptPath: newP, final: true });
      out[d] = {
        bigger,
        afterCatchup,
        prompts: (
          db.query("SELECT n, text FROM prompts WHERE session_id = ? ORDER BY n").all(sid) as { n: number; text: string }[]
        ).map((x) => `${x.n}:${x.text}`),
        notes: notes(sid).map((o) => o.prompt_n),
      };
    }
    return out;
  },

  // pierwsza wiadomość z wklejonym obrazem: linia ~300 KB, dłuższa niż dawny odczyt początku (256 KB)
  head() {
    const sid = "obraz-na-start";
    const c = ctx(sid, "obraz");
    const t0 = Date.now() - HOUR;
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(300_000) } };
    const id = "toolu_img";
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        userPrompt(c, t0 + 1000, [image, { type: "text", text: "co jest nie tak na tym zrzucie ekranu" }]),
        toolCall(c, t0 + 2000, id, "bun run dev"),
        toolOutput(c, t0 + 3000, id, "serwer na :3000"),
        reply(c, t0 + 4000, "Na zrzucie brakuje paska narzędzi: komponent nie dostał danych z API."),
      ]),
    );
    const r = ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
    return { created: !!repo.getSession(sid), inserted: r.inserted.length };
  },

  // ostatnia tura czeka na długi Bash (tool_use bez wyniku), plik cichy od 10 min
  catchup() {
    const dir = claudeHome("catchup");
    const sid = "nadrabianie";
    const c = ctx(sid, "nadrabianie");
    const t0 = Date.now() - 2 * HOUR;
    const id = "toolu_tests";
    const p = writeTranscript(dir, sid, [
      metaLine(sid, t0),
      ...fullTurn(c, t0 + MIN, 1, "dodaj walidację formularza", "Dodałem walidację pól e-mail i telefonu."),
      userPrompt(c, t0 + 2 * MIN, "odpal wszystkie testy"),
      toolCall(c, t0 + 2 * MIN + 1000, id, "bun test", "Running tests…"),
    ]);
    quietFor(p, 10 * MIN);
    const first = catchUp(repo);
    const afterFirst = { notes: notes(sid).length, offset: offsetOf(sid), size: statSync(p).size };
    const second = catchUp(repo);
    appendFileSync(
      p,
      jsonl([
        toolOutput(c, t0 + 9 * MIN, id, "33 pass, 0 fail"),
        reply(c, t0 + 9 * MIN + 1000, "Testy przeszły: 33 pass, 0 fail. Walidacja formularza działa."),
      ]),
    );
    quietFor(p, 10 * MIN);
    const third = catchUp(repo);
    const summary = db.query("SELECT completed FROM summaries WHERE session_id = ? AND source = 'digest'").get(sid) as {
      completed: string | null;
    } | null;
    return {
      first,
      afterFirst,
      second,
      third,
      notes: notes(sid).map((o) => ({ prompt_n: o.prompt_n, narrative: o.narrative })),
      offset: offsetOf(sid),
      size: statSync(p).size,
      summary: summary?.completed ?? null,
    };
  },

  // ostatnia tura bez odpowiedzi w trzech sesjach: awaria (13 h ciszy), SessionEnd, sesja wznowiona po SessionEnd
  catchupPolicy() {
    const dir = claudeHome("polityka");
    const mk = (sid: string, quietMs: number) => {
      const c = ctx(sid, `polityka-${sid}`);
      const t0 = Date.now() - quietMs - HOUR;
      const p = writeTranscript(dir, sid, [
        metaLine(sid, t0),
        userPrompt(c, t0 + 1000, `wdróż wersję ${sid} na serwer testowy`),
        toolCall(c, t0 + 2000, `toolu_${sid}`, "./deploy.sh test", "Wdrażam…"),
      ]);
      quietFor(p, quietMs);
      return { c, p, t0 };
    };
    mk("awaria", 13 * HOUR);
    for (const [sid, endedAgo] of [
      ["koniec", 19 * MIN],
      ["wznowiona", 80 * MIN],
    ] as const) {
      const { c, p, t0 } = mk(sid, 20 * MIN);
      repo.upsertSession({ id: sid, project: sid, cwd: c.cwd, started_at: t0, transcript_path: p });
      repo.endSession(sid, Date.now() - endedAgo);
    }
    const r = catchUp(repo);
    return {
      inserted: r.inserted,
      awaria: notes("awaria").length,
      koniec: notes("koniec").length,
      wznowiona: notes("wznowiona").length,
    };
  },

  // sesja w „praca”, druga tura w katalogu „sejf” (capture.excludeProjects = ["sejf"] w config.json testu)
  exclude() {
    const sid = "wykluczenia";
    const praca = ctx(sid, "praca");
    const sejf = ctx(sid, "sejf");
    // nazwy projektów wprost: reguła z katalogu zależy od tego, czy nad katalogiem tymczasowym jest repo git
    repo.setProjectAlias(praca.cwd, "praca", "test");
    repo.setProjectAlias(sejf.cwd, "sejf", "test");
    const t0 = Date.now() - HOUR;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        ...fullTurn(praca, t0 + MIN, 1, "przygotuj raport sprzedaży", "Raport sprzedaży gotowy w pliku raport.md."),
        ...fullTurn(sejf, t0 + 2 * MIN, 2, "zmień hasło do bazy w sejfie", "Hasło do bazy zmienione w sejfie."),
        ...fullTurn(praca, t0 + 3 * MIN, 3, "dodaj wykres do raportu", "Wykres dodany do raportu sprzedaży."),
      ]),
    );
    const r = ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
    return {
      inserted: r.inserted.length,
      notes: notes(sid).map((o) => ({ prompt_n: o.prompt_n, project: o.project })),
      prompts: promptRows(sid).map((x) => ({ n: x.n, project: x.project })),
      sejfNotes: count("SELECT COUNT(*) c FROM observations WHERE project = 'sejf' OR narrative LIKE '%sejfie%'"),
      sejfPrompts: count("SELECT COUNT(*) c FROM prompts WHERE project = 'sejf' OR text LIKE '%sejfie%'"),
      promptCount: repo.getSession(sid)?.prompt_count,
      offset: offsetOf(sid),
      size: statSync(p).size,
    };
  },

  // dwa zdarzenia Stop: po pierwszym end_turn hook Stop blokuje koniec (uwaga), Claude pracuje dalej bez nowego promptu
  continuation() {
    const sid = "ciag-dalszy";
    const c = ctx(sid, "ciag");
    const t0 = Date.now() - HOUR;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        ...fullTurn(c, t0 + MIN, 1, "napraw build aplikacji mobilnej", "Build naprawiony: brakowało zależności expo-camera."),
      ]),
    );
    const req: IngestRequest = { sessionId: sid, transcriptPath: p, final: true };
    const stop1 = ingestTranscript(repo, req).inserted.length;
    const afterStop1 = { prompts: promptRows(sid).map((r) => r.n), n: metaN(sid) };
    const feedback = metaUser(c, t0 + 5 * MIN, "Stop hook feedback: [dokończ wdrożenie]: aplikacja nie jest jeszcze wdrożona");
    appendFileSync(
      p,
      jsonl([
        systemLine(sid, t0 + 4 * MIN, "stop_hook_summary"),
        feedback,
        toolCall(c, t0 + 6 * MIN, "toolu_deploy", "eas build --platform android", "Wdrażam build Androida."),
      ]),
    );
    // przed drugim Stop (spool, PreCompact): ciąg dalszy w toku czeka, offset na jego początku
    const pending = ingestTranscript(repo, { ...req, final: false });
    const waiting = { inserted: pending.inserted.length, offset: offsetOf(sid), feedbackStart: lineStart(p, feedback.uuid) };
    appendFileSync(
      p,
      jsonl([
        toolOutput(c, t0 + 9 * MIN, "toolu_deploy", "Build finished, uploaded to internal track"),
        reply(c, t0 + 10 * MIN, "Wdrożenie gotowe: build Androida opublikowany na ścieżce testów wewnętrznych."),
      ]),
    );
    const stop2 = ingestTranscript(repo, req).inserted.length;
    // następny prompt dostaje numer 2
    appendFileSync(p, jsonl(fullTurn(c, t0 + 20 * MIN, 2, "dodaj ikonę aplikacji", "Ikona dodana w assets/icon.png.")));
    const stop3 = ingestTranscript(repo, req).inserted.length;
    return {
      stop1,
      afterStop1,
      waiting,
      stop2,
      stop3,
      notes: db
        .query(
          "SELECT prompt_n, title, subtitle, narrative, json_extract(meta, '$.kind') kind, turn_key FROM observations WHERE session_id = ? ORDER BY id",
        )
        .all(sid),
      feedbackUuid: feedback.uuid,
      prompts: promptRows(sid).map((r) => r.n),
      n: metaN(sid),
      promptCount: repo.getSession(sid)?.prompt_count,
      offset: offsetOf(sid),
      size: statSync(p).size,
    };
  },

  // prompt z aplikacji desktop (blok <system-reminder> przed treścią), potem /model obsłużony lokalnie i drugi prompt
  localCommand() {
    const sid = "komendy";
    const c = ctx(sid, "komendy");
    const t0 = Date.now() - HOUR;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        desktopPrompt(c, t0 + MIN, "zrób certyfikat SSL na serwerze NAS"),
        toolCall(c, t0 + MIN + 1000, "toolu_cert", "certbot certonly --standalone"),
        toolOutput(c, t0 + MIN + 2000, "toolu_cert", "Successfully received certificate."),
        reply(c, t0 + MIN + 3000, "Certyfikat wystawiony i podpięty pod nginx na NAS."),
        metaUser(
          c,
          t0 + 2 * MIN,
          "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
        ),
        command(c, t0 + 2 * MIN + 100, "/model", "opus"),
        userPrompt(c, t0 + 2 * MIN + 200, "<local-command-stdout>Set model to opus</local-command-stdout>"),
        ...fullTurn(c, t0 + 3 * MIN, 2, "sprawdź odnowienie certyfikatu", "Odnowienie działa, timer certbot jest aktywny."),
      ]),
    );
    const r = ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
    return {
      inserted: r.inserted.length,
      prompts: db.query("SELECT n, text FROM prompts WHERE session_id = ? ORDER BY n").all(sid),
      firstPrompt: repo.getSession(sid)?.first_prompt ?? null,
      n: metaN(sid),
      promptCount: repo.getSession(sid)?.prompt_count,
      notes: notes(sid).map((o) => o.prompt_n),
    };
  },

  // sesje przeczytane parserem 0.1 przy kolejnych Stop: zgubiona pierwsza tura z aplikacji desktop i ciąg dalszy po
  // uwadze hooka Stop (okno zaczynało się bez promptu). Naprawa: próba na bazie tylko do odczytu, przebieg, drugi przebieg.
  recover() {
    const r = ownRepo("odzysk");
    const t0 = Date.now() - 2 * 86_400_000;
    const sid1 = "odzysk-live";
    const c1 = ctx(sid1, "odzysk1");
    r.setProjectAlias(c1.cwd, "odzysk", "test");
    const d1 = desktopPrompt(c1, t0 + MIN, "zrób certyfikat SSL na serwerze NAS");
    const t2 = fullTurn(
      c1,
      t0 + 2 * MIN,
      2,
      "napraw build aplikacji mobilnej",
      "Build naprawiony: brakowało zależności expo-camera.",
    );
    const feedback = metaUser(c1, t0 + 3 * MIN, "Stop hook feedback: [dokończ wdrożenie]: aplikacja nie jest jeszcze wdrożona");
    const done = reply(c1, t0 + 3 * MIN + 3000, "Wdrożenie gotowe: build Androida opublikowany na ścieżce testów wewnętrznych.");
    const t3 = fullTurn(c1, t0 + 5 * MIN, 3, "dodaj ikonę aplikacji", "Ikona dodana w assets/icon.png.");
    const p1 = join(home, `${sid1}.jsonl`);
    writeFileSync(
      p1,
      jsonl([
        metaLine(sid1, t0),
        d1,
        toolCall(c1, t0 + MIN + 1000, "toolu_cert", "certbot certonly --standalone"),
        toolOutput(c1, t0 + MIN + 2000, "toolu_cert", "Successfully received certificate."),
        reply(c1, t0 + MIN + 3000, "Certyfikat wystawiony i podpięty pod nginx na NAS."),
        ...t2,
        systemLine(sid1, t0 + 2 * MIN + 4000, "stop_hook_summary"),
        feedback,
        toolCall(c1, t0 + 3 * MIN + 1000, "toolu_deploy", "eas build --platform android", "Wdrażam build Androida."),
        toolOutput(c1, t0 + 3 * MIN + 2000, "toolu_deploy", "Build finished, uploaded to internal track"),
        done,
        ...t3,
      ]),
    );
    // stan po 0.1: okna Stop kończyły się na odpowiedziach; tura desktop i ciąg dalszy przepadły, numery od tury 2
    r.upsertSession({ id: sid1, project: "odzysk", cwd: c1.cwd, started_at: t0, transcript_path: p1, source: "live" });
    const t2Key = (t2[0] as { uuid: string }).uuid;
    const t3Key = (t3[0] as { uuid: string }).uuid;
    oldNote(r, p1, sid1, "odzysk", lineStart(p1, t2Key), lineEnd(p1, (t2[3] as { uuid: string }).uuid), 1);
    oldNote(r, p1, sid1, "odzysk", lineStart(p1, t3Key), lineEnd(p1, (t3[3] as { uuid: string }).uuid), 2);
    r.insertPrompt({
      session_id: sid1,
      project: "odzysk",
      n: 1,
      text: "napraw build aplikacji mobilnej",
      created_at: t0 + 2 * MIN,
      source: "live",
    });
    r.insertPrompt({
      session_id: sid1,
      project: "odzysk",
      n: 2,
      text: "dodaj ikonę aplikacji",
      created_at: t0 + 5 * MIN,
      source: "live",
    });
    readToEnd(r, sid1, p1, 2, "napraw build aplikacji mobilnej");
    buildSessionSummary(r, sid1);

    // sesja z jednym promptem z aplikacji desktop: 0.1 założył sesję, ale nie zapisał nic
    const sid2 = "odzysk-desktop";
    const c2 = ctx(sid2, "odzysk2");
    r.setProjectAlias(c2.cwd, "odzysk", "test");
    const d2 = desktopPrompt(c2, t0 + 10 * MIN, "przygotuj kopię zapasową bazy klientów");
    const p2 = join(home, `${sid2}.jsonl`);
    writeFileSync(
      p2,
      jsonl([
        metaLine(sid2, t0 + 10 * MIN),
        d2,
        toolCall(c2, t0 + 10 * MIN + 1000, "toolu_dump", "pg_dump klienci > klienci.sql"),
        toolOutput(c2, t0 + 10 * MIN + 2000, "toolu_dump", "ok"),
        reply(c2, t0 + 10 * MIN + 3000, "Kopia bazy klientów zapisana w klienci.sql (12 MB)."),
      ]),
    );
    r.upsertSession({ id: sid2, project: "odzysk", cwd: c2.cwd, started_at: t0 + 10 * MIN, transcript_path: p2, source: "live" });
    readToEnd(r, sid2, p2, 0, null);

    const snapshot = () =>
      JSON.stringify([
        r.db.query("SELECT id, turn_key, prompt_n, status, title FROM observations ORDER BY id").all(),
        r.db.query("SELECT id, session_id, n, text FROM prompts ORDER BY id").all(),
        r.db.query("SELECT id, transcript_offset, prompt_count, meta, first_prompt FROM sessions ORDER BY id").all(),
        r.db.query("SELECT id, session_id, completed FROM summaries ORDER BY id").all(),
      ]);
    const before = snapshot();
    const noCm = join(home, "brak-claude-mem.db");
    const ro = openDb({ path: r.db.filename, readonly: true });
    const dryLog = join(home, "odzysk-proba.jsonl");
    const dry = repair(new Repo(ro), { dryRun: true, cmDbPath: noCm, logPath: dryLog });
    ro.close();
    const afterDry = snapshot();
    const logPath = join(home, "odzysk.jsonl");
    const run = repair(r, { cmDbPath: noCm, logPath });
    const afterRun = snapshot();
    const again = repair(r, { cmDbPath: noCm, logPath: join(home, "odzysk-2.jsonl") });
    const log = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    return {
      dry: dry.recover,
      dryChanges: dry.changes,
      dryUnchanged: afterDry === before,
      dryLog: existsSync(dryLog),
      run: run.recover,
      runChanges: run.changes,
      report: formatRepairReport(run),
      again: again.recover,
      againChanges: again.changes,
      againUnchanged: snapshot() === afterRun,
      ops: log.map((e) => e.op),
      keys: { d1: d1.uuid, feedback: feedback.uuid, d2: d2.uuid },
      notes: r.db
        .query(
          "SELECT session_id, turn_key, prompt_n, source, subtitle, title, json_extract(meta, '$.kind') kind, json_extract(meta, '$.repair') repair, transcript_ref FROM observations ORDER BY id",
        )
        .all(),
      prompts: r.db.query("SELECT session_id, n, text, source FROM prompts ORDER BY session_id, n").all(),
      sessions: r.db
        .query("SELECT id, transcript_offset, prompt_count, json_extract(meta, '$.n') n, first_prompt FROM sessions ORDER BY id")
        .all(),
      sizes: { [sid1]: statSync(p1).size, [sid2]: statSync(p2).size },
      summary: (r.db.query("SELECT completed FROM summaries WHERE session_id = ? AND source = 'digest'").get(sid1) as any)
        ?.completed,
      summary2: r.db.query("SELECT 1 FROM summaries WHERE session_id = ?").get(sid2) !== null,
    };
  },

  // prompt z samych symboli („?”) zgubiony przez 0.1 przy zajętym numerze: klucz porównania po normalizacji był pusty,
  // więc dopisany prompt nie był „znany” i każdy przebieg naprawy dopisywał go od nowa pod kolejnym numerem
  recoverSymbolPrompt() {
    const r = ownRepo("odzysk-symbol");
    const t0 = Date.now() - 2 * 86_400_000;
    const sid = "odzysk-symbol";
    const c = ctx(sid, "odzysk-symbol");
    r.setProjectAlias(c.cwd, "odzysk-symbol", "test");
    const d = desktopPrompt(c, t0 + MIN, "?");
    const t2 = fullTurn(c, t0 + 2 * MIN, 2, "sprawdź logi serwera", "W logach serwera nie ma błędów od wczoraj.");
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        d,
        toolCall(c, t0 + MIN + 1000, "toolu_status", "systemctl status nginx"),
        toolOutput(c, t0 + MIN + 2000, "toolu_status", "active (running)"),
        reply(c, t0 + MIN + 3000, "Nginx działa, usługa aktywna od rana."),
        ...t2,
      ]),
    );
    // stan po 0.1: tura desktop przepadła, a prompt tury 2 zapisał się pod numerem 1 (zajęty numer tury desktop)
    r.upsertSession({ id: sid, project: "odzysk-symbol", cwd: c.cwd, started_at: t0, transcript_path: p, source: "live" });
    const k2 = (t2[0] as { uuid: string }).uuid;
    oldNote(r, p, sid, "odzysk-symbol", lineStart(p, k2), lineEnd(p, (t2[3] as { uuid: string }).uuid), 1);
    r.insertPrompt({
      session_id: sid,
      project: "odzysk-symbol",
      n: 1,
      text: "sprawdź logi serwera",
      created_at: t0 + 2 * MIN,
      source: "live",
    });
    readToEnd(r, sid, p, 1, "sprawdź logi serwera");
    const noCm = join(home, "brak-claude-mem.db");
    const run = repair(r, { cmDbPath: noCm, logPath: join(home, "odzysk-symbol.jsonl") });
    const again = repair(r, { cmDbPath: noCm, logPath: join(home, "odzysk-symbol-2.jsonl") });
    return {
      run: run.recover,
      againChanges: again.changes,
      prompts: r.db.query("SELECT n, text FROM prompts WHERE session_id = ? ORDER BY n").all(sid),
    };
  },

  // tury opisane przez claude-mem (prompt z tym samym tekstem i czasem i notatka do jego numeru): bez drugiej notatki,
  // także powiadomienie po nich; prompt claude-mem bez notatki to nie opis. To samo w ingest czytającym oknami.
  recoverClaudeMem() {
    const r = ownRepo("odzysk-cm");
    const t0 = Date.now() - 2 * 86_400_000;
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };
    const build = (sid: string, c: Ctx) => {
      const id = `toolu_${sid}`;
      return [
        fullTurn(c, t0 + MIN, 1, "napraw zakleszczenie portu 47777", "Port trzymał osierocony proces; zabity, worker wstaje."),
        [
          taskNote(c, t0 + 2 * MIN, "Testy w tle zakończone"),
          toolCall(c, t0 + 2 * MIN + 1000, `${id}_n`, "git log -1"),
          toolOutput(c, t0 + 2 * MIN + 2000, `${id}_n`, "abc123 fix: port"),
          reply(c, t0 + 2 * MIN + 3000, "Testy w tle przeszły, commit abc123 jest na gałęzi."),
        ],
        fullTurn(c, t0 + 3 * MIN, 2, "dodaj test dla modułu sesji", "Dodałem test sesji w pliku sesja.test.ts."),
        [
          userPrompt(c, t0 + 4 * MIN, [image]),
          toolCall(c, t0 + 4 * MIN + 1000, `${id}_i`, "bun run dev"),
          toolOutput(c, t0 + 4 * MIN + 2000, `${id}_i`, "serwer na :3000"),
          reply(c, t0 + 4 * MIN + 3000, "Na zrzucie brakuje paska narzędzi: komponent nie dostał danych z API."),
        ],
      ];
    };
    // osobne projekty sesji: ta sama treść w jednym projekcie to duplikat (wzmacnia istniejącą notatkę)
    const cm = (sid: string) =>
      cmData(r, sid, sid, [
        { n: 1, text: "napraw zakleszczenie portu 47777", at: t0 + MIN, note: true },
        { n: 2, text: "dodaj test dla modułu sesji", at: t0 + 3 * MIN, note: false },
        { n: 3, text: "[media prompt]", at: t0 + 4 * MIN, note: true },
      ]);

    // naprawa: sesja przeczytana do końca, backfill 0.1 pominął wszystko numerem claude-mem
    const sid = "odzysk-cm";
    const c = ctx(sid, "odzysk-cm");
    r.setProjectAlias(c.cwd, "odzysk-cm", "test");
    const turns = build(sid, c);
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(p, jsonl([metaLine(sid, t0), ...turns.flat()]));
    r.upsertSession({ id: sid, project: "odzysk-cm", cwd: c.cwd, started_at: t0, transcript_path: p, source: "claude-mem" });
    cm(sid);
    readToEnd(r, sid, p, 3, "napraw zakleszczenie portu 47777");
    const rec = recoverTurns(r);
    const recNotes = (
      r.db.query("SELECT turn_key FROM observations WHERE session_id = ? AND source != 'claude-mem'").all(sid) as {
        turn_key: string;
      }[]
    ).map((o) => o.turn_key);

    // ingest jak przy kolejnych Stop: powiadomienie zaczyna okno, jego stan bierze się z promptu sprzed okna
    const sid2 = "ingest-cm";
    const c2 = ctx(sid2, "ingest-cm");
    r.setProjectAlias(c2.cwd, "ingest-cm", "test");
    const turns2 = build(sid2, c2);
    const p2 = join(home, `${sid2}.jsonl`);
    r.upsertSession({ id: sid2, project: "ingest-cm", cwd: c2.cwd, started_at: t0, transcript_path: p2, source: "claude-mem" });
    cm(sid2);
    writeFileSync(p2, jsonl([metaLine(sid2, t0)]));
    const windows: number[] = [];
    for (const t of turns2) {
      appendFileSync(p2, jsonl(t));
      windows.push(ingestTranscript(r, { sessionId: sid2, transcriptPath: p2, final: true, source: "backfill" }).inserted.length);
    }
    const keyOf = (t: object[]) => (t[0] as { uuid: string }).uuid;
    return {
      rec,
      recNotes,
      keys: turns.map(keyOf),
      prompts: (r.db.query("SELECT n, source FROM prompts WHERE session_id = ? ORDER BY n").all(sid) as any[]).map(
        (x) => `${x.n}:${x.source}`,
      ),
      windows,
      ingestNotes: (
        r.db.query("SELECT turn_key FROM observations WHERE session_id = ? AND source != 'claude-mem'").all(sid2) as {
          turn_key: string;
        }[]
      ).map((o) => o.turn_key),
      keys2: turns2.map(keyOf),
      prompts2: (r.db.query("SELECT n, source FROM prompts WHERE session_id = ? ORDER BY n").all(sid2) as any[]).map(
        (x) => `${x.n}:${x.source}`,
      ),
      n2: (r.db.query("SELECT json_extract(meta, '$.n') n FROM sessions WHERE id = ?").get(sid2) as any).n,
    };
  },

  // wznowiona stara sesja po wyłączeniu claude-mem: jego ostatni prompt z notatką jest sprzed dwóch dni, a okno zaczyna
  // powiadomienie zadania albo komenda. Obserwator claude-mem w czasie tych tur nie działał, więc nikt ich nie opisał.
  resumedAfterClaudeMem() {
    const r = ownRepo("wznowiona-cm");
    const t0 = Date.now() - 2 * 86_400_000;
    const now = Date.now() - 10 * MIN;
    const out: Record<string, number> = {};
    for (const first of ["task", "command"] as const) {
      const sid = `wznowiona-${first}`;
      const c = ctx(sid, sid);
      r.setProjectAlias(c.cwd, sid, "test");
      const p = join(home, `${sid}.jsonl`);
      writeFileSync(
        p,
        jsonl([metaLine(sid, t0), ...fullTurn(c, t0 + MIN, 1, "napraw zakleszczenie portu", "Port zwolniony, worker wstaje.")]),
      );
      r.upsertSession({ id: sid, project: sid, cwd: c.cwd, started_at: t0, transcript_path: p, source: "claude-mem" });
      cmData(r, sid, sid, [{ n: 1, text: "napraw zakleszczenie portu", at: t0 + MIN, note: true }]);
      readToEnd(r, sid, p, 1, "napraw zakleszczenie portu");
      const id = `toolu_${sid}`;
      appendFileSync(
        p,
        jsonl([
          first === "task"
            ? taskNote(c, now, "Build w tle zakończony")
            : command(c, now, "/goal", "wdróż wersję 2.0 na produkcję"),
          toolCall(c, now + 1000, `${id}_a`, "git log -1"),
          toolOutput(c, now + 2000, `${id}_a`, "def456 release 2.0"),
          reply(c, now + 3000, "Wersja 2.0 jest na produkcji, commit def456 przeszedł testy."),
        ]),
      );
      out[first] = ingestTranscript(r, { sessionId: sid, transcriptPath: p, final: true, source: "backfill" }).inserted.length;
    }
    return out;
  },

  // #9001 nigdy niewidziana, #9002 wstrzyknięta, #9003 pobrana w tej sesji, #9004 wstrzyknięta w innej sesji
  cited() {
    const sid = "cytaty";
    const c = ctx(sid, "cytaty");
    const now = Date.now();
    const mk = (id: number, title: string) =>
      repo.insertObservation({
        id,
        session_id: "inna",
        project: "cytaty",
        type: "discovery",
        title,
        created_at: now - 86_400_000,
        source: "digest",
      });
    mk(9001, "Jak otwieramy pull requesty");
    mk(9002, "Port 47777 trzyma worker");
    mk(9003, "Konfiguracja proxy w biurze");
    mk(9004, "Stara notatka z innej sesji");
    repo.recordInjections(sid, [9002], "start", new Map());
    repo.logAccess([9003], "fetched", sid, now);
    repo.recordInjections("inna-sesja", [9004], "start", new Map());
    const t0 = now + 1000;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        ...fullTurn(
          c,
          t0 + 1000,
          1,
          "sprawdź, czemu worker nie wstaje",
          "Otworzyłem PR #9001. Zgodnie z #9002 port trzyma worker, a #9003 opisuje proxy; #9004 nie dotyczy.",
        ),
      ]),
    );
    ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true });
    const cited = (
      db.query("SELECT obs_id FROM access_log WHERE kind = 'cited' AND session_id = ? ORDER BY obs_id").all(sid) as {
        obs_id: number;
      }[]
    ).map((r) => r.obs_id);
    return { cited };
  },

  // inny proces trzyma blokadę zapisu 1,5 s; ingest ma poczekać (busy_timeout), a nie paść od razu
  async immediate() {
    const sid = "blokada";
    const c = ctx(sid, "blokada");
    const t0 = Date.now() - HOUR;
    const p = join(home, `${sid}.jsonl`);
    writeFileSync(
      p,
      jsonl([
        metaLine(sid, t0),
        ...fullTurn(c, t0 + MIN, 1, "zaktualizuj zależności projektu", "Zależności zaktualizowane, testy przechodzą."),
      ]),
    );
    // sesja już jest, więc jedyny zapis ingestu to jego transakcja
    repo.upsertSession({ id: sid, project: "blokada", cwd: c.cwd, started_at: t0, transcript_path: p });
    const locker = Bun.spawn([process.execPath, join(import.meta.dir, "locker.ts"), paths.db(), "1500"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = locker.stdout.getReader();
    const dec = new TextDecoder();
    let got = "";
    while (!got.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) break;
      got += dec.decode(value);
    }
    const t = performance.now();
    let error: string | null = null;
    let inserted = 0;
    try {
      inserted = ingestTranscript(repo, { sessionId: sid, transcriptPath: p, final: true }).inserted.length;
    } catch (e) {
      error = String(e);
    }
    const waitedMs = Math.round(performance.now() - t);
    await locker.exited;
    return { locked: got.includes("locked"), error, inserted, waitedMs };
  },

  // Codex: nadrabianie z CODEX_HOME/sessions (bez wątków podagentów) i hook Stop bez transcript_path
  async codex() {
    claudeHome("codex");
    const day = join(process.env.CODEX_HOME ?? "", "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    const a = "01a10000-0000-7000-8000-0000000000a1";
    const pa = join(day, X.rolloutName(a));
    writeFileSync(pa, jsonl(X.session(a)));
    quietFor(pa, 10 * MIN);
    const sub = "01a10000-0000-7000-8000-0000000000a2";
    const ps = join(day, X.rolloutName(sub));
    writeFileSync(ps, jsonl([X.sessionMeta(sub, X.CWD, { subagent: { other: "guardian" } }), ...X.session(sub).slice(1)]));
    quietFor(ps, 10 * MIN);
    const caught = catchUp(repo);
    const notes = (sid: string) =>
      (db.query("SELECT type, files_modified FROM observations WHERE session_id = ? ORDER BY id").all(sid) as any[]).map((o) => ({
        type: o.type,
        files: JSON.parse(o.files_modified).length,
      }));
    const prompts = (sid: string) =>
      (db.query("SELECT n, text FROM prompts WHERE session_id = ? ORDER BY n").all(sid) as any[]).map((r) => `${r.n}:${r.text}`);

    // hook Stop z Codexa: bez transcript_path, rollout po id wątku; ostatnia tura dopiero po task_complete
    const h = "01a10000-0000-7000-8000-0000000000a3";
    const ph = join(day, X.rolloutName(h));
    // inna treść niż w pierwszej sesji: identyczna tura to duplikat i nie dostaje drugiej notatki
    const rows = X.session(h, X.CWD, " (hook)");
    const hook = (rowsNow: object[]) => {
      writeFileSync(ph, jsonl(rowsNow));
      const r = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "..", "..", "..", "src", "hooks", "hook.ts"), "stop", "codex"],
        {
          stdin: Buffer.from(JSON.stringify({ session_id: h, cwd: X.CWD, hook_event_name: "Stop" })),
          env: process.env as Record<string, string>,
        },
      );
      return { code: r.exitCode, notes: notes(h).length };
    };
    const beforeComplete = hook(rows.slice(0, 11));
    const afterComplete = hook(rows.slice(0, 12));
    const session = repo.getSession(a);
    return {
      caught: { files: caught.files, inserted: caught.inserted },
      notes: notes(a),
      prompts: prompts(a),
      transcript: session?.transcript_path === pa,
      subagent: notes(sub).length + (repo.getSession(sub) ? 1 : 0),
      beforeComplete,
      afterComplete,
    };
  },
};

const name = process.argv[2] ?? "";
const run = scenarios[name];
if (!run) throw new Error(`nieznany scenariusz: ${name}`);
process.stdout.write(JSON.stringify(await run()));
