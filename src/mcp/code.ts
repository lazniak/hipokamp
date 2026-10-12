// Nawigacja po kodzie bez tree-sittera i bez natywnych modułów: lekkie wzorce sygnatur dla TS/JS, Pythona, Go, Rusta,
// rodziny C (C#, Java, C++, Kotlin, Swift, PHP), PowerShella i Markdownu. Zamiennik smart_search / smart_outline /
// smart_unfold z claude-mem: zarys pliku, rozwinięcie symbolu, szukanie symboli.
// Koniec ciała: w językach z klamrami mały lekser całego pliku (komentarze, łańcuchy, szablony z ${}, regexy) z zapasem
// po wcięciach, w Pythonie wcięcia linii logicznych, w Markdownie następny nagłówek poza blokami kodu.
// Granice: tylko pliki projektu (korzeń git dla cwd albo cwd), bez ukrytych (poza katalogami .github, .gitea, .claude)
// i wyglądających na sekrety; każda wypisana linia źródła przechodzi przez clean().
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clean, maskSource } from "../capture/redact.ts";
import { gitRoot } from "../util/paths.ts";

// katalog konfiguracji Claude Code jak claudeDir() w config.ts; bez importu config.ts, bo ten przy imporcie ustala
// DATA_DIR z HIPOKAMP_HOME, a testy w jednym procesie Buna ustawiają je dopiero później
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export interface Sym {
  name: string;
  kind: string;
  /** Numer linii od 1. */
  line: number;
  indent: number;
  sig: string;
  /** Poziom nagłówka (Markdown). */
  level?: number;
  /** Typ, do którego należy metoda zadeklarowana poza jego ciałem (Go: func (p *Pool) Grow). */
  owner?: string;
}

type Lang = "ts" | "py" | "go" | "rs" | "c" | "ps" | "md";

const EXT: Record<string, Lang> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".cs": "c",
  ".java": "c",
  ".kt": "c",
  ".kts": "c",
  ".swift": "c",
  ".php": "c",
  ".c": "c",
  ".h": "c",
  ".cc": "c",
  ".cpp": "c",
  ".hpp": "c",
  ".cxx": "c",
  ".ps1": "ps",
  ".psm1": "ps",
  ".md": "md",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  "vendor",
  "graphify-out",
  ".idea",
  ".vs",
  "bin",
  "obj",
]);
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "new",
  "await",
  "typeof",
  "else",
  "do",
  "try",
  "with",
  "using",
  "sizeof",
  "delete",
  "throw",
  "lock",
  "foreach",
  "elif",
  "match",
  "when",
  "super",
  "this",
]);

type Rule = {
  re: RegExp;
  kind: string | ((m: RegExpMatchArray) => string);
  name: (m: RegExpMatchArray) => string;
  topOnly?: boolean;
  /** Właściciel metody zadeklarowanej poza ciałem typu (Go). */
  owner?: (m: RegExpMatchArray) => string | undefined;
};

const ID = "[A-Za-z_$][\\w$]*";
const RULES: Record<Exclude<Lang, "md">, Rule[]> = {
  ts: [
    {
      re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\b\\s*\\*?\\s*(${ID})`),
      kind: "function",
      name: (m) => m[1],
    },
    {
      re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`),
      kind: "class",
      name: (m) => m[1],
    },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+(${ID})`), kind: "interface", name: (m) => m[1] },
    {
      re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${ID})\\s*(?:<[^=]*>\\s*)?=`),
      kind: "type",
      name: (m) => m[1],
    },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${ID})`), kind: "enum", name: (m) => m[1] },
    {
      re: new RegExp(
        `^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`,
      ),
      kind: "function",
      name: (m) => m[1],
    },
    {
      re: new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=`),
      kind: "const",
      name: (m) => m[1],
      topOnly: true,
    },
    {
      re: new RegExp(
        `^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set|declare)\\s+)*\\*?(${ID})\\s*(?:<[^>]*>\\s*)?\\(.*\\)\\s*(?::[^{;=]+)?\\{\\s*$`,
      ),
      kind: "method",
      name: (m) => m[1],
    },
  ],
  py: [
    {
      re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
      kind: (m) => (m[0].startsWith(" ") || m[0].startsWith("\t") ? "method" : "function"),
      name: (m) => m[1],
    },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", name: (m) => m[1] },
  ],
  go: [
    {
      re: /^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)/,
      kind: (m) => (m[1] ? "method" : "func"),
      name: (m) => m[2],
      // odbiorca "p *Pool[T]" → Pool
      owner: (m) => m[1]?.replace(/\[.*$/, "").match(/(\w+)\s*$/)?.[1],
    },
    { re: /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/, kind: (m) => m[2], name: (m) => m[1] },
  ],
  rs: [
    {
      re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
      kind: "fn",
      name: (m) => m[1],
    },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|union)\s+([A-Za-z_]\w*)/, kind: (m) => m[1], name: (m) => m[2] },
    {
      re: /^\s*impl(?:<[^>]*>)?\s+(?:([A-Za-z_][\w:<>]*)\s+for\s+)?([A-Za-z_][\w:]*)/,
      kind: "impl",
      name: (m) => (m[1] ? `${m[1]} for ${m[2]}` : m[2]),
    },
  ],
  c: [
    {
      // C++: przed nazwą alignas(…), __declspec(…), [[…]] i makro eksportu WIELKIMI literami (class Q_CORE_EXPORT
      // QObject : …); enum class to enum
      re: /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|inline|final|partial|unsafe|export|data|open)\s+)*(class|struct|interface|enum|namespace|record|object|trait)\s+(?:(?:class|struct)\s+)?(?:(?:alignas|__declspec|__attribute__)\s*\((?:[^()]|\([^()]*\))*\)\s*|\[\[[^\]]*\]\]\s*|[A-Z][A-Z0-9]*_[A-Z0-9_]*\s+(?=[A-Za-z_]\w*\s*(?:[:{]|final\b|$)))*([A-Za-z_]\w*)/,
      kind: (m) => m[1],
      name: (m) => m[2],
    },
    {
      // modyfikatory i typ zwracany (public static, fun, unsigned int *) jako słowa przed nazwą; na końcu const,
      // override, noexcept, throws, "-> typ", typ zwracany po ":" (Kotlin, Swift) albo sam ":" przed listą
      // inicjalizacyjną w następnej linii (C++). Żadne dwa sąsiednie kwantyfikatory nie biorą tych samych znaków
      // (spacje są tylko na początku grup), więc dopasowanie nie cofa się wykładniczo.
      re: /^\s*(?:[\w:<>,[\]*&?~]+\s+)*\**&?([A-Za-z_~][\w:~]*)\s*\([^;]*\)(?:\s*const)?(?:\s*override)?(?:\s*noexcept)?(?:\s*throws\s+[\w.]+(?:\s*,\s*[\w.]+)*)?(?:\s*->\s*[\w:<>]+)?(?:\s*:(?:\s*[\w<>?]+(?:\s*,\s*[\w<>?]+)*)?)?\s*(?:\{\s*)?$/,
      kind: "function",
      name: (m) => m[1],
    },
  ],
  ps: [{ re: /^\s*function\s+([\w-]+)/i, kind: "function", name: (m) => m[1] }],
};

export function langOf(path: string): Lang | null {
  return EXT[extname(path).toLowerCase()] ?? null;
}

/** Odmiana języka z rozszerzenia (cpp, kt, php…): w rodzinie C składnia różni się w szczegółach, które zna lekser. */
export function dialectOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

// C i C++: listy inicjalizacyjne konstruktorów; Java, Kotlin i PHP: bez preprocesora (# w PHP to komentarz)
const CPP = new Set(["c", "h", "cc", "cpp", "hpp", "cxx"]);
const NO_PP = new Set(["java", "kt", "kts", "php"]);
const CLASS_HEAD = new Set(["class", "struct", "union", "enum"]);

/** Wcięcie w kolumnach (tabulator do wielokrotności 4), żeby pliki z mieszanymi wcięciami dało się porównać. */
function indentOf(l: string): number {
  let w = 0;
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += 4 - (w % 4);
    else break;
  }
  return w;
}

// linia zaczynająca się od instrukcji albo znaku kontynuacji nie jest deklaracją (return foo(x), : a(1), b(2), .map(...))
const LEAD_WORDS = new Set([
  "return",
  "throw",
  "if",
  "else",
  "for",
  "foreach",
  "while",
  "switch",
  "case",
  "do",
  "try",
  "catch",
  "finally",
  "new",
  "await",
  "yield",
  "delete",
  "typeof",
  "goto",
  "break",
  "continue",
  "echo",
  "print",
  "using",
  "lock",
  "with",
]);
const LEAD_CONT = /^\s*[:,.?)\]}|&+=<>!-]/;
const MAX_SIG = 1000;

/** Nagłówek Markdown (# Tytuł, ## Tytuł ##): poziom i tytuł bez zamykających # (po spacji, jak w CommonMark). */
function mdHeading(line: string): { level: number; name: string } | null {
  const m = /^(#{1,6})[ \t]+\S/.exec(line);
  if (!m) return null;
  let t = line.slice(m[1].length).trim();
  let k = t.length;
  while (k > 0 && t[k - 1] === "#") k--;
  if (k > 0 && k < t.length && (t[k - 1] === " " || t[k - 1] === "\t")) t = t.slice(0, k).trimEnd();
  return { level: m[1].length, name: t };
}

/**
 * Zarys z linii pliku; skip[i] = 1 dla linii, która zaczyna się wewnątrz łańcucha, komentarza blokowego, bloku kodu
 * (Markdown) albo wyrażenia (otwarty nawias, poprzednia linia kończy się "=", "." itp.).
 */
function outlineLines(lines: string[], lang: Lang, skip: Uint8Array): Sym[] {
  const syms: Sym[] = [];
  for (let i = 0; i < lines.length; i++) {
    // linia dłuższa niż MAX_SIG to nie sygnatura (zminifikowany kod, dane); wzorce z wieloma kwantyfikatorami
    // nie dostają wejścia, na którym cofanie mogłoby trwać sekundami
    if (skip[i] || lines[i].length > MAX_SIG) continue;
    const line = lines[i];
    if (lang === "md") {
      const h = mdHeading(line);
      if (h)
        syms.push({
          name: h.name,
          kind: `h${h.level}`,
          line: i + 1,
          indent: (h.level - 1) * 2,
          sig: line.trim(),
          level: h.level,
        });
      continue;
    }
    if (!line.trim() || /^\s*(\/\/|\/\*|\*|#(?!\[))/.test(line) || LEAD_CONT.test(line)) continue;
    if (LEAD_WORDS.has(line.trimStart().match(/^[\w$]+/)?.[0] ?? "")) continue;
    for (const r of RULES[lang]) {
      if (r.topOnly && /^\s/.test(line)) continue;
      const m = line.match(r.re);
      if (!m) continue;
      const name = r.name(m);
      if (!name || KEYWORDS.has(name)) break;
      const sym: Sym = {
        name,
        kind: typeof r.kind === "function" ? r.kind(m) : r.kind,
        line: i + 1,
        indent: indentOf(line),
        sig: line.trim().slice(0, 160),
      };
      const owner = r.owner?.(m);
      if (owner) sym.owner = owner;
      syms.push(sym);
      break;
    }
  }
  return syms;
}

export function outlineText(text: string, lang: Lang, dialect = ""): Sym[] {
  const lines = text.split(/\r?\n/);
  if (lang === "md") return outlineLines(lines, lang, mdFences(lines));
  if (lang === "py") return outlineLines(lines, lang, pySkip(lexPy(lines)));
  return outlineBraces(lines, lang, dialect, altBudget(text.length));
}

function outlineBraces(lines: string[], lang: Lang, dialect: string, budget: AltBudget): Sym[] {
  const lex = lexBraces(lines.join("\n"), lang, false, dialect);
  return withAlts(lines, lex, outlineLines(lines, lang, braceSkip(lex)), budget, (sub, from) =>
    outlineBraces(sub, lang, dialect, budget).map((s) => ({ ...s, line: s.line + from })),
  );
}

/**
 * Gałęzie #else czytane ponownie: łącznie najwyżej 2× rozmiar pliku i 32 poziomy zagnieżdżenia. Bez limitu złośliwie
 * zagnieżdżone #if/#else leksowałyby resztę pliku na każdym poziomie (koszt kwadratowy, serwer MCP jest
 * jednowątkowy). Gałęzie ponad limit zostają poza zarysem.
 */
interface AltBudget {
  left: number;
  depth: number;
}
const ALT_DEPTH = 32;
const altBudget = (size: number): AltBudget => ({ left: 2 * size, depth: 0 });

/**
 * Gałęzie #else/#elif: lekser liczy klamry tylko w pierwszej gałęzi (klamry alternatywnych wersji kodu się nie
 * sumują), a każdą pominiętą gałąź czytamy osobno jako samodzielny tekst (read). Jej symbol wchodzi do zarysu, gdy
 * tej nazwy nie ma pierwsza gałąź ani wcześniejsza alternatywa tego samego #if: ta sama funkcja w dwóch wersjach to
 * jeden symbol (z pierwszej gałęzi), funkcja tylko z #else też jest widoczna. main jest posortowane po linii, więc
 * symbole pierwszej gałęzi to wycinek znaleziony wyszukiwaniem binarnym.
 */
function withAlts(
  lines: string[],
  lex: Lex,
  main: Sym[],
  budget: AltBudget,
  read: (sub: string[], from: number) => Sym[],
): Sym[] {
  if (!lex.alts.length || budget.depth >= ALT_DEPTH) return main;
  const out = [...main];
  const seen = new Map<number, Set<string>>();
  for (const a of lex.alts) {
    if (a.to < a.from) continue;
    let size = 0;
    for (let k = a.from; k <= a.to && size <= budget.left; k++) size += lines[k].length + 1;
    if (size > budget.left) continue;
    budget.left -= size;
    let known = seen.get(a.group);
    if (!known) {
      known = new Set<string>();
      // symbol pierwszej gałęzi: ifLine < line - 1 < elseLine
      for (let k = firstLine(main, a.ifLine + 2); k < main.length && main[k].line <= a.elseLine; k++) known.add(main[k].name);
      seen.set(a.group, known);
    }
    const names = known;
    budget.depth++;
    // przeciążenia w jednej gałęzi zostają; nazwy tej gałęzi zasłaniają dopiero następne alternatywy
    const found = read(lines.slice(a.from, a.to + 1), a.from).filter((s) => !names.has(s.name));
    budget.depth--;
    for (const s of found) names.add(s.name);
    out.push(...found);
  }
  return out.sort((x, y) => x.line - y.line);
}

/** Indeks pierwszego symbolu z linią >= line (syms posortowane po linii). */
function firstLine(syms: Sym[], line: number): number {
  let lo = 0;
  let hi = syms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (syms[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const braceSkip = (lex: Lex) => lex.inside.map((v, i) => v | lex.expr[i]);
// Python: deklaracja zaczyna linię logiczną (nie w łańcuchu, nawiasie ani po \)
const pySkip = (py: PyLex) => py.logical.map((v) => 1 - v);

// ---------- lekser języków z klamrami ----------

/** Token: słowo, znak interpunkcji, "=>", "->" albo "0" dla literału (łańcuch, szablon, regex, liczba). */
interface Tok {
  v: string;
  /** Linia początku (od 0). */
  l: number;
  /** Linia końca: różna od l tylko dla literałów wieloliniowych. */
  e: number;
}

interface Lex {
  toks: Tok[];
  /** 1, gdy linia zaczyna się wewnątrz łańcucha, szablonu albo komentarza blokowego. */
  inside: Uint8Array;
  /**
   * 1, gdy linia zaczyna się wewnątrz wyrażenia: otwarty ( albo [ w bieżącym bloku, poprzednia linia kończy się na
   * = . => -> albo trwa lista inicjalizacyjna konstruktora C++ (od ":" po ")" do klamry ciała).
   */
  expr: Uint8Array;
  /** Pominięte gałęzie #else/#elif (linie od 0, bez dyrektyw) z położeniem ich #if i pierwszego #else. */
  alts: Alt[];
}

interface Alt {
  from: number;
  to: number;
  /** Numer grupy #if ... #endif: gałęzie jednej grupy to wersje tego samego kodu. */
  group: number;
  /** Linia #if (-1: poza widokiem) i pierwszego #else/#elif: pierwsza gałąź leży między nimi. */
  ifLine: number;
  elseLine: number;
}

const isId = (c: number) =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;
const isIdStart = (c: number) => isId(c) && (c < 48 || c > 57);

// po tych tokenach "/" otwiera regex, nie dzielenie; bez "<" i ">", bo w JSX to znaczniki (</div>)
const REGEX_PREV = new Set([
  ..."(,=:[!&|?{};+-*%~^",
  "=>",
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);
// surowe łańcuchy Rusta: r"..", r#".."#, br"..", cr".."
const RS_RAW = /[bc]?r(#*)"/y;
// preprocesor: słowo dyrektywy i początek gałęzi alternatywnej (#else, #elif, #elifdef z C23, #elseif w Swifcie)
const PP_WORD = /^#\s*(\w+)/;
const PP_BRANCH = /^(?:else|elif\w*|elseif)$/;
// PHP: heredoc <<<ID, <<<"ID" i nowdoc <<<'ID' (identyfikator do końca linii)
const HEREDOC = /<<<[ \t]*(["']?)([A-Za-z_\x80-￿][\w\x80-￿]*)\1[ \t]*(?=\r?\n)/y;
// surowe łańcuchy C++: R"(..)", u8R"x(..)x"
const CPP_RAW = new Set(["R", "u8R", "uR", "UR", "LR"]);
const CPP_DELIM = /^([^()\\\s"]{0,16})\(/;
// linia kończąca się tym tokenem przenosi wyrażenie do następnej (bez ":", "*", ">": public:, char *\nf(), template<...>)
const EXPR_END = new Set(["=", "=>", "->", "."]);

/**
 * Jedno przejście po całym pliku ze stanem przez linie: komentarze (// i blokowe, w Ruście zagnieżdżone, # preprocesora),
 * łańcuchy, szablony z zagnieżdżonym ${ }, regexy (TS/JS: po operatorze, nawiasie otwierającym, słowie kluczowym albo
 * na początku linii, domknięte w tej samej linii) i specjały języków: Go `surowe`, Rust r#""# oraz 'a (lifetime),
 * C# @"" i """, PowerShell <# #>, here-stringi i ${zmienna}, PHP heredoc i nowdoc, szablony Kotlina z cudzysłowami
 * w ${ }, dyrektywy preprocesora z liniami przeniesionymi przez \ (wieloliniowe makra).
 * Niedomknięty zwykły łańcuch kończy się z linią (apostrof w tekście JSX nie połyka reszty pliku).
 */
function lexBraces(text: string, lang: Lang, want: boolean, dialect = ""): Lex {
  const toks: Tok[] = [];
  const inside: number[] = [0];
  const expr: number[] = [0];
  const alts: Alt[] = [];
  const n = text.length;
  const ts = lang === "ts";
  const ps = lang === "ps";
  const rs = lang === "rs";
  const pp = lang === "c" && !NO_PP.has(dialect);
  const cpp = lang === "c" && CPP.has(dialect);
  const php = lang === "c" && dialect === "php";
  const kt = lang === "c" && (dialect === "kt" || dialect === "kts");
  const lastEndif = pp ? text.lastIndexOf("#endif") : -1;
  let i = 0;
  let line = 0;
  let prev = "";
  let prevLine = -1;
  let init = false; // C++: lista inicjalizacyjna konstruktora (": a_(x), b_{y}" przed ciałem)
  // C++: nagłówek klasy (class API_EXPORT(W) : public Base {), w którym ":" po ")" to dziedziczenie, nie lista
  let head = false;
  const tpl: number[] = []; // otwarte ${ }: głębokość klamer w środku
  const tplEnd: string[] = []; // znacznik końca szablonu, do którego wraca każde ${ } (`, " albo """)
  const tplToks: Tok[] = []; // szablony czekające na koniec ${ }
  const frames: number[] = [0]; // otwarte ( i [ w każdym poziomie klamer
  const ifs: number[] = []; // linie otwartych #if
  let groups = 0;
  const nl = (str: boolean) => {
    line++;
    inside.push(str ? 1 : 0);
    expr.push(!str && (frames[frames.length - 1] > 0 || EXPR_END.has(prev) || init) ? 1 : 0);
  };
  const tok = (v: string, from = line) => {
    if (want) toks.push({ v, l: from, e: line });
    prev = v;
    prevLine = line;
  };
  const eol = () => {
    while (i < n && text.charCodeAt(i) !== 10) i++;
  };
  // znak po ucieczce; ucieczka końca linii przenosi łańcuch do następnej
  const escaped = () => {
    i++;
    if (text.charCodeAt(i) === 13) i++;
    if (text.charCodeAt(i) === 10) nl(true);
    i++;
  };
  // łańcuch do cudzysłowu q; esc = znak ucieczki (-1: brak); cut = niedomknięty kończy się z linią; dbl = podwojony q to znak
  const quoted = (q: number, esc: number, cut: boolean, dbl: boolean) => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === esc) escaped();
      else if (c === q) {
        i++;
        if (!dbl || text.charCodeAt(i) !== q) return;
        i++;
      } else if (c === 10) {
        if (cut) return;
        nl(true);
        i++;
      } else i++;
    }
  };
  // komentarz blokowy albo surowy łańcuch do znacznika close (nested: zagnieżdżone komentarze Rusta)
  const until = (close: string, nested?: string) => {
    const c0 = close.charCodeAt(0);
    let depth = 1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === c0 && text.startsWith(close, i)) {
        i += close.length;
        if (--depth === 0) return;
      } else if (nested && c === 47 && text.startsWith(nested, i)) {
        i += nested.length;
        depth++;
      } else {
        if (c === 10) nl(true);
        i++;
      }
    }
  };
  // treść szablonu do znacznika close (` w TS, " i """ w Kotlinie); true = wejście w ${ (dalej zwykły kod, także
  // z łańcuchami w środku), false = koniec szablonu. Zwykły łańcuch Kotlina niedomknięty kończy się z linią,
  // surowy """ nie ma ucieczek.
  const template = (close: string): boolean => {
    const q = close.charCodeAt(0);
    const raw = close === '"""';
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 92 && !raw) escaped();
      else if (c === q && (close.length === 1 || text.startsWith(close, i))) {
        i += close.length;
        prev = "0";
        prevLine = line;
        return false;
      } else if (c === 36 && text.charCodeAt(i + 1) === 123) {
        i += 2;
        tpl.push(0);
        tplEnd.push(close);
        frames.push(1); // wnętrze ${ } to wyrażenie
        prev = "{";
        prevLine = line;
        return true;
      } else if (c === 10 && close === '"') {
        prev = "0";
        prevLine = line;
        return false;
      } else {
        if (c === 10) nl(true);
        i++;
      }
    }
    return false;
  };
  // początek szablonu: jeden token literału, który kończy się dopiero z ostatnim kawałkiem szablonu
  const openTemplate = (close: string) => {
    i += close.length;
    const t: Tok = { v: "0", l: line, e: line };
    if (want) toks.push(t);
    if (template(close)) tplToks.push(t);
    else t.e = line;
  };
  // regex musi się domknąć w tej samej linii; inaczej "/" to dzielenie
  const regex = (): boolean => {
    let j = i + 1;
    let cls = false;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 13) return false;
      if (c === 92) {
        j++;
        const d = text.charCodeAt(j);
        if (d === 10 || d === 13) return false;
      } else if (cls) {
        if (c === 93) cls = false;
      } else if (c === 91) cls = true;
      else if (c === 47) break;
    }
    if (j >= n) return false;
    j++;
    while (j < n && isId(text.charCodeAt(j))) j++;
    i = j;
    return true;
  };
  // C, C++, C#, Swift: gałęzie #else/#elif pomijamy aż do #endif, żeby klamry alternatywnych wersji kodu się nie
  // sumowały; każdą zapisujemy w alts, zarys czyta je osobno (withAlts)
  const skipBranch = () => {
    const group = groups++;
    const ifLine = ifs.length ? ifs[ifs.length - 1] : -1;
    const elseLine = line;
    let from = line + 1;
    let depth = 0;
    eol();
    while (i < n) {
      i++;
      nl(true);
      let j = i;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
      const w = text.charCodeAt(j) === 35 ? (PP_WORD.exec(text.slice(j, j + 16))?.[1] ?? "") : "";
      if (w.startsWith("if")) depth++;
      else if (depth === 0 && PP_BRANCH.test(w)) {
        alts.push({ from, to: line - 1, group, ifLine, elseLine });
        from = line + 1;
      } else if (w === "endif" && depth-- === 0) {
        alts.push({ from, to: line - 1, group, ifLine, elseLine });
        ifs.pop();
        eol();
        return;
      }
      eol();
    }
  };
  // dyrektywa preprocesora do końca linii razem z liniami przeniesionymi przez \ (klamry wieloliniowego #define nie
  // należą do kodu wokół); #else i #elif otwierają gałąź alternatywną
  const directive = () => {
    const w = PP_WORD.exec(text.slice(i, i + 16))?.[1] ?? "";
    // gałąź bez #endif dalej w pliku czytamy jak zwykły kod (pozycja ostatniego #endif liczona raz, nie przy każdym #else)
    if (PP_BRANCH.test(w) && i <= lastEndif) return skipBranch();
    if (w.startsWith("if")) ifs.push(line);
    else if (w === "endif") ifs.pop();
    eol();
    while (i < n) {
      let k = i - 1;
      if (text.charCodeAt(k) === 13) k--;
      if (text.charCodeAt(k) !== 92) return;
      i++;
      nl(true);
      eol();
    }
  };
  // PHP: treść heredoc i nowdoc do linii, która (po wcięciu) zaczyna się identyfikatorem zamykającym
  const heredoc = (id: string) => {
    while (i < n) {
      eol();
      if (i >= n) return;
      i++;
      nl(true);
      let j = i;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
      if (text.startsWith(id, j) && !isId(text.charCodeAt(j + id.length))) {
        i = j + id.length;
        return;
      }
    }
  };
  // PowerShell: @" albo @' na końcu linii otwiera here-string zamykany przez "@ / '@ na początku linii
  const hereString = (q: number): boolean => {
    let j = i + 2;
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 13)) j++;
    if (j < n && text.charCodeAt(j) !== 10) return false;
    const s = line;
    const close = q === 34 ? '"@' : "'@";
    i = j;
    while (i < n) {
      i++;
      nl(true);
      if (text.startsWith(close, i)) {
        i += 2;
        break;
      }
      eol();
    }
    tok("0", s);
    return true;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      nl(false);
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) {
      i++;
      continue;
    }
    const d = text.charCodeAt(i + 1);
    const first = prevLine < line; // pierwszy znaczący znak w linii
    const s = line;
    if (ps) {
      if (c === 60 && d === 35) {
        i += 2;
        until("#>");
        continue;
      }
      if (c === 35) {
        eol();
        continue;
      }
      if (c === 96) {
        // ` ucieka znak albo przenosi wiersz (następna linia to ciąg tej samej instrukcji)
        i++;
        if (text.charCodeAt(i) === 13) i++;
        if (text.charCodeAt(i) === 10) {
          nl(false);
          expr[line] = 1;
        }
        i++;
        continue;
      }
      if (c === 36 && d === 123) {
        // ${zmienna}
        i += 2;
        while (i < n && text.charCodeAt(i) !== 125) {
          if (text.charCodeAt(i) === 10) nl(true);
          i++;
        }
        i++;
        tok("0", s);
        continue;
      }
      if (c === 64 && (d === 34 || d === 39) && hereString(d)) continue;
      if (c === 34 || c === 39) {
        i++;
        quoted(c, c === 34 ? 96 : -1, false, true);
        tok("0", s);
        continue;
      }
    } else {
      if (c === 47 && d === 47) {
        eol();
        continue;
      }
      if (c === 47 && d === 42) {
        i += 2;
        until("*/", rs ? "/*" : undefined);
        continue;
      }
      // PHP: # to komentarz w dowolnym miejscu linii (#[ otwiera atrybut)
      if (php && c === 35 && d !== 91) {
        eol();
        continue;
      }
      // dyrektywy preprocesora, shebang
      if (c === 35 && first && (pp || (line === 0 && d === 33))) {
        if (pp) directive();
        else eol();
        continue;
      }
      if (php && c === 60 && d === 60 && text.charCodeAt(i + 2) === 60) {
        HEREDOC.lastIndex = i;
        const m = HEREDOC.exec(text);
        if (m) {
          i += m[0].length;
          heredoc(m[2]);
          tok("0", s);
          continue;
        }
      }
    }
    if (ts && (c === 34 || c === 39)) {
      i++;
      quoted(c, 92, true, false);
      tok("0", s);
      continue;
    }
    if (ts && c === 96) {
      openTemplate("`");
      continue;
    }
    if (kt && c === 34) {
      openTemplate(text.startsWith('"""', i) ? '"""' : '"');
      continue;
    }
    if (lang === "go" && (c === 34 || c === 39 || c === 96)) {
      i++;
      if (c === 96) quoted(96, -1, false, false);
      else quoted(c, 92, true, false);
      tok("0", s);
      continue;
    }
    if (rs) {
      if (c === 114 || c === 98 || c === 99) {
        RS_RAW.lastIndex = i;
        const m = RS_RAW.exec(text);
        if (m) {
          i += m[0].length;
          until(`"${m[1]}`);
          tok("0", s);
          continue;
        }
        if ((c === 98 || c === 99) && (d === 34 || d === 39)) {
          i += 2;
          quoted(d, 92, d === 39, false);
          tok("0", s);
          continue;
        }
      }
      if (c === 34) {
        i++;
        quoted(34, 92, false, false);
        tok("0", s);
        continue;
      }
      if (c === 39) {
        // znak ('x', '\n') albo lifetime / etykieta ('a)
        const e = text.charCodeAt(i + 2);
        if (d === 92) {
          i++;
          quoted(39, 92, true, false);
        } else if (e === 39 && d !== 10) i += 3;
        else if (d >= 0xd800 && d <= 0xdbff && text.charCodeAt(i + 3) === 39) i += 4;
        else {
          i++;
          while (i < n && isId(text.charCodeAt(i))) i++;
        }
        tok("0", s);
        continue;
      }
    }
    if (lang === "c" && (c === 34 || c === 39 || c === 96)) {
      const raw =
        c === 34 && text.charCodeAt(i - 1) === 82 && CPP_RAW.has(prev) ? CPP_DELIM.exec(text.slice(i + 1, i + 18)) : null;
      if (raw) {
        // C++: R"delim( ... )delim"
        i += raw[0].length + 1;
        until(`)${raw[1]}"`);
      } else if (
        c === 34 &&
        (text.charCodeAt(i - 1) === 64 || (text.charCodeAt(i - 1) === 36 && text.charCodeAt(i - 2) === 64))
      ) {
        // C#: @"..." i @$"..." (wieloliniowe, "" to cudzysłów, więc @""" zaczyna się od cudzysłowu)
        i++;
        quoted(34, -1, false, true);
      } else if (c === 34 && text.startsWith('"""', i)) {
        // Java, Kotlin, Swift, C#: łańcuch wieloliniowy
        i += 3;
        until('"""');
      } else {
        i++;
        quoted(c, c === 96 ? -1 : 92, true, false);
      }
      tok("0", s);
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n) {
        const x = text.charCodeAt(j);
        if (isId(x) || (ps && x === 45)) j++;
        else break;
      }
      const w = text.slice(i, j);
      // "class" w <...> szablonu albo w nawiasach parametru (f(struct S *s)) nie otwiera nagłówka
      if (cpp && frames[frames.length - 1] === 0 && CLASS_HEAD.has(w)) head = true;
      tok(w);
      i = j;
      continue;
    }
    if (c >= 48 && c <= 57) {
      let j = i + 1;
      while (j < n) {
        const x = text.charCodeAt(j);
        if (isId(x) || x === 46) j++;
        else break;
      }
      tok("0");
      i = j;
      continue;
    }
    if (ts && c === 47 && (first || REGEX_PREV.has(prev)) && regex()) {
      tok("0", s);
      continue;
    }
    if (c === 61 && d === 62) {
      tok("=>");
      i += 2;
      continue;
    }
    if (c === 45 && d === 62) {
      tok("->");
      i += 2;
      continue;
    }
    if (c === 123) {
      if (tpl.length) tpl[tpl.length - 1]++;
      // klamra po ")" albo po "}" ostatniego inicjalizatora to ciało konstruktora; po nazwie pola (a_{x}) to inicjalizator
      if (init && (prev === ")" || prev === "}" || prev === "noexcept")) init = false;
      head = false;
      frames.push(0);
      tok("{");
      i++;
      continue;
    }
    if (c === 125) {
      if (tpl.length) {
        const top = tpl.length - 1;
        if (tpl[top] === 0) {
          // koniec ${ }: wracamy do treści szablonu
          tpl.pop();
          frames.pop();
          i++;
          const t = tplToks.pop()!;
          if (template(tplEnd.pop() ?? "`")) tplToks.push(t);
          else t.e = line;
          continue;
        }
        tpl[top]--;
      }
      if (frames.length > 1) frames.pop();
    } else if (c === 40 || c === 91) frames[frames.length - 1]++;
    else if ((c === 41 || c === 93) && frames[frames.length - 1] > 0) frames[frames.length - 1]--;
    // C++: ":" po ")" (nie "::") zaczyna listę inicjalizacyjną, chyba że to nagłówek klasy; średnik kończy (to był
    // trójargumentowy operator albo deklaracja), ">" zamyka listę parametrów szablonu (template <class T>)
    else if (cpp && c === 58 && d !== 58 && text.charCodeAt(i - 1) !== 58 && (prev === ")" || prev === "noexcept")) init = !head;
    else if (c === 59) {
      init = false;
      head = false;
    } else if (c === 62) head = false;
    tok(text[i]);
    i++;
  }
  return { toks, inside: Uint8Array.from(inside), expr: Uint8Array.from(expr), alts };
}

// ---------- Python i Markdown ----------

interface PyLex {
  /** 1: linia zaczyna nową linię logiczną (poza łańcuchem, nawiasem i kontynuacją \). */
  logical: Uint8Array;
  /** 1: linia zaczyna się wewnątrz łańcucha. */
  inStr: Uint8Array;
  /** 1: w linii jest dwukropek poza nawiasami, łańcuchami i komentarzem. */
  colon: Uint8Array;
  /** Głębokość nawiasów na końcu linii. */
  depth: Int32Array;
}

function lexPy(lines: string[]): PyLex {
  const n = lines.length;
  const logical = new Uint8Array(n);
  const inStr = new Uint8Array(n);
  const colon = new Uint8Array(n);
  const depth = new Int32Array(n);
  let str = ""; // otwarty łańcuch: ', ", ''' albo """
  let d = 0;
  let cont = false;
  for (let li = 0; li < n; li++) {
    const l = lines[li];
    inStr[li] = str ? 1 : 0;
    logical[li] = !str && d === 0 && !cont ? 1 : 0;
    cont = false;
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      if (str) {
        if (c === "\\") j++;
        else if (c === str[0] && l.startsWith(str, j)) {
          j += str.length - 1;
          str = "";
        }
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") {
        str = l.startsWith(c + c + c, j) ? c + c + c : c;
        j += str.length - 1;
      } else if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") d = Math.max(0, d - 1);
      else if (c === ":" && d === 0) colon[li] = 1;
      else if (c === "\\" && !l.slice(j + 1).trim()) cont = true;
    }
    // zwykły cudzysłów nie przechodzi do następnej linii, chyba że linia kończy się \
    if (str.length === 1) {
      if (l.endsWith("\\")) cont = true;
      else str = "";
    }
    depth[li] = d;
  }
  return { logical, inStr, colon, depth };
}

/** Linie bloków kodu w Markdownie (``` i ~~~ razem z płotami); blok zamyka ten sam znak w co najmniej tej samej liczbie. */
function mdFences(lines: string[]): Uint8Array {
  const f = new Uint8Array(lines.length);
  let open = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (open) {
      f[i] = 1;
      if (m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = "";
    } else if (m) {
      f[i] = 1;
      open = m[1];
    }
  }
  return f;
}

// ---------- końce symboli ----------

// deklaracje kończące się jak instrukcja (średnik albo nowa instrukcja), nie klamrą ciała
const STMT_KINDS = new Set(["const", "type"]);
const NO_TYPES = new Set<string>();
// po tych tokenach klamra otwiera literał typu, nie ciało (TS: typ zwracany, Go: struct{} i interface{})
const TYPE_PREV: Partial<Record<Lang, Set<string>>> = {
  ts: new Set([
    ":",
    "|",
    "&",
    "?",
    "keyof",
    "typeof",
    "is",
    "infer",
    "readonly",
    "extends",
    "asserts",
    "unique",
    "as",
    "satisfies",
  ]),
  go: new Set(["struct", "interface"]),
};
// linia kończąca się tym tokenem ma ciąg dalszy
// (bez "?": na końcu linii to zwykle typ z null w Kotlinie, C# i Swifcie, a nie trójargumentowy operator)
const CONT_END = new Set([..."=([{,.+-*/%&|^!:<~", "=>", "->", "extends", "implements", "throws", "where", "keyof", "typeof"]);
// linia zaczynająca się tym tokenem kontynuuje poprzednią
const CONT_START = new Set([
  ...".?:)]},+-*/%&|^=<>",
  "=>",
  "->",
  "as",
  "satisfies",
  "extends",
  "implements",
  "throws",
  "where",
  "instanceof",
  "in",
  "of",
]);

function firstTok(toks: Tok[], line: number): number {
  let lo = 0;
  let hi = toks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].l < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function matchBrace(toks: Tok[], k: number): number {
  let d = 0;
  for (let j = k; j < toks.length; j++) {
    const v = toks[j].v;
    if (v === "{") d++;
    else if (v === "}" && --d === 0) return j;
  }
  return -1;
}

/** Czy token tk (pierwszy w swojej linii) zaczyna nową instrukcję na poziomie deklaracji. */
function startsNew(lines: string[], lex: Lex, prev: Tok, tk: Tok, indent: number, block: boolean): boolean {
  if (lex.inside[tk.l] || indentOf(lines[tk.l]) > indent) return false;
  if (CONT_END.has(prev.v) || CONT_START.has(tk.v)) return false;
  return !(block && tk.v === "{"); // klamra w osobnej linii (Allman) to wciąż ta deklaracja
}

/** Koniec instrukcji (const, type, funkcja strzałkowa bez klamer): średnik poza nawiasami albo nowa instrukcja. */
function stmtEnd(lines: string[], lex: Lex, k: number, indent: number, prev: Tok | null): number {
  const toks = lex.toks;
  let d = 0;
  for (; k < toks.length; k++) {
    const tk = toks[k];
    if (prev && tk.l > prev.e && d === 0 && startsNew(lines, lex, prev, tk, indent, false)) return prev.e;
    const v = tk.v;
    if (v === "(" || v === "[" || v === "{") d++;
    else if (v === ")" || v === "]" || v === "}") {
      if (--d < 0) return prev ? prev.e : tk.l; // koniec bloku nadrzędnego
    } else if (v === ";" && d === 0) return tk.l;
    prev = tk;
  }
  return prev ? prev.e : -1;
}

/**
 * Ciało w klamrach. Klamry w nawiasach (parametry, domyślne = {}, destrukturyzacja), w <...> i w literałach typu
 * (typ zwracany `: { ... }`, `Promise<{ ... }>`) nie są ciałem; ciało to pierwsza klamra po kompletnej sygnaturze
 * albo po =>. open = linia klamry ciała (-1: deklaracja bez ciała), end = linia końca (-1: nie wiadomo).
 */
function blockEnd(lines: string[], lex: Lex, k: number, indent: number, typePrev: Set<string>): { open: number; end: number } {
  const toks = lex.toks;
  let p = 0;
  let b = 0;
  let a = 0;
  let t = 0;
  let prev: Tok | null = null;
  for (; k < toks.length; k++) {
    const tk = toks[k];
    if (prev && tk.l > prev.e && p + b + a + t === 0 && startsNew(lines, lex, prev, tk, indent, true))
      return { open: -1, end: prev.e };
    const v = tk.v;
    if (v === "(") p++;
    else if (v === ")") p = Math.max(0, p - 1);
    else if (v === "[") b++;
    else if (v === "]") b = Math.max(0, b - 1);
    else if (p + b === 0) {
      if (t === 0 && v === "<") a++;
      else if (v === ">" && a > 0) a--;
      else if (a === 0) {
        if (v === "{") {
          if (t > 0 || (prev && typePrev.has(prev.v))) t++;
          else {
            const close = matchBrace(toks, k);
            if (close < 0) return { open: tk.l, end: -1 };
            const nx = toks[close + 1];
            // grupa w jednej linii z "," albo "{" za nią to inicjalizator (C++ a{1}, b{2} {), nie ciało
            if (toks[close].l === tk.l && nx?.l === tk.l && (nx.v === "," || nx.v === "{")) {
              prev = toks[close];
              k = close;
              continue;
            }
            return { open: tk.l, end: toks[close].l };
          }
        } else if (v === "}") {
          if (t === 0) return { open: -1, end: prev ? prev.e : tk.l }; // koniec bloku nadrzędnego: bez ciała
          t--;
        } else if (t === 0 && v === ";") return { open: -1, end: tk.l };
        else if (t === 0 && v === "=>" && toks[k + 1]?.v !== "{")
          return { open: -1, end: stmtEnd(lines, lex, k + 1, indent, tk) };
      }
    }
    prev = tk;
  }
  return { open: -1, end: -1 };
}

/** Następna linia z kodem (bez pustych, komentarzy i wnętrz łańcuchów) albo -1. */
function nextCode(lines: string[], inside: Uint8Array, from: number): number {
  for (let k = from; k < lines.length; k++) {
    if (inside[k]) continue;
    const t = lines[k].trim();
    if (t && !/^(\/\/|\/\*|\*|#)/.test(t)) return k;
  }
  return -1;
}

/**
 * Zapas dla sformatowanego kodu: ciało kończy pierwsza dalsza linia (poza łańcuchem i komentarzem) z wcięciem
 * nie większym niż deklaracja, która zaczyna się od "}" (też "};", "})", "},"). Inna linia na tym poziomie kończy
 * ciało na poprzedniej linii z kodem.
 */
function indentEnd(lines: string[], inside: Uint8Array, from: number, indent: number): number {
  let last = from;
  for (let k = from + 1; k < lines.length; k++) {
    const l = lines[k];
    if (inside[k]) {
      last = k;
      continue;
    }
    const t = l.trim();
    if (!t) continue;
    if (indentOf(l) <= indent) {
      if (t.startsWith("}")) return k;
      // dalszy ciąg sygnatury albo klamra w osobnej linii należą do symbolu, komentarz przy krawędzi go nie kończy
      if (/^[)\]{]/.test(t)) last = k;
      else if (!/^(\/\/|\/\*|\*|#)/.test(t)) return last;
      continue;
    }
    last = k;
  }
  return last;
}

/** Linia końca symbolu; strict: -1 zamiast zapasu po wcięciach, gdy leksemy nie znajdą końca (gałąź #else). */
function braceEnd(lines: string[], lex: Lex, sym: Sym, lang: Lang, strict = false): number {
  const start = sym.line - 1;
  const k = firstTok(lex.toks, start);
  if (STMT_KINDS.has(sym.kind)) {
    const e = stmtEnd(lines, lex, k, sym.indent, null);
    return e >= start ? e : strict ? -1 : indentEnd(lines, lex.inside, start, sym.indent);
  }
  const typePrev =
    lang === "go" && (sym.kind === "struct" || sym.kind === "interface") ? NO_TYPES : (TYPE_PREV[lang] ?? NO_TYPES);
  const { open, end } = blockEnd(lines, lex, k, sym.indent, typePrev);
  if (open < 0) return end >= start ? end : strict ? -1 : indentEnd(lines, lex.inside, start, sym.indent);
  if (end < 0) return strict ? -1 : indentEnd(lines, lex.inside, open, sym.indent);
  const closes = (l: number) => /^\s*\}/.test(lines[l]) && indentOf(lines[l]) <= sym.indent;
  if (closes(end)) return end;
  // zamknięcie w nietypowym miejscu (ciało w jednej linii, "x }"): wierzymy leksemom, jeśli dalej kod wraca do poziomu
  // deklaracji albo jeśli wcięcia też nie znajdą porządnego "}"; inaczej leksemy się pomyliły i wygrywają wcięcia
  const nx = nextCode(lines, lex.inside, end + 1);
  if (nx < 0 || indentOf(lines[nx]) <= sym.indent) return end;
  const fb = indentEnd(lines, lex.inside, open, sym.indent);
  return fb > end && closes(fb) ? fb : end;
}

/** Python: nagłówek może mieć wiele linii (Black), ciało trwa, dopóki linie logiczne są wcięte głębiej niż def/class. */
function pyEnd(lines: string[], py: PyLex, sym: Sym): number {
  const start = sym.line - 1;
  let head = start;
  for (let j = start; j < Math.min(lines.length, start + 200); j++) {
    if (py.colon[j] && py.depth[j] === 0) {
      head = j;
      break;
    }
  }
  let end = head;
  for (let k = head + 1; k < lines.length; k++) {
    if (!py.logical[k]) {
      end = k; // wnętrze łańcucha (docstring), nawiasu albo kontynuacja \: należy do ciała niezależnie od wcięcia
      continue;
    }
    const l = lines[k];
    const t = l.trim();
    if (!t) continue;
    const ind = indentOf(l);
    if (t.startsWith("#")) {
      if (ind > sym.indent) end = k; // komentarz przy lewej krawędzi nie kończy ciała, ale też do niego nie należy
      continue;
    }
    if (ind <= sym.indent) break;
    end = k;
  }
  return end;
}

/** Markdown: sekcja do następnego nagłówka tego samego albo wyższego poziomu, z pominięciem bloków kodu. */
function mdEnd(lines: string[], fences: Uint8Array, sym: Sym): number {
  const level = sym.level ?? 6;
  let end = lines.length - 1;
  for (let i = sym.line; i < lines.length; i++) {
    if (fences[i]) continue;
    const h = lines[i].match(/^(#{1,6})\s+\S/);
    if (h && h[1].length <= level) {
      end = i - 1;
      break;
    }
  }
  while (end > sym.line - 1 && !lines[end].trim()) end--;
  return end;
}

/** Zarys pliku razem z końcami symboli: end(sym) = indeks linii (od 0), na której symbol się kończy. */
export function rangesOf(text: string, lang: Lang, dialect = ""): { lines: string[]; syms: Sym[]; end: (s: Sym) => number } {
  const lines = text.split(/\r?\n/);
  if (lang === "md") {
    const fences = mdFences(lines);
    return { lines, syms: outlineLines(lines, lang, fences), end: (s) => mdEnd(lines, fences, s) };
  }
  if (lang === "py") {
    const py = lexPy(lines);
    return { lines, syms: outlineLines(lines, lang, pySkip(py)), end: (s) => pyEnd(lines, py, s) };
  }
  return { lines, ...braceRanges(lines, lang, dialect, false, altBudget(text.length)) };
}

/**
 * Języki z klamrami razem z gałęziami #else/#elif (withAlts). Symbol z gałęzi alternatywnej kończy się tam, gdzie
 * wskazują leksemy jego gałęzi; gdy ciało nie domyka się przed #endif (wspólne ciało za dyrektywą), po wcięciach
 * w całym pliku (linie gałęzi i dyrektyw są tam „wewnątrz”, więc liczy się kod za #endif).
 */
function braceRanges(
  lines: string[],
  lang: Lang,
  dialect: string,
  strict: boolean,
  budget: AltBudget,
): { syms: Sym[]; end: (s: Sym) => number } {
  const lex = lexBraces(lines.join("\n"), lang, true, dialect);
  const ends = new Map<Sym, number>();
  const syms = withAlts(lines, lex, outlineLines(lines, lang, braceSkip(lex)), budget, (sub, from) => {
    const r = braceRanges(sub, lang, dialect, true, budget);
    return r.syms.map((s) => {
      const moved = { ...s, line: s.line + from };
      const e = r.end(s);
      ends.set(moved, e >= 0 ? e + from : indentEnd(lines, lex.inside, moved.line - 1, moved.indent));
      return moved;
    });
  });
  return { syms, end: (s) => ends.get(s) ?? braceEnd(lines, lex, s, lang, strict) };
}

// ---------- granice projektu i redakcja ----------

const WIN = process.platform === "win32";
// Nazwy plików i katalogów z sekretami: .env (też prod.env), klucze SSH, klucze i magazyny (.pem, .key, .pfx…) oraz
// rdzeń secrets i credentials sam albo z dowolnym rozszerzeniem (secrets.h, secrets.py, credentials.json,
// secrets.prod.yaml, katalogi secrets.d i secrets.local). Takie pliki trzymają wartości w konwencjach, których redakcja
// nie musi znać. Wyjątek: moduł kodu z rolą w nazwie (credentials.service.ts, secrets.module.ts, secrets.d.ts) to kod
// obsługi sekretów, nie ich magazyn, a jego typowe wartości maskuje clean() (test w code.test.ts). Bez wyjątku role,
// które zwykle trzymają wartości: mock, test, spec, store, model (atrapy i dane testowe z prawdziwymi kluczami).
// Rdzeń w środku nazwy (CredentialsForm.tsx, arduino_secrets.h) nie blokuje; #define SECRET_PASS "…" maskuje clean().
const CODE_ROLE =
  "service|controller|module|component|dto|guard|repository|entity|schema|types?|d|utils?|helpers?|manager|provider|handler|resolver|factory|interface|hooks?|client|api|view";
const SECRET_NAME = new RegExp(
  String.raw`^(?:\.env.*|.+\.env|id_(?:rsa|dsa|ecdsa|ed25519).*|(?:secrets?|credentials?)(?!(?:\.(?:${CODE_ROLE}))+\.[a-z]+$)(?:\..*)?|.*\.(?:pem|key|pfx|p12|kdbx|ppk|jks|keystore))$`,
  "i",
);
// katalogi z kropką, które smart_* czytają (CI i konfiguracja projektu); inne ukryte (.git, .ssh, .aws, .vscode…)
// odpadają, a w środku dalej obowiązują ukryte pliki i nazwy sekretów
const DOT_DIRS = new Set([".github", ".gitea", ".claude"]);

/** Ścieżka p względem korzenia albo null, gdy p leży poza nim (Windows: bez rozróżniania wielkości liter). */
function within(root: string, p: string): string | null {
  const r = WIN ? relative(root.toLowerCase(), p.toLowerCase()) : relative(root, p);
  if (r === "") return "";
  if (isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`) || r.startsWith("../")) return null;
  return relative(root, p);
}

/** Powód odmowy dla ścieżki względnej w projekcie: elementy ukryte (.env, .git, poza DOT_DIRS) i nazwy sekretów. */
function refused(rel: string): string | null {
  for (const part of rel.split(/[\\/]+/)) {
    if (part.startsWith(".") && !DOT_DIRS.has(part.toLowerCase())) return "pliki i katalogi ukryte są niedostępne";
    if (SECRET_NAME.test(part)) return "plik albo katalog z sekretami";
  }
  return null;
}

/**
 * Katalogi konfiguracji Claude Code (ścieżki rzeczywiste, istniejące): CLAUDE_CONFIG_DIR i zawsze ~/.claude, bo
 * CLAUDE_CONFIG_DIR wskazujący gdzie indziej nie czyni ~/.claude mniej prywatnym.
 */
function claudeConfigs(): string[] {
  const out: string[] = [];
  for (const d of [claudeDir(), join(homedir(), ".claude")]) {
    try {
      const r = realpathSync.native(d);
      if (!out.some((x) => within(x, r) === "")) out.push(r);
    } catch {
      // nie istnieje
    }
  }
  return out;
}

/**
 * Katalog konfiguracji Claude Code (ustawienia z env, transkrypty, pamięć, plany, skrypty skilli i hooków) leży
 * w projekcie, np. gdy korzeniem jest katalog domowy: wyjątek .claude go nie otwiera. Projekt w środku konfiguracji
 * (repo skilla w ~/.claude/skills) czyta się normalnie.
 */
function inClaudeConfig(real: string, realRoot: string, cfgs = claudeConfigs()): boolean {
  return cfgs.some((cfg) => within(cfg, real) !== null && within(cfg, realRoot) === null);
}

/**
 * Ścieżka w obrębie projektu: korzeń git dla cwd (katalog albo plik .git), inaczej cwd. Odmawia wyjścia poza korzeń
 * (ścieżki bezwzględne, .., inne dyski, UNC) i dowiązań prowadzących na zewnątrz (porównanie ścieżek rzeczywistych).
 * realpathSync.native rozwija też krótkie nazwy 8.3 z Windows (HIDDEN~1 to .hidden), zwykły realpathSync ich nie rusza.
 */
function confine(p: string, cwd: string): { path: string; shown: string } | { error: string } {
  const root = resolve(gitRoot(cwd)?.root ?? cwd);
  const abs = resolve(cwd, p);
  const rel = within(root, abs);
  if (rel === null) return { error: `Odmowa: ${p} leży poza projektem (${root}).` };
  let why = refused(rel);
  if (why) return { error: `Odmowa: ${p}: ${why}.` };
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync.native(abs);
    realRoot = realpathSync.native(root);
  } catch {
    return { error: `Nie ma takiego pliku ani katalogu: ${p}` };
  }
  const realRel = within(realRoot, real);
  if (realRel === null) return { error: `Odmowa: ${p} prowadzi poza projekt (dowiązanie).` };
  why = refused(realRel);
  if (why) return { error: `Odmowa: ${p}: ${why}.` };
  if (inClaudeConfig(real, realRoot)) return { error: `Odmowa: ${p}: katalog konfiguracji Claude Code.` };
  return { path: real, shown: abs };
}

/**
 * clean() dostaje pojedyncze linie, więc bloki wieloliniowe (<private>…</private>, klucz PEM, także ucięty) i przypisania
 * złamane przez formatter (klucz w jednej linii, literał w następnej) maskujemy wcześniej, linia po linii, żeby numeracja
 * się nie przesunęła. Całość w capture/redact.ts (maskSource): podłoga z main i reguły ścisłe jako suma zakresów, liniowo.
 */
export function maskBlocks(text: string): string {
  return maskSource(text);
}

/** Sygnatura do wypisania: cała linia przez clean(), dopiero potem przycięta. */
const sigOf = (lines: string[], s: Sym) => clean(lines[s.line - 1].trim()).slice(0, 160);

function readCode(path: string): { text: string; lang: Lang; dialect: string } | { error: string } {
  const lang = langOf(path);
  if (!lang) return { error: `nieobsługiwane rozszerzenie: ${extname(path) || "(brak)"}` };
  try {
    const st = statSync(path);
    if (!st.isFile()) return { error: `to nie jest plik: ${path}` };
    if (st.size > 2_000_000) return { error: "plik większy niż 2 MB" };
    return { text: maskBlocks(readFileSync(path, "utf8")), lang, dialect: dialectOf(path) };
  } catch {
    return { error: `nie można odczytać pliku: ${path}` };
  }
}

// ---------- narzędzia ----------

export function smartOutline(filePath: string, cwd: string): string {
  const t = confine(filePath, cwd);
  if ("error" in t) return t.error;
  const r = readCode(t.path);
  if ("error" in r) return r.error;
  const lines = r.text.split(/\r?\n/);
  const syms = outlineText(r.text, r.lang, r.dialect);
  if (!syms.length) return `${filePath}: ${lines.length} linii, brak rozpoznanych symboli.`;
  const minIndent = Math.min(...syms.map((s) => s.indent));
  return [
    `${filePath}: ${lines.length} linii, ${syms.length} symboli`,
    ...syms.map((s) => `L${s.line} ${" ".repeat(Math.min(12, s.indent - minIndent))}${sigOf(lines, s)}`),
  ].join("\n");
}

type Ranges = ReturnType<typeof rangesOf>;

function fuzzy(list: Sym[], name: string): Sym | undefined {
  const l = name.toLowerCase();
  return (
    list.find((s) => s.name === name) ??
    list.find((s) => s.name.toLowerCase() === l) ??
    list.find((s) => s.name.toLowerCase().includes(l))
  );
}

/**
 * Symbol po nazwie. "Klasa.metoda" (albo Klasa::metoda) szuka metody tylko w zakresie klasy, wśród metod Go z tym
 * odbiorcą i w blokach impl Rusta; gdy jej tam nie ma, zwraca opis braku zamiast metody innej klasy.
 */
function findSymbol(src: Ranges, query: string, file: string): Sym | string {
  const want = query.trim();
  const all = src.syms;
  const avail = (list: Sym[]) => {
    const names = list.slice(0, 40).map((s) => s.name);
    return names.length ? ` Dostępne: ${clean(names.join(", "))}` : "";
  };
  const exact = all.find((s) => s.name === want);
  if (exact) return exact;
  const parts = want
    .split(/\.|::/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return fuzzy(all, want) ?? `Nie znaleziono symbolu "${want}" w ${file}.${avail(all)}`;
  let scope = all;
  let path = "";
  for (const part of parts.slice(0, -1)) {
    let owners = scope.filter((s) => s.name === part || (s.kind === "impl" && s.name.endsWith(` for ${part}`)));
    if (!owners.length) owners = scope.filter((s) => s.name.toLowerCase() === part.toLowerCase());
    if (!owners.length) return `Nie znaleziono "${part}"${path ? ` w ${path}` : ""} (${file}).${avail(scope)}`;
    const members: Sym[] = [];
    for (const o of owners) {
      const last = src.end(o) + 1;
      for (const s of all) if (s.line > o.line && s.line <= last && !members.includes(s)) members.push(s);
    }
    for (const s of all) if (s.owner === part && !members.includes(s)) members.push(s);
    path = path ? `${path}.${part}` : part;
    scope = members;
  }
  const member = parts[parts.length - 1];
  return fuzzy(scope, member) ?? `Nie znaleziono "${member}" w ${path} (${file}).${avail(scope)}`;
}

const MAX_LINES = 600;
// komentarz dokumentacyjny, dekoratory i atrybuty bezpośrednio nad symbolem
const DOC_ABOVE: Partial<Record<Lang, RegExp | null>> = { md: null, py: /^\s*@\w/ };
const DOC_DEFAULT = /^\s*(\/\/\/?|\/\*\*?|\*|@\w|#\[|\[\w)/;

export function smartUnfold(filePath: string, symbol: string, cwd: string): string {
  const t = confine(filePath, cwd);
  if ("error" in t) return t.error;
  const r = readCode(t.path);
  if ("error" in r) return r.error;
  const src = rangesOf(r.text, r.lang, r.dialect);
  const sym = findSymbol(src, symbol, filePath);
  if (typeof sym === "string") return sym;
  const lines = src.lines;
  let start = sym.line - 1;
  const doc = r.lang in DOC_ABOVE ? DOC_ABOVE[r.lang] : DOC_DEFAULT;
  if (doc) while (start > 0 && doc.test(lines[start - 1])) start--;
  const end = Math.max(sym.line - 1, src.end(sym));
  const last = Math.min(end, start + MAX_LINES - 1);
  const width = String(last + 1).length;
  const body = lines.slice(start, last + 1).map((l, i) => `${String(start + i + 1).padStart(width)}│ ${clean(l)}`);
  if (last < end) body.push(`… pominięto ${end - last} linii (limit ${MAX_LINES}); ${clean(sym.name)} kończy się w L${end + 1}`);
  const twins = /\.|::/.test(symbol) ? [] : src.syms.filter((s) => s !== sym && s.name === sym.name);
  if (twins.length)
    body.push(`(ta sama nazwa także w ${twins.map((s) => `L${s.line}`).join(", ")}; zawęź przez Klasa.${clean(sym.name)})`);
  return `${filePath} L${start + 1}-${end + 1} [${sym.kind}] ${clean(sym.name)}\n${body.join("\n")}`;
}

// file_pattern przez Bun.Glob: dopasowanie natywne, bez wykładniczego cofania (wyrażenie z wieloma .* dla powtórzonego
// "**/" potrafiło zawiesić serwer). Bez rozróżniania wielkości liter; wzorzec bez "/" (np. *.ts) dopasowuje nazwę pliku
// w dowolnym katalogu, wzorzec z "/" (src/**/*.py) całą ścieżkę względną.
function globMatcher(pattern: string): (rel: string) => boolean {
  const g = pattern
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .toLowerCase();
  const glob = new Bun.Glob(g);
  if (g.includes("/")) return (rel) => glob.match(rel.toLowerCase());
  return (rel) => glob.match(rel.slice(rel.lastIndexOf("/") + 1).toLowerCase());
}

/**
 * Pliki pod root: bez ukrytych (.env, .git, katalogi z kropką poza DOT_DIRS), nazw sekretów, katalogów zależności,
 * kopii repo z Claude Code (.claude/worktrees) i katalogu konfiguracji Claude Code; dowiązań nie odwiedza.
 */
function* walk(root: string, max: number): Generator<string> {
  const stack = [root];
  const cfgs = claudeConfigs();
  let n = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const inDotClaude = basename(dir).toLowerCase() === ".claude";
    for (const e of entries) {
      if (SECRET_NAME.test(e.name)) continue;
      if (e.name.startsWith(".") && !(e.isDirectory() && DOT_DIRS.has(e.name.toLowerCase()))) continue;
      const p = join(dir, e.name);
      // dowiązanie i junction nie są ani katalogiem, ani plikiem (Dirent bez podążania), więc odpadają
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (inDotClaude && e.name.toLowerCase() === "worktrees")) continue;
        if (!inClaudeConfig(p, root, cfgs)) stack.push(p);
      } else if (e.isFile()) {
        yield p;
        if (++n >= max) return;
      }
    }
  }
}

/** Słowa zapytania, z rozbiciem camelCase i snake_case. */
function queryTerms(q: string): string[] {
  return q
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9ąćęłńóśźż]+/)
    .filter((w) => w.length >= 2);
}

export function smartSearch(
  query: string,
  opts: { path?: string | null; filePattern?: string | null; maxResults?: number },
  cwd: string,
): string {
  const target = confine(opts.path || ".", cwd);
  if ("error" in target) return target.error;
  let root = target.path;
  let list: Iterable<string>;
  try {
    if (statSync(root).isDirectory()) list = walk(root, 20_000);
    else {
      list = [root];
      root = dirname(root);
    }
  } catch {
    return `Nie można odczytać: ${opts.path}`;
  }
  const max = Math.max(1, Math.min(100, opts.maxResults ?? 20));
  const pat = opts.filePattern ? globMatcher(opts.filePattern) : null;
  const q = query.trim();
  const ql = q.toLowerCase();
  const terms = queryTerms(q);
  if (!terms.length && !ql) return "Puste zapytanie.";
  const symHits: { score: number; text: string }[] = [];
  const lineHits: string[] = [];
  let files = 0;
  const started = Date.now();
  for (const file of list) {
    if (Date.now() - started > 8000) break;
    // także z file_pattern tylko kod i Markdown (bez .env, JSON-ów z ustawieniami i innych plików tekstowych)
    const lang = langOf(file);
    if (!lang) continue;
    const rel = relative(root, file).replace(/\\/g, "/");
    if (pat && !pat(rel)) continue;
    let text: string;
    try {
      if (statSync(file).size > 800_000) continue;
      text = maskBlocks(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    files++;
    let lines: string[] | null = null;
    for (const s of outlineText(text, lang, dialectOf(file))) {
      const nl = s.name.toLowerCase();
      let score = nl === ql ? 6 : nl.includes(ql) ? 4 : 0;
      const nameTerms = queryTerms(s.name);
      for (const t of terms) {
        if (nameTerms.includes(t)) score += 1.5;
        else if (nl.includes(t)) score += 1;
        else if (s.sig.toLowerCase().includes(t)) score += 0.4;
      }
      if (score >= Math.max(1, terms.length * 0.75)) {
        lines ??= text.split(/\r?\n/);
        symHits.push({ score: score + (s.indent === 0 ? 0.2 : 0), text: `${rel}:${s.line} [${s.kind}] ${sigOf(lines, s)}` });
      }
    }
    if (lineHits.length < max && ql.length >= 3) {
      lines ??= text.split(/\r?\n/);
      for (let i = 0; i < lines.length && lineHits.length < max; i++) {
        if (!lines[i].toLowerCase().includes(ql)) continue;
        // trafienie tylko w zamaskowanym sekrecie nie jest trafieniem
        const shown = clean(lines[i]).trim();
        if (shown.toLowerCase().includes(ql)) lineHits.push(`${rel}:${i + 1}: ${shown.slice(0, 160)}`);
      }
    }
  }
  symHits.sort((a, b) => b.score - a.score);
  const out = [`Szukanie "${q}" w ${relative(cwd, target.shown) || "."} (${files} plików)`];
  if (symHits.length) out.push("## Symbole", ...symHits.slice(0, max).map((h) => `- ${h.text}`));
  const restSlots = max - Math.min(max, symHits.length);
  if (lineHits.length && restSlots > 0)
    out.push("## Wystąpienia w tekście", ...lineHits.slice(0, restSlots).map((l) => `- ${l}`));
  if (out.length === 1) out.push("Brak trafień.");
  out.push("Dalej: smart_outline(file_path) albo smart_unfold(file_path, symbol_name).");
  return out.join("\n");
}
