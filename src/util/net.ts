// Adresy tylko w pętli zwrotnej: lokalny LLM (Ollama) i webhook powiadomień. Zasada repo: zero sieci poza maszyną.
// Egzekwowane w kodzie: adres sprawdzany przed połączeniem (host 127.0.0.0/8 albo ::1, localhost zamieniany na
// 127.0.0.1), żadnych przekierowań i żadnego proxy z HTTP(S)_PROXY (fetch Buna 1.3 kieruje przez proxy także
// 127.0.0.1, a NO_PROXY czyta przy każdym żądaniu).

/** Błąd konfiguracji adresu (zdalny host, zły protokół): wywołanie nie idzie w ogóle. */
export class RemoteAddressError extends Error {}

/**
 * Adres http(s) na 127.0.0.0/8 albo ::1. `localhost` zamieniamy na 127.0.0.1, żeby wpis w hosts nie wyprowadził
 * ruchu poza maszynę. Inny host, dane logowania w adresie albo inny protokół: wyjątek.
 */
export function loopbackUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new RemoteAddressError(`niepoprawny adres: ${String(raw).slice(0, 80)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new RemoteAddressError(`tylko http(s): ${u.protocol}`);
  if (u.username || u.password) throw new RemoteAddressError("adres z danymi logowania jest odrzucany");
  const h = u.hostname.toLowerCase();
  if (h === "localhost") u.hostname = "127.0.0.1";
  else if (!/^127(?:\.\d{1,3}){3}$/.test(h) && h !== "[::1]" && h !== "::1")
    throw new RemoteAddressError(`adres spoza 127.0.0.1 jest odrzucany: ${h}`);
  return u;
}

/** Sprawdzenie bez wyjątku (do komunikatów w CLI i doctor). */
export function isLoopbackUrl(raw: string): boolean {
  try {
    loopbackUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dopisuje hosty pętli zwrotnej (i podany host) do NO_PROXY/no_proxy tego procesu: żądanie na 127.0.0.1 nie pójdzie
 * przez proxy z HTTP_PROXY/HTTPS_PROXY. Ruchu do innych hostów to nie zmienia.
 */
export function bypassProxyForLoopback(host?: string, env: Record<string, string | undefined> = process.env): void {
  const want = ["127.0.0.1", "localhost", "::1", "[::1]"];
  if (host && !want.includes(host)) want.push(host);
  for (const k of ["NO_PROXY", "no_proxy"]) {
    const cur = (env[k] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (cur.includes("*")) continue;
    const missing = want.filter((h) => !cur.includes(h));
    if (missing.length) env[k] = [...cur, ...missing].join(",");
  }
}

/**
 * fetch wyłącznie na pętlę zwrotną: adres sprawdzony przed połączeniem (wyjątek RemoteAddressError), bez proxy,
 * bez przekierowań (odpowiedź 3xx wraca jako odpowiedź, wywołujący traktuje ją jak błąd).
 */
export function loopbackFetch(raw: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = loopbackUrl(String(raw));
  bypassProxyForLoopback(url.hostname);
  return fetch(url, { ...init, redirect: "manual" });
}
