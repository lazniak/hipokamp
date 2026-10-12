#!/usr/bin/env bun
// Demo podglądu na wymyślonych danych: tymczasowy HIPOKAMP_HOME (katalog z „hipokamp-test” w nazwie), wektory
// wyłączone (bez pobierania modelu, wyszukiwanie po słowach), syntetyczne sesje Claude Code w tymczasowym CLAUDE_CONFIG_DIR, zapis
// przez prawdziwy backfill, listy pracy i jawne decyzje, worker na osobnym porcie. Prawdziwa baza, ustawienia
// Claude Code i inne harnessy nie są dotykane (wszystkie harnessy i Codex wyłączone w config.json demo).
// Użycie: bun run demo [--port 47801] [--keep]   (Ctrl+C kończy i sprząta katalog, --keep go zostawia)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? (argv[i + 1] ?? "") : null;
};
const portArg = flag("port");
const PORT = portArg === null ? 47801 : Number(portArg);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("demo: --port wymaga numeru portu (1 do 65535), np. bun run demo --port 47801");
  process.exit(1);
}
const KEEP = argv.includes("--keep");
const REPO = resolve(import.meta.dir, "..");

const home = mkdtempSync(join(tmpdir(), "hipokamp-test-demo-"));
const claude = join(home, "claude");
// katalogi projektów są wymyślone i nie istnieją: zapis pomija pliki z katalogów tymczasowych (szum), a projekt
// katalogu bez repo to jego nazwa
const code = process.platform === "win32" ? "C:/demo/code" : "/demo/code";
mkdirSync(join(claude, "projects"), { recursive: true });
mkdirSync(join(home, "codex"), { recursive: true });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify(
    {
      port: PORT,
      workerIdleExitMin: 0,
      capture: {
        codex: false,
        autoMemory: false,
        harnesses: { gemini: false, antigravity: false, cursor: false, opencode: false, claudeDesktop: false },
      },
      backup: { enabled: false },
      // zastępczy model daje wektory z hasha (cosinus ~0), więc wyszukiwanie pokazywałoby szum z trafnością 0%;
      // bez wektorów wyszukiwanie idzie po słowach (BM25), a trafność to pokrycie słów zapytania
      embed: { enabled: false },
    },
    null,
    2,
  ),
);

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: home,
  HIPOKAMP_PORT: String(PORT),
  HIPOKAMP_FAKE_EMBED_MS: "0",
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(home, "codex"),
  // Gemini CLI, Cursor, OpenCode, Claude Desktop: pusty katalog domowy harnessów; baza claude-mem: nieistniejąca
  // (jak w scripts/ci-env.ts), żeby demo nie czytało prawdziwej
  HIPOKAMP_HARNESS_HOME: join(home, "harness-home"),
  CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
};
// config.ts czyta HIPOKAMP_HOME przy pierwszym imporcie, więc moduły hipokampa ładujemy dopiero po ustawieniu env
Object.assign(process.env, env);

// ---------------------------------------------------------------- wymyślone sesje

const DAY = 86_400_000;
const uid = () => crypto.randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();

interface Turn {
  ask: string;
  answer: string;
  /** Plik względem katalogu projektu: edycja (from → to) albo nowy plik (sama treść). */
  edit?: { file: string; from?: string; to: string };
  command?: { cmd: string; out: string };
}
interface Session {
  project: string;
  daysAgo: number;
  hour: number;
  turns: Turn[];
}

const SESSIONS: Session[] = [
  {
    project: "acme-shop",
    daysAgo: 13,
    hour: 10,
    turns: [
      {
        ask: "Fix the checkout bug: two browser tabs can submit the same cart twice",
        edit: { file: "src/cart/checkout.ts", from: "await createOrder(cart)", to: "await withCartLock(cart.id, () => createOrder(cart))" },
        command: { cmd: "bun test src/cart", out: "error: duplicate order for cart 41\n1 fail\n...\n12 pass 0 fail" },
        answer:
          "Double checkout is gone: createOrder now runs under a per-cart lock (withCartLock), so the second tab gets the existing order instead of a duplicate. Added a regression test that submits the same cart from two concurrent requests.",
      },
    ],
  },
  {
    project: "acme-shop",
    daysAgo: 11,
    hour: 15,
    turns: [
      {
        ask: "Add a webhook handler for payment events in test mode",
        edit: { file: "src/payments/webhook.ts", to: "export async function onPaymentEvent(evt: PaymentEvent) {\n  // verify signature, then mark order paid\n}\n" },
        answer:
          "Added src/payments/webhook.ts: verifies the signature header, ignores events it has already seen (idempotency key in the events table) and marks the order as paid. Test mode only for now; live keys stay out of the repo.",
      },
      {
        ask: "Should we keep sessions in SQLite or move them to Postgres now?",
        answer:
          "Decision: we'll go with SQLite for sessions until traffic needs a second app server. It keeps deploys to a single binary and the session table is tiny. Revisit when we add a second instance.",
      },
    ],
  },
  {
    project: "acme-shop",
    daysAgo: 8,
    hour: 11,
    turns: [
      {
        ask: "Refactor price formatting into one money.ts helper, it is duplicated in five components",
        edit: { file: "src/lib/money.ts", to: "export const formatPrice = (cents: number, currency = 'EUR') =>\n  new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);\n" },
        answer:
          "Extracted formatPrice into src/lib/money.ts (Intl.NumberFormat, amounts kept in cents) and replaced the five hand-rolled copies. No visual change; snapshot tests still pass.",
      },
    ],
  },
  {
    project: "acme-shop",
    daysAgo: 5,
    hour: 17,
    turns: [
      {
        ask: "From now on run the e2e suite before every pull request, remember that",
        answer: "Noted: e2e suite (bun run e2e) before every pull request, not just unit tests.",
      },
      {
        ask: "Why does the image upload fail on Windows only?",
        command: { cmd: "bun run upload-smoke", out: "Error: EPERM: operation not permitted, rename 'tmp\\upload-1.part'" },
        answer:
          "The upload writes a .part file and renames it while an antivirus scanner still holds the handle, so rename fails with EPERM on Windows. Retrying the rename with a short backoff fixes it; Linux and macOS never hit this.",
      },
    ],
  },
  {
    project: "acme-shop",
    daysAgo: 1,
    hour: 9,
    turns: [
      {
        ask: "Add a low-stock badge to the product card",
        edit: { file: "src/components/ProductCard.tsx", from: "<Price value={p.price} />", to: "<Price value={p.price} />\n{p.stock < 5 && <Badge>Only {p.stock} left</Badge>}" },
        answer: "Added a low-stock badge on the product card when fewer than 5 items are left, with a translation key and a story in the component gallery.",
      },
    ],
  },
  {
    project: "weather-cli",
    daysAgo: 12,
    hour: 20,
    turns: [
      {
        ask: "Add a --units flag (metric or imperial)",
        edit: { file: "src/args.ts", from: "lang: string;", to: "lang: string;\n  units: 'metric' | 'imperial';" },
        answer: "Added --units metric|imperial (default metric). The flag is passed to the API client and the formatter converts wind speed and temperature.",
      },
    ],
  },
  {
    project: "weather-cli",
    daysAgo: 9,
    hour: 13,
    turns: [
      {
        ask: "Fix the hourly forecast, it shows tomorrow's hours shifted by the UTC offset",
        edit: { file: "src/forecast/hourly.ts", from: "new Date(h.time)", to: "toLocal(h.time, location.timezone)" },
        command: { cmd: "bun test hourly", out: "expected 09:00, got 07:00\n1 fail\n...\n8 pass 0 fail" },
        answer:
          "Hourly forecast times are correct again: the API returns UTC, and we now convert them with the location's timezone (toLocal) instead of the machine's. The test pins TZ so it no longer depends on where it runs.",
      },
    ],
  },
  {
    project: "weather-cli",
    daysAgo: 6,
    hour: 16,
    turns: [
      {
        ask: "How does the response cache work right now?",
        answer:
          "The cache keys responses by (lat, lon, units) rounded to 2 decimals and keeps them for 10 minutes in ~/.cache/weather-cli. Forecast requests bypass it when --fresh is set.",
      },
      {
        ask: "Refactor the HTTP client retry loop into a small helper",
        edit: { file: "src/http/retry.ts", to: "export async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {\n  // exponential backoff with jitter\n}\n" },
        answer: "Extracted retry() with exponential backoff and jitter into src/http/retry.ts; both API clients use it now.",
      },
    ],
  },
  {
    project: "weather-cli",
    daysAgo: 2,
    hour: 10,
    turns: [
      {
        ask: "Add shell completions for bash, zsh and PowerShell",
        edit: { file: "src/completions.ts", to: "export const shells = ['bash', 'zsh', 'pwsh'] as const;\n" },
        answer: "Added `weather completions <shell>` for bash, zsh and PowerShell, generated from the same flag table as --help.",
      },
    ],
  },
  {
    project: "docs-site",
    daysAgo: 10,
    hour: 12,
    turns: [
      {
        ask: "Astro or Next.js for the docs site?",
        answer:
          "Decision: we chose Astro. The site is static content with a few interactive islands, Astro ships far less JavaScript and builds in seconds. Next.js would only pay off with server features we don't need.",
      },
    ],
  },
  {
    project: "docs-site",
    daysAgo: 4,
    hour: 14,
    turns: [
      {
        ask: "Fix the broken links in the sidebar navigation after the folder rename",
        edit: { file: "src/nav.ts", from: "'/guide/setup'", to: "'/getting-started/setup'" },
        command: { cmd: "bun run check-links", out: "3 broken links: /guide/setup, /guide/config, /guide/faq\n...\n0 broken links" },
        answer: "Three sidebar links still pointed at /guide/* after the rename to /getting-started/*; they use the new paths now, and check-links runs in CI so dead internal links fail the build.",
      },
    ],
  },
  {
    project: "docs-site",
    daysAgo: 0,
    hour: 9,
    turns: [
      {
        ask: "Add full-text search to the docs",
        edit: { file: "src/search/index.ts", to: "export function buildIndex(pages: Page[]) {\n  // static index generated at build time\n}\n" },
        answer: "Added client-side full-text search with a static index built at build time (no external service). Results show the section heading and a highlighted snippet.",
      },
    ],
  },
];

function writeSession(s: Session, now: number): void {
  const sid = uid();
  const cwd = `${code}/${s.project}`;
  const start = new Date(now - s.daysAgo * DAY);
  start.setHours(s.hour, 7, 0, 0);
  let at = Math.min(start.getTime(), now - 30 * 60_000);
  const lines: object[] = [{ type: "queue-operation", operation: "enqueue", timestamp: iso(at), sessionId: sid }];
  const base = { sessionId: sid, cwd };
  const user = (content: unknown) => ({ type: "user", uuid: uid(), ...base, timestamp: iso(at), message: { role: "user", content } });
  const assistant = (content: object[], stop: string) => ({
    type: "assistant",
    uuid: uid(),
    ...base,
    timestamp: iso(at),
    message: { role: "assistant", model: "demo", stop_reason: stop, content },
  });
  s.turns.forEach((t, n) => {
    lines.push(user(t.ask));
    at += 20_000;
    if (t.edit) {
      const file = `${cwd}/${t.edit.file}`;
      const id = `toolu_demo_${n}_edit`;
      const input = t.edit.from
        ? { file_path: file, old_string: t.edit.from, new_string: t.edit.to }
        : { file_path: file, content: t.edit.to };
      lines.push(assistant([{ type: "tool_use", id, name: t.edit.from ? "Edit" : "Write", input }], "tool_use"));
      at += 5_000;
      lines.push({
        ...user([{ type: "tool_result", tool_use_id: id, content: `The file ${file} has been updated.` }]),
        toolUseResult: { filePath: file },
      });
      at += 5_000;
    }
    if (t.command) {
      const id = `toolu_demo_${n}_bash`;
      lines.push(assistant([{ type: "tool_use", id, name: "Bash", input: { command: t.command.cmd } }], "tool_use"));
      at += 8_000;
      lines.push({
        ...user([{ type: "tool_result", tool_use_id: id, content: t.command.out }]),
        toolUseResult: { stdout: t.command.out, stderr: "", interrupted: false },
      });
      at += 5_000;
    }
    lines.push(assistant([{ type: "text", text: t.answer }], "end_turn"));
    at += 4 * 60_000;
  });
  const dir = join(claude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  // nadrabianie i backfill czytają transkrypty po ciszy: plik „skończony” w chwili ostatniej linii
  utimesSync(file, at / 1000, at / 1000);
}

// ---------------------------------------------------------------- zapis przez prawdziwy kod

async function seed(): Promise<void> {
  const now = Date.now();
  for (const s of SESSIONS) writeSession(s, now);

  const { ensureDataDirs } = await import("../src/config.ts");
  const { openDb } = await import("../src/db/db.ts");
  const { Repo } = await import("../src/db/repo.ts");
  const { backfill } = await import("../src/importers/backfill.ts");
  const { remember } = await import("../src/core/remember.ts");
  ensureDataDirs();
  const repo = new Repo(openDb({ vectors: false }));
  const r = backfill(repo, {});
  console.log(`demo: ${r.files} sesji, ${r.inserted} notatek z transkryptów`);

  const project = (name: string) => repo.resolveProject(`${code}/${name}`);
  remember(repo, {
    project: project("acme-shop"),
    type: "gotcha",
    key: "money-in-cents",
    title: "Prices are stored in cents, never as floats",
    text: "Prices are stored in cents (integers) everywhere: database, API and cart. Formatting happens only at the edge with formatPrice in src/lib/money.ts.",
  });
  remember(repo, {
    project: project("weather-cli"),
    type: "preference",
    key: "error-messages",
    title: "Error messages tell the user what to do next",
    text: "Every CLI error message ends with a concrete next step (flag to add, command to run), not just what failed.",
  });
  remember(repo, {
    project: project("docs-site"),
    type: "decision",
    key: "docs-hosting",
    title: "Docs are hosted as static files, no server",
    text: "The docs site is deployed as static files to any CDN. No server-side rendering, no runtime secrets.",
  });

  const ws = (p: string, list: string, items: [string, string][], ageDays = 0) => {
    items.forEach(([task, status], i) =>
      repo.appendWorkState(project(p), list, { task, status }, now - ageDays * DAY + i * 1000, "live"),
    );
  };
  ws("acme-shop", "release 1.4", [
    ["Low-stock badge on product card", "done"],
    ["Payment webhooks: switch to live keys", "doing"],
    ["E2E test for double checkout", "todo"],
    ["Retry image upload rename on Windows", "todo"],
  ]);
  ws("weather-cli", "v2 roadmap", [
    ["Shell completions", "done"],
    ["Air quality index", "todo"],
    ["Offline mode from cache", "todo"],
  ], 16);
  ws("docs-site", "launch checklist", [
    ["Search", "done"],
    ["Dead link check in CI", "done"],
    ["Custom 404 page", "todo"],
  ]);
  repo.db.close();
}

// ---------------------------------------------------------------- worker

/** Usuwa katalog demo (bez --keep). Na Windows worker chwilę po wyjściu trzyma jeszcze pliki bazy: kilka prób. */
const cleanup = () => {
  if (KEEP) return;
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(200);
    }
  }
  console.error(`demo: nie udało się usunąć ${home}, usuń go ręcznie`);
};

try {
  await seed();
} catch (e) {
  cleanup();
  throw e;
}
const { portOpen } = await import("../src/worker/client.ts");
if (await portOpen()) {
  console.error(`demo: port ${PORT} jest zajęty, spróbuj --port <inny>`);
  cleanup();
  process.exit(1);
}
const worker = spawn(process.execPath, [join(REPO, "src", "worker", "main.ts")], { env, stdio: "ignore" });
let stopping = false;
/** Kończy demo: zatrzymuje workera, czeka na jego wyjście (pliki bazy zwolnione), potem sprząta katalog. */
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  const done = () => {
    cleanup();
    process.exit(code);
  };
  if (worker.exitCode !== null || worker.signalCode !== null) return done();
  worker.once("exit", done);
  worker.kill();
  setTimeout(done, 5000).unref();
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
worker.on("exit", (code) => stop(code ? 1 : 0));

let up = false;
for (let i = 0; i < 100 && !up && !stopping; i++) {
  await Bun.sleep(150);
  up = await portOpen();
}
if (!up) {
  console.error("demo: worker nie wstał (port zajęty?), spróbuj --port <inny>");
  stop(1);
} else {
  const { viewerUrl } = await import("./demo-url.ts");
  console.log(`\nhipokamp demo (link jednorazowy, ważny 2 min): ${await viewerUrl(PORT)}`);
  console.log(`dane demo: ${home}${KEEP ? " (zostają po zakończeniu)" : " (usuwane po Ctrl+C)"}\n`);
}
