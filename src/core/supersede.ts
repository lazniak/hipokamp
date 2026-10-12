// Zastępowanie po kluczu (supersession): nowsza decyzja albo preferencja o tym samym temacie unieważnia starszą.
// Zastąpiona notatka dostaje status `superseded` z odsyłaczem `superseded_by` (nigdy twarde usunięcie), znika
// z wyszukiwania i kontekstu, a wraca przez forget(undo=true) (repo.restoreSuperseded). Dwie drogi:
// - jawny klucz (`remember` z `key`): od razu, ten sam projekt, decyzja albo preferencja z tym samym kluczem;
// - notatki z digestu (sen, `supersedeSimilar`): ostrożnie, precyzja ponad recall. Sen działa na pamięci wszystkich
//   sesji, a zastąpiona notatka przestaje przypominać się sama: lepiej nie zastąpić niż zastąpić błędnie. Domyślnie sen
//   tylko proponuje pary (log, `hipokamp supersede --dry-run`), zapisuje w trybie `consolidation.supersedeDigest: "apply"`.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { cosQ8 } from "../index/vectors.ts";
import { log } from "../log.ts";
import type { Observation } from "../types.ts";
import { slicer } from "../util/slice.ts";
import { isStopword, normKey } from "../util/text.ts";

/** Typy, które zastępują się po kluczu: decyzja i preferencja mówią, jak jest teraz (epizod tylko, co się stało). */
export const KEYED_TYPES = ["decision", "preference"] as const;
const isKeyed = (type: string) => (KEYED_TYPES as readonly string[]).includes(type);

/** Klucz tematu: małe litery, bez ogonków i interpunkcji („Hosting repo!” i „hosting  repo” to ten sam klucz). */
export function topicKey(raw: string | null | undefined): string {
  return normKey(raw ?? "").slice(0, 120);
}

/**
 * Jawny klucz z `remember`: aktywne decyzje i preferencje projektu z tym samym kluczem dostają status `superseded`
 * ze wskazaniem `id`. Tylko starsze (niższy numer): przy dwóch równoległych `remember` z tym samym kluczem starsza
 * nie zastąpi nowszej. `reassert`: ta sama treść podana drugi raz (deduplikacja zwraca starą notatkę), więc ona jest
 * teraz najnowszym stanem i zastępuje też nowsze. Zwraca zastąpione numery.
 */
export function supersedeByKey(repo: Repo, id: number, project: string, key: string, type: string, reassert = false): number[] {
  const k = topicKey(key);
  if (!k || !isKeyed(type)) return [];
  const old = repo.keyedObservations(project, k, [...KEYED_TYPES]).filter((x) => x !== id && (reassert || x < id));
  return old.filter((o) => repo.supersedeObservation(o, id, { reason: "klucz", key: k }));
}

// ---------------------------------------------------------------- notatki z digestu (sen)

/** Pojęcia typu wiedzy z digestu (każda decyzja ma „trade-off”): wspólne nic nie mówią o temacie. */
const GENERIC_CONCEPTS = new Set(["trade-off", "pattern", "problem-solution", "what-changed", "how-it-works", "gotcha"]);

/**
 * Słowa pytań, które nic nie mówią o temacie („Jak chcesz kontynuować?”, „Czy mam zacząć?”, „Which option?”).
 * Po normKey, więc bez ogonków. Pytanie jest konkretne dopiero z co najmniej `MIN_QUESTION_WORDS` innymi słowami.
 */
const GENERIC_QUESTION_WORDS = new Set(
  (
    "jak jaki jaka jakie jakim czy co gdzie kiedy ktory ktora ktore ktorego ktorej ktorym ktorych ile " +
    "mam moge mozemy mamy masz chcesz chcialbys wolisz wybierasz wybierz wybrac wybieramy robic zrobic robimy zrobimy " +
    "kontynuowac kontynuuj kontynuujemy dalej teraz najpierw potem zaczac zaczynamy idziemy isc dzialamy " +
    "opcja opcje opcji wariant warianty wariantu podejscie sposob plan krok kroki nastepny nastepne nastepnie kolejny " +
    "tak nie dobrze ok okej prosze ten ta to tym tego tej tych tutaj tu " +
    "how what which where when should shall can could would want prefer proceed continue next now first then " +
    "option options approach way step steps go ahead start do does we you the this that it yes no"
  ).split(" "),
);
const MIN_QUESTION_WORDS = 4;

/** Minimalne podobieństwo tytułów (Jaccard słów: dłuższych niż 2 znaki albo z cyfrą, po normalizacji). */
const TITLE_JACCARD = 0.6;
/** Bez wektorów (tylko przy wyłączonym modelu i wspólnym zmienionym pliku) tytuł musi być niemal ten sam. */
const TITLE_JACCARD_NO_VEC = 0.8;
/** Cosinus int8 (bge-m3): ten sam temat. Powyżej 0,965 sen scala duplikaty, więc tu zostaje „to samo, ale inaczej”. */
const MIN_COS = 0.85;
/**
 * To samo konkretne pytanie z inną odpowiedzią: treść różni się właśnie odpowiedzią, więc cosinus jest niższy
 * (pary z recenzji 0,79 i 0,82), a różne sprawy z tym samym pytaniem miały 0,57.
 */
const QUESTION_MIN_COS = 0.75;
/**
 * Rzeczowniki, po których stoi nazwa własna albo identyfikator („repo hipokamp”, „projektu alpha”, „preset Studio”):
 * podmiana słowa tuż za nimi to inna rzecz, nie nowa wersja tej samej decyzji. Po normKey (bez ogonków).
 */
const KIND_NOUNS = new Set(
  (
    "repo repozytorium repozytorium repozytoria repozytoriach projekt projektu projekcie projektem projekty " +
    "preset presetu presecie presety klient klienta kliencie klientem galaz galezi branch serwer serwera serwerze host " +
    "hosta katalog katalogu plik pliku pliki domena domeny domenie aplikacja aplikacji usluga uslugi modul modulu pakiet " +
    "pakietu skill skilla plugin pluginu wtyczka wtyczki konto konta koncie kanal kanalu scena sceny scenie kamera " +
    "kamery telefon telefonu sesja sesji baza bazy bazie tabela tabeli worktree workspace bucket tenant agent agenta"
  ).split(" "),
);
/** Najwyżej tyle starszych notatek projektu i typu bierze pod uwagę jeden przebieg (najnowsze). */
const MAX_OLDER = 3000;
/**
 * Jedna nowa notatka pasująca do więcej niż tylu starszych naraz to sygnał, że reguła złapała coś ogólnego:
 * wtedy nie zastępujemy żadnej (wpis w logu). Zwykła zmiana decyzji zastępuje jedną poprzednią wersję.
 */
const MAX_PER_NEWER = 3;
/** Najdłuższy kawałek pracy snu bez oddania sterowania pętli workera (hook czeka na odpowiedź najwyżej 1,8 s). */
const SLICE_MS = 25;
/** Notatki ładowane partiami (wiersz → obiekt z JSON-em faktów i plików kosztuje). */
const LOAD_CHUNK = 100;
/** Strona numerów starszych decyzji i preferencji (same numery, projekt i data: tanie). */
const PAGE = 2000;

function titleWords(t: string): Set<string> {
  // słowa z cyfrą zostają mimo długości („PR 5”, „v2”): bez nich tytuły różniące się numerem są identyczne
  return new Set(
    normKey(t)
      .split(" ")
      .filter((w) => w.length > 2 || /\d/.test(w)),
  );
}

/** Liczby z tytułu (numery PR-ów, wersji, portów, daty) jako posortowany klucz: różne liczby = różne rzeczy. */
export function titleNumbers(t: string): string {
  const nums = [...t.matchAll(/\d+(?:[.,:/-]\d+)*/g)].map((m) => m[0].replace(/,/g, "."));
  return [...new Set(nums)].sort().join("|");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const w of a) if (b.has(w)) i++;
  return i / (a.size + b.size - i);
}

/** Pytanie konkretne: co najmniej 4 słowa treściwe (bez stop-słów i ogólników typu „kontynuować”, „czy mam”). */
export function isSpecificQuestion(q: string): boolean {
  const words = normKey(q)
    .split(" ")
    .filter((w) => (w.length >= 3 || /\d/.test(w)) && !isStopword(w) && !GENERIC_QUESTION_WORDS.has(w));
  return new Set(words).size >= MIN_QUESTION_WORDS;
}

/** Pytania z odpowiedzi użytkownika (fakty digestu „Decyzja: pytanie → odpowiedź”), tylko konkretne. */
export function decisionQuestions(o: Pick<Observation, "facts">): Set<string> {
  return new Set(decisionAnswers(o).keys());
}

/** Konkretne pytania z faktów „Decyzja: pytanie → odpowiedź” z odpowiedzią (po normKey). */
function decisionAnswers(o: Pick<Observation, "facts">): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of o.facts) {
    const m = f.match(/^Decyzja:\s*(.+?)\s+→\s+(.*)$/s);
    if (m && isSpecificQuestion(m[1])) {
      const q = normKey(m[1]);
      out.set(q, `${out.get(q) ?? ""} ${normKey(m[2])}`.trim());
    }
  }
  return out;
}

/** Słowa tytułu z zachowaną wielkością liter (do weta podmiany nazwy) i ich postać znormalizowana. */
function titleTokens(t: string): { raw: string[]; norm: string[] } {
  const raw = t
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  return { raw, norm: raw.map((w) => normKey(w).replace(/ /g, "")) };
}

/** Rdzeń znanej nazwy projektu: pierwsze 5 liter (po normKey, ł→l) i najdłuższa odmiana (nazwa + 4 litery końcówki). */
export interface NameStem {
  name: string;
  stem: string;
  max: number;
}

/**
 * Rdzenie znanych nazw projektów (`repo.projectNames()`: klucze sesji, aliasy, nazwy katalogów, scalenia; klucz złożony
 * „repo/worktree” daje oba człony). Słowa krótsze niż 4 litery i same liczby pomijane: „app”, „ui” albo „v2”
 * wetowałyby zwykłe słowa.
 */
export function projectStems(names: Iterable<string>): NameStem[] {
  const out = new Map<string, NameStem>();
  for (const raw of names)
    for (const seg of String(raw ?? "").split("/"))
      for (const w of normKey(seg).split(" "))
        if (w.length >= 4 && !/^\d+$/.test(w) && !out.has(w)) out.set(w, { name: w, stem: w.slice(0, 5), max: w.length + 4 });
  // dłuższy rdzeń wygrywa („hipokamp” przed „hipo…” innego projektu)
  return [...out.values()].sort((a, b) => b.stem.length - a.stem.length || b.name.length - a.name.length);
}

/** Nazwa projektu, której odmianą jest słowo („hipokampie”, „hipokampa” → hipokamp), albo null. */
function projectOf(word: string, stems: NameStem[]): string | null {
  for (const s of stems) if (word.length <= s.max && word.startsWith(s.stem)) return s.name;
  return null;
}

/** Podmienione słowo tytułu: postać ze starszej i z nowszej notatki. */
export interface Swap {
  older: string;
  newer: string;
}

/**
 * Weto podmiany nazwy. Zwraca podmiany nazw między tytułami (pusta lista: weta nie ma):
 * - tytuły tej samej długości różnią się jednym albo dwoma słowami na tych samych miejscach, a podmienione słowo stoi
 *   w miejscu nazwy: wielka litera w środku zdania, identyfikator z literą i cyfrą albo znakiem `-_./\`, słowo tuż za
 *   „repo”, „projektu”, „preset”… („Gałąź main chroniona w repo hipokamp” i „… w repo sejf”);
 * - każdy z tytułów wymienia znany projekt, którego nie ma w drugim, w dowolnej odmianie i małą literą („w hipokampie”
 *   i „w sejfie”, „Worker hipokampa” i „Worker sejfa”, także przy różnej długości tytułów: „w repo hipokamp” i
 *   „w sejfie”). Odmiany tej samej nazwy („hipokamp” → „hipokampa”) to nie podmiana.
 * Zmiana wartości zwykłym słowem („commity po polsku” → „po angielsku”) i sama liczba przechodzą dalej.
 */
export function nameSwaps(a: string, b: string, stems: NameStem[] = []): Swap[] {
  const x = titleTokens(a);
  const y = titleTokens(b);
  const out: Swap[] = [];
  if (x.norm.length === y.norm.length) {
    const diff: number[] = [];
    for (let i = 0; i < x.norm.length; i++) if (x.norm[i] !== y.norm[i]) diff.push(i);
    // sama liczba („47777”, „0,62”, „7:00”) to wartość, nie nazwa: różne liczby w tytułach rozdziela już
    // `titleNumbers`, a przy tym samym pytaniu liczba bywa właśnie nową odpowiedzią
    const nameLike = (raw: string, i: number) =>
      (i > 0 && /^\p{Lu}/u.test(raw)) ||
      (/\p{L}/u.test(raw) && /[\d_./\\-]/.test(raw)) ||
      (i > 0 && KIND_NOUNS.has(x.norm[i - 1]));
    if (diff.length && diff.length <= 2)
      for (const i of diff) if (nameLike(x.raw[i], i) || nameLike(y.raw[i], i)) out.push({ older: x.raw[i], newer: y.raw[i] });
  }
  if (stems.length) {
    const mentions = (t: { raw: string[]; norm: string[] }) => {
      const m = new Map<string, string>();
      t.norm.forEach((w, i) => {
        const p = projectOf(w, stems);
        if (p && !m.has(p)) m.set(p, t.raw[i]);
      });
      return m;
    };
    const px = mentions(x);
    const py = mentions(y);
    const onlyX = [...px].filter(([p]) => !py.has(p));
    const onlyY = [...py].filter(([p]) => !px.has(p));
    if (onlyX.length && onlyY.length && !out.some((s) => s.older === onlyX[0][1] && s.newer === onlyY[0][1]))
      out.push({ older: onlyX[0][1], newer: onlyY[0][1] });
  }
  return out;
}

export function nameSwap(a: string, b: string, stems: NameStem[] = []): boolean {
  return nameSwaps(a, b, stems).length > 0;
}

/** Czy słowo (albo identyfikator z kilku członów: „Qwen-4.6”, „bge-m3”) występuje w odpowiedzi, z odmianą. */
function inAnswer(word: string, answer: string | undefined): boolean {
  if (!answer) return false;
  const w = normKey(word);
  if (!w) return false;
  if (w.includes(" ")) return ` ${answer} `.includes(` ${w} `);
  return answer.split(" ").some((x) => x === w || (w.length >= 4 && x.length >= 4 && x.slice(0, 5) === w.slice(0, 5)));
}

/** Cechy notatki liczone raz na przebieg snu (nie raz na parę). */
interface Feat {
  id: number;
  created_at: number;
  title: string;
  words: Set<string>;
  nums: string;
  questions: Set<string>;
  /** Odpowiedź na każde konkretne pytanie (po normKey). */
  answers: Map<string, string>;
  /** Wspólny temat: pliki zmienione (`f:`) i konkretne pojęcia (`c:`); pliki czytane nie (CLAUDE.md czyta każda sesja). */
  entities: Set<string>;
  files: Set<string>;
  undone: boolean;
}

function featuresOf(o: Observation): Feat {
  const files = new Set(o.files_modified.map((f) => f.toLowerCase()));
  const entities = new Set<string>([...files].map((f) => `f:${f}`));
  for (const c of o.concepts)
    if (!c.includes(":") && !GENERIC_CONCEPTS.has(c.toLowerCase())) entities.add(`c:${c.toLowerCase()}`);
  const answers = decisionAnswers(o);
  return {
    id: o.id,
    created_at: o.created_at,
    title: o.title,
    words: titleWords(o.title),
    nums: titleNumbers(o.title),
    questions: new Set(answers.keys()),
    answers,
    entities,
    files,
    undone: !!o.meta?.supersede_undone,
  };
}

const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((x) => b.has(x));
const shares = <T>(a: Set<T>, b: Set<T>) => [...a].some((x) => b.has(x));

interface Verdict {
  reason: string;
  jaccard: number;
  cos: number | null;
}

/** Para bez obu wektorów przy włączonym modelu: wróci w następnym śnie, gdy wektory się doliczą. */
const PENDING = "czeka na wektory";

/**
 * Czy `b` (nowsza) zastępuje `a` (starszą) z tego samego projektu i typu. Warunki konieczne: starsza wcześniejsza i jej
 * zastąpienie nie było cofnięte, starsza nie zmieniała plików albo tylko te, które zmienia nowsza (inaczej opisuje też
 * pracę, która by zniknęła z pamięci). Potem kandydat: podobny tytuł (te same liczby, Jaccard ≥ 0,6, oba po co
 * najmniej 3 słowa, wspólny plik zmieniony albo konkretne pojęcie, bez podmiany nazwy: `nameSwaps`) albo to samo
 * konkretne pytanie zadane użytkownikowi (pytania starszej ⊆ pytań nowszej; podmiana nazwy wetuje, chyba że podmienione
 * słowo jest w odpowiedzi każdej z notatek na to pytanie: „→ GitHub” i „→ Gitea” to nowa odpowiedź, nie inne repo).
 * Rozstrzygają wektory:
 * - to samo pytanie i cosinus ≥ 0,75 (odpowiedź jest inna, więc treść też trochę);
 * - podobny tytuł i cosinus ≥ 0,85.
 * Bez obu wektorów przy włączonym modelu: nic (para czeka na następny sen; sam tytuł łączył szablonowe „Zmiany są
 * w gotowym buildzie.”). Przy wyłączonym modelu tylko ze wspólnym plikiem zmienionym: to samo pytanie i podobny tytuł
 * albo tytuł niemal ten sam (Jaccard ≥ 0,8). `cos` jest leniwe: wektory czytamy tylko dla par po tańszych warunkach.
 */
function judge(a: Feat, b: Feat, cos: () => number | null, embed: boolean, stems: NameStem[]): Verdict | typeof PENDING | null {
  if (a.created_at >= b.created_at || a.undone) return null;
  if (!subset(a.files, b.files)) return null;
  const j = a.words.size >= 3 && b.words.size >= 3 ? jaccard(a.words, b.words) : 0;
  // inne liczby w tytułach (PR #5 i #6, wersje, daty) rozdzielają drogę tytułu; przy tym samym pytaniu liczba bywa
  // nową odpowiedzią („model Qwen-4.6” → „Qwen-5.3”), tam rozstrzyga pytanie i cosinus
  let title = a.nums === b.nums && j >= TITLE_JACCARD && shares(a.entities, b.entities);
  const shared = [...a.questions].filter((q) => b.questions.has(q));
  let question = a.questions.size > 0 && shared.length === a.questions.size;
  if (!title && !question) return null;
  const swaps = nameSwaps(a.title, b.title, stems);
  if (swaps.length) {
    title = false;
    // na drodze pytania podmiana jest nową odpowiedzią, gdy oba słowa są w odpowiedziach na wspólne pytanie
    question &&= swaps.every((s) =>
      shared.some((q) => inAnswer(s.older, a.answers.get(q)) && inAnswer(s.newer, b.answers.get(q))),
    );
    if (!question) return null;
  }
  const c = cos();
  if (c === null) {
    if (embed) return PENDING;
    if (!shares(a.files, b.files)) return null;
    if (question && j >= TITLE_JACCARD) return { reason: "to samo pytanie i plik (bez wektorów)", jaccard: j, cos: null };
    return title && j >= TITLE_JACCARD_NO_VEC
      ? { reason: "niemal ten sam tytuł i plik (bez wektorów)", jaccard: j, cos: null }
      : null;
  }
  if (question && c >= QUESTION_MIN_COS) return { reason: "to samo pytanie", jaccard: j, cos: c };
  if (title && c >= MIN_COS) return { reason: "podobny tytuł i treść", jaccard: j, cos: c };
  return null;
}

/**
 * Reguła snu dla jednej pary (testy, podgląd): powód zastąpienia albo null (także para czekająca na wektory).
 * `embed`: czy model wektorów jest włączony (domyślnie z konfiguracji); `projects`: znane nazwy projektów (weto).
 */
export function supersedesDigest(
  older: Observation,
  newer: Observation,
  vecs?: { older?: Int8Array; newer?: Int8Array },
  embed = loadConfig().embed.enabled,
  projects: Iterable<string> = [],
): string | null {
  if (older.type !== newer.type || !isKeyed(older.type)) return null;
  if (older.project.toLowerCase() !== newer.project.toLowerCase()) return null;
  const v = judge(
    featuresOf(older),
    featuresOf(newer),
    () => (vecs?.older && vecs.newer ? cosQ8(vecs.older, vecs.newer) : null),
    embed,
    projectStems([older.project, ...projects]),
  );
  return v && v !== PENDING ? v.reason : null;
}

/** Tryb zastępowania z digestu w śnie (`consolidation.supersedeDigest`): propozycje (domyślnie), zapis, wyłączone. */
export type SupersedeMode = "propose" | "apply" | "off";

const MODES: Record<string, SupersedeMode> = {
  propose: "propose",
  apply: "apply",
  // true: zgodność z pierwszą wersją klucza (jawne włączenie = zapis)
  true: "apply",
  off: "off",
  false: "off",
};

/** Tryb z wartości konfiguracji: bez wielkości liter i spacji („ Apply” = apply); nieznana wartość = propose. */
export function supersedeMode(v: unknown): SupersedeMode {
  const k = String(v).trim().toLowerCase();
  return Object.hasOwn(MODES, k) ? MODES[k] : "propose";
}

/** Ostrzeżenie dla `doctor`, gdy wartość klucza nie jest jednym z trybów (wtedy działa „propose”). */
export function supersedeModeWarning(v: unknown): string | null {
  if (v === undefined || Object.hasOwn(MODES, String(v).trim().toLowerCase())) return null;
  return `consolidation.supersedeDigest = ${JSON.stringify(v)} to nieznana wartość, działa "propose" (dozwolone: "propose", "apply", false)`;
}

/** Jedno zastąpienie z digestu: plan próby (`--dry-run`), wynik snu i linia w logs/sleep-RRRR-MM-DD.jsonl. */
export interface SupersedePair {
  older: number;
  newer: number;
  project: string;
  type: string;
  reason: string;
  jaccard: number;
  cos: number | null;
  olderTitle: string;
  newerTitle: string;
}

export interface SupersedeOptions {
  /** Tylko plan, bez zapisu (baza może być otwarta tylko do odczytu). */
  dryRun?: boolean;
  /** Zapis każdej pary do logs/sleep-RRRR-MM-DD.jsonl (`kind`: „supersede”, a w próbie „propose”). */
  logPairs?: boolean;
  /** Najdłuższy kawałek pracy bez oddania sterowania pętli zdarzeń, ms (gdy nie ma `pause`). */
  sliceMs?: number;
  /** Przerwa dla pętli zdarzeń wołana w pętli (sen podaje swój `slicer()`, wspólny budżet i zgłaszanie kawałków). */
  pause?: () => Promise<void>;
  /** Czy model wektorów jest włączony (domyślnie z konfiguracji): bez niego zastępuje tylko wspólny zmieniony plik. */
  embed?: boolean;
  /** Nowa notatka (jej `created_at`) ma parę czekającą na wektory: sen zacznie od niej następne okno. */
  onPending?: (createdAt: number) => void;
}

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Linia pary w logs/sleep-RRRR-MM-DD.jsonl: `supersede` (zapisane), `propose` (tylko propozycja). */
export function logPair(p: SupersedePair, kind: "supersede" | "propose", extra: Record<string, unknown> = {}): void {
  try {
    appendFileSync(
      join(paths.logs(), `sleep-${dayOf(Date.now())}.jsonl`),
      `${JSON.stringify({ ...p, ...extra, at: Date.now(), kind })}\n`,
    );
  } catch {}
}

export const pairKey = (p: Pick<SupersedePair, "older" | "newer">) => `${p.older}>${p.newer}`;

/** Propozycje z logów snu od dnia `sinceMs` (najstarsze najpierw); uszkodzone linie i pliki pomijane. */
export function loggedProposals(sinceMs: number): SupersedePair[] {
  const from = dayOf(sinceMs);
  const out: SupersedePair[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(paths.logs())
      .filter((f) => /^sleep-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(6, 16) >= from)
      .sort();
  } catch {
    return out;
  }
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(paths.logs(), f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j?.kind === "propose" && Number.isInteger(j.older) && Number.isInteger(j.newer)) {
          const { at: _at, kind: _kind, ...pair } = j;
          out.push(pair as SupersedePair);
        }
      } catch {}
    }
  }
  return out;
}

/**
 * `hipokamp supersede --ids`: zastępuje tylko wskazane starsze notatki (lewa strona `#12 → #15`), parą z propozycji
 * snu (logi z `days` dni, najnowsza propozycja dla numeru) albo, gdy jej tam nie ma, z planu na bieżącej bazie.
 * Obie notatki muszą być nadal aktywne. Zwraca zastąpione, nieznalezione i pominięte (już nieaktywne).
 */
export async function applySelected(
  repo: Repo,
  ids: number[],
  days = 120,
): Promise<{ applied: SupersedePair[]; missing: number[]; skipped: number[] }> {
  const since = Date.now() - days * 86_400_000;
  const want = new Set(ids);
  const byOlder = new Map<number, SupersedePair>();
  // propozycja z logu pasuje tylko do tych samych notatek (ten sam tytuł): log przeżyje np. przywrócenie innej kopii bazy
  const sameNotes = (p: SupersedePair) =>
    repo.getObservation(p.older)?.title === p.olderTitle && repo.getObservation(p.newer)?.title === p.newerTitle;
  for (const p of loggedProposals(since)) if (want.has(p.older) && sameNotes(p)) byOlder.set(p.older, p);
  if (ids.some((id) => !byOlder.has(id)))
    for (const p of await supersedeSimilar(repo, since, { dryRun: true }))
      if (want.has(p.older) && !byOlder.has(p.older)) byOlder.set(p.older, p);
  const applied: SupersedePair[] = [];
  const missing: number[] = [];
  const skipped: number[] = [];
  for (const id of want) {
    const p = byOlder.get(id);
    if (!p) missing.push(id);
    else if (repo.supersedeObservation(p.older, p.newer, { reason: p.reason, jaccard: p.jaccard, cos: p.cos, manual: true })) {
      applied.push(p);
      logPair(p, "supersede", { manual: true });
    } else skipped.push(id);
  }
  return { applied, missing, skipped };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Sen: nowe decyzje i preferencje z digestu (od `sinceMs`) zastępują starsze o tym samym temacie (`judge`).
 * Cechy każdej notatki liczone raz, kandydaci z indeksu odwrotnego (wspólne słowo tytułu albo wspólne pytanie: bez
 * tego reguła i tak nie przejdzie), wektory tylko dla par po tańszych warunkach. Praca w kawałkach (`pause` snu
 * albo własny `slicer` po `sliceMs`) z oddaniem sterowania: worker odpowiada hookom w trakcie. Nowe notatki idą od najstarszej, więc łańcuch A → B → C
 * zostaje łańcuchem. Para czekająca na wektory liczy się do limitu `MAX_PER_NEWER` i wraca w kolejnym śnie (`onPending`:
 * sleep.ts zaczyna następne okno najpóźniej od tej nowej notatki). Zwraca zastąpione pary (w próbie: plan).
 */
export async function supersedeSimilar(repo: Repo, sinceMs: number, opts: SupersedeOptions = {}): Promise<SupersedePair[]> {
  const embed = opts.embed ?? loadConfig().embed.enabled;
  const breathe = opts.pause ?? slicer(opts.sliceMs ?? SLICE_MS, 0);
  // jedno przejście po aktywnych decyzjach i preferencjach z digestu wszystkich projektów (strony po indeksie typu,
  // z oddechem między stronami); świeże i starsze, grupy projekt bez wielkości liter + typ liczone w JS
  type Ref = { id: number; project: string; type: string; created_at: number };
  const byGroup = new Map<string, Ref[]>();
  for (const type of KEYED_TYPES) {
    let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const page = repo.keyedDigestRefsPage(type, before, PAGE);
      for (const r of page) {
        const g = `${r.project.toLowerCase()}|${type}`;
        const ref = { ...r, type };
        const l = byGroup.get(g);
        if (l) l.push(ref);
        else byGroup.set(g, [ref]);
      }
      await breathe();
      if (page.length < PAGE) break;
      before = page[page.length - 1].id;
    }
  }
  // znane nazwy projektów do weta podmiany nazwy (sesje, aliasy, scalenia i projekty decyzji)
  const stems = projectStems([...repo.projectNames(), ...[...byGroup.values()].map((l) => l[0].project)]);
  const out: SupersedePair[] = [];
  for (const refs of byGroup.values()) {
    // od najnowszej; świeże od najstarszej (łańcuch A → B → C), starsze: najnowsze MAX_OLDER sprzed świeżych
    refs.sort((x, y) => y.created_at - x.created_at || y.id - x.id);
    const list = refs.filter((r) => r.created_at >= sinceMs).reverse();
    if (!list.length) continue;
    const { project, type } = list[0];
    const prior = refs.filter((r) => r.created_at < sinceMs).slice(0, MAX_OLDER);
    const ids = [...prior.map((r) => r.id), ...list.map((r) => r.id)];
    await breathe();
    const feats = new Map<number, Feat>();
    for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
      for (const o of repo.getObservations(ids.slice(i, i + LOAD_CHUNK)))
        if (o.status === "active") feats.set(o.id, featuresOf(o));
      await breathe();
    }
    const byWord = new Map<string, number[]>();
    const byQuestion = new Map<string, number[]>();
    const push = (m: Map<string, number[]>, k: string, id: number) => {
      const l = m.get(k);
      if (l) l.push(id);
      else m.set(k, [id]);
    };
    for (const f of feats.values()) {
      for (const w of f.words) push(byWord, w, f.id);
      for (const q of f.questions) push(byQuestion, q, f.id);
      await breathe();
    }
    const vecs = new Map<number, Int8Array | null>();
    const vec = (id: number) => {
      if (!vecs.has(id)) vecs.set(id, repo.getVectorsQ8([id]).get(id) ?? null);
      return vecs.get(id) ?? null;
    };
    const gone = new Set<number>();
    for (const ref of list) {
      const b = feats.get(ref.id);
      if (!b || gone.has(b.id)) continue;
      // kandydaci: wspólne słowo tytułu (z liczbą wspólnych słów do szybkiego odsiewu) albo wspólne pytanie
      const inter = new Map<number, number>();
      for (const w of b.words) for (const id of byWord.get(w) ?? []) inter.set(id, (inter.get(id) ?? 0) + 1);
      const byQ = new Set<number>();
      for (const q of b.questions) for (const id of byQuestion.get(q) ?? []) byQ.add(id);
      const hits: SupersedePair[] = [];
      let pending = 0;
      for (const id of new Set([...inter.keys(), ...byQ])) {
        await breathe();
        if (id === b.id || gone.has(id)) continue;
        const a = feats.get(id);
        if (!a) continue;
        const n = inter.get(id) ?? 0;
        if (!byQ.has(id) && n / (a.words.size + b.words.size - n) < TITLE_JACCARD) continue;
        const v = judge(
          a,
          b,
          () => {
            const va = vec(a.id);
            const vb = va ? vec(b.id) : null;
            return va && vb ? cosQ8(va, vb) : null;
          },
          embed,
          stems,
        );
        if (v === PENDING) pending++;
        else if (v)
          hits.push({
            older: a.id,
            newer: b.id,
            project,
            type,
            reason: v.reason,
            jaccard: r3(v.jaccard),
            cos: v.cos === null ? null : r3(v.cos),
            olderTitle: a.title,
            newerTitle: b.title,
          });
      }
      if (pending) opts.onPending?.(ref.created_at);
      // pary czekające na wektory liczą się do limitu: inaczej nadmiar przeszedłby w dwóch snach po kawałku
      if (hits.length + pending > MAX_PER_NEWER) {
        if (hits.length > MAX_PER_NEWER || !pending)
          log.warn("sen: nowa notatka pasuje do zbyt wielu starszych, bez zastąpień", {
            newer: b.id,
            pasuje: hits.length,
            czeka: pending,
            starsze: hits.slice(0, 10).map((h) => h.older),
          });
      } else
        for (const h of hits) {
          if (!opts.dryRun && !repo.supersedeObservation(h.older, h.newer, { reason: h.reason, jaccard: h.jaccard, cos: h.cos }))
            continue;
          gone.add(h.older);
          out.push(h);
          if (opts.logPairs) logPair(h, opts.dryRun ? "propose" : "supersede");
        }
      await breathe();
    }
  }
  return out;
}
