// Udawany `claude` dla testów instalacji (test/install.test.ts): zapisuje każde wywołanie do FAKE_CLAUDE_LOG
// i symuluje `claude plugin` w CLAUDE_CONFIG_DIR (known_marketplaces.json, installed_plugins.json w wersji 2, kopia
// pluginu w cache, enabledPlugins w settings.json). Zachowania jak w prawdziwym Claude Code 2.1.272 (sprawdzone na
// tymczasowym CLAUDE_CONFIG_DIR):
// - `marketplace add` z nazwą już zarejestrowaną nadpisuje ścieżkę i zapisuje ją też w `extraKnownMarketplaces`
//   w settings.json (`marketplace remove` ten wpis usuwa); `marketplace update` i `plugin install` już
//   zainstalowanego pluginu NIE odświeżają kopii w cache;
// - `plugin install` zastępuje cały katalog kopii (`rm` i kopia źródła; znika też `.orphaned_at`);
// - `plugin uninstall` (z `--keep-data` i bez) usuwa wpis i enabledPlugins, ale katalogu kopii nie kasuje: zapisuje
//   w nim `.orphaned_at` (czas w ms); `marketplace remove` robi to samo z pluginami z tego marketplace;
// - `plugin enable` przechodzi też dla niezainstalowanego pluginu, a dla włączonego kończy się błędem „already enabled”;
// - `plugin uninstall` niezainstalowanego to błąd; `plugin validate` i `install` padają na zepsutym manifeście.
// Awarie na żądanie przez pliki w CLAUDE_CONFIG_DIR (nie zmienne środowiskowe: Bun nie przekazuje dzieciom zmian
// process.env z czasu działania): `fail-add.txt` z fragmentem ścieżki psuje `marketplace add` tej ścieżki,
// `fail-install.txt` psuje `plugin install` (np. zablokowane pliki), choć manifest jest poprawny,
// `fail-uninstall.txt` psuje `plugin uninstall` bez żadnej zmiany, `install-skip.txt` ze ścieżką względną pliku
// pluginu pomija ten plik przy kopiowaniu (instalacja „udana”, ale kopia niepełna).
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const claude = process.env.CLAUDE_CONFIG_DIR ?? "";
if (!claude.includes("hipokamp-test")) {
  console.error("udawany claude: CLAUDE_CONFIG_DIR spoza katalogu testowego, odmawiam");
  process.exit(2);
}
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG ?? join(claude, "calls.jsonl"), `${JSON.stringify(args)}\n`);

const pl = join(claude, "plugins");
mkdirSync(pl, { recursive: true });
const KM = join(pl, "known_marketplaces.json");
const IP = join(pl, "installed_plugins.json");
const ST = join(claude, "settings.json");
const rd = (f: string, d: any) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const wr = (f: string, v: unknown) => writeFileSync(f, JSON.stringify(v, null, 2));
const known = rd(KM, {});
const inst = rd(IP, { version: 2, plugins: {} });
const now = new Date().toISOString();
const enabled = () => rd(ST, {}).enabledPlugins ?? {};
const setEnabled = (id: string, on: boolean | null) => {
  const st = rd(ST, {});
  st.enabledPlugins ??= {};
  if (on === null) delete st.enabledPlugins[id];
  else st.enabledPlugins[id] = on;
  wr(ST, st);
};
const setExtra = (name: string, path: string | null) => {
  const st = rd(ST, {});
  st.extraKnownMarketplaces ??= {};
  if (path === null) delete st.extraKnownMarketplaces[name];
  else st.extraKnownMarketplaces[name] = { source: { source: "directory", path: resolve(path) } };
  wr(ST, st);
};
const orphan = (dir: string) => {
  if (existsSync(dir)) writeFileSync(join(dir, ".orphaned_at"), String(Date.now()));
};
const fail = (m: string): never => {
  console.error(`✘ ${m}`);
  process.exit(1);
};
const flag = (name: string) => (existsSync(join(claude, name)) ? readFileSync(join(claude, name), "utf8").trim() : null);
/** Parsuje manifest jak prawdziwy CLI: brak pliku to null, zepsuty JSON kończy komendę błędem. */
const manifest = (p: string) => {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return fail(`Invalid JSON in ${p}: ${String(e)}`);
  }
};
const marketplaceName = (dir: string) => {
  const m = manifest(join(dir, ".claude-plugin", "marketplace.json"));
  if (!m?.name) fail(`brak .claude-plugin/marketplace.json w ${dir}`);
  return m.name as string;
};

const [a, b, c, d] = args;
if (a !== "plugin") fail(`nieznana komenda: ${args.join(" ")}`);
if (b === "validate") {
  const mk = manifest(join(c, ".claude-plugin", "marketplace.json"));
  if (mk) for (const p of mk.plugins ?? []) manifest(join(c, p.source, ".claude-plugin", "plugin.json"));
  else if (!manifest(join(c, ".claude-plugin", "plugin.json"))) fail(`No manifest found in ${c}`);
  console.log("✔ Validation passed");
} else if (b === "marketplace") {
  if (c === "add") {
    const bad = flag("fail-add.txt");
    if (bad && d.includes(bad)) fail(`Failed to add marketplace: ${d}`);
    const name = marketplaceName(d);
    known[name] = { source: { source: "directory", path: d }, installLocation: d, lastUpdated: now };
    wr(KM, known);
    setExtra(name, d);
    console.log(`✔ Successfully added marketplace: ${name} (declared in user settings)`);
  } else if (c === "remove") {
    if (!known[d]) fail(`Marketplace '${d}' not found`);
    delete known[d];
    wr(KM, known);
    setExtra(d, null);
    for (const id of Object.keys(inst.plugins))
      if (id.endsWith(`@${d}`)) {
        for (const e of inst.plugins[id]) orphan(e.installPath);
        delete inst.plugins[id];
        setEnabled(id, null);
      }
    wr(IP, inst);
    console.log(`✔ Successfully removed marketplace: ${d}`);
  } else if (c === "update") {
    if (!known[d]) fail(`Marketplace '${d}' not found`);
    marketplaceName(known[d].source.path);
    known[d].lastUpdated = now;
    wr(KM, known);
    console.log(`✔ Successfully updated marketplace: ${d}`);
  } else fail(`nieznana komenda: ${args.join(" ")}`);
} else if (b === "install") {
  const [p, m] = c.split("@");
  if (!known[m]) fail(`Marketplace "${m}" not found`);
  if (inst.plugins[c]) {
    console.log(`✔ Plugin "${c}" is already installed (scope: user)`);
    process.exit(0);
  }
  const src = join(known[m].source.path, "plugin");
  manifest(join(src, ".claude-plugin", "plugin.json"));
  if (flag("fail-install.txt") !== null) fail(`Failed to install plugin "${c}": EBUSY`);
  const dst = join(pl, "cache", m, p, "0.1.0");
  rmSync(dst, { recursive: true, force: true });
  const skip = flag("install-skip.txt");
  cpSync(src, dst, {
    recursive: true,
    filter: (f) => !skip || relative(src, f).replace(/\\/g, "/") !== skip,
  });
  inst.plugins[c] = [{ scope: "user", installPath: dst, version: "0.1.0", installedAt: now, lastUpdated: now }];
  wr(IP, inst);
  setEnabled(c, true);
  console.log(`✔ Successfully installed plugin: ${c} (scope: user)`);
} else if (b === "uninstall") {
  if (!inst.plugins[c]) fail(`Failed to uninstall plugin "${c}": Plugin "${c}" not found in installed plugins`);
  if (flag("fail-uninstall.txt") !== null) fail(`Failed to uninstall plugin "${c}": EPERM`);
  for (const e of inst.plugins[c]) orphan(e.installPath);
  delete inst.plugins[c];
  wr(IP, inst);
  setEnabled(c, null);
  console.log(`✔ Successfully uninstalled plugin: ${c}`);
} else if (b === "enable") {
  if (enabled()[c] === true) fail(`Failed to enable plugin "${c}": Plugin "${c}" is already enabled`);
  setEnabled(c, true);
  console.log(`✔ Successfully enabled plugin: ${c} (scope: user)`);
} else if (b === "disable") {
  setEnabled(c, false);
  console.log(`✔ Successfully disabled plugin: ${c}`);
} else fail(`nieznana komenda: ${args.join(" ")}`);
