// Zapis z transkryptu: koniec tury, okno odczytu rosnące przy dużych turach, tura dłuższa niż limit czytana
// partiami, nadrabianie tylko skończonych tur (także po restarcie workera), numeracja po imporcie claude-mem,
// wykluczone projekty w turze i w sesji, projekt tury w podkatalogu bez repo, transkrypt sesji wznowionej w innym
// katalogu, projekt serwera MCP po zmianie katalogu sesji, cytowania #id, transakcja IMMEDIATE,
// ciąg dalszy po uwadze hooka Stop, komendy lokalne i prompty z aplikacji desktop.
// Funkcje transkryptu (bez bazy) są testowane tutaj, scenariusze z bazą w osobnym procesie
// (test/fixtures/capture/scenarios.ts): bun test dzieli moduły między plikami, a config.ts zamraża HIPOKAMP_HOME.
import { heapStats } from "bun:jsc";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
const claude = join(home, "claude");
mkdirSync(join(claude, "projects"), { recursive: true });
const prevEnv = {
  HIPOKAMP_HOME: process.env.HIPOKAMP_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HIPOKAMP_HOME = home;
process.env.CLAUDE_CONFIG_DIR = claude;
process.env.CODEX_HOME = join(home, "codex");
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ embed: { enabled: false }, backup: { enabled: false }, capture: { excludeProjects: ["sejf"] } }),
);

const {
  alignToLine,
  anchorBefore,
  compactSummaries,
  countsAsPrompt,
  groupTurns,
  isLocalCommand,
  lastTurnComplete,
  offsetAfterAnchor,
  promptOf,
  readLinesFrom,
  readTurns,
} = await import("../src/capture/transcript.ts");
const { continuationText, digestTurn } = await import("../src/capture/digest.ts");
const J = await import("./fixtures/capture/jsonl.ts");

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: home,
  HIPOKAMP_NO_WORKER: "1",
  HIPOKAMP_PORT: "47994",
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(home, "codex"),
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
};

function scenario(name: string): any {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "test", "fixtures", "capture", "scenarios.ts"), name], {
    env,
    cwd: ROOT,
  });
  if (p.exitCode !== 0) throw new Error(`scenariusz ${name}: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

const c = { sessionId: "s", cwd: "D:/x" };
const asLines = (rows: object[]) => rows.map((json, i) => ({ json, start: i * 100, end: i * 100 + 100 }));
const ask = J.userPrompt(c, 0, "odpal testy");
const call = J.toolCall(c, 1, "t1", "bun test", "Running tests…");
const out = J.toolOutput(c, 2, "t1", "33 pass");
const done = J.reply(c, 3, "Testy przeszły.");
const interrupt = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
};

function file(name: string, rows: object[]): string {
  const p = join(home, name);
  writeFileSync(p, J.jsonl(rows));
  return p;
}

describe("koniec tury", () => {
  test("end_turn kończy turę; narzędzie bez wyniku albo wynik bez odpowiedzi nie", () => {
    expect(lastTurnComplete(asLines([ask, call, out, done]))).toBe(true);
    expect(lastTurnComplete(asLines([ask, call]))).toBe(false);
    expect(lastTurnComplete(asLines([ask, call, out]))).toBe(false);
    expect(lastTurnComplete(asLines([ask]))).toBe(false);
    expect(lastTurnComplete([])).toBe(false);
  });

  test("uwaga hooka Stop po end_turn: Claude jeszcze odpowie", () => {
    const hook = { type: "user", isMeta: true, message: { role: "user", content: "Stop hook feedback: zadanie niedokończone" } };
    expect(lastTurnComplete(asLines([ask, call, out, done, hook]))).toBe(false);
    expect(lastTurnComplete(asLines([ask, call, out, done, hook, J.reply(c, 5, "Dokończone.")]))).toBe(true);
  });

  test("błąd API i przerwanie kończą turę, max_tokens nie", () => {
    const apiError = {
      type: "assistant",
      isApiErrorMessage: true,
      message: {
        role: "assistant",
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: "API Error" }],
      },
    };
    expect(lastTurnComplete(asLines([ask, call, out, apiError]))).toBe(true);
    expect(lastTurnComplete(asLines([ask, call, out, interrupt]))).toBe(true);
    expect(lastTurnComplete(asLines([ask, J.reply(c, 3, "Część odpowiedzi", "max_tokens")]))).toBe(false);
  });

  test("metadane i wątki boczne po odpowiedzi się nie liczą", () => {
    const side = { ...J.toolCall(c, 4, "t9", "ls"), isSidechain: true };
    const meta = [{ type: "system", subtype: "turn_duration" }, { type: "last-prompt" }];
    expect(lastTurnComplete(asLines([ask, call, out, done, side, ...meta]))).toBe(true);
  });

  test("przerwanie zapisane jako blok tekstu oznacza turę jako przerwaną", () => {
    const { turns } = groupTurns(asLines([ask, call, out, interrupt]), "s", { final: true });
    expect(turns[0].interrupted).toBe(true);
  });
});

describe("okno odczytu", () => {
  test("tura większa niż okno: okno rośnie, aż obejmie jej koniec", () => {
    const rows: object[] = [J.metaLine("s", 0), J.userPrompt(c, 0, "zbierz logi")];
    for (let i = 0; i < 6; i++)
      rows.push(J.toolCall(c, i, `t${i}`, `cat ${i}.log`), J.toolOutput(c, i, `t${i}`, "z".repeat(1500)));
    rows.push(J.reply(c, 9, "Logi zebrane."), J.userPrompt(c, 10, "dalej"));
    const p = file("duza.jsonl", rows);
    const b = readTurns(p, "s", 0, { window: 1024, maxWindow: 1 << 20, final: false });
    expect(b.turns.length).toBe(1);
    expect(b.turns[0].texts).toContain("Logi zebrane.");
    expect(b.batched).toBe(false);
    // offset stoi na początku tury w toku („dalej”), a nie tam, gdzie zaczęło się czytanie
    expect(b.offset).toBe(readLinesFrom(p, 0).lines.at(-1)!.start);
  });

  test("linia dłuższa niż limit w środku tury: pominięta, reszta zostaje w tej samej turze", () => {
    const p = file("limit.jsonl", [
      J.userPrompt(c, 0, "przeczytaj log"),
      J.toolCall(c, 1, "t1", "cat app.log"),
      J.toolOutput(c, 2, "t1", "q".repeat(20_000)),
      J.reply(c, 3, "Przeczytany."),
      J.userPrompt(c, 4, "dalej"),
    ]);
    const all = readLinesFrom(p, 0).lines;
    const a = readTurns(p, "s", 0, { window: 256, maxWindow: 4096, final: false });
    expect(a.batched).toBe(true);
    expect(a.skipped).toEqual({ from: all[2].start, to: all[2].end });
    expect(a.turns.map((t) => [t.kind, t.tools.map((x) => x.name), t.texts])).toEqual([["human", ["Bash"], ["Przeczytany."]]]);
    // nowa tura czeka na swój koniec
    expect(a.offset).toBe(all[4].start);
  });

  test("przycięte wyniki narzędzi są kopiami, nie wycinkami trzymającymi cały wynik", () => {
    // JSC: wycinek współdzieli bufor ze źródłem, kopia nie; po zwolnieniu źródła sterta spada tylko przy kopiach
    const heap = () => {
      Bun.gc(true);
      Bun.gc(true);
      const s = heapStats() as { heapSize: number; extraMemorySize?: number };
      return s.heapSize + (s.extraMemorySize ?? 0);
    };
    const K = 16;
    const rows: object[] = [J.userPrompt(c, 0, "zbierz duże logi")];
    for (let i = 0; i < K; i++)
      rows.push(J.toolCall(c, i, `t${i}`, `cat ${i}.log`), J.toolOutput(c, i, `t${i}`, `wynik ${i}: ${"ź".repeat(1 << 20)}`));
    rows.push(J.reply(c, 50, "Zebrane."));
    const base = heap();
    // linie jak po JSON.parse w readLinesFrom: własne napisy, zwalniane razem z linią (wynik i stdout po 2 MB)
    const lines = rows.map((json, i) => ({ json: JSON.parse(JSON.stringify(json)), start: i, end: i + 1 }));
    const [turn] = groupTurns(lines, "s", { final: true }).turns;
    lines.length = 0;
    const kept = heap() - base;
    expect(turn.tools.length).toBe(K);
    expect(turn.tools[0].result.length).toBeLessThan(4100);
    expect(turn.tools[0].structured?.stdout.length).toBe(1500);
    // bez kopii tura trzymałaby wszystkie wyniki i stdout w całości (ok. 64 MB)
    expect(kept).toBeLessThan(16 << 20);
  });

  test("tura dłuższa niż limit (T-19): partiami do końca, cała w jednej turze; bez końca w pliku czeka", () => {
    const compact = {
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: `Streszczenie rozmowy po kompakcji: ${"przegląd logów usług ".repeat(20)}` },
    };
    const rows: object[] = [J.userPrompt(c, 0, "zbierz logi wszystkich usług")];
    for (let i = 0; i < 8; i++) {
      rows.push(J.toolCall(c, i, `t${i}`, `cat ${i}.log`), J.toolOutput(c, i, `t${i}`, `usługa ${i}: ${"z".repeat(1500)}`));
      if (i === 4) rows.push(compact);
    }
    rows.push(J.reply(c, 9, "Wszystkie usługi działają."), J.userPrompt(c, 10, "dalej"));
    const p = file("partie.jsonl", rows);
    const all = readLinesFrom(p, 0).lines;
    const opts = { window: 1024, maxWindow: 4096 };
    expect(all[all.length - 1].start).toBeGreaterThan(4 * opts.maxWindow);
    const b = readTurns(p, "s", 0, { ...opts, final: false });
    expect(b.batched).toBe(true);
    expect(b.turns.length).toBe(1);
    expect(b.turns[0].tools.map((t) => t.result.slice(0, 9))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `usługa ${i}:`));
    expect(b.turns[0].texts).toEqual(["Wszystkie usługi działają."]);
    expect(b.offset).toBe(all[all.length - 1].start);
    // podsumowanie kompakcji z zakresu tury zostaje do zapisu
    expect(compactSummaries(b.lines).length).toBe(1);
    // koniec pliku w środku tury, której ten odczyt nie zamknie (bez promptu i końca tury w ogonie pliku): czeka
    // (offset na jej początku) bez czytania całej tury od nowa: odczyt kończy się na pierwszym oknie, okno nie rośnie
    const open = file("partie-w-toku.jsonl", rows.slice(0, -2));
    for (const final of [false, "complete"] as const) {
      const w = readTurns(open, "s", 0, { ...opts, final });
      expect(w).toMatchObject({ turns: [], offset: 0, batched: false });
      expect(w.end).toBeLessThanOrEqual(opts.window);
    }
    const closed = readTurns(open, "s", 0, { ...opts, final: true });
    expect(closed.turns[0].tools.length).toBe(8);
    expect(closed.offset).toBe(closed.size);
    // odpowiedź z end_turn na końcu pliku: "complete" zamyka turę
    const ended = file("partie-koniec.jsonl", rows.slice(0, -1));
    const fin = readTurns(ended, "s", 0, { ...opts, final: "complete" });
    expect(fin.turns.map((t) => t.texts)).toEqual([["Wszystkie usługi działają."]]);
    expect(fin.offset).toBe(fin.size);
  });

  test("odchudzanie linii: bez base64 obrazów i surowego toolUseResult", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(5000) } };
    const p = file("obrazy.jsonl", [
      J.userPrompt(c, 0, [img, { type: "text", text: "co tu widać" }]),
      { ...J.toolOutput(c, 1, "t1", "ok"), toolUseResult: [img] },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t2", content: [img, { type: "text", text: "zrzut" }] }],
        },
        toolUseResult: { type: "create", filePath: "D:/x/a.ts", originalFile: "x".repeat(5000) },
      },
    ]);
    const [a, b, d] = readLinesFrom(p, 0).lines.map((l) => l.json);
    expect(JSON.stringify([a, b, d])).not.toContain("BBBB");
    expect(a.message.content[0].type).toBe("image");
    expect(b.toolUseResult).toBeNull();
    expect(d.toolUseResult).toEqual({ type: "create", filePath: "D:/x/a.ts" });
  });
});

describe("ciąg dalszy, komendy lokalne, prompt z aplikacji desktop", () => {
  const feedback = J.metaUser(c, 4, "Stop hook feedback: [dokończ wdrożenie]: aplikacja nie jest jeszcze wdrożona");
  const stopSummary = J.systemLine("s", 4, "stop_hook_summary");
  const deploy = J.toolCall(c, 5, "t2", "./deploy.sh", "Wdrażam.");
  const deployed = J.toolOutput(c, 6, "t2", "deployed");
  const finished = J.reply(c, 7, "Wdrożenie zakończone na produkcji, wersja 2.1 działa.");
  const big = { window: 1 << 20, maxWindow: 1 << 20 };

  test("praca bez nowego promptu po zamkniętej turze to tura continuation z kluczem pierwszej linii", () => {
    const { turns, consumedTo } = groupTurns(asLines([stopSummary, feedback, deploy, deployed, finished]), "s", {
      final: true,
    });
    expect(turns.map((t) => t.kind)).toEqual(["continuation"]);
    expect(turns[0].key).toBe(feedback.uuid);
    expect(turns[0].from).toBe(100);
    expect(turns[0].prompt).toStartWith("Stop hook feedback:");
    expect(turns[0].tools.map((x) => x.result)).toEqual(["deployed"]);
    expect(turns[0].texts.at(-1)).toBe("Wdrożenie zakończone na produkcji, wersja 2.1 działa.");
    expect(consumedTo).toBe(500);
  });

  test("start od offsetu 0: metadane przed pierwszym promptem nie otwierają ciągu dalszego", () => {
    const meta = [
      J.metaLine("s", 0),
      { type: "file-history-snapshot", snapshot: {} },
      { type: "summary", summary: "poprzednia sesja" },
      J.systemLine("s", 0, "informational"),
    ];
    expect(groupTurns(asLines([...meta, ask, call, out, done]), "s", { final: true }).turns.map((t) => t.kind)).toEqual([
      "human",
    ]);
    const p = file("start.jsonl", [...meta, ask, call, out, done]);
    const b = readTurns(p, "s", 0, { ...big, final: false });
    expect(b.turns).toEqual([]);
    expect(b.offset).toBe(readLinesFrom(p, 0).lines[4].start);
  });

  test("ciąg dalszy w toku czeka jak zwykła tura: offset na jego początku, zamyka go odpowiedź", () => {
    const p = file("ciag.jsonl", [ask, call, out, done]);
    const first = readTurns(p, "s", 0, { ...big, final: true });
    expect(first.turns.map((t) => t.kind)).toEqual(["human"]);
    appendFileSync(p, J.jsonl([stopSummary, feedback, deploy]));
    const start = readLinesFrom(p, 0).lines.find((l) => l.json.uuid === feedback.uuid)!.start;
    for (const final of [false, "complete"] as const) {
      const w = readTurns(p, "s", first.offset, { ...big, final });
      expect(w.turns).toEqual([]);
      expect(w.offset).toBe(start);
    }
    appendFileSync(p, J.jsonl([deployed, finished]));
    const fin = readTurns(p, "s", start, { ...big, final: "complete" });
    expect(fin.turns.map((t) => t.kind)).toEqual(["continuation"]);
    expect(fin.offset).toBe(fin.size);
  });

  test("zastrzeżenie przed komendą lokalną nie jest turą; komenda bez odpowiedzi modelu jest lokalna", () => {
    const caveat = J.metaUser(c, 0, "<local-command-caveat>Caveat: The messages below were generated…</local-command-caveat>");
    const stdout = J.userPrompt(c, 2, "<local-command-stdout>Set model to opus</local-command-stdout>");
    const { turns } = groupTurns(
      asLines([caveat, J.command(c, 1, "/model", "opus"), stdout, J.command(c, 3, "/review"), call, out, done]),
      "s",
      { final: true },
    );
    expect(turns.map((t) => [t.kind, t.prompt, isLocalCommand(t)])).toEqual([
      ["command", "/model opus", true],
      ["command", "/review", false],
    ]);
    // przerwana zanim model odpowiedział: poszła do modelu, nie jest lokalna
    const cut = groupTurns(asLines([J.command(c, 0, "/review"), interrupt]), "s", { final: true }).turns;
    expect(isLocalCommand(cut[0])).toBe(false);
  });

  test("prompt z aplikacji desktop: blok <system-reminder> przed treścią nie odrzuca promptu", () => {
    expect(promptOf(J.desktopPrompt(c, 0, "zrób certyfikat SSL"))).toEqual({
      text: "zrób certyfikat SSL",
      kind: "human",
      hasImage: false,
    });
    const asString = {
      ...J.userPrompt(c, 0, "<system-reminder>\nkontekst\n</system-reminder>\n\nnapraw port"),
      origin: { kind: "human" },
    };
    expect(promptOf(asString)?.text).toBe("napraw port");
    // sam blok bez słów człowieka i przypomnienie bez origin human promptem nie są
    expect(promptOf({ ...J.userPrompt(c, 0, "<system-reminder>x</system-reminder>"), origin: { kind: "human" } })).toBeNull();
    expect(promptOf(J.userPrompt(c, 0, "<system-reminder>x</system-reminder> napraw port"))).toBeNull();
  });

  test("notatka z ciągu dalszego: tytuł z odpowiedzi, podtytuł z wyzwalacza; bez pracy to szum", () => {
    const [turn] = groupTurns(asLines([feedback, deploy, deployed, finished]), "s", { final: true }).turns;
    const opt = { project: "x", n: 3, privateTools: [], maxNarrativeChars: 1200 };
    const d = digestTurn(turn, opt);
    expect(d.skip).toBe(false);
    expect(d.obs.title).toContain("Wdrożenie zakończone na produkcji");
    expect(d.obs.subtitle).toStartWith("Ciąg dalszy: uwaga hooka Stop: [dokończ wdrożenie]");
    expect(d.obs.narrative).toContain("wersja 2.1 działa");
    expect(d.obs.prompt_n).toBe(3);
    expect(d.obs.meta?.kind).toBe("continuation");
    // długi wyzwalacz nie ratuje tury bez narzędzi z krótką odpowiedzią
    const idle = groupTurns(
      asLines([J.metaUser(c, 0, `Stop hook feedback: [${"dokończ cel ".repeat(20)}]: dalej`), J.reply(c, 1, "Gotowe.")]),
      "s",
      { final: true },
    ).turns[0];
    expect(digestTurn(idle, opt).skip).toBe(true);
    // obieg pętli bez skutku (skrypt tylko czyta, krótka odpowiedź) to szum; scalenie albo wysłana wiadomość już nie
    const loop = (tool: object) =>
      groupTurns(
        asLines([
          J.metaUser(c, 0, "Nasłuch kolejki zgłoszeń, przebieg cykliczny"),
          tool,
          J.toolOutput(c, 2, "t5", "[]"),
          J.reply(c, 3, "Bez zmian, nic nowego w kolejce."),
        ]),
        "s",
        { final: true },
      ).turns[0];
    expect(digestTurn(loop(J.toolCall(c, 1, "t5", "python - <<'EOF'")), opt)).toMatchObject({
      skip: true,
      reason: "ciąg dalszy bez skutku",
    });
    expect(digestTurn(loop(J.toolCall(c, 1, "t5", "git merge agent/s3/lockscreen")), opt).skip).toBe(false);
    // nakładka na gita tylko na początku polecenia: `xgit save` to zapis, `legit commit` w tekście echo nie
    const wrapped = digestTurn(loop(J.toolCall(c, 1, "t5", 'xgit save -m "zapis kolejki"')), opt);
    expect(wrapped.skip).toBe(false);
    expect((wrapped.obs.facts ?? []).some((f: string) => f.includes("zapis kolejki"))).toBe(true);
    expect(digestTurn(loop(J.toolCall(c, 1, "t5", "echo legit commit")), opt).skip).toBe(true);
    expect(digestTurn(loop(J.toolCall(c, 1, "t5", "echo digit save")), opt).skip).toBe(true);
    const send = {
      ...J.toolCall(c, 1, "t5", ""),
      message: {
        role: "assistant",
        model: "test",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t5", name: "mcp__chat__send_message", input: {} }],
      },
    };
    expect(digestTurn(loop(send), opt).skip).toBe(false);
    expect(continuationText("Goal check-in: «wdróż wersję na produkcję» is still active")).toBe("cel: wdróż wersję na produkcję");
    expect(
      continuationText(
        'Another Claude session sent a message: <cross-session-message from="x">Raport gotowy</cross-session-message>',
      ),
    ).toBe("wiadomość innej sesji: Raport gotowy");
  });
});

describe("komunikat o błędzie API", () => {
  test("limit API to nie odpowiedź: tura bez notatki, ale skończona i z numerem promptu", () => {
    const limit = {
      ...J.reply(c, 1, "You've hit your weekly limit · resets Oct 8, 12pm (Europe/Warsaw)", "stop_sequence"),
      isApiErrorMessage: true,
    };
    limit.message = { ...limit.message, model: "<synthetic>" };
    const lines = asLines([J.userPrompt(c, 0, "sprawdź kontekst startowy pamięci"), limit]);
    expect(lastTurnComplete(lines)).toBe(true);
    const [t] = groupTurns(lines, "s", { final: true }).turns;
    expect(t.texts).toEqual([]);
    expect(countsAsPrompt(t)).toBe(true);
    expect(digestTurn(t, { project: "x", n: 1, privateTools: [], maxNarrativeChars: 1400 }).skip).toBe(true);
  });
});

describe("ingest z bazą (osobny proces)", () => {
  test("dwa zdarzenia Stop: ciąg dalszy po uwadze hooka daje notatkę bez nowego promptu", () => {
    const r = scenario("continuation");
    expect(r.stop1).toBe(1);
    expect(r.afterStop1).toEqual({ prompts: [1], n: 1 });
    // przed drugim Stop ciąg dalszy w toku czeka, offset na jego początku
    expect(r.waiting).toEqual({ inserted: 0, offset: r.waiting.feedbackStart, feedbackStart: r.waiting.feedbackStart });
    expect(r.waiting.feedbackStart).toBeGreaterThan(0);
    expect(r.stop2).toBe(1);
    expect(r.stop3).toBe(1);
    expect(r.notes.map((o: any) => [o.prompt_n, o.kind])).toEqual([
      [1, "human"],
      [1, "continuation"],
      [2, "human"],
    ]);
    expect(r.notes[1].turn_key).toBe(r.feedbackUuid);
    expect(r.notes[1].title).toContain("Wdrożenie gotowe");
    expect(r.notes[1].subtitle).toStartWith("Ciąg dalszy: uwaga hooka Stop");
    expect(r.prompts).toEqual([1, 2]);
    expect(r.n).toBe(2);
    expect(r.promptCount).toBe(2);
    expect(r.offset).toBe(r.size);
  }, 20_000);

  test("numeracja jak w claude-mem: prompt z aplikacji desktop liczony, komenda lokalna nie", () => {
    const r = scenario("localCommand");
    expect(r.prompts).toEqual([
      { n: 1, text: "zrób certyfikat SSL na serwerze NAS" },
      { n: 2, text: "sprawdź odnowienie certyfikatu" },
    ]);
    expect(r.firstPrompt).toBe("zrób certyfikat SSL na serwerze NAS");
    expect(r.notes).toEqual([1, 2]);
    expect(r.inserted).toBe(2);
    expect(r.n).toBe(2);
    expect(r.promptCount).toBe(2);
  }, 20_000);

  test("import claude-mem: numeracja od transkryptu, jedna nowa notatka, bez dubli promptów", () => {
    const r = scenario("numbering");
    expect(r.first).toBe(1);
    expect(r.second).toBe(0);
    expect(r.notes).toEqual([{ prompt_n: 4, source: "backfill" }]);
    expect(r.prompts).toEqual([
      { n: 1, source: "claude-mem" },
      { n: 2, source: "claude-mem" },
      { n: 3, source: "claude-mem" },
      { n: 4, source: "backfill" },
    ]);
    expect(r.promptCount).toBe(4);
    expect(r.offset).toBe(r.size);
    // ten sam import czytany oknami po ~1 turze: numer tury nie wraca do licznika claude-mem
    expect(r.windows.calls).toBeGreaterThan(2);
    expect(r.windows.notes).toEqual([4]);
    expect(r.windows.prompts).toEqual([1, 2, 3, 4]);
    expect(r.windows.promptCount).toBe(4);
    expect(r.windows.offset).toBe(r.windows.size);
  }, 20_000);

  test("granica odczytu (limit) w środku tury: Stop nie zamyka tury przy granicy, zapis po odczycie do końca", () => {
    const r = scenario("readLimit");
    expect(r.cut).toBeLessThan(r.size);
    // bez granicy pierwszą turę zamknąłby prompt drugiej, z zamykaniem przy granicy poszłaby ucięta: w obu turns 1
    expect(r.afterCut).toMatchObject({ turns: 0, notes: 0 });
    expect(r.afterCut.offset).toBeLessThan(r.cut);
    expect(r.afterEnd).toEqual({ turns: 2, offset: r.size });
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toContain("Porty poprawione");
  }, 20_000);

  test("tura większa niż maxBytes trafia do pamięci, kolejne tury też", () => {
    const r = scenario("bigturn");
    expect(r.turnBytes).toBeGreaterThan(3 * 4096);
    expect(r.calls[0].inserted).toBeGreaterThan(0);
    expect(r.notes.map((n: any) => n.prompt_n)).toEqual([1, 2, 3]);
    expect(r.notes[0].narrative).toContain("Raport gotowy");
    expect(r.offset).toBe(r.size);
  }, 20_000);

  test("linia dłuższa niż limit okna: pominięta z ostrzeżeniem, offset przesunięty, dalsze tury zapisane", () => {
    const r = scenario("longline");
    expect(r.notes.map((n: any) => n.prompt_n)).toEqual([1, 2, 3]);
    expect(r.notes[1].narrative).toContain("przeczytaj cały log błędów");
    expect(r.notes[2].narrative).toContain("Usługa bazy zrestartowana");
    expect(r.offset).toBe(r.size);
    expect(r.loggedBatched).toBe(true);
    expect(r.warnedSkipped).toBe(true);
  }, 20_000);

  test("tura dłuższa niż limit okna (T-19): jedna notatka z odpowiedzią, bez ciągów dalszych, następna tura z numerem 2", () => {
    const r = scenario("longturn");
    expect(r.turnBytes).toBeGreaterThan(4 * 16 * 1024);
    expect(r.notes).toEqual([
      [1, "human"],
      [2, "human"],
    ]);
    expect(r.narrative).toContain("usługa 17 gubi połączenia");
    expect(r.prompts).toEqual([1, 2]);
    expect(r.offset).toBe(r.size);
  }, 20_000);

  test("sesja z katalogu wykluczonego projektu (T-19): bez wiersza w sessions", () => {
    expect(scenario("excludedSession")).toEqual({ project: "sejf", inserted: 0, session: false });
  }, 20_000);

  test("nadrabianie po restarcie workera (T-19): tura w toku nie jest czytana od nowa, po nowych liniach tak", () => {
    const r = scenario("catchupRestart");
    expect(r.first).toEqual({ files: 1, inserted: 1 });
    expect(r.waitingAfterFirst).toBe(true);
    expect(r.restarted).toEqual({ files: 0, inserted: 0 });
    expect(r.grown).toEqual({ files: 1, inserted: 1 });
    expect(r.notes).toEqual([1, 2]);
    expect(r.waitingAtEnd).toBe("{}");
  }, 30_000);

  test("projekt tury (T-23): podkatalog bez repo w projekcie sesji, własne repo, znacznik i alias claude-mem osobno, wykluczony wykluczony", () => {
    const r = scenario("turnProject");
    expect(r.inRepo).toBe(false);
    expect(r.session).toBe("t23-projekt");
    const expected = [
      [1, "t23-projekt"],
      [2, "t23-projekt"],
      [3, "biblioteka"],
      [5, "modul"],
      [6, "stary-klucz"],
    ];
    expect(r.notes).toEqual(expected);
    expect(r.prompts).toEqual(expected);
  }, 20_000);

  test("projekt tury (T-23): klucze plików od katalogu startowego, nie od sessions.cwd; start w ~, %TEMP% i korzeniu dysku bez wchłaniania", () => {
    const r = scenario("turnFiles");
    expect(r.rootIsStart).toBe(true);
    // ten sam plik z katalogu projektu i z podkatalogu: jeden klucz, projekt katalogu startowego
    for (const n of [1, 2])
      expect(r.notes.find((o: any) => o.n === n)).toEqual({
        n,
        project: r.projectName,
        files: ["skrypty/deploy.sh"],
        fingerprints: ["skrypty/deploy.sh"],
      });
    // odczyt (hook po użyciu pliku z podkatalogu) liczy klucz tą samą regułą co zapis
    expect([r.recalled, r.hookOut]).toEqual([true, r.hookOut]);
    // start sesji po /compact w podkatalogu: plik zmieniony po notatkach oznaczony (klucz od katalogu projektu)
    expect([r.staleAtStart, r.startOut]).toEqual([true, r.startOut]);
    // naprawa: odzyskane notatki z tym samym projektem i kluczami co z ingestu
    expect(r.recovered).toEqual([
      { n: 1, project: r.projectName, files: ["skrypty/deploy.sh"] },
      { n: 2, project: r.projectName, files: ["skrypty/deploy.sh"] },
    ]);
    expect(r.generic).toEqual({ home: [r.projectName], tmp: ["ogolny"], drive: ["ogolny"], config: ["narzedzie"] });
  }, 30_000);

  test("projekt tury (T-23): katalog z wieloma projektami (jak D:\\code) nie wchłania projektów bez repo", () => {
    const r = scenario("turnContainer");
    expect(r["kontener-goly"]).toEqual([
      [1, "kontener"],
      [2, "Kompas"],
      [3, "Kompas"],
      [4, "notatki"],
    ]);
    expect(r["kontener-claude"]).toEqual([
      [1, "kontener-claude"],
      [2, "szkice"],
    ]);
    expect(r["kontener-md"]).toEqual([
      [1, "kontener-md"],
      [2, "brudnopis"],
    ]);
    // podprojekt podpięty junctionem też się liczy
    expect(r["kontener-junction"]).toEqual([
      [1, "kontener-junction"],
      [2, "zapiski"],
    ]);
    // monorepo bez gita (workspaces): jeden projekt, pakiety i katalogi obok nich w nim
    expect(r["monorepo-plaski"]).toEqual([
      [1, "mono-plaski"],
      [2, "mono-plaski"],
      [3, "mono-plaski"],
      [4, "mono-plaski"],
    ]);
    expect(r["monorepo-pnpm"]).toEqual([
      [1, "mono-pnpm"],
      [2, "mono-pnpm"],
    ]);
    // hook bierze werdykt katalogu startowego z sessions.meta (bez skanowania); start sesji zapisuje go raz
    expect(r.verdict).toEqual({ project: true, container: false });
    expect(r.remembered).toEqual({ root: true, rootProject: true });
    // skan: po limicie czasu wynik nieznany; pierwsze 64 podkatalogi według nazwy, ten sam wynik na każdym systemie
    expect(r.scan).toEqual({
      late: null,
      capped: {
        "repo 64. (p00..p62, p63-repo)": 1,
        "repo 65. (p00..p63, p64-repo)": 0,
        "repo 71. (p00..p69, zz-repo)": 0,
        "Zz-repo przed p00 (kody znaków, na NTFS za p63)": 1,
      },
    });
  }, 20_000);

  test("transkrypt sesji wznowionej w innym katalogu (T-28): offset starej kopii wyrównany do linii nowego pliku", () => {
    const r = scenario("movedTranscript");
    // krótsza ostatnia linia: offset w środku nowego promptu, prompt czytany od początku (numer 2, nie ciąg dalszy)
    expect(r.krotsza.midPrompt).toBe(true);
    // dłuższa: offset w środku nowej linii metadanych, czytanie od następnej linii
    expect(r.dluzsza.midMeta).toBe(true);
    for (const v of [r.krotsza, r.dluzsza]) {
      expect(v.inserted).toBe(1);
      expect(v.notes).toEqual([
        [1, "human"],
        [2, "human"],
      ]);
      expect(v.prompts).toEqual([1, 2]);
      expect(v.atEnd).toBe(true);
      expect(v.path).toBe(true);
    }
  }, 20_000);

  test("transkrypt sesji wznowionej (T-28): ostatnia linia starej kopii dłuższa o 100, 300, 450 i 900 B, prompty po wznowieniu zostają", () => {
    const r = scenario("movedOvershoot");
    // 900 B to więcej niż cały prompt po wznowieniu: offset starej kopii wypada za nim
    expect(r["900"].pastPrompt).toBe(true);
    for (const d of ["100", "300", "450", "900"]) {
      expect([d, r[d].notes]).toEqual([
        d,
        [
          [1, "human"],
          [2, "human"],
          [3, "human"],
        ],
      ]);
      expect([d, r[d].prompts]).toEqual([d, [1, 2, 3]]);
      expect(r[d].atEnd).toBe(true);
    }
  }, 20_000);

  test("transkrypt sesji wznowionej (T-28): nadrabianie nie wraca do starszej kopii, tura 2 nie czyta się drugi raz", () => {
    const r = scenario("movedCatchup");
    for (const d of ["1700", "2500"])
      expect([d, r[d]]).toEqual([
        d,
        {
          bigger: true,
          afterCatchup: true,
          prompts: ["1:napisz raport kwartalny", "2:dalej", "3:a teraz podsumuj raport"],
          notes: [1, 2, 3],
        },
      ]);
  }, 30_000);

  test("pierwsza wiadomość dłuższa niż 256 KB (wklejony obraz) zakłada sesję", () => {
    expect(scenario("head")).toEqual({ created: true, inserted: 1 });
  }, 20_000);

  test("nadrabianie nie zamyka tury z narzędziem w toku; po wyniku i odpowiedzi notatka ją zawiera", () => {
    const r = scenario("catchup");
    expect(r.first.inserted).toBe(1);
    expect(r.afterFirst.notes).toBe(1);
    expect(r.afterFirst.offset).toBeLessThan(r.afterFirst.size);
    expect(r.second.files).toBe(0); // plik bez zmian: nie jest czytany od nowa
    expect(r.third.inserted).toBe(1);
    expect(r.notes.map((n: any) => n.prompt_n)).toEqual([1, 2]);
    expect(r.notes[1].narrative).toContain("Testy przeszły");
    expect(r.offset).toBe(r.size);
    expect(r.summary).toContain("Testy przeszły");
  }, 20_000);

  test("nadrabianie: SessionEnd albo 12 h ciszy zamykają turę bez odpowiedzi, sesja wznowiona po SessionEnd czeka", () => {
    const r = scenario("catchupPolicy");
    expect(r.awaria).toBe(1);
    expect(r.koniec).toBe(1);
    expect(r.wznowiona).toBe(0);
  }, 20_000);

  test("tura w katalogu wykluczonego projektu: bez promptu i bez notatki, offset idzie dalej", () => {
    const r = scenario("exclude");
    expect(r.inserted).toBe(2);
    expect(r.notes).toEqual([
      { prompt_n: 1, project: "praca" },
      { prompt_n: 3, project: "praca" },
    ]);
    expect(r.prompts).toEqual([
      { n: 1, project: "praca" },
      { n: 3, project: "praca" },
    ]);
    expect(r.sejfNotes).toBe(0);
    expect(r.sejfPrompts).toBe(0);
    expect(r.promptCount).toBe(3);
    expect(r.offset).toBe(r.size);
  }, 20_000);

  test("cytowanie #id liczy się tylko dla notatek widzianych w tej sesji", () => {
    expect(scenario("cited").cited).toEqual([9002, 9003]);
  }, 20_000);

  test("transakcja IMMEDIATE czeka na cudzą blokadę zapisu zamiast SQLITE_BUSY", () => {
    const r = scenario("immediate");
    expect(r.locked).toBe(true);
    expect(r.error).toBeNull();
    expect(r.inserted).toBe(1);
    expect(r.waitedMs).toBeGreaterThan(300);
  }, 20_000);
});

describe("offset z innej kopii transkryptu (T-28)", () => {
  test("granica linii zostaje; ze środka metadanych na następną linię, ze środka promptu na jego początek", () => {
    const p = file("kopia.jsonl", [
      J.metaLine("s", 0),
      { type: "last-prompt", lastPrompt: "x".repeat(100), sessionId: "s" },
      J.userPrompt(c, 1, "dodaj reset hasła przez e-mail"),
      J.reply(c, 2, "Reset hasła dodany."),
    ]);
    const [, last, ask2, answer] = readLinesFrom(p, 0).lines;
    expect(alignToLine(p, 0)).toBe(0);
    expect(alignToLine(p, last.start)).toBe(last.start);
    expect(alignToLine(p, last.start + 20)).toBe(ask2.start);
    expect(alignToLine(p, ask2.start + 20)).toBe(ask2.start);
    expect(alignToLine(p, answer.start + 20)).toBe(answer.end);
    expect(alignToLine(p, answer.end)).toBe(answer.end);
    // plik krótszy niż offset albo linia jeszcze się pisze: decyzja przy następnym odczycie
    expect(alignToLine(p, answer.end + 10)).toBeNull();
    appendFileSync(p, '{"type":"user","message":');
    expect(alignToLine(p, answer.end + 5)).toBeNull();
  });

  test("kotwica: ostatnia linia z uuid przed offsetem; odpowiednik tylko z tym samym uuid, nie po samym typie", () => {
    const ask = J.userPrompt(c, 1, "napisz raport");
    const answer = J.reply(c, 2, "Raport gotowy.");
    const last = (t: string) => ({ type: "last-prompt", lastPrompt: t, sessionId: "s" });
    const old = file("kotwica-stara.jsonl", [J.metaLine("s", 0), ask, answer, last("x".repeat(500)), J.metaLine("s", 3)]);
    const size = readLinesFrom(old, 0).size;
    const a = anchorBefore(old, size);
    const [, , ans] = readLinesFrom(old, 0).lines;
    // za odpowiedzią są już tylko metadane bez uuid: kotwicą jest odpowiedź
    expect(a).toEqual({ at: ans.start, len: ans.end - ans.start, uuid: answer.uuid, type: "assistant", off: size });
    // nowa kopia: krótsze metadane, nowy prompt; czytanie od końca odpowiedzi
    const ask2 = J.userPrompt(c, 4, "dalej");
    const fresh = file("kotwica-nowa.jsonl", [J.metaLine("s", 0), ask, answer, last("dalej"), ask2]);
    expect(offsetAfterAnchor(fresh, a!)).toBe(ans.end);
    // w tym miejscu linia tego samego typu, ale inna (inny uuid): brak odpowiednika
    const other = file("kotwica-inna.jsonl", [J.metaLine("s", 0), ask, J.reply(c, 2, "Raport gotowy.")]);
    expect(offsetAfterAnchor(other, a!)).toBeNull();
    // same metadane (bez uuid) albo offset poza granicą linii: bez kotwicy
    const meta = file("kotwica-metadane.jsonl", [J.metaLine("s", 0), last("x")]);
    expect(anchorBefore(meta, readLinesFrom(meta, 0).size)).toBeNull();
    expect(anchorBefore(old, size - 3)).toBeNull();
  });
});

describe("projekt serwera MCP (T-23, osobny proces)", () => {
  test("liczony przy każdym wywołaniu: zmiana katalogu sesji (roots od Claude Code) zmienia projekt", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const alfa = join(home, "mcp-alfa");
    const beta = join(home, "mcp-beta");
    mkdirSync(alfa, { recursive: true });
    mkdirSync(beta, { recursive: true });
    let root = alfa;
    const client = new Client({ name: "test", version: "0" }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href }] }));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "src", "mcp", "server.ts")],
        env: { ...env, CLAUDE_PROJECT_DIR: alfa },
        cwd: alfa,
      }),
    );
    const workState = async () =>
      ((await client.callTool({ name: "work_state_read", arguments: {} })) as { content: { text: string }[] }).content[0].text;
    try {
      expect(await workState()).toContain("mcp-alfa");
      root = beta;
      await client.sendRootsListChanged();
      await Bun.sleep(100);
      expect(await workState()).toContain("mcp-beta");
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("klucz promptu", () => {
  test("prompt z samych symboli ma niepusty klucz i paruje się z tym samym tekstem", async () => {
    const { pairByTextAndTime, promptKey } = await import("../src/capture/match.ts");
    expect(promptKey("®")).not.toBe("");
    expect(promptKey(" ®  ")).toBe(promptKey("®"));
    expect(promptKey("-")).not.toBe(promptKey("®"));
    expect(promptKey("Napraw build!")).toBe("napraw build");
    expect(promptKey("   ")).toBe("");
    const at = Date.UTC(2026, 9, 1);
    const pairs = pairByTextAndTime(
      [{ item: "tura", key: promptKey("®"), at }],
      [{ item: "prompt", key: promptKey("®"), at: at + 1000 }],
    );
    expect(pairs.get("tura")).toBe("prompt");
  });
});

describe("odzyskiwanie tur zgubionych przez parser 0.1 (osobny proces)", () => {
  test("prompt z samych symboli dopisany raz: drugi przebieg nic nie dodaje", () => {
    const r = scenario("recoverSymbolPrompt");
    expect(r.run.recovered).toBe(1);
    expect(r.run.prompts).toBe(1);
    expect(r.againChanges).toBe(0);
    // b) przenumerowało prompt tury 2, więc tura desktop dostała swój numer 1
    expect(r.prompts).toEqual([
      { n: 1, text: "?" },
      { n: 2, text: "sprawdź logi serwera" },
    ]);
  }, 20_000);

  test("naprawa dopisuje turę z aplikacji desktop i ciąg dalszy; próba nic nie zapisuje; drugi przebieg nic nie dodaje", () => {
    const r = scenario("recover");
    const expected = {
      sessions: 2,
      missingTranscript: 0,
      turns: 5,
      missing: 3,
      recovered: 3,
      byKind: { human: 2, command: 0, continuation: 1, task: 0 },
      claudeMem: 0,
      covered: 0,
      idle: 0,
      duplicates: 0,
      excluded: 0,
      prompts: 2,
      promptsMoved: 0,
      firstPrompts: 1,
      summaries: 1,
    };
    // (d) próba na bazie tylko do odczytu: te same liczby, baza i dziennik bez zmian. Próba widzi przenumerowanie z b)
    // (RecoverView), więc numer 1 tury desktop jest dla niej wolny jak w przebiegu właściwym (T-24)
    expect(r.dry).toEqual(expected);
    expect(r.dryUnchanged).toBe(true);
    expect(r.dryLog).toBe(false);
    // (a) przebieg właściwy: to, co przewidziała próba
    expect(r.run).toEqual(expected);
    expect(r.runChanges).toBe(r.dryChanges);
    // b) obejmuje też sesje bez claude-mem: numeracja 0.1 przesunięta o zgubioną turę desktop
    expect(new Set(r.ops)).toEqual(
      new Set(["renumber-prompt", "prompt-n", "prompt-count", "recover", "recover-prompt", "first-prompt", "summary"]),
    );
    expect(r.report).toContain("d) tury bez notatki w przeczytanych zakresach");
    expect(r.report).toContain("odzyskane notatki: 3");
    const recovered = r.notes.filter((o: any) => o.repair === "recover");
    expect(recovered.map((o: any) => [o.session_id, o.turn_key, o.prompt_n, o.kind, o.source])).toEqual([
      ["odzysk-live", r.keys.d1, 1, "human", "backfill"],
      ["odzysk-live", r.keys.feedback, 2, "continuation", "backfill"],
      ["odzysk-desktop", r.keys.d2, 1, "human", "backfill"],
    ]);
    expect(recovered[1].subtitle).toStartWith("Ciąg dalszy: uwaga hooka Stop");
    expect(recovered[1].title).toContain("Wdrożenie gotowe");
    expect(JSON.parse(recovered[0].transcript_ref).path).toEndWith("odzysk-live.jsonl");
    // prompty 0.1 przenumerowane przez b) na numery tur z transkryptu, więc tura desktop dostaje swój numer 1
    expect(r.prompts.map((p: any) => [p.session_id, p.n, p.source])).toEqual([
      ["odzysk-desktop", 1, "backfill"],
      ["odzysk-live", 1, "backfill"],
      ["odzysk-live", 2, "live"],
      ["odzysk-live", 3, "live"],
    ]);
    // offset bez zmian; licznik promptów i meta.n z transkryptu (b), żeby ingest numerował dalej bez kolizji;
    // pierwszy prompt tylko tam, gdzie go nie było
    expect(r.sessions).toEqual([
      {
        id: "odzysk-desktop",
        transcript_offset: r.sizes["odzysk-desktop"],
        prompt_count: 1,
        n: 1,
        first_prompt: "przygotuj kopię zapasową bazy klientów",
      },
      {
        id: "odzysk-live",
        transcript_offset: r.sizes["odzysk-live"],
        prompt_count: 3,
        n: 3,
        first_prompt: "napraw build aplikacji mobilnej",
      },
    ]);
    // podsumowanie, które już było, zna odzyskany ciąg dalszy; sesja bez podsumowania go nie dostaje
    expect(r.summary).toContain("Wdrożenie gotowe");
    expect(r.summary2).toBe(false);
    // (b) drugi przebieg: nic do zrobienia
    expect(r.againChanges).toBe(0);
    expect(r.again.recovered + r.again.prompts + r.again.firstPrompts + r.again.summaries).toBe(0);
    expect(r.againUnchanged).toBe(true);
  }, 30_000);

  test("(c) tura opisana przez claude-mem nie dostaje drugiej notatki, także w ingest czytającym oknami", () => {
    const r = scenario("recoverClaudeMem");
    const [u1, n1, u2, u3] = r.keys;
    // tura 1 i powiadomienie po niej: prompt claude-mem z notatką; obraz: „[obraz]” i „[media prompt]” to ten sam prompt
    expect(r.rec.claudeMem).toBe(3);
    // tura 2: claude-mem ma prompt bez notatki (obserwator na limicie), więc to jedyny jej opis
    expect(r.rec.recovered).toBe(1);
    expect(r.recNotes).toEqual([u2]);
    expect(r.recNotes).not.toContain(u1);
    expect(r.recNotes).not.toContain(n1);
    expect(r.recNotes).not.toContain(u3);
    // prompty są już w bazie jako prompty claude-mem
    expect(r.rec.prompts).toBe(0);
    expect(r.prompts).toEqual(["1:claude-mem", "2:claude-mem", "3:claude-mem"]);
    // ingest przy kolejnych Stop: powiadomienie zaczyna okno i dziedziczy stan promptu sprzed okna
    expect(r.windows).toEqual([0, 0, 1, 0]);
    expect(r.ingestNotes).toEqual([r.keys2[2]]);
    expect(r.prompts2).toEqual(["1:claude-mem", "2:claude-mem", "3:claude-mem"]);
    expect(r.n2).toBe(3);
  }, 30_000);

  // rollout ze ścieżkami Windows (D:/code/demo) działa też na Linuksie: ścieżki liczy się według stylu katalogu rolloutu
  test("Codex: nadrabianie z rolloutów i hook Stop bez transcript_path", () => {
    const r = scenario("codex");
    expect(r.caught).toEqual({ files: 1, inserted: 2 });
    expect(r.notes.length).toBe(2);
    expect(r.notes[0].files).toBe(2);
    expect(r.prompts).toEqual(["1:napraw test logowania w aplikacji demo", "2:teraz dodaj eksport raportu do CSV"]);
    expect(r.transcript).toBe(true);
    expect(r.subagent).toBe(0);
    // Stop przed zapisem task_complete: tura czeka (domknie ją nadrabianie albo następny Stop)
    expect(r.beforeComplete).toEqual({ code: 0, notes: 0 });
    expect(r.afterComplete).toEqual({ code: 0, notes: 1 });
  }, 30_000);

  test("wznowiona stara sesja po claude-mem: powiadomienie i komenda na początku okna dostają notatkę", () => {
    // stan sprzed okna jest „opisane”, ale obserwator claude-mem w czasie tych tur nie działał
    expect(scenario("resumedAfterClaudeMem")).toEqual({ task: 1, command: 1 });
  }, 30_000);
});
