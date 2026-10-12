// Uwierzytelnienie workera w testach (T-17): klucz z katalogu testowego (`<dane>/state/worker.key`), wyzwanie i dowód
// klienta jak w src/worker/auth.ts, oraz udawany worker, który klucz zna. Bez config.ts: ścieżki podaje test.
import { join } from "node:path";
import {
  AUTH_PATH,
  ChallengeStore,
  H_CHALLENGE,
  H_NONCE,
  H_PROOF,
  handshake,
  KEY_FILE,
  readKey,
  sign,
  verify,
} from "../../src/worker/auth.ts";
import { cookieName, mintCookie } from "../../src/worker/viewer-auth.ts";

export const keyFileOf = (home: string) => join(home, "state", KEY_FILE);

export function keyOf(home: string): Buffer {
  const k = readKey(keyFileOf(home));
  if (!k) throw new Error(`brak klucza workera w ${home}`);
  return k;
}

/**
 * Żądanie z wyzwaniem i dowodem klienta. Zwraca odpowiedź zawsze (także bez dowodu, np. 413 z Buna przed trasą),
 * a `proven` mówi, czy dowód odpowiedzi się zgadza.
 */
export async function authed(
  home: string,
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<{ res: Response; proven: boolean }> {
  const key = keyOf(home);
  const port = Number(new URL(base).port);
  const hs = await handshake(base, port, key);
  if (!hs.ok) throw new Error(`wyzwanie: ${hs.reason}`);
  const url = new URL(path, base);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set(H_NONCE, hs.nw);
  headers.set(H_PROOF, sign(key, "client", port, [hs.nw, `${method} ${url.pathname}${url.search}`]));
  const res = await fetch(url, { ...init, method, headers });
  return { res, proven: verify(key, "response", port, [hs.nc, hs.nw, String(res.status)], res.headers.get(H_PROOF)) };
}

/**
 * Żądanie podglądu (T-34): ciasteczko podglądu wybite kluczem katalogu testowego (bez wymiany biletu, tę sprawdza
 * test/viewer-token.test.ts), a zapis dostaje Origin podglądu, jak z przeglądarki. Nagłówki z `init` wygrywają.
 */
export function viewerInit(home: string, base: string, init: RequestInit = {}): RequestInit {
  const port = Number(new URL(base).port);
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", `${cookieName(port)}=${mintCookie(keyOf(home), port)}`);
  if ((init.method ?? "GET").toUpperCase() !== "GET" && !headers.has("origin")) headers.set("origin", base);
  return { ...init, headers };
}

/** fetch podglądu z ciasteczkiem (viewerInit). */
export const viewerFetch = (home: string, base: string, path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, viewerInit(home, base, init));

/** POST JSON z uwierzytelnieniem; odpowiedź jak z fetch (dowód sprawdza `authed`). */
export async function authedPost(home: string, base: string, path: string, body: unknown): Promise<Response> {
  return (
    await authed(home, base, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  ).res;
}

/**
 * Udawany worker znający klucz katalogu testowego: wyzwanie i dowód odpowiedzi jak w server.ts, a treść z `handler`.
 * `seen`: ścieżki wszystkich żądań (także wyzwań).
 */
export function fakeWorker(home: string, handler: (req: Request) => Response | Promise<Response>, port = 0) {
  const challenges = new ChallengeStore();
  const seen: string[] = [];
  const srv: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req): Promise<Response> {
      const key = keyOf(home);
      const u = new URL(req.url);
      seen.push(u.pathname);
      if (u.pathname === AUTH_PATH) {
        const nc = req.headers.get(H_CHALLENGE) ?? "";
        const nw = challenges.issue(nc);
        return Response.json({ app: "hipokamp", auth: 1, nonce: nw, proof: sign(key, "worker", srv.port!, [nc, nw]) });
      }
      const nw = req.headers.get(H_NONCE) ?? "";
      const nc = challenges.take(nw);
      const res = await handler(req);
      if (nc) res.headers.set(H_PROOF, sign(key, "response", srv.port!, [nc, nw, String(res.status)]));
      return res;
    },
  });
  return { port: srv.port!, seen, stop: (close = true) => srv.stop(close) };
}
