// Powiadomienia (`notify`): wybór notatek z okna czasu (typy, ważność, źródła, projekty, wiek), grupowanie, limit
// częstości i na godzinę, blokada procesu wysyłki, kanały na atrapach i prawdziwe lokalne (plik, webhook na porcie 0,
// polecenie z treścią na stdin), odmowa webhooka spoza 127.0.0.1, toast bez treści w linii poleceń i hook Stop,
// który podnosi odłączony proces wysyłki. Nic nie wychodzi z maszyny.
// Osobny proces z katalogiem „hipokamp-test” jak w projects.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_NOTIFY_CHILD";

if (!process.env[CHILD]) {
  test("powiadomienia (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/notify.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47990",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `notify: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy powiadomień nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, DEFAULTS, ensureDataDirs, loadConfig, paths } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test")) throw new Error("notify: HIPOKAMP_HOME musi wskazywać katalog testowy");
  ensureDataDirs();
  const { openDb, getMeta } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const N = await import("../src/notify/notify.ts");
  const { toastInvocation } = await import("../src/notify/channels.ts");
  const J = await import("./fixtures/capture/jsonl.ts");
  type RepoT = InstanceType<typeof Repo>;
  type Msg = import("../src/notify/notify.ts").NotifyMessage;

  const MIN = 60_000;
  let seq = 0;
  const fresh = (): RepoT => new Repo(openDb({ path: join(DATA_DIR, `${++seq}-n.db`), vectors: false }));
  const cfgOf = (over: Partial<typeof DEFAULTS.notify> = {}) => ({
    ...DEFAULTS.notify,
    enabled: true,
    channels: ["atrapa"],
    ...over,
  });
  const sink = () => {
    const got: Msg[] = [];
    return { got, channels: { atrapa: async (m: Msg) => void got.push(m) } };
  };
  const note = (
    repo: RepoT,
    o: { type?: string; title: string; importance?: number; source?: string; project?: string; at?: number },
  ) =>
    repo.insertObservation({
      session_id: null,
      project: o.project ?? "Proj",
      type: o.type ?? "decision",
      title: o.title,
      narrative: `${o.title}.`,
      importance: o.importance ?? 0.8,
      source: (o.source ?? "digest") as any,
      created_at: o.at ?? Date.now(),
    }).id;
  const lock = () => join(paths.state(), "notify.lock");

  describe("wybór i grupowanie", () => {
    test("tylko wybrane typy, ważność i źródła; bez historii sprzed okna; kursor nie wysyła drugi raz", async () => {
      const repo = fresh();
      note(repo, { title: "stara decyzja sprzed włączenia", at: Date.now() - 5 * 60 * MIN });
      const d = note(repo, { title: "Tylko HTTPS do serwera git" });
      const g = note(repo, { type: "gotcha", title: "Heredoc psuje znaki nowej linii", importance: 0.7, source: "agent" });
      note(repo, { type: "preference", title: "mało ważna preferencja", importance: 0.4 });
      note(repo, { type: "feature", title: "nowa funkcja", importance: 0.9 });
      note(repo, { title: "decyzja z backfillu", source: "backfill" });
      note(repo, { title: "decyzja z claude-mem", source: "claude-mem" });
      const s = sink();
      const r = await N.runNotify(repo, cfgOf(), { channels: s.channels });
      expect(r.sent).toBe(true);
      expect(r.delivered).toEqual(["atrapa"]);
      expect(s.got.length).toBe(1);
      expect(s.got[0].items.map((i) => i.id).sort()).toEqual([d, g].sort());
      expect(s.got[0].title).toBe("hipokamp: 2 nowe notatki");
      expect(s.got[0].text).toContain("[decyzja] Tylko HTTPS do serwera git (Proj)");
      expect(s.got[0].text).toContain("[pułapka] Heredoc");
      expect(
        JSON.parse(getMeta(repo.db, "notify_seen")!)
          .map((x: number[]) => x[0])
          .sort(),
      ).toEqual([d, g].sort());

      const again = await N.runNotify(repo, cfgOf(), { channels: s.channels, force: true });
      expect(again.sent).toBe(false);
      expect(again.reason).toContain("brak nowych");

      // stara notatka wstawiona później (np. import z dawną datą) jest poza oknem, świeża idzie sama
      note(repo, { title: "dawna decyzja z importu", at: Date.now() - 10 * 60 * MIN });
      const one = note(repo, { title: "Nowa decyzja o kopiach", project: "Kopie" });
      const r3 = await N.runNotify(repo, cfgOf(), { channels: s.channels, force: true });
      expect(r3.message?.items.map((i) => i.id)).toEqual([one]);
      expect(s.got[1].count).toBe(1);
      expect(s.got[1].title).toBe("hipokamp: decyzja · Kopie");
      expect(s.got[1].text).toBe(`#${one} Nowa decyzja o kopiach`);
    });

    test("numer z innego urządzenia (synchronizacja) nie zasłania lokalnych notatek", async () => {
      const repo = fresh();
      const s = sink();
      // notatka z drugiego urządzenia z numerem z innego zakresu; lokalna dostaje numer niższy
      const withId = (id: number, title: string) =>
        repo.insertObservation({
          id,
          session_id: null,
          project: "Proj",
          type: "decision",
          title,
          narrative: `${title}.`,
          importance: 0.8,
          source: "digest",
          created_at: Date.now(),
        }).id;
      expect(withId(200_000_001, "Decyzja z laptopa")).toBe(200_000_001);
      expect((await N.runNotify(repo, cfgOf(), { channels: s.channels, force: true })).count).toBe(1);
      expect(withId(500, "Lokalna decyzja po synchronizacji")).toBe(500);
      const r = await N.runNotify(repo, cfgOf(), { channels: s.channels, force: true });
      expect(r.message?.items.map((i) => i.id)).toEqual([500]);
    });

    test("filtr projektów i zbiorcze powiadomienie z limitem pozycji", async () => {
      const repo = fresh();
      for (let i = 0; i < 7; i++) note(repo, { title: `decyzja ${i}`, importance: 0.6 + i * 0.05, project: "A" });
      note(repo, { title: "decyzja w innym projekcie", project: "B" });
      const s = sink();
      await N.runNotify(repo, cfgOf({ projects: ["a"], maxItems: 3 }), { channels: s.channels });
      const m = s.got[0];
      expect(m.count).toBe(7);
      expect(m.title).toBe("hipokamp: 7 nowych notatek");
      expect(m.text.split("\n")).toEqual([
        "• [decyzja] decyzja 6 (A)",
        "• [decyzja] decyzja 5 (A)",
        "• [decyzja] decyzja 4 (A)",
        "i 4 więcej",
      ]);
      expect(N.notesWord(1)).toBe("nowa notatka");
      expect(N.notesWord(22)).toBe("nowe notatki");
      expect(N.notesWord(12)).toBe("nowych notatek");
    });

    test("wyłączone powiadomienia nic nie robią (domyślnie wyłączone)", async () => {
      expect(DEFAULTS.notify.enabled).toBe(false);
      const repo = fresh();
      note(repo, { title: "decyzja" });
      const s = sink();
      const r = await N.runNotify(repo, { ...DEFAULTS.notify, channels: ["atrapa"] }, { channels: s.channels });
      expect(r.reason).toContain("wyłączone");
      expect(s.got.length).toBe(0);
      expect(getMeta(repo.db, "notify_seen")).toBeNull();
      expect(await N.kickNotifier(repo, loadConfig())).toBe(false);
    });
  });

  describe("wysyłka w procesie (worker, serwer MCP): zegar wstrzymanej wysyłki", () => {
    test("jeden zegar: późniejszy termin nic nie zmienia, wcześniejszy zastępuje, disarm kasuje", () => {
      const repo = fresh();
      const now = Date.now();
      try {
        expect(N.pendingNotifyRetry()).toBeNull();
        N.armNotifyRetry(repo, now + 60_000);
        N.armNotifyRetry(repo, now + 90_000);
        expect(N.pendingNotifyRetry()).toBe(now + 60_000);
        N.armNotifyRetry(repo, now + 30_000);
        expect(N.pendingNotifyRetry()).toBe(now + 30_000);
        N.armNotifyRetry(repo, now + 30_000);
        expect(N.pendingNotifyRetry()).toBe(now + 30_000);
      } finally {
        N.disarmNotifyRetry();
      }
      expect(N.pendingNotifyRetry()).toBeNull();
    });

    test("odpalenie czyta config.json: wyłączone nic nie wysyła, włączone wysyła tylko file i webhook", async () => {
      const { configPath, refreshConfig } = await import("../src/config.ts");
      const repo = fresh();
      const out = join(DATA_DIR, `zegar-${++seq}.jsonl`);
      const called: string[] = [];
      const deps = {
        channels: { command: async () => void called.push("command"), toast: async () => void called.push("toast") },
      };
      const write = (enabled: boolean) =>
        writeFileSync(
          configPath(),
          JSON.stringify({ notify: { enabled, channels: ["file", "toast", "command"], file: out, minIntervalSec: 0 } }),
        );
      try {
        note(repo, { title: "decyzja do zegara" });
        write(false);
        N.armNotifyRetry(repo, Date.now() + 100, deps);
        await Bun.sleep(400);
        expect(N.pendingNotifyRetry()).toBeNull();
        expect(existsSync(out)).toBe(false);
        write(true);
        N.armNotifyRetry(repo, Date.now() + 100, deps);
        await Bun.sleep(400);
        expect(JSON.parse(readFileSync(out, "utf8").trim()).items[0].title).toBe("decyzja do zegara");
        expect(called).toEqual([]);
        // Stop w trakcie wysyłki zamawia kolejny przebieg, nie drugi równoległy
        note(repo, { title: "druga decyzja do zegara" });
        const p1 = N.notifyInProcess(repo, deps);
        const p2 = N.notifyInProcess(repo, deps);
        expect(p2).toBe(p1);
        await p1;
        expect(readFileSync(out, "utf8").trim().split("\n").length).toBe(2);
      } finally {
        N.disarmNotifyRetry();
        rmSync(configPath(), { force: true });
        refreshConfig();
      }
    });

    test("baza zablokowana i blokada innego procesu: zegar ponawia, przy trwałej awarii kończy (T-38)", async () => {
      const { configPath, refreshConfig } = await import("../src/config.ts");
      const repo = fresh();
      const out = join(DATA_DIR, `zegar-${++seq}.jsonl`);
      writeFileSync(
        configPath(),
        JSON.stringify({ notify: { enabled: true, channels: ["file"], file: out, minIntervalSec: 0 } }),
      );
      const orig = repo.observationsCreatedSince.bind(repo);
      let fail = 0;
      let calls = 0;
      repo.observationsCreatedSince = ((...a: Parameters<typeof orig>) => {
        calls++;
        if (fail-- > 0) throw new Error("database is locked");
        return orig(...a);
      }) as typeof orig;
      const deps = { stuckRetryMs: 40 };
      const lines = () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").length : 0);
      try {
        // jeden błąd bazy: notatka nie ginie, wychodzi z zegara bez kolejnego Stop
        note(repo, { title: "decyzja przy zablokowanej bazie" });
        fail = 1;
        expect(await N.notifyInProcess(repo, deps)).toBeNull();
        expect(N.pendingNotifyRetry()).not.toBeNull();
        expect(lines()).toBe(0);
        await Bun.sleep(300);
        expect(lines()).toBe(1);
        expect(N.pendingNotifyRetry()).toBeNull();

        // blokadę trzyma inny żywy proces (proces wysyłki z hooka): zegar czeka, po zwolnieniu blokady wysyła
        note(repo, { title: "decyzja przy blokadzie innego procesu" });
        writeFileSync(lock(), JSON.stringify({ pid: process.ppid, at: Date.now() }));
        expect((await N.notifyInProcess(repo, deps))?.busy).toBe(true);
        expect(N.pendingNotifyRetry()).not.toBeNull();
        rmSync(lock(), { force: true });
        await Bun.sleep(300);
        expect(lines()).toBe(2);
        expect(N.pendingNotifyRetry()).toBeNull();

        // trwała awaria: 1 przebieg + 6 ponowień (5, 10, …, 160 ms), potem bez zegara (bez pętli)
        note(repo, { title: "decyzja przy trwałej awarii" });
        fail = 1000;
        calls = 0;
        await N.notifyInProcess(repo, { stuckRetryMs: 5 });
        const t0 = Date.now();
        while (N.pendingNotifyRetry() !== null && Date.now() - t0 < 5000) await Bun.sleep(20);
        await Bun.sleep(50);
        expect(N.pendingNotifyRetry()).toBeNull();
        expect(calls).toBe(7);
        expect(lines()).toBe(2);
      } finally {
        N.disarmNotifyRetry();
        rmSync(lock(), { force: true });
        rmSync(configPath(), { force: true });
        refreshConfig();
      }
    });
  });

  describe("limit częstości i blokada", () => {
    test("odstęp: przebieg odkłada (retryAt), pętla procesu śpi z zamkniętą bazą i wysyła zbiorczo", async () => {
      const repo = fresh();
      let now = Date.now();
      const clock = () => now;
      const s = sink();
      note(repo, { title: "pierwsza" });
      expect((await N.runNotify(repo, cfgOf(), { channels: s.channels, now: clock })).sent).toBe(true);
      note(repo, { title: "druga" });
      note(repo, { title: "trzecia" });
      now += 10_000;
      const r = await N.runNotify(repo, cfgOf(), { channels: s.channels, now: clock });
      expect(r.sent).toBe(false);
      expect(r.reason).toContain("limit częstości");
      expect(r.retryAt).toBe(now + 110_000);
      // krótki odstęp: hooki nadal mogą podnieść proces (on poczeka), notify_next_at nie blokuje
      expect(Number(getMeta(repo.db, "notify_next_at") ?? 0)).toBe(0);
      const slept: number[] = [];
      const opened: string[] = [];
      const r2 = await N.notifyLoop(
        async (fn) => {
          opened.push("otwarta");
          try {
            return await fn(repo);
          } finally {
            opened.push("zamknięta");
          }
        },
        cfgOf(),
        {
          channels: s.channels,
          now: clock,
          sleep: async (ms) => {
            // podczas czekania baza jest zamknięta (restore i kopie nie trafiają na zajęty plik)
            expect(opened.at(-1)).toBe("zamknięta");
            slept.push(ms);
            now += ms;
          },
        },
      );
      expect(slept).toEqual([110_000]);
      expect(r2.sent).toBe(true);
      expect(s.got.at(-1)?.count).toBe(2);
      expect(opened).toEqual(["otwarta", "zamknięta", "otwarta", "zamknięta"]);
      expect(existsSync(lock())).toBe(false);
    });

    test("limit na godzinę", async () => {
      const repo = fresh();
      let now = Date.now();
      const s = sink();
      const cfg = cfgOf({ minIntervalSec: 0, maxPerHour: 2 });
      for (let i = 0; i < 3; i++) {
        note(repo, { title: `decyzja ${i}` });
        now += 1000;
        const r = await N.runNotify(repo, cfg, { channels: s.channels, now: () => now });
        if (i < 2) expect(r.sent).toBe(true);
        else expect(r.reason).toContain("na godzinę");
      }
      // limit na godzinę: hooki nie podnoszą procesu aż do wolnego miejsca (żadnych pustych startów Buna)
      expect(Number(getMeta(repo.db, "notify_next_at"))).toBeGreaterThan(Date.now() + 30 * MIN);
      expect(await N.kickNotifier(repo, { ...loadConfig(), notify: cfg })).toBe(false);
      now += 61 * MIN;
      expect((await N.runNotify(repo, cfg, { channels: s.channels, now: () => now })).sent).toBe(true);
      expect(Number(getMeta(repo.db, "notify_next_at"))).toBe(0);
    });

    test("blokada żywego procesu zatrzymuje drugi; porzucona blokada nie", async () => {
      const repo = fresh();
      note(repo, { title: "decyzja" });
      const s = sink();
      writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: Date.now() }));
      expect(N.notifyLockHeld()).toBe(true);
      expect((await N.runNotify(repo, cfgOf(), { channels: s.channels })).reason).toContain("inny proces");
      expect(await N.kickNotifier(repo, { ...loadConfig(), notify: cfgOf() })).toBe(false);
      // proces, którego już nie ma
      writeFileSync(lock(), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
      expect(N.notifyLockHeld()).toBe(false);
      expect((await N.runNotify(repo, cfgOf(), { channels: s.channels })).sent).toBe(true);
      expect(existsSync(lock())).toBe(false);
    });
  });

  describe("kanały", () => {
    test("plik kolejki i nieznany kanał", async () => {
      const repo = fresh();
      note(repo, { title: "decyzja do pliku" });
      const file = join(DATA_DIR, `outbox-${++seq}.jsonl`);
      const r = await N.runNotify(repo, cfgOf({ channels: ["file", "nie-ma"], file }));
      expect(r.delivered).toEqual(["file"]);
      expect(r.failed).toEqual([{ channel: "nie-ma", error: "nieznany kanał" }]);
      const line = JSON.parse(readFileSync(file, "utf8").trim());
      expect(line.app).toBe("hipokamp");
      expect(line.items[0].title).toBe("decyzja do pliku");
    });

    test("sekret w tytule, projekcie i rodzaju notatki nie wychodzi plikiem, webhookiem ani poleceniem", async () => {
      const repo = fresh();
      // składany w czasie testu: skaner sekretów przy wysyłce nie widzi go w pliku
      const key = ["sk", "ant", "api03", "x".repeat(28)].join("-");
      const dir = join(DATA_DIR, `sekret-${++seq}`);
      mkdirSync(dir, { recursive: true });
      const save = join(dir, "save.ts");
      writeFileSync(save, "await Bun.write(process.argv[2], await Bun.stdin.text());\n");
      const stdin = join(dir, "stdin.json");
      const file = join(dir, "outbox.jsonl");
      const got: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          got.push(await req.text());
          return new Response("ok");
        },
      });
      const cfg = cfgOf({
        channels: ["file", "webhook", "command"],
        file,
        webhook: `http://127.0.0.1:${server.port}/hook`,
        command: [process.execPath, save, stdin],
      });
      const outputs = () => [readFileSync(file, "utf8"), readFileSync(stdin, "utf8"), ...got].join("\n");
      try {
        // tak zapisuje remember na main: headline(clean(tekst)) skleja klucz rozcięty znacznikiem kodu już po redakcji,
        // więc w bazie leży cały klucz (źródło agent jest w domyślnych notify.sources)
        note(repo, { title: `Klucz ${key} do testów`, source: "agent", project: `Proj-${key}` });
        const one = await N.runNotify(repo, cfg, { force: true });
        expect(one.delivered).toEqual(["file", "webhook", "command"]);
        expect(one.message?.count).toBe(1);
        // zbiorcze: lista pozycji i tekst z wierszami
        note(repo, { title: `Druga z ${key}`, source: "agent" });
        note(repo, { type: `decision ${key}`, title: "Trzecia", source: "agent" });
        const many = await N.runNotify(repo, { ...cfg, types: [...cfg.types, `decision ${key}`] }, { force: true });
        expect(many.delivered).toEqual(["file", "webhook", "command"]);
        expect(many.message?.count).toBe(2);
        const all = outputs();
        expect(all).not.toContain(key);
        expect(all).toContain("[REDACTED");
        expect(got.length).toBe(2);
      } finally {
        server.stop(true);
      }
    });

    test("wysyłka z workera (hook natywny): tylko kanały bez procesów; same toast i command czekają na proces hooka", async () => {
      const repo = fresh();
      note(repo, { title: "decyzja z workera" });
      const file = join(DATA_DIR, `outbox-${++seq}.jsonl`);
      const called: string[] = [];
      const fake = {
        toast: async () => void called.push("toast"),
        command: async () => void called.push("command"),
      };
      const r = await N.runNotify(repo, cfgOf({ channels: ["toast", "file", "command"], file }), {
        inProcess: true,
        channels: fake,
      });
      expect(r.delivered).toEqual(["file"]);
      expect(called).toEqual([]);
      expect(JSON.parse(readFileSync(file, "utf8").trim()).items[0].title).toBe("decyzja z workera");
      note(repo, { title: "druga decyzja" });
      const only = await N.runNotify(repo, cfgOf({ channels: ["toast", "command"] }), {
        inProcess: true,
        channels: fake,
        force: true,
      });
      expect(only.sent).toBe(false);
      expect(only.reason).toContain("bez procesów");
      expect(called).toEqual([]);
      // notatka nie została zajęta przez worker: proces hooka wysyła ją toastem
      const hook = await N.runNotify(repo, cfgOf({ channels: ["toast"] }), { channels: fake, force: true });
      expect(hook.delivered).toEqual(["toast"]);
      expect(hook.message?.items.map((i) => i.title)).toEqual(["druga decyzja"]);
    });

    test("doctor ostrzega, gdy toast albo command są ustawione przy hooku natywnym", async () => {
      const { notifyModeWarning } = await import("../src/install/doctor.ts");
      const cfg = (channels: string[], mode: string, enabled = true) =>
        ({ ...DEFAULTS, notify: { ...cfgOf({ channels }), enabled }, hooks: { mode } }) as any;
      expect(notifyModeWarning(cfg(["toast", "file"], "native"))).toContain("toast");
      expect(notifyModeWarning(cfg(["command"], "auto"))).toContain("command");
      expect(notifyModeWarning(cfg(["toast"], "command"))).toBeNull();
      expect(notifyModeWarning(cfg(["file", "webhook"], "native"))).toBeNull();
      expect(notifyModeWarning(cfg(["toast"], "native", false))).toBeNull();
      // tryb rozstrzygnięty (hooksModeFor): auto, które spadło do command, nie ostrzega; auto, które wybrało natywny, tak
      expect(notifyModeWarning(cfg(["toast"], "auto"), "command")).toBeNull();
      expect(notifyModeWarning(cfg(["toast"], "auto"), "native")).toContain("native");
      // tryb mcp: Stop obsługuje serwer MCP, też bez procesów
      expect(notifyModeWarning(cfg(["command"], "mcp"))).toContain("serwer MCP");
      // domyślne hooks.mode = auto bez rozstrzygnięcia: ostrzega (auto może wybrać natywny)
      expect(notifyModeWarning({ ...DEFAULTS, notify: cfgOf({ channels: ["toast"] }) } as any)).toContain("auto");
    });

    test("webhook tylko na 127.0.0.1 (localhost zamieniony), adres zdalny odrzucony bez połączenia", async () => {
      const got: any[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          got.push({ host: req.headers.get("host"), body: await req.json() });
          return new Response("ok");
        },
      });
      try {
        const ok = await N.testNotify(cfgOf({ channels: ["webhook"], webhook: `http://localhost:${server.port}/hook` }));
        expect(ok.delivered).toEqual(["webhook"]);
        expect(got[0].host).toBe(`127.0.0.1:${server.port}`);
        expect(got[0].body.title).toBe("hipokamp: próba powiadomienia");
        for (const url of ["http://example.com/hook", "http://127.0.0.1.nip.io/x", "http://10.0.0.5:8080/", "file:///c:/x"]) {
          const bad = await N.testNotify(cfgOf({ channels: ["webhook"], webhook: url }));
          expect(bad.delivered).toEqual([]);
          expect(bad.failed[0].channel).toBe("webhook");
        }
        expect(got.length).toBe(1);
      } finally {
        server.stop(true);
      }
    });

    test("webhook: odpowiedź 3xx to błąd (bez podążania za przekierowaniem), proxy z HTTP_PROXY pomijane", async () => {
      const hits: string[] = [];
      const target = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          hits.push(`cel ${new URL(req.url).pathname}`);
          return new Response("ok");
        },
      });
      const redirect = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          hits.push("przekierowanie");
          return new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${target.port}/po-przekierowaniu` },
          });
        },
      });
      const proxy = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          hits.push(`proxy ${req.url}`);
          return new Response("z proxy");
        },
      });
      const keys = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      try {
        const r = await N.testNotify(cfgOf({ channels: ["webhook"], webhook: `http://127.0.0.1:${redirect.port}/x` }));
        expect(r.delivered).toEqual([]);
        expect(r.failed[0].error).toContain("302");
        expect(hits).toEqual(["przekierowanie"]);
        // proxy w zmiennych środowiska (np. firmowe): żądanie na 127.0.0.1 i tak idzie prosto do celu
        for (const k of ["NO_PROXY", "no_proxy"]) delete process.env[k];
        process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
        process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
        const ok = await N.testNotify(cfgOf({ channels: ["webhook"], webhook: `http://127.0.0.1:${target.port}/hook` }));
        expect(ok.delivered).toEqual(["webhook"]);
        expect(hits).toEqual(["przekierowanie", "cel /hook"]);
        expect(process.env.NO_PROXY).toContain("127.0.0.1");
      } finally {
        for (const k of keys) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
        target.stop(true);
        redirect.stop(true);
        proxy.stop(true);
      }
    });

    test("polecenie: treść JSON na stdin bez powłoki, limit czasu, kod wyjścia", async () => {
      const dir = join(DATA_DIR, `cmd-${++seq}`);
      mkdirSync(dir, { recursive: true });
      const save = join(dir, "save.ts");
      writeFileSync(save, "await Bun.write(process.argv[2], await Bun.stdin.text());\n");
      const slow = join(dir, "slow.ts");
      writeFileSync(slow, "await Bun.sleep(15000);\n");
      const fail = join(dir, "fail.ts");
      writeFileSync(fail, "process.stderr.write('zły dzień'); process.exit(3);\n");
      const out = join(dir, "out.json");
      // argument ze znakami powłoki trafia do programu dosłownie (bez cmd.exe i bez sh)
      const weird = join(dir, "a & b; $(x).json");
      const ok = await N.testNotify(cfgOf({ channels: ["command"], command: [process.execPath, save, out] }));
      expect(ok.delivered).toEqual(["command"]);
      expect(JSON.parse(readFileSync(out, "utf8")).title).toBe("hipokamp: próba powiadomienia");
      expect((await N.testNotify(cfgOf({ channels: ["command"], command: [process.execPath, save, weird] }))).delivered).toEqual([
        "command",
      ]);
      expect(existsSync(weird)).toBe(true);
      const t0 = performance.now();
      const to = await N.testNotify(cfgOf({ channels: ["command"], command: [process.execPath, slow], commandTimeoutSec: 1 }));
      expect(to.failed[0].error).toContain("limit czasu");
      expect(performance.now() - t0).toBeLessThan(8000);
      const bad = await N.testNotify(cfgOf({ channels: ["command"], command: [process.execPath, fail] }));
      expect(bad.failed[0].error).toContain("kod wyjścia 3");
      expect(bad.failed[0].error).toContain("zły dzień");
      expect((await N.testNotify(cfgOf({ channels: ["command"], command: [] }))).failed[0].error).toContain("notify.command");
      // .cmd/.bat Windows uruchamia przez cmd.exe (powłoka): odmowa przed uruchomieniem
      const bat = join(dir, "x.cmd");
      writeFileSync(bat, `echo zle> "${join(dir, "bat.txt")}"\r\n`);
      const nb = await N.testNotify(cfgOf({ channels: ["command"], command: [bat] }));
      expect(nb.failed[0].error).toContain("cmd.exe");
      expect(existsSync(join(dir, "bat.txt"))).toBe(false);
    });

    // Windows dopisuje rozszerzenie z PATHEXT: samo „x” w PATH to x.cmd, czyli znowu cmd.exe
    test.skipIf(process.platform !== "win32")(
      "polecenie: nazwa bez rozszerzenia rozwiązana do .cmd przez PATHEXT jest odrzucana",
      async () => {
        const dir = join(DATA_DIR, `pathext-${++seq}`);
        mkdirSync(dir, { recursive: true });
        const mark = join(dir, "pathext.txt");
        writeFileSync(join(dir, "hipokamp-x.cmd"), `echo zle> "${mark}"\r\n`);
        const saved = process.env.PATH;
        process.env.PATH = `${dir};${saved ?? ""}`;
        try {
          const r = await N.testNotify(cfgOf({ channels: ["command"], command: ["hipokamp-x"] }));
          expect(r.delivered).toEqual([]);
          expect(r.failed[0].error).toContain("cmd.exe");
          expect(existsSync(mark)).toBe(false);
        } finally {
          process.env.PATH = saved;
        }
      },
    );

    test("toast: treść tylko na stdin (base64 UTF-8), skrypt bez treści, limity dymka", () => {
      const title = `hipokamp: decyzja · ${"x".repeat(80)}`;
      const inv = toastInvocation({ app: "hipokamp", at: 0, title, text: "$(Remove-Item C:\\) ; zażółć", count: 1, items: [] });
      expect(inv.cmd[0]).toBe("powershell.exe");
      expect(inv.cmd).toContain("-NonInteractive");
      const script = Buffer.from(inv.cmd.at(-1)!, "base64").toString("utf16le");
      expect(script).toContain("FromBase64String");
      expect(script).toContain("NotifyIcon");
      expect(script).not.toContain("Remove-Item");
      expect(inv.cmd.join(" ")).not.toContain("zażółć");
      const data = JSON.parse(Buffer.from(inv.stdin, "base64").toString("utf8"));
      expect(data.text).toBe("$(Remove-Item C:\\) ; zażółć");
      expect(data.title.length).toBeLessThanOrEqual(63);
    });
  });

  describe("hook Stop", () => {
    const ROOT = join(import.meta.dir, "..");
    /** Hook Stop dla sesji; z tytułem dopisuje najpierw jedną pełną turę do transkryptu. */
    async function stopHook(sessionId: string, title?: string) {
      const cwd = join(DATA_DIR, "proj-hook");
      mkdirSync(cwd, { recursive: true });
      const tr = join(DATA_DIR, "tr", `${sessionId}.jsonl`);
      mkdirSync(join(DATA_DIR, "tr"), { recursive: true });
      const c = { sessionId, cwd };
      if (title)
        writeFileSync(
          tr,
          J.jsonl(J.fullTurn(c, Date.now() - 5000, 1, `zrób ${title}`, `${title}: gotowe i sprawdzone testami.`)),
        );
      const t0 = performance.now();
      const p = Bun.spawn([process.execPath, join(ROOT, "src", "hooks", "hook.ts"), "stop"], {
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: cwd },
        stdin: Buffer.from(JSON.stringify({ session_id: sessionId, transcript_path: tr, cwd })),
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await p.exited).toBe(0);
      return performance.now() - t0;
    }
    const waitFor = async (pred: () => boolean, ms: number) => {
      for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(100)) if (pred()) return true;
      return pred();
    };

    test("wyłączone: hook nie uruchamia wysyłki; włączone: odłączony proces dopisuje powiadomienie do kolejki", async () => {
      const outbox = join(DATA_DIR, "outbox-hook.jsonl");
      const cfgFile = join(DATA_DIR, "config.json");
      const base = { embed: { enabled: false }, backup: { enabled: false } };
      writeFileSync(cfgFile, JSON.stringify(base));
      await stopHook("sess-off", "Pierwsza praca");
      await Bun.sleep(1500);
      expect(existsSync(outbox)).toBe(false);

      // drugi kanał to wolne polecenie (6 s): hook nie czeka na wysyłkę, tylko podnosi odłączony proces
      const slow = join(DATA_DIR, "slow-cmd.ts");
      writeFileSync(slow, "await Bun.stdin.text(); await Bun.sleep(6000);\n");
      writeFileSync(
        cfgFile,
        JSON.stringify({
          ...base,
          notify: {
            enabled: true,
            channels: ["file", "command"],
            command: [process.execPath, slow],
            file: outbox,
            types: ["bugfix", "feature", "refactor", "change", "discovery", "decision", "gotcha", "preference"],
            minImportance: 0,
            minIntervalSec: 0,
          },
        }),
      );
      const ms = await stopHook("sess-on", "Druga praca");
      expect(ms).toBeLessThan(4000);
      expect(await waitFor(() => existsSync(outbox), 15_000)).toBe(true);
      const msgs = readFileSync(outbox, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(msgs.length).toBe(1);
      expect(JSON.stringify(msgs[0])).toContain("Druga praca");
      // proces wysyłki skończył (po wolnym poleceniu) i zwolnił blokadę
      expect(await waitFor(() => !existsSync(lock()), 15_000)).toBe(true);
      // ta sama sesja bez nowych tur: nic do wysłania, nic nie startuje
      await stopHook("sess-on");
      await Bun.sleep(1500);
      expect(readFileSync(outbox, "utf8").trim().split("\n").length).toBe(1);
    }, 60_000);
  });
}
