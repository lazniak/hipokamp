// Skrypty PowerShell w scripts/: instalator uruchamia je przez Windows PowerShell 5.1, który plik UTF-8 bez BOM czyta jako
// stronę kodową ANSI (polskie ł daje bajt, który 5.1 bierze za apostrof i ucina łańcuch). Plik z nie-ASCII musi mieć BOM.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "scripts");
const scripts = readdirSync(dir).filter((f) => f.endsWith(".ps1"));
const hasBom = (b: Buffer) => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

describe("skrypty .ps1", () => {
  test("są (inaczej test niczego nie pilnuje)", () => expect(scripts.length).toBeGreaterThan(0));

  for (const name of scripts) {
    const file = join(dir, name);
    test(`${name}: nie-ASCII tylko z BOM`, () => {
      const b = readFileSync(file);
      // eslint-disable-next-line no-control-regex
      const nonAscii = /[^\x00-\x7f]/.test(b.toString("utf8"));
      if (nonAscii) expect(hasBom(b)).toBe(true);
    });

    test.skipIf(process.platform !== "win32")(`${name}: parsuje się w Windows PowerShell 5.1`, () => {
      const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e){$e|ForEach-Object{$_.Message};exit 1}`;
      const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 30000 });
      expect(r.stdout.trim()).toBe("");
      expect(r.status).toBe(0);
    });
  }
});
