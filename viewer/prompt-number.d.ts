// Typy dla prompt-number.js (podgląd to czysty JS, serwer importuje ten sam moduł).
export declare const PROMPT_SUBST_BASE: number;
export declare const PROMPT_CM_BASE: number;
export type PromptKind = "turn" | "subst" | "cm";
export declare function promptRef(n: number): { kind: PromptKind; n: number };
