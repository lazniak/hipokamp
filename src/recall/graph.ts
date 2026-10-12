// Rozprzestrzenianie aktywacji po grafie encji (pliki, katalogi, pojęcia, narzędzia).
// Kontekst (pliki z promptu, pliki dotykane w tej sesji, katalog roboczy) aktywuje powiązane notatki.
import type { Repo } from "../db/repo.ts";

export interface ContextEntities {
  files?: string[];
  dirs?: string[];
  concepts?: string[];
  tools?: string[];
}

const ROLE_W: Record<string, number> = { modified: 1.0, read: 0.55, mentioned: 0.5, concept: 0.4 };

/**
 * Zwraca mapę obs_id → siła powiązania (0..1). Waga encji = IDF (rzadkie pliki/pojęcia znaczą więcej).
 */
export function spread(repo: Repo, project: string, ctx: ContextEntities, limit = 400): Map<number, number> {
  const out = new Map<number, number>();
  const groups: [string, string[], number][] = [
    ["file", ctx.files ?? [], 1.0],
    ["dir", ctx.dirs ?? [], 0.45],
    ["concept", (ctx.concepts ?? []).map((c) => c.toLowerCase()), 0.5],
    ["tool", ctx.tools ?? [], 0.35],
  ];
  const total = Math.max(
    1,
    (repo.db.query("SELECT COUNT(*) c FROM observations WHERE project = ? COLLATE NOCASE").get(project) as { c: number }).c,
  );
  for (const [kind, keys, kw] of groups) {
    if (!keys.length) continue;
    const ents = repo.entityIds(kind, project, [...new Set(keys)].slice(0, 60));
    for (const { id, df } of ents.values()) {
      const idf = Math.log(1 + total / Math.max(1, df)) / Math.log(1 + total);
      const rows = repo.db
        .query(
          "SELECT oe.obs_id, oe.role FROM obs_entities oe JOIN observations o ON o.id = oe.obs_id WHERE oe.entity_id = ? AND o.status = 'active' ORDER BY o.created_at DESC LIMIT ?",
        )
        .all(id, limit) as { obs_id: number; role: string }[];
      for (const r of rows) {
        const w = kw * idf * (ROLE_W[r.role] ?? 0.4);
        out.set(r.obs_id, (out.get(r.obs_id) ?? 0) + w);
      }
    }
  }
  // spłaszczenie do 0..1
  for (const [k, v] of out) out.set(k, 1 - Math.exp(-1.6 * v));
  return out;
}

/** Ścieżki plików wspomniane w tekście promptu (np. src/auth/session.ts, D:\code\x\y.ps1). */
export function filesInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:[A-Za-z]:[\\/]|\.{0,2}\/)?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,8}\b/g)) out.add(m[0]);
  for (const m of text.matchAll(
    /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|ps1|sh|json|md|sql|go|rs|php|css|html|vue|svelte|yaml|yml|toml)\b/g,
  ))
    out.add(m[0]);
  return [...out].slice(0, 20);
}
