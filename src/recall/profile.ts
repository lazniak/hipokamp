// Profil ścieżki promptu: czas etapów (embedding, FTS, wektory, ranking) w ms dla ostatnich przypomnień przy prompcie.
// Każda decyzja ma czasy także w logu decyzji (logs/recall-*.jsonl, pole `ms`); tu żyje okno ostatnich próbek procesu,
// które worker pokazuje w /api/health (mediana i p95), żeby było widać, który etap zjada limit hooka.

export interface StageTimes {
  /** Wektor zapytania (bge-m3, CPU). */
  embed: number;
  /** BM25 (FTS5), lokalnie i globalnie razem. */
  fts: number;
  /** KNN na wektorach binarnych z przeliczeniem kandydatów na int8 (projekt i inne projekty razem). */
  vec: number;
  /** Scalanie RRF, pewność, aktywacja, graf, wybór pod budżet i tekst. */
  rank: number;
}

export interface PromptTimes extends StageTimes {
  total: number;
  /** Czy szło globalne FTS w innych projektach (tylko przy słabym lokalnym; KNN innych projektów idzie zawsze). */
  global: boolean;
}

export const emptyStages = (): StageTimes => ({ embed: 0, fts: 0, vec: 0, rank: 0 });

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Zaokrąglenie do 0,1 ms (log i API). */
export function roundTimes(t: PromptTimes): PromptTimes {
  return { embed: r1(t.embed), fts: r1(t.fts), vec: r1(t.vec), rank: r1(t.rank), total: r1(t.total), global: t.global };
}

const WINDOW = 200;
const samples: PromptTimes[] = [];

export function recordPromptTimes(t: PromptTimes): void {
  samples.push(roundTimes(t));
  if (samples.length > WINDOW) samples.shift();
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export interface PromptProfile {
  n: number;
  /** Odsetek promptów, przy których szło globalne FTS. */
  globalShare: number;
  p50: StageTimes & { total: number };
  p95: StageTimes & { total: number };
  last: PromptTimes;
}

/** Mediana i p95 każdego etapu z ostatnich (najwyżej 200) przypomnień przy prompcie; null bez próbek. */
export function promptProfile(): PromptProfile | null {
  if (!samples.length) return null;
  const of = (k: keyof StageTimes | "total", q: number) =>
    quantile(
      samples.map((s) => s[k]),
      q,
    );
  const at = (q: number) => ({
    embed: of("embed", q),
    fts: of("fts", q),
    vec: of("vec", q),
    rank: of("rank", q),
    total: of("total", q),
  });
  return {
    n: samples.length,
    globalShare: Math.round((samples.filter((s) => s.global).length / samples.length) * 1000) / 1000,
    p50: at(0.5),
    p95: at(0.95),
    last: samples[samples.length - 1],
  };
}

/** Tylko do testów: czyste okno próbek. */
export function resetPromptProfile(): void {
  samples.length = 0;
}
