import { describe, expect, test } from "bun:test";
import { digestTurn, notificationText } from "../src/capture/digest.ts";
import { clean, redact, stripPrivate } from "../src/capture/redact.ts";
import { groupTurns, type Line, promptOf } from "../src/capture/transcript.ts";
import { isBusyError, retryBusy } from "../src/db/db.ts";
import { toBits, toQ8 } from "../src/index/embedder.ts";
import { buildMatch } from "../src/index/fts.ts";
import { baseLevel } from "../src/recall/activation.ts";
import { selectUnderBudget } from "../src/recall/select.ts";
import { foldWorkState } from "../src/recall/workstate.ts";
import { estimateTokens, headline, truncate } from "../src/util/text.ts";

/** Nagłówek klucza PEM sklejany w czasie testu: skaner sekretów przy wysyłce nie widzi go w pliku. */
const PEM_HEAD = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

describe("redact", () => {
  test("maskuje klucze i hasła", () => {
    // tokeny sklejane w czasie testu, żeby skaner sekretów nie brał pliku za wyciek
    const r = redact(
      `klucz ${["sk-or", "v1", "abcdefghijklmnopqrstuvwxyz0123"].join("-")} oraz password=Sup3rTajne!x i ${["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}`,
    );
    expect(r.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(r.text).not.toContain("Sup3rTajne");
    expect(r.hits).toBeGreaterThanOrEqual(3);
  });
  test("zostawia zwykły tekst i placeholdery", () => {
    const placeholder = ["$", "{GITEA_TOKEN}"].join("");
    const r = redact(`token: ${placeholder} i password=<hasło> w README`);
    expect(r.text).toContain(placeholder);
    expect(r.hits).toBe(0);
  });
  test("dane logowania w URL", () => {
    // adresy sklejane w czasie testu, żeby skaner sekretów nie brał pliku za wyciek
    const url = (pass: string) => ["postgres://user", `${pass}@db:5432/x`].join(":");
    expect(redact(url("tajnehaslo")).text).toBe(url("[REDACTED]"));
  });
  test("dane logowania w wolnym tekście: adres / hasło", () => {
    const r = redact("zaloguj się: jan.nowak@firma.pl / Lato2026!x i sprawdź panel");
    expect(r.text).toBe("zaloguj się: jan.nowak@firma.pl / [REDACTED:login] i sprawdź panel");
    expect(r.hits).toBe(1);
    expect(redact("konto ola@firma.pl /Zx81kqP2").text).toBe("konto ola@firma.pl /[REDACTED:login]");
    // „@” w haśle
    expect(redact("konto ola@firma.pl / KoTeK7@2! i dalej").text).toBe("konto ola@firma.pl / [REDACTED:login] i dalej");
    // drugi przebieg nic nie zmienia
    expect(redact(r.text)).toEqual({ text: r.text, hits: 0 });
    // lista adresów, link, ścieżka w adresie i krótkie słowo zostają
    for (const s of [
      "do jan@firma.pl / ola@firma.pl",
      "repo git@git.example.com/jdoe/hipokamp",
      "https://jan@host.pl/sciezka/dluga",
      "jan@firma.pl / https://panel.firma.pl",
      "jan@firma.pl / tak",
    ])
      expect(redact(s)).toEqual({ text: s, hits: 0 });
  });
  test("<private>", () => {
    expect(stripPrivate("a <private>sekret</private> b")).toBe("a [prywatne] b");
  });
  // pliki-sejfy w konwencjach Arduino, Django i JS: wartości bez znanego prefiksu klucza (sztuczne, składane w locie)
  const WIFI = ["Wifi-", "Pa55", "word-", "Xyz"].join("");
  const DJANGO = ["django-insecure-", "q8w7e6r5t4y3u2i1"].join("");
  const HEX = ["a9f8e7d6c5", "b4a3f2e1d0"].join("");
  test("secrets.h, secrets.py, secrets.js: stałe *_KEY, *_SECRET, *_PASS, *_TOKEN i #define maskowane", () => {
    const files = {
      h: `#pragma once\n#define SECRET_SSID "MyHomeNet"\n#define SECRET_PASS "${WIFI}"\n#  define  API_TOKEN "${HEX}"\n#define STAPSK "${WIFI}"\n`,
      py: `SECRET_KEY = "${DJANGO}"\nDB_URL = "postgres://app@db/x"\nSTRIPE_TOKEN='${HEX}'\n`,
      js: `export const SECRET_KEY = "${HEX}";\nexport const MQTT_PASS = '${WIFI}';\nconst cfg = { APP_SECRET: "${DJANGO}" };\nexport function load() { return 1; }\n`,
    };
    for (const [ext, src] of Object.entries(files)) {
      const r = redact(src);
      for (const v of [WIFI, DJANGO, HEX]) expect([ext, v, r.text.includes(v)]).toEqual([ext, v, false]);
      expect(redact(r.text)).toEqual({ text: r.text, hits: 0 }); // drugi przebieg nic nie zmienia
    }
    // w makrach słowo sekretu w dowolnym miejscu nazwy (konwencja Arduino: SECRET_SSID obok SECRET_PASS)
    expect(redact(files.h).text).toBe(
      '#pragma once\n#define SECRET_SSID "[REDACTED]"\n#define SECRET_PASS "[REDACTED]"\n#  define  API_TOKEN "[REDACTED]"\n#define STAPSK "[REDACTED]"\n',
    );
    const js = redact(files.js).text;
    expect(js).toContain('export const SECRET_KEY = "[REDACTED]";');
    expect(js).toContain("export function load() { return 1; }");
    expect(redact(files.py).text).toContain('DB_URL = "postgres://app@db/x"');
  });

  test("sekrety, których dawne reguły nie łapały: cała wartość ze spacjami, *_KEY z przedrostkiem, PSK, PW, PWD", () => {
    const cases: [string, string][] = [
      ['DB_PASSWORD = "Zielony Kot Skacze 2024"', 'DB_PASSWORD = "[REDACTED]"'],
      [`STRIPE_KEY=${HEX}`, "STRIPE_KEY=[REDACTED]"],
      ['AUTH_KEY = "s3cr3t-Value"', 'AUTH_KEY = "[REDACTED]"'],
      ['CLIENT_KEY: "Zq7vR2mL"', 'CLIENT_KEY: "[REDACTED]"'],
      [`WIFI_PSK = "${WIFI}"`, 'WIFI_PSK = "[REDACTED]"'],
      [`MQTT_PW: '${WIFI}'`, "MQTT_PW: '[REDACTED]'"],
      [`MYSQL_PWD=${WIFI}`, "MYSQL_PWD=[REDACTED]"],
      [`#define WIFI_PSK "${WIFI}"`, '#define WIFI_PSK "[REDACTED]"'],
      [`secret_key = "${DJANGO}"`, 'secret_key = "[REDACTED]"'],
      [`signingKey: '${HEX}'`, "signingKey: '[REDACTED]'"],
    ];
    for (const [input, out] of cases) {
      expect(redact(input).text).toBe(out);
      expect(redact(out)).toEqual({ text: out, hits: 0 });
    }
  });

  test("bez fałszywych trafień: nazwy pól i kluczy pamięci, komunikaty, placeholdery, liczby i stałe szesnastkowe", () => {
    const keep = [
      // *_KEY bez przedrostka sekretu i z wartością, która nie wygląda na wygenerowany klucz
      'export const PROJECT_MERGES_KEY = "project_merges";',
      'const STORAGE_KEY = "hipokamp.viewer.theme";',
      'export const QUERY_KEY = "observations";',
      'const CACHE_KEY = "user-profile-v2";',
      'SORT_KEY = "created_at"',
      'FOREIGN_KEY = "user_id_fk"',
      'I18N_KEY = "auth.password.label"',
      'const SHORTCUT_KEY = "Ctrl+Shift+K";',
      'LOCAL_STORAGE_KEY: "hk-settings",',
      'enum Keys { ARROW_KEY = "ArrowUp" }',
      "PRIMARY_KEY = 'id'",
      "PARTITION_KEY = tenant_id",
      'HOTKEY = "F12"',
      'MONKEY = "banana-split"',
      "KEY: user:1234:session",
      "Sortowanie: SORT_KEY: created_at_desc",
      "https://example.com/api?KEY=abcdef123456&x=1",
      // komunikaty i etykiety pod nazwą hasła
      'ERROR_WRONG_PASSWORD = "Złe hasło, spróbuj ponownie"',
      'MSG_PASSWORD = "Podaj hasło do konta"',
      '"PASSWORD": "Wpisz hasło"',
      'PASSWORD_LABEL = "Hasło"',
      "Klucz API_KEY: patrz README.md#konfiguracja",
      "| SECRET_KEY | wymagany | klucz Django |",
      // wyrażenia po nazwach spoza przypisań (*_KEY bez członu sekretu) i stałe z main (process.env.X, undefined)
      "const masterKey = await deriveKey(password);",
      'STRIPE_KEY = os.environ["STRIPE_KEY"]',
      "API_TOKEN = process.env.API_TOKEN",
      "CACHE_KEY = buildKey(user)",
      "SORT_KEY = Config.SORT_KEY",
      "const API_KEY = undefined;",
      `API_TOKEN: ${["$", "{{ secrets.API_TOKEN }}"].join("")}`,
      `SECRET_KEY = "${["$", "{SECRET_KEY}"].join("")}"`,
      `const FAKE_KEY = \`sk-or-v1-${["$", "{FAKE_TOKEN}"].join("")}\`;`,
      "MASTER_KEY: <twój klucz>",
      "x = y ? KEY : PASS",
      "class TOKEN: pass",
      "PWD=/home/jan/projekt",
      // liczby i makra
      "MAX_TOKENS = 100000000",
      "MAX_TOKENS: 4096",
      "TOKEN_EXPIRY = 3600",
      "KEY_COUNT = 5",
      "#define KEY_MASK 0xFFFF0000",
      "#define KEY_ESCAPE 0x1B",
      "#define KEY_F13 0x00000068",
      "#define KEY_ESCAPE 27",
      "#define TOKEN_MAX_LEN 256",
      "#define TOKEN_BUFFER_SIZE 4096",
      "#define TOKEN_TYPE_IDENT TOKEN_TYPE_BASE + 1",
      "#define PASS_THROUGH(x) (x)",
    ];
    for (const s of keep) expect([s, redact(s).text]).toEqual([s, s]);
    // kod po nazwie sekretu jest maskowany: wyjątki „to kod, nie wartość” dawały wycieki (jak w main, świadomy koszt)
    for (const s of [
      'SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")',
      "secret_key = settings.SECRET_KEY",
      "session_key = request.session.session_key",
      'SESSION_KEY = sessionStorage.getItem("k")',
      "#define SECRET_HANDLER handle_secret_v2",
    ])
      expect([s, redact(s).text.includes("[REDACTED]")]).toEqual([s, true]);
  });

  test("redakcja: złośliwe wejścia po 1 MB liczą się liniowo (clean() jest w hooku, workerze i repair)", () => {
    const MB = 1_000_000;
    const one = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
    const lines = (unit: string) => Array.from({ length: Math.ceil(MB / (unit.length + 1)) }, () => unit).join("\n");
    const best = (s: string) => {
      let min = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        clean(s);
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    // punkt odniesienia: zwykły kod tej samej wielkości; próg 100 ms, przy obciążonej maszynie 4× punkt odniesienia
    // (cofanie kwadratowe to sekundy albo minuty, więc i tak wychodzi)
    const base = best(lines('export const STORAGE_KEY = "hipokamp.viewer.theme"; const x = foo(bar, baz);'));
    const limit = Math.max(100, 4 * base);
    const shapes: [string, string][] = [
      ["#define KEY_KEY_…", `#define ${one("KEY_")}`],
      ["#define A_PASS_PASS_…", `#define A${one("_PASS_")}`],
      ["#define KEY + spacje", `#define KEY${one(" ")}`],
      ["#define KEY_… w liniach", lines(`#define ${"KEY_".repeat(2500)}`)],
      ["KEY_KEY_… bez =", one("KEY_")],
      ["A_A_…KEY bez =", `${one("A_")}KEY`],
      ["spacje", one(" ")],
      ["= × N", one("=")],
      ['KEY="KEY="…', one('KEY="')],
      ['" × N', one('"')],
      ['token=" niedomknięty', `token="${one("x")}`],
      ["token + spacje", `token${one(" ")}x`],
      ["KEY: + spacje", `KEY:${one(" ")}`],
      ["password: × N", one("password: ")],
      ["a.a.a…", one("a.")],
      ["a@b.b.b…", `a@${one("b.")}`],
      ["a.b@a.b@…", one("a.b@")],
      ["x://x://…", one("x://")],
      ["eyJ-eyJ-…", one("eyJ-")],
      ["sk_ hex + g", `sk_${one("a")}g`],
      ["BEGIN PRIVATE KEY bez END", one(`${PEM_HEAD}\n`)],
      ["<private> bez zamknięcia", one("<private>")],
      [
        "mieszanka sekretów",
        lines('#define API_KEY "abc123def456ghi789" password = "Zielony Kot" jan@host.pl / Haslo123! eyJabc'),
      ],
    ];
    for (const [label, s] of shapes) {
      const ms = best(s);
      expect([label, ms < limit]).toEqual([label, true]);
    }
  });

  test("klucz PEM bez END: nagłówek i linie base64 maskowane, tekst dalej zostaje", () => {
    const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj"].join("\n");
    const r = redact(`przed\n${PEM_HEAD}\n${body}\n\nza kluczem`);
    expect(r.text).toBe("przed\n[REDACTED:private-key]\n\nza kluczem");
    expect(stripPrivate("a <private>x</private> b <PRIVATE>y</Private> c <private>bez końca")).toBe(
      "a [prywatne] b [prywatne] c <private>bez końca",
    );
  });
});

describe("fts", () => {
  test("prefiksy dla polskiej fleksji", () => {
    const m = buildMatch("zakleszczenie portu workera")!;
    expect(m).toContain('"zakleszcz');
    expect(m).toContain("OR");
  });
  test("pomija stop-słowa i znaki specjalne", () => {
    expect(buildMatch("i a ale")).toBeNull();
    expect(buildMatch('co "z" (tym) * AND NOT')).toBeNull();
    expect(buildMatch('port "37777" (watchdog) * AND')).not.toContain("(");
  });
});

describe("transcript", () => {
  const L = (json: any, i: number): Line => ({ json, start: i * 100, end: i * 100 + 99 });
  test("prompt vs tool_result vs szum", () => {
    expect(promptOf({ type: "user", message: { content: "napraw port" } })?.kind).toBe("human");
    expect(promptOf({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x" }] } })).toBeNull();
    expect(promptOf({ type: "user", isMeta: true, message: { content: "x" } })).toBeNull();
    expect(
      promptOf({ type: "user", message: { content: "<command-name>/graphify</command-name><command-args>.</command-args>" } })
        ?.text,
    ).toBe("/graphify .");
  });
  test("grupowanie tur i wyniki narzędzi", () => {
    // katalog projektu bez repo git nad nim; na POSIX `D:/code/x` nie byłby bezwzględny (resolve() położyłby go w
    // katalogu procesu, a gitRoot znalazłby .git checkoutu testów)
    const X = process.platform === "win32" ? "D:/code/x" : "/hipokamp-test-brak/x";
    const lines = [
      L({ type: "user", uuid: "u1", timestamp: "2026-10-04T10:00:00Z", cwd: X, message: { content: "dodaj test" } }, 0),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:05Z",
          message: {
            model: "m",
            content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: `${X}/a.test.ts` } }],
          },
        },
        1,
      ),
      L(
        {
          type: "user",
          timestamp: "2026-10-04T10:00:06Z",
          toolUseResult: { type: "create", filePath: `${X}/a.test.ts` },
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        },
        2,
      ),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:09Z",
          message: { content: [{ type: "text", text: "Dodałem test a.test.ts dla modułu sesji." }] },
        },
        3,
      ),
      L({ type: "user", uuid: "u2", timestamp: "2026-10-04T10:01:00Z", message: { content: "dzięki" } }, 4),
    ];
    const { turns, consumedTo } = groupTurns(lines, "s1", { final: false });
    expect(turns.length).toBe(1);
    expect(consumedTo).toBe(400); // druga tura w toku zostaje
    expect(turns[0].tools[0].structured?.type).toBe("create");
    const d = digestTurn(turns[0], { project: "x", n: 1, privateTools: [], maxNarrativeChars: 1200 });
    expect(d.skip).toBe(false);
    expect(d.obs.type).toBe("feature");
    expect(d.obs.files_modified).toEqual(["a.test.ts"]);
    expect(d.obs.title).toContain("Dodałem test");
  });

  test("zadanie cykliczne to komenda, nie słowa człowieka", () => {
    const p = promptOf({
      type: "user",
      origin: { kind: "human" },
      message: { content: '<scheduled-task name="focus-poranny" file="C:\\x\\SKILL.md">\nThis is an automated run…' },
    });
    expect(p?.kind).toBe("command");
    expect(p?.text).toBe("Zadanie cykliczne: focus-poranny");
  });

  test("powiadomienie o zadaniu w tle: tytuł z odpowiedzi, nie z XML-a", () => {
    const note =
      '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:\\t\\b1.output</output-file>\n<status>completed</status>\n<summary>Background command "Run lint and tests" completed (exit code 0)</summary>\n</task-notification>';
    expect(notificationText(note)).toBe('Background command "Run lint and tests" completed (exit code 0)');
    expect(notificationText("<task-notification><task-id>b2</task-id><event>NOWA 09:06</event></task-notification>")).toBe(
      "NOWA 09:06",
    );
    const lines = [
      L(
        {
          type: "user",
          uuid: "n1",
          origin: { kind: "task-notification" },
          timestamp: "2026-10-04T10:00:00Z",
          message: { content: note },
        },
        0,
      ),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:03Z",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git log -1" } }] },
        },
        1,
      ),
      L(
        {
          type: "user",
          timestamp: "2026-10-04T10:00:04Z",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "abc123" }] },
        },
        2,
      ),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:06Z",
          message: { content: [{ type: "text", text: "Lint i testy przeszły, commit abc123 jest na main." }] },
        },
        3,
      ),
    ];
    const { turns } = groupTurns(lines, "s1", { final: true });
    const d = digestTurn(turns[0], { project: "x", n: 1, privateTools: [], maxNarrativeChars: 1200 });
    expect(d.obs.title).toContain("Lint i testy przeszły");
    expect(d.obs.title).not.toContain("<");
    expect(d.obs.subtitle).toBe('Powiadomienie: Background command "Run lint and tests" completed (exit code 0)');
    expect(d.obs.narrative).not.toContain("task-id");
  });

  test("komunikat o braku kredytów nie jest odpowiedzią", () => {
    const lines = [
      L(
        { type: "user", uuid: "u1", timestamp: "2026-10-04T10:00:00Z", message: { content: "zbuduj aplikację i odpal testy" } },
        0,
      ),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:03Z",
          message: { content: [{ type: "text", text: "Kompiluję teraz, shadery waliduję równolegle przez fxc." }] },
        },
        1,
      ),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:05Z",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cmake --build build" } }] },
        },
        2,
      ),
      L(
        {
          type: "user",
          timestamp: "2026-10-04T10:00:09Z",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        },
        3,
      ),
      L(
        {
          type: "assistant",
          timestamp: "2026-10-04T10:00:10Z",
          message: {
            content: [
              {
                type: "text",
                text: "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage, to continue.",
              },
            ],
          },
        },
        4,
      ),
    ];
    const { turns } = groupTurns(lines, "s1", { final: true });
    const d = digestTurn(turns[0], { project: "x", n: 1, privateTools: [], maxNarrativeChars: 1200 });
    expect(d.obs.title).not.toContain("usage credits");
    expect(d.obs.narrative).not.toContain("usage credits");
  });
});

describe("text", () => {
  test("headline pomija ogólniki", () => {
    expect(headline("Gotowe.\n\nNaprawiłem zakleszczenie portu 37777 w watchdogu.")).toContain("Naprawiłem");
  });
  test("truncate na granicy słowa", () => {
    expect(truncate("ala ma kota i psa", 10).endsWith("…")).toBe(true);
    expect(estimateTokens("abcdefghij")).toBe(4);
  });
});

describe("wektory", () => {
  test("kwantyzacja i bity", () => {
    const v = new Float32Array([0.5, -0.5, 0, 1, -1, 0.1, -0.1, 0.9, 0.2]);
    const q = toQ8(v);
    expect(q[0]).toBe(64);
    expect(q[4]).toBe(-127);
    const b = toBits(v);
    expect(b.length).toBe(2);
    expect(b[0] & 1).toBe(1);
    expect((b[0] >> 1) & 1).toBe(0);
  });
});

describe("aktywacja", () => {
  test("świeże > stare, częste > rzadkie", () => {
    const now = Date.now();
    const day = 86_400_000;
    const fresh = baseLevel([{ at: now - day, w: 1 }], now);
    const old = baseLevel([{ at: now - 100 * day, w: 1 }], now);
    const often = baseLevel(
      [
        { at: now - 100 * day, w: 1 },
        { at: now - 2 * day, w: 1 },
        { at: now - 5 * day, w: 1 },
      ],
      now,
    );
    expect(fresh).toBeGreaterThan(old);
    expect(often).toBeGreaterThan(old);
  });
});

describe("work state", () => {
  test("najnowsza wartość wygrywa, done zamyka", () => {
    const lists = foldWorkState([
      { list_name: "v1", fields: { task: "A", status: "todo" }, created_at: 1 },
      { list_name: "v1", fields: { task: "A", status: "done" }, created_at: 2 },
      { list_name: "v1", fields: { task: "B", status: "doing", note: "x" }, created_at: 3 },
      { list_name: "v1", fields: { owner: "ja" }, created_at: 4 },
      { list_name: "v1", fields: { owner: null }, created_at: 5 },
      { list_name: "old", fields: { status: "done" }, created_at: 6 },
    ]);
    const v1 = lists.find((l) => l.name === "v1")!;
    expect(v1.items.find((i) => i.task === "A")?.status).toBe("done");
    expect(v1.items.find((i) => i.task === "B")?.fields.note).toBe("x");
    expect(v1.state.owner).toBeUndefined();
    expect(lists.find((l) => l.name === "old")?.closed).toBe(true);
  });
});

describe("selekcja pod budżet", () => {
  test("mieści się w budżecie i unika duplikatów", () => {
    const mk = (id: number, title: string, score: number, tokens: number) =>
      ({ obs: { id, title, session_id: `s${id}`, prompt_n: 1 } as any, score, tokens, why: [] }) as any;
    const out = selectUnderBudget(
      [
        mk(1, "port zakleszczony watchdog", 0.9, 40),
        mk(2, "port zakleszczony watchdog", 0.89, 40),
        mk(3, "stripe webhook checkout", 0.6, 40),
      ],
      { budget: 85, diversity: 0.9 },
    );
    expect(out.reduce((s: number, c: any) => s + c.tokens, 0)).toBeLessThanOrEqual(85);
    expect(out.map((c: any) => c.obs.id)).toContain(3);
  });
});

describe("FTS i polskie litery", () => {
  test("zapytanie bez ogonków trafia w słowa z ł, ą, ó", async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { Repo } = await import("../src/db/repo.ts");
    const { ftsSearch } = await import("../src/index/fts.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const { id } = repo.insertObservation({
      session_id: null,
      project: "p",
      type: "bugfix",
      title: "Naprawiono błąd wyłączania workera w Łodzi",
      created_at: Date.now(),
      source: "digest",
    });
    for (const q of ["blad", "błąd", "wylaczania", "lodzi"]) expect(ftsSearch(repo.db, q).map((h) => h.id)).toContain(id);
  });
});

describe("podsumowanie kompakcji", () => {
  test("sekcje streszczenia trafiają w pola podsumowania", async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { Repo } = await import("../src/db/repo.ts");
    const { storeCompactSummary } = await import("../src/capture/summary.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const text = [
      "This session is being continued from a previous conversation that ran out of context.",
      "Summary:",
      "1. Primary Request and Intent:",
      "   Zbudować darmowy zamiennik claude-mem.",
      "2. Key Technical Concepts:",
      "   - FTS5 i wektory bge-m3",
      "7. Pending Tasks:",
      "   - napisać serwer MCP",
      "8. Current Work:",
      "   Import bazy claude-mem.",
    ].join("\n");
    const id = storeCompactSummary(repo, "s1", "p", { text, at: 1000, start: 42 });
    expect(id).toBeGreaterThan(0);
    expect(storeCompactSummary(repo, "s1", "p", { text, at: 1000, start: 42 })).toBeNull();
    const [s] = repo.recentSummaries("p", 5);
    expect(s.request).toContain("zamiennik claude-mem");
    expect(s.learned).toContain("bge-m3");
    expect(s.next_steps).toContain("serwer MCP");
    expect(s.completed).toContain("Import bazy");
  });
});

describe("stop-słowa po normalizacji", () => {
  test("się, już, może, będzie bez ogonków nie trafiają do zapytania", () => {
    const m = buildMatch("czy już się udało, może będzie też jeśli który był więc właśnie")!;
    for (const w of ["juz", "sie", "moze", "bedzie", "tez", "jesli", "ktory", "byl", "wiec", "wlasnie"])
      expect(m).not.toContain(`"${w}"`);
    expect(m).toContain('"udalo"');
  });
});

describe("oś czasu", () => {
  test("notatki z tym samym czasem co kotwica są widoczne, ujemne limity to zero", async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { Repo } = await import("../src/db/repo.ts");
    const { timeline } = await import("../src/recall/timeline.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const at = Date.now() - 1000;
    const mk = (title: string) =>
      repo.insertObservation({ session_id: null, project: "p", type: "change", title, created_at: at, source: "digest" }).id;
    const [x, y, z] = [mk("pierwsza notatka o porcie"), mk("druga notatka o bazie"), mk("trzecia notatka o hookach")];
    const t = timeline(repo, { anchor: y, before: 5, after: 5, withPrompts: false, withSummaries: false });
    expect(t.items.map((i) => (i.kind === "observation" ? i.obs.id : -1))).toEqual([x, y, z]);
    const none = timeline(repo, { anchor: y, before: -1, after: -1, withPrompts: false, withSummaries: false });
    expect(none.items.length).toBe(1);
  });
});

describe("search: sesje i prompty", () => {
  test("zakres dat, kierunek i przesunięcie liczy SQL", async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { Repo } = await import("../src/db/repo.ts");
    const { ftsSearchPrompts } = await import("../src/index/fts.ts");
    const { storeCompactSummary } = await import("../src/capture/summary.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 5, 1);
    for (let i = 0; i < 30; i++)
      repo.insertPrompt({
        session_id: `S${i + 1}`,
        project: "p",
        n: 1,
        text: `wdrożenie serwera numer ${i + 1}`,
        created_at: t0 + i * day,
        source: "live",
      });
    expect(repo.listPrompts({ project: "p", since: t0 + 4 * day, until: t0 + 9 * day, limit: 50 }).length).toBe(6);
    expect(repo.listPrompts({ project: "p", asc: true, limit: 2 }).map((p) => p.text)).toEqual([
      "wdrożenie serwera numer 1",
      "wdrożenie serwera numer 2",
    ]);
    expect(repo.listPrompts({ project: "p", limit: 5, offset: 5 })[0].text).toBe("wdrożenie serwera numer 25");
    const hits = ftsSearchPrompts(repo.db, "wdrożenie serwera", {
      project: "p",
      since: t0 + 4 * day,
      until: t0 + 9 * day,
      order: "date_asc",
      limit: 3,
      offset: 1,
    });
    const texts = hits.map((h) => (repo.db.query("SELECT text FROM prompts WHERE id = ?").get(h.id) as { text: string }).text);
    expect(texts).toEqual(["wdrożenie serwera numer 6", "wdrożenie serwera numer 7", "wdrożenie serwera numer 8"]);

    const text = ["Summary:", "1. Primary Request and Intent:", "   Wdrożenie serwera."].join("\n");
    for (let i = 0; i < 5; i++) storeCompactSummary(repo, `S${i + 1}`, "p", { text, at: t0 + i * day, start: i });
    const sums = repo.listSummaries({ project: "p", since: t0 + day, until: t0 + 3 * day, asc: true, limit: 10 });
    expect(sums.map((s) => s.created_at)).toEqual([t0 + day, t0 + 2 * day, t0 + 3 * day]);
  });
});

describe("prompty tur: numer zastępczy", () => {
  test("zajęty numer: prompt w zakresie zastępczym (T-29); drugi odczyt tej samej tury bez drugiego wiersza", async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { PROMPT_SUBST_BASE, Repo } = await import("../src/db/repo.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const t0 = Date.UTC(2026, 9, 1, 8);
    const base = { session_id: "S", project: "p" };
    repo.insertPrompt({ ...base, n: 1, text: "pobudka pętli", created_at: t0, source: "claude-mem" });
    repo.insertPrompt({ ...base, n: 2, text: "wiadomość agenta", created_at: t0 + 1000, source: "claude-mem" });
    // tura 1 z transkryptu: numer 1 zajęty przez prompt innej tury, więc pod numerem zastępczym z osobnego zakresu
    // (numery dalszych tur zostają wolne)
    const a = repo.insertTurnPrompt({ ...base, n: 1, text: "napraw kolejkę", created_at: t0 + 2000, source: "live" });
    expect(a.n).toBe(PROMPT_SUBST_BASE + 1);
    // ten sam prompt czytany drugi raz (np. inny offset tej samej historii): ten sam wiersz
    expect(repo.insertTurnPrompt({ ...base, n: 1, text: "napraw kolejkę", created_at: t0 + 2000, source: "live" })).toEqual(a);
    // ten sam tekst godzinę później to nowa wypowiedź
    const b = repo.insertTurnPrompt({ ...base, n: 2, text: "napraw kolejkę", created_at: t0 + 3_600_000, source: "live" });
    expect(b.n).toBe(PROMPT_SUBST_BASE + 2);
    // wolny numer: bez zmian (dawniej numery zastępcze 3 i 4 zajmowały numery tur 3 i 4)
    expect(repo.insertTurnPrompt({ ...base, n: 3, text: "dodaj test", created_at: t0 + 3_700_000, source: "live" }).n).toBe(3);
    const rows = repo.db.query("SELECT n, text FROM prompts WHERE session_id = 'S' ORDER BY n").all();
    expect(rows).toEqual([
      { n: 1, text: "pobudka pętli" },
      { n: 2, text: "wiadomość agenta" },
      { n: 3, text: "dodaj test" },
      { n: PROMPT_SUBST_BASE + 1, text: "napraw kolejkę" },
      { n: PROMPT_SUBST_BASE + 2, text: "napraw kolejkę" },
    ]);
  });

  test("numery spoza zakresu tur: czytelne etykiety w MCP, w CLI i w podglądzie (te same zakresy)", async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { PROMPT_CM_BASE, PROMPT_SUBST_BASE, Repo } = await import("../src/db/repo.ts");
    const { obsJson, obsMarkdown, promptLabel, promptLine, timelineMarkdown } = await import("../src/mcp/format.ts");
    const load = (path: string): Promise<any> => import(path);
    const viewer = await load("../viewer/prompt-number.js");
    const { DICTS } = await load("../viewer/i18n/index.js");
    const { createI18n } = await load("../viewer/i18n.js");
    // jedno źródło zakresów dla bazy, serwera i podglądu
    expect([viewer.PROMPT_SUBST_BASE, viewer.PROMPT_CM_BASE]).toEqual([PROMPT_SUBST_BASE, PROMPT_CM_BASE]);
    expect(viewer.promptRef(7)).toEqual({ kind: "turn", n: 7 });
    expect(viewer.promptRef(PROMPT_SUBST_BASE + 3)).toEqual({ kind: "subst", n: 3 });
    expect(viewer.promptRef(PROMPT_CM_BASE + 4)).toEqual({ kind: "cm", n: 4 });

    expect(promptLabel(7)).toBe("prompt 7");
    expect(promptLabel(PROMPT_SUBST_BASE + 3)).toBe("prompt 3 (numer zastępczy)");
    expect(promptLabel(PROMPT_CM_BASE + 4)).toBe("bez tury (claude-mem nr 4)");

    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const at = Date.UTC(2026, 9, 1, 8);
    const ins = (prompt_n: number) =>
      repo.insertObservation({
        session_id: "S",
        project: "p",
        type: "change",
        title: "notatka",
        prompt_n,
        created_at: at,
        source: "claude-mem",
      }).id;
    const cm = repo.getObservation(ins(PROMPT_CM_BASE + 4))!;
    const own = repo.getObservation(ins(5))!;
    expect(obsMarkdown(cm)).toContain("· bez tury (claude-mem nr 4)");
    expect(obsMarkdown(cm)).not.toContain(String(PROMPT_CM_BASE + 4));
    expect(obsMarkdown(own)).toContain("· prompt 5");
    // JSON: liczba bez zmian (zgodność z claude-mem), etykieta obok tylko dla numerów spoza zakresu tur
    expect(obsJson(cm)).toMatchObject({ prompt_number: PROMPT_CM_BASE + 4, prompt_label: "bez tury (claude-mem nr 4)" });
    expect(obsJson(own).prompt_label).toBeUndefined();
    const p = { id: 9, project: "p", n: PROMPT_SUBST_BASE + 2, text: "napraw", created_at: at };
    expect(promptLine(p)).toContain("[prompt 2 (numer zastępczy)]");
    expect(
      timelineMarkdown([{ kind: "prompt", id: 9, project: "p", n: PROMPT_CM_BASE + 1, text: "x", at } as any], { title: "t" }),
    ).toContain("[bez tury (claude-mem nr 1)]");

    // podgląd: etykiety w obu językach
    for (const [lang, want] of [
      [
        "pl",
        ["Tura 3 (numer zastępczy)", "Bez tury (claude-mem nr 4)", "tura 3 (numer zastępczy)", "bez tury (claude-mem nr 4)"],
      ],
      [
        "en",
        ["Turn 3 (substitute number)", "No turn (claude-mem no. 4)", "turn 3 (substitute number)", "no turn (claude-mem no. 4)"],
      ],
    ] as const) {
      const i = createI18n(lang, DICTS);
      const plain = (s: string) => s.replace(/ /g, " ");
      expect(
        ["session.turnSubst", "session.turnNone", "note.turnSubst", "note.turnNone"].map((k, j) =>
          plain(i.t(k, { n: j % 2 ? 4 : 3 })),
        ),
      ).toEqual([...want]);
    }
    // app.js nie pokazuje surowego numeru tury: wszystkie miejsca idą przez turnLabel
    const app = (await Bun.file(new URL("../viewer/app.js", import.meta.url)).text()).replace(/^\s*\/\/.*$/gm, "");
    expect(app).not.toMatch(/t\("(?:note|session)\.turn", \{ n: (?:o\.prompt_n|n) \}\)/);
    expect(app).not.toContain("String(o.prompt_n) : null");
  });
});

describe("kontekst: budżet i liczba notatek", () => {
  const seedRepo = async () => {
    const { openDb } = await import("../src/db/db.ts");
    const { Repo } = await import("../src/db/repo.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const now = Date.now();
    for (let i = 0; i < 60; i++)
      repo.insertObservation({
        session_id: null,
        project: "demo",
        type: "change",
        title: `Zmiana numer ${i} w module eksportu`,
        narrative: "opis zmiany ".repeat(20),
        facts: ["pierwszy fakt ".repeat(8), "drugi fakt ".repeat(8), "trzeci fakt ".repeat(8), "czwarty fakt ".repeat(8)],
        created_at: now - i * 60_000,
        source: "backfill",
      });
    return repo;
  };

  test("start sesji: notatki w indeksie liczone po koszcie wiersza, tekst zawsze w budżecie", async () => {
    const { sessionStartContext } = await import("../src/recall/context.ts");
    const repo = await seedRepo();
    const big = await sessionStartContext(repo, null, { project: "demo", budget: 1600, record: false });
    expect(estimateTokens(big.text)).toBeLessThanOrEqual(1600);
    // pełny koszt dla każdej kandydatki dawał ok. 12 notatek; indeks mieści ich znacznie więcej
    expect(big.ids.length).toBeGreaterThanOrEqual(20);
    const costs = Object.values(big.costs ?? {});
    expect(costs.length).toBe(big.ids.length);
    expect(Math.max(...costs)).toBeGreaterThan(Math.min(...costs) * 2);
    for (const budget of [400, 250]) {
      const r = await sessionStartContext(repo, null, { project: "demo", budget, record: false });
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(budget);
    }
  });

  test("start sesji: dużo list pracy nie rozsadza budżetu", async () => {
    const { sessionStartContext } = await import("../src/recall/context.ts");
    const repo = await seedRepo();
    for (let l = 0; l < 30; l++) {
      repo.appendWorkState("demo", `lista-${l}`, { cel: "długi opis celu tej listy ".repeat(4), etap: "w toku" });
      for (let t = 0; t < 3; t++)
        repo.appendWorkState("demo", `lista-${l}`, { task: `zadanie ${t} z listy ${l} `.repeat(4), status: "todo" });
    }
    const r = await sessionStartContext(repo, null, { project: "demo", budget: 1600, record: false });
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(1600);
    expect(r.text).toContain("work_state_read");
    expect(r.ids.length).toBeGreaterThan(0);
  });

  test("prompt: pierwsza notatka z faktami kosztuje więcej, reszta po wierszu, całość w budżecie", async () => {
    const { promptContext } = await import("../src/recall/context.ts");
    const { loadConfig } = await import("../src/config.ts");
    const repo = await seedRepo();
    const r = await promptContext(repo, null, {
      project: "demo",
      sessionId: "s-test",
      prompt: "zmiana w module eksportu, numer 3 i numer 4",
      preview: true,
    });
    expect(r?.ids.length ?? 0).toBeGreaterThan(1);
    expect(estimateTokens(r!.text)).toBeLessThanOrEqual(loadConfig().context.promptBudget);
    const costs = r!.ids.map((id) => r!.costs?.[id] ?? 0);
    expect(costs[0]).toBeGreaterThan(costs[1] * 2);
  });
});

describe("klucz projektu (zgodny z claude-mem)", () => {
  test("repo, podkatalog, worktree, znacznik, korzeń dysku, pusty katalog", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { projectFromCwd, UNKNOWN_PROJECT } = await import("../src/util/paths.ts");
    const base = mkdtempSync(join(tmpdir(), "hipokamp-test-proj-"));
    try {
      const repoDir = join(base, "Sklep");
      mkdirSync(join(repoDir, ".git", "worktrees", "feat-x"), { recursive: true });
      mkdirSync(join(repoDir, "frontend", "lib"), { recursive: true });
      const wt = join(repoDir, ".claude", "worktrees", "feat-x");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(repoDir, ".git", "worktrees", "feat-x")}\n`);
      expect(projectFromCwd(repoDir)).toBe("Sklep");
      expect(projectFromCwd(join(repoDir, "frontend", "lib"))).toBe("Sklep");
      // claude-mem: Sklep/feat-x; w hipokampie worktree dzieli pamięć z repo
      expect(projectFromCwd(wt)).toBe("Sklep");
      const loose = join(base, "luzem", "Klient", "materialy");
      mkdirSync(loose, { recursive: true });
      expect(projectFromCwd(loose)).toBe("materialy");
      writeFileSync(join(base, "luzem", "Klient", ".claude-mem-project"), "");
      expect(projectFromCwd(loose)).toBe("Klient");
      expect(projectFromCwd("")).toBe(UNKNOWN_PROJECT);
      expect(projectFromCwd("   ")).toBe(UNKNOWN_PROJECT);
      if (process.platform === "win32") expect(projectFromCwd("C:\\")).toBe("drive-C");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("alias starszej reguły liczony od nowa tylko dla istniejącego katalogu", async () => {
    const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDb } = await import("../src/db/db.ts");
    const { Repo } = await import("../src/db/repo.ts");
    const { normPath, PROJECT_RULE, UNKNOWN_PROJECT } = await import("../src/util/paths.ts");
    const repo = new Repo(openDb({ path: ":memory:", vectors: false }));
    const base = mkdtempSync(join(tmpdir(), "hipokamp-test-alias-"));
    try {
      const dir = join(base, "Nowy");
      mkdirSync(dir);
      const gone = join(base, "usuniety-worktree");
      const key = (p: string) => normPath(p).toLowerCase();
      const add = repo.db.prepare("INSERT INTO project_aliases (cwd, project, source, seen_at) VALUES (?, ?, 'rule', 0)");
      add.run(key(dir), "stary");
      add.run(key(gone), "Repo");
      repo.setProjectAlias(join(base, "z-claude-mem"), "Inny");
      expect(repo.resolveProject(dir)).toBe("Nowy");
      const row = repo.db.query("SELECT source FROM project_aliases WHERE cwd = ?").get(key(dir)) as { source: string };
      expect(row.source).toBe(PROJECT_RULE);
      expect(repo.resolveProject(gone)).toBe("Repo");
      expect(repo.resolveProject(join(base, "z-claude-mem"))).toBe("Inny");
      expect(repo.resolveProject("")).toBe(UNKNOWN_PROJECT);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("otwieranie zajętej bazy", () => {
  const busy = (code: string) => Object.assign(new Error("database is locked"), { code });

  test("rozpoznaje rodzinę SQLITE_BUSY i komunikat, nie inne błędy", () => {
    expect(isBusyError(busy("SQLITE_BUSY_RECOVERY"))).toBe(true);
    expect(isBusyError(busy("SQLITE_BUSY"))).toBe(true);
    expect(isBusyError(new Error("SQLiteError: database is locked"))).toBe(true);
    expect(isBusyError(Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });

  test("ponawia przy SQLITE_BUSY_RECOVERY, przerwy rosną", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const r = retryBusy(
      () => {
        if (++calls < 3) throw busy("SQLITE_BUSY_RECOVERY");
        return "ok";
      },
      10_000,
      (ms) => sleeps.push(ms),
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  test("inny błąd i budżet 0 kończą od razu", () => {
    let calls = 0;
    const ioerr = () => {
      calls++;
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    };
    expect(() => retryBusy(ioerr, 10_000, () => {})).toThrow("disk I/O error");
    expect(calls).toBe(1);
    calls = 0;
    const locked = () => {
      calls++;
      throw busy("SQLITE_BUSY");
    };
    expect(() => retryBusy(locked, 0, () => {})).toThrow("database is locked");
    expect(calls).toBe(1);
  });
});
