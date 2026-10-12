// Token podglądu (T-34): bilet z `hipokamp open` na ciasteczko, 401 na /api/* bez ciasteczka i bez dowodu klienta,
// zapis z ciasteczkiem tylko z Origin podglądu, klienci z kluczem (T-17) bez zmian. Osobna baza i port, bez modelu.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  COOKIE_MAX_AGE_S,
  cookieHeaderOk,
  cookieName,
  mintCookie,
  mintTicket,
  readCookies,
  TICKET_TTL_MS,
  TicketStore,
  verifyCookie,
} from "../src/worker/viewer-auth.ts";
import {
  currentSid,
  LAUNCHER_DIR,
  launcherHtml,
  parseSecurity,
  privateAcl,
  privateDirError,
  readAcl,
  removeLauncher,
  SYSTEM_SIDS,
  writeLauncher,
} from "../src/worker/viewer-open.ts";
import { authed, authedPost, fakeWorker, keyFileOf, keyOf } from "./fixtures/auth.ts";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
const claude = join(home, "claude");
mkdirSync(join(claude, "projects"), { recursive: true });
const PORT = 47997;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: home,
  HIPOKAMP_PORT: String(PORT),
  HIPOKAMP_NO_WORKER: "1",
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(home, "codex"),
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
  // ping SSE (i sprawdzenie ciasteczka otwartych strumieni) co 300 ms zamiast 30 s
  HIPOKAMP_SSE_PING_MS: "300",
};
let worker: Subprocess | undefined;

const raw = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, { redirect: "manual", ...init });
/** Wymiana biletu: odpowiedź 303 i ciasteczko „nazwa=wartość” (null, gdy go nie ma). */
async function redeem(ticket: string): Promise<{ res: Response; cookie: string | null }> {
  const res = await raw(`/auth?t=${encodeURIComponent(ticket)}`);
  const set = res.headers.get("set-cookie");
  return { res, cookie: set ? set.split(";")[0] : null };
}
const withCookie = (cookie: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie },
});
const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ embed: { enabled: false }, backup: { enabled: false } }));
  await startWorker();
}, 30_000);

async function startWorker(): Promise<void> {
  worker = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
    env,
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try {
      // statyczny podgląd odpowiada bez ciasteczka; klucz workera powstaje przy starcie workera
      if ((await raw("/")).ok) {
        keyOf(home);
        return;
      }
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("worker nie wstał");
}

/**
 * Surowe żądanie HTTP przez gniazdo: ścieżka idzie dokładnie tak, jak podana (fetch normalizuje `/x/../`, `//`
 * i ukośniki wsteczne, zanim cokolwiek wyśle). Zwraca kod statusu i całą odpowiedź.
 */
function rawHttp(method: string, target: string, headers: string[] = []): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => resolve({ status: Number(buf.split(" ")[1]) || 0, text: buf });
    const s = connect(PORT, "127.0.0.1", () =>
      s.write([`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, "Connection: close", ...headers, "", ""].join("\r\n")),
    );
    s.on("data", (d) => {
      buf += d.toString("utf8");
    });
    s.on("end", done);
    s.on("error", done);
    setTimeout(() => {
      s.destroy();
      done();
    }, 3000);
  });
}

afterAll(async () => {
  worker?.kill();
  await worker?.exited;
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
});

describe("bilet i ciasteczko (viewer-auth.ts)", () => {
  const key = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 8);

  test("ciasteczko: podpis, port, klucz, termin, format", () => {
    const now = Date.now();
    const c = mintCookie(key, 47777, now);
    expect(verifyCookie(key, 47777, c, now)).toBe(true);
    expect(verifyCookie(key, 47778, c, now)).toBe(false);
    expect(verifyCookie(other, 47777, c, now)).toBe(false);
    expect(verifyCookie(key, 47777, c, now + COOKIE_MAX_AGE_S * 1000)).toBe(false);
    expect(verifyCookie(key, 47777, mintCookie(key, 47777, now + 10 * 60_000), now)).toBe(false); // z przyszłości
    expect(verifyCookie(key, 47777, `${c.slice(0, -1)}${c.endsWith("0") ? "1" : "0"}`, now)).toBe(false);
    for (const bad of [null, "", "x", "1.2.3", `${c}.`, c.toUpperCase()]) expect(verifyCookie(key, 47777, bad, now)).toBe(false);
  });

  test("bilet: jednorazowy, krótko ważny, nie jest ciasteczkiem i odwrotnie", () => {
    const now = Date.now();
    const store = new TicketStore(now);
    const t = mintTicket(key, 47777, now);
    expect(store.redeem(other, 47777, t, now)).toBe(false);
    expect(store.redeem(key, 47778, t, now)).toBe(false);
    expect(store.redeem(key, 47777, t, now)).toBe(true);
    expect(store.redeem(key, 47777, t, now + 1)).toBe(false); // drugi raz
    expect(store.redeem(key, 47777, mintTicket(key, 47777, now - TICKET_TTL_MS), now)).toBe(false); // po terminie
    expect(store.redeem(key, 47777, mintTicket(key, 47777, now + 10 * 60_000), now)).toBe(false); // z przyszłości
    // etykiety rozdzielają role: ciasteczko nie przejdzie jako bilet, bilet nie przejdzie jako ciasteczko
    expect(store.redeem(key, 47777, mintCookie(key, 47777, now + 1000), now)).toBe(false);
    expect(verifyCookie(key, 47777, mintTicket(key, 47777, now - TICKET_TTL_MS + 1000), now)).toBe(false);
    // zużyte bilety znikają z pamięci po terminie
    expect(store.size).toBe(1);
    expect(store.redeem(key, 47777, mintTicket(key, 47777, now + TICKET_TTL_MS + 1), now + TICKET_TTL_MS + 1)).toBe(true);
    expect(store.size).toBe(1);
  });

  test("bilet wybity przed startem workera nie działa (restart nie daje drugiego użycia); pełna pamięć odrzuca nowe", () => {
    const now = Date.now();
    const store = new TicketStore(now);
    expect(store.redeem(key, 47777, mintTicket(key, 47777, now - 1000), now)).toBe(false);
    expect(store.redeem(key, 47777, mintTicket(key, 47777, now), now)).toBe(true);
    const small = new TicketStore(now, 2);
    expect(small.redeem(key, 47777, mintTicket(key, 47777, now), now)).toBe(true);
    expect(small.redeem(key, 47777, mintTicket(key, 47777, now), now)).toBe(true);
    expect(small.redeem(key, 47777, mintTicket(key, 47777, now), now)).toBe(false);
    expect(small.size).toBe(2);
  });

  test("nazwa ciasteczka z portem; wszystkie wystąpienia z nagłówka Cookie, ważne którekolwiek", () => {
    expect(cookieName(47777)).toBe("hipokamp_viewer_47777");
    expect(readCookies("a=1; hipokamp_viewer_47777=abc; b=2; hipokamp_viewer_47777=def", "hipokamp_viewer_47777")).toEqual([
      "abc",
      "def",
    ]);
    expect(readCookies("hipokamp_viewer_477770=abc", "hipokamp_viewer_47777")).toEqual([]);
    expect(readCookies(null, "x")).toEqual([]);
    const good = mintCookie(key, 47777);
    expect(cookieHeaderOk(key, 47777, `hipokamp_viewer_47777=podrzucone; hipokamp_viewer_47777=${good}`)).toBe(true);
    expect(cookieHeaderOk(key, 47777, `hipokamp_viewer_47777=${good}; hipokamp_viewer_47777=podrzucone`)).toBe(true);
    expect(cookieHeaderOk(key, 47777, "hipokamp_viewer_47777=a; hipokamp_viewer_47777=b")).toBe(false);
    expect(cookieHeaderOk(key, 47777, null)).toBe(false);
  });

  test("SDDL: właściciel obcy albo nieznany odrzucony, nasz albo Administratorzy przyjęci", () => {
    const me = "S-1-5-21-1-2-3-1001";
    const dacl = `D:PAI(A;OICI;FA;;;${me})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
    expect(parseSecurity(`O:${me}G:${me}${dacl}`)?.owner).toBe(me);
    expect(privateAcl(parseSecurity(`O:${me}G:${me}${dacl}`), me)).toBe(true);
    expect(privateAcl(parseSecurity(`O:BAG:SY${dacl}`), me)).toBe(true);
    expect(privateAcl(parseSecurity(`O:S-1-5-32-544G:SY${dacl}`), me)).toBe(true);
    // konto z zapisem w state/ założyło katalog: jest właścicielem, choć wpisy wyglądają na prywatne
    expect(privateAcl(parseSecurity(`O:S-1-5-21-9-9-9-2002G:${me}${dacl}`), me)).toBe(false);
    expect(privateAcl(parseSecurity(`O:AUG:${me}${dacl}`), me)).toBe(false);
    expect(privateAcl(parseSecurity(dacl), me)).toBe(false); // bez O: nie wiemy, kto jest właścicielem
    // obcy wpis zezwalający albo dziedziczenie nadal odrzucone
    expect(privateAcl(parseSecurity(`O:${me}${dacl}(A;;FR;;;AU)`), me)).toBe(false);
    expect(privateAcl(parseSecurity(`O:${me}D:AI(A;OICIID;FA;;;${me})`), me)).toBe(false);
  });

  test("plik przekierowania: bilet w treści, nie w argv; prywatny katalog; losowe nazwy; sprzątanie po 2 min", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hipokamp-test-launch-"));
    try {
      const url = "http://127.0.0.1:47777/auth?t=1.ab.cd";
      expect(launcherHtml(url)).toContain(`location.replace("${url}")`);
      expect(launcherHtml('http://x/"><script>')).not.toContain('"><script>');
      const file = await writeLauncher(dir, url);
      if (!file) throw new Error(`writeLauncher: null (${privateDirError})`);
      const open = join(dir, LAUNCHER_DIR);
      expect(file.startsWith(open)).toBe(true);
      expect(file).not.toContain("auth?t=");
      expect(readFileSync(file, "utf8")).toContain(url);
      if (process.platform === "win32") {
        // pełny SDDL po SID: właściciel to my, katalog bez dziedziczenia, wpisy tylko użytkownik, SYSTEM,
        // Administratorzy; plik dziedziczy to samo od urodzenia
        const sid = await currentSid();
        if (!sid) throw new Error("brak SID");
        const dacl = await readAcl(open);
        expect(dacl?.owner).toBe(sid);
        expect(privateAcl(dacl, sid)).toBe(true);
        expect(dacl!.aces.filter((a) => a.type === "A").every((a) => a.sid === sid || SYSTEM_SIDS.includes(a.sid))).toBe(true);
        expect(privateAcl(await readAcl(file), sid, false)).toBe(true);
      } else {
        expect(statSync(open).mode & 0o777).toBe(0o700);
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      // drugi równoległy open: inny plik, pierwszy (młodszy niż 2 min) zostaje
      const second = await writeLauncher(dir, "http://127.0.0.1:47777/auth?t=2.ef.01");
      expect(second).not.toBe(file);
      expect(existsSync(file)).toBe(true);
      // plik starszy niż ważność biletu znika przy następnym open
      const old = (Date.now() - TICKET_TTL_MS - 5000) / 1000;
      utimesSync(file, old, old);
      const third = await writeLauncher(dir, "http://127.0.0.1:47777/auth?t=3.ef.01");
      expect(existsSync(file)).toBe(false);
      expect(existsSync(second!)).toBe(true);
      removeLauncher(second);
      removeLauncher(third);
      expect(readdirSync(open).filter((f) => f.endsWith(".html"))).toEqual([]);
      // katalogu nie da się zrobić (zajęty przez plik): null, CLI wypisze link zamiast stosu wyjątku
      const blocked = mkdtempSync(join(tmpdir(), "hipokamp-test-launch-"));
      writeFileSync(join(blocked, LAUNCHER_DIR), "x");
      expect(await writeLauncher(blocked, url)).toBeNull();
      rmSync(blocked, { recursive: true, force: true });
      // state/open jako dowiązanie (Windows: junction) do katalogu, który ktoś inny kontroluje: odrzucone, bez pliku
      const linked = mkdtempSync(join(tmpdir(), "hipokamp-test-launch-"));
      const target = join(linked, "cudzy");
      mkdirSync(target);
      symlinkSync(target, join(linked, LAUNCHER_DIR), process.platform === "win32" ? "junction" : "dir");
      expect(await writeLauncher(linked, url)).toBeNull();
      expect(privateDirError).toContain("dowiązaniem");
      expect(readdirSync(target)).toEqual([]);
      rmSync(linked, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker: podgląd za ciasteczkiem", () => {
  const VIEWER_ROUTES = [
    "/api/viewer",
    "/api/health",
    "/api/stats",
    "/api/recent",
    "/api/projects",
    "/api/sessions",
    "/api/search?q=worker",
    "/api/work-state/all",
    "/api/activity",
  ];

  test("bez ciasteczka: 401 na każdej trasie /api/* (odczyt, zapis, SSE); pliki statyczne bez ciasteczka", async () => {
    for (const p of [...VIEWER_ROUTES, "/api/stream"]) {
      const r = await raw(p);
      expect({ p, s: r.status }).toEqual({ p, s: 401 });
      expect((await r.json()) as unknown).toEqual({ error: "podgląd wymaga ciasteczka: otwórz go przez hipokamp open" });
    }
    const writes = [
      ["/api/work-state", { project: "alfa", list: "todo", fields: { task: "wstrzyknięcie", status: "todo" } }],
      ["/api/forget", { ids: [1] }],
      ["/api/restore", { ids: [1] }],
      ["/api/admin/sleep", {}],
    ] as const;
    for (const [p, body] of writes) {
      const r = await raw(p, postJson(body, { origin: ORIGIN }));
      expect({ p, s: r.status }).toEqual({ p, s: 401 });
    }
    for (const p of ["/", "/app.js", "/app.css", "/i18n/en.js", "/assets/logo/favicon.svg"])
      expect({ p, s: (await raw(p)).status }).toEqual({ p, s: 200 });
  });

  test("złe ciasteczko (inny klucz, inny port, śmieci): 401", async () => {
    const key = keyOf(home);
    for (const v of [
      mintCookie(Buffer.alloc(32, 1), PORT),
      mintCookie(key, PORT + 1),
      "1.2.3",
      mintTicket(key, PORT), // bilet to nie ciasteczko
    ])
      expect((await raw("/api/recent", withCookie(`${cookieName(PORT)}=${v}`))).status).toBe(401);
    // ciasteczko innego portu pod nazwą tego portu też nie
    expect((await raw("/api/recent", withCookie(`${cookieName(PORT + 1)}=${mintCookie(key, PORT + 1)}`))).status).toBe(401);
  });

  test("zły, zużyty, przeterminowany bilet: 303 na ekran wejścia, bez ciasteczka", async () => {
    const key = keyOf(home);
    const used = mintTicket(key, PORT);
    expect((await redeem(used)).cookie).not.toBeNull();
    for (const t of [
      "",
      "zly",
      used, // drugi raz
      mintTicket(key, PORT, Date.now() - TICKET_TTL_MS - 1000),
      mintTicket(key, PORT + 1),
      mintTicket(Buffer.alloc(32, 1), PORT),
    ]) {
      const { res, cookie } = await redeem(t);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/?auth=invalid");
      expect(cookie).toBeNull();
    }
  });

  test("poprawny przepływ: bilet → ciasteczko HttpOnly, SameSite=Strict, Path=/ → odczyt, SSE i zapis z Origin", async () => {
    const { res, cookie } = await redeem(mintTicket(keyOf(home), PORT));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set.startsWith(`${cookieName(PORT)}=`)).toBe(true);
    for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${COOKIE_MAX_AGE_S}`]) expect(set).toContain(attr);
    const c = cookie!;
    expect(await (await raw("/api/viewer", withCookie(c))).json()).toEqual({ ok: true, via: "cookie" });
    for (const p of VIEWER_ROUTES) expect({ p, s: (await raw(p, withCookie(c))).status }).toEqual({ p, s: 200 });
    // odświeżanie Dashboardu w tle (x-hipokamp-bg) też z ciasteczkiem
    expect((await raw("/api/stats", withCookie(c, { headers: { "x-hipokamp-bg": "1" } }))).status).toBe(200);
    // SSE: EventSource wysyła ciasteczka tego samego źródła
    const ctrl = new AbortController();
    const s = await raw("/api/stream", withCookie(c, { signal: ctrl.signal }));
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toContain("text/event-stream");
    const first = new TextDecoder().decode((await s.body!.getReader().read()).value);
    expect(first).toContain("event: hello");
    ctrl.abort();
    // zapis z ciasteczkiem: z Origin podglądu 200, bez Origin albo z innym (localhost przy Host 127.0.0.1) 403
    const item = { project: "alfa", list: "todo", fields: { task: "sprawdź token podglądu", status: "todo" } };
    expect((await raw("/api/work-state", withCookie(c, postJson(item, { origin: ORIGIN })))).status).toBe(200);
    const noOrigin = await raw("/api/work-state", withCookie(c, postJson(item)));
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: "zapis z podglądu wymaga nagłówka Origin" });
    expect((await raw("/api/forget", withCookie(c, postJson({ ids: [1] }, { origin: `http://localhost:${PORT}` })))).status).toBe(
      403,
    );
    // obca strona dalej odpada na kontroli Origin i Sec-Fetch-Site, także z ciasteczkiem
    expect((await raw("/api/recent", withCookie(c, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await raw("/api/recent", withCookie(c, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    // ciasteczko nie otwiera tras klientów (kontekst do modelu, remember, hooki)
    expect((await raw("/api/context/start?project=alfa", withCookie(c))).status).toBe(401);
    expect(
      (await raw("/api/remember", withCookie(c, postJson({ project: "alfa", title: "x", text: "y" }, { origin: ORIGIN }))))
        .status,
    ).toBe(401);
  });

  test("klienci z kluczem (T-17) bez ciasteczka i bez Origin: odczyt i zapis jak dotąd", async () => {
    const { res, proven } = await authed(home, BASE, "/api/viewer");
    expect(proven).toBe(true);
    expect(await res.json()).toEqual({ ok: true, via: "key" });
    for (const p of VIEWER_ROUTES) {
      const r = await authed(home, BASE, p);
      expect({ p, s: r.res.status, proven: r.proven }).toEqual({ p, s: 200, proven: true });
    }
    const w = await authedPost(home, BASE, "/api/work-state", {
      project: "alfa",
      list: "todo",
      fields: { task: "klient z kluczem", status: "todo" },
    });
    expect(w.status).toBe(200);
    expect((await authedPost(home, BASE, "/api/forget", { ids: [999_999_999] })).status).toBe(200);
  });

  test("hipokamp open --print: link z biletem otwiera podgląd raz", async () => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli.ts"), "open", "--print"], { env, cwd: ROOT });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/auth\?t=(\S+)/);
    expect(m?.[1]).toBe(String(PORT));
    const first = await redeem(decodeURIComponent(m![2]));
    expect(first.res.headers.get("location")).toBe("/");
    expect((await raw("/api/recent", withCookie(first.cookie!))).status).toBe(200);
    expect((await redeem(decodeURIComponent(m![2]))).cookie).toBeNull();
  }, 30_000);
});

describe("worker: obejścia i krawędzie (przegląd PR #22)", () => {
  test("bez ciasteczka: HEAD, OPTIONS, DELETE, PUT, PATCH na /api/* też 401", async () => {
    for (const method of ["HEAD", "OPTIONS", "DELETE", "PUT", "PATCH"])
      for (const p of ["/api/recent", "/api/forget", "/api/work-state", "/api/stream"]) {
        const r = await raw(p, {
          method,
          headers: method === "HEAD" || method === "OPTIONS" ? {} : { "content-type": "application/json" },
        });
        expect({ method, p, s: r.status }).toEqual({ method, p, s: 401 });
      }
  });

  test("warianty ścieżki bez ciasteczka nie dają danych ani pliku klucza", async () => {
    const key = readFileSync(keyFileOf(home), "utf8").trim();
    for (const target of [
      "//api/recent",
      "/API/recent",
      "/Api/Stats",
      "/api%2Frecent",
      "/%61pi/recent",
      "/x/../api/recent",
      "/api/./recent",
      "/api/recent/",
      "/api//recent",
      `http://127.0.0.1:${PORT}/api/recent`,
      "/../state/worker.key",
      "/..%2Fstate%2Fworker.key",
      "/%2e%2e/state/worker.key",
      "/assets/../../state/worker.key",
    ]) {
      const r = await rawHttp("GET", target);
      expect({ target, ok: r.status > 0 && r.status !== 200 }).toEqual({ target, ok: true });
      expect(r.text.includes(key)).toBe(false);
    }
  });

  test("kilka ciasteczek o tej samej nazwie: podrzucone przed ważnym nie blokuje, same podrzucone nie wpuszczają", async () => {
    const name = cookieName(PORT);
    const good = mintCookie(keyOf(home), PORT);
    expect((await raw("/api/recent", withCookie(`${name}=podrzucone; ${name}=${good}`))).status).toBe(200);
    expect((await raw("/api/recent", withCookie(`${name}=${good}; ${name}=podrzucone`))).status).toBe(200);
    expect((await raw("/api/recent", withCookie(`${name}=a; ${name}=b; ${name}=1.2.3`))).status).toBe(401);
  });

  test("hipokamp open wobec workera bez T-34: podpowiedź hipokamp restart, bez biletu", async () => {
    const OLD_PORT = 47984;
    const fake = fakeWorker(
      home,
      (req) =>
        new URL(req.url).pathname === "/api/health"
          ? Response.json({
              app: "hipokamp",
              ok: true,
              pid: 4242,
              version: "0.0.1-stary",
              uptimeS: 5,
              embedder: { loaded: false, device: "cpu", model: "" },
            })
          : Response.json({ error: "nieznany endpoint" }, { status: 404 }),
      OLD_PORT,
    );
    try {
      // asynchronicznie: udawany worker działa w tym procesie i musi odpowiadać, gdy CLI czeka
      const p = Bun.spawn([process.execPath, join(ROOT, "src", "cli.ts"), "open", "--print"], {
        env: { ...env, HIPOKAMP_PORT: String(OLD_PORT) },
        cwd: ROOT,
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(1);
      expect(out).toContain("hipokamp restart");
      expect(out).toContain("0.0.1-stary");
      expect(out).not.toContain("auth?t=");
      expect(fake.seen).toContain("/api/viewer");
    } finally {
      fake.stop();
    }
  }, 30_000);

  test("otwarty strumień z ciasteczkiem zamyka się, gdy ciasteczko przestaje działać (nowy klucz)", async () => {
    const { cookie } = await redeem(mintTicket(keyOf(home), PORT));
    const ctrl = new AbortController();
    const s = await raw("/api/stream", withCookie(cookie!, { signal: ctrl.signal }));
    expect(s.status).toBe(200);
    const reader = s.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: hello");
    // nowy klucz workera unieważnia wszystkie ciasteczka; najbliższy ping (300 ms) zamyka strumień
    writeFileSync(keyFileOf(home), `${"ab".repeat(32)}\n`);
    let closed = false;
    const t0 = Date.now();
    while (!closed && Date.now() - t0 < 5000) {
      const r = await Promise.race([reader.read(), Bun.sleep(5000).then(() => ({ done: false, value: undefined }))]);
      closed = r.done;
    }
    ctrl.abort();
    expect(closed).toBe(true);
    expect((await raw("/api/stream", withCookie(cookie!))).status).toBe(401);
    // klient z kluczem dalej słucha bez terminu
    expect((await authed(home, BASE, "/api/viewer")).res.status).toBe(200);
  }, 15_000);

  test("restart workera: bilet zużyty albo wybity przed startem nie działa, nowy działa, ciasteczko przeżywa", async () => {
    const key = keyOf(home);
    const used = mintTicket(key, PORT);
    const unused = mintTicket(key, PORT);
    const { cookie } = await redeem(used);
    expect(cookie).not.toBeNull();
    worker?.kill();
    await worker?.exited;
    for (let i = 0; i < 50; i++) {
      try {
        await raw("/");
      } catch {
        break;
      }
      await Bun.sleep(100);
    }
    await Bun.sleep(50); // termin biletu liczony od chwili startu nowego procesu
    await startWorker();
    for (const t of [used, unused]) {
      const r = await redeem(t);
      expect(r.res.headers.get("location")).toBe("/?auth=invalid");
      expect(r.cookie).toBeNull();
    }
    expect((await redeem(mintTicket(keyOf(home), PORT))).cookie).not.toBeNull();
    expect((await raw("/api/recent", withCookie(cookie!))).status).toBe(200);
  }, 40_000);
});
