// Ścieżki obcego stylu: transkrypt, hook albo alias z innej maszyny (Windows na Linuksie, WSL na Windows) liczymy według
// stylu samej ścieżki, nie systemu, na którym działa hipokamp. Testy mają przechodzić na Windows i na Linuksie bez
// warunków na platformę: stałe są pisane w obu stylach, a wynik ma być ten sam wszędzie.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  absFromKey,
  fileKey,
  gitRoot,
  isSubdir,
  isWinPath,
  normPath,
  pathKey,
  pathPlatform,
  projectFromCwd,
  resolveIn,
  samePath,
} from "../src/util/paths.ts";

// Nieistniejące katalogi: nic na dysku nie może ich „znaleźć”
const WIN = "D:\\hipokamp-test-brak\\demo";
const POSIX = "/hipokamp-test-brak/demo";

describe("styl ścieżki", () => {
  test("litera dysku i UNC to Windows, reszta nie", () => {
    for (const p of ["D:\\code", "d:/code", "C:", "C:\\", "\\\\serwer\\udzial\\x"]) expect(isWinPath(p)).toBe(true);
    for (const p of ["/home/x", "src/a.ts", "D:a.ts", "", "\\foo"]) expect(isWinPath(p)).toBe(false);
  });

  test("względna ścieżka według stylu katalogu bazowego, na każdym systemie", () => {
    expect(resolveIn(WIN, "src/a.ts")).toBe("D:\\hipokamp-test-brak\\demo\\src\\a.ts");
    expect(resolveIn(WIN, "..\\x.ts")).toBe("D:\\hipokamp-test-brak\\x.ts");
    expect(resolveIn(WIN, "\\foo\\a.ts")).toBe("D:\\foo\\a.ts"); // od korzenia dysku bazy
    expect(resolveIn(WIN, "D:a.ts")).toBe("D:\\hipokamp-test-brak\\demo\\a.ts"); // względna na tym samym dysku
    expect(resolveIn(POSIX, "src/a.ts")).toBe("/hipokamp-test-brak/demo/src/a.ts");
    expect(resolveIn(POSIX, "../x.ts")).toBe("/hipokamp-test-brak/x.ts");
  });

  test("ścieżka już bezwzględna (dowolnego stylu) i brak bazy zostają bez zmian", () => {
    for (const base of [WIN, POSIX, null, undefined, ""]) {
      expect(resolveIn(base, "D:/x/y.ts")).toBe("D:/x/y.ts");
      expect(resolveIn(base, "d:\\x\\y.ts")).toBe("d:\\x\\y.ts");
      expect(resolveIn(base, "\\\\serwer\\udzial\\y.ts")).toBe("\\\\serwer\\udzial\\y.ts");
      expect(resolveIn(base, "/abs/y.ts")).toBe("/abs/y.ts");
      expect(resolveIn(base, "  /abs/y.ts ")).toBe("/abs/y.ts");
    }
    expect(resolveIn(null, "src/a.ts")).toBe("src/a.ts");
  });
});

describe("katalog obcego stylu nie jest rozwiązywany w katalogu procesu", () => {
  const base = mkdtempSync(join(tmpdir(), "hipokamp-test-paths-"));
  const procRepo = join(base, "repo-procesu");
  mkdirSync(join(procRepo, ".git"), { recursive: true });
  const prev = process.cwd();
  afterAll(() => {
    process.chdir(prev);
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {}
  });
  // katalog procesu w repo git: na Linuksie resolve("D:\\…") położyłby ścieżkę Windows pod nim i gitRoot znalazłby to repo
  const inProcessRepo = <T>(f: () => T): T => {
    process.chdir(procRepo);
    try {
      return f();
    } finally {
      process.chdir(prev);
    }
  };

  test("gitRoot: katalog Windows nie ma repo z katalogu procesu", () => {
    expect(gitRoot(procRepo)?.root).toBe(procRepo); // pułapka jest prawdziwym repo
    expect(inProcessRepo(() => gitRoot(WIN))).toBeNull();
  });

  test("projectFromCwd: nazwa z ostatniego członu ścieżki, nie z repo procesu ani całej ścieżki", () => {
    expect(inProcessRepo(() => projectFromCwd(WIN))).toBe("demo");
    expect(inProcessRepo(() => projectFromCwd(`${WIN}\\`))).toBe("demo");
    expect(inProcessRepo(() => projectFromCwd("d:/hipokamp-test-brak/demo"))).toBe("demo");
    expect(inProcessRepo(() => projectFromCwd("D:\\"))).toBe("drive-D");
    expect(projectFromCwd(POSIX)).toBe("demo");
  });

  test("fileKey i absFromKey liczą od katalogu Windows, a nie od repo procesu", () => {
    inProcessRepo(() => {
      expect(fileKey(`${WIN}\\src\\a.ts`, WIN)).toBe("src/a.ts");
      expect(fileKey("D:/hipokamp-test-brak/inny/b.ts", WIN)).toBe("d:/hipokamp-test-brak/inny/b.ts");
      expect(absFromKey("src/a.ts", WIN)).toBe("d:/hipokamp-test-brak/demo/src/a.ts");
    });
    expect(absFromKey("src/a.ts", POSIX)).toBe("/hipokamp-test-brak/demo/src/a.ts");
  });
});

// T-38: zachowanie każdego systemu na jednej maszynie (parametr albo HIPOKAMP_PATH_PLATFORM)
describe("system ścieżek wymuszony parametrem i zmienną", () => {
  test("Git Bash /d/… → d:/… tylko na Windows; reszta normalizacji wszędzie taka sama", () => {
    expect(normPath("/d/code/x", "win32")).toBe("d:/code/x");
    expect(normPath("/D/code/x/", "win32")).toBe("d:/code/x");
    for (const plat of ["linux", "darwin"] as const) {
      expect(normPath("/d/code/x", plat)).toBe("/d/code/x");
      expect(normPath("/d/", plat)).toBe("/d/");
    }
    // dotychczasowe wejścia na Windows bez zmian
    expect(normPath("D:\\Code\\X\\", "win32")).toBe("d:/Code/X");
    expect(normPath("/home/x/", "win32")).toBe("/home/x");
    for (const plat of ["win32", "linux", "darwin"] as const) expect(normPath("D:\\Code\\X", plat)).toBe("d:/Code/X");
  });

  test("wielkość liter: Linux ją rozróżnia, Windows i macOS nie, ścieżka Windows nigdzie", () => {
    expect(pathKey("/home/Jan/x", "linux")).toBe("/home/Jan/x");
    expect(pathKey("/home/Jan/x", "darwin")).toBe("/home/jan/x");
    expect(pathKey("D:\\Code\\X", "win32")).toBe("d:/code/x");
    expect(pathKey("D:\\Code\\X", "linux")).toBe("d:/code/x");
    expect(pathKey("\\\\Serwer\\Udzial", "linux")).toBe("//serwer/udzial");

    expect(samePath("/srv/Jan/x", "/srv/jan/x", "linux")).toBe(false);
    expect(samePath("/srv/jan/x/", "/srv/jan/x", "linux")).toBe(true);
    expect(samePath("/srv/Jan/x", "/srv/jan/x", "darwin")).toBe(true);
    expect(samePath("D:\\Code\\X", "d:/code/x", "win32")).toBe(true);
    expect(samePath("D:\\Code\\X", "d:/code/x", "linux")).toBe(true);

    expect(isSubdir("/srv/Jan/x/y", "/srv/jan/x", "linux")).toBe(false);
    expect(isSubdir("/srv/jan/x/y", "/srv/jan/x", "linux")).toBe(true);
    expect(isSubdir("/srv/Jan/x/y", "/srv/jan/x", "darwin")).toBe(true);
    expect(isSubdir("D:\\Code\\X\\y", "d:/code/x", "win32")).toBe(true);
    expect(isSubdir("D:\\Code\\X\\y", "d:/code/x", "linux")).toBe(true);
    expect(isSubdir("d:/code/x", "d:/code/x", "win32")).toBe(false);
  });

  test("HIPOKAMP_PATH_PLATFORM zmienia domyślny system, nieznana wartość nic nie zmienia", () => {
    const old = process.env.HIPOKAMP_PATH_PLATFORM;
    try {
      delete process.env.HIPOKAMP_PATH_PLATFORM;
      expect(pathPlatform()).toBe(process.platform);
      process.env.HIPOKAMP_PATH_PLATFORM = "linux";
      expect(pathPlatform()).toBe("linux");
      expect(normPath("/d/code")).toBe("/d/code");
      expect(pathKey("/srv/Jan")).toBe("/srv/Jan");
      process.env.HIPOKAMP_PATH_PLATFORM = "win32";
      expect(normPath("/d/code")).toBe("d:/code");
      expect(pathKey("/srv/Jan")).toBe("/srv/jan");
      process.env.HIPOKAMP_PATH_PLATFORM = "amiga";
      expect(pathPlatform()).toBe(process.platform);
    } finally {
      if (old === undefined) delete process.env.HIPOKAMP_PATH_PLATFORM;
      else process.env.HIPOKAMP_PATH_PLATFORM = old;
    }
  });
});
