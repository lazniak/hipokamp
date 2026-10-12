#!/usr/bin/env bun
// Worker hipokampa: jeden proces, bez procesów potomnych (żadne dziecko nie odziedziczy gniazda),
// API + podgląd na 127.0.0.1:47777, dolicza wektory, konsoliduje w bezczynności, sam się wyłącza.
// Pętla zdarzeń zostaje wolna dla hooków: model wektorów i kopia bazy liczą w osobnych wątkach (Bun Worker),
// a nadrabianie, sen i przebudowa FTS idą kawałkami z oddechem (diagnostyka przestojów: lag.ts).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDirs, llmConfig, loadConfig, paths, refreshConfig } from "../config.ts";
import { getDb, getMeta, setMeta } from "../db/db.ts";
import { Repo } from "../db/repo.ts";
import { ThreadEmbedder } from "../index/embed-client.ts";
import { initLog, log, pruneLogs } from "../log.ts";
import { disarmNotifyRetry } from "../notify/notify.ts";
import { SyncScheduler } from "../sync/background.ts";
import { VERSION } from "../version.ts";
import { ensureKey } from "./auth.ts";
import { health, keyPath } from "./client.ts";
import { EmbedLoop } from "./embedloop.ts";
import { track } from "./lag.ts";
import { createServer, pollNewObservations } from "./server.ts";

initLog("worker", !process.env.HIPOKAMP_SPAWNED);
ensureDataDirs();
const cfg = loadConfig();

// klucz uwierzytelnienia (T-17): zwykle tworzy go klient przed startem workera (z ACL na Windows); worker uruchomiony
// ręcznie tworzy go sam, ale icacls to proces potomny, więc ACL nada najbliższy start z klienta albo hipokamp install
try {
  if (ensureKey(keyPath()).created) log.info("klucz workera utworzony przez workera (ACL: hipokamp doctor)");
} catch (e) {
  log.error("klucz workera: nie da się utworzyć ani przeczytać, klienci nie przejdą wyzwania", String(e));
}

const existing = await health(500);
if (existing) {
  log.info("worker już działa, kończę duplikat", { pid: existing.pid });
  process.exit(0);
}

// bez ponawiania przy zajętej bazie: duplikat czekający na bazę przeszedłby kontrolę health() i potem requeueStale()
// cofnąłby zadania działającego workera; pad i ponowny start z hooka jest tu bezpieczniejszy
const db = getDb();
const repo = new Repo(db);
repo.requeueStale();
const embedder = new ThreadEmbedder(cfg.embed);
const embedLoop = new EmbedLoop(repo, embedder);
// embed.enabled = false: API nigdy nie ładuje modelu (ani nie pobiera go z sieci), pętla wektorów też stoi
const apiEmbedder = cfg.embed.enabled ? embedder : null;
const startedAt = Date.now();
let lastActivity = Date.now();
// opcjonalny etap snu z lokalnym LLM (domyślnie wyłączony): tylko w bezczynności, przerywa go pierwsze żądanie
let llmRun: AbortController | null = null;

// sen oddaje sterowanie w trakcie, więc drugie wywołanie (tick i /api/admin/sleep) dostaje ten sam przebieg: jedyna
// blokada jest w consolidate/sleep.ts, a trwający sen nie jest liczony drugi raz jako zadanie
async function runSleep(): Promise<unknown> {
  const { sleep, sleepInProgress } = await import("../consolidate/sleep.ts");
  refreshConfig(); // sen z konfiguracją z pliku (consolidation.*, capture.*), bez restartu workera
  return sleepInProgress() ?? track("sen", () => sleep(repo), { sliced: true });
}

let server: ReturnType<typeof createServer>;
try {
  server = createServer({
    repo,
    embedder: apiEmbedder,
    embedLoop,
    startedAt,
    onActivity: () => {
      lastActivity = Date.now();
      llmRun?.abort();
    },
    runSleep,
    keyFile: keyPath(),
  });
} catch (e: any) {
  // port zajęty przez coś, co nie jest nami: nie walczymy, tylko zgłaszamy (żadnego zabijania cudzych procesów)
  log.error(`nie mogę nasłuchiwać na ${cfg.host}:${cfg.port}`, String(e?.message ?? e));
  process.exit(1);
}

writeFileSync(paths.lock(), JSON.stringify({ pid: process.pid, port: cfg.port, startedAt, version: VERSION }));
log.info("worker wystartował", { pid: process.pid, port: cfg.port });

// zaległości z hooków, które nie mogły pisać do bazy
async function drainSpool(): Promise<void> {
  const f = join(paths.spool(), "pending.jsonl");
  if (!existsSync(f)) return;
  const work = `${f}.${process.pid}.work`;
  try {
    renameSync(f, work);
  } catch {
    return;
  }
  const { ingestTranscript } = await import("../capture/ingest.ts");
  for (const line of readFileSync(work, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      // final: false, bo spool odtwarzamy przy starcie workera, zwykle w trakcie żywej sesji (tura może trwać)
      if (j.kind === "ingest") ingestTranscript(repo, { ...j.payload, final: false });
    } catch (e) {
      log.warn("spool: wpis pominięty", String(e));
    }
  }
  unlinkSync(work);
}

await track("kolejka awaryjna", drainSpool);
// indeks FTS w starszej wersji (np. po aktualizacji): przebudowa partiami, API odpowiada w trakcie
if (repo.ftsOutdated()) {
  const t0 = performance.now();
  void track("przebudowa FTS", () => repo.reindexFts(), { sliced: true })
    .then((r) => log.info("FTS przebudowany", { ...r, s: Math.round((performance.now() - t0) / 1000) }))
    .catch((e) => log.error("przebudowa FTS", e));
} else {
  // przebudowa przerwana zabiciem procesu (np. `hipokamp reindex` w CLI) zostawia wyłączone scalanie segmentów
  try {
    repo.ftsMergeDefaults();
  } catch (e) {
    log.warn("FTS: nie ustawiono domyślnego scalania", String(e));
  }
}
void embedLoop.start();
// model do zapytań ładujemy od razu w tle — pierwszy prompt nie czeka na rozruch ONNX
if (cfg.context.promptRecall && cfg.embed.enabled)
  void track("model: rozgrzewka", () => embedder.embed(["rozgrzewka"], "query"), { thread: true }).catch((e) =>
    log.warn("rozgrzewka modelu nieudana", String(e)),
  );

let lastCatchUp = 0;
let ticking = false;
// synchronizacja z hubem (docs/SYNC.md): tylko po włączeniu w konfiguracji, domyślnie żadnej sieci. Ustawienia
// z config.json w każdym cyklu (syncConfigFromFile), więc sync.enabled: false zatrzymuje kolejny obieg bez restartu
const syncer = new SyncScheduler(repo);
function maybeSync(): void {
  syncer
    .maybe((run) => track("sync", run, { sliced: true }))
    ?.then((r) => {
      if (!r) return;
      if (r.pull.observations) embedLoop.notify(); // nowe notatki z innych komputerów: wektory liczy ta maszyna
      if (r.push.ops || r.pull.entries || r.push.skipped || r.pull.unreadable || r.pull.rejected)
        log.info("sync", {
          wysłane: r.push.ops,
          wpisy: r.pull.entries,
          notatki: r.pull.observations,
          uszkodzone: r.pull.bad,
          nieczytelne: r.pull.unreadable,
          odrzucone: r.pull.rejected,
          zaDuże: r.push.skipped,
        });
    })
    .catch((e) => log.warn("sync nieudany", String(e?.message ?? e)));
}

const tick = setInterval(async () => {
  // podgląd na żywo co 5 s także w trakcie długiego nadrabiania, snu albo kopii (jest poza blokadą przebiegu)
  try {
    track("podgląd: nowe notatki", () => pollNewObservations(repo));
  } catch (e) {
    log.error("podgląd: nowe notatki", e);
  }
  // synchronizacja też poza blokadą: ma własną (jeden obieg naraz) i nie czeka na nadrabianie, sen ani kopię
  try {
    maybeSync();
  } catch (e) {
    log.error("sync", e);
  }
  // jeden przebieg naraz: nadrabianie, sen i kopia oddają sterowanie, więc mogą trwać dłużej niż 5 s
  if (ticking) return;
  ticking = true;
  try {
    const idleMin = (Date.now() - lastActivity) / 60_000;
    // co 10 min dociągamy to, czego ucięte hooki nie zapisały (transkrypt = trwała kolejka)
    if (Date.now() - lastCatchUp > 10 * 60_000) {
      lastCatchUp = Date.now();
      const { catchUpSliced } = await import("./catchup.ts");
      refreshConfig(); // zmiana privateTools czy excludeProjects obowiązuje też nadrabianie, bez restartu workera
      await track("nadrabianie", () => catchUpSliced(repo), { sliced: true });
      // pamięć automatyczna Claude Code: osobny krok z przerwami (slicer), po nadrabianiu transkryptów; bez `cfg`
      // z chwili startu: loadConfig() oddaje konfigurację odświeżoną wyżej (refreshConfig), więc
      // capture.autoMemory = false działa bez restartu workera
      const { catchUpAutoMemory } = await import("../importers/automemory.ts");
      await track("pamięć automatyczna", () => catchUpAutoMemory(repo), { sliced: true });
    }
    // sen: raz na ~20 h, gdy nikt nie pracuje od 10 min
    const lastSleep = Number(getMeta(db, "last_sleep_at") ?? 0);
    if (idleMin > 10 && Date.now() - lastSleep > 20 * 3_600_000) {
      await runSleep();
      pruneLogs();
    }
    if (!llmRun && llmConfig(loadConfig())) {
      const { llmStageDue, sleepLlm } = await import("../consolidate/sleep.ts");
      if (llmStageDue(db, idleMin)) {
        const ctrl = new AbortController();
        llmRun = ctrl;
        void sleepLlm(repo, { signal: ctrl.signal })
          .catch((e) => log.error("sen z LLM", e))
          .finally(() => {
            if (llmRun === ctrl) llmRun = null;
          });
      }
    }
    // kopia bazy: raz na everyHours, w bezczynności (VACUUM INTO nie blokuje zapisów hooków), w osobnym wątku
    const lastBackup = Number(getMeta(db, "last_backup_at") ?? 0);
    if (cfg.backup.enabled && idleMin > 10 && Date.now() - lastBackup > cfg.backup.everyHours * 3_600_000) {
      const { backupDbInThread, backupDir } = await import("../core/backup.ts");
      // ścieżki z wątku głównego (wątek kopii ma środowisko z chwili startu procesu)
      const opts = { keep: cfg.backup.keep, dbPath: paths.db(), dir: backupDir() };
      const r = await track("kopia (VACUUM INTO)", () => backupDbInThread(opts), { thread: true });
      setMeta(db, "last_backup_at", String(Date.now()));
      log.info("kopia bazy", { file: r.file, mb: Math.round(r.bytes / 1e6), ms: r.ms, usunięte: r.removed.length });
    }
    if (cfg.workerIdleExitMin > 0 && idleMin > cfg.workerIdleExitMin) {
      log.info("bezczynność: worker się wyłącza (hook podniesie go, gdy będzie potrzebny)");
      shutdown(0);
    }
  } catch (e) {
    log.error("tick", e);
  } finally {
    ticking = false;
  }
}, 5_000);

function shutdown(code: number): void {
  clearInterval(tick);
  // zegar wysyłki powiadomień wstrzymanej limitem (Stop w workerze): po zamknięciu bazy nie ma czego wysyłać
  disarmNotifyRetry();
  embedLoop.stop();
  embedder.dispose();
  try {
    server.stop(true);
  } catch {}
  try {
    db.close();
  } catch {}
  try {
    const lock = JSON.parse(readFileSync(paths.lock(), "utf8"));
    if (lock.pid === process.pid) unlinkSync(paths.lock());
  } catch {}
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (e) => log.error("uncaughtException", e));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
