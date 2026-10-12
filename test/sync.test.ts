// Synchronizacja (src/sync, docs/SYNC.md): hub na porcie 0 i „komputery” (osobne bazy i katalogi stanu) w katalogu
// tymczasowym „hipokamp-test”. Scenariusze: migracja (także z pierwszej wersji tabel synchronizacji), dołączanie
// z jednorazowym kodem (także złośliwy hub: klucz grupy, rola, numer urządzenia), wzajemne dociąganie, numery #id
// i licznik, powtórka, redakcja sekretów (każde pole każdej tabeli), pochodzenie gid, wersje sesji, konflikty statusów
// (zegar, remis, zmiana niewysłana, zegar statusu, scalenia w krzyż, zegar ponad dobę w przyszłości), ślad decyzji przy
// statusie (forget, przywrócenie z archiwum snu, cofnięte zastąpienie, ten sam stan z dwóch stron), powiadomienia tylko
// o własnych notatkach, zbieranie zmian kawałkami (także kilka tysięcy sesji), wektor do kolejki po powrocie notatki,
// identyfikator instalacji bazy z innego komputera, uszkodzony szyfrogram, bomba deflate, nieznana wersja i nieznany
// klucz (także ponad listę pominiętych), zatruty wpis, odcięcie urządzenia, przywrócona kopia bazy, cofnięty dziennik huba, hub z kopii a numery urządzeń (także tryb
// odzyskiwania przy dwóch adminach), członek bez podnoszenia licznika, jednorazowe zaproszenie przy wyścigu,
// równoległe zatwierdzenia, jedyny admin, ponowne dołączenie (listy pracy, odnośniki scaleń), odbiór kawałkami,
// przerwana wysyłka, limity i Host huba (IPv6 /64, zaproszenia), wiersz za duży dla huba, synchronizacja w tle
// wyłączona bez sieci, pełny przebieg przez CLI.
// Osobny proces jak w projects.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_SYNC_CHILD";
const ROOT = join(import.meta.dir, "..");

if (!process.env[CHILD]) {
  test("synchronizacja (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-sync-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/sync.test.ts"], {
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47981",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `sync: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy synchronizacji nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  }, 300_000);
} else {
  const home = process.env.HIPOKAMP_HOME ?? "";
  if (!home.includes("hipokamp-test")) throw new Error("HIPOKAMP_HOME musi wskazywać katalog testowy");

  const { openDb } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const { MIGRATIONS } = await import("../src/db/schema.ts");
  const { startHub, ipKey, isLocalAddr } = await import("../src/sync/server.ts");
  const sync = await import("../src/sync/client.ts");
  const { sealEntry, entryId, newGroupKey, newJoinKeys, openEntry, sealForDevice } = await import("../src/sync/crypto.ts");
  const { sha256hex, PROTOCOL_HEADER, PROTOCOL_VERSION, INVITE_HEADER, LIMITS } = await import("../src/sync/protocol.ts");
  const { idRange, applyOps, Hlc, hlcString } = await import("../src/sync/store.ts");
  const { SyncScheduler } = await import("../src/sync/background.ts");
  type RepoT = InstanceType<typeof Repo>;
  type Ctx = Parameters<typeof sync.push>[0];

  const BOOT = `boot-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const hub = startHub({ dbPath: join(home, "hub", "hub.db"), port: 0, bootstrapSha256: sha256hex(BOOT) });

  interface Machine {
    name: string;
    dir: string;
    repo: RepoT;
    ctx: Ctx;
  }
  const machine = (name: string): Machine => {
    const dir = join(home, name);
    mkdirSync(join(dir, "state"), { recursive: true });
    const repo = new Repo(openDb({ path: join(dir, "hipokamp.db") }));
    return { name, dir, repo, ctx: { repo, stateDir: join(dir, "state"), exclude: ["tajny"], timeoutMs: 10_000 } };
  };
  const A = machine("stacja");
  const B = machine("laptop");
  const C = machine("desktop2");

  const T0 = Date.now() - 3_600_000;
  const HOUR = 3_600_000;
  const obs = (m: Machine, title: string, extra: Record<string, unknown> = {}) =>
    m.repo.insertObservation(
      {
        session_id: (extra.session_id as string) ?? null,
        project: "demo",
        type: "decision",
        title,
        narrative: `${title}: opis`,
        facts: [`Fakt: ${title}`],
        concepts: ["sync"],
        files_modified: ["src/worker.ts"],
        created_at: T0 + Math.floor(Math.random() * 1000),
        source: "agent",
        ...extra,
      },
      [
        { kind: "file", key: "src/worker.ts", role: "modified" },
        { kind: "concept", key: "zakleszczenie", role: "concept" },
      ],
    ).id;
  /** Pola notatki w operacji zbudowanej ręcznie (wpis z pominięciem zwykłej wysyłki). */
  const fakeObs = (title: string, extra: Record<string, unknown> = {}) => ({
    session_id: null,
    project: "demo",
    prompt_n: null,
    type: "decision",
    tier: "episodic",
    title,
    subtitle: null,
    narrative: `${title}: opis`,
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    text: null,
    created_at: T0,
    importance: 0.5,
    source: "agent",
    content_hash: `test-${title}`,
    turn_key: null,
    git_head: null,
    meta: null,
    ...extra,
  });
  const byTitle = (m: Machine, title: string) => m.repo.db.query("SELECT * FROM observations WHERE title = ?").get(title) as any;
  const count = (m: Machine, table: string) => (m.repo.db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  const secretOf = (m: Machine) => JSON.parse(readFileSync(join(m.dir, "state", "sync-secret.json"), "utf8"));
  const hubBytes = (path: string) =>
    Buffer.concat([path, `${path}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p)));
  const raw = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, base = hub.url) =>
    fetch(`${base}${path}`, { ...init, headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...(init.headers ?? {}) } });
  /** Wpis zbudowany ręcznie i wysłany kluczem urządzenia `m` (jak klient bez redakcji albo w innej wersji). */
  const postOps = async (
    m: Machine,
    ops: unknown[],
    o: { v?: number; pv?: number; keys?: any[]; label?: string; base?: string } = {},
  ) => {
    const s = secretOf(m);
    const st = sync.readState(m.ctx)!;
    const keys = o.keys ?? s.keys;
    const id = entryId(keys, `test|${o.label ?? Math.random()}`);
    const { kid, ct } = sealEntry(keys, st.hub, id, { v: o.pv ?? 1, dev: st.device, ops });
    const r = await raw(
      "/v1/entries",
      {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
        body: JSON.stringify({ entries: [{ id, kid, v: o.v ?? 1, ct }] }),
      },
      o.base,
    );
    return { status: r.status, body: (await r.json()) as any, id };
  };
  const joinVia = async (
    admin: Machine,
    m: Machine,
    url: string,
    name: string,
    o: { admin?: boolean; ackLost?: boolean } = {},
  ) => {
    const j = await sync.joinStart(m.ctx, { server: url, name });
    await sync.approveJoin(admin.ctx, { code: j.code, ...o });
    expect((await sync.joinFinish(m.ctx)).status).toBe("approved");
  };
  // sekret w treści składany w locie (skaner sekretów repo nie widzi go w źródle)
  const FAKE_KEY = ["sk", "ant", "api03", `${"Q".repeat(16)}${"w".repeat(16)}`].join("-");
  /** Licznik numerów notatek (wartość i typ w SQLite). */
  const obsSeq = (m: Machine) =>
    m.repo.db.query("SELECT seq, typeof(seq) t FROM sqlite_sequence WHERE name = 'observations'").get() as {
      seq: number;
      t: string;
    } | null;
  /** Wpisy huba od numeru `after`, odszyfrowane kluczami `m` (treść, którą widziałby każdy z kluczem grupy). */
  const hubPayloads = (h: { db: any }, m: Machine, after: number) => {
    const st = sync.readState(m.ctx)!;
    return (h.db.query("SELECT id, kid, ct FROM entries WHERE seq > ?").all(after) as any[]).map((r) =>
      JSON.stringify(openEntry(secretOf(m).keys, st.hub, { id: r.id, kid: r.kid, ct: Buffer.from(r.ct).toString("base64") })),
    );
  };
  const headSeq = (h: { db: any }) => (h.db.query("SELECT COALESCE(MAX(seq), 0) m FROM entries").get() as { m: number }).m;
  /**
   * Złośliwy hub jako pośrednik: przekazuje żądania do prawdziwego huba i przepisuje odpowiedzi (`rewrite` dostaje
   * ścieżkę, metodę i JSON odpowiedzi).
   */
  const evilProxy = (target: () => string, rewrite: (path: string, method: string, j: any) => any) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const headers = new Headers(req.headers);
        headers.delete("host");
        const r = await fetch(`${target()}${u.pathname}${u.search}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.arrayBuffer(),
        });
        const j = (await r.json().catch(() => null)) as any;
        const out = j ? (rewrite(u.pathname, req.method, j) ?? j) : j;
        return new Response(JSON.stringify(out), { status: r.status, headers: { "content-type": "application/json" } });
      },
    });

  // dane sprzed synchronizacji: A ma historię (notatka claude-mem z niskim numerem, dwie własne), B jedną własną
  A.repo.upsertSession({ id: "sesja-a1", project: "demo", cwd: "/repo/demo", started_at: T0, title: "praca A" });
  A.repo.insertPrompt({ session_id: "sesja-a1", project: "demo", n: 1, text: "napraw zakleszczenie workera", created_at: T0 });
  const aCm = obs(A, "Notatka z claude-mem", { id: 500, source: "claude-mem" });
  const a1 = obs(A, "Naprawa zakleszczenia workera", { session_id: "sesja-a1", turn_key: "sesja-a1:u1", type: "bugfix" });
  const a2 = obs(A, "Decyzja o porcie huba");
  obs(A, "Notatka z projektu tajnego", { project: "tajny" });
  A.repo.insertSummary({
    session_id: "sesja-a1",
    project: "demo",
    request: "napraw zakleszczenie",
    investigated: null,
    learned: null,
    completed: "naprawione",
    next_steps: null,
    notes: null,
    files_read: [],
    files_edited: ["src/worker.ts"],
    prompt_n: 1,
    created_at: T0 + 5000,
    source: "digest",
  });
  A.repo.appendWorkState("demo", "plan", { task: "hub synchronizacji", status: "todo" }, T0 + 6000);
  const bLegacy = obs(B, "Stara notatka laptopa");

  describe("hub i dołączanie", () => {
    test("bootstrap: zły sekret odrzucony, dobry tworzy urządzenie 1, drugi raz 409", async () => {
      await expect(sync.initSync(A.ctx, { server: hub.url, name: "stacja", bootstrap: "zly-sekret" })).rejects.toThrow(
        /zły sekret/,
      );
      expect(sync.readState(A.ctx)).toBeNull();
      const st = await sync.initSync(A.ctx, { server: hub.url, name: "stacja", bootstrap: BOOT });
      expect(st.device).toBe(1);
      expect(st.role).toBe("admin");
      expect(secretOf(A).token).toMatch(/^hks_/);
      // zasada „najpierw repair, potem sync” (src/core/sync-guard.ts) widzi połączoną bazę
      const { syncInUse } = await import("../src/core/sync-guard.ts");
      expect(syncInUse(A.repo.db, join(A.dir, "state"))).toContain(st.hub);
      const again = await raw("/v1/bootstrap", {
        method: "POST",
        headers: { authorization: `Bearer ${BOOT}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "obcy", token_hash: "a".repeat(64) }),
      });
      expect(again.status).toBe(409);
    });

    test("migracja synchronizacji jest w schemacie i ma tabele; ślad decyzji to osobna, późniejsza migracja", async () => {
      const tables = MIGRATIONS.findIndex((m) => m.includes("sync_map") && m.includes("sync_status_at"));
      expect(tables).toBeGreaterThan(-1);
      expect(count(A, "sync_status")).toBe(0);
      const cols = (db: any) => (db.query("PRAGMA table_info(sync_status)").all() as { name: string }[]).map((c) => c.name);
      const version = (db: any) => (db.query("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string }).v;
      // świeża baza: tabele synchronizacji, potem kolumna śladu
      expect(cols(A.repo.db)).toContain("intent");
      expect(version(A.repo.db)).toBe(String(MIGRATIONS.length));
      expect(MIGRATIONS[tables]).not.toContain("intent");
      const intent = MIGRATIONS.findIndex((m) => m.includes("intent TEXT"));
      expect(intent).toBeGreaterThan(tables);
      // baza z pierwszą wersją synchronizacji (schemat zakończony migracją tabel) dostaje tylko kolumnę, rejestry zostają
      const { Database } = await import("bun:sqlite");
      const path = join(home, "pierwsza-wersja-sync.db");
      const old = new Database(path);
      for (const m of MIGRATIONS.slice(0, tables + 1)) old.exec(m);
      old.run("INSERT INTO meta (k, v) VALUES ('schema_version', ?)", [String(tables + 1)]);
      old.run("INSERT INTO sync_status (gid, hlc, status) VALUES ('1:5', ?, 'archived')", [hlcString(T0, 0, 1)]);
      expect(cols(old)).not.toContain("intent");
      old.close();
      const db = openDb({ path });
      try {
        expect(cols(db)).toContain("intent");
        expect(version(db)).toBe(String(MIGRATIONS.length));
        expect(db.query("SELECT status, intent FROM sync_status WHERE gid = '1:5'").get()).toEqual({
          status: "archived",
          intent: null,
        });
        const idx = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_status' ORDER BY name");
        expect(idx.all()).toEqual([{ name: "ix_sync_status_by" }, { name: "ix_sync_status_into" }]);
      } finally {
        db.close();
      }
      // baza z pośredniego commitu PR #9 (T-37): wersja 7, a kolumna `intent` już jest (w innym miejscu tabeli);
      // migracja 8 nie pada na „duplicate column”, a ślad decyzji zostaje
      const midPath = join(home, "posredni-commit-sync.db");
      const mid = new Database(midPath);
      for (const m of MIGRATIONS.slice(0, tables)) mid.exec(m);
      mid.exec(MIGRATIONS[tables].replace("hlc TEXT NOT NULL,", "hlc TEXT NOT NULL, intent TEXT,"));
      mid.run("INSERT INTO meta (k, v) VALUES ('schema_version', ?)", [String(tables + 1)]);
      mid.run("INSERT INTO sync_status (gid, hlc, status, intent) VALUES ('1:5', ?, 'archived', ?)", [
        hlcString(T0, 0, 1),
        '{"forgotten_at":1}',
      ]);
      mid.run("INSERT INTO sync_status (gid, hlc, status, into_gid) VALUES ('1:6', ?, 'merged', '1:5')", [hlcString(T0, 1, 1)]);
      expect(cols(mid)).toEqual(["gid", "hlc", "intent", "status", "into_gid", "by_gid", "valid_until"]);
      mid.close();
      const db2 = openDb({ path: midPath });
      try {
        expect(version(db2)).toBe(String(MIGRATIONS.length));
        expect(cols(db2)).toEqual(["gid", "hlc", "status", "into_gid", "by_gid", "valid_until", "intent"]);
        expect(db2.query("SELECT gid, status, into_gid, intent FROM sync_status ORDER BY gid").all()).toEqual([
          { gid: "1:5", status: "archived", into_gid: null, intent: '{"forgotten_at":1}' },
          { gid: "1:6", status: "merged", into_gid: "1:5", intent: null },
        ]);
      } finally {
        db2.close();
      }
    });

    test("dołączenie: jednorazowy kod z ekranu nowego urządzenia; zły kod nic nie zatwierdza, hub nie zna kodu ani kluczy", async () => {
      const j = await sync.joinStart(B.ctx, { server: hub.url, name: "laptop" });
      expect(j.request).toMatch(/^[a-z2-7]{16}$/);
      expect(j.code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
      await expect(sync.approveJoin(A.ctx, { code: "AAAA-BBBB-CCCC" })).rejects.toThrow(/zły kod/);
      await expect(sync.approveJoin(A.ctx, { code: "AAAA-BBBB-CCCC-DDDD" })).rejects.toThrow(/nie pasuje/);
      expect((await sync.joinFinish(B.ctx)).status).toBe("pending");
      const ok = await sync.approveJoin(A.ctx, { code: j.code.toLowerCase().replace(/-/g, " ") });
      expect(ok.device).toBe(2);
      const fin = await sync.joinFinish(B.ctx);
      expect(fin.status).toBe("approved");
      expect(secretOf(B).keys).toEqual(secretOf(A).keys);
      expect(secretOf(B).token).not.toBe(secretOf(A).token);
      expect(existsSync(join(B.dir, "state", "sync-join.json"))).toBe(false);
      // hub nie trzyma klucza grupy, kluczy dostępu (tylko skróty) ani kodu dołączania
      const hubFile = hubBytes(join(home, "hub", "hub.db"));
      for (const k of secretOf(A).keys) expect(hubFile.includes(Buffer.from(k.key))).toBe(false);
      expect(hubFile.includes(Buffer.from(secretOf(B).token))).toBe(false);
      expect(hubFile.includes(Buffer.from(j.code))).toBe(false);
      expect(hubFile.includes(Buffer.from(j.code.replace(/-/g, "")))).toBe(false);
      // trzecie urządzenie (rola member) do dalszych scenariuszy
      await joinVia(A, C, hub.url, "desktop2");
    });

    test("złośliwy hub: własny klucz grupy bez podpisu admina odrzucony, podmieniony klucz publiczny nie przejdzie", async () => {
      const BOOT7 = `boot7-${Date.now()}`;
      const h = startHub({ dbPath: join(home, "hub7", "hub.db"), port: 0, bootstrapSha256: sha256hex(BOOT7) });
      const adm = machine("e1-admin");
      const x = machine("e1-nowy");
      try {
        await sync.initSync(adm.ctx, { server: h.url, name: "admin", bootstrap: BOOT7 });
        const j = await sync.joinStart(x.ctx, { server: h.url, name: "nowy" });
        // hub sam „zatwierdza” prośbę i pieczętuje dla nowego urządzenia własny klucz grupy (zna jego klucz publiczny)
        const row = h.db.query("SELECT * FROM joins WHERE id = ?").get(j.request) as any;
        const evil = [newGroupKey()];
        const dev = h.db
          .query("INSERT INTO devices (name, role, token_hash, created_at) VALUES (?, 'member', ?, ?) RETURNING no")
          .get(row.name, row.token_hash, Date.now()) as { no: number };
        for (const mac of [null, "A".repeat(43)]) {
          h.db.run("UPDATE joins SET status = 'approved', device_no = ?, role = 'member', sealed = ?, mac = ? WHERE id = ?", [
            dev.no,
            sealForDevice(evil, row.pubkey, j.request),
            mac,
            j.request,
          ]);
          await expect(sync.joinFinish(x.ctx)).rejects.toThrow(/podpisu admina/);
          expect(sync.readState(x.ctx)).toBeNull();
          expect(existsSync(join(x.dir, "state", "sync-secret.json"))).toBe(false);
        }
        // hub podmienia klucz publiczny w prośbie (żeby to jemu admin zapieczętował klucz grupy): kod go nie wskaże
        h.db.run("DELETE FROM devices WHERE no = ?", [dev.no]);
        h.db.run(
          "UPDATE joins SET status = 'pending', device_no = NULL, role = NULL, sealed = NULL, mac = NULL, pubkey = ? WHERE id = ?",
          [newJoinKeys().pubkey, j.request],
        );
        await expect(sync.approveJoin(adm.ctx, { code: j.code })).rejects.toThrow(/nie pasuje/);
        expect((h.db.query("SELECT status FROM joins WHERE id = ?").get(j.request) as { status: string }).status).toBe("pending");
        // hub zmienia rolę w zatwierdzeniu (member → admin): podpis obejmuje rolę
        h.db.run("UPDATE joins SET pubkey = ? WHERE id = ?", [row.pubkey, j.request]);
        await sync.approveJoin(adm.ctx, { code: j.code });
        h.db.run("UPDATE joins SET role = 'admin' WHERE id = ?", [j.request]);
        await expect(sync.joinFinish(x.ctx)).rejects.toThrow(/podpisu admina/);
        // uczciwy hub: to samo zatwierdzenie przechodzi
        h.db.run("UPDATE joins SET role = 'member' WHERE id = ?", [j.request]);
        expect((await sync.joinFinish(x.ctx)).status).toBe("approved");
        expect(secretOf(x).keys).toEqual(secretOf(adm).keys);
      } finally {
        h.stop();
        adm.repo.db.close();
        x.repo.db.close();
      }
    });

    test("złośliwy hub: numer urządzenia spoza zakresu, cudzy, zmieniony albo złego typu odrzucony; licznik nietknięty (X1)", async () => {
      const BOOT8 = `boot8-${Date.now()}`;
      // wszystkie prośby idą z 127.0.0.1: limit nowych próśb z adresu podniesiony
      const h = startHub({
        dbPath: join(home, "hub8", "hub.db"),
        port: 0,
        bootstrapSha256: sha256hex(BOOT8),
        limits: { joinsPerIpPer15Min: 100 },
      });
      const h2 = startHub({ dbPath: join(home, "hub8b", "hub.db"), port: 0, bootstrapSha256: sha256hex(BOOT8) });
      let target = h.url;
      let fake: unknown;
      let rewriting = false;
      const proxy = evilProxy(
        () => target,
        (p, m, j) => {
          if (!rewriting) return j;
          if ((m === "GET" && /^\/v1\/join\/[a-z2-7]+$/.test(p) && j.status === "approved") || p === "/v1/bootstrap")
            return { ...j, device: fake };
          return j;
        },
      );
      const evil = `http://127.0.0.1:${proxy.port}`;
      const adm = machine("x1-admin");
      const used: number[] = [];
      try {
        await sync.initSync(adm.ctx, { server: h.url, name: "admin", bootstrap: BOOT8 });
        // NaN przechodzi przez JSON jako null; "7" to napis; 999 to poprawna liczba, ale nie ta, którą podpisał admin
        for (const v of [1e11, 5e10, -3, 1, 0, 2.5, "7", Number.NaN, null, 999]) {
          fake = v;
          rewriting = true;
          const x = machine(`x1-${String(v)}`);
          const old = obs(x, "Stara notatka przed dołączeniem");
          const seq0 = obsSeq(x);
          const j = await sync.joinStart(x.ctx, { server: evil, name: "nowy" });
          used.push((await sync.approveJoin(adm.ctx, { code: j.code })).device);
          await expect(sync.joinFinish(x.ctx)).rejects.toThrow(/numer urządzenia|podpisu admina/);
          expect(sync.readState(x.ctx)).toBeNull();
          expect(existsSync(join(x.dir, "state", "sync-secret.json"))).toBe(false);
          expect(obsSeq(x)).toEqual(seq0); // licznik notatek bez zmian (ani REAL, ani cudza przestrzeń)
          const n1 = obs(x, "Notatka po odrzuceniu 1");
          const n2 = obs(x, "Notatka po odrzuceniu 2");
          expect([n1, n2]).toEqual([old + 1, old + 2]);
          x.repo.db.close();
        }
        // uczciwy pośrednik: to samo przechodzi, numer nadany przez admina (większy od każdego wydanego) i podpisany
        rewriting = false;
        const ok = machine("x1-uczciwy");
        await joinVia(adm, ok, evil, "uczciwy");
        expect(sync.readState(ok.ctx)!.device).toBe(Math.max(...used) + 1);
        expect(new Set(used).size).toBe(used.length);
        ok.repo.db.close();
        // bootstrap: pierwsze urządzenie to zawsze nr 1 z rolą admin
        target = h2.url;
        rewriting = true;
        fake = 2;
        const first = machine("x1-pierwsze");
        await expect(sync.initSync(first.ctx, { server: evil, name: "pierwsze", bootstrap: BOOT8 })).rejects.toThrow(
          /niezgodnie z protokołem/,
        );
        expect(sync.readState(first.ctx)).toBeNull();
        first.repo.db.close();
      } finally {
        proxy.stop(true);
        h.stop();
        h2.stop();
        adm.repo.db.close();
      }
    });

    test("przestrzeń numerów: urządzenie 2 nadaje numery od 200 000 001", () => {
      expect(idRange(1)).toEqual({ lo: 10_000_001, hi: 100_000_000 });
      const id = obs(B, "Nowa notatka laptopa");
      expect(id).toBe(200_000_001);
      expect(bLegacy).toBe(10_000_001);
      expect(a1).toBe(10_000_001);
    });
  });

  describe("wymiana", () => {
    test("wzajemne dociąganie: notatki, prompty, sesje, podsumowania, listy pracy, encje", async () => {
      const pa = await sync.push(A.ctx);
      expect(pa.ops).toBeGreaterThan(5);
      const pb = await sync.push(B.ctx);
      expect(pb.ops).toBe(2);
      const ra = await sync.pull(A.ctx);
      expect(ra.observations).toBe(2);
      const rb = await sync.pull(B.ctx);
      expect(rb.observations).toBe(3); // claude-mem, naprawa, decyzja (projekt tajny zostaje na A)
      expect(rb.prompts).toBe(1);
      expect(rb.sessions).toBe(1);
      expect(rb.summaries).toBe(1);
      expect(rb.workState).toBe(1);

      // numery: wolne zostają (claude-mem 500, decyzja A, nowa notatka B), zajęte dostają numer własny odbiorcy
      expect(byTitle(B, "Notatka z claude-mem").id).toBe(aCm);
      expect(byTitle(B, "Decyzja o porcie huba").id).toBe(a2);
      expect(byTitle(A, "Nowa notatka laptopa").id).toBe(200_000_001);
      const fix = byTitle(B, "Naprawa zakleszczenia workera");
      expect(fix.id).toBeGreaterThanOrEqual(200_000_002); // 10 000 001 to stara notatka laptopa
      expect(byTitle(A, "Stara notatka laptopa").id).toBeGreaterThan(a2); // w przestrzeni A, za jej notatkami
      expect(byTitle(B, "Notatka z projektu tajnego")).toBeNull();

      // licznik A po notatce z wyższym numerem wraca do własnej przestrzeni
      const next = obs(A, "Notatka A po odbiorze");
      expect(next).toBeLessThan(100_000_000);
      expect(next).toBeGreaterThan(byTitle(A, "Stara notatka laptopa").id);

      // treść i otoczenie: FTS, encje, sesja bez ścieżki transkryptu, wektory do policzenia lokalnie
      const fts = B.repo.db.query("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'zakleszczen*'").all();
      expect(fts.map((r: any) => r.rowid)).toContain(fix.id);
      const ents = B.repo.db
        .query("SELECT e.kind, e.key, oe.role FROM obs_entities oe JOIN entities e ON e.id = oe.entity_id WHERE oe.obs_id = ?")
        .all(fix.id);
      expect(ents).toContainEqual({ kind: "file", key: "src/worker.ts", role: "modified" });
      const s = B.repo.getSession("sesja-a1")!;
      expect(s.source).toBe("sync");
      expect(s.transcript_path).toBeNull();
      expect(s.title).toBe("praca A");
      expect(B.repo.countMissingVectors()).toBeGreaterThanOrEqual(3);
      expect(fix.fingerprints).toBeNull();
      expect(B.repo.workStateEntries("demo")[0].fields).toEqual({ task: "hub synchronizacji", status: "todo" });

      // szyfrogramy na hubie nie zawierają treści
      for (const r of hub.db.query("SELECT ct FROM entries").all() as { ct: Uint8Array }[])
        expect(Buffer.from(r.ct).includes(Buffer.from("zakleszczenia"))).toBe(false);
    });

    test("C dociąga wszystko, a wysyłka bez zmian nic nie wysyła", async () => {
      const r = await sync.pull(C.ctx);
      expect(r.observations).toBe(5);
      expect((await sync.push(A.ctx)).ops).toBe(1); // tylko „Notatka A po odbiorze”
      expect((await sync.push(A.ctx)).ops).toBe(0);
      expect((await sync.push(C.ctx)).ops).toBe(0);
      await sync.pull(B.ctx);
      await sync.pull(C.ctx);
    });

    test("powtórka: ten sam wpis drugi raz nie wchodzi, odbiór od zera nic nie zmienia", async () => {
      const before = count(B, "observations");
      const sec = secretOf(A);
      const st = sync.readState(A.ctx)!;
      const id = entryId(sec.keys, "test|powtórka");
      const { kid, ct } = sealEntry(sec.keys, st.hub, id, { v: 1, dev: 1, ops: [] });
      const post = () =>
        raw("/v1/entries", {
          method: "POST",
          headers: { authorization: `Bearer ${sec.token}`, "content-type": "application/json" },
          body: JSON.stringify({ entries: [{ id, kid, v: 1, ct }] }),
        }).then((r) => r.json() as Promise<any>);
      expect((await post()).accepted).toBe(1);
      expect(await post()).toMatchObject({ accepted: 0, duplicates: 1 });

      B.repo.db.run("UPDATE meta SET v = '0' WHERE k = 'sync_cursor'");
      const r = await sync.pull(B.ctx);
      expect(r.observations + r.prompts + r.summaries + r.workState + r.sessions + r.statuses).toBe(0);
      expect(r.skipped).toBeGreaterThan(5);
      expect(count(B, "observations")).toBe(before);
      expect(count(B, "prompts")).toBe(1);
    });

    test("redakcja: sekret nie wychodzi z komputera i nie wchodzi z cudzego wpisu bez redakcji", async () => {
      obs(A, "Notatka z kluczem", { narrative: `klucz ${FAKE_KEY} do testu`, facts: [`token: ${FAKE_KEY}`] });
      const before = (hub.db.query("SELECT MAX(seq) m FROM entries").get() as { m: number }).m;
      await sync.push(A.ctx);
      const st = sync.readState(A.ctx)!;
      const sent = hub.db.query("SELECT id, kid, ct FROM entries WHERE seq > ?").all(before) as any[];
      expect(sent.length).toBeGreaterThan(0);
      for (const r of sent) {
        const p = openEntry(secretOf(A).keys, st.hub, { id: r.id, kid: r.kid, ct: Buffer.from(r.ct).toString("base64") });
        expect(JSON.stringify(p)).not.toContain(FAKE_KEY);
      }
      // urządzenie bez redakcji (albo ze starszymi regułami): odbiorca czyści sam
      await postOps(A, [
        { t: "obs", g: "1:7001", o: fakeObs("Notatka obca z kluczem", { narrative: `inny klucz ${FAKE_KEY}` }), e: [] },
        { t: "prompt", g: "1:7001", sid: "sesja-a1", project: "demo", n: 7, text: `prompt z ${FAKE_KEY}`, at: T0, src: "test" },
        {
          t: "ws",
          g: "1:7001",
          project: "demo",
          list: "plan",
          fields: { note: `api_key=${FAKE_KEY}` },
          at: T0,
          src: "test",
          cm: null,
        },
      ]);
      await sync.pull(B.ctx);
      for (const t of ["Notatka z kluczem", "Notatka obca z kluczem"]) {
        const o = byTitle(B, t);
        expect(o).not.toBeNull();
        expect(JSON.stringify(o)).not.toContain(FAKE_KEY);
        expect(o.narrative).toContain("[REDACTED");
      }
      expect(JSON.stringify(B.repo.db.query("SELECT text FROM prompts").all())).not.toContain(FAKE_KEY);
      expect(JSON.stringify(B.repo.db.query("SELECT fields FROM work_state").all())).not.toContain(FAKE_KEY);
      await sync.pull(C.ctx);
    });

    test("redakcja każdego pola: sekret w każdym polu tekstowym każdej tabeli nie trafia do huba ani do odbiorcy", async () => {
      const S = FAKE_KEY;
      const sid = `sesja-${S}`;
      const proj = `projekt-${S}`;
      // stary wiersz (np. import claude-mem sprzed repair): sekret wszędzie, także w identyfikatorach i kluczach encji
      A.repo.upsertSession({
        id: sid,
        project: proj,
        cwd: `/repo/${S}`,
        git_branch: `feat/${S}`,
        title: `tytuł ${S}`,
        first_prompt: `pierwszy ${S}`,
        started_at: T0,
        model: `model ${S}`,
        status: `stan-${S}`,
      } as any);
      A.repo.insertPrompt({ session_id: sid, project: proj, n: 1, text: `prompt ${S}`, created_at: T0, source: `zrodlo-${S}` });
      A.repo.insertObservation(
        {
          session_id: sid,
          project: proj,
          type: `typ-${S}`,
          tier: `warstwa-${S}`,
          title: `Tytuł ${S}`,
          subtitle: `pod ${S}`,
          narrative: `opis ${S}`,
          facts: [`fakt ${S}`],
          concepts: [`pojęcie ${S}`],
          files_read: [`/r/${S}`],
          files_modified: [`/m/${S}`],
          text: `tekst ${S}`,
          created_at: T0 + 10,
          source: `src-${S}`,
          turn_key: `tura-${S}`,
          git_head: `head-${S}`,
          // ślady tej maszyny w meta (katalog startowy, kotwica w transkrypcie, ścieżka na dysku) nie jadą
          meta: {
            klucz: S,
            [S]: 1,
            lista: [`w liście ${S}`],
            kind: "turn",
            root: "D:\\code\\projekt",
            anchor: { at: 1, len: 2, uuid: "u", type: null, off: 3 },
            plik: "C:\\Users\\kto\\notatki.txt",
          },
        } as any,
        [
          { kind: "command", key: `curl -H "x-api-key: ${S}" https://api.example.com`, role: "mentioned" },
          { kind: "url", key: `https://api.example.com/v1?key=${S}`, role: "mentioned" },
          { kind: "file", key: `/sekrety/${S}.txt`, role: "read" },
          { kind: "concept", key: S, role: "concept" },
        ],
      );
      A.repo.insertSummary({
        session_id: sid,
        project: proj,
        request: `prośba ${S}`,
        investigated: `badane ${S}`,
        learned: `nauka ${S}`,
        completed: `zrobione ${S}`,
        next_steps: `dalej ${S}`,
        notes: `uwagi ${S}`,
        files_read: [`/r/${S}`],
        files_edited: [`/e/${S}`],
        prompt_n: 1,
        created_at: T0 + 20,
        source: `src-${S}`,
        meta: { k: S },
      } as any);
      A.repo.appendWorkState(proj, `lista-${S}`, { pole: S, [S]: "x" }, T0 + 30, `src-${S}`);
      const tables = ["sessions", "prompts", "observations", "summaries", "work_state", "entities"];
      const dump = (m: Machine) => tables.map((t) => JSON.stringify(m.repo.db.query(`SELECT * FROM ${t}`).all())).join("\n");
      expect(dump(A)).toContain(S); // test ma sens: u nadawcy sekret jest w bazie

      const before = headSeq(hub);
      await sync.push(A.ctx);
      const sent = hubPayloads(hub, A, before);
      expect(sent.length).toBeGreaterThan(0);
      for (const p of sent) expect(p).not.toContain(S);
      // surowe bajty dziennika huba (szyfrogramy i plik bazy) też nie
      expect(hubBytes(join(home, "hub", "hub.db")).includes(Buffer.from(S))).toBe(false);

      const r = await sync.pull(B.ctx);
      expect(r.rejected).toBe(0);
      expect(dump(B)).not.toContain(S);
      // wiersze dotarły (redakcja nie wycina wierszy), encja z samego sekretu pominięta, polecenie i adres bez sekretu
      const o = B.repo.db.query("SELECT * FROM observations WHERE title LIKE 'Tytuł [REDACTED%'").get() as any;
      expect(o).not.toBeNull();
      const meta = JSON.parse(o.meta);
      expect(meta.kind).toBe("turn");
      for (const k of ["root", "anchor", "plik"]) expect(k in meta).toBe(false);
      for (const p of sent) expect(p).not.toContain("notatki.txt");
      const ents = B.repo.db
        .query("SELECT e.kind, e.key FROM obs_entities oe JOIN entities e ON e.id = oe.entity_id WHERE oe.obs_id = ?")
        .all(o.id) as { kind: string; key: string }[];
      expect(ents.map((e) => e.kind).sort()).toEqual(["command", "file", "url"]);
      expect(ents.find((e) => e.kind === "command")!.key).toContain("[REDACTED");
      const sess = B.repo.db.query("SELECT * FROM sessions WHERE id LIKE 'sesja-[REDACTED%'").get() as any;
      expect(sess?.model).toContain("[REDACTED");
      expect(B.repo.db.query("SELECT COUNT(*) c FROM prompts WHERE session_id = ?").get(sess.id)).toEqual({ c: 1 });
      expect(B.repo.db.query("SELECT COUNT(*) c FROM summaries WHERE session_id = ?").get(sess.id)).toEqual({ c: 1 });
      expect(B.repo.db.query("SELECT COUNT(*) c FROM work_state WHERE list_name LIKE 'lista-[REDACTED%'").get()).toEqual({
        c: 1,
      });
      await sync.pull(C.ctx);
    });

    test("pochodzenie: urządzenie nie wyśle notatki pod cudzym gid", async () => {
      const r = await postOps(B, [{ t: "obs", g: "1:7003", o: fakeObs("Podszyta notatka A"), e: [] }]);
      expect(r.status).toBe(200);
      const q = await sync.pull(C.ctx);
      expect(q.rejected).toBe(1);
      expect(byTitle(C, "Podszyta notatka A")).toBeNull();
      await sync.pull(A.ctx);
      expect(byTitle(A, "Podszyta notatka A")).toBeNull();
    });

    test("sesja: starsza wersja nie nadpisuje nowszej (zegar wersji)", () => {
      const hlc = new Hlc(C.repo, 3);
      const f = {
        project: "demo",
        cwd: null,
        git_branch: null,
        title: "nowa",
        first_prompt: null,
        started_at: T0,
        ended_at: null,
        last_activity_at: null,
        prompt_count: 0,
        model: null,
        status: "active",
      };
      const apply = (h: string, title: string) =>
        C.repo.db
          .transaction(() => applyOps(C.repo, 3, hlc, [{ t: "session", sid: "sesja-wersje", h, f: { ...f, title } }], 1))
          .immediate();
      expect(apply(hlcString(T0 + 2000, 0, 1), "nowa").sessions).toBe(1);
      expect(apply(hlcString(T0 + 1000, 0, 1), "stara").skipped).toBe(1);
      expect(C.repo.getSession("sesja-wersje")!.title).toBe("nowa");
      expect(apply(hlcString(T0 + 3000, 0, 1), "najnowsza").sessions).toBe(1);
      expect(C.repo.getSession("sesja-wersje")!.title).toBe("najnowsza");
    });
  });

  describe("statusy (LWW)", () => {
    // chwila zmiany statusu (sync_status_at, zapisuje ją wyzwalacz) ustawiona na zadany czas
    const setStatus = (m: Machine, title: string, status: any, at: number, into?: string) => {
      const o = byTitle(m, title);
      m.repo.setStatus(o.id, status, into ? { mergedInto: byTitle(m, into).id } : {});
      m.repo.db.run("INSERT INTO sync_status_at (obs_id, at) VALUES (?, ?) ON CONFLICT(obs_id) DO UPDATE SET at = excluded.at", [
        o.id,
        at,
      ]);
    };

    test("konflikt: wygrywa późniejszy zegar, obie strony zbiegają się", async () => {
      const t = Date.now();
      setStatus(A, "Decyzja o porcie huba", "archived", t + 1000);
      setStatus(B, "Decyzja o porcie huba", "merged", t + 2000, "Notatka z claude-mem");
      await sync.push(A.ctx);
      await sync.push(B.ctx);
      expect((await sync.pull(B.ctx)).statuses).toBe(0); // starsza zmiana A przegrywa
      expect((await sync.pull(A.ctx)).statuses).toBe(1);
      for (const m of [A, B]) {
        const o = byTitle(m, "Decyzja o porcie huba");
        expect(o.status).toBe("merged");
        expect(o.merged_into).toBe(byTitle(m, "Notatka z claude-mem").id);
      }
      expect((await sync.push(A.ctx)).ops).toBe(0);
    });

    test("remis zegara: wygrywa wyższy numer urządzenia", async () => {
      // dalej niż jakikolwiek dotychczasowy zegar, więc oba dostaną ten sam czas; przesunięcia w tych testach to
      // godziny, bo zegar ponad dobę przed odbiorcą jest odrzucany (MAX_CLOCK_AHEAD_MS)
      const t = Date.now() + HOUR;
      setStatus(A, "Naprawa zakleszczenia workera", "archived", t);
      setStatus(B, "Naprawa zakleszczenia workera", "superseded", t);
      await sync.push(A.ctx);
      await sync.push(B.ctx);
      await sync.pull(A.ctx);
      await sync.pull(B.ctx);
      expect(byTitle(A, "Naprawa zakleszczenia workera").status).toBe("superseded");
      expect(byTitle(B, "Naprawa zakleszczenia workera").status).toBe("superseded");
    });

    test("zmiana niewysłana przy odbiorze: późniejsza lokalna zostaje i potem wygrywa wszędzie", async () => {
      const t = Date.now() + 2 * HOUR;
      setStatus(B, "Stara notatka laptopa", "archived", t);
      await sync.push(B.ctx);
      setStatus(A, "Stara notatka laptopa", "superseded", t + 5000);
      await sync.pull(A.ctx); // bez wcześniejszej wysyłki
      expect(byTitle(A, "Stara notatka laptopa").status).toBe("superseded");
      await sync.push(A.ctx);
      await sync.pull(B.ctx);
      await sync.pull(C.ctx);
      expect(byTitle(B, "Stara notatka laptopa").status).toBe("superseded");
      expect(byTitle(C, "Stara notatka laptopa").status).toBe("superseded");
    });

    test("zegar statusu: liczy się chwila zmiany statusu, nie późniejsze podbicie updated_at (np. powtórka treści)", async () => {
      const t = Date.now() + 3 * HOUR;
      setStatus(B, "Notatka A po odbiorze", "archived", t + 2000);
      await sync.push(B.ctx);
      setStatus(A, "Notatka A po odbiorze", "superseded", t + 1000);
      A.repo.db.run("UPDATE observations SET updated_at = ? WHERE id = ?", [t + 9000, byTitle(A, "Notatka A po odbiorze").id]);
      await sync.pull(A.ctx);
      expect(byTitle(A, "Notatka A po odbiorze").status).toBe("archived");
      expect((await sync.push(A.ctx)).ops).toBe(0);
    });

    test("scalenia w krzyż (X w Y na A, Y w X na B): wszędzie zostaje ta sama aktywna notatka", async () => {
      const x = obs(A, "Duplikat X");
      const y = obs(A, "Duplikat Y");
      await sync.push(A.ctx);
      await sync.pull(B.ctx);
      await sync.pull(C.ctx);
      const t = Date.now() + 4 * HOUR;
      setStatus(A, "Duplikat X", "merged", t, "Duplikat Y");
      setStatus(B, "Duplikat Y", "merged", t + 1000, "Duplikat X");
      for (let i = 0; i < 3; i++)
        for (const m of [A, B, C]) {
          await sync.push(m.ctx);
          await sync.pull(m.ctx);
        }
      const [keep, gone] = x < y ? ["Duplikat X", "Duplikat Y"] : ["Duplikat Y", "Duplikat X"]; // najmniejszy gid zostaje
      for (const m of [A, B, C]) {
        expect(byTitle(m, keep).status).toBe("active");
        expect(byTitle(m, gone).status).toBe("merged");
        expect(byTitle(m, gone).merged_into).toBe(byTitle(m, keep).id);
      }
    });

    test("zegar ponad dobę w przyszłości: status i wersja sesji odrzucone, zegar odbiorcy stoi, zwykła zmiana przechodzi", async () => {
      const title = "Notatka z zegarem z przyszłości";
      const id = obs(A, title);
      await sync.push(A.ctx);
      await sync.pull(B.ctx);
      const clockOf = (m: Machine) => (m.repo.db.query("SELECT v FROM meta WHERE k = 'sync_hlc'").get() as { v: string }).v;
      const before = clockOf(B);
      const far = hlcString(Date.now() + 2 * 86_400_000, 0, 1);
      const f = {
        project: "demo",
        cwd: null,
        git_branch: null,
        title: "z przyszłości",
        first_prompt: null,
        started_at: T0,
        ended_at: null,
        last_activity_at: null,
        prompt_count: 0,
        model: null,
        status: "active",
      };
      const ops = [
        { t: "status", g: `1:${id}`, h: far, s: "archived", into: null, by: null, until: null },
        { t: "session", sid: "sesja-z-przyszlosci", h: far, f },
      ];
      expect((await postOps(A, ops, { label: "zegar-z-przyszlosci" })).status).toBe(200);
      const { readClockRejected, clockWarnings, hlcAheadMs } = await import("../src/sync/store.ts");
      const cursorOf = (m: Machine) =>
        Number((m.repo.db.query("SELECT v FROM meta WHERE k = 'sync_cursor'").get() as { v: string } | null)?.v ?? 0);
      const c0 = cursorOf(B);
      // T-37: odbiór przerwany zaraz po wpisie z odrzuceniami (błąd huba na dalszej stronie, zabity worker): kursor
      // poszedł dalej w tej samej transakcji co ślad, więc ślad nie ginie
      await expect(
        sync.pull({
          ...B.ctx,
          onSlice: () => {
            throw new Error("przerwany odbiór");
          },
        }),
      ).rejects.toThrow("przerwany odbiór");
      expect(cursorOf(B)).toBeGreaterThan(c0);
      expect(readClockRejected(B.repo)).toMatchObject({ count: 2, maxWall: parseInt(far, 10) });
      // dalszy zwykły odbiór nic nowego nie ma i śladu nie rusza (zmiany są wciąż zgubione)
      const r = await sync.pull(B.ctx);
      expect(r.future).toBe(0);
      expect(readClockRejected(B.repo)?.count).toBe(2);
      expect(byTitle(B, title).status).toBe("active");
      expect(B.repo.getSession("sesja-z-przyszlosci")).toBeNull();
      expect(clockOf(B)).toBe(before);
      expect(B.repo.db.query("SELECT 1 FROM sync_status WHERE gid = ?").get(`1:${id}`)).toBeNull();
      // sam zegar: w granicy doby przyjęty, dalej nie
      const hb = new Hlc(B.repo, 2);
      expect(hb.plausible(hlcString(Date.now() + 12 * HOUR, 0, 1))).toBe(true);
      expect(hb.plausible(far)).toBe(false);

      // ślad widać w sync status z instrukcją odzysku
      const st = await sync.syncStatus(B.ctx);
      expect(st.clock).toHaveLength(1);
      expect(st.clock[0]).toContain("hipokamp sync pull --full");
      expect(clockWarnings(B.repo).map((w) => w.kind)).toEqual(["rejected"]);
      // odbiór od początku z zegarem wciąż w tyle odrzuca te same operacje: ślad zastąpiony, nie podwojony; tak samo
      // odbiór od kursora 0 bez --full (resync, pierwszy odbiór po ponownym dołączeniu)
      expect((await sync.pull(B.ctx, { full: true })).future).toBe(2);
      expect(readClockRejected(B.repo)?.count).toBe(2);
      B.repo.db.run(
        "UPDATE meta SET v = CASE k WHEN 'sync_cursor' THEN '0' ELSE '' END WHERE k IN ('sync_cursor', 'sync_cursor_id')",
      );
      expect((await sync.pull(B.ctx, { verify: false })).future).toBe(2);
      expect(readClockRejected(B.repo)?.count).toBe(2);
      // zegar odbiorcy poprawiony (tu: przesunięty o 3 dni): pull --full przyjmuje odrzucone zmiany i czyści ślad
      const later = () => Date.now() + 3 * 86_400_000;
      const fixed = await sync.pull({ ...B.ctx, now: later }, { full: true });
      expect(fixed.future).toBe(0);
      expect(readClockRejected(B.repo)).toBeNull();
      expect(byTitle(B, title).status).toBe("archived");
      expect(B.repo.getSession("sesja-z-przyszlosci")).not.toBeNull();
      expect(clockWarnings(B.repo, later())).toEqual([]);
      // a w czasie rzeczywistym zapamiętany zegar B wyprzedza teraz zegar systemowy o 2 doby: ostrzeżenie „ahead”
      expect(hlcAheadMs(B.repo)).toBeGreaterThan(86_400_000);
      const ahead = clockWarnings(B.repo);
      expect(ahead.map((w) => w.kind)).toEqual(["ahead"]);
      expect(ahead[0].text).toContain("sync resync tego nie przyspieszy");
      expect(ahead[0].text).toContain("same nie wrócą");
      expect((await sync.syncStatus(B.ctx)).clock[0]).toBe(ahead[0].text);
      // sprzątanie dla dalszych scenariuszy: zegar B z powrotem (notatka zostaje zarchiwizowana, jak za chwilę u wszystkich)
      B.repo.db.run("UPDATE meta SET v = ? WHERE k = 'sync_hlc'", [before]);
      expect(clockWarnings(B.repo)).toEqual([]);
      // zwykła zmiana z A dochodzi normalnie
      A.repo.setStatus(id, "archived");
      await sync.push(A.ctx);
      await sync.pull(B.ctx);
      expect(byTitle(B, title).status).toBe("archived");
      await sync.pull(C.ctx);
    });
  });

  describe("ślad decyzji przy statusie, notatki z innych komputerów, zbieranie kawałkami", () => {
    const DAY = 86_400_000;
    const metaOf = (m: Machine, title: string) => JSON.parse(byTitle(m, title).meta ?? "{}");
    const roundTrip = async (from: Machine, ...to: Machine[]) => {
      await sync.push(from.ctx);
      for (const m of to) await sync.pull(m.ctx);
    };

    test("forget z powodem jedzie ze statusem (powód po redakcji), przywrócenie na drugim komputerze cofa go wszędzie", async () => {
      const id = obs(A, "Notatka do zapomnienia");
      await roundTrip(A, B, C);
      expect(A.repo.forgetObservations([id], "błędna notatka")).toEqual([id]);
      await roundTrip(A, B, C);
      for (const m of [B, C]) {
        expect(byTitle(m, "Notatka do zapomnienia").status).toBe("archived");
        expect(metaOf(m, "Notatka do zapomnienia").forgotten_at).toBe(metaOf(A, "Notatka do zapomnienia").forgotten_at);
        expect(metaOf(m, "Notatka do zapomnienia").forget_reason).toBe("błędna notatka");
      }
      // rejestr LWW pamięta ślad (ponowna wysyłka po cofnięciu dziennika huba niesie go dalej)
      const reg = A.repo.db.query("SELECT intent FROM sync_status WHERE gid = ?").get(`1:${id}`) as { intent: string };
      expect(JSON.parse(reg.intent).forget_reason).toBe("błędna notatka");
      // przywrócenie na B to cofnięcie zapomnienia: znacznik i powód znikają też na A i C, bez restored_at
      expect(B.repo.restoreObservations([byTitle(B, "Notatka do zapomnienia").id]).length).toBe(1);
      await roundTrip(B, A, C);
      for (const m of [A, B, C]) {
        expect(byTitle(m, "Notatka do zapomnienia").status).toBe("active");
        const meta = metaOf(m, "Notatka do zapomnienia");
        expect([meta.forgotten_at, meta.forget_reason, meta.restored_at]).toEqual([undefined, undefined, undefined]);
      }
      expect((await sync.push(A.ctx)).ops).toBe(0);
      // wpis od klienta bez redakcji: sekret w powodzie nie wchodzi do bazy odbiorcy
      const h = hlcString(Date.now() + 6 * HOUR, 0, 1);
      const m = { forgotten_at: 1, forget_reason: `zły klucz ${FAKE_KEY}` };
      expect(
        (await postOps(A, [{ t: "status", g: `1:${id}`, h, s: "archived", into: null, by: null, until: null, m }])).status,
      ).toBe(200);
      await sync.pull(B.ctx);
      expect(byTitle(B, "Notatka do zapomnienia").status).toBe("archived");
      expect(byTitle(B, "Notatka do zapomnienia").meta).not.toContain(FAKE_KEY);
      expect(metaOf(B, "Notatka do zapomnienia").forget_reason).toContain("zły klucz");
    });

    test("przywrócenie z archiwum snu: sen drugiego komputera nie odkłada notatki z powrotem (restored_at jedzie ze statusem)", async () => {
      const { sleep } = await import("../src/consolidate/sleep.ts");
      const title = "Stary epizod bez użycia";
      obs(A, title, { type: "discovery", importance: 0.1, created_at: Date.now() - 400 * DAY });
      await roundTrip(A, B);
      await sleep(A.repo);
      await sleep(B.repo);
      for (const m of [A, B]) expect(byTitle(m, title).status).toBe("archived");
      for (const m of [A, B, A, B]) await roundTrip(m, ...[A, B].filter((x) => x !== m));
      A.repo.restoreObservations([byTitle(A, title).id]);
      expect(metaOf(A, title).restored_at).toBeGreaterThan(0);
      await roundTrip(A, B);
      expect(byTitle(B, title).status).toBe("active");
      expect(metaOf(B, title).restored_at).toBe(metaOf(A, title).restored_at);
      await sleep(B.repo);
      expect(byTitle(B, title).status).toBe("active");
      await roundTrip(B, A);
      expect(byTitle(A, title).status).toBe("active");
    });

    test("cofnięte zastąpienie jedzie ze statusem (sen nie zastąpi notatki drugi raz na żadnym komputerze)", async () => {
      const x = obs(A, "Decyzja stara o cache");
      const y = obs(A, "Decyzja nowa o cache");
      await roundTrip(A, B);
      expect(A.repo.supersedeObservation(x, y, { reason: "klucz" })).toBe(true);
      await roundTrip(A, B);
      expect(byTitle(B, "Decyzja stara o cache").status).toBe("superseded");
      expect(byTitle(B, "Decyzja stara o cache").superseded_by).toBe(byTitle(B, "Decyzja nowa o cache").id);
      expect(A.repo.restoreSuperseded([x])).toEqual([x]);
      await roundTrip(A, B);
      expect(byTitle(B, "Decyzja stara o cache").status).toBe("active");
      expect(metaOf(B, "Decyzja stara o cache").supersede_undone.at).toBe(metaOf(A, "Decyzja stara o cache").supersede_undone.at);
    });

    test("ten sam stan z dwóch stron (forget tutaj, archiwum snu tam, późniejsze): ślad zapomnienia zostaje i dociera wszędzie", async () => {
      const title = "Notatka zapomniana i uśpiona naraz";
      const id = obs(A, title);
      await roundTrip(A, B);
      // A: forget z powodem; B (bez odbioru): sen archiwizuje tę samą notatkę, później (zegar B wygrywa)
      expect(A.repo.forgetObservations([id], "nieaktualne ustalenie")).toEqual([id]);
      await sync.push(A.ctx);
      const onB = byTitle(B, title).id;
      B.repo.setStatus(onB, "archived");
      B.repo.db.run("INSERT INTO sync_status_at (obs_id, at) VALUES (?, ?) ON CONFLICT(obs_id) DO UPDATE SET at = excluded.at", [
        onB,
        Date.now() + 8 * HOUR,
      ]);
      await sync.push(B.ctx);
      // A dostaje zwycięski status B bez śladu: ten sam stan, więc zapomnienie zostaje (wcześniej znikało)
      await sync.pull(A.ctx);
      expect(byTitle(A, title).status).toBe("archived");
      expect(metaOf(A, title).forget_reason).toBe("nieaktualne ustalenie");
      expect(metaOf(A, title).forgotten_at).toBeGreaterThan(0);
      // B odrzuca starszą zmianę A, ale A wysyła różnicę śladu i B ją łączy
      await sync.pull(B.ctx);
      expect((await sync.push(A.ctx)).ops).toBe(1);
      await sync.pull(B.ctx);
      expect(byTitle(B, title).status).toBe("archived");
      expect(metaOf(B, title).forget_reason).toBe("nieaktualne ustalenie");
      expect(metaOf(B, title).forgotten_at).toBe(metaOf(A, title).forgotten_at);
      // zbieżność: nikt nie ma już nic do wysłania
      for (const m of [A, B]) expect((await sync.push(m.ctx)).ops).toBe(0);
      await sync.pull(A.ctx);
      expect((await sync.push(A.ctx)).ops).toBe(0);
      await sync.pull(C.ctx);
    });

    test("notatka z innego komputera nie daje powiadomienia (isLocalNote), własna tak", async () => {
      const { isLocalNote } = await import("../src/notify/notify.ts");
      obs(A, "Notatka stacji do powiadomienia");
      obs(B, "Notatka laptopa do powiadomienia");
      await roundTrip(A, B);
      const remote = B.repo.getObservations([byTitle(B, "Notatka stacji do powiadomienia").id])[0];
      const own = B.repo.getObservations([byTitle(B, "Notatka laptopa do powiadomienia").id])[0];
      expect(isLocalNote(B.repo, remote)).toBe(false);
      expect(isLocalNote(B.repo, own)).toBe(true);
      await sync.push(B.ctx); // wysłana dalej zostaje własna (gid z numerem tego urządzenia)
      expect(isLocalNote(B.repo, own)).toBe(true);
      expect(isLocalNote(A.repo, A.repo.getObservations([byTitle(A, "Notatka stacji do powiadomienia").id])[0])).toBe(true);
    });

    test("zbieranie kawałkami (collectMs, worker): ta sama treść co jednym ciągiem, każde wywołanie posuwa kursor", async () => {
      const { collectBatch, newCursor, Hlc: H } = await import("../src/sync/store.ts");
      for (let i = 0; i < 40; i++) obs(A, `Notatka partii ${i}`);
      for (let i = 0; i < 10; i++) A.repo.setStatus(byTitle(A, `Notatka partii ${i}`).id, "archived");
      // budżet 0: po jednym kawałku pracy na wywołanie, a i tak koniec przychodzi i nic nie ginie
      const cur = newCursor();
      const hlc = new H(A.repo, 1);
      let calls = 0;
      let rows = 0;
      for (;;) {
        const before = JSON.stringify(cur);
        const b = collectBatch(A.repo, 1, hlc, cur, { maxBytes: 4_000_000, exclude: ["tajny"], budgetMs: 0 });
        calls++;
        rows += b.ops.filter((o) => o.t === "obs").length;
        if (!b.ops.length && !b.more) break;
        expect(JSON.stringify(cur) === before && !b.ops.length).toBe(false);
        expect(calls).toBeLessThan(200);
      }
      expect(rows).toBe(40);
      expect(calls).toBeGreaterThan(2);
      // prawdziwa wysyłka kawałkami: notatki i statusy (dopiero po zatwierdzeniu notatek) w jednym push
      const r = await sync.push({ ...A.ctx, collectMs: 0 });
      expect(r.ops).toBeGreaterThanOrEqual(50);
      await sync.pull(B.ctx);
      expect(byTitle(B, "Notatka partii 39").status).toBe("active");
      expect(byTitle(B, "Notatka partii 3").status).toBe("archived");
      expect((await sync.push({ ...A.ctx, collectMs: 0 })).ops).toBe(0);
      // wszystkie komputery na bieżąco przed następnymi scenariuszami
      for (const m of [A, B, C]) await sync.push(m.ctx);
      for (const m of [A, B, C]) await sync.pull(m.ctx);
    });

    test("przegląd sesji kawałkami: kilka tysięcy sesji z długim pierwszym promptem nie idzie jednym kawałkiem", async () => {
      const { collectBatch, newCursor, Hlc: H } = await import("../src/sync/store.ts");
      // osobna baza bez huba: liczy się tylko przegląd (redakcja pól i skrót każdej sesji)
      const S = machine("sesje-tysiace");
      try {
        const N = 4000;
        const prompt = "Opis zadania do zrobienia w projekcie ".repeat(44); // ok. 1,6 KB jak długi pierwszy prompt
        const ins = S.repo.db.prepare(
          "INSERT INTO sessions (id, project, started_at, first_prompt, title) VALUES (?, 'demo', ?, ?, ?)",
        );
        S.repo.db.transaction(() => {
          for (let i = 0; i < N; i++) ins.run(`sesja-${String(i).padStart(5, "0")}`, T0 + i, `${prompt}${i}`, `Sesja ${i}`);
        })();
        const ids = Array.from({ length: N }, (_, i) => `sesja-${String(i).padStart(5, "0")}`);
        // zegar budżetu jako licznik odczytów (T-37): kawałkowanie sprawdzone bez czasu zegarowego, który na
        // obciążonej maszynie skacze. Budżet 50 „ms” = najwyżej 50 sesji na wywołanie, bo budżet jest sprawdzany po
        // każdej sesji; 50 nie dzieli SCAN_SESSIONS (256), więc kawałki przechodzą też przez granice zakresów
        const BUDGET = 50;
        let reads = 0;
        const clock = () => reads++;
        const cur = newCursor();
        const hlc = new H(S.repo, 9);
        const chunks: string[][] = [];
        for (;;) {
          // partia bez limitu bajtów: przerwać może tylko budżet
          const b = collectBatch(S.repo, 9, hlc, cur, { maxBytes: 100_000_000, exclude: [], budgetMs: BUDGET, clock });
          chunks.push((b.ops.filter((o) => o.t === "session") as { sid: string }[]).map((o) => o.sid));
          if (!b.ops.length && !b.more) break;
          expect(b.more).toBe(true);
          expect(chunks.length).toBeLessThan(10_000);
        }
        // każda sesja dokładnie raz i w kolejności: nic nie ginie ani nie wraca między kawałkami (lista, nie zbiór)
        expect(chunks.flat()).toEqual(ids);
        // przegląd sesji oddaje głos po najwyżej BUDGET sesjach, bez pustych wywołań w środku (po sesjach mogą przyjść
        // puste wywołania przeglądu pozostałych tabel)
        const body = chunks.slice(0, chunks.findLastIndex((c) => c.length > 0) + 1);
        for (const c of body) expect(c.length >= 1 && c.length <= BUDGET).toBe(true);
        expect(body.length).toBeGreaterThanOrEqual(N / BUDGET);
        // domyślny zegar: budżet 0 zwraca po pierwszej sesji niezależnie od szybkości maszyny
        const cur0 = newCursor();
        const one = collectBatch(S.repo, 9, new H(S.repo, 9), cur0, { maxBytes: 100_000_000, exclude: [], budgetMs: 0 });
        expect(one.ops.map((o) => (o as { sid?: string }).sid)).toEqual([ids[0]]);
        expect(one.more).toBe(true);
      } finally {
        S.repo.db.close();
      }
    });

    test("notatka scalona bez bitów wraca do aktywnych operacją z huba: wektor do kolejki (status i rozcięcie cyklu scaleń)", async () => {
      const { loadConfig } = await import("../src/config.ts");
      const dims = loadConfig().embed.dims;
      // baza z wektorami (sqlite-vec): sen kasuje bity scalonej notatki, wektor q8 zostaje
      const dir = join(home, "wektory");
      mkdirSync(join(dir, "state"), { recursive: true });
      const repo = new Repo(openDb({ path: join(dir, "hipokamp.db"), vectors: true }));
      const V: Machine = { name: "wektory", dir, repo, ctx: { repo, stateDir: join(dir, "state") } };
      try {
        const [x, y, z] = ["Wektor X", "Wektor Y", "Wektor Z"].map((t) => obs(V, t));
        for (const id of [x, y, z]) {
          repo.db.run("INSERT INTO sync_map (kind, gid, local_id, origin) VALUES ('obs', ?, ?, 1)", [`1:${id}`, id]);
          repo.putVector(id, "demo", "test", new Int8Array(dims).fill(1), new Uint8Array(dims / 8).fill(0x55), false);
        }
        repo.db.run("UPDATE observations SET status = 'merged', merged_into = ? WHERE id = ?", [z, x]);
        const queued = () => repo.missingVectors(100).map((r) => r.id);
        const row = (id: number) => repo.db.query("SELECT status, merged_into FROM observations WHERE id = ?").get(id) as any;
        const hlc = new Hlc(repo, 1);
        const apply = (g: string, s: string, into: string | null) =>
          repo.db
            .transaction(() =>
              applyOps(
                repo,
                1,
                hlc,
                [{ t: "status", g, h: hlc.tick(Date.now() + HOUR), s, into, by: null, until: null }] as any,
                2,
              ),
            )
            .immediate();
        expect(queued()).toEqual([]);
        // 1) status z huba: X wraca do aktywnych (setLocalStatus), bez bitów, więc wektor do przeliczenia
        expect(apply(`1:${x}`, "active", null).statuses).toBe(1);
        expect(row(x).status).toBe("active");
        expect(queued()).toEqual([x]);
        repo.putVector(x, "demo", "test", new Int8Array(dims).fill(1), new Uint8Array(dims / 8).fill(0x55), true);
        expect(queued()).toEqual([]);
        // 2) cykl scaleń: Y w Z tutaj, z huba Z w Y; zostaje najmniejszy gid (Y), wraca bez bitów, wektor do kolejki
        repo.db.run("UPDATE observations SET status = 'merged', merged_into = ? WHERE id = ?", [z, y]);
        expect(apply(`1:${z}`, "merged", `1:${y}`).statuses).toBe(1);
        expect(row(y).status).toBe("active");
        expect(row(z)).toEqual({ status: "merged", merged_into: y });
        expect(queued()).toEqual([y]);
      } finally {
        repo.db.close();
      }
    });
  });

  describe("odporność", () => {
    test("uszkodzony szyfrogram: wpis pominięty i zgłoszony, reszta przychodzi", async () => {
      obs(A, "Notatka przed uszkodzeniem");
      await sync.push(A.ctx);
      obs(A, "Notatka w uszkodzonym wpisie");
      await sync.push(A.ctx);
      obs(A, "Notatka po uszkodzeniu");
      await sync.push(A.ctx);
      const seqs = (
        hub.db.query("SELECT seq FROM entries WHERE dev = 1 ORDER BY seq DESC LIMIT 3").all() as { seq: number }[]
      ).map((r) => r.seq);
      const victim = seqs[1];
      const ct = Buffer.from((hub.db.query("SELECT ct FROM entries WHERE seq = ?").get(victim) as { ct: Uint8Array }).ct);
      ct[ct.length - 5] ^= 0xff;
      hub.db.run("UPDATE entries SET ct = ? WHERE seq = ?", [ct, victim]);
      const r = await sync.pull(C.ctx);
      expect(r.bad).toBe(1);
      expect(r.observations).toBe(2);
      expect(byTitle(C, "Notatka w uszkodzonym wpisie")).toBeNull();
      expect(byTitle(C, "Notatka po uszkodzeniu")).not.toBeNull();
      expect((await sync.syncStatus(C.ctx)).bad).toContain(victim);
      expect((await sync.pull(C.ctx)).bad).toBe(0);
      await sync.pull(B.ctx);
    });

    test("bomba deflate: treść ponad granicę po rozpakowaniu to uszkodzony wpis, odbiór idzie dalej; nadawca takiej nie wysyła", async () => {
      // członek grupy (ma klucz) wysyła kilka KB, które rozpakowują się do ponad LIMITS.maxEntryPlainBytes
      const huge = "0".repeat(LIMITS.maxEntryPlainBytes + 4096);
      const bomb = await postOps(A, [{ t: "obs", g: "1:7101", o: fakeObs("Notatka-bomba", { narrative: huge }), e: [] }], {
        label: "bomba",
      });
      expect(bomb.status).toBe(200);
      const row = hub.db.query("SELECT seq, id, kid, ct FROM entries WHERE id = ?").get(bomb.id) as any;
      expect(row.ct.byteLength).toBeLessThan(64 * 1024);
      const wire = { id: row.id, kid: row.kid, ct: Buffer.from(row.ct).toString("base64") };
      expect(() => openEntry(secretOf(A).keys, sync.readState(A.ctx)!.hub, wire)).toThrow(/granicy/);
      obs(A, "Notatka po bombie");
      await sync.push(A.ctx);
      const r = await sync.pull(B.ctx);
      expect(r.bad).toBe(1);
      expect(byTitle(B, "Notatka-bomba")).toBeNull();
      expect(byTitle(B, "Notatka po bombie")).not.toBeNull();
      expect((await sync.syncStatus(B.ctx)).bad).toContain(row.seq);
      await sync.pull(C.ctx);

      // nadawca: własna notatka ponad granicę po rozpakowaniu jest pominięta i zgłoszona, choć jej szyfrogram (kilka KB)
      // mieści się w limicie huba; osobny hub, żeby wiersz nie wracał przy resync w dalszych testach
      const BOOTB = `bootb-${Date.now()}`;
      const h = startHub({ dbPath: join(home, "hub-bomba", "hub.db"), port: 0, bootstrapSha256: sha256hex(BOOTB) });
      const P = machine("bomba-nadawca");
      try {
        await sync.initSync(P.ctx, { server: h.url, name: "p", bootstrap: BOOTB });
        obs(P, "Ogromna notatka", { narrative: "x".repeat(LIMITS.maxEntryPlainBytes + 4096) });
        obs(P, "Zwykła notatka obok ogromnej");
        const p = await sync.push(P.ctx);
        expect(p.skipped).toBe(1);
        const s = await sync.syncStatus(P.ctx);
        expect(s.skippedRows.map((x) => x.t)).toEqual(["obs"]);
        expect(s.skippedRows[0].bytes).toBeGreaterThan(LIMITS.maxEntryPlainBytes);
        const keys = secretOf(P).keys;
        const sent = (h.db.query("SELECT id, kid, ct FROM entries").all() as any[]).map((e) =>
          JSON.stringify(openEntry(keys, sync.readState(P.ctx)!.hub, { ...e, ct: Buffer.from(e.ct).toString("base64") })),
        );
        expect(sent.some((t) => t.includes("Zwykła notatka obok ogromnej"))).toBe(true);
        expect(sent.some((t) => t.includes("Ogromna notatka"))).toBe(false);
      } finally {
        h.stop();
        P.repo.db.close();
      }
    });

    test("niezgodna wersja: hub odpowiada 426; nieznana wersja koperty albo treści pominięta i zapamiętana, odbiór idzie dalej", async () => {
      const r = await fetch(`${hub.url}/v1/me`, { headers: { [PROTOCOL_HEADER]: "99" } });
      expect(r.status).toBe(426);
      expect(((await r.json()) as any).protocol).toBe(PROTOCOL_VERSION);
      const r2 = await fetch(`${hub.url}/v1/me`);
      expect(r2.status).toBe(426);

      expect((await postOps(A, [], { pv: 99, label: "wersja-tresci" })).status).toBe(200);
      expect((await postOps(A, [], { v: 2, label: "wersja-koperty" })).status).toBe(200);
      obs(A, "Notatka po nowych wersjach");
      await sync.push(A.ctx);
      const q = await sync.pull(B.ctx);
      expect(q.unreadable).toBe(2);
      expect(byTitle(B, "Notatka po nowych wersjach")).not.toBeNull();
      const s = await sync.syncStatus(B.ctx);
      expect(s.unreadable.map((u) => u.why).sort()).toEqual(["pv", "v"]);
      expect(s.rollback).toBeNull();
      expect((await sync.pull(B.ctx)).unreadable).toBe(0); // kursor poszedł dalej
      await sync.pull(C.ctx);
    });

    test("nieznany klucz grupy: wpis czeka, a po otrzymaniu klucza wraca sam", async () => {
      const k2 = newGroupKey();
      const ring = [...secretOf(A).keys, k2];
      await postOps(A, [{ t: "obs", g: "1:7004", o: fakeObs("Notatka nowym kluczem"), e: [] }], { keys: ring, label: "klucz" });
      const r = await sync.pull(B.ctx);
      expect(r.unreadable).toBe(1);
      expect(byTitle(B, "Notatka nowym kluczem")).toBeNull();
      const file = join(B.dir, "state", "sync-secret.json");
      const sb = secretOf(B);
      writeFileSync(file, JSON.stringify({ ...sb, keys: [...sb.keys, k2] }));
      try {
        const r2 = await sync.pull(B.ctx);
        expect(r2.observations).toBe(1);
        expect(byTitle(B, "Notatka nowym kluczem")).not.toBeNull();
        expect((await sync.syncStatus(B.ctx)).unreadable.filter((u) => u.why === "kid")).toEqual([]);
      } finally {
        writeFileSync(file, JSON.stringify(sb)); // aktywny klucz B jak u reszty grupy
      }
      await sync.pull(C.ctx);
    });

    test("wiele nieczytelnych wpisów: ponad listę zostaje zakres, po otrzymaniu klucza wracają wszystkie", async () => {
      const k3 = newGroupKey();
      const ring = [...secretOf(A).keys, k3];
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await postOps(A, [{ t: "obs", g: `1:${7200 + i}`, o: fakeObs(`Nieczytelna ${i}`), e: [] }], {
          keys: ring,
          label: `nieczytelna-${i}`,
        });
        seqs.push(r.body.stored[0].seq);
      }
      const ctx = { ...C.ctx, skipListMax: 2 }; // lista pominiętych krótsza niż liczba wpisów
      expect((await sync.pull(ctx)).unreadable).toBe(5);
      const s = await sync.syncStatus(ctx);
      expect(s.unreadable.map((u) => u.seq)).toEqual(seqs.slice(-2));
      expect(s.unreadableOlder!.max).toBeGreaterThanOrEqual(seqs[2]);
      expect(s.unreadableOlder!.min).toBeLessThanOrEqual(seqs[0]);
      const file = join(C.dir, "state", "sync-secret.json");
      const sc = secretOf(C);
      writeFileSync(file, JSON.stringify({ ...sc, keys: [...sc.keys.slice(0, -1), k3, sc.keys.at(-1)] }));
      try {
        const r2 = await sync.pull(ctx);
        expect(r2.observations).toBe(5);
        for (let i = 0; i < 5; i++) expect(byTitle(C, `Nieczytelna ${i}`)).not.toBeNull();
        const s2 = await sync.syncStatus(ctx);
        expect(s2.unreadable.filter((u) => u.why === "kid")).toEqual([]);
        // w zakresie zostały tylko wpisy, których ta wersja dalej nie czyta (nowsze wersje z testu wyżej)
        expect(!s2.unreadableOlder || s2.unreadableOlder.max < seqs[0]).toBe(true);
        expect((await sync.pull(ctx)).observations).toBe(0);
      } finally {
        writeFileSync(file, JSON.stringify(sc));
      }
    });

    test("zatruty wpis: pola złego typu odrzucone, błąd bazy przy jednej operacji cofa tylko ją, odbiór idzie dalej (X3)", async () => {
      const f = {
        project: "demo",
        cwd: null,
        git_branch: null,
        title: null,
        first_prompt: null,
        started_at: T0,
        ended_at: null,
        last_activity_at: null,
        prompt_count: 0,
        model: {},
        status: "active",
      };
      const s = {
        session_id: null,
        project: "demo",
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        files_read: [],
        files_edited: [],
        prompt_n: null,
        created_at: T0,
        source: "digest",
        meta: null,
      };
      const bad = [
        { t: "obs", g: "1:7101", o: fakeObs("Zły typ", { type: null }), e: [] },
        { t: "obs", g: "1:7102", o: fakeObs("Zła sesja", { session_id: {} }), e: [] },
        { t: "obs", g: "1:7103", o: fakeObs("Złe fakty", { facts: [1, 2] }), e: [] },
        { t: "prompt", g: "1:7104", sid: "s1", project: "demo", n: 1, text: "x", at: {}, src: "live" },
        { t: "ws", g: "1:7105", project: "demo", list: "plan", fields: {}, at: 1, src: "live", cm: {} },
        { t: "session", sid: "sx", h: hlcString(T0, 0, 1), f },
        { t: "sum", g: "1:7106", rep: "tak", s },
        { t: "status", g: "1:7107", h: "zły zegar", s: "archived", into: null, by: null, until: null },
        { t: "nieznana", g: "1:7108" },
        null,
        7,
        "napis",
      ];
      await postOps(A, [...bad, { t: "obs", g: "1:7109", o: fakeObs("Dobra notatka po zatrutych"), e: [] }], {
        label: "zatruty",
      });
      obs(A, "Dobra notatka w osobnym wpisie");
      await sync.push(A.ctx);
      const r1 = await sync.pull(C.ctx);
      expect(r1.rejected).toBe(bad.length);
      expect(byTitle(C, "Dobra notatka po zatrutych")).not.toBeNull();
      expect(byTitle(C, "Dobra notatka w osobnym wpisie")).not.toBeNull();
      for (const t of ["Zły typ", "Zła sesja", "Złe fakty"]) expect(byTitle(C, t)).toBeNull();
      expect((await sync.pull(C.ctx)).entries).toBe(0); // kursor poszedł dalej, nic nie wraca

      // błąd bazy w połowie jednej operacji (kontrola typów go nie widzi): SAVEPOINT cofa tylko ją, reszta wpisu wchodzi
      const orig = C.repo.insertTurnPrompt.bind(C.repo);
      C.repo.insertTurnPrompt = ((p: Parameters<typeof orig>[0]) => {
        orig(p);
        throw new Error("awaria w połowie operacji");
      }) as typeof orig;
      try {
        await postOps(
          A,
          [
            { t: "prompt", g: "1:7110", sid: "sesja-a1", project: "demo", n: 77, text: "prompt z awarią", at: T0, src: "test" },
            { t: "obs", g: "1:7111", o: fakeObs("Notatka obok awarii"), e: [] },
          ],
          { label: "awaria" },
        );
        const r2 = await sync.pull(C.ctx);
        expect(r2.rejected).toBe(1);
        expect(r2.observations).toBe(1);
        expect(C.repo.db.query("SELECT COUNT(*) c FROM prompts WHERE text = 'prompt z awarią'").get()).toEqual({ c: 0 });
      } finally {
        C.repo.insertTurnPrompt = orig;
      }
      await sync.pull(B.ctx);
    });

    test("odcięcie urządzenia: B traci dostęp, A i C działają, member nie odcina", async () => {
      await expect(sync.revokeDevice(C.ctx, 2)).rejects.toThrow(/admin/);
      await expect(sync.revokeDevice(A.ctx, 1)).rejects.toThrow(/nie można odciąć/);
      await sync.revokeDevice(A.ctx, 2);
      obs(B, "Notatka laptopa po odcięciu");
      await expect(sync.push(B.ctx)).rejects.toThrow(/odcięte/);
      await expect(sync.pull(B.ctx)).rejects.toThrow(/odcięte/);
      const devs = await sync.listDevices(A.ctx);
      expect(devs.find((d) => d.no === 2)?.status).toBe("revoked");
      obs(A, "Notatka po odcięciu B");
      await sync.push(A.ctx);
      expect((await sync.pull(C.ctx)).observations).toBe(1);
      expect(byTitle(C, "Notatka laptopa po odcięciu")).toBeNull();
    });

    test("przywrócona kopia bazy: wysyłka wstrzymana, pull --full odtwarza, nowa notatka idzie pod innym gid", async () => {
      const snap = join(A.dir, "kopia.db");
      A.repo.db.run(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
      const lost = obs(A, "Notatka utracona przy przywróceniu");
      await sync.push(A.ctx);
      // przywrócenie: baza sprzed notatki, ten sam katalog stanu (na Windows plik otwartej bazy jest zablokowany,
      // więc kopia idzie pod nową ścieżkę; dla synchronizacji to to samo)
      const restored = join(A.dir, "hipokamp-przywrocona.db");
      copyFileSync(snap, restored);
      A.repo = new Repo(openDb({ path: restored }));
      A.ctx = { ...A.ctx, repo: A.repo };
      const fresh = obs(A, "Nowa notatka po przywróceniu");
      expect(fresh).toBe(lost); // ten sam numer, inna treść
      await expect(sync.push(A.ctx)).rejects.toThrow(/pull --full/);
      const r = await sync.pull(A.ctx, { full: true });
      expect(r.observations).toBeGreaterThanOrEqual(1);
      const back = byTitle(A, "Notatka utracona przy przywróceniu");
      expect(back).not.toBeNull();
      expect(back.id).not.toBe(lost);
      await sync.push(A.ctx);
      await sync.pull(C.ctx);
      expect(byTitle(C, "Nowa notatka po przywróceniu")).not.toBeNull();
      expect(byTitle(C, "Notatka utracona przy przywróceniu").id).toBe(lost);
    });
  });

  describe("cofnięty dziennik huba i przerwana wysyłka", () => {
    const BOOT5 = `boot5-${Date.now()}`;
    const dbPath = join(home, "hub5", "hub.db");
    let h = startHub({ dbPath, port: 0, bootstrapSha256: sha256hex(BOOT5) });
    const D = machine("d-stacja");
    const E = machine("e-laptop");
    const F = machine("f-mirror");

    test("hub przywrócony z kopii: odbiór i wysyłka stają, resync odbudowuje, nowe urządzenie dostaje wszystko", async () => {
      await sync.initSync(D.ctx, { server: h.url, name: "d", bootstrap: BOOT5 });
      await joinVia(D, E, h.url, "e");
      obs(D, "Wpis n1");
      await sync.push(D.ctx);
      await sync.pull(E.ctx);
      const snap = join(home, "hub5", "kopia.db");
      h.db.run(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
      obs(D, "Wpis n2");
      await sync.push(D.ctx);
      expect((await sync.pull(E.ctx)).observations).toBe(1);

      // hub przywrócony z kopii sprzed n2 (ten sam adres)
      const port = h.port;
      h.stop();
      for (const s of ["", "-wal", "-shm"]) if (existsSync(dbPath + s)) rmSync(dbPath + s);
      copyFileSync(snap, dbPath);
      h = startHub({ dbPath, port, bootstrapSha256: sha256hex(BOOT5) });
      obs(D, "Wpis n3");
      await expect(sync.push(D.ctx)).rejects.toThrow(/sync resync/);
      await expect(sync.pull(E.ctx)).rejects.toThrow(/sync resync/);
      expect((await sync.syncStatus(E.ctx)).rollback).toContain("wstrzymana");

      const rd = await sync.resync(D.ctx);
      expect(rd.push.ops).toBeGreaterThanOrEqual(3);
      await sync.resync(E.ctx);
      for (const t of ["Wpis n1", "Wpis n2", "Wpis n3"]) expect(byTitle(E, t)).not.toBeNull();
      expect(count(E, "observations")).toBe(3);
      // resync admina włączył tryb odzyskiwania: nowe urządzenie dopiero z potwierdzeniem
      await expect(joinVia(D, F, h.url, "f")).rejects.toThrow(/--ack-lost-devices/);
      await sync.approveJoin(D.ctx, { code: sync.pendingJoin(F.ctx)!.code, ackLost: true });
      expect((await sync.joinFinish(F.ctx)).status).toBe("approved");
      await sync.pull(F.ctx);
      for (const t of ["Wpis n1", "Wpis n2", "Wpis n3"]) expect(byTitle(F, t)).not.toBeNull();
      expect((await sync.push(D.ctx)).ops).toBe(0);
      expect((await sync.pull(E.ctx)).entries).toBe(0);
    });

    test("przerwana wysyłka: znacznik najwyższego numeru zapisany po każdej potwierdzonej partii", async () => {
      // ok. 510 KB (jedna notatka na wpis do 512 KB): 9 notatek w pierwszej partii 4 MB, dziesiąta w drugiej
      const big = "Duża notatka do wysyłki partiami. ".repeat(15_000);
      const ids = Array.from({ length: 10 }, (_, i) => obs(D, `Duża notatka ${i}`, { narrative: `${big}${i}` }));
      const before = sync.readState(D.ctx)!.hwm?.obs ?? 0;
      const orig = globalThis.fetch;
      let posts = 0;
      globalThis.fetch = (async (input: any, init?: any) => {
        if (String(input).endsWith("/v1/entries") && init?.method === "POST" && ++posts === 2)
          return new Response(JSON.stringify({ error: "zerwane połączenie" }), { status: 500 });
        return orig(input, init);
      }) as typeof fetch;
      try {
        await expect(sync.push(D.ctx)).rejects.toThrow(/zerwane/);
      } finally {
        globalThis.fetch = orig;
      }
      const mid = sync.readState(D.ctx)!.hwm!.obs;
      expect(mid).toBeGreaterThan(before);
      expect(mid).toBeLessThan(Math.max(...ids));
      await sync.push(D.ctx);
      expect(sync.readState(D.ctx)!.hwm!.obs).toBe(Math.max(...ids));
      await sync.pull(E.ctx);
      expect(byTitle(E, "Duża notatka 9")).not.toBeNull();
    });

    test("sprzątanie huba 5", () => {
      h.stop();
      for (const m of [D, E, F]) m.repo.db.close();
    });
  });

  describe("hub z kopii a numery urządzeń (X2)", () => {
    const BOOT9 = `boot9-${Date.now()}`;
    const dbPath = join(home, "hub9", "hub.db");
    const limits = { joinsPerIpPer15Min: 100 }; // wszystkie prośby z 127.0.0.1
    let h = startHub({ dbPath, port: 0, bootstrapSha256: sha256hex(BOOT9), limits });
    const [P, Q, R, S, U] = ["x2-stacja", "x2-laptop", "x2-mirror", "x2-nowy", "x2-piaty"].map(machine);
    const dev = (m: Machine) => sync.readState(m.ctx)?.device;
    const titles = ["Notatka Q sprzed przywrócenia", "Notatka R sprzed przywrócenia", "Notatka S po przywróceniu"];

    test("numer nie wraca do użycia; urządzenia, których hub nie zna, dołączają od nowa i ich notatki wracają do huba", async () => {
      await sync.initSync(P.ctx, { server: h.url, name: "p", bootstrap: BOOT9 });
      const snap = join(home, "hub9", "kopia.db");
      h.db.run(`VACUUM INTO '${snap.replace(/'/g, "''")}'`); // kopia huba sprzed dołączenia Q i R
      await joinVia(P, Q, h.url, "q");
      await joinVia(P, R, h.url, "r");
      expect([dev(Q), dev(R)]).toEqual([2, 3]);
      obs(Q, titles[0]);
      obs(R, titles[1]);
      await sync.push(Q.ctx);
      await sync.push(R.ctx);
      await sync.pull(P.ctx);

      // hub przywrócony z kopii (ten sam adres): zna tylko P i nie ma wpisów
      const port = h.port;
      h.stop();
      for (const s of ["", "-wal", "-shm"]) if (existsSync(dbPath + s)) rmSync(dbPath + s);
      copyFileSync(snap, dbPath);
      h = startHub({ dbPath, port, bootstrapSha256: sha256hex(BOOT9), limits });

      // admin nie wyda numeru, zanim hub nie pozna numerów, które zna grupa (inaczej S dostałby ponownie nr 2)
      const j = await sync.joinStart(S.ctx, { server: h.url, name: "s" });
      await expect(sync.approveJoin(P.ctx, { code: j.code })).rejects.toThrow(/sync resync/);
      expect((await sync.resync(P.ctx)).recovery).toBe(true);
      await expect(sync.approveJoin(P.ctx, { code: j.code })).rejects.toThrow(/--ack-lost-devices/);
      await sync.approveJoin(P.ctx, { code: j.code, ackLost: true });
      expect((await sync.joinFinish(S.ctx)).status).toBe("approved");
      expect(dev(S)).toBe(4);
      obs(S, titles[2]);
      await sync.push(S.ctx);

      // Q i R hub zapomniał: komunikat wskazuje naprawę, a po niej ich notatki wracają do huba pod nowym numerem
      await expect(sync.pull(R.ctx)).rejects.toThrow(/sync leave/);
      await expect(sync.push(Q.ctx)).rejects.toThrow(/sync leave/);
      for (const [m, name] of [
        [R, "r"],
        [Q, "q"],
      ] as const) {
        expect((await sync.leave(m.ctx)).device).toBeGreaterThan(1);
        await joinVia(P, m, h.url, name);
        await sync.push(m.ctx);
        await sync.pull(m.ctx);
      }
      expect([dev(R), dev(Q)]).toEqual([5, 6]);
      await joinVia(P, U, h.url, "u");
      for (const m of [P, Q, R, S, U]) await sync.pull(m.ctx);

      // każda notatka dokładnie raz na każdym komputerze; #id notatki Q zostaje (numer ze starej przestrzeni Q)
      for (const m of [P, Q, R, S, U])
        for (const t of titles)
          expect((m.repo.db.query("SELECT COUNT(*) c FROM observations WHERE title = ?").get(t) as { c: number }).c).toBe(1);
      expect(byTitle(U, titles[0]).id).toBe(200_000_001);
      expect(byTitle(U, titles[1]).id).toBe(300_000_001);
      // numery urządzeń: żaden nie wrócił, Q pisze już w nowej przestrzeni
      expect((await sync.listDevices(P.ctx)).map((d) => d.no)).toEqual([1, 4, 5, 6, 7]);
      expect(obs(Q, "Nowa notatka Q")).toBe(600_000_001);
    });

    test("hub odrzuca numer już użyty albo niższy niż prośba pozwala", async () => {
      const N = machine("x2-reczny");
      const pj = await sync.joinStart(N.ctx, { server: h.url, name: "reczny" });
      const tok = secretOf(P).token;
      const approve = (device: unknown) =>
        raw(
          `/v1/join/${pj.request}/approve`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
            body: JSON.stringify({ sealed: "{}", mac: "A".repeat(43), role: "member", device }),
          },
          h.url,
        );
      for (const d of [1, 0, 1e11, "8", 2.5]) expect((await approve(d)).status).toBe(400);
      const r = await approve(5);
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).max_device).toBe(7);
      N.repo.db.close();
    });

    test("sprzątanie huba 9", () => {
      h.stop();
      for (const m of [P, Q, R, S, U]) m.repo.db.close();
    });
  });

  describe("hub z kopii i dwóch adminów: tryb odzyskiwania (S10)", () => {
    const BOOT11 = `boot11-${Date.now()}`;
    const dbPath = join(home, "hub11", "hub.db");
    const limits = { joinsPerIpPer15Min: 100 };
    let h = startHub({ dbPath, port: 0, bootstrapSha256: sha256hex(BOOT11), limits });
    const [P, A2, K, S] = ["s10-stacja", "s10-admin2", "s10-k", "s10-s"].map(machine);
    const dev = (m: Machine) => sync.readState(m.ctx)?.device;

    test("numer nadany przez drugiego admina po kopii nie wraca: zatwierdzanie czeka na resync każdego admina i potwierdzenie", async () => {
      await sync.initSync(P.ctx, { server: h.url, name: "p", bootstrap: BOOT11 });
      await joinVia(P, A2, h.url, "a2", { admin: true });
      const snap = join(home, "hub11", "kopia.db");
      h.db.run(`VACUUM INTO '${snap.replace(/'/g, "''")}'`); // kopia zna 1 i 2
      await joinVia(A2, K, h.url, "k"); // K zatwierdza drugi admin: numer 3 zna tylko A2 (i K)
      expect(dev(K)).toBe(3);
      obs(K, "Notatka K");
      await sync.push(K.ctx);
      await sync.pull(A2.ctx);

      const port = h.port;
      h.stop();
      for (const s of ["", "-wal", "-shm"]) if (existsSync(dbPath + s)) rmSync(dbPath + s);
      copyFileSync(snap, dbPath);
      h = startHub({ dbPath, port, bootstrapSha256: sha256hex(BOOT11), limits });

      // P niczego nie wykrywa (nie zna nr 3); jego resync włącza tryb odzyskiwania
      expect((await sync.resync(P.ctx)).recovery).toBe(true);
      const js = await sync.joinStart(S.ctx, { server: h.url, name: "s" });
      await expect(sync.approveJoin(P.ctx, { code: js.code, ackLost: true })).rejects.toThrow(/resync.*nr 2/);
      expect((await sync.syncStatus(P.ctx)).recovery).toBe(true);
      // resync drugiego admina podnosi licznik huba do nr 3
      await sync.resync(A2.ctx);
      await expect(sync.approveJoin(P.ctx, { code: js.code })).rejects.toThrow(/--ack-lost-devices/);
      // K hub nie zna: prośba od nowa (jej min_device mówi, że K zna nr 3), potem zatwierdzenia z potwierdzeniem
      await expect(sync.push(K.ctx)).rejects.toThrow(/sync leave/);
      await sync.leave(K.ctx);
      const jk = await sync.joinStart(K.ctx, { server: h.url, name: "k" });
      await sync.approveJoin(P.ctx, { code: js.code, ackLost: true });
      expect((await sync.joinFinish(S.ctx)).status).toBe("approved");
      await sync.approveJoin(P.ctx, { code: jk.code }); // tryb odzyskiwania już zakończony
      expect((await sync.joinFinish(K.ctx)).status).toBe("approved");
      expect(dev(S)).toBe(4);
      expect(dev(K)).toBe(5);

      obs(S, "Notatka S");
      await sync.push(S.ctx);
      await sync.push(K.ctx);
      for (const m of [A2, P, S, K]) await sync.pull(m.ctx);
      for (const m of [A2, P, S, K])
        for (const t of ["Notatka K", "Notatka S"])
          expect((m.repo.db.query("SELECT COUNT(*) c FROM observations WHERE title = ?").get(t) as { c: number }).c).toBe(1);
      expect(byTitle(A2, "Notatka S").id).not.toBe(byTitle(A2, "Notatka K").id);
      expect((await sync.listDevices(P.ctx)).map((d) => d.no)).toEqual([1, 2, 4, 5]);
    });

    test("znacznik przywrócenia przy starcie huba włącza tryb odzyskiwania", async () => {
      const port = h.port;
      h.stop();
      h = startHub({ dbPath, port, bootstrapSha256: sha256hex(BOOT11), limits, restoredMark: "2026-10-05" });
      expect((await sync.syncStatus(P.ctx)).recovery).toBe(true);
      // ten sam znacznik po restarcie nic nie zmienia; tryb kończy się po resync adminów i potwierdzeniu
      for (const m of [P, A2]) await sync.resync(m.ctx);
      const N = machine("s10-n");
      await joinVia(P, N, h.url, "n", { ackLost: true });
      h.stop();
      h = startHub({ dbPath, port, bootstrapSha256: sha256hex(BOOT11), limits, restoredMark: "2026-10-05" });
      expect((await sync.syncStatus(P.ctx)).recovery).toBe(false);
      N.repo.db.close();
    });

    test("sprzątanie huba 11", () => {
      h.stop();
      for (const m of [P, A2, K, S]) m.repo.db.close();
    });
  });

  describe("członek, zaproszenie, równoległe zatwierdzenia, jedyny admin (S2b, S3, S5)", () => {
    const BOOT12 = `boot12-${Date.now()}`;
    const h = startHub({
      dbPath: join(home, "hub12", "hub.db"),
      port: 0,
      bootstrapSha256: sha256hex(BOOT12),
      limits: { joinsPerIpPer15Min: 100, maxPendingJoinsPerIp: 50 },
    });
    const [P, A2, M] = ["s5-stacja", "s5-admin2", "s5-czlonek"].map(machine);
    const maxDevice = () =>
      Number((h.db.query("SELECT v FROM meta WHERE k = 'max_device'").get() as { v: string } | null)?.v ?? 0);
    const anchors = (m: Machine, q: string) =>
      raw(`/v1/anchors?${q}`, { headers: { authorization: `Bearer ${secretOf(m).token}` } }, h.url);

    test("jedyny admin nie opuści grupy bez --abandon-group", async () => {
      await sync.initSync(P.ctx, { server: h.url, name: "p", bootstrap: BOOT12 });
      await expect(sync.leave(P.ctx)).rejects.toThrow(/jedyne aktywne urządzenie z rolą admin/);
      expect(sync.readState(P.ctx)).not.toBeNull();
      await joinVia(P, A2, h.url, "a2", { admin: true });
      await joinVia(P, M, h.url, "m");
    });

    test("członek nie podniesie licznika numerów urządzeń, admin najwyżej o maxDeviceRaise (S3)", async () => {
      const before = maxDevice();
      expect((await anchors(M, "seqs=&maxdev=999999&raise=1")).status).toBe(200);
      expect(maxDevice()).toBe(before);
      expect((await anchors(P, "seqs=&maxdev=999999&raise=1")).status).toBe(400);
      expect(maxDevice()).toBe(before);
      // członek, który zna wyższy numer niż hub: resync kieruje do admina, nic nie podnosi
      const { noteDevice } = await import("../src/sync/store.ts");
      noteDevice(M.repo, 40);
      await expect(sync.resync(M.ctx)).rejects.toThrow(/podnosi tylko admin/);
      expect(maxDevice()).toBe(before);
      // admin (resync) podnosi w granicach i włącza tryb odzyskiwania; potwierdzenie go kończy
      noteDevice(P.repo, 40);
      await sync.resync(P.ctx);
      expect(maxDevice()).toBe(40);
      await sync.resync(A2.ctx);
      const X = machine("s3-nowy");
      await joinVia(P, X, h.url, "x", { ackLost: true });
      expect(sync.readState(X.ctx)!.device).toBe(41);
      await sync.resync(M.ctx);
      X.repo.db.close();
    });

    test("zaproszenie jednorazowe także przy wolno wysyłanym ciele (S2b)", async () => {
      const inv = await sync.createInvite(P.ctx);
      const one = (i: number) =>
        new Promise<number>((res) => {
          const body = JSON.stringify({
            name: `z${i}`,
            token_hash: sha256hex(`s2b-${i}`),
            pubkey: "A".repeat(43),
            proof: "B".repeat(43),
          });
          const r = httpRequest(
            {
              host: "127.0.0.1",
              port: h.port,
              path: "/v1/join",
              method: "POST",
              headers: {
                host: `127.0.0.1:${h.port}`,
                [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                [INVITE_HEADER]: inv.invite,
              },
            },
            (x) => {
              x.resume();
              res(x.statusCode ?? 0);
            },
          );
          r.on("error", () => res(-1));
          r.write(body.slice(0, 10));
          setTimeout(() => r.end(body.slice(10)), 200);
        });
      const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 403)).toHaveLength(11);
      expect((h.db.query("SELECT COUNT(*) c FROM joins WHERE invited = 1").get() as { c: number }).c).toBe(1);
    });

    test("trzy równoczesne zatwierdzenia dwóch adminów: każde dostaje inny numer (S5)", async () => {
      const news = ["s5-c", "s5-d", "s5-e"].map(machine);
      const codes = [];
      for (const [i, m] of news.entries()) codes.push((await sync.joinStart(m.ctx, { server: h.url, name: `n${i}` })).code);
      const res = await Promise.all([
        sync.approveJoin(P.ctx, { code: codes[0] }),
        sync.approveJoin(A2.ctx, { code: codes[1] }),
        sync.approveJoin(P.ctx, { code: codes[2] }),
      ]);
      expect(new Set(res.map((r) => r.device)).size).toBe(3);
      for (const m of news) expect((await sync.joinFinish(m.ctx)).status).toBe("approved");
      expect(new Set(news.map((m) => sync.readState(m.ctx)!.device)).size).toBe(3);
      for (const m of news) m.repo.db.close();
      // drugi admin jest, więc pierwszy może odejść
      expect((await sync.leave(A2.ctx)).device).toBe(2);
    });

    test("sprzątanie huba 12", () => {
      h.stop();
      for (const m of [P, A2, M]) m.repo.db.close();
    });
  });

  describe("ponowne dołączenie: listy pracy i odnośniki scaleń (S9, S1b), odbiór kawałkami (S6)", () => {
    const BOOT13 = `boot13-${Date.now()}`;
    const h = startHub({
      dbPath: join(home, "hub13", "hub.db"),
      port: 0,
      bootstrapSha256: sha256hex(BOOT13),
      limits: { joinsPerIpPer15Min: 100 },
    });
    const [P, Q, W] = ["s9-stacja", "s9-laptop", "s9-nowy"].map(machine);

    test("po leave i join wpisy list pracy się nie dublują, a cel scalenia pod nowym gid dociera wszędzie", async () => {
      await sync.initSync(P.ctx, { server: h.url, name: "p", bootstrap: BOOT13 });
      await joinVia(P, Q, h.url, "q");
      const qn = obs(Q, "QN");
      for (let i = 0; i < 3; i++) Q.repo.appendWorkState("demo", "plan", { task: `zadanie ${i}`, status: "todo" }, T0 + i);
      await sync.push(Q.ctx);
      await sync.pull(P.ctx);
      // Q dołącza od nowa (hub wciąż ma jego wpisy pod starym numerem): wysyła wszystko jeszcze raz pod nowym
      await sync.leave(Q.ctx);
      await joinVia(P, Q, h.url, "q");
      expect(sync.readState(Q.ctx)!.device).toBe(3);
      await sync.push(Q.ctx);
      await sync.pull(P.ctx);
      await joinVia(P, W, h.url, "w");
      await sync.pull(W.ctx);
      for (const m of [P, Q, W]) {
        expect(count(m, "work_state")).toBe(3);
        expect((m.repo.db.query("SELECT COUNT(*) c FROM observations WHERE title = 'QN'").get() as { c: number }).c).toBe(1);
      }
      // P scala swoją notatkę w QN (QN ma na P dwa gid: 2:… i 3:…); odnośnik idzie pod nowym, znanym wszystkim
      const px = obs(P, "PX");
      await sync.push(P.ctx);
      for (const m of [Q, W]) await sync.pull(m.ctx);
      P.repo.setStatus(px, "merged", { mergedInto: byTitle(P, "QN").id });
      await sync.push(P.ctx);
      for (const m of [Q, W]) await sync.pull(m.ctx);
      expect(byTitle(Q, "QN").id).toBe(qn);
      for (const m of [Q, W]) {
        const r = byTitle(m, "PX");
        expect(r.status).toBe("merged");
        expect(r.merged_into).toBe(byTitle(m, "QN").id);
      }
      expect((P.repo.db.query("SELECT into_gid FROM sync_status WHERE into_gid IS NOT NULL").get() as any).into_gid).toMatch(
        /^3:/,
      );
    });

    test("duży wpis stosuje się kawałkami: krótkie transakcje, pętla zdarzeń dostaje głos (S6)", async () => {
      for (let i = 0; i < 400; i++) obs(Q, `Partia ${i}`, { narrative: `Notatka numer ${i} z większej partii odbioru.` });
      const pushed = await sync.push(Q.ctx);
      const V = machine("s6-odbiorca");
      await joinVia(P, V, h.url, "v");
      const slices: number[] = [];
      V.ctx.sliceMs = 10;
      V.ctx.onSlice = (ms) => slices.push(ms);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      const r = await sync.pull(V.ctx);
      clearInterval(timer);
      expect(count(V, "observations")).toBeGreaterThanOrEqual(400);
      expect(slices.length).toBeGreaterThan(r.entries);
      expect(Math.max(...slices)).toBeLessThan(100);
      expect(ticks).toBeGreaterThan(0);
      expect(pushed.entries).toBeGreaterThan(0);
      V.repo.db.close();
    });

    test("sprzątanie huba 13", () => {
      h.stop();
      for (const m of [P, Q, W]) m.repo.db.close();
    });
  });

  describe("granice huba", () => {
    const get = (port: number, path: string, headers: Record<string, string>) =>
      new Promise<number>((res, rej) => {
        const r = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (x) => {
          x.resume();
          res(x.statusCode ?? 0);
        });
        r.on("error", rej);
        r.end();
      });

    test("obcy Host, przeglądarka, brak HTTPS za proxy", async () => {
      const h = startHub({
        dbPath: join(home, "hub2", "hub.db"),
        port: 0,
        publicHosts: ["hipokamp.test"],
        requireHttps: true,
      });
      try {
        expect(await get(h.port, "/v1/health", { host: "zly.example" })).toBe(421);
        expect(await get(h.port, "/v1/health", { host: "hipokamp.test" })).toBe(403);
        expect(await get(h.port, "/v1/health", { host: "hipokamp.test", "x-forwarded-proto": "https" })).toBe(200);
        expect(await get(h.port, "/v1/health", { host: `127.0.0.1:${h.port}`, origin: "https://zla.strona" })).toBe(403);
        // bez sekretu bootstrapu w konfiguracji: init wyłączony
        const r = await fetch(`${h.url}/v1/bootstrap`, {
          method: "POST",
          headers: { [PROTOCOL_HEADER]: "1", authorization: "Bearer x", "content-type": "application/json" },
          body: "{}",
        });
        expect(r.status).toBe(403);
      } finally {
        h.stop();
      }
    });

    test("limity: rozmiar żądania i liczba żądań", async () => {
      const h = startHub({
        dbPath: join(home, "hub3", "hub.db"),
        port: 0,
        limits: { maxBodyBytes: 2048, anonRatePerMin: 3 },
      });
      try {
        const big = await fetch(`${h.url}/v1/join`, {
          method: "POST",
          headers: { [PROTOCOL_HEADER]: "1", "content-type": "application/json" },
          body: JSON.stringify({ pad: "x".repeat(8192) }),
        });
        expect(big.status).toBe(413);
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) codes.push((await fetch(`${h.url}/v1/health`)).status);
        expect(codes).toContain(429);
      } finally {
        h.stop();
      }
    });

    test("prośby z internetu: limit na adres IP, osobne kubełki, admin odrzuca; odbiór w budżecie bajtów; wiersz za duży pominięty", async () => {
      const BOOT6 = `boot6-${Date.now()}`;
      const h = startHub({
        dbPath: join(home, "hub6", "hub.db"),
        port: 0,
        bootstrapSha256: sha256hex(BOOT6),
        trustProxy: true,
        limits: { joinsPerIpPer15Min: 4, maxPendingJoinsPerIp: 2, maxPullBytes: 1, maxEntryBytes: 4096 },
      });
      const G = machine("g-admin");
      try {
        await sync.initSync(G.ctx, { server: h.url, name: "g", bootstrap: BOOT6 });
        const join = (ip: string) =>
          fetch(`${h.url}/v1/join`, {
            method: "POST",
            headers: { [PROTOCOL_HEADER]: "1", "content-type": "application/json", "x-real-ip": ip },
            body: JSON.stringify({
              name: "obcy",
              token_hash: sha256hex(`${ip}-${Math.random()}`),
              pubkey: "A".repeat(43),
              proof: "B".repeat(43),
            }),
          });
        const ip1 = "203.0.113.1";
        const r1 = await join(ip1);
        const r2 = await join(ip1);
        expect([r1.status, r2.status]).toEqual([200, 200]);
        expect((await join(ip1)).status).toBe(429); // dwie oczekujące z tego adresu
        expect((await join("203.0.113.2")).status).toBe(200); // inny adres ma swój limit
        expect((await fetch(`${h.url}/v1/health`, { headers: { "x-real-ip": ip1 } })).status).toBe(200); // osobny kubełek
        expect((await sync.listJoins(G.ctx)).length).toBe(3);
        const req1 = ((await r1.json()) as { request: string }).request;
        const req2 = ((await r2.json()) as { request: string }).request;
        await sync.rejectJoin(G.ctx, req1);
        expect((await sync.listJoins(G.ctx)).map((j) => j.request)).not.toContain(req1);
        expect((await join(ip1)).status).toBe(200); // miejsce po odrzuconej
        await sync.rejectJoin(G.ctx, req2);
        expect((await join(ip1)).status).toBe(429); // piąta próba w 15 minut: limit nowych próśb z adresu

        // odbiór: najpierw rozmiary, szyfrogramy tylko w budżecie bajtów (tu 1 bajt: jeden wpis na odpowiedź)
        for (let i = 0; i < 3; i++) {
          obs(G, `Mała notatka ${i}`);
          await sync.push(G.ctx);
        }
        const page = (await (
          await raw("/v1/entries?after=0&own=1", { headers: { authorization: `Bearer ${secretOf(G).token}` } }, h.url)
        ).json()) as { entries: unknown[]; more: boolean };
        expect(page.entries.length).toBe(1);
        expect(page.more).toBe(true);

        // wiersz większy niż limit huba: pominięty i zgłoszony, reszta partii idzie
        obs(G, "Za duża notatka", { narrative: randomBytes(30_000).toString("base64") });
        obs(G, "Zwykła notatka po dużej");
        const before = (h.db.query("SELECT COUNT(*) c FROM entries").get() as { c: number }).c;
        const p = await sync.push(G.ctx);
        expect(p.skipped).toBe(1);
        expect((h.db.query("SELECT COUNT(*) c FROM entries").get() as { c: number }).c).toBe(before + 1);
        const s = await sync.syncStatus(G.ctx);
        expect(s.skippedRows.map((r) => r.t)).toEqual(["obs"]);
        expect((await sync.push(G.ctx)).ops).toBe(0);
      } finally {
        h.stop();
        G.repo.db.close();
      }
    });
  });

  describe("granice huba: zalew z internetu", () => {
    test("adresy: IPv6 po podsieci /64, IPv4 w IPv6 jako IPv4, X-Real-IP tylko od adresu lokalnego (proxy)", () => {
      expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(ipKey("2001:db8:1:2::1"));
      expect(ipKey("2001:DB8:1:2::1")).toBe(ipKey("2001:db8:1:2::1"));
      expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
      expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
      expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
      for (const a of ["127.0.0.1", "::1", "10.1.2.3", "172.17.0.1", "192.168.1.5", "::ffff:172.18.0.1", "fd00::5"])
        expect(isLocalAddr(a)).toBe(true);
      for (const a of ["203.0.113.7", "8.8.8.8", "172.32.0.1", "2001:db8::1", "::ffff:8.8.8.8"])
        expect(isLocalAddr(a)).toBe(false);
    });

    test("podsieć IPv6 jak jeden adres, limit bez klucza na każdy endpoint, zaproszenie admina omija zapchaną kolejkę", async () => {
      const BOOT10 = `boot10-${Date.now()}`;
      const h = startHub({
        dbPath: join(home, "hub10", "hub.db"),
        port: 0,
        bootstrapSha256: sha256hex(BOOT10),
        trustProxy: true,
        limits: { maxPendingJoinsPerIp: 2, maxPendingJoins: 3, anonRatePerMin: 5, maxBuckets: 8 },
      });
      const G = machine("g10-admin");
      const N = machine("g10-nowy");
      try {
        await sync.initSync(G.ctx, { server: h.url, name: "g", bootstrap: BOOT10 });
        const join = (ip: string, headers: Record<string, string> = {}) =>
          fetch(`${h.url}/v1/join`, {
            method: "POST",
            headers: { [PROTOCOL_HEADER]: "1", "content-type": "application/json", "x-real-ip": ip, ...headers },
            body: JSON.stringify({
              name: "obcy",
              token_hash: sha256hex(`${ip}-${Math.random()}`),
              pubkey: "A".repeat(43),
              proof: "B".repeat(43),
            }),
          });
        // dwa adresy z jednej podsieci /64 to jeden klient: trzecia oczekująca prośba odrzucona
        expect((await join("2001:db8:1:2::1")).status).toBe(200);
        expect((await join("2001:db8:1:2:ffff::9")).status).toBe(200);
        expect((await join("2001:db8:1:2:9::9")).status).toBe(429);
        expect((await join("2001:db8:1:3::1")).status).toBe(200); // inna podsieć; kolejka (3) pełna
        expect((await join("198.51.100.9")).status).toBe(429);
        // skrót adresu z solą huba (bez soli adres IPv4 dałoby się odzyskać ze skrótu)
        const ips = (h.db.query("SELECT ip FROM joins").all() as { ip: string }[]).map((r) => r.ip);
        expect(ips).not.toContain(sha256hex("hipokamp-sync-ip\u00012001:db8:1:3::1").slice(0, 16));
        expect(ips).not.toContain(sha256hex("hipokamp-sync-ip\u00012001:db8:1:3::/64").slice(0, 16));

        // prawdziwe urządzenie przy zapchanej kolejce: bez zaproszenia odmowa, z zaproszeniem admina przechodzi
        await expect(sync.joinStart(N.ctx, { server: h.url, name: "nowy" })).rejects.toThrow(/sync invite/);
        const inv = await sync.createInvite(G.ctx);
        expect(inv.invite).toMatch(/^hki_/);
        const j = await sync.joinStart(N.ctx, { server: h.url, name: "nowy", invite: inv.invite });
        expect((await join("198.51.100.10", { [INVITE_HEADER]: inv.invite })).status).toBe(403); // jednorazowe
        await sync.approveJoin(G.ctx, { code: j.code });
        expect((await sync.joinFinish(N.ctx)).status).toBe("approved");
        expect(sync.readState(N.ctx)!.device).toBe(2);

        // żądania bez klucza (albo z nieznanym) do każdego endpointu: limit na adres, 429 po wyczerpaniu
        const fakeTok = `hks_${"x".repeat(43)}`;
        for (const [i, [path, auth]] of (
          [
            [`/v1/join/${"a".repeat(16)}`, ""],
            ["/v1/me", ""],
            ["/v1/entries?after=0", fakeTok],
            ["/v1/anchors?seqs=1", fakeTok],
          ] as const
        ).entries()) {
          const codes: number[] = [];
          for (let k = 0; k < 8; k++)
            codes.push(
              (
                await raw(
                  path,
                  { headers: { "x-real-ip": `198.51.100.${50 + i}`, ...(auth ? { authorization: `Bearer ${auth}` } : {}) } },
                  h.url,
                )
              ).status,
            );
          expect(codes).toContain(429);
        }
        // kubełków w pamięci najwyżej maxBuckets: zalew z wielu adresów nie zapycha pamięci ani nie blokuje huba
        for (let k = 0; k < 40; k++)
          expect((await fetch(`${h.url}/v1/health`, { headers: { "x-real-ip": `2001:db8:${k}::1` } })).status).toBe(200);
        expect((await sync.pull(N.ctx)).entries).toBe(0);
      } finally {
        h.stop();
        G.repo.db.close();
        N.repo.db.close();
      }
    });
  });

  describe("w tle", () => {
    test("synchronizacja w tle: wyłączona nie robi ani jednego połączenia, włączona robi obieg", async () => {
      const orig = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
        calls++;
        return orig(...a);
      }) as typeof fetch;
      try {
        const off = new SyncScheduler(A.repo, () => ({ enabled: false, intervalMin: 10 }), Date.now, A.ctx.stateDir);
        for (let i = 0; i < 3; i++) expect(off.maybe()).toBeNull();
        // domyślnie ustawienia z config.json w chwili sprawdzenia (worker): bez pliku synchronizacja wyłączona
        expect(new SyncScheduler(A.repo, undefined, Date.now, A.ctx.stateDir).maybe()).toBeNull();
        expect(calls).toBe(0);
        const on = new SyncScheduler(A.repo, () => ({ enabled: true, intervalMin: 10 }), Date.now, A.ctx.stateDir);
        let wrapped = 0;
        // worker opakowuje obieg w track("sync", …, { sliced: true }) (diagnostyka przestojów)
        const r = await on.maybe((run) => {
          wrapped++;
          return run();
        });
        expect(r).not.toBeNull();
        expect(wrapped).toBe(1);
        expect(calls).toBeGreaterThan(0);
        expect(on.maybe()).toBeNull(); // następny obieg dopiero po interwale
      } finally {
        globalThis.fetch = orig;
      }
    });

    test("ostrzeżenia zegara w logu workera: raz na rodzaj, nie co obieg; po zniknięciu i powrocie znowu (T-37)", async () => {
      const logged: string[] = [];
      let t = 0;
      const s = new SyncScheduler(
        A.repo,
        () => ({ enabled: true, intervalMin: 1 }),
        () => t,
        A.ctx.stateDir,
        (m) => logged.push(m),
      );
      const round = (kinds: string[]) => async () =>
        ({ push: {}, pull: {}, clock: kinds.map((kind) => ({ kind, text: `tekst ${kind}` })) }) as any;
      const tick = async (kinds: string[]) => {
        t += 61_000;
        await s.maybe(round(kinds));
      };
      await tick(["ahead"]);
      await tick(["ahead"]);
      await tick(["ahead", "rejected"]);
      await tick(["ahead", "rejected"]);
      expect(logged).toEqual(["sync: tekst ahead", "sync: tekst rejected"]);
      await tick([]);
      await tick(["ahead"]);
      expect(logged).toEqual(["sync: tekst ahead", "sync: tekst rejected", "sync: tekst ahead"]);
      // obieg bez ostrzeżeń w wyniku (starszy kształt) nic nie psuje
      t += 61_000;
      await s.maybe(async () => ({ push: {}, pull: {} }) as any);
      expect(logged).toHaveLength(3);
    });
  });

  describe("baza z innego komputera", () => {
    test("identyfikator instalacji pamięci automatycznej: nowy przy dołączeniu bazy skopiowanej z innego komputera, własny zostaje", async () => {
      const { foreignInstallId, adoptMembership } = await import("../src/sync/store.ts");
      const { getMeta, setMeta } = await import("../src/db/db.ts");
      const D = machine("kopia-dysku");
      expect(foreignInstallId(D.repo, "stacja-pc")).toBe(false); // bez identyfikatora nie ma czego zmieniać
      setMeta(D.repo.db, "install_id", "inst-1");
      const auto = (title: string, host: string) =>
        obs(D, title, { source: "automemory", meta: { automemory: { file: "c:/x/memory/a.md", install: "inst-1", host } } });
      auto("Pamięć z innego komputera", "inny-pc");
      // zepsute meta (np. z importu) nie przerywa sprawdzenia
      D.repo.db.run("UPDATE observations SET meta = '{nie json' WHERE id = ?", [auto("Zepsute meta", "stacja-pc")]);
      expect(foreignInstallId(D.repo, "stacja-pc")).toBe(true);
      expect(foreignInstallId(D.repo, "INNY-PC")).toBe(false); // wielkość liter bez znaczenia
      // ten sam komputer: identyfikator zostaje (inaczej import zdublowałby każdy plik pamięci)
      expect(adoptMembership(D.repo, 9, "inny-pc").newInstall).toBe(false);
      expect(getMeta(D.repo.db, "install_id")).toBe("inst-1");
      // baza skopiowana na inny komputer: importer wylosuje nowy, a notatki tamtego komputera zostają jego
      expect(adoptMembership(D.repo, 10, "stacja-pc").newInstall).toBe(true);
      expect(getMeta(D.repo.db, "install_id")).toBeNull();
    });
  });

  describe("CLI", () => {
    test("init, join, add-device, push, pull, status przez hipokamp sync; bez kluczy na ekranie", async () => {
      const BOOT2 = `boot2-${Date.now()}`;
      const h = startHub({ dbPath: join(home, "hub4", "hub.db"), port: 0, bootstrapSha256: sha256hex(BOOT2) });
      const homes = { x: join(home, "hipokamp-test-cli-x"), y: join(home, "hipokamp-test-cli-y") };
      const run = async (who: "x" | "y", args: string[], extra: Record<string, string> = {}) => {
        const p = Bun.spawn([process.execPath, join(ROOT, "src", "cli.ts"), ...args], {
          cwd: ROOT,
          env: { ...(process.env as Record<string, string>), HIPOKAMP_HOME: homes[who], HIPOKAMP_PORT: "47982", ...extra },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, out: out + err };
      };
      try {
        const init = await run("x", ["sync", "init", "--server", h.url, "--name", "cli-x"], { HIPOKAMP_SYNC_BOOTSTRAP: BOOT2 });
        expect(init.code).toBe(0);
        expect(init.out).toContain("hipokamp sync add-device");
        const sx = JSON.parse(readFileSync(join(homes.x, "state", "sync-secret.json"), "utf8"));
        expect(init.out).not.toContain(sx.token);
        expect(init.out).not.toContain(BOOT2);
        for (const k of sx.keys) expect(init.out).not.toContain(k.key);

        const j = await run("y", ["sync", "join", "--server", h.url, "--name", "cli-y", "--wait", "0"]);
        expect(j.code).toBe(0);
        const code = j.out.match(/Kod dołączania:\s+([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})/)?.[1];
        expect(code).toBeTruthy();
        expect((await run("x", ["sync", "joins"])).out).toContain("cli-y");
        expect((await run("x", ["sync", "add-device", "ZZZZ-ZZZZ-ZZZZ-ZZZZ"])).code).toBe(1);
        const add = await run("x", ["sync", "add-device", code!]);
        expect(add.code).toBe(0);
        const fin = await run("y", ["sync", "join", "--wait", "0"]);
        expect(fin.out).toContain("Dołączono: urządzenie nr 2");

        expect((await run("x", ["remember", "Pamięć z CLI przez hub", "--project", "demo"])).code).toBe(0);
        const p = await run("x", ["sync", "push"]);
        expect(p.out).toMatch(/wysłane: [1-9]/);
        const q = await run("y", ["sync", "pull"]);
        expect(q.out).toContain("notatki 1");
        const st = await run("y", ["sync", "status"]);
        expect(st.out).toContain("urządzenie: nr 2");
        expect(st.out).toContain("cli-x");
        const sy = JSON.parse(readFileSync(join(homes.y, "state", "sync-secret.json"), "utf8"));
        for (const o of [j.out, fin.out, q.out, st.out]) {
          expect(o).not.toContain(sy.token);
          for (const k of sy.keys) expect(o).not.toContain(k.key);
        }
        const hb = await run("x", ["sync", "bootstrap-hash"], { HIPOKAMP_SYNC_BOOTSTRAP: BOOT2 });
        expect(hb.out).toContain(sha256hex(BOOT2));
        // opuszczenie grupy tylko z --yes (kasuje lokalne klucze)
        const lv = await run("y", ["sync", "leave"]);
        expect(lv.code).toBe(1);
        expect(existsSync(join(homes.y, "state", "sync-secret.json"))).toBe(true);
      } finally {
        h.stop();
      }
    }, 60_000);
  });

  test("sprzątanie", () => {
    hub.stop();
    for (const m of [A, B, C]) m.repo.db.close();
  });
}
