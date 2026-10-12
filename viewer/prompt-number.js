// hipokamp: zakresy numerów promptów w sesji, wspólne dla podglądu, serwera MCP i bazy (src/db/repo.ts).
// Poniżej PROMPT_SUBST_BASE: numer tury z transkryptu. Od PROMPT_SUBST_BASE: numer zastępczy (PROMPT_SUBST_BASE + tura),
// gdy numer tury zajmuje już inny prompt. Od PROMPT_CM_BASE: prompt claude-mem bez tury w transkrypcie
// (PROMPT_CM_BASE + numer w claude-mem). Typy: prompt-number.d.ts.

export const PROMPT_SUBST_BASE = 1_000_000;
export const PROMPT_CM_BASE = 2_000_000;

/** Numer promptu do wyświetlenia: rodzaj (turn, subst, cm) i numer w swoim zakresie. */
export function promptRef(n) {
  if (n >= PROMPT_CM_BASE) return { kind: "cm", n: n - PROMPT_CM_BASE };
  if (n >= PROMPT_SUBST_BASE) return { kind: "subst", n: n - PROMPT_SUBST_BASE };
  return { kind: "turn", n };
}
