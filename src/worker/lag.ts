// Diagnostyka przestojów pętli zdarzeń workera: próbka opóźnienia co 500 ms oraz trasy HTTP i zadania w tle
// z czasem trwania. Próbka powyżej 1 s trafia do logs/stall-RRRR-MM-DD.jsonl (jedna linia JSON) z trasami i zadaniami
// rozpoczętymi albo trwającymi w tym oknie. /api/health pokazuje maksimum z minuty i winowajcę ostatniego przestoju.
// Bez treści zapytań: trasa to metoda i ścieżka (numery i identyfikatory zwinięte do :id).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";
import { runSliced, setSliceSink } from "../util/slice.ts";

const SAMPLE_MS = 500;
const WINDOW_MS = 60_000;
/** Próbka dłuższa od tego progu idzie do logu przestojów. */
export const STALL_LOG_MS = 1000;
/** Przestój od tego progu dostaje winowajcę w /api/health. */
export const CULPRIT_MS = 200;

type Kind = "trasa" | "zadanie";
interface Rec {
  kind: Kind;
  name: string;
  t0: number;
  t1: number | null;
  /** praca w osobnym wątku (model wektorów, kopia): w logu, ale bez winy za przestój pętli */
  thread?: boolean;
  /**
   * zadanie pocięte na kawałki (nadrabianie, sen, przebudowa FTS): trwa minuty z przerwami, więc o winie decydują
   * jego kawałki synchroniczne (`slices`), a nie całe trwanie, które zachodzi na każdy przestój w tym czasie
   */
  sliced?: boolean;
}

/** Kawałek synchroniczny zadania pociętego (od przerwy do przerwy). */
interface Slice {
  name: string;
  t0: number;
  t1: number;
}

export interface Culprit {
  name: string;
  kind: Kind | null;
  /** czas trwania zadania albo trasy (dla trwającej: dotąd) */
  ms: number;
  /** przestój, w który trafiło */
  lagMs: number;
  at: number;
}

export interface TaskStat {
  lastMs: number;
  maxMs: number;
  runs: number;
  at: number;
  /** zadanie pocięte: najdłuższy kawałek synchroniczny ostatniego przebiegu */
  sliceMs?: number;
}

let seq = 0;
const running = new Map<number, Rec>();
/** zakończone z ostatnich ~70 s (do przypisania winy i do logu) */
let finished: Rec[] = [];
const tasks = new Map<string, TaskStat>();
const state = { lastMs: 0, maxMs: 0, since: Date.now(), stalls: 0, culprit: null as Culprit | null };
let timer: ReturnType<typeof setInterval> | null = null;
/** kawałki zadań pociętych z ostatnich ~10 s (krótsze niż 5 ms pomijamy: nie robią przestoju) */
let slices: Slice[] = [];
/** najdłuższy kawałek bieżącego albo ostatniego przebiegu zadania pociętego */
const sliceMax = new Map<string, number>();

/** Kawałek zadania pociętego (wołane z przerw w `util/slice.ts`); eksport dla testów. */
export function slice(name: string, t0: number, t1: number): void {
  const ms = t1 - t0;
  sliceMax.set(name, Math.max(sliceMax.get(name) ?? 0, ms));
  if (ms < 5) return;
  slices.push({ name, t0, t1 });
  if (slices.length > 500) slices = slices.filter((s) => t1 - s.t1 <= 10_000).slice(-300);
}
setSliceSink(slice);

/** Początek trasy albo zadania; zwraca uchwyt do `end`. */
export function begin(kind: Kind, name: string, thread = false, sliced = false): number {
  const id = ++seq;
  if (sliced) sliceMax.set(name, 0);
  running.set(id, {
    kind,
    name,
    t0: performance.now(),
    t1: null,
    ...(thread ? { thread } : {}),
    ...(sliced ? { sliced } : {}),
  });
  return id;
}

export function end(id: number): void {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  r.t1 = performance.now();
  const now = r.t1;
  finished.push(r);
  if (finished.length > 2000 || (finished.length > 200 && now - finished[0].t1! > WINDOW_MS + 10_000))
    finished = finished.filter((x) => now - x.t1! <= WINDOW_MS + 10_000).slice(-1000);
  if (r.kind === "zadanie") {
    const ms = Math.round(r.t1 - r.t0);
    const s = tasks.get(r.name) ?? { lastMs: 0, maxMs: 0, runs: 0, at: 0 };
    tasks.set(r.name, {
      lastMs: ms,
      maxMs: Math.max(s.maxMs, ms),
      runs: s.runs + 1,
      at: Date.now(),
      ...(r.sliced ? { sliceMs: Math.round(sliceMax.get(r.name) ?? 0) } : {}),
    });
  }
}

/**
 * Mierzy zadanie w tle (synchroniczne albo zwracające obietnicę); czas trafia do statystyk i przypisania winy.
 * `thread`: zadanie czeka na osobny wątek (model wektorów, kopia), więc nie blokuje pętli i nie bywa winowajcą.
 * `sliced`: zadanie z przerwami (`breathe`, `slicer`); winę i `sliceMs` liczymy z jego kawałków synchronicznych.
 */
export function track<T>(name: string, fn: () => T, opts: { thread?: boolean; sliced?: boolean } = {}): T {
  const id = begin("zadanie", name, opts.thread, opts.sliced);
  let res: T;
  let close = () => {};
  try {
    if (opts.sliced) ({ result: res, close } = runSliced(name, fn));
    else res = fn();
  } catch (e) {
    close();
    end(id);
    throw e;
  }
  if (res instanceof Promise) {
    return res.finally(() => {
      close();
      end(id);
    }) as T;
  }
  close();
  end(id);
  return res;
}

/** Nazwa trasy do diagnostyki: bez zapytania, z numerami i identyfikatorami sesji zwiniętymi do :id. */
export function routeName(method: string, path: string): string {
  if (!path.startsWith("/api/")) return `${method} (podgląd)`;
  return `${method} ${path.replace(/^(\/api\/(?:observation|session))\/[^/]+$/, "$1/:id")}`;
}

/** Wpisy (trwające i zakończone) zachodzące na okno [from, to]. */
function overlapping(from: number, to: number): Rec[] {
  const out: Rec[] = [];
  for (const r of running.values()) if (r.t0 <= to) out.push(r);
  for (let i = finished.length - 1; i >= 0; i--) {
    const r = finished[i];
    if (r.t1! >= from && r.t0 <= to) out.push(r);
  }
  return out;
}

/** Jedna próbka opóźnienia (eksport dla testów: pozwala podać przestój bez blokowania pętli). */
export function sample(lagMs: number, now = performance.now()): void {
  state.lastMs = lagMs;
  if (Date.now() - state.since > WINDOW_MS) Object.assign(state, { maxMs: 0, since: Date.now() });
  state.maxMs = Math.max(state.maxMs, lagMs);
  if (lagMs < CULPRIT_MS) return;
  // okno próbki: od oczekiwanego czasu poprzedniej próbki do teraz; wina: największa część wspólna z przestojem
  const from = now - lagMs - SAMPLE_MS;
  const stallFrom = now - lagMs;
  const recs = overlapping(from, now);
  // kandydaci: kawałki zadań pociętych (na pewno synchroniczne, więc przy remisie wygrywają), trasy i zadania zwykłe;
  // całe trwanie zadania pociętego się nie liczy (zachodzi na każdy przestój w czasie nadrabiania, snu, przebudowy)
  const cands: { name: string; kind: Kind; t0: number; t1: number | null }[] = [
    ...slices.filter((s) => s.t1 >= stallFrom && s.t0 <= now).map((s) => ({ ...s, kind: "zadanie" as Kind })),
    ...recs.filter((r) => r.kind === "trasa" && !r.thread),
    ...recs.filter((r) => r.kind === "zadanie" && !r.thread && !r.sliced),
  ];
  let best: (typeof cands)[number] | null = null;
  let bestOv = 0;
  for (const r of cands) {
    const ov = Math.min(r.t1 ?? now, now) - Math.max(r.t0, stallFrom);
    // remis (do 1 ms, bo czasy to liczby zmiennoprzecinkowe) wygrywa wcześniejszy kandydat
    if (ov > 0 && ov > bestOv + (best ? 1 : 0)) {
      best = r;
      bestOv = ov;
    }
  }
  state.culprit = best
    ? { name: best.name, kind: best.kind, ms: Math.round((best.t1 ?? now) - best.t0), lagMs, at: Date.now() }
    : { name: "nieśledzone (poza trasami i zadaniami)", kind: null, ms: 0, lagMs, at: Date.now() };
  if (lagMs <= STALL_LOG_MS) return;
  state.stalls++;
  const longestSlice = (name: string) =>
    Math.round(Math.max(0, ...slices.filter((s) => s.name === name && s.t1 >= from && s.t0 <= now).map((s) => s.t1 - s.t0)));
  const item = (r: Rec) => ({
    name: r.name,
    ms: Math.round((r.t1 ?? now) - r.t0),
    running: r.t1 === null,
    startedMsAgo: Math.round(now - r.t0),
    ...(r.thread ? { thread: true } : {}),
    // zadanie pocięte: najdłuższy kawałek synchroniczny w oknie próbki
    ...(r.sliced ? { sliced: true, sliceMs: longestSlice(r.name) } : {}),
  });
  writeStall({
    at: new Date().toISOString(),
    lagMs,
    culprit: state.culprit.name,
    routes: recs.filter((r) => r.kind === "trasa").map(item),
    tasks: recs.filter((r) => r.kind === "zadanie").map(item),
  });
}

function day(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function writeStall(entry: unknown): void {
  try {
    appendFileSync(join(paths.logs(), `stall-${day()}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch {}
}

/** Próbkowanie co 500 ms (timer bez trzymania procesu przy życiu). */
export function startLagMonitor(): void {
  if (timer) return;
  let expected = performance.now() + SAMPLE_MS;
  timer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, Math.round(now - expected));
    expected = now + SAMPLE_MS;
    sample(lag, now);
  }, SAMPLE_MS);
  timer.unref?.();
}

/** Pola dla /api/health. */
export function lagHealth() {
  const c = state.culprit;
  return {
    eventLoopLagMs: state.lastMs,
    eventLoopLagMaxMs: state.maxMs,
    eventLoopWindowS: WINDOW_MS / 1000,
    /** przestoje powyżej 1 s od startu workera (każdy ma linię w logs/stall-*.jsonl) */
    eventLoopStalls: state.stalls,
    /** winowajca ostatniego przestoju od 200 ms: zadanie albo trasa o największej części wspólnej z przestojem */
    lagCulprit: c ? { name: c.name, kind: c.kind, ms: c.ms, lagMs: c.lagMs, agoS: Math.round((Date.now() - c.at) / 1000) } : null,
    /** czas ostatniego i najdłuższego przebiegu każdego zadania w tle; pocięte: najdłuższy kawałek (`sliceMs`) */
    backgroundTasks: Object.fromEntries(
      [...tasks].map(([k, s]) => [
        k,
        {
          lastMs: s.lastMs,
          maxMs: s.maxMs,
          runs: s.runs,
          agoS: Math.round((Date.now() - s.at) / 1000),
          ...(s.sliceMs !== undefined ? { sliceMs: s.sliceMs } : {}),
        },
      ]),
    ),
  };
}
