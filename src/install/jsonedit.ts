// Punktowa edycja plików konfiguracji JSON i JSONC (komentarze, przecinki na końcu) innych harnessów: zmieniamy
// tylko wpis hipokampa, reszta pliku (cudze wpisy, komentarze, wcięcia, kolejność) zostaje bajt w bajt. Dopisanie
// i usunięcie tego samego wpisu oddaje plik w dokładnie takiej postaci, w jakiej był.

type Node =
  | { kind: "object"; start: number; end: number; members: Member[] }
  | { kind: "array"; start: number; end: number; items: Node[] }
  | { kind: "value"; start: number; end: number };

interface Member {
  key: string;
  keyStart: number;
  value: Node;
}

/** Drzewo dokumentu z zakresami znaków; błąd składni rzuca wyjątek (wtedy pliku nie ruszamy). */
export function parseTree(text: string): Node {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (what: string): never => {
    throw new Error(`${what} (znak ${i})`);
  };
  const ws = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && text[i + 1] === "/") {
        const e = text.indexOf("\n", i);
        i = e < 0 ? text.length : e + 1;
      } else if (c === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        if (e < 0) fail("niezamknięty komentarz");
        i = e + 2;
      } else return;
    }
  };
  const str = (): string => {
    const s = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (text[i] !== '"') fail("niezamknięty napis");
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const value = (): Node => {
    ws();
    const s = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const members: Member[] = [];
      for (;;) {
        ws();
        if (text[i] === "}") break;
        if (text[i] !== '"') fail("oczekiwany klucz");
        const keyStart = i;
        const key = str();
        ws();
        if (text[i] !== ":") fail("oczekiwany dwukropek");
        i++;
        members.push({ key, keyStart, value: value() });
        ws();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail("oczekiwany przecinek albo }");
      }
      i++;
      return { kind: "object", start: s, end: i, members };
    }
    if (c === "[") {
      i++;
      const items: Node[] = [];
      for (;;) {
        ws();
        if (text[i] === "]") break;
        items.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("oczekiwany przecinek albo ]");
      }
      i++;
      return { kind: "array", start: s, end: i, items };
    }
    if (c === '"') {
      str();
      return { kind: "value", start: s, end: i };
    }
    const lit = /true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    lit.lastIndex = i;
    const m = lit.exec(text);
    if (!m) fail("nieznana wartość");
    i += m![0].length;
    return { kind: "value", start: s, end: i };
  };
  const root = value();
  ws();
  if (i < text.length) fail("nadmiarowa treść po dokumencie");
  return root;
}

/** Wartość węzła jako obiekt JS (bez komentarzy). */
function nodeValue(text: string, n: Node): any {
  if (n.kind === "value") return JSON.parse(text.slice(n.start, n.end));
  if (n.kind === "array") return n.items.map((x) => nodeValue(text, x));
  return Object.fromEntries(n.members.map((m) => [m.key, nodeValue(text, m.value)]));
}

/** Dokument JSONC jako obiekt JS; pusty plik to `{}`. */
export function readJsonc(text: string): any {
  if (!text.trim()) return {};
  return nodeValue(text, parseTree(text));
}

/**
 * Indeks klucza w obiekcie: przy powtórzonym kluczu ostatni, bo ostatni widzi parser aplikacji (JSON.parse
 * i parsery JSONC harnessów biorą ostatnią wartość).
 */
function memberIndex(box: Node & { kind: "object" }, key: string): number {
  for (let i = box.members.length - 1; i >= 0; i--) if (box.members[i].key === key) return i;
  return -1;
}

/** Węzeł pod ścieżką; w tablicy segment ścieżki to indeks elementu („0”, „1”…). */
function find(root: Node, path: string[]): Node | null {
  let n: Node | null = root;
  for (const k of path) {
    if (n?.kind === "array") n = /^\d+$/.test(k) ? (n.items[Number(k)] ?? null) : null;
    else if (n?.kind === "object") {
      const i = memberIndex(n, k);
      n = i < 0 ? null : n.members[i].value;
    } else return null;
  }
  return n;
}

export function getAt(text: string, path: string[]): any {
  if (!text.trim()) return undefined;
  const root = parseTree(text);
  const n = find(root, path);
  return n ? nodeValue(text, n) : undefined;
}

const newline = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Jednostka wcięcia pliku: pierwsze wcięcie od nowej linii (tabulator albo spacje), domyślnie dwie spacje. */
function indentUnit(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return "  ";
  return m[1].startsWith("\t") ? "\t" : m[1];
}

/** Wcięcie linii, w której zaczyna się pozycja `at`. */
function lineIndent(text: string, at: number): string {
  const s = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(s, at))![0];
}

/**
 * Wartość sformatowana jak plik: wcięcie pliku, kolejne linie przesunięte do wcięcia wpisu; `indent` null: w jednej
 * linii (plik albo kontener zapisany w jednej linii).
 */
function format(text: string, value: unknown, indent: string | null): string {
  if (indent === null) return minified(text) ? JSON.stringify(value) : spaced(JSON.stringify(value));
  const nl = newline(text);
  return JSON.stringify(value, null, indentUnit(text)).split("\n").join(`${nl}${indent}`);
}

/** Cały dokument w jednej linii (np. `{"mcpServers":{}}`): dopisane wartości też w jednej linii. */
const oneLine = (text: string) => !text.trim().includes("\n");

/** Plik bez odstępów po przecinkach i dwukropkach (poza napisami): dopisany wpis też bez nich. */
const minified = (text: string) => !/[,:][ \t]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'));

/** JSON w jednej linii z odstępem po `:` i `,` (poza napisami), jak `{"a": 1, "b": [1, 2]}`. */
function spaced(json: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    out += c;
    if (inStr) {
      if (c === "\\") out += json[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === ":" || c === ",") out += " ";
  }
  return out;
}

/** Oddzielenie klucza od wartości w stylu pliku. */
const colon = (text: string, indent: string | null) => (indent === null && minified(text) ? ":" : ": ");

/** Wstawia element (`"klucz": wartość` albo wartość tablicy) na końcu kontenera, w stylu pliku. */
function insertLast(text: string, box: Node & { kind: "object" | "array" }, render: (indent: string | null) => string): string {
  const nl = newline(text);
  const kids = box.kind === "object" ? box.members.map((m) => ({ start: m.keyStart, end: m.value.end })) : box.items;
  if (kids.length) {
    const last = kids[kids.length - 1];
    // nowy element w osobnej linii z wcięciem ostatniego; kontener w jednej linii: dalej w jednej linii
    const multiline = text.slice(box.start, last.start).includes("\n");
    const ind = lineIndent(text, last.start);
    const piece = multiline ? `,${nl}${ind}${render(ind)}` : `${minified(text) ? "," : ", "}${render(null)}`;
    return text.slice(0, last.end) + piece + text.slice(last.end);
  }
  // pusty kontener: to, co jest między nawiasami (odstępy, komentarze), zostaje. Kontener w jednej linii (`{}`, `{ }`)
  // dostaje wpis zaraz za nawiasem, w tej samej linii. Rozpisany na linie (`{\n}`, komentarz w środku) dostaje wpis
  // w nowej linii za resztą tekstu (komentarz `[ // koniec tury` zostaje przed wpisem), przed odstępem przed nawiasem
  // zamykającym; zdjęcie jedynego elementu (removeKid) oddaje kontener bajt w bajt
  const open = box.start + 1;
  if (!text.slice(open, box.end - 1).includes("\n")) return `${text.slice(0, open)}${render(null)}${text.slice(open)}`;
  let at = box.end - 1;
  while (at > open && /[ \t\r\n]/.test(text[at - 1])) at--;
  const ind = lineIndent(text, box.start) + indentUnit(text);
  return `${text.slice(0, at)}${nl}${ind}${render(ind)}${text.slice(at)}`;
}

/**
 * Ustawia wartość pod ścieżką kluczy (brakujące obiekty po drodze zakłada). Istniejąca wartość jest zastępowana
 * w swoim zakresie, nowa dopisywana na końcu obiektu. Pusty plik dostaje cały dokument.
 */
export function setAt(text: string, path: string[], value: unknown): string {
  if (!text.trim()) {
    let doc: unknown = value;
    for (const k of [...path].reverse()) doc = { [k]: doc };
    return `${JSON.stringify(doc, null, 2)}\n`;
  }
  const root = parseTree(text);
  let box: Node = root;
  for (let d = 0; d < path.length; d++) {
    if (box.kind !== "object") throw new Error(`${path.slice(0, d).join(".") || "dokument"} to nie obiekt`);
    const mi = memberIndex(box, path[d]);
    const m = mi < 0 ? null : box.members[mi];
    if (!m) {
      // reszta ścieżki jako jeden nowy wpis
      let rest: unknown = value;
      for (const k of path.slice(d + 1).reverse()) rest = { [k]: rest };
      return insertLast(text, box, (ind) => `${JSON.stringify(path[d])}${colon(text, ind)}${format(text, rest, ind)}`);
    }
    if (d === path.length - 1) {
      // obiekt zapisany w jednej linii: nowa wartość też w jednej linii
      const ind = oneLine(text) || !text.slice(box.start, box.end).includes("\n") ? null : lineIndent(text, m.keyStart);
      return text.slice(0, m.value.start) + format(text, value, ind) + text.slice(m.value.end);
    }
    box = m.value;
  }
  return text;
}

/**
 * Usuwa element `idx` kontenera razem z przecinkiem. Jedyny element schodzi ze swoim zakresem (z odstępem przed nim,
 * gdy przed nim jest tylko nawias, i z przecinkiem za nim): reszta tekstu między nawiasami, np. komentarze, zostaje.
 */
function removeKid(text: string, box: Node & { kind: "object" | "array" }, idx: number): string {
  const kids = box.kind === "object" ? box.members.map((m) => ({ start: m.keyStart, end: m.value.end })) : box.items;
  if (kids.length === 1) {
    const k = kids[0];
    let s = k.start;
    while (s > box.start + 1 && /[ \t\r\n]/.test(text[s - 1])) s--;
    let j = k.end;
    while (j < box.end - 1 && /[ \t\r\n]/.test(text[j])) j++;
    // za elementem (i przecinkiem) koniec linii przed dalszą treścią
    let q = text[j] === "," ? j + 1 : k.end;
    let lineAfter = false;
    for (; q < box.end - 1 && /[ \t\r\n]/.test(text[q]); q++) if (text[q] === "\n") lineAfter = true;
    // przed elementem komentarz albo inny tekst: odstęp przed elementem schodzi tylko wtedy, gdy element stał we
    // własnej linii, a za nim zostaje koniec linii (zamyka komentarz //); inaczej odstęp zostaje
    if (s !== box.start + 1 && !(lineAfter && text.slice(s, k.start).includes("\n"))) s = k.start;
    if (text[j] === ",") return text.slice(0, s) + text.slice(k.end, j) + text.slice(j + 1);
    return text.slice(0, s) + text.slice(k.end);
  }
  if (idx > 0) return text.slice(0, kids[idx - 1].end) + text.slice(kids[idx].end);
  return text.slice(0, kids[0].start) + text.slice(kids[1].start);
}

/**
 * Usuwa klucz pod ścieżką; obiekty po drodze, które przez to zostały puste i które `prune` wskaże (domyślnie
 * wszystkie), też znikają (bez samego dokumentu): wpis dopisany przez `setAt` razem z obiektami, które założył,
 * schodzi bez śladu, a cudzy pusty obiekt zostaje.
 */
export function removeAt(text: string, path: string[], prune: (p: string[]) => boolean = () => true): string {
  if (!text.trim() || !path.length) return text;
  for (let d = path.length; d >= 1; d--) {
    const root = parseTree(text);
    const parent = find(root, path.slice(0, d - 1));
    if (parent?.kind !== "object") return text;
    const idx = memberIndex(parent, path[d - 1]);
    if (idx < 0) return text;
    const target = parent.members[idx].value;
    const empty = (target.kind === "object" && !target.members.length) || (target.kind === "array" && !target.items.length);
    // na najgłębszym poziomie usuwamy zawsze, wyżej tylko kontener, który został pusty
    if (d < path.length && (!empty || !prune(path.slice(0, d)))) return text;
    text = removeKid(text, parent, idx);
  }
  return text;
}

/** Dopisuje element na końcu tablicy pod ścieżką (brakującą tablicę i obiekty po drodze zakłada). */
export function appendAt(text: string, path: string[], value: unknown): string {
  if (!text.trim()) return setAt(text, path, [value]);
  const n = find(parseTree(text), path);
  if (!n) return setAt(text, path, [value]);
  if (n.kind !== "array") throw new Error(`${path.join(".")} to nie tablica`);
  return insertLast(text, n, (ind) => format(text, value, ind));
}

/**
 * Wstawia element tablicy pod ścieżką na pozycję `index` (przed element, który tam stoi; poza końcem: na końcu, jak
 * appendAt). Reszta tekstu, w tym komentarze między elementami, zostaje na miejscu.
 */
export function insertAt(text: string, path: string[], index: number, value: unknown): string {
  if (!text.trim()) return setAt(text, path, [value]);
  const n = find(parseTree(text), path);
  if (!n) return setAt(text, path, [value]);
  if (n.kind !== "array") throw new Error(`${path.join(".")} to nie tablica`);
  if (index >= n.items.length) return insertLast(text, n, (ind) => format(text, value, ind));
  const at = n.items[Math.max(0, index)];
  const multiline = text.slice(n.start, at.start).includes("\n");
  if (multiline) {
    const ind = lineIndent(text, at.start);
    return `${text.slice(0, at.start)}${format(text, value, ind)},${newline(text)}${ind}${text.slice(at.start)}`;
  }
  return `${text.slice(0, at.start)}${format(text, value, null)}${minified(text) ? "," : ", "}${text.slice(at.start)}`;
}

/**
 * Usuwa z tablicy pod ścieżką elementy spełniające warunek; tablica, która przez to została pusta, znika razem
 * z pustymi obiektami nad nią, o ile `prune` je wskaże (domyślnie wszystkie).
 */
export function removeFromArray(
  text: string,
  path: string[],
  match: (v: any) => boolean,
  prune: (p: string[]) => boolean = () => true,
): { text: string; removed: number } {
  let removed = 0;
  for (;;) {
    if (!text.trim()) return { text, removed };
    const n = find(parseTree(text), path);
    if (n?.kind !== "array") return { text, removed };
    const idx = n.items.findIndex((x) => match(nodeValue(text, x)));
    if (idx < 0) {
      if (removed && !n.items.length && prune(path)) text = removeAt(text, path, prune);
      return { text, removed };
    }
    text = removeKid(text, n, idx);
    removed++;
  }
}
