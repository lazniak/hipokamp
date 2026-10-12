// Deterministyczny „obserwator”: tura transkryptu → obserwacja. Zero wywołań LLM.
// Źródłem streszczenia jest to, co Claude sam napisał użytkownikowi na końcu tury
// (zwykle zwięzłe podsumowanie), plus fakty wyciągnięte z wywołań narzędzi.
import type { EntityRef, NewObservation } from "../types.ts";
import { basenameOf, fileKey } from "../util/paths.ts";
import { bulletLines, codeIdentifiers, headline, keywords, oneLine, stripMarkdown, truncate } from "../util/text.ts";
import { isPrivateTool as isPrivate } from "./private-tools.ts";
import { clean } from "./redact.ts";
import type { ToolCall, Turn } from "./transcript.ts";

export interface DigestOptions {
  project: string;
  n: number;
  privateTools: string[];
  maxNarrativeChars: number;
}

export interface Digest {
  skip: boolean;
  reason?: string;
  prompt: string;
  obs: NewObservation;
  entities: EntityRef[];
  /** Pliki zmodyfikowane (ścieżki absolutne) — do odcisków stanu plików. */
  modifiedAbs: string[];
  /** Id obserwacji cytowane przez asystenta (#123) — sygnał użycia pamięci. */
  cited: number[];
}

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);

const RE_DECISION =
  /\b(decyzj[aęi]|zdecydowa\w*|wybieram|wybrał\w*|wybrano|postanowi\w*|decided|decision|we'll go with|going with|chose|chosen)\b/i;
// tylko jawne prośby o zapamiętanie (zawsze/nigdy/never to zwykłe słowa w briefach — fałszywe alarmy)
const RE_REMEMBER =
  /\b(zapamiętaj|zapamietaj|pamiętaj|pamietaj|zapisz sobie|na przyszłość|na przyszlosc|od teraz|od dziś|od dzis|remember (this|that)|from now on|note that|keep in mind)\b/i;
const RE_TEMP_PATH = /[\\/](AppData[\\/]Local[\\/]Temp|tmp|temp)[\\/]|scratchpad|[\\/]\.claude[\\/]projects[\\/]/i;
const RE_STATUS_PREFIX = /^(READY|GOTOWE|GOTOWY|GOTOWA|DONE|OK|Zrobione|Gotowe|Fixed|Naprawione|Zrobiłem|Status)\b\s*[—–:-]?\s*/i;
const GENERIC_WORDS = new Set(
  "ready gotowe gotowy zakres dostarczony dostarczone zweryfikowany zweryfikowane wszystkie kontrole zakończone zakonczone done complete completed verified pass passed exit własny wlasny pełni pelni wykorzystany sukces success finished skończone skonczone".split(
    " ",
  ),
);
const RE_CORRECTION =
  /(^|\s)(nie tak|źle|zle|to nieprawda|nieprawda|nie rób|nie rob|przestań|przestan|zamiast tego|wrong|incorrect|that's not|thats not|don't do|do not do|nope)\b/i;
const RE_FIX =
  /\b(napraw\w*|fix\w*|bug\w*|błąd|błędy|bledy|blad|popraw\w*|crash\w*|nie działa|nie dziala|broken|regres\w*|hotfix)\b/i;
const RE_REFACTOR =
  /\b(refaktor\w*|refactor\w*|rename\w*|uporządk\w*|uporzadk\w*|przenie\w*|cleanup|clean up|wydziel\w*|extract\w*|simplif\w*|uprość|uprosc)\b/i;
const RE_FEATURE =
  /\b(dodaj\w*|add\w*|implement\w*|zbuduj\w*|stwórz|stworz|utwórz|utworz|nowy|nowa|nowe|feature|funkcj\w*|create\w*|build\w*|napisz)\b/i;
const RE_ERRLINE =
  /(error|exception|traceback|failed|failure|fail:|cannot|could not|couldn't|not found|denied|refused|ENOENT|EADDRINUSE|EACCES|TS\d{4}|błąd|blad|nie można|nie mozna|nie udało|nie udalo|panic|fatal)/i;

function firstErrorLine(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Exit code -?\d+$/i.test(l) && !/^<\/?(tool_use_error|error)>$/.test(l));
  // Python: sens jest w ostatniej linii tracebacku
  if (s.includes("Traceback (most recent call last)")) {
    const exc = [...lines].reverse().find((l) => /^[\w.]+(Error|Exception|Exit)\b/.test(l));
    if (exc) return truncate(oneLine(exc), 170);
  }
  for (const l of lines) if (l.length > 4 && RE_ERRLINE.test(l)) return truncate(oneLine(l), 170);
  return truncate(oneLine(lines[0] ?? ""), 170);
}

function commandHead(cmd: string): string {
  const first = cmd.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? cmd;
  return truncate(oneLine(first), 160);
}

/** Rdzeń komendy do porównań „czy później się udało” (np. „bun test”, „git push”). */
function commandStem(cmd: string): string {
  const w = oneLine(cmd)
    .replace(/^(cd\s+\S+\s*(&&|;)\s*)+/i, "")
    .replace(/^Set-Location\s+\S+\s*;\s*/i, "")
    .split(/\s+/)
    .filter((x) => !x.startsWith("-"));
  return w.slice(0, 2).join(" ").toLowerCase();
}

/**
 * Nakładka na gita z własnym poleceniem (`xgit save`, `mygit push`): tylko na początku polecenia albo po `;`, `&`, `|`
 * czy nowej linii, żeby `echo legit commit` albo `digit save` w środku tekstu nie trafiały.
 */
const RE_GIT_WRAPPER = /(?:^|[;&|\n])\s*[a-z]+git\s+(?:save|commit|push|merge|pr)\b/i;

function commitMessage(cmd: string): string | null {
  // git i nakładki na gita z własnym poleceniem zapisu (np. `xgit save -m "…"`), nakładka tylko na początku polecenia
  if (!/\bgit\s+commit\b/.test(cmd) && !RE_GIT_WRAPPER.test(cmd)) return null;
  const here = cmd.match(/<<'?"?EOF'?"?\s*\n([\s\S]*?)\n\s*EOF/);
  if (here) return oneLine(here[1].split("\n").find((l) => l.trim()) ?? "");
  const m = cmd.match(/-m\s+(?:"([^"]+)"|'([^']+)')/);
  return m ? oneLine(m[1] ?? m[2]) : null;
}

function testSummary(text: string): string | null {
  const pass = [...text.matchAll(/(\d+)\s+(pass(?:ed|ing)?)\b/gi)].pop();
  const fail = [...text.matchAll(/(\d+)\s+(fail(?:ed|ing|ures?)?)\b/gi)].pop();
  if (!pass && !fail) return null;
  return [pass ? `${pass[1]} pass` : null, fail ? `${fail[1]} fail` : null].filter(Boolean).join(", ");
}

function toolLabel(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return `mcp:${parts[1]?.replace(/^plugin_/, "") ?? "?"}`;
  }
  return name;
}

interface ToolFacts {
  read: string[];
  modified: string[];
  created: string[];
  searched: string[];
  commands: { cmd: string; ok: boolean; stem: string }[];
  errors: { text: string; stem: string; resolved: boolean }[];
  commits: string[];
  tests: string | null;
  agents: string[];
  skills: string[];
  tools: string[];
  urls: string[];
  decisions: string[];
  plans: string[];
}

function analyzeTools(tools: ToolCall[], priv: string[]): ToolFacts {
  const f: ToolFacts = {
    read: [],
    modified: [],
    created: [],
    searched: [],
    commands: [],
    errors: [],
    commits: [],
    tests: null,
    agents: [],
    skills: [],
    tools: [],
    urls: [],
    decisions: [],
    plans: [],
  };
  for (const t of tools) {
    const name = t.name;
    if (isPrivate(name, priv)) {
      f.tools.push(toolLabel(name));
      continue;
    }
    const inp = t.input ?? {};
    let fp: string | undefined = inp.file_path ?? inp.notebook_path ?? t.structured?.filePath;
    if (fp && RE_TEMP_PATH.test(fp)) fp = undefined; // pliki tymczasowe to szum
    if (READ_TOOLS.has(name) && fp) f.read.push(fp);
    else if (WRITE_TOOLS.has(name) && fp) {
      if (!t.isError) {
        f.modified.push(fp);
        if (name === "Write" && t.structured?.type === "create") f.created.push(fp);
      }
    } else if (SEARCH_TOOLS.has(name)) {
      const what = [inp.pattern, inp.path ? basenameOf(String(inp.path)) : null].filter(Boolean).join(" w ");
      if (what) f.searched.push(truncate(String(what), 80));
    } else if (SHELL_TOOLS.has(name) && typeof inp.command === "string") {
      const cmd = clean(inp.command);
      const stem = commandStem(cmd);
      f.commands.push({ cmd: commandHead(cmd), ok: !t.isError, stem });
      const msg = commitMessage(cmd);
      if (msg && !t.isError) f.commits.push(truncate(clean(msg), 140));
      const out = `${t.result}\n${t.structured?.stdout ?? ""}`;
      const ts = /\b(test|vitest|jest|pytest|spec)\b/i.test(cmd) ? testSummary(out) : null;
      if (ts) f.tests = `${commandHead(cmd).slice(0, 60)} → ${ts}`;
      if (t.isError) f.errors.push({ text: clean(firstErrorLine(t.result)), stem, resolved: false });
    } else if (name === "Agent" || name === "Task") {
      const desc = inp.description ?? inp.subagent_type ?? "agent";
      f.agents.push(truncate(clean(String(desc)), 90));
    } else if (name === "Skill" && inp.skill) {
      f.skills.push(String(inp.skill));
    } else if (name === "WebFetch" && inp.url) {
      f.urls.push(String(inp.url));
    } else if (name === "WebSearch" && inp.query) {
      f.searched.push(truncate(clean(String(inp.query)), 80));
    } else if (name === "AskUserQuestion") {
      const qs: any[] = Array.isArray(inp.questions) ? inp.questions : [];
      const answers = t.structured?.answers ?? null;
      const resText = t.result ?? "";
      for (const q of qs.slice(0, 3)) {
        const qt = String(q.question ?? q.header ?? "").trim();
        let a = "";
        if (answers && typeof answers === "object") a = String((answers as any)[qt] ?? "");
        if (!a) {
          const m = resText.match(
            new RegExp(`${qt.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*?[=:]\\s*"?([^"\\n]+)`),
          );
          a = m?.[1] ?? "";
        }
        if (qt) f.decisions.push(truncate(clean(`${qt} → ${a || "(odpowiedź w transkrypcie)"}`), 200));
      }
    } else if (name === "ExitPlanMode" && inp.plan) {
      f.plans.push(truncate(clean(headline(String(inp.plan), 160) || String(inp.plan)), 200));
    } else if (t.isError && !name.startsWith("mcp__")) {
      f.errors.push({ text: clean(firstErrorLine(t.result)), stem: name.toLowerCase(), resolved: false });
    }
    if (name.startsWith("mcp__") || name === "Skill" || name === "Agent") f.tools.push(toolLabel(name));
  }
  // błąd uznajemy za naprawiony, gdy później ta sama komenda (rdzeń) przeszła bez błędu
  for (const e of f.errors) {
    const idx = f.commands.findIndex((c) => c.stem === e.stem && !c.ok);
    const later = f.commands.slice(idx + 1);
    e.resolved = later.some((c) => c.stem === e.stem && c.ok);
  }
  return f;
}

/** Pierwszy nagłówek markdown (# …) — w briefach to zwykle najlepszy tytuł. */
function firstHeading(s: string): string {
  const m = s.match(/^\s{0,3}#{1,4}\s+(.+)$/m);
  return m ? truncate(oneLine(stripMarkdown(m[1])), 110) : "";
}

/** Ile treści niesie tytuł: słowa merytoryczne, identyfikatory, nazwy plików; kara za ogólniki statusu. */
function informativeness(t: string, files: string[]): number {
  const words = normWords(t);
  const content = words.filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  let s = Math.min(8, content.length);
  if (/[A-Za-z]+[A-Z_][A-Za-z0-9]+|\w+\.\w{1,5}\b/.test(t)) s += 1.5;
  if (files.some((f) => t.includes(basenameOf(f)))) s += 1;
  if (t.length < 18) s -= 2;
  if (t.length > 105) s -= 1;
  return s;
}

function normWords(t: string): string[] {
  return t
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function pickTitle(finalText: string, prompt: string, files: string[]): string {
  const cands: { t: string; w: number }[] = [];
  const add = (t: string, w: number) => {
    const x = t
      .replace(RE_STATUS_PREFIX, "")
      .replace(/^[—–:\-\s]+/, "")
      .trim();
    if (x.length >= 8) cands.push({ t: truncate(x, 100), w });
  };
  add(firstHeading(finalText), 1.1);
  add(headline(finalText, 110), 1.0);
  // drugie zdanie odpowiedzi bywa konkretniejsze niż pierwsze („Gotowe. Dodałem X do Y.”)
  const s2 = headline(
    finalText
      .split(/(?<=[.!?])\s+/)
      .slice(1)
      .join(" "),
    110,
  );
  if (s2) add(s2, 0.9);
  add(firstHeading(prompt), 0.95);
  add(headline(prompt, 110), 0.8);
  if (!cands.length) return "";
  cands.sort((a, b) => b.w * informativeness(b.t, files) - a.w * informativeness(a.t, files));
  return cands[0].t;
}

function classify(turn: Turn, tf: ToolFacts, finalText: string): { type: string; correction: boolean; remember: boolean } {
  const prompt = turn.prompt;
  const correction = turn.kind === "human" && prompt.length < 1500 && RE_CORRECTION.test(prompt.slice(0, 300));
  const remember = turn.kind === "human" && prompt.length < 900 && RE_REMEMBER.test(prompt);
  if (
    tf.decisions.length ||
    tf.plans.length ||
    (RE_DECISION.test(finalText) && RE_DECISION.test(prompt + finalText.slice(0, 400)))
  ) {
    return { type: "decision", correction, remember };
  }
  if (tf.modified.length) {
    const hadError = tf.errors.length > 0;
    if ((hadError && tf.errors.some((e) => e.resolved)) || RE_FIX.test(prompt)) return { type: "bugfix", correction, remember };
    if (RE_REFACTOR.test(prompt)) return { type: "refactor", correction, remember };
    if (tf.created.length || RE_FEATURE.test(prompt)) return { type: "feature", correction, remember };
    return { type: "change", correction, remember };
  }
  if (remember && !tf.modified.length) return { type: "preference", correction, remember };
  if (correction) return { type: "gotcha", correction, remember };
  return { type: "discovery", correction, remember };
}

const TYPE_BASE: Record<string, number> = {
  decision: 0.62,
  preference: 0.7,
  gotcha: 0.55,
  bugfix: 0.5,
  feature: 0.48,
  refactor: 0.4,
  change: 0.36,
  discovery: 0.28,
};

/** Pojęcia w stylu claude-mem (typy wiedzy), mapowane z typu tury. */
const TYPE_CONCEPT: Record<string, string> = {
  bugfix: "problem-solution",
  decision: "trade-off",
  feature: "what-changed",
  refactor: "what-changed",
  change: "what-changed",
  discovery: "how-it-works",
  gotcha: "gotcha",
  preference: "pattern",
};

/** Odpowiedź, która jest tylko komunikatem błędu API albo limitu, a nie treścią pracy. */
const RE_API_ERROR =
  /^(API Error\b|This is a server-side issue|Request timed out|Claude AI usage limit reached|Credit balance is too low|Prompt is too long|5-hour limit reached|You've hit your (usage )?limit|You're out of (usage )?credits|You are out of (usage )?credits)/i;

/** Powiadomienie o zadaniu w tle albo zdarzeniu Monitora: treść <summary> zamiast surowego XML-a z identyfikatorami. */
export function notificationText(prompt: string): string {
  const s = prompt.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
  return oneLine(
    (s ?? prompt.replace(/<(task-id|tool-use-id|output-file|status)>[\s\S]*?<\/\1>/g, " ")).replace(/<[^>]+>/g, " "),
  );
}

/** Narzędzie MCP, które coś zapisuje albo wysyła (po nazwie, np. send_message, create_event). */
const RE_WRITE_MCP =
  /(^|_)(send|create|update|delete|post|reply|publish|upload|write|set|add|remove|edit|move|rename|submit|share|trash|run|generate|execute)(_|$)/i;
const writesOut = (name: string) => name.startsWith("mcp__") && RE_WRITE_MCP.test(name.slice(name.lastIndexOf("__") + 2));
/** Komenda powłoki, która zmienia stan (commit, scalenie, wdrożenie, publikacja, instalacja, kopiowanie, usuwanie). */
const RE_EFFECT_CMD =
  /\b(git\s+(commit|merge|push|tag|rebase|cherry-pick|revert|reset)|gh\s+(pr|release)|deploy|publish|release|eas\s+(build|submit|update)|docker|kubectl|scp|rsync|ssh|systemctl|install|cp|mv|rm|mkdir|Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Out-File|taskkill|Stop-Process)\b/i;

/** Wyzwalacz ciągu dalszego bez XML-a: cel z /goal, uwaga hooka Stop, wiadomość innej sesji albo treść linii. */
export function continuationText(prompt: string): string {
  const goal =
    prompt.match(/^Goal check-in:\s*«([^»]+)»/)?.[1] ??
    prompt.match(/^A session-scoped Stop hook is now active with condition:\s*"([^"]+)"/)?.[1];
  if (goal) return `cel: ${oneLine(goal)}`;
  return oneLine(
    prompt
      .replace(/^Stop hook feedback:\s*/i, "uwaga hooka Stop: ")
      .replace(/^Another Claude session sent a message:\s*/i, "wiadomość innej sesji: ")
      .replace(/<[^>]+>/g, " "),
  );
}

export function digestTurn(turn: Turn, opt: DigestOptions): Digest {
  const prompt = clean(turn.prompt);
  const texts = turn.texts.map((t) => clean(t)).filter((t) => !RE_API_ERROR.test(t.trim()));
  const finalText = texts.length ? texts[texts.length - 1] : "";
  const allText = texts.join("\n\n");
  const tf = analyzeTools(turn.tools, opt.privateTools);
  const isCont = turn.kind === "continuation";
  // powiadomienie zadania i wyzwalacz ciągu dalszego to nie słowa człowieka: nie są kandydatem na tytuł
  const notice = turn.kind === "task" ? notificationText(prompt) : isCont ? continuationText(prompt) : "";
  // w ciągu dalszym kontekstem jest wyzwalacz (cel z /goal, wiadomość innej sesji), przycięty: pętla powtarza go co obieg
  const ask = isCont ? truncate(notice, 300) : prompt;
  const { type, correction, remember } = classify({ ...turn, prompt: ask }, tf, finalText);

  const base = { skip: false, prompt, modifiedAbs: [...new Set(tf.modified)], cited: citedIds(allText) };

  // tury puste/trywialne: „ok”, „dzięki”, powiadomienia bez pracy; ciąg dalszy liczy się tylko pracą asystenta
  const trivial = turn.tools.length === 0 && finalText.length < 120 && (isCont || prompt.length < 60) && !remember;
  // brak jakiejkolwiek pracy: same błędy API albo przerwanie przed odpowiedzią
  const noWork = turn.tools.length === 0 && !finalText;
  if (trivial || noWork || (turn.kind === "task" && turn.tools.length === 0)) {
    return { ...base, skip: true, reason: "trywialna tura", obs: null as any, entities: [] };
  }
  // ciąg dalszy bez skutku (obieg pętli „bez zmian”, „czekam na…”): nic nie zmienił i odpowiedział krótko.
  // Bez tego każdy obieg pętli to notatka, a identyczne obiegi scalone po hashu dostają ważność za powtórzenia.
  const idle =
    isCont &&
    finalText.length < 250 &&
    !tf.modified.length &&
    !tf.commits.length &&
    !tf.decisions.length &&
    !tf.plans.length &&
    !tf.agents.length &&
    !tf.errors.some((e) => e.resolved) &&
    !tf.commands.some((c) => RE_EFFECT_CMD.test(c.cmd) || RE_GIT_WRAPPER.test(c.cmd)) &&
    !turn.tools.some((t) => writesOut(t.name));
  if (idle) return { ...base, skip: true, reason: "ciąg dalszy bez skutku", obs: null as any, entities: [] };

  // tytuł: najbardziej treściwy kandydat z odpowiedzi i promptu (powiadomienie systemowe nie jest kandydatem)
  let title = pickTitle(finalText, notice ? "" : prompt, tf.modified) || truncate(oneLine(notice || prompt), 100);
  if (!title)
    title = tf.modified.length
      ? `Zmiany w ${tf.modified.map(basenameOf).slice(0, 3).join(", ")}`
      : isCont
        ? "Ciąg dalszy tury"
        : "Tura bez opisu";
  const promptHead = headline(prompt, 160) || truncate(oneLine(prompt), 160);
  const subtitle =
    turn.kind === "command"
      ? `Komenda: ${truncate(oneLine(prompt), 150)}`
      : turn.kind === "task"
        ? `Powiadomienie: ${truncate(notice, 140)}`
        : isCont
          ? `Ciąg dalszy${notice ? `: ${truncate(notice, 140)}` : " tury"}`
          : promptHead;

  // fakty
  const facts: string[] = [];
  // bulletLines i stripMarkdown niżej zdejmują z tekstu już po clean() więcej, niż widzi widok sklejony w clean()
  // (`, **, __, ~~, <private>, znaczniki z wejścia): emoji, link [tekst](adres), kursywę *x*. Sekret rozcięty czymś
  // takim (sk-ant-🔑api03-…) skleja się dopiero teraz, więc clean() jeszcze raz, przed ucięciem
  for (const b of bulletLines(finalText).slice(0, 6)) facts.push(truncate(clean(b), 220));
  for (const c of tf.commits.slice(0, 2)) facts.push(`Commit: ${c}`);
  if (tf.tests) facts.push(`Testy: ${tf.tests}`);
  const errs = dedupeBy(tf.errors, (e) => e.text).slice(0, 2);
  for (const e of errs) facts.push(`Błąd: ${e.text}${e.resolved ? " (naprawiony)" : ""}`);
  for (const d of tf.decisions.slice(0, 3)) facts.push(`Decyzja: ${d}`);
  for (const p of tf.plans.slice(0, 1)) facts.push(`Plan: ${p}`);
  for (const a of tf.agents.slice(0, 2)) facts.push(`Agent: ${a}`);
  for (const c of tf.created.slice(0, 3)) facts.push(`Utworzono: ${fileKey(c, turn.cwd)}`);
  if (remember) facts.unshift(`Do zapamiętania: ${truncate(oneLine(prompt), 220)}`);

  // narracja: prośba + odpowiedź (przycięta), bez markdownu
  const answer = clean(
    stripMarkdown(finalText)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const budget = Math.max(400, opt.maxNarrativeChars - 360);
  let narrative =
    turn.kind === "task"
      ? `Powiadomienie: ${truncate(notice, 340)}`
      : isCont
        ? `Ciąg dalszy${notice ? `: ${truncate(notice, 340)}` : " tury bez nowego promptu"}`
        : `Prośba: ${truncate(oneLine(prompt), 340)}`;
  if (answer) narrative += `\n\n${truncate(answer, budget)}`;
  else if (tf.commands.length)
    narrative += `\n\nKomendy: ${tf.commands
      .slice(-4)
      .map((c) => c.cmd)
      .join(" | ")}`;
  if (turn.interrupted) narrative += "\n\n(przerwane przez użytkownika)";

  // pojęcia: typ wiedzy + narzędzia + słowa kluczowe + identyfikatory z kodu
  const kw = keywords(`${ask}\n${finalText}`, 6);
  const ids = codeIdentifiers(`${ask}\n${allText}`, 3);
  const concepts = dedupeCi([
    TYPE_CONCEPT[type] ?? "how-it-works",
    ...(correction ? ["gotcha"] : []),
    ...tf.skills.map((s) => `skill:${s}`),
    ...tf.tools.filter((t) => t.startsWith("mcp:")),
    ...ids,
    ...kw,
  ]).slice(0, 12);

  let importance = TYPE_BASE[type] ?? 0.3;
  if (correction) importance += 0.12;
  if (remember) importance += 0.2;
  if (tf.errors.some((e) => e.resolved)) importance += 0.08;
  if (tf.commits.length) importance += 0.06;
  importance += Math.min(0.12, 0.04 * Math.log2(1 + tf.modified.length));
  if (turn.tools.length === 0) importance -= 0.05;
  if (turn.interrupted) importance -= 0.08;
  importance = Math.max(0.05, Math.min(1, importance));

  const filesRead = dedupe(tf.read.map((p) => fileKey(p, turn.cwd))).slice(0, 40);
  const filesModified = dedupe(tf.modified.map((p) => fileKey(p, turn.cwd))).slice(0, 40);

  const entities: EntityRef[] = [
    ...filesModified.map((k) => ({ kind: "file" as const, key: k, role: "modified" as const })),
    ...filesRead.filter((k) => !filesModified.includes(k)).map((k) => ({ kind: "file" as const, key: k, role: "read" as const })),
    ...dedupe(filesModified.map(dirKey).filter(Boolean)).map((k) => ({
      kind: "dir" as const,
      key: k,
      role: "mentioned" as const,
    })),
    ...concepts
      .filter((c) => !c.includes(":"))
      .map((c) => ({ kind: "concept" as const, key: c.toLowerCase(), role: "concept" as const })),
    ...dedupe([...tf.tools, ...tf.skills.map((s) => `skill:${s}`)]).map((t) => ({
      kind: "tool" as const,
      key: t,
      role: "mentioned" as const,
    })),
    ...tf.urls.slice(0, 5).map((u) => ({ kind: "url" as const, key: urlKey(u), role: "mentioned" as const })),
  ];

  const obs: NewObservation = {
    session_id: turn.sessionId,
    project: opt.project,
    prompt_n: opt.n,
    type,
    tier: type === "preference" ? "semantic" : "episodic",
    title: clean(title),
    // podtytuł z headline() promptu: też po stripMarkdown (patrz fakty)
    subtitle: clean(subtitle),
    narrative,
    facts: dedupe(facts),
    concepts,
    files_read: filesRead,
    files_modified: filesModified,
    created_at: turn.endedAt || turn.startedAt || Date.now(),
    importance: Math.round(importance * 1000) / 1000,
    source: "digest",
    turn_key: turn.key,
    meta: {
      kind: turn.kind,
      tools: turn.tools.length,
      commands: tf.commands.length,
      errors: tf.errors.length,
      model: turn.model,
      branch: turn.gitBranch,
      durationMs: Math.max(0, turn.endedAt - turn.startedAt),
    },
  };
  return { ...base, obs, entities };
}

function dirKey(fileKeyStr: string): string {
  const i = fileKeyStr.lastIndexOf("/");
  return i > 0 ? fileKeyStr.slice(0, i) : "";
}

function urlKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname}`.replace(/\/+$/, "");
  } catch {
    return u.slice(0, 120);
  }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function dedupeCi(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** „#1234” w odpowiedzi asystenta = użyta pamięć (wzmacnianie). */
export function citedIds(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?:^|[\s([,])#(\d{1,8})\b/g)) out.add(Number(m[1]));
  return [...out].slice(0, 30);
}
