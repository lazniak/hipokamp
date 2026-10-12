// Uwierzytelnienie workera (T-17). Worker po bezczynności wychodzi, a jego port (127.0.0.1:47777) może wtedy zająć
// obcy proces: dostałby treść promptów, a jego `text` trafiłby do kontekstu modelu. Dlatego klient (hook Buna,
// natywny hook, serwer MCP, CLI) najpierw sprawdza, czy po drugiej stronie jest worker z kluczem z
// `~/.hipokamp/state/worker.key`, i dopiero wtedy wysyła treść:
//
//   1. GET /api/auth, nagłówek x-hipokamp-challenge: Nc (losowe 16 bajtów klienta)
//      → { app, auth: 1, nonce: Nw, proof: HMAC(klucz, "worker", port, Nc, Nw) }   (Nw: jednorazowy, ważny 10 s)
//   2. właściwe żądanie z x-hipokamp-nonce: Nw i x-hipokamp-proof: HMAC(klucz, "client", port, Nw, "METODA ścieżka")
//      → odpowiedź z x-hipokamp-proof: HMAC(klucz, "response", port, Nc, Nw, status)
//
// Klient bez poprawnego dowodu (krok 1 albo 3) traktuje workera jak niedziałającego. Port w każdym dowodzie: worker
// z tym samym kluczem na innym porcie nie posłuży za wyrocznię podpisów dla procesu, który zajął port klienta.
// Etykiety (worker, client, response) rozdzielają dowody, więc żadnego nie da się odbić w innej roli.
// Moduł bez procesów potomnych i bez konfiguracji (ścieżkę klucza podaje wołający): importuje go worker (zasada 2),
// a testy używają go bez katalogu danych. ACL klucza na Windows (icacls) ustawia osobno keyacl.ts po stronie klienta.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const AUTH_PATH = "/api/auth";
/** Klient → worker (krok 1): nonce klienta. */
export const H_CHALLENGE = "x-hipokamp-challenge";
/** Klient → worker (krok 2): nonce workera z kroku 1. */
export const H_NONCE = "x-hipokamp-nonce";
/** Klient → worker: dowód klienta; worker → klient: dowód odpowiedzi. */
export const H_PROOF = "x-hipokamp-proof";
/** Nazwa pliku klucza w `<dane>/state`. */
export const KEY_FILE = "worker.key";
/** Wersja protokołu (zmiana = nowa etykieta, stare dowody przestają pasować). */
const PROTOCOL = "hipokamp-auth-1";
/** Nonce workera żyje tyle: między krokiem 1 i 2 mijają milisekundy, zapas na zajętą pętlę zdarzeń. */
export const NONCE_TTL_MS = 10_000;
export const NONCE_RE = /^[0-9a-f]{32}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

export type ProofLabel = "worker" | "client" | "response";

export const newNonce = (): string => randomBytes(16).toString("hex");

/** HMAC-SHA256 (hex) z protokołu, etykiety, portu i części (nonce'y, „METODA ścieżka”, status). */
export function sign(key: Buffer, label: ProofLabel, port: number, parts: string[]): string {
  return createHmac("sha256", key)
    .update([PROTOCOL, label, String(port), ...parts].join("\n"))
    .digest("hex");
}

/** Dowód zgodny z kluczem; porównanie stałoczasowe (timingSafeEqual), zły format to po prostu fałsz. */
export function verify(key: Buffer, label: ProofLabel, port: number, parts: string[], proof: unknown): boolean {
  if (typeof proof !== "string" || !PROOF_RE.test(proof)) return false;
  return timingSafeEqual(Buffer.from(sign(key, label, port, parts), "hex"), Buffer.from(proof, "hex"));
}

/** Klucz z pliku: 64 znaki hex (32 bajty); null, gdy pliku nie ma, nie da się go przeczytać albo jest uszkodzony. */
export function readKey(file: string): Buffer | null {
  try {
    const t = readFileSync(file, "utf8").trim();
    return KEY_RE.test(t) ? Buffer.from(t, "hex") : null;
  } catch {
    return null;
  }
}

/** Ile czekać na klucz w pliku, który już istnieje: zwycięzca wyścigu `wx` może być między utworzeniem a zapisem. */
const EXISTING_WAIT_MS = 1000;
/** Plik młodszy niż to może być w trakcie zapisu (czekamy); starszy bez klucza jest uszkodzony (naprawa od razu). */
const FRESH_FILE_MS = 2000;

/** Czy plik powstał albo zmienił się przed chwilą (zapis zwycięzcy wyścigu może być jeszcze w toku). */
function freshFile(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < FRESH_FILE_MS;
  } catch {
    return false;
  }
}

/**
 * Klucz z pliku albo nowy (crypto.randomBytes, 32 bajty). Tworzenie z flagą `wx`: dwa procesy naraz nie nadpiszą
 * sobie klucza, przegrany czyta zwycięzcę (czeka do ok. 1 s, ale tylko gdy plik jest młodszy niż 2 s, bo bywa
 * chwilę pusty między utworzeniem a zapisem). Plik starszy bez klucza jest uszkodzony i od razu dostaje nowy klucz
 * (zapis obok i zmiana nazwy). Kilka procesów naprawia go naraz, więc wiążące jest to, co po podmianie leży na
 * dysku, a nie własny nowy klucz (loadKey i tak czyta plik od nowa po każdej zmianie). POSIX: plik 0600, katalog
 * 0700 (bez procesów potomnych, więc może to zrobić także worker). Windows: tryb pliku nic nie znaczy, ACL ustawia
 * keyacl.ts (icacls) po stronie klienta.
 */
export function ensureKey(file: string): { key: Buffer; created: boolean } {
  const have = readKey(file);
  if (have) return { key: have, created: false };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, `${fresh}\n`, { flag: "wx", mode: 0o600 });
    restrictPosix(file);
    return { key: Buffer.from(fresh, "hex"), created: true };
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  const until = Date.now() + EXISTING_WAIT_MS;
  for (;;) {
    const k = readKey(file);
    if (k) return { key: k, created: false };
    if (Date.now() >= until || !freshFile(file)) break;
    Bun.sleepSync(10);
  }
  // plik jest, ale nie ma w nim klucza (ucięty zapis, ręczna edycja): nowy klucz, podmiana w jednym kroku
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${fresh}\n`, { mode: 0o600 });
  try {
    for (let i = 0; ; i++) {
      // inny proces mógł naprawić plik w międzyczasie: wtedy jego klucz, bez drugiej podmiany
      const k = readKey(file);
      if (k) return { key: k, created: false };
      try {
        renameSync(tmp, file);
        break;
      } catch (e) {
        // Windows: plik chwilowo otwarty przez inny proces (EPERM, EBUSY, EACCES)
        if (i >= 20) throw e;
        Bun.sleepSync(10);
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  restrictPosix(file);
  const disk = readKey(file);
  if (disk) return { key: disk, created: disk.toString("hex") === fresh };
  return { key: Buffer.from(fresh, "hex"), created: true };
}

/** POSIX: klucz tylko dla właściciela (0600), katalog stanu 0700. Na Windows nic (ACL: keyacl.ts). */
export function restrictPosix(file: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
    chmodSync(dirname(file), 0o700);
  } catch {}
}

const cache = new Map<string, { stamp: string; key: Buffer }>();

/**
 * Klucz z dysku przez pamięć podręczną: najpierw stempel pliku, potem treść. Podmiana pliku po odczycie zmienia
 * stempel, więc następne wywołanie przeczyta plik od nowa; w pamięci nigdy nie zostaje klucz, którego nie ma w pliku.
 */
function cachedFromDisk(file: string): Buffer | null {
  try {
    const stamp = stampOf(file);
    if (stamp === "brak") throw new Error("brak pliku");
    const hit = cache.get(file);
    if (hit && hit.stamp === stamp) return hit.key;
    const key = readKey(file);
    if (key) cache.set(file, { stamp, key });
    else cache.delete(file);
    return key;
  } catch {
    cache.delete(file);
    return null;
  }
}

/**
 * Klucz z pamięci podręcznej procesu, odświeżany po zmianie pliku (czas zmiany, rozmiar, i-węzeł: jeden stat, kilka
 * do kilkudziesięciu mikrosekund). Długowieczne procesy (worker, serwer MCP) widzą więc nowy klucz bez restartu.
 * `create`: brak pliku albo uszkodzony plik = ensureKey, a potem znowu odczyt z dysku (kilka procesów naprawia plik
 * naraz i ostatnia podmiana wygrywa). null: klucza nie ma i nie wolno albo nie da się go utworzyć. Nieudana
 * naprawa (np. plik bez prawa zapisu) nie jest ponawiana w tym procesie przez 30 s, dopóki plik się nie zmieni:
 * długowieczny proces (serwer MCP) nie płaci za nią przy każdym wywołaniu. Worker woła z `create = false`: klucz
 * tworzy klient, a wyzwanie nigdy nie czeka na zapis pliku.
 */
export function loadKey(file: string, create = true): Buffer | null {
  const have = cachedFromDisk(file);
  if (have || !create) return have;
  const f = failedRepair.get(file);
  if (f && f.stamp === stampOf(file) && Date.now() < f.until) return null;
  try {
    const { key } = ensureKey(file);
    failedRepair.delete(file);
    // bez zapamiętywania własnego klucza: pamięć podręczna dostaje tylko to, co jest w pliku
    return cachedFromDisk(file) ?? key;
  } catch {
    failedRepair.set(file, { stamp: stampOf(file), until: Date.now() + 30_000 });
    return null;
  }
}

const failedRepair = new Map<string, { stamp: string; until: number }>();

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "brak";
  }
}

/** Wynik kroku 1: nonce'y do kroku 2 albo powód odmowy (`status`: kod HTTP odpowiedzi, gdy była). */
export type Handshake = { ok: true; nc: string; nw: string } | { ok: false; status?: number; reason: string };

/**
 * Krok 1 po stronie klienta: wyzwanie i sprawdzenie dowodu workera. Nagłówek `x-hipokamp-bg`: samo wyzwanie nie
 * liczy się jako aktywność (także w starszym workerze, który go nie zna i wyjdzie z bezczynności jak dotąd).
 * Bez przekierowań: odpowiedź 3xx to odmowa.
 */
export async function handshake(base: string, port: number, key: Buffer, signal?: AbortSignal): Promise<Handshake> {
  const nc = newNonce();
  const res = await fetch(`${base}${AUTH_PATH}`, {
    headers: { [H_CHALLENGE]: nc, "x-hipokamp-bg": "1" },
    signal,
    redirect: "manual",
  });
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, reason: `wyzwanie: HTTP ${res.status}` };
  }
  let j: any;
  try {
    j = await res.json();
  } catch {
    return { ok: false, status: res.status, reason: "wyzwanie: odpowiedź nie jest JSON-em" };
  }
  const nw = typeof j?.nonce === "string" ? j.nonce : "";
  if (j?.app !== "hipokamp" || !NONCE_RE.test(nw) || nw === nc || !verify(key, "worker", port, [nc, nw], j?.proof))
    return { ok: false, status: res.status, reason: "wyzwanie: zły dowód workera" };
  return { ok: true, nc, nw };
}

/**
 * Żądanie do workera z obu krokami: wyzwanie, potem żądanie z dowodem klienta i sprawdzenie dowodu odpowiedzi.
 * Zwraca odpowiedź (dowolny status, treść nieprzeczytana) tylko wtedy, gdy dowody się zgadzają; inaczej null
 * (obcy proces na porcie, starszy worker bez /api/auth, inny klucz). Treść żądania wychodzi dopiero po kroku 1.
 */
export async function authedFetch(o: {
  base: string;
  port: number;
  key: Buffer;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<Response | null> {
  const hs = await handshake(o.base, o.port, o.key, o.signal);
  if (!hs.ok) return null;
  const url = new URL(o.path, o.base);
  const method = (o.method ?? (o.body !== undefined ? "POST" : "GET")).toUpperCase();
  const res = await fetch(url, {
    method,
    headers: {
      ...o.headers,
      [H_NONCE]: hs.nw,
      [H_PROOF]: sign(o.key, "client", o.port, [hs.nw, `${method} ${url.pathname}${url.search}`]),
    },
    body: o.body,
    signal: o.signal,
    redirect: "manual",
  });
  if (verify(o.key, "response", o.port, [hs.nc, hs.nw, String(res.status)], res.headers.get(H_PROOF))) return res;
  void res.body?.cancel().catch(() => {});
  return null;
}

/**
 * Po stronie workera: jednorazowe nonce'y z kroku 1 (nonce workera → nonce klienta i termin). Mapa trzyma kolejność
 * wstawiania, a termin jest stały, więc przeterminowane leżą na początku; limit chroni pamięć przed zalewem wyzwań.
 */
export class ChallengeStore {
  private m = new Map<string, { nc: string; exp: number }>();
  constructor(
    private ttlMs = NONCE_TTL_MS,
    private max = 1024,
  ) {}

  issue(nc: string, now = Date.now()): string {
    for (const [k, v] of this.m) {
      if (v.exp > now && this.m.size < this.max) break;
      this.m.delete(k);
    }
    const nw = newNonce();
    this.m.set(nw, { nc, exp: now + this.ttlMs });
    return nw;
  }

  /** Zużywa nonce (także przeterminowany albo z błędnym dowodem): każdy działa najwyżej raz. */
  take(nw: string, now = Date.now()): string | null {
    const v = this.m.get(nw);
    if (!v) return null;
    this.m.delete(nw);
    return v.exp > now ? v.nc : null;
  }

  get size(): number {
    return this.m.size;
  }
}
