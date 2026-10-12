// T-36: clean() ma być idempotentne (clean(clean(x)) === clean(x)), bo `hipokamp repair` przepuszcza przez nie całą
// bazę i każda różnica to rekord przepisany jeszcze raz. Kształty znalezione fuzzerem plus deterministyczny fuzzer
// z ziarnem: wejścia sklejone z kawałków, które wchodzą w interakcje reguł (znaczniki obu przebiegów, opcje CLI,
// stałe, <private>, litery spoza ASCII przy \b).
import { describe, expect, test } from "bun:test";
import { clean } from "../src/capture/redact";

const KEY = "sk-AbCdEfGhIjKlMnOpQrStUv12";

describe("clean(): idempotencja (T-36)", () => {
  const cases = [
    "--password <private>x</private>",
    "--token <private>abc</private>",
    `-u ł${KEY}`,
    `-u ł${KEY}:hasloXy12`,
    "-u ł[REDACTED:openai-key]",
    "-u admin:<private>x</private>",
    "WIFI_PSK=<private>x</private>",
    "#define SECRET_PASS <private>x</private>",
    "sshpass -p <private>x</private> ssh host",
    "Server=x;Pwd=<private>x</private>",
    "redis://sk-AbCdEfGhIjKlMnOpQrStUv12@host",
    // kaskada: maska curl skraca wartość stałej *_pwd
    " --user mysql_pwd=::a",
    "mysql_pwd=?sig=;Pwd=[REDACTED:openai-key]",
  ];
  for (const c of cases)
    test(JSON.stringify(c), () => {
      const once = clean(c);
      expect(clean(once)).toBe(once);
    });

  test("poprawka nie zostawia hasła za zamaskowanym użytkownikiem ani za <private>", () => {
    expect(clean(`curl -u ł${KEY}:hasloXy12 x`)).not.toContain("hasloXy12");
    expect(clean("x --password <private>a</private>bcdef9")).not.toContain("bcdef9");
    expect(clean("x -u [REDACTED:github-token]:hasloXy12")).not.toContain("hasloXy12");
    expect(clean("x -u ab[c:hasloXy12")).not.toContain("hasloXy12");
  });
});

describe("clean(): znaczniki rozcinające sekret (recenzja PR #25)", () => {
  // sklejane w czasie testu, żeby skaner sekretów w repo nie brał ich za token
  const P = `sk-${"ant"}-`;
  const BODY = "api03-AbCdEfGhIjKlMnOpQrStUvWx";
  const cases: [string, string][] = [
    [`Ustaw klucz \`${P}\`${BODY}\``, "Ustaw klucz `[REDACTED:anthropic-key]`"],
    [`Ustaw klucz **${P}**${BODY}`, "Ustaw klucz **[REDACTED:anthropic-key]"],
    [`klucz __${P}__${BODY} koniec`, "klucz __[REDACTED:anthropic-key] koniec"],
    [`klucz ~~${P}~~${BODY} koniec`, "klucz ~~[REDACTED:anthropic-key] koniec"],
    [`klucz ${P}api03-AbCd<private>x</private>EfGhIjKlMnOpQrStUvWx koniec`, "klucz [REDACTED:anthropic-key] koniec"],
    // znacznik z wejścia przed i w środku sekretu
    ["password=[REDACTED]hunter2Xy9 x", "password=[REDACTED][REDACTED] x"],
    [`${P}api03-AbCdEfG[REDACTED]hIjKlMnOpQrStUvWx koniec`, "[REDACTED:anthropic-key] koniec"],
  ];
  for (const [s, out] of cases)
    test(JSON.stringify(s), () => {
      expect(clean(s)).toBe(out);
      expect(clean(out)).toBe(out);
      expect(clean(s)).not.toContain("hIjKlMnOp");
    });

  test("zwykły Markdown i znaczniki przy odstępach zostają bez zmian", () => {
    for (const s of [
      "zwykły `kod` i **pogrubienie** oraz __init__ i ~~skreślenie~~",
      "a [REDACTED] b [prywatne] c",
      "token=[REDACTED] następnie dalej",
      'SECRET_KEY = [REDACTED]"SECRET_KEY"]',
      // proza o kodzie: seria przy interpunkcji nie jest wnętrzem tokenu
      "`password`: `string`",
      "`ANTHROPIC_AUTH_TOKEN`: bezpośrednie",
      "`key_hash` = sha256",
    ])
      expect(clean(s)).toBe(s);
  });

  test("blok <private> w odwrotnych apostrofach zostaje [prywatne]", () => {
    expect(clean("(`<private>tajne</private>`, dalej")).toBe("(`[prywatne]`, dalej");
    expect(clean("x `<private>tajne</private>`b y")).toBe("x `[prywatne]`b y");
    expect(clean("**<private>tajne</private>**, dalej")).toBe("**[prywatne]**, dalej");
  });
});

describe("clean(): czas na kształtach ze znacznikami (recenzja PR #25)", () => {
  test("255 KB i 1 MB znaczników, Markdownu i <private> liczą się jak zwykły tekst", () => {
    const one = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const best = (s: string) => {
      let min = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        clean(s);
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    for (const n of [30_000, 255_000, 1_000_000]) {
      // punkt odniesienia: zwykły kod tej samej wielkości; próg jak w test/unit.test.ts (100 ms albo 4× odniesienie)
      const base = best(one('export const STORAGE_KEY = "hipokamp.viewer.theme"; const x = foo(bar, baz);\n', n));
      const limit = Math.max(100, 4 * base);
      for (const u of [
        "[REDACTED]",
        "[REDACTED] ",
        "[REDACTED]x",
        "x[REDACTED]x ",
        "[prywatne]a",
        "**x",
        "`a`b",
        "a**b**c ",
        "<private>x</private>y",
        "password=[REDACTED]x ",
      ]) {
        const ms = best(one(u, n));
        expect([n, u, ms < limit]).toEqual([n, u, true]);
      }
    }
  });
});

// mulberry32: szybki, deterministyczny
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  " ",
  " ",
  "\n",
  "ł",
  "ż",
  "x",
  "a",
  "_",
  "-",
  ":",
  "=",
  ";",
  "/",
  "|",
  "@",
  '"',
  "'",
  "\\",
  "[",
  "]",
  "<private>",
  "</private>",
  "[prywatne]",
  "[REDACTED]",
  "[REDACTED:openai-key]",
  "`",
  "**",
  "__",
  "~~",
  "sk-ant-",
  "api03-AbCdEfGhIjKlMnOpQrStUvWx",
  KEY,
  // sklejane w czasie testu: wartość taka sama, a skanery sekretów w repo nie biorą jej za token
  `ghp${"_"}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`,
  `eyJhbGciOiJIUzI1NiJ9${"."}eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlMTI`,
  "Bearer ",
  "hasloXy12",
  "Zq9#kL2$",
  "abcdef",
  "123456",
  "--password ",
  "--token ",
  "-u ",
  " --user ",
  "sshpass -p ",
  ";Pwd=",
  "password=",
  "password: ",
  "token=",
  "api_key=",
  "WIFI_PSK=",
  "STRIPE_KEY=",
  "mysql_pwd=",
  "#define SECRET_PASS ",
  "https://",
  "redis://",
  "?sig=",
  "ala@firma.pl",
  " / ",
];

describe("clean(): fuzzer idempotencji (T-36)", () => {
  test("30 tys. wejść z ziarnem: clean(clean(x)) === clean(x)", () => {
    const next = rng(0x7e36);
    const bad: string[] = [];
    for (let n = 0; n < 30_000; n++) {
      const len = 1 + Math.floor(next() * 7);
      let s = "";
      for (let k = 0; k < len; k++) s += PIECES[Math.floor(next() * PIECES.length)];
      const once = clean(s);
      if (clean(once) !== once && bad.length < 10)
        bad.push(`${JSON.stringify(s)} → ${JSON.stringify(once)} → ${JSON.stringify(clean(once))}`);
    }
    expect(bad).toEqual([]);
  });
});
