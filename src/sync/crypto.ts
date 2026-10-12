// Szyfrowanie po stronie klienta. Serwer widzi tylko szyfrogramy, identyfikator klucza i rozmiar.
// - klucz grupy: 32 losowe bajty, wspólne dla urządzeń; z niego HKDF wyprowadza klucz AES-256-GCM i klucz HMAC
//   identyfikatorów wpisów (serwer deduplikuje po identyfikatorze, nie widząc, czego dotyczy wpis);
// - treść wpisu: JSON → deflate → AES-256-GCM (nonce 96 bitów losowy, AAD wiąże szyfrogram z hubem, kluczem
//   i identyfikatorem wpisu, więc serwer nie przestawi szyfrogramu pod inny wpis);
// - dołączanie urządzenia: klucz grupy zapieczętowany kluczem publicznym X25519 nowego urządzenia (efemeryczny
//   klucz nadawcy, ECDH, HKDF, AES-256-GCM), a obie strony uwierzytelnia jednorazowy kod, który przepisuje człowiek
//   i który nigdy nie idzie do huba (joinCodeKey, joinProof, approvalMac; docs/SYNC.md, „Dołączanie urządzenia”).
// Wszystko z node:crypto wbudowanego w Buna, bez zależności.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { CODE_ALPHABET, ENTRY_VERSION, JOIN_CODE_CHARS, LIMITS, normCode } from "./protocol.ts";

export interface GroupKey {
  kid: string;
  /** 32 bajty w base64. */
  key: string;
  created_at: number;
}

/** Klucze grupy; aktywny jest ostatni (starsze zostają do odczytu dawnych wpisów). */
export type Keyring = GroupKey[];

const te = new TextEncoder();
const td = new TextDecoder();

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const unb64 = (s: string): Buffer => Buffer.from(s, "base64");
export const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export function keyId(raw: Uint8Array): string {
  return createHash("sha256").update("hipokamp-sync-kid\u0001").update(raw).digest("hex").slice(0, 8);
}

export function newGroupKey(now = Date.now()): GroupKey {
  const raw = randomBytes(32);
  return { kid: keyId(raw), key: b64(raw), created_at: now };
}

/** Nowy klucz dostępu urządzenia (zob. TOKEN_RE). */
export const newToken = (): string => `hks_${b64url(randomBytes(32))}`;

const subkeys = new Map<string, { enc: Buffer; id: Buffer }>();

function derive(k: GroupKey): { enc: Buffer; id: Buffer } {
  let s = subkeys.get(k.key);
  if (!s) {
    const ikm = unb64(k.key);
    const salt = te.encode("hipokamp-sync/v1");
    s = {
      enc: Buffer.from(hkdfSync("sha256", ikm, salt, te.encode("hipokamp-sync/v1/enc"), 32)),
      id: Buffer.from(hkdfSync("sha256", ikm, salt, te.encode("hipokamp-sync/v1/id"), 32)),
    };
    subkeys.set(k.key, s);
  }
  return s;
}

export function activeKey(ring: Keyring): GroupKey {
  const k = ring[ring.length - 1];
  if (!k) throw new Error("pusty pęk kluczy grupy");
  return k;
}

/** Identyfikator wpisu: HMAC z treści logicznej (te same operacje dają ten sam identyfikator, więc powtórka nic nie dodaje). */
export function entryId(ring: Keyring, logical: string): string {
  return createHmac("sha256", derive(activeKey(ring)).id)
    .update(logical)
    .digest("base64url");
}

const aad = (hub: string, kid: string, id: string) => te.encode(`hks${ENTRY_VERSION}|${hub}|${kid}|${id}`);

/**
 * Treść wpisu → szyfrogram base64 (nonce || szyfrogram || znacznik). `plain` to rozmiar JSON-u przed kompresją:
 * nadawca nie wysyła wpisu ponad LIMITS.maxEntryPlainBytes, bo odbiorca go nie rozpakuje (openEntry).
 */
export function sealEntry(ring: Keyring, hub: string, id: string, payload: unknown): { kid: string; ct: string; plain: number } {
  const k = activeKey(ring);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(k).enc, iv);
  c.setAAD(aad(hub, k.kid, id));
  const json = te.encode(JSON.stringify(payload));
  const body = Bun.deflateSync(json); // surowy DEFLATE (bez nagłówka zlib), stąd inflateRawSync w openEntry
  const ct = Buffer.concat([iv, c.update(body), c.final(), c.getAuthTag()]);
  return { kid: k.kid, ct: ct.toString("base64"), plain: json.byteLength };
}

export class UnknownKeyError extends Error {
  constructor(readonly kid: string) {
    super(`brak klucza grupy ${kid}`);
  }
}

/**
 * Szyfrogram → treść. Rzuca UnknownKeyError (brak klucza) albo Error (uszkodzony albo podmieniony szyfrogram, także
 * treść większa po rozpakowaniu niż LIMITS.maxEntryPlainBytes: rozpakowanie staje na tej granicy, więc kilka KB
 * bomby deflate od członka grupy nie zajmie gigabajtów pamięci).
 */
export function openEntry(ring: Keyring, hub: string, e: { id: string; kid: string; ct: string }): unknown {
  const k = ring.find((x) => x.kid === e.kid);
  if (!k) throw new UnknownKeyError(e.kid);
  const raw = unb64(e.ct);
  if (raw.length < 12 + 16) throw new Error("szyfrogram za krótki");
  const d = createDecipheriv("aes-256-gcm", derive(k).enc, raw.subarray(0, 12));
  d.setAAD(aad(hub, k.kid, e.id));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const body = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
  let json: Buffer;
  try {
    json = inflateRawSync(body, { maxOutputLength: LIMITS.maxEntryPlainBytes });
  } catch {
    throw new Error(`treść wpisu nie rozpakowuje się w granicy ${LIMITS.maxEntryPlainBytes} bajtów`);
  }
  return JSON.parse(td.decode(json));
}

// --- dołączanie urządzenia: X25519

export interface JoinKeys {
  /** Klucz publiczny, 32 bajty base64url (idzie do serwera i do kodu porównania). */
  pubkey: string;
  /** Klucz prywatny PKCS#8 w base64 (tylko w pliku stanu dołączania, uprawnienia użytkownika). */
  privateKey: string;
}

export function newJoinKeys(): JoinKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { pubkey: jwk.x, privateKey: b64(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer) };
}

const pubFromRaw = (x: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });

function joinKey(shared: Buffer, epk: string, rpk: string, request: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, te.encode(`${epk}|${rpk}`), te.encode(`hipokamp-sync/v1/join|${request}`), 32));
}

/** Pęk kluczy grupy zapieczętowany dla nowego urządzenia (tylko ono go otworzy). */
export function sealForDevice(ring: Keyring, recipientPub: string, request: string): string {
  const eph = generateKeyPairSync("x25519");
  const epk = (eph.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pubFromRaw(recipientPub) });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", joinKey(shared, epk, recipientPub, request), iv);
  c.setAAD(te.encode(request));
  const ct = Buffer.concat([c.update(te.encode(JSON.stringify(ring))), c.final(), c.getAuthTag()]);
  return JSON.stringify({ epk, iv: b64(iv), ct: b64(ct) });
}

// --- dołączanie urządzenia: jednorazowy kod
//
// Nowe urządzenie losuje kod (80 bitów) i pokazuje go tylko na swoim ekranie. Do huba idzie `proof` = HMAC z klucza
// kodu po nazwie, skrócie klucza dostępu, kluczu publicznym i najniższym dopuszczalnym numerze urządzenia: admin, który
// przepisał kod, rozpoznaje po nim prośbę i wie, że klucz publiczny należy do urządzenia z kodem (hub nie podmieni go
// bez kodu). Zatwierdzenie niesie `mac` z tego samego klucza po hubie, prośbie, kluczu publicznym, roli,
// zapieczętowanym kluczu grupy i numerze urządzenia: nowe urządzenie przyjmuje klucz grupy i numer tylko z poprawnym
// `mac`, więc hub nie podsunie własnego klucza, roli ani numeru i nie „zatwierdzi” sam.
// Klucz kodu liczy scrypt: hub zna `proof` i mógłby zgadywać kod offline, a tak 80 bitów jest poza zasięgiem
// także w ciągu 15 minut życia prośby.

/** Nowy kod dołączania: 16 znaków z alfabetu bez I, L, O, U, w czterech grupach. */
export function newJoinCode(): string {
  const s = Array.from(randomBytes(JOIN_CODE_CHARS), (x) => CODE_ALPHABET[x & 31]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
}

/** Kod wygląda na kod dołączania (po normalizacji: długość i alfabet). */
export function isJoinCode(code: string): boolean {
  const c = normCode(code);
  return c.length === JOIN_CODE_CHARS && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

/** Klucz HMAC z kodu dołączania (scrypt N=2^14, r=8: ok. 16 MB i kilkadziesiąt ms na próbę). */
export function joinCodeKey(code: string): Buffer {
  if (!isJoinCode(code)) throw new Error(`zły kod dołączania (${JOIN_CODE_CHARS} znaków z ekranu nowego urządzenia)`);
  return scryptSync(normCode(code), "hipokamp-sync/v1/join-code", 32, { N: 1 << 14, r: 8, p: 1 });
}

const mac = (k: Buffer, parts: string[]): string => createHmac("sha256", k).update(parts.join("\u0001")).digest("base64url");

/**
 * Dowód znajomości kodu w prośbie o dołączenie: wiąże z kodem klucz publiczny, skrót klucza dostępu i najniższy numer
 * urządzenia, jaki ta baza może przyjąć (`min_device`: hub nie obniży go bez kodu).
 */
export const joinProof = (k: Buffer, j: { name: string; token_hash: string; pubkey: string; min_device: number }): string =>
  mac(k, ["hipokamp-sync/v1/proof", j.name, j.token_hash, j.pubkey, String(j.min_device)]);

/**
 * Podpis zatwierdzenia: tylko ktoś, kto zna kod (admin, który go przepisał), może go wystawić. Obejmuje numer
 * urządzenia nadany przez admina: hub nie poda innego (cudza przestrzeń numerów, numer spoza zakresu).
 */
export const approvalMac = (
  k: Buffer,
  a: { hub: string; request: string; pubkey: string; token_hash: string; role: string; sealed: string; device: number },
): string => mac(k, ["hipokamp-sync/v1/approve", a.hub, a.request, a.pubkey, a.token_hash, a.role, a.sealed, String(a.device)]);

/** Porównanie podpisów w stałym czasie. */
export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function openSealed(sealed: string, keys: JoinKeys, request: string): Keyring {
  const s = JSON.parse(sealed) as { epk: string; iv: string; ct: string };
  const priv = createPrivateKey({ key: unb64(keys.privateKey), format: "der", type: "pkcs8" });
  const shared = diffieHellman({ privateKey: priv, publicKey: pubFromRaw(s.epk) });
  const raw = unb64(s.ct);
  const d = createDecipheriv("aes-256-gcm", joinKey(shared, s.epk, keys.pubkey, request), unb64(s.iv));
  d.setAAD(te.encode(request));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const ring = JSON.parse(td.decode(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]))) as Keyring;
  if (!Array.isArray(ring) || !ring.length || ring.some((k) => keyId(unb64(k.key)) !== k.kid))
    throw new Error("zapieczętowany klucz grupy jest niepoprawny");
  return ring;
}
