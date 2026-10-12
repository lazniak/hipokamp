// Tury opisane już przez claude-mem: dopasowanie tury do promptu claude-mem po tekście i czasie.
// Sam numer promptu nie wystarcza: claude-mem numeruje też pobudki pętli i wiadomości innych sesji i agentów, a jego
// obserwator na wyczerpanym limicie zostawiał prompt bez notatki. Kryterium jak przy duplikatach w `hipokamp repair`
// (core/repair.ts): ten sam tekst, czasy różne najwyżej o 10 minut, pary najbliższe w czasie, każdy element raz.
// SQL poza repo.ts: dwa odczyty potrzebne tylko tutaj.
import type { Repo } from "../db/repo.ts";
import { normKey } from "../util/text.ts";
import { clean } from "./redact.ts";
import { comparablePrompt, type Turn } from "./transcript.ts";

/** Tura i prompt to ta sama wypowiedź, gdy tekst jest ten sam, a czasy różnią się najwyżej o tyle. */
export const PAIR_TOLERANCE_MS = 10 * 60_000;
/** Porównujemy początek tekstu: claude-mem przycina prompty do 4000 znaków, hipokamp do 8000. */
const KEY_CHARS = 1000;
/** Prompt z samym obrazem: hipokamp zapisuje „[obraz]”, claude-mem „[media prompt]”. */
const IMAGE_ONLY = "\u0000obraz";
/** Znaczniki wklejonej treści z aplikacji desktop (raz są w tekście promptu, raz nie). */
const RE_PASTED = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>/g;

/** Klucz porównania promptów: postać z tury, redakcja, bez znaczników obrazów i wklejeń, znormalizowany początek. */
export function promptKey(s: string | null | undefined): string {
  const text = clean(comparablePrompt(s ?? "")).replace(RE_PASTED, " ");
  const key = normKey(text.replace(/\[obraz\]/g, " ")).slice(0, KEY_CHARS);
  if ((!key && text.includes("[obraz]")) || key === "media prompt") return IMAGE_ONLY;
  // prompt z samych symboli („®”, „-”, „?”): normalizacja zostawia pusty klucz, a pustego klucza parowanie nie bierze,
  // więc taki prompt nigdy nie był „znany” (naprawa dopisywała go przy każdym przebiegu). Wtedy surowy tekst
  if (!key) {
    const raw = text.replace(/\s+/g, " ").trim().slice(0, KEY_CHARS);
    return raw ? `\u0000${raw}` : "";
  }
  return key;
}

/** Paruje elementy po tym samym kluczu tekstu i najbliższym czasie (w tolerancji); każdy element najwyżej raz. */
export function pairByTextAndTime<A, B>(
  left: { item: A; key: string; at: number }[],
  right: { item: B; key: string; at: number }[],
): Map<A, B> {
  const byKey = new Map<string, number[]>();
  right.forEach((r, i) => {
    if (!r.key || !r.at) return;
    const a = byKey.get(r.key);
    if (a) a.push(i);
    else byKey.set(r.key, [i]);
  });
  const cands: { l: number; r: number; d: number }[] = [];
  left.forEach((l, li) => {
    if (!l.key || !l.at) return;
    for (const ri of byKey.get(l.key) ?? []) {
      const d = Math.abs(l.at - right[ri].at);
      if (d <= PAIR_TOLERANCE_MS) cands.push({ l: li, r: ri, d });
    }
  });
  cands.sort((a, b) => a.d - b.d || a.l - b.l || a.r - b.r);
  const usedL = new Set<number>();
  const usedR = new Set<number>();
  const out = new Map<A, B>();
  for (const c of cands) {
    if (usedL.has(c.l) || usedR.has(c.r)) continue;
    usedL.add(c.l);
    usedR.add(c.r);
    out.set(left[c.l].item, right[c.r].item);
  }
  return out;
}

export interface ClaudeMemTurns {
  /** Tury opisane przez claude-mem (bez drugiej notatki). */
  described: Set<string>;
  /** Tury, których prompt jest już w bazie jako prompt claude-mem (bez drugiego wiersza w prompts). */
  paired: Set<string>;
}

/** Notatka claude-mem najpóźniej tyle po końcu tury jeszcze świadczy, że jego obserwator w czasie tury działał. */
export const OBSERVER_SLACK_MS = 30 * 60_000;

/**
 * Tury, które opisał claude-mem. Tura jest opisana, gdy paruje się z promptem claude-mem, a claude-mem ma notatkę dla
 * numeru tego promptu (w dowolnym stanie: scalona przez sen nadal znaczy, że turę opisano). Liczą się też prompty
 * claude-mem bez pary, które przyszły w trakcie tury (wiadomość agenta albo innej sesji doręczona w środku tury,
 * prompt o innym zapisie tekstu): obserwator przypisywał pracę do bieżącego numeru promptu. Tura bez żadnego promptu
 * claude-mem (ciąg dalszy, powiadomienie zadania) dziedziczy stan poprzedniej, ale tylko wtedy, gdy obserwator
 * claude-mem w czasie tury działał: ma w tej sesji notatkę z czasu od startu tury do OBSERVER_SLACK_MS po jej końcu.
 * Inaczej (claude-mem wyłączony, wznowiona stara sesja) nikt tej tury nie opisał. Prompt człowieka i komenda bez pary
 * nie dziedziczą: claude-mem ich nie widział, więc nie opisał. Pierwsza tura okna dziedziczy po ostatnim prompcie
 * sesji sprzed niej (ingest czyta transkrypt oknami). Prompty claude-mem bierzemy z sesji i z sesji zapisanych
 * w liniach tur (kopia historii innej sesji). Tury muszą iść w kolejności z transkryptu.
 */
export function claudeMemDescribed(repo: Repo, sessionId: string, turns: Turn[]): ClaudeMemTurns {
  const out: ClaudeMemTurns = { described: new Set(), paired: new Set() };
  if (!turns.length) return out;
  const sids = [...new Set([sessionId, ...turns.map((t) => t.sessionId)])];
  // szybka ścieżka (hook Stop we wznowionej starej sesji): ostatni prompt i ostatnia notatka claude-mem sprzed tur
  // nie dadzą ani pary (tolerancja czasu), ani promptu w trakcie tury, ani śladu działającego obserwatora
  const first = Math.min(...turns.map((t) => t.startedAt || Number.POSITIVE_INFINITY));
  let lastPrompt = 0;
  let lastNote = 0;
  for (const sid of sids) {
    const r = repo.db
      .query(
        `SELECT (SELECT MAX(created_at) FROM prompts WHERE session_id = ?1 AND source = 'claude-mem') AS p,
           (SELECT MAX(created_at) FROM observations WHERE session_id = ?1 AND source = 'claude-mem') AS o`,
      )
      .get(sid) as { p: number | null; o: number | null };
    lastPrompt = Math.max(lastPrompt, r.p ?? 0);
    lastNote = Math.max(lastNote, r.o ?? 0);
  }
  if (!lastPrompt || (lastPrompt + PAIR_TOLERANCE_MS < first && lastNote < first)) return out;

  type P = { sid: string; n: number; key: string; at: number };
  const prompts: P[] = [];
  const noted = new Set<string>();
  const noteTimes: number[] = [];
  for (const sid of sids) {
    const rows = repo.db
      .query("SELECT n, text, created_at FROM prompts WHERE session_id = ? AND source = 'claude-mem'")
      .all(sid) as { n: number; text: string; created_at: number }[];
    if (!rows.length) continue;
    for (const p of rows) prompts.push({ sid, n: p.n, key: promptKey(p.text), at: p.created_at });
    for (const r of repo.db
      .query("SELECT prompt_n, created_at FROM observations WHERE session_id = ? AND source = 'claude-mem'")
      .all(sid) as { prompt_n: number | null; created_at: number }[]) {
      if (r.prompt_n !== null) noted.add(`${sid}\n${r.prompt_n}`);
      noteTimes.push(r.created_at);
    }
  }
  if (!prompts.length) return out;
  noteTimes.sort((a, b) => a - b);
  /** Obserwator claude-mem działał w czasie tury: jego notatka od startu tury do OBSERVER_SLACK_MS po jej końcu. */
  const observed = (t: Turn): boolean => {
    if (!t.startedAt) return false;
    const to = Math.max(t.endedAt, t.startedAt) + OBSERVER_SLACK_MS;
    let lo = 0;
    let hi = noteTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (noteTimes[mid] < t.startedAt) lo = mid + 1;
      else hi = mid;
    }
    return lo < noteTimes.length && noteTimes[lo] <= to;
  };
  const hasNote = (p: P) => noted.has(`${p.sid}\n${p.n}`);
  const pairs = pairByTextAndTime(
    turns.map((t) => ({ item: t, key: promptKey(t.prompt), at: t.startedAt })),
    prompts.map((p) => ({ item: p, key: p.key, at: p.at })),
  );
  const used = new Set(pairs.values());
  const loose = prompts.filter((p) => !used.has(p) && p.at);

  /** Stan sprzed okna: ostatni prompt sesji przed `at` (claude-mem albo własny sparowany z promptem claude-mem). */
  const before = (at: number): boolean => {
    const prev = repo.db
      .query(
        "SELECT n, text, created_at, source FROM prompts WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId, at) as { n: number; text: string; created_at: number; source: string } | null;
    if (!prev) return false;
    if (prev.source === "claude-mem") return noted.has(`${sessionId}\n${prev.n}`);
    const k = promptKey(prev.text);
    const cm = prompts
      .filter((p) => p.sid === sessionId && p.key === k && Math.abs(p.at - prev.created_at) <= PAIR_TOLERANCE_MS)
      .sort((a, b) => Math.abs(a.at - prev.created_at) - Math.abs(b.at - prev.created_at))[0];
    return !!cm && hasNote(cm);
  };

  let cur: boolean | null = null;
  for (const t of turns) {
    const p = pairs.get(t);
    if (p) out.paired.add(t.key);
    const during = loose.filter((x) => x.at >= t.startedAt && x.at <= Math.max(t.endedAt, t.startedAt));
    if (p || during.length || t.kind === "human" || t.kind === "command") cur = (!!p && hasNote(p)) || during.some(hasNote);
    else cur = (cur ?? (t.startedAt ? before(t.startedAt) : false)) && observed(t);
    if (cur) out.described.add(t.key);
  }
  return out;
}
