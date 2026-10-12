// Test API workera: osobna baza i port, bez modelu wektorów, bez kopii i bez cudzych transkryptów (pusty CLAUDE_CONFIG_DIR).

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { authed, authedPost, viewerFetch } from "./fixtures/auth.ts";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
const claude = join(home, "claude");
mkdirSync(join(claude, "projects"), { recursive: true });
const PORT = 47996;
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: home,
  HIPOKAMP_PORT: String(PORT),
  HIPOKAMP_NO_WORKER: "1",
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(home, "codex"),
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
};
// Strefa workera wymuszona (T-50): bun test liczy daty w UTC, a worker w strefie lokalnej, więc „dziś” rozjeżdżało
// się między 00:00 a 02:00 czasu polskiego. Kiritimati (UTC+14, bez zmiany czasu) jest daleko od UTC i od Warszawy:
// błąd strefy w trasie aktywności wychodzi o każdej godzinie, nie tylko po północy.
const WORKER_TZ = "Pacific/Kiritimati";
const WORKER_TZ_OFFSET_MS = 14 * 3_600_000;
const dayInWorkerTz = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: WORKER_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
let ids: { project: string; a: number; b: number; c: number; s: number };
let worker: Subprocess | undefined;

// podgląd z ciasteczkiem (T-34): bez niego /api/* odpowiada 401 (test/viewer-token.test.ts)
const get = async (path: string, init?: RequestInit) => viewerFetch(home, BASE, path, init);
const getJson = async (path: string) => (await get(path)).json() as Promise<any>;
// trasy klientów (kontekst, remember, embed, notify) tylko z kluczem workera (T-17): wyzwanie i dowód klienta
const aget = async (path: string, init?: RequestInit) => (await authed(home, BASE, path, init)).res;
const apost = (path: string, body: unknown) => authedPost(home, BASE, path, body);

beforeAll(async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ embed: { enabled: false }, backup: { enabled: false } }));
  const seed = Bun.spawnSync([process.execPath, join(ROOT, "test", "fixtures", "seed.ts")], { env, cwd: ROOT });
  if (seed.exitCode !== 0) throw new Error(`seed: ${seed.stderr.toString()}`);
  ids = JSON.parse(seed.stdout.toString());
  // trzy notatki z identycznym czasem utworzenia (jak po imporcie): kursor nie może ich zgubić
  const db = new Database(join(home, "hipokamp.db"));
  db.run("UPDATE observations SET created_at = (SELECT MAX(created_at) FROM observations)");
  db.close();
  worker = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
    env: { ...env, TZ: WORKER_TZ },
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await get("/api/health")).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("worker nie wstał");
}, 30_000);

afterAll(async () => {
  worker?.kill();
  await worker?.exited;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

describe("worker", () => {
  test("nagłówki obronne i CSP podglądu", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const api = await get("/api/health");
    expect(api.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const h = (await api.json()) as { eventLoopLagMs: number; eventLoopLagMaxMs: number; pendingJobs: number };
    expect(Number.isInteger(h.eventLoopLagMs) && h.eventLoopLagMs >= 0).toBe(true);
    expect(h.eventLoopLagMaxMs).toBeGreaterThanOrEqual(h.eventLoopLagMs);
    expect(h.pendingJobs).toBeGreaterThanOrEqual(0);
    const ico = await get("/assets/logo/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
  });

  test("obca strona nie dostaje odpowiedzi (Origin)", async () => {
    const r = await get("/api/recent", { headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  test("inna lokalna strona (inny port) nie dostaje odpowiedzi", async () => {
    const r = await get("/api/recent", { headers: { origin: "http://localhost:5173" } });
    expect(r.status).toBe(403);
    const ok = await get("/api/recent", { headers: { origin: `http://127.0.0.1:${PORT}` } });
    expect(ok.status).toBe(200);
  });

  test("prosty POST bez JSON i żądanie z obcej karty są odrzucane", async () => {
    const plain = await get("/api/work-state", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ project: ids.project, list: "x", fields: { task: "uruchom coś", status: "todo" } }),
    });
    expect(plain.status).toBe(415);
    expect((await get("/api/recent", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await get("/api/recent", { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await get("/api/recent", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
    // statyczny podgląd otwarty z linku nadal działa
    expect((await get("/", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
  });

  test("ujemny limit nie zdejmuje limitu", async () => {
    expect((await getJson("/api/recent?limit=-1")).length).toBe(1);
    expect((await getJson("/api/sessions?limit=-5")).length).toBe(1);
  });

  test("wektory wyłączone: model się nie ładuje, /api/embed odpowiada 503", async () => {
    const h = await getJson("/api/health");
    expect(h.embedder.loaded).toBe(false);
    const e = await aget("/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    });
    expect(e.status).toBe(503);
  });

  test("record=false: worker zwraca kontekst z kosztami, ale wstrzyknięcia zapisuje dopiero hook", async () => {
    const ask = async (session: string, record?: boolean) =>
      (await aget("/api/context/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: ids.project,
          session,
          prompt: "zakleszczenie workera na porcie 47777, osierocony proces trzyma gniazdo",
          record,
        }),
      }).then((r) => r.json())) as any;
    const count = (session: string) => {
      const db = new Database(join(home, "hipokamp.db"), { readonly: true });
      const n = (db.query("SELECT COUNT(*) c FROM injections WHERE session_id = ?").get(session) as { c: number }).c;
      db.close();
      return n;
    };
    const off = await ask("s-bez-zapisu", false);
    expect(off.ids).toContain(ids.a);
    expect(off.costs[String(ids.a)]).toBeGreaterThan(0);
    expect(count("s-bez-zapisu")).toBe(0);
    const on = await ask("s-z-zapisem");
    expect(on.ids).toContain(ids.a);
    expect(count("s-z-zapisem")).toBe(on.ids.length);
  });

  test("profil ścieżki promptu w /api/health: czasy etapów z ostatnich przypomnień", async () => {
    // poprzedni test wysłał dwa prompty (bez modelu: samo FTS, bez szukania w innych projektach)
    const h = await getJson("/api/health");
    expect(h.promptPathMs.n).toBeGreaterThanOrEqual(2);
    expect(h.promptPathMs.globalShare).toBe(0);
    for (const k of ["embed", "fts", "vec", "rank", "total"]) {
      expect(h.promptPathMs.p50[k]).toBeGreaterThanOrEqual(0);
      expect(h.promptPathMs.p95[k]).toBeGreaterThanOrEqual(h.promptPathMs.p50[k]);
    }
    expect(h.promptPathMs.last.global).toBe(false);
  });

  test("pusty type= nie zeruje listy", async () => {
    const all = await getJson("/api/recent");
    const empty = await getJson("/api/recent?type=");
    expect(all.length).toBe(3);
    expect(empty.length).toBe(all.length);
  });

  test("kursor (created_at, id) przechodzi przez notatki z tym samym czasem", async () => {
    const seen: number[] = [];
    let cursor: { at: number; id: number } | null = null;
    for (let i = 0; i < 6; i++) {
      const qs: string = cursor ? `&before=${cursor.at}&before_id=${cursor.id}` : "";
      const rows = await getJson(`/api/recent?limit=1${qs}`);
      if (!rows.length) break;
      seen.push(rows[0].id);
      cursor = { at: rows[0].created_at, id: rows[0].id };
    }
    expect(seen.length).toBe(3);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort((x, y) => y - x)).toEqual(seen);
  });

  test("sesja zwraca podsumowanie z listami, nie surowym JSON-em", async () => {
    const d = await getJson("/api/session/s1");
    expect(d.session.id).toBe("s1");
    expect(Array.isArray(d.summary.files_read)).toBe(true);
    expect(Array.isArray(d.summary.files_edited)).toBe(true);
  });

  test("strumień: hello i powtórka po Last-Event-ID", async () => {
    const [first, , last] = [ids.a, ids.b, ids.c].sort((x, y) => x - y);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await get("/api/stream", { headers: { "last-event-id": String(first) }, signal: ctrl.signal });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 4000;
    try {
      while (Date.now() < deadline && (buf.match(/event: observation/g) ?? []).length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    } catch {
      // przerwane po czasie: asercje niżej powiedzą, czego zabrakło
    }
    clearTimeout(timer);
    ctrl.abort();
    expect(buf).toContain("event: hello");
    expect((buf.match(/event: observation/g) ?? []).length).toBe(2);
    expect(buf).toContain(`id: ${last}`);
    expect(buf).not.toContain(`id: ${first}\n`);
  });

  test("strumień: notatka z innego komputera (numer ponad licznikiem) nie przesuwa kursora, własna nowa przychodzi", async () => {
    // jak po `hipokamp sync pull`: wiersz z przestrzeni urządzenia 2, licznik sqlite_sequence wraca do własnej
    const FOREIGN = 200_000_005;
    const db = new Database(join(home, "hipokamp.db"));
    db.run("PRAGMA busy_timeout = 5000");
    const seq = (db.query("SELECT seq FROM sqlite_sequence WHERE name = 'observations'").get() as { seq: number }).seq;
    db.run("CREATE TEMP TABLE obca AS SELECT * FROM observations WHERE id = ?", [ids.a]);
    db.run("UPDATE obca SET id = ?, content_hash = 'obca-notatka', turn_key = NULL, title = 'Notatka z innego komputera'", [
      FOREIGN,
    ]);
    db.run("INSERT INTO observations SELECT * FROM obca");
    db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'observations'", [seq]);
    db.close();

    const read = async (headers: Record<string, string>, until: (buf: string) => boolean, act?: () => Promise<void>) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await get("/api/stream", { headers, signal: ctrl.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        buf += dec.decode((await reader.read()).value); // hello (i powtórka): subskrypcja już działa
        await act?.();
        while (!until(buf)) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
        }
      } catch {
        // przerwane po czasie: asercje niżej powiedzą, czego zabrakło
      }
      clearTimeout(timer);
      ctrl.abort();
      return buf;
    };

    // powtórka po Last-Event-ID: tylko własne notatki do licznika
    const replay = await read({ "last-event-id": String(Math.min(ids.a, ids.b, ids.c) - 1) }, (b) =>
      b.includes(`id: ${Math.max(ids.a, ids.b, ids.c)}`),
    );
    expect(replay).not.toContain(`id: ${FOREIGN}`);

    // na żywo: własna nowa notatka przychodzi (kursor strumienia nie przeskoczył na numer innego komputera)
    let own = 0;
    const live = await read(
      {},
      (b) => own > 0 && b.includes(`id: ${own}`),
      async () => {
        const res = await aget("/api/remember", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: "alfa", title: "własna notatka po odbiorze", text: "notatka po synchronizacji" }),
        });
        own = ((await res.json()) as { id: number }).id;
      },
    );
    expect(own).toBe(seq + 1);
    expect(live).toContain(`id: ${own}`);
    expect(live).not.toContain(`id: ${FOREIGN}`);
  });

  test("zbiorcze TODO: listy ze wszystkich projektów, projekty łączone bez względu na wielkość liter", async () => {
    type Lists = { project: string; name: string; closed: boolean; items: { task: string; status: string }[] }[];
    const post = (project: string, list: string, fields: Record<string, unknown>) =>
      get("/api/work-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, list, fields }),
      });
    expect((await post("Alfa", "zb-sprint", { task: "napisz test", status: "doing" })).status).toBe(200);
    await post("alfa", "zb-sprint", { task: "zrób wdrożenie", status: "todo" });
    await post("beta", "zb-plan", { task: "stara rzecz", status: "done" });
    await post("beta", "zb-plan", { status: "done" }); // status listy done zamyka ją
    await post("beta", "zb-otwarta", { task: "czeka na decyzję", status: "blocked" });
    // SQLite NOCASE zwija tylko ASCII: Żaba i żaba to różne projekty, więc dwie osobne listy
    await post("Żaba", "zb-wielkie", { task: "a", status: "todo" });
    await post("żaba", "zb-wielkie", { task: "b", status: "todo" });

    const open = (await getJson("/api/work-state/all")) as Lists;
    const sprint = open.find((l) => l.name === "zb-sprint");
    expect(sprint?.project).toBe("alfa"); // nazwa z najnowszego wpisu, jedna lista mimo różnej wielkości liter
    expect(sprint?.items.map((i) => i.task)).toEqual(["napisz test", "zrób wdrożenie"]);
    expect(open.some((l) => l.name === "zb-otwarta" && l.project === "beta")).toBe(true);
    expect(open.some((l) => l.name === "zb-plan")).toBe(false);
    expect(
      open
        .filter((l) => l.name === "zb-wielkie")
        .map((l) => l.project)
        .sort(),
    ).toEqual(["Żaba", "żaba"].sort());

    const all = (await getJson("/api/work-state/all?closed=1")) as Lists;
    expect(all.find((l) => l.name === "zb-plan")?.closed).toBe(true);

    // zmiana statusu z podglądu to zwykły wpis: najnowszy wygrywa także przy innej pisowni projektu
    await post("ALFA", "zb-sprint", { task: "napisz test", status: "done" });
    const after = (await getJson("/api/work-state/all")) as Lists;
    expect(after.find((l) => l.name === "zb-sprint")?.items.find((i) => i.task === "napisz test")?.status).toBe("done");
  });

  test("zdrowie: diagnostyka przestojów (maksimum z minuty, winowajca, czasy zadań w tle)", async () => {
    const h = await getJson("/api/health");
    expect(h.eventLoopWindowS).toBe(60);
    expect(h.eventLoopStalls).toBe(0);
    expect(h.lagCulprit === null || typeof h.lagCulprit.name === "string").toBe(true);
    expect(h.backgroundTasks["podgląd: nowe notatki"]?.runs ?? 0).toBeGreaterThanOrEqual(0);
    expect(h.backgroundTasks["kolejka awaryjna"].runs).toBe(1);
    expect(h.embedQueue).toBe(0);
  });

  test("aktywność dzień po dniu: stała liczba dni, dziś na końcu, notatka z dzisiaj policzona", async () => {
    type Day = { day: string; notes: number; sessions: number };
    const remembered = await aget("/api/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "alfa", title: "notatka na dziś", text: "treść do wykresu aktywności" }),
    });
    expect(remembered.status).toBe(200);
    const days = (await getJson("/api/activity?days=7")) as Day[];
    expect(days).toHaveLength(7);
    expect(days[6].day).toBe(dayInWorkerTz(Date.now()));
    expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort());
    expect(days[6].notes).toBeGreaterThanOrEqual(1);
    expect(((await getJson("/api/activity")) as Day[]).length).toBe(14);
    expect(((await getJson("/api/activity?days=999")) as Day[]).length).toBe(90);
  });

  test("aktywność dzień po dniu: granica dnia w strefie workera (minuta przed i po północy)", async () => {
    type Day = { day: string; notes: number; sessions: number };
    // dni z odpowiedzi workera, nie z zegara testu: północ w Kiritimati między dwoma odczytami nie robi wyścigu
    const before = (await getJson("/api/activity?days=2")) as Day[];
    const [y, m, d] = before[1].day.split("-").map(Number);
    const midnight = Date.UTC(y, m - 1, d) - WORKER_TZ_OFFSET_MS;
    expect(before[0].day).toBe(dayInWorkerTz(midnight - 1));
    expect(before[1].day).toBe(dayInWorkerTz(midnight));
    const made: number[] = [];
    for (const title of ["minuta przed północą", "minuta po północy"]) {
      const r = await aget("/api/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "alfa", title, text: `granica dnia aktywności: ${title}` }),
      });
      made.push(((await r.json()) as { id: number }).id);
    }
    const db = new Database(join(home, "hipokamp.db"));
    try {
      db.run("UPDATE observations SET created_at = ? WHERE id = ?", [midnight - 60_000, made[0]]);
      db.run("UPDATE observations SET created_at = ? WHERE id = ?", [midnight + 60_000, made[1]]);
    } finally {
      db.close();
    }
    // trzy dni i wybór po etykiecie: gdy w międzyczasie minęła północ, oba dni z `before` są dalej w odpowiedzi
    const after = (await getJson("/api/activity?days=3")) as Day[];
    const notesOn = (day: string) => after.find((x) => x.day === day)?.notes;
    expect([notesOn(before[0].day), notesOn(before[1].day)]).toEqual([before[0].notes + 1, before[1].notes + 1]);
  });

  // --- zapomnij i przywróć z podglądu, zmiany statusu w strumieniu (T-09). Na końcu: zmieniają stan notatek.

  test("zapomnij i przywróć: walidacja, kontrola pochodzenia, miękkie archiwum z powodem, numer zostaje", async () => {
    const before = await getJson(`/api/observation/${ids.a}`);
    expect(before.status).toBe("active");
    for (const body of [
      {},
      { ids: [] },
      { ids: ["abc"] },
      { ids: [-1] },
      { ids: [1.5] },
      { ids: [0] },
      { ids: [ids.a], reason: 5 },
      { ids: Array.from({ length: 201 }, (_, i) => i + 1) },
    ])
      expect({ body, status: (await post("/api/forget", body)).status }).toEqual({ body, status: 400 });
    expect((await post("/api/forget", "{to nie json")).status).toBe(400);
    expect((await post("/api/forget", { ids: [ids.a] }, { origin: "http://localhost:5173" })).status).toBe(403);
    expect((await post("/api/forget", { ids: [ids.a] }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("/api/forget", { ids: [ids.a] }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await get("/api/forget")).status).toBe(404);
    // odrzucone żądania niczego nie zmieniły
    expect((await getJson(`/api/observation/${ids.a}`)).status).toBe("active");
    expect((await post("/api/forget", { ids: [999_999_999] }).then((r) => r.json())).changed).toEqual([]);

    // ciało ponad 64 KB odrzucone przed czytaniem; cały serwer ma limit 8 MB (Bun domyślnie 128 MB)
    expect((await post("/api/forget", { ids: [ids.a], reason: "x".repeat(70_000) })).status).toBe(413);
    // ponad limit Bun zrywa połączenie (albo odpowiada 413), notatka nie powstaje, a worker działa dalej
    const huge = await apost("/api/remember", { project: "alfa", title: "za duża notatka", text: "x".repeat(9 << 20) }).then(
      (r) => r.status,
      () => "zerwane",
    );
    expect([413, "zerwane"]).toContain(huge);
    expect((await get("/api/health")).ok).toBe(true);
    expect(((await getJson("/api/recent?limit=50")) as { title: string }[]).some((o) => o.title === "za duża notatka")).toBe(
      false,
    );

    // powód pisze model (MCP) albo człowiek: przed zapisem idzie przez clean() jak każdy tekst z transkryptu.
    // Token sklejany w czasie testu, żeby skaner sekretów nie brał pliku za wyciek
    const token = `ghp_${"a1B2c3D4".repeat(5)}`;
    const f = await post("/api/forget", { ids: [`#${ids.a}`], reason: `  błędna notatka, token ${token}  ` }).then((r) =>
      r.json(),
    );
    expect(f.changed).toEqual([ids.a]);
    expect(f.observations[0]).toMatchObject({
      id: ids.a,
      status: "archived",
      meta: { forget_reason: "błędna notatka, token [REDACTED:github-token]" },
    });
    expect(f.observations[0].meta.forgotten_at).toBeGreaterThan(0);
    const raw = new Database(join(home, "hipokamp.db"), { readonly: true });
    const stored = raw.query("SELECT meta FROM observations WHERE id = ?").get(ids.a) as { meta: string };
    const logged = JSON.stringify(raw.query("SELECT * FROM status_log WHERE obs_id = ?").all(ids.a));
    raw.close();
    expect(stored.meta).not.toContain(token);
    expect(logged).not.toContain(token);
    expect(((await getJson("/api/recent")) as { id: number }[]).map((o) => o.id)).not.toContain(ids.a);
    expect(((await getJson("/api/recent?status=archived")) as { id: number }[]).map((o) => o.id)).toContain(ids.a);
    expect((await get("/api/recent?status=merged")).status).toBe(400);
    // drugi raz: już w archiwum, nic do zmiany; aktywnej nie da się „przywrócić”
    expect((await post("/api/forget", { ids: [ids.a] }).then((r) => r.json())).changed).toEqual([]);
    expect((await post("/api/restore", { ids: [ids.b] }).then((r) => r.json())).changed).toEqual([]);

    // przywrócenie po zapomnieniu to cofnięcie: meta jak przed zapomnieniem, bez stałej ochrony przed snem
    const r = await post("/api/restore", { ids: [ids.a, `#${ids.a}`] }).then((x) => x.json());
    expect(r.changed).toEqual([ids.a]);
    expect(r.observations[0].status).toBe("active");
    expect(r.observations[0].meta.forget_reason).toBeUndefined();
    expect(r.observations[0].meta.forgotten_at).toBeUndefined();
    expect(r.observations[0].meta.restored_at).toBeUndefined();
    const after = await getJson(`/api/observation/${ids.a}`);
    expect({ id: after.id, title: after.title, created_at: after.created_at }).toEqual({
      id: before.id,
      title: before.title,
      created_at: before.created_at,
    });
  });

  test("przywróć: zastąpione wracają tą samą ścieżką co archiwum, scalone nie; archiwum podglądu z zastąpionymi", async () => {
    const db = new Database(join(home, "hipokamp.db"));
    db.run("PRAGMA busy_timeout = 5000");
    // ids.c zastąpiona przez ids.b (jak klucz w remember albo sen)
    db.run("UPDATE observations SET status = 'superseded', superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?", [
      ids.b,
      Date.now(),
      Date.now(),
      ids.c,
    ]);
    db.close();
    const listed = async (status: string) =>
      ((await getJson(`/api/recent?status=${status}`)) as { id: number }[]).map((o) => o.id);
    expect(await listed("archived")).not.toContain(ids.c);
    expect(await listed("archived,superseded")).toContain(ids.c);
    expect(await listed("active")).not.toContain(ids.c);
    for (const bad of ["merged", "active,merged", "archived,", "superseded;drop"])
      expect({ bad, status: (await get(`/api/recent?status=${encodeURIComponent(bad)}`)).status }).toEqual({ bad, status: 400 });

    const r = await post("/api/restore", { ids: [ids.c] }).then((x) => x.json());
    expect(r.changed).toEqual([ids.c]);
    expect(r.observations[0]).toMatchObject({ id: ids.c, status: "active", superseded_by: null, valid_until: null });
    expect(r.observations[0].meta.supersede_undone.by).toBe(ids.b);
    expect(await listed("archived,superseded")).not.toContain(ids.c);

    // scalona: treść żyje w notatce docelowej, przywracanie jej nie dotyczy
    const db2 = new Database(join(home, "hipokamp.db"));
    db2.run("PRAGMA busy_timeout = 5000");
    db2.run("UPDATE observations SET status = 'merged', merged_into = ? WHERE id = ?", [ids.b, ids.c]);
    try {
      expect((await post("/api/restore", { ids: [ids.c] }).then((x) => x.json())).changed).toEqual([]);
      expect((await post("/api/forget", { ids: [ids.c] }).then((x) => x.json())).changed).toEqual([]);
    } finally {
      db2.run("UPDATE observations SET status = 'active', merged_into = NULL WHERE id = ?", [ids.c]);
      db2.close();
    }
    // zmiany z bazy rozgłoszone teraz (bez słuchaczy kursor tylko się przesuwa), nie w strumieniu następnego testu
    await apost("/api/notify", {});
    await Bun.sleep(150);
  });

  test("strumień: zmiany statusu z podglądu i z innego procesu jako zdarzenia status, dosłanie po kursorze", async () => {
    const ofB = (ev: SseEvent[]) => ev.filter((e) => e.event === "status" && e.data.id === ids.b);
    const s = await openStream("/api/stream");
    try {
      await s.until((ev) => ev.some((e) => e.event === "hello"));
      const hello = s.events.find((e) => e.event === "hello")!;
      expect(hello.data.cursor).toMatch(/^\d+-\d+$/);
      // z podglądu: zdarzenie od razu po zapisie, nie przy ticku workera
      await post("/api/forget", { ids: [ids.b], reason: `stary klucz ghp_${"Zx9".repeat(12)}` });
      await s.until((ev) => ofB(ev).length >= 1);
      // z innego procesu (MCP, sen, CLI): wyzwalacz w bazie i powiadomienie; ten sam status nie tworzy wpisu
      const db = new Database(join(home, "hipokamp.db"));
      db.run("PRAGMA busy_timeout = 5000");
      db.run("UPDATE observations SET status = 'active', updated_at = ? WHERE id = ?", [Date.now(), ids.b]);
      db.run("UPDATE observations SET status = status WHERE id = ?", [ids.c]);
      db.close();
      await apost("/api/notify", {});
      await s.until((ev) => ofB(ev).length >= 2);
    } finally {
      s.close();
    }
    // (zmiana z poprzedniego testu może dojść tuż po połączeniu: rozgłoszenie po zapisie leci do wszystkich)
    const st = ofB(s.events);
    expect(s.events.filter((e) => e.event === "status" && e.data.id === ids.c)).toEqual([]);
    expect(st.map((e) => [e.data.id, e.data.from, e.data.status])).toEqual([
      [ids.b, "active", "archived"],
      [ids.b, "archived", "active"],
    ]);
    // zdarzenie niesie samą zmianę (podgląd dociąga notatkę, gdy ma ją na ekranie): ani treści, ani powodu
    expect(Object.keys(st[0].data).sort()).toEqual(["at", "from", "id", "seq", "status"]);
    expect(JSON.stringify(s.events)).not.toContain("ghp_");
    for (const e of st) expect(e.id).toMatch(/^\d+-\d+$/);

    // nowe połączenie z kursorem sprzed zmian dostaje obie, z kursorem ostatniej żadnej
    const again = await openStream(`/api/stream?since=${encodeURIComponent(s.events[0].data.cursor)}`);
    try {
      await again.until((ev) => ofB(ev).length >= 2);
    } finally {
      again.close();
    }
    expect(ofB(again.events).map((e) => e.data.status)).toEqual(["archived", "active"]);
    const none = await openStream("/api/stream", { "last-event-id": st[1].id! });
    try {
      await none.until(() => false, 800);
    } finally {
      none.close();
    }
    expect(none.events.filter((e) => e.event === "status")).toEqual([]);
  });

  test("strumień: masowa zmiana statusu i długa przerwa dają jedno resync z kursorem na końcu, nie setki zdarzeń", async () => {
    const ofB = (ev: SseEvent[]) => ev.filter((e) => e.event === "status" && e.data.id === ids.b);
    const statusEnd = () => {
      const ro = new Database(join(home, "hipokamp.db"), { readonly: true });
      const m = (ro.query("SELECT MAX(id) m FROM status_log").get() as { m: number }).m;
      ro.close();
      return m;
    };
    const s = await openStream("/api/stream");
    let before = "";
    try {
      await s.until((ev) => ev.some((e) => e.event === "hello"));
      before = s.events.find((e) => e.event === "hello")!.data.cursor;
      // 602 zmian statusu jednej notatki (jak sen albo repair na wielu): więcej niż 200 na takt i 500 do dosłania
      const db = new Database(join(home, "hipokamp.db"));
      db.run("PRAGMA busy_timeout = 5000");
      db.transaction(() => {
        for (let i = 0; i < 602; i++)
          db.run(
            "UPDATE observations SET status = CASE status WHEN 'active' THEN 'archived' ELSE 'active' END, updated_at = ? WHERE id = ?",
            [Date.now(), ids.b],
          );
      })();
      db.close();
      await apost("/api/notify", {});
      await s.until((ev) => ev.some((e) => e.event === "resync"));
    } finally {
      s.close();
    }
    const end = statusEnd();
    const resync = s.events.filter((e) => e.event === "resync");
    expect(resync).toHaveLength(1);
    expect(resync[0].id).toBe(resync[0].data.cursor);
    expect(Number(resync[0].id!.split("-")[1])).toBe(end);
    expect(ofB(s.events)).toEqual([]);
    expect((await getJson(`/api/observation/${ids.b}`)).status).toBe("active");

    // powrót z kursorem sprzed zmian: zamiast 500 z 602 zdarzeń (reszta ginęła) jedno resync, kursor na końcu
    const back = await openStream(`/api/stream?since=${encodeURIComponent(before)}`);
    try {
      await back.until((ev) => ev.some((e) => e.event === "resync"));
    } finally {
      back.close();
    }
    const again = back.events.filter((e) => e.event === "resync");
    expect(again).toHaveLength(1);
    expect(Number(again[0].data.cursor.split("-")[1])).toBe(end);
    expect(ofB(back.events)).toEqual([]);
  });

  test("sen: liczy archiwum bez wierszy wyzwalacza, cofnięte zapomnienie nie chroni, przywrócenie z archiwum snu tak", async () => {
    const old = Date.now() - 400 * 86_400_000;
    const db = new Database(join(home, "hipokamp.db"));
    db.run("PRAGMA busy_timeout = 5000");
    // dokładnie trzy kandydatki do archiwum snu (stare, nieużywane epizody odkrywcze); reszta za ważna
    db.run("UPDATE observations SET importance = 0.5");
    db.run(
      `UPDATE observations SET type = 'discovery', tier = 'episodic', importance = 0.1, access_count = 0, created_at = ?
       WHERE id IN (?, ?, ?)`,
      [old, ids.a, ids.b, ids.c],
    );
    db.run("INSERT INTO status_log (obs_id, from_status, to_status, at) VALUES (?, 'active', 'merged', ?)", [ids.c, old]);
    db.close();
    const sleep = async () => (await post("/api/admin/sleep", {})).json() as Promise<{ archived: number }>;
    const statusOf = async (id: number) => (await getJson(`/api/observation/${id}`)).status;

    // ids.a: zapomniana i od razu Cofnij (jak w podglądzie), więc sen traktuje ją jak każdą inną
    await post("/api/forget", { ids: [ids.a] });
    await post("/api/restore", { ids: [ids.a] });
    // stary kod: .changes liczyło też wiersze dopisane przez wyzwalacz tr_obs_status i raport mówił 6
    expect((await sleep()).archived).toBe(3);
    for (const id of [ids.a, ids.b, ids.c]) expect(await statusOf(id)).toBe("archived");
    const ro = new Database(join(home, "hipokamp.db"), { readonly: true });
    const logged = ro.query("SELECT at, to_status FROM status_log WHERE obs_id = ? ORDER BY id").all(ids.c) as {
      at: number;
      to_status: string;
    }[];
    const report = JSON.parse((ro.query("SELECT v FROM meta WHERE k = 'last_sleep_report'").get() as { v: string }).v);
    ro.close();
    expect(report.archived).toBe(3);
    // wpis sprzed 400 dni przycięty (wcześniejsze testy zostawiły świeże), archiwizacja snu zapisana przez wyzwalacz
    expect(logged.filter((l) => l.at < Date.now() - 30 * 86_400_000)).toEqual([]);
    expect(logged.at(-1)).toMatchObject({ to_status: "archived" });
    expect(logged.at(-1)!.at).toBeGreaterThan(Date.now() - 60_000);

    // przywrócenie z archiwum snu chroni; ponowne zapomnienie i Cofnij tej ochrony nie zabierają
    const restored = await post("/api/restore", { ids: [ids.c] }).then((r) => r.json());
    expect(restored.changed).toEqual([ids.c]);
    expect(restored.observations[0].meta.restored_at).toBeGreaterThan(0);
    const forgotten = await post("/api/forget", { ids: [ids.c] }).then((r) => r.json());
    expect(forgotten.observations[0].meta.forgotten_at).toBeGreaterThan(0);
    const undone = await post("/api/restore", { ids: [ids.c] }).then((r) => r.json());
    expect(undone.observations[0].meta.forgotten_at).toBeUndefined();
    expect(undone.observations[0].meta.restored_at).toBe(restored.observations[0].meta.restored_at);
    expect((await sleep()).archived).toBe(0);
    expect(await statusOf(ids.c)).toBe("active");
  });
});

// Wątek embeddingów: model zastępczy (HIPOKAMP_FAKE_EMBED_MS, tylko w katalogu testowym) blokuje swój wątek
// synchronicznie na 200 ms na tekst, jak ONNX. Na wątku głównym partia 16 notatek to 3,2 s przestoju workera.
describe("wątek embeddingów", () => {
  const home2 = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
  const PORT2 = 47995;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  let w2: Subprocess | undefined;
  const timed = async (path: string, init?: RequestInit, auth = false) => {
    const t = performance.now();
    const r = auth ? (await authed(home2, BASE2, path, init)).res : await viewerFetch(home2, BASE2, path, init);
    const body = (await r.json()) as any;
    return { ms: performance.now() - t, body };
  };

  beforeAll(async () => {
    mkdirSync(join(home2, "claude", "projects"), { recursive: true });
    writeFileSync(join(home2, "config.json"), JSON.stringify({ embed: { enabled: true }, backup: { enabled: false } }));
    w2 = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
      env: {
        ...env,
        HIPOKAMP_HOME: home2,
        HIPOKAMP_PORT: String(PORT2),
        CLAUDE_CONFIG_DIR: join(home2, "claude"),
        CODEX_HOME: join(home2, "codex"),
        HIPOKAMP_FAKE_EMBED_MS: "200",
      },
      cwd: ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try {
        if ((await viewerFetch(home2, BASE2, "/api/health")).ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("worker z wątkiem embeddingów nie wstał");
  }, 30_000);

  afterAll(async () => {
    w2?.kill();
    await w2?.exited;
    try {
      rmSync(home2, { recursive: true, force: true });
    } catch {}
  });

  test("liczenie wektorów nie zatrzymuje pętli, a zapytania mają pierwszeństwo przed partią notatek", async () => {
    // 32 notatki bez wektora: 6,4 s liczenia w wątku (dwie partie po 16)
    for (let i = 0; i < 32; i++) {
      const { res: r } = await authed(home2, BASE2, "/api/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "alfa",
          title: `Notatka ${i}: worker liczy wektory w osobnym wątku`,
          text: `Treść notatki ${i}. `.repeat(40),
        }),
      });
      expect(r.status).toBe(200);
    }
    const health: number[] = [];
    const search: number[] = [];
    const prompt: number[] = [];
    const deadline = Date.now() + 40_000;
    for (let i = 0; ; i++) {
      const h = await timed("/api/health");
      health.push(h.ms);
      const s = await timed("/api/stats");
      if (s.body.missingVectors === 0) break;
      // zapytanie w trakcie liczenia partii: czeka najwyżej na jeden kawałek (jedna notatka), nie na całą partię
      if (i % 3 === 0) search.push((await timed(`/api/search?q=${encodeURIComponent(`wektory w wątku ${i}`)}&limit=5`)).ms);
      // hook promptu: wektor zapytania najwyżej 600 ms, potem sam FTS z adnotacją; całość w budżecie hooka
      if (i % 3 === 1) {
        const pr = await timed(
          "/api/context/prompt",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              project: "alfa",
              session: "s-prompt",
              prompt: `jak worker liczy wektory w wątku ${i}`,
              record: false,
            }),
          },
          true,
        );
        prompt.push(pr.ms);
        if (pr.body.vectors) expect(pr.body.vectors).toContain("sam FTS");
      }
      if (Date.now() > deadline) throw new Error("wektory nie policzone w 40 s");
      await Bun.sleep(100);
    }
    expect(search.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...health)).toBeLessThan(1000);
    expect(Math.max(...search)).toBeLessThan(1500);
    expect(prompt.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...prompt)).toBeLessThan(1200);
    const h = (await timed("/api/health")).body;
    expect(h.embedder.device).toBe("fake");
    expect(h.embedder.loaded).toBe(true);
    expect(h.embedded).toBeGreaterThanOrEqual(32);
    expect(h.eventLoopLagMaxMs).toBeLessThan(1000);
    expect(h.eventLoopStalls).toBe(0);
    expect(h.backgroundTasks["wektory: liczenie"].runs).toBeGreaterThanOrEqual(2);
    // wynik wyszukiwania korzysta z wektorów z wątku
    const hits = (await timed(`/api/search?q=${encodeURIComponent("Notatka 7: worker liczy wektory w osobnym wątku")}&limit=3`))
      .body;
    expect(hits[0].cos).not.toBeNull();
  }, 60_000);
});

// Limit wektora zapytania w hooku promptu: jeden termin na całe żądanie. Prompt szuka dwa razy (projekt i globalnie),
// więc limit liczony osobno dla każdego wywołania dawał przy wolnym modelu 2 × 600 ms zamiast 600 ms.
describe("limit wektora w hooku promptu", () => {
  const home3 = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
  const PORT3 = 47988;
  const BASE3 = `http://127.0.0.1:${PORT3}`;
  let w3: Subprocess | undefined;
  const health3 = async () => (await viewerFetch(home3, BASE3, "/api/health")).json() as Promise<any>;

  beforeAll(async () => {
    mkdirSync(join(home3, "claude", "projects"), { recursive: true });
    writeFileSync(join(home3, "config.json"), JSON.stringify({ embed: { enabled: true }, backup: { enabled: false } }));
    w3 = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
      env: {
        ...env,
        HIPOKAMP_HOME: home3,
        HIPOKAMP_PORT: String(PORT3),
        CLAUDE_CONFIG_DIR: join(home3, "claude"),
        CODEX_HOME: join(home3, "codex"),
        // wolniej niż dwa limity: bez wspólnego terminu drugie wyszukiwanie czekałoby kolejne 600 ms
        HIPOKAMP_FAKE_EMBED_MS: "1500",
      },
      cwd: ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 300; i++) {
      try {
        // model gotowy i rozgrzewka (jeden tekst, 1,5 s) skończona: pomiar bez zimnego startu wątku
        const h = await health3();
        if (h.embedder.loaded && h.embedQueue === 0) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("worker z wolnym modelem nie wstał");
  }, 40_000);

  afterAll(async () => {
    w3?.kill();
    await w3?.exited;
    try {
      rmSync(home3, { recursive: true, force: true });
    } catch {}
  });

  test("model wolniejszy niż limit: cały prompt mieści się w jednym limicie i dostaje adnotację", async () => {
    const { res: r } = await authed(home3, BASE3, "/api/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "alfa", title: "Limit hooka promptu", text: "wektor zapytania i sam FTS" }),
    });
    expect(r.status).toBe(200);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      // wątek zapytań może jeszcze liczyć poprzednie zapytanie: limit i tak obejmuje całe żądanie
      const t = performance.now();
      const { res: pr } = await authed(home3, BASE3, "/api/context/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "alfa", session: "s-limit", prompt: `limit hooka promptu numer ${i}`, record: false }),
      });
      const body = (await pr.json()) as { vectors?: string | null };
      times.push(performance.now() - t);
      expect(body.vectors).toContain("600 ms: sam FTS");
    }
    expect(Math.max(...times)).toBeLessThan(900);
  }, 30_000);
});

/** POST JSON do workera (body jako obiekt albo surowy tekst), z dodatkowymi nagłówkami. */
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return get(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type SseEvent = { event: string; id: string | null; data: any };

/** Strumień SSE z parserem zdarzeń; until() czyta, aż warunek spełniony albo minie czas (bez wyjątku). */
async function openStream(path: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const r = await get(path, { headers, signal: ctrl.signal });
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = "";
  // odczyt czekający dłużej niż until() zostaje na następne wywołanie: porzucony zjadłby kawałek strumienia
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
  const take = () => {
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const field = (k: string) =>
        block
          .split("\n")
          .find((l) => l.startsWith(`${k}: `))
          ?.slice(k.length + 2) ?? null;
      const data = field("data");
      events.push({ event: field("event") ?? "message", id: field("id"), data: data ? JSON.parse(data) : null });
    }
  };
  return {
    events,
    async until(pred: (ev: SseEvent[]) => boolean, ms = 4000) {
      const deadline = Date.now() + ms;
      while (!pred(events) && Date.now() < deadline) {
        pending ??= reader.read().catch(() => ({ done: true }));
        const timeout = Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null);
        const res = await Promise.race([pending, timeout]);
        if (!res) break;
        pending = null;
        if (res.done || !res.value) break;
        buf += dec.decode(res.value, { stream: true });
        take();
      }
    },
    close: () => ctrl.abort(),
  };
}
