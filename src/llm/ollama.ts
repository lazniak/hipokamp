// Klient lokalnej Ollamy (`/api/chat`, `/api/tags`) dla opcjonalnej konsolidacji LLM. Adres tylko w pętli zwrotnej
// (zdalny = wyjątek przed jakimkolwiek połączeniem), bez proxy i bez przekierowań, twardy limit czasu na wywołanie,
// przerwanie z zewnątrz (AbortSignal: worker przerywa przebieg, gdy ktoś zaczyna pracę). Model zwalnia się po
// `keepAlive`. Modele chmurowe Ollamy (`…-cloud`, `…:cloud`) są odrzucane: lokalna Ollama przekazuje je na ollama.com.
import type { LlmConfig } from "../config.ts";
import { loopbackFetch, loopbackUrl, RemoteAddressError } from "../util/net.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  outputTokens: number;
  ms: number;
}

export type ChatFn = (messages: ChatMessage[], opts?: { signal?: AbortSignal; json?: boolean }) => Promise<ChatResult>;

/** Błąd połączenia z Ollamą (nie działa, zły adres, limit czasu): przebieg się kończy, nie ponawiamy w pętli. */
export class LlmTransportError extends Error {}

/** Model chmurowy Ollamy (np. `gpt-oss:120b-cloud`, `glm-4.6:cloud`): treść poszłaby na ollama.com. */
export function isCloudModel(model: string): boolean {
  return /(?:^|[:-])cloud$/i.test(model.trim());
}

/** Funkcja rozmowy z Ollamą według konfiguracji. Adres i model sprawdzane od razu, przy tworzeniu. */
export function ollamaChat(cfg: LlmConfig): ChatFn {
  const url = new URL("/api/chat", loopbackUrl(cfg.baseUrl));
  if (isCloudModel(cfg.model))
    throw new RemoteAddressError(
      `model chmurowy Ollamy (${cfg.model}) wysyła treść notatek na ollama.com: odmowa, wskaż model lokalny`,
    );
  return async (messages, opts = {}) => {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (opts.signal?.aborted) throw new LlmTransportError("przerwane");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, cfg.callTimeoutSec) * 1000);
    const t0 = performance.now();
    try {
      let r: Response;
      try {
        r = await loopbackFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: cfg.model,
            messages,
            stream: false,
            ...(opts.json ? { format: "json" } : {}),
            keep_alive: cfg.keepAlive,
            options: { temperature: 0, num_ctx: cfg.numCtx, num_predict: cfg.numPredict },
          }),
        });
      } catch (e: any) {
        throw new LlmTransportError(
          opts.signal?.aborted
            ? "przerwane"
            : ctrl.signal.aborted
              ? `limit czasu ${cfg.callTimeoutSec} s`
              : `Ollama nie odpowiada: ${e?.message ?? e}`,
        );
      }
      if (r.status !== 200) throw new LlmTransportError(`Ollama ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const j: any = await r.json().catch(() => null);
      return {
        content: String(j?.message?.content ?? ""),
        promptTokens: Number(j?.prompt_eval_count ?? 0),
        outputTokens: Number(j?.eval_count ?? 0),
        ms: Math.round(performance.now() - t0),
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Modele dostępne w Ollamie (`/api/tags`); null = Ollama nie odpowiada. */
export async function ollamaModels(cfg: LlmConfig, timeoutMs = 3000): Promise<string[] | null> {
  const url = new URL("/api/tags", loopbackUrl(cfg.baseUrl));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await loopbackFetch(url, { signal: ctrl.signal });
    if (r.status !== 200) return null;
    const j: any = await r.json();
    return Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? m?.model ?? "")).filter(Boolean) : [];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Pierwszy obiekt JSON z odpowiedzi modelu (bywa otoczony tekstem albo blokiem ```json). */
export function parseJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  for (let end = s.lastIndexOf("}"); end > start; end = s.lastIndexOf("}", end - 1)) {
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  return null;
}
