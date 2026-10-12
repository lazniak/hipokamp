// Podział zlecenia wektorów na kawałki w wątku embeddingów (osobny moduł: czysta funkcja do testów).

/** Kawałek na CPU: tyle znaków, ile ma jedna długa notatka (passageText tnie na 1800), ok. 0,3 s liczenia. */
export const CPU_CHUNK_CHARS = 1800;

export interface ChunkJob {
  texts: string[];
  kind: "query" | "passage";
  mode: "query" | "bulk";
  /** kolejność liczenia (masowo: od najkrótszych) */
  order: number[];
  next: number;
}

/**
 * Ile tekstów w następnym kawałku. Model jest już załadowany (wątek czeka na `ready()` przed pierwszym kawałkiem),
 * więc urządzenie jest znane. Zapytanie w całości. Masowo na GPU zawsze pełna partia `bulkBatch`: DirectML kompiluje
 * graf dla każdego kształtu, a reszta zlecenia dopełnia się w `embedBucketed` do tej samej partii. Na CPU kształt nie
 * ma znaczenia, liczy się czas: kawałek po budżecie znaków (ok. jedna długa notatka).
 */
export function chunkSize(job: ChunkJob, device: string, bulkBatch: number): number {
  const left = job.order.length - job.next;
  if (job.kind === "query") return left;
  if (job.mode === "bulk" && device !== "cpu") return Math.min(left, Math.max(1, bulkBatch));
  let n = 0;
  let chars = 0;
  while (job.next + n < job.order.length) {
    chars += job.texts[job.order[job.next + n]].length;
    if (n > 0 && chars > CPU_CHUNK_CHARS) break;
    n++;
  }
  return n;
}
