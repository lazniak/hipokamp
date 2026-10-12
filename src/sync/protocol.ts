// Protokół synchronizacji (klient i serwer). Bez zależności od reszty hipokampa: serwer na VPS kopiuje tylko
// src/sync/server.ts i ten plik. Szczegóły i kompromisy: docs/SYNC.md.
import { createHash, timingSafeEqual } from "node:crypto";

/** Wersja protokołu HTTP (nagłówek x-hipokamp-sync). Serwer odrzuca inne wersje kodem 426. */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = "x-hipokamp-sync";
/** Wersja koperty wpisu (pole `v` widoczne dla serwera) i treści po odszyfrowaniu. */
export const ENTRY_VERSION = 1;
export const PAYLOAD_VERSION = 1;

/** Domyślne limity serwera (nadpisywane zmiennymi środowiskowymi, zob. server.ts). */
export const LIMITS = {
  /** Największe ciało żądania (POST /v1/entries). */
  maxBodyBytes: 8 * 1024 * 1024,
  /** Największy szyfrogram jednego wpisu. */
  maxEntryBytes: 2 * 1024 * 1024,
  /**
   * Największa treść wpisu po rozpakowaniu (JSON). Pilnuje jej klient: nadawca nie wysyła większej, odbiorca przerywa
   * rozpakowanie po tej granicy i traktuje wpis jak uszkodzony szyfrogram (bomba deflate: kilka KB → gigabajty).
   */
  maxEntryPlainBytes: 4 * 1024 * 1024,
  /** Wpisów w jednym żądaniu. */
  maxEntriesPerPush: 64,
  /** Odpowiedź GET /v1/entries: najwyżej tyle wpisów i bajtów. */
  maxPullEntries: 200,
  maxPullBytes: 8 * 1024 * 1024,
  /** Cały magazyn huba. */
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  /** Żądań na minutę na urządzenie (pierwsza wysyłka 110 tys. notatek to ok. 20 żądań). */
  ratePerMin: 600,
  /** Żądań na minutę bez klucza urządzenia z jednego adresu IP (health, bootstrap). */
  anonRatePerMin: 60,
  /** Nowych próśb o dołączenie z jednego adresu IP na 15 minut. */
  joinsPerIpPer15Min: 5,
  /** Odpytań jednej prośby przez samo urządzenie na minutę (osobny kubełek: zalew z innych adresów go nie głodzi). */
  pollRatePerMin: 60,
  /**
   * Prośba o dołączenie wygasa po tylu ms; oczekujących bez zaproszenia naraz najwyżej tyle (łącznie i z jednego
   * adresu IP albo podsieci IPv6 /64). Prośby z zaproszeniem admina (`sync invite`) mają własną pulę miejsc.
   */
  joinTtlMs: 15 * 60_000,
  maxPendingJoins: 50,
  maxPendingJoinsPerIp: 3,
  /** Aktywnych zaproszeń naraz (każde jednorazowe, ważne jak prośba). */
  maxInvites: 10,
  /** Kubełków limitów w pamięci huba (najdawniej używane wypadają pierwsze). */
  maxBuckets: 10_000,
  /**
   * O ile `sync resync` admina może podnieść najwyższy numer urządzenia ponad najwyższy numer na liście urządzeń huba
   * (hub z kopii nie zna tylko urządzeń dołączonych po kopii; więcej to błąd albo próba zablokowania numeracji).
   */
  maxDeviceRaise: 1000,
  /** Zapieczętowany klucz dla nowego urządzenia: górny limit rozmiaru. */
  maxSealedBytes: 16 * 1024,
};

export type Role = "admin" | "member";

/** Wpis dziennika w postaci przesyłanej po HTTP (szyfrogram w base64). */
export interface WireEntry {
  /** Nieprzezroczysty identyfikator (HMAC z kluczem grupy); powtórka tego samego wpisu nic nie dodaje. */
  id: string;
  /** Identyfikator klucza grupy, którym zaszyfrowano wpis. */
  kid: string;
  /** Wersja koperty. */
  v: number;
  ct: string;
}

export interface PulledEntry extends WireEntry {
  seq: number;
  /** Numer urządzenia, które wysłało wpis (serwer zna go z klucza dostępu). */
  dev: number;
}

export interface DeviceInfo {
  no: number;
  name: string;
  role: Role;
  status: "active" | "revoked";
  created_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
}

// --- formaty pól (walidacja po obu stronach)

/** Klucz dostępu urządzenia: prefiks hks_ (łatwy do wyłapania przez skanery sekretów) i 32 losowe bajty. */
export const TOKEN_RE = /^hks_[A-Za-z0-9_-]{43}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const ENTRY_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const KID_RE = /^[0-9a-f]{8}$/;
export const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export const B64URL_RE = /^[A-Za-z0-9_-]+$/;
export const JOIN_ID_RE = /^[a-z2-7]{16}$/;
export const NAME_RE = /^[\p{L}\p{N} ._-]{1,40}$/u;
/** Identyfikator huba (12 losowych bajtów w base64url). */
export const HUB_ID_RE = /^[A-Za-z0-9_-]{16}$/;
/** Zaproszenie admina do dołączenia (16 losowych bajtów), nagłówek INVITE_HEADER przy POST /v1/join. */
export const INVITE_RE = /^hki_[A-Za-z0-9_-]{22}$/;
export const INVITE_HEADER = "x-hipokamp-invite";

/**
 * Numer urządzenia: 1 to pierwsze urządzenie (`sync init`), kolejne 2 … MAX_DEVICE. Numer wyznacza przestrzeń
 * numerów notatek (n·10⁸) i prefiks gid, więc nigdy nie wraca do użycia: nadaje go admin, podpisuje w zatwierdzeniu,
 * a hub pilnuje, żeby był większy od każdego, jaki kiedykolwiek widział (docs/SYNC.md, sekcja 4).
 */
export const MAX_DEVICE = 999_999;
export const validDevice = (n: unknown, min = 1): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= MAX_DEVICE;

export function sha256hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Skrót klucza dostępu, który trzyma serwer (sam klucz nie jest nigdzie zapisany po stronie serwera). */
export const tokenHash = (token: string): string => sha256hex(`hipokamp-sync-token\u0001${token}`);

/** Porównanie w stałym czasie (skróty tej samej długości). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Alfabet kodu dołączania: bez I, L, O, U (kod przepisuje człowiek). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
/** Kod dołączania: 16 znaków po 5 bitów = 80 bitów losowych (zob. crypto.ts, newJoinCode). */
export const JOIN_CODE_CHARS = 16;

/** Kod wpisany przez człowieka: wielkie litery, bez separatorów, typowe pomyłki (O→0, I/L→1, U→V). */
export function normCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

/** Pole `proof` prośby o dołączenie i `mac` zatwierdzenia: HMAC-SHA256 w base64url (43 znaki). */
export const MAC_RE = /^[A-Za-z0-9_-]{43}$/;

/** Odpowiedź błędu serwera. */
export interface ErrorBody {
  error: string;
  /** Wersje protokołu obsługiwane przez serwer (przy 426). */
  protocol?: number;
  revoked?: boolean;
}
