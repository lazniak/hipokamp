// Test lokalizacji podglądu: wybór języka, silnik tłumaczeń, zgodność słowników PL i EN,
// pokrycie kluczy użytych w kodzie oraz brak polskich literałów w kodzie widoków.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// moduły widoku to czysty JS bez deklaracji typów: ładujemy je dynamicznie, jako any
const load = (path: string): Promise<any> => import(path);
const { DICTS } = await load("../viewer/i18n/index.js");
const { createI18n, nb, offersPolish, resolveLang } = await load("../viewer/i18n.js");

const VIEWER = join(import.meta.dir, "..", "viewer");
const read = (f: string) => readFileSync(join(VIEWER, f), "utf8");
const placeholders = (v: unknown): string[] =>
  (typeof v === "string" ? [v] : Object.values(v as Record<string, string>))
    .flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
    .filter((x, i, a) => a.indexOf(x) === i)
    .sort();

describe("wybór języka", () => {
  test("domyślnie angielski, bez wyboru, gdy polskiego nie ma w systemie", () => {
    expect(resolveLang({ languages: ["en-US", "en"] })).toEqual({ lang: "en", canChoose: false });
    expect(resolveLang({ languages: ["de-DE", "fr"] })).toEqual({ lang: "en", canChoose: false });
    expect(resolveLang({ languages: [] })).toEqual({ lang: "en", canChoose: false });
  });
  test("zapamiętany polski nie działa bez polskiego w systemie", () => {
    expect(resolveLang({ languages: ["en-US"], stored: "pl" })).toEqual({ lang: "en", canChoose: false });
  });
  test("polski pierwszy: język polski i wybór", () => {
    expect(resolveLang({ languages: ["pl-PL", "en"] })).toEqual({ lang: "pl", canChoose: true });
    expect(resolveLang({ languages: ["pl"] })).toEqual({ lang: "pl", canChoose: true });
  });
  test("polski dalej na liście: angielski domyślnie, ale wybór jest", () => {
    expect(resolveLang({ languages: ["en-GB", "pl"] })).toEqual({ lang: "en", canChoose: true });
    expect(resolveLang({ languages: ["de", "pl-PL"] })).toEqual({ lang: "en", canChoose: true });
  });
  test("zapamiętany wybór wygrywa, gdy wybór jest dostępny", () => {
    expect(resolveLang({ languages: ["pl-PL"], stored: "en" })).toEqual({ lang: "en", canChoose: true });
    expect(resolveLang({ languages: ["en-US", "pl"], stored: "pl" })).toEqual({ lang: "pl", canChoose: true });
    expect(resolveLang({ languages: ["pl-PL"], stored: "xx" })).toEqual({ lang: "pl", canChoose: true });
  });
  test("parametr ?lang= wygrywa, ale nie włącza wyboru", () => {
    expect(resolveLang({ languages: ["en-US"], override: "pl" })).toEqual({ lang: "pl", canChoose: false });
    expect(resolveLang({ languages: ["pl-PL"], override: "en", stored: "pl" })).toEqual({ lang: "en", canChoose: true });
    expect(resolveLang({ languages: ["en-US"], override: "zz" })).toEqual({ lang: "en", canChoose: false });
  });
  test("offersPolish rozpoznaje podtypy i separatory", () => {
    expect(offersPolish(["pl-PL"])).toBe(true);
    expect(offersPolish(["PL"])).toBe(true);
    expect(offersPolish(["pl_PL"])).toBe(true);
    expect(offersPolish(["plt"])).toBe(false);
    expect(offersPolish(undefined)).toBe(false);
  });
});

describe("silnik tłumaczeń", () => {
  const dicts = {
    en: { a: "Hello {name}", n: { one: "{n} note", other: "{n} notes" }, only: "English only" },
    pl: {
      a: "Cześć {name}",
      n: { one: "{n} notatka", few: "{n} notatki", many: "{n} notatek", other: "{n} notatki" },
      nb: "a w domu",
    },
  };
  test("podstawianie parametrów", () => {
    expect(createI18n("en", dicts).t("a", { name: "Ala" })).toBe("Hello Ala");
    expect(createI18n("pl", dicts).t("a", { name: "Ala" })).toBe("Cześć Ala");
    expect(createI18n("en", dicts).t("a")).toBe("Hello {name}");
  });
  test("odmiana liczebnikowa EN i PL, n z separatorem tysięcy", () => {
    const en = createI18n("en", dicts).t;
    expect(en("n", { n: 1 })).toBe("1 note");
    expect(en("n", { n: 2 })).toBe("2 notes");
    expect(en("n", { n: 1234 })).toBe("1,234 notes");
    const pl = createI18n("pl", dicts).t;
    expect(pl("n", { n: 1 })).toBe("1 notatka");
    expect(pl("n", { n: 3 })).toBe("3 notatki");
    expect(pl("n", { n: 5 })).toBe("5 notatek");
    expect(pl("n", { n: 22 })).toBe("22 notatki");
    expect(pl("n", { n: 12 })).toBe("12 notatek");
  });
  test("brak klucza: angielski, a potem sam klucz", () => {
    const pl = createI18n("pl", dicts);
    expect(pl.t("only")).toBe("English only");
    expect(pl.t("brak.klucza")).toBe("brak.klucza");
    expect(pl.has("only")).toBe(true);
    expect(pl.has("brak.klucza")).toBe(false);
  });
  test("twarde spacje tylko w polskim", () => {
    expect(createI18n("pl", dicts).t("nb")).toBe("a w domu");
    expect(nb("w domu i w lesie")).toBe("w domu i w lesie");
  });
});

describe("słowniki", () => {
  const en = DICTS.en as Record<string, unknown>;
  const pl = DICTS.pl as Record<string, unknown>;
  test("te same klucze w PL i EN", () => {
    expect(Object.keys(pl).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in pl))).toEqual([]);
  });
  test("te same parametry w PL i EN, odmiany z kluczem other", () => {
    for (const k of Object.keys(en)) {
      expect({ k, p: placeholders(pl[k]) }).toEqual({ k, p: placeholders(en[k]) });
      for (const d of [en, pl]) {
        const v = d[k];
        expect(typeof v === "string" || (typeof v === "object" && v !== null && typeof (v as any).other === "string")).toBe(true);
      }
    }
  });
  test("wartości nie są puste", () => {
    for (const d of [en, pl])
      for (const [k, v] of Object.entries(d)) {
        const all = typeof v === "string" ? [v] : Object.values(v as Record<string, string>);
        expect({ k, empty: all.some((s) => !s.trim()) }).toEqual({ k, empty: false });
      }
  });
});

describe("kod widoków", () => {
  const files = ["app.js", "dashboard.js", "index.html"].filter((f) => {
    try {
      read(f);
      return true;
    } catch {
      return false;
    }
  });
  const KEY = /\bt\(\s*["'`]([\w.-]+)["'`]/g;
  test("każdy klucz użyty w kodzie istnieje w słowniku", () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = read(f);
      const keys = [...src.matchAll(KEY)].map((m) => m[1]);
      // klucze trzymane w mapach (etykiety statusów, widżetów…) też muszą istnieć
      if (f === "dashboard.js") for (const m of src.matchAll(/"(dash\.[\w.]+)"/g)) keys.push(m[1]);
      for (const m of src.matchAll(/data-i18n="([\w.-]+)"/g)) keys.push(m[1]);
      for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g))
        for (const pair of m[1].split(";")) keys.push(pair.split(":")[1]?.trim() ?? "");
      for (const k of keys) if (!k || !(k in DICTS.en)) missing.push(`${f}: ${k}`);
    }
    expect(missing).toEqual([]);
  });
  test("dostępne są klucze nawigacji i przełącznika języka", () => {
    for (const k of ["nav.dashboard", "nav.stream", "nav.search", "nav.sessions", "nav.projects", "nav.work", "nav.stats"])
      expect(k in DICTS.en).toBe(true);
  });
  test("w kodzie app.js i dashboard.js nie ma polskich literałów (teksty idą przez t())", () => {
    const ALLOW = new Set(['"wyłączony"']); // wartość zwracana przez worker (/api/health), nie tekst interfejsu
    const bad: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
        .join("\n");
      for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
        if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(m[0]) && !ALLOW.has(m[0])) bad.push(`${f}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(bad).toEqual([]);
  });
  test("tłumaczenia błędów serwera wskazują istniejące klucze", async () => {
    let map: Record<string, string> = {};
    try {
      map = (await load("../viewer/i18n/server-errors.js")).default as Record<string, string>;
    } catch {
      return; // plik powstaje razem z konwersją app.js; brak = test nie ma czego sprawdzać
    }
    for (const [pl, key] of Object.entries(map)) expect({ pl, ok: key in DICTS.en }).toEqual({ pl, ok: true });
  });
  test("każdy stały komunikat błędu workera (bad) ma tłumaczenie w server-errors.js", async () => {
    const map = (await load("../viewer/i18n/server-errors.js")).default as Record<string, string>;
    const src = readFileSync(join(import.meta.dir, "..", "src", "worker", "server.ts"), "utf8");
    const msgs = [...src.matchAll(/\bbad\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(msgs.length).toBeGreaterThan(10);
    expect(msgs.filter((m) => !Object.hasOwn(map, m))).toEqual([]);
  });
  test("pliki słowników to same moduły (bez ukrytych plików)", () => {
    expect(readdirSync(join(VIEWER, "i18n")).filter((f) => !f.endsWith(".js"))).toEqual([]);
  });
});
