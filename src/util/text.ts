// Narzędzia tekstowe: szacowanie tokenów, cięcie, zdania, markdown, słowa kluczowe (PL + EN).
import { createHash } from "node:crypto";

/** Szacunek tokenów Claude dla mieszanki PL/EN/kodu (bez tokenizera: ~3.2 znaku na token). */
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / 3.2);
}

/** Tnie do `max` znaków na granicy słowa, z wielokropkiem. */
export function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–]+$/, "") + "…";
}

export function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Usuwa formatowanie markdown, zostawia czytelny tekst. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*\S)[*_](?=\s|$)/g, "$1$2")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[ \t]+/g, " ");
}

/** Dzieli na zdania (heurystyka odporna na ścieżki i wersje typu 1.2.3). */
export function sentences(s: string): string[] {
  const out: string[] = [];
  for (const para of s.split(/\n{1,}/)) {
    const p = para.trim();
    if (!p) continue;
    const parts = p.split(/(?<=[.!?…])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9"„(])/u);
    for (const x of parts) if (x.trim()) out.push(x.trim());
  }
  return out;
}

/** Linie list (-, *, •, 1.) z tekstu markdown. */
export function bulletLines(s: string): string[] {
  const out: string[] = [];
  for (const line of s.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/);
    if (m) out.push(stripMarkdown(m[1]).trim());
  }
  return out.filter((x) => x.length > 2);
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** Tekst do indeksu FTS: tokenizer unicode61 zdejmuje ogonki (ą→a), ale „ł” nie ma rozkładu Unicode,
 *  więc składamy je sami — tak jak normKey po stronie zapytania („blad” trafia w „błąd”). */
export function foldFts(s: string): string {
  return s.replace(/ł/g, "l").replace(/Ł/g, "L");
}

/** Normalizacja do porównań: małe litery, bez diakrytyków, bez interpunkcji. */
export function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/g, "l")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOP_WORDS =
  // PL
  (
    "a aby ach acz aczkolwiek aj albo ale ależ ani aż bardziej bardzo bez bo bowiem by byli bym bynajmniej był była było były będzie będą będę cali cała cały chce chcę ci ciebie cię co cokolwiek coś czasami czasem czemu czy czyli daleko dla dlaczego dlatego do dobrze dokąd dość dużo dwa dwaj dwie dwoje dziś dzisiaj gdy gdyby gdyż gdzie gdziekolwiek gdzieś go i ich ile im inna inne inny innych iż ja ją jak jakaś jakby jaki jakichś jakie jakiś jakiż jakkolwiek jako jakoś je jeden jedna jedno jednak jednakże jego jej jemu jest jestem jeszcze jeśli jeżeli już ją każdy kiedy kilka kimś kto ktokolwiek ktoś która które którego której który których którym którzy ku lat lecz lub ma mają mam mi mimo między mną mnie mogą moi moim moja moje może możliwe można mój mu musi my na nad nam nami nas nasi nasz nasza nasze naszego naszych natomiast natychmiast nawet nią nic nich nie niech niego niej niemu nigdy nim nimi niż no o obok od około on ona one oni ono oraz oto owszem pan pana pani po pod podczas pomimo ponad ponieważ powinien powinna powinni powinno poza prawie przecież przed przede przedtem przez przy roku również sam sama są się skąd sobie sobą sposób swoje ta tak taka taki takie także tam te tego tej temu ten teraz też to tobą tobie toteż trzeba tu tutaj twoi twoim twoja twoje twym twój ty tych tylko tym u w wam wami was wasz wasza wasze we według wiele wielu więc więcej wszyscy wszystkich wszystkie wszystkim wszystko wtedy wy właśnie z za zapewne zawsze ze zł znowu znów został żaden żadna żadne żadnych że żeby " +
    // EN
    "a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also use used using get got make made via per let lets done ok okay yes yeah need want like " +
    // techniczne śmieci
    "true false null undefined const let var return function import export from new"
  )
    .split(/\s+/)
    .filter(Boolean);

// buildMatch i porównania widzą słowa po normKey (bez ogonków): „się”, „już”, „może” muszą być stop-słowami także jako „sie”, „juz”, „moze”.
// Wyjątki: formy bez ogonków, które są też terminami technicznymi (az: Azure CLI, cos: cosinus, sa: konto admina SQL Server).
const TECH_FORMS = new Set(["az", "cos", "sa"]);
const STOP = new Set([...STOP_WORDS, ...STOP_WORDS.map(normKey).filter((w) => !TECH_FORMS.has(w))]);

export function isStopword(w: string): boolean {
  return STOP.has(w);
}

/** Tokeny słownikowe (litery/cyfry, min. 3 znaki, bez stop-słów). */
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().matchAll(/[\p{L}][\p{L}\p{N}_-]{2,}/gu)) {
    const w = m[0].replace(/[-_]+$/, "");
    if (!STOP.has(w) && w.length >= 3 && w.length <= 40) out.push(w);
  }
  return out;
}

/** Najczęstsze słowa kluczowe (prosty TF z karą za bardzo krótkie). */
export function keywords(s: string, k = 6, extraStop: Set<string> = new Set()): string[] {
  const tf = new Map<string, number>();
  for (const w of tokens(s)) {
    if (extraStop.has(w) || /^\d+$/.test(w)) continue;
    tf.set(w, (tf.get(w) ?? 0) + (w.length >= 5 ? 1 : 0.6));
  }
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, k)
    .map(([w]) => w);
}

/** Identyfikatory z kodu (camelCase, snake_case, kebab-case z min. jednym separatorem). */
export function codeIdentifiers(s: string, k = 8): string[] {
  const seen = new Map<string, number>();
  for (const m of s.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]+|[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+-[a-z0-9-]+)\b/g)) {
    const w = m[1];
    if (w.length < 5 || w.length > 48) continue;
    seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w]) => w);
}

/** Pierwsza sensowna linia/zdanie (pomija ogólniki typu „Gotowe.”, „Done.”). */
export function headline(s: string, max = 100): string {
  const GENERIC =
    /^(gotowe|zrobione|done|ok|okej|okay|sure|jasne|oto|here('?s| is)|podsumowanie|summary|wynik|result|status|dzięki|thanks|great|super|perfect|świetnie)[\s.!:,]*$/i;
  for (const sent of sentences(stripMarkdown(s))) {
    const x = oneLine(sent).replace(/^[-*•]\s*/, "");
    if (x.length < 8 || GENERIC.test(x)) continue;
    if (x.split(" ").length < 2) continue;
    return truncate(x.replace(/[:]$/, ""), max);
  }
  return "";
}
