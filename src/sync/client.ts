// Klient huba synchronizacji: pliki stanu, HTTP, dołączanie urządzeń, wysyłka i odbiór dziennika.
// Sekrety (klucz dostępu urządzenia i klucze grupy) leżą tylko w state/sync-secret.json z uprawnieniami użytkownika
// (albo w zmiennej HIPOKAMP_SYNC_SECRET, np. z menedżera sekretów); nigdy w logu, w bazie ani na ekranie.
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, paths } from "../config.ts";
import { getMeta, setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { breathe, waitOutside } from "../util/slice.ts";
import {
  approvalMac,
  entryId,
  isJoinCode,
  type JoinKeys,
  joinCodeKey,
  joinProof,
  type Keyring,
  macEqual,
  newGroupKey,
  newJoinCode,
  newJoinKeys,
  newToken,
  openEntry,
  openSealed,
  sealEntry,
  sealForDevice,
  UnknownKeyError,
} from "./crypto.ts";
import {
  type DeviceInfo,
  ENTRY_VERSION,
  HUB_ID_RE,
  INVITE_HEADER,
  INVITE_RE,
  LIMITS,
  NAME_RE,
  PAYLOAD_VERSION,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type PulledEntry,
  type Role,
  tokenHash,
  validDevice,
  type WireEntry,
} from "./protocol.ts";
import {
  type ApplyStats,
  adoptMembership,
  applySlice,
  clockWarnings,
  collectBatch,
  commitMarks,
  emptyStats,
  ensureOwnRange,
  Hlc,
  idRange,
  isMapped,
  knownMaxDevice,
  minDeviceFor,
  newCursor,
  noteDevice,
  type Op,
  ownDevices,
  ownRangeProblem,
  ownSeq,
  pendingCounts,
  sessionHash,
  traceClockRejected,
} from "./store.ts";

export interface SyncState {
  server: string;
  hub: string;
  device: number;
  name: string;
  role: Role;
  created_at: number;
  /**
   * Najwyższe własne numery notatki i podsumowania potwierdzone przez hub (zapisywane po każdej potwierdzonej
   * partii). Plik stanu leży poza bazą, więc przywrócona starsza kopia bazy (licznik niżej) jest wykrywana przed wysyłką.
   */
  hwm?: { obs: number; sum: number };
}

interface SyncSecret {
  token: string;
  keys: Keyring;
}

interface JoinState {
  server: string;
  name: string;
  request: string;
  token: string;
  keys: JoinKeys;
  /** Jednorazowy kod dołączania (tylko na ekranie tego urządzenia i u admina, który go przepisze; nigdy w hubie). */
  code: string;
  /** Najniższy numer urządzenia, jaki ta baza może przyjąć (w `proof`, więc hub go nie obniży). */
  min_device: number;
  created_at: number;
  expires_at: number;
}

export interface SyncCtx {
  repo: Repo;
  /** Katalog stanu (domyślnie ~/.hipokamp/state); testy dają osobny na każdy „komputer”. */
  stateDir?: string;
  now?: () => number;
  /** Projekty wyłączone z wysyłki (domyślnie sync.excludeProjects z konfiguracji). */
  exclude?: string[];
  timeoutMs?: number;
  /** Ile wpisów nieczytelnych pamiętać pojedynczo (domyślnie 500; starsze jako zakres, zob. SKIPPED_OVERFLOW). */
  skipListMax?: number;
  /** Budżet jednej transakcji odbioru w ms (domyślnie SLICE_MS); duży wpis stosuje się kawałkami. */
  sliceMs?: number;
  /**
   * Budżet jednego zbierania zmian do wysyłki w ms (collectBatch): przegląd dużej bazy kawałkami z przerwą dla pętli
   * zdarzeń. Worker: SLICE_MS (hooki czekają na tę samą pętlę); CLI bez limitu (własny proces, większe partie).
   */
  collectMs?: number;
  /** Testy: czas każdej transakcji odbioru (ms, z zatwierdzeniem). */
  onSlice?: (ms: number) => void;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly body: any = null,
  ) {
    super(message);
  }
}

/** Ile JSON-u (przed kompresją) mieści się w jednym wpisie i w jednym żądaniu wysyłki. */
const ENTRY_RAW_BYTES = 512 * 1024;
const REQUEST_RAW_BYTES = 4 * 1024 * 1024;

const files = (ctx: SyncCtx) => {
  const dir = ctx.stateDir ?? paths.state();
  return { state: join(dir, "sync.json"), secret: join(dir, "sync-secret.json"), join: join(dir, "sync-join.json") };
};

/**
 * Plik tylko dla użytkownika: tryb 0600 na POSIX. Na Windows tryb nie działa: chroni ACL katalogu (profil
 * użytkownika ma ACL tylko dla właściciela i administratorów); poza profilem ostrzega `hipokamp doctor`.
 */
function writePrivate(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, path);
}

/** Ostrzeżenie dla `hipokamp doctor`: klucze synchronizacji na Windows poza profilem użytkownika. */
export function secretFileWarning(stateDir = paths.state()): string | null {
  const f = resolve(join(stateDir, "sync-secret.json"));
  if (process.platform !== "win32" || !existsSync(f)) return null;
  const profile = resolve(process.env.USERPROFILE ?? "").toLowerCase();
  if (process.env.USERPROFILE && f.toLowerCase().startsWith(`${profile}\\`)) return null;
  return `klucze synchronizacji leżą poza profilem użytkownika (${f}): na Windows tryb 0600 nie działa, a ACL katalogu może wpuszczać innych lokalnych użytkowników. Zostaw dostęp tylko sobie: icacls "${f}" /inheritance:r /grant:r "%USERNAME%:F"`;
}

const readJson = <T>(path: string): T | null => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

export function readState(ctx: SyncCtx): SyncState | null {
  return readJson<SyncState>(files(ctx).state);
}

function readSecret(ctx: SyncCtx): SyncSecret | null {
  const f = readJson<SyncSecret>(files(ctx).secret);
  if (f) return f;
  try {
    return process.env.HIPOKAMP_SYNC_SECRET ? (JSON.parse(process.env.HIPOKAMP_SYNC_SECRET) as SyncSecret) : null;
  } catch {
    return null;
  }
}

function load(ctx: SyncCtx): { st: SyncState; sec: SyncSecret } {
  const st = readState(ctx);
  if (!st) throw new SyncError("synchronizacja nie jest skonfigurowana: hipokamp sync init albo hipokamp sync join");
  if (!validDevice(st.device) || !HUB_ID_RE.test(String(st.hub)))
    throw new SyncError(`plik stanu ${files(ctx).state} ma niepoprawny numer urządzenia albo hub`);
  const sec = readSecret(ctx);
  if (!sec?.token || !Array.isArray(sec.keys) || !sec.keys.length)
    throw new SyncError(`brak klucza urządzenia albo kluczy grupy (${files(ctx).secret})`);
  return { st, sec };
}

/** Adres huba: tylko HTTPS; zwykłe HTTP wyłącznie dla 127.0.0.1 i localhost (testy, tunel SSH). */
export function normServer(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SyncError(`zły adres huba: ${url}`);
  }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop))
    throw new SyncError("hub tylko przez HTTPS (http:// wyłącznie dla 127.0.0.1)");
  if (u.username || u.password || u.search || u.hash) throw new SyncError("adres huba bez danych logowania i parametrów");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function message(status: number, j: any): string {
  if (status === 426)
    return `niezgodna wersja protokołu: hub obsługuje wersję ${j?.protocol ?? "?"}, ten hipokamp ${PROTOCOL_VERSION}; zaktualizuj starszą stronę`;
  if (status === 403 && j?.revoked)
    return "to urządzenie zostało odcięte od huba (sync revoke); dołącz je od nowa: hipokamp sync join";
  if (status === 401 && /nieznany klucz/.test(String(j?.error)))
    return "hub nie zna klucza tego urządzenia (hub przywrócony z kopii sprzed dołączenia tego urządzenia albo założony od nowa). Naprawa: hipokamp sync leave --yes, potem hipokamp sync join --server <adres> (nowy numer urządzenia; własne notatki pójdą do huba jeszcze raz)";
  if (status === 401) return `hub odrzucił klucz: ${j?.error ?? "brak autoryzacji"}`;
  return `hub: ${j?.error ?? `HTTP ${status}`}`;
}

async function http<T = any>(
  server: string,
  method: string,
  path: string,
  o: { token?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string>; retry?: boolean } = {},
): Promise<T> {
  const tries = o.retry === false ? 0 : 3;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    // czekanie na hub poza kawałkami pracy (waitOutside): w workerze sieć nie liczy się jako przestój synchronizacji
    try {
      res = await waitOutside(
        fetch(`${server}${path}`, {
          method,
          headers: {
            [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
            ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
            ...(o.headers ?? {}),
          },
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
          redirect: "error",
        }),
      );
    } catch (e) {
      if (attempt < Math.min(2, tries)) {
        await waitOutside(Bun.sleep(500 * 2 ** attempt));
        continue;
      }
      throw new SyncError(`hub nie odpowiada (${server}): ${String((e as Error)?.message ?? e)}`);
    }
    // poza kawałkiem tylko czekanie na bajty; parsowanie (do 8 MB odbioru) to praca procesu i liczy się w kawałku
    let j: any = null;
    let text = "";
    try {
      text = await waitOutside(res.text());
    } catch {}
    try {
      j = JSON.parse(text);
    } catch {}
    if (res.ok) return j as T;
    // przeciążenie i chwilowe błędy proxy: ponów z przerwą (Retry-After, najwyżej 10 s); prośba o dołączenie
    // (retry: false) nie jest idempotentna, a zapchana kolejka i tak nie zwolni się w kilka sekund
    if ([429, 502, 503, 504].includes(res.status) && attempt < tries) {
      const ra = Number(res.headers.get("retry-after"));
      await waitOutside(Bun.sleep(Math.min(10_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt)));
      continue;
    }
    throw new SyncError(message(res.status, j), res.status, j);
  }
}

/** Ta baza należy do tego huba (kopia bazy z innej grupy nie miesza numerów urządzeń). */
function bindHub(repo: Repo, hub: string): void {
  const have = getMeta(repo.db, "sync_hub");
  if (have && have !== hub)
    throw new SyncError(
      `ta baza była już połączona z innym hubem (${have}); nowy hub wymaga czystej bazy albo ręcznego wyczyszczenia stanu (docs/SYNC.md)`,
    );
  if (!have) setMeta(repo.db, "sync_hub", hub);
}

// ---------- konfiguracja i urządzenia ----------

/** Pierwsze urządzenie grupy: nowy klucz grupy, rejestracja w hubie sekretem bootstrapu. */
export async function initSync(ctx: SyncCtx, o: { server: string; name: string; bootstrap: string }): Promise<SyncState> {
  if (readState(ctx)) throw new SyncError("synchronizacja jest już skonfigurowana (hipokamp sync status)");
  if (!NAME_RE.test(o.name)) throw new SyncError("nazwa urządzenia: litery, cyfry, spacja, . _ - (do 40 znaków)");
  if (!o.bootstrap) throw new SyncError("brak sekretu bootstrapu (zmienna HIPOKAMP_SYNC_BOOTSTRAP)");
  const server = normServer(o.server);
  const now = ctx.now?.() ?? Date.now();
  const token = newToken();
  const keys: Keyring = [newGroupKey(now)];
  const problem = ownRangeProblem(ctx.repo, 1);
  if (problem) throw new SyncError(`${problem}: ta baza nie może być urządzeniem 1 (dołącz ją: hipokamp sync join)`);
  const r = await http<{ hub: string; device: number; role: Role }>(server, "POST", "/v1/bootstrap", {
    token: o.bootstrap,
    body: { name: o.name, token_hash: tokenHash(token) },
    timeoutMs: ctx.timeoutMs,
  });
  // pierwsze urządzenie grupy to zawsze nr 1 z rolą admin: inna odpowiedź to błąd albo podstawiony hub
  if (r?.device !== 1 || r.role !== "admin" || typeof r.hub !== "string" || !HUB_ID_RE.test(r.hub))
    throw new SyncError("hub odpowiedział na bootstrap niezgodnie z protokołem (urządzenie 1, rola admin): nic nie zapisuję");
  bindHub(ctx.repo, r.hub);
  adoptMembership(ctx.repo, 1);
  ensureOwnRange(ctx.repo, 1);
  const st: SyncState = { server, hub: r.hub, device: 1, name: o.name, role: "admin", created_at: now };
  writePrivate(files(ctx).secret, { token, keys } satisfies SyncSecret);
  writePrivate(files(ctx).state, st);
  return st;
}

/**
 * Nowe urządzenie prosi o dołączenie. Zwraca jednorazowy kod: przepisuje się go na urządzeniu z rolą admin
 * (`hipokamp sync add-device <kod>`). Do huba idzie tylko dowód znajomości kodu (`proof`), nigdy sam kod.
 * `min_device`: numer, poniżej którego ta baza nie może dostać numeru (jej licznik notatek albo numery, które zna
 * z wcześniejszej przynależności). `invite`: zaproszenie admina (`sync invite`), gdy kolejka próśb jest zapchana.
 */
export async function joinStart(
  ctx: SyncCtx,
  o: { server: string; name: string; invite?: string },
): Promise<{ request: string; code: string; expires_at: number }> {
  if (readState(ctx)) throw new SyncError("to urządzenie jest już w grupie (hipokamp sync status)");
  if (!NAME_RE.test(o.name)) throw new SyncError("nazwa urządzenia: litery, cyfry, spacja, . _ - (do 40 znaków)");
  const invite = o.invite?.trim();
  if (invite && !INVITE_RE.test(invite)) throw new SyncError("zaproszenie: hki_ i 22 znaki (z hipokamp sync invite)");
  const server = normServer(o.server);
  const token = newToken();
  const keys = newJoinKeys();
  const code = newJoinCode();
  const token_hash = tokenHash(token);
  const min_device = minDeviceFor(ctx.repo);
  const proof = joinProof(joinCodeKey(code), { name: o.name, token_hash, pubkey: keys.pubkey, min_device });
  const r = await http<{ request: string; expires_at: number }>(server, "POST", "/v1/join", {
    body: { name: o.name, token_hash, pubkey: keys.pubkey, proof, min_device },
    headers: invite ? { [INVITE_HEADER]: invite } : undefined,
    timeoutMs: ctx.timeoutMs,
    retry: false,
  });
  const js: JoinState = {
    server,
    name: o.name,
    request: r.request,
    token,
    keys,
    code,
    min_device,
    created_at: ctx.now?.() ?? Date.now(),
    expires_at: r.expires_at,
  };
  writePrivate(files(ctx).join, js);
  return { request: r.request, code, expires_at: r.expires_at };
}

export function pendingJoin(ctx: SyncCtx): { request: string; code: string; server: string; expires_at: number } | null {
  const js = readJson<JoinState>(files(ctx).join);
  return js?.code ? { request: js.request, code: js.code, server: js.server, expires_at: js.expires_at } : null;
}

/**
 * Sprawdza prośbę. Klucz grupy przyjmuje tylko z podpisem admina (`mac` z klucza kodu): hub, który sam „zatwierdzi”
 * prośbę i podsunie własny klucz grupy, nie zna kodu, więc podpisu nie podrobi.
 */
export async function joinFinish(ctx: SyncCtx): Promise<{ status: "pending" } | { status: "approved"; state: SyncState }> {
  const f = files(ctx);
  const js = readJson<JoinState>(f.join);
  if (!js?.code) throw new SyncError("brak oczekującej prośby: hipokamp sync join --server <adres>");
  let r: { status: string; hub?: string; device?: number; role?: Role; sealed?: string; mac?: string };
  try {
    r = await http(js.server, "GET", `/v1/join/${js.request}`, { token: js.token, timeoutMs: ctx.timeoutMs });
  } catch (e) {
    if (e instanceof SyncError && e.status === 404) {
      unlinkSync(f.join);
      throw new SyncError("prośba wygasła albo została odrzucona; zacznij od nowa: hipokamp sync join --server <adres>");
    }
    throw e;
  }
  if (r.status !== "approved" || !r.sealed || r.hub === undefined || r.device === undefined) return { status: "pending" };
  // numer urządzenia wyznacza przestrzeń numerów notatek i prefiks gid: tylko liczba całkowita z zakresu, nie niższa
  // niż ta baza może przyjąć, i tylko z podpisem admina (niżej); inaczej nic nie zapisujemy
  const minDev = validDevice(js.min_device, 2) ? js.min_device : 2;
  if (!validDevice(r.device, minDev) || typeof r.hub !== "string" || !HUB_ID_RE.test(r.hub))
    throw new SyncError(
      `hub podał niepoprawny numer urządzenia (${String(r.device).slice(0, 24)}; dozwolone ${minDev} … 999999) albo identyfikator huba: nic nie zapisuję. Sprawdź hub i zacznij od nowa: hipokamp sync join --server <adres>`,
    );
  const device = r.device;
  const role: Role = r.role === "admin" ? "admin" : "member";
  const want = approvalMac(joinCodeKey(js.code), {
    hub: r.hub,
    request: js.request,
    pubkey: js.keys.pubkey,
    token_hash: tokenHash(js.token),
    role,
    sealed: r.sealed,
    device,
  });
  if (!r.mac || !macEqual(r.mac, want))
    throw new SyncError(
      "zatwierdzenie bez ważnego podpisu admina (hub podał klucz grupy, rolę albo numer urządzenia, których nie wystawiło urządzenie znające kod): nic nie zapisuję. Sprawdź hub i zacznij od nowa: hipokamp sync join --server <adres>",
    );
  const keys = openSealed(r.sealed, js.keys, js.request);
  const problem = ownRangeProblem(ctx.repo, device);
  if (problem) throw new SyncError(`${problem}: nic nie zapisuję; zacznij od nowa: hipokamp sync join --server <adres>`);
  bindHub(ctx.repo, r.hub);
  // ta sama baza dołącza drugi raz (np. po przywróceniu huba z kopii albo po odcięciu): nowy numer, nowy dziennik
  // własnych wierszy (pójdą do huba jeszcze raz pod nowym numerem), kursor i kotwice od zera
  if (ownDevices(ctx.repo).some((d) => d !== device))
    ctx.repo.db
      .transaction(() => {
        setMeta(ctx.repo.db, CURSOR, "0");
        setMeta(ctx.repo.db, CURSOR_ID, "");
        setMeta(ctx.repo.db, PUSH_ANCHOR, "");
      })
      .immediate();
  adoptMembership(ctx.repo, device);
  ensureOwnRange(ctx.repo, device);
  const st: SyncState = {
    server: js.server,
    hub: r.hub,
    device,
    name: js.name,
    role,
    created_at: ctx.now?.() ?? Date.now(),
  };
  writePrivate(f.secret, { token: js.token, keys } satisfies SyncSecret);
  writePrivate(f.state, st);
  unlinkSync(f.join);
  await http(js.server, "DELETE", `/v1/join/${js.request}`, { token: js.token, timeoutMs: ctx.timeoutMs }).catch(() => {});
  return { status: "approved", state: st };
}

export interface PendingJoinInfo {
  request: string;
  name: string;
  token_hash: string;
  pubkey: string;
  proof: string;
  min_device: number;
  invited?: number;
  created_at: number;
  expires_at: number;
}

/** Oczekujące prośby o dołączenie (rola admin). */
export async function listJoins(ctx: SyncCtx): Promise<PendingJoinInfo[]> {
  const { st, sec } = load(ctx);
  return http(st.server, "GET", "/v1/joins", { token: sec.token, timeoutMs: ctx.timeoutMs });
}

/** Odrzuca prośbę o dołączenie (rola admin). */
export async function rejectJoin(ctx: SyncCtx, request: string): Promise<void> {
  const { st, sec } = load(ctx);
  await http(st.server, "DELETE", `/v1/join/${encodeURIComponent(request.trim().toLowerCase())}`, {
    token: sec.token,
    timeoutMs: ctx.timeoutMs,
  });
}

/**
 * Zatwierdza prośbę nowego urządzenia po kodzie z jego ekranu. Prośbę wskazuje dowód znajomości kodu (`proof`):
 * podmieniony przez hub klucz publiczny albo cudza prośba go nie mają, więc nic nie zostanie zatwierdzone. Klucz grupy
 * idzie zapieczętowany kluczem publicznym nowego urządzenia, z podpisem z klucza kodu.
 *
 * Numer urządzenia nadaje admin: większy od każdego, jaki zna on sam (własne numery, urządzenia z odebranych wpisów,
 * lista urządzeń, wcześniejsze zatwierdzenia) i jaki zna hub, i nie mniejszy niż `min_device` z prośby. Numer jest
 * w podpisie, więc hub go nie zmieni. Najpierw kotwice: hub przywrócony z kopii (zapomniał wpisy albo urządzenia)
 * zatrzymuje zatwierdzanie, zanim wyda drugi raz numer, który ma już inne urządzenie.
 */
export async function approveJoin(
  ctx: SyncCtx,
  o: { code: string; request?: string; admin?: boolean; ackLost?: boolean },
): Promise<{ device: number; role: Role; name: string }> {
  const { st, sec } = load(ctx);
  if (!o.code || !isJoinCode(o.code))
    throw new SyncError("zły kod: 16 znaków z ekranu nowego urządzenia (np. ABCD-EFGH-JKMN-PQRS)");
  const hubMax = (await verifyHub(ctx, st, sec)).max;
  const k = joinCodeKey(o.code);
  const want = o.request?.trim().toLowerCase();
  const joins = await listJoins(ctx);
  const match = joins.find(
    (j) => (!want || j.request === want) && validDevice(j.min_device, 2) && macEqual(j.proof, joinProof(k, j)),
  );
  if (!match)
    throw new SyncError(
      "kod nie pasuje do żadnej oczekującej prośby: nic nie zatwierdzam. Sprawdź kod na ekranie nowego urządzenia (prośba wygasa po 15 minutach).",
    );
  const role: Role = o.admin ? "admin" : "member";
  const sealed = sealForDevice(sec.keys, match.pubkey, match.request);
  const base = Math.max(hubMax, knownMaxDevice(ctx.repo, true), st.device);
  // po przywróceniu huba z kopii (potwierdzenie --ack-lost-devices): urządzenia, których hub nie zna, czekają z
  // prośbami, a ich `min_device` mówi, jakie numery znają; nowy numer jest wyższy także od nich (prośba z internetu
  // przesunie numerację najwyżej o maxDeviceRaise)
  const lost = o.ackLost
    ? joins
        .filter((j) => j !== match && validDevice(j.min_device, 2) && j.min_device - 1 <= base + LIMITS.maxDeviceRaise)
        .map((j) => j.min_device - 1)
    : [];
  const pick = (floor: number) => Math.max(floor, base, match.min_device - 1, ...lost) + 1;
  let device = pick(hubMax);
  for (let attempt = 0; ; attempt++) {
    if (!validDevice(device, 2)) throw new SyncError("brak wolnego numeru urządzenia (najwyżej 999999)");
    const mac = approvalMac(k, {
      hub: st.hub,
      request: match.request,
      pubkey: match.pubkey,
      token_hash: match.token_hash,
      role,
      sealed,
      device,
    });
    try {
      const r = await http<{ device: number; role: Role; name: string }>(st.server, "POST", `/v1/join/${match.request}/approve`, {
        token: sec.token,
        body: { sealed, mac, role, device, ...(o.ackLost ? { ack_lost: true } : {}) },
        timeoutMs: ctx.timeoutMs,
      });
      noteDevice(ctx.repo, device);
      return r;
    } catch (e) {
      if (e instanceof SyncError && e.status === 409 && e.body?.recovery) throw new SyncError(recoveryHint(e.body), 409, e.body);
      // inny admin w międzyczasie zatwierdził urządzenie: numer dalej, kilka prób z losową przerwą (równoległe
      // zatwierdzenia nie trafiają znów na ten sam numer)
      const floor = e instanceof SyncError && e.status === 409 ? Number(e.body?.max_device) : Number.NaN;
      if (attempt >= APPROVE_TRIES - 1 || !Number.isSafeInteger(floor)) throw e;
      await Bun.sleep(20 + Math.floor(Math.random() * 80 * (attempt + 1)));
      device = pick(floor);
    }
  }
}

const APPROVE_TRIES = 6;

/** Komunikat dla admina, gdy hub jest w trybie odzyskiwania (przywrócony z kopii, docs/SYNC.md, sekcja 9). */
function recoveryHint(b: { waiting?: number[]; ack_required?: boolean }): string {
  const steps =
    "Kolejność: 1) hipokamp sync resync na każdym urządzeniu, które hub zna (najpierw na wszystkich z rolą admin); 2) na każdym urządzeniu, którego hub nie zna (komunikat o nieznanym kluczu): hipokamp sync leave --yes, potem hipokamp sync join (prośba); 3) gdy wszystkie prośby czekają (hipokamp sync joins): hipokamp sync add-device <kod> --ack-lost-devices.";
  if (b.waiting?.length)
    return `Hub przywrócony z kopii (tryb odzyskiwania): zatwierdzanie czeka na hipokamp sync resync na urządzeniach z rolą admin nr ${b.waiting.join(", ")} (każdy admin zna numery, które sam nadał; inaczej numer mógłby wrócić do użycia). ${steps}`;
  return `Hub przywrócony z kopii (tryb odzyskiwania): zatwierdzenie wymaga potwierdzenia, że każde urządzenie, którego hub nie zna, złożyło już prośbę (jej min_device mówi, jakie numery zna). ${steps}`;
}

export async function listDevices(ctx: SyncCtx): Promise<(DeviceInfo & { entries: number; bytes: number })[]> {
  const { st, sec } = load(ctx);
  const list = await http<(DeviceInfo & { entries: number; bytes: number })[]>(st.server, "GET", "/v1/devices", {
    token: sec.token,
    timeoutMs: ctx.timeoutMs,
  });
  for (const d of list) noteDevice(ctx.repo, d.no);
  return list;
}

/**
 * Jednorazowe zaproszenie (rola admin): prośba nowego urządzenia z nim omija limity próśb bez klucza, więc zalew
 * z internetu nie zablokuje dołączania. Ważne 15 minut; przenosi się je na nowe urządzenie (`sync join --invite`).
 */
export async function createInvite(ctx: SyncCtx): Promise<{ invite: string; expires_at: number }> {
  const { st, sec } = load(ctx);
  return http(st.server, "POST", "/v1/invites", { token: sec.token, body: {}, timeoutMs: ctx.timeoutMs });
}

/**
 * To urządzenie opuszcza grupę: kasuje lokalne pliki członkostwa (klucz dostępu, klucze grupy, stan, prośbę).
 * Baza zostaje nietknięta i pamięta swój hub, więc można dołączyć ponownie (`sync join`: nowy numer, własne wiersze
 * pójdą jeszcze raz). Naprawa po „nieznanym kluczu” (hub przywrócony z kopii sprzed dołączenia).
 *
 * Jedyny aktywny admin nie odchodzi bez `abandonGroup`: po nim nikt nie zatwierdzi nowego urządzenia (także jego
 * samego przy ponownym dołączeniu), a bootstrap działa tylko raz. Hub, który tego urządzenia nie zna albo je odciął,
 * niczego tu nie chroni.
 */
export async function leave(
  ctx: SyncCtx,
  o: { abandonGroup?: boolean } = {},
): Promise<{ device: number | null; server: string | null }> {
  const st = readState(ctx);
  const f = files(ctx);
  if (!st && !existsSync(f.join)) throw new SyncError("to urządzenie nie jest w grupie (hipokamp sync status)");
  if (st?.role === "admin" && !o.abandonGroup) {
    let list: DeviceInfo[] | null = null;
    try {
      list = await listDevices(ctx);
    } catch (e) {
      if (!(e instanceof SyncError && (e.status === 401 || e.status === 403)))
        throw new SyncError(
          `nie sprawdzę, czy w grupie zostaje inne urządzenie z rolą admin (${(e as Error).message}); nic nie zmieniłem. Świadome odłączenie mimo to: hipokamp sync leave --yes --abandon-group`,
        );
    }
    if (list && !list.some((d) => d.role === "admin" && d.status === "active" && d.no !== st.device))
      throw new SyncError(
        "to jedyne aktywne urządzenie z rolą admin: po jego odejściu nikt nie zatwierdzi nowego urządzenia (ani ponownego dołączenia tego), a bootstrap działa tylko raz. Nic nie zmieniłem. Najpierw dodaj drugiego admina (na nowym urządzeniu hipokamp sync join, tutaj hipokamp sync add-device <kod> --admin) albo odłącz świadomie: hipokamp sync leave --yes --abandon-group",
      );
  }
  for (const p of [f.secret, f.state, f.join]) if (existsSync(p)) unlinkSync(p);
  return { device: st?.device ?? null, server: st?.server ?? null };
}

export async function revokeDevice(ctx: SyncCtx, no: number): Promise<void> {
  const { st, sec } = load(ctx);
  await http(st.server, "POST", `/v1/devices/${no}/revoke`, { token: sec.token, body: {}, timeoutMs: ctx.timeoutMs });
}

// ---------- kotwice: wykrycie cofniętego dziennika huba ----------

const CURSOR = "sync_cursor";
const CURSOR_ID = "sync_cursor_id";
const PUSH_ANCHOR = "sync_push_anchor";

/** Hub zgubił albo podmienił wpisy, które to urządzenie już zna (np. przywrócony z kopii). */
export class HubRollbackError extends SyncError {}

const parseAnchor = (s: string | null): { seq: number; id: string } | null => {
  const m = /^(\d+):([A-Za-z0-9_-]{43})$/.exec(s ?? "");
  return m ? { seq: Number(m[1]), id: m[2] } : null;
};

/**
 * Sprawdza, czy hub ma pod zapamiętanymi numerami te same wpisy (ostatni odebrany i ostatni własny potwierdzony)
 * i czy zna każde urządzenie, które zna ta baza (najwyższy numer). Inaczej (dziennik cofnięty albo podmieniony, hub
 * przywrócony z kopii) dalsza praca po cichu gubiłaby wpisy albo hub wydałby drugi raz numer urządzenia: zatrzymanie.
 * `raise` (resync): bez porównania; hub podnosi swój najwyższy numer urządzenia do znanego tej bazie.
 * Zwraca najwyższy numer urządzenia znany hubowi i to, czy hub jest w trybie odzyskiwania (po przywróceniu z kopii).
 */
async function verifyHub(
  ctx: SyncCtx,
  st: SyncState,
  sec: SyncSecret,
  o: { raise?: boolean } = {},
): Promise<{ max: number; recovery: boolean }> {
  const db = ctx.repo.db;
  const anchors: { seq: number; id: string; what: string }[] = [];
  const cur = Number(getMeta(db, CURSOR) ?? 0) || 0;
  const curId = getMeta(db, CURSOR_ID);
  if (!o.raise && cur > 0 && curId) anchors.push({ seq: cur, id: curId, what: "odebrało" });
  const pa = o.raise ? null : parseAnchor(getMeta(db, PUSH_ANCHOR));
  if (pa) anchors.push({ ...pa, what: "wysłało" });
  const known = Math.max(knownMaxDevice(ctx.repo), st.device);
  const r = await http<{ head: number; entries: { seq: number; id: string }[]; max_device?: number; recovery?: boolean }>(
    st.server,
    "GET",
    `/v1/anchors?seqs=${anchors.map((a) => a.seq).join(",")}&maxdev=${known}${o.raise ? "&raise=1" : ""}`,
    { token: sec.token, timeoutMs: ctx.timeoutMs ?? 30_000 },
  );
  const hubMax = Number(r.max_device);
  if (!Number.isSafeInteger(hubMax) || hubMax < 1)
    throw new SyncError("hub nie podał najwyższego numeru urządzenia (stara wersja huba?)");
  const have = new Map(r.entries.map((e) => [e.seq, e.id]));
  for (const a of anchors)
    if (r.head < a.seq || have.get(a.seq) !== a.id)
      throw new HubRollbackError(
        `hub nie ma wpisu ${a.seq}, który to urządzenie już ${a.what} (dziennik huba cofnięty, np. przywrócony z kopii, albo podmieniony; najwyższy wpis huba: ${r.head}). Synchronizacja wstrzymana, nic nie zmieniłem. Jeśli hub przywrócono z kopii: hipokamp sync resync (odbiór od początku i ponowna wysyłka wszystkiego, co hub mógł zgubić); w innym razie sprawdź hub (docs/SYNC.md, odzyskiwanie).`,
        409,
        { rollback: true, seq: a.seq, head: r.head },
      );
  const recovery = r.recovery === true;
  if (o.raise) {
    // licznik numerów podnosi tylko admin (członek mógłby nim zablokować dodawanie urządzeń)
    if (st.role !== "admin" && hubMax < known)
      throw new HubRollbackError(
        `hub zna urządzenia najwyżej do nr ${hubMax}, a to urządzenie zna nr ${known}; licznik numerów podnosi tylko admin. Najpierw hipokamp sync resync na urządzeniu z rolą admin (a urządzenia, których hub nie zna, dołączają od nowa: hipokamp sync leave --yes, hipokamp sync join), potem powtórz tu hipokamp sync resync.`,
        409,
        { rollback: true, max_device: hubMax, known },
      );
    return { max: Math.max(hubMax, known), recovery };
  }
  if (hubMax < known)
    throw new HubRollbackError(
      `hub zna urządzenia najwyżej do nr ${hubMax}, a to urządzenie zna nr ${known} (hub przywrócony z kopii albo podmieniony: mógłby wydać drugi raz numer, który ma już inne urządzenie). Synchronizacja i zatwierdzanie urządzeń wstrzymane, nic nie zmieniłem. Jeśli hub przywrócono z kopii: hipokamp sync resync; w innym razie sprawdź hub (docs/SYNC.md, odzyskiwanie).`,
      409,
      { rollback: true, max_device: hubMax, known },
    );
  return { max: hubMax, recovery };
}

// ---------- wysyłka i odbiór ----------

const opKey = (op: Op): string =>
  op.t === "session"
    ? `session|${op.sid}|${sessionHash(op.f)}`
    : op.t === "status"
      ? `status|${op.g}|${op.h}`
      : `${op.t}|${op.g}`;

function prepare(ctx: SyncCtx): { st: SyncState; sec: SyncSecret; hlc: Hlc } {
  const { st, sec } = load(ctx);
  bindHub(ctx.repo, st.hub);
  ensureOwnRange(ctx.repo, st.device);
  return { st, sec, hlc: new Hlc(ctx.repo, st.device, ctx.now) };
}

export interface PushResult {
  ops: number;
  entries: number;
  duplicates: number;
  /** Operacje za duże dla huba (pominięte, zapisane w meta sync_skipped_rows i w `sync status`). */
  skipped: number;
}

const SKIPPED_ROWS = "sync_skipped_rows";
const SKIPPED_ENTRIES = "sync_skipped";

interface SendResult {
  accepted: number;
  duplicates: number;
  stored: { id: string; seq: number }[];
  skipped: Op[];
}

const halves = <T>(a: T[]): T[][] => [a.slice(0, Math.ceil(a.length / 2)), a.slice(Math.ceil(a.length / 2))];

/**
 * Wysyła paczki operacji jako wpisy. Wpis ponad limit huba (413 albo szyfrogram większy niż domyślny limit) albo
 * z treścią większą po rozpakowaniu niż LIMITS.maxEntryPlainBytes dzielimy na pół; pojedyncza operacja, która się nie
 * mieści, jest pomijana i zgłaszana (inaczej blokowałaby wysyłkę na zawsze).
 */
async function sendChunks(ctx: SyncCtx, st: SyncState, sec: SyncSecret, chunks: Op[][]): Promise<SendResult> {
  const out: SendResult = { accepted: 0, duplicates: 0, stored: [], skipped: [] };
  const merge = (r: SendResult) => {
    out.accepted += r.accepted;
    out.duplicates += r.duplicates;
    out.stored.push(...r.stored);
    out.skipped.push(...r.skipped);
  };
  const fit: { ops: Op[]; wire: WireEntry }[] = [];
  for (const ops of chunks) {
    const id = entryId(sec.keys, `${st.hub}|${st.device}|${ops.map(opKey).join("\n")}`);
    const { kid, ct, plain } = sealEntry(sec.keys, st.hub, id, { v: PAYLOAD_VERSION, dev: st.device, ops });
    // dwie granice: szyfrogram dla huba i treść po rozpakowaniu dla odbiorców (openEntry odrzuci większą)
    if (Buffer.byteLength(ct, "base64") <= LIMITS.maxEntryBytes && plain <= LIMITS.maxEntryPlainBytes)
      fit.push({ ops, wire: { id, kid, v: ENTRY_VERSION, ct } });
    else if (ops.length > 1) merge(await sendChunks(ctx, st, sec, halves(ops)));
    else out.skipped.push(ops[0]);
    await breathe(); // kompresja i szyfrowanie wpisu do 512 KB to kilka ms: przerwa między wpisami
  }
  if (!fit.length) return out;
  try {
    const r = await http<{ accepted: number; duplicates: number; stored: { id: string; seq: number }[] }>(
      st.server,
      "POST",
      "/v1/entries",
      { token: sec.token, body: { entries: fit.map((c) => c.wire) }, timeoutMs: ctx.timeoutMs ?? 120_000 },
    );
    merge({ accepted: r.accepted, duplicates: r.duplicates, stored: r.stored ?? [], skipped: [] });
  } catch (e) {
    if (!(e instanceof SyncError && e.status === 413)) throw e;
    // hub z niższymi limitami niż domyślne: po połowie, aż do pojedynczej operacji
    if (fit.length > 1)
      for (const part of halves(fit))
        merge(
          await sendChunks(
            ctx,
            st,
            sec,
            part.map((c) => c.ops),
          ),
        );
    else if (fit[0].ops.length > 1) merge(await sendChunks(ctx, st, sec, halves(fit[0].ops)));
    else out.skipped.push(fit[0].ops[0]);
  }
  return out;
}

function recordSkippedRows(ctx: SyncCtx, ops: Op[]): void {
  if (!ops.length) return;
  const db = ctx.repo.db;
  const prev = JSON.parse(getMeta(db, SKIPPED_ROWS) ?? "[]") as unknown[];
  const add = ops.map((op) => ({
    t: op.t,
    ref: op.t === "session" ? op.sid : op.g,
    bytes: JSON.stringify(op).length,
    at: ctx.now?.() ?? Date.now(),
  }));
  setMeta(db, SKIPPED_ROWS, JSON.stringify([...prev, ...add].slice(-100)));
}

/**
 * Wysyła wszystkie własne zmiany, partiami; wiersz liczy się jako wysłany dopiero po potwierdzeniu przez hub.
 * `resend`: także to, co hub już kiedyś przyjął (odbudowa po cofnięciu dziennika huba, zob. resync).
 */
export async function push(ctx: SyncCtx, o: { resend?: boolean; verify?: boolean } = {}): Promise<PushResult> {
  const { st: st0, sec, hlc } = prepare(ctx);
  let st = st0;
  const { lo, hi } = idRange(st.device);
  // baza cofnięta w czasie (przywrócona kopia): ostatnio wysłany własny numer nie jest już znany jako wysłany, a nowe
  // notatki dostają numery, które hub zna z inną treścią. Najpierw pull --full odtwarza tamte wiersze i mapę.
  const seq = ownSeq(ctx.repo);
  const rolledBack = (kind: "obs" | "sum", n: number) =>
    n >= lo && n <= hi && (seq[kind] < n || !isMapped(ctx.repo, kind, `${st.device}:${n}`));
  if (st.hwm && (rolledBack("obs", st.hwm.obs) || rolledBack("sum", st.hwm.sum)))
    throw new SyncError("baza nie zna ostatnio wysłanych notatek (przywrócona kopia?): najpierw hipokamp sync pull --full");
  if (o.verify !== false) await verifyHub(ctx, st, sec);
  const exclude = ctx.exclude ?? loadConfig().sync.excludeProjects;
  const cur = newCursor();
  const out: PushResult = { ops: 0, entries: 0, duplicates: 0, skipped: 0 };
  let previous = "";
  for (;;) {
    const b = collectBatch(ctx.repo, st.device, hlc, cur, {
      maxBytes: REQUEST_RAW_BYTES,
      exclude,
      resend: o.resend,
      budgetMs: ctx.collectMs,
    });
    if (!b.ops.length) {
      if (!b.more) break;
      await breathe(); // przegląd przerwany budżetem czasu bez zmian do wysłania: dalej po przerwie
      continue;
    }
    // bezpiecznik: ta sama partia drugi raz znaczy, że potwierdzenie nic nie zmieniło (pętla bez końca)
    const keys = b.ops.map((op) => (op.t === "status" ? `status|${op.g}|${op.s}|${op.into}|${op.by}` : opKey(op))).join("\n");
    if (keys === previous) throw new SyncError("wysyłka nie posuwa się naprzód (ta sama partia drugi raz); zgłoś błąd");
    previous = keys;
    const chunks: Op[][] = [];
    let cur2: Op[] = [];
    let size = 0;
    for (const op of b.ops) {
      const n = JSON.stringify(op).length;
      if (cur2.length && size + n > ENTRY_RAW_BYTES) {
        chunks.push(cur2);
        cur2 = [];
        size = 0;
      }
      cur2.push(op);
      size += n;
    }
    if (cur2.length) chunks.push(cur2);
    const r = await sendChunks(ctx, st, sec, chunks);
    // potwierdzona partia: znaczniki „wysłane”, kotwica dziennika i najwyższy własny numer od razu (przerwana pierwsza
    // wysyłka ponad 100 tys. notatek nie zostawia wykrywania przywróconej kopii bazy wyłączonego)
    commitMarks(ctx.repo, st.device, b.marks);
    recordSkippedRows(ctx, r.skipped);
    const last = r.stored.reduce<{ id: string; seq: number } | null>((m, x) => (!m || x.seq > m.seq ? x : m), null);
    if (last) setMeta(ctx.repo.db, PUSH_ANCHOR, `${last.seq}:${last.id}`);
    const hwm = { obs: st.hwm?.obs ?? 0, sum: st.hwm?.sum ?? 0 };
    for (const m of b.marks)
      if (m.k === "map" && (m.kind === "obs" || m.kind === "sum") && m.local >= lo && m.local <= hi)
        hwm[m.kind] = Math.max(hwm[m.kind], m.local);
    if (hwm.obs !== (st.hwm?.obs ?? 0) || hwm.sum !== (st.hwm?.sum ?? 0)) {
      st = { ...st, hwm };
      writePrivate(files(ctx).state, st);
    }
    out.ops += b.ops.length - r.skipped.length;
    out.entries += r.accepted;
    out.duplicates += r.duplicates;
    out.skipped += r.skipped.length;
    await breathe(); // zapis znaczników partii i następne zbieranie nie idą jednym ciągiem
  }
  setMeta(ctx.repo.db, "sync_last_push_at", String(ctx.now?.() ?? Date.now()));
  return out;
}

export interface PullResult extends ApplyStats {
  entries: number;
  /** Wpisy z uszkodzonym albo podmienionym szyfrogramem: pominięte (numery w meta sync_bad). */
  bad: number;
  /** Wpisy nieczytelne dla tej wersji (nowsza koperta albo treść, nieznany klucz grupy): pominięte i zapamiętane. */
  unreadable: number;
  cursor: number;
}

const BAD_KEY = "sync_bad";

interface Payload {
  v?: number;
  dev?: number;
  ops?: Op[];
}

/** Wpis pominięty, bo ta wersja go nie czyta; po aktualizacji albo po otrzymaniu klucza wraca sam (retrySkipped). */
interface SkippedEntry {
  seq: number;
  why: "v" | "pv" | "kid";
  need: number | string;
}

type Outcome = { ok: Payload & { ops: Op[] } } | { bad: true } | { skip: SkippedEntry };

/** Odczyt wpisu: treść, uszkodzony szyfrogram (albo treść podpisana jako inne urządzenie) albo wpis nieczytelny. */
function readEntry(keys: Keyring, hub: string, e: PulledEntry): Outcome {
  if (e.v !== ENTRY_VERSION) return { skip: { seq: e.seq, why: "v", need: e.v } };
  let p: Payload | null;
  try {
    p = openEntry(keys, hub, e) as Payload | null;
  } catch (err) {
    if (err instanceof UnknownKeyError) return { skip: { seq: e.seq, why: "kid", need: err.kid } };
    return { bad: true };
  }
  if (!p || typeof p !== "object" || p.dev !== e.dev) return { bad: true };
  if (p.v !== PAYLOAD_VERSION || !Array.isArray(p.ops)) return { skip: { seq: e.seq, why: "pv", need: Number(p.v) || 0 } };
  return { ok: p as Payload & { ops: Op[] } };
}

const readable = (s: Pick<SkippedEntry, "why" | "need">, keys: Keyring) =>
  s.why === "v" ? s.need === ENTRY_VERSION : s.why === "pv" ? s.need === PAYLOAD_VERSION : keys.some((k) => k.kid === s.need);

/**
 * Wpisy nieczytelne ponad listę `sync_skipped` (najstarsze wypadają z listy): zakres numerów i potrzebne wersje albo
 * klucze. Gdy któraś potrzeba staje się czytelna, odbiór przegląda cały zakres jeszcze raz (operacje są idempotentne),
 * więc po aktualizacji żaden pominięty wpis nie zostaje za listą.
 */
const SKIPPED_OVERFLOW = "sync_skipped_overflow";

interface SkipOverflow {
  min: number;
  max: number;
  needs: { why: SkippedEntry["why"]; need: number | string }[];
}

function readOverflow(db: Repo["db"]): SkipOverflow | null {
  try {
    const o = JSON.parse(getMeta(db, SKIPPED_OVERFLOW) || "null");
    return o && Number.isSafeInteger(o.min) && Number.isSafeInteger(o.max) && Array.isArray(o.needs) ? o : null;
  } catch {
    return null;
  }
}

function overflowOf(list: SkippedEntry[], prev: SkipOverflow | null = null): SkipOverflow | null {
  if (!list.length) return prev;
  const needs = new Map<string, SkipOverflow["needs"][number]>();
  for (const n of [...(prev?.needs ?? []), ...list.map((s) => ({ why: s.why, need: s.need }))])
    needs.set(`${n.why}:${n.need}`, n);
  const seqs = list.map((s) => s.seq);
  return {
    min: Math.min(prev?.min ?? Number.POSITIVE_INFINITY, ...seqs),
    max: Math.max(prev?.max ?? 0, ...seqs),
    needs: [...needs.values()],
  };
}

/** Zapamiętanie pominiętego wpisu: lista ostatnich (do pokazania i szybkiego dociągnięcia), starsze jako zakres. */
function rememberSkipped(ctx: SyncCtx, skip: SkippedEntry): void {
  const db = ctx.repo.db;
  const cap = Math.max(1, ctx.skipListMax ?? 500);
  const list = [...(JSON.parse(getMeta(db, SKIPPED_ENTRIES) ?? "[]") as SkippedEntry[]).filter((s) => s.seq !== skip.seq), skip];
  const keep = list.slice(-cap);
  const dropped = list.slice(0, list.length - keep.length);
  if (dropped.length) setMeta(db, SKIPPED_OVERFLOW, JSON.stringify(overflowOf(dropped, readOverflow(db))));
  setMeta(db, SKIPPED_ENTRIES, JSON.stringify(keep));
}

/** Wynik jednego wpisu doliczony do wyniku odbioru (liczniki sumą, najdalszy zegar maksimum). */
function addStats(out: ApplyStats, es: ApplyStats): void {
  for (const k of Object.keys(es) as (keyof ApplyStats)[]) out[k] = k === "futureMax" ? Math.max(out[k], es[k]) : out[k] + es[k];
}

/** Budżet jednej transakcji odbioru (ms): pętla workera i hooki czekają na bazę najwyżej tyle, a nie cały wpis. */
const SLICE_MS = 40;

/**
 * Stosuje operacje wpisu kawałkami po ok. SLICE_MS, każdy w osobnej transakcji, z oddechem dla pętli zdarzeń między
 * nimi; `finish` (kursor) idzie w transakcji ostatniego kawałka. Przerwanie w środku zostawia kursor przed wpisem:
 * następny odbiór stosuje go od początku, a operacje są idempotentne.
 */
async function applyEntry(
  ctx: SyncCtx,
  st: SyncState,
  hlc: Hlc,
  ops: Op[],
  dev: number,
  out: ApplyStats,
  finish?: () => void,
): Promise<void> {
  const db = ctx.repo.db;
  const budget = ctx.sliceMs ?? SLICE_MS;
  let i = 0;
  for (;;) {
    const t = performance.now();
    db.transaction(() => {
      i = applySlice(ctx.repo, st.device, hlc, ops, dev, out, i, budget);
      if (i >= ops.length) finish?.();
    }).immediate();
    ctx.onSlice?.(performance.now() - t);
    if (i >= ops.length) return;
    await breathe(); // przerwa między kawałkami (src/util/slice.ts): w track(…, { sliced }) zamyka kawałek diagnostyki
  }
}

/**
 * Wpis dociągnięty poza kursorem (wcześniej nieczytelny): ślad odrzuceń za zegar dopisany w transakcji ostatniego
 * kawałka wpisu, więc przerwany odbiór go nie gubi (wpis wróci w całości przy następnym).
 */
async function applyOneRetried(ctx: SyncCtx, st: SyncState, hlc: Hlc, ops: Op[], dev: number, out: ApplyStats): Promise<void> {
  const es = emptyStats();
  await applyEntry(ctx, st, hlc, ops, dev, es, () =>
    traceClockRejected(ctx.repo, es.future, es.futureMax, ctx.now?.() ?? Date.now(), false),
  );
  addStats(out, es);
}

/**
 * Wpisy pominięte wcześniej, które ta wersja (albo nowy klucz) już czyta: z listy dociągnięcie pojedynczo, bez
 * kursora; zakres ponad listą (SKIPPED_OVERFLOW) przegląda się od najniższego numeru.
 */
async function retrySkipped(ctx: SyncCtx, st: SyncState, sec: SyncSecret, hlc: Hlc, out: PullResult): Promise<void> {
  const db = ctx.repo.db;
  const list = JSON.parse(getMeta(db, SKIPPED_ENTRIES) ?? "[]") as SkippedEntry[];
  const todo = list.filter((s) => readable(s, sec.keys));
  const done = new Set<number>();
  for (const s of todo) {
    const r = await http<{ entries: PulledEntry[] }>(st.server, "GET", `/v1/entries?after=${s.seq - 1}&limit=1&own=1`, {
      token: sec.token,
      timeoutMs: ctx.timeoutMs ?? 120_000,
    });
    const e = r.entries.find((x) => x.seq === s.seq);
    if (!e) {
      done.add(s.seq); // hub już go nie ma
      continue;
    }
    const x = readEntry(sec.keys, st.hub, e);
    if ("skip" in x) continue;
    if ("ok" in x) {
      await applyOneRetried(ctx, st, hlc, x.ok.ops, e.dev, out);
      out.entries++;
    } else out.bad++;
    done.add(s.seq);
  }
  if (done.size) setMeta(db, SKIPPED_ENTRIES, JSON.stringify(list.filter((s) => !done.has(s.seq))));

  const ov = readOverflow(db);
  if (!ov?.needs.some((n) => readable(n, sec.keys))) return;
  const still: SkippedEntry[] = [];
  let after = ov.min - 1;
  scan: for (;;) {
    const r = await http<{ entries: PulledEntry[]; more: boolean }>(st.server, "GET", `/v1/entries?after=${after}&limit=100`, {
      token: sec.token,
      timeoutMs: ctx.timeoutMs ?? 120_000,
    });
    for (const e of r.entries) {
      if (e.seq > ov.max) break scan;
      const x = readEntry(sec.keys, st.hub, e);
      if ("ok" in x) {
        await applyOneRetried(ctx, st, hlc, x.ok.ops, e.dev, out);
        out.entries++;
      } else if ("skip" in x) still.push(x.skip);
      after = e.seq;
      await breathe();
    }
    if (!r.more || !r.entries.length) break;
  }
  setMeta(db, SKIPPED_OVERFLOW, still.length ? JSON.stringify(overflowOf(still)) : "");
}

/**
 * Dociąga cudze wpisy od kursora i stosuje je kawałkami (applyEntry); kursor (numer i identyfikator wpisu) zapisuje
 * się w transakcji ostatniego kawałka operacji wpisu. `full`: od początku, razem z własnymi wpisami (odtworzenie po przywróceniu kopii
 * bazy). Wpis nieczytelny dla tej wersji jest pomijany i zapamiętany; wraca sam po aktualizacji.
 */
export async function pull(ctx: SyncCtx, o: { full?: boolean; verify?: boolean } = {}): Promise<PullResult> {
  const { st, sec, hlc } = prepare(ctx);
  const db = ctx.repo.db;
  if (o.verify !== false) await verifyHub(ctx, st, sec);
  let cursor = o.full ? 0 : Number(getMeta(db, CURSOR) ?? 0) || 0;
  const out: PullResult = { ...emptyStats(), entries: 0, bad: 0, unreadable: 0, cursor };
  await retrySkipped(ctx, st, sec, hlc, out);
  let maxDev = knownMaxDevice(ctx.repo);
  // ślad odrzuceń za zegar z przyszłości (T-37) idzie w transakcji kursora każdego wpisu: przerwany odbiór (błąd
  // huba na dalszej stronie, zabity worker) nie gubi śladu wpisów, za którymi kursor już poszedł. Odbiór od
  // początku dziennika (pull --full, resync, pierwszy odbiór po dołączeniu) ślad zastępuje przy pierwszym wpisie,
  // więc te same operacje nie liczą się drugi raz, a odbiór od zera bez odrzuceń go czyści
  let replaceTrace = cursor === 0;
  const advance = (e: PulledEntry, es: ApplyStats = emptyStats()) => {
    traceClockRejected(ctx.repo, es.future, es.futureMax, ctx.now?.() ?? Date.now(), replaceTrace);
    replaceTrace = false;
    setMeta(db, CURSOR, String(e.seq));
    setMeta(db, CURSOR_ID, e.id);
    // numer urządzenia, które wysłało wpis: od teraz ta baza go zna (wykrycie huba, który go zapomni)
    if (validDevice(e.dev) && e.dev > maxDev) {
      maxDev = e.dev;
      noteDevice(ctx.repo, e.dev);
    }
  };
  for (;;) {
    const r = await http<{ entries: PulledEntry[]; more: boolean; head: number }>(
      st.server,
      "GET",
      `/v1/entries?after=${cursor}&limit=100${o.full ? "&own=1" : ""}`,
      { token: sec.token, timeoutMs: ctx.timeoutMs ?? 120_000 },
    );
    for (const e of r.entries) {
      const x = readEntry(sec.keys, st.hub, e);
      if ("ok" in x) {
        const es = emptyStats();
        await applyEntry(ctx, st, hlc, x.ok.ops, e.dev, es, () => advance(e, es));
        addStats(out, es);
        out.entries++;
      } else if ("bad" in x) {
        const bad = JSON.parse(getMeta(db, BAD_KEY) ?? "[]") as number[];
        db.transaction(() => {
          setMeta(db, BAD_KEY, JSON.stringify([...bad, e.seq].slice(-100)));
          advance(e);
        }).immediate();
        out.bad++;
      } else {
        db.transaction(() => {
          rememberSkipped(ctx, x.skip);
          advance(e);
        }).immediate();
        out.unreadable++;
      }
      cursor = e.seq;
      await breathe(); // oddech dla pętli zdarzeń (worker odpowiada hookom w trakcie)
    }
    if (!r.more || !r.entries.length) break;
  }
  out.cursor = cursor;
  const now = ctx.now?.() ?? Date.now();
  // odbiór od zera bez żadnego wpisu (pusty dziennik): nic nie jest odrzucone
  if (replaceTrace) traceClockRejected(ctx.repo, 0, 0, now, true);
  setMeta(db, "sync_last_pull_at", String(now));
  return out;
}

/**
 * Odbudowa po cofnięciu dziennika huba (np. przywrócenie huba z kopii): zapomina kursor i kotwice starego dziennika,
 * wysyła ponownie wszystko, co hub mógł zgubić (własne wiersze pod tymi samymi gid, własne sesje, rejestry statusów),
 * i odbiera od początku. Operacje są idempotentne, więc to, co hub i odbiorcy już mają, nic nie zmienia.
 * Resync admina włącza na hubie tryb odzyskiwania: nowe urządzenia dopiero po resync każdego admina i potwierdzeniu
 * (`add-device --ack-lost-devices`, docs/SYNC.md, sekcja 9).
 */
export async function resync(ctx: SyncCtx): Promise<{ push: PushResult; pull: PullResult; recovery: boolean }> {
  const db = ctx.repo.db;
  const { st, sec } = load(ctx);
  db.transaction(() => {
    setMeta(db, CURSOR, "0");
    setMeta(db, CURSOR_ID, "");
    setMeta(db, PUSH_ANCHOR, "");
  }).immediate();
  // hub przywrócony z kopii zapomniał też urządzenia dołączone po kopii: admin podnosi jego najwyższy numer do
  // znanego tu, więc hub nie wyda go drugi raz (członek tylko się zgłasza)
  const { recovery } = await verifyHub(ctx, st, sec, { raise: true });
  const p = await push(ctx, { resend: true, verify: false });
  const q = await pull(ctx, { verify: false });
  return { push: p, pull: q, recovery };
}

export interface SyncStatus {
  state: SyncState | null;
  join: ReturnType<typeof pendingJoin>;
  enabled: boolean;
  cursor: number;
  head: number | null;
  bad: number[];
  /** Wpisy pominięte jako nieczytelne dla tej wersji (wrócą po aktualizacji albo z kluczem). */
  unreadable: SkippedEntry[];
  /** Starsze nieczytelne wpisy ponad listę: zakres numerów (wrócą tak samo). */
  unreadableOlder: { min: number; max: number } | null;
  /** Własne operacje za duże dla huba (pominięte przy wysyłce). */
  skippedRows: { t: string; ref: string; bytes: number }[];
  lastPushAt: number | null;
  lastPullAt: number | null;
  pending: Record<string, number> | null;
  kids: string[];
  devices: (DeviceInfo & { entries: number; bytes: number })[] | null;
  /** Dziennik huba cofnięty albo podmieniony (synchronizacja wstrzymana do `sync resync`). */
  rollback: string | null;
  /** Hub w trybie odzyskiwania po przywróceniu z kopii (zatwierdzanie urządzeń wstrzymane, docs/SYNC.md, sekcja 9). */
  recovery: boolean;
  /** Ostrzeżenia zegara z instrukcją naprawy (T-37, store.ts clockWarnings). */
  clock: string[];
  error: string | null;
}

/** Stan synchronizacji bez sekretów (identyfikatory kluczy grupy zamiast kluczy). */
export async function syncStatus(ctx: SyncCtx): Promise<SyncStatus> {
  const db = ctx.repo.db;
  const st = readState(ctx);
  const num = (k: string) => (getMeta(db, k) ? Number(getMeta(db, k)) : null);
  const out: SyncStatus = {
    state: st,
    join: pendingJoin(ctx),
    enabled: loadConfig().sync.enabled,
    cursor: num(CURSOR) ?? 0,
    head: null,
    bad: JSON.parse(getMeta(db, BAD_KEY) ?? "[]"),
    unreadable: JSON.parse(getMeta(db, SKIPPED_ENTRIES) ?? "[]"),
    unreadableOlder: (() => {
      const o = readOverflow(db);
      return o ? { min: o.min, max: o.max } : null;
    })(),
    skippedRows: JSON.parse(getMeta(db, SKIPPED_ROWS) ?? "[]"),
    lastPushAt: num("sync_last_push_at"),
    lastPullAt: num("sync_last_pull_at"),
    pending: st ? pendingCounts(ctx.repo, st.device, ctx.exclude ?? loadConfig().sync.excludeProjects) : null,
    kids: (readSecret(ctx)?.keys ?? []).map((k) => k.kid),
    devices: null,
    rollback: null,
    recovery: false,
    clock: st ? clockWarnings(ctx.repo, ctx.now?.() ?? Date.now()).map((w) => w.text) : [],
    error: null,
  };
  if (!st) return out;
  try {
    const sec = load(ctx).sec;
    out.devices = await http(st.server, "GET", "/v1/devices", { token: sec.token, timeoutMs: ctx.timeoutMs ?? 10_000 });
    const r = await http<{ head: number }>(st.server, "GET", `/v1/entries?after=${out.cursor}&limit=1`, {
      token: sec.token,
      timeoutMs: ctx.timeoutMs ?? 10_000,
    });
    out.head = r.head;
    out.recovery = (await verifyHub(ctx, st, sec)).recovery;
  } catch (e) {
    if (e instanceof HubRollbackError) out.rollback = e.message;
    else out.error = String((e as Error).message ?? e);
  }
  return out;
}

/**
 * Jeden obieg w tle (worker, sync.enabled): wysyłka, potem odbiór. null = synchronizacja nieskonfigurowana.
 * `clock`: ostrzeżenia zegara po udanym obiegu (T-37); SyncScheduler zapisuje je w logu raz, nie co obieg.
 * Ten sam stan pokazują `sync status` i `doctor`.
 */
export async function backgroundSync(
  repo: Repo,
  stateDir?: string,
): Promise<{ push: PushResult; pull: PullResult; clock: ReturnType<typeof clockWarnings> } | null> {
  // zbieranie zmian kawałkami jak odbiór: worker obsługuje w tym czasie hooki
  const ctx: SyncCtx = { repo, stateDir, collectMs: SLICE_MS };
  if (!readState(ctx)) return null;
  const p = await push(ctx);
  const q = await pull(ctx, { verify: false }); // push właśnie sprawdził kotwice
  return { push: p, pull: q, clock: clockWarnings(repo) };
}
