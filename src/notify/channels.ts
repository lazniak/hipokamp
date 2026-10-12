// Kanały powiadomień, wyłącznie lokalne: toast Windows (PowerShell, NotifyIcon, bez instalowania modułów), plik
// kolejki JSONL, webhook na 127.0.0.1 (bez proxy i przekierowań) i polecenie użytkownika z treścią JSON na stdin
// (lista argumentów, bez powłoki; .cmd/.bat odrzucone, bo Windows uruchamia je przez cmd.exe).
// Każdy kanał ma twardy limit czasu. Treść nigdy nie trafia do linii poleceń ani do kodu skryptu: toast dostaje ją
// na stdin (base64 z UTF-8, bo konsola PowerShell 5.1 czyta stdin w stronie kodowej OEM). Uwaga: wywołanie
// `powershell.exe -EncodedCommand -WindowStyle Hidden -ExecutionPolicy Bypass` to wzorzec, który antywirusy i EDR
// bywają skłonne oznaczać; kto tego nie chce, używa kanału file, webhook albo command.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, type NotifyConfig } from "../config.ts";
import { loopbackFetch } from "../util/net.ts";
import { truncate } from "../util/text.ts";
// tylko typ: notify.ts importuje kanały, odwrotny import wartości dałby cykl
import type { NotifyMessage } from "./notify.ts";

export type ChannelFn = (msg: NotifyMessage, cfg: NotifyConfig) => Promise<void>;

/** Plik kolejki rośnie do tylu bajtów, potem idzie do `.1` (jedna poprzednia wersja). */
const OUTBOX_MAX = 5 * 1024 * 1024;
const TOAST_TIMEOUT_MS = 20_000;
const WEBHOOK_TIMEOUT_MS = 5_000;

export function outboxPath(cfg: NotifyConfig): string {
  return cfg.file?.trim() || join(DATA_DIR, "notify", "outbox.jsonl");
}

async function fileChannel(msg: NotifyMessage, cfg: NotifyConfig): Promise<void> {
  const f = outboxPath(cfg);
  mkdirSync(dirname(f), { recursive: true });
  try {
    if (statSync(f).size > OUTBOX_MAX) renameSync(f, f.replace(/(\.jsonl)?$/, ".1.jsonl"));
  } catch {}
  appendFileSync(f, `${JSON.stringify(msg)}\n`);
}

async function webhookChannel(msg: NotifyMessage, cfg: NotifyConfig): Promise<void> {
  if (!cfg.webhook?.trim()) throw new Error("brak notify.webhook");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    // adres spoza 127.0.0.1: wyjątek, zanim cokolwiek wyjdzie; bez proxy i bez przekierowań (3xx to błąd)
    const r = await loopbackFetch(cfg.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
      signal: ctrl.signal,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`webhook odpowiedział ${r.status}`);
  } finally {
    clearTimeout(t);
  }
}

/** Skrypt toastu: dane tylko ze stdin (JSON w base64), dymek NotifyIcon, po kilku sekundach sprzątanie ikony. */
const TOAST_PS = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw.Trim())) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Text = 'hipokamp'
$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$n.BalloonTipTitle = [string]$d.title
$n.BalloonTipText = [string]$d.text
$n.Visible = $true
$n.ShowBalloonTip(10000)
Start-Sleep -Seconds 7
$n.Dispose()
`;

/** Wywołanie toastu: argumenty PowerShella (skrypt w -EncodedCommand) i stdin z treścią. */
export function toastInvocation(msg: NotifyMessage): { cmd: string[]; stdin: string } {
  const script = Buffer.from(TOAST_PS, "utf16le").toString("base64");
  // limity dymka Windows: tytuł 63 znaki, tekst 255
  const data = { title: truncate(msg.title, 63), text: truncate(msg.text, 250) };
  return {
    cmd: [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      script,
    ],
    stdin: Buffer.from(JSON.stringify(data), "utf8").toString("base64"),
  };
}

/** Czyta cały strumień i zachowuje tylko początek (do komunikatu błędu; reszta nie zostaje w pamięci). */
async function drainHead(stream: ReadableStream<Uint8Array>, max = 4096): Promise<string> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  try {
    for await (const c of stream) {
      if (kept < max) {
        chunks.push(c.subarray(0, max - kept));
        kept += Math.min(c.length, max - kept);
      }
    }
  } catch {}
  return Buffer.concat(chunks).toString("utf8");
}

/** Uruchamia proces z treścią na stdin, czeka na koniec z limitem czasu; kod różny od 0 to błąd. */
export async function runWithStdin(cmd: string[], stdin: string, timeoutMs: number): Promise<void> {
  const p = Bun.spawn({ cmd, stdin: "pipe", stdout: "ignore", stderr: "pipe", windowsHide: true });
  // stderr czytany od razu, równolegle z czekaniem (Bun i tak buforuje potok, więc chodzi o kolejność i pamięć,
  // nie o zawieszenie procesu)
  const err = drainHead(p.stderr);
  // limit czasu liczony tutaj: Bun na Windows ustawia `killed` także po zwykłym zakończeniu procesu
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, timeoutMs);
  try {
    p.stdin.write(stdin);
    await p.stdin.end();
  } catch {}
  const code = await p.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(`przekroczony limit czasu ${Math.round(timeoutMs / 1000)} s`);
  if (code !== 0) {
    const e = (await err).replace(/\s+/g, " ").trim();
    throw new Error(`kod wyjścia ${code}${e ? `: ${truncate(e, 160)}` : ""}`);
  }
}

async function toastChannel(msg: NotifyMessage): Promise<void> {
  if (process.platform !== "win32") throw new Error("toast tylko na Windows (użyj kanału command, np. notify-send)");
  const t = toastInvocation(msg);
  await runWithStdin(t.cmd, t.stdin, TOAST_TIMEOUT_MS);
}

async function commandChannel(msg: NotifyMessage, cfg: NotifyConfig): Promise<void> {
  const argv = (cfg.command ?? []).map(String).filter((x) => x.length > 0);
  if (!argv.length) throw new Error("brak notify.command (lista: program i argumenty)");
  // plik .cmd/.bat Windows uruchamia przez cmd.exe, który interpretuje argumenty: to już powłoka, więc odmowa;
  // sprawdzamy też ścieżkę znalezioną w PATH (sama nazwa rozwija się przez PATHEXT do .cmd) i uruchamiamy dokładnie
  // tę sprawdzoną ścieżkę. PATH podany jawnie: Bun.which bez opcji widzi PATH z chwili startu procesu
  const resolved = Bun.which(argv[0].trim(), { PATH: process.env.PATH ?? "" }) ?? argv[0].trim();
  if (/\.(?:cmd|bat)$/i.test(argv[0].trim()) || /\.(?:cmd|bat)$/i.test(resolved))
    throw new Error("notify.command: .cmd/.bat uruchamia cmd.exe (powłoka); wskaż program, np. powershell.exe -File skrypt.ps1");
  await runWithStdin([resolved, ...argv.slice(1)], JSON.stringify(msg), Math.max(1, cfg.commandTimeoutSec) * 1000);
}

export const CHANNELS: Record<string, ChannelFn> = {
  toast: toastChannel,
  file: fileChannel,
  webhook: webhookChannel,
  command: commandChannel,
};
