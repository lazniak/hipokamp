// hipokamp: lokalizacja podglądu. Czysty moduł ES (bez DOM przy imporcie), więc działa też w testach.
// Zasada języka: domyślnie angielski. Polski jest językiem głównym tylko wtedy, gdy pierwszy język
// przeglądarki/systemu jest polski. Przełącznik PL/EN pokazujemy tylko wtedy, gdy polski jest wśród
// języków przeglądarki/systemu; w innym razie interfejs zostaje po angielsku, bez żadnego wyboru.

export const LANGS = ["en", "pl"];
export const DEFAULT_LANG = "en";
export const LOCALES = { en: "en-GB", pl: "pl-PL" };
export const STORE_LANG = "hipokamp:lang";

const NBSP = " ";
const primary = (tag) => String(tag ?? "").toLowerCase().split(/[-_]/)[0];

/** Czy wśród języków przeglądarki/systemu jest polski (wtedy wolno pokazać wybór języka). */
export const offersPolish = (languages) => (languages ?? []).some((l) => primary(l) === "pl");

/**
 * Wybiera język interfejsu.
 * languages: navigator.languages; stored: zapamiętany wybór; override: parametr ?lang= (link, zrzut ekranu).
 * Zwraca { lang, canChoose }; canChoose = true tylko gdy polski jest w językach przeglądarki/systemu.
 */
export function resolveLang({ languages = [], stored = "", override = "" } = {}) {
  const canChoose = offersPolish(languages);
  if (LANGS.includes(override)) return { lang: override, canChoose };
  if (canChoose && LANGS.includes(stored)) return { lang: stored, canChoose };
  return { lang: canChoose && primary(languages[0]) === "pl" ? "pl" : DEFAULT_LANG, canChoose };
}

/** Twarde spacje po jednoliterowych spójnikach i przyimkach (typografia polska; tylko dla stałych tekstów UI). */
export const nb = (s) => s.replace(/(?<=^|[\s(„])([aiouwzAIOUWZ])\s+/g, `$1${NBSP}`);

/**
 * Tworzy tłumacza. dicts: { en: {klucz: "tekst" | {one, few, many, other}}, pl: {...} }.
 * t(klucz, params): {nazwa} podstawia params.nazwa; wartość-obiekt to odmiana liczebnikowa wybierana
 * po params.n (Intl.PluralRules dla języka). Parametr n jest formatowany liczbowo (separatory tysięcy),
 * wszystkie inne wstawiane są bez zmian (id, wersje i teksty formatuje wołający).
 * Brak klucza w języku: tekst angielski, a gdy i tego brak, sam klucz (i jedno ostrzeżenie w konsoli).
 */
export function createI18n(lang, dicts) {
  const locale = LOCALES[lang] ?? LOCALES[DEFAULT_LANG];
  const dict = dicts[lang] ?? {};
  const base = dicts[DEFAULT_LANG] ?? {};
  const rules = new Intl.PluralRules(locale);
  const fmtN = new Intl.NumberFormat(locale);
  const warned = new Set();

  function t(key, params) {
    let v = dict[key] ?? base[key];
    if (v == null) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`i18n: brak klucza ${key}`);
      }
      return key;
    }
    if (typeof v === "object") {
      const n = Number(params?.n);
      v = v[rules.select(Number.isFinite(n) ? n : 0)] ?? v.other ?? "";
    }
    if (lang === "pl") v = nb(v);
    return v.replace(/\{(\w+)\}/g, (m, k) => {
      if (!params || !(k in params)) return m;
      const val = params[k];
      return k === "n" && typeof val === "number" ? fmtN.format(val) : String(val);
    });
  }

  return { lang, locale, t, has: (key) => key in dict || key in base };
}

/**
 * Tłumaczy statyczny HTML: data-i18n="klucz" ustawia textContent,
 * data-i18n-attr="aria-label:klucz;title:klucz2" ustawia atrybuty.
 */
export function applyStatic(root, t) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}
