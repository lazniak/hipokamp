// Strojenie progu przypominania przy prompcie (`context.promptMinScore`) na własnych danych: `hipokamp recall-stats`.
// Źródła: dziennik decyzji (logs/recall-RRRR-MM-DD.jsonl, bez treści promptów) i ślady `fetched` w access_log
// (get_observations). Pytanie: ile decyzji „poniżej progu” i tak skończyło się pobraniem tej notatki (próg za wysoki),
// a ile wstrzyknięć nikt potem nie pobrał (próg za niski). Narzędzie tylko liczy i rekomenduje; progu nie zmienia.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "../db/repo.ts";

export interface RecallDecision {
  at: number;
  session: string;
  project: string;
  vectors: boolean;
  /** Próg w chwili decyzji (null: wpis bez pola). */
  min: number | null;
  best: { id: number; conf: number }[];
  outcome: string;
  fired: number[];
}

/** Wynik „wstrzyknięte”: hook ścieżką lokalną zapisuje wstrzyknięte, worker zwrócone (wstrzykuje hook po odebraniu). */
const FIRED = new Set(["wstrzyknięte", "zwrócone"]);
const BELOW = "poniżej-progu";

/** Szerokość przedziału pewności w tabeli i w regule rekomendacji. */
const BAND = 0.05;
/** Najniższy próg, jaki narzędzie w ogóle zaproponuje (poniżej cosinus bge-m3 to szum). */
const FLOOR = 0.4;
/** Obniżenie: przedział pod progiem pobierany później co najmniej tak często (bezwzględnie)… */
const LOWER_MIN_RATE = 0.15;
/** …i co najmniej w takiej części tego, jak często używane są notatki wstrzyknięte. */
const LOWER_REL_RATE = 0.5;
/** Podniesienie: przedział tuż nad progiem, z którego wstrzyknięć prawie nikt nie pobiera. */
const RAISE_MAX_RATE = 0.05;
/** Za mało decyzji z wektorami, żeby cokolwiek rekomendować. */
const MIN_DECISIONS = 200;
/** Dni danych, po których zadanie zakładało strojenie (TASKS.md, T-03). */
const MIN_DAYS = 14;

export function readRecallLogs(dir: string, since: number): RecallDecision[] {
  if (!existsSync(dir)) return [];
  const sinceDay = dayOf(since);
  const out: RecallDecision[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = f.match(/^recall-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] < sinceDay) continue;
    let raw = "";
    try {
      raw = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.at !== "number" || e.at < since || !Array.isArray(e.best)) continue;
        out.push({
          at: e.at,
          session: String(e.session ?? ""),
          project: String(e.project ?? ""),
          vectors: e.vectors === true,
          min: typeof e.min === "number" && Number.isFinite(e.min) ? e.min : null,
          best: e.best
            .filter((b: any) => Number.isFinite(Number(b?.id)) && Number.isFinite(Number(b?.conf)))
            .map((b: any) => ({ id: Number(b.id), conf: Number(b.conf) })),
          outcome: String(e.outcome ?? ""),
          fired: Array.isArray(e.fired) ? e.fired.map(Number).filter(Number.isFinite) : [],
        });
      } catch {
        // uszkodzona linia (przerwany zapis): pomijamy
      }
    }
  }
  return out;
}

function dayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface Band {
  from: number;
  to: number;
  /** Decyzje poniżej progu w tym przedziale i ile z nich skończyło się pobraniem kandydata. */
  below: number;
  belowFetched: number;
  /** Decyzje ze wstrzyknięciem w tym przedziale i ile wstrzykniętych notatek ktoś potem pobrał. */
  fired: number;
  firedUsed: number;
}

export interface RecallStats {
  from: number;
  to: number;
  days: number;
  windowMin: number;
  threshold: number;
  /** Decyzje podjęte przy analizowanym progu (`threshold`). */
  decisions: number;
  withoutVectors: number;
  /** Decyzje z tego okresu podjęte przy innym progu: poza analizą. */
  otherThreshold: { n: number; values: number[] };
  outcomes: Record<string, number>;
  below: { n: number; fetched: number; sameSession: number };
  fired: { n: number; used: number };
  bands: Band[];
  recommendation: { threshold: number; change: "obniż" | "podnieś" | "zostaw" | "za mało danych"; why: string };
}

const pct = (k: number, n: number) => (n ? `${((k / n) * 100).toFixed(0)}%` : "–");
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Statystyki decyzji z ostatnich `days` dni. Notatka „pobrana później” = ślad `fetched` w ciągu `windowMin` minut po
 * decyzji (dowolna sesja: MCP zna tylko ostatnio aktywną sesję projektu, więc przy równoległych sesjach id sesji bywa
 * inne; zgodność sesji jest podana osobno). Rekomendacja tylko z decyzji z wektorami (pewność = skalibrowany cosinus).
 */
export function recallStats(
  repo: Repo,
  opts: { logsDir: string; days?: number; windowMin?: number; minN?: number; threshold: number; now?: number },
): RecallStats {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 14;
  const windowMs = (opts.windowMin ?? 60) * 60_000;
  const minN = opts.minN ?? 20;
  const threshold = opts.threshold;
  // tylko decyzje podjęte przy analizowanym progu: po zmianie progu ten sam przedział pewności raz jest „poniżej”,
  // raz „wstrzyknięte”, więc dane z dwóch progów się nie mieszają (reszta liczona osobno)
  const sameMin = (d: RecallDecision) => d.min === null || Math.abs(d.min - threshold) < 1e-6;
  const read = readRecallLogs(opts.logsDir, now - days * 86_400_000).filter((d) => d.at <= now);
  const all = read.filter(sameMin);
  const other = read.filter((d) => !sameMin(d));
  const outcomes: Record<string, number> = {};
  for (const d of all) outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
  const vec = all.filter((d) => d.vectors && d.best.length);

  // ślady pobrań wszystkich kandydatów z okna analizy (jedno zapytanie na 500 notatek)
  const ids = [...new Set(vec.flatMap((d) => [...d.best.map((b) => b.id), ...d.fired]))];
  const from = vec.length ? Math.min(...vec.map((d) => d.at)) : now;
  const to = vec.length ? Math.max(...vec.map((d) => d.at)) : now;
  const byObs = new Map<number, { at: number; session: string | null }[]>();
  for (const e of repo.accessEvents(ids, "fetched", from, to + windowMs)) {
    const list = byObs.get(e.obs_id) ?? [];
    list.push({ at: e.at, session: e.session_id });
    byObs.set(e.obs_id, list);
  }
  const fetchedAfter = (d: RecallDecision, list: number[], sameSession = false) =>
    list.some((id) =>
      (byObs.get(id) ?? []).some((e) => e.at > d.at && e.at <= d.at + windowMs && (!sameSession || e.session === d.session)),
    );

  const top = (d: RecallDecision) => Math.max(...d.best.map((b) => b.conf));
  const below = vec.filter((d) => d.outcome === BELOW);
  const fired = vec.filter((d) => FIRED.has(d.outcome) && d.fired.length);
  const belowFetched = new Set(
    below.filter((d) =>
      fetchedAfter(
        d,
        d.best.map((b) => b.id),
      ),
    ),
  );
  const firedUsed = new Set(fired.filter((d) => fetchedAfter(d, d.fired)));

  // przedziały pewności co 0,05, granica na progu; pod najniższą granicą (≥ 0,40) jeden zbiorczy przedział od zera
  const edges: number[] = [];
  for (let e = threshold; e > FLOOR - 1e-9; e -= BAND) edges.unshift(r2(e));
  for (let e = threshold + BAND; e < 1 - 1e-9; e += BAND) edges.push(r2(e));
  if (edges[0] > 0) edges.unshift(0);
  const bands: Band[] = [];
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i];
    const hi = i + 1 < edges.length ? edges[i + 1] : 1.0001;
    const inBand = (d: RecallDecision) => top(d) >= lo - 1e-9 && top(d) < hi - 1e-9;
    const b = below.filter(inBand);
    const f = fired.filter(inBand);
    bands.push({
      from: lo,
      to: Math.min(1, hi),
      below: b.length,
      belowFetched: b.filter((d) => belowFetched.has(d)).length,
      fired: f.length,
      firedUsed: f.filter((d) => firedUsed.has(d)).length,
    });
  }

  const usedRate = fired.length ? firedUsed.size / fired.length : 0;
  const recommendation = recommend(bands, {
    threshold,
    decisions: vec.length,
    days: (to - from) / 86_400_000,
    usedRate,
    minN,
  });
  return {
    from,
    to,
    days,
    windowMin: windowMs / 60_000,
    threshold,
    decisions: all.length,
    withoutVectors: all.filter((d) => !d.vectors).length,
    otherThreshold: { n: other.length, values: [...new Set(other.map((d) => d.min as number))].sort((a, b) => a - b) },
    outcomes,
    below: {
      n: below.length,
      fetched: belowFetched.size,
      sameSession: below.filter((d) =>
        fetchedAfter(
          d,
          d.best.map((b) => b.id),
          true,
        ),
      ).length,
    },
    fired: { n: fired.length, used: firedUsed.size },
    bands,
    recommendation,
  };
}

/**
 * Reguła (jawna, żeby dało się ją sprawdzić ręcznie):
 * - za mało danych: mniej niż 200 decyzji z wektorami;
 * - obniż: przedziały tuż pod progiem (każdy z co najmniej `minN` decyzjami), z których notatki i tak pobrano
 *   w co najmniej 15% decyzji i co najmniej w połowie tak często, jak używane są notatki wstrzyknięte. Próg schodzi
 *   do dolnej granicy najniższego takiego przedziału, idąc w dół bez przerw;
 * - podnieś: przedziały tuż nad progiem (po `minN` wstrzyknięć), z których wstrzyknięte notatki pobrano w mniej niż 5%;
 * - inaczej zostaw.
 */
function recommend(
  bands: Band[],
  s: { threshold: number; decisions: number; days: number; usedRate: number; minN: number },
): RecallStats["recommendation"] {
  const t = s.threshold;
  if (s.decisions < MIN_DECISIONS)
    return {
      threshold: t,
      change: "za mało danych",
      why: `${s.decisions} decyzji z wektorami (potrzeba co najmniej ${MIN_DECISIONS}); zostaw ${t}`,
    };
  const short = s.days < MIN_DAYS ? ` Uwaga: dane z ${s.days.toFixed(1)} dni (zalecane ${MIN_DAYS}).` : "";
  const need = Math.max(LOWER_MIN_RATE, LOWER_REL_RATE * s.usedRate);
  let lowered = t;
  const why: string[] = [];
  for (const b of [...bands].filter((x) => x.to <= t + 1e-9).reverse()) {
    if (b.from < FLOOR - 1e-9 || b.below < s.minN || b.belowFetched / b.below < need) break;
    lowered = b.from;
    why.push(`${b.from.toFixed(2)}–${b.to.toFixed(2)}: pobrane później ${pct(b.belowFetched, b.below)} z ${b.below}`);
  }
  if (lowered < t)
    return {
      threshold: r2(lowered),
      change: "obniż",
      why: `Pod progiem notatki i tak pobierano (${why.join("; ")}), a wymagane było ${pct(need, 1)} (wstrzyknięte używane w ${pct(s.usedRate, 1)}).${short}`,
    };
  let raised = t;
  for (const b of bands.filter((x) => x.from >= t - 1e-9)) {
    if (b.fired < s.minN || b.firedUsed / b.fired >= RAISE_MAX_RATE) break;
    raised = b.to;
    why.push(`${b.from.toFixed(2)}–${b.to.toFixed(2)}: użyte ${pct(b.firedUsed, b.fired)} z ${b.fired} wstrzyknięć`);
  }
  if (raised > t)
    return {
      threshold: r2(raised),
      change: "podnieś",
      why: `Wstrzyknięć tuż nad progiem prawie nikt nie pobiera (${why.join("; ")}, granica ${pct(RAISE_MAX_RATE, 1)}).${short}`,
    };
  const nb = bands.find((b) => b.to <= t + 1e-9 && b.to > t - 1e-9);
  return {
    threshold: t,
    change: "zostaw",
    why: `Przedział tuż pod progiem: pobrane później ${nb ? `${pct(nb.belowFetched, nb.below)} z ${nb.below}` : "brak danych"} (potrzeba ${pct(need, 1)} przy co najmniej ${s.minN} decyzjach); wstrzyknięte używane w ${pct(s.usedRate, 1)}.${short}`,
  };
}

export function formatRecallStats(r: RecallStats): string {
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `Decyzje przypominania przy prompcie: ${r.decisions} z ostatnich ${r.days} dni${r.decisions ? ` (${d(r.from)} – ${d(r.to)})` : ""}`,
    `Wyniki: ${
      Object.entries(r.outcomes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "brak"
    }${r.withoutVectors ? `; bez wektorów ${r.withoutVectors} (poza analizą)` : ""}`,
    ...(r.otherThreshold.n
      ? [
          `Przy innym progu (${r.otherThreshold.values.join(", ")}): ${r.otherThreshold.n} decyzji poza analizą (--threshold wybiera próg).`,
        ]
      : []),
    `Próg: ${r.threshold}. Okno „pobrane później”: ${r.windowMin} min po decyzji (get_observations).`,
    `Poniżej progu: ${r.below.n}, z tego pobrane później ${r.below.fetched} (${pct(r.below.fetched, r.below.n)}; w tej samej sesji ${r.below.sameSession}).`,
    `Wstrzyknięte: ${r.fired.n}, z tego notatkę pobrano później ${r.fired.used} (${pct(r.fired.used, r.fired.n)}).`,
    "",
    "pewność      poniżej  pobrane   wstrzyk.  użyte",
  ];
  for (const b of r.bands) {
    if (!b.below && !b.fired) continue;
    const mark = Math.abs(b.from - r.threshold) < 1e-9 ? " ← próg" : "";
    lines.push(
      `${b.from.toFixed(2)}–${b.to.toFixed(2)}   ${String(b.below).padStart(6)}  ${pct(b.belowFetched, b.below).padStart(7)}   ${String(b.fired).padStart(7)}  ${pct(b.firedUsed, b.fired).padStart(6)}${mark}`,
    );
  }
  lines.push(
    "",
    `Rekomendacja: ${r.recommendation.change}${r.recommendation.change === "obniż" || r.recommendation.change === "podnieś" ? ` do ${r.recommendation.threshold}` : ""}`,
    r.recommendation.why,
  );
  if (r.recommendation.change === "obniż" || r.recommendation.change === "podnieś")
    lines.push(`Zmiana (ręcznie): ~/.hipokamp/config.json → { "context": { "promptMinScore": ${r.recommendation.threshold} } }`);
  return lines.join("\n");
}
