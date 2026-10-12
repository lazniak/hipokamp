// Strona workera wątków embeddingów: ta sama rola co Embedder (embed, loaded, warm, device), ale modele liczą
// w osobnych wątkach (embed-thread.ts), więc pętla zdarzeń workera odpowiada hookom także w trakcie liczenia wektorów.
// Dwa wątki: „zapytania” (zapytania i wektory nowych notatek, model zapytań) i „masowy” (zaległość, model masowy,
// na GPU partie po 64). Zapytanie nie czeka więc na kawałek masowy (na DirectML ok. 2 s, przy kompilacji kształtu
// albo ładowaniu modelu dłużej), najwyżej na jeden kawałek wektorów nowej notatki.
// Wątek startuje przy pierwszym użyciu i żyje do końca procesu; model zwalnia się w nim po bezczynności.
// Nigdy terminate(): Bun 1.3 pada (NAPI FATAL ERROR w onnxruntime_binding) przy zamykaniu wątku z załadowanym
// onnxruntime-node, także po zwolnieniu sesji. Zwolnienie modelu w wątku i process.exit() z żywym wątkiem są bezpieczne.
// Wątek, który przy zleceniach w toku nie daje pulsu dłużej niż próg roli (zapytania 2 min; masowy 10 min, bo zimna
// kompilacja jednego kształtu DirectML to prawie minuta ciszy, a karta bywa zajęta przez inne programy), jest porzucany
// bez terminate: zlecenia dostają błąd, stary wątek po odblokowaniu porzuca kolejkę i zwalnia modele (`abandon`),
// a następne zlecenie startuje nowy wątek. Po RESTART_LIMIT porzuceniach w godzinie rola jest wyłączona do restartu
// workera (ostrzeżenie w logu i w /api/health): pętla wektorów liczy wtedy zaległość zwykłym wątkiem, a hooki idą na FTS.
import type { EmbedConfig } from "../config.ts";
import { log } from "../log.ts";
import type { EmbedMode, ThreadIn, ThreadOut } from "./embed-thread.ts";

type Role = "zapytania" | "masowy";
const ROLES: Role[] = ["zapytania", "masowy"];
/** Porzuceń zawieszonego wątku na godzinę, po których rola jest wyłączona do restartu workera. */
const RESTART_LIMIT = 3;

interface Pending {
  role: Role;
  res: (v: Float32Array[]) => void;
  rej: (e: Error) => void;
}

/** Zapytanie nie dostało wektora w limicie czasu (wołający idzie dalej na samym FTS). */
export class EmbedTimeoutError extends Error {
  constructor(ms: number) {
    super(`wektor zapytania: brak odpowiedzi w ${ms} ms`);
    this.name = "EmbedTimeoutError";
  }
}

export class ThreadEmbedder {
  private threads: Record<Role, Worker | null> = { zapytania: null, masowy: null };
  private heard: Record<Role, number> = { zapytania: 0, masowy: 0 };
  private pending = new Map<number, Pending>();
  private seq = 0;
  // to samo zapytanie bywa liczone kilka razy pod rząd (prompt: w projekcie i globalnie); trafienie nie czeka na wątek
  private queryCache = new Map<string, Float32Array>();
  /** zapytania w toku: drugie wyszukiwanie tym samym tekstem czeka na to samo zlecenie */
  private inflight = new Map<string, Promise<Float32Array[]>>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** bez pulsu dłużej niż tyle przy zleceniach w toku = wątek wisi */
  private hangMs: Record<Role, number>;
  /** chwile porzuceń zawieszonego wątku (ostatnia godzina) */
  private abandoned: Record<Role, number[]> = { zapytania: [], masowy: [] };
  /** role wyłączone po zbyt wielu porzuceniach (do restartu workera): powód */
  readonly disabled: Partial<Record<Role, string>> = {};
  /** model zapytań załadowany w wątku */
  loaded = false;
  device: string;
  bulkDevice: string | null = null;

  constructor(
    readonly cfg: EmbedConfig,
    opts: { hangMs?: number; bulkHangMs?: number } = {},
  ) {
    this.device = cfg.device;
    this.hangMs = { zapytania: opts.hangMs ?? 120_000, masowy: opts.bulkHangMs ?? 600_000 };
  }

  /** Wektory masowe wyłączone (wątek masowy wisiał za często): zaległość liczy zwykły wątek. */
  get bulkDisabled(): boolean {
    return !!this.disabled.masowy;
  }

  get modelId(): string {
    return `${this.cfg.model}`;
  }

  /** Zlecenia w toku (wysłane do wątków, bez odpowiedzi). */
  get queued(): number {
    return this.pending.size;
  }

  private thread(role: Role): Worker {
    const cur = this.threads[role];
    if (cur) return cur;
    // bieżące środowisko procesu (Bun bez tej opcji daje wątkowi środowisko z chwili startu procesu)
    const w = new Worker(new URL("./embed-thread.ts", import.meta.url).href, { env: { ...process.env } } as WorkerOptions);
    w.onmessage = (e: MessageEvent<ThreadOut>) => this.onMessage(role, w, e.data);
    w.onerror = (e) => {
      log.error(`wątek embeddingów (${role}): błąd`, String(e.message ?? e));
      this.reset(role, w, new Error(`wątek embeddingów: ${e.message ?? e}`));
    };
    // wątek zakończony sam (błąd poza kolejką): następne zlecenie startuje nowy
    w.addEventListener("close", () => this.reset(role, w, new Error("wątek embeddingów zakończony")));
    // wątek nie trzyma procesu przy życiu (worker kończy się sam po bezczynności)
    (w as unknown as { unref?: () => void }).unref?.();
    this.threads[role] = w;
    this.heard[role] = performance.now();
    w.postMessage({ op: "init", beatMs: Math.min(5000, Math.max(50, this.hangMs[role] / 4)) } satisfies ThreadIn);
    return w;
  }

  /**
   * Strażnik działa tylko przy zleceniach w toku i trzyma wtedy proces (ktoś czeka na wynik). Zegar bez odniesienia
   * (unref) Bun pomija, gdy nic innego nie trzyma pętli, i zawieszony wątek nie zostałby wykryty.
   */
  private watch(): void {
    if (!this.pending.size) {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
    } else {
      const every = Math.min(10_000, Math.max(25, Math.min(this.hangMs.zapytania, this.hangMs.masowy) / 4));
      this.watchdog ??= setInterval(() => this.checkHang(), every);
    }
  }

  private checkHang(): void {
    const now = performance.now();
    for (const role of ROLES) {
      const w = this.threads[role];
      if (!w || now - this.heard[role] <= this.hangMs[role]) continue;
      if (![...this.pending.values()].some((p) => p.role === role)) continue;
      const s = Math.round((now - this.heard[role]) / 1000);
      // stary wątek dostaje polecenie porzucenia kolejki i zwolnienia modeli: wykona je, gdy się odblokuje
      // (bez tego dokańczałby kolejkę równolegle z nowym wątkiem i trzymał model do końca procesu)
      try {
        w.postMessage({ op: "abandon" } satisfies ThreadIn);
      } catch {}
      const recent = this.abandoned[role].filter((t) => now - t < 3_600_000);
      recent.push(now);
      this.abandoned[role] = recent;
      if (recent.length >= RESTART_LIMIT) {
        this.disabled[role] =
          `wątek ${role} wisiał ${recent.length} razy w godzinie (ostatnio ${s} s bez odpowiedzi): wyłączony do restartu workera`;
        log.error(`wątek embeddingów: ${this.disabled[role]}`);
      } else log.error(`wątek embeddingów (${role}) nie odpowiada od ${s} s: porzucam go`);
      this.reset(role, w, new Error("wątek embeddingów nie odpowiada"));
    }
  }

  private onMessage(role: Role, w: Worker, m: ThreadOut): void {
    // porzucony wątek (zawieszony) może jeszcze coś przysłać: jego stan i wyniki już nas nie dotyczą
    if (this.threads[role] !== w) return;
    this.heard[role] = performance.now();
    if (m.op === "beat") return;
    if (m.op === "state") {
      if (role === "zapytania") {
        this.loaded = m.loaded;
        this.device = m.device;
      } else this.bulkDevice = m.bulkDevice;
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    this.watch();
    if (m.op === "done") p.res(m.vecs);
    else p.rej(new Error(m.error));
  }

  /** Odrzuca zlecenia wątku i zapomina go (bez terminate, zob. nagłówek). */
  private reset(role: Role, w: Worker, err: Error): void {
    if (this.threads[role] !== w) return;
    this.threads[role] = null;
    if (role === "zapytania") this.loaded = false;
    else this.bulkDevice = null;
    for (const [id, p] of this.pending)
      if (p.role === role) {
        this.pending.delete(id);
        p.rej(err);
      }
    this.watch();
  }

  private send(role: Role, m: ThreadIn): void {
    this.thread(role).postMessage(m);
  }

  /** Zaczyna ładować model zapytań w wątku (bez czekania). */
  warm(): void {
    if (this.loaded || this.disabled.zapytania) return;
    this.send("zapytania", { op: "warm" });
  }

  /**
   * Wektory znormalizowane. Priorytet w wątku: zapytania (0) przed wektorami notatek (1).
   * mode „bulk”: osobny wątek z modelem masowym (DirectML fp16, stałe kształty), zwalnianym przez releaseBulk().
   * `timeoutMs`: limit dla wołającego (ścieżki hooków); wynik spóźniony i tak trafia do pamięci podręcznej zapytań.
   */
  embed(
    texts: string[],
    kind: "query" | "passage",
    opts: { mode?: EmbedMode; prio?: number; timeoutMs?: number } = {},
  ): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    const mode = opts.mode ?? "query";
    const cacheable = kind === "query" && texts.length === 1 && mode === "query";
    let job: Promise<Float32Array[]>;
    if (cacheable) {
      const hit = this.queryCache.get(texts[0]);
      // trafienie też przez makrozadanie: prompt szuka w projekcie i zaraz globalnie, a bez tej przerwy oba
      // wyszukiwania (FTS do ok. 0,2 s każde) szłyby jednym blokiem pętli zdarzeń
      if (hit) return new Promise((res) => setTimeout(() => res([hit]), 0));
      job =
        this.inflight.get(texts[0]) ??
        this.request(texts, kind, mode, opts.prio).then((v) => {
          this.queryCache.set(texts[0], v[0]);
          if (this.queryCache.size > 32) this.queryCache.delete(this.queryCache.keys().next().value!);
          return v;
        });
      if (!this.inflight.has(texts[0])) {
        this.inflight.set(texts[0], job);
        const drop = () => this.inflight.delete(texts[0]);
        job.then(drop, drop);
      }
    } else job = this.request(texts, kind, mode, opts.prio);
    const ms = opts.timeoutMs;
    if (!ms) return job;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new EmbedTimeoutError(ms)), ms);
      job.then(
        (v) => {
          clearTimeout(t);
          res(v);
        },
        (e) => {
          clearTimeout(t);
          rej(e);
        },
      );
    });
  }

  private request(texts: string[], kind: "query" | "passage", mode: EmbedMode, prio?: number): Promise<Float32Array[]> {
    const id = ++this.seq;
    const role: Role = mode === "bulk" ? "masowy" : "zapytania";
    const off = this.disabled[role];
    if (off) return Promise.reject(new Error(`wektory wyłączone: ${off}`));
    return new Promise<Float32Array[]>((res, rej) => {
      this.pending.set(id, { role, res, rej });
      try {
        this.send(role, { op: "embed", id, texts, kind, mode, prio: prio ?? (kind === "query" ? 0 : 1) });
      } catch (e) {
        this.pending.delete(id);
        rej(e as Error);
      }
      this.watch();
    });
  }

  /** Zwalnia model masowy w wątku (po zaległości). */
  releaseBulk(): void {
    if (this.threads.masowy) this.send("masowy", { op: "release" });
  }

  /** Wyłączanie workera: odrzuca zlecenia w toku; wątki kończą się razem z procesem (process.exit). */
  dispose(): void {
    for (const role of ROLES) {
      const w = this.threads[role];
      if (w) this.reset(role, w, new Error("wątek embeddingów zamknięty"));
    }
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.queryCache.clear();
  }
}
