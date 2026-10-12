// Konfiguracja: wartości domyślne + ~/.hipokamp/config.json (+ zmienne środowiskowe HIPOKAMP_*).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EmbedConfig {
  enabled: boolean;
  /** Model ONNX (transformers.js). Ten sam model musi liczyć indeks i zapytania. */
  model: string;
  dims: number;
  pooling: "cls" | "mean";
  queryPrefix: string;
  passagePrefix: string;
  /** Zapytania w workerze (niska latencja). */
  device: string;
  dtype: string;
  /** Masowe liczenie (import, backfill): GPU przez DirectML, jeśli jest. */
  bulkDevice: string;
  bulkDtype: string;
  bulkBatch: number;
  /** Po ilu minutach bezczynności zwolnić model z RAM. */
  idleUnloadMin: number;
}

export interface ContextConfig {
  enabled: boolean;
  /** Budżet tokenów kontekstu na start sesji. */
  sessionStartBudget: number;
  /** Ile obserwacji pokazać z pełnymi faktami (reszta jako indeks). */
  fullCount: number;
  /** Ile ostatnich sesji (podsumowań) pokazać na starcie. */
  recentSessions: number;
  /** Przypominanie w trakcie rozmowy, warunkowane treścią promptu. */
  promptRecall: boolean;
  promptBudget: number;
  /** Minimalna trafność (0..1), poniżej której nic nie wstrzykujemy do promptu. */
  promptMinScore: number;
  /** Przypominanie przy otwarciu pliku (PostToolUse Read/Edit). */
  fileRecall: boolean;
  fileBudget: number;
}

/**
 * Opcjonalna konsolidacja lokalnym LLM (Ollama). Domyślnie wyłączona; nigdy w ścieżce hooka, nigdy sieć poza
 * pętlą zwrotną (adres zdalny = odmowa). Wyniki to dodatkowe pola notatek (meta.llm), nigdy zamiennik treści.
 */
export interface LlmConfig {
  enabled: boolean;
  /** Adres Ollamy: tylko 127.0.0.1, ::1 albo localhost. */
  baseUrl: string;
  /** Nazwa modelu w Ollamie (np. qwen2.5:14b, SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M); pusta = etap stoi. */
  model: string;
  /** Wykrywanie sprzeczności między decyzjami i preferencjami tego samego projektu. */
  contradictions: boolean;
  /** Jednozdaniowe „lekcje” dla najważniejszych notatek. */
  lessons: boolean;
  /** Limity jednego przebiegu: wywołania, czas całości, czas jednego wywołania. */
  maxCallsPerRun: number;
  maxRunSec: number;
  callTimeoutSec: number;
  /** Przebieg tylko po tylu minutach bezczynności workera, nie częściej niż co `everyHours`. */
  minIdleMin: number;
  everyHours: number;
  /** Kontekst modelu i długość odpowiedzi (pamięć GPU), czas trzymania modelu po przebiegu. */
  numCtx: number;
  numPredict: number;
  keepAlive: string;
}

/** Powiadomienia o wybranych notatkach (odpowiednik CLAUDE_MEM_TELEGRAM_*, tylko kanały lokalne). Domyślnie wyłączone. */
export interface NotifyConfig {
  enabled: boolean;
  /** Typy notatek i minimalna ważność, które zasługują na powiadomienie. */
  types: string[];
  minImportance: number;
  /** Źródła notatek (import i backfill nie powiadamiają: to stare rzeczy). */
  sources: string[];
  /** Tylko te projekty (puste = wszystkie). */
  projects: string[];
  /** Notatki starsze niż tyle minut w chwili wysyłki są pomijane. */
  maxAgeMin: number;
  /** Kanały: toast (Windows), file (kolejka JSONL), webhook (127.0.0.1), command (polecenie z treścią na stdin). */
  channels: string[];
  /** Limit częstości: odstęp między wysyłkami i limit na godzinę; nadmiar idzie zbiorczo w następnej wysyłce. */
  minIntervalSec: number;
  maxPerHour: number;
  /** Ile notatek wypisać w jednym zbiorczym powiadomieniu (reszta jako „i N więcej”). */
  maxItems: number;
  /** Plik kolejki (pusty: <dane>/notify/outbox.jsonl). */
  file: string;
  /** Adres lokalnego webhooka (tylko 127.0.0.1, ::1, localhost). */
  webhook: string;
  /** Polecenie jako lista argumentów (bez powłoki), treść JSON na stdin. */
  command: string[];
  commandTimeoutSec: number;
}

/**
 * Jak Claude Code woła hooki pluginu. command: proces `bun hook.ts`; mcp: narzędzia hook_* działającego serwera MCP
 * (SessionStart zostaje command, bo przy starcie sesji serwery MCP jeszcze nie działają); native: plik wykonywalny
 * z native/hook (rozmawia z workerem, zapasowo hook Buna); auto: native, gdy zbudowany i przeszedł test dymny,
 * inaczej command. Zmiana działa po `hipokamp install` (generuje hooks.json pluginu).
 */
export type HooksMode = "auto" | "command" | "mcp" | "native";
export type McpTools = "compat" | "slim";

/** Przełączniki harnessów poza Claude Code i Codexem (zob. capture.harnesses). */
export interface HarnessSwitches {
  gemini: boolean | null;
  antigravity: boolean | null;
  cursor: boolean | null;
  opencode: boolean | null;
  claudeDesktop: boolean | null;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Worker kończy się sam po tylu minutach bez żadnego żądania (hook go podniesie); 0 = działa stale (autostart). */
  workerIdleExitMin: number;
  hooks: { mode: HooksMode };
  embed: EmbedConfig;
  context: ContextConfig;
  capture: {
    excludeProjects: string[];
    /** Fragmenty ścieżek transkryptów pomijanych w całości (sesje automatów, np. obserwator claude-mem). */
    excludeTranscriptDirs: string[];
    /** Narzędzia, których wejścia/wyjścia nigdy nie trafiają do pamięci (prywatność). */
    privateTools: string[];
    redactSecrets: boolean;
    maxNarrativeChars: number;
    /** Sesje Codexa (~/.codex/sessions) też trafiają do pamięci: hooki, nadrabianie i backfill. */
    codex: boolean;
    /**
     * Inne harnessy: zapis sesji (hooki, nadrabianie, backfill) i podłączenie przez `hipokamp install` (serwer MCP,
     * hooki, plugin). null (domyślnie): install podłącza harness, który jest na tej maszynie (jego katalog
     * konfiguracji istnieje), a zapis jego sesji rusza dopiero po tym install (do rollbacku); true: zapis zawsze;
     * false: nigdy (install go pomija). Antigravity ma tylko serwer MCP (transkrypt w zamkniętym formacie).
     */
    harnesses: HarnessSwitches;
    /**
     * Dni bez zmian, po których worker usuwa przeczytany do końca transkrypt pluginu OpenCode
     * (~/.hipokamp/transcripts/opencode, kopia rozmów poza OpenCode); 0: nigdy.
     */
    opencodeKeepDays: number;
    /**
     * Pamięć automatyczna Claude Code (pliki .md w projects/<katalog>/memory): worker dociąga zmiany przy nadrabianiu.
     * null (domyślnie): wyłączone, dopóki użytkownik nie zrobi pierwszego `hipokamp import-automemory --apply` (znacznik
     * w meta); true: zawsze; false: nigdy (także po imporcie ręcznym).
     */
    autoMemory: boolean | null;
  };
  /** Kopie bazy (VACUUM INTO) robione przez workera w bezczynności. */
  backup: { enabled: boolean; everyHours: number; keep: number };
  mcp: {
    /**
     * Zestaw narzędzi serwera MCP. compat: 19 narzędzi z nazwami i parametrami claude-mem. slim: search,
     * get_observations, remember i memory(cmd, args) dla reszty, z krótkimi opisami (dla klientów, które ładują
     * wszystkie schematy do każdego zapytania). Też HIPOKAMP_MCP_TOOLS.
     */
    tools: McpTools;
  };
  consolidation: {
    enabled: boolean;
    /**
     * Sen a decyzje i preferencje z digestu o tym samym temacie (core/supersede.ts): `"propose"` (domyślnie) tylko
     * zapisuje pary do logs/sleep-*.jsonl i pokazuje je `hipokamp supersede --dry-run`, `"apply"` zastępuje starsze,
     * `false` wyłącza. Jawny `key` w `remember` zastępuje zawsze. `true` z pierwszej wersji klucza znaczy `"apply"`.
     */
    supersedeDigest: "propose" | "apply" | boolean;
    /** Opcjonalny lokalny LLM do „snu” (domyślnie wyłączony; null w starszych configach = wyłączony). */
    llm: LlmConfig | null;
  };
  notify: NotifyConfig;
  /**
   * Synchronizacja z własnym hubem (docs/SYNC.md). Adres huba i klucze zapisuje `hipokamp sync init/join` w state/.
   * `enabled` włącza tylko synchronizację w tle przez workera; ręczne `hipokamp sync push/pull` działa zawsze.
   */
  sync: {
    enabled: boolean;
    intervalMin: number;
    /** Projekty, których notatki nie wychodzą z tej maszyny (wielkość liter bez znaczenia). */
    excludeProjects: string[];
  };
}

export const DATA_DIR = process.env.HIPOKAMP_HOME ?? join(homedir(), ".hipokamp");

/** Katalog konfiguracji Claude Code (honoruje CLAUDE_CONFIG_DIR, jak sam Claude Code). */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export const DEFAULTS: Config = {
  host: "127.0.0.1",
  port: 47777,
  dataDir: DATA_DIR,
  workerIdleExitMin: 180,
  hooks: { mode: "auto" },
  embed: {
    enabled: true,
    model: "Xenova/bge-m3",
    dims: 1024,
    pooling: "cls",
    queryPrefix: "",
    passagePrefix: "",
    device: "cpu",
    dtype: "q8",
    bulkDevice: process.platform === "win32" ? "dml" : "cpu",
    bulkDtype: process.platform === "win32" ? "fp16" : "q8",
    bulkBatch: 64,
    idleUnloadMin: 20,
  },
  context: {
    enabled: true,
    sessionStartBudget: 1600,
    fullCount: 3,
    recentSessions: 3,
    promptRecall: true,
    promptBudget: 350,
    promptMinScore: 0.62,
    fileRecall: true,
    fileBudget: 160,
  },
  capture: {
    excludeProjects: [],
    excludeTranscriptDirs: ["claude-mem-observer"],
    privateTools: ["mcp__sejf__", "mcp__plugin_sejf", "reveal_secret"],
    redactSecrets: true,
    maxNarrativeChars: 1400,
    codex: true,
    harnesses: { gemini: null, antigravity: null, cursor: null, opencode: null, claudeDesktop: null },
    opencodeKeepDays: 30,
    autoMemory: null,
  },
  backup: { enabled: true, everyHours: 24, keep: 7 },
  mcp: { tools: "compat" },
  consolidation: {
    enabled: true,
    supersedeDigest: "propose",
    llm: {
      enabled: false,
      baseUrl: "http://127.0.0.1:11434",
      model: "",
      contradictions: true,
      lessons: true,
      maxCallsPerRun: 30,
      maxRunSec: 300,
      callTimeoutSec: 90,
      minIdleMin: 15,
      everyHours: 24,
      numCtx: 4096,
      numPredict: 200,
      keepAlive: "2m",
    },
  },
  notify: {
    enabled: false,
    types: ["decision", "gotcha", "preference"],
    minImportance: 0.6,
    sources: ["digest", "agent"],
    projects: [],
    maxAgeMin: 120,
    channels: ["toast"],
    minIntervalSec: 120,
    maxPerHour: 12,
    maxItems: 5,
    file: "",
    webhook: "",
    command: [],
    commandTimeoutSec: 10,
  },
  sync: { enabled: false, intervalMin: 10, excludeProjects: [] },
};

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== "object") return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as any)[k];
    out[k] =
      b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out;
}

let cached: Config | null = null;
/** Stan pliku config.json (długość i skrót treści) z chwili ostatniego odczytu: refreshConfig porównuje go z dyskiem. */
let cachedStamp = "";
/** Stan zepsutego pliku, o którym już było ostrzeżenie w logu (jedno ostrzeżenie na stan pliku). */
let warnedStamp = "";

export function configPath(): string {
  return join(DATA_DIR, "config.json");
}

/**
 * Treść config.json i jej stan. Skrót treści, nie czas zmiany i rozmiar: zapis tej samej długości w tym samym takcie
 * zegara systemu plików też jest zmianą. Plik ma kilka KB, więc odczyt i skrót to kilkadziesiąt mikrosekund.
 */
function readConfigFile(): { text: string | null; stamp: string } {
  try {
    const text = readFileSync(configPath(), "utf8");
    return { text, stamp: `${text.length}:${Bun.hash(text).toString(36)}` };
  } catch {
    return { text: null, stamp: "brak" };
  }
}

/**
 * Konfiguracja aktualna względem dysku: procesy długowieczne (worker, serwer MCP) wołają to przed zapisem tury,
 * przypominaniem, nadrabianiem i snem, żeby zmiana `capture.privateTools` czy `capture.excludeProjects` działała od
 * następnego żądania, jak w hooku Buna (nowy proces = świeży config), a nie dopiero po restarcie.
 */
export function refreshConfig(): Config {
  const f = readConfigFile();
  if (cached && f.stamp === cachedStamp) return cached;
  return applyConfig(f);
}

export function loadConfig(fresh = false): Config {
  if (cached && !fresh) return cached;
  return applyConfig(readConfigFile());
}

function applyConfig(f: { text: string | null; stamp: string }): Config {
  let user: any = {};
  if (f.text !== null) {
    try {
      user = JSON.parse(f.text);
      if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("to nie jest obiekt JSON");
    } catch (e) {
      // zepsuty albo pusty config.json (np. zapis w toku, przecinek na końcu listy): proces, który ma już konfigurację,
      // zostaje przy niej, inaczej privateTools i excludeProjects użytkownika cicho wracałyby do domyślnych. Nowy
      // proces leci na domyślnych: zepsuty config nie może zatrzymać hooków
      if (warnedStamp !== f.stamp) {
        warnedStamp = f.stamp;
        const what = cached ? "zostaje poprzednia konfiguracja" : "konfiguracja domyślna";
        void import("./log.ts")
          .then(({ log }) => log.warn(`config.json nieczytelny (${what}): ${configPath()}`, String(e)))
          .catch(() => {});
      }
      if (cached) {
        cachedStamp = f.stamp;
        return cached;
      }
      user = {};
    }
  }
  let cfg = deepMerge(DEFAULTS, user);
  if (process.env.HIPOKAMP_PORT) cfg = { ...cfg, port: Number(process.env.HIPOKAMP_PORT) };
  // wielkość liter bez znaczenia (SLIM = slim); nieznana wartość (literówka w configu) = pełny zestaw zgodny z claude-mem
  const tools = String(process.env.HIPOKAMP_MCP_TOOLS || cfg.mcp?.tools || "")
    .trim()
    .toLowerCase();
  cfg = { ...cfg, mcp: { tools: tools === "slim" ? "slim" : "compat" } };
  cfg.dataDir = DATA_DIR;
  cached = cfg;
  cachedStamp = f.stamp;
  return cfg;
}

/** Transkrypt z katalogu automatu (np. obserwator claude-mem): nie trafia do pamięci. */
export function isExcludedTranscript(path: string, cfg: Config = loadConfig()): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return cfg.capture.excludeTranscriptDirs.some((d) => !!d && p.includes(d.toLowerCase()));
}

export function ensureDataDirs(): void {
  for (const d of ["", "logs", "spool", "models", "backups", "state"]) mkdirSync(join(DATA_DIR, d), { recursive: true });
  if (!existsSync(configPath())) {
    writeFileSync(
      configPath(),
      JSON.stringify({ $comment: "Nadpisuj tylko to, co chcesz zmienić. Pełne domyślne: hipokamp config --defaults" }, null, 2),
    );
  }
}

/** Ustawienia LLM po scaleniu; null = etap wyłączony (także `"llm": null` ze starszego configu). */
export function llmConfig(cfg: Config = loadConfig()): LlmConfig | null {
  const l = cfg.consolidation?.llm;
  return l && typeof l === "object" && l.enabled ? { ...DEFAULTS.consolidation.llm!, ...l } : null;
}

export const paths = {
  db: () => join(DATA_DIR, "hipokamp.db"),
  logs: () => join(DATA_DIR, "logs"),
  spool: () => join(DATA_DIR, "spool"),
  models: () => join(DATA_DIR, "models"),
  state: () => join(DATA_DIR, "state"),
  backups: () => join(DATA_DIR, "backups"),
  lock: () => join(DATA_DIR, "worker.lock.json"),
};
