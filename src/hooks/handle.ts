// Logika hooków wspólna dla trzech dróg wywołania (config hooks.mode): proces `bun hook.ts` (command), narzędzia
// hook_* serwera MCP (mcp) i endpoint workera /api/hook/<zdarzenie>, w który uderza natywny hook (native).
// Zasada bez zmian: żadna droga nie blokuje użytkownika. Błąd daje pusty wynik, a tura i tak wróci z transkryptu
// (nadrabianie w workerze). Moduły cięższe niż konfiguracja ładujemy leniwie: start hooka Buna liczy się w ms.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { claudeDir, loadConfig, paths, refreshConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { TextEmbedder } from "../index/embedder.ts";

export const HOOK_EVENTS = ["session-start", "prompt", "post-tool", "stop", "pre-compact", "session-end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Claude Code przyjmuje do 10 000 znaków additionalContext; nadmiar ląduje w pliku zamiast w kontekście. */
export const MAX_CONTEXT_CHARS = 9500;

/** Najwięcej plików z jednego wywołania narzędzia (łatka Codexa potrafi zmienić kilkanaście naraz). */
export const MAX_FILES = 3;

/**
 * Zapis tury w workerze idzie na jego pętlę zdarzeń (synchroniczny SQLite i parsowanie w jednej transakcji, bez
 * oddechów jak w nadrabianiu) i ma się zmieścić w budżecie pętli (ok. 40 ms, jak kawałki pracy z util/slice.ts).
 * Koszt rośnie przede wszystkim z liczbą linii (tur), bajty kosztują mniej. Zwykły Stop (jedna tura, nawet z kilkudziesięcioma
 * narzędziami) mieści się w progach; zaległość ponad którykolwiek próg worker oddaje hookowi Buna (`delegate`).
 */
export const WORKER_INGEST_BYTES = 512 * 1024;
/** Najwięcej linii zaległego kawałka w workerze (ok. 37 krótkich tur po 4 linie albo jedna tura z ok. 70 narzędziami). */
export const WORKER_INGEST_LINES = 150;
/** Okno odczytu w workerze rośnie najwyżej do tylu bajtów (zapas na linie dopisane między stat a odczytem). */
const WORKER_WINDOW_CAP = 1024 * 1024;

/** Czy zaległy kawałek (`len` bajtów od `from`) ma więcej niż `max` linii: odczyt najwyżej progu bajtów, bez parsowania. */
function moreLinesThan(path: string, from: number, len: number, max: number): boolean {
  if (len <= 0) return false;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const got = buf.subarray(0, readSync(fd, buf, 0, len, from));
    let n = 0;
    for (let i = got.indexOf(10); i !== -1; i = got.indexOf(10, i + 1)) if (++n > max) return true;
    return false;
  } finally {
    closeSync(fd);
  }
}

export interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

/** Wstrzyknięcie policzone, ale niezapisane: zapis dopiero, gdy wynik dotarł do hooka (natywny potwierdza je workerowi). */
export interface PendingInjection {
  session: string;
  channel: "start" | "prompt" | "file";
  ids: number[];
  costs: Record<string, number>;
  /** kanał pliku: klucze plików do oznaczenia jako pokazane (przypomnienie raz na sesję) */
  files?: string[];
}

export interface HookResult {
  output: HookOutput | null;
  pending: PendingInjection | null;
  /** Worker oddaje zdarzenie hookowi Buna: duży zaległy zapis tury albo transkrypt spoza jego katalogów. */
  delegate?: boolean;
}

export interface HookOptions {
  repo: Repo;
  codex?: boolean;
  /** CLAUDE_PROJECT_DIR procesu, który dostał zdarzenie: projekt sesji ma pierwszeństwo przed cwd */
  projectDir?: string | null;
  /** katalog procesu hooka, gdy payload nie ma cwd (natywny hook podaje swój) */
  cwd?: string | null;
  /** Wywołanie spoza procesu hooka (narzędzie MCP, HTTP): transkrypt tylko taki, jak w trustedTranscript. */
  strict?: boolean;
  /** Natywny hook nie doczekał się workera: nie pytamy go drugi raz, liczymy od razu lokalnie. */
  skipWorker?: boolean;
  /** Wywołanie w workerze: kontekst liczy model w procesie, wstrzyknięcia wracają jako `pending`, bez HTTP do siebie. */
  inWorker?: { embedder: TextEmbedder | null; notify: () => void };
}

type Injected = { text: string | null; ids?: number[]; costs?: Record<string, number> };

const NONE: HookResult = { output: null, pending: null };
const DELEGATE: HookResult = { output: null, pending: null, delegate: true };

export function additional(hookEventName: string, text: string | null | undefined): HookOutput | null {
  if (!text) return null;
  const t =
    text.length > MAX_CONTEXT_CHARS
      ? `${text.slice(0, MAX_CONTEXT_CHARS - 80).replace(/\n[^\n]*$/, "")}\n… (ucięte do limitu hooka; reszta: search / timeline)`
      : text;
  return { hookSpecificOutput: { hookEventName, additionalContext: t } };
}

export function spool(kind: string, payload: unknown, err: unknown): void {
  try {
    mkdirSync(paths.spool(), { recursive: true });
    appendFileSync(
      join(paths.spool(), "pending.jsonl"),
      `${JSON.stringify({ at: Date.now(), kind, payload, error: String(err).slice(0, 300) })}\n`,
    );
  } catch {}
}

/** Wstrzyknięcia z workera zapisujemy dopiero po odebraniu odpowiedzi: żądanie porzucone po limicie czasu
 *  nie zostawia w bazie notatek, których model nie zobaczył (nie wypadają z sesji i nie dostają kary). */
function recordInjected(repo: Repo, sessionId: string, res: Injected | null, channel: "start" | "prompt"): void {
  // bez `costs` odpowiada worker sprzed zmiany (żyje do 3 h bezczynności): on już zapisał, drugi zapis podwoiłby karę
  const p = toPending(sessionId, res, channel);
  if (p) recordPending(repo, p);
}

function toPending(sessionId: string, res: Injected | null, channel: "start" | "prompt"): PendingInjection | null {
  if (!sessionId || !res?.text || !res.ids?.length || !res.costs) return null;
  return { session: sessionId, channel, ids: res.ids, costs: res.costs };
}

/** Zapis wstrzyknięcia, które dotarło do modelu (hook Buna, serwer MCP, potwierdzenie natywnego hooka). */
export function recordPending(repo: Repo, p: PendingInjection): void {
  try {
    for (const key of p.files ?? []) repo.markFileInjected(p.session, key);
    const costs = new Map(Object.entries(p.costs ?? {}).map(([k, v]) => [Number(k), Number(v)]));
    repo.recordInjections(p.session, p.ids.map(Number), p.channel, costs);
  } catch {}
}

/** Transkrypt tej sesji: Claude Code pisze `<session_id>.jsonl`, Codex `rollout-…-<id wątku>.jsonl`. */
export function ownTranscript(path: string, sessionId: string): boolean {
  const b = basename(path).toLowerCase();
  const id = sessionId.toLowerCase();
  return !!id && (b === `${id}.jsonl` || b.endsWith(`-${id}.jsonl`));
}

const WIN = process.platform === "win32";

/**
 * Ścieżka po rozwiązaniu dowiązań (na Windows bez wielkości liter). Czego jeszcze nie ma (SessionStart nowego
 * projektu przed pierwszą linią transkryptu), dokładamy do najgłębszego istniejącego katalogu.
 */
function canon(path: string): string {
  let p = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const r = join(realpathSync.native(p), ...rest);
      return WIN ? r.toLowerCase() : r;
    } catch {
      const up = dirname(p);
      if (up === p) throw new Error(`brak ścieżki: ${path}`);
      rest.unshift(basename(p));
      p = up;
    }
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Transkrypt z wywołania spoza procesu hooka (narzędzie MCP, HTTP workera), gdzie ścieżkę może podać ktokolwiek:
 * tylko plik tej sesji (id w nazwie), bezwzględny, bez UNC i przedrostków `\\?\`, `\\.\`, po realpath pod
 * `<CLAUDE_CONFIG_DIR>/projects` albo `<CODEX_HOME>/sessions`. Dla sesji, która ma już transkrypt, tylko ten sam
 * plik: obcy plik nie przesunie jej offsetu ani nie zamknie jej przez SessionEnd.
 */
export async function trustedTranscript(repo: Repo, path: string, sessionId: string): Promise<string | null> {
  if (!sessionId || !ownTranscript(path, sessionId)) return null;
  if (/^[\\/]{2}/.test(path) || !isAbsolute(path) || (WIN && !/^[a-z]:[\\/]/i.test(path))) return null;
  try {
    const real = canon(path);
    const { codexHome } = await import("../capture/codex.ts");
    const roots = [join(claudeDir(), "projects"), join(codexHome(), "sessions")];
    if (
      !roots.some((r) => {
        try {
          return inside(real, canon(r));
        } catch {
          return false;
        }
      })
    )
      return null;
    try {
      if (!statSync(real).isFile()) return null;
    } catch {} // pliku jeszcze nie ma (SessionStart przed pierwszą linią): wystarczy katalog
    const stored = repo.getSession(sessionId)?.transcript_path;
    if (stored && canon(stored) !== real) return null;
    return path;
  } catch {
    return null;
  }
}

/** Pliki, o których przypomnieć: Claude Code podaje `tool_input.file_path`, Codex łatkę (capture/codex.ts). */
async function hookFiles(input: any, codex: boolean): Promise<{ path: string; changed: boolean }[]> {
  if (codex) return (await import("../capture/codex.ts")).codexHookFiles(input, MAX_FILES);
  const fp = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return fp ? [{ path: String(fp), changed: false }] : [];
}

/** Notatki o pliku, który łatka właśnie zmieniła, opisują stan sprzed zmiany: ostrzeżenie pod nagłówkiem. */
const CHANGED_NOTE = "⚠ plik zmieniony przed chwilą: notatki opisują stan sprzed tej zmiany, sprawdź kod, zanim im zaufasz";

export async function runHook(event: string, input: any, o: HookOptions): Promise<HookResult> {
  // worker i serwer MCP żyją godzinami: zmiana config.json (privateTools, excludeProjects) działa od następnego
  // zdarzenia, jak w hooku Buna, który za każdym razem czyta config od nowa (koszt: odczyt małego pliku i jego skrót)
  const cfg = o.inWorker || o.strict ? refreshConfig() : loadConfig();
  const { repo, inWorker } = o;
  const codex = o.codex === true;
  input = input && typeof input === "object" ? input : {};
  const cwd: string | null = input.cwd ? String(input.cwd) : (o.cwd ?? process.cwd());
  // tożsamość projektu jak w claude-mem: katalog projektu z Claude Code przed bieżącym cwd (po `cd` agenta albo
  // w katalogu tymczasowym podagenta cwd nie wskazuje projektu); cwd zostaje do kluczy plików
  const project = repo.resolveProject(o.projectDir?.trim() || cwd);
  const sessionId = input.session_id ? String(input.session_id) : "";
  if (cfg.capture.excludeProjects.some((p) => p.toLowerCase() === project.toLowerCase())) return NONE;
  if (codex && !cfg.capture.codex) return NONE;
  // Codex nie zawsze podaje ścieżkę rolloutu: szukamy pliku po id wątku
  let transcriptPath: string | null = input.transcript_path ? String(input.transcript_path) : null;
  if (!transcriptPath && codex && sessionId) transcriptPath = (await import("../capture/codex.ts")).findCodexRollout(sessionId);
  // ścieżka odrzucona w trybie ścisłym: worker oddaje zapis tury hookowi Buna (on dostał payload prosto od Claude Code)
  // Inny plik znanej sesji (wznowienie w innym katalogu, zob. ingest) też jest tu odrzucany: worker oddaje go hookowi
  // Buna, a w trybie mcp nic się nie zapisuje i sesja się nie zamyka (dokończy nadrabianie z katalogu transkryptów)
  let rejected = false;
  if (o.strict && transcriptPath && event !== "prompt" && event !== "post-tool") {
    transcriptPath = await trustedTranscript(repo, transcriptPath, sessionId);
    rejected = !transcriptPath;
  }
  // klucze plików przy odczycie od tego samego katalogu co przy zapisie (podkatalog projektu bez repo: od katalogu
  // startowego sesji, zob. turnPlace); liczone tylko dla zdarzeń, które szukają po plikach. W trybie mcp bez
  // projectDir: katalog startowy wyłącznie z sessions.meta.root
  const keyCwd = async () =>
    (await import("../capture/place.ts")).keyBase(repo, cfg.capture.excludeProjects, sessionId, cwd, o.projectDir);

  switch (event) {
    case "session-start": {
      if (!cfg.context.enabled) return NONE;
      const { sessionStartContext } = await import("../recall/context.ts");
      // po /compact albo wznowieniu w podkatalogu przeterminowanie liczy się od katalogu kluczy, nie od cwd
      const base = await keyCwd();
      // katalog startowy i jego werdykt (projekt czy kontener) od razu w sessions.meta: hooki pierwszej tury czytają
      // go zamiast skanować podkatalogi (później liczy go ingest). W workerze krótszy limit skanu (jego pętla)
      const remember = async () => {
        try {
          (await import("../capture/place.ts")).rememberRoot(repo, sessionId, o.projectDir?.trim() || cwd, inWorker ? 50 : 200);
        } catch {}
      };
      if (inWorker) {
        if (sessionId)
          repo.upsertSession({ id: sessionId, project, cwd, started_at: Date.now(), transcript_path: transcriptPath });
        const res = await sessionStartContext(repo, inWorker.embedder, {
          project,
          sessionId: sessionId || null,
          cwd: base,
          record: false,
        });
        await remember();
        return { output: additional("SessionStart", res.text), pending: toPending(sessionId, res, "start") };
      }
      const client = await import("../worker/client.ts");
      const qs = new URLSearchParams({
        project,
        session: sessionId,
        cwd: base ?? "",
        source: String(input.source ?? ""),
        record: "0",
      });
      let res: Injected | null = o.skipWorker
        ? null
        : await client.call<Injected>(`/api/context/start?${qs}`, { timeoutMs: 1800 });
      if (res) recordInjected(repo, sessionId, res, "start");
      else {
        // worker nie odpowiedział: kontekst liczymy lokalnie (FTS + aktywacja, zapisuje własne wstrzyknięcia);
        // nowego workera startujemy tylko, gdy obecny nie żyje (wolny worker nie dostaje dubla)
        if (!(await client.health(300))) await client.spawnWorker();
        repo.upsertSession({ id: sessionId, project, cwd, started_at: Date.now(), transcript_path: transcriptPath });
        res = await sessionStartContext(repo, null, { project, sessionId, cwd: base });
      }
      await remember();
      return { output: additional("SessionStart", res?.text), pending: null };
    }
    case "prompt": {
      if (!cfg.context.enabled || !cfg.context.promptRecall) return NONE;
      const prompt = String(input.prompt ?? "");
      if (prompt.trim().length < 12) return NONE;
      const { promptContext } = await import("../recall/context.ts");
      const base = await keyCwd();
      if (inWorker) {
        const res = await promptContext(repo, inWorker.embedder, { project, sessionId, prompt, cwd: base, record: false });
        return { output: additional("UserPromptSubmit", res?.text), pending: toPending(sessionId, res, "prompt") };
      }
      const client = await import("../worker/client.ts");
      let res: Injected | null = o.skipWorker
        ? null
        : await client.call<Injected>("/api/context/prompt", {
            body: { project, session: sessionId, prompt, cwd: base, record: false },
            timeoutMs: 1600,
          });
      if (res) recordInjected(repo, sessionId, res, "prompt");
      else {
        res = (await promptContext(repo, null, { project, sessionId, prompt, cwd: base })) ?? { text: null };
        if (!(await client.health(300))) await client.spawnWorker();
      }
      return { output: additional("UserPromptSubmit", res?.text), pending: null };
    }
    case "post-tool": {
      if (!cfg.context.enabled || !cfg.context.fileRecall || !sessionId) return NONE;
      const files = await hookFiles(input, codex);
      if (!files.length) return NONE;
      const { fileContext } = await import("../recall/context.ts");
      const parts: string[] = [];
      // w workerze plik i wstrzyknięcie zapisuje dopiero potwierdzenie natywnego hooka (wynik dotarł do modelu)
      const pending: PendingInjection = { session: sessionId, channel: "file", ids: [], costs: {}, files: [] };
      const base = await keyCwd();
      for (const f of files) {
        const res = fileContext(repo, { project, sessionId, filePath: f.path, cwd: base, record: !inWorker });
        if (!res?.text) continue;
        const [head, ...rest] = res.text.split("\n");
        parts.push(f.changed ? [head, CHANGED_NOTE, ...rest].join("\n") : res.text);
        if (res.fileKey) pending.files!.push(res.fileKey);
        for (const id of res.ids) if (!pending.ids.includes(id)) pending.ids.push(id);
        Object.assign(pending.costs, res.costs ?? {});
      }
      const output = additional("PostToolUse", parts.join("\n\n"));
      return { output, pending: inWorker && output ? pending : null };
    }
    case "stop":
    case "pre-compact":
    case "session-end": {
      if (!sessionId) return NONE;
      if (!transcriptPath) return inWorker && rejected ? DELEGATE : NONE;
      // w workerze ten sam plik co zapisany w sesji (trustedTranscript), więc offset sesji dotyczy tego pliku
      const from = repo.getSession(sessionId)?.transcript_offset ?? 0;
      if (inWorker) {
        // duży zaległy kawałek nie idzie na pętlę workera (przestój podglądu i innych hooków): liczy hook Buna.
        // Dwa progi, bo wiele krótkich tur kosztuje więcej niż te same bajty w kilku długich
        let unread = 0;
        try {
          unread = statSync(transcriptPath).size - from;
        } catch {}
        if (unread > WORKER_INGEST_BYTES) return DELEGATE;
        try {
          if (moreLinesThan(transcriptPath, from, unread, WORKER_INGEST_LINES)) return DELEGATE;
        } catch {}
      }
      // Codex dopisuje koniec tury (task_complete) po swojemu: turę zamykamy, gdy rollout go już pokazuje,
      // a resztę domknie nadrabianie; Claude Code woła Stop dopiero po zapisie odpowiedzi. Ścieżkę transkryptu
      // sesji (także założonej bez niej na starcie) zapisuje ingest razem z offsetem
      const req = {
        sessionId,
        transcriptPath,
        cwd,
        final: event === "pre-compact" ? false : codex ? ("complete" as const) : true,
        maxBytes: inWorker ? WORKER_INGEST_BYTES : 24 * 1024 * 1024,
        windowCap: inWorker ? WORKER_WINDOW_CAP : undefined,
        // w workerze twarda granica odczytu: plik dopisany po sprawdzeniu progu ani długa tura czytana partiami
        // (readLongTurn) nie wyjdą ponad próg bajtów; reszta czeka na następne zdarzenie albo nadrabianie. Gdy plik
        // jest dłuższy niż granica, ingest nie zamyka tury przy niej (final tylko do rzeczywistego końca pliku)
        limit: inWorker ? from + WORKER_INGEST_BYTES : undefined,
      };
      try {
        const { ingestTranscript } = await import("../capture/ingest.ts");
        const r = ingestTranscript(repo, req);
        if (codex && !r.done) ingestTranscript(repo, req);
        else if (codex && r.offset < Bun.file(transcriptPath).size) {
          await Bun.sleep(400);
          ingestTranscript(repo, req);
        }
        if (event === "session-end") {
          const { buildSessionSummary } = await import("../capture/summary.ts");
          buildSessionSummary(repo, sessionId);
          repo.endSession(sessionId, Date.now());
        }
      } catch (e) {
        // w workerze błąd wraca do natywnego hooka, który powtórzy zapis hookiem Buna (ten w razie czego spooluje)
        if (inWorker) throw e;
        spool("ingest", req, e);
      }
      // powiadomienia (opt-in): proces hooka Buna podnosi odłączony proces wysyłki (wszystkie kanały); worker i serwer
      // MCP nie uruchamiają procesów (zasada 2), więc wysyłają w procesie tylko file i webhook, bez czekania na wynik
      // (webhook do 5 s nie opóźnia odpowiedzi hooka). toast i command działają tylko dla Stop z procesu hooka
      if (cfg.notify?.enabled) {
        try {
          const N = await import("../notify/notify.ts");
          if (inWorker || o.strict) void N.notifyInProcess(repo);
          else await N.kickNotifier(repo, cfg);
        } catch {}
      }
      if (inWorker) {
        inWorker.notify();
        return NONE;
      }
      // obudź workera (wektory, podgląd na żywo); nie czekamy na odpowiedź dłużej niż chwilę
      const client = await import("../worker/client.ts");
      const ok = o.skipWorker
        ? null
        : await client.call("/api/notify", { body: { kind: event, session: sessionId }, timeoutMs: 300 });
      if (!ok) await client.spawnWorker();
      return NONE;
    }
    default:
      return NONE;
  }
}
