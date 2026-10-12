// Opcjonalna konsolidacja lokalnym LLM: domyślnie wyłączona, adres tylko w pętli zwrotnej, kontrakt API Ollamy
// (`/api/chat`, `/api/tags`) na atrapie serwera na porcie 0, sprzeczności i lekcje jako dodatkowe pola (treść notatek
// bez zmian), limity wywołań i czasu, przerwanie, błąd połączenia, termin w workerze i przerwanie aktywnością.
// Prawdziwego modelu tu nie ma: przebieg na Ollamie sprawdza się ręcznie (`hipokamp llm check`, `hipokamp llm run`).
// Osobny proces z katalogiem „hipokamp-test” jak w projects.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_LLM_CHILD";

if (!process.env[CHILD]) {
  test("konsolidacja lokalnym LLM (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/llm.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47988",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `llm: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy konsolidacji LLM nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, DEFAULTS, ensureDataDirs, llmConfig, loadConfig, configPath } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test")) throw new Error("llm: HIPOKAMP_HOME musi wskazywać katalog testowy");
  ensureDataDirs();
  const { openDb, getMeta, setMeta } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const { llmConsolidate, conflictCandidates, conflictCandidatesAsync } = await import("../src/llm/consolidate.ts");
  const { isCloudModel, ollamaChat, ollamaModels, parseJsonObject } = await import("../src/llm/ollama.ts");
  const { loopbackUrl, isLoopbackUrl } = await import("../src/util/net.ts");
  const { llmStageDue, sleepLlm } = await import("../src/consolidate/sleep.ts");
  const { obsMarkdown } = await import("../src/mcp/format.ts");
  type RepoT = InstanceType<typeof Repo>;

  let seq = 0;
  const fresh = (path = join(DATA_DIR, `${++seq}-l.db`)): RepoT => new Repo(openDb({ path, vectors: false }));

  /** Atrapa Ollamy: `/api/tags` i `/api/chat` (stream false), odpowiedź z funkcji testu, opcjonalne opóźnienie. */
  function fakeOllama(answer: (prompt: string, body: any) => string, delayMs = 0) {
    const reqs: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/api/tags") return Response.json({ models: [{ name: "test-model:1b" }, { name: "qwen2.5:14b" }] });
        if (p !== "/api/chat") return new Response("brak", { status: 404 });
        const body = await req.json();
        reqs.push(body);
        if (delayMs) await Bun.sleep(delayMs);
        const prompt = String(body.messages?.at(-1)?.content ?? "");
        return Response.json({
          model: body.model,
          message: { role: "assistant", content: answer(prompt, body) },
          done: true,
          prompt_eval_count: 120,
          eval_count: 12,
        });
      },
    });
    return { server, reqs, url: `http://127.0.0.1:${server.port}` };
  }

  const cfgOf = (url: string, over: Partial<NonNullable<typeof DEFAULTS.consolidation.llm>> = {}) => ({
    ...DEFAULTS.consolidation.llm!,
    enabled: true,
    model: "test-model:1b",
    baseUrl: url,
    ...over,
  });

  /** Dwie sprzeczne decyzje (wspólne słownictwo), decyzja niezwiązana, podobna w innym projekcie, ważna pułapka. */
  function seed(repo: RepoT) {
    const ins = (project: string, type: string, title: string, narrative: string, importance = 0.7) =>
      repo.insertObservation({
        session_id: null,
        project,
        type,
        title,
        narrative,
        importance,
        created_at: Date.UTC(2026, 9, 1) + ++seq * 1000,
        source: "agent",
      }).id;
    return {
      a: ins(
        "P",
        "decision",
        "Sekrety aplikacji trzymamy w lokalnym sejfie",
        "Sekrety aplikacji zapisujemy w lokalnym sejfie, nie w plikach env repozytorium.",
      ),
      b: ins(
        "P",
        "decision",
        "Sekrety aplikacji trzymamy w plikach env",
        "Sekrety aplikacji zapisujemy w plikach env repozytorium, lokalny sejf zbędny.",
      ),
      c: ins("P", "decision", "Przyciski w kolorze złotym", "Interfejs używa złotego koloru akcentu na przyciskach."),
      d: ins(
        "Q",
        "decision",
        "Sekrety aplikacji trzymamy w lokalnym sejfie",
        "Sekrety aplikacji zapisujemy w lokalnym sejfie projektu Q.",
      ),
      g: ins("P", "gotcha", "Heredoc w Git Bash psuje znaki nowej linii", "Pliki z escape'ami pisz narzędziem Write.", 0.95),
    };
  }

  const answers = (conflict: [number, number]) => (prompt: string) => {
    if (prompt.includes("Czy A i B są ze sobą sprzeczne")) {
      const both = prompt.includes(`#${conflict[0]},`) && prompt.includes(`#${conflict[1]},`);
      return both
        ? 'Oto ocena:\n```json\n{"sprzeczne": true, "powod": "A każe trzymać sekrety w sejfie, B w plikach env."}\n```'
        : '{"sprzeczne": false, "powod": "różne tematy"}';
    }
    if (prompt.includes("Napisz jedną lekcję")) return '{"lekcja": "Sprawdź sposób zapisu przed zmianą plików."}';
    return "{}";
  };

  describe("adresy i klient Ollamy", () => {
    test("tylko pętla zwrotna: 127.0.0.0/8, ::1, localhost zamieniony na 127.0.0.1", () => {
      expect(loopbackUrl("http://localhost:11434").hostname).toBe("127.0.0.1");
      for (const ok of ["http://127.0.0.1:11434", "http://127.4.5.6:1/", "http://[::1]:11434", "https://127.0.0.1/x"])
        expect(isLoopbackUrl(ok)).toBe(true);
      for (const bad of [
        "http://10.0.0.2:11434",
        "http://192.168.1.10:11434",
        "http://ollama.example.com",
        "http://127.0.0.1.nip.io",
        `http://${["user", "pass"].join(":")}@127.0.0.1:11434`, // dane logowania w adresie (składane, żeby skaner sekretów nie zgłaszał fikstury)
        "ftp://127.0.0.1",
        "nie-adres",
      ])
        expect(isLoopbackUrl(bad)).toBe(false);
      expect(() => ollamaChat(cfgOf("http://10.1.2.3:11434"))).toThrow();
    });

    test("kontrakt /api/chat i /api/tags, JSON z otoczki tekstowej", async () => {
      const f = fakeOllama(() => '{"ok": 1}');
      try {
        const chat = ollamaChat(cfgOf(f.url));
        const r = await chat([{ role: "user", content: "hej" }], { json: true });
        expect(r.content).toBe('{"ok": 1}');
        expect(r.promptTokens).toBe(120);
        const b = f.reqs[0];
        expect([b.model, b.stream, b.format, b.keep_alive]).toEqual(["test-model:1b", false, "json", "2m"]);
        expect(b.options).toEqual({ temperature: 0, num_ctx: 4096, num_predict: 200 });
        expect(await ollamaModels(cfgOf(f.url))).toEqual(["test-model:1b", "qwen2.5:14b"]);
      } finally {
        f.server.stop(true);
      }
      expect(await ollamaModels(cfgOf(f.url), 500)).toBeNull();
      expect(parseJsonObject('tekst {"a": {"b": 1}} i dalej }')).toEqual({ a: { b: 1 } });
      expect(parseJsonObject("brak")).toBeNull();
    });

    test("modele chmurowe Ollamy odrzucone przed połączeniem; 3xx to błąd; proxy z HTTP_PROXY pomijane", async () => {
      const f = fakeOllama(() => '{"ok": 1}');
      const hits: string[] = [];
      const redirect = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          hits.push("przekierowanie");
          return new Response(null, { status: 307, headers: { location: `${f.url}/api/chat` } });
        },
      });
      const proxy = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          hits.push(`proxy ${req.url}`);
          return Response.json({ message: { content: "z proxy" } });
        },
      });
      const keys = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      try {
        for (const m of ["gpt-oss:120b-cloud", "glm-4.6:cloud", "deepseek-v3.1:671b-cloud"]) {
          expect(isCloudModel(m)).toBe(true);
          expect(() => ollamaChat(cfgOf(f.url, { model: m }))).toThrow("chmurowy");
        }
        for (const m of ["qwen2.5:14b", "cloudy:7b", "SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M"])
          expect(isCloudModel(m)).toBe(false);
        const repo = fresh();
        seed(repo);
        const cloud = await llmConsolidate(repo, cfgOf(f.url, { model: "gpt-oss:120b-cloud" }));
        expect(cloud.stopped).toContain("chmurowy");
        expect(f.reqs.length).toBe(0);

        // przekierowanie nie jest wykonywane: błąd z kodem, drugi serwer nietknięty
        await expect(ollamaChat(cfgOf(`http://127.0.0.1:${redirect.port}`))([{ role: "user", content: "x" }])).rejects.toThrow(
          "307",
        );
        expect(f.reqs.length).toBe(0);

        // proxy w zmiennych środowiska: żądanie na 127.0.0.1 i tak idzie prosto do Ollamy
        for (const k of ["NO_PROXY", "no_proxy"]) delete process.env[k];
        process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
        process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
        const r = await ollamaChat(cfgOf(f.url))([{ role: "user", content: "x" }]);
        expect(r.content).toBe('{"ok": 1}');
        expect(await ollamaModels(cfgOf(f.url))).toEqual(["test-model:1b", "qwen2.5:14b"]);
        expect(hits).toEqual(["przekierowanie"]);
      } finally {
        for (const k of keys) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
        f.server.stop(true);
        redirect.stop(true);
        proxy.stop(true);
      }
    });
  });

  describe("przebieg", () => {
    test("sprzeczności i lekcje jako dodatkowe pola; treść, status i ważność bez zmian; drugi przebieg nic nie powtarza", async () => {
      const repo = fresh();
      const ids = seed(repo);
      const pairs = conflictCandidates(repo, new Set()).map((p) => [p.a.id, p.b.id]);
      expect(pairs).toContainEqual([ids.a, ids.b]);
      expect(pairs.some(([x, y]) => [x, y].includes(ids.c))).toBe(false);
      expect(pairs.some(([x, y]) => [x, y].includes(ids.d))).toBe(false);
      // wersja dla workera (porcjami, z oddawaniem pętli) daje te same pary
      expect((await conflictCandidatesAsync(repo, new Set())).map((p) => [p.a.id, p.b.id])).toEqual(pairs);
      const before = repo
        .getObservations([ids.a, ids.b, ids.g])
        .map((o) => [o.title, o.narrative, o.status, o.importance, o.type]);

      const f = fakeOllama(answers([ids.a, ids.b]));
      try {
        const rep = await llmConsolidate(repo, cfgOf(f.url));
        expect(rep.stopped).toBeUndefined();
        expect(rep.conflicts).toEqual([
          { a: ids.a, b: ids.b, project: "P", reason: "A każe trzymać sekrety w sejfie, B w plikach env." },
        ]);
        expect(rep.lessons[0]).toEqual({ id: ids.g, text: "Sprawdź sposób zapisu przed zmianą plików." });
        const [a, b, g] = repo.getObservations([ids.a, ids.b, ids.g]);
        expect((a.meta as any).llm.conflicts[0]).toMatchObject({ with: ids.b, newer: ids.b, model: "test-model:1b" });
        // powód tylko przy nowszej notatce, przy starszej sam odsyłacz
        expect((a.meta as any).llm.conflicts[0].reason).toBeUndefined();
        expect((b.meta as any).llm.conflicts[0]).toMatchObject({
          with: ids.a,
          reason: "A każe trzymać sekrety w sejfie, B w plikach env.",
        });
        expect((g.meta as any).llm.lesson.text).toBe("Sprawdź sposób zapisu przed zmianą plików.");
        expect([a, b, g].map((o) => [o.title, o.narrative, o.status, o.importance, o.type])).toEqual(before);
        expect(Number(getMeta(repo.db, "last_llm_at"))).toBeGreaterThan(0);

        // widoczne w get_observations jako dopisek
        expect(obsMarkdown(b)).toContain(`⚠ Możliwa sprzeczność z #${ids.a} (lokalny LLM): A każe`);
        const md = obsMarkdown(a);
        expect(md).toContain(`⚠ Możliwa sprzeczność z #${ids.b} (lokalny LLM; powód przy #${ids.b})`);
        expect(md).not.toContain("A każe");
        expect(obsMarkdown(g)).toContain("Lekcja (lokalny LLM, test-model:1b): Sprawdź sposób");
        expect(obsMarkdown(repo.getObservation(ids.c)!)).not.toContain("Możliwa sprzeczność");
        const plain = repo.insertObservation({
          session_id: null,
          project: "P",
          type: "feature",
          title: "Nowy widok",
          created_at: 1,
          source: "agent",
        });
        expect(obsMarkdown(repo.getObservation(plain.id)!)).not.toContain("lokalny LLM");

        const calls = f.reqs.length;
        const again = await llmConsolidate(repo, cfgOf(f.url));
        expect([again.calls, again.pairsChecked, again.conflicts.length, again.lessons.length]).toEqual([0, 0, 0, 0]);
        expect(f.reqs.length).toBe(calls);
        expect((repo.getObservation(ids.a)!.meta as any).llm.conflicts.length).toBe(1);
      } finally {
        f.server.stop(true);
      }
    });

    test("powód sprzeczności i lekcja od modelu przechodzą przez clean(): sekret i <private> nie trafiają do bazy", async () => {
      const repo = fresh();
      const ids = seed(repo);
      // składany w czasie testu: skaner sekretów przy wysyłce nie widzi go w pliku
      const key = ["sk", "ant", "api03", "x".repeat(28)].join("-");
      const f = fakeOllama((prompt) => {
        if (prompt.includes("Czy A i B są ze sobą sprzeczne")) {
          const both = prompt.includes(`#${ids.a},`) && prompt.includes(`#${ids.b},`);
          return both
            ? JSON.stringify({ sprzeczne: true, powod: `A używa ${key}, B nie <private>tajne dane</private>` })
            : '{"sprzeczne": false, "powod": "różne tematy"}';
        }
        if (prompt.includes("Napisz jedną lekcję"))
          return JSON.stringify({ lekcja: `Wpisz ${key} <private>tajne dane</private>` });
        return "{}";
      });
      try {
        const rep = await llmConsolidate(repo, cfgOf(f.url));
        expect(rep.conflicts.length).toBe(1);
        expect(rep.lessons.length).toBeGreaterThan(0);
        const reason = JSON.stringify(repo.getObservation(ids.b)!.meta);
        const lesson = JSON.stringify(repo.getObservation(rep.lessons[0].id)!.meta);
        for (const t of [reason, lesson]) {
          expect(t).not.toContain(key);
          expect(t).not.toContain("tajne dane");
          expect(t).toContain("[REDACTED");
        }
        const dump = JSON.stringify([rep, repo.db.query("SELECT meta FROM observations").all()]);
        expect(dump).not.toContain(key);
        expect(dump).not.toContain("tajne dane");
      } finally {
        f.server.stop(true);
      }
    });

    test("limity: wywołania, czas; przerwanie nie zalicza przebiegu; błąd połączenia i adres zdalny kończą bez ponawiania", async () => {
      const f = fakeOllama(answers([0, 0]));
      try {
        const r1 = fresh();
        seed(r1);
        const one = await llmConsolidate(r1, cfgOf(f.url), { maxCalls: 1 });
        expect([one.calls, one.stopped]).toEqual([1, "limit wywołań"]);

        const r2 = fresh();
        seed(r2);
        let now = Date.now();
        const slow = await llmConsolidate(r2, cfgOf(f.url, { maxRunSec: 150 }), {
          now: () => now,
          chat: async () => {
            now += 100_000;
            return { content: '{"sprzeczne": false}', promptTokens: 0, outputTokens: 0, ms: 0 };
          },
        });
        expect([slow.calls, slow.stopped]).toEqual([2, "limit czasu"]);

        const r3 = fresh();
        seed(r3);
        const ctrl = new AbortController();
        const ab = await llmConsolidate(r3, cfgOf(f.url), {
          signal: ctrl.signal,
          chat: async () => {
            ctrl.abort();
            return { content: '{"sprzeczne": false}', promptTokens: 0, outputTokens: 0, ms: 0 };
          },
        });
        expect([ab.calls, ab.stopped]).toEqual([1, "przerwane (aktywność)"]);
        expect(getMeta(r3.db, "last_llm_at")).toBeNull();

        // przerwanie w trakcie liczenia par (lista pusta), lekcje wyłączone: przebieg też niezaliczony
        const r5 = fresh();
        seed(r5);
        const early = new AbortController();
        early.abort();
        const none = await llmConsolidate(r5, cfgOf(f.url, { lessons: false }), {
          signal: early.signal,
          chat: async () => ({ content: "{}", promptTokens: 0, outputTokens: 0, ms: 0 }),
        });
        expect([none.calls, none.stopped]).toEqual([0, "przerwane (aktywność)"]);
        expect(getMeta(r5.db, "last_llm_at")).toBeNull();
        // to samo przy włączonych lekcjach bez kandydatów (pusta baza)
        const r6 = fresh();
        const empty = await llmConsolidate(r6, cfgOf(f.url), { signal: early.signal });
        expect(empty.stopped).toBe("przerwane (aktywność)");
        expect(getMeta(r6.db, "last_llm_at")).toBeNull();
      } finally {
        f.server.stop(true);
      }
      // port po zatrzymanej atrapie: nikt nie słucha
      const r4 = fresh();
      seed(r4);
      const down = await llmConsolidate(r4, cfgOf(f.url, { callTimeoutSec: 3 }));
      expect(down.calls).toBe(1);
      expect(down.stopped).toContain("Ollama nie odpowiada");
      expect(Number(getMeta(r4.db, "last_llm_at"))).toBeGreaterThan(0);

      const remote = await llmConsolidate(r4, cfgOf("http://192.168.1.50:11434"));
      expect(remote.calls).toBe(0);
      expect(remote.stopped).toContain("spoza 127.0.0.1");
      expect((await llmConsolidate(r4, cfgOf(f.url, { model: " " }))).stopped).toContain("brak modelu");
    });
  });

  describe("konfiguracja i worker", () => {
    test("domyślnie wyłączone: brak etapu w śnie i w workerze; `llm: null` ze starszego configu też wyłącza", async () => {
      expect(DEFAULTS.consolidation.llm?.enabled).toBe(false);
      expect(llmConfig(DEFAULTS)).toBeNull();
      expect(llmConfig({ ...DEFAULTS, consolidation: { ...DEFAULTS.consolidation, llm: null } })).toBeNull();
      const repo = fresh();
      expect(await sleepLlm(repo)).toBeNull();
      expect(llmStageDue(repo.db, 1000)).toBe(false);
    });

    test("włączone: termin po bezczynności i odstępie", () => {
      writeFileSync(
        configPath(),
        JSON.stringify({ consolidation: { llm: { enabled: true, model: "m", minIdleMin: 15, everyHours: 24 } } }),
      );
      try {
        loadConfig(true);
        const repo = fresh();
        expect(llmStageDue(repo.db, 5)).toBe(false);
        expect(llmStageDue(repo.db, 16)).toBe(true);
        setMeta(repo.db, "last_llm_at", String(Date.now() - 3_600_000));
        expect(llmStageDue(repo.db, 16)).toBe(false);
        setMeta(repo.db, "last_llm_at", String(Date.now() - 25 * 3_600_000));
        expect(llmStageDue(repo.db, 16)).toBe(true);
      } finally {
        writeFileSync(configPath(), "{}");
        loadConfig(true);
      }
    });

    test("worker uruchamia przebieg w bezczynności i przerywa go pierwszym żądaniem", async () => {
      const ROOT = join(import.meta.dir, "..");
      const repo = fresh(join(DATA_DIR, "hipokamp.db"));
      const ids = seed(repo);
      repo.db.close();
      // atrapa odpowiada wolno: worker zdąży dostać żądanie, które przerwie przebieg
      const f = fakeOllama(answers([ids.a, ids.b]), 4000);
      writeFileSync(
        configPath(),
        JSON.stringify({
          embed: { enabled: false },
          backup: { enabled: false },
          consolidation: { llm: { enabled: true, model: "test-model:1b", baseUrl: f.url, minIdleMin: 0.02 } },
        }),
      );
      const port = Number(process.env.HIPOKAMP_PORT);
      const worker = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
        cwd: ROOT,
        env: process.env as Record<string, string>,
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
          try {
            // podgląd statyczny: /api/* bez ciasteczka i bez klucza to 401 (T-34)
            up = (await fetch(`http://127.0.0.1:${port}/`)).ok;
          } catch {}
          if (!up) await Bun.sleep(100);
        }
        expect(up).toBe(true);
        // pierwszy tick po 5 s, bezczynność ponad 1,2 s: przebieg startuje i pyta atrapę
        for (let i = 0; i < 200 && !f.reqs.length; i++) await Bun.sleep(100);
        expect(f.reqs.length).toBeGreaterThan(0);
        expect(f.reqs[0].model).toBe("test-model:1b");
        await fetch(`http://127.0.0.1:${port}/api/health`); // aktywność liczy się także przy 401
        const db = openDb({ readonly: true });
        let stopped = "";
        for (let i = 0; i < 40 && !stopped; i++) {
          try {
            stopped = JSON.parse(getMeta(db, "last_llm_report") ?? "{}").stopped ?? "";
          } catch {}
          if (!stopped) await Bun.sleep(100);
        }
        db.close();
        expect(stopped).toBe("przerwane (aktywność)");
      } finally {
        worker.kill();
        await worker.exited;
        f.server.stop(true);
        writeFileSync(configPath(), "{}");
      }
    }, 60_000);
  });
}
