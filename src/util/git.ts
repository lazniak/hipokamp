// Odczyt HEAD repozytorium bez uruchamiania gita (tanie: kilka odczytów plików).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitRoot } from "./paths.ts";

function gitDir(root: string): string | null {
  const g = join(root, ".git");
  if (!existsSync(g)) return null;
  try {
    if (statSync(g).isDirectory()) return g;
    const m = readFileSync(g, "utf8").match(/gitdir:\s*(.+)/);
    return m ? resolve(root, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** Hash commita HEAD (albo null). Obsługuje worktree i packed-refs. */
export function gitHead(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const r = gitRoot(cwd);
  if (!r) return null;
  const gd = gitDir(r.root);
  if (!gd) return null;
  try {
    const head = readFileSync(join(gd, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return null;
    // worktree: refy są we wspólnym katalogu (commondir)
    const dirs = [gd];
    const common = join(gd, "commondir");
    if (existsSync(common)) dirs.push(resolve(gd, readFileSync(common, "utf8").trim()));
    for (const d of dirs) {
      const p = join(d, ref);
      if (existsSync(p)) return readFileSync(p, "utf8").trim();
    }
    for (const d of dirs) {
      const packed = join(d, "packed-refs");
      if (!existsSync(packed)) continue;
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        const [hash, name] = line.trim().split(" ");
        if (name === ref) return hash;
      }
    }
  } catch {}
  return null;
}

/** Pliki do tej wielkości mają w odcisku skrót treści: sama zmiana mtime (git checkout, touch) to nie zmiana pliku. */
export const FINGERPRINT_HASH_MAX = 1024 * 1024;

/** Skrót treści pliku (xxHash64, 16 znaków hex) albo null: plik większy niż limit albo nieczytelny. */
export function contentDigest(abs: string, size?: number): string | null {
  try {
    if ((size ?? statSync(abs).size) > FINGERPRINT_HASH_MAX) return null;
    return Bun.hash.xxHash64(readFileSync(abs)).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

/**
 * Odcisk stanu pliku (do wykrywania przeterminowanych notatek): `mtime:rozmiar:x<skrót treści>` dla plików do 1 MB,
 * `mtime:rozmiar` dla większych. Stary format (`mtime:rozmiar`) zostaje w bazie i dalej działa po mtime.
 */
export function fingerprint(abs: string): string | null {
  try {
    const st = statSync(abs);
    const base = `${Math.round(st.mtimeMs)}:${st.size}`;
    const h = st.size <= FINGERPRINT_HASH_MAX ? contentDigest(abs, st.size) : null;
    return h ? `${base}:x${h}` : base;
  } catch {
    return null;
  }
}

/** Rozbiór odcisku: mtime, rozmiar (null w uszkodzonym wpisie) i skrót treści (null w starym formacie i dla dużych plików). */
export function parseFingerprint(fp: string): { mtime: number; size: number | null; hash: string | null } {
  const [m, s, h] = fp.split(":");
  const size = s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
  return { mtime: Number(m), size, hash: h?.startsWith("x") && h.length > 1 ? h.slice(1) : null };
}
