// HTTP API workera (127.0.0.1) + podgląd (viewer) + strumień SSE.
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { DATA_DIR, loadConfig } from "../config.ts";
import { remember } from "../core/remember.ts";
import { RECENT_STATUSES, type RecentStatus, type Repo, rowToSummary, type StatusChange } from "../db/repo.ts";
import { HOOK_EVENTS, MAX_FILES, recordPending, runHook } from "../hooks/handle.ts";
import { EmbedTimeoutError, type ThreadEmbedder } from "../index/embed-client.ts";
import type { TextEmbedder } from "../index/embedder.ts";
import { log } from "../log.ts";
import { fileContext, promptContext, sessionStartContext } from "../recall/context.ts";
import { promptProfile } from "../recall/profile.ts";
import { hybridSearch, loadHits } from "../recall/search.ts";
import { timeline } from "../recall/timeline.ts";
import { readAllWorkState, readWorkState } from "../recall/workstate.ts";
import { VERSION } from "../version.ts";
import {
  AUTH_PATH,
  ChallengeStore,
  H_CHALLENGE,
  H_NONCE,
  H_PROOF,
  loadKey,
  NONCE_RE,
  NONCE_TTL_MS,
  sign,
  verify,
} from "./auth.ts";
import type { EmbedLoop } from "./embedloop.ts";
import { begin, end, lagHealth, routeName, startLagMonitor } from "./lag.ts";
import { cookieHeaderOk, mintCookie, setCookieHeader, TicketStore, VIEWER_AUTH_PATH } from "./viewer-auth.ts";

export { VERSION };

/** Limit wektora zapytania w ścieżkach hooków: hook czeka na cały kontekst 1,6 do 1,8 s, a FTS i składanie to reszta. */
export const HOOK_EMBED_MS = 600;
/** Limit wektora zapytania w /api/search (MCP czeka na odpowiedź 15 s, potem sam szuka w FTS). */
const SEARCH_EMBED_MS = 8000;
/** Ważność liczników /api/stats (pełne przeglądy tabel). */
const STATS_TTL_MS = 5000;
let statsCache: { at: number; body: unknown } | null = null;

const VIEWER_DIR = join(import.meta.dir, "..", "..", "viewer");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// nagłówki obronne dla każdej odpowiedzi; CSP dla podglądu (frame-ancestors działa tylko w nagłówku, nie w <meta>)
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};
const VIEWER_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export interface ServerDeps {
  repo: Repo;
  /** Model w wątku embeddingów; null: wektory wyłączone w konfiguracji (embed.enabled = false), model się nie ładuje. */
  embedder: ThreadEmbedder | null;
  embedLoop: EmbedLoop;
  startedAt: number;
  onActivity: () => void;
  runSleep: () => Promise<unknown>;
  /** Plik klucza workera (`<dane>/state/worker.key`, T-17): czytany przy każdym wyzwaniu, odświeżany po zmianie pliku. */
  keyFile: string;
}

/**
 * Trasy tylko dla klientów z kluczem (T-17): zwracają treść, która idzie do kontekstu modelu (kontekst startu, promptu
 * i pliku, natywny hook), albo piszą do pamięci (`remember`, potwierdzenie wstrzyknięcia, wektor zapytania, budzenie).
 * Podgląd w przeglądarce klucza nie zna i z nich nie korzysta; jego trasy (odczyt, forget i restore, listy pracy,
 * sen, SSE) przyjmują klienta z kluczem albo ciasteczko podglądu (T-34, viewer-auth.ts), zawsze za kontrolą Host,
 * Origin, Sec-Fetch-Site i JSON.
 */
export const CLIENT_ONLY = (p: string) =>
  p.startsWith("/api/context/") ||
  p.startsWith("/api/hook/") ||
  p === "/api/embed" ||
  p === "/api/remember" ||
  p === "/api/notify";

/** Termin nonce'a workera: w testach krótszy (HIPOKAMP_AUTH_TTL_MS tylko w katalogu „hipokamp-test”). */
const authTtl = () => {
  const t = Number(process.env.HIPOKAMP_AUTH_TTL_MS);
  return DATA_DIR.includes("hipokamp-test") && t > 0 ? t : NONCE_TTL_MS;
};

/** Uwierzytelnione żądanie: klucz z chwili sprawdzenia i nonce'y do dowodu odpowiedzi. */
type Authed = { key: Buffer; nc: string; nw: string };

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

// Limit ciała żądania dla całego serwera (Bun domyślnie 128 MB, a req.json() czyta całość przed walidacją). Hook
// wysyła na /api/context/prompt cały prompt użytkownika, który bywa dużym wklejonym logiem, więc globalnie 8 MB;
// endpointy z małym ciałem sprawdzają content-length same (SMALL_BODY)
const MAX_BODY = 8 << 20;
const SMALL_BODY = 64 << 10;

const num = (v: string | null, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
/** Liczba z zapytania przycięta do [1, max]: ujemny limit dałby w SQLite LIMIT -1, czyli całą tabelę. */
const lim = (v: string | null, d: number, max: number) => Math.max(1, Math.min(max, Math.trunc(num(v, d))));
const ids = (v: string | null) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((x) => Number(x.replace(/^#/, "")))
    .filter((x) => Number.isFinite(x) && x > 0);

// --- SSE: nowe obserwacje i zmiany statusu (scalenie, archiwum, forget, przywrócenie) na żywo w podglądzie
/** Subskrypcje SSE; `valid`: czy dostęp, z którym otwarto strumień, nadal działa (ciasteczko podglądu wygasa, T-34). */
const subscribers = new Map<ReadableStreamDefaultController, { valid: () => boolean }>();
let lastBroadcastId = 0;
let lastStatusId = 0;

const sseMsg = (event: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Kursor strumienia „numer notatki-numer zmiany statusu”: przeglądarka pamięta tylko ostatnie id zdarzenia,
 * więc każde zdarzenie niesie oba liczniki. Sama liczba (starszy podgląd, since_id) to tylko licznik notatek.
 */
export const streamCursor = (obsId: number, statusId: number) => `${obsId}-${statusId}`;
export function parseStreamCursor(raw: string | null | undefined): { obs: number; status: number | null } {
  const m = /^(\d{1,15})(?:-(\d{1,15}))?$/.exec((raw ?? "").trim());
  return m ? { obs: Number(m[1]), status: m[2] != null ? Number(m[2]) : null } : { obs: 0, status: null };
}

/**
 * Zdarzenie `status`: sama zmiana z dziennika, bez treści notatki. Podgląd dociąga notatkę tylko wtedy, gdy ma ją
 * na ekranie, więc masowa zmiana (sen, repair) nie wozi przez strumień tysięcy pełnych notatek.
 */
const statusEvent = (c: StatusChange) => ({ seq: c.id, id: c.obs_id, from: c.from_status, status: c.to_status, at: c.at });

// Powyżej tylu zaległych zdarzeń zamiast nich idzie jedno `resync` (kursor na końcu, podgląd przeładowuje widok):
// strumień nie ciągnie masowej zmiany minutami i nie gubi jej reszty przy dosyłaniu
const LIVE_OBS = 50;
const LIVE_STATUS = 200;
const REPLAY_OBS = 200;
const REPLAY_STATUS = 500;

export function broadcast(event: string, data: unknown, id?: string): void {
  const msg = sseMsg(event, data, id);
  for (const c of subscribers.keys()) {
    try {
      c.enqueue(msg);
    } catch {
      subscribers.delete(c);
    }
  }
}

/** Nowe notatki i zmiany statusu od ostatniego wywołania (tick workera, /api/notify, zapis z podglądu). */
export function pollNewObservations(repo: Repo): void {
  if (!subscribers.size) {
    lastBroadcastId = repo.maxObservationId();
    lastStatusId = repo.maxStatusChangeId();
    return;
  }
  const ids = repo.observationIdsAfter(lastBroadcastId, LIVE_OBS + 1);
  const changes = repo.statusChangesSince(lastStatusId, LIVE_STATUS + 1);
  if (ids.length > LIVE_OBS || changes.length > LIVE_STATUS) {
    lastBroadcastId = Math.max(lastBroadcastId, repo.maxObservationId());
    lastStatusId = Math.max(lastStatusId, repo.maxStatusChangeId());
    const cursor = streamCursor(lastBroadcastId, lastStatusId);
    broadcast("resync", { cursor }, cursor);
    return;
  }
  if (ids.length) {
    lastBroadcastId = ids[ids.length - 1];
    for (const o of repo.getObservations(ids)) broadcast("observation", o, streamCursor(o.id, lastStatusId));
  }
  if (!changes.length) return;
  lastStatusId = changes[changes.length - 1].id;
  for (const c of changes) broadcast("status", statusEvent(c), streamCursor(lastBroadcastId, c.id));
}

/** Lista numerów notatek z body (liczby albo „#123”): null, gdy czegoś brakuje albo coś nie jest numerem. */
function idList(v: unknown): number[] | null {
  const raw = Array.isArray(v) ? v : v == null ? [] : [v];
  if (!raw.length || raw.length > 200) return null;
  const out: number[] = [];
  for (const x of raw) {
    const n =
      typeof x === "number"
        ? x
        : typeof x === "string" && /^#?\d{1,15}$/.test(x.trim())
          ? Number(x.trim().replace(/^#/, ""))
          : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ping co 30 s: połączenie nie wygasa na limicie bezczynności, a podgląd wykrywa martwy strumień. W testach krócej
// (HIPOKAMP_SSE_PING_MS tylko w katalogu „hipokamp-test”)
const pingMs = () => {
  const t = Number(process.env.HIPOKAMP_SSE_PING_MS);
  return DATA_DIR.includes("hipokamp-test") && t > 0 ? t : 30_000;
};
let pingTimer: ReturnType<typeof setInterval> | null = null;
function startPing(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    // strumień otwarty ciasteczkiem, które od tego czasu wygasło (albo zmienił się klucz), jest zamykany; podgląd
    // przy ponownym połączeniu dostaje 401 i pokazuje ekran wejścia
    for (const [c, s] of subscribers) {
      if (s.valid()) continue;
      subscribers.delete(c);
      try {
        c.close();
      } catch {}
    }
    if (subscribers.size) broadcast("ping", { t: Date.now() });
  }, pingMs());
  pingTimer.unref?.();
}

export function createServer(deps: ServerDeps) {
  const { repo, embedder } = deps;
  // opóźnienie pętli zdarzeń, trasy i zadania w tle: zajęty worker widać w /api/health, zanim zacznie gubić hooki
  startLagMonitor();
  const cfg = loadConfig();
  lastBroadcastId = repo.maxObservationId();
  lastStatusId = repo.maxStatusChangeId();

  /**
   * Model z limitem czasu na wektor zapytania: po limicie wyszukiwanie idzie na samym FTS, a `note()` mówi dlaczego
   * (pole `vectors` w odpowiedzi). Limit to jeden termin na całe żądanie, wspólny dla wszystkich wyszukiwań
   * (prompt szuka w projekcie i zaraz globalnie): po przekroczeniu kolejne wywołania nie czekają drugi raz, a trafienie
   * w pamięci podręcznej zapytań nadal przechodzi. `coldSkip`: zimny model ładuje się w tle, a żądanie idzie na FTS.
   */
  const limitedEmbedder = (ms: number, coldSkip: boolean): { emb: TextEmbedder | null; note: () => string | null } => {
    if (!embedder) return { emb: null, note: () => null };
    if (coldSkip && !embedder.loaded) {
      embedder.warm();
      return { emb: null, note: () => "model wektorów się ładuje: sam FTS" };
    }
    let timedOut = false;
    let deadline = 0;
    return {
      emb: {
        modelId: embedder.modelId,
        embed: (texts, kind) => {
          deadline ||= performance.now() + ms;
          const left = Math.max(1, Math.round(deadline - performance.now()));
          return embedder.embed(texts, kind, { timeoutMs: left }).catch((e) => {
            if (e instanceof EmbedTimeoutError) timedOut = true;
            throw e;
          });
        },
      },
      note: () => (timedOut ? `wektor zapytania nie zmieścił się w ${ms} ms: sam FTS` : null),
    };
  };
  /** Ścieżki hooków (hook czeka 1,6 do 1,8 s na cały kontekst): zimny model i limit wektora zapytania. */
  const ctxEmbedder = () => limitedEmbedder(HOOK_EMBED_MS, true);
  const challenges = new ChallengeStore(authTtl());
  const tickets = new TicketStore(deps.startedAt);

  async function route(req: Request, ctx: { auth: Authed | null }): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const q = url.searchParams;
    // tylko lokalne strony i klienci: obrona przed DNS rebinding i CSRF z przeglądarki
    const host = (req.headers.get("host") ?? "").toLowerCase();
    if (host !== `127.0.0.1:${cfg.port}` && host !== `localhost:${cfg.port}`) return bad("niedozwolony Host", 403);
    // Origin tylko z tego samego portu: inna lokalna strona (dev serwer, XSS w lokalnej aplikacji) nie pisze do pamięci
    const origin = req.headers.get("origin");
    if (
      origin &&
      origin.toLowerCase() !== `http://127.0.0.1:${cfg.port}` &&
      origin.toLowerCase() !== `http://localhost:${cfg.port}`
    )
      return bad("niedozwolony Origin", 403);
    if (p.startsWith("/api/")) {
      // <img>, <form> i fetch z obcej karty przeglądarki: Sec-Fetch-Site zdradza pochodzenie także bez Origin
      const site = req.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") return bad("żądanie z obcej strony", 403);
      // prosty POST (text/plain, bez preflightu) nie przejdzie: wymagamy JSON
      if (req.method === "POST" && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
        return bad("wymagany content-type: application/json", 415);
    }
    // otwarta karta podglądu (sam strumień) nie trzyma workera przy życiu; zapytania człowieka już tak
    // odświeżanie w tle (nagłówek x-hipokamp-bg z Dashboardu) też nie: inaczej karta zostawiona na drugim monitorze
    // nigdy nie pozwoliłaby workerowi zrobić snu, kopii ani samemu się wyłączyć
    if (p !== "/api/stream" && req.headers.get("x-hipokamp-bg") !== "1") deps.onActivity();

    // T-17, krok 1: dowód, że to worker z kluczem użytkownika, i jednorazowy nonce do kroku 2 (auth.ts)
    if (p === AUTH_PATH) {
      const nc = req.headers.get(H_CHALLENGE) ?? "";
      if (!NONCE_RE.test(nc)) return bad("wymagane wyzwanie: x-hipokamp-challenge (32 znaki hex)");
      // bez tworzenia i naprawy pliku w workerze: to robi klient (loadKey), a pętla zdarzeń nie czeka na dysk
      const key = loadKey(deps.keyFile, false);
      if (!key) return bad("brak klucza workera", 503);
      const nw = challenges.issue(nc);
      return json({ app: "hipokamp", auth: 1, nonce: nw, proof: sign(key, "worker", cfg.port, [nc, nw]) });
    }
    // krok 2: dowód klienta na jednorazowym nonce (zużyty także przy błędzie). Zły dowód to 401 na każdej trasie,
    // brak dowodu na trasach CLIENT_ONLY też; pozostałe /api/* przyjmują jeszcze ciasteczko podglądu (T-34, niżej)
    const nw = req.headers.get(H_NONCE);
    const proof = req.headers.get(H_PROOF);
    if (nw !== null || proof !== null) {
      const key = loadKey(deps.keyFile, false);
      const nc = nw ? challenges.take(nw) : null;
      if (!key || !nc || !verify(key, "client", cfg.port, [nw!, `${req.method} ${p}${url.search}`], proof))
        return bad("uwierzytelnienie: nonce nieznany, zużyty albo przeterminowany, albo zły dowód klienta", 401);
      ctx.auth = { key, nc, nw: nw! };
    } else if (CLIENT_ONLY(p)) return bad("ta trasa wymaga uwierzytelnienia klucza workera (x-hipokamp-proof)", 401);

    // T-34: jednorazowy bilet z `hipokamp open` na ciasteczko podglądu; zły, zużyty albo przeterminowany bilet
    // kończy się na stronie z instrukcją (/?auth=invalid), bez ciasteczka
    if (p === VIEWER_AUTH_PATH && req.method === "GET") {
      const key = loadKey(deps.keyFile, false);
      const ok = !!key && tickets.redeem(key, cfg.port, q.get("t"));
      const headers: Record<string, string> = { location: ok ? "/" : "/?auth=invalid", "cache-control": "no-store" };
      if (ok) headers["set-cookie"] = setCookieHeader(cfg.port, mintCookie(key!, cfg.port));
      return new Response(null, { status: 303, headers });
    }
    // każda trasa /api/* (odczyt, zapis, SSE) bez dowodu klienta wymaga ciasteczka podglądu; zapis z ciasteczkiem
    // dodatkowo nagłówka Origin tego podglądu (przeglądarka wysyła go przy każdym POST z fetch)
    if (p.startsWith("/api/") && !ctx.auth) {
      const key = loadKey(deps.keyFile, false);
      if (!key || !cookieHeaderOk(key, cfg.port, req.headers.get("cookie")))
        return bad("podgląd wymaga ciasteczka: otwórz go przez hipokamp open", 401);
      if (req.method !== "GET" && req.method !== "HEAD" && origin?.toLowerCase() !== `http://${host}`)
        return bad("zapis z podglądu wymaga nagłówka Origin", 403);
    }

    // podgląd sprawdza przy starcie, czy ma ciasteczko (401 wyżej = ekran z instrukcją `hipokamp open`)
    if (p === "/api/viewer") return json({ ok: true, via: ctx.auth ? "key" : "cookie" });

    if (p === "/api/health")
      return json({
        app: "hipokamp",
        ok: true,
        pid: process.pid,
        version: VERSION,
        uptimeS: Math.round((Date.now() - deps.startedAt) / 1000),
        embedder: embedder
          ? { loaded: embedder.loaded, device: embedder.device, model: embedder.modelId }
          : { loaded: false, device: "wyłączony", model: "" },
        embedded: deps.embedLoop.processed,
        /** zlecenia czekające w wątku embeddingów (zapytania mają pierwszeństwo przed wektorami notatek) */
        embedQueue: embedder?.queued ?? 0,
        /** wątki embeddingów wyłączone po zawieszeniach (do restartu workera): powód; puste, gdy wszystko działa */
        embedderDisabled: embedder?.disabled ?? {},
        ...lagHealth(),
        // ścieżka promptu: mediana i p95 etapów (embedding, FTS, wektory, ranking) z ostatnich 200 przypomnień
        promptPathMs: promptProfile(),
        pendingJobs: (repo.db.query("SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')").get() as { c: number })
          .c,
      });

    if (p === "/api/stats") {
      // liczniki to pełne przeglądy tabel (na 40 tys. notatek do ok. 0,4 s synchronicznie), a Dashboard i podgląd
      // pytają co kilka sekund: wynik żyje STATS_TTL_MS
      if (statsCache && performance.now() - statsCache.at < STATS_TTL_MS) return json(statsCache.body);
      const s = repo.stats();
      const byType = repo.db
        .query("SELECT type, COUNT(*) c FROM observations WHERE status='active' GROUP BY type ORDER BY c DESC")
        .all();
      const bySource = repo.db.query("SELECT source, COUNT(*) c FROM observations GROUP BY source ORDER BY c DESC").all();
      const inj = repo.db
        .query("SELECT channel, COUNT(*) n, SUM(tokens) t FROM injections WHERE at > ? GROUP BY channel")
        .all(Date.now() - 7 * 86_400_000);
      const used = repo.db
        .query(
          "SELECT COUNT(DISTINCT a.obs_id) n FROM access_log a JOIN injections i ON i.obs_id = a.obs_id AND i.session_id = a.session_id WHERE a.kind IN ('fetched','cited') AND a.at > ?",
        )
        .get(Date.now() - 7 * 86_400_000) as { n: number };
      const body = {
        ...s,
        byType,
        bySource,
        injections7d: inj,
        usedAfterInjection7d: used.n,
        missingVectors: repo.countMissingVectors(),
        llmCostUsd: 0,
      };
      statsCache = { at: performance.now(), body };
      return json(body);
    }

    if (p === "/api/projects")
      return json(
        repo.db
          .query(
            "SELECT project, COUNT(*) observations, MAX(created_at) last_at FROM observations WHERE status='active' GROUP BY project COLLATE NOCASE ORDER BY last_at DESC",
          )
          .all(),
      );

    if (p === "/api/search") {
      const query = q.get("q") ?? q.get("query") ?? "";
      if (!query.trim()) return bad("brak q");
      // MCP czeka na wynik 15 s: wektor zapytania najwyżej SEARCH_EMBED_MS, potem sam FTS (nagłówek x-hipokamp-vectors)
      const se = limitedEmbedder(SEARCH_EMBED_MS, false);
      const hits = await hybridSearch(repo, se.emb, query, {
        project: q.get("project") || null,
        // korpusy (MCP build_corpus) biorą duże pule; zwykłe wyszukiwanie najwyżej 300 jak w MCP search
        limit: lim(q.get("limit"), 20, q.get("corpus") === "1" ? 5000 : 300),
        types: q.get("type") ? q.get("type")!.split(",").filter(Boolean) : undefined,
        since: q.get("since") ? Date.parse(q.get("since")!) : undefined,
        until: q.get("until") ? Date.parse(q.get("until")!) : undefined,
        useVectors: q.get("vectors") !== "0",
        includeArchived: q.get("archived") === "1",
      });
      const rows = loadHits(repo, hits);
      if (q.get("session"))
        repo.logAccess(
          rows.slice(0, 5).map((r) => r.obs.id),
          "search_hit",
          q.get("session"),
        );
      const res = json(rows.map(({ hit, obs }) => ({ ...hit, observation: obs })));
      const note = se.note();
      if (note) res.headers.set("x-hipokamp-vectors", encodeURIComponent(note));
      return res;
    }

    if (p === "/api/observations") {
      const list = ids(q.get("ids"));
      const obs = repo.getObservations(list);
      if (q.get("session") || q.get("fetch") === "1")
        repo.logAccess(
          obs.map((o) => o.id),
          "fetched",
          q.get("session"),
        );
      return json(obs);
    }

    const m1 = p.match(/^\/api\/observation\/(\d+)$/);
    if (m1) {
      const o = repo.getObservation(Number(m1[1]));
      return o ? json(o) : bad("nie ma takiej obserwacji", 404);
    }

    if (p === "/api/recent") {
      const before = q.get("before") ? Number(q.get("before")) : undefined;
      // status=archived,superseded: archiwum podglądu (zapomniane, odłożone przez sen, zastąpione); scalone nie
      const status = (q.get("status") || "active").split(",").map((s) => s.trim());
      if (!status.every((s): s is RecentStatus => (RECENT_STATUSES as readonly string[]).includes(s)))
        return bad("status: active, archived albo superseded (lista po przecinku)");
      return json(
        repo.recentObservations(q.get("project") || null, lim(q.get("limit"), 50, 200), {
          before,
          beforeId: q.get("before_id") ? Number(q.get("before_id")) : undefined,
          types: q.get("type")?.split(",").filter(Boolean),
          status,
        }),
      );
    }

    // zapomnij i przywróć z podglądu: miękko (status archived), numery #id zostają; przywrócenie z archiwum
    // i zastąpionych (scalone nie)
    if ((p === "/api/forget" || p === "/api/restore") && req.method === "POST") {
      // 200 numerów i powód do 300 znaków to setki bajtów: większe ciało odrzucamy przed czytaniem
      if (Number(req.headers.get("content-length") ?? 0) > SMALL_BODY) return bad("za duże żądanie", 413);
      let b: any;
      try {
        b = await req.json();
      } catch {
        return bad("zły JSON");
      }
      const list = idList(b?.ids);
      if (!list) return bad("wymagane: ids (od 1 do 200 numerów notatek)");
      if (b.reason != null && typeof b.reason !== "string") return bad("reason musi być tekstem");
      const changed = p === "/api/forget" ? repo.forgetObservations(list, b.reason) : repo.restoreObservations(list);
      // zdarzenie status dla wszystkich kart podglądu od razu, nie przy najbliższym ticku workera
      if (changed.length) setTimeout(() => pollNewObservations(repo), 20);
      return json({ changed, observations: repo.getObservations(list) });
    }

    if (p === "/api/timeline") {
      let anchor = q.get("anchor") ? Number(q.get("anchor")!.replace(/^#/, "")) : null;
      if (!anchor && q.get("q")) {
        const [h] = await hybridSearch(repo, embedder, q.get("q")!, { project: q.get("project") || null, limit: 1 });
        anchor = h?.id ?? null;
      }
      return json(
        timeline(repo, {
          anchor,
          project: q.get("project") || null,
          before: num(q.get("before"), 6),
          after: num(q.get("after"), 6),
        }),
      );
    }

    if (p === "/api/sessions") return json(repo.recentSessions(q.get("project") || null, lim(q.get("limit"), 30, 200)));

    const m2 = p.match(/^\/api\/session\/([\w-]+)$/);
    if (m2) {
      const s = repo.getSession(m2[1]);
      if (!s) return bad("nie ma takiej sesji", 404);
      const row = repo.db.query("SELECT * FROM summaries WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(m2[1]);
      return json({ session: s, observations: repo.sessionObservations(m2[1]), summary: row ? rowToSummary(row) : null });
    }

    if (p === "/api/summaries") return json(repo.recentSummaries(q.get("project") || null, lim(q.get("limit"), 20, 100)));

    if (p === "/api/context/start") {
      const project = q.get("project");
      if (!project) return bad("brak project");
      const sessionId = q.get("session") || null;
      if (sessionId) repo.upsertSession({ id: sessionId, project, cwd: q.get("cwd") || null, started_at: Date.now() });
      const ce = ctxEmbedder();
      const r = await sessionStartContext(repo, ce.emb, {
        project,
        sessionId,
        cwd: q.get("cwd") || null,
        budget: q.get("budget") ? Number(q.get("budget")) : undefined,
        // record=0: wstrzyknięcia zapisuje hook, dopiero gdy dostał odpowiedź (porzucone żądanie niczego nie zapisuje)
        record: q.get("record") !== "0",
      });
      const note = ce.note();
      return json(note ? { ...r, vectors: note } : r);
    }

    if (p === "/api/context/prompt" && req.method === "POST") {
      const b = (await req.json()) as any;
      const ce = ctxEmbedder();
      const r = await promptContext(repo, ce.emb, {
        project: b.project,
        sessionId: b.session,
        prompt: String(b.prompt ?? ""),
        cwd: b.cwd,
        preview: b.preview === true,
        record: b.record !== false,
      });
      const note = ce.note();
      return json({ ...(r ?? { text: null }), ...(note ? { vectors: note } : {}) });
    }

    if (p === "/api/context/file" && req.method === "POST") {
      const b = (await req.json()) as any;
      return json(
        fileContext(repo, { project: b.project, sessionId: b.session, filePath: b.file, cwd: b.cwd }) ?? { text: null },
      );
    }

    // natywny hook (hooks.mode = native): ta sama logika co hook Buna (handle.ts), liczona tutaj, bez nowego procesu
    const mh = p.match(/^\/api\/hook\/([a-z-]+)$/);
    if (mh && req.method === "POST") {
      let b: any;
      try {
        b = await req.json();
      } catch {
        return bad("zły JSON");
      }
      if (mh[1] === "ack") {
        // wstrzyknięcie dotarło do modelu: hook potwierdza je po wypisaniu wyniku (porzucone żądanie niczego nie zapisuje)
        const files: unknown = b?.files ?? [];
        const ok =
          typeof b?.session === "string" &&
          b.session !== "" &&
          (b.channel === "start" || b.channel === "prompt" || b.channel === "file") &&
          Array.isArray(b.ids) &&
          b.ids.length <= 200 &&
          b.ids.every((x: unknown) => Number.isInteger(x)) &&
          Array.isArray(files) &&
          files.length <= MAX_FILES &&
          files.every((x) => typeof x === "string" && x.length > 0 && x.length <= 4096) &&
          // kanał pliku zawsze z kluczem pliku (przypomnienie raz na sesję), pozostałe bez
          (b.channel === "file") === files.length > 0;
        if (!ok) return bad("złe potwierdzenie");
        const costs = b.costs && typeof b.costs === "object" && !Array.isArray(b.costs) ? b.costs : {};
        recordPending(repo, { session: b.session, channel: b.channel, ids: b.ids, costs, files: files as string[] });
        return json({ ok: true });
      }
      if (!(HOOK_EVENTS as readonly string[]).includes(mh[1])) return bad("nieznane zdarzenie", 404);
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      return json(
        await runHook(mh[1], b?.input ?? {}, {
          repo,
          codex: b?.codex === true,
          projectDir: str(b?.projectDir),
          cwd: str(b?.cwd),
          strict: true,
          inWorker: {
            embedder: ctxEmbedder().emb,
            notify: () => {
              deps.embedLoop.notify();
              setTimeout(() => pollNewObservations(repo), 50);
            },
          },
        }),
      );
    }

    if (p === "/api/notify" && req.method === "POST") {
      deps.embedLoop.notify();
      setTimeout(() => pollNewObservations(repo), 50);
      return json({ ok: true });
    }

    // wektor zapytania dla klientów bez modelu (MCP: korpusy); model ładuje się tylko tutaj, raz na maszynę
    if (p === "/api/embed" && req.method === "POST") {
      const b = (await req.json()) as any;
      const text = String(b.text ?? "").slice(0, 4000);
      if (!text.trim()) return bad("brak text");
      if (!embedder) return bad("wektory wyłączone w konfiguracji", 503);
      const [v] = await embedder.embed([text], b.kind === "passage" ? "passage" : "query");
      return json({ model: embedder.modelId, dims: v.length, vector: Array.from(v, (x) => Math.round(x * 1e5) / 1e5) });
    }

    // zbiorcze TODO podglądu: listy pracy ze wszystkich projektów
    if (p === "/api/work-state/all") return json(readAllWorkState(repo, q.get("closed") === "1"));

    // aktywność dzień po dniu (notatki i sesje) do wykresu na Dashboardzie
    if (p === "/api/activity") return json(repo.activityByDay(lim(q.get("days"), 14, 90)));

    if (p === "/api/work-state") {
      if (req.method === "POST") {
        const b = (await req.json()) as any;
        if (!b.project || !b.list || !b.fields) return bad("wymagane: project, list, fields");
        const id = repo.appendWorkState(b.project, b.list, b.fields);
        return json({ ok: true, id });
      }
      const project = q.get("project");
      if (!project) return bad("brak project");
      return json(readWorkState(repo, project, q.get("closed") === "1"));
    }

    if (p === "/api/remember" && req.method === "POST") {
      const b = (await req.json()) as any;
      const r = remember(repo, b);
      deps.embedLoop.notify();
      setTimeout(() => pollNewObservations(repo), 20);
      return json(r);
    }

    if (p === "/api/admin/sleep" && req.method === "POST") return json(await deps.runSleep());

    if (p === "/api/stream") {
      startPing();
      server?.timeout(req, 0);
      // wznowienie: dosyłamy to, co przeleciało w przerwie. Last-Event-ID (sama przeglądarka) albo since (podgląd
      // przy nowym połączeniu); since_id to dawny kursor samych notatek. Dosyłka sięga do kursora rozgłoszeń,
      // resztę przyniesie najbliższe rozgłoszenie (bez dubli)
      const cur = parseStreamCursor(req.headers.get("last-event-id") ?? q.get("since") ?? q.get("since_id"));
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          // klient z kluczem: strumień bez terminu; ciasteczko: sprawdzane przy każdym pingu (klucz czytany od nowa)
          const cookie = req.headers.get("cookie");
          subscribers.set(c, {
            valid: ctx.auth
              ? () => true
              : () => {
                  const key = loadKey(deps.keyFile, false);
                  return !!key && cookieHeaderOk(key, cfg.port, cookie);
                },
          });
          const now = streamCursor(lastBroadcastId, lastStatusId);
          c.enqueue(sseMsg("hello", { version: VERSION, cursor: now }));
          const obsIds = cur.obs > 0 ? repo.observationIdsAfter(cur.obs, REPLAY_OBS + 1, lastBroadcastId) : [];
          const changes = cur.status != null ? repo.statusChangesSince(cur.status, REPLAY_STATUS + 1, lastStatusId) : [];
          // przerwa za długa na dosłanie po jednym: jedno resync, kursor od razu na końcu
          if (obsIds.length > REPLAY_OBS || changes.length > REPLAY_STATUS) {
            c.enqueue(sseMsg("resync", { cursor: now }, now));
            return;
          }
          let obsAt = cur.obs > 0 ? cur.obs : lastBroadcastId;
          const statusAt = cur.status ?? lastStatusId;
          for (const o of repo.getObservations(obsIds)) {
            obsAt = o.id;
            c.enqueue(sseMsg("observation", o, streamCursor(obsAt, statusAt)));
          }
          for (const ch of changes) c.enqueue(sseMsg("status", statusEvent(ch), streamCursor(obsAt, ch.id)));
        },
        cancel() {
          subscribers.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
      });
    }

    // podgląd (statyczne pliki)
    if (req.method === "GET" && !p.startsWith("/api/")) {
      const rel = p === "/" ? "index.html" : p.slice(1);
      const file = normalize(join(VIEWER_DIR, rel));
      if (!file.startsWith(normalize(VIEWER_DIR))) return bad("zła ścieżka", 403);
      if (existsSync(file)) {
        const type = MIME[extname(file)] ?? "application/octet-stream";
        return new Response(readFileSync(file), {
          headers: {
            "content-type": type,
            "cache-control": "no-cache",
            ...(type.startsWith("text/html") ? { "content-security-policy": VIEWER_CSP } : {}),
          },
        });
      }
      return bad("nie znaleziono", 404);
    }
    return bad("nieznany endpoint", 404);
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 120,
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      let res: Response;
      const t = begin("trasa", routeName(req.method, new URL(req.url).pathname));
      const ctx: { auth: Authed | null } = { auth: null };
      try {
        res = await route(req, ctx);
      } catch (e) {
        log.error("api", { url: req.url, e: String(e) });
        res = bad(String(e), 500);
      } finally {
        end(t);
      }
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      // T-17, krok 3: dowód odpowiedzi na nonce'ach tego żądania; klient bez niego odrzuca wynik
      const a = ctx.auth;
      if (a) res.headers.set(H_PROOF, sign(a.key, "response", cfg.port, [a.nc, a.nw, String(res.status)]));
      return res;
    },
  });
  return server;
}
