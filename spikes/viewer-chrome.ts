// Weryfikacja T-34 w prawdziwym Chrome headless (DevTools Protocol): plik przekierowania z `hipokamp open` (file://)
// -> /auth?t= -> 303 -> / z ciasteczkiem SameSite=Strict, potem /api/viewer 200 i Dashboard zamiast ekranu wejścia.
// Tymczasowy HIPOKAMP_HOME (hipokamp-test), osobny profil Chrome (--user-data-dir, nigdy profil użytkownika),
// sprzątanie tylko własnych procesów. Uruchomienie: bun spikes/viewer-chrome.ts (Chrome: HIPOKAMP_CHROME albo
// domyślna ścieżka Windows).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WT = join(import.meta.dir, "..");
const { readKey } = await import(`${WT}/src/worker/auth.ts`);
const { mintTicket } = await import(`${WT}/src/worker/viewer-auth.ts`);
const { writeLauncher } = await import(`${WT}/src/worker/viewer-open.ts`);

const CHROME = process.env.HIPOKAMP_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 47985;
// wolny port debugowania: system przydziela go serwerowi na porcie 0, który od razu zamykamy
const CDP = (() => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return port;
})();
const home = mkdtempSync(join(tmpdir(), "hipokamp-test-cdp-"));
const profile = mkdtempSync(join(tmpdir(), "hipokamp-cdp-profile-"));
mkdirSync(join(home, "claude", "projects"), { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({ embed: { enabled: false }, backup: { enabled: false } }));

const worker = Bun.spawn([process.execPath, join(WT, "src", "worker", "main.ts")], {
  env: {
    ...process.env,
    HIPOKAMP_HOME: home,
    HIPOKAMP_PORT: String(PORT),
    HIPOKAMP_NO_WORKER: "1",
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    CLAUDE_MEM_DB: join(home, "none.db"),
  },
  cwd: WT,
  stdout: "ignore",
  stderr: "ignore",
});
let chrome: ReturnType<typeof Bun.spawn> | null = null;
const log = (...a: unknown[]) => console.log(...a);

try {
  let key: Buffer | null = null;
  for (let i = 0; i < 100 && !key; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) key = readKey(join(home, "state", "worker.key"));
    } catch {}
    if (!key) await Bun.sleep(100);
  }
  if (!key) throw new Error("worker nie wstał");
  const file = await writeLauncher(join(home, "state"), `http://127.0.0.1:${PORT}/auth?t=${mintTicket(key, PORT)}`);
  if (!file) throw new Error("writeLauncher: null");
  log("plik:", file);

  chrome = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as any[];
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {}
    if (!wsUrl) await Bun.sleep(100);
  }
  if (!wsUrl) throw new Error("Chrome DevTools nie odpowiada");
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  const events: any[] = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)!(d);
      pending.delete(d.id);
    } else events.push(d);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((r) => {
      const id = ++seq;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression: string) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send("Page.enable");
  await send("Network.enable");
  const fileUrl = pathToFileURL(file).href;
  log("Page.navigate:", fileUrl.replace(/viewer-open-[0-9a-f]+/, "viewer-open-…"));
  await send("Page.navigate", { url: fileUrl });
  let href = "";
  for (let i = 0; i < 100; i++) {
    href = (await evalJs("location.href")) ?? "";
    if (href.startsWith(`http://127.0.0.1:${PORT}/`) && (await evalJs("document.readyState")) === "complete") break;
    await Bun.sleep(100);
  }
  await Bun.sleep(1500); // init podglądu: sprawdzenie sesji i pierwszy widok
  const redirects = events
    .filter((e) => e.method === "Network.responseReceived" || e.method === "Network.requestWillBeSent")
    .map((e) =>
      e.method === "Network.requestWillBeSent"
        ? `-> ${e.params.request.url.replace(/t=[^&]+/, "t=…")}${e.params.redirectResponse ? ` (po ${e.params.redirectResponse.status})` : ""}`
        : `<- ${e.params.response.status} ${e.params.response.url.replace(/t=[^&]+/, "t=…")}`,
    );
  log("ruch:", redirects.join("\n      "));
  log("location.href:", await evalJs("location.href"));
  log("fetch('/api/viewer'):", await evalJs("fetch('/api/viewer').then(r => r.status)"));
  log("ekran wejścia:", await evalJs("document.body.dataset.gate ?? 'brak'"), "| .app-gate:", await evalJs("!!document.querySelector('.app-gate')"));
  log("tytuł widoku:", await evalJs("document.querySelector('.view-title')?.textContent ?? null"));
  log("document.cookie (HttpOnly = puste):", JSON.stringify(await evalJs("document.cookie")));
  const cookies = (await send("Network.getCookies", { urls: [`http://127.0.0.1:${PORT}/`] })).result?.cookies ?? [];
  for (const c of cookies)
    log("ciasteczko:", c.name, `sameSite=${c.sameSite}`, `httpOnly=${c.httpOnly}`, `path=${c.path}`, `wygasa za ${Math.round((c.expires * 1000 - Date.now()) / 86_400_000)} dni`);
  // drugi raz ten sam plik: bilet zużyty, worker odsyła na /?auth=invalid (ciasteczko i tak jest, więc widok działa)
  await send("Page.navigate", { url: fileUrl });
  await Bun.sleep(2000);
  const second = events.filter((e) => e.method === "Network.requestWillBeSent" && e.params.redirectResponse).pop();
  log("drugie otwarcie pliku, przekierowanie na:", second?.params.request.url, "| href:", await evalJs("location.href"));
  ws.close();
} finally {
  if (chrome?.pid)
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.kill();
  worker.kill();
  await worker.exited;
  await Bun.sleep(500);
  for (const d of [home, profile])
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
      log("nie usunięto", d, String(e));
    }
}
