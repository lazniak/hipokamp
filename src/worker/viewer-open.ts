// `hipokamp open` po stronie klienta (T-34): bilet podglądu nigdy nie trafia do linii poleceń procesu. Na Linux
// i macOS linia poleceń `xdg-open`, `open` i przeglądarki jest widoczna dla innych kont (`ps`), a przeglądarka na
// zimno startuje kilka sekund: kto przeczyta bilet pierwszy, dostaje ciasteczko na 30 dni. Dlatego CLI zapisuje
// mały plik HTML (bilet w treści, przekierowanie `location.replace`) w prywatnym katalogu `<dane>/state/open/`
// i otwiera ścieżkę pliku. Katalog: POSIX 0700, Windows bez dziedziczenia, tylko bieżący użytkownik, SYSTEM
// i Administratorzy (pliki dziedziczą to od urodzenia; `state/` bywa czytelny dla innych kont, np. piaskownicy
// Codexa). Pliki mają losowe nazwy, starsze niż ważność biletu sprząta każde następne `open`. Moduł nie jest
// importowany przez workera (uruchamia procesy: przeglądarkę, icacls, whoami i PowerShell Get-Acl na Windows,
// xdg-settings na Linux). Katalog `open` nie może być dowiązaniem ani junction i musi należeć do bieżącego
// użytkownika (Windows: także Administratorzy): właściciel obcego katalogu mógłby po naszym icacls dopisać sobie odczyt.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSddl } from "./keyacl.ts";
import { TICKET_TTL_MS } from "./viewer-auth.ts";

/** Podkatalog stanu na pliki przekierowania. */
export const LAUNCHER_DIR = "open";
const LAUNCHER_RE = /^viewer-open-[0-9a-f]{16}\.html$/;

const WIN = process.platform === "win32";
const SYS32 = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");
/** SID-y kont, które poza użytkownikiem mogą mieć dostęp do prywatnego katalogu: SYSTEM i Administratorzy. */
export const SYSTEM_SIDS = ["SY", "BA", "S-1-5-18", "S-1-5-32-544"];
/** Poza bieżącym użytkownikiem właścicielem prywatnego katalogu mogą być tylko Administratorzy. */
const ADMIN_SIDS = ["BA", "S-1-5-32-544"];

/** Treść pliku: przekierowanie bez wpisu w historii (skrypt) i zapasowo meta refresh (bez JavaScriptu). */
export function launcherHtml(url: string): string {
  // adres składa się z portu i biletu (cyfry, hex, kropki), ale i tak bez znaków, które coś znaczą w HTML
  const attr = url.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const js = JSON.stringify(url).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>hipokamp</title><noscript><meta http-equiv="refresh" content="0;url=${attr}"></noscript></head>
<body><script>location.replace(${js})</script></body></html>
`;
}

/**
 * Program z limitem czasu (lista argumentów, bez powłoki); null, gdy się nie uruchomił albo nie skończył w limicie.
 * Bun.spawn zamiast spawnSync: `timeout` w spawnSync Buna (1.3, Windows) potrafi zgłosić ETIMEDOUT po kilku
 * milisekundach w procesie, który wcześniej uruchamiał wiele procesów (widać to w pełnym `bun test`). Odczyt wyjścia
 * ściga się z zegarem: skrypt (np. `xdg-settings`) po zabiciu powłoki zostawia potomka, który trzyma stdout, więc na
 * koniec strumienia nie wolno czekać bez limitu.
 */
async function run(
  cmd: string,
  args: string[],
  timeout = 5000,
  env?: Record<string, string>,
): Promise<{ status: number | null; stdout: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Bun.spawn([cmd, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        p.kill();
        resolve(null);
      }, timeout);
    });
    const done = Promise.all([new Response(p.stdout).text(), p.exited]).then(([stdout, status]) =>
      p.signalCode ? null : { status, stdout },
    );
    return await Promise.race([done, late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let mySid: string | undefined;
/** SID bieżącego użytkownika (`whoami /user`, po pełnej ścieżce: w Git Bash `whoami` z PATH to coreutils). */
export async function currentSid(): Promise<string | null> {
  if (mySid) return mySid;
  const r = await run(join(SYS32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const m = /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/m.exec(r?.stdout ?? "");
  if (m) mySid = m[1];
  else
    privateDirError = `whoami /user: ${r ? `kod ${r.status}, wyjście ${JSON.stringify(r.stdout.slice(0, 200))}` : "nie uruchomił się albo limit czasu"}`;
  return m ? m[1] : null;
}

/** Właściciel i DACL katalogu albo pliku. */
export type SecInfo = (NonNullable<ReturnType<typeof parseSddl>> & { owner: string | null }) | null;

/** Właściciel i DACL z pełnego SDDL (`O:…G:…D:…`); null, gdy nie ma w nim DACL. */
export function parseSecurity(sddl: string): SecInfo {
  const dacl = parseSddl(sddl);
  if (!dacl) return null;
  const o = /(?:^|\s)O:(.+?)(?=G:|D:|S:|$)/m.exec(sddl.trim());
  return { ...dacl, owner: o ? o[1] : null };
}

/**
 * Właściciel i DACL przez PowerShell `Get-Acl` (pełny SDDL; `icacls /save` właściciela nie podaje). Ścieżka idzie
 * przez zmienną środowiska, nie przez tekst polecenia, więc żadne znaki w niej nic nie znaczą dla PowerShella.
 */
export async function readAcl(path: string): Promise<SecInfo> {
  const r = await run(
    join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:HIPOKAMP_ACL_PATH).Sddl"],
    15_000,
    { HIPOKAMP_ACL_PATH: path },
  );
  return r?.status === 0 ? parseSecurity(r.stdout) : null;
}

/**
 * Prywatny katalog: właściciel to `sid` albo Administratorzy, wpisy zezwalające tylko dla `sid`, SYSTEM
 * i Administratorów. `dir`: także bez dziedziczenia z rodzica (flaga P, żaden wpis z flagą ID); pliku nie pytamy o P,
 * bo dziedziczy z prywatnego katalogu.
 */
export function privateAcl(acl: SecInfo, sid: string, dir = true): boolean {
  if (!acl?.owner || (acl.owner !== sid && !ADMIN_SIDS.includes(acl.owner))) return false;
  const allow = acl.aces.filter((a) => a.type === "A");
  if (!allow.length || allow.some((a) => a.sid !== sid && !SYSTEM_SIDS.includes(a.sid))) return false;
  return !dir || (acl.protected && !acl.aces.some((a) => a.flags.includes("ID")));
}

/**
 * Katalog plików przekierowania tylko dla użytkownika; null, gdy nie da się go takim zrobić (wtedy CLI wypisuje link
 * zamiast pisać bilet do pliku). Windows: najpierw jawne prawa (z dziedziczeniem na pliki: OI, CI) dla użytkownika,
 * SYSTEM i Administratorów, potem zdjęcie dziedziczenia z `state/`; sprawdzenie właściciela i wpisów po SID z pełnego
 * SDDL (`Get-Acl`).
 */
export async function privateDir(stateDir: string): Promise<string | null> {
  const dir = join(stateDir, LAUNCHER_DIR);
  const fail = (why: string) => {
    privateDirError = why;
    return null;
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // dowiązanie albo junction (lstat Buna zgłasza junction jako dowiązanie): plik trafiłby tam, gdzie wskazuje
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return fail("state/open jest dowiązaniem albo nie jest katalogiem");
    if (!WIN) {
      if (process.getuid && st.uid !== process.getuid()) return fail("state/open należy do innego użytkownika");
      chmodSync(dir, 0o700);
      return (statSync(dir).mode & 0o077) === 0 ? dir : fail("katalog nie ma trybu 0700");
    }
    const sid = await currentSid();
    if (!sid) return fail(privateDirError || "nie znam SID bieżącego użytkownika (whoami /user)");
    const before = await readAcl(dir);
    if (privateAcl(before, sid)) return dir;
    // obcy właściciel może zmienić ACL po naszym icacls: tylko link, bez pliku
    if (before?.owner && before.owner !== sid && !ADMIN_SIDS.includes(before.owner))
      return fail(`state/open ma obcego właściciela (${before.owner})`);
    const icacls = join(SYS32, "icacls.exe");
    const g = await run(icacls, [dir, "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
    if (g?.status !== 0) return fail(`icacls /grant: ${g ? `kod ${g.status}` : "limit czasu"}`);
    const i = await run(icacls, [dir, "/inheritance:r"]);
    if (i?.status !== 0) return fail(`icacls /inheritance:r: ${i ? `kod ${i.status}` : "limit czasu"}`);
    return privateAcl(await readAcl(dir), sid) ? dir : fail("po zmianie ACL katalog nadal nie jest prywatny");
  } catch (e) {
    return fail(String(e));
  }
}

/** Powód ostatniego niepowodzenia privateDir (CLI i testy). */
export let privateDirError = "";

/** Usuwa pliki przekierowania starsze niż ważność biletu (po wymianie albo terminie bilet i tak nic nie znaczy). */
export function sweepLaunchers(dir: string, now = Date.now()): void {
  try {
    for (const f of readdirSync(dir)) {
      if (!LAUNCHER_RE.test(f)) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > TICKET_TTL_MS) rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

/**
 * Nowy plik przekierowania w prywatnym katalogu: losowa nazwa (dwa równoległe `open` się nie zderzą), `wx`, 0600.
 * null: katalogu nie da się zrobić prywatnym albo zapis się nie udał (CLI wypisuje wtedy link).
 */
export async function writeLauncher(stateDir: string, url: string): Promise<string | null> {
  const dir = await privateDir(stateDir);
  if (!dir) return null;
  sweepLaunchers(dir);
  const file = join(dir, `viewer-open-${randomBytes(8).toString("hex")}.html`);
  try {
    writeFileSync(file, launcherHtml(url), { flag: "wx", mode: 0o600 });
    if (!WIN) chmodSync(file, 0o600);
    return file;
  } catch {
    rmSync(file, { force: true });
    return null;
  }
}

/** Usuwa jeden plik przekierowania (np. gdy przeglądarki nie dało się uruchomić i CLI wypisuje link). */
export function removeLauncher(file: string | null): void {
  if (file) rmSync(file, { force: true });
}

/**
 * Linux: domyślna przeglądarka ze snapa albo flatpaka nie czyta `~/.hipokamp` (izolacja katalogu domowego), więc
 * plik się nie otworzy. Heurystyka po identyfikatorze z `xdg-settings get default-web-browser`: snap ma `_`
 * w nazwie pliku .desktop (`firefox_firefox.desktop`), flatpak eksportuje go do `…/flatpak/exports/share/applications`.
 */
export async function sandboxedBrowser(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const id = ((await run("xdg-settings", ["get", "default-web-browser"], 1500))?.stdout ?? "").trim();
  if (!id) return false;
  if (/_/.test(id) || existsSync(join("/snap/bin", id.replace(/\.desktop$/, "")))) return true;
  return ["/var/lib/flatpak/exports/share/applications", join(homedir(), ".local/share/flatpak/exports/share/applications")].some(
    (d) => existsSync(join(d, id)),
  );
}

/**
 * Domyślna przeglądarka z plikiem (nie z adresem): lista argumentów, bez powłoki, odłączony proces. Windows:
 * `rundll32 url.dll,FileProtocolHandler` (bez okna konsoli i bez parsowania przez cmd). false: nie udało się
 * uruchomić (brak xdg-open itp.), wtedy CLI wypisuje link.
 */
export function openInBrowser(file: string): boolean {
  const argv = WIN
    ? ["rundll32.exe", "url.dll,FileProtocolHandler", file]
    : process.platform === "darwin"
      ? ["open", file]
      : ["xdg-open", file];
  try {
    const child = Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
