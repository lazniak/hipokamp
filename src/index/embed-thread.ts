// Wątek embeddingów workera (Bun Worker, nie proces). onnxruntime-node liczy synchronicznie na wątku JS: run()
// i ładowanie modelu blokują go na sekundy (partia 16 długich notatek na CPU: ok. 4,5 s). Dlatego modele żyją tutaj,
// a pętla zdarzeń workera tylko wysyła teksty i odbiera wektory.
// Worker trzyma dwa takie wątki (embed-client.ts): zapytania i wektory nowych notatek w jednym, zaległość masową
// (model masowy, na GPU partie po 64) w drugim, więc zapytanie nigdy nie czeka na kawałek masowy.
// W wątku kolejka z priorytetem (zapytania przed wektorami notatek), duże zlecenia idą kawałkami, a między kawałkami
// wątek odbiera nowe wiadomości. Puls co kilka sekund mówi workerowi, że wątek nie wisi.
import { DATA_DIR, loadConfig } from "../config.ts";
import { initLog, log } from "../log.ts";
import { chunkSize } from "./embed-chunks.ts";
import { Embedder } from "./embedder.ts";

declare const self: Worker;

export type EmbedMode = "query" | "bulk";
export type ThreadIn =
  | { op: "init"; beatMs: number }
  | { op: "embed"; id: number; texts: string[]; kind: "query" | "passage"; mode: EmbedMode; prio: number }
  | { op: "warm" }
  | { op: "release" }
  /** wątek uznany za zawieszony: porzuca kolejkę, puls i modele (wykona po odblokowaniu) */
  | { op: "abandon" };
export interface ThreadState {
  op: "state";
  loaded: boolean;
  device: string;
  bulkLoaded: boolean;
  bulkDevice: string | null;
}
export type ThreadOut =
  | { op: "done"; id: number; vecs: Float32Array[] }
  | { op: "error"; id: number; error: string }
  | { op: "beat" }
  | ThreadState;

interface Model {
  readonly loaded: boolean;
  device: string;
  onState: (() => void) | null;
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
  ready(): Promise<void>;
  warm(): void;
  dispose(): Promise<void>;
}

/**
 * Model zastępczy tylko dla testów (HIPOKAMP_FAKE_EMBED_MS i katalog z „hipokamp-test”): wektor z hasha tekstu,
 * a liczenie blokuje wątek synchronicznie na podany czas na tekst, jak ONNX.
 */
class FakeModel implements Model {
  loaded = false;
  device = "fake";
  onState: (() => void) | null = null;
  constructor(
    private dims: number,
    private ms: number,
  ) {}
  warm(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onState?.();
  }
  async ready(): Promise<void> {
    this.warm();
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.warm();
    return texts.map((t) => {
      const until = performance.now() + this.ms;
      while (performance.now() < until) {}
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
      const v = new Float32Array(this.dims);
      let s = 0;
      for (let i = 0; i < this.dims; i++) {
        h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
        v[i] = h / 2 ** 31 - 1;
        s += v[i] * v[i];
      }
      const n = Math.sqrt(s) || 1;
      for (let i = 0; i < this.dims; i++) v[i] /= n;
      return v;
    });
  }
  async dispose(): Promise<void> {
    this.loaded = false;
    this.onState?.();
  }
}

initLog("worker");
const cfg = loadConfig().embed;
const fakeMs = process.env.HIPOKAMP_FAKE_EMBED_MS;
const fake = fakeMs !== undefined && DATA_DIR.includes("hipokamp-test");
const makeModel = (mode: EmbedMode): Model => (fake ? new FakeModel(cfg.dims, Number(fakeMs) || 0) : new Embedder(cfg, mode));

const query = makeModel("query");
let bulk: Model | null = null;
query.onState = postState;

interface Job {
  id: number;
  texts: string[];
  kind: "query" | "passage";
  mode: EmbedMode;
  prio: number;
  seq: number;
  /** kolejność liczenia (masowo: od najkrótszych, żeby kawałki trafiały w krótkie kubełki DirectML) */
  order: number[];
  next: number;
  out: Float32Array[];
}
const queue: Job[] = [];
let seq = 0;
let busy = false;
let lastState = "";
let beat: ReturnType<typeof setInterval> | null = null;
/** worker porzucił ten wątek (zawieszony): nic więcej nie liczy i nie wysyła */
let abandoned = false;

function postState(): void {
  const s: ThreadState = {
    op: "state",
    loaded: query.loaded,
    device: query.device,
    bulkLoaded: !!bulk?.loaded,
    bulkDevice: bulk ? bulk.device : null,
  };
  const key = JSON.stringify(s);
  if (key === lastState) return;
  lastState = key;
  self.postMessage(s);
}

function bulkModel(): Model {
  if (!bulk) {
    bulk = makeModel("bulk");
    bulk.onState = postState;
  }
  return bulk;
}

/** Zlecenie z kolejki (kolejkę mogło już wyczyścić porzucenie w trakcie liczenia). */
function drop(job: Job): void {
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
}

async function pump(): Promise<void> {
  if (busy || abandoned) return;
  busy = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const job = queue[0];
      const m = job.mode === "bulk" ? bulkModel() : query;
      try {
        // najpierw model (urządzenie znane po ewentualnym przejściu z GPU na CPU), potem kawałek właściwej wielkości;
        // dawniej zimny model liczył najpierw jeden tekst, co na DirectML dawało dodatkowy kształt (1, L)
        if (!m.loaded) await m.ready();
        const idx = job.order.slice(job.next, job.next + chunkSize(job, m.device, cfg.bulkBatch));
        const vecs = await m.embed(
          idx.map((i) => job.texts[i]),
          job.kind,
        );
        idx.forEach((i, k) => {
          job.out[i] = vecs[k];
        });
        job.next += idx.length;
        if (job.next >= job.texts.length) {
          drop(job);
          // bez listy transferu: wektor z pamięci podręcznej zapytań nie może zostać odłączony
          self.postMessage({ op: "done", id: job.id, vecs: job.out } satisfies ThreadOut);
        }
      } catch (e) {
        drop(job);
        self.postMessage({ op: "error", id: job.id, error: String((e as Error)?.message ?? e) } satisfies ThreadOut);
      }
      if (abandoned) return;
      postState();
      self.postMessage({ op: "beat" } satisfies ThreadOut);
      // oddech: wiadomości, które przyszły w trakcie liczenia (zapytania), trafiają do kolejki przed kolejnym kawałkiem
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e: MessageEvent<ThreadIn>) => {
  const m = e.data;
  if (abandoned) return;
  if (m.op === "abandon") {
    // worker uznał wątek za zawieszony i ma już nowy: bez dalszej pracy, pulsu ani modeli (wątek żyje do końca
    // procesu, bo terminate() z onnxruntime-node wywraca Bun)
    abandoned = true;
    queue.length = 0;
    if (beat) clearInterval(beat);
    beat = null;
    for (const md of [bulk, query]) void md?.dispose().catch(() => {});
    bulk = null;
    log.warn("wątek embeddingów porzucony przez workera: kolejka odrzucona, modele zwolnione");
  } else if (m.op === "init") {
    // puls także przy pobieraniu modelu (wątek wolny); ustaje tylko, gdy wątek stoi w synchronicznym liczeniu
    if (beat) clearInterval(beat);
    beat = setInterval(() => self.postMessage({ op: "beat" } satisfies ThreadOut), Math.max(50, m.beatMs));
  } else if (m.op === "embed") {
    const order = m.texts.map((_, i) => i);
    if (m.mode === "bulk") order.sort((a, b) => m.texts[a].length - m.texts[b].length);
    queue.push({ ...m, seq: ++seq, order, next: 0, out: new Array(m.texts.length) });
    void pump();
  } else if (m.op === "warm") {
    query.warm();
  } else if (m.op === "release") {
    const b = bulk;
    bulk = null;
    void b
      ?.dispose()
      .catch((err) => log.warn("wątek embeddingów: zwalnianie modelu masowego", String(err)))
      .finally(postState);
  }
};
