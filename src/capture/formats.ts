// Transkrypty innych harnessów czyta ten sam parser co Claude Code: tłumacz zamienia ich linie na linie w kształcie
// Claude Code (Codex: rollouty, Gemini CLI: sesje JSONL i starsze JSON, Cursor: transkrypty agenta .jsonl i .txt).
// Sesje Claude Desktop (Cowork) i OpenCode (plugin hipokampa) są już w kształcie Claude Code i tłumacza nie potrzebują.
import { codexState, fromCodex, isCodexSubagent, isCodexTranscript } from "./codex.ts";
import { cursorTranslator, isCursorTranscript } from "./cursor.ts";
import { fromGemini, geminiJsonTranslator, geminiMeta, geminiState, isGeminiJson, isGeminiTranscript } from "./gemini.ts";
import type { Line } from "./transcript.ts";

/**
 * Tłumacz jednego odczytu pliku. `skipUntil`: linie kończące się do tego bajtu pomijamy (historia zaimportowana).
 * Format JSON: `json` dostaje sparsowaną linię. Format tekstowy: `text` dostaje surową linię z zakresem bajtów
 * i składa bloki, `flush` domyka blok przy końcu pliku (także linię bez \n na końcu), a `pendingFrom` mówi, gdzie
 * zaczyna się blok niedomknięty (odczyt nie przesuwa offsetu za jego początek).
 */
export interface Translator {
  skipUntil: number;
  json?: (j: any) => any[];
  text?: (raw: string, start: number, end: number) => Line[];
  flush?: () => Line[];
  pendingFrom?: () => number | null;
}

export function translatorFor(path: string): Translator | null {
  if (isCodexTranscript(path)) {
    const st = codexState(path);
    return { skipUntil: st.importEnd, json: (j) => fromCodex(j, st) };
  }
  if (isGeminiTranscript(path)) {
    if (isGeminiJson(path)) return geminiJsonTranslator(path);
    const st = geminiState(path);
    return { skipUntil: 0, json: (j) => fromGemini(j, st) };
  }
  if (isCursorTranscript(path)) return cursorTranslator(path);
  return null;
}

/** Plik w obcym formacie (tłumaczony): bez kotwic linii (uuid) z formatu Claude Code. */
export function isForeignTranscript(path: string): boolean {
  return isCodexTranscript(path) || isGeminiTranscript(path) || isCursorTranscript(path);
}

/** Wątek podagenta (Codex: strażnik zgód, thread_spawn; Gemini CLI: kind subagent): jego praca jest w wątku głównym. */
export function isSubagentTranscript(path: string): boolean {
  if (isCodexTranscript(path)) return isCodexSubagent(path);
  if (isGeminiTranscript(path)) return geminiMeta(path).subagent;
  return false;
}
