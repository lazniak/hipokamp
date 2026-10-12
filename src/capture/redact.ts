// Redakcja sekretów PRZED zapisem do pamięci. Lepiej zamaskować za dużo niż zapamiętać klucz.
//
// Dwa niezależne przebiegi po tym samym wejściu, a wynik to suma zamaskowanych zakresów, więc redact() i clean()
// maskują nadzbiór tego, co maskuje każdy z nich:
// - podłoga (floor): reguły z origin/main sprzed PR #8 jeden do jednego: te same wyrażenia, kolejność, wyjątki
//   i zjadanie tekstu przez odrzucone dopasowanie. Wzorce, które cofały się kwadratowo (klucz PEM, JWT, dane logowania
//   w URL, para „adres / hasło”, <private>), mają liniowe odpowiedniki o tej samej semantyce. Każde odluźnienie reguł
//   pokazywało kolejny wyciek, więc tego, co maskowała dawna wersja, pilnuje ona sama;
// - reguły ścisłe (strict): tylko zaostrzenia: szersze nazwy kluczy, :=, =>, klucz w JSON-ie zapisanym w JSON-ie, cała
//   wartość w cudzysłowie, wartość za adnotacją typu, stałe *_KEY, *_PSK, *_PW, #define, opcje CLI, connection
//   stringi, podpisy w URL, nowe tokeny, ucięty klucz PEM. Bez wyjątków „to kod, nie wartość” (wywołanie, pole, typ,
//   funkcja strzałkowa, nazwa innej zmiennej): w kodzie (smart_*) daje to fałszywe trafienia, tak jak na main.
// Każdy przebieg widzi własny tekst po swoich wcześniejszych maskach (jak dawniej), a Track przelicza zamiany na zakresy
// oryginału. Nadzbiór pilnuje test w test/redact-leaks.test.ts (wersja z main jako punkt odniesienia). Tak samo
// maskSource() składa tekst pliku dla smart_* (bloki wieloliniowe i przypisania złamane przez formatter, niżej).
//
// clean() działa w hooku, w workerze (ingest), w get_tool_uses, w smart_* i w `hipokamp repair` na całej bazie, więc
// każda reguła musi być liniowa względem wejścia: złośliwy tekst (1 MB „KEY_KEY_…”, „a.a.a…”, „<private>” bez końca)
// nie może go zatrzymać. Zasady:
// - wyrażenie zaczyna się od stałego tekstu albo \b na klasie \w; gdy początek ma szerszą klasę (eyJ po myślniku,
//   a.a.a… przed @), kotwicę szukamy przez indexOf, a początek i resztę sprawdza kod albo wyrażenie z flagą y;
// - lookbehind na początku wyłącza w JSC szybkie szukanie (każdy tekst wolniejszy), grupa powtarzana na każdy znak
//   zwalnia JSC i przy setkach tysięcy powtórzeń „poddaje się” (brak dopasowania), więc żadnej z nich;
// - nazwy zmiennych dopasowujemy w całości, a o tym, czy to sekret, decyduje kod;
// - reguły ścisłe nie konsumują odrzuconej wartości (dalsze przypisanie w niej też jest sprawdzane), a wartości
//   dłuższej niż LONG nie odrzucają wcale (maskują ją w całości), więc ponowne czytanie kosztuje najwyżej LONG znaków;
// - pary otwarcie-zamknięcie (klucz PEM, <private>) szukamy w pętli, nie leniwym [\s\S]*?.
// Testy: test/unit.test.ts (czas na złośliwych wejściach) i test/redact-leaks.test.ts (korpus wycieków i nadzbiór
// względem main).

const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
// \b przed pozycją p: znaki po obu stronach różnią się „słownością”
const boundary = (t: string, p: number) => (p > 0 && isWord(t.charCodeAt(p - 1))) !== isWord(t.charCodeAt(p));

// ---------------------------------------------------------------- zakresy w oryginale

/** Zamiana w bieżącym tekście przebiegu: [od, do), znacznik, wstawiany tekst (domyślnie znacznik). */
type Rep = [number, number, string, string?];
/** Zamaskowany zakres oryginału [od, do) ze znacznikiem. */
type Span = [number, number, string];

/** Kawałek bieżącego tekstu: fragment oryginału [s, e) albo (ins !== null) znacznik pokrywający oryginał [s, e). */
interface Seg {
  s: number;
  e: number;
  ins: string | null;
  mark: string;
}
const segLen = (g: Seg) => (g.ins === null ? g.e - g.s : g.ins.length);
// kawałek [x, y) segmentu g (pozycje względem jego początku); kawałek znacznika zachowuje cały jego zakres
const cut = (g: Seg, x: number, y: number): Seg =>
  g.ins === null ? { s: g.s + x, e: g.s + y, ins: null, mark: "" } : { s: g.s, e: g.e, ins: g.ins.slice(x, y), mark: g.mark };

/**
 * Tekst przebiegu po kolejnych maskach z mapą do oryginału. apply() przyjmuje zamiany na bieżącym tekście (rosnąco,
 * rozłączne), spans() zwraca zamaskowane zakresy oryginału. Znacznik nakryty w części (dalsza reguła złapała kawałek
 * „[REDACTED]”) zostaje w bieżącym tekście dokładnie jak w dawnej wersji, a jego zakres przechodzi na nową maskę.
 * Początki segmentów w oryginale nie maleją (nowa maska zaczyna się tam, gdzie pierwszy nakryty kawałek), więc
 * spans() wychodzi posortowane.
 */
class Track {
  text: string;
  private segs: Seg[] | null = null;

  constructor(src: string) {
    this.text = src;
  }

  apply(reps: Rep[]): void {
    if (!reps.length) return;
    const old = this.text;
    const parts: string[] = [];
    let pos = 0;
    for (const r of reps) {
      parts.push(old.slice(pos, r[0]), r[3] ?? r[2]);
      pos = r[1];
    }
    parts.push(old.slice(pos));
    this.text = parts.join("");
    const out: Seg[] = [];
    if (!this.segs) {
      // pierwsze maski: pozycje bieżącego tekstu to pozycje oryginału
      let p = 0;
      for (const [a, b, mark, ins] of reps) {
        if (a > p) out.push({ s: p, e: a, ins: null, mark: "" });
        out.push({ s: a, e: b, ins: ins ?? mark, mark });
        p = b;
      }
      if (p < old.length) out.push({ s: p, e: old.length, ins: null, mark: "" });
      this.segs = out;
      return;
    }
    const segs = this.segs;
    let k = 0; // segs[k] zaczyna się w bieżącym tekście na pozycji off
    let off = 0;
    let x = 0; // wszystko przed x już przepisane
    for (const [a, b, mark, ins] of reps) {
      while (x < a) {
        const g = segs[k];
        const end = off + segLen(g);
        const y = end < a ? end : a;
        out.push(x === off && y === end ? g : cut(g, x - off, y - off));
        x = y;
        if (y === end) {
          off = end;
          k++;
        }
      }
      let lo = Number.POSITIVE_INFINITY;
      let hi = -1;
      while (x < b) {
        const g = segs[k];
        // znacznik usunięty z widoku (pusty napis, widok sklejony) tuż przed zamianą zostaje osobno: nie jest częścią
        // tego, co zamiana maskuje (`sk-ant-…` w kodzie zostaje w odwrotnych apostrofach, sąsiednie usunięcia się nie
        // zlewają); pusty znacznik w środku zamiany ją rozcinał, więc wchodzi do jej zakresu
        if (x === a && g.ins === "") {
          out.push(g);
          k++;
          continue;
        }
        const end = off + segLen(g);
        const y = end < b ? end : b;
        const s = g.ins === null ? g.s + x - off : g.s;
        const e = g.ins === null ? g.s + y - off : g.e;
        if (s < lo) lo = s;
        if (e > hi) hi = e;
        x = y;
        if (y === end) {
          off = end;
          k++;
        }
      }
      if (hi >= 0) out.push({ s: lo, e: hi, ins: ins ?? mark, mark });
    }
    for (; k < segs.length; k++) {
      const g = segs[k];
      const len = segLen(g);
      if (x > off) {
        if (x < off + len) out.push(cut(g, x - off, len));
      } else out.push(g);
      off += len;
    }
    this.segs = out;
  }

  spans(): Span[] {
    const out: Span[] = [];
    for (const g of this.segs ?? []) if (g.ins !== null && g.e > g.s) out.push([g.s, g.e, g.mark]);
    return out;
  }

  /** Kopia do dalszych masek (apply() nie zmienia segmentów ani ich tablicy, tylko podmienia ją na nową). */
  fork(): Track {
    const t = new Track(this.text);
    t.segs = this.segs;
    return t;
  }
}

/**
 * Suma zakresów dwóch przebiegów (każda lista posortowana po początku): nakładające się łączy w jeden, ze znacznikiem
 * najdłuższego z tych, które zaczynają się najwcześniej; fmt daje tekst w miejsce fragmentu. hits liczy miejsca,
 * w których tekst się zmienił (drugi przebieg po zamaskowanym tekście daje 0).
 */
function render(
  t: string,
  x: Span[],
  y: Span[],
  fmt: (slice: string, mark: string) => string = (_, mark) => mark,
): { text: string; hits: number } {
  if (!x.length && !y.length) return { text: t, hits: 0 };
  let i = 0;
  let j = 0;
  let out = "";
  let pos = 0;
  let hits = 0;
  while (i < x.length || j < y.length) {
    const first = j >= y.length || (i < x.length && x[i][0] <= y[j][0]) ? x[i++] : y[j++];
    const a = first[0];
    let b = first[1];
    let mark = first[2];
    let best = b - a;
    for (;;) {
      const fromX = j >= y.length || (i < x.length && x[i][0] <= y[j][0]);
      const s = fromX ? x[i] : y[j];
      if (!s || s[0] >= b) break;
      if (fromX) i++;
      else j++;
      if (s[0] === a && s[1] - a > best) {
        best = s[1] - a;
        mark = s[2];
      }
      if (s[1] > b) b = s[1];
    }
    const slice = t.slice(a, b);
    const rep = fmt(slice, mark);
    if (rep !== slice) hits++;
    out += t.slice(pos, a) + rep;
    pos = b;
  }
  return { text: out + t.slice(pos), hits };
}

/** Zamiany z kolejnych dopasowań wyrażenia z flagą g: cały fragment na znacznik. */
function regexReps(t: string, re: RegExp, mark: string): Rep[] {
  const reps: Rep[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) reps.push([m.index, m.index + m[0].length, mark]);
  return reps;
}

const rangeReps = (ranges: [number, number][], mark: string): Rep[] => ranges.map(([a, b]) => [a, b, mark]);

/**
 * Kolejne trafienia bez nakładania: anchor przez indexOf, start(i, min) daje początek dopasowania nie wcześniej niż
 * min (koniec poprzedniego) albo -1, rest(i, s) maskę [from, to) i koniec dopasowania albo null, skip(i) miejsce
 * dalszego szukania po porażce.
 */
function anchored(
  t: string,
  anchor: string,
  start: (i: number, min: number) => number,
  rest: (i: number, s: number) => { from: number; to: number; end: number; mark: string } | null,
  skip: (i: number) => number = (i) => i + 1,
): Rep[] {
  const reps: Rep[] = [];
  let pos = 0;
  for (let i = t.indexOf(anchor); i >= 0; ) {
    const s = start(i, pos);
    const r = s >= 0 ? rest(i, s) : null;
    if (r) {
      reps.push([r.from, r.to, r.mark]);
      pos = r.end;
      i = t.indexOf(anchor, Math.max(r.end, i + 1));
    } else i = t.indexOf(anchor, s >= 0 ? skip(i) : i + 1);
  }
  return reps;
}

// ---------------------------------------------------------------- reguły wspólne obu przebiegów

// tokeny znanych dostawców z main (klucz PEM, JWT, Bearer i dane logowania w URL są osobno, niżej)
const MAIN_RULES: [string, RegExp][] = [
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openrouter-key", /\bsk-or-(?:v1-)?[A-Za-z0-9]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["stripe-key", /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g],
  ["elevenlabs-key", /\bsk_[0-9a-f]{40,}\b/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}/g],
];
const RULES: [string, RegExp][] = [
  ...MAIN_RULES,
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g],
  ["pypi-token", /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
];
const MAIN_BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{20,}/g;

/** Słowo z odstępem i token: maska od końca słowa (odstępy znikają: „Bearer [REDACTED:bearer]”, jak w main). */
function bearerReps(t: string, re: RegExp): Rep[] {
  const reps: Rep[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) reps.push([m.index + m[1].length, m.index + m[0].length, " [REDACTED:bearer]"]);
  return reps;
}

const JWT_REST = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/y;
const isB64url = (c: number) => isWord(c) || c === 45;

/** JWT: początek jak \b w /\beyJ/ (main), w regułach ścisłych także po _ (id_token_eyJ…). */
function jwtReps(t: string, underscore: boolean): Rep[] {
  return anchored(
    t,
    "eyJ",
    (i, min) => {
      const p = i > 0 ? t.charCodeAt(i - 1) : 0;
      return i < min || (i > 0 && isWord(p) && !(underscore && p === 95)) ? -1 : i;
    },
    (i) => {
      JWT_REST.lastIndex = i;
      const m = JWT_REST.exec(t);
      return m ? { from: i, to: i + m[0].length, end: i + m[0].length, mark: "[REDACTED:jwt]" } : null;
    },
    // nieudana próba przeczytała cały ciąg base64url: dalsze eyJ w nim (eyJ-eyJ-…) dałyby to samo, więc przeskok
    (i) => {
      let k = i + 3;
      while (k < t.length && isB64url(t.charCodeAt(k))) k++;
      return k;
    },
  );
}

// użytkownik niepusty jak w main (/([^\s:@/]+):/), w regułach ścisłych może być pusty (redis://:hasło@host)
const MAIN_URL_REST = /([^\s:@/]+):([^\s@/]{3,})@/y;
const URL_REST = /([^\s:@/]*):([^\s@/]{3,})@/y;
const isScheme = (c: number) => isWord(c) || c === 43 || c === 46 || c === 45; // [a-z0-9+.-] (bez _, patrz niżej)

/** Dane logowania w URL jak /\b([a-z][a-z0-9+.-]*:\/\/)(użytkownik):(hasło)@/gi: maskowane hasło. */
function urlReps(t: string, rest: RegExp): Rep[] {
  return anchored(
    t,
    "://",
    (i, min) => {
      // schemat: najwcześniejszy początek w ciągu znaków schematu, na granicy słowa i od litery; _ jest słowny, ale
      // spoza klasy, więc przerywa ciąg (schemat zawsze kończy się na końcu ciągu, bo : do niego nie należy)
      let s = i;
      while (s > min && isScheme(t.charCodeAt(s - 1)) && t.charCodeAt(s - 1) !== 95) s--;
      for (let p = s; p < i; p++) if (isLetter(t.charCodeAt(p)) && boundary(t, p)) return p;
      return -1;
    },
    (i) => {
      rest.lastIndex = i + 3;
      const m = rest.exec(t);
      if (!m) return null;
      const end = rest.lastIndex;
      return { from: end - 1 - m[2].length, to: end - 1, end, mark: "[REDACTED]" };
    },
  );
}

const isLocal = (c: number) => isWord(c) || c === 46 || c === 37 || c === 43 || c === 45; // [A-Za-z0-9._%+-]
const EMAIL_ONLY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}[.,;:)]*$/;

// ---------------------------------------------------------------- bloki: klucze PEM i <private>

// podłoga: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g z main. Nagłówek kończy się
// zawsze na końcu ciągu [A-Z ] (myślnik do niego nie należy), więc [A-Z ]* cofa się liniowo.
const MAIN_PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const MAIN_PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Pary otwarcie-zamknięcie jak leniwe open[\s\S]*?close: od otwarcia do najbliższego zamknięcia za nim. Po otwarciu
 * bez zamknięcia dalej też go nie będzie, więc koniec (liniowo).
 */
function pairs(t: string, open: RegExp, close: RegExp): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(t);
    if (!o) break;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(t);
    if (!c) break;
    out.push([o.index, c.index + c[0].length]);
    pos = c.index + c[0].length;
  }
  return out;
}

const mainPemRanges = (t: string) => (t.includes("PRIVATE KEY") ? pairs(t, MAIN_PEM_BEGIN, MAIN_PEM_END) : []);

const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_LINE = /^(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+: .*)$/;

/**
 * Koniec uciętego klucza (head -5 key.pem, przycięty wynik narzędzia): kolejne linie base64 i nagłówki PEM
 * (Proc-Type, DEK-Info), także z wcięciem YAML; pusta linia tylko między nimi. Linie dzieli znak nowej linii albo
 * sekwencja \n w napisie JSON ("-----BEGIN …-----\nMIIE…), a napis kończy cudzysłów. Pętla po liniach zamiast
 * powtarzanej grupy w wyrażeniu (JSC przy dziesiątkach tysięcy linii przestaje dopasowywać).
 */
function pemBodyEnd(t: string, p: number): number {
  let end = p;
  let k = p;
  for (;;) {
    let j = k;
    if (t.charCodeAt(j) === 13) j++;
    if (t.charCodeAt(j) === 10) j++;
    else if (t.charCodeAt(j) === 92 && t.charCodeAt(j + 1) === 110) j += 2;
    else return end;
    let e = j;
    for (; e < t.length; e++) {
      const c = t.charCodeAt(e);
      if (c === 10 || c === 13 || c === 92 || c === 34) break;
    }
    const line = t.slice(j, e).trim();
    if (line && !PEM_LINE.test(line)) return end;
    k = e;
    if (line) end = e;
  }
}

/**
 * Reguły ścisłe: zakresy [od, do) kluczy prywatnych PEM (też PGP … BLOCK): od BEGIN do najbliższego END, a bez END
 * nagłówek z liniami base64. Sam nagłówek bez treści (wzmianka w dokumentacji) nie zawiera sekretu i zostaje.
 */
function pemRanges(t: string): [number, number][] {
  const out: [number, number][] = [];
  if (!t.includes("PRIVATE KEY")) return out;
  let pos = 0;
  let noEnd = false; // po pierwszym BEGIN bez END dalej też nie ma END: nie szukamy go znowu (liniowo)
  for (;;) {
    PEM_BEGIN.lastIndex = pos;
    const b = PEM_BEGIN.exec(t);
    if (!b) break;
    const head = b.index + b[0].length;
    let end = -1;
    if (!noEnd) {
      PEM_END.lastIndex = head;
      const e = PEM_END.exec(t);
      if (e) end = e.index + e[0].length;
      else noEnd = true;
    }
    if (end < 0) end = pemBodyEnd(t, head);
    if (end > head || !noEnd) out.push([b.index, end]);
    pos = end;
  }
  return out;
}

// <private>…</private>: w main dokładnie te znaczniki (bez odstępów), w regułach ścisłych także <private >
const MAIN_PRIVATE_OPEN = /<private>/gi;
const MAIN_PRIVATE_CLOSE = /<\/private>/gi;
const PRIVATE_OPEN = /<private\s*>/gi;
const PRIVATE_CLOSE = /<\/private\s*>/gi;

/** Zakresy <private>…</private> (do najbliższego zamknięcia; bez zamknięcia: nic, jak dawniej). */
const privateSpans = (s: string, open: RegExp, close: RegExp): Span[] =>
  pairs(s, open, close).map(([a, b]) => [a, b, "[prywatne]"]);

const markLines = (mark: string) => (s: string) => s.replace(/[^\r\n]+/g, mark);

// ---------------------------------------------------------------- podłoga: przypisania i pary z main

const MAIN_ASSIGN =
  /((?:pass(?:word|wd)?|haslo|hasło|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;
const MAIN_SKIP = /^(true|false|null|none|undefined|\$\{?[A-Z_]+\}?|process\.env\.\w+|<[^>]+>)$/i;

/**
 * Entropia z main bit w bit: punkty kodowe w kolejności pierwszego wystąpienia (jak iteracja Map), te same działania,
 * mianownik w jednostkach UTF-16. Podłoga liczy ją tylko dla wartości krótszych niż 8 znaków, więc tablica zamiast Map.
 */
function mainEntropy(s: string): number {
  const chars: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    const lo = c >= 0xd800 && c <= 0xdbff ? s.charCodeAt(i + 1) : 0;
    if (lo >= 0xdc00 && lo <= 0xdfff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
      i++;
    }
    const k = chars.indexOf(c);
    if (k < 0) {
      chars.push(c);
      counts.push(1);
    } else counts[k]++;
  }
  let h = 0;
  for (const n of counts) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** ASSIGN z main: odrzucone dopasowanie też zjada tekst (replace z flagą g szuka dalej za nim). */
function mainAssign(t: string): Rep[] {
  const reps: Rep[] = [];
  MAIN_ASSIGN.lastIndex = 0;
  for (let m = MAIN_ASSIGN.exec(t); m; m = MAIN_ASSIGN.exec(t)) {
    const val = m[2];
    if (val.startsWith("[REDACTED") || MAIN_SKIP.test(val)) continue;
    if (val.length < 8 && mainEntropy(val) < 2.5) continue;
    const at = m.index + m[1].length;
    reps.push([at, at + val.length, "[REDACTED]"]);
  }
  return reps;
}

const isDomain = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 46; // [A-Za-z0-9.-]

/** Domena [a, b) jak [A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}: niepuste etykiety, ostatnia z co najmniej 2 liter. */
function domainOk(t: string, a: number, b: number): boolean {
  let labels = 0;
  let last = a;
  for (let k = a; k <= b; k++) {
    if (k < b && t.charCodeAt(k) !== 46) continue;
    if (k === last) return false;
    labels++;
    if (k < b) last = k + 1;
  }
  if (labels < 2 || b - last < 2) return false;
  for (let k = last; k < b; k++) if (!isLetter(t.charCodeAt(k))) return false;
  return true;
}

const MAIN_LOGIN_SEP = /(?:\s+[/|]\s*|\s*[/|]\s+)([^\s"',;]{6,})/y;

/**
 * LOGIN_PAIR z main: /\b([A-Za-z0-9._%+-]+@domena)(\s+[/|]\s*|\s*[/|]\s+)([^\s"',;]{6,})/g. Część lokalna kończy się
 * na @ (jej klasa go nie ma), domena na końcu ciągu [A-Za-z0-9.-] (za nią musi stać odstęp albo / |), więc każde @
 * ma jedno możliwe dopasowanie, liczone w kodzie. Odrzucone dopasowanie zjada tekst do końca wartości (jak w main).
 */
function mainLogin(t: string): Rep[] {
  const reps: Rep[] = [];
  let min = 0;
  for (let i = t.indexOf("@"); i >= 0; i = t.indexOf("@", Math.max(i + 1, min))) {
    // początek: najwcześniejsza granica słowa w ciągu znaków części lokalnej przed @, nie przed końcem poprzedniego
    let p = i;
    while (p > min && isLocal(t.charCodeAt(p - 1))) p--;
    while (p < i && !boundary(t, p)) p++;
    if (p === i) continue;
    let d = i + 1;
    while (d < t.length && isDomain(t.charCodeAt(d))) d++;
    if (!domainOk(t, i + 1, d)) continue;
    MAIN_LOGIN_SEP.lastIndex = d;
    const m = MAIN_LOGIN_SEP.exec(t);
    if (!m) continue;
    const end = MAIN_LOGIN_SEP.lastIndex;
    min = end;
    const val = m[1];
    // (adres e-mail ma najwyżej 254 znaki: dłuższej wartości nie sprawdzamy wyrażeniem, które cofałoby się po niej)
    if (/^\[REDACTED/.test(val) || (val.length <= 254 && EMAIL_ONLY.test(val)) || /^(?:https?:|www\.)/i.test(val)) continue;
    if (val.length < 8 && mainEntropy(val) < 2.5) continue;
    reps.push([end - val.length, end, "[REDACTED:login]"]);
  }
  return reps;
}

/** Podłoga: kolejność i reguły jak redact() z main. */
function floor(tr: Track): void {
  tr.apply(rangeReps(mainPemRanges(tr.text), "[REDACTED:private-key]"));
  for (const [kind, re] of MAIN_RULES) tr.apply(regexReps(tr.text, re, `[REDACTED:${kind}]`));
  tr.apply(jwtReps(tr.text, false));
  tr.apply(bearerReps(tr.text, MAIN_BEARER));
  tr.apply(urlReps(tr.text, MAIN_URL_REST));
  tr.apply(mainAssign(tr.text));
  tr.apply(mainLogin(tr.text));
}

// ---------------------------------------------------------------- reguły ścisłe: przypisania

/** Słowa kluczowe przypisań (też przypisanie złamane przez formatter w maskSource). */
const ASSIGN_KEYS =
  "pass(?:word|wd|phrase)?|haslo|hasło|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credentials?|private[_-]?key|client[_-]?secret|(?:secret|signing|encryption|master|hmac|session)[_-]?key|secret[_-]?key[_-]?base";
// przypisania typu password=..., "api_key": "...", TOKEN: ..., secret_key = ..., signingKey: ... (wartość czyta kod);
// także := (Go), => (PHP, Ruby; x => x.y też, bo nazwa przed => bywa sekretem) i \" po nazwie: klucz w JSON-ie
// zapisanym w JSON-ie, {\"password\": \"…\"}
const ASSIGN_HEAD = new RegExp(String.raw`(?:${ASSIGN_KEYS})(?:\\?["'])?\s*(?::=|=>|[:=])\s*`, "gi");
// adnotacja typu przed przypisaniem: password: str = "…", let password: String = "…", const API_KEY: &str = "…"
const TYPE_NAME = /^[A-Za-z_&][\w&<>[\]:.?|]*$/;
// wyjątki z main: stała logiczna, ${VAR}, process.env.X, placeholder <…>
const ASSIGN_SKIP = MAIN_SKIP;
// wartość dłuższa niż LONG nie bywa odrzucana: maskowana w całości (bez przeskakiwania i bez kwadratowego czytania)
const LONG = 200;

// Wartość, która nie jest sekretem (stałe *_KEY, *_PSK, *_PW, #define): stała logiczna, placeholder, liczba dziesiętna
// albo szesnastkowa (MAX_TOKENS = 100000, #define KEY_MASK 0xFFFF0000), sama nazwa innej stałej.
const NOT_SECRET =
  /^(?:true|false|null|none|nil|undefined|\$\{?[A-Za-z_]+\}?|%[A-Za-z_]+%|<[^>]+>|\{\{.*\}\}|-?\d[\d_]*(?:\.\d+)?[uUlLfF]*|0[xX][0-9a-fA-F]+[uUlL]*|[A-Za-z_]+)$/;
const PLACEHOLDER = /^(?:\$\{?[A-Za-z_]+\}?|%[A-Za-z_]+%|<[^>]+>|\{\{.*\}\})$/;
const REDACTED = /^\[REDACTED/i;
// nazwa albo ścieżka zamiast sekretu: słowa małymi literami (app_session, client-id), ścieżka (~/.ssh/id_ed25519)
const PLAIN_WORDS = /^[a-z]+(?:[_-][a-z]+)*$/;
const PATH = /^(?:~?\/|\.\.?\/)/;

// \s z JS bez wyrażenia na każdy znak spoza ASCII (tekst po polsku byłby wolny)
const isSpace = (c: number) =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  (c > 127 &&
    (c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff));
// znaki kończące wartość bez cudzysłowu: odstęp i " ' , ; (jak klasa [^\s"',;] w main)
const isStop = (c: number) => isSpace(c) || c === 34 || c === 39 || c === 44 || c === 59;

function firstWord(s: string): string {
  let k = 0;
  while (k < s.length && !isStop(s.charCodeAt(k))) k++;
  return k === s.length ? s : s.slice(0, k);
}

interface Val {
  start: number;
  end: number;
  q: string;
  closed: boolean;
  inner: string;
}

/**
 * Wartość od p: w cudzysłowie do cudzysłowu (niedomknięty: do końca linii), bez niego do znaku końca.
 * Cudzysłów poprzedzony \ to napis wewnątrz JSON-a ({"command":"export PASSWORD=\"…\""}, wejście narzędzia):
 * do \" (\\ w środku to znak hasła), a inna sekwencja \x albo goły cudzysłów kończy niedomknięty napis.
 */
function readValue(t: string, p: number): Val | null {
  const c = t.charCodeAt(p);
  const e = c === 92 ? t.charCodeAt(p + 1) : 0;
  if (e === 34 || e === 39) {
    let k = p + 2;
    let closed = false;
    while (k < t.length) {
      const x = t.charCodeAt(k);
      if (x === e || x === 10 || x === 13) break;
      if (x === 92) {
        const y = t.charCodeAt(k + 1);
        if (y === e) {
          closed = true;
          break;
        }
        if (y !== 92) break;
        k += 2;
      } else k++;
    }
    return { start: p, end: closed ? k + 2 : k, q: t.slice(p, p + 2), closed, inner: t.slice(p + 2, k) };
  }
  if (c === 34 || c === 39 || c === 96) {
    let k = p + 1;
    while (k < t.length) {
      const x = t.charCodeAt(k);
      if (x === c || x === 10 || x === 13) break;
      k++;
    }
    const closed = t.charCodeAt(k) === c;
    return { start: p, end: closed ? k + 1 : k, q: t[p], closed, inner: t.slice(p + 1, k) };
  }
  let k = p;
  while (k < t.length && !isStop(t.charCodeAt(k))) k++;
  return k > p ? { start: p, end: k, q: "", closed: false, inner: t.slice(p, k) } : null;
}

/** Długość otwarcia napisu na pozycji p: 1 dla " ' `, 2 dla \" i \' (JSON), 0 bez cudzysłowu. */
function quoteLen(t: string, p: number): number {
  const c = t.charCodeAt(p);
  if (c === 34 || c === 39 || c === 96) return 1;
  const e = c === 92 ? t.charCodeAt(p + 1) : 0;
  return e === 34 || e === 39 ? 2 : 0;
}

/** Maska wartości: cała zawartość (w cudzysłowie bez niego). */
const maskRep = (v: Val): Rep => [v.start + v.q.length, v.start + v.q.length + v.inner.length, "[REDACTED]"];

/** Maski przypisania i koniec przeczytanej wartości (tam szukamy dalej). */
interface Decision {
  reps: Rep[];
  end: number;
}

/**
 * Przypisania: head dopasowuje nazwę z separatorem, decide ocenia wartość. Odrzucona wartość nie jest konsumowana
 * (dalsze przypisanie w niej też jest sprawdzane); odrzucana bywa tylko wartość do LONG znaków, więc liniowo.
 */
function assignments(t: string, head: RegExp, decide: (m: RegExpExecArray, at: number) => Decision | null): Rep[] {
  const reps: Rep[] = [];
  head.lastIndex = 0;
  for (let m = head.exec(t); m; m = head.exec(t)) {
    const at = m.index + m[0].length;
    const r = decide(m, at);
    if (r) {
      reps.push(...r.reps);
      head.lastIndex = r.end;
    } else head.lastIndex = at;
  }
  return reps;
}

/**
 * Wartość przypisania od p i decyzja jak w main: pierwsze słowo od 6 znaków, nie krótkie powtarzalne, nie znacznik,
 * nie wyjątek z main. Maskowana cała wartość w cudzysłowie (hasło ze spacjami), a dłuższa niż LONG zawsze.
 */
function assignAt(t: string, p: number): { v: Val; mask: boolean } | null {
  const q = quoteLen(t, p);
  // w cudzysłowie: pierwsze słowo od 6 znaków, zanim w ogóle czytamy wartość (cudzysłów po słowie kluczowym bywa
  // zamknięciem argumentu: echo "DB_PASSWORD=" >> .env && echo DB_PASSWORD=…; main też go nie łapał)
  if (q) for (let k = p + q; k < p + q + 6; k++) if (k >= t.length || isStop(t.charCodeAt(k))) return null;
  const v = readValue(t, p);
  if (!v) return null;
  if (v.inner.length > LONG) return { v, mask: true };
  const first = v.q ? firstWord(v.inner) : v.inner; // bez cudzysłowu wartość kończy już pierwszy znak końca
  const keep =
    first.length < 6 || (first.length < 8 && entropy(first) < 2.5) || first.startsWith("[REDACTED") || ASSIGN_SKIP.test(first);
  return { v, mask: !keep };
}

const isBlank = (c: number) => c === 32 || c === 9;

/** Po adnotacji typu (password: str = …): pozycja wartości za „=”, inaczej -1. */
function afterType(t: string, v: Val): number {
  if (v.q || v.inner.length > 100 || !TYPE_NAME.test(v.inner)) return -1;
  let k = v.end;
  while (isBlank(t.charCodeAt(k))) k++;
  if (t.charCodeAt(k) !== 61 || t.charCodeAt(k + 1) === 61 || t.charCodeAt(k + 1) === 62) return -1;
  k++;
  while (isBlank(t.charCodeAt(k))) k++;
  return k;
}

function assignValue(m: RegExpExecArray, t: string, at: number): Decision | null {
  const r = assignAt(t, at);
  if (!r) return null;
  const reps: Rep[] = [];
  let end = at;
  if (r.mask) {
    reps.push(maskRep(r.v));
    end = r.v.end;
  }
  // po dwukropku może stać typ, a wartość za =: password: str = "…" (typ oceniony wyżej jak każda wartość)
  const sep = m[0];
  let s = sep.length - 1;
  while (s > 0 && isSpace(sep.charCodeAt(s))) s--;
  const k = sep.charCodeAt(s) === 58 ? afterType(t, r.v) : -1;
  const w = k >= 0 ? assignAt(t, k) : null;
  if (w?.mask) {
    reps.push(maskRep(w.v));
    end = w.v.end;
  }
  return reps.length ? { reps, end } : null;
}

// Stałe WIELKIMI literami, których ASSIGN nie łapie: nazwa kończy się na KEY (STRIPE_KEY, APP_KEY), PSK albo PW
// (WIFI_PSK, MQTT_PW, STAPSK). Nazwa dopasowana w całości, ocena w kodzie.
// Wyrażenie bierze tylko nazwy z możliwą końcówką (wstępne sito: A:A:A… nie woła kodu na każdym dwukropku).
const UPPER_HEAD = /\b((?:[A-Z][A-Z0-9_]*)?(?:KEYS?|PSK|PWD?))(?:\\?["'])?[ \t]*[:=][ \t]*/g;
// to samo w snake_case (mysql_pwd, wifi_psk, mqtt_pw, stripe_key); człon przed końcówką wymagany (samo key= to nie to)
const LOWER_HEAD = /\b([a-z][a-z0-9_]*_(?:keys?|psk|pwd?))(?:\\?["'])?[ \t]*[:=][ \t]*/g;
// makra C bez znaku = (#define SECRET_PASS "…", konwencja arduino_secrets.h, ESP8266 STAPSK)
const DEFINE = /(#[ \t]*define[ \t]+)(\w+)([ \t]+)("[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"',;]+)/g;

// Człon przed KEY, z którym klucz jest sekretem bez względu na wartość. Samo *_KEY (STORAGE_KEY, SORT_KEY,
// PROJECT_MERGES_KEY) to zwykle nazwa pola albo klucz pamięci podręcznej: maskujemy tylko wartość wyglądającą na sekret.
const KEY_PREFIX = new Set([
  "API",
  "SECRET",
  "PRIVATE",
  "ACCESS",
  "AUTH",
  "CLIENT",
  "MASTER",
  "SIGNING",
  "ENCRYPTION",
  "ENC",
  "HMAC",
  "SESSION",
  "LICENSE",
  "WIFI",
  "SSH",
  "JWT",
  "DEPLOY",
  "WEBHOOK",
]);
const SECRET_WORD = new Set([
  "SECRET",
  "SECRETS",
  "PASS",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "PW",
  "PSK",
  "TOKEN",
  "CREDENTIAL",
  "CREDENTIALS",
]);
// ostatni człon nazwy, przy którym wartość to opis, a nie sekret (PASSWORD_PROMPT, API_KEY_HEADER, SECRET_NAME)
const NOT_SECRET_TAIL = new Set(["PROMPT", "HEADER", "LABEL", "NAME", "ID", "HINT", "TITLE", "MSG", "MESSAGE", "TEXT"]);

// "secret": każda wartość od 6 znaków; "prefix": jak secret, ale słowa i ścieżki to nazwy; "key": tylko wartość
// wyglądająca na wygenerowany klucz
type Kind = "secret" | "prefix" | "key" | null;

/** Stała WIELKIMI literami: liczy się ostatni człon; SECRET, PASS i TOKEN zostawiamy ASSIGN. */
function tailKind(name: string): Kind {
  const u = name.lastIndexOf("_");
  const last = u < 0 ? name : name.slice(u + 1);
  if (last === "PSK" || last === "PW" || last === "PWD" || (u < 0 && last.endsWith("PSK"))) {
    // samo PWD to katalog roboczy powłoki (PWD=/home/x), hasło tylko z przedrostkiem (MYSQL_PWD)
    return last === "PWD" && u < 0 ? null : "secret";
  }
  if (last !== "KEY" && last !== "KEYS") return null;
  if (u < 0) return "key";
  return KEY_PREFIX.has(name.slice(name.lastIndexOf("_", u - 1) + 1, u)) ? "prefix" : "key";
}

/** Makro (DEFINE): słowo sekretu w dowolnym członie nazwy (SECRET_SSID, WIFI_PASS_2), KEY jak w tailKind. */
function macroKind(name: string): Kind {
  const parts = name.toUpperCase().split("_");
  if (NOT_SECRET_TAIL.has(parts[parts.length - 1])) return null;
  let kind: Kind = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (SECRET_WORD.has(p) || (i === parts.length - 1 && p.endsWith("PSK"))) return "secret";
    if (p === "KEY" || p === "KEYS") kind = i > 0 && KEY_PREFIX.has(parts[i - 1]) ? "prefix" : (kind ?? "key");
  }
  return kind;
}

/**
 * Wartość wyglądająca na wygenerowany sekret: długa, bez spacji i kropek, z cyframi i literami, wysoka entropia.
 * Nie: ścieżka (uploads/2024/10/a.png), wersja (-v12), klucz z dwukropkiem (session:user:12345), hash gita.
 */
function looksSecret(v0: string): boolean {
  const v = v0.startsWith("base64:") ? v0.slice(7) : v0; // APP_KEY Laravela
  if (v.length < 16 || /[\s.:]/.test(v) || !/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (PATH.test(v) || v.split("/").length >= 3 || /[-_]v\d+(?:[-_]|$)/i.test(v) || /^[0-9a-f]{40}$/.test(v)) return false;
  if (!mixed(v)) return false;
  // tylko znaki kluczy (base64, base64url, hex): nawiasy i przecinki to kod (new_key = (vals[1][0], x))
  return /^[\w+/=~-]+$/.test(v) && entropy(v) >= 3.5;
}

// wygenerowany klucz ma cyfry rozsiane (hex) albo małe i wielkie litery (base62); jedna seria cyfr w małych literach
// to nazwa (observations2024list)
const mixed = (v: string) => /\d\D+\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));

// plik klucza zamiast klucza: SSH_KEY = "id_ed25519", PRIVATE_KEY = "server.pem", CREDENTIALS = "sa.json"
const KEY_FILE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:-sk)?(?:\.pub)?|[\w.-]+\.(?:pem|key|pub|json|p12|pfx|crt|cer|der|jks|ppk))$/i;

/**
 * Czy maskować wartość stałej (*_KEY, *_PSK, *_PW, #define). To tylko dodatek do ASSIGN i podłogi: nazwy, które znają
 * one, ocenia już ich reguła, a tu odpadają stałe, liczby, placeholdery i nazwy plików.
 */
function judge(kind: Kind, v: Val): boolean {
  if (!kind) return false;
  const inner = v.inner;
  if (inner.length > LONG) return true;
  // ${…} w środku to szablon albo zmienna środowiska (`sk-or-v1-${TOKEN}`), nie wpisana wartość
  if (REDACTED.test(inner) || inner.includes("${") || PATH.test(inner) || KEY_FILE.test(inner)) return false;
  if (v.q ? PLACEHOLDER.test(inner) : NOT_SECRET.test(inner)) return false;
  if (kind === "key") return looksSecret(inner);
  if (kind === "prefix" && PLAIN_WORDS.test(inner)) return false;
  return !(inner.length < 6 || (inner.length < 8 && entropy(inner) < 2.5));
}

function upperValue(m: RegExpExecArray, t: string, at: number): Decision | null {
  const name = m[1].toUpperCase();
  const u = name.lastIndexOf("_");
  if (u >= 0 && NOT_SECRET_TAIL.has(name.slice(u + 1))) return null;
  const kind = tailKind(name);
  if (!kind) return null;
  const q = quoteLen(t, at);
  // cudzysłów, po którym jest odstęp albo drugi cudzysłów, to zamknięcie argumentu, nie wartość ("STRIPE_KEY=" >> .env)
  if (q && (at + q >= t.length || isSpace(t.charCodeAt(at + q)) || t.startsWith(t.slice(at, at + q), at + q))) return null;
  const v = readValue(t, at);
  return v && judge(kind, v) ? { reps: [maskRep(v)], end: v.end } : null;
}

function defineReps(t: string): Rep[] {
  const reps: Rep[] = [];
  DEFINE.lastIndex = 0;
  for (let m = DEFINE.exec(t); m; m = DEFINE.exec(t)) {
    const [, pre, name, gap, val] = m;
    const q = val[0] === '"' || val[0] === "'" ? val[0] : "";
    const closed = !!q && val.length > 1 && val.endsWith(q);
    const start = m.index + pre.length + name.length + gap.length;
    const v = { start, end: start + val.length, q, closed, inner: q ? val.slice(1, closed ? -1 : undefined) : val };
    if (judge(macroKind(name), v)) reps.push(maskRep(v));
  }
  return reps;
}

// Opcje wiersza poleceń z wartością po spacji (--password X, --token X) i curl -u user:hasło (uid:gid zostaje).
// Użytkownik zamaskowany wcześniej (-u [REDACTED:github-token]) to cały znacznik, nigdy jego początek: inaczej drugie
// clean() brałoby „github-token]” za hasło (wynik ma być idempotentny).
const CLI_FLAG =
  /(--(?:password|passwd|pass|passphrase|token|api-key|apikey|secret|client-secret|access-token|auth-token)[ \t]+)([^\s"'-][^\s"']*)/g;
const CURL_USER = /(\s(?:-u|--user)[ \t]+)(\[REDACTED[^\]\s]*\]|(?!\[REDACTED)[^\s:"']+):([^\s"']+)/g;
const SSHPASS = /(\bsshpass[ \t]+-p[ \t]*)([^\s"']+)/g;
/** Wartość opcji, która nie jest hasłem: zmienna, placeholder, już zamaskowana, krótka albo powtarzalna. */
const plain = (val: string) =>
  REDACTED.test(val) || val[0] === "$" || PLACEHOLDER.test(val) || val.length < 6 || (val.length < 8 && entropy(val) < 2.5);
// hasło w connection stringu ODBC/ADO po średniku (;PWD=…, ;Pwd=…); samo PWD= to katalog powłoki
const CONN_PWD = /(;[ \t]*pwd[ \t]*=[ \t]*)([^;\s"']+)/gi;
// podpis i klucz w zapytaniu URL (?sig=…, &key=…): tylko wartość wyglądająca na wygenerowaną
const QUERY_SECRET = /([?&](?:key|sig|signature|x-amz-signature|x-goog-signature)=)([^&#\s"'<>]+)/gi;

/**
 * Wyrażenie z grupami (przed)(wartość) albo (przed)(użytkownik):(wartość): maska ostatniej grupy, gdy ok(wartość, m).
 * Grupy leżą jedna za drugą, więc początek wartości to koniec dopasowania minus jej długość.
 */
function tailReps(t: string, re: RegExp, ok: (val: string, m: RegExpExecArray) => boolean): Rep[] {
  const reps: Rep[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const val = m[m.length - 1];
    const end = m.index + m[0].length;
    if (ok(val, m)) reps.push([end - val.length, end, "[REDACTED]"]);
  }
  return reps;
}

// dane logowania w wolnym tekście: „adres@domena.pl / hasło” (adres zostaje, maskujemy to, co po ukośniku). Ukośnik
// ze spacją z co najmniej jednej strony, żeby nie łapać ścieżek w adresach typu https://git@host.pl/repo. Domena do 127
// etykiet (granica DNS): bez tego „a@b.b.b…” cofa się po setkach tysięcy etykiet (podłoga liczy domenę w kodzie).
const LOGIN_REST = /@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){0,126}\.[A-Za-z]{2,})(\s+[/|]\s*|\s*[/|]\s+)([^\s"',;]{6,})/y;

/** Reguły ścisłe: jak podłoga, ale odrzucona wartość nie zjada tekstu (adres w niej też jest sprawdzany). */
function loginReps(t: string): Rep[] {
  return anchored(
    t,
    "@",
    (i, min) => {
      // część lokalna jak w /\b[A-Za-z0-9._%+-]+@/: najwcześniejsza granica słowa w ciągu znaków przed @
      let s = i;
      while (s > min && isLocal(t.charCodeAt(s - 1))) s--;
      for (let p = s; p < i; p++) if (boundary(t, p)) return p;
      return -1;
    },
    (i) => {
      LOGIN_REST.lastIndex = i;
      const m = LOGIN_REST.exec(t);
      if (!m) return null;
      const val = m[3];
      // druga pozycja listy adresów albo link to nie hasło (samo „@” w środku już tak: hasła je mają)
      if (REDACTED.test(val) || (val.length <= 254 && EMAIL_ONLY.test(val)) || /^(?:https?:|www\.)/i.test(val)) return null;
      if (val.length < 8 && entropy(val) < 2.5) return null;
      const end = LOGIN_REST.lastIndex;
      return { from: end - val.length, to: end, end, mark: "[REDACTED:login]" };
    },
  );
}

/** Reguły ścisłe: zaostrzenia ponad podłogę, każdy przebieg na tekście po poprzednich maskach. */
function strict(tr: Track): void {
  tr.apply(rangeReps(pemRanges(tr.text), "[REDACTED:private-key]"));
  for (const [kind, re] of RULES) tr.apply(regexReps(tr.text, re, `[REDACTED:${kind}]`));
  tr.apply(jwtReps(tr.text, true));
  tr.apply(bearerReps(tr.text, BEARER));
  tr.apply(urlReps(tr.text, URL_REST));
  tr.apply(assignments(tr.text, ASSIGN_HEAD, (m, at) => assignValue(m, tr.text, at)));
  tr.apply(assignments(tr.text, UPPER_HEAD, (m, at) => upperValue(m, tr.text, at)));
  tr.apply(assignments(tr.text, LOWER_HEAD, (m, at) => upperValue(m, tr.text, at)));
  tr.apply(defineReps(tr.text));
  // samo słowo po opcji to proza („--password option”), nie hasło
  tr.apply(tailReps(tr.text, CLI_FLAG, (val) => !(plain(val) || PLAIN_WORDS.test(val))));
  tr.apply(tailReps(tr.text, CURL_USER, (val) => !(/^\d+$/.test(val) || REDACTED.test(val))));
  for (const re of [SSHPASS, CONN_PWD]) tr.apply(tailReps(tr.text, re, (val) => !plain(val)));
  tr.apply(
    tailReps(tr.text, QUERY_SECRET, (val) => !(val.length < 16 || REDACTED.test(val) || !mixed(val) || entropy(val) < 3.5)),
  );
  tr.apply(loginReps(tr.text));
}

const ASCII = new Int32Array(128);

/**
 * Entropia Shannona po punktach kodowych, mianownik w jednostkach UTF-16 (jak w main). Woła się ją na każdym
 * przypisaniu, więc bez Map i iteratora napisu: ASCII w tablicy, reszta posortowana i zliczona seriami.
 */
function entropy(s: string): number {
  const n = s.length;
  let other: number[] | null = null;
  for (let i = 0; i < n; i++) {
    let k = s.charCodeAt(i);
    if (k < 128) {
      ASCII[k]++;
      continue;
    }
    if (k >= 0xd800 && k <= 0xdbff && i + 1 < n) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        k = 0x10000 + ((k - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    (other ??= []).push(k);
  }
  let h = 0;
  const add = (x: number) => {
    const p = x / n;
    h -= p * Math.log2(p);
  };
  for (let i = 0; i < n; i++) {
    const k = s.charCodeAt(i);
    if (k < 128 && ASCII[k]) {
      add(ASCII[k]);
      ASCII[k] = 0;
    }
  }
  if (other && other.length > 64) {
    const f = new Map<number, number>();
    for (const k of other) f.set(k, (f.get(k) ?? 0) + 1);
    for (const x of f.values()) add(x);
  } else if (other) {
    other.sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i <= other.length; i++) {
      if (i < other.length && other[i] === other[i - 1]) run++;
      else {
        add(run);
        run = 1;
      }
    }
  }
  return h;
}

export interface RedactResult {
  text: string;
  hits: number;
}

export function redact(input: string | null | undefined): RedactResult {
  if (!input) return { text: input ?? "", hits: 0 };
  const a = new Track(input);
  floor(a);
  const b = new Track(input);
  strict(b);
  return render(input, a.spans(), b.spans());
}

/** Usuwa fragmenty oznaczone przez użytkownika jako prywatne (zgodne z claude-mem). Liniowo, bez cofania. */
export function stripPrivate(s: string): string {
  return render(s, privateSpans(s, MAIN_PRIVATE_OPEN, MAIN_PRIVATE_CLOSE), privateSpans(s, PRIVATE_OPEN, PRIVATE_CLOSE)).text;
}

// Znaczniki już w wejściu (tekst po wcześniejszym clean(): `hipokamp repair`, get_tool_uses, import). W pierwszym
// clean() znacznik powstaje w tekście przebiegu i reguła, która nakryje jego kawałek, przenosi maskę na cały jego
// zakres (Track), więc w wyniku zostaje ten sam znacznik. Ten sam znacznik w wejściu był zwykłym tekstem: drugie
// clean() maskowało jego kawałek (redis://[REDACTED:openai-key]@ → hasło „openai-key]”, -u ł[REDACTED:…] → użytkownik
// „ł[REDACTED”) albo cały, gdy pierwsze clean() zostawiło [prywatne] z podłogi (--password [prywatne]). Dlatego zakres
// maski, który zaczyna się albo kończy w środku znacznika z wejścia, rozszerzamy na cały znacznik, a zakres, pod którym
// są same znaczniki, pomijamy (znacznik zostaje). Tekst, który widzą reguły, jest ten sam, więc to dokładnie to, co
// dałoby zarejestrowanie znacznika w Track, bez segmentu na każdy znacznik (1 MB „[REDACTED] ” × N). Maski tylko rosną
// (o tekst znacznika), więc redakcja niczego nie traci. Idempotencję pilnuje test/redact-idempotent.test.ts.
const LITERAL_MARK = /\[(?:REDACTED(?::[a-z0-9-]+)?|prywatne)\]/g;
const ONLY_MARKS = /^(?:\[(?:REDACTED(?::[a-z0-9-]+)?|prywatne)\])+$/;
function literalMarks(s: string): [number, number][] {
  const out: [number, number][] = [];
  if (!s.includes("[REDACTED") && !s.includes("[prywatne]")) return out;
  LITERAL_MARK.lastIndex = 0;
  for (let m = LITERAL_MARK.exec(s); m; m = LITERAL_MARK.exec(s)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Znacznik z wejścia, w którego środku leży pozycja p (marks rosnąco, rozłączne), albo -1. */
function markAt(marks: [number, number][], p: number): number {
  let lo = 0;
  let hi = marks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid][1] <= p) lo = mid + 1;
    else if (marks[mid][0] >= p) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * Zakresy po rozszerzeniu na całe znaczniki z wejścia, bez zakresów pod samymi znacznikami. spans rosnąco po początku
 * i wynik też (rozszerzenie może przestawić początki, więc po nim sortujemy).
 */
function settle(s: string, spans: Span[], marks: [number, number][]): Span[] {
  if (!marks.length) return spans;
  const out: Span[] = [];
  for (const [a0, z0, mark] of spans) {
    const i = markAt(marks, a0);
    const j = markAt(marks, z0);
    const a = i >= 0 ? marks[i][0] : a0;
    const z = j >= 0 ? marks[j][1] : z0;
    const slice = s.slice(a, z);
    if (slice.charCodeAt(0) === 91 && ONLY_MARKS.test(slice)) continue;
    out.push([a, z, mark]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Podłoga clean(): clean() z main (<private>, potem reguły), tekst i zakresy. */
function floorClean(s: string): Track {
  const a = new Track(s);
  a.apply(rangeReps(pairs(s, MAIN_PRIVATE_OPEN, MAIN_PRIVATE_CLOSE), "[prywatne]"));
  floor(a);
  return a;
}

// Znaczniki, które rozcinają sekret w tekście, choć same sekretem nie są: kod i formatowanie Markdown (`, **, __, ~~:
// `sk-ant-`api03-…`, **sk-ant-**api03-…), blok <private> w środku klucza oraz znaczniki z wejścia ([REDACTED…],
// [prywatne]) w środku wartości albo klucza (password=[REDACTED]hunter2Xy9, sk-ant-api03-AbCd[REDACTED]EfGh…).
const SPLIT_RUN = /(?:`|\*\*|__|~~)+/g;
const MARK_RUN = /(?:\[(?:REDACTED(?::[a-z0-9-]+)?|prywatne)\])+/g;
const hasSplitMark = (s: string) => s.includes("`") || s.includes("**") || s.includes("__") || s.includes("~~");
// Więcej niż SPLIT_MAX serii do usunięcia jednego rodzaju (blok <private>, znaczniki z wejścia albo Markdown) w jednym
// tekście to nie rozcięty sekret, tylko masowy kształt („**x” × N, „[REDACTED]x” × N): ten rodzaj zostaje wtedy
// w widoku (jak w zwykłym), żeby koszt
// był liniowy i mały (segment Track na każdą serię i reguły ścisłe na nich kosztowały kilka razy więcej niż clean()
// z main). Tekst w bazie (prompt do 8000 znaków, wynik narzędzia do 4000) nie ma tylu serii.
const SPLIT_MAX = 4096;

const WORD_CHAR = /[\p{L}\p{N}_-]/u;
/** Znak słowa (litera, cyfra, _ albo -) zaczynający się na pozycji i. */
const wordAt = (t: string, i: number) => i < t.length && WORD_CHAR.test(String.fromCodePoint(t.codePointAt(i) ?? 32));
/** Znak słowa kończący się tuż przed pozycją i (para zastępcza: cały znak). */
function wordBefore(t: string, i: number): boolean {
  if (i <= 0) return false;
  const c = t.charCodeAt(i - 1);
  return wordAt(t, c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1);
}
// Znacznik zakresu usuniętego w widoku sklejonym (seria znaczników z wejścia albo Markdownu). Zakres z tym znacznikiem
// to nie maska: albo nic go nie objęło, albo seria wchłonęła sąsiedni pusty segment (blok <private> między
// odwrotnymi apostrofami: `<private>…</private>` daje w widoku „``”); w obu przypadkach odpada, a blok <private> ma
// swoją maskę [prywatne] ze zwykłego widoku.
const GLUE = "\u0000sklejone";

/**
 * Serie znaczników z wejścia, za którymi idzie znak słowa (dalszy ciąg wartości albo klucza, a nie cudzysłów czy
 * nawias za zamaskowaną wartością: SECRET_KEY = [REDACTED]"…"] po pierwszym clean() nie robi z reszty nowej
 * wartości), jako zamiany na pusty napis; null, gdy jest ich więcej niż SPLIT_MAX.
 */
function markRuns(t: string): Rep[] | null {
  const out: Rep[] = [];
  MARK_RUN.lastIndex = 0;
  for (let m = MARK_RUN.exec(t); m; m = MARK_RUN.exec(t)) {
    const z = m.index + m[0].length;
    if (!wordAt(t, z)) continue;
    if (out.length === SPLIT_MAX) return null;
    out.push([m.index, z, GLUE, ""]);
  }
  return out;
}

/**
 * Serie znaczników Markdown do usunięcia: wewnątrz tokenu (znak słowa po obu stronach: sk-ant-`api03) i na początku
 * słowa, w którym dalej jest seria wewnętrzna (__sk-ant-__api03: podkreślniki przed kluczem psują granicę słowa).
 * Seria przy interpunkcji albo samotna na brzegu słowa zostaje: `password`: `string` i `KEY`: bezpośrednie to proza
 * o kodzie, a nie rozcięty sekret. null, gdy serii do usunięcia jest więcej niż SPLIT_MAX.
 */
function splitRuns(t: string): Rep[] | null {
  const runs: [number, number][] = [];
  SPLIT_RUN.lastIndex = 0;
  for (let m = SPLIT_RUN.exec(t); m; m = SPLIT_RUN.exec(t)) runs.push([m.index, m.index + m[0].length]);
  const out: Rep[] = [];
  const inner = (i: number) => wordBefore(t, runs[i][0]) && wordAt(t, runs[i][1]);
  for (let i = 0; i < runs.length; i++) {
    const [a, z] = runs[i];
    let take = inner(i);
    if (!take && (a === 0 || isSpace(t.charCodeAt(a - 1))) && wordAt(t, z)) {
      // początek słowa: szukamy serii wewnętrznej przed najbliższym odstępem
      for (let j = i + 1; j < runs.length && !take; j++) {
        let gap = false;
        for (let k = runs[j - 1][1]; k < runs[j][0] && !gap; k++) gap = isSpace(t.charCodeAt(k));
        if (gap) break;
        take = inner(j);
      }
    }
    if (!take) continue;
    if (out.length === SPLIT_MAX) return null;
    out.push([a, z, GLUE, ""]);
  }
  return out;
}

/**
 * Widok sklejony: tekst bez tego, co rozcina słowo (zamiana na pusty napis): blok <private>, do którego coś przylega
 * z prawej, seria znaczników z wejścia, za którą idzie znak słowa, i seria znaczników Markdown wewnątrz tokenu albo
 * na początku słowa z serią wewnętrzną (splitRuns). Na nim reguły ścisłe widzą sekret w całości, a maska, która
 * obejmie miejsce usuniętego znacznika, pokrywa też ten znacznik (Track), więc z sekretu nie zostaje żaden kawałek.
 * Znacznik przed odstępem zostaje jak w zwykłym widoku: inaczej „token=[REDACTED] następnie” dawało wartość
 * „następnie”, a każdy kolejny przebieg clean() maskował następne słowo. null: nie ma czego usunąć (widok byłby
 * zwykłym widokiem). Tylko dokłada maski.
 */
function joinedView(s: string, priv: [number, number][], hasMarks: boolean): Track | null {
  let removed = false;
  const c = new Track(s);
  if (priv.length) {
    const glued = priv.map(([, z]) => z < s.length && !isSpace(s.charCodeAt(z)));
    const n = glued.filter(Boolean).length;
    removed = n > 0 && n <= SPLIT_MAX;
    c.apply(priv.map(([a, z], i): Rep => [a, z, "[prywatne]", removed && glued[i] ? "" : "[prywatne]"]));
  }
  // znaczniki z wejścia i Markdown na tekście po zdjęciu bloków (pozycje bieżącego tekstu)
  const marks = hasMarks ? markRuns(c.text) : null;
  if (marks?.length) {
    removed = true;
    c.apply(marks);
  }
  const split = hasSplitMark(c.text) ? splitRuns(c.text) : null;
  if (split?.length) {
    removed = true;
    c.apply(split);
  }
  if (!removed) return null;
  strict(c);
  return c;
}

/** clean() z gotowymi zakresami podłogi (maskSource liczy ją raz dla obu decyzji); marks: znaczniki z wejścia. */
function cleanOver(s: string, floorSpans: Span[], marks: [number, number][] = []): string {
  const priv = pairs(s, PRIVATE_OPEN, PRIVATE_CLOSE);
  const b = new Track(s);
  b.apply(rangeReps(priv, "[prywatne]"));
  strict(b);
  // widok sklejony tylko dla tekstu z czymś do usunięcia (koszt jednego przebiegu reguł ścisłych)
  const c = priv.length || marks.length || hasSplitMark(s) ? joinedView(s, priv, marks.length > 0) : null;
  // zakresy widoku sklejonego bez samych usuniętych serii (GLUE: nie maska)
  const joined = c ? c.spans().filter(([, , mark]) => mark !== GLUE) : [];
  const both = joined.length ? [...b.spans(), ...joined].sort((x, y) => x[0] - y[0]) : b.spans();
  const extra = settle(s, both, marks);
  return render(s, settle(s, floorSpans, marks), extra).text;
}

/** Jeden przebieg clean(). */
function cleanOnce(s: string): string {
  return cleanOver(s, floorClean(s).spans(), literalMarks(s));
}

// Kaskada: maska późniejszej reguły skraca tekst, który wcześniejsza reguła brała za wartość, więc na wyniku ta
// wcześniejsza widzi inną wartość („--user mysql_pwd=::a” → curl maskuje „:a”, a na „mysql_pwd=:[REDACTED]” stała
// *_pwd dostaje wartość od 6 znaków). Takich par reguł jest wiele i każda łatka osłabiałaby którąś redakcję, więc
// clean() powtarza przebieg na własnym wyniku, aż przestanie się zmieniać (każdy przebieg tylko dokłada maski).
// Tekst bez trafień kosztuje jeden przebieg, z trafieniami zwykle dwa; MAX_PASSES to bezpiecznik. Tekst dłuższy niż
// FIXPOINT_MAX dostaje jeden przebieg (wklejony log w hooku nie płaci podwójnie, kaskady to rzadkie, sztuczne kształty),
// a wszystko, co trafia do bazy (prompt do 8000 znaków, wynik narzędzia do 4000, notatki), jest dużo krótsze, więc
// `hipokamp repair` nie przepisuje rekordu drugi raz.
const MAX_PASSES = 4;
const FIXPOINT_MAX = 32 * 1024;

/**
 * Jak redact(stripPrivate(s)) w każdym z przebiegów: <private> najpierw, potem reguły, zakresy z obu razem.
 * Idempotentne (do FIXPOINT_MAX znaków): clean(clean(s)) === clean(s) (T-36).
 */
export function clean(s: string | null | undefined): string {
  if (!s) return "";
  let prev = s;
  let out = cleanOnce(s);
  if (s.length > FIXPOINT_MAX) return out;
  for (let n = 1; n < MAX_PASSES && out !== prev; n++) {
    prev = out;
    out = cleanOnce(out);
  }
  return out;
}

// ---------------------------------------------------------------- tekst źródła dla smart_* (src/mcp/code.ts)

// Przypisanie złamane przez formatter: klucz w jednej linii, literał z wartością w następnej (DATABASE_PASSWORD =\n "…",
// password:\n "…", Black: = (\n "…"). clean() widzi jedną linię i tego nie połączy. W main:
// /((?:klucze)["']?)(\s*[:=]\s*(?:[(\\]\s*)?)(["'`])((?:\\.|(?!\3)[^\\\r\n])*)\3/gi, a o masce decyduje clean() na
// sklejonej linii (te same wyjątki: ${VAR}, krótkie wartości, placeholdery). Tylko literał w cudzysłowie: wartość bez
// niego to zwykle kod (Python: if token:\n return ...). Głowę (klucz, separator, cudzysłów otwierający) znajduje
// wyrażenie: dla danego początku pasuje najwyżej jedna, więc dopasowanie całości to głowa plus literał, a gdy literał
// się nie zamyka, szukamy od następnego znaku, jak replace z flagą g. Koniec literału liczy kod (literalEnd).
const MAIN_BROKEN =
  /((?:pass(?:word|wd)?|haslo|hasło|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential|private[_-]?key|client[_-]?secret)["']?)(\s*[:=]\s*(?:[(\\]\s*)?)["'`]/gi;
const BROKEN = new RegExp(String.raw`((?:${ASSIGN_KEYS})["']?)(\s*[:=]\s*(?:[(\\]\s*)?)["'${"`"}]`, "gi");

/**
 * Zamknięcie literału (?:\\.|(?!q)[^\\\r\n])*q otwartego cudzysłowem q na pozycji o: indeks q albo -1. Rozstrzyga
 * pierwsze zdarzenie za otwarciem: q bez \ przed nim (koniec), CR/LF albo \ przed końcem linii lub tekstu (brak).
 * Pary \x liczą się od początku serii \, a otwarcie to cudzysłów, nie \, więc każde otwarcie przed tym samym
 * zdarzeniem kończy się tak samo: wynik jest zapamiętany i każdy znak czytamy raz na rodzaj cudzysłowu (liniowo także
 * na „password=\"password=\"…”, gdzie dawne wyrażenie czytało literał do końca linii od każdego klucza).
 */
function literalEnd(t: string): (o: number) => number {
  const memo = new Map<number, [number, number, number]>(); // q → [od, zdarzenie, wynik]
  return (o) => {
    const q = t.charCodeAt(o);
    const from = o + 1;
    const m = memo.get(q);
    if (m && m[0] <= from && from <= m[1]) return m[2];
    let k = from;
    let res = -1;
    for (; k < t.length; k++) {
      const c = t.charCodeAt(k);
      if (c === 92) {
        const d = t.charCodeAt(k + 1);
        if (k + 1 >= t.length || d === 10 || d === 13 || d === 0x2028 || d === 0x2029) break; // . nie łapie końca linii
        k++;
      } else if (c === q) {
        res = k;
        break;
      } else if (c === 10 || c === 13) break;
    }
    memo.set(q, [from, k, res]);
    return res;
  };
}

/** Złamane przypisania: maska wnętrza literału, gdy sklejona linia zmienia się w cleaner(). */
function brokenReps(t: string, head: RegExp, cleaner: (s: string) => string): Rep[] {
  const reps: Rep[] = [];
  const close = literalEnd(t);
  head.lastIndex = 0;
  for (let m = head.exec(t); m; m = head.exec(t)) {
    const o = m.index + m[0].length - 1;
    const c = close(o);
    if (c < 0) {
      head.lastIndex = m.index + 1;
      continue;
    }
    head.lastIndex = c + 1;
    const [, key, sep] = m;
    if (!sep.includes("\n") || c === o + 1) continue; // w jednej linii maskuje clean()
    const flat = `${key}${sep.includes("=") ? "=" : ":"} ${t.slice(o, c + 1)}`;
    if (cleaner(flat) !== flat) reps.push([o + 1, c, "[REDACTED]"]);
  }
  return reps;
}

/** Bloki wieloliniowe: znacznik w każdej linii, znaki nowej linii zostają (numeracja linii bez zmian). */
const blockPass = (tr: Track, ranges: [number, number][], mark: string): void =>
  tr.apply(ranges.map(([a, b]) => [a, b, mark, markLines(mark)(tr.text.slice(a, b))]));

/** Zakresy podłogi clean() dla jednej linii, także przyciętej (sygnatura w smart_outline), połączone i rozłączne. */
function lineFloorReps(line: string, at: number): Rep[] {
  const sp = floorClean(line).spans();
  const trimmed = line.trim();
  if (trimmed && trimmed !== line) {
    const lead = line.length - line.trimStart().length;
    for (const [a, b, mark] of floorClean(trimmed).spans()) sp.push([a + lead, b + lead, mark]);
    sp.sort((x, y) => x[0] - y[0]);
  }
  const reps: Rep[] = [];
  for (const [a, b, mark] of sp) {
    const last = reps[reps.length - 1];
    if (last && a < last[1]) last[1] = Math.max(last[1], b);
    else reps.push([a, b, mark]);
  }
  for (const r of reps) {
    r[0] += at;
    r[1] += at;
  }
  return reps;
}

/**
 * Tekst pliku dla smart_*: bloki wieloliniowe (<private>…</private>, klucz PEM, także ucięty) i złamane przypisania
 * zamaskowane z góry, linia po linii, bo clean() dostaje potem pojedyncze linie. Jak w redact(): podłoga to dokładnie
 * maskBlocks z main (bloki w tej samej kolejności, złamane przypisania z kluczami main i decyzją clean() z main), reguły
 * ścisłe osobno (<private >, ucięty PEM, ASSIGN_KEYS z decyzją pełnego clean()), wynik to suma zakresów.
 *
 * Sama suma nie wystarcza, bo code.ts woła na niej clean() linia po linii: maska ścisła może zasłonić klucz, od którego
 * clean() z main zaczynał maskę dalej w tej linii ("x password": "…" za złamanym credentials:). Dlatego w każdej linii,
 * której tekst różni się od tekstu main, dokładamy z góry zakresy clean() z main policzone na linii main (pełnej
 * i przyciętej). W pozostałych liniach tekst jest ten sam co w main, a clean() maskuje nadzbiór podłogi. Zakres
 * dołożony na znaczniku bloku obejmuje cały blok, więc sprawdzamy linie aż do braku nowych różnic (najwyżej kilka
 * rund, potem wszystkie linie naraz).
 */
export function maskSource(text: string): string {
  // sklejone linie się powtarzają (ten sam klucz i literał w obu przebiegach, wzorce w pliku): podłoga clean() raz
  const memo = new Map<string, { floor: string; spans: Span[]; full?: string }>();
  const once = (flat: string) => {
    let m = memo.get(flat);
    if (!m) {
      const a = floorClean(flat);
      memo.set(flat, (m = { floor: a.text, spans: a.spans() }));
    }
    return m;
  };
  const f = new Track(text);
  blockPass(f, pairs(f.text, MAIN_PRIVATE_OPEN, MAIN_PRIVATE_CLOSE), "[prywatne]");
  blockPass(f, mainPemRanges(f.text), "[REDACTED:private-key]");
  f.apply(brokenReps(f.text, MAIN_BROKEN, (flat) => once(flat).floor));
  const s = new Track(text);
  blockPass(s, pairs(s.text, PRIVATE_OPEN, PRIVATE_CLOSE), "[prywatne]");
  blockPass(s, pemRanges(s.text), "[REDACTED:private-key]");
  s.apply(
    brokenReps(s.text, BROKEN, (flat) => {
      const m = once(flat);
      m.full ??= cleanOver(flat, m.spans);
      return m.full;
    }),
  );
  const fmt = (slice: string, mark: string) => markLines(mark)(slice);
  const sSpans = s.spans();
  const base = f.text;
  let out = render(text, f.spans(), sSpans, fmt).text;
  if (out === base) return out;
  const NL = /\r?\n/g;
  const starts = [0];
  for (let m = NL.exec(base); m; m = NL.exec(base)) starts.push(m.index + m[0].length);
  const lines = base.split(/\r?\n/);
  const done = new Uint8Array(lines.length);
  for (let round = 0; ; round++) {
    const now = out.split(/\r?\n/);
    let grew = false;
    for (let i = 0; i < lines.length; i++)
      if (!done[i] && now[i] !== lines[i]) {
        done[i] = 1;
        grew = true;
      }
    if (!grew) return out;
    if (round >= 3) done.fill(1);
    const reps: Rep[] = [];
    for (let i = 0; i < lines.length; i++) if (done[i]) for (const r of lineFloorReps(lines[i], starts[i])) reps.push(r);
    const g = f.fork();
    g.apply(reps);
    out = render(text, g.spans(), sSpans, fmt).text;
    if (round >= 3) return out;
  }
}
