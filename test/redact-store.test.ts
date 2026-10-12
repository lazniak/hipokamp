// T-38: luki redakcji na drodze do bazy. Sekret rozcięty znacznikiem (blok <private>, znaczniki Markdown) maskuje już
// clean() (widok sklejony); rozcięty emoji albo linkiem skleja się dopiero w polach liczonych po stripMarkdown
// (narracja, fakty, podtytuł, tytuł z `remember`, następne kroki), a z nich bierze się FTS. Sprawdzamy też prośbę
// w narracji, pojęcia i klucze encji. `hipokamp repair` redaguje też napisy w observations.meta.
// Osobny proces z katalogiem „hipokamp-test” jak w projects.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = "HIPOKAMP_REDACT_STORE_CHILD";
// klucz w całości i ten sam klucz rozcięty znacznikiem kodu (każdy kawałek osobno nie jest kluczem); szukamy reszty
// klucza (BODY), bo kawałek po znaczniku też jest wyciekiem
const BODY = "api03-AbCdEfGhIjKlMnOpQrStUvWx";
const KEY = `sk-ant-${BODY}`;
const SPLIT = `\`sk-ant-\`${BODY}`;
// emoji między kawałkami: clean() go nie zdejmuje, robi to dopiero stripMarkdown (fakty, narracja, tytuł)
const EMOJI = `sk-ant-\u{1F511}${BODY}`;

if (!process.env[CHILD]) {
  test("redakcja na drodze do bazy (osobny proces, katalog testowy)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    mkdirSync(join(claude, "projects"), { recursive: true });
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/redact-store.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...(process.env as Record<string, string>),
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47986",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      if (r.exitCode !== 0) throw new Error(`testy redakcji na drodze do bazy nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
} else {
  const { DATA_DIR } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test")) throw new Error("redact-store: HIPOKAMP_HOME musi wskazywać katalog testowy");
  const { openDb } = await import("../src/db/db.ts");
  const { Repo, ftsRow } = await import("../src/db/repo.ts");
  const { clean } = await import("../src/capture/redact.ts");
  const { digestTurn } = await import("../src/capture/digest.ts");
  const { remember } = await import("../src/core/remember.ts");
  const { repair } = await import("../src/core/repair.ts");
  type Turn = import("../src/capture/transcript.ts").Turn;

  let seq = 0;
  const fresh = () => new Repo(openDb({ path: join(DATA_DIR, `${++seq}-r.db`), vectors: false }));
  // reszta klucza po znaczniku (BODY) w ogóle, a dla rozcięcia, którego clean() nie widzi (emoji), klucz sklejony
  const noKey = (label: string, v: unknown) => expect([label, JSON.stringify(v).includes(BODY)]).toEqual([label, false]);
  const noJoined = (label: string, v: unknown) => expect([label, JSON.stringify(v).includes(KEY)]).toEqual([label, false]);
  const entityKeys = (repo: InstanceType<typeof Repo>) =>
    (repo.db.query("SELECT key FROM entities").all() as { key: string }[]).map((r) => r.key);
  const turnOf = (prompt: string, text: string): Turn => ({
    key: "u1",
    sessionId: "s1",
    kind: "human",
    prompt,
    hasImage: false,
    startedAt: 1,
    endedAt: 2,
    cwd: null,
    gitBranch: null,
    model: null,
    texts: [text],
    tools: [],
    interrupted: false,
    from: 0,
    to: 0,
  });
  const opt = { project: "x", n: 1, privateTools: [], maxNarrativeChars: 1200 };

  describe("sekret rozcięty znacznikiem", () => {
    test("<private> w środku klucza: clean() nie zostawia kawałków", () => {
      const out = clean(`klucz sk-ant-api03-AbCd<private>x</private>EfGhIjKlMnOpQrStUvWx koniec`);
      expect(out).toBe("klucz [REDACTED:anthropic-key] koniec");
      // bez sekretu blok <private> dalej jest tylko [prywatne]
      expect(clean("a <private>tajne</private> b")).toBe("a [prywatne] b");
    });

    test("clean() skleja `, **, __ i ~~; emoji skleja dopiero stripMarkdown", () => {
      for (const s of [SPLIT, `**sk-ant-**${BODY}`, `__sk-ant-__${BODY}`, `~~sk-ant-~~${BODY}`]) noKey(s, clean(s));
      // emoji to nie znacznik i clean() go nie zdejmuje: dlatego pola po stripMarkdown dostają clean() jeszcze raz
      expect(clean(EMOJI)).toContain(BODY);
    });

    test("notatka z tury: prośba w narracji, fakty, podtytuł, pojęcia, encje i FTS bez reszty klucza", () => {
      const turn = turnOf(
        `Klucz ${SPLIT} do konfiguracji serwera ustaw w pliku env i uruchom deploy.\n\nDrugi klucz **sk-ant-**${BODY} też.`,
        `Ustawiłem klucz w konfiguracji serwera i sprawdziłem połączenie z API.\n\n- klucz **sk-ant-**${BODY} działa\n- klucz ${SPLIT} zapisany w env\n- klucz __sk-ant-__${BODY} w zapasie\n\nWszystko gotowe, klucz ${SPLIT} jest aktywny od teraz i deploy przeszedł.`,
      );
      const d = digestTurn(turn, opt);
      expect(d.skip).toBe(false);
      const { title, subtitle, narrative, facts, concepts } = d.obs;
      noKey("prompt", d.prompt);
      noKey("tytuł", title);
      noKey("podtytuł", subtitle);
      noKey("narracja", narrative);
      noKey("fakty", facts);
      noKey("pojęcia", concepts);
      noKey("encje", d.entities);
      noKey("FTS", ftsRow(d.obs));
      expect(narrative).toStartWith("Prośba: Klucz `[REDACTED:anthropic-key] do konfiguracji");
      const repo = fresh();
      const { id } = repo.insertObservation(d.obs, d.entities);
      noKey("notatka w bazie", repo.getObservation(id));
      noKey("encje w bazie", entityKeys(repo));
    });

    test("notatka z tury: klucz rozcięty emoji nie skleja się w polach po stripMarkdown", () => {
      const turn = turnOf(
        `Sprawdź klucz ${EMOJI} w konfiguracji serwera i uruchom deploy.`,
        `Sprawdziłem konfigurację serwera i połączenie z API.\n\n- klucz ${EMOJI} działa\n- deploy przeszedł bez błędów\n\nKlucz ${EMOJI} jest aktywny od teraz, a połączenie z API działa poprawnie.`,
      );
      const d = digestTurn(turn, opt);
      const { title, subtitle, narrative, facts } = d.obs;
      noJoined("tytuł", title);
      noJoined("podtytuł", subtitle);
      noJoined("narracja", narrative);
      noJoined("fakty", facts);
      noJoined("FTS", ftsRow(d.obs));
    });

    test("remember: tytuł, narracja, pojęcia i encje bez reszty klucza", () => {
      const repo = fresh();
      for (const text of [
        `Produkcja używa klucza ${SPLIT} od dziś, stary wycofany.`,
        `Produkcja używa klucza **sk-ant-**${BODY} od jutra, stary wycofany.`,
      ]) {
        const { id } = remember(repo, { project: "x", text });
        const o = repo.getObservation(id)!;
        noKey("tytuł", o.title);
        noKey("narracja", o.narrative);
        noKey("pojęcia", o.concepts);
        noKey("notatka", o);
        expect(o.title).toContain("[REDACTED:anthropic-key]");
      }
      noKey("encje w bazie", entityKeys(repo));
      // emoji: tytuł z headline() (stripMarkdown) nie skleja klucza
      const { id } = remember(repo, { project: "x", text: `Produkcja używa klucza ${EMOJI} od soboty, stary wycofany.` });
      noJoined("tytuł", repo.getObservation(id)!.title);
    });
  });

  describe("repair: observations.meta", () => {
    test("napisy w meta przechodzą przez clean(), drugi przebieg nic nie zmienia", () => {
      const repo = fresh();
      const { id } = repo.insertObservation({
        session_id: null,
        project: "x",
        type: "decision",
        title: "Notatka z meta",
        narrative: "zwykła treść",
        created_at: 1,
        source: "agent",
        meta: { forget_reason: `wyciekł ${KEY}`, llm: { reason: ["ok", `token=${KEY}`] }, n: 3, key: "temat" },
      });
      const cm = join(DATA_DIR, "brak-claude-mem.db");
      const dry = repair(repo, { cmDbPath: cm, dryRun: true });
      expect(dry.clean.observations).toBe(1);
      expect(JSON.stringify(repo.getObservation(id)!.meta)).toContain(KEY); // próba nic nie zapisuje
      const r = repair(repo, { cmDbPath: cm });
      expect(r.clean.observations).toBe(1);
      const meta = repo.getObservation(id)!.meta as Record<string, any>;
      noKey("meta", meta);
      expect(meta.forget_reason).toBe("wyciekł [REDACTED:anthropic-key]");
      expect(meta.llm.reason[0]).toBe("ok");
      expect(meta.n).toBe(3);
      expect(meta.key).toBe("temat");
      expect(repair(repo, { cmDbPath: cm }).clean.observations).toBe(0);
      // podmiana meta tylko przy tej samej wartości w bazie (zmiana w międzyczasie wygrywa, repair poprawi ją później)
      expect(repo.setObservationMeta(id, { n: 4 }, JSON.stringify({ n: 3 }))).toBe(false);
      expect((repo.getObservation(id)!.meta as Record<string, any>).forget_reason).toBe("wyciekł [REDACTED:anthropic-key]");
    });
  });
}
