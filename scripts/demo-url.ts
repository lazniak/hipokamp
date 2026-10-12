// Adres podglądu demo (scripts/demo.ts): jednorazowy bilet podglądu (T-34) z klucza workera demo, jak `hipokamp open`.
// Klucz zakłada worker przy starcie, więc chwilę na niego czekamy.
export async function viewerUrl(port: number): Promise<string> {
  const { loadKey } = await import("../src/worker/auth.ts");
  const { mintTicket } = await import("../src/worker/viewer-auth.ts");
  const { keyPath } = await import("../src/worker/client.ts");
  for (let i = 0; i < 50; i++) {
    const key = loadKey(keyPath());
    if (key) return `http://127.0.0.1:${port}/auth?t=${mintTicket(key, port)}`;
    await Bun.sleep(100);
  }
  return `http://127.0.0.1:${port}/`;
}
