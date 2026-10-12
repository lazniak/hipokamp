// Token podglądu (T-34). Trasy `/api/*` workera wymagają albo dowodu klienta z kluczem (T-17, auth.ts), albo
// ciasteczka podglądu. Przeglądarka klucza nie zna (klucz w stronie dostałby każdy jej skrypt), więc:
//
//   1. `hipokamp open` (klient z kluczem) wybija bilet: `<termin>.<losowe 16 bajtów>.<HMAC(klucz, "ticket", port, …)>`,
//      ważny TICKET_TTL_MS, i otwiera http://127.0.0.1:<port>/auth?t=<bilet>;
//   2. worker sprawdza bilet (stały czas, jednorazowy: losowa część trafia do zużytych do końca terminu) i odpowiada
//      303 na `/` z ciasteczkiem `HttpOnly; SameSite=Strict; Path=/`; adres z biletem znika z paska po przekierowaniu;
//   3. ciasteczko `<chwila wydania>.<losowe 16 bajtów>.<HMAC(klucz, "cookie", port, …)>` żyje COOKIE_MAX_AGE_S.
//
// Bez nowego sekretu na dysku: bilet i ciasteczko wyprowadza HMAC z klucza workera z osobnym protokołem i etykietą,
// więc żadnego nie da się podać jako dowodu T-17 ani odwrotnie. Bezstanowe ciasteczko przeżywa restart workera
// (worker po bezczynności wychodzi). Unieważnienie wszystkich ciasteczek: nowy klucz workera (usunięcie
// `state/worker.key` i restart). Moduł bez procesów potomnych i bez konfiguracji: importuje go worker (zasada 2).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Wymiana biletu na ciasteczko (poza `/api/`, bo to nawigacja przeglądarki, nie wywołanie API). */
export const VIEWER_AUTH_PATH = "/auth";
/** Wersja protokołu (zmiana = stare bilety i ciasteczka przestają pasować). */
const PROTOCOL = "hipokamp-viewer-1";
/** Bilet żyje tyle: przeglądarka na zimno potrafi startować kilkanaście sekund. */
export const TICKET_TTL_MS = 120_000;
/** Ciasteczko żyje 30 dni; `hipokamp open` wydaje nowe. */
export const COOKIE_MAX_AGE_S = 30 * 86_400;
/** Zapas na różnicę zegarów między procesami tej samej maszyny (ciasteczko „z przyszłości”). */
const SKEW_MS = 60_000;
const TOKEN_RE = /^(\d{1,15})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

type Label = "ticket" | "cookie";

/**
 * Nazwa ciasteczka z numerem portu: przeglądarka nie rozdziela ciasteczek po portach, a worker testowy albo drugi
 * katalog danych na innym porcie nie może nadpisać ciasteczka głównego podglądu.
 */
export const cookieName = (port: number) => `hipokamp_viewer_${port}`;

function mac(key: Buffer, label: Label, port: number, parts: string[]): string {
  return createHmac("sha256", key)
    .update([PROTOCOL, label, String(port), ...parts].join("\n"))
    .digest("hex");
}

/** Token `<czas>.<losowe>.<HMAC>` z poprawnym podpisem (porównanie stałoczasowe); null, gdy format albo podpis zły. */
function parse(key: Buffer, label: Label, port: number, token: unknown): { at: number; rand: string } | null {
  if (typeof token !== "string") return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const good = Buffer.from(mac(key, label, port, [m[1], m[2]]), "hex");
  if (!timingSafeEqual(good, Buffer.from(m[3], "hex"))) return null;
  return { at: Number(m[1]), rand: m[2] };
}

function mint(key: Buffer, label: Label, port: number, at: number): string {
  const rand = randomBytes(16).toString("hex");
  return `${at}.${rand}.${mac(key, label, port, [String(at), rand])}`;
}

/** Bilet do jednorazowej wymiany na ciasteczko (wybija klient z kluczem: `hipokamp open`). */
export const mintTicket = (key: Buffer, port: number, now = Date.now()): string => mint(key, "ticket", port, now + TICKET_TTL_MS);

/** Wartość ciasteczka podglądu (wydaje worker po wymianie biletu). */
export const mintCookie = (key: Buffer, port: number, now = Date.now()): string => mint(key, "cookie", port, now);

/** Ciasteczko z poprawnym podpisem, wydane najwyżej COOKIE_MAX_AGE_S temu (i nie z przyszłości). */
export function verifyCookie(key: Buffer, port: number, value: unknown, now = Date.now()): boolean {
  const c = parse(key, "cookie", port, value);
  return !!c && c.at <= now + SKEW_MS && now - c.at < COOKIE_MAX_AGE_S * 1000;
}

/**
 * Wszystkie wartości ciasteczka `name` z nagłówka Cookie. Przeglądarka nie rozdziela ciasteczek po portach: strona
 * z innego portu 127.0.0.1 może podrzucić ciasteczko o tej samej nazwie z dłuższą ścieżką, które przyjdzie pierwsze.
 */
export function readCookies(header: string | null, name: string): string[] {
  const out: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** Czy którekolwiek ciasteczko podglądu w nagłówku Cookie jest ważne (podrzucone śmieci obok nie blokują wejścia). */
export const cookieHeaderOk = (key: Buffer, port: number, header: string | null, now = Date.now()): boolean =>
  readCookies(header, cookieName(port)).some((v) => verifyCookie(key, port, v, now));

/** Nagłówek Set-Cookie: tylko HTTP (skrypt strony go nie przeczyta), tylko to samo źródło, cały podgląd. */
export const setCookieHeader = (port: number, value: string): string =>
  `${cookieName(port)}=${value}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict`;

/**
 * Po stronie workera: losowe części zużytych biletów do końca ich terminu, więc każdy bilet działa najwyżej raz
 * (także po nieudanej wymianie w drugiej karcie). Mapa żyje w pamięci, więc bilet wybity przed startem tego workera
 * jest odrzucany zawsze (restart nie daje drugiego użycia; `hipokamp open` wybija bilet dopiero, gdy worker działa).
 * Pełna mapa (same żywe bilety) odrzuca nowe: zużytego nie wolno zapomnieć przed terminem, a bez klucza nikt nie
 * wybije biletu, który w ogóle do niej trafi.
 */
export class TicketStore {
  private used = new Map<string, number>();
  constructor(
    private startedAt = Date.now(),
    private max = 1024,
  ) {}

  redeem(key: Buffer, port: number, ticket: unknown, now = Date.now()): boolean {
    const t = parse(key, "ticket", port, ticket);
    // termin w przeszłości albo dalej niż TTL od teraz (bilet z przyszłości nie żyje dłużej niż zwykły)
    if (!t || t.at <= now || t.at > now + TICKET_TTL_MS + SKEW_MS) return false;
    // wybity przed startem workera: mógł być zużyty przez poprzedni proces
    if (t.at - TICKET_TTL_MS < this.startedAt) return false;
    for (const [k, exp] of this.used) if (exp <= now) this.used.delete(k);
    if (this.used.has(t.rand) || this.used.size >= this.max) return false;
    this.used.set(t.rand, t.at);
    return true;
  }

  get size(): number {
    return this.used.size;
  }
}
