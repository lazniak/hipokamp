// Aktywacja pamięci wg ACT-R: B = ln(Σ Δt_j^(-d)). Częste i świeże użycia = wysoka aktywacja,
// nieużywane notatki wygasają potęgowo (nie wykładniczo — stare, ale ważne rzeczy nie znikają).
import type { Repo } from "../db/repo.ts";
import type { Observation } from "../types.ts";

const DAY = 86_400_000;
const DECAY = 0.5;

const KIND_WEIGHT: Record<string, number> = { fetched: 1.0, cited: 1.2, search_hit: 0.25 };

export function baseLevel(events: { at: number; w: number }[], now: number): number {
  let s = 0;
  for (const e of events) {
    const dtDays = Math.max(1 / 24, (now - e.at) / DAY);
    s += e.w * dtDays ** -DECAY;
  }
  return s > 0 ? Math.log(s) : -5;
}

/** Aktywacja znormalizowana do 0..1 (sigmoida przesunięta: świeże ≈0.9, rok ≈0.1). */
export function activation(o: Observation, access: { at: number; kind: string }[] | undefined, now = Date.now()): number {
  const ev: { at: number; w: number }[] = [{ at: o.created_at, w: 1 }];
  // powtórzenia tej samej treści (dedup) liczą się jak dodatkowe ślady
  if (o.occurrence_count > 1) ev.push({ at: o.updated_at, w: Math.min(3, o.occurrence_count - 1) * 0.6 });
  for (const a of access ?? []) ev.push({ at: a.at, w: KIND_WEIGHT[a.kind] ?? 0.5 });
  // gdy log dostępu przycięty — reszta jako ślad w last_access_at
  if (!access?.length && o.access_count > 0 && o.last_access_at)
    ev.push({ at: o.last_access_at, w: Math.min(4, o.access_count) * 0.7 });
  const b = baseLevel(ev, now);
  return 1 / (1 + Math.exp(-(b + 1)));
}

export function activations(repo: Repo, obs: Observation[], now = Date.now()): Map<number, number> {
  const acc = repo.accessTimes(obs.map((o) => o.id));
  const out = new Map<number, number>();
  for (const o of obs) out.set(o.id, activation(o, acc.get(o.id), now));
  return out;
}

/** Kara za „wstrzyknięte, a nieużyte” — pamięć, która stale nie pomaga, schodzi niżej. */
export function ignorePenalty(o: Observation): number {
  const ignored = Math.max(0, o.inject_count - 2 * o.access_count);
  return Math.min(0.25, 0.03 * ignored);
}
