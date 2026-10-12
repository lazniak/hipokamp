// Spike: porównanie modeli embeddingów na mieszanych PL/EN zapytaniach technicznych.
// bun spikes/embed-compare.ts <model> <dtype> <device> <queryPrefix> <passagePrefix>
import { env, pipeline } from "@huggingface/transformers";
import { join } from "path";

env.cacheDir = join(process.env.USERPROFILE!, ".hipokamp", "models");
const [model = "Xenova/multilingual-e5-small", dtype = "q8", device = "cpu", qp = "query: ", pp = "passage: "] = process.argv.slice(2);

const passages = [
  "Orphaned LISTEN socket on Windows keeps port 37777 bound to a dead PID, worker refuses to start",
  "Watchdog zabija proces trzymający port, gdy /health nie odpowiada przez 20 sekund",
  "Dodano obsługę płatności Stripe w panelu klienta, webhook checkout.session.completed",
  "Hook UserPromptSubmit blokuje prompt po 3 kolejnych błędach (exit 2)",
  "Migracja repozytorium z GitHuba na Gitea: git push --mirror, origin zmieniony",
  "Fixed TypeScript error TS2345 in src/auth/session.ts by narrowing the union type",
  "Napisy w Premiere Pro generowane przez Whisper, eksport SRT",
  "Kolejka sync_outbox rośnie bez końca, gdy synchronizacja z chmurą jest wyłączona",
  "Blender: render miniatury do pliku PNG przez MCP",
  "FTS5 trigram tokenizer for substring search on file paths",
  "Telefonia: trunk SIP oferuje opus i g722 przed G.711",
  "Obserwator claude-mem wyczerpał tygodniowy limit subskrypcji, pamięć wstrzymana",
];
const queries: [string, number][] = [
  ["czemu worker nie startuje, port zajęty przez martwy proces", 0],
  ["prompt zablokowany przez hook pamięci", 3],
  ["jak przenieść repo na nasz serwer git", 4],
  ["database grows huge because outbox is never drained", 7],
  ["quota exhausted memory paused", 11],
  ["błąd typów w module sesji auth", 5],
  ["wyszukiwanie fragmentu ścieżki pliku", 9],
  ["kodeki szerokopasmowe w centralce", 10],
];

let t = performance.now();
const ex = await pipeline("feature-extraction", model, { dtype: dtype as any, device: device as any });
const loadMs = performance.now() - t;
const emb = async (xs: string[]) => (await ex(xs, { pooling: model.includes("Qwen3") ? "last_token" : model.includes("bge") ? "cls" : "mean", normalize: true })).tolist() as number[][];
t = performance.now();
const P = await emb(passages.map((p) => pp + p));
const Q = await emb(queries.map(([q]) => qp + q));
const encMs = performance.now() - t;
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
let hit1 = 0, mrr = 0;
for (let i = 0; i < Q.length; i++) {
  const ranked = P.map((p, j) => [j, dot(Q[i], p)] as [number, number]).sort((a, b) => b[1] - a[1]);
  const rank = ranked.findIndex(([j]) => j === queries[i][1]) + 1;
  if (rank === 1) hit1++;
  mrr += 1 / rank;
}
console.log(JSON.stringify({ model, dtype, device, dims: P[0].length, loadMs: Math.round(loadMs), encMs: Math.round(encMs), hit1: `${hit1}/${Q.length}`, mrr: +(mrr / Q.length).toFixed(3), rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
