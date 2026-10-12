#!/usr/bin/env bun
// CLI hipokampa. `bun src/cli.ts <komenda>` albo `hipokamp <komenda>` po instalacji.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, ensureDataDirs, llmConfig, loadConfig, paths } from "./config.ts";
import { getDb } from "./db/db.ts";
import { Repo } from "./db/repo.ts";
import type { LlmReport } from "./llm/consolidate.ts";
import { initLog } from "./log.ts";
import { call, describeWorker, keyPath, probeWorker, type WorkerProbe, waitWorker, wakeWorker } from "./worker/client.ts";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";

function flag(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split("=").slice(1).join("=") : def;
}
const has = (name: string) => argv.includes(`--${name}`);
const positional = () =>
  argv
    .slice(1)
    .filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--") && !all[i - 1].includes("=")));

function repo(): Repo {
  return new Repo(getDb());
}

/** Raport przebiegu z lokalnym LLM (CLI `llm run`, `sleep --llm`). */
function formatLlm(r: LlmReport): string {
  const lines = [
    `LLM ${r.model || "(bez modelu)"}: wywołania ${r.calls}, ocenione pary ${r.pairsChecked}, sprzeczności ${r.conflicts.length}, lekcje ${r.lessons.length}, ${Math.round(r.ms / 1000)} s${r.stopped ? `, stop: ${r.stopped}` : ""}`,
  ];
  for (const c of r.conflicts) lines.push(`  ⚠ #${c.a} i #${c.b} (${c.project}): ${c.reason}`);
  for (const l of r.lessons.slice(0, 20)) lines.push(`  #${l.id}: ${l.text}`);
  return lines.join("\n");
}

/**
 * Odmowa naprawy i przywracania przy zajętym porcie workera. Obcy proces (nie przeszedł wyzwania klucza i nie ma go
 * w worker.lock.json) to nie worker hipokampa: `hipokamp stop` go nie zatrzyma, więc komunikat mówi, co zrobić.
 */
function portBusy(p: WorkerProbe): string {
  const port = loadConfig().port;
  if (p.state === "unverified" && p.lockPid === undefined)
    return `Na porcie ${port} słucha proces, który nie jest workerem hipokampa (nie przeszedł wyzwania klucza i nie ma go w worker.lock.json), więc hipokamp stop go nie zatrzyma. Sprawdź, co to za proces (Windows: netstat -ano | findstr :${port}, Linux i macOS: lsof -i :${port}), zamknij go albo ustaw inny port w config.json, potem powtórz.`;
  return "Worker działa. Zatrzymaj go (hipokamp stop) i zamknij sesje Claude Code, potem powtórz.";
}

/** Projekt z `--project` albo z katalogu, jak w hooku: aliasy i scalenia (`hipokamp project merge`). */
function cliProject(): string {
  const p = flag("project");
  return p ? repo().mergedProject(p) : repo().resolveProject(process.cwd());
}

const HELP = `hipokamp: darmowa, lokalna pamięć dla Claude Code

Użycie: hipokamp <komenda> [opcje]

  status                   stan workera, bazy, wektorów i ostatniego snu
  start | stop | restart   worker w tle (127.0.0.1:${DEFAULTS.port})
  open [--print]           podgląd w przeglądarce: jednorazowy link (2 min), worker wymienia go na ciasteczko
                           na 30 dni; bez ciasteczka API podglądu odpowiada 401. --print: tylko wypisz link
  logs [--n 60]            końcówka logu workera
  search <zapytanie>       szukanie hybrydowe  [--project p] [--limit n] [--type t]
  show <id...>             pełne notatki
  timeline <id>            oś czasu wokół notatki  [--before n] [--after n]
  context [--project p]    podgląd kontekstu startowego  [--prompt "…"] [--budget n]
  remember "<tekst>"       zapamiętaj jawnie  [--project p] [--type decision|gotcha|preference] [--key temat]
  recall-stats             próg przypominania na logach decyzji  [--days 14] [--window 60] [--min-n 20] [--threshold p] [--json]
  import-claude-mem        kopiuje bazę wiedzy claude-mem  [--db ścieżka] [--dry-run]
  import-automemory        pamięć automatyczna Claude Code (projects/*/memory): plan, --apply zapisuje  [--root katalog] [--all]
  export-vault <katalog>   decyzje i pułapki jako markdown (np. do vaulta Obsidian)  [--project p] [--types t,t] [--per-project] [--dry-run]
  backfill                 notatki z transkryptów  [--since RRRR-MM-DD] [--limit n]
  embed                    przelicz brakujące wektory  [--device dml|cpu] [--dtype fp16|q8]
  sleep [--full] [--llm]   konsolidacja (scalanie, zastępowanie, archiwum, przycinanie logów); --llm także etap
                           z lokalnym LLM
  supersede [--dry-run]    zastępowanie starszych decyzji z digestu nowszymi (sen domyślnie tylko proponuje,
                           consolidation.supersedeDigest)  [--days 120] [--json]; --ids 12,34: tylko te pary
  notify status|test|run   powiadomienia o wybranych notatkach (opt-in: notify.enabled)
  llm check|run [--max n]  opcjonalna konsolidacja lokalnym LLM (Ollama, consolidation.llm)
  reindex                  przebudowa indeksów pełnotekstowych
  redigest                 ponowny skrót tur z transkryptu  [--all] [--ids 1,2] [--dry-run]
  repair [--dry-run]       naprawa po imporcie i backfillu: kolizje #id, duplikaty tur, sekrety  [--db ścieżka]
                           przed pierwszym sync; po nim tylko z --force-sync-warning
  project list [--json]    klucze projektów; merge <from> <into> albo merge --worktrees (repo/worktree)  [--dry-run]
  sync <komenda>           synchronizacja z własnym hubem: init, join, add-device, devices, revoke, status, push, pull
                           (hipokamp sync help)
  backup [--keep n]        kopia bazy (VACUUM INTO) do ~/.hipokamp/backups/db
  restore <plik>           przywraca kopię (bieżąca baza idzie do pre-restore)
  eval                     benchmark trafności na Twoich danych
  install [--replace-claude-mem] [--no-codex] [--no-autostart] [--dry-run]
          [--no-gemini] [--no-antigravity] [--no-cursor] [--no-opencode] [--no-claude-desktop]
                           plugin Claude Code, hooki i MCP w Codexie, autostart workera (Windows);
                           serwer MCP, hooki i plugin w innych wykrytych harnessach;
                           marketplace z innego katalogu przepina na ten
  update [--dry-run]       worktree live: fetch, merge --ff-only origin/main, zależności, plugin, restart, doctor
  rollback                 wraca do claude-mem; zdejmuje hipokamp z Codexa i innych harnessów
  doctor                   diagnoza
  config [--defaults]      pokaż konfigurację
`;

async function main(): Promise<void> {
  ensureDataDirs();
  initLog("cli");
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "status": {
      const p = await probeWorker(800);
      const r = repo();
      const s = r.stats();
      console.log(`worker:   ${describeWorker(p)}`);
      console.log(`baza:     ${paths.db()}`);
      console.log(
        `notatki:  ${s.observations} (aktywne ${s.active}), sesje ${s.sessions}, podsumowania ${s.summaries}, prompty ${s.prompts}, projekty ${s.projects}`,
      );
      // osierocone: wektory binarne notatek usuniętych i scalonych (sprząta je sen)
      const orphans = r.countOrphanVectorBits();
      console.log(
        `wektory:  ${s.vectors} (brakuje ${r.countMissingVectors()}${orphans === null ? "" : `, osierocone ${orphans}`}), encje ${s.entities}`,
      );
      console.log(`zadania:  oczekujące ${s.pendingJobs}, błędne ${s.failedJobs}`);
      const { sleepStatus } = await import("./consolidate/sleep.ts");
      console.log(`sen:      ${sleepStatus(r.db)}`);
      console.log("koszt LLM: 0 zł");
      return;
    }

    case "start": {
      // starszy worker bez uwierzytelnienia (T-17) jest zastępowany nowym, obcy proces na porcie zostaje nietknięty
      const p = await wakeWorker();
      const h = p.state === "ok" ? p.health : await waitWorker(20_000);
      console.log(
        h
          ? `worker działa: pid ${h.pid}, http://127.0.0.1:${loadConfig().port}/ (podgląd: hipokamp open)`
          : `worker nie wstał w 20 s (${describeWorker(await probeWorker())}), zobacz: hipokamp logs`,
      );
      return;
    }

    case "open": {
      // T-34: API podglądu wymaga ciasteczka; bilet z klucza workera (jednorazowy, 2 min) worker wymienia na nie
      // pod /auth i przekierowuje na podgląd. Bilet idzie do przeglądarki przez plik w prywatnym katalogu stanu, nie
      // przez linię poleceń, którą widzą inne konta (viewer-open.ts)
      const p = await wakeWorker();
      const h = p.state === "ok" ? p.health : await waitWorker(20_000);
      if (!h) {
        console.log(`worker nie wstał w 20 s (${describeWorker(await probeWorker())}), zobacz: hipokamp logs`);
        process.exitCode = 1;
        return;
      }
      const { authedFetch, loadKey } = await import("./worker/auth.ts");
      const key = loadKey(keyPath());
      if (!key) {
        console.log(`brak klucza workera (${keyPath()}): sprawdź prawa zapisu w katalogu danych, potem hipokamp doctor`);
        process.exitCode = 1;
        return;
      }
      const port = loadConfig().port;
      // worker z kodem sprzed T-34 (kod zaktualizowany bez restartu) nie zna /api/viewer (404); brak odpowiedzi to
      // zajęty worker, nie stary kod
      const viewer = await authedFetch({
        base: `http://127.0.0.1:${port}`,
        port,
        key,
        path: "/api/viewer",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      void viewer?.body?.cancel().catch(() => {});
      if (!viewer?.ok) {
        console.log(
          viewer?.status === 404
            ? `Worker (pid ${h.pid}, wersja ${h.version}) nie obsługuje tokenu podglądu: działa na kodzie sprzed aktualizacji. Uruchom hipokamp restart, potem hipokamp open.`
            : viewer
              ? `Worker (pid ${h.pid}) odpowiedział na /api/viewer kodem HTTP ${viewer.status}; zobacz: hipokamp logs.`
              : `Worker (pid ${h.pid}) nie odpowiedział w 5 s (zajęty, np. liczy wektory). Spróbuj za chwilę; stan: hipokamp status.`,
        );
        process.exitCode = 1;
        return;
      }
      const { mintTicket } = await import("./worker/viewer-auth.ts");
      const { openInBrowser, removeLauncher, sandboxedBrowser, writeLauncher } = await import("./worker/viewer-open.ts");
      const url = `http://127.0.0.1:${port}/auth?t=${mintTicket(key, port)}`;
      // przeglądarka ze snapa albo flatpaka nie czyta katalogu danych: od razu link
      const file = has("print") || (await sandboxedBrowser()) ? null : await writeLauncher(paths.state(), url);
      if (file && openInBrowser(file)) {
        console.log("Podgląd otwarty w przeglądarce (link jednorazowy; przeglądarka zachowa dostęp przez 30 dni).");
        console.log("Jeśli podgląd się nie otworzył (albo plik otworzył się w edytorze): hipokamp open --print");
        return;
      }
      removeLauncher(file);
      console.log(`Otwórz w przeglądarce na tym komputerze (link działa raz, przez 2 min):\n${url}`);
      return;
    }

    case "stop": {
      const p = await probeWorker(800);
      if (p.state === "none") return console.log("worker nie działa");
      const { stopWorker } = await import("./install/update.ts");
      if (await stopWorker()) return console.log(`zatrzymano: ${describeWorker(p)}`);
      console.log(`nie zatrzymano: ${describeWorker(p)}`);
      process.exitCode = 1;
      return;
    }

    case "restart": {
      const { restartWorker } = await import("./install/update.ts");
      const n = await restartWorker(20_000);
      console.log(n ? `worker działa: pid ${n.pid}` : "worker nie wstał, zobacz: hipokamp logs");
      return;
    }

    case "logs": {
      const d = new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const f = join(paths.logs(), `worker-${day}.log`);
      if (!existsSync(f)) return console.log("brak logu z dziś");
      const lines = readFileSync(f, "utf8").trimEnd().split("\n");
      console.log(lines.slice(-Number(flag("n", "60"))).join("\n"));
      return;
    }

    case "search": {
      const q = positional().join(" ");
      if (!q) return console.log("podaj zapytanie");
      const project = flag("project") ? repo().mergedProject(flag("project")!) : undefined;
      const limit = Number(flag("limit", "15"));
      let rows: any[] | null = await call(
        `/api/search?${new URLSearchParams({ q, limit: String(limit), ...(project ? { project } : {}), ...(flag("type") ? { type: flag("type")! } : {}) })}`,
        {
          timeoutMs: 15_000,
        },
      );
      if (!rows) {
        const { hybridSearch, loadHits } = await import("./recall/search.ts");
        const r = repo();
        rows = loadHits(r, await hybridSearch(r, null, q, { project, limit, types: flag("type")?.split(",") })).map(
          ({ hit, obs }) => ({ ...hit, observation: obs }),
        );
        console.log("(worker nie działa, tylko pełnotekstowo)");
      }
      const { indexLine } = await import("./recall/context.ts");
      for (const h of rows)
        console.log(`${indexLine(h.observation)}  · ${h.observation.project} · pewność ${(h.conf * 100).toFixed(0)}%`);
      return;
    }

    case "show": {
      const ids = positional().map((x) => Number(x.replace(/^#/, "")));
      for (const o of repo().getObservations(ids)) {
        console.log(
          `\n#${o.id} [${o.type}] ${o.title}\n${new Date(o.created_at).toISOString()} · ${o.project} · ważność ${o.importance} · źródło ${o.source} · status ${o.status}`,
        );
        if (o.subtitle) console.log(`> ${o.subtitle}`);
        if (o.narrative) console.log(`\n${o.narrative}`);
        if (o.facts.length) console.log(`\nFakty:\n${o.facts.map((f) => `- ${f}`).join("\n")}`);
        if (o.files_modified.length) console.log(`\nZmienione: ${o.files_modified.join(", ")}`);
        if (o.files_read.length) console.log(`Czytane: ${o.files_read.slice(0, 12).join(", ")}`);
        if (o.concepts.length) console.log(`Pojęcia: ${o.concepts.join(", ")}`);
        const { llmNoteLines } = await import("./mcp/format.ts");
        for (const l of llmNoteLines(o.meta)) console.log(l);
      }
      return;
    }

    case "timeline": {
      const id = Number((positional()[0] ?? "").replace(/^#/, ""));
      const { timeline } = await import("./recall/timeline.ts");
      const { indexLine, fmtDate } = await import("./recall/context.ts");
      const { promptLabel } = await import("./mcp/format.ts");
      const t = timeline(repo(), { anchor: id, before: Number(flag("before", "6")), after: Number(flag("after", "6")) });
      for (const it of t.items) {
        if (it.kind === "observation") console.log(`${it.anchor ? "▶ " : "  "}${indexLine(it.obs)}`);
        else if (it.kind === "prompt")
          console.log(`  » ${fmtDate(it.at).slice(5)} ${promptLabel(it.n)}: ${it.text.replace(/\s+/g, " ").slice(0, 120)}`);
        else
          console.log(
            `  ≡ ${fmtDate(it.at).slice(5)} podsumowanie: ${(it.summary.completed ?? it.summary.request ?? "").slice(0, 140)}`,
          );
      }
      return;
    }

    case "context": {
      const project = cliProject();
      const prompt = flag("prompt");
      if (prompt) {
        const args = { project, sessionId: `preview-${Date.now()}`, prompt, cwd: process.cwd(), preview: true };
        let r: any = await call("/api/context/prompt", {
          body: { project, session: args.sessionId, prompt, cwd: args.cwd, preview: true },
          timeoutMs: 20_000,
        });
        if (!r) {
          console.log("(worker nie działa: podgląd tylko na BM25, bez wektorów; `hipokamp start` daje pełny obraz)");
          const { promptContext } = await import("./recall/context.ts");
          r = await promptContext(repo(), null, args);
        }
        if (r?.text) console.log(r.text);
        else {
          const d = r?.debug ?? {};
          const best = (d.best ?? []).map((b: any) => `#${b.id} ${b.conf}`).join(", ");
          console.log(
            `(nic nie zostałoby wstrzyknięte${d.outcome ? `: ${d.outcome}` : ""}${best ? `; najlepsze: ${best}` : ""}${d.min ? `; próg ${d.min}` : ""})`,
          );
        }
        return;
      }
      const qs = new URLSearchParams({ project, cwd: process.cwd(), ...(flag("budget") ? { budget: flag("budget")! } : {}) });
      let r: any = await call(`/api/context/start?${qs}`, { timeoutMs: 20_000 });
      if (!r) {
        const { sessionStartContext } = await import("./recall/context.ts");
        r = await sessionStartContext(repo(), null, {
          project,
          cwd: process.cwd(),
          budget: flag("budget") ? Number(flag("budget")) : undefined,
        });
      }
      console.log(r.text);
      console.log(`\n${r.tokens} tokenów, ${r.ids.length} notatek`);
      return;
    }

    case "remember": {
      const text = positional().join(" ");
      if (!text) return console.log("podaj treść");
      const { remember } = await import("./core/remember.ts");
      const r = remember(repo(), {
        project: cliProject(),
        text,
        type: flag("type") ?? "decision",
        key: flag("key") ?? null,
      });
      console.log(
        `zapamiętane: #${r.id}${r.supersededByKey?.length ? `, zastępuje ${r.supersededByKey.map((i) => `#${i}`).join(", ")} (ten sam klucz)` : ""}`,
      );
      return;
    }

    case "backfill": {
      const { backfill } = await import("./importers/backfill.ts");
      const since = flag("since") ? Date.parse(flag("since")!) : undefined;
      const t0 = performance.now();
      let lastPrint = 0;
      const res = backfill(repo(), {
        since,
        limit: flag("limit") ? Number(flag("limit")) : undefined,
        onProgress: (done, total, f, ins) => {
          if (performance.now() - lastPrint > 1000 || done === total) {
            lastPrint = performance.now();
            process.stdout.write(`\r  ${done}/${total} plików, ostatni ${f.sessionId.slice(0, 8)} (+${ins})        `);
          }
        },
      });
      console.log(
        `\nbackfill: ${res.files} transkryptów, ${(res.bytes / 1e6).toFixed(0)} MB, nowe notatki ${res.inserted}, sesje pokryte przez claude-mem ${res.skippedCovered}, usunięte sesje automatów ${res.purged}, ${Math.round((performance.now() - t0) / 1000)} s`,
      );
      await call("/api/notify", { body: { kind: "backfill" }, timeoutMs: 500 });
      return;
    }

    case "embed": {
      const { bulkEmbed } = await import("./importers/embed-bulk.ts");
      const r = await bulkEmbed(repo(), {
        device: flag("device"),
        dtype: flag("dtype"),
        batch: flag("batch") ? Number(flag("batch")) : undefined,
        max: flag("max") ? Number(flag("max")) : undefined,
        onProgress: (d, t, ps) =>
          process.stdout.write(
            `\r  ${d}/${t} wektorów, ${ps.toFixed(0)}/s, zostało ~${Math.round((t - d) / Math.max(ps, 0.1) / 60)} min      `,
          ),
      });
      console.log(`\nwektory: ${r.done} w ${Math.round(r.ms / 1000)} s (${r.device})`);
      return;
    }

    case "sleep": {
      const { sleep, sleepLlm } = await import("./consolidate/sleep.ts");
      // await: sen bywa asynchroniczny (kroki z przerwami); etap LLM rusza dopiero po nim
      console.log(await sleep(repo(), { full: has("full") }));
      if (has("llm")) {
        const r = await sleepLlm(repo());
        console.log(r ? formatLlm(r) : "etap z LLM wyłączony (consolidation.llm.enabled = false)");
      }
      return;
    }

    case "notify": {
      const sub = positional()[0] ?? "status";
      const N = await import("./notify/notify.ts");
      const cfg = loadConfig();
      if (sub === "status") return console.log(N.notifyStatus(repo(), cfg).join("\n"));
      if (sub !== "test" && sub !== "run") {
        console.log("użycie: hipokamp notify status|test|run");
        process.exitCode = 1;
        return;
      }
      // próba idzie przez kanały także przy wyłączonych powiadomieniach (żeby sprawdzić je przed włączeniem)
      const r = sub === "test" ? await N.testNotify(cfg.notify) : await N.runNotify(repo(), cfg.notify);
      if (r.reason) console.log(r.reason);
      if (r.message) console.log(`${r.message.title}\n${r.message.text}`);
      if (r.delivered.length) console.log(`doręczone: ${r.delivered.join(", ")}`);
      for (const f of r.failed) console.log(`błąd kanału ${f.channel}: ${f.error}`);
      if (r.failed.length && !r.delivered.length) process.exitCode = 1;
      return;
    }

    case "llm": {
      const sub = positional()[0] ?? "check";
      const cfg = loadConfig();
      const l = llmConfig(cfg);
      if (sub === "check") {
        const { isLoopbackUrl } = await import("./util/net.ts");
        const { ollamaModels, isCloudModel } = await import("./llm/ollama.ts");
        const shown = { ...DEFAULTS.consolidation.llm!, ...(cfg.consolidation.llm ?? {}) };
        console.log(`etap z LLM: ${l ? "włączony" : "wyłączony (consolidation.llm.enabled = false)"}`);
        console.log(
          `adres: ${shown.baseUrl}${isLoopbackUrl(shown.baseUrl) ? "" : "  ← odrzucony: tylko 127.0.0.1, ::1, localhost"}`,
        );
        const cloud = isCloudModel(shown.model);
        console.log(
          `model: ${shown.model || "(nie ustawiony: consolidation.llm.model)"}${cloud ? "  ← odrzucony: model chmurowy Ollamy wysyła treść na ollama.com" : ""}`,
        );
        if (!isLoopbackUrl(shown.baseUrl) || cloud) {
          process.exitCode = 1;
          return;
        }
        const models = await ollamaModels(shown);
        if (!models) console.log("Ollama nie odpowiada pod tym adresem (uruchom: ollama serve)");
        else {
          console.log(
            `modele w Ollamie: ${models.map((m) => (isCloudModel(m) ? `${m} (chmurowy, niedozwolony)` : m)).join(", ") || "brak"}`,
          );
          if (shown.model && !models.includes(shown.model))
            console.log(`brak modelu ${shown.model}: pobierz go sam (ollama pull ${shown.model}); hipokamp niczego nie pobiera`);
        }
        return;
      }
      if (sub !== "run") {
        console.log("użycie: hipokamp llm check|run [--max n]");
        process.exitCode = 1;
        return;
      }
      if (!l) {
        console.log("etap z LLM wyłączony: ustaw consolidation.llm.enabled = true i consolidation.llm.model w config.json");
        process.exitCode = 1;
        return;
      }
      const { llmConsolidate } = await import("./llm/consolidate.ts");
      const r = await llmConsolidate(repo(), l, { maxCalls: flag("max") ? Number(flag("max")) : undefined });
      console.log(formatLlm(r));
      return;
    }

    case "import-automemory": {
      const { importAutoMemory, formatMemoryReport, markAutoMemoryApplied, autoMemoryState, isDefaultRoot } = await import(
        "./importers/automemory.ts"
      );
      const apply = has("apply");
      if (!apply) {
        // plan: baza tylko do odczytu (jak import-claude-mem --dry-run), nic się nie zapisuje
        const { openDb } = await import("./db/db.ts");
        const db = openDb({ readonly: true });
        try {
          const rep = importAutoMemory(new Repo(db), { root: flag("root"), decode: true });
          console.log(formatMemoryReport(rep, { apply, all: has("all") }));
          console.log(`nadrabianie w workerze: ${autoMemoryState(db).why}`);
        } finally {
          db.close();
        }
        return;
      }
      const r = repo();
      const rep = importAutoMemory(r, { root: flag("root"), apply: true, decode: true });
      // pierwszy ręczny import z domyślnego katalogu włącza dociąganie zmian w workerze (capture.autoMemory = null);
      // próba na innym katalogu (--root) tego nie robi
      const own = isDefaultRoot(flag("root"));
      if (own) markAutoMemoryApplied(r);
      console.log(formatMemoryReport(rep, { apply, all: has("all") }));
      console.log(
        `nadrabianie w workerze: ${autoMemoryState(r.db).why}${own ? "" : " (import z innego katalogu niż domyślny nie włącza nadrabiania)"}`,
      );
      if (rep.inserted || rep.updated) await call("/api/notify", { body: { kind: "automemory" }, timeoutMs: 500 });
      return;
    }

    case "export-vault": {
      const dir = positional()[0];
      if (!dir) {
        console.log("podaj katalog: hipokamp export-vault <katalog vaulta>  (eksport nigdy nie pisze w miejsce domyślne)");
        process.exitCode = 1;
        return;
      }
      const { exportVault } = await import("./core/vault.ts");
      const r = exportVault(repo(), {
        dir,
        project: flag("project"),
        types: flag("types")
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        layout: has("per-project") ? "project" : "note",
        dryRun: has("dry-run"),
      });
      console.log(
        `${has("dry-run") ? "(próba) " : ""}${r.dir}: notatki ${r.notes}, zapisane pliki ${r.written}, bez zmian ${r.unchanged}, pominięte (cudze pliki o tej nazwie) ${r.conflicts.length}`,
      );
      for (const c of r.conflicts.slice(0, 10)) console.log(`  pominięty: ${c}`);
      return;
    }

    case "supersede": {
      // zastępowanie decyzji i preferencji z digestu (ten sam etap co w śnie); --dry-run: plan na bazie tylko do odczytu
      // --ids 12,34: tylko wskazane starsze notatki (lewa strona `#12 → #15`), parą z propozycji snu albo z planu
      const { applySelected, supersedeSimilar } = await import("./core/supersede.ts");
      const dry = has("dry-run");
      const days = Number(flag("days", "120"));
      // samo `--ids` bez numerów nie może przejść w „zastąp wszystko”
      const idsGiven = argv.some((a) => a === "--ids" || a.startsWith("--ids="));
      const idsArg = idsGiven ? (flag("ids") ?? "") : undefined;
      const ids = idsArg?.split(",").map((s) => Number(s.trim().replace(/^#/, "")));
      if (idsArg !== undefined && (!ids?.length || ids.some((n) => !Number.isInteger(n) || n <= 0))) {
        console.log(`--ids: oczekuję numerów po przecinku, np. --ids 12,34 (dostałem: ${idsArg})`);
        process.exitCode = 1;
        return;
      }
      if (ids && dry) {
        console.log("--ids zastępuje wskazane pary; podgląd planu: hipokamp supersede --dry-run (bez --ids)");
        process.exitCode = 1;
        return;
      }
      const { openDb } = await import("./db/db.ts");
      const db = dry ? openDb({ readonly: true }) : getDb();
      const line = (p: import("./core/supersede.ts").SupersedePair) =>
        `#${p.older} → #${p.newer} [${p.type}] ${p.project} (${p.reason}; tytuł ${p.jaccard}${p.cos === null ? "" : `, cosinus ${p.cos}`})\n  było: ${p.olderTitle.slice(0, 110)}\n  jest: ${p.newerTitle.slice(0, 110)}`;
      try {
        if (ids) {
          const r = await applySelected(new Repo(db), ids, days);
          if (has("json")) console.log(JSON.stringify(r, null, 2));
          else {
            for (const p of r.applied) console.log(line(p));
            console.log(
              `zastąpione: ${r.applied.length} z ${ids.length}${r.missing.length ? `; bez propozycji ani pary w planie: ${r.missing.map((i) => `#${i}`).join(", ")}` : ""}${r.skipped.length ? `; pominięte (notatka już nieaktywna): ${r.skipped.map((i) => `#${i}`).join(", ")}` : ""}${r.applied.length ? "; cofnięcie: forget z undo" : ""}`,
            );
          }
          return;
        }
        const pairs = await supersedeSimilar(new Repo(db), Date.now() - days * 86_400_000, { dryRun: dry, logPairs: !dry });
        if (has("json")) console.log(JSON.stringify(pairs, null, 2));
        else {
          for (const p of pairs) console.log(line(p));
          console.log(
            `${dry ? "(próba) do zastąpienia" : "zastąpione"}: ${pairs.length} z ostatnich ${days} dni${pairs.length && !dry ? "; cofnięcie: forget z undo" : ""}${pairs.length && dry ? "; wybrane: hipokamp supersede --ids 12,34" : ""}`,
          );
        }
      } finally {
        if (dry) db.close();
      }
      return;
    }

    case "reindex": {
      const t0 = performance.now();
      const r = await repo().reindexFts({ onProgress: (t, n) => process.stdout.write(`\r  ${t}: ${n}        `) });
      console.log(
        `\nFTS: ${r.observations} notatek, ${r.prompts} promptów, ${r.summaries} podsumowań, ${Math.round((performance.now() - t0) / 1000)} s`,
      );
      return;
    }

    case "redigest": {
      const { redigest } = await import("./capture/redigest.ts");
      const ids = (flag("ids") ?? "")
        .split(/[,\s]+/)
        .map((x) => Number(x.replace(/^#/, "")))
        .filter((x) => x > 0);
      let shown = 0;
      const r = redigest(repo(), {
        ids: ids.length ? ids : undefined,
        all: has("all"),
        dryRun: has("dry-run"),
        limit: flag("limit") ? Number(flag("limit")) : undefined,
        onChange: (o, next) => {
          if (shown++ < 12) console.log(`#${o.id}\n  było: ${o.title.slice(0, 110)}\n  jest: ${next.title.slice(0, 110)}`);
        },
      });
      console.log(
        `${has("dry-run") ? "(próba) " : ""}sprawdzone ${r.checked}, zmienione ${r.updated}, bez zmian ${r.unchanged}, pominięte ${r.skipped}, brak transkryptu ${r.missingTranscript}`,
      );
      if (r.updated && !has("dry-run")) console.log("wektory zmienionych notatek przeliczy worker w tle");
      return;
    }

    case "repair": {
      const { repair, formatRepairReport } = await import("./core/repair.ts");
      const { FORCE_SYNC_FLAG, syncInUse, syncWarning } = await import("./core/sync-guard.ts");
      const { openDb } = await import("./db/db.ts");
      const { existsSync } = await import("node:fs");
      const say = (m: string) => console.log(m);
      if (has("dry-run")) {
        // próba: baza otwarta tylko do odczytu (bez migracji), żadnego zapisu, także dziennika zmian
        const db = openDb({ readonly: true });
        try {
          const sync = syncInUse(db);
          if (sync) say(syncWarning("repair", sync, false));
          console.log(formatRepairReport(repair(new Repo(db), { dryRun: true, cmDbPath: flag("db"), log: say })));
        } finally {
          db.close();
        }
        return;
      }
      // najpierw repair, potem sync: po synchronizacji zmiana zapisanych wierszy nie dotarłaby do innych komputerów
      if (existsSync(paths.db()) && !argv.includes(FORCE_SYNC_FLAG)) {
        const ro = openDb({ readonly: true });
        let sync: string | null;
        try {
          sync = syncInUse(ro);
        } finally {
          ro.close();
        }
        if (sync) {
          say(syncWarning("repair", sync, true));
          process.exitCode = 1;
          return;
        }
      }
      // naprawa zmienia numery i statusy, które worker i hooki właśnie czytają albo piszą: tylko przy zatrzymanym
      // (także starszym bez uwierzytelnienia i zajętym, który nie zdążył odpowiedzieć: liczy się zajęty port)
      const busy = await probeWorker();
      if (busy.state !== "none") {
        console.log(`${portBusy(busy)} Próba (--dry-run) działa przy workerze.`);
        process.exitCode = 1;
        return;
      }
      const { backupDbFile, stamp } = await import("./core/backup.ts");
      // kopia z pliku przed pierwszym otwarciem do zapisu: to otwarcie robi migracje schematu (nowsza wersja)
      if (existsSync(paths.db())) {
        const b = backupDbFile(paths.db(), { keep: loadConfig().backup.keep, tag: "pre-repair" });
        console.log(`kopia przed naprawą: ${b.file}`);
      }
      const r = repo();
      const rep = repair(r, { cmDbPath: flag("db"), logPath: join(paths.logs(), `repair-${stamp()}.jsonl`), log: say });
      console.log(formatRepairReport(rep));
      if (rep.changes) console.log("wektory zmienionych notatek przeliczy worker w tle");
      return;
    }

    case "project": {
      const { projectCommand } = await import("./core/projects.ts");
      process.exitCode = projectCommand(argv.slice(1));
      return;
    }

    case "sync": {
      const { syncCommand } = await import("./sync/cli.ts");
      process.exitCode = await syncCommand(argv.slice(1));
      return;
    }

    case "backup": {
      const { backupDb } = await import("./core/backup.ts");
      const r = backupDb(repo().db, { keep: flag("keep") ? Number(flag("keep")) : loadConfig().backup.keep });
      console.log(
        `kopia: ${r.file} (${(r.bytes / 1e6).toFixed(0)} MB, ${r.ms} ms)${r.removed.length ? `, usunięte stare: ${r.removed.length}` : ""}`,
      );
      return;
    }

    case "restore": {
      const file = positional()[0];
      if (!file) {
        const { listBackups } = await import("./core/backup.ts");
        console.log("Podaj plik. Dostępne kopie:");
        for (const b of listBackups()) console.log(`  ${b.file}  ${(b.bytes / 1e6).toFixed(0)} MB`);
        return;
      }
      const busy = await probeWorker();
      if (busy.state !== "none") {
        console.log(portBusy(busy));
        process.exitCode = 1;
        return;
      }
      const { restoreDb } = await import("./core/backup.ts");
      const r = restoreDb(file);
      console.log(`przywrócono ${file}${r.previous ? `; poprzednia baza: ${r.previous}` : ""}`);
      return;
    }

    case "import-claude-mem": {
      const { importClaudeMem } = await import("./importers/claude-mem.ts");
      const log = (m: string) => console.log(m);
      if (has("dry-run")) {
        // próba: baza tylko do odczytu, bez migracji i bez wektorów (jak repair --dry-run)
        const { openDb } = await import("./db/db.ts");
        const db = openDb({ readonly: true });
        try {
          await importClaudeMem(new Repo(db), { dbPath: flag("db"), dryRun: true, log });
        } finally {
          db.close();
        }
        return;
      }
      await importClaudeMem(repo(), { dbPath: flag("db"), log });
      return;
    }

    case "recall-stats": {
      // tylko odczyt: dziennik decyzji z logs/ i ślady pobrań z bazy otwartej bez zapisu (bez migracji)
      const { recallStats, formatRecallStats } = await import("./recall/recallstats.ts");
      const { openDb } = await import("./db/db.ts");
      const db = openDb({ readonly: true });
      try {
        const r = recallStats(new Repo(db), {
          logsDir: paths.logs(),
          days: Number(flag("days", "14")),
          windowMin: Number(flag("window", "60")),
          minN: Number(flag("min-n", "20")),
          threshold: Number(flag("threshold", String(loadConfig().context.promptMinScore))),
        });
        console.log(has("json") ? JSON.stringify(r, null, 2) : formatRecallStats(r));
      } finally {
        db.close();
      }
      return;
    }

    case "eval": {
      const { runEval } = await import("./eval/eval.ts");
      await runEval(repo(), {
        sessions: Number(flag("sessions", "150")),
        k: Number(flag("k", "10")),
        log: (m) => console.log(m),
      });
      return;
    }

    case "install":
    case "rollback":
    case "uninstall": {
      const inst = await import("./install/install.ts");
      if (cmd === "install") {
        const ok = await inst.install({
          replace: has("replace-claude-mem"),
          dryRun: has("dry-run"),
          codex: !has("no-codex"),
          skipHarnesses: {
            gemini: has("no-gemini"),
            antigravity: has("no-antigravity"),
            cursor: has("no-cursor"),
            opencode: has("no-opencode"),
            "claude-desktop": has("no-claude-desktop"),
          },
          autostart: !has("no-autostart"),
          log: (m) => console.log(m),
        });
        if (!ok) process.exitCode = 1;
      } else await inst.rollback({ dryRun: has("dry-run"), log: (m) => console.log(m) });
      return;
    }

    case "update": {
      const u = await import("./install/update.ts");
      const log = (m: string) => console.log(m);
      const ok = has("finish")
        ? await u.finishUpdate({ from: flag("finish"), log })
        : await u.update({ dryRun: has("dry-run"), log });
      if (!ok) process.exitCode = 1;
      return;
    }

    case "doctor": {
      const { doctor } = await import("./install/doctor.ts");
      await doctor((m) => console.log(m));
      return;
    }

    case "config": {
      console.log(JSON.stringify(has("defaults") ? DEFAULTS : loadConfig(), null, 2));
      return;
    }

    default:
      console.log(`nieznana komenda: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

await main();
