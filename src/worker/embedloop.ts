// Pętla embeddingów: dolicza wektory obserwacjom, które ich nie mają (nowe tury, import, edycje).
// Model liczy w wątku embeddingów (ThreadEmbedder), więc tu zostają tylko krótkie odczyty i zapisy bazy.
import { loadConfig } from "../config.ts";
import { getMeta, hasVectors } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import type { ThreadEmbedder } from "../index/embed-client.ts";
import { passageText, type TextEmbedder, toBits, toQ8 } from "../index/embedder.ts";
import { log } from "../log.ts";
import { track } from "./lag.ts";

/** Od tylu brakujących wektorów (import, backfill) liczymy masowo, na GPU jeśli jest. */
const BACKLOG = 1500;
/** Zapis wektorów w transakcjach po tyle wierszy, z oddechem między nimi (partia masowa ma ich 512). */
const WRITE_CHUNK = 64;

/** Liczy wektory dla partii notatek bez wektora. Zwraca liczbę przetworzonych (także pominiętych przy zapisie). */
export async function embedBatch(repo: Repo, embedder: TextEmbedder, batch: number): Promise<number> {
  const rows = track("wektory: kolejka", () => repo.missingVectors(batch));
  if (!rows.length) return 0;
  const texts = rows.map(passageText);
  // liczenie w wątku embeddingów: pętla workera w tym czasie obsługuje hooki
  const vecs = await track("wektory: liczenie", () => embedder.embed(texts, "passage"), { thread: true });
  const withBits = hasVectors();
  for (let at = 0; at < rows.length; at += WRITE_CHUNK) {
    if (at) await Bun.sleep(0);
    const part = rows.slice(at, at + WRITE_CHUNK);
    // w trakcie liczenia notatka mogła dostać nową treść (redigest) albo zniknąć (purge): zapisujemy tylko wektor
    // policzony z bieżącej treści, inaczej zostałby nieaktualny wektor (missingVectors już do niego nie wróci)
    // albo osierocony wiersz. IMMEDIATE: sprawdzenie i zapis pod jedną blokadą zapisu.
    track("wektory: zapis", () =>
      repo.db
        .transaction(() => {
          const now = repo.vectorSources(part.map((r) => r.id));
          part.forEach((r, k) => {
            const i = at + k;
            const cur = now.get(r.id);
            if (!cur || passageText(cur) !== texts[i]) return;
            repo.putVector(r.id, cur.project, embedder.modelId, toQ8(vecs[i]), toBits(vecs[i]), withBits);
          });
        })
        .immediate(),
    );
  }
  return rows.length;
}

export class EmbedLoop {
  private running = false;
  private wake: (() => void) | null = null;
  processed = 0;

  constructor(
    private repo: Repo,
    private embedder: ThreadEmbedder,
  ) {}

  notify(): void {
    this.wake?.();
  }

  async start(): Promise<void> {
    if (this.running || !loadConfig().embed.enabled) return;
    this.running = true;
    let backlogChecked = false;
    while (this.running) {
      try {
        // CLI liczy masowo na GPU — wtedy nie dublujemy pracy
        if (this.cliBulkActive()) {
          await this.sleep(15_000);
          continue;
        }
        if (!backlogChecked) {
          backlogChecked = true;
          const missing = track("wektory: licznik braków", () => this.repo.countMissingVectors());
          // wątek masowy wyłączony po zawieszeniach: zaległość idzie zwykłym wątkiem (wolniej, ale bez GPU)
          if (missing >= BACKLOG && !this.embedder.bulkDisabled) await this.drainBacklog(missing);
        }
        const n = await embedBatch(this.repo, this.embedder, 16);
        this.processed += n;
        if (n > 0) {
          await Bun.sleep(30); // oddech dla CPU
          continue;
        }
      } catch (e) {
        log.error("embed loop", e);
        await this.sleep(30_000);
        continue;
      }
      await this.sleep(60_000);
      backlogChecked = false;
    }
  }

  private cliBulkActive(): boolean {
    return Number(getMeta(this.repo.db, "bulk_embed_until") ?? 0) > Date.now();
  }

  /** Duża zaległość: osobny model masowy w wątku embeddingów (DirectML fp16, duże partie), zwalniany po skończeniu.
   *  Bez GPU spada na CPU i robi przerwy równe czasowi partii, żeby nie zająć maszyny. */
  private async drainBacklog(missing: number): Promise<void> {
    const cfg = loadConfig().embed;
    const bulk: TextEmbedder = {
      modelId: this.embedder.modelId,
      embed: (texts, kind) => this.embedder.embed(texts, kind, { mode: "bulk" }),
    };
    const t0 = performance.now();
    let done = 0;
    log.info("zaległość wektorów: liczę masowo", { missing, device: cfg.bulkDevice });
    try {
      while (this.running && !this.cliBulkActive()) {
        const tb = performance.now();
        const n = await embedBatch(this.repo, bulk, cfg.bulkBatch * 8);
        if (!n) break;
        done += n;
        this.processed += n;
        await Bun.sleep(this.embedder.bulkDevice === "cpu" ? Math.round(performance.now() - tb) : 5);
      }
    } finally {
      const device = this.embedder.bulkDevice;
      this.embedder.releaseBulk();
      log.info("zaległość wektorów policzona", { done, device, s: Math.round((performance.now() - t0) / 1000) });
    }
  }

  stop(): void {
    this.running = false;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.wake = null;
        res();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        res();
      };
    });
  }
}
