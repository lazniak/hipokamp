#!/usr/bin/env bun
// Hub synchronizacji hipokampa: osobny proces Buna na własnym serwerze, za proxy HTTPS. Trzyma tylko dziennik
// zaszyfrowanych wpisów i listę urządzeń; treści nie zna (klucz grupy nigdy tu nie trafia). Jedna instancja = jedna
// grupa urządzeń. Zależy tylko od protocol.ts, więc obraz Dockera kopiuje dwa pliki (server/Dockerfile).
//
// Uruchomienie: `bun src/sync/server.ts`, konfiguracja w zmiennych środowiskowych (opisane w startFromEnv).
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  B64_RE,
  B64URL_RE,
  type DeviceInfo,
  ENTRY_ID_RE,
  ENTRY_VERSION,
  HEX64_RE,
  INVITE_HEADER,
  INVITE_RE,
  JOIN_ID_RE,
  KID_RE,
  LIMITS,
  MAC_RE,
  NAME_RE,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type PulledEntry,
  type Role,
  safeEqualHex,
  sha256hex,
  TOKEN_RE,
  tokenHash,
  validDevice,
  type WireEntry,
} from "./protocol.ts";

export interface HubOptions {
  dbPath: string;
  /** Adres nasłuchu: domyślnie 127.0.0.1 (w kontenerze 0.0.0.0, a port publikowany tylko na 127.0.0.1 hosta). */
  host?: string;
  /** 0 = wolny port (testy). */
  port?: number;
  /** Dozwolone nagłówki Host z zewnątrz (np. hub.example.com). Lokalne 127.0.0.1:port i localhost:port zawsze. */
  publicHosts?: string[];
  /** Żądania z publicznym Host muszą przyjść przez HTTPS (proxy ustawia x-forwarded-proto). */
  requireHttps?: boolean;
  /** SHA-256 (hex) sekretu bootstrapu; bez niego `sync init` jest wyłączony. */
  bootstrapSha256?: string | null;
  /**
   * Adres klienta z nagłówka X-Real-IP (ustawia go nginx z $remote_addr). Nagłówek liczy się tylko wtedy, gdy samo
   * połączenie przychodzi od proxy: z adresu loopback albo prywatnego (nginx na hoście przez bramę Dockera) albo
   * z `trustedProxies`; klient z internetu, który połączy się z hubem bezpośrednio, nie poda dowolnego adresu.
   * Bez tej opcji limity per IP liczą adres połączenia (w kontenerze to brama Dockera).
   */
  trustProxy?: boolean;
  /** Dodatkowe adresy proxy (dokładne), którym wolno ustawić X-Real-IP. */
  trustedProxies?: string[];
  /**
   * Znacznik przywrócenia bazy huba z kopii (HIPOKAMP_SYNC_RESTORED, np. data przywrócenia). Inny niż zapisany w bazie:
   * hub zaczyna od trybu odzyskiwania (zatwierdzanie urządzeń wstrzymane do `sync resync` każdego admina i jawnego
   * potwierdzenia, docs/SYNC.md, sekcja 9).
   */
  restoredMark?: string | null;
  limits?: Partial<typeof LIMITS>;
  now?: () => number;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

export interface Hub {
  port: number;
  url: string;
  db: Database;
  stop: () => void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS devices (
    no INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    dev INTEGER NOT NULL,
    kid TEXT NOT NULL,
    v INTEGER NOT NULL,
    size INTEGER NOT NULL,
    at INTEGER NOT NULL,
    ct BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS joins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    pubkey TEXT NOT NULL,
    proof TEXT NOT NULL,
    min_device INTEGER NOT NULL DEFAULT 2,
    ip TEXT NOT NULL,
    invited INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    device_no INTEGER,
    role TEXT,
    sealed TEXT,
    mac TEXT
  );
  CREATE TABLE IF NOT EXISTS invites (
    hash TEXT PRIMARY KEY,
    by_device INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recovery_reports (
    no INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    max_device INTEGER NOT NULL
  );
`;

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Kubełek żetonów: `size` żądań na okres `periodMs`, tyle samo w zapasie. */
class Bucket {
  private tokens: number;
  at: number;
  constructor(
    private readonly size: number,
    private readonly periodMs: number,
    now: number,
  ) {
    this.tokens = size;
    this.at = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.size, this.tokens + ((now - this.at) * this.size) / this.periodMs);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Adres IPv6 w pełnej postaci (8 grup po 4 cyfry hex) albo null; IPv4 w IPv6 (::ffff:1.2.3.4) zwraca jako IPv4. */
function expand6(a: string): string[] | null {
  const s = a.toLowerCase().replace(/%.*$/, "");
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  let head = s;
  let tail: string[] = [];
  if (v4) {
    const p = v4[2].split(".").map(Number);
    head = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
    tail = [((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16)];
  }
  const parts = head.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = 8 - left.length - right.length - tail.length;
  if (fill < 0 || (parts.length === 1 && fill !== 0)) return null;
  const all = [...left, ...Array(parts.length === 2 ? fill : 0).fill("0"), ...right, ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => g.padStart(4, "0"));
}

/**
 * Klucz adresu do limitów: IPv4 jak jest, IPv6 po podsieci /64 (typowy przydział jednego klienta: inaczej zalew
 * z jednej podsieci liczyłby się jak miliony adresów), IPv4 w IPv6 jako IPv4.
 */
export function ipKey(addr: string): string {
  if (V4_RE.test(addr)) return addr;
  const g = expand6(addr);
  if (!g) return addr;
  if (g.slice(0, 5).every((x) => x === "0000") && g[5] === "ffff")
    return [g[6].slice(0, 2), g[6].slice(2), g[7].slice(0, 2), g[7].slice(2)].map((h) => Number.parseInt(h, 16)).join(".");
  return `${g.slice(0, 4).join(":")}::/64`;
}

/** Adres loopback albo prywatny (nginx na tym samym hoście, brama Dockera): tylko od niego X-Real-IP coś znaczy. */
export function isLocalAddr(addr: string): boolean {
  const k = ipKey(addr);
  const m = V4_RE.exec(k);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const g = expand6(addr);
  if (!g) return false;
  if (g.join(":") === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  const first = Number.parseInt(g[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7 (ULA), fe80::/10
}

interface DeviceRow {
  no: number;
  name: string;
  role: Role;
  token_hash: string;
  status: "active" | "revoked";
}

export function openHubDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, readwrite: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

export function startHub(opts: HubOptions): Hub {
  const L = { ...LIMITS, ...(opts.limits ?? {}) };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const db = openHubDb(opts.dbPath);
  const publicHosts = new Set((opts.publicHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  // kubełki limitów: mapa w kolejności ostatniego użycia (użyty kubełek idzie na koniec), więc przy zalewie wypada
  // najdawniej używany w O(1), a pamięć huba ma stały sufit
  const buckets = new Map<string, Bucket>();
  const take = (key: string, size: number, periodMs = 60_000) => {
    let b = buckets.get(key);
    if (b) buckets.delete(key);
    else {
      b = new Bucket(size, periodMs, now());
      while (buckets.size >= L.maxBuckets) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    buckets.set(key, b);
    return b.take(now());
  };
  const limit = (key: string, size: number, periodMs = 60_000) => {
    if (!take(key, size, periodMs)) throw new HttpError(429, "za dużo żądań");
  };
  const meta = (k: string) => (db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
  const setMeta = (k: string, v: string) =>
    db.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]);
  // sól skrótu adresu IP (losowa dla huba, trwała: limity oczekujących próśb przeżywają restart); bez niej skrót
  // adresu IPv4 dałoby się odwrócić, sprawdzając wszystkie 2^32 adresy
  if (!meta("ip_salt")) setMeta("ip_salt", randomBytes(16).toString("base64url"));
  const ipSalt = meta("ip_salt") ?? "";
  const trusted = new Set((opts.trustedProxies ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean));
  /**
   * Najwyższy numer urządzenia, jaki hub kiedykolwiek wydał albo o jakim usłyszał od klientów (`max_device`): nowy
   * numer musi być od niego większy, więc hub przywrócony z kopii nie wyda drugi raz numeru, który zna grupa.
   */
  const deviceFloor = (): number =>
    Math.max(
      (db.query("SELECT COALESCE(MAX(no), 0) m FROM devices").get() as { m: number }).m,
      (db.query("SELECT COALESCE(MAX(seq), 0) m FROM sqlite_sequence WHERE name = 'devices'").get() as { m: number }).m,
      Number(meta("max_device") ?? 0) || 0,
    );
  const maxListed = (): number => (db.query("SELECT COALESCE(MAX(no), 0) m FROM devices").get() as { m: number }).m;

  /**
   * Tryb odzyskiwania po przywróceniu huba z kopii. Kopia nie zna urządzeń dołączonych po jej dacie, a najwyższy numer
   * urządzenia, jaki wydano, zna tylko admin, który je zatwierdził (może być ich kilku, a któryś może być nieznany
   * kopii). Dopóki tryb trwa, zatwierdzanie czeka, aż każdy aktywny admin z listy huba zrobi `sync resync` (podnosi
   * licznik do znanego sobie numeru) i aż admin jawnie potwierdzi (`--ack-lost-devices`), że urządzenia, których hub
   * nie zna, złożyły już prośby (ich `min_device` mówi, jakie numery znają). Wejście: pierwszy `sync resync` admina
   * albo znacznik przywrócenia przy starcie (`restoredMark`); wyjście: zatwierdzenie z potwierdzeniem.
   */
  const recoverySince = (): number => Number(meta("recovery_since") ?? 0) || 0;
  const startRecovery = (why: string, by?: number) => {
    db.transaction(() => {
      setMeta("recovery_since", String(now()));
      db.run("DELETE FROM recovery_reports");
    }).immediate();
    log("recovery", { why, ...(by ? { by } : {}) });
  };
  if (opts.restoredMark && meta("restored_mark") !== opts.restoredMark) {
    setMeta("restored_mark", opts.restoredMark);
    startRecovery("restored");
  }
  let totalBytes = (db.query("SELECT COALESCE(SUM(size), 0) s FROM entries").get() as { s: number }).s;
  let port = 0;

  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: SECURITY_HEADERS });

  async function body<T>(req: Request): Promise<T> {
    try {
      return (await req.json()) as T;
    } catch {
      throw new HttpError(400, "ciało żądania to nie JSON");
    }
  }

  function bearer(req: Request): string | null {
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/);
    return m ? m[1] : null;
  }

  /**
   * Urządzenie z klucza dostępu. Żądanie bez klucza albo z nieznanym kluczem liczy się do limitu bez klucza z adresu
   * IP (`a:`): zalew zgadywanymi kluczami nie dostaje nieograniczonej liczby odpowiedzi.
   */
  function device(req: Request, ip: string): DeviceRow {
    const t = bearer(req);
    if (!t || !TOKEN_RE.test(t)) {
      limit(`a:${ip}`, L.anonRatePerMin);
      throw new HttpError(401, "brak klucza urządzenia");
    }
    const d = db
      .query("SELECT no, name, role, token_hash, status FROM devices WHERE token_hash = ?")
      .get(tokenHash(t)) as DeviceRow | null;
    if (d?.status !== "active") {
      limit(`a:${ip}`, L.anonRatePerMin);
      if (!d) throw new HttpError(401, "nieznany klucz urządzenia");
      throw new HttpError(403, "urządzenie odcięte", { revoked: true });
    }
    limit(`d${d.no}`, L.ratePerMin);
    db.run("UPDATE devices SET last_seen_at = ? WHERE no = ?", [now(), d.no]);
    return d;
  }

  const admin = (req: Request, ip: string): DeviceRow => {
    const d = device(req, ip);
    if (d.role !== "admin") throw new HttpError(403, "potrzebne urządzenie z rolą admin");
    return d;
  };

  /**
   * Wygasłe prośby i zaproszenia znikają (oczekujące po 15 minutach, zatwierdzone nieodebrane też). Sprząta minutnik
   * i dodanie prośby; odczyt prośby tylko pomija wygasłe (żądanie bez klucza nie pisze do bazy).
   */
  const expireJoins = () => {
    db.run("DELETE FROM joins WHERE expires_at < ?", [now()]);
    db.run("DELETE FROM invites WHERE expires_at < ?", [now()]);
  };
  const sweeper = setInterval(() => {
    try {
      expireJoins();
    } catch {}
  }, 60_000);
  sweeper.unref?.();
  /** Oczekujące prośby bez zaproszenia (łącznie albo z jednego adresu); prośby z zaproszeniem mają własną pulę. */
  const pendingCount = (ip?: string) =>
    (
      db
        .query(`SELECT COUNT(*) c FROM joins WHERE status = 'pending' AND invited = 0${ip ? " AND ip = ?" : ""}`)
        .get(...(ip ? [ip] : [])) as {
        c: number;
      }
    ).c;

  async function route(req: Request, srv: { requestIP(r: Request): { address: string } | null }): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    // Host: tylko adres publiczny z konfiguracji albo lokalny (healthcheck w kontenerze). Obrona przed DNS rebinding.
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const local = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (!local && !publicHosts.has(host)) throw new HttpError(421, "niedozwolony Host");
    if (!local && opts.requireHttps && (req.headers.get("x-forwarded-proto") ?? "").toLowerCase() !== "https")
      throw new HttpError(403, "tylko przez HTTPS");
    // przeglądarka nie ma tu czego szukać: żądanie z Origin (strona WWW) odrzucamy bez wyjątków
    if (req.headers.get("origin")) throw new HttpError(403, "żądania z przeglądarki są wyłączone");
    // adres klienta do limitów bez klucza: X-Real-IP tylko od proxy (połączenie z adresu lokalnego albo zaufanego),
    // IPv6 po podsieci /64; w bazie tylko skrót z solą huba
    const peer = srv.requestIP(req)?.address ?? "?";
    const real = (req.headers.get("x-real-ip") ?? "").trim();
    const viaProxy = !!opts.trustProxy && IP_RE.test(real) && (isLocalAddr(peer) || trusted.has(peer.toLowerCase()));
    const ip = sha256hex(`hipokamp-sync-ip\u0001${ipSalt}\u0001${ipKey(viaProxy ? real : peer)}`).slice(0, 16);

    if (p === "/v1/health" && req.method === "GET") {
      limit(`h:${ip}`, L.anonRatePerMin);
      return json({ app: "hipokamp-sync", ok: true, protocol: PROTOCOL_VERSION });
    }
    if (!p.startsWith("/v1/")) throw new HttpError(404, "nieznany endpoint");
    const ver = req.headers.get(PROTOCOL_HEADER);
    if (ver !== String(PROTOCOL_VERSION))
      throw new HttpError(426, `nieobsługiwana wersja protokołu (${ver ?? "brak"}), serwer: ${PROTOCOL_VERSION}`, {
        protocol: PROTOCOL_VERSION,
      });
    if (req.method === "POST" && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      throw new HttpError(415, "wymagany content-type: application/json");

    // --- pierwsze urządzenie (sekret bootstrapu ze zmiennej środowiskowej, porównanie skrótów w stałym czasie)
    if (p === "/v1/bootstrap" && req.method === "POST") {
      limit(`b:${ip}`, L.anonRatePerMin);
      if (!opts.bootstrapSha256 || !HEX64_RE.test(opts.bootstrapSha256))
        throw new HttpError(403, "bootstrap wyłączony (brak HIPOKAMP_SYNC_BOOTSTRAP_SHA256)");
      const t = bearer(req);
      if (!t || !safeEqualHex(sha256hex(t), opts.bootstrapSha256)) throw new HttpError(401, "zły sekret bootstrapu");
      const b = await body<{ name?: string; token_hash?: string }>(req);
      const name = b.name ?? "";
      const th = b.token_hash ?? "";
      if (!NAME_RE.test(name) || !HEX64_RE.test(th)) throw new HttpError(400, "wymagane: name, token_hash");
      const res = db
        .transaction(() => {
          const n = (db.query("SELECT COUNT(*) c FROM devices").get() as { c: number }).c;
          if (n > 0) return null;
          const hub = randomBytes(12).toString("base64url");
          db.run("INSERT INTO meta(k, v) VALUES ('hub_id', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [hub]);
          db.run("INSERT INTO devices (no, name, role, token_hash, created_at) VALUES (1, ?, 'admin', ?, ?)", [name, th, now()]);
          return hub;
        })
        .immediate();
      if (!res) throw new HttpError(409, "hub ma już urządzenia (bootstrap tylko raz)");
      log("bootstrap", { device: 1 });
      return json({ hub: res, device: 1, role: "admin" });
    }

    // --- prośba nowego urządzenia o dołączenie (bez klucza: urządzenie jeszcze go nie ma)
    if (p === "/v1/join" && req.method === "POST") {
      // limity: nowe prośby z jednego adresu, oczekujące z jednego adresu i łącznie (każda wygasa po 15 minutach,
      // a admin może je odrzucić); odpytywanie istniejącej prośby i health mają osobne kubełki. Prośba z zaproszeniem
      // admina (jednorazowe, `sync invite`) omija te limity: zalew z internetu nie zablokuje dołączania urządzenia.
      // Zaproszenie sprawdzone tu tylko wstępnie (przed odczytem ciała), a zużyte w tej samej transakcji co zapis prośby:
      // kilka żądań z tym samym zaproszeniem (np. z wolno wysyłanym ciałem) daje najwyżej jedną prośbę.
      const inv = (req.headers.get(INVITE_HEADER) ?? "").trim();
      const invHash = inv && INVITE_RE.test(inv) ? sha256hex(`hipokamp-sync-invite\u0001${inv}`) : null;
      const invited = !!invHash && !!db.query("SELECT 1 FROM invites WHERE hash = ? AND expires_at >= ?").get(invHash, now());
      if (!invited) limit(`j:${ip}`, L.joinsPerIpPer15Min, 15 * 60_000);
      if (inv && !invited) throw new HttpError(403, "zaproszenie nieważne albo wygasło (admin: hipokamp sync invite)");
      const b = await body<{ name?: string; token_hash?: string; pubkey?: string; proof?: string; min_device?: unknown }>(req);
      const minDevice = b.min_device === undefined ? 2 : b.min_device;
      if (
        !b.name ||
        !NAME_RE.test(b.name) ||
        !b.token_hash ||
        !HEX64_RE.test(b.token_hash) ||
        !b.pubkey ||
        !B64URL_RE.test(b.pubkey) ||
        b.pubkey.length !== 43 ||
        !b.proof ||
        !MAC_RE.test(b.proof) ||
        !validDevice(minDevice, 2)
      )
        throw new HttpError(400, "wymagane: name, token_hash, pubkey, proof (min_device: liczba 2 … 999999)");
      if (!meta("hub_id")) throw new HttpError(409, "hub nie ma jeszcze grupy (najpierw sync init)");
      expireJoins();
      const full = () => pendingCount(ip) >= L.maxPendingJoinsPerIp || pendingCount() >= L.maxPendingJoins;
      const FULL =
        "za dużo oczekujących próśb (wygasają po 15 minutach; admin: hipokamp sync joins, a nowemu urządzeniu da zaproszenie: hipokamp sync invite)";
      if (!invited && full()) throw new HttpError(429, FULL);
      const th = b.token_hash;
      const taken = db.query("SELECT 1 FROM devices WHERE token_hash = ? UNION SELECT 1 FROM joins WHERE token_hash = ?");
      const id = Array.from(randomBytes(16), (x) => "abcdefghijklmnopqrstuvwxyz234567"[x & 31]).join("");
      const exp = now() + L.joinTtlMs;
      const row = [id, b.name, b.token_hash, b.pubkey, b.proof, minDevice, ip, invited ? 1 : 0, now(), exp];
      // kontrola i zapis w jednej transakcji: równoległe żądania (ciało wysyłane wolno) widzą już skutek poprzednich;
      // błąd w środku cofa całość (zaproszenie zostaje, gdy prośba nie powstała)
      db.transaction(() => {
        if (invited) {
          if (db.run("DELETE FROM invites WHERE hash = ? AND expires_at >= ?", [invHash, now()]).changes !== 1)
            throw new HttpError(403, "zaproszenie już użyte albo wygasło (admin: hipokamp sync invite)");
        } else if (full()) throw new HttpError(429, FULL);
        if (taken.get(th, th)) throw new HttpError(409, "ten klucz jest już użyty");
        db.run(
          "INSERT INTO joins (id, name, token_hash, pubkey, proof, min_device, ip, invited, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          row,
        );
      }).immediate();
      log("join", { request: id, invited });
      return json({ request: id, expires_at: exp });
    }

    // zaproszenie (admin): jednorazowy klucz, który przenosi się na nowe urządzenie (`sync join --invite`)
    if (p === "/v1/invites" && req.method === "POST") {
      const a = admin(req, ip);
      expireJoins();
      const active = (db.query("SELECT COUNT(*) c FROM invites").get() as { c: number }).c;
      if (active >= L.maxInvites)
        throw new HttpError(429, `najwyżej ${L.maxInvites} aktywnych zaproszeń (wygasają po 15 minutach)`);
      const invite = `hki_${randomBytes(16).toString("base64url")}`;
      const exp = now() + L.joinTtlMs;
      db.run("INSERT INTO invites (hash, by_device, created_at, expires_at) VALUES (?, ?, ?, ?)", [
        sha256hex(`hipokamp-sync-invite\u0001${invite}`),
        a.no,
        now(),
        exp,
      ]);
      log("invite", { by: a.no });
      return json({ invite, expires_at: exp });
    }

    // oczekujące prośby (admin): przepisany kod wskazuje prośbę po `proof`, bez przepisywania numeru
    if (p === "/v1/joins" && req.method === "GET") {
      admin(req, ip);
      expireJoins();
      return json(
        db
          .query(
            "SELECT id AS request, name, token_hash, pubkey, proof, min_device, invited, created_at, expires_at FROM joins WHERE status = 'pending' ORDER BY created_at",
          )
          .all(),
      );
    }

    const mj = p.match(/^\/v1\/join\/([a-z2-7]+)(\/approve)?$/);
    if (mj) {
      const t = bearer(req);
      // bez klucza o formacie klucza dostępu nic tu nie ma: limit bez klucza przed zajrzeniem do bazy
      if (!t || !TOKEN_RE.test(t)) limit(`a:${ip}`, L.anonRatePerMin);
      if (!JOIN_ID_RE.test(mj[1])) throw new HttpError(404, "nie ma takiej prośby");
      const j = db.query("SELECT * FROM joins WHERE id = ? AND expires_at >= ?").get(mj[1], now()) as any;
      if (!j) {
        if (t && TOKEN_RE.test(t)) limit(`a:${ip}`, L.anonRatePerMin);
        throw new HttpError(404, "nie ma takiej prośby (wygasła albo zła)");
      }
      const own = !!t && TOKEN_RE.test(t) && safeEqualHex(tokenHash(t), j.token_hash);
      if (!mj[2] && own && (req.method === "GET" || req.method === "DELETE")) {
        limit(`p:${j.id}`, L.pollRatePerMin);
        if (req.method === "DELETE") {
          db.run("DELETE FROM joins WHERE id = ?", [j.id]);
          return json({ ok: true });
        }
        // samo urządzenie pyta o swoją prośbę: po zatwierdzeniu dostaje zapieczętowany klucz grupy i podpis admina
        if (j.status !== "approved") return json({ status: j.status, expires_at: j.expires_at });
        const d = db.query("SELECT status FROM devices WHERE no = ?").get(j.device_no) as { status: string } | null;
        if (d?.status !== "active") throw new HttpError(403, "urządzenie odcięte", { revoked: true });
        return json({
          status: "approved",
          hub: meta("hub_id"),
          device: j.device_no,
          role: j.role,
          sealed: j.sealed,
          mac: j.mac,
        });
      }
      const a = admin(req, ip);
      if (!mj[2] && req.method === "GET")
        return json({
          request: j.id,
          name: j.name,
          pubkey: j.pubkey,
          token_hash: j.token_hash,
          proof: j.proof,
          min_device: j.min_device,
          status: j.status,
          expires_at: j.expires_at,
        });
      if (!mj[2] && req.method === "DELETE") {
        // odrzucenie prośby przez admina (także zatwierdzonej, ale jeszcze nieodebranej: urządzenie zostaje odcięte)
        db.transaction(() => {
          db.run("DELETE FROM joins WHERE id = ?", [j.id]);
          if (j.device_no)
            db.run("UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE no = ?", [
              now(),
              j.device_no,
            ]);
        }).immediate();
        log("reject", { by: a.no, request: j.id });
        return json({ ok: true });
      }
      if (mj[2] && req.method === "POST") {
        const b = await body<{ sealed?: string; mac?: string; role?: string; device?: unknown; ack_lost?: unknown }>(req);
        const role: Role = b.role === "admin" ? "admin" : "member";
        if (!b.sealed || typeof b.sealed !== "string" || b.sealed.length > L.maxSealedBytes)
          throw new HttpError(400, "wymagane: sealed");
        if (!b.mac || !MAC_RE.test(b.mac)) throw new HttpError(400, "wymagane: mac");
        // numer nadaje admin (podpisany w `mac`); hub pilnuje tylko, żeby nigdy nie wrócił do użycia
        if (!validDevice(b.device, 2)) throw new HttpError(400, "wymagane: device (liczba 2 … 999999)");
        const want = b.device;
        const res = db
          .transaction(() => {
            const cur = db.query("SELECT status FROM joins WHERE id = ?").get(j.id) as { status: string } | null;
            if (cur?.status !== "pending") return { err: "prośba nie czeka już na zatwierdzenie" };
            // tryb odzyskiwania: najpierw resync każdego aktywnego admina, potem zatwierdzenie z jawnym potwierdzeniem
            const since = recoverySince();
            if (since) {
              const waiting = (
                db
                  .query(
                    "SELECT d.no FROM devices d WHERE d.role = 'admin' AND d.status = 'active' AND NOT EXISTS (SELECT 1 FROM recovery_reports r WHERE r.no = d.no AND r.at >= ?) ORDER BY d.no",
                  )
                  .all(since) as { no: number }[]
              ).map((r) => r.no);
              if (waiting.length)
                throw new HttpError(
                  409,
                  `hub w trybie odzyskiwania (przywrócony z kopii): zatwierdzanie czeka na hipokamp sync resync na urządzeniach admin nr ${waiting.join(", ")}`,
                  { recovery: true, waiting },
                );
              if (b.ack_lost !== true)
                throw new HttpError(
                  409,
                  "hub w trybie odzyskiwania (przywrócony z kopii): zatwierdzenie wymaga potwierdzenia, że urządzenia nieznane hubowi złożyły już prośby (--ack-lost-devices)",
                  { recovery: true, ack_required: true },
                );
            }
            const floor = deviceFloor();
            if (want <= floor || want < j.min_device)
              return { err: `numer urządzenia ${want} był już użyty albo jest za niski (najwyższy znany: ${floor})`, floor };
            db.run("INSERT INTO devices (no, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
              want,
              j.name,
              role,
              j.token_hash,
              now(),
            ]);
            setMeta("max_device", String(want));
            if (since) {
              // potwierdzone: koniec trybu odzyskiwania (kolejne prośby admin numeruje ponad ich `min_device`)
              setMeta("recovery_since", "");
              db.run("DELETE FROM recovery_reports");
            }
            // po zatwierdzeniu prośba żyje jeszcze chwilę: urządzenie odbiera klucz, potem ją kasuje
            db.run(
              "UPDATE joins SET status = 'approved', device_no = ?, role = ?, sealed = ?, mac = ?, expires_at = ? WHERE id = ?",
              [want, role, b.sealed, b.mac, now() + L.joinTtlMs, j.id],
            );
            return { no: want, ended: !!since };
          })
          .immediate() as { no?: number; err?: string; floor?: number; ended?: boolean };
        if (!res.no) throw new HttpError(409, res.err ?? "konflikt", res.floor !== undefined ? { max_device: res.floor } : {});
        log("approve", { by: a.no, device: res.no, role });
        if (res.ended) log("recovery-end", { by: a.no });
        return json({ device: res.no, role, name: j.name });
      }
      throw new HttpError(405, "niedozwolona metoda");
    }

    // --- dalej tylko urządzenia grupy
    if (p === "/v1/me" && req.method === "GET") {
      const d = device(req, ip);
      return json({ hub: meta("hub_id"), device: d.no, role: d.role, name: d.name });
    }

    if (p === "/v1/devices" && req.method === "GET") {
      device(req, ip);
      const rows = db
        .query("SELECT no, name, role, status, created_at, revoked_at, last_seen_at FROM devices ORDER BY no")
        .all() as DeviceInfo[];
      const usage = db.query("SELECT dev, COUNT(*) n, SUM(size) bytes FROM entries GROUP BY dev").all() as {
        dev: number;
        n: number;
        bytes: number;
      }[];
      const by = new Map(usage.map((u) => [u.dev, u]));
      return json(rows.map((r) => ({ ...r, entries: by.get(r.no)?.n ?? 0, bytes: by.get(r.no)?.bytes ?? 0 })));
    }

    const mr = p.match(/^\/v1\/devices\/(\d+)\/revoke$/);
    if (mr && req.method === "POST") {
      const a = admin(req, ip);
      const no = Number(mr[1]);
      if (no === a.no) throw new HttpError(400, "nie można odciąć urządzenia, z którego wysyłasz polecenie");
      const t = db.query("SELECT status FROM devices WHERE no = ?").get(no) as { status: string } | null;
      if (!t) throw new HttpError(404, "nie ma takiego urządzenia");
      db.run("UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE no = ?", [now(), no]);
      db.run("DELETE FROM joins WHERE device_no = ?", [no]);
      log("revoke", { by: a.no, device: no });
      return json({ ok: true, device: no });
    }

    if (p === "/v1/entries" && req.method === "POST") {
      const d = device(req, ip);
      const b = await body<{ entries?: WireEntry[] }>(req);
      const list = Array.isArray(b.entries) ? b.entries : null;
      if (!list?.length || list.length > L.maxEntriesPerPush)
        throw new HttpError(400, `wymagane: entries (1 do ${L.maxEntriesPerPush})`);
      const rows: { id: string; kid: string; v: number; ct: Buffer }[] = [];
      for (const e of list) {
        if (!e || typeof e.id !== "string" || !ENTRY_ID_RE.test(e.id)) throw new HttpError(400, "zły identyfikator wpisu");
        if (typeof e.kid !== "string" || !KID_RE.test(e.kid)) throw new HttpError(400, "zły identyfikator klucza");
        if (!Number.isInteger(e.v) || e.v < 1 || e.v > 1000) throw new HttpError(400, "zła wersja wpisu");
        if (typeof e.ct !== "string" || !e.ct || !B64_RE.test(e.ct)) throw new HttpError(400, "zły szyfrogram");
        const ct = Buffer.from(e.ct, "base64");
        if (ct.length > L.maxEntryBytes) throw new HttpError(413, "wpis za duży");
        rows.push({ id: e.id, kid: e.kid, v: e.v, ct });
      }
      const add = rows.reduce((s, r) => s + r.ct.length, 0);
      if (totalBytes + add > L.maxTotalBytes) throw new HttpError(507, "magazyn huba pełny");
      const ins = db.query(
        "INSERT INTO entries (id, dev, kid, v, size, at, ct) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING seq",
      );
      const known = db.query("SELECT seq, dev FROM entries WHERE id = ?");
      // numer każdego wpisu (także powtórzonego): klient zapamiętuje ostatni jako kotwicę dziennika
      const stored: { id: string; seq: number }[] = [];
      let accepted = 0;
      db.transaction(() => {
        for (const r of rows) {
          const got = ins.get(r.id, d.no, r.kid, r.v, r.ct.length, now(), r.ct) as { seq: number } | null;
          if (got) {
            stored.push({ id: r.id, seq: got.seq });
            accepted++;
            totalBytes += r.ct.length;
          } else {
            const k = known.get(r.id) as { seq: number; dev: number } | null;
            if (k?.dev === d.no) stored.push({ id: r.id, seq: k.seq });
          }
        }
      }).immediate();
      log("push", { device: d.no, accepted, duplicates: rows.length - accepted, bytes: add });
      return json({ accepted, duplicates: rows.length - accepted, stored });
    }

    if (p === "/v1/entries" && req.method === "GET") {
      const d = device(req, ip);
      const after = Math.max(0, Math.trunc(Number(url.searchParams.get("after") ?? 0)) || 0);
      const max = Math.max(1, Math.min(L.maxPullEntries, Math.trunc(Number(url.searchParams.get("limit") ?? 100)) || 100));
      // own=1: także własne wpisy (odtworzenie po przywróceniu kopii bazy); domyślnie tylko cudze
      const own = url.searchParams.get("own") === "1";
      const devSql = own ? "" : " AND dev != ?";
      const devArg = own ? [] : [d.no];
      // najpierw numery i rozmiary, potem szyfrogramy tylko w budżecie bajtów (200 wpisów po 2 MB nie trafia do pamięci)
      const idx = db
        .query(`SELECT seq, size FROM entries WHERE seq > ?${devSql} ORDER BY seq LIMIT ?`)
        .all(after, ...devArg, max + 1) as { seq: number; size: number }[];
      let n = 0;
      let bytes = 0;
      for (const r of idx.slice(0, max)) {
        if (n && bytes + r.size > L.maxPullBytes) break;
        bytes += r.size;
        n++;
      }
      const rows = n
        ? (db
            .query(`SELECT seq, id, dev, kid, v, ct FROM entries WHERE seq >= ? AND seq <= ?${devSql} ORDER BY seq`)
            .all(idx[0].seq, idx[n - 1].seq, ...devArg) as {
            seq: number;
            id: string;
            dev: number;
            kid: string;
            v: number;
            ct: Uint8Array;
          }[])
        : [];
      const out: PulledEntry[] = rows.map((r) => ({
        seq: r.seq,
        id: r.id,
        dev: r.dev,
        kid: r.kid,
        v: r.v,
        ct: Buffer.from(r.ct).toString("base64"),
      }));
      const head = (db.query("SELECT COALESCE(MAX(seq), 0) m FROM entries").get() as { m: number }).m;
      return json({ entries: out, more: n < idx.length, head });
    }

    // kotwice: identyfikatory wpisów pod numerami, które klient już zna (wykrycie cofniętego albo podmienionego
    // dziennika), i najwyższy numer urządzenia znany hubowi (`max_device`; klient, który zna wyższy, wie, że hub
    // zapomniał urządzenia). `raise=1` to `sync resync` (po przywróceniu huba z kopii): admin podnosi licznik do `maxdev`
    // (najwyżej o maxDeviceRaise ponad listę urządzeń, więc nikt nie zablokuje numeracji, wpisując 999999) i włącza
    // tryb odzyskiwania; członek grupy licznika nie podnosi. W trybie odzyskiwania resync każdego urządzenia jest
    // odnotowany (zatwierdzanie czeka na resync każdego admina).
    if (p === "/v1/anchors" && req.method === "GET") {
      const d = device(req, ip);
      const seqs = (url.searchParams.get("seqs") ?? "")
        .split(",")
        .filter(Boolean)
        .map((s) => Math.trunc(Number(s)))
        .filter((s) => Number.isSafeInteger(s) && s > 0)
        .slice(0, 16);
      const q = db.query("SELECT seq, id FROM entries WHERE seq = ?");
      const entries = seqs.map((s) => q.get(s) as { seq: number; id: string } | null).filter((x) => x !== null);
      const head = (db.query("SELECT COALESCE(MAX(seq), 0) m FROM entries").get() as { m: number }).m;
      const floor = deviceFloor();
      const maxdev = Math.trunc(Number(url.searchParams.get("maxdev") ?? 0));
      if (url.searchParams.get("raise") === "1") {
        if (d.role === "admin") {
          const top = maxListed() + L.maxDeviceRaise;
          if (validDevice(maxdev) && maxdev > floor && maxdev > top)
            throw new HttpError(
              400,
              `numer urządzenia ${maxdev} za wysoki: hub zna urządzenia do nr ${maxListed()}, resync podnosi licznik najwyżej do ${top}`,
            );
          if (validDevice(maxdev) && maxdev > floor) {
            setMeta("max_device", String(maxdev));
            log("raise", { by: d.no, max_device: maxdev });
          }
          if (!recoverySince()) startRecovery("resync", d.no);
        }
        if (recoverySince())
          db.run(
            "INSERT INTO recovery_reports (no, at, max_device) VALUES (?, ?, ?) ON CONFLICT(no) DO UPDATE SET at = excluded.at, max_device = excluded.max_device",
            [d.no, now(), validDevice(maxdev) ? maxdev : 0],
          );
      }
      return json({ head, entries, max_device: floor, recovery: recoverySince() > 0 });
    }

    throw new HttpError(404, "nieznany endpoint");
  }

  const server = Bun.serve({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? 47790,
    maxRequestBodySize: L.maxBodyBytes,
    idleTimeout: 60,
    async fetch(req, srv) {
      try {
        return await route(req, srv);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
        log("error", { e: String(e) });
        return json({ error: "błąd serwera" }, 500);
      }
    },
  });
  port = server.port ?? 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    db,
    stop: () => {
      clearInterval(sweeper);
      server.stop(true);
      try {
        db.close();
      } catch {}
    },
  };
}

/**
 * Start z konfiguracji w zmiennych środowiskowych:
 * - HIPOKAMP_SYNC_DB (domyślnie ./data/hub.db), HIPOKAMP_SYNC_HOST (127.0.0.1), HIPOKAMP_SYNC_PORT (47790)
 * - HIPOKAMP_SYNC_PUBLIC_HOSTS: dozwolone nagłówki Host po przecinku (np. hub.example.com)
 * - HIPOKAMP_SYNC_REQUIRE_HTTPS=1: publiczny Host tylko z x-forwarded-proto: https
 * - HIPOKAMP_SYNC_TRUST_PROXY=1: adres klienta z X-Real-IP, ale tylko z połączeń od proxy (adres loopback albo
 *   prywatny, np. nginx na hoście przez bramę Dockera, albo HIPOKAMP_SYNC_TRUSTED_PROXIES: adresy po przecinku)
 * - HIPOKAMP_SYNC_BOOTSTRAP_SHA256: skrót sekretu pierwszego urządzenia (hipokamp sync bootstrap-hash)
 * - HIPOKAMP_SYNC_RESTORED: znacznik przywrócenia bazy z kopii (np. data); nowa wartość włącza tryb odzyskiwania
 * - HIPOKAMP_SYNC_MAX_TOTAL_MB, HIPOKAMP_SYNC_RATE_PER_MIN: limity
 */
function startFromEnv(): void {
  const env = process.env;
  const limits: Partial<typeof LIMITS> = {};
  if (env.HIPOKAMP_SYNC_MAX_TOTAL_MB) limits.maxTotalBytes = Number(env.HIPOKAMP_SYNC_MAX_TOTAL_MB) * 1024 * 1024;
  if (env.HIPOKAMP_SYNC_RATE_PER_MIN) limits.ratePerMin = Number(env.HIPOKAMP_SYNC_RATE_PER_MIN);
  const log = (event: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));
  const host = env.HIPOKAMP_SYNC_HOST ?? "127.0.0.1";
  const trustProxy = env.HIPOKAMP_SYNC_TRUST_PROXY === "1";
  // X-Real-IP bez proxy przed hubem: hub i tak bierze go tylko od adresów lokalnych i zaufanych, ale przy nasłuchu
  // poza loopback każdy w tej samej sieci prywatnej mógłby go podać
  if (trustProxy && !["127.0.0.1", "::1", "localhost"].includes(host))
    log("warning", {
      msg: "HIPOKAMP_SYNC_TRUST_PROXY=1 przy nasłuchu poza 127.0.0.1: X-Real-IP przyjmowany tylko od adresów lokalnych i prywatnych (nginx przez bramę Dockera) oraz z HIPOKAMP_SYNC_TRUSTED_PROXIES; port huba publikuj tylko na 127.0.0.1 hosta (docker-compose.yml)",
    });
  const hub = startHub({
    dbPath: env.HIPOKAMP_SYNC_DB ?? "./data/hub.db",
    host,
    port: Number(env.HIPOKAMP_SYNC_PORT ?? 47790),
    publicHosts: (env.HIPOKAMP_SYNC_PUBLIC_HOSTS ?? "").split(","),
    requireHttps: env.HIPOKAMP_SYNC_REQUIRE_HTTPS === "1",
    trustProxy,
    trustedProxies: (env.HIPOKAMP_SYNC_TRUSTED_PROXIES ?? "").split(","),
    bootstrapSha256: env.HIPOKAMP_SYNC_BOOTSTRAP_SHA256?.trim().toLowerCase() || null,
    restoredMark: env.HIPOKAMP_SYNC_RESTORED?.trim() || null,
    limits,
    // dziennik bez treści i bez sekretów: zdarzenie, numer urządzenia, liczby
    log,
  });
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      event: "start",
      port: hub.port,
      protocol: PROTOCOL_VERSION,
      entry: ENTRY_VERSION,
    }),
  );
  const bye = () => {
    hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

if (import.meta.main) startFromEnv();
