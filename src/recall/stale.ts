// Wykrywanie przeterminowania: notatka mówi o pliku, który od tamtej pory się zmienił.
// Nie kasujemy — oznaczamy i lekko obniżamy wagę (kod mógł zmienić sens notatki).
// Zmiana to zmiana treści: odcisk ze skrótem (pliki do 1 MB) porównuje treść, więc `git checkout`, który zmienia
// tylko mtime, nie unieważnia notatki. Odciski bez skrótu (stary format, duże pliki) działają po mtime jak dotąd.
import { statSync } from "node:fs";
import type { Observation } from "../types.ts";
import { contentDigest, parseFingerprint } from "../util/git.ts";
import { absFromKey } from "../util/paths.ts";

/** Tolerancja mtime (zapis pliku tuż przed końcem tury). */
const MTIME_SLACK_MS = 2000;

const cache = new Map<string, { at: number; mtime: number | null; size: number }>();
/** Skróty treści po (ścieżka, mtime, rozmiar): plik czytamy raz, dopóki się nie zmieni. Tylko udane odczyty. */
const digests = new Map<string, string>();
const DIGESTS_MAX = 4096;
/** Najwyżej tyle bajtów czyta jedno wywołanie `staleness` (8 plików po 1 MB to za dużo na ścieżkę kontekstu). */
export const STALE_READ_BUDGET = 2 * 1024 * 1024;

/** Budżet odczytu treści na jedno wywołanie: po wyczerpaniu odcisk ze skrótem działa jak bez niego (mtime). */
export interface ReadBudget {
  bytes: number;
}

function stateOf(abs: string): { mtime: number | null; size: number } {
  const c = cache.get(abs);
  if (c && Date.now() - c.at < 30_000) return c;
  let m: number | null = null;
  let size = 0;
  try {
    const st = statSync(abs);
    m = Math.round(st.mtimeMs);
    size = st.size;
  } catch {
    m = null;
  }
  const s = { at: Date.now(), mtime: m, size };
  cache.set(abs, s);
  return s;
}

/**
 * Skrót treści z pamięci albo z pliku. Do pamięci trafia tylko udany odczyt: chwilowa blokada pliku (Windows,
 * edytor, antywirus) nie może zostać „zmianą” do końca życia workera. null: nieczytelny albo budżet wyczerpany.
 */
function digestOf(abs: string, mtime: number, size: number, budget?: ReadBudget): string | null {
  const k = `${abs}|${mtime}|${size}`;
  const hit = digests.get(k);
  if (hit) return hit;
  if (budget) {
    if (budget.bytes < size) return null;
    budget.bytes -= size;
  }
  const h = contentDigest(abs, size);
  if (h === null) return null;
  if (digests.size >= DIGESTS_MAX) digests.delete(digests.keys().next().value!);
  digests.set(k, h);
  return h;
}

/**
 * Czy plik różni się od stanu z odcisku. Ze skrótem: inny rozmiar albo (przy nowszym mtime) inna treść.
 * Bez skrótu (stary format `mtime:rozmiar`, plik > 1 MB, brak odcisku), przy nieczytelnym pliku i po wyczerpaniu
 * budżetu odczytu: mtime późniejszy niż zapisany.
 */
export function fileChanged(
  abs: string,
  now: { mtime: number; size: number },
  fp: string | null | undefined,
  createdAt: number,
  budget?: ReadBudget,
): boolean {
  if (!fp) return now.mtime > createdAt + MTIME_SLACK_MS;
  const rec = parseFingerprint(fp);
  if (!rec.hash || rec.size === null) return now.mtime > rec.mtime + MTIME_SLACK_MS;
  if (now.size !== rec.size) return true;
  // ten sam rozmiar i mtime bez zmian: bez czytania pliku
  if (now.mtime <= rec.mtime + MTIME_SLACK_MS) return false;
  const h = digestOf(abs, now.mtime, now.size, budget);
  // nieczytelny plik albo budżet wyczerpany: jak bez skrótu (mtime jest późniejszy), następne wywołanie spróbuje znowu
  return h === null ? true : h !== rec.hash;
}

export interface Staleness {
  stale: boolean;
  /** Ile z plików notatki zmieniło się po jej powstaniu. */
  changed: string[];
  missing: string[];
}

export function staleness(o: Observation, cwd: string | null, readBudget = STALE_READ_BUDGET): Staleness {
  const res: Staleness = { stale: false, changed: [], missing: [] };
  const files = o.files_modified.length ? o.files_modified : [];
  if (!files.length || !cwd) return res;
  const budget: ReadBudget = { bytes: readBudget };
  for (const key of files.slice(0, 8)) {
    const abs = absFromKey(key, cwd);
    const st = stateOf(abs);
    if (st.mtime === null) {
      res.missing.push(key);
      continue;
    }
    if (fileChanged(abs, { mtime: st.mtime, size: st.size }, o.fingerprints?.[key], o.created_at, budget)) res.changed.push(key);
  }
  res.stale = res.changed.length > 0 && res.changed.length >= Math.ceil(files.slice(0, 8).length / 2);
  return res;
}
