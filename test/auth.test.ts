// Uwierzytelnienie workera (T-17): protokół wyzwania i odpowiedzi (wektory wspólne z natywnym hookiem w Go), klucz
// (tworzenie bez wyścigu, uszkodzony plik, odświeżanie, uprawnienia tylko dla użytkownika), worker (401 bez dowodu na
// trasach klientów, podgląd bez klucza jak dotąd, jednorazowy i krótko ważny nonce), klient (zły i brak sekretu,
// podszyty serwer na porcie, powtórka dowodu, starszy worker bez /api/auth: rozpoznanie i zastąpienie nowym) oraz
// koszt na wywołaniu. Część z klientem w osobnym procesie z katalogiem „hipokamp-test” (jak install.test.ts):
// config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authedFetch,
  ChallengeStore,
  ensureKey,
  H_CHALLENGE,
  H_NONCE,
  H_PROOF,
  handshake,
  loadKey,
  readKey,
  sign,
  verify,
} from "../src/worker/auth.ts";
import {
  checkKeyAcl,
  hardenKey,
  hardenKeyOnce,
  judgeDacl,
  lookupSid,
  parseSddl,
  type WhoamiRun,
  whoamiPlan,
} from "../src/worker/keyacl.ts";

const CHILD = "HIPOKAMP_AUTH_CHILD";
const ROOT = join(import.meta.dir, "..");
const freePort = () => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
};

if (!process.env[CHILD]) {
  describe("protokół i klucz (bez katalogu danych)", () => {
    const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const A = "00112233445566778899aabbccddeeff";
    const B = "ffeeddccbbaa99887766554433221100";

    test("wektory wspólne z natywnym hookiem (native/hook/main_test.go: TestAuthVectors)", () => {
      expect(sign(K, "worker", 47777, [A, B])).toBe("e571c88d72bf800c555be35b508902fa2b22bc8c5b7b564fe6423fa1038dad0a");
      expect(sign(K, "client", 47777, [B, "POST /api/hook/prompt"])).toBe(
        "ac6b195301ecbfbdc0514c6d898dbdb71f92d251764767dbcd8d50ff161d4017",
      );
      expect(sign(K, "response", 47777, [A, B, "200"])).toBe("33358c6a84a384b0fc46fc7a0c389eb37f03ea4341c9bd613ef20e73e3dd550e");
    });

    test("dowód: inny klucz, port, etykieta, nonce, format: odrzucony", () => {
      const p = sign(K, "worker", 47777, [A, B]);
      expect(verify(K, "worker", 47777, [A, B], p)).toBe(true);
      expect(verify(Buffer.alloc(32, 7), "worker", 47777, [A, B], p)).toBe(false);
      expect(verify(K, "worker", 47778, [A, B], p)).toBe(false);
      expect(verify(K, "response", 47777, [A, B], p)).toBe(false);
      expect(verify(K, "worker", 47777, [B, A], p)).toBe(false);
      for (const bad of [p.toUpperCase(), p.slice(1), `${p}0`, "", null, 42, { p }])
        expect(verify(K, "worker", 47777, [A, B], bad)).toBe(false);
    });

    test("nonce workera: jednorazowy, krótko ważny, limit wpisów", () => {
      const s = new ChallengeStore(1000, 3);
      const n1 = s.issue(A, 0);
      expect(s.take(n1, 10)).toBe(A);
      expect(s.take(n1, 20)).toBeNull(); // drugi raz nie
      const n2 = s.issue(A, 0);
      expect(s.take(n2, 1001)).toBeNull(); // przeterminowany
      expect(s.take(n2, 0)).toBeNull(); // i zużyty przy próbie
      const many = [0, 1, 2, 3, 4].map((t) => s.issue(B, t));
      expect(s.size).toBeLessThanOrEqual(3);
      expect(s.take(many[0], 5)).toBeNull(); // najstarszy wypchnięty limitem
      expect(s.take(many[4], 5)).toBe(B);
    });

    test("klucz: tworzony raz (wiele procesów naraz ma ten sam), uszkodzony zastąpiony, zmiana pliku widoczna bez restartu", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hipokamp-test-key-"));
      try {
        const f = join(dir, "state", "worker.key");
        const script = join(dir, "make.ts");
        writeFileSync(
          script,
          `import { ensureKey } from ${JSON.stringify(join(ROOT, "src", "worker", "auth.ts"))};\nprocess.stdout.write(ensureKey(process.argv[2]).key.toString("hex"));\n`,
        );
        const procs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, script, f], { stdout: "pipe" }));
        const keys = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(readKey(f)?.toString("hex")).toBe(keys[0]);
        if (process.platform !== "win32") expect(statSync(f).mode & 0o077).toBe(0);
        expect(loadKey(f)?.toString("hex")).toBe(keys[0]);
        // uszkodzony plik: nowy klucz
        writeFileSync(f, "to nie klucz\n");
        const fresh = ensureKey(f);
        expect(fresh.created).toBe(true);
        expect(fresh.key.toString("hex")).not.toBe(keys[0]);
        // zmiana pliku (inny proces): loadKey widzi nowy klucz
        await Bun.sleep(20);
        writeFileSync(f, `${"ab".repeat(32)}\n`);
        expect(loadKey(f)?.toString("hex")).toBe("ab".repeat(32));
        // bez prawa tworzenia: brak pliku to null
        expect(loadKey(join(dir, "brak", "worker.key"), false)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("stary uszkodzony klucz naprawiany od razu, świeży pusty plik czeka na zapis, worker (bez tworzenia) nie naprawia", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hipokamp-test-keyage-"));
      try {
        const f = join(dir, "state", "worker.key");
        mkdirSync(join(dir, "state"), { recursive: true });
        const old = new Date(Date.now() - 60_000);
        // plik sprzed minuty bez klucza: uszkodzony, bez czekania
        writeFileSync(f, "uszkodzony\n");
        utimesSync(f, old, old);
        let t = performance.now();
        const fixed = ensureKey(f);
        expect(performance.now() - t).toBeLessThan(500);
        expect(fixed.created).toBe(true);
        expect(readKey(f)?.equals(fixed.key)).toBe(true);
        // loadKey bez prawa tworzenia (worker): null od razu, plik nietknięty
        writeFileSync(f, "uszkodzony\n");
        utimesSync(f, old, old);
        t = performance.now();
        expect(loadKey(f, false)).toBeNull();
        expect(performance.now() - t).toBeLessThan(100);
        expect(readFileSync(f, "utf8")).toBe("uszkodzony\n");
        // świeży pusty plik (zwycięzca wyścigu jeszcze pisze): przegrany czeka i czyta jego klucz
        const writer = join(dir, "writer.ts");
        writeFileSync(
          writer,
          `await Bun.sleep(50);\nrequire("node:fs").writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(`${"ef".repeat(32)}\n`)});\n`,
        );
        writeFileSync(f, "");
        const w = Bun.spawn([process.execPath, writer], { stdout: "ignore", stderr: "ignore" });
        const won = ensureKey(f);
        await w.exited;
        expect(won).toEqual({ key: Buffer.from("ef".repeat(32), "hex"), created: false });
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }, 30_000);

    test("uszkodzony klucz naprawiany przez wiele procesów naraz: na końcu każdy ma w pamięci klucz z dysku", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hipokamp-test-keyrace-"));
      try {
        const f = join(dir, "state", "worker.key");
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(f, "uszkodzony\n");
        const script = join(dir, "race.ts");
        writeFileSync(
          script,
          [
            `import { existsSync, writeFileSync } from "node:fs";`,
            `import { join } from "node:path";`,
            `import { loadKey } from ${JSON.stringify(join(ROOT, "src", "worker", "auth.ts"))};`,
            "const [f, dir, i] = process.argv.slice(2);",
            // wszystkie procesy zaczynają naprawę w tej samej chwili (bez rozrzutu startu Buna)
            "writeFileSync(join(dir, 'up-' + i), '');",
            "while (!existsSync(join(dir, 'start'))) Bun.sleepSync(2);",
            "const k1 = loadKey(f);",
            "writeFileSync(join(dir, 'ready-' + i), '');",
            "while (!existsSync(join(dir, 'go'))) Bun.sleepSync(10);",
            "const k2 = loadKey(f);",
            "process.stdout.write(JSON.stringify({ k1: k1?.toString('hex') ?? null, k2: k2?.toString('hex') ?? null }));",
          ].join("\n"),
        );
        const N = 16;
        const procs = Array.from({ length: N }, (_, i) =>
          Bun.spawn([process.execPath, script, f, dir, String(i)], { stdout: "pipe", stderr: "pipe" }),
        );
        const until = Date.now() + 60_000;
        const all = async (name: string) => {
          while (Array.from({ length: N }, (_, i) => existsSync(join(dir, `${name}-${i}`))).includes(false)) {
            if (Date.now() > until) throw new Error(`procesy nie doszły do etapu ${name}`);
            await Bun.sleep(10);
          }
        };
        await all("up");
        writeFileSync(join(dir, "start"), "");
        await all("ready");
        writeFileSync(join(dir, "go"), "");
        const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
        const disk = readKey(f)?.toString("hex");
        expect(disk).toMatch(/^[0-9a-f]{64}$/);
        const res = outs.map((o) => JSON.parse(o) as { k1: string | null; k2: string | null });
        expect(res.filter((r) => r.k1 === null)).toEqual([]);
        expect(res.map((r) => r.k2)).toEqual(Array(N).fill(disk));
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }, 90_000);

    test("klient odrzuca odpowiedź bez dowodu, z dowodem innego statusu i z dowodem o innej etykiecie", async () => {
      // udawany worker zna klucz i przechodzi wyzwanie, ale dowód odpowiedzi psuje według ścieżki
      const challenges = new ChallengeStore();
      const seen: string[] = [];
      const srv: ReturnType<typeof Bun.serve> = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req): Response {
          const u = new URL(req.url);
          seen.push(`${req.method} ${u.pathname}`);
          if (u.pathname === "/api/auth") {
            const nc = req.headers.get(H_CHALLENGE) ?? "";
            const nw = challenges.issue(nc);
            return Response.json({ app: "hipokamp", auth: 1, nonce: nw, proof: sign(K, "worker", srv.port!, [nc, nw]) });
          }
          const nw = req.headers.get(H_NONCE) ?? "";
          const nc = challenges.take(nw) ?? "";
          const res = Response.json({ hookSpecificOutput: { additionalContext: "wstrzyknięcie" } });
          const proofs: Record<string, string | null> = {
            "/dobry": sign(K, "response", srv.port!, [nc, nw, "200"]),
            "/bez-dowodu": null,
            "/inny-status": sign(K, "response", srv.port!, [nc, nw, "201"]),
            "/etykieta-worker": sign(K, "worker", srv.port!, [nc, nw, "200"]),
            "/etykieta-client": sign(K, "client", srv.port!, [nc, nw, "200"]),
            "/inny-port": sign(K, "response", srv.port! + 1, [nc, nw, "200"]),
            "/zle-nonce": sign(K, "response", srv.port!, [nw, nc, "200"]),
          };
          const proof = proofs[u.pathname];
          if (proof) res.headers.set(H_PROOF, proof);
          return res;
        },
      });
      try {
        const base = `http://127.0.0.1:${srv.port}`;
        const call = (path: string) => authedFetch({ base, port: srv.port!, key: K, path, method: "POST", body: "{}" });
        const ok = await call("/dobry");
        expect(ok?.status).toBe(200); // kontrola: poprawny dowód przechodzi
        for (const path of ["/bez-dowodu", "/inny-status", "/etykieta-worker", "/etykieta-client", "/inny-port", "/zle-nonce"])
          expect([path, await call(path)]).toEqual([path, null]);
        expect(seen.filter((s) => s === "GET /api/auth")).toHaveLength(7);
      } finally {
        srv.stop(true);
      }
    });

    test("ACL klucza: tylko bieżący użytkownik (Windows: icacls, POSIX: 0600), znacznik: drugi raz bez icacls", () => {
      const dir = mkdtempSync(join(tmpdir(), "hipokamp-test-acl-"));
      try {
        const f = join(dir, "state", "worker.key");
        const { key } = ensureKey(f);
        const win = process.platform === "win32";
        // katalog tymczasowy dziedziczy wpisy SYSTEM, Administratorzy itd.: przed nadaniem ACL sprawdzenie to widzi
        if (win) expect(checkKeyAcl(f)).toMatchObject({ ok: false });
        const t0 = performance.now();
        const st = hardenKey(f);
        console.log(`ACL klucza: pierwsze nadanie ${(performance.now() - t0).toFixed(0)} ms`);
        expect(st).toMatchObject({ ok: true });
        expect(checkKeyAcl(f).ok).toBe(true);
        expect(readKey(f)?.equals(key)).toBe(true); // właściciel nadal czyta
        expect(hardenKeyOnce(f)?.ok).toBe(true);
        expect(existsSync(`${f}.acl`)).toBe(true);
        expect(hardenKeyOnce(f)).toBeNull(); // ten sam klucz: pominięte
        expect(hardenKeyOnce(f, true)?.ok).toBe(true);
        if (win) {
          // nowy klucz i próba bez czasu (termin minął): nieudana, znacznik nieudanej próby wstrzymuje następne
          writeFileSync(f, `${"cd".repeat(32)}\n`);
          const t1 = performance.now();
          expect(hardenKeyOnce(f, false, 0)).toMatchObject({ ok: false });
          expect(performance.now() - t1).toBeLessThan(500);
          expect(existsSync(`${f}.acl-fail`)).toBe(true);
          expect(hardenKeyOnce(f)).toBeNull(); // w hooku: bez icacls do upływu RETRY_AFTER_MS
          expect(hardenKeyOnce(f, true)?.ok).toBe(true); // install: zawsze
          expect(existsSync(`${f}.acl-fail`)).toBe(false);
          expect(hardenKeyOnce(f)).toBeNull();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    test("ACL z SDDL (icacls /save): ocena po SID, nie po nazwie konta", () => {
      const me = "S-1-5-21-1111111111-2222222222-3333333333-1001";
      const inherited = `worker.key\r\nD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${me})\r\n`;
      expect(parseSddl(inherited)).toEqual({
        protected: false,
        aces: [
          { type: "A", flags: "ID", rights: "FA", sid: "SY" },
          { type: "A", flags: "ID", rights: "FA", sid: "BA" },
          { type: "A", flags: "ID", rights: "FA", sid: me },
        ],
      });
      expect(judgeDacl(parseSddl(inherited), me).ok).toBe(false);
      expect(judgeDacl(parseSddl(`worker.key\r\nD:PAI(A;;FA;;;${me})\r\n`), me)).toEqual({
        ok: true,
        detail: "tylko bieżący użytkownik",
      });
      // inne konto z jawnym wpisem, brak ochrony przed dziedziczeniem, pusty DACL, śmieci
      expect(judgeDacl(parseSddl(`D:PAI(A;;FA;;;${me})(A;;FR;;;S-1-5-21-9-9-9-1002)`), me).ok).toBe(false);
      expect(judgeDacl(parseSddl(`D:AI(A;;FA;;;${me})`), me).ok).toBe(false);
      expect(judgeDacl(parseSddl("D:P"), me).ok).toBe(false);
      expect(judgeDacl(parseSddl("coś innego"), me).ok).toBe(false);
      // wpis odmowy niczego nie otwiera
      expect(judgeDacl(parseSddl(`D:PAI(D;;FA;;;WD)(A;;FA;;;${me})`), me).ok).toBe(true);
    });

    test("SID z whoami: ponowienie poza hookiem, limit próby z zapasem na icacls, powód w komunikacie (T-45)", () => {
      const me = "S-1-5-21-1111111111-2222222222-3333333333-1001";
      const line = `"pc\\ja","${me}"\r\n`;
      // podmienione wywołanie i zegar: zawieszone wywołanie „trwa” cały swój limit, przerwy też płyną
      const fake = (results: WhoamiRun[], budget: number) => {
        let now = 0;
        const calls: number[] = [];
        const pauses: number[] = [];
        const r = lookupSid(
          (t) => {
            calls.push(t);
            const x = results[calls.length - 1] ?? { why: "brak" };
            now += "why" in x && x.why === "limit czasu" ? t : 30;
            return x;
          },
          () => budget - now,
          whoamiPlan(budget),
          (ms) => {
            pauses.push(ms);
            now += ms;
          },
        );
        return { r, calls, pauses, left: budget - now };
      };
      // termin doctor/install (15 s): 3 próby po (15 s - 3 s na icacls - 0,6 s przerw) / 3
      expect(whoamiPlan(15_000)).toEqual({ tries: 3, tryMs: 3800 });
      // termin hooka: jedna próba z całym terminem, bez ponowień
      expect(whoamiPlan(1500)).toEqual({ tries: 1, tryMs: 1500 });
      // pierwsza próba bez SID (stan po restarcie), druga z kodem błędu, trzecia udana
      const ok = fake(
        [
          { status: 0, stdout: "" },
          { status: 1, stdout: "" },
          { status: 0, stdout: line },
        ],
        15_000,
      );
      expect(ok.r).toEqual({ sid: me });
      expect(ok.calls).toEqual([3800, 3800, 3800]);
      expect(ok.pauses).toEqual([200, 400]);
      // od razu udane: jedno wywołanie, bez przerwy
      expect(fake([{ status: 0, stdout: line }], 15_000)).toMatchObject({ r: { sid: me }, calls: [3800], pauses: [] });
      // trzy porażki: powód ostatniej i liczba prób
      expect(fake([{ why: "x" }, { status: 0, stdout: "śmieci" }, { status: 5, stdout: "" }], 15_000).r).toEqual({
        why: "kod 5, prób: 3",
      });
      // trzy zawieszone próby w doctor: icacls zostaje cały zapas
      const slow = fake([{ why: "limit czasu" }, { why: "limit czasu" }, { why: "limit czasu" }], 15_000);
      expect(slow.calls).toEqual([3800, 3800, 3800]);
      expect(slow.r).toEqual({ why: "limit czasu, prób: 3" });
      expect(slow.left).toBeGreaterThanOrEqual(3000);
      // termin hooka (1,5 s): jedna próba, także po szybkiej porażce nie ma drugiej
      expect(fake([{ why: "limit czasu" }, { status: 0, stdout: line }], 1500)).toMatchObject({
        calls: [1500],
        r: { why: "limit czasu, prób: 1" },
      });
      expect(
        fake(
          [
            { status: 0, stdout: "" },
            { status: 0, stdout: line },
          ],
          1500,
        ),
      ).toMatchObject({
        calls: [1500],
        pauses: [],
        r: { why: "brak SID w wyniku, prób: 1" },
      });
    });
  });

  test("klient i worker (osobny proces, katalog testowy, własny port)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-auth-"));
    mkdirSync(join(home, "claude", "projects"), { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ embed: { enabled: false }, backup: { enabled: false } }));
    const env = { ...(process.env as Record<string, string>) };
    Reflect.deleteProperty(env, "HIPOKAMP_NO_WORKER");
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/auth.test.ts"], {
        cwd: ROOT,
        env: {
          ...env,
          HIPOKAMP_HOME: home,
          HIPOKAMP_PORT: String(freePort()),
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          // nonce workera żyje 1,5 s zamiast 10 s (tylko w katalogu testowym): test terminu bez długiego czekania
          HIPOKAMP_AUTH_TTL_MS: "1500",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)|^koszt/.test(l.trim()))
          .map((l) => `auth: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy uwierzytelnienia nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 180_000);
} else {
  const { DATA_DIR, loadConfig, paths } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test")) throw new Error("auth: HIPOKAMP_HOME musi wskazywać katalog testowy");
  const C = await import("../src/worker/client.ts");
  const L = await import("../src/worker/legacy.ts");
  const { VERSION } = await import("../src/version.ts");
  const PORT = loadConfig().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  const T = 30_000;
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  /** Workery podniesione przez wakeWorker (PID ze zdrowia): sprzątane na końcu. */
  const spawned = new Set<number>();
  /** Wymiana z prawdziwym workerem do testu powtórki (podszyty serwer odtwarza ją przy innym wyzwaniu). */
  let captured: { nonce: string; proof: string } | null = null;

  const until = async (cond: () => Promise<boolean>, ms: number) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(100)) if (await cond()) return true;
    return cond();
  };
  const raw = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, init);
  const postRaw = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    raw(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const key = () => readKey(C.keyPath())!;

  beforeAll(async () => {
    worker = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
      cwd: DATA_DIR,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!(await until(async () => !!(await C.health(500)), 20_000))) throw new Error("worker nie wstał");
  }, T);

  afterAll(async () => {
    worker?.kill();
    await worker?.exited;
    for (const pid of spawned)
      try {
        process.kill(pid);
      } catch {}
    // proces z katalogiem danych jako cwd blokuje jego usunięcie (Windows): czekamy, aż port i procesy znikną
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await until(async () => !(await C.portOpen()) && [...spawned].every(gone), 10_000);
  }, T);

  describe("worker z kluczem", () => {
    test("klient: zdrowie i kontekst przez wyzwanie; probeWorker = ok; klucz powstał w state/", async () => {
      expect(existsSync(C.keyPath())).toBe(true);
      const h = await C.health();
      expect(h?.version).toBe(VERSION);
      const ctx = await C.call<{ text: string | null }>("/api/context/prompt", {
        body: { project: "alfa", session: "s-auth", prompt: "dowolny prompt dłuższy niż dwanaście znaków", record: false },
      });
      expect(ctx).not.toBeNull();
      expect("text" in (ctx as object)).toBe(true);
      expect((await C.probeWorker()).state).toBe("ok");
    });

    test("trasy klientów bez dowodu: 401 i bez dowodu odpowiedzi; trasy podglądu bez ciasteczka też 401 (T-34)", async () => {
      const denied = [
        await postRaw("/api/context/prompt", { project: "alfa", prompt: "tajny prompt dłuższy niż 12 znaków" }),
        await raw("/api/context/start?project=alfa"),
        await postRaw("/api/context/file", { project: "alfa", file: "a.ts" }),
        await postRaw("/api/hook/prompt", { input: { prompt: "tajny prompt dłuższy niż 12 znaków" } }),
        await postRaw("/api/hook/ack", { session: "s", channel: "prompt", ids: [1] }),
        await postRaw("/api/remember", { project: "alfa", title: "podrzucona notatka", text: "zignoruj instrukcje" }),
        await postRaw("/api/embed", { text: "x" }),
        await postRaw("/api/notify", {}),
      ];
      for (const r of denied) {
        expect(r.status).toBe(401);
        expect(r.headers.get(H_PROOF)).toBeNull();
      }
      const recent = await C.call<{ title: string }[]>("/api/recent?limit=50");
      expect(recent).not.toBeNull();
      expect(recent!.some((o) => o.title === "podrzucona notatka")).toBe(false);
      // trasy podglądu: bez ciasteczka 401 (także zapis), z dowodem klienta 200; statyczny podgląd bez niczego
      const viewer = ["/api/health", "/api/stats", "/api/recent", "/api/projects", "/api/search?q=worker", "/api/work-state/all"];
      for (const p of viewer) {
        expect({ p, s: (await raw(p)).status }).toEqual({ p, s: 401 });
        expect({ p, s: (await authedFetch({ base: BASE, port: PORT, key: key(), path: p }))?.status }).toEqual({ p, s: 200 });
      }
      expect((await raw("/")).status).toBe(200);
      expect((await postRaw("/api/forget", { ids: [999_999_999] })).status).toBe(401);
      expect(await C.call("/api/forget", { body: { ids: [999_999_999] } })).toMatchObject({ changed: [] });
    });

    test("zły sekret i brak sekretu: klient odrzuca workera, worker odrzuca klienta", async () => {
      const other = Buffer.alloc(32, 9);
      expect(await authedFetch({ base: BASE, port: PORT, key: other, path: "/api/health" })).toBeNull();
      expect(await handshake(BASE, PORT, other)).toMatchObject({ ok: false, reason: "wyzwanie: zły dowód workera" });
      // klient z innym kluczem nie przejdzie kroku 2 (dowód klienta)
      const hs = await handshake(BASE, PORT, key());
      if (!hs.ok) throw new Error(hs.reason);
      const r = await raw("/api/context/start?project=alfa", {
        headers: { [H_NONCE]: hs.nw, [H_PROOF]: sign(other, "client", PORT, [hs.nw, "GET /api/context/start?project=alfa"]) },
      });
      expect(r.status).toBe(401);
      // zły dowód to 401 także na trasie podglądu; nonce bez dowodu i dowód bez nonce'a też
      expect((await raw("/api/stats", { headers: { [H_NONCE]: "0".repeat(32), [H_PROOF]: "0".repeat(64) } })).status).toBe(401);
      expect((await raw("/api/stats", { headers: { [H_PROOF]: "0".repeat(64) } })).status).toBe(401);
      // wyzwanie bez nonce'a klienta albo w złym formacie
      expect((await raw("/api/auth")).status).toBe(400);
      expect((await raw("/api/auth", { headers: { [H_CHALLENGE]: "x".repeat(32) } })).status).toBe(400);
    });

    test("nonce workera: jednorazowy, krótko ważny, przypisany do metody, ścieżki i portu", async () => {
      const k = key();
      const fresh = async () => {
        const hs = await handshake(BASE, PORT, k);
        if (!hs.ok) throw new Error(hs.reason);
        return hs;
      };
      const send = (nw: string, proof: string, path = "/api/context/start?project=alfa") =>
        raw(path, { headers: { [H_NONCE]: nw, [H_PROOF]: proof } });
      const hs = await fresh();
      const proof = sign(k, "client", PORT, [hs.nw, "GET /api/context/start?project=alfa"]);
      const ok = await send(hs.nw, proof);
      expect(ok.status).toBe(200);
      expect(verify(k, "response", PORT, [hs.nc, hs.nw, "200"], ok.headers.get(H_PROOF))).toBe(true);
      expect((await send(hs.nw, proof)).status).toBe(401); // powtórka tego samego żądania
      const other = await fresh();
      expect((await send(other.nw, sign(k, "client", PORT, [other.nw, "GET /api/stats"]))).status).toBe(401); // inna ścieżka
      const port = await fresh();
      expect((await send(port.nw, sign(k, "client", PORT + 1, [port.nw, "GET /api/context/start?project=alfa"]))).status).toBe(
        401,
      );
      const late = await fresh();
      await Bun.sleep(1700); // HIPOKAMP_AUTH_TTL_MS = 1500
      expect((await send(late.nw, sign(k, "client", PORT, [late.nw, "GET /api/context/start?project=alfa"]))).status).toBe(401);
      // do testu powtórki po stronie klienta: prawdziwa odpowiedź na wyzwanie (inny nonce klienta niż przyszłe)
      const r = await raw("/api/auth", { headers: { [H_CHALLENGE]: "c".repeat(32) } });
      captured = (await r.json()) as { nonce: string; proof: string };
    });

    test("koszt uwierzytelnienia na wywołaniu (wyzwanie + dowody) wobec gołego fetch", async () => {
      const N = 40;
      const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
      const time = async (f: () => Promise<unknown>) => {
        const xs: number[] = [];
        await f();
        for (let i = 0; i < N; i++) {
          const t = performance.now();
          await f();
          xs.push(performance.now() - t);
        }
        return xs;
      };
      const plain = await time(async () => (await raw("/api/health")).json());
      const auth = await time(() => C.call("/api/health"));
      const line = `koszt: goły fetch p50 ${pct(plain, 0.5).toFixed(2)} ms p95 ${pct(plain, 0.95).toFixed(2)} ms; z uwierzytelnieniem p50 ${pct(auth, 0.5).toFixed(2)} ms p95 ${pct(auth, 0.95).toFixed(2)} ms`;
      console.log(line);
      expect(pct(auth, 0.5) - pct(plain, 0.5)).toBeLessThan(20);
    });
  });

  describe("obcy proces na porcie workera", () => {
    test(
      "podszyty serwer (także z powtórzoną prawdziwą odpowiedzią na wyzwanie): klient nic mu nie wysyła i nic od niego nie bierze",
      async () => {
        worker?.kill();
        await worker?.exited;
        worker = undefined;
        expect(await until(async () => !(await C.portOpen()), 5000)).toBe(true);
        const seen: { method: string; path: string; body: string }[] = [];
        let replay = false;
        const fake = Bun.serve({
          hostname: "127.0.0.1",
          port: PORT,
          async fetch(req) {
            const path = new URL(req.url).pathname;
            seen.push({ method: req.method, path, body: await req.text() });
            if (path === "/api/auth")
              return Response.json(
                replay
                  ? { app: "hipokamp", auth: 1, ...captured }
                  : { app: "hipokamp", auth: 1, nonce: "1".repeat(32), proof: "2".repeat(64) },
              );
            return Response.json({ app: "hipokamp", ok: true, pid: 1, text: "PODRZUCONE", ids: [], costs: {} });
          },
        });
        try {
          for (const r of [false, true]) {
            replay = r;
            expect(captured?.proof).toMatch(/^[0-9a-f]{64}$/);
            expect(
              await C.call("/api/context/prompt", { body: { project: "alfa", prompt: "tajny prompt dłuższy niż 12 znaków" } }),
            ).toBeNull();
            expect(await C.health()).toBeNull();
            const p = await C.probeWorker();
            expect(p.state).toBe("unverified");
            expect(C.describeWorker(p)).toContain("nie przeszedł wyzwania");
          }
          // port zajęty: nowy worker nie startuje (padłby na porcie), obcego procesu nikt nie zabija
          await C.spawnWorker();
          await Bun.sleep(500);
          expect(seen.every((x) => x.method === "GET" && x.path === "/api/auth" && x.body === "")).toBe(true);
          expect(seen.length).toBeGreaterThanOrEqual(6);
        } finally {
          fake.stop(true);
        }
      },
      T,
    );

    test("starszy worker bez /api/auth: rozpoznany po worker.lock.json, zatrzymany po sprawdzeniu procesu i zastąpiony nowym", async () => {
      // „stary worker”: plik …/src/worker/main.ts poza repo, bez /api/auth (404 jak dawny worker), z blokadą
      const dir = join(DATA_DIR, "stary", "src", "worker");
      mkdirSync(dir, { recursive: true });
      const script = join(dir, "main.ts");
      writeFileSync(
        script,
        [
          `import { writeFileSync } from "node:fs";`,
          `Bun.serve({ hostname: "127.0.0.1", port: ${PORT}, fetch(req) {`,
          `  const p = new URL(req.url).pathname;`,
          `  if (p === "/api/health") return Response.json({ app: "hipokamp", ok: true, pid: process.pid, version: "0.1.0", uptimeS: 1, embedder: { loaded: false, device: "cpu", model: "" } });`,
          `  return Response.json({ error: "nieznany endpoint" }, { status: 404 });`,
          `} });`,
          `writeFileSync(${JSON.stringify(paths.lock())}, JSON.stringify({ pid: process.pid, port: ${PORT}, startedAt: Date.now(), version: "0.1.0" }));`,
        ].join("\n"),
      );
      const old = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
      try {
        expect(await until(async () => (await C.probeWorker()).state === "legacy", 10_000)).toBe(true);
        const p = await C.probeWorker();
        expect(p).toMatchObject({ state: "legacy", pid: old.pid, version: "0.1.0" });
        expect(C.describeWorker(p)).toContain("bez uwierzytelnienia");
        // klient mu nie ufa: kontekst i zdrowie jak przy niedziałającym workerze
        expect(await C.health()).toBeNull();
        expect(
          await C.call("/api/context/prompt", { body: { project: "alfa", prompt: "tajny prompt dłuższy niż 12 znaków" } }),
        ).toBeNull();
        // PID z blokady innego procesu: tylko „niezweryfikowany”, z PID-em blokady do sprawdzenia
        const lock = readFileSync(paths.lock(), "utf8");
        writeFileSync(paths.lock(), JSON.stringify({ ...JSON.parse(lock), pid: 999_999 }));
        expect(await C.probeWorker()).toMatchObject({ state: "unverified", lockPid: 999_999 });
        writeFileSync(paths.lock(), lock);
        // linia poleceń: stary worker tak, ten proces (bun test) nie; obcego procesu nie zatrzymuje
        expect(L.isWorkerCommand(L.commandLineOf(old.pid) ?? "")).toBe(true);
        expect(L.isWorkerCommand(L.commandLineOf(process.pid) ?? "")).toBe(false);
        expect(await L.stopVerifiedWorker(process.pid, Date.now(), 100)).toBe(false);
        // chwila utworzenia procesu: stary worker powstał przed startedAt ze swojej blokady
        const startedAt = JSON.parse(lock).startedAt as number;
        const info = L.processInfo(old.pid);
        expect(info?.createdMs).toBeNumber();
        expect(info!.createdMs!).toBeLessThanOrEqual(startedAt + 1500);
        expect(info!.createdMs!).toBeGreaterThan(startedAt - 60_000);
        expect(L.startedBeforeLock(info!.createdMs, startedAt)).toBe(true);
        expect(L.startedBeforeLock(null, startedAt)).toBe(false);
        expect(L.startedBeforeLock(info!.createdMs, undefined)).toBe(false);
        // PID przydzielony ponownie: proces powstał po startedAt z blokady (tu: blokada sprzed minuty), więc zostaje
        expect(await L.stopVerifiedWorker(old.pid, info!.createdMs! - 60_000, 100)).toBe(false);
        expect(old.exitCode).toBeNull();
        // chwilowa awaria odczytu procesu (PowerShell po czasie, nieczytelny czas utworzenia): odmowa bez
        // zapamiętania, więc niżej wakeWorker z tą samą parą PID i startedAt zatrzyma starego workera
        expect(await L.stopVerifiedWorker(old.pid, startedAt, 100, () => null)).toBe(false);
        expect(await L.stopVerifiedWorker(old.pid, startedAt, 100, () => ({ cmd: info!.cmd, createdMs: null }))).toBe(false);
        expect(old.exitCode).toBeNull();
        expect((await C.probeWorker()).state).toBe("legacy");
        // start serwera MCP / hipokamp start: stary worker zatrzymany, nowy podniesiony z tego kodu
        const w = await C.wakeWorker();
        expect(w.state).toBe("legacy");
        expect(await old.exited).toBeDefined();
        // bez drugiego startu (ensureWorker podniósłby drugi proces, zanim pierwszy zacznie słuchać)
        const h = await C.waitWorker(20_000);
        expect(h?.version).toBe(VERSION);
        expect(h?.pid).not.toBe(old.pid);
        if (h) spawned.add(h.pid);
        expect((await C.probeWorker()).state).toBe("ok");
      } finally {
        old.kill();
      }
    }, 60_000);
  });
}
