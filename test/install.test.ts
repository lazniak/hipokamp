// Instalacja i aktualizacja pluginu (T-31): przepięcie marketplace na bieżące repo, ponowna instalacja nieaktualnej
// kopii pluginu w cache, powrót do starego katalogu po błędzie, próba bez zmian, diagnoza katalogu pluginu
// (`hipokamp doctor`) i `hipokamp update` (odmowa na innej gałęzi, przy brudnym drzewie i rozjeździe, szybkie
// przewinięcie, powrót po nieudanym bun install). Udawany `claude` (test/fixtures/install/fake-claude.ts) jest
// pierwszy w PATH i zapisuje wywołania; git ma pusty config globalny. Osobny proces z katalogiem „hipokamp-test”
// jak w integrity.test.ts: config.ts zapamiętuje HIPOKAMP_HOME przy imporcie.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const CHILD = "HIPOKAMP_INSTALL_CHILD";
const ROOT = join(import.meta.dir, "..");

if (!process.env[CHILD]) {
  test("instalacja i update (osobny proces, katalog testowy, udawany claude)", () => {
    const home = mkdtempSync(join(tmpdir(), "hipokamp-test-"));
    const claude = join(home, "claude");
    const bin = join(home, "bin");
    mkdirSync(claude, { recursive: true });
    mkdirSync(bin);
    const fake = join(ROOT, "test", "fixtures", "install", "fake-claude.ts");
    if (process.platform === "win32") writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
    else {
      writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
      chmodSync(join(bin, "claude"), 0o755);
    }
    const gitconfig = join(home, "gitconfig");
    writeFileSync(gitconfig, "");
    // tryb hooków stały (domyślne auto zależałoby od tego, czy deweloper zbudował natywny hook); testy trybów go zmieniają
    writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: { mode: "command" } }));
    // Windows trzyma PATH pod kluczem „Path”: dwa klucze w env dziecka to loteria, który wygra
    const env = { ...(process.env as Record<string, string>) };
    const basePath = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
    for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
    try {
      const r = Bun.spawnSync([process.execPath, "test", "./test/install.test.ts"], {
        cwd: ROOT,
        env: {
          ...env,
          PATH: `${bin}${delimiter}${basePath}`,
          HIPOKAMP_HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: join(home, "codex"),
          CLAUDE_MEM_DB: join(home, "brak-claude-mem.db"),
          HIPOKAMP_NO_WORKER: "1",
          HIPOKAMP_PORT: "47991",
          FAKE_CLAUDE_BIN: bin,
          FAKE_CLAUDE_LOG: join(home, "claude-calls.jsonl"),
          GIT_CONFIG_GLOBAL: gitconfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "hipokamp-test",
          GIT_AUTHOR_EMAIL: "test@hipokamp.invalid",
          GIT_COMMITTER_NAME: "hipokamp-test",
          GIT_COMMITTER_EMAIL: "test@hipokamp.invalid",
          [CHILD]: "1",
        },
      });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l.trim()) || /^\(fail\)/.test(l.trim()))
          .map((l) => `install: ${l.trim()}`)
          .join("\n"),
      );
      if (r.exitCode !== 0) throw new Error(`testy instalacji nie przeszły:\n${out}`);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
} else {
  const { DATA_DIR, claudeDir, paths } = await import("../src/config.ts");
  if (!DATA_DIR.includes("hipokamp-test") || !claudeDir().includes("hipokamp-test"))
    throw new Error("instalacja: HIPOKAMP_HOME i CLAUDE_CONFIG_DIR muszą wskazywać katalog testowy");
  const L = await import("../src/install/live.ts");
  // żadne wywołanie nie może trafić do prawdziwego claude: udawany musi być pierwszy w PATH
  const which = Bun.which("claude");
  if (!which || !L.samePath(dirname(which), process.env.FAKE_CLAUDE_BIN ?? ""))
    throw new Error(`instalacja: udawany claude nie jest pierwszy w PATH (${which})`);
  const I = await import("../src/install/install.ts");
  const U = await import("../src/install/update.ts");

  const T = 60_000;
  const CALLS = process.env.FAKE_CLAUDE_LOG ?? "";
  const calls = (): string[] =>
    existsSync(CALLS)
      ? readFileSync(CALLS, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as string[]).join(" "))
      : [];
  const KM = join(claudeDir(), "plugins", "known_marketplaces.json");
  const enabled = () => JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8")).enabledPlugins?.[L.PLUGIN_ID];
  const state = () => JSON.parse(readFileSync(join(paths.state(), "install.json"), "utf8"));
  const same = (a: string | null | undefined, b: string) => !!a && L.samePath(a, b);
  const MANIFEST = readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8");
  const PLUGIN_JSON = readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8");
  const SKILL = (d: string) => join(d, "plugin", "skills", "demo", "SKILL.md");
  const PJ = (d: string) => join(d, "plugin", ".claude-plugin", "plugin.json");
  const IP = join(claudeDir(), "plugins", "installed_plugins.json");

  /** Katalog udający repo hipokampa: manifesty marketplace i pluginu, skill, ignorowane pliki generowane przez install. */
  const scaffold = (d: string) => {
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    mkdirSync(join(d, "plugin", ".claude-plugin"), { recursive: true });
    mkdirSync(join(d, "plugin", "skills", "demo"), { recursive: true });
    writeFileSync(join(d, ".claude-plugin", "marketplace.json"), MANIFEST);
    writeFileSync(PJ(d), PLUGIN_JSON);
    writeFileSync(SKILL(d), "---\nname: demo\ndescription: test\n---\n");
    writeFileSync(join(d, ".gitignore"), "plugin/hooks/hooks.json\nplugin/.mcp.json\n");
    return d;
  };
  /** Zawartość drzewa katalogu (ścieżka względna → treść): porównanie kopii pluginu przed i po próbie. */
  const tree = (dir: string) =>
    Object.fromEntries(
      (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => statSync(join(dir, f)).isFile())
        .sort()
        .map((f) => [f.replace(/\\/g, "/"), readFileSync(join(dir, f), "utf8")]),
    );
  const inst = async (repo: string, dryRun = false) => {
    const log: string[] = [];
    const ok = await I.install({
      repo,
      dryRun,
      replace: false,
      codex: false,
      harnesses: false,
      autostart: false,
      log: (m) => log.push(m),
    });
    return { ok, log: log.join("\n") };
  };
  const validates = (repo: string) => [`plugin validate ${repo}`, `plugin validate ${join(repo, "plugin")}`];

  describe("install: marketplace i kopia pluginu w cache", () => {
    const old = scaffold(join(DATA_DIR, "stary"));
    const neu = scaffold(join(DATA_DIR, "live"));

    test(
      "pierwsza instalacja rejestruje marketplace z katalogu repo",
      async () => {
        const n = calls().length;
        const r = await inst(old);
        expect(r.ok).toBe(true);
        expect(calls().slice(n)).toEqual([
          ...validates(old),
          `plugin marketplace add ${old}`,
          "plugin install hipokamp@hipokamp",
          "plugin enable hipokamp@hipokamp",
        ]);
        expect(same(L.marketplaceDir(), old)).toBe(true);
        expect(same(L.pluginLocation().hooksRepo, old)).toBe(true);
        expect(L.pluginCacheCurrent(old)).toBe(true);
      },
      T,
    );

    test(
      "próba: plan przepięcia bez żadnej zmiany",
      async () => {
        const n = calls().length;
        const before = readFileSync(KM, "utf8");
        const r = await inst(neu, true);
        expect(r.ok).toBe(true);
        expect(r.log).toContain(`przepinam na ${neu}`);
        expect(r.log).toContain("$ claude plugin marketplace remove hipokamp");
        expect(r.log).toContain(`$ claude plugin marketplace add ${neu}`);
        // próba tylko waliduje (odczyt); żadnej zmiany w rejestracji
        expect(calls().slice(n)).toEqual(validates(neu));
        expect(readFileSync(KM, "utf8")).toBe(before);
        expect(existsSync(join(neu, "plugin", "hooks", "hooks.json"))).toBe(false);
      },
      T,
    );

    test(
      "marketplace z innego katalogu: przepięcie, nowa kopia pluginu, stan i kopia ustawień",
      async () => {
        const n = calls().length;
        const r = await inst(neu);
        expect(r.ok).toBe(true);
        expect(calls().slice(n)).toEqual([
          ...validates(neu),
          "plugin marketplace remove hipokamp",
          `plugin marketplace add ${neu}`,
          "plugin install hipokamp@hipokamp",
          "plugin enable hipokamp@hipokamp",
        ]);
        expect(same(L.marketplaceDir(), neu)).toBe(true);
        expect(same(L.pluginLocation().hooksRepo, neu)).toBe(true);
        expect(enabled()).toBe(true);
        const s = state();
        expect(same(s.marketplace.path, neu)).toBe(true);
        expect(same(s.marketplace.previous, old)).toBe(true);
        expect(typeof s.marketplace.relocatedAt).toBe("string");
        // kopia ustawień sprzed przepięcia wskazuje stary katalog
        const bk = JSON.parse(readFileSync(join(s.backup, "plugins__known_marketplaces.json"), "utf8"));
        expect(same(bk.hipokamp.source.path, old)).toBe(true);
      },
      T,
    );

    test(
      "ten sam katalog: update marketplace bez przepinania, historia przepięcia zostaje",
      async () => {
        const n = calls().length;
        const r = await inst(neu);
        expect(r.ok).toBe(true);
        expect(calls().slice(n)).toEqual([
          ...validates(neu),
          "plugin marketplace update hipokamp",
          "plugin install hipokamp@hipokamp",
          "plugin enable hipokamp@hipokamp",
        ]);
        expect(same(state().marketplace.previous, old)).toBe(true);
      },
      T,
    );

    test(
      "zmieniony skill przy tej samej wersji: instalacja od nowa, nowa treść w kopii",
      async () => {
        writeFileSync(SKILL(neu), "---\nname: demo\ndescription: test\n---\nnowa treść skilla\n");
        expect(L.pluginCacheDiff(neu)).toEqual(["inny: skills/demo/SKILL.md"]);
        const n = calls().length;
        const r = await inst(neu);
        expect(r.ok).toBe(true);
        expect(calls().slice(n)).toContain("plugin uninstall hipokamp@hipokamp --keep-data");
        expect(readFileSync(join(L.pluginInstallPath() ?? "", "skills", "demo", "SKILL.md"), "utf8")).toContain(
          "nowa treść skilla",
        );
        expect(L.pluginCacheCurrent(neu)).toBe(true);
      },
      T,
    );

    test("dane Claude Code w kopii (.in_use, .orphaned_at) nie są różnicą; doctor pokazuje różnice kopii", () => {
      const ip = L.pluginInstallPath() ?? "";
      mkdirSync(join(ip, ".in_use"), { recursive: true });
      writeFileSync(join(ip, ".in_use", "12345"), "");
      writeFileSync(join(ip, ".orphaned_at"), "1791221748469");
      expect(L.pluginCacheCurrent(neu)).toBe(true);
      expect(L.liveCheck({ codeRepo: neu }).some((l) => l.startsWith("✓") && l.includes("kopia pluginu w cache zgodna"))).toBe(
        true,
      );
      rmSync(join(ip, ".orphaned_at"));
      // zbędny plik pluginu w kopii już tak
      writeFileSync(join(ip, "skills", "demo", "stary.md"), "x");
      expect(L.pluginCacheDiff(neu)).toEqual(["zbędny: skills/demo/stary.md"]);
      const warn = L.liveCheck({ codeRepo: neu }).find((l) => l.startsWith("! kopia pluginu w cache"));
      expect(warn).toContain("zbędny: skills/demo/stary.md");
      expect(warn).toContain("hipokamp install");
      rmSync(join(ip, "skills", "demo", "stary.md"));
    });

    test(
      "zepsuty plugin.json: walidacja zatrzymuje próbę, rejestracja i kopia bez zmian",
      async () => {
        const before = { ip: readFileSync(IP, "utf8"), km: readFileSync(KM, "utf8"), cache: tree(L.pluginInstallPath() ?? "") };
        writeFileSync(PJ(neu), '{ "name": "hipokamp", "version": ');
        writeFileSync(SKILL(neu), "---\nname: demo\ndescription: test\n---\nzmiana, która wymagałaby reinstalacji\n");
        const n = calls().length;
        let r: { ok: boolean; log: string };
        try {
          r = await inst(neu);
        } finally {
          writeFileSync(PJ(neu), PLUGIN_JSON);
        }
        expect(r.ok).toBe(false);
        expect(r.log).toContain("nie przechodzi; niczego nie zmieniam");
        expect(calls().slice(n)).toEqual([`plugin validate ${neu}`]);
        expect(readFileSync(IP, "utf8")).toBe(before.ip);
        expect(readFileSync(KM, "utf8")).toBe(before.km);
        expect(tree(L.pluginInstallPath() ?? "")).toEqual(before.cache);
        expect(enabled()).toBe(true);
      },
      T,
    );

    test(
      "instalacja od nowa pada po uninstall: kopia w cache, wpis i włączenie jak przed próbą",
      async () => {
        // kopia jest nieaktualna (skill z poprzedniego testu), więc install odinstaluje plugin i zainstaluje od nowa
        expect(L.pluginCacheCurrent(neu)).toBe(false);
        const before = {
          entry: JSON.parse(readFileSync(IP, "utf8")).plugins[L.PLUGIN_ID],
          cache: tree(L.pluginInstallPath() ?? ""),
        };
        const flag = join(claudeDir(), "fail-install.txt");
        writeFileSync(flag, "");
        const n = calls().length;
        let r: { ok: boolean; log: string };
        try {
          r = await inst(neu);
        } finally {
          rmSync(flag, { force: true });
        }
        expect(r.ok).toBe(false);
        expect(calls().slice(n)).toContain("plugin uninstall hipokamp@hipokamp --keep-data");
        expect(r.log).toContain("przywrócono kopię pluginu w");
        expect(r.log).toContain("plugin działa jak przed próbą");
        expect(JSON.parse(readFileSync(IP, "utf8")).plugins[L.PLUGIN_ID]).toEqual(before.entry);
        expect(tree(L.pluginInstallPath() ?? "")).toEqual(before.cache);
        expect(enabled()).toBe(true);
        // po usunięciu przyczyny kolejna instalacja się udaje
        expect((await inst(neu)).ok).toBe(true);
        expect(L.pluginCacheCurrent(neu)).toBe(true);
      },
      T,
    );

    /** Stan pluginu do porównania przed i po nieudanej próbie: wpis w installed_plugins.json i drzewo kopii. */
    const snapshot = () => ({
      entry: JSON.parse(readFileSync(IP, "utf8")).plugins[L.PLUGIN_ID],
      cache: tree(L.pluginInstallPath() ?? ""),
    });
    const withFlag = async (name: string, text: string, fn: () => Promise<{ ok: boolean; log: string }>) => {
      const flag = join(claudeDir(), name);
      writeFileSync(flag, text);
      try {
        return await fn();
      } finally {
        rmSync(flag, { force: true });
      }
    };

    test(
      "nieudany uninstall: bez install, błąd z komendą naprawczą, stan jak przed próbą, doctor pokazuje różnicę",
      async () => {
        writeFileSync(SKILL(neu), "---\nname: demo\ndescription: test\n---\nskill, którego uninstall nie wpuści\n");
        const before = snapshot();
        const n = calls().length;
        const r = await withFlag("fail-uninstall.txt", "", () => inst(neu));
        expect(r.ok).toBe(false);
        const after = calls().slice(n);
        expect(after).toContain("plugin uninstall hipokamp@hipokamp --keep-data");
        // „already installed” po nieudanym uninstall nic by nie podmienił: po nim nie ma już install
        expect(after.slice(after.indexOf("plugin uninstall hipokamp@hipokamp --keep-data"))).not.toContain(
          "plugin install hipokamp@hipokamp",
        );
        expect(r.log).toContain("uninstall hipokamp@hipokamp nie przeszedł");
        expect(r.log).toContain("plugin działa jak przed próbą");
        expect(r.log).toContain("Naprawa:");
        expect(snapshot()).toEqual(before);
        expect(enabled()).toBe(true);
        const warn = L.liveCheck({ codeRepo: neu }).find((l) => l.startsWith("! kopia pluginu w cache"));
        expect(warn).toContain("inny: skills/demo/SKILL.md");
      },
      T,
    );

    test(
      "kopia po ponownej instalacji dalej inna niż plugin/: ok false, poprzednia kopia przywrócona",
      async () => {
        const before = snapshot();
        const r = await withFlag("install-skip.txt", "skills/demo/SKILL.md", () => inst(neu));
        expect(r.ok).toBe(false);
        expect(r.log).toContain("dalej różni się");
        expect(r.log).toContain("brak: skills/demo/SKILL.md");
        expect(r.log).toContain("przywrócono kopię pluginu w");
        expect(r.log).toContain("plugin działa jak przed próbą");
        expect(r.log).toContain("Naprawa:");
        expect(snapshot()).toEqual(before);
        expect(enabled()).toBe(true);
        // obok kopii nie zostają katalogi robocze przywracania
        expect(readdirSync(dirname(L.pluginInstallPath() ?? "")).filter((d) => d.includes("hipokamp-"))).toEqual([]);
        expect((await inst(neu)).ok).toBe(true);
        expect(L.pluginCacheCurrent(neu)).toBe(true);
      },
      T,
    );

    /** Plik nieczytelny dla innych procesów: na Windows otwarty bez współdzielenia (PowerShell), na POSIX chmod 000. */
    const lockFile = async (f: string): Promise<() => Promise<void>> => {
      if (process.platform !== "win32") {
        chmodSync(f, 0);
        return async () => chmodSync(f, 0o644);
      }
      const p = Bun.spawn(
        [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$f=[System.IO.File]::Open('${f.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('zablokowany'); [Console]::Out.Flush(); Start-Sleep 120; $f.Close()`,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const reader = p.stdout.getReader();
      let text = "";
      while (!text.includes("zablokowany")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("PowerShell nie zablokował pliku");
        text += new TextDecoder().decode(value);
      }
      return async () => {
        p.kill();
        await p.exited;
      };
    };
    // root na Linuksie czyta pliki z chmod 000
    const canLock = process.platform === "win32" || process.getuid?.() !== 0;

    test.skipIf(!canLock)(
      "zablokowany plik w plugin/: bez wyjątku, „nieczytelny” w różnicach, stan jak przed próbą",
      async () => {
        expect(L.pluginCacheCurrent(neu)).toBe(true);
        const before = snapshot();
        const unlock = await lockFile(SKILL(neu));
        let r: { ok: boolean; log: string };
        let diff: string[] | null;
        try {
          diff = L.pluginCacheDiff(neu);
          r = await inst(neu);
        } finally {
          await unlock();
        }
        expect(diff).toEqual(["nieczytelny: skills/demo/SKILL.md"]);
        expect(r.ok).toBe(false);
        expect(r.log).toContain("nieczytelny: skills/demo/SKILL.md");
        expect(r.log).toContain("przywrócono kopię pluginu w");
        expect(r.log).toContain("plugin działa jak przed próbą");
        expect(snapshot()).toEqual(before);
        expect(enabled()).toBe(true);
        expect((await inst(neu)).ok).toBe(true);
        expect(L.pluginCacheCurrent(neu)).toBe(true);
      },
      T,
    );

    test(
      "kopia w cache ze starymi hookami: instalacja od nowa z zachowaniem danych pluginu",
      async () => {
        const ip = L.pluginInstallPath() ?? "";
        const stale = { hooks: { Stop: [{ hooks: [{ type: "command", command: `"bun" "${old}/src/hooks/hook.ts" stop` }] }] } };
        writeFileSync(join(ip, "hooks", "hooks.json"), JSON.stringify(stale));
        expect(L.pluginCacheCurrent(neu)).toBe(false);
        expect(same(L.pluginLocation().hooksRepo, old)).toBe(true);
        const n = calls().length;
        const r = await inst(neu);
        expect(r.ok).toBe(true);
        expect(calls().slice(n)).toContain("plugin uninstall hipokamp@hipokamp --keep-data");
        expect(L.pluginCacheCurrent(neu)).toBe(true);
        expect(same(L.pluginLocation().hooksRepo, neu)).toBe(true);
        expect(enabled()).toBe(true);
      },
      T,
    );

    test(
      "nieudane dodanie nowego katalogu: powrót do poprzedniego, plugin dalej włączony",
      async () => {
        const other = scaffold(join(DATA_DIR, "inny"));
        const flag = join(claudeDir(), "fail-add.txt");
        writeFileSync(flag, "inny");
        let r: { ok: boolean; log: string };
        try {
          r = await inst(other);
        } finally {
          rmSync(flag, { force: true });
        }
        expect(r.ok).toBe(false);
        expect(r.log).toContain(`wracam do ${neu}`);
        expect(r.log).toContain(`plugin działa dalej z ${neu}`);
        expect(same(L.marketplaceDir(), neu)).toBe(true);
        expect(same(L.pluginLocation().hooksRepo, neu)).toBe(true);
        expect(enabled()).toBe(true);
        // nieudane przepięcie nie trafia do stanu instalacji
        expect(same(state().marketplace.path, neu)).toBe(true);
      },
      T,
    );

    test(
      "przepięcie bez powrotu: poprzedni katalog zapisany w stanie, kolejna instalacja naprawia",
      async () => {
        const other = scaffold(join(DATA_DIR, "inny2"));
        // psuje dodanie i nowego, i starego katalogu (oba leżą w katalogu testowym)
        const r = await withFlag("fail-add.txt", basename(DATA_DIR), () => inst(other));
        expect(r.ok).toBe(false);
        expect(r.log).toContain(`powrót do ${neu} też nie wyszedł`);
        const s = state();
        expect(same(s.marketplace.previous, neu)).toBe(true);
        expect(s.marketplace.failed).toBe(true);
        const fix = await inst(neu);
        expect(fix.ok).toBe(true);
        expect(same(L.marketplaceDir(), neu)).toBe(true);
        expect(L.pluginCacheCurrent(neu)).toBe(true);
        expect(enabled()).toBe(true);
        expect(state().marketplace.failed).toBeUndefined();
        // marketplace w settings.json też wskazuje bieżący katalog (prawdziwy CLI zapisuje extraKnownMarketplaces)
        const extra = JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8")).extraKnownMarketplaces;
        expect(same(extra.hipokamp.source.path, neu)).toBe(true);
      },
      T,
    );

    test("diagnoza: plugin z katalogu bez gita", () => {
      const lines = L.liveCheck({ codeRepo: neu });
      expect(lines.some((l) => l.startsWith("!") && l.includes("nie jest checkoutem git"))).toBe(true);
    });
  });

  describe("update i diagnoza checkoutu", () => {
    const G = (dir: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, ...args]);
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    const origin = join(DATA_DIR, "origin.git");
    const seed = join(DATA_DIR, "seed");
    const push = (msg: string, files: Record<string, string>) => {
      for (const [f, text] of Object.entries(files)) writeFileSync(join(seed, f), text);
      G(seed, "add", "-A");
      G(seed, "commit", "-q", "-m", msg);
      G(seed, "push", "-q", "origin", "HEAD:main");
      return G(seed, "rev-parse", "HEAD");
    };
    /** Klon na gałęzi live śledzącej origin/main, jak worktree live (docs/MIGRACJA.md, „Worktree live”). */
    const clone = (name: string) => {
      const d = join(DATA_DIR, name);
      G(DATA_DIR, "clone", "-q", origin, d);
      G(d, "checkout", "-q", "-b", "live", "origin/main");
      return d;
    };
    const upd = async (repo: string, dryRun = false, finishOk = true) => {
      const log: string[] = [];
      const fin: string[] = [];
      const ok = await U.update({
        repo,
        dryRun,
        log: (m) => log.push(m),
        finish: (from) => {
          fin.push(from);
          return finishOk;
        },
      });
      return { ok, log: log.join("\n"), fin };
    };
    let v1 = "";
    let v2 = "";
    const c: Record<string, string> = {};

    test(
      "przygotowanie: origin z main i klony na gałęzi live",
      () => {
        G(DATA_DIR, "init", "-q", "--bare", "-b", "main", origin);
        G(DATA_DIR, "clone", "-q", origin, seed);
        scaffold(seed);
        v1 = push("v1", { "README.md": "v1\n", "package.json": '{ "name": "demo", "private": true }\n' });
        for (const n of ["branch", "dirty", "detached", "fresh", "dry", "ff", "fin", "div", "deps"]) c[n] = clone(`u-${n}`);
        expect(G(c.ff, "rev-parse", "HEAD")).toBe(v1);
      },
      T,
    );

    test(
      "aktualny checkout: nic do zrobienia, bez drugiego etapu",
      async () => {
        const r = await upd(c.fresh);
        expect(r.ok).toBe(true);
        expect(r.log).toContain("już aktualne");
        expect(r.fin).toEqual([]);
      },
      T,
    );

    test(
      "inna gałąź niż live/main: odmowa",
      async () => {
        G(c.branch, "checkout", "-q", "-b", "feature");
        const r = await upd(c.branch);
        expect(r.ok).toBe(false);
        expect(r.log).toContain("odmawiam");
        expect(r.log).toContain("gałęzi feature");
        expect(r.fin).toEqual([]);
      },
      T,
    );

    test(
      "odłączony HEAD: odmowa",
      async () => {
        G(c.detached, "checkout", "-q", "--detach");
        const r = await upd(c.detached);
        expect(r.ok).toBe(false);
        expect(r.log).toContain("odłączonym HEAD");
      },
      T,
    );

    test(
      "niezacommitowane zmiany: odmowa, drzewo i HEAD nietknięte",
      async () => {
        v2 = push("v2: nowa wersja", { "README.md": "v2\n" });
        writeFileSync(join(c.dirty, "README.md"), "lokalna zmiana\n");
        const r = await upd(c.dirty);
        expect(r.ok).toBe(false);
        expect(r.log).toContain("niezacommitowane zmiany");
        expect(r.log).toContain("README.md");
        expect(G(c.dirty, "rev-parse", "HEAD")).toBe(v1);
        expect(readFileSync(join(c.dirty, "README.md"), "utf8")).toBe("lokalna zmiana\n");
      },
      T,
    );

    test(
      "próba: fetch i lista nowych commitów, drzewo bez zmian",
      async () => {
        const r = await upd(c.dry, true);
        expect(r.ok).toBe(true);
        expect(r.log).toContain("v2: nowa wersja");
        expect(r.log).toContain("(dry-run)");
        expect(G(c.dry, "rev-parse", "HEAD")).toBe(v1);
        expect(r.fin).toEqual([]);
      },
      T,
    );

    test(
      "czysty live za origin/main: szybkie przewinięcie i drugi etap z commitem sprzed scalenia",
      async () => {
        const r = await upd(c.ff);
        expect(r.ok).toBe(true);
        expect(G(c.ff, "rev-parse", "HEAD")).toBe(v2);
        expect(r.fin).toEqual([v1]);
        expect(r.log).toContain("zależności bez zmian");
      },
      T,
    );

    test(
      "drugi etap padł: SHA i komenda powrotu, kolejny update go powtarza, potem już aktualne",
      async () => {
        const r1 = await upd(c.fin, false, false);
        expect(r1.ok).toBe(false);
        expect(G(c.fin, "rev-parse", "HEAD")).toBe(v2);
        expect(r1.log).toContain(`reset --keep ${v1}`);
        expect(r1.log).toContain(`hipokamp update --finish ${v1}`);
        const r2 = await upd(c.fin);
        expect(r2.ok).toBe(true);
        expect(r2.log).toContain("nie dokończył drugiego etapu");
        expect(r2.fin).toEqual([v1]);
        const r3 = await upd(c.fin);
        expect(r3.ok).toBe(true);
        expect(r3.log).toContain("już aktualne");
        expect(r3.fin).toEqual([]);
      },
      T,
    );

    test(
      "lokalny commit spoza origin/main: odmowa zamiast scalania",
      async () => {
        writeFileSync(join(c.div, "lokalny.txt"), "x\n");
        G(c.div, "add", "-A");
        G(c.div, "commit", "-q", "-m", "lokalny");
        const head = G(c.div, "rev-parse", "HEAD");
        const r = await upd(c.div);
        expect(r.ok).toBe(false);
        expect(r.log).toContain("nie jest szybkie przewinięcie");
        expect(G(c.div, "rev-parse", "HEAD")).toBe(head);
      },
      T,
    );

    test(
      "nieudany bun install po zmianie zależności: powrót do commitu sprzed scalenia",
      async () => {
        push("v3: zepsute zależności", { "package.json": "{ to nie jest json\n" });
        const r = await upd(c.deps);
        expect(r.ok).toBe(false);
        expect(r.log).toContain("install --frozen-lockfile");
        expect(r.log).toContain("drzewo wróciło");
        expect(G(c.deps, "rev-parse", "HEAD")).toBe(v1);
        expect(r.fin).toEqual([]);
      },
      T,
    );

    test("ostrzeżenie przed bun install: serwery MCP hipokampa z katalogu live", () => {
      const live = process.platform === "win32" ? "C:\\work\\hipokamp-live" : "/srv/hipokamp-live";
      const fwd = live.replace(/\\/g, "/");
      const lines = [
        `"C:/Users/x/.bun/bin/bun.exe" "${fwd}/src/mcp/server.ts"`,
        `bun ${live}${process.platform === "win32" ? "\\src\\mcp\\server.ts" : "/src/mcp/server.ts"}`,
        `"bun" "${fwd}/src/worker/main.ts"`,
        `"bun" "${fwd}-stary/src/mcp/server.ts"`,
        `"bun" "${fwd.replace("hipokamp-live", "hipokamp")}/src/mcp/server.ts"`,
      ];
      expect(U.mcpServersFrom(lines, live)).toBe(2);
      expect(U.mcpServersFrom([], live)).toBe(0);
    });

    test(
      "drugi etap: pliki pluginu bez brudzenia drzewa; plugin zarejestrowany gdzie indziej tylko ostrzega",
      async () => {
        const n = calls().length;
        let restarted = 0;
        let doctored = 0;
        const log: string[] = [];
        const ok = await U.finishUpdate({
          repo: c.ff,
          from: v1,
          log: (m) => log.push(m),
          restart: async () => ++restarted,
          doctor: async () => {
            doctored++;
          },
        });
        expect(ok).toBe(true);
        expect(existsSync(join(c.ff, "plugin", "hooks", "hooks.json"))).toBe(true);
        expect(L.gitCheckout(c.ff).dirty).toEqual([]);
        expect(log.join("\n")).toContain("przepnij go komendą hipokamp install");
        expect(calls().length).toBe(n);
        expect([restarted, doctored]).toEqual([1, 1]);
      },
      T,
    );

    test(
      "drugi etap po przepięciu na live: kopia w cache aktualna, bez wywołań claude",
      async () => {
        expect((await inst(c.ff)).ok).toBe(true);
        expect(same(L.pluginLocation().hooksRepo, c.ff)).toBe(true);
        const n = calls().length;
        const ok = await U.finishUpdate({
          repo: c.ff,
          from: v2,
          log: () => {},
          restart: async () => true,
          doctor: async () => {},
        });
        expect(ok).toBe(true);
        expect(calls().length).toBe(n);
        // worker, który nie wstał, to nieudany drugi etap
        const log: string[] = [];
        const bad = await U.finishUpdate({
          repo: c.ff,
          from: v2,
          log: (m) => log.push(m),
          restart: async () => null,
          doctor: async () => {},
        });
        expect(bad).toBe(false);
        expect(log.join("\n")).toContain("worker nie wstał");
      },
      T,
    );

    test(
      "drugi etap po commicie ze zmienionym skillem: kopia ustawień i świeża kopia pluginu w cache",
      async () => {
        const before = G(c.ff, "rev-parse", "HEAD");
        push("v3s: nowa treść skilla", {
          "plugin/skills/demo/SKILL.md": "---\nname: demo\ndescription: test\n---\nskill z commita\n",
        });
        G(c.ff, "fetch", "-q", "origin");
        G(c.ff, "merge", "-q", "--ff-only", "origin/main");
        const n = calls().length;
        const log: string[] = [];
        const ok = await U.finishUpdate({
          repo: c.ff,
          from: before,
          log: (m) => log.push(m),
          restart: async () => true,
          doctor: async () => {},
        });
        expect(ok).toBe(true);
        expect(log.join("\n")).toContain("kopia ustawień Claude Code");
        expect(calls().slice(n)).toContain("plugin uninstall hipokamp@hipokamp --keep-data");
        expect(readFileSync(join(L.pluginInstallPath() ?? "", "skills", "demo", "SKILL.md"), "utf8")).toContain(
          "skill z commita",
        );
        expect(L.pluginCacheCurrent(c.ff)).toBe(true);
        expect(L.gitCheckout(c.ff).dirty).toEqual([]);
      },
      T,
    );

    test(
      "diagnoza checkoutu: czysty live, zmiany, inna gałąź, zaległość, inny katalog komendy",
      () => {
        const ok = L.liveCheck({ codeRepo: c.ff });
        expect(ok.some((l) => l.startsWith("✓") && l.includes("czystego checkoutu") && l.includes("gałąź live"))).toBe(true);
        expect(ok.some((l) => l.startsWith("!"))).toBe(false);

        writeFileSync(join(c.ff, "README.md"), "edycja w katalogu pluginu\n");
        expect(L.liveCheck({ codeRepo: c.ff }).some((l) => l.startsWith("!") && l.includes("niezacommitowanymi"))).toBe(true);
        G(c.ff, "checkout", "-q", "--", "README.md");

        G(c.ff, "checkout", "-q", "-b", "eksperyment");
        expect(L.liveCheck({ codeRepo: c.ff }).some((l) => l.startsWith("!") && l.includes("nie live ani main"))).toBe(true);
        G(c.ff, "checkout", "-q", "live");

        push("v4", { "README.md": "v4\n" });
        G(c.ff, "fetch", "-q", "origin");
        expect(L.liveCheck({ codeRepo: c.ff }).some((l) => l.includes("za origin/main") && l.includes("hipokamp update"))).toBe(
          true,
        );
        expect(L.liveCheck({ codeRepo: seed }).some((l) => l.includes("komenda hipokamp działa z"))).toBe(true);
      },
      T,
    );
  });

  const M = await import("../src/hooks/modes.ts");
  const N = await import("../src/install/native.ts");
  const D = await import("../src/install/doctor.ts");
  const C = await import("../src/config.ts");

  test("doctor: sonda workera ponawiana tylko przy braku odpowiedzi w limicie, we wspólnym terminie (T-45)", async () => {
    type P = Awaited<ReturnType<typeof D.probeWorkerPatient>>;
    /** Najgorszy przypadek: wolna próba zjada oba etapy (zdrowie i wyzwanie), każdy po pełnym limicie. */
    const run = async (answers: P[]) => {
      let clock = 0;
      const limits: number[] = [];
      const pauses: number[] = [];
      const p = await D.probeWorkerPatient(
        async (t) => {
          limits.push(t);
          const a = answers[limits.length - 1] ?? { state: "none" };
          clock += a.state === "unverified" && a.reason.includes("w limicie") ? 2 * t : 10;
          return a;
        },
        async (ms) => {
          pauses.push(ms);
          clock += ms;
        },
        3,
        () => clock,
      );
      return { p, limits, pauses, total: clock };
    };
    const slow: P = { state: "unverified", reason: "brak odpowiedzi w limicie", lockPid: 7 };
    const ok = { state: "ok", health: { pid: 7 } } as unknown as P;
    // worker po restarcie (pętla stoi na ładowaniu modelu): pierwsza próba bez odpowiedzi, druga zdrowa
    const r = await run([slow, ok]);
    expect(r.p).toBe(ok);
    expect(r.limits).toEqual([D.PROBE_TIMEOUT_MS, 1500]); // druga próba: połowa reszty terminu
    expect(D.PROBE_TIMEOUT_MS).toBeGreaterThan(800);
    expect(r.pauses).toEqual([1000]);
    // stale bez odpowiedzi: kolejne próby dostają resztę terminu, całość mieści się w PROBE_BUDGET_MS
    const worst = await run([slow, slow, slow, ok]);
    expect(worst.p).toBe(slow);
    expect(worst.limits).toEqual([2500, 1500]);
    expect(worst.total).toBeLessThanOrEqual(D.PROBE_BUDGET_MS);
    // brak workera, odrzucone wyzwanie, starszy worker: od razu, bez czekania
    for (const a of [
      { state: "none" },
      { state: "unverified", reason: "zły dowód" },
      { state: "legacy", pid: 1, version: "0.1" },
    ] as P[])
      expect(await run([a, ok])).toMatchObject({ p: a, limits: [2500], pauses: [] });
  });

  describe("hooks.mode: tryb w hooks.json, kopia w cache i natywny hook", () => {
    const go = Bun.which("go");
    const EXE = process.platform === "win32" ? "hipokamp-hook.exe" : "hipokamp-hook";
    const setMode = (mode: string) => {
      writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ hooks: { mode } }));
      C.loadConfig(true);
    };
    /** Komendy z hooks.json kopii pluginu w cache (to, co naprawdę uruchamia Claude Code), jedna na linię. */
    const cacheHooks = () =>
      Object.values<any>(JSON.parse(readFileSync(join(L.pluginInstallPath() ?? "", "hooks", "hooks.json"), "utf8")).hooks)
        .flat()
        .flatMap((g: any) => g.hooks.map((h: any) => h.command ?? ""))
        .join("\n");
    /** Natywny hook zbudowany z native/hook tego repo do `dir` (go build, bez skryptu). */
    const buildTo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      const b = Bun.spawnSync([go as string, "build", "-o", join(dir, EXE), "."], { cwd: join(ROOT, "native", "hook") });
      if (b.exitCode !== 0) throw new Error(`go build: ${b.stderr.toString()}`);
      return join(dir, EXE);
    };
    /** Repo z hookiem Buna (test dymny sprawdza, że plik jest) i opcjonalnie zbudowanym natywnym hookiem. */
    const withHookTs = (d: string) => {
      mkdirSync(join(d, "src", "hooks"), { recursive: true });
      writeFileSync(join(d, "src", "hooks", "hook.ts"), "// hook Buna (atrapa)\n");
      return d;
    };

    test("hooksRepo rozpoznaje repo w hooks.json każdego trybu (także native i mcp)", () => {
      for (const mode of ["command", "native", "mcp"] as const) {
        const dir = join(DATA_DIR, "hooks-repo", mode);
        mkdirSync(join(dir, "hooks"), { recursive: true });
        const repo = join(DATA_DIR, "repo z spacją");
        writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify(M.pluginHooks({ mode, bun: process.execPath, repo })));
        expect(same(L.hooksRepo(dir), repo)).toBe(true);
      }
    });

    test.skipIf(!go)(
      "przełączenie command → native → command zmienia hooks.json i kopię w cache; doctor czyta kopię",
      async () => {
        const d = withHookTs(scaffold(join(DATA_DIR, "tryby")));
        setMode("command");
        expect((await inst(d)).ok).toBe(true);
        expect(cacheHooks()).not.toContain("--bun");
        expect(same(L.pluginLocation().hooksRepo, d)).toBe(true);
        expect(D.hooksCheck()).toMatchObject({ ok: true, line: expect.stringContaining("tryb command") });

        buildTo(join(d, "native", "hook"));
        setMode("native");
        // przed install: kopia w cache dalej command, a config chce native
        expect(D.hooksCheck()).toMatchObject({ ok: false, line: expect.stringContaining("po hipokamp install") });
        const r = await inst(d);
        expect(r.ok).toBe(true);
        expect(r.log).toContain("tryb native");
        expect(cacheHooks()).toContain(`--hook-ts "${join(d, "src", "hooks", "hook.ts").replace(/\\/g, "/")}"`);
        expect(cacheHooks()).toContain(" || ");
        expect(same(L.pluginLocation().hooksRepo, d)).toBe(true); // liveCheck dalej porównuje marketplace z hookami
        expect(L.pluginCacheCurrent(d)).toBe(true);
        expect(D.hooksCheck()).toMatchObject({ ok: true, line: expect.stringContaining("tryb native") });

        setMode("command");
        expect((await inst(d)).ok).toBe(true);
        expect(cacheHooks()).not.toContain("--bun");
        expect(D.hooksCheck()).toMatchObject({ ok: true, line: expect.stringContaining("tryb command") });
      },
      T,
    );

    test.skipIf(!go)(
      "native bez pliku w repo pluginu: command, choć repo komendy ma zbudowany hook",
      async () => {
        // test dymny sprawdza plik z repo, do którego idą ścieżki, nie z repo, z którego działa kod
        const d = withHookTs(scaffold(join(DATA_DIR, "bez-pliku")));
        setMode("native");
        const r = await inst(d);
        expect(r.ok).toBe(true);
        expect(r.log).toContain("tryb command");
        expect(cacheHooks()).not.toContain("--bun");
        setMode("command");
      },
      T,
    );

    test("ensureNative: tryb command nic nie buduje, bez Go ostrzeżenie i hooki przez Buna", () => {
      const d = withHookTs(scaffold(join(DATA_DIR, "bez-go")));
      mkdirSync(join(d, "native", "hook"), { recursive: true });
      mkdirSync(join(d, "scripts"), { recursive: true });
      writeFileSync(join(d, "native", "hook", "main.go"), "package main\n");
      for (const s of ["build-native.ps1", "build-native.sh"]) writeFileSync(join(d, "scripts", s), "exit 1\n");
      const log: string[] = [];
      expect(N.ensureNative({ repo: d, mode: "command", log: (m) => log.push(m), go: null })).toBe(false);
      expect(log).toEqual([]);
      expect(N.ensureNative({ repo: d, mode: "auto", log: (m) => log.push(m), go: null })).toBe(false);
      expect(log.join("\n")).toContain("nie ma Go");
      expect(log.join("\n")).toContain("hipokamp install");
    });

    test.skipIf(!go)(
      "ensureNative: zmienione źródła albo zła wersja = budowa skryptem z repo, udana i nieudana",
      () => {
        const d = withHookTs(scaffold(join(DATA_DIR, "budowa")));
        const prebuilt = buildTo(join(DATA_DIR, "gotowy"));
        const hook = join(d, "native", "hook");
        mkdirSync(hook, { recursive: true });
        mkdirSync(join(d, "scripts"), { recursive: true });
        writeFileSync(join(hook, "main.go"), "package main\n");
        const marker = join(d, "zbudowano.txt");
        // atrapa skryptu budowy: znacznik i gotowa binarka (prawdziwa budowa: build-native, testy w hooks.test.ts)
        const ps1 = `Set-Content -Path '${marker}' -Value 'tak'\r\nCopy-Item -Force '${prebuilt}' '${join(hook, EXE)}'\r\n`;
        const sh = `echo tak > '${marker}'\ncp -f '${prebuilt}' '${join(hook, EXE)}'\n`;
        writeFileSync(join(d, "scripts", "build-native.ps1"), ps1);
        writeFileSync(join(d, "scripts", "build-native.sh"), sh);
        const log: string[] = [];
        const run = (changed: boolean) => N.ensureNative({ repo: d, mode: "auto", log: (m) => log.push(m), changed, go });
        // brak pliku: budowa
        expect(run(false)).toBe(true);
        expect(existsSync(marker)).toBe(true);
        // plik dobry, źródła bez zmian: bez budowy
        rmSync(marker);
        expect(run(false)).toBe(true);
        expect(existsSync(marker)).toBe(false);
        // zmienione źródła (update): budowa mimo dobrego pliku
        expect(run(true)).toBe(true);
        expect(existsSync(marker)).toBe(true);
        expect(log.join("\n")).toContain("źródła natywnego hooka się zmieniły");
        // nieudana budowa przy starym pliku: zostaje poprzedni plik
        writeFileSync(join(d, "scripts", "build-native.ps1"), "exit 3\r\n");
        writeFileSync(join(d, "scripts", "build-native.sh"), "exit 3\n");
        log.length = 0;
        expect(run(true)).toBe(true);
        expect(log.join("\n")).toContain("budowa natywnego hooka nie wyszła");
        expect(log.join("\n")).toContain("Zostaje poprzedni plik");
      },
      T,
    );
  });
}
