// Powiadomienia o wybranych notatkach (opt-in, `notify.enabled`; odpowiednik CLAUDE_MEM_TELEGRAM_* bez usług
// zewnętrznych). Kandydaci to notatki z okna `maxAgeMin` (po dacie utworzenia), których nie ma w zbiorze zgłoszonych
// (`meta.notify_seen`: pary numer i data, przycinane do okna). Okno po dacie zamiast kursora po numerze: notatki
// z innych urządzeń (synchronizacja, numery z innego zakresu) nie przesuwają niczego ponad lokalne notatki.
// Wysyła proces odłączony (`src/notify/run.ts`), który podnosi hook Stop (proces hooka Buna) po zapisie tury, gdy
// w oknie są notatki do powiadomienia. Stop obsłużony w workerze (hook natywny) albo w serwerze MCP wysyła w procesie
// (`notifyInProcess`): bez procesów potomnych, więc tylko kanały file i webhook; powiadomienie wstrzymane limitem
// częstości dosyła jeden zegar (`armNotifyRetry`), także po przebiegu przerwanym błędem bazy albo blokadą innego procesu
// wysyłki (ponowienia z rosnącym odstępem, `retryStuck`). Notatki z nadrabiania i z `remember` czekają na następny Stop
// (albo `hipokamp notify run`).
// Limit częstości: odstęp `minIntervalSec` (proces czeka na okno najwyżej 15 min z zamkniętą bazą; inne procesy
// w tym czasie nie startują: blokada w pliku) i `maxPerHour` (po jego wyczerpaniu `meta.notify_next_at` mówi hookom,
// żeby do tej chwili nie podnosiły procesu); wszystko, co przyszło w międzyczasie, idzie jednym zbiorczym powiadomieniem.
// Notatki zajmujemy przed wysyłką (CAS na zbiorze zgłoszonych), więc dwa procesy nigdy nie wyślą tego samego.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clean } from "../capture/redact.ts";
import { type Config, loadConfig, type NotifyConfig, paths, refreshConfig } from "../config.ts";
import { casMeta, getMeta, setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { log } from "../log.ts";
import type { Observation } from "../types.ts";
import { oneLine, truncate } from "../util/text.ts";
import { CHANNELS, type ChannelFn } from "./channels.ts";

const SEEN = "notify_seen";
const SENT = "notify_sent";
const LAST = "notify_last";
const NEXT = "notify_next_at";
const HOUR = 3_600_000;
/** Dłużej proces nie czeka na okno limitu (większy odstęp: `notify_next_at`, notatki pójdą przy późniejszym hooku). */
const MAX_WAIT_MS = 15 * 60_000;
/** Blokada starsza niż to albo z martwym procesem jest porzucona. */
const LOCK_STALE_MS = 20 * 60_000;
/** Najwięcej kandydatów z okna (najnowsi) i najwięcej zapamiętanych zgłoszeń. */
const CANDIDATES = 1000;
const SEEN_MAX = 5000;
/**
 * Ponowienie przebiegu w procesie, który nie doszedł do końca (baza zablokowana, nieudany zapis) albo trafił na blokadę
 * innego procesu wysyłki: odstęp od 30 s, za każdym razem dwa razy dłuższy, najwyżej 10 min, najwyżej 6 prób (łącznie
 * ok. 25 min, dłużej niż proces z hooka czeka na okno limitu, MAX_WAIT_MS). Potem do następnego Stop.
 */
const STUCK_BASE_MS = 30_000;
const STUCK_CAP_MS = 10 * 60_000;
const STUCK_MAX = 6;

export interface NotifyItem {
  id: number;
  type: string;
  title: string;
  project: string;
  importance: number;
  created_at: number;
}

/**
 * Treść jednego (zbiorczego) powiadomienia: tytuł i tekst dla toastu, lista pozycji dla pliku, webhooka i polecenia
 * (najważniejsze, najwyżej `MAX_ITEMS`; `count` mówi, ile notatek objęło powiadomienie).
 */
export interface NotifyMessage {
  app: "hipokamp";
  at: number;
  title: string;
  text: string;
  count: number;
  items: NotifyItem[];
}

export interface NotifyResult {
  sent: boolean;
  count: number;
  delivered: string[];
  failed: { channel: string; error: string }[];
  reason?: string;
  /** Limit częstości: najwcześniejsza chwila następnej wysyłki. */
  retryAt?: number;
  /** Blokadę procesu wysyłki trzyma inny proces (nic nie zajęto ani nie wysłano). */
  busy?: boolean;
  message?: NotifyMessage;
}

export interface NotifyDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Atrapy kanałów w testach. */
  channels?: Partial<Record<string, ChannelFn>>;
  /** Pomija limit częstości (`hipokamp notify test`). */
  force?: boolean;
  /** Blokadę trzyma wywołujący (pętla procesu wysyłki). */
  lockHeld?: boolean;
  /**
   * Wysyłka z procesu workera (hook natywny obsługuje Stop w workerze): tylko kanały bez procesów potomnych
   * (`file`, `webhook`); `toast` i `command` czekają na proces hooka (zasada 2 w CLAUDE.md).
   */
  inProcess?: boolean;
  /** Pierwszy odstęp ponowienia po nieudanym przebiegu albo blokadzie innego procesu (testy; domyślnie STUCK_BASE_MS). */
  stuckRetryMs?: number;
}

/** Kanały, które doręcza się bez uruchamiania procesu (zapis do pliku, loopbackFetch): wolno je wołać z workera. */
export const IN_PROCESS_CHANNELS = ["file", "webhook"];

/**
 * Czy notatka powstała na tym urządzeniu. Synchronizacja (docs/SYNC.md) zachowuje `created_at`, więc notatka
 * odebrana w oknie `maxAgeMin` dałaby powiadomienie na każdym urządzeniu: przysłane z innego komputera (wpis w mapie
 * gid z cudzym pochodzeniem, Repo.isForeignObservation) pomijamy. Bez synchronizacji każda notatka jest lokalna.
 */
export function isLocalNote(repo: Repo, o: Observation): boolean {
  return !repo.isForeignObservation(o.id);
}

const TYPE_PL: Record<string, string> = {
  decision: "decyzja",
  gotcha: "pułapka",
  preference: "preferencja",
  bugfix: "poprawka",
  feature: "funkcja",
  refactor: "refaktor",
  change: "zmiana",
  discovery: "odkrycie",
  reference: "odnośnik",
};

export const typeLabel = (t: string) => TYPE_PL[t] ?? t;

/** 1 nowa notatka, 2-4 nowe notatki, 5+ nowych notatek (też 12-14 i 22-24 jak w polszczyźnie). */
export function notesWord(n: number): string {
  if (n === 1) return "nowa notatka";
  const d = n % 10;
  const t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? "nowe notatki" : "nowych notatek";
}

/** Najwięcej pozycji w `items` jednego powiadomienia (plik, webhook, polecenie); reszta tylko w `count`. */
export const MAX_ITEMS = 50;

/**
 * Pozycja powiadomienia. Każdy tekst z bazy przechodzi przez clean() przed wyjściem z procesu (plik, webhook,
 * polecenie, toast): notatka mogła zostać zapisana z sekretem, który zapis przepuścił (np. rozcięty znacznikiem
 * kodu i sklejony dopiero przy wyliczaniu tytułu). Tytuł czyszczony po `oneLine`, przed ucięciem.
 */
const itemOf = (o: Observation): NotifyItem => ({
  id: o.id,
  type: clean(o.type),
  title: truncate(clean(oneLine(o.title)), 200),
  project: clean(o.project),
  importance: o.importance,
  created_at: o.created_at,
});

/** Grupowanie: jedna notatka ma własny tytuł, kilka idzie listą najważniejszych z dopiskiem „i N więcej”. */
export function buildMessage(notes: Observation[], maxItems: number, at: number): NotifyMessage {
  const items = notes.map(itemOf).sort((a, b) => b.importance - a.importance || a.id - b.id);
  if (items.length === 1) {
    const o = items[0];
    return {
      app: "hipokamp",
      at,
      title: truncate(`hipokamp: ${typeLabel(o.type)} · ${o.project}`, 63),
      text: truncate(`#${o.id} ${o.title}`, 250),
      count: 1,
      items,
    };
  }
  const shown = items.slice(0, Math.max(1, maxItems));
  const lines = shown.map((o) => truncate(`• [${typeLabel(o.type)}] ${o.title} (${o.project})`, 110));
  if (items.length > shown.length) lines.push(`i ${items.length - shown.length} więcej`);
  return {
    app: "hipokamp",
    at,
    title: truncate(`hipokamp: ${items.length} ${notesWord(items.length)}`, 63),
    text: truncate(lines.join("\n"), 250),
    count: items.length,
    items: items.slice(0, MAX_ITEMS),
  };
}

// ---------------------------------------------------------------- blokada procesu wysyłki

const lockPath = () => join(paths.state(), "notify.lock");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Blokada trzymana przez żywy proces (świeża): inny proces wysyłki już czeka albo wysyła. */
export function notifyLockHeld(now = Date.now()): boolean {
  try {
    const l = JSON.parse(readFileSync(lockPath(), "utf8"));
    return now - Number(l.at) < LOCK_STALE_MS && alive(Number(l.pid));
  } catch {
    return false;
  }
}

function acquireLock(now: number): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: now }), { flag: "wx" });
      return true;
    } catch {
      if (notifyLockHeld(now)) return false;
      try {
        unlinkSync(lockPath());
      } catch {}
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    const l = JSON.parse(readFileSync(lockPath(), "utf8"));
    if (Number(l.pid) === process.pid) unlinkSync(lockPath());
  } catch {}
}

// ---------------------------------------------------------------- wybór notatek

type Seen = { raw: string | null; list: [number, number][] };

function seenOf(repo: Repo): Seen {
  const raw = getMeta(repo.db, SEEN);
  try {
    const v = JSON.parse(raw ?? "[]");
    const list = Array.isArray(v)
      ? v
          .filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]))
          .map((x) => [x[0], x[1]] as [number, number])
      : [];
    return { raw, list };
  } catch {
    return { raw, list: [] };
  }
}

/** Notatki z okna `maxAgeMin`, które zasługują na powiadomienie i nie były jeszcze zgłoszone (bez zmian w meta). */
export function pendingNotes(
  repo: Repo,
  cfg: NotifyConfig,
  now: number,
  limit = CANDIDATES,
): { fresh: Observation[]; seen: Seen; since: number } {
  const seen = seenOf(repo);
  const ids = new Set(seen.list.map((x) => x[0]));
  const since = now - cfg.maxAgeMin * 60_000;
  const projects = new Set(cfg.projects.map((p) => p.toLowerCase()));
  const fresh = repo
    .observationsCreatedSince(since, { types: cfg.types, sources: cfg.sources, minImportance: cfg.minImportance, limit })
    .filter((o) => !ids.has(o.id) && (!projects.size || projects.has(o.project.toLowerCase())) && isLocalNote(repo, o))
    .reverse();
  return { fresh, seen, since };
}

function sentTimes(repo: Repo, now: number): number[] {
  try {
    const v = JSON.parse(getMeta(repo.db, SENT) ?? "[]");
    return Array.isArray(v) ? v.map(Number).filter((t) => now - t < HOUR) : [];
  } catch {
    return [];
  }
}

/** Najwcześniejsza chwila, w której limit częstości pozwala wysłać (0: od razu). */
function allowedAt(repo: Repo, cfg: NotifyConfig, now: number): { at: number; hourly: boolean } {
  const sent = sentTimes(repo, now).sort((a, b) => a - b);
  const interval = sent.length ? sent[sent.length - 1] + cfg.minIntervalSec * 1000 : 0;
  const max = Math.max(1, cfg.maxPerHour);
  // wolne miejsce w godzinie pojawia się, gdy z okna wypadnie wysyłka numer (len - max + 1) od najstarszej
  const hour = sent.length >= max ? sent[sent.length - max] + HOUR : 0;
  return hour > interval ? { at: hour, hourly: true } : { at: interval, hourly: false };
}

// ---------------------------------------------------------------- wysyłka

async function deliver(
  msg: NotifyMessage,
  cfg: NotifyConfig,
  fns: Partial<Record<string, ChannelFn>>,
): Promise<Pick<NotifyResult, "delivered" | "failed">> {
  const delivered: string[] = [];
  const failed: { channel: string; error: string }[] = [];
  const one = async (ch: string): Promise<void> => {
    const fn = fns[ch];
    if (!fn) {
      failed.push({ channel: ch, error: "nieznany kanał" });
      return;
    }
    try {
      await fn(msg, cfg);
      delivered.push(ch);
    } catch (e: any) {
      failed.push({ channel: ch, error: truncate(String(e?.message ?? e), 200) });
    }
  };
  await Promise.all([...new Set(cfg.channels)].map(one));
  return { delivered, failed };
}

/**
 * Jeden przebieg: wybór, limit częstości, zajęcie notatek (CAS na zbiorze zgłoszonych) i wysyłka do wszystkich
 * kanałów. Bez czekania: przy limicie zwraca `retryAt`. Notatki zajęte przed wysyłką nie wracają, nawet gdy kanał
 * zawiedzie (błąd trafia do logu, bez pętli powtórek).
 */
export async function runNotify(
  repo: Repo,
  cfg: NotifyConfig = loadConfig().notify,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const clock = deps.now ?? Date.now;
  const res: NotifyResult = { sent: false, count: 0, delivered: [], failed: [] };
  if (!cfg?.enabled) return { ...res, reason: "powiadomienia wyłączone (notify.enabled)" };
  if (deps.inProcess) {
    const channels = cfg.channels.filter((c) => IN_PROCESS_CHANNELS.includes(c));
    if (!channels.length) return { ...res, reason: "brak kanałów bez procesów (file, webhook) dla wysyłki z workera" };
    cfg = { ...cfg, channels };
  }
  if (!deps.lockHeld && !acquireLock(clock()))
    return { ...res, busy: true, reason: "inny proces powiadomień już czeka albo wysyła" };
  try {
    const now = clock();
    const p = pendingNotes(repo, cfg, now);
    if (!p.fresh.length) return { ...res, reason: "brak nowych notatek do powiadomienia" };
    if (!deps.force) {
      const lim = allowedAt(repo, cfg, now);
      if (lim.at > now) {
        // proces wysyłki nie poczeka tak długo: hooki nie podnoszą nowego aż do tej chwili
        if (lim.at - now > MAX_WAIT_MS) setMeta(repo.db, NEXT, String(lim.at));
        const sec = Math.ceil((lim.at - now) / 1000);
        return {
          ...res,
          retryAt: lim.at,
          reason: lim.hourly
            ? `limit ${cfg.maxPerHour} powiadomień na godzinę: następna wysyłka za ${sec} s`
            : `limit częstości: następna wysyłka za ${sec} s`,
        };
      }
    }
    // zajęcie przed wysyłką: zbiór zmienia się tylko z wartości, którą widzieliśmy (przycięty do okna)
    const next = [...p.seen.list.filter(([, at]) => at >= p.since), ...p.fresh.map((o) => [o.id, o.created_at])].slice(-SEEN_MAX);
    if (!casMeta(repo.db, SEEN, p.seen.raw, JSON.stringify(next))) return { ...res, reason: "notatki zajął inny proces" };
    const msg = buildMessage(p.fresh, cfg.maxItems, now);
    Object.assign(res, await deliver(msg, cfg, { ...CHANNELS, ...deps.channels }));
    res.sent = res.delivered.length > 0;
    res.count = msg.count;
    res.message = msg;
    const sent = [...sentTimes(repo, now), now];
    setMeta(repo.db, SENT, JSON.stringify(sent));
    setMeta(repo.db, LAST, JSON.stringify({ at: now, count: msg.count, delivered: res.delivered, failed: res.failed }));
    const lim = allowedAt(repo, cfg, now);
    setMeta(repo.db, NEXT, String(lim.at - now > MAX_WAIT_MS ? lim.at : 0));
    if (res.failed.length) log.warn("powiadomienia: kanał zawiódł", res.failed);
    return res;
  } finally {
    if (!deps.lockHeld) releaseLock();
  }
}

/**
 * Pętla procesu wysyłki: blokada na cały czas życia procesu, baza otwierana tylko na czas przebiegu (`withRepo`),
 * czekanie na okno limitu z zamkniętą bazą (najwyżej 15 min; dłużej: koniec, hooki wiedzą z `notify_next_at`).
 */
export async function notifyLoop(
  withRepo: <T>(fn: (repo: Repo) => Promise<T>) => Promise<T>,
  cfg: NotifyConfig = loadConfig().notify,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  if (!cfg?.enabled)
    return { sent: false, count: 0, delivered: [], failed: [], reason: "powiadomienia wyłączone (notify.enabled)" };
  if (!acquireLock(clock()))
    return { sent: false, count: 0, delivered: [], failed: [], reason: "inny proces powiadomień już czeka albo wysyła" };
  try {
    const deadline = clock() + MAX_WAIT_MS;
    for (;;) {
      const r = await withRepo((repo) => runNotify(repo, cfg, { ...deps, lockHeld: true }));
      if (!r.retryAt || r.retryAt > deadline) return r;
      await sleep(Math.max(0, r.retryAt - clock()));
    }
  } finally {
    releaseLock();
  }
}

/** Wiadomość próbna przez skonfigurowane kanały (bez limitu częstości i bez zmian w zbiorze zgłoszonych). */
export async function testNotify(cfg: NotifyConfig = loadConfig().notify, deps: NotifyDeps = {}): Promise<NotifyResult> {
  const now = (deps.now ?? Date.now)();
  const msg: NotifyMessage = {
    app: "hipokamp",
    at: now,
    title: "hipokamp: próba powiadomienia",
    text: "Kanały działają. Tak wyglądają powiadomienia o nowych decyzjach, pułapkach i preferencjach.",
    count: 0,
    items: [],
  };
  const r = await deliver(msg, cfg, { ...CHANNELS, ...deps.channels });
  return { sent: r.delivered.length > 0, count: 0, ...r, message: msg };
}

export function notifyStatus(repo: Repo, cfg: Config = loadConfig()): string[] {
  const n = cfg.notify;
  const now = Date.now();
  const p = pendingNotes(repo, n, now);
  const next = Number(getMeta(repo.db, NEXT) ?? 0);
  let last: any = null;
  try {
    last = JSON.parse(getMeta(repo.db, LAST) ?? "null");
  } catch {}
  return [
    `powiadomienia: ${n.enabled ? "włączone" : "wyłączone (notify.enabled = false)"}`,
    `kanały: ${n.channels.join(", ") || "brak"}; typy: ${n.types.join(", ")}; ważność od ${n.minImportance}; źródła: ${n.sources.join(", ")}`,
    `limit: co najmniej ${n.minIntervalSec} s odstępu, ${n.maxPerHour} na godzinę; wysłane w ostatniej godzinie: ${sentTimes(repo, now).length}${next > now ? `; wstrzymane do ${new Date(next).toLocaleString("pl-PL")}` : ""}`,
    `czeka: ${p.fresh.length} z ostatnich ${n.maxAgeMin} min; zgłoszone w oknie: ${p.seen.list.filter(([, at]) => at >= p.since).length}`,
    last
      ? `ostatnio: ${new Date(last.at).toLocaleString("pl-PL")}, ${last.count} notatek, doręczone: ${(last.delivered ?? []).join(", ") || "nigdzie"}${last.failed?.length ? `, błędy: ${last.failed.map((f: any) => `${f.channel}: ${f.error}`).join("; ")}` : ""}`
      : "ostatnio: jeszcze nic nie wysłano",
  ];
}

// ---------------------------------------------------------------- start z hooka

export function notifyScript(): string {
  return join(import.meta.dir, "run.ts");
}

/**
 * Wywoływane przez hook Stop po zapisie tury: gdy powiadomienia są włączone, limit na godzinę nie wstrzymał wysyłki
 * (`notify_next_at`), nikt teraz nie wysyła, a w oknie są notatki do powiadomienia, podnosi odłączony proces wysyłki
 * (jak spawnWorker: bez okna, bez dziedziczenia stdio). Koszt przy włączonych powiadomieniach: dwa odczyty meta,
 * odczyt pliku blokady i jedno zapytanie po indeksie dat.
 */
// ---------------------------------------------------------------- wysyłka w procesie (worker, serwer MCP)

/** Trwający przebieg w tym procesie i prośba o kolejny (Stop przyszedł w trakcie wysyłki). */
let inProcessRun: Promise<NotifyResult | null> | null = null;
let inProcessAgain = false;
/** Jeden zegar na proces: najwcześniejszy termin wysyłki wstrzymanej limitem częstości. */
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDue: number | null = null;
/** Ile ponowień z rzędu po nieudanym przebiegu albo blokadzie innego procesu (zeruje każdy przebieg, który doszedł do końca). */
let stuck = 0;

/**
 * Przebieg nie doszedł do końca albo blokadę trzyma inny proces: zegar za STUCK_BASE_MS · 2^n. Bez tego powiadomienie
 * czekało do następnego Stop (proces z hooka, który trzyma blokadę, kończy się bez wysyłki, gdy okno limitu jest
 * dalej niż MAX_WAIT_MS), a po `maxAgeMin` wypadało z okna. Po STUCK_MAX próbach koniec (bez pętli przy trwałej awarii).
 */
function retryStuck(repo: Repo, deps: NotifyDeps, why: string): void {
  if (stuck >= STUCK_MAX) {
    log.warn(`powiadomienia: ${why}, ${STUCK_MAX} ponowień bez skutku, czekam na następny Stop`);
    stuck = 0;
    return;
  }
  const ms = Math.min(STUCK_CAP_MS, (deps.stuckRetryMs ?? STUCK_BASE_MS) * 2 ** stuck);
  stuck++;
  armNotifyRetry(repo, (deps.now ?? Date.now)() + ms, deps);
}

/**
 * Wysyłka w procesie, który nie uruchamia procesów potomnych (worker przy hooku natywnym, serwer MCP; zasada 2):
 * tylko kanały bez procesów (file, webhook), konfiguracja czytana z pliku w chwili wywołania (`refreshConfig`).
 * Wywołujący nie czeka (webhook do 5 s nie opóźnia odpowiedzi hooka); błąd trafia tylko do logu. Jeden przebieg naraz
 * w procesie: Stop w trakcie wysyłki zamawia kolejny przebieg po niej. Wynik z `retryAt` (limit częstości) nastawia
 * zegar, więc wstrzymane powiadomienie wychodzi bez kolejnego Stop.
 */
export function notifyInProcess(repo: Repo, deps: NotifyDeps = {}): Promise<NotifyResult | null> {
  if (inProcessRun) {
    inProcessAgain = true;
    return inProcessRun;
  }
  const run = (async (): Promise<NotifyResult | null> => {
    let r: NotifyResult | null = null;
    do {
      inProcessAgain = false;
      const cfg = refreshConfig().notify;
      if (!cfg?.enabled) {
        stuck = 0;
        return r;
      }
      try {
        r = await runNotify(repo, cfg, { ...deps, inProcess: true });
      } catch (e) {
        // baza zablokowana albo zapis się nie udał: notatki zajęte przed błędem już nie wrócą (CAS), reszta czeka
        log.error("powiadomienia (w procesie): przebieg przerwany", e);
        retryStuck(repo, deps, "przebieg przerwany błędem");
        return r;
      }
      if (r.busy) retryStuck(repo, deps, "blokada innego procesu wysyłki");
      else {
        stuck = 0;
        if (r.retryAt) armNotifyRetry(repo, r.retryAt, deps);
      }
    } while (inProcessAgain);
    return r;
  })()
    .catch((e) => {
      log.error("powiadomienia (w procesie)", e);
      return null;
    })
    .finally(() => {
      inProcessRun = null;
    });
  inProcessRun = run;
  return run;
}

/**
 * Nastawia zegar wysyłki w procesie na chwilę `at` (setTimeout z unref: nie trzyma procesu przy życiu, bez procesów
 * potomnych). Jeden zegar naraz: późniejszy albo ten sam termin niczego nie zmienia, wcześniejszy zastępuje czekający.
 * W chwili odpalenia `notifyInProcess` czyta config.json: wyłączone powiadomienia nic nie wysyłają.
 */
export function armNotifyRetry(repo: Repo, at: number, deps: NotifyDeps = {}): void {
  if (retryTimer && retryDue !== null && retryDue <= at) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryDue = at;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      retryDue = null;
      void notifyInProcess(repo, deps);
    },
    Math.max(0, at - (deps.now ?? Date.now)()),
  );
  retryTimer.unref?.();
}

/** Kasuje czekający zegar i licznik ponowień (zamykanie workera, testy). */
export function disarmNotifyRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDue = null;
  stuck = 0;
}

/** Termin czekającego zegara albo null (testy, diagnostyka). */
export function pendingNotifyRetry(): number | null {
  return retryTimer ? retryDue : null;
}

// ---------------------------------------------------------------- proces wysyłki z hooka Buna

export async function kickNotifier(repo: Repo, cfg: Config = loadConfig()): Promise<boolean> {
  if (!cfg.notify?.enabled) return false;
  const now = Date.now();
  if (Number(getMeta(repo.db, NEXT) ?? 0) > now || notifyLockHeld(now)) return false;
  if (!pendingNotes(repo, cfg.notify, now, 50).fresh.length) return false;
  try {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const bun = process.execPath && existsSync(process.execPath) ? process.execPath : "bun";
    const child = spawn(bun, [notifyScript()], {
      cwd: cfg.dataDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, HIPOKAMP_SPAWNED: "1" },
    });
    child.unref();
    return true;
  } catch (e) {
    log.warn("powiadomienia: nie udało się uruchomić procesu wysyłki", String(e));
    return false;
  }
}
