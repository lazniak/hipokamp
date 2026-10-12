// Pomiar przestoju pętli workera (T-30) wyłącznie na bazie TESTOWEJ (katalog z „hipokamp-test” w nazwie).
// Baza: kilkadziesiąt tysięcy notatek z wektorami (losowymi) i 500 notatek bez wektora (liczy je prawdziwy model).
// Faza „worker”: worker na wolnym porcie liczy 500 wektorów, a w tym czasie idzie 20 zapytań przeszukiwania;
// sonda /api/health co 100 ms mierzy, ile worker odpowiada, i zbiera maksimum opóźnienia pętli.
// Fazy „sen”, „kopia” i „nadrabianie”: ten sam kod co w workerze, w osobnym procesie z próbnikiem pętli co 20 ms.
// Faza „fts”: przebudowa indeksu FTS (po podbiciu FTS_VERSION worker robi ją przy starcie).
// Użycie: bun spikes/worker-stall.ts [--root <drzewo kodu>] [--home <katalog>] [--notes 40000] [--phase all|worker|sen|kopia|nadrabianie|fts]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authedFetch, handshake, KEY_FILE, readKey } from "../src/worker/auth.ts";
import { cookieName, mintCookie } from "../src/worker/viewer-auth.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ROOT = resolve(arg("root", join(import.meta.dir, "..")));
const HOME = resolve(arg("home", join(tmpdir(), "hipokamp-test-stall-bench")));
const NOTES = Number(arg("notes", "40000"));
const MISSING = 500;
const QUERIES = 20;
const PORT = Number(arg("port", "47981"));
if (!HOME.includes("hipokamp-test")) throw new Error("bench: katalog musi mieć „hipokamp-test” w nazwie");

const claude = join(HOME, "claude");
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HIPOKAMP_HOME: HOME,
  HIPOKAMP_PORT: String(PORT),
  HIPOKAMP_NO_WORKER: "1",
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(HOME, "codex"),
  CLAUDE_MEM_DB: join(HOME, "brak-claude-mem.db"),
};
const BASE = join(HOME, "base.db");
const DB = join(HOME, "hipokamp.db");
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

const WORDS =
  "worker port pętla zdarzeń wektor model embedding zapytanie hook prompt sesja transkrypt notatka projekt baza sqlite indeks fts wyszukiwanie hybrydowe ranking kontekst budżet tokenów sen scalanie archiwum kopia przywracanie migracja schemat kolumna tabela partycja bitowy hamming cosinus kwantyzacja int8 onnx runtime directml procesor karta graficzna wątek kolejka priorytet opóźnienie przestój limit czasu nadrabianie offset tura podsumowanie decyzja pułapka poprawka błąd konfiguracja instalacja plugin serwer mcp narzędzie timeline obserwacja encja graf aktywacja ważność dostęp wstrzyknięcie redakcja sekret prywatność gitea repozytorium gałąź commit przegląd test bramka lint typecheck the worker blocks event loop while computing vectors for new notes and the prompt hook times out after seconds".split(
    " ",
  );
function words(rnd: () => number, chars: number): string {
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)];
    out.push(w);
    n += w.length + 1;
  }
  return out.join(" ");
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Baza bazowa raz na katalog: NOTES notatek z losowymi wektorami w 20 projektach (rozkład Zipfa) + 500 bez wektora. */
async function seedBase(): Promise<void> {
  if (existsSync(BASE)) return;
  const r = Bun.spawnSync([process.execPath, import.meta.path, "--child", "seed", "--root", ROOT, "--home", HOME, "--notes", String(NOTES)], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) throw new Error("seed nieudany");
}

function freshDb(): void {
  for (const x of ["", "-wal", "-shm"]) rmSync(DB + x, { force: true });
  copyFileSync(BASE, DB);
}

// ---------- proces potomny: ziarno i fazy w procesie ----------
async function child(what: string): Promise<void> {
  const imp = (p: string) => import(join(ROOT, p));
  const { openDb } = await imp("src/db/db.ts");
  const { Repo } = await imp("src/db/repo.ts");
  if (what === "seed") {
    const repo = new Repo(openDb({ path: BASE, vectors: true }));
    const rnd = rng(42);
    const now = Date.now();
    const projects = Array.from({ length: 20 }, (_, i) => `proj-${i}`);
    const pickProject = () => projects[Math.min(19, Math.floor(20 * rnd() ** 2.2))];
    const t0 = performance.now();
    for (let i = 0; i < NOTES + MISSING; i++) {
      if (i % 2000 === 0) repo.db.run("BEGIN");
      const project = pickProject();
      const { id } = repo.insertObservation({
        session_id: null,
        project,
        type: ["discovery", "change", "bugfix", "decision", "feature"][i % 5],
        title: words(rnd, 40 + Math.floor(rnd() * 60)),
        subtitle: words(rnd, 30),
        narrative: words(rnd, 250 + Math.floor(rnd() * 1300)),
        facts: [words(rnd, 60), words(rnd, 80)],
        concepts: ["worker", "pamięć"],
        created_at: now - Math.floor(rnd() * 200 * 86_400_000),
        source: "backfill",
      });
      if (i < NOTES) {
        const q8 = new Int8Array(1024);
        const bits = new Uint8Array(128);
        for (let k = 0; k < 1024; k++) {
          q8[k] = Math.round((rnd() - 0.5) * 60);
          if (q8[k] > 0) bits[k >> 3] |= 1 << (k & 7);
        }
        repo.putVector(id, project, "Xenova/bge-m3", q8, bits, true);
      }
      if (i % 2000 === 1999 || i === NOTES + MISSING - 1) repo.db.run("COMMIT");
    }
    // stan ustalony: indeks FTS w bieżącej wersji (przebudowę mierzy osobna faza „fts”)
    const { FTS_VERSION } = await imp("src/db/repo.ts");
    repo.db.run("INSERT INTO meta(k, v) VALUES ('fts_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [FTS_VERSION]);
    repo.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    repo.db.close();
    console.log(`ziarno: ${NOTES} notatek z wektorami + ${MISSING} bez, ${Math.round((performance.now() - t0) / 1000)} s`);
    return;
  }
  // moduły i baza przed próbnikiem: worker ładuje je przy starcie, a nie w trakcie zadania
  const mods = {
    sen: what === "sen" ? await imp("src/consolidate/sleep.ts") : null,
    kopia: what === "kopia" ? await imp("src/core/backup.ts") : null,
    nadrabianie: what === "nadrabianie" ? await imp("src/worker/catchup.ts") : null,
  };
  const repo = new Repo(openDb({ vectors: true }));
  // najdłuższy odcinek synchroniczny między oddechami (Bun.sleep): nie zależy od obciążenia maszyny innymi procesami,
  // które opóźniają też sam próbnik (stary kod bez oddechów = jeden odcinek na całe zadanie)
  const sleep0 = Bun.sleep;
  let resumed = performance.now();
  let longest = 0;
  (Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
    longest = Math.max(longest, performance.now() - resumed);
    await sleep0(ms);
    resumed = performance.now();
  };
  // próbnik pętli w tym procesie: najdłuższa blokada = najdłuższy przestój, jaki zadanie zrobiłoby w workerze
  let max = 0;
  let expected = performance.now() + 20;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - expected);
    expected = now + 20;
  }, 20);
  const t0 = performance.now();
  let info: unknown;
  if (mods.sen) {
    info = await mods.sen.sleep(repo, { full: true });
  } else if (mods.kopia) {
    const dir = join(HOME, "backups-bench");
    const bk = mods.kopia;
    // nowy kod: kopia w osobnym wątku (tak jak woła ją worker); stary: VACUUM INTO na wątku głównym
    info = bk.backupDbInThread ? await bk.backupDbInThread({ dir, keep: 1 }) : bk.backupDb(repo.db, { dir, keep: 1 });
    // w wątku: wątek główny tylko czeka na wynik, więc odcinka synchronicznego nie ma
    if (bk.backupDbInThread) resumed = performance.now();
  } else if (mods.nadrabianie) {
    // nowy kod: wersja pocięta na okna (tak jak woła ją worker); stary: jeden przebieg na wątku głównym
    const { catchUp, catchUpSliced } = mods.nadrabianie;
    info = catchUpSliced ? await catchUpSliced(repo) : catchUp(repo);
  } else if (what === "fts") {
    repo.db.run("DELETE FROM meta WHERE k = 'fts_version'");
    info = await repo.reindexFts();
  }
  const ms = performance.now() - t0;
  longest = Math.max(longest, performance.now() - resumed);
  // próbnik musi dostać turę pętli po pracy synchronicznej, inaczej nie zobaczy jej blokady
  await sleep0(60);
  clearInterval(timer);
  console.log(
    JSON.stringify({ phase: what, ms: Math.round(ms), maxLagMs: Math.round(max), longestSyncMs: Math.round(longest), info }),
  );
}

// ---------- transkrypty do nadrabiania ----------
function makeTranscripts(): void {
  const dir = join(claude, "projects", "D--bench-proj");
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const rnd = rng(7);
  const ago = Date.now() - 6 * 3_600_000;
  for (let f = 0; f < 19; f++) {
    const sid = `00000000-0000-4000-8000-${String(f).padStart(12, "0")}`;
    const lines: string[] = [];
    let t = ago - 3_600_000;
    for (let turn = 0; turn < 120; turn++) {
      const ts = () => new Date((t += 2000)).toISOString();
      const u = `u${f}-${turn}`;
      lines.push(
        JSON.stringify({
          type: "user",
          uuid: u,
          sessionId: sid,
          cwd: "D:\\bench\\proj",
          timestamp: ts(),
          message: { role: "user", content: words(rnd, 200) },
        }),
      );
      for (let k = 0; k < 3; k++) {
        const id = `toolu_${f}_${turn}_${k}`;
        lines.push(
          JSON.stringify({
            type: "assistant",
            uuid: `a${f}-${turn}-${k}`,
            sessionId: sid,
            timestamp: ts(),
            message: {
              role: "assistant",
              model: "bench",
              content: [{ type: "tool_use", id, name: "Bash", input: { command: `grep -rn ${words(rnd, 20)}` } }],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: `r${f}-${turn}-${k}`,
            sessionId: sid,
            timestamp: ts(),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: words(rnd, 6000) }] },
          }),
        );
      }
      lines.push(
        JSON.stringify({
          type: "assistant",
          uuid: `e${f}-${turn}`,
          sessionId: sid,
          timestamp: ts(),
          message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: words(rnd, 600) }] },
        }),
      );
    }
    const p = join(dir, `${sid}.jsonl`);
    writeFileSync(p, `${lines.join("\n")}\n`);
    const old = new Date(ago);
    utimesSync(p, old, old);
  }
}

// ---------- faza „worker”: 500 wektorów + 20 zapytań ----------
async function workerPhase(): Promise<void> {
  freshDb();
  for (const f of readdirSync(join(HOME, "logs"))) if (f.startsWith("stall-") || f.startsWith("worker-")) rmSync(join(HOME, "logs", f));
  const base = `http://127.0.0.1:${PORT}`;
  // pusty katalog Claude Code: transkrypty fazy „nadrabianie” nie trafiają do workera (inaczej liczyłby ich wektory)
  const empty = join(HOME, "claude-pusty");
  mkdirSync(join(empty, "projects"), { recursive: true });
  const worker = Bun.spawn([process.execPath, join(ROOT, "src", "worker", "main.ts")], {
    env: { ...env, HIPOKAMP_SPAWNED: "1", CLAUDE_CONFIG_DIR: empty },
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  const t0 = performance.now();
  // odpowiedzi bez wektora zapytania (limit czasu w ścieżce hooka albo wyszukiwania: sam FTS)
  let ftsOnly = 0;
  const timed = async (f: () => Promise<Response>, ms = 30_000) => {
    const t = performance.now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await f();
      const body = await r.text();
      if (r.headers.get("x-hipokamp-vectors") || body.includes('"vectors":')) ftsOnly++;
      return performance.now() - t;
    } finally {
      clearTimeout(to);
    }
  };
  try {
    for (;;) {
      try {
        // statyczny podgląd: /api/* bez ciasteczka albo klucza to 401 (T-34)
        if ((await fetch(`${base}/`)).ok) break;
      } catch {}
      if (performance.now() - t0 > 30_000) throw new Error("worker nie wstał");
      await Bun.sleep(100);
    }
    const ready = performance.now();
    // trasy klienta (/api/context/*) wymagają dowodu klucza (T-17); drzewo z --root sprzed T-17 nie zna /api/auth
    const key = readKey(join(HOME, "state", KEY_FILE));
    const legacy = !key || (await handshake(base, PORT, key)).status === 404;
    const clientFetch = async (path: string, init: { method: string; body: string }) =>
      legacy
        ? fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } })
        : ((await authedFetch({
            base,
            port: PORT,
            key: key!,
            path,
            method: init.method,
            headers: { "content-type": "application/json" },
            body: init.body,
          })) ?? new Response("uwierzytelnienie nie przeszło", { status: 599 }));
    // trasy podglądu z ciasteczkiem podglądu (T-34); starszy worker nagłówek pomija
    const viewer: Record<string, string> = key ? { cookie: `${cookieName(PORT)}=${mintCookie(key, PORT)}` } : {};
    let maxLag = 0;
    let stop = false;
    const probes: number[] = [];
    let culprit: unknown = null;
    let loadedAt = 0;
    const probe = (async () => {
      while (!stop) {
        const t = performance.now();
        try {
          const r = await fetch(`${base}/api/health`, { headers: { ...viewer, "x-hipokamp-bg": "1" } });
          const h = (await r.json()) as any;
          probes.push(performance.now() - t);
          maxLag = Math.max(maxLag, h.eventLoopLagMaxMs ?? 0);
          if (h.lagCulprit) culprit = h.lagCulprit;
          if (!loadedAt && h.embedder?.loaded) loadedAt = performance.now() - ready;
        } catch {}
        await Bun.sleep(100);
      }
    })();
    const search: number[] = [];
    const prompt: number[] = [];
    const rnd = rng(3);
    const queries = (async () => {
      await Bun.sleep(1000);
      for (let i = 0; i < QUERIES; i++) {
        const q = words(rnd, 60);
        if (i % 2 === 0)
          search.push(await timed(() => fetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=10`, { headers: viewer })));
        else
          prompt.push(
            await timed(() =>
              clientFetch("/api/context/prompt", {
                method: "POST",
                body: JSON.stringify({ project: "proj-0", session: `bench-${i}`, prompt: q, record: false }),
              }),
            ),
          );
        await Bun.sleep(700);
      }
    })();
    let doneAt = 0;
    for (;;) {
      await Bun.sleep(1000);
      const s = (await (await fetch(`${base}/api/stats`, { headers: { ...viewer, "x-hipokamp-bg": "1" } })).json()) as any;
      if (s.missingVectors === 0) {
        doneAt = performance.now() - ready;
        break;
      }
      if (performance.now() - ready > 20 * 60_000) throw new Error("wektory nie policzone w 20 min");
    }
    await queries;
    await Bun.sleep(1200);
    stop = true;
    await probe;
    const stalls = readdirSync(join(HOME, "logs"))
      .filter((f) => f.startsWith("stall-"))
      .flatMap((f) =>
        readFileSync(join(HOME, "logs", f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
    const by: Record<string, number> = {};
    for (const s of stalls) by[s.culprit] = (by[s.culprit] ?? 0) + 1;
    console.log(
      JSON.stringify(
        {
          phase: "worker",
          vectors: MISSING,
          embedS: Math.round(doneAt / 100) / 10,
          modelLoadedS: Math.round(loadedAt / 100) / 10,
          maxLoopLagMs: maxLag,
          healthProbe: { n: probes.length, p50: pct(probes, 50), p95: pct(probes, 95), max: pct(probes, 100) },
          search: { n: search.length, p50: pct(search, 50), p95: pct(search, 95), max: pct(search, 100) },
          prompt: { n: prompt.length, p50: pct(prompt, 50), p95: pct(prompt, 95), max: pct(prompt, 100) },
          withoutQueryVector: ftsOnly,
          stallsOver1s: stalls.length,
          stallCulprits: by,
          worstStall: stalls.sort((a, b) => b.lagMs - a.lagMs)[0] ?? null,
          lastCulprit: culprit,
        },
        null,
        1,
      ),
    );
  } finally {
    worker.kill();
    await worker.exited;
  }
}

async function inproc(phase: string): Promise<void> {
  freshDb();
  if (phase === "nadrabianie") makeTranscripts();
  const r = Bun.spawnSync([process.execPath, import.meta.path, "--child", phase, "--root", ROOT, "--home", HOME, "--notes", String(NOTES)], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString().trim().split("\n").pop();
  if (r.exitCode !== 0) console.log(`${phase}: błąd\n${r.stderr.toString()}`);
  else console.log(out);
}

const childPhase = arg("child", "");
if (childPhase) await child(childPhase);
else {
  mkdirSync(join(HOME, "logs"), { recursive: true });
  mkdirSync(join(claude, "projects"), { recursive: true });
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({
      embed: { device: "cpu", dtype: "q8", bulkDevice: "cpu", bulkDtype: "q8" },
      backup: { enabled: false },
      workerIdleExitMin: 0,
      capture: { codex: false },
    }),
  );
  console.log(`kod: ${ROOT}\nkatalog: ${HOME}`);
  await seedBase();
  const phase = arg("phase", "all");
  if (phase === "all" || phase === "worker") await workerPhase();
  for (const p of ["sen", "kopia", "nadrabianie", "fts"]) if (phase === "all" || phase === p) await inproc(p);
}
