// Plugin OpenCode: zapis sesji do pamięci hipokampa. OpenCode trzyma rozmowy u siebie (wewnętrzny magazyn bez
// opisanego formatu), więc plugin bierze je przez jego SDK, gdy sesja się zatrzyma (`session.idle`), i dopisuje
// transkrypt w kształcie linii Claude Code do ~/.hipokamp/transcripts/opencode/<id sesji>.jsonl. Dalej działa wspólny
// zapis: plugin woła hook Stop (`bun hook.ts stop opencode`, odłączony proces), a nadrabianie i backfill czytają ten
// katalog. Plik pluginu w konfiguracji OpenCode (plugins/hipokamp.js) zapisuje `hipokamp install`: ładuje ten moduł
// dynamicznie (błąd importu, np. po przeniesieniu repo, wyłącza tylko plugin) i eksportuje tylko fabrykę pluginu.
// Prywatność jak przy zapisie: tekst przechodzi przez clean() (sekrety, <private>), narzędzia z capture.privateTools
// bez wejścia i wyniku, a capture.harnesses.opencode: false wyłącza zapis. Przeczytane i stare pliki sprząta worker
// (capture.opencodeKeepDays, transcriptName). Plugin działa w procesie OpenCode: nie ładuje bazy ani modeli (tylko
// czyste moduły redakcji), błąd nigdy nie wychodzi poza plugin.
// Kontekst (jak SessionStart i UserPromptSubmit w Claude Code): `chat.message` uruchamia hook.ts `session-start`
// (raz na sesję; `experimental.chat.system.transform` dokłada jego odpowiedź do promptu systemowego, stałego przez
// całą sesję, więc pamięć podręczna rozmowy u dostawcy działa) i `prompt` z tekstem wiadomości (odpowiedź jako
// syntetyczna część tej wiadomości użytkownika). Bez id sesji nic nie trafia do modelu. Hook ma twardy limit czasu
// (start 8 s, prompt 5 s): po nim i przy błędzie model rusza bez kontekstu. To API pluginu V1 (`@opencode-ai/plugin`); OpenCode bez tych hooków ich nie woła, a zapis działa dalej.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPrivateTool } from "./private-tools.ts";
import { clean } from "./redact.ts";

export interface OpencodeOptions {
  /** Katalog transkryptów (…/.hipokamp/transcripts/opencode). */
  dir: string;
  /** Bun i hook.ts hipokampa (hook Stop po dopisaniu tury); bez nich zapis zostaje dla nadrabiania. */
  bun?: string;
  hook?: string;
  /** HIPOKAMP_HOME instalacji, gdy inny niż domyślny. */
  home?: string;
  /** config.json hipokampa: capture.privateTools i capture.harnesses.opencode czytane przy każdym zapisie. */
  config?: string;
  /** Narzędzia prywatne, gdy config.json ich nie ustawia (domyślne hipokampa). */
  privateTools?: string[];
  /** Limit czasu pobrania wiadomości sesji z OpenCode (ms). */
  timeoutMs?: number;
  /** Uruchomienie hooka (testy podstawiają własne). */
  spawn?: (cmd: string[], stdin: string, env: Record<string, string>) => void;
  /** Hook z odpowiedzią (kontekst na start sesji i przy prompcie): stdout albo "" po limicie czasu (testy: własny). */
  run?: (cmd: string[], stdin: string, env: Record<string, string>, timeoutMs: number) => Promise<string>;
  /** Limity czasu hooka kontekstu (ms): start sesji i prompt. Po nich model rusza bez kontekstu hipokampa. */
  startTimeoutMs?: number;
  promptTimeoutMs?: number;
}

const MAX_RESULT = 4000;
/** Domyślne capture.privateTools (src/config.ts), gdy plugin nie dostał listy. */
const DEFAULT_PRIVATE = ["mcp__sejf__", "mcp__plugin_sejf", "reveal_secret"];

const iso = (t: unknown): string | undefined => (typeof t === "number" && t > 0 ? new Date(t).toISOString() : undefined);

/** Napisy w wejściu narzędzia po clean() (komenda może nieść hasło); inne wartości bez zmian. */
function cleanInput(a: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === "string" ? clean(v) : v;
  return out;
}

/** Narzędzie OpenCode jako narzędzie Claude Code (nazwa i pola, które czyta streszczenie); łatka: jedno na plik. */
export function opencodeTool(
  tool: string,
  input: any,
  priv: readonly string[] = DEFAULT_PRIVATE,
): { name: string; input: Record<string, any> }[] {
  const a = input && typeof input === "object" ? input : {};
  const file = a.filePath ?? a.file_path ?? a.path;
  switch (tool) {
    case "bash":
      return [{ name: "Bash", input: { command: clean(String(a.command ?? "")) } }];
    case "read":
      return [{ name: "Read", input: { file_path: file } }];
    case "write":
      return [{ name: "Write", input: { file_path: file } }];
    case "edit":
    case "multiedit":
      return [{ name: "Edit", input: { file_path: file } }];
    case "patch":
    case "apply_patch": {
      const text = String(a.patchText ?? a.patch ?? a.input ?? "");
      const out: { name: string; input: Record<string, any> }[] = [];
      for (const m of text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/gm))
        out.push({ name: m[1] === "Add" ? "Write" : "Edit", input: { file_path: m[2] } });
      return out;
    }
    case "glob":
      return [{ name: "Glob", input: { pattern: a.pattern, path: a.path } }];
    case "grep":
      return [{ name: "Grep", input: { pattern: a.pattern, path: a.path } }];
    case "list":
      return [{ name: "LS", input: { path: a.path } }];
    case "webfetch":
      return [{ name: "WebFetch", input: { url: a.url } }];
    case "websearch":
      return [{ name: "WebSearch", input: { query: a.query } }];
    case "task":
      return [{ name: "Agent", input: { description: clean(String(a.description ?? a.subagent_type ?? "agent")) } }];
    default:
      return [{ name: tool, input: isPrivateTool(tool, priv) ? {} : cleanInput(a) }];
  }
}

/** Wiadomość OpenCode ({info, parts}) jako linie transkryptu; `last`: ostatnia wiadomość sesji (koniec tury). */
export function messageLines(m: any, cwd: string, last: boolean, priv: readonly string[] = DEFAULT_PRIVATE): any[] {
  const info = m?.info ?? {};
  const parts: any[] = Array.isArray(m?.parts) ? m.parts : [];
  const id = String(info.id ?? "");
  const dir = typeof info.path?.cwd === "string" && info.path.cwd ? info.path.cwd : cwd;
  if (info.role === "user") {
    const content: object[] = [];
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored && p.text.trim())
        content.push({ type: "text", text: clean(p.text) });
      else if (p?.type === "file" && String(p.mime ?? "").startsWith("image/")) content.push({ type: "image" });
    }
    if (!content.length) return [];
    return [{ type: "user", uuid: id, timestamp: iso(info.time?.created), cwd: dir, message: { role: "user", content } }];
  }
  if (info.role !== "assistant") return [];
  const at = iso(info.time?.completed ?? info.time?.created);
  const blocks: object[] = [];
  const results: object[] = [];
  for (const p of parts) {
    if (p?.type === "text" && typeof p.text === "string" && !p.synthetic && p.text.trim())
      blocks.push({ type: "text", text: clean(p.text) });
    if (p?.type !== "tool") continue;
    const tool = String(p.tool ?? "");
    const st = p.state ?? {};
    const calls = opencodeTool(tool, st.input, priv);
    calls.forEach((c, i) => {
      const cid = i === calls.length - 1 ? String(p.callID ?? p.id) : `${p.callID ?? p.id}:${i}`;
      blocks.push({ type: "tool_use", id: cid, name: c.name, input: c.input });
      if (st.status !== "completed" && st.status !== "error") return;
      const raw = isPrivateTool(tool, priv) ? "" : clean(String(st.output ?? st.error ?? ""));
      const content = raw.length > MAX_RESULT ? `${raw.slice(0, MAX_RESULT)}…` : raw;
      results.push({ type: "tool_result", tool_use_id: cid, content, is_error: st.status === "error" });
    });
  }
  const done = last || (typeof info.finish === "string" && info.finish !== "tool-calls" && info.finish !== "unknown");
  const out: any[] = [];
  if (blocks.length || done)
    out.push({
      type: "assistant",
      uuid: id,
      timestamp: at,
      cwd: dir,
      message: { role: "assistant", model: info.modelID ?? null, content: blocks, stop_reason: done ? "end_turn" : null },
    });
  // wyniki przed końcem tury: znacznik end_turn ma być ostatnią wiadomością (lastTurnComplete)
  if (results.length) {
    const end = out.length && done ? out.pop() : null;
    if (end) out.push({ ...end, message: { ...end.message, stop_reason: "tool_use" } });
    out.push({ type: "user", uuid: `${id}#wyniki`, timestamp: at, cwd: dir, message: { role: "user", content: results } });
    if (end)
      out.push({ type: "assistant", uuid: `${id}#koniec`, timestamp: at, cwd: dir, message: { ...end.message, content: [] } });
  }
  return out;
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

/** Plik w katalogu transkryptów z listą sprzątniętych (nazwa pliku bez .jsonl → czas jego ostatniej zmiany, ms). */
export const PRUNED_FILE = "pruned.json";

/**
 * Nazwa transkryptu sesji: `<id>`, a po sprzątnięciu starego pliku (capture.opencodeKeepDays, PRUNED_FILE) kolejna
 * `<id>.<n>`; w niej są tylko wiadomości nowsze od sprzątniętego pliku (`after`), więc wznowiona sesja nie wraca
 * do pamięci drugi raz i ma nowy klucz.
 */
export function transcriptName(dir: string, id: string): { name: string; after: number } {
  const base = safeName(id);
  let pruned: Record<string, unknown> = {};
  try {
    pruned = JSON.parse(readFileSync(join(dir, PRUNED_FILE), "utf8")) ?? {};
  } catch {}
  let n = 1;
  let after = 0;
  for (const [k, t] of Object.entries(pruned)) {
    const tail = k.startsWith(`${base}.`) ? k.slice(base.length + 1) : "";
    const gen = k === base ? 1 : /^\d+$/.test(tail) ? Number(tail) : 0;
    if (!gen) continue;
    n = Math.max(n, gen + 1);
    after = Math.max(after, typeof t === "number" ? t : 0);
  }
  return { name: n === 1 ? base : `${base}.${n}`, after };
}

function defaultSpawn(cmd: string[], stdin: string, env: Record<string, string>): void {
  const B = (globalThis as any).Bun;
  if (!B?.spawn) return;
  const p = B.spawn(cmd, { stdin: new Blob([stdin]), stdout: "ignore", stderr: "ignore", env });
  p.unref?.();
}

/**
 * Hook z odpowiedzią: stdout procesu albo "" (błąd uruchomienia, limit czasu: proces zabity). Plugin czeka na niego
 * przed wywołaniem modelu, więc limit jest twardy, a błąd to cisza.
 */
async function defaultRun(cmd: string[], stdin: string, env: Record<string, string>, ms: number): Promise<string> {
  const B = (globalThis as any).Bun;
  if (!B?.spawn) return "";
  let p: any;
  try {
    p = B.spawn(cmd, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "ignore", env });
  } catch {
    return "";
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([
    new Response(p.stdout).text().catch(() => ""),
    new Promise<string>((r) => {
      t = setTimeout(() => {
        try {
          p.kill();
        } catch {}
        r("");
      }, ms);
    }),
  ]);
  clearTimeout(t);
  return out;
}

/** Kontekst z wyjścia hook.ts (kształt Claude Code: hookSpecificOutput.additionalContext) albo null. */
function contextOf(out: string | null): string | null {
  try {
    const t = out ? JSON.parse(out)?.hookSpecificOutput?.additionalContext : null;
    return typeof t === "string" && t.trim() ? t : null;
  } catch {
    return null;
  }
}

/** Ustawienia z config.json hipokampa przy każdym zapisie (zmiana działa bez restartu OpenCode). */
function settings(opts: OpencodeOptions): { off: boolean; priv: string[] } {
  let c: any = null;
  try {
    if (opts.config && existsSync(opts.config)) c = JSON.parse(readFileSync(opts.config, "utf8"));
  } catch {}
  const priv = Array.isArray(c?.capture?.privateTools) ? c.capture.privateTools : (opts.privateTools ?? DEFAULT_PRIVATE);
  return { off: c?.capture?.harnesses?.opencode === false, priv };
}

/** Obietnica z limitem czasu: po nim null (OpenCode nie odpowiada, a plugin nie może wisieć). */
function within<T>(p: Promise<T> | undefined, ms: number): Promise<T | null> {
  if (!p) return Promise.resolve(null);
  // zegar trzyma pętlę zdarzeń (bez unref: inaczej czekanie na zawieszone wywołanie nie kończy się nigdy), a po
  // odpowiedzi OpenCode jest od razu zdejmowany
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((r) => {
      t = setTimeout(() => r(null), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export default function hipokampOpencode(opts: OpencodeOptions) {
  const timeout = opts.timeoutMs ?? 10_000;
  return async (ctx: any) => {
    const client = ctx?.client;
    const directory = String(ctx?.directory ?? process.cwd());
    const written = new Map<string, Set<string>>();
    const subagent = new Map<string, boolean>();
    const queue = new Map<string, Promise<void>>();

    /** Id wiadomości już zapisanych w transkrypcie sesji (po restarcie OpenCode z pliku). */
    const seen = (file: string, id: string): Set<string> => {
      let s = written.get(id);
      if (s) return s;
      s = new Set();
      if (existsSync(file))
        for (const l of readFileSync(file, "utf8").split("\n")) {
          try {
            const u = JSON.parse(l)?.uuid;
            if (typeof u === "string") s.add(u.split("#")[0]);
          } catch {}
        }
      written.set(id, s);
      return s;
    };

    const sync = async (id: string): Promise<void> => {
      const cfg = settings(opts);
      if (cfg.off) return;
      if (!subagent.has(id)) {
        if (typeof client?.session?.get !== "function") subagent.set(id, false);
        else {
          const info = await within<any>(client.session.get({ path: { id } }), timeout);
          if (info === null) return; // OpenCode nie odpowiedział: spróbujemy przy następnym zatrzymaniu
          subagent.set(id, !!info?.data?.parentID);
        }
      }
      // podagent (narzędzie task): jego wynik jest w sesji głównej
      if (subagent.get(id)) return;
      const res = await within<any>(
        client?.session?.messages?.({ path: { id }, query: { directory }, signal: AbortSignal.timeout(timeout) }),
        timeout,
      );
      const msgs: any[] = Array.isArray(res?.data) ? res.data : [];
      if (!msgs.length) return;
      mkdirSync(opts.dir, { recursive: true });
      const { name, after } = transcriptName(opts.dir, id);
      const file = join(opts.dir, `${name}.jsonl`);
      const done = seen(file, id);
      const lines: any[] = [];
      for (const [i, m] of msgs.entries()) {
        const mid = String(m?.info?.id ?? "");
        if (!mid || done.has(mid)) continue;
        // zapisana w sprzątniętym już pliku (sesja wznowiona po czasie retencji)
        if (after && typeof m.info.time?.created === "number" && m.info.time.created <= after) continue;
        // odpowiedź jeszcze się pisze: ona i dalsze poczekają na następne zatrzymanie sesji
        if (m.info.role === "assistant" && !m.info.time?.completed) break;
        lines.push(...messageLines(m, directory, i === msgs.length - 1, cfg.priv));
        done.add(mid);
      }
      if (!lines.length) return;
      appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      if (!opts.bun || !opts.hook) return;
      const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: directory };
      if (opts.home) env.HIPOKAMP_HOME = opts.home;
      const input = JSON.stringify({ session_id: name, transcript_path: file, cwd: directory, hook_event_name: "Stop" });
      (opts.spawn ?? defaultSpawn)([opts.bun, opts.hook, "stop", "opencode"], input, env);
    };

    // ── kontekst (hook.ts z odpowiedzią): start sesji w prompcie systemowym, prompt w wiadomości użytkownika ──
    // Prompt systemowy musi być stały w całej sesji (inaczej każda wiadomość unieważnia pamięć podręczną rozmowy
    // u dostawcy modelu), więc trafia do niego tylko kontekst startu. Przypomnienie do bieżącego promptu idzie jako
    // syntetyczna część wiadomości użytkownika: zostaje w historii, a wcześniejsze wiadomości się nie zmieniają.
    const startMs = opts.startTimeoutMs ?? 8000;
    const promptMs = opts.promptTimeoutMs ?? 5000;
    /** Kontekst startu sesji (raz na sesję w tym procesie OpenCode). */
    const contexts = new Map<string, { start?: Promise<string | null> }>();

    const hookContext = (event: "session-start" | "prompt", id: string, extra: object, ms: number) => {
      if (!opts.bun || !opts.hook || settings(opts).off) return Promise.resolve(null);
      const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: directory };
      if (opts.home) env.HIPOKAMP_HOME = opts.home;
      const input = JSON.stringify({
        session_id: transcriptName(opts.dir, id).name,
        cwd: directory,
        hook_event_name: event === "prompt" ? "UserPromptSubmit" : "SessionStart",
        ...extra,
      });
      // drugi limit nad limitem uruchomienia: własne `run` (testy) też nie zatrzyma modelu
      return within((opts.run ?? defaultRun)([opts.bun, opts.hook, event, "opencode"], input, env, ms), ms + 500).then(
        contextOf,
        () => null,
      );
    };

    return {
      event: async ({ event }: { event: any }): Promise<void> => {
        if (event?.type === "session.deleted") {
          const gone = String(event.properties?.sessionID ?? event.properties?.info?.id ?? "");
          contexts.delete(gone);
          return;
        }
        if (event?.type !== "session.idle") return;
        const id = String(event.properties?.sessionID ?? event.properties?.info?.id ?? "");
        if (!id) return;
        // zatrzymania jednej sesji po kolei: dwa naraz zapisałyby te same wiadomości dwa razy
        const next = (queue.get(id) ?? Promise.resolve()).then(() => sync(id)).catch(() => {});
        queue.set(id, next);
        await next;
      },
      // nowa wiadomość użytkownika: kontekst startu rusza w tle (czeka na niego prompt systemowy), przypomnienie do
      // promptu dochodzi jako syntetyczna część tej wiadomości (z limitem czasu). Podagent (narzędzie task) kontekstu
      // nie dostaje: pracuje na zleceniu sesji głównej. Bez id sesji nic nie wstrzykujemy (kontekst trafiłby do innej)
      "chat.message": async (input: any, output: any): Promise<void> => {
        try {
          const id = String(input?.sessionID ?? output?.message?.sessionID ?? "");
          if (!id || subagent.get(id)) return;
          const parts: any[] = Array.isArray(output?.parts) ? output.parts : [];
          const text = parts
            .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
            .map((p) => p.text)
            .join("\n")
            .trim();
          let c = contexts.get(id);
          if (!c) contexts.set(id, (c = {}));
          c.start ??= hookContext("session-start", id, { source: "startup" }, startMs);
          if (!text || !Array.isArray(output?.parts)) return;
          const add = await hookContext("prompt", id, { prompt: text }, promptMs);
          if (!add) return;
          const base = parts.find((p) => p?.type === "text") ?? parts[0] ?? {};
          const messageID = base.messageID ?? output?.message?.id ?? input?.messageID;
          output.parts.push({
            // id za częścią użytkownika (OpenCode sortuje części po id), z jej sesją i wiadomością
            id: typeof base.id === "string" ? `${base.id}hk` : `prt_hipokamp${Date.now().toString(36)}`,
            sessionID: id,
            ...(messageID ? { messageID } : {}),
            type: "text",
            text: add,
            synthetic: true,
          });
        } catch {}
      },
      // kontekst startu sesji jako dodatkowa część promptu systemowego: ten sam przez całą sesję. Bez id sesji nic
      "experimental.chat.system.transform": async (input: any, output: any): Promise<void> => {
        try {
          if (!Array.isArray(output?.system)) return;
          const id = String(input?.sessionID ?? "");
          const c = id ? contexts.get(id) : undefined;
          if (!c?.start) return;
          const t = await c.start;
          if (t) output.system.push(t);
        } catch {}
      },
    };
  };
}
