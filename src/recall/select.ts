// Wybór pamięci pod budżet tokenów: zachłanny „plecak” z karą za podobieństwo (MMR).
// Maksymalizuje wartość na token, a nie liczbę wpisów — kontekst sesji jest drogi.
import { cosQ8 } from "../index/vectors.ts";
import type { Observation } from "../types.ts";
import { normKey } from "../util/text.ts";

export interface Candidate {
  obs: Observation;
  score: number;
  tokens: number;
  vec?: Int8Array;
  why: string[];
  stale?: boolean;
}

export interface SelectOptions {
  budget: number;
  /** Siła kary za podobieństwo do już wybranych (0..1). */
  diversity?: number;
  /** Wykładnik kosztu tokenów: 0 = ignoruj długość, 1 = czysta wartość/token. */
  costExp?: number;
  maxItems?: number;
  minScore?: number;
}

function jaccard(a: string, b: string): number {
  const A = new Set(
    normKey(a)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  const B = new Set(
    normKey(b)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}

function similarity(x: Candidate, y: Candidate): number {
  if (x.vec && y.vec) return Math.max(0, cosQ8(x.vec, y.vec));
  return jaccard(x.obs.title, y.obs.title);
}

export function selectUnderBudget(cands: Candidate[], o: SelectOptions): Candidate[] {
  const div = o.diversity ?? 0.55;
  const ce = o.costExp ?? 0.35;
  const chosen: Candidate[] = [];
  let used = 0;
  const pool = cands.filter((c) => c.score >= (o.minScore ?? 0) && c.tokens > 0);
  while (pool.length && chosen.length < (o.maxItems ?? 50)) {
    let best = -1;
    let bestU = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (used + c.tokens > o.budget) continue;
      let maxSim = 0;
      for (const s of chosen) maxSim = Math.max(maxSim, similarity(c, s));
      // ta sama sesja i ten sam plik = prawdopodobny duplikat informacji
      const sameSession = chosen.some(
        (s) => s.obs.session_id && s.obs.session_id === c.obs.session_id && s.obs.prompt_n === c.obs.prompt_n,
      );
      const u = (c.score * (1 - div * maxSim) - (sameSession ? 0.2 : 0)) / c.tokens ** ce;
      if (u > bestU) {
        bestU = u;
        best = i;
      }
    }
    if (best < 0) break;
    const c = pool.splice(best, 1)[0];
    chosen.push(c);
    used += c.tokens;
  }
  return chosen;
}
