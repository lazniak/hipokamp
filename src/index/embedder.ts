// Lokalne embeddingi (transformers.js + ONNX Runtime). Zero kosztów API.
// Model ładowany leniwie i zwalniany po bezczynności, żeby worker nie trzymał 1,5 GB RAM bez potrzeby.
import type { EmbedConfig } from "../config.ts";
import { paths } from "../config.ts";
import { log } from "../log.ts";

/** Stałe długości wejścia trybu masowego. DirectML liczy plan raz na kształt, więc kilka stałych kształtów
 *  zamiast setek zmiennych daje stałą, wysoką przepustowość (pomiar: spikes/embed-shapes.ts). */
const BUCKETS = [128, 256, 512];

/** To, czego potrzebuje wyszukiwanie i pętla wektorów: model w procesie (CLI) albo wątek embeddingów workera. */
export type TextEmbedder = Pick<Embedder, "embed" | "modelId">;

export class Embedder {
  /** Wywoływane po załadowaniu i zwolnieniu modelu (wątek embeddingów zgłasza stan workerowi). */
  onState: (() => void) | null = null;
  private ext: any = null;
  private loading: Promise<any> | null = null;
  private raw: { tok: any; model: any } | null = null;
  private rawLoading: Promise<{ tok: any; model: any }> | null = null;
  private lastUse = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queryCache = new Map<string, Float32Array>();
  device: string;
  dtype: string;

  constructor(
    readonly cfg: EmbedConfig,
    readonly mode: "query" | "bulk" = "query",
  ) {
    this.device = mode === "bulk" ? cfg.bulkDevice : cfg.device;
    this.dtype = mode === "bulk" ? cfg.bulkDtype : cfg.dtype;
  }

  get modelId(): string {
    return `${this.cfg.model}`;
  }

  get loaded(): boolean {
    return !!this.ext || !!this.raw;
  }

  /** Tryb masowy: tokenizer i model osobno, żeby dopełniać do stałych kubełków (pipeline dopełnia do najdłuższego). */
  private async loadRaw(): Promise<{ tok: any; model: any }> {
    if (this.raw) return this.raw;
    if (this.rawLoading) return this.rawLoading;
    this.rawLoading = (async () => {
      const t0 = performance.now();
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = paths.models();
      tf.env.allowLocalModels = true;
      const tok = await tf.AutoTokenizer.from_pretrained(this.cfg.model);
      let model: any;
      try {
        model = await tf.AutoModel.from_pretrained(this.cfg.model, { dtype: this.dtype as any, device: this.device as any });
      } catch (e) {
        if (this.device === "cpu") throw e;
        log.warn(`embedder masowy: ${this.device}/${this.dtype} niedostępne, przechodzę na cpu/q8`, e);
        this.device = "cpu";
        this.dtype = "q8";
        model = await tf.AutoModel.from_pretrained(this.cfg.model, { dtype: "q8" as any, device: "cpu" as any });
      }
      log.info("embedder masowy załadowany", {
        model: this.cfg.model,
        device: this.device,
        dtype: this.dtype,
        ms: Math.round(performance.now() - t0),
      });
      this.raw = { tok, model };
      this.onState?.();
      return this.raw;
    })();
    try {
      return await this.rawLoading;
    } finally {
      this.rawLoading = null;
    }
  }

  /** Sortuje teksty po długości, partie o stałym rozmiarze i długości kubełka, pooling (CLS albo średnia), normalizacja. */
  private async embedBucketed(texts: string[]): Promise<Float32Array[]> {
    const { tok, model } = await this.loadRaw();
    const maxLen = BUCKETS[BUCKETS.length - 1];
    const lens = texts.map((t) => Math.min(maxLen, tok(t, { truncation: true, max_length: maxLen }).input_ids.dims[1] as number));
    const order = texts.map((_, i) => i).sort((a, b) => lens[a] - lens[b]);
    // GPU (DirectML): zawsze pełna partia, bo każdy nowy kształt to kompilacja grafu (spadek z 29/s do ok. 3/s);
    // CPU: partia nie większa niż zlecenie (dopełnianie kosztowałoby tylko czas)
    const bs = this.device === "cpu" ? Math.max(1, Math.min(this.cfg.bulkBatch, texts.length)) : Math.max(1, this.cfg.bulkBatch);
    const out: Float32Array[] = new Array(texts.length);
    for (let i = 0; i < order.length; i += bs) {
      const idx = order.slice(i, i + bs);
      const L = BUCKETS.find((b) => b >= lens[idx[idx.length - 1]]) ?? maxLen;
      const batch = idx.map((j) => texts[j]);
      // stały rozmiar partii to też stały kształt: niepełną partię dopełniamy powtórzeniem
      while (batch.length < bs) batch.push(batch[batch.length - 1]);
      const enc = tok(batch, { padding: "max_length", truncation: true, max_length: L });
      const res = await model(enc);
      const h = hiddenStates(res).to("float32");
      const [, seq, dim] = h.dims as number[];
      const data = h.data as Float32Array;
      const mask = this.cfg.pooling === "mean" ? (enc.attention_mask.data as ArrayLike<number | bigint>) : null;
      idx.forEach((j, b) => {
        out[j] = poolHidden(data, b, seq, dim, mask, this.cfg.pooling);
      });
    }
    return out;
  }

  private async load(): Promise<any> {
    if (this.ext) return this.ext;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const t0 = performance.now();
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = paths.models();
      tf.env.allowLocalModels = true;
      try {
        this.ext = await tf.pipeline("feature-extraction", this.cfg.model, {
          dtype: this.dtype as any,
          device: this.device as any,
        });
      } catch (e) {
        if (this.device !== "cpu") {
          log.warn(`embedder: ${this.device}/${this.dtype} niedostępne, przechodzę na cpu/q8`, e);
          this.device = "cpu";
          this.dtype = "q8";
          this.ext = await tf.pipeline("feature-extraction", this.cfg.model, { dtype: "q8" as any, device: "cpu" as any });
        } else throw e;
      }
      log.info("embedder załadowany", {
        model: this.cfg.model,
        device: this.device,
        dtype: this.dtype,
        ms: Math.round(performance.now() - t0),
      });
      if (this.mode === "query" && !this.timer) {
        this.timer = setInterval(() => void this.unloadIfIdle(), 60_000);
        (this.timer as any).unref?.();
      }
      this.onState?.();
      return this.ext;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** Ładuje model i czeka (wątek embeddingów: przed pierwszym kawałkiem musi znać urządzenie po ewentualnym przejściu na CPU). */
  async ready(): Promise<void> {
    this.lastUse = Date.now();
    if (this.mode === "bulk") await this.loadRaw();
    else await this.load();
  }

  /** Zaczyna ładować model w tle (bez czekania). Ścieżki z twardym limitem czasu nie czekają na rozruch ONNX. */
  warm(): void {
    // bez tego zegar zwalniania (co 60 s) uznałby świeżo ładowany model za bezczynny i od razu go zwolnił
    this.lastUse = Date.now();
    if (this.ext || this.loading) return;
    void this.load().catch((e) => log.warn("embedder: ładowanie w tle nieudane", String(e)));
  }

  async unloadIfIdle(): Promise<void> {
    if (!this.ext || Date.now() - this.lastUse < this.cfg.idleUnloadMin * 60_000) return;
    try {
      await this.ext.dispose?.();
    } catch {}
    this.ext = null;
    log.info("embedder zwolniony (bezczynność)");
    this.onState?.();
  }

  /** Zwalnia model natychmiast (embedder masowy po zaległości). */
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.ext?.dispose?.();
      await this.raw?.model?.dispose?.();
    } catch {}
    this.ext = null;
    this.raw = null;
    this.queryCache.clear();
    this.onState?.();
  }

  /** Wektory znormalizowane (cosinus = iloczyn skalarny). */
  async embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    // to samo zapytanie bywa liczone kilka razy pod rząd (prompt: szukanie w projekcie i globalnie)
    if (kind === "query" && texts.length === 1 && this.mode !== "bulk") {
      const hit = this.queryCache.get(texts[0]);
      if (hit) {
        this.lastUse = Date.now();
        return [hit];
      }
      const [v] = await this.embedRaw(texts, kind);
      this.queryCache.set(texts[0], v);
      if (this.queryCache.size > 32) this.queryCache.delete(this.queryCache.keys().next().value!);
      return [v];
    }
    return this.embedRaw(texts, kind);
  }

  private async embedRaw(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const prefix = kind === "query" ? this.cfg.queryPrefix : this.cfg.passagePrefix;
    // masowo (zaległość, import): stałe kształty; ścieżka kubełkowa liczy pooling CLS (bge-m3, arctic) i średni (e5)
    if (this.mode === "bulk") {
      const res = await this.embedBucketed(texts.map((t) => prefix + t));
      this.lastUse = Date.now();
      return res;
    }
    const ext = await this.load();
    this.lastUse = Date.now();
    const out = await ext(
      texts.map((t) => prefix + t),
      { pooling: this.cfg.pooling, normalize: true },
    );
    const dims = out.dims[out.dims.length - 1];
    const res: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) res.push(out.data.slice(i * dims, (i + 1) * dims));
    this.lastUse = Date.now();
    return res;
  }
}

/**
 * Ukryte stany z wyniku modelu, jak w pipeline feature-extraction: `last_hidden_state`, a gdy go brak `logits` albo
 * `token_embeddings` (eksporty ONNX z sentence-transformers, np. arctic).
 */
export function hiddenStates(out: Record<string, any>): { to(dtype: string): { dims: number[]; data: Float32Array } } {
  const h = out.last_hidden_state ?? out.logits ?? out.token_embeddings;
  if (!h)
    throw new Error(`model nie zwraca last_hidden_state, logits ani token_embeddings (wyjścia: ${Object.keys(out).join(", ")})`);
  return h;
}

/**
 * Wektor jednego tekstu z partii ukrytych stanów modelu (`data` = [partia, seq, dim] płasko): CLS (pierwszy token) albo
 * średnia po tokenach, które nie są dopełnieniem (`mask` = attention_mask partii, [partia, seq]; bez maski wszystkie tokeny); potem norma L2.
 */
export function poolHidden(
  data: Float32Array,
  row: number,
  seq: number,
  dim: number,
  mask: ArrayLike<number | bigint> | null,
  pooling: "cls" | "mean",
): Float32Array {
  const base = row * seq * dim;
  let v: Float32Array;
  if (pooling === "mean") {
    v = new Float32Array(dim);
    let n = 0;
    for (let t = 0; t < seq; t++) {
      if (mask && Number(mask[row * seq + t]) === 0) continue;
      n++;
      for (let k = 0; k < dim; k++) v[k] += data[base + t * dim + k];
    }
    if (n > 0) for (let k = 0; k < dim; k++) v[k] /= n;
  } else v = data.slice(base, base + dim);
  let s = 0;
  for (let k = 0; k < dim; k++) s += v[k] * v[k];
  const norm = Math.sqrt(s) || 1;
  for (let k = 0; k < dim; k++) v[k] /= norm;
  return v;
}

/** int8 (skala 127) — do dokładnego przeliczenia kandydatów. */
export function toQ8(v: Float32Array): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  return q;
}

/** Bity znaku w kolejności sqlite-vec (bit i → bajt i>>3, pozycja i&7). */
export function toBits(v: Float32Array | Int8Array): Uint8Array {
  const b = new Uint8Array(Math.ceil(v.length / 8));
  for (let i = 0; i < v.length; i++) if (v[i] > 0) b[i >> 3] |= 1 << (i & 7);
  return b;
}

/** Tekst obserwacji do embeddingu (≈ do 500 tokenów). */
export function passageText(o: {
  title: string;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string[] | string;
  concepts?: string[] | string;
}): string {
  const facts = Array.isArray(o.facts) ? o.facts : safeArr(o.facts);
  const concepts = Array.isArray(o.concepts) ? o.concepts : safeArr(o.concepts);
  const s = [o.title, o.subtitle ?? "", facts.join("\n"), o.narrative ?? "", concepts.filter((c) => !c.includes(":")).join(", ")]
    .filter(Boolean)
    .join("\n");
  return s.length > 1800 ? s.slice(0, 1800) : s;
}

function safeArr(s: unknown): string[] {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
