// „Sen” — konsolidacja offline (bez LLM): scalanie niemal identycznych notatek, przycinanie logów,
// archiwizacja starych i nieużywanych epizodów, zastępowanie starszych decyzji z digestu nowszymi, sprzątanie
// osieroconych wektorów binarnych. Uruchamiany przez workera w bezczynności (raz na dobę) albo CLI. Pracuje kawałkami
// po ok. 40 ms z przerwą między nimi: worker ma jeden wątek JS, a pierwszy sen po instalacji przegląda tysiące notatek.
// Opcjonalny etap z lokalnym LLM (sleepLlm) jest osobno: domyślnie wyłączony, trwa minuty, a worker przerywa go
// pierwszym żądaniem; moduł LLM ładuje się dopiero wtedy, gdy etap jest włączony.
import type { Database } from "bun:sqlite";
import { llmConfig, refreshConfig } from "../config.ts";
import { loggedProposals, logPair, pairKey, supersedeMode, supersedeSimilar } from "../core/supersede.ts";
import { getMeta, hasVectors, setMeta } from "../db/db.ts";
import type { Repo } from "../db/repo.ts";
import { cosQ8 } from "../index/vectors.ts";
// tylko typy: sam moduł LLM ładuje się w sleepLlm, gdy etap jest włączony
import type { LlmReport, LlmRunOptions } from "../llm/consolidate.ts";
import { log } from "../log.ts";
import { slicer } from "../util/slice.ts";
import { normKey } from "../util/text.ts";

export interface SleepReport {
  merged: number;
  /** Starsze decyzje i preferencje z digestu zastąpione nowszymi o tym samym temacie (core/supersede.ts, tryb „apply”). */
  superseded: number;
  /**
   * Nowe pary zastąpienia tylko zapisane w logs/sleep-*.jsonl, bez zmiany w bazie (tryb „propose”, domyślny); para
   * zaproponowana w poprzednim śnie nie liczy się drugi raz. Zastosowanie: `hipokamp supersede --ids`.
   */
  proposed: number;
  archived: number;
  prunedAccess: number;
  prunedInjections: number;
  /** usunięte wiersze obs_vec_bits notatek usuniętych i scalonych */
  orphanVectors: number;
  /** aktywne notatki bez bitów, oddane do przeliczenia wektora */
  requeuedVectors: number;
  ms: number;
}

const DAY = 86_400_000;

function jaccard(a: string, b: string): number {
  const A = new Set(
    normKey(a)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  const B = new Set(
    normKey(b)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}

/**
 * Scala `older` z `newer` w jednej transakcji: statusy czytane w transakcji (nie z listy sprzed pętli),
 * a cel idzie po łańcuchu merged_into do aktywnej notatki. Zwraca id celu albo null (nic nie scalono).
 */
function mergeInto(repo: Repo, older: number, newer: number): number | null {
  const db = repo.db;
  const st = db.query("SELECT status, merged_into FROM observations WHERE id = ?");
  return db
    .transaction((): number | null => {
      const a = st.get(older) as { status: string } | null;
      if (a?.status !== "active") return null;
      let target = newer;
      const seen = new Set<number>([older]);
      for (;;) {
        if (seen.has(target)) return null;
        seen.add(target);
        const t = st.get(target) as { status: string; merged_into: number | null } | null;
        if (!t) return null;
        if (t.status === "active") break;
        if (t.status !== "merged" || !t.merged_into) return null;
        target = t.merged_into;
      }
      repo.setStatus(older, "merged", { mergedInto: target });
      db.run(
        "UPDATE observations SET occurrence_count = occurrence_count + (SELECT occurrence_count FROM observations WHERE id = ?), importance = CASE WHEN occurrence_count < 3 THEN MIN(1, importance + 0.04) ELSE importance END WHERE id = ?",
        [older, target],
      );
      // dostępy, log dostępu i wstrzyknięcia (sesja, która widziała starszą, nie dostanie celu drugi raz)
      repo.moveUsage(older, target);
      return target;
    })
    .immediate();
}

/** Scala duplikaty wśród świeżych notatek (starszą oznacza jako merged → nowsza dostaje jej ślady). */
export async function mergeDuplicates(repo: Repo, sinceMs: number, limit = 5000, pause = slicer()): Promise<number> {
  if (!hasVectors()) return 0;
  const db = repo.db;
  const fresh = db
    .query(
      "SELECT o.id, o.project, o.type, o.title, o.created_at, o.content_hash FROM observations o JOIN obs_vectors v ON v.obs_id = o.id WHERE o.status='active' AND o.created_at >= ? ORDER BY o.created_at DESC LIMIT ?",
    )
    .all(sinceMs, limit) as {
    id: number;
    project: string;
    type: string;
    title: string;
    created_at: number;
    content_hash: string | null;
  }[];
  const bitsOf = db.query("SELECT emb FROM obs_vec_bits WHERE obs_id = ?");
  // kolumna bit[] zwraca surowy blob; bez vec_bit() sqlite-vec bierze go za float32 i odrzuca zapytanie
  const knn = db.query("SELECT obs_id FROM obs_vec_bits WHERE emb MATCH vec_bit(?) AND k = 12 AND project = ?");
  let merged = 0;
  let errors = 0;
  const done = new Set<number>();
  for (const o of fresh) {
    // każde wyszukiwanie sąsiadów to ok. 0,5 ms, a notatek do 5000: oddech co ok. 40 ms
    await pause();
    if (done.has(o.id)) continue;
    const vec = repo.getVectorsQ8([o.id]).get(o.id);
    if (!vec) continue;
    // sąsiedzi z wektorów binarnych w tym samym projekcie
    let cands: { obs_id: number }[] = [];
    try {
      const bits = bitsOf.get(o.id) as { emb: Uint8Array } | null;
      if (!bits) continue;
      cands = knn.all(bits.emb, o.project.toLowerCase()) as { obs_id: number }[];
    } catch (e) {
      // błąd nie może znikać po cichu (tak sen długo nic nie scalał); log raz, liczba wszystkich na końcu
      if (!errors++) log.error("sen: wyszukiwanie sąsiadów nieudane", e);
      continue;
    }
    const others = cands.map((c) => c.obs_id).filter((id) => id !== o.id && !done.has(id));
    if (!others.length) continue;
    const vecs = repo.getVectorsQ8(others);
    for (const other of repo.getObservations(others)) {
      // o jest już scalona z nowszą notatką: nic więcej do niej nie scalamy (łańcuch merged → merged)
      if (done.has(o.id)) break;
      if (done.has(other.id) || other.status !== "active" || other.type !== o.type) continue;
      if (Math.abs(other.created_at - o.created_at) > 45 * DAY) continue;
      const v = vecs.get(other.id);
      if (!v || cosQ8(vec, v) < 0.965 || jaccard(o.title, other.title) < 0.45) continue;
      // remis czasu rozstrzyga skrót treści (ten sam na każdym komputerze), nie kolejność pętli ani numer lokalny:
      // dwie maszyny scalają tę samą parę w tę samą stronę (inaczej X w Y i Y w X po synchronizacji, docs/SYNC.md)
      const otherFirst =
        other.created_at !== o.created_at
          ? other.created_at < o.created_at
          : (other.content_hash ?? "") !== (o.content_hash ?? "")
            ? (other.content_hash ?? "") < (o.content_hash ?? "")
            : other.id < o.id;
      const [older, newer] = otherFirst ? [other.id, o.id] : [o.id, other.id];
      if (mergeInto(repo, older, newer) === null) continue;
      done.add(older);
      merged++;
    }
  }
  if (errors > 1) log.error("sen: nieudane wyszukiwania sąsiadów", { errors });
  return merged;
}

/** Sprząta wiersze obs_vec_bits notatek usuniętych i scalonych (T-08) kawałkami po 2000 przejrzanych. Zwraca liczbę usuniętych. */
export async function pruneOrphanVectors(repo: Repo, pause = slicer()): Promise<number> {
  if (!hasVectors()) return 0;
  let removed = 0;
  let after = 0;
  for (;;) {
    const { ids, last } = repo.orphanVectorBits(after, 2000);
    for (let i = 0; i < ids.length; i += 500) {
      removed += repo.deleteOrphanVectorBits(ids.slice(i, i + 500));
      await pause();
    }
    if (last === null) break;
    after = last;
    await pause();
  }
  return removed;
}

/**
 * Samoleczenie: aktywna notatka z q8, ale bez bitów (powrót ze scalenia albo surowy UPDATE statusu w innym kodzie)
 * dostaje wektor do przeliczenia. Kawałki po 2000 przejrzanych. Zwraca liczbę oddanych do przeliczenia.
 */
export async function requeueVectorsWithoutBits(repo: Repo, pause = slicer()): Promise<number> {
  if (!hasVectors()) return 0;
  let n = 0;
  let after = 0;
  for (;;) {
    const page = repo.activeWithoutBits(after, 2000);
    if (!page) return n;
    n += repo.requeueVectors(page.ids);
    await pause();
    if (page.last === null) return n;
    after = page.last;
  }
}

/**
 * Jedna linia o śnie do `status` i `doctor`: wynik ostatniego snu (w trybie „propose” liczba par czekających na
 * decyzję użytkownika, sprzątanie wektorów) i tryb zastępowania z digestu.
 */
export function sleepStatus(db: Database): string {
  // z pliku, jak w samym śnie (worker czyta konfigurację przy każdym przebiegu)
  const mode = supersedeMode(refreshConfig().consolidation.supersedeDigest);
  const modeText =
    mode === "apply"
      ? "zastępowanie z digestu: zapis (apply)"
      : mode === "off"
        ? "zastępowanie z digestu: wyłączone"
        : "zastępowanie z digestu: tylko propozycje (propose; podgląd: hipokamp supersede --dry-run, wybrane: --ids)";
  const at = Number(getMeta(db, "last_sleep_at") ?? 0);
  let rep: Partial<SleepReport> = {};
  try {
    rep = JSON.parse(getMeta(db, "last_sleep_report") ?? "{}");
  } catch {}
  if (!at) return `jeszcze nie było (worker robi go w bezczynności, ręcznie: hipokamp sleep); ${modeText}`;
  return `${new Date(at).toLocaleString("pl-PL")}, scalone ${rep.merged ?? 0}, zastąpione ${rep.superseded ?? 0}, zaproponowane ${rep.proposed ?? 0}, archiwum ${rep.archived ?? 0}, usunięte osierocone wektory ${rep.orphanVectors ?? 0}, do przeliczenia ${rep.requeuedVectors ?? 0}; ${modeText}`;
}

let running: Promise<SleepReport> | null = null;

/** Trwający sen albo null (worker nie liczy drugiego wywołania jako osobnego zadania). */
export function sleepInProgress(): Promise<SleepReport> | null {
  return running;
}

/**
 * Jeden sen naraz (jedyna blokada snu): sen oddaje sterowanie pętli workera, więc następny tick (albo
 * /api/admin/sleep) mógłby zacząć drugi przebieg, zanim pierwszy zapisze last_sleep_at. Drugie wywołanie dostaje
 * ten sam wynik.
 */
export function sleep(repo: Repo, opts: { full?: boolean } = {}): Promise<SleepReport> {
  if (!running)
    running = sleepOnce(repo, opts).finally(() => {
      running = null;
    });
  return running;
}

async function sleepOnce(repo: Repo, opts: { full?: boolean }): Promise<SleepReport> {
  const t0 = performance.now();
  const db = repo.db;
  const pause = slicer();
  const last = Number(getMeta(db, "last_sleep_at") ?? 0);
  const since = opts.full || !last ? Date.now() - 120 * DAY : last - 2 * DAY;
  const merged = await mergeDuplicates(repo, since, 5000, pause);
  // po scaleniu duplikatów: to samo, ale inaczej (nowsza decyzja o tym samym temacie) zastępuje starszą. Domyślnie
  // tylko propozycje (logs/sleep-RRRR-MM-DD.jsonl, `hipokamp supersede --dry-run`), zapis w trybie „apply”.
  // Okno zaczyna się najpóźniej od notatki, której para czekała w poprzednim śnie na wektory. Konfiguracja czytana
  // z pliku przy każdym śnie: worker żyje długo, a `status` pokazuje tryb z pliku.
  const mode = supersedeMode(refreshConfig().consolidation.supersedeDigest);
  let superseded = 0;
  let proposed = 0;
  if (mode !== "off") {
    const waiting = Number(getMeta(db, "supersede_pending_since") ?? 0);
    const from = waiting > 0 ? Math.max(Math.min(since, waiting), Date.now() - 120 * DAY) : since;
    let pendingSince = 0;
    const pairs = await supersedeSimilar(repo, from, {
      pause,
      dryRun: mode === "propose",
      logPairs: mode === "apply",
      onPending: (at) => {
        if (!pendingSince || at < pendingSince) pendingSince = at;
      },
    });
    setMeta(db, "supersede_pending_since", String(pendingSince));
    if (mode === "apply") superseded = pairs.length;
    else {
      // okna kolejnych snów nachodzą na siebie (2 dni): para już zaproponowana nie trafia do logu drugi raz
      const seen = new Set(loggedProposals(from - DAY).map(pairKey));
      for (const p of pairs)
        if (!seen.has(pairKey(p))) {
          logPair(p, "propose");
          proposed++;
        }
    }
  }

  // log dostępu: najwyżej 64 ostatnie zdarzenia na notatkę (resztę niesie access_count/last_access_at);
  // kawałkami po 2000 notatek (indeks ix_access_obs), żeby zapytanie z oknem nie przechodziło całej tabeli naraz
  let pa = 0;
  const nextIds = db.query("SELECT DISTINCT obs_id FROM access_log WHERE obs_id > ? ORDER BY obs_id LIMIT 2000");
  for (let after = Number.MIN_SAFE_INTEGER; ; ) {
    const ids = nextIds.all(after) as { obs_id: number }[];
    if (!ids.length) break;
    const hi = ids[ids.length - 1].obs_id;
    pa += db.run(
      `DELETE FROM access_log WHERE rowid IN (
         SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY obs_id ORDER BY at DESC) rn
                            FROM access_log WHERE obs_id BETWEEN ? AND ?) WHERE rn > 64)`,
      [ids[0].obs_id, hi],
    ).changes;
    after = hi;
    await pause();
  }
  const pi = db.run("DELETE FROM injections WHERE at < ?", [Date.now() - 60 * DAY]).changes;
  db.run("DELETE FROM file_injections WHERE at < ?", [Date.now() - 30 * DAY]);
  db.run("DELETE FROM jobs WHERE status = 'failed' AND updated_at < ?", [Date.now() - 14 * DAY]);
  // dziennik zmian statusu potrzebny jest tylko strumieniowi podglądu (dosłanie po zerwaniu połączenia)
  repo.pruneStatusLog(Date.now() - 30 * DAY);
  await pause();

  // archiwum: stare, mało ważne, nigdy nieużyte epizody odkrywcze/zmiany (dalej do znalezienia w search z includeArchived);
  // notatka przywrócona ręcznie z archiwum snu (meta.restored_at) zostaje aktywna, inaczej sen odkładałby ją co dobę.
  // Liczba przez RETURNING: .changes w Bunie liczy też wiersze dopisane przez wyzwalacz tr_obs_status (podwojona)
  const archived = db
    .query(
      `UPDATE observations SET status = 'archived', updated_at = ?
       WHERE status = 'active' AND tier = 'episodic' AND type IN ('discovery','change') AND importance < 0.3
         AND access_count = 0 AND created_at < ?
         AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.restored_at') IS NULL ELSE 1 END
       RETURNING id`,
    )
    .all(Date.now(), Date.now() - 365 * DAY).length;
  // na końcu: obejmuje też notatki scalone w tym przebiegu (drugi sen nie ma już nic do zrobienia)
  const orphanVectors = await pruneOrphanVectors(repo, pause);
  const requeuedVectors = await requeueVectorsWithoutBits(repo, pause);

  setMeta(db, "last_sleep_at", String(Date.now()));
  const rep: SleepReport = {
    merged,
    superseded,
    proposed,
    archived,
    prunedAccess: pa,
    prunedInjections: pi,
    orphanVectors,
    requeuedVectors,
    ms: Math.round(performance.now() - t0),
  };
  setMeta(db, "last_sleep_report", JSON.stringify(rep));
  log.info("sen zakończony", rep);
  return rep;
}

/** Czy pora na etap z LLM: włączony, worker bezczynny co najmniej `minIdleMin`, ostatni przebieg dawniej niż `everyHours`. */
export function llmStageDue(db: Database, idleMin: number, now = Date.now()): boolean {
  const l = llmConfig();
  if (!l || idleMin < l.minIdleMin) return false;
  return now - Number(getMeta(db, "last_llm_at") ?? 0) > l.everyHours * 3_600_000;
}

/** Etap snu z lokalnym LLM (sprzeczności i lekcje); null, gdy wyłączony w konfiguracji. */
export async function sleepLlm(repo: Repo, opts: LlmRunOptions = {}): Promise<LlmReport | null> {
  const l = llmConfig();
  if (!l) return null;
  const { llmConsolidate } = await import("../llm/consolidate.ts");
  return llmConsolidate(repo, l, opts);
}
