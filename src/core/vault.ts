// Eksport decyzji i pułapek do vaulta Obsidian (`hipokamp export-vault <katalog>`): markdown pod ścieżką podaną
// jawnie przez użytkownika, nigdy domyślnie. Pliki eksportu mają we frontmatterze `hipokamp_export: true`; pliku bez
// tego znacznika (notatki człowieka o tej samej nazwie) eksport nie nadpisuje nigdy. Treść przechodzi przez clean().
// Ponowny eksport nadpisuje tylko pliki, których treść się zmieniła; notatek zarchiwizowanych później nie usuwa.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clean } from "../capture/redact.ts";
import type { Repo } from "../db/repo.ts";
import type { Observation } from "../types.ts";
import { oneLine, sha1 } from "../util/text.ts";

export const DEFAULT_VAULT_TYPES = ["decision", "gotcha"];
const MARKER = "hipokamp_export: true";

export interface VaultOptions {
  /** Katalog docelowy (wymagany, bez wartości domyślnej). */
  dir: string;
  project?: string;
  types?: string[];
  /** note: plik na notatkę w podkatalogu projektu; project: jeden plik zbiorczy na projekt. */
  layout?: "note" | "project";
  dryRun?: boolean;
  limit?: number;
}

export interface VaultReport {
  dir: string;
  notes: number;
  written: number;
  unchanged: number;
  /** Pliki o tej samej nazwie bez znacznika eksportu: pominięte. */
  conflicts: string[];
  files: string[];
}

/** Nazwa pliku bezpieczna na Windows i w Obsidianie (bez znaków zastrzeżonych, kropek na brzegach, nazw urządzeń). */
export function safeName(s: string, max = 80): string {
  let x = s
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(x)) x = `_${x}`;
  return x.slice(0, max).trim() || "bez-nazwy";
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const yaml = (v: string) => JSON.stringify(v);

function body(o: Observation, level: string): string[] {
  const lines: string[] = [];
  if (o.subtitle) lines.push(`> ${oneLine(clean(o.subtitle))}`, "");
  const text = clean(o.narrative ?? o.text ?? "").trim();
  if (text) lines.push(text, "");
  if (o.facts.length) lines.push(`${level} Fakty`, ...o.facts.map((f) => `- ${oneLine(clean(f))}`), "");
  if (o.files_modified.length)
    lines.push(
      `Pliki: ${o.files_modified
        .slice(0, 12)
        .map((f) => `\`${clean(f)}\``)
        .join(", ")}`,
      "",
    );
  lines.push(`Źródło: hipokamp #${o.id} (${o.source}), ważność ${o.importance.toFixed(2)}`, "");
  return lines;
}

/** Jedna notatka jako plik markdown z frontmatterem. */
export function noteMarkdown(o: Observation): string {
  return [
    "---",
    MARKER,
    `id: ${o.id}`,
    `type: ${yaml(o.type)}`,
    `project: ${yaml(o.project)}`,
    `created: ${day(o.created_at)}`,
    `importance: ${o.importance.toFixed(2)}`,
    `source: ${yaml(o.source)}`,
    `tags: [hipokamp, ${yaml(o.type)}]`,
    "---",
    "",
    `# ${oneLine(clean(o.title))}`,
    "",
    ...body(o, "##"),
  ].join("\n");
}

/** Plik zbiorczy projektu: najnowsze notatki pierwsze. */
export function projectMarkdown(project: string, notes: Observation[]): string {
  const out = [
    "---",
    MARKER,
    `project: ${yaml(project)}`,
    `notes: ${notes.length}`,
    "---",
    "",
    `# ${project}: decyzje i pułapki`,
    "",
  ];
  for (const o of notes)
    out.push(`## #${o.id} [${o.type}] ${oneLine(clean(o.title))} (${day(o.created_at)})`, "", ...body(o, "###"));
  return out.join("\n");
}

/** Zapis z ochroną cudzych plików; zwraca stan pliku. */
function put(path: string, text: string, dryRun: boolean): "written" | "unchanged" | "conflict" {
  if (existsSync(path)) {
    let cur = "";
    try {
      cur = readFileSync(path, "utf8");
    } catch {
      return "conflict";
    }
    if (!cur.replace(/\r\n/g, "\n").split("\n").slice(0, 3).includes(MARKER)) return "conflict";
    if (cur === text) return "unchanged";
  }
  if (!dryRun) writeFileSync(path, text);
  return "written";
}

/**
 * Nazwy plików i katalogów projektów. Klucze, które po `safeName` (wielkość liter, ucięcie, znaki zastrzeżone) dają tę
 * samą nazwę, dostają sufiks z krótkim skrótem klucza (pierwszy w kolejności alfabetycznej zostaje bez sufiksu), więc
 * dwa projekty nigdy nie piszą do jednego pliku.
 */
export function projectNames(projects: string[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const p of projects) {
    const k = safeName(p).toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const out = new Map<string, string>();
  for (const list of groups.values())
    [...new Set(list)].sort().forEach((p, i) => {
      out.set(p, i === 0 ? safeName(p) : `${safeName(p, 72)} ~${sha1(p).slice(0, 6)}`);
    });
  return out;
}

export function exportVault(repo: Repo, opts: VaultOptions): VaultReport {
  if (!opts.dir?.trim()) throw new Error("podaj katalog vaulta (eksport nigdy nie pisze w miejsce domyślne)");
  const dir = resolve(opts.dir);
  const types = opts.types?.length ? opts.types : DEFAULT_VAULT_TYPES;
  const project = opts.project ? repo.mergedProject(opts.project) : null;
  const notes = repo.recentObservations(project, opts.limit ?? 5000, { types });
  const rep: VaultReport = { dir, notes: notes.length, written: 0, unchanged: 0, conflicts: [], files: [] };
  const byProject = new Map<string, Observation[]>();
  for (const o of notes) byProject.set(o.project, [...(byProject.get(o.project) ?? []), o]);
  const mark = (path: string, state: ReturnType<typeof put>) => {
    if (state === "conflict") rep.conflicts.push(path);
    else if (state === "unchanged") rep.unchanged++;
    else {
      rep.written++;
      rep.files.push(path);
    }
  };
  if (!opts.dryRun) mkdirSync(dir, { recursive: true });
  const names = projectNames([...byProject.keys()]);
  for (const [p, list] of byProject) {
    const name = names.get(p)!;
    if (opts.layout === "project") {
      mark(join(dir, `${name}.md`), put(join(dir, `${name}.md`), projectMarkdown(p, list), !!opts.dryRun));
      continue;
    }
    const sub = join(dir, name);
    if (!opts.dryRun) mkdirSync(sub, { recursive: true });
    for (const o of list) {
      const path = join(sub, `${o.id} ${safeName(clean(o.title), 70)}.md`);
      mark(path, put(path, noteMarkdown(o), !!opts.dryRun));
    }
  }
  return rep;
}
