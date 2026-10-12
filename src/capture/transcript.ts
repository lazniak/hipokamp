// Przyrostowy parser transkryptów Claude Code (JSONL) i grupowanie w tury.
// Tura = prompt człowieka + cała praca asystenta do następnego promptu. Praca po turze zamkniętej wcześniej
// (Stop przy end_turn), która przyszła bez nowego promptu, to osobna tura „ciąg dalszy”.
// Transkrypty innych harnessów (Codex, Gemini CLI, Cursor) czyta ten sam parser: linie tłumaczy formats.ts.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isForeignTranscript, type Translator, translatorFor } from "./formats.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
  isError: boolean;
  /** Tekst wyniku (przycięty). */
  result: string;
  /** Ustrukturyzowany wynik z `toolUseResult` (np. filePath, type: 'create', stdout). */
  structured: Record<string, any> | null;
  at: number;
}

/** `continuation`: dalsza praca głównego wątku po zamkniętej turze bez nowego promptu (np. po uwadze hooka Stop). */
export type TurnKind = "human" | "task" | "command" | "continuation";

export interface Turn {
  /** uuid linii promptu (w ciągu dalszym: jego pierwszej linii) — stabilny klucz (wznowienie sesji kopiuje historię z tymi samymi uuid). */
  key: string;
  sessionId: string;
  kind: TurnKind;
  prompt: string;
  hasImage: boolean;
  startedAt: number;
  endedAt: number;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  texts: string[];
  tools: ToolCall[];
  interrupted: boolean;
  from: number;
  to: number;
}

/** Klucz sesji innego harnessu: przedrostek (Cowork, Gemini CLI, Cursor, OpenCode), a linie (Cowork) niosą goły uuid. */
const HARNESS_SESSION = /^(desktop|gemini|cursor|opencode):/;

/**
 * Tury sesji innego harnessu dostają jej klucz z przedrostkiem zamiast sessionId z linii (ingest i odzysk tur
 * w `hipokamp repair`): inaczej notatka trafia do sesji z gołym uuid, której nie ma w bazie.
 */
export function adoptSession(sessionId: string, turns: Turn[]): void {
  if (HARNESS_SESSION.test(sessionId)) for (const t of turns) t.sessionId = sessionId;
}

export interface Line {
  json: any;
  start: number;
  end: number;
}

const MAX_RESULT = 4000;

/**
 * Czyta pełne linie od `offset`. Niepełna ostatnia linia (bez \n) zostaje na później. `given`: tłumacz obcego formatu
 * współdzielony przez kolejne, przylegające odczyty jednego wywołania readTurns (Gemini CLI: stan wersji wiadomości);
 * bez niego każdy odczyt dostaje nowy.
 */
export function readLinesFrom(
  path: string,
  offset: number,
  maxBytes = 64 * 1024 * 1024,
  given?: Translator,
): { lines: Line[]; end: number; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset >= size) return { lines: [], end: Math.min(offset, size), size };
    const len = Math.max(0, Math.min(size - offset, maxBytes));
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const data = read < len ? buf.subarray(0, read) : buf;
    const lines: Line[] = [];
    // obcy format (Codex, Gemini CLI, Cursor): linie tłumaczone na kształt Claude Code (jedna linia bywa kilkoma
    // albo żadną, w formacie tekstowym blok składa się z wielu linii)
    const tr = given ?? translatorFor(path);
    let s = 0;
    // format tekstowy (stary .txt Cursora) nie kończy pliku znakiem \n: przy odczycie do końca pliku ostatnia linia też
    const tail = !!tr?.text && offset + data.length === size && data.length > 0 && data[data.length - 1] !== 0x0a;
    // 0x0A nie występuje wewnątrz wielobajtowych znaków UTF-8, więc cięcie po bajtach jest bezpieczne
    for (let i = data.indexOf(0x0a); i >= 0 || (tail && s < data.length); i = data.indexOf(0x0a, s)) {
      if (i < 0) i = data.length;
      const start = offset + s;
      const end = offset + Math.min(i + 1, data.length);
      if (i > s && !(tr && end <= tr.skipUntil)) {
        const raw = data.toString("utf8", s, i);
        if (tr?.text) lines.push(...tr.text(raw, start, end));
        else {
          try {
            const j = JSON.parse(raw);
            if (tr?.json) for (const json of tr.json(j)) lines.push({ json, start, end });
            else lines.push({ json: slimLine(j), start, end });
          } catch {
            // uszkodzona linia: pomijamy, ale przesuwamy offset
          }
        }
      }
      s = Math.min(i + 1, data.length);
    }
    if (tr?.text) {
      // blok przy końcu pliku domykamy; w środku pliku czeka, a offset nie przechodzi za jego początek
      if (offset + s === size) lines.push(...(tr.flush?.() ?? []));
      const open = tr.pendingFrom?.() ?? null;
      if (open !== null) return { lines, end: Math.max(offset, open), size };
    }
    return { lines, end: offset + s, size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Odchudza linię zaraz po parsowaniu. Base64 obrazów i surowy `toolUseResult` (u narzędzi MCP to drugi raz te same
 * obrazy) to ok. 95% bajtów największych tur, a nikt ich nie czyta: obraz to „[obraz]”, wynik idzie przez slimStructured.
 */
function slimLine(j: any): any {
  if (j?.type !== "user" && j?.type !== "assistant") return j;
  const c = j.message?.content;
  if (Array.isArray(c)) for (const b of c) dropImageData(b);
  if (j.toolUseResult !== undefined) j.toolUseResult = slimStructured(j.toolUseResult);
  return j;
}

function dropImageData(b: any): void {
  if (b?.type === "image" && b.source?.data) b.source = { type: b.source.type, media_type: b.source.media_type };
  else if (b?.type === "tool_result" && Array.isArray(b.content)) for (const x of b.content) dropImageData(x);
}

/** Pozycja tuż za najbliższym \n od `from`, czytana kawałkami (bez trzymania linii w pamięci); -1: brak do końca pliku. */
function lineEndAfter(path: string, from: number): number {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (let pos = from; ; ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return -1;
      const i = buf.subarray(0, n).indexOf(0x0a);
      if (i >= 0) return pos + i + 1;
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
}

function ts(x: unknown): number {
  const t = typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function blocksText(c: any): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[obraz]" : ""))
    .filter(Boolean)
    .join("\n");
}

const NOISE =
  /^(<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|Caveat: The messages below|<system-reminder>|\[Request interrupted)/;

const RE_INTERRUPT = /^\[Request interrupted/;

/** Znacznik przerwania przez użytkownika („[Request interrupted by user…]”) jako napis albo blok tekstu. */
function isInterrupt(j: any): boolean {
  const c = j?.message?.content;
  if (typeof c === "string") return RE_INTERRUPT.test(c);
  return Array.isArray(c) && c.some((b: any) => b?.type === "text" && RE_INTERRUPT.test(b.text ?? ""));
}

const RE_LEADING_REMINDERS = /^(\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/;

/** Komenda i zadanie cykliczne w skrócie: treścią „promptu” są wtedy instrukcje skilla, nie słowa człowieka. */
function commandText(text: string): string | null {
  const sched = text.match(/^<scheduled-task name="([^"]+)"/);
  if (sched) return `Zadanie cykliczne: ${sched[1]}`;
  const cmd = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (!cmd) return null;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
  return `${cmd[1]}${args ? ` ${args}` : ""}`;
}

/**
 * Surowy tekst promptu (np. zapisany przez claude-mem) w postaci, jaką prompt ma w turze: bez bloków <system-reminder>
 * na początku, komenda i zadanie cykliczne w skrócie. Do porównywania promptów po tekście.
 */
export function comparablePrompt(raw: string): string {
  const text = raw.replace(RE_LEADING_REMINDERS, "").trim();
  return commandText(text) ?? text;
}

/** Czy linia to prompt (człowieka, komendy albo powiadomienia zadania). */
export function promptOf(j: any): { text: string; kind: TurnKind; hasImage: boolean } | null {
  if (j?.type !== "user" || j.isSidechain || j.isMeta || j.isCompactSummary) return null;
  const c = j.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return null;
  let text = blocksText(c).trim();
  // aplikacja desktop dokleja przed promptem człowieka blok <system-reminder> (sesja bez folderu, worktree, zadanie
  // z podpowiedzi); bez tego cięcia NOISE odrzucał cały prompt, a z nim pierwszą turę takich sesji
  if (j.origin?.kind === "human") text = text.replace(RE_LEADING_REMINDERS, "").trim();
  const hasImage = Array.isArray(c) && c.some((b: any) => b?.type === "image");
  if (!text && !hasImage) return null;
  if (NOISE.test(text)) return null;
  if (/^This session is being continued from a previous conversation/.test(text)) return null;
  if (j.origin?.kind === "task-notification" || text.startsWith("<task-notification>")) return { text, kind: "task", hasImage };
  const cmd = commandText(text);
  if (cmd !== null) return { text: cmd, kind: "command", hasImage };
  return { text, kind: "human", hasImage };
}

/** Treść linii otwierającej ciąg dalszy („Stop hook feedback: …”, wiadomość innej sesji), bez bloków <system-reminder>. */
function continuationPrompt(j: any): string {
  const t = blocksText(j.message?.content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .trim();
  return /^This session is being continued from a previous conversation/.test(t) ? "" : t;
}

/** Komenda obsłużona lokalnie przez Claude Code (/model, /compact): bez odpowiedzi modelu i bez przerwania. */
export function isLocalCommand(t: Turn): boolean {
  return t.kind === "command" && t.model === null && !t.texts.length && !t.tools.length && !t.interrupted;
}

/**
 * Czy tura dostaje numer promptu. Numer i wiersz w prompts mają tylko prompty, które numeruje też claude-mem
 * (UserPromptSubmit): bez powiadomień zadań, ciągów dalszych i komend lokalnych (/model, /compact).
 */
export function countsAsPrompt(t: Turn): boolean {
  return t.kind === "human" || (t.kind === "command" && !isLocalCommand(t));
}

/**
 * Kopia napisu. Wycinek (`slice`) w JSC współdzieli bufor z napisem źródłowym: 4000 znaków z wyniku narzędzia
 * trzymało w pamięci cały wynik (200 wyników po 2 MB: 800 MB sterty, z kopią 3 MB). Przycięte fragmenty, które
 * zostają w turze dłużej niż linia, z której pochodzą, muszą być kopiami.
 */
const copyOf = (s: string): string => Buffer.from(s, "utf8").toString("utf8");

function resultText(b: any): string {
  const c = b?.content;
  const t =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((x: any) => (x?.type === "text" ? x.text : x?.type === "image" ? "[obraz]" : "")).join("\n")
        : "";
  return t.length > MAX_RESULT ? copyOf(`${t.slice(0, MAX_RESULT)}…[+${t.length - MAX_RESULT}]`) : t;
}

/** Ostatnie `n` znaków napisu jako kopia (zob. copyOf); krótszy zostaje bez zmian. */
const tailOf = (s: string, n: number): string => (s.length > n ? copyOf(s.slice(-n)) : s);

/** Wycina z toolUseResult tylko pola przydatne do streszczenia (bez pełnych treści plików). */
function slimStructured(r: any): Record<string, any> | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const out: Record<string, any> = {};
  for (const k of [
    "type",
    "filePath",
    "interrupted",
    "returnCodeInterpretation",
    "numFiles",
    "numLines",
    "success",
    "commandName",
    "status",
    "agentId",
    "description",
    "gitOperation",
  ]) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  if (typeof r.stdout === "string") out.stdout = tailOf(r.stdout, 1500);
  if (typeof r.stderr === "string" && r.stderr) out.stderr = tailOf(r.stderr, 1500);
  if (r.file?.filePath) out.filePath = r.file.filePath;
  if (Array.isArray(r.answers) || r.answers) out.answers = r.answers;
  if (Array.isArray(r.questions)) out.questions = r.questions;
  return out;
}

/**
 * Grupuje linie w tury. `final=true`: ostatnia tura jest kompletna (Stop/SessionEnd/backfill).
 * Linie głównego wątku przed pierwszym promptem okna (offset za turą zamkniętą wcześniej) tworzą turę
 * `continuation`, jeśli asystent coś w nich napisał albo wywołał; czeka jak zwykła tura w toku.
 * Zwraca też offset, do którego linie zostały skonsumowane.
 */
export function groupTurns(lines: Line[], sessionId: string, opts: { final: boolean }): { turns: Turn[]; consumedTo: number } {
  const g = turnGrouper(sessionId);
  for (const l of lines) g.feed(l);
  const last = lines.length ? lines[lines.length - 1].end : 0;
  if (opts.final) {
    g.close();
    return { turns: g.turns, consumedTo: last };
  }
  // tura w toku zostaje — konsumujemy tylko do jej początku
  const pending = g.current();
  return { turns: g.turns, consumedTo: pending ? pending.from : last };
}

/** Składanie tur linia po linii: groupTurns, a readTurns dokłada tak kolejne partie tury dłuższej niż okno. */
function turnGrouper(sessionId: string): {
  turns: Turn[];
  feed: (line: Line) => void;
  close: () => void;
  current: () => Turn | null;
} {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const byToolId = new Map<string, ToolCall>();

  const close = () => {
    const c = cur as Turn | null;
    // ciąg dalszy bez tekstu i narzędzi asystenta (np. zastrzeżenie przed komendą lokalną) nie jest turą
    if (c && (c.kind !== "continuation" || c.texts.length || c.tools.length)) turns.push(c);
    cur = null;
  };
  const open = (j: any, start: number, end: number, kind: TurnKind, prompt: string, hasImage: boolean): Turn => ({
    key: j.uuid ?? `${sessionId}:${start}`,
    sessionId: j.sessionId ?? sessionId,
    kind,
    prompt,
    hasImage,
    startedAt: ts(j.timestamp),
    endedAt: ts(j.timestamp),
    cwd: j.cwd ?? null,
    gitBranch: j.gitBranch ?? null,
    model: null,
    texts: [],
    tools: [],
    interrupted: false,
    from: start,
    to: end,
  });

  const feed = ({ json: j, start, end }: Line): void => {
    const p = promptOf(j);
    if (p) {
      close();
      cur = open(j, start, end, p.kind, p.text, p.hasImage);
      return;
    }
    if (!cur) {
      // główny wątek pracuje dalej bez nowego promptu: uwaga hooka Stop, wiadomość innej sesji, pobudka pętli.
      // Metadane, wątki agentów i podsumowanie kompakcji tury nie otwierają.
      if ((j?.type !== "user" && j?.type !== "assistant") || j.isSidechain || j.isCompactSummary) return;
      cur = open(j, start, end, "continuation", j.type === "user" ? continuationPrompt(j) : "", false);
    }
    const t = cur as Turn;
    if (j.isSidechain) return;
    if (j.type === "assistant") {
      t.model ??= j.message?.model ?? null;
      // komunikat o błędzie API („You've hit your weekly limit”) pisze Claude Code, nie model: to nie odpowiedź
      const apiError = !!j.isApiErrorMessage || j.message?.model === "<synthetic>";
      for (const b of j.message?.content ?? []) {
        if (b?.type === "text" && b.text?.trim()) {
          if (!apiError) t.texts.push(b.text.trim());
        } else if (b?.type === "tool_use") {
          const call: ToolCall = {
            id: b.id,
            name: b.name,
            input: b.input ?? {},
            isError: false,
            result: "",
            structured: null,
            at: ts(j.timestamp),
          };
          t.tools.push(call);
          byToolId.set(b.id, call);
        }
      }
      t.endedAt = Math.max(t.endedAt, ts(j.timestamp));
      t.to = end;
      if (!t.cwd && j.cwd) t.cwd = j.cwd;
    } else if (j.type === "user") {
      const c = j.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== "tool_result") continue;
          const call = byToolId.get(b.tool_use_id);
          if (!call) continue;
          call.isError = !!b.is_error;
          call.result = resultText(b);
          call.structured = slimStructured(j.toolUseResult);
        }
      }
      // obecny Claude Code pisze znacznik jako blok tekstu, starszy jako napis
      if (isInterrupt(j)) t.interrupted = true;
      t.endedAt = Math.max(t.endedAt, ts(j.timestamp));
      t.to = end;
    } else if (j.type === "system" || j.type === "attachment") {
      t.to = end;
    }
  };

  return { turns, feed, close, current: () => cur };
}

/**
 * Czy ostatnia tura w przeczytanych liniach jest skończona. Rozstrzyga ostatnia wiadomość głównego wątku: odpowiedź
 * z `stop_reason: "end_turn"`, komunikat o błędzie API (Claude Code pisze go sam, model `<synthetic>`, i kończy turę)
 * albo przerwanie przez użytkownika. Każda późniejsza linia użytkownika (wynik narzędzia, nowy prompt, uwaga hooka
 * Stop, przypomnienie) znaczy, że Claude jeszcze odpowie. `tool_use` bez wyniku (długi Bash, agent, Workflow,
 * czekanie na zgodę) i `max_tokens` (Claude Code prosi o ciąg dalszy) to tura w toku. Linie metadanych nie liczą się.
 */
export function lastTurnComplete(lines: Line[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i].json;
    if (j?.isSidechain) continue;
    if (j?.type === "assistant")
      return j.message?.stop_reason === "end_turn" || !!j.isApiErrorMessage || j.message?.model === "<synthetic>";
    if (j?.type === "user") return isInterrupt(j);
  }
  return false;
}

export interface TurnBatch {
  lines: Line[];
  turns: Turn[];
  /** Nowy offset: początek tury w toku albo koniec przeczytanego zakresu. */
  offset: number;
  end: number;
  size: number;
  /** Tura dłuższa niż limit okna, czytana partiami (w `lines` zostają z niej tylko podsumowania kompakcji). */
  batched: boolean;
  /** Linia dłuższa niż limit okna, pominięta (zakres bajtów; przy kilku pierwsza). */
  skipped: { from: number; to: number } | null;
}

/**
 * Czyta od `offset` i składa tury. `final` jak w groupTurns, a "complete" zamyka ostatnią turę tylko wtedy, gdy
 * lastTurnComplete. Pełne okno, w którym nic się nie domknęło (tura w toku albo linia się w nim nie mieści), rośnie
 * dwukrotnie, dociągając tylko brakujący kawałek, aż do `maxWindow`. Tura dłuższa od limitu jest czytana dalej
 * partiami do `maxWindow` aż do swojego końca (readLongTurn), a linia dłuższa od limitu jest pomijana, więc rozmiar
 * tury ani linii nie zatrzymuje offsetu i nic z tury nie przepada.
 * `limit`: koniec czytanego zakresu (granica linii); plik dalej traktujemy, jakby się tam kończył.
 */
export function readTurns(
  path: string,
  sessionId: string,
  offset: number,
  opts: { window: number; maxWindow: number; final: boolean | "complete"; limit?: number },
): TurnBatch {
  const readWith = (tr: Translator | undefined) => (from: number, max: number) => {
    const r = readLinesFrom(path, from, opts.limit === undefined ? max : Math.max(0, Math.min(max, opts.limit - from)), tr);
    return opts.limit === undefined ? r : { ...r, size: Math.min(r.size, opts.limit) };
  };
  // tłumacz formatu JSON (Gemini CLI: stan wersji wiadomości) wspólny dla przylegających odczytów tego wywołania:
  // tura czytana kawałkami (większe okno, partie readLongTurn) nie powtarza tekstu ani narzędzi. Tekstowy (.txt
  // Cursora) składa bloki od granicy odczytu, więc każdy odczyt ma nowy; ogon pliku (longTurnCanEnd) też
  const first = translatorFor(path);
  const read = readWith(first && !first.text ? first : undefined);
  let win = Math.max(1, Math.min(opts.window, opts.maxWindow));
  let { lines, end, size } = read(offset, win);
  // czy ten odczyt może zamknąć turę w toku (ogon pliku liczony raz na wywołanie, zob. longTurnCanEnd)
  let canEnd: boolean | undefined;
  const turnCanEnd = () => (canEnd ??= longTurnCanEnd(path, end, size, opts, readWith(undefined)));
  for (;;) {
    const final = end >= size && (opts.final === true || (opts.final === "complete" && lastTurnComplete(lines)));
    const { turns, consumedTo } = groupTurns(lines, sessionId, { final });
    // tura w toku zaczyna się przed końcem ostatniej linii; bez niej konsumujemy wszystko (także uszkodzone linie)
    const pending = lines.length > 0 && consumedTo < lines[lines.length - 1].end;
    const next = Math.max(offset, pending ? consumedTo : end);
    // okno rośnie, gdy nic się nie domknęło: stoimy w miejscu albo przeszliśmy tylko metadane przed turą w toku
    const stuck = next === offset || (pending && !turns.length);
    if (!stuck || offset + win >= size || (win >= opts.maxWindow && next > offset))
      return { lines, turns, offset: next, end, size, batched: false, skipped: null };
    if (win >= opts.maxWindow) break;
    // tury w toku, której ten odczyt i tak nie zamknie, nie czytamy dalej: większe okno parsowałoby ją na próżno
    if (pending && !turnCanEnd()) return { lines, turns, offset: next, end, size, batched: false, skipped: null };
    win = Math.min(win * 2, opts.maxWindow);
    const more = read(end, offset + win - end);
    lines = lines.concat(more.lines);
    end = more.end;
    size = more.size;
  }
  // limit okna: tura zaczyna się w `offset` i jest dłuższa od niego. Jej linie idą od razu do składania, a okno
  // zwalniamy, zanim przyjdą kolejne partie
  if (lines.length) {
    // tury w toku, której ten odczyt i tak nie zamknie, nie czytamy całej od nowa: czeka na swój koniec
    if (!turnCanEnd()) return { lines: [], turns: [], offset, end, size, batched: false, skipped: null };
    const long = startLongTurn(sessionId, lines);
    lines = [];
    return readLongTurn(path, offset, end, long, read, opts);
  }
  // pojedyncza linia dłuższa od limitu: przeskakujemy ją; bez \n do końca pliku jeszcze się pisze
  const to = lineEndAfter(path, offset + win);
  if (to < 0) return { lines, turns: [], offset, end, size, batched: false, skipped: null };
  return { lines, turns: [], offset: to, end: to, size, batched: false, skipped: { from: offset, to } };
}

/**
 * Czy czytanie tury dłuższej niż okno może ją zamknąć. Przy `final` = true zawsze (koniec pliku ją zamknie). Inaczej
 * (PreCompact, aktywna sesja w backfillu, nadrabianie bez końca tury) zamyka ją tylko następny prompt albo, przy
 * "complete", koniec tury widoczny w transkrypcie, więc patrzymy najpierw na ogon pliku (ostatnie do 8 MB od granicy
 * linii). Prompt wcześniej w pliku tylko opóźnia zapis do najbliższego Stop (final = true); nic nie przepada.
 */
function longTurnCanEnd(
  path: string,
  from: number,
  size: number,
  opts: { maxWindow: number; final: boolean | "complete" },
  read: (from: number, max: number) => { lines: Line[]; end: number; size: number },
): boolean {
  if (opts.final === true) return true;
  const tailFrom = Math.max(from, size - Math.min(opts.maxWindow, 8 * 1024 * 1024));
  const start = tailFrom === from ? from : lineEndAfter(path, tailFrom - 1);
  if (start < 0 || start >= size) return false;
  const tail = read(start, size - start).lines;
  return tail.some((l) => promptOf(l.json) !== null) || (opts.final === "complete" && lastTurnComplete(tail));
}

/** Stan tury dłuższej niż okno: składanie, podsumowania kompakcji z jej zakresu i ostatnia wiadomość głównego wątku. */
interface LongTurn {
  g: ReturnType<typeof turnGrouper>;
  turn: Turn | null;
  compacts: Line[];
  lastMessage: Line | null;
}

function startLongTurn(sessionId: string, lines: Line[]): LongTurn {
  const s: LongTurn = { g: turnGrouper(sessionId), turn: null, compacts: [], lastMessage: null };
  for (const l of lines) trackLongTurn(s, l);
  s.turn = s.g.current();
  return s;
}

/** Linia tury dłuższej niż okno: do składania, a podsumowanie kompakcji i wiadomość głównego wątku też na bok. */
function trackLongTurn(s: LongTurn, l: Line): void {
  s.g.feed(l);
  const j = l.json;
  if (j?.isSidechain || (j?.type !== "user" && j?.type !== "assistant")) return;
  if (j.isCompactSummary) s.compacts.push(l);
  else s.lastMessage = l;
}

/**
 * Reszta tury dłuższej niż okno: kolejne partie do `maxWindow` dokładane linia po linii, bez trzymania przeczytanych
 * już linii, aż do następnego promptu (wtedy offset na jego początku) albo końca pliku. W pamięci zostaje sama tura
 * (wyniki narzędzi przycięte) i jej podsumowania kompakcji. Koniec pliku bez końca tury: tura czeka jak każda inna
 * (offset na jej początku), chyba że wolno ją zamknąć (`final` jak w readTurns).
 */
function readLongTurn(
  path: string,
  offset: number,
  from: number,
  s: LongTurn,
  read: (from: number, max: number) => { lines: Line[]; end: number; size: number },
  opts: { maxWindow: number; final: boolean | "complete" },
): TurnBatch {
  let pos = from;
  let size = 0;
  let next = -1;
  let skipped: { from: number; to: number } | null = null;
  let whole = true;
  while (next < 0) {
    const more = read(pos, opts.maxWindow);
    size = more.size;
    if (!more.lines.length) {
      // same uszkodzone linie: idziemy dalej
      if (more.end > pos) {
        pos = more.end;
        continue;
      }
      // koniec pliku albo ostatnia linia jeszcze się pisze
      if (pos + opts.maxWindow >= size) {
        whole = pos >= size;
        break;
      }
      // linia dłuższa od limitu w środku tury: pomijamy ją jak w readTurns
      const to = lineEndAfter(path, pos + opts.maxWindow);
      if (to < 0 || to > size) {
        whole = false;
        break;
      }
      skipped ??= { from: pos, to };
      pos = to;
      continue;
    }
    for (const l of more.lines) {
      trackLongTurn(s, l);
      // następny prompt zamknął długą turę: dalej czyta zwykłe okno od jego początku
      if (s.g.current() !== s.turn) {
        next = l.start;
        break;
      }
    }
    if (next < 0) pos = more.end;
  }
  const compacts = s.compacts.filter((l) => next < 0 || l.end <= next);
  if (next >= 0) return { lines: compacts, turns: s.g.turns, offset: next, end: next, size, batched: true, skipped };
  const final =
    whole && (opts.final === true || (opts.final === "complete" && !!s.lastMessage && lastTurnComplete([s.lastMessage])));
  if (!final) return { lines: [], turns: [], offset, end: pos, size, batched: true, skipped: null };
  s.g.close();
  return { lines: compacts, turns: s.g.turns, offset: pos, end: pos, size, batched: true, skipped };
}

/**
 * Offset policzony w innej kopii transkryptu przeniesiony na granicę linii tego pliku. Sesja wznowiona w innym
 * katalogu dostaje nowy plik z tą samą historią, ale ostatnia linia starej kopii bywa w nowej inna, więc offset
 * starej kopii trafia w środek linii. Granica linii i koniec pliku zostają. Ze środka linii idziemy na początek
 * następnej (zwykle to nowa wersja linii metadanych, przeczytanej już w starej kopii), ale prompt czytamy od jego
 * początku: to już nowa praca, a jego pominięcie zgubiłoby prompt i przesunęło numerację o 1.
 * null: plik jest jeszcze krótszy niż offset albo linia z offsetem jeszcze się pisze (bez \n); rozstrzygnie następny
 * odczyt.
 */
export function alignToLine(path: string, offset: number): number | null {
  if (offset <= 0) return offset;
  // dłuższej linii (wklejony obraz) nie parsujemy, tylko ją przeskakujemy
  const MAX_LINE = 16 * 1024 * 1024;
  let start = -1;
  const fd = openSync(path, "r");
  try {
    if (offset > fstatSync(fd).size) return null;
    const buf = Buffer.allocUnsafe(64 * 1024);
    // początek linii z offsetem: najbliższe \n przed nim
    for (let pos = offset; pos > 0 && offset - pos < MAX_LINE; ) {
      const at = Math.max(0, pos - buf.length);
      const n = readSync(fd, buf, 0, pos - at, at);
      const i = buf.subarray(0, n).lastIndexOf(0x0a);
      if (i >= 0) {
        start = at + i + 1;
        break;
      }
      pos = at;
      if (pos === 0) start = 0;
    }
  } finally {
    closeSync(fd);
  }
  if (start === offset) return offset;
  const end = lineEndAfter(path, offset);
  if (end < 0) return null;
  if (start < 0 || end - start > MAX_LINE) return end;
  const line = readLinesFrom(path, start, end - start).lines[0];
  return line && promptOf(line.json) ? start : end;
}

/**
 * Kotwica offsetu: ostatnia przeczytana linia z uuid przed nim (początek, długość, uuid, typ) i offset, dla którego
 * ją policzono. Za nią do offsetu są już tylko linie metadanych bez uuid (`last-prompt`, `queue-operation`).
 * Sesja wznowiona w innym katalogu ma w nowym pliku tę samą historię bajt w bajt co najmniej do tej linii, a dalsze
 * metadane bywają w nowym pliku inne (np. krótsza linia `last-prompt`). Odpowiednik zaczyna się więc w tym samym
 * miejscu i ma ten sam uuid, a czytać trzeba od jego końca: metadane nowej kopii czytamy jeszcze raz (nic z nich nie
 * powstaje), a pierwsza nowa wiadomość nie przepada, niezależnie od tego, o ile metadane się różnią. Linia bez uuid
 * nie bywa kotwicą: dopasowanie po samym typie przyjęłoby cudzą linię metadanych w tym samym miejscu.
 */
export interface LineAnchor {
  at: number;
  len: number;
  uuid: string;
  type: string | null;
  /** Offset, dla którego liczono kotwicę: naprawa zmienia offset bez kotwicy, wtedy kotwica nie obowiązuje. */
  off: number;
}

/** Kotwicy szukamy najwyżej 1 MB i 64 linie wstecz: dłuższe linie trzeba by czytać przy każdym zapisie offsetu. */
const ANCHOR_MAX_BACK = 1024 * 1024;
const ANCHOR_MAX_LINES = 64;

/** Typ i uuid linii JSON albo null (uszkodzona). */
function lineIdentity(text: string): { type: string | null; uuid: string | null } | null {
  try {
    const j = JSON.parse(text);
    return {
      type: typeof j?.type === "string" ? j.type : null,
      uuid: typeof j?.uuid === "string" ? j.uuid : null,
    };
  } catch {
    return null;
  }
}

/** Kotwica offsetu (zob. LineAnchor). null: brak (obcy format, offset poza granicą linii, linia z uuid dalej niż limit). */
export function anchorBefore(path: string, offset: number): LineAnchor | null {
  if (offset <= 0 || isForeignTranscript(path)) return null;
  const fd = openSync(path, "r");
  try {
    if (offset > fstatSync(fd).size) return null;
    const from = Math.max(0, offset - ANCHOR_MAX_BACK);
    const buf = Buffer.allocUnsafe(offset - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    if (n !== buf.length || buf[n - 1] !== 0x0a) return null;
    // linie od końca: [start, end) w buforze, end wskazuje za końcowe \n
    let end = n;
    for (let i = 0; i < ANCHOR_MAX_LINES && end > 0; i++) {
      const nl = end >= 2 ? buf.lastIndexOf(0x0a, end - 2) : -1;
      if (nl < 0 && from > 0) return null; // początek linii poza limitem
      const start = nl + 1;
      const text = buf.toString("utf8", start, end);
      if (!text.trim()) {
        end = start;
        continue;
      }
      const id = lineIdentity(text);
      if (!id) return null;
      if (id.uuid) return { at: from + start, len: end - start, uuid: id.uuid, type: id.type, off: offset };
      end = start;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Offset w pliku `path` za odpowiednikiem linii-kotwicy: linia zaczyna się w `at` (granica linii) i ma ten sam uuid
 * i typ. null: brak odpowiednika (historia w nowym pliku nie jest wierną kopią).
 */
export function offsetAfterAnchor(path: string, a: LineAnchor): number | null {
  if (!a.uuid) return null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (a.at >= size) return null;
    if (a.at > 0) {
      const prev = Buffer.allocUnsafe(1);
      if (readSync(fd, prev, 0, 1, a.at - 1) !== 1 || prev[0] !== 0x0a) return null;
    }
    const end = lineEndAfter(path, a.at);
    if (end < 0 || end - a.at > ANCHOR_MAX_BACK) return null;
    const buf = Buffer.allocUnsafe(end - a.at);
    const n = readSync(fd, buf, 0, buf.length, a.at);
    const id = lineIdentity(buf.toString("utf8", 0, n));
    return id && id.uuid === a.uuid && id.type === a.type ? end : null;
  } finally {
    closeSync(fd);
  }
}

export interface CompactSummary {
  text: string;
  at: number;
  /** Offset linii w transkrypcie (klucz idempotencji). */
  start: number;
}

/** Podsumowania kompakcji (`isCompactSummary`): ustrukturyzowane streszczenie pisane przez Claude, za darmo. */
export function compactSummaries(lines: Line[]): CompactSummary[] {
  const out: CompactSummary[] = [];
  for (const { json: j, start } of lines) {
    if (j?.type !== "user" || !j.isCompactSummary || j.isSidechain) continue;
    const text = blocksText(j.message?.content).trim();
    if (text.length > 200) out.push({ text, at: ts(j.timestamp), start });
  }
  return out;
}

/** Metadane sesji z pierwszych linii (cwd, branch, czas startu, tytuł). */
export function sessionMeta(lines: Line[]): {
  cwd: string | null;
  gitBranch: string | null;
  startedAt: number;
  title: string | null;
} {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let startedAt = 0;
  let title: string | null = null;
  for (const { json: j } of lines) {
    if (!cwd && j.cwd) cwd = j.cwd;
    if (!gitBranch && j.gitBranch) gitBranch = j.gitBranch;
    if (!startedAt && j.timestamp) startedAt = ts(j.timestamp);
    if (j.type === "custom-title" && j.customTitle) title = j.customTitle;
    if (cwd && gitBranch && startedAt && title) break;
  }
  return { cwd, gitBranch, startedAt, title };
}
