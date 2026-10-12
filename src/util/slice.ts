// Długa praca w tle pocięta na kawałki: worker ma jeden wątek JS, a hook czeka na odpowiedź najwyżej 1,8 s.
import { AsyncLocalStorage } from "node:async_hooks";

/** Zadanie pocięte na kawałki (ustawia je `track(..., { sliced: true })` w workerze) i początek bieżącego kawałka. */
interface SliceScope {
  name: string;
  since: number;
}

const scope = new AsyncLocalStorage<SliceScope>();
let sink: ((name: string, t0: number, t1: number) => void) | null = null;

/** Odbiorca kawałków synchronicznych (diagnostyka przestojów: winny jest kawałek, nie całe wielominutowe zadanie). */
export function setSliceSink(fn: ((name: string, t0: number, t1: number) => void) | null): void {
  sink = fn;
}

/** Uruchamia `fn` jako zadanie pocięte: przerwy (`breathe`, `slicer`) zgłaszają odbiorcy kolejne kawałki. */
export function runSliced<T>(name: string, fn: () => T): { result: T; close: () => void } {
  const s: SliceScope = { name, since: performance.now() };
  const result = scope.run(s, fn);
  // ostatni kawałek: od ostatniej przerwy do końca zadania
  return { result, close: () => sink?.(s.name, s.since, performance.now()) };
}

/** Krótka przerwa dla pętli zdarzeń; w zadaniu pociętym zamyka bieżący kawałek. */
export async function breathe(pauseMs = 1): Promise<void> {
  const s = scope.getStore();
  if (s) sink?.(s.name, s.since, performance.now());
  await Bun.sleep(pauseMs);
  if (s) s.since = performance.now();
}

/**
 * Czekanie poza pracą synchroniczną (sieć, inny wątek): w zadaniu pociętym zamyka bieżący kawałek przed `await`
 * i zaczyna nowy po nim, więc czas oczekiwania nie liczy się jako kawałek zadania (diagnostyka przestojów nie obwini
 * go za cudzy przestój w tym czasie). Poza zadaniem pociętym zwykłe `await`.
 */
export async function waitOutside<T>(p: Promise<T>): Promise<T> {
  const s = scope.getStore();
  if (s) sink?.(s.name, s.since, performance.now());
  try {
    return await p;
  } finally {
    if (s) s.since = performance.now();
  }
}

/**
 * Funkcja do wołania w pętli długiej pracy: gdy od ostatniej przerwy minęło `budgetMs`, robi krótką przerwę
 * (`await`), w której pętla zdarzeń obsługuje żądania. Wołana częściej niż budżet kosztuje tylko odczyt zegara.
 */
export function slicer(budgetMs = 40, pauseMs = 1): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < budgetMs) return;
    await breathe(pauseMs);
    since = performance.now();
  };
}
