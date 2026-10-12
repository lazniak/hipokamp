// smart_outline / smart_unfold / smart_search: końce ciał po leksemach i granice projektu. Wszystko w katalogu
// tymczasowym (hipokamp-test-*), bez bazy i bez prawdziwego katalogu domowego.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outlineText, rangesOf, smartOutline, smartSearch, smartUnfold } from "../src/mcp/code.ts";

const FIX = join(import.meta.dir, "fixtures", "code");
const base = mkdtempSync(join(tmpdir(), "hipokamp-test-code-"));
const proj = join(base, "proj");
const outside = join(base, "outside");
const cfgDir = join(base, "cfg");
// sztuczny klucz składany w locie, żeby w repo nie leżał literał wyglądający na sekret
const FAKE_KEY = ["sk-or-v1-", "a1b2c3d4e5f6".repeat(4)].join("");
// hasło bez znanego prefiksu: maskuje je tylko reguła przypisań (password = ...), nie wzorzec klucza
const FAKE_PASS = ["Zq7v", "R2mL", "p9xT", "w4kN"].join("");
// hasła w złamanych przypisaniach z piątej recenzji PR #8 (main je maskował)
const R5 = [
  ["Wiosna", "2026xQ"],
  ["Lato", "2026xyzQ"],
  ["Secret", "123xyz"],
].map((p) => p.join(""));
// ścieżka długa i niepasująca do *.ts: na niej stare wyrażenie dla powtórzonego **/ cofało się wykładniczo
const DEEP = "src/deep/nested/transcripts/module.py";

// projekt budujemy od razu (nie w beforeAll), bo test.skipIf czyta `linked` przy definiowaniu testów
function setup(): boolean {
  const dirs = [
    "src/deep/nested/transcripts",
    "docs",
    ".git",
    ".claude/agents",
    ".claude/worktrees/wt1/src",
    ".github/scripts",
    ".gitea/actions",
    ".hidden",
    "config",
  ];
  for (const d of dirs) mkdirSync(join(proj, d), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(cfgDir, "skills", "s1"), { recursive: true });
  const copies: [string, string][] = [
    ["sample.ts.txt", "src/sample.ts"],
    ["sample.py.txt", "src/sample.py"],
    ["sample.md.txt", "docs/sample.md"],
    ["pool.go.txt", "src/pool.go"],
    ["pool.rs.txt", "src/pool.rs"],
    ["Shader.cs.txt", "src/Shader.cs"],
    ["tools.ps1.txt", "src/tools.ps1"],
    ["Store.kt.txt", "src/Store.kt"],
    ["widget.cpp.txt", "src/widget.cpp"],
    ["platform.c.txt", "src/platform.c"],
    ["render.php.txt", "src/render.php"],
    ["Shop.kt.txt", "src/Shop.kt"],
    ["classhead.hpp.txt", "src/classhead.hpp"],
  ];
  for (const [from, to] of copies) copyFileSync(join(FIX, from), join(proj, to));
  // katalogi z kropką czytane wyjątkowo (.github, .gitea, .claude) i to, co w nich dalej zakryte
  writeFileSync(join(proj, ".github", "scripts", "release.ts"), "export function publishRelease() {\n  return 1;\n}\n");
  writeFileSync(join(proj, ".gitea", "actions", "check.ps1"), "function Invoke-GiteaCheck {\n  return 1\n}\n");
  writeFileSync(join(proj, ".claude", "agents", "reviewer.md"), "# Recenzent\n\nSprawdza diff.\n");
  writeFileSync(join(proj, ".claude", "worktrees", "wt1", "src", "dup.ts"), "export function publishRelease() {}\n");
  writeFileSync(join(proj, ".claude", ".credentials.json"), JSON.stringify({ token: FAKE_KEY }));
  // projekt wewnątrz katalogu konfiguracji Claude Code (repo skilla w ~/.claude/skills), poza repo proj
  writeFileSync(join(cfgDir, "skills", "s1", "SKILL.md"), "# Skill\n\nOpis.\n");
  // pliki danych z sekretami (zostają zablokowane) i kod z tym słowem w nazwie (dostępny, z redakcją)
  writeFileSync(join(proj, "credentials.json"), JSON.stringify({ key: FAKE_KEY }));
  writeFileSync(join(proj, "config", "secrets.yaml"), `key: ${FAKE_KEY}\n`);
  writeFileSync(join(proj, "src", "credentials.service.ts"), `export class CredentialsService {\n  apiKey = "${FAKE_KEY}";\n}\n`);
  writeFileSync(
    join(proj, "src", "config.ts"),
    `// konfiguracja\nexport const OPENROUTER_API_KEY = "${FAKE_KEY}";\nexport const port = 47_777;\n`,
  );
  const long = ["export function huge(): number {", "  let x = 0;"];
  for (let i = 0; i < 700; i++) long.push(`  x += ${i};`);
  long.push("  return x;", "}", "");
  writeFileSync(join(proj, "src", "huge.ts"), long.join("\n"));
  writeFileSync(join(proj, ".env"), `OPENROUTER_API_KEY=${FAKE_KEY}\n`);
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ env: { OPENROUTER_API_KEY: FAKE_KEY } }));
  writeFileSync(join(proj, ".hidden", "x.ts"), "export const KEY_HIDDEN = 1;\n");
  writeFileSync(join(proj, "secrets.ts"), `export const KEY_SECRET = "${FAKE_KEY}";\n`);
  writeFileSync(join(proj, "credentials.ts"), "export const KEY_CRED = 1;\n");
  // sejfy w konwencjach Arduino, Django i JS (zablokowane po nazwie) i katalogi secrets.d, secrets.local
  writeFileSync(join(proj, "src", "secrets.h"), `#define SECRET_SSID "MyHomeNet"\n#define SECRET_PASS "${FAKE_PASS}"\n`);
  writeFileSync(join(proj, "src", "secrets.py"), `SECRET_KEY = "${FAKE_PASS}"\n`);
  writeFileSync(
    join(proj, "src", "secrets.js"),
    `export const SECRET_KEY = "${FAKE_PASS}";\nexport function load() {\n  return 1;\n}\n`,
  );
  for (const d of ["secrets.d", "secrets.local"]) {
    mkdirSync(join(proj, d), { recursive: true });
    writeFileSync(join(proj, d, "db.ts"), `export const KEY_IN_${d.slice(8).toUpperCase()} = "${FAKE_PASS}";\n`);
  }
  // magazyn z rolą store (zablokowany mimo roli: wartość bez nazwy sekretu, clean() jej nie zna)
  writeFileSync(join(proj, "src", "credentials.store.ts"), `export const wifiStore = "${FAKE_PASS}";\n`);
  // nazwa z sekretem w środku i moduł z rolą (service, d.ts): zwykły kod, wartości maskuje clean()
  writeFileSync(join(proj, "src", "arduino_secrets.h"), `#define SECRET_PASS "${FAKE_PASS}"\nvoid connect_wifi(void) {\n}\n`);
  writeFileSync(
    join(proj, "src", "secrets.service.ts"),
    `export class SecretsService {\n  static SECRET_KEY = "${FAKE_PASS}";\n  signingKey = "${FAKE_PASS}";\n}\n`,
  );
  writeFileSync(join(proj, "src", "CredentialsForm.tsx"), "export function CredentialsForm() {\n  return null;\n}\n");
  writeFileSync(join(proj, "src", "credentials-store.ts"), "export function loadStore() {\n  return [];\n}\n");
  writeFileSync(join(proj, DEEP), "def deep_module():\n    return 1\n");
  // przypisania złamane przez formatter: klucz w jednej linii, wartość w następnej
  const db = [
    "// konfiguracja bazy",
    "export const DATABASE_PASSWORD =",
    `  "${FAKE_PASS}";`,
    "export const cfg = {",
    "  password:",
    `    "${FAKE_PASS}",`,
    "};",
    "export const messages = {",
    "  password:",
    '    "Hasło musi mieć co najmniej 8 znaków",',
    "};",
  ];
  writeFileSync(join(proj, "src", "db.ts"), `${db.join("\n")}\n`);
  const settings = [
    "DATABASE_PASSWORD = (",
    `    "${FAKE_PASS}"`,
    ")",
    "",
    "",
    "def connect(token):",
    "    if token:",
    '        headers["Authorization"] = f"Bearer {token}"',
    "    return headers",
  ];
  writeFileSync(join(proj, "src", "settings.py"), `${settings.join("\n")}\n`);
  // piąta recenzja PR #8: złamane przypisania, które maskował main, pod szerszym kluczem, za uciętym PEM i w linii
  writeFileSync(
    join(proj, "docs", "deploy.md"),
    `# Wdrożenie\n\n## Konfiguracja R5\n\n\`\`\`yaml\ncredentials:\n  "token":\n    "${R5[0]}"\n\`\`\`\n\n## Dalej\n`,
  );
  writeFileSync(
    join(proj, "src", "cfg_r5.py"),
    [
      "def make_r5():",
      "    return {",
      '        "session_key":',
      '            "x password":',
      `            "${R5[1]}"`,
      "    }",
      "",
      "def same_line_r5():",
      "    return {",
      "        session_key:",
      `            "the password": "${R5[1]}"`,
      "    }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(proj, "src", "pem_r5.ts"),
    `export function pemR5() {\n  return \`${["-----BEGIN RSA ", "PRIVATE KEY-----"].join("")}\nMIIEowIBAAKCAQEAwordpassword\n= "${R5[2]}"\`;\n}\n`,
  );
  writeFileSync(join(proj, "notes.txt"), `KEY w zwykłym tekście ${FAKE_KEY}\n`);
  writeFileSync(join(outside, "leak.ts"), `export const KEY_OUTSIDE = "${FAKE_KEY}";\n`);
  try {
    // junction (Windows) albo symlink (POSIX) z projektu na zewnątrz
    symlinkSync(outside, join(proj, "link"), "junction");
    return true;
  } catch {
    return false;
  }
}
const linked = setup();

/** Krótkie nazwy 8.3 z `dir /x` (Windows z włączonym 8.3, zwykle dysk systemowy): nazwa długa -> krótka. */
function shortNames(dir: string): Map<string, string> {
  const names = new Map<string, string>();
  if (process.platform !== "win32") return names;
  const out = Bun.spawnSync(["cmd", "/d", "/c", "dir", "/x", "/a", dir]).stdout.toString();
  for (const l of out.split(/\r?\n/)) {
    const m = l.match(/\s(\S+~\d+(?:\.\S+)?)\s+(\S.*)$/);
    if (m) names.set(m[2].trim(), m[1]);
  }
  return names;
}
const short = shortNames(proj);

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {}
});

/** Numery i treść linii z wyniku smart_unfold. */
function body(out: string): { n: number; text: string }[] {
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)│ (.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ n: Number(m[1]), text: m[2] }));
}

const unfold = (file: string, sym: string) => smartUnfold(file, sym, proj);
const lastLine = (out: string) => body(out).at(-1)?.text ?? "";

describe("smart_unfold: TypeScript", () => {
  test("parametr z wieloliniowym typem obiektowym i typ zwracany w klamrach", () => {
    const u = unfold("src/sample.ts", "promptContext");
    expect(u).toContain("/** Wieloliniowy parametr");
    expect(u).toContain("return { text: args.project, ids };");
    expect(lastLine(u)).toBe("}");
    expect(u).not.toContain("ftsSearch");
  });

  test("= {} w parametrach i Promise<{ ... }> w typie zwracanym", () => {
    const f = unfold("src/sample.ts", "ftsSearch");
    expect(f).toContain("return out.concat(String(repo.id));");
    expect(lastLine(f)).toBe("}");
    const l = unfold("src/sample.ts", "load");
    expect(l).toContain("return { a };");
    expect(l).not.toContain("handler");
  });

  test("funkcja strzałkowa w const: z klamrami i bez", () => {
    const h = unfold("src/sample.ts", "handler");
    expect(h).toContain("return { status: body ? 200 : 400 };");
    expect(lastLine(h)).toBe("};");
    const d = unfold("src/sample.ts", "double");
    expect(lastLine(d)).toBe("  n * 2;");
    expect(d).not.toContain("css");
  });

  test("szablon z } w wielu liniach", () => {
    const c = unfold("src/sample.ts", "css");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: to treść pliku źródłowego fixture, nie szablon
    expect(c).toContain("color: ${color};");
    const lines = body(c);
    expect(lines.at(-2)?.text).toBe("`;");
    expect(lines.at(-1)?.text).toBe("}");
    expect(c).not.toContain("unquote");
  });

  test("regex z cudzysłowami", () => {
    const u = unfold("src/sample.ts", "unquote");
    expect(u).toContain("return s.slice(1, -1);");
    expect(u).toContain("  return s;");
    expect(lastLine(u)).toBe("}");
    expect(u).not.toContain("lastOne");
  });

  test("B.render to metoda B, nie A; brak metody to komunikat, nie cudza metoda", () => {
    const b = unfold("src/sample.ts", "B.render");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: to treść pliku źródłowego fixture, nie szablon
    expect(b).toContain("return `B${this.x}`;");
    expect(b).not.toContain('return "A"');
    expect(unfold("src/sample.ts", "A.render")).toContain('return "A";');
    const miss = unfold("src/sample.ts", "B.missing");
    expect(miss).toContain('Nie znaleziono "missing" w B');
    expect(miss).not.toContain("│");
    expect(unfold("src/sample.ts", "C.render")).toContain('Nie znaleziono "C"');
  });

  test("ta sama nazwa w kilku klasach: podpowiedź Klasa.metoda", () => {
    expect(unfold("src/sample.ts", "render")).toContain("zawęź przez Klasa.render");
  });

  test("limit linii kończy się jawnym znacznikiem z prawdziwym końcem", () => {
    const u = unfold("src/huge.ts", "huge");
    expect(body(u)).toHaveLength(600);
    expect(u).toContain("pominięto 104 linii");
    expect(u).toContain("kończy się w L704");
    expect(u.split("\n")[0]).toContain("L1-704");
  });
});

describe("smart_unfold: Python, Markdown i inne języki", () => {
  test("Python: sygnatura w stylu Black i docstring z linią przy lewej krawędzi", () => {
    const g = unfold("src/sample.py", "grow");
    expect(g).toContain("Zwraca nowy rozmiar.");
    expect(lastLine(g)).toBe("        return self.size");
    expect(g).not.toContain("def shrink");
    expect(unfold("src/sample.py", "Pool.shrink")).toContain("self.size = 0");
    const h = unfold("src/sample.py", "helper");
    expect(lastLine(h)).toBe("    return a + 1");
    expect(smartOutline("src/sample.py", proj)).not.toContain("fake");
  });

  test("Markdown: # w bloku kodu nie kończy sekcji", () => {
    const s = unfold("docs/sample.md", "Instalacja");
    expect(s).toContain("Po instalacji uruchom testy.");
    expect(s).toContain("### Szczegóły");
    expect(s).not.toContain("## Prywatne");
    expect(smartOutline("docs/sample.md", proj)).not.toContain("komentarz w bloku kodu");
  });

  test("<private> na kilka linii: maskowane linia po linii, numeracja zostaje", () => {
    const p = body(unfold("docs/sample.md", "Prywatne"));
    expect(p.map((l) => l.text).join("\n")).not.toContain("hasło do serwera");
    expect(p.find((l) => l.text === "Dalej jawnie.")?.n).toBe(25);
    expect(p.filter((l) => l.text === "[prywatne]")).toHaveLength(4);
  });

  test("Go: metoda po odbiorcy, struct{} w typie zwracanym, surowy łańcuch z }", () => {
    const g = unfold("src/pool.go", "Pool.Grow");
    expect(g).toContain("return map[string]struct{}{s: {}}");
    expect(lastLine(g)).toBe("}");
    expect(g).not.toContain("helper");
  });

  test("Rust: lifetime, r#\"}\"# i '}' w metodzie z bloku impl", () => {
    const r = unfold("src/pool.rs", "Pool.grow");
    expect(r).toContain("self.name");
    expect(lastLine(r)).toBe("    }");
    expect(r).not.toContain("fn after");
  });

  test('C#: @"""..."" wieloliniowy i #if/#else z dwiema sygnaturami', () => {
    const m = unfold("src/Shader.cs", "Make");
    expect(lastLine(m)).toBe("    }");
    expect(m).not.toContain("Other");
    const o = unfold("src/Shader.cs", "Other");
    expect(o).toContain('Make("x");');
    expect(o).not.toContain("Last");
  });

  test("PowerShell: here-string i komentarz z }", () => {
    const p = unfold("src/tools.ps1", "Get-Thing");
    expect(p).toContain("return $text");
    expect(lastLine(p)).toBe("}");
    expect(p).not.toContain("After");
  });

  test("Kotlin: metoda interfejsu bez ciała (typ z ?) i data class bez ciała", () => {
    const g = unfold("src/Store.kt", "Store.get");
    expect(body(g)).toHaveLength(1);
    const i = unfold("src/Store.kt", "Item");
    expect(lastLine(i)).toBe(")");
    expect(i).not.toContain("After");
  });

  test("C++: lista inicjalizacyjna nie daje symboli, konstruktor z ':' na końcu linii jest w zarysie", () => {
    const o = smartOutline("src/widget.cpp", proj);
    for (const fake of ["impl_", "compute", "size_"]) expect([fake, o.includes(fake)]).toEqual([fake, false]);
    expect(o).toContain("L11 Widget::Widget(int a, int b)");
    expect(o).toContain("L19 Widget::Widget() :");
    expect(o).toContain("L25 Panel::Panel(Widget w)");
    const p = unfold("src/widget.cpp", "Panel::Panel");
    expect(body(p).map((l) => l.n)).toEqual([25, 26, 27, 28]);
  });

  test("C++: wieloliniowe makro z } w kolumnie 0 i surowy łańcuch z # i { w środku", () => {
    // makro: linie przeniesione przez \ należą do #define, jego } nie zamyka funkcji
    const s = unfold("src/widget.cpp", "Widget::swap");
    expect(s).toContain("LOCAL_SWAP(b_);");
    expect(body(s).at(-1)).toEqual({ n: 36, text: "}" });
    // surowy łańcuch R"glsl(...)glsl" (działał już wcześniej, test pilnuje regresji)
    const r = unfold("src/widget.cpp", "shader");
    expect(body(r).at(-1)).toEqual({ n: 44, text: "}" });
    expect(r).not.toContain("after");
    expect(smartOutline("src/widget.cpp", proj)).not.toContain("fake_main");
  });

  test("#if/#elif/#else: wszystkie gałęzie w zarysie, ta sama funkcja raz, wspólne ciało za #endif", () => {
    const o = smartOutline("src/platform.c", proj);
    for (const f of ["win_only", "mac_only", "posix_only", "checksum(", "checksum_slow(", "after("])
      expect([f, o.includes(f)]).toEqual([f, true]);
    expect(o.match(/open_file/g)).toHaveLength(1);
    const p = unfold("src/platform.c", "posix_only");
    expect(p).toContain("return 3;");
    expect(body(p).at(-1)).toEqual({ n: 30, text: "}" });
    expect(unfold("src/platform.c", "mac_only")).toContain("return 2;");
    const slow = unfold("src/platform.c", "checksum_slow");
    expect(slow).toContain("return s;");
    expect(body(slow).at(-1)).toEqual({ n: 43, text: "}" });
    expect(smartSearch("posix_only", {}, proj)).toContain("src/platform.c:25 [function]");
  });

  test("PHP: heredoc i nowdoc (function, /* i klamry w treści), # jako komentarz", () => {
    const o = smartOutline("src/render.php", proj);
    expect(o).not.toContain("hello");
    for (const f of ["function render", "class Page", "function title", "function after"]) expect(o).toContain(f);
    const r = unfold("src/render.php", "render");
    expect(r).toContain("return $html . $sql;");
    expect(body(r).at(-1)).toEqual({ n: 13, text: "}" });
    expect(unfold("src/render.php", "Page.title")).toContain('return "x";');
  });

  test("Kotlin: cudzysłowy we wstawce szablonu (też /* i nawiasy), szablon w surowym łańcuchu", () => {
    const o = smartOutline("src/Shop.kt", proj);
    for (const f of ["class Shop", "fun greet", "fun after", "fun top"]) expect([f, o.includes(f)]).toEqual([f, true]);
    const g = unfold("src/Shop.kt", "Shop.greet");
    expect(g).toContain("joinToString");
    expect(body(g).map((l) => l.n)).toEqual([8, 9, 10]);
    expect(lastLine(unfold("src/Shop.kt", "Shop"))).toBe("}");
  });

  test("C++: nagłówek klasy z makrem i alignas to nie lista inicjalizacyjna; nazwa klasy za makrem eksportu", () => {
    // konstruktor za nagłówkiem z makrem był gubiony (": public" po ")" brany za listę inicjalizacyjną)
    const o = smartOutline("src/classhead.hpp", proj);
    expect(o).toMatch(/^L7\s+explicit Widget\(QObject \*parent\)$/m);
    expect(o).toMatch(/^L11\s+void show\(\) \{$/m);
    // lista po template <class T> to nie funkcja (second(make(b)) {)
    expect(o).not.toMatch(/^L2[23] /m);
    // nazwy: alignas, makro eksportu i "class" z "enum class" to nie nazwy
    for (const [name, line, kind] of [
      ["Vec", 1, "struct"],
      ["Thing", 15, "class"],
      ["Color", 19, "enum"],
    ] as const)
      expect(smartSearch(name, {}, proj)).toContain(`src/classhead.hpp:${line} [${kind}]`);
    for (const fake of ["alignas", "Q_CORE_EXPORT"])
      expect(smartSearch(fake, {}, proj)).not.toMatch(/classhead\.hpp:(?:1 \[struct\]|15 \[class\])/);
    expect(body(unfold("src/classhead.hpp", "show")).at(-1)).toEqual({ n: 13, text: "    }" });
    expect(unfold("src/classhead.hpp", "Thing")).toContain("void run()");
  });

  test("złośliwe wejścia: tysiące grup #if, głębokie zagnieżdżenie, bardzo długa linia", () => {
    // lepszy z dwóch pomiarów: pojedyncza pauza GC albo obciążona maszyna nie udaje regresji (kwadratowe cofanie to
    // sekundy i minuty, nie kilkadziesiąt procent)
    const time = (f: () => unknown) => {
      let min = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 2; r++) {
        const t0 = performance.now();
        f();
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    // #else bez #endif dalej w pliku (1,8 MB): koniec szukany raz, nie przy każdej dyrektywie (było 26 s)
    const noEndif = `#if A\nvoid f(void) {}\n${"#else\n".repeat(300_000)}`;
    expect(time(() => outlineText(noEndif, "c", "c"))).toBeLessThan(1000);
    const flat: string[] = [];
    for (let i = 0; i < 20_000; i++)
      flat.push(`#if A${i}`, `void f${i}(void) {`, "}", "#else", `void g${i}(void) {`, "}", "#endif");
    const flatSrc = flat.join("\n");
    let syms = 0;
    expect(time(() => (syms = outlineText(flatSrc, "c", "c").length))).toBeLessThan(500);
    expect(syms).toBe(40_000); // obie gałęzie każdej grupy
    expect(time(() => rangesOf(flatSrc, "c", "c"))).toBeLessThan(500);
    const nested: string[] = [];
    for (let i = 0; i < 800; i++) nested.push(`#if A${i}`, `void f${i}(void) {`, "  x();", "}", "#else");
    nested.push("void last(void) {}");
    for (let i = 0; i < 800; i++) nested.push("#endif");
    const nestedSrc = nested.join("\n");
    expect(time(() => outlineText(nestedSrc, "c", "c"))).toBeLessThan(100);
    expect(time(() => rangesOf(nestedSrc, "c", "c"))).toBeLessThan(100);
    const spaces = " ".repeat(100_000);
    for (const [lang, dialect, line] of [
      ["c", "cpp", `f(a): ${spaces}=`],
      ["c", "kt", `fun f(a): ${spaces}=`],
      ["ts", "ts", `function f(a)${spaces}: x {`],
      ["ts", "ts", `type T${spaces}<`],
      ["md", "md", `#${spaces}x${spaces}#`],
      ["py", "py", `def f(${spaces}`],
    ] as const)
      expect([lang, line.slice(0, 12), time(() => outlineText(line, lang, dialect)) < 50]).toEqual([
        lang,
        line.slice(0, 12),
        true,
      ]);
  });

  test("rangesOf: jednolinijkowiec kończy się w swojej linii", () => {
    const r = rangesOf("export function a() { return 1; }\nexport function b() {\n  return 2;\n}\n", "ts");
    expect(r.syms.map((s) => [s.name, r.end(s)])).toEqual([
      ["a", 0],
      ["b", 3],
    ]);
  });
});

describe("granice projektu", () => {
  test("ucieczki: ../, ścieżka bezwzględna, plik i katalog ukryty, nazwa sekretu", () => {
    expect(smartOutline("../outside/leak.ts", proj)).toStartWith("Odmowa");
    expect(smartOutline(join(outside, "leak.ts"), proj)).toStartWith("Odmowa");
    expect(smartUnfold("src/../../outside/leak.ts", "KEY_OUTSIDE", proj)).toStartWith("Odmowa");
    expect(smartUnfold(".github/../../outside/leak.ts", "KEY_OUTSIDE", proj)).toStartWith("Odmowa");
    expect(smartOutline(".env", proj)).toStartWith("Odmowa");
    expect(smartOutline(".hidden/x.ts", proj)).toStartWith("Odmowa");
    expect(smartOutline(".git/config", proj)).toStartWith("Odmowa");
    expect(smartOutline(".claude/.credentials.json", proj)).toStartWith("Odmowa");
    // .claude czytany, ale settings.json to nie kod: treść nie jest otwierana
    expect(smartOutline(".claude/settings.json", proj)).not.toContain(FAKE_KEY);
    expect(smartSearch("KEY", { path: "../outside", filePattern: "*" }, proj)).toStartWith("Odmowa");
    expect(smartSearch("KEY", { path: outside }, proj)).toStartWith("Odmowa");
    expect(smartSearch("KEY", { path: ".hidden" }, proj)).toStartWith("Odmowa");
  });

  test.skipIf(process.platform !== "win32")("Windows: UNC i inny dysk", () => {
    expect(smartOutline("\\\\localhost\\c$\\Windows\\win.ini", proj)).toStartWith("Odmowa");
    const other = proj.toUpperCase().startsWith("X:") ? "Y:\\x.ts" : "X:\\x.ts";
    expect(smartOutline(other, proj)).toStartWith("Odmowa");
  });

  test.skipIf(!short.has(".hidden"))("Windows: krótka nazwa 8.3 nie omija odmowy (HIDDEN~1 to .hidden)", () => {
    expect(smartOutline(`${short.get(".hidden")}/x.ts`, proj)).toStartWith("Odmowa");
    const cred = short.get("credentials.json");
    if (cred) expect(smartOutline(cred, proj)).toStartWith("Odmowa");
  });

  test.skipIf(!linked)("dowiązanie (junction/symlink) prowadzące poza projekt", () => {
    expect(smartOutline("link/leak.ts", proj)).toStartWith("Odmowa");
    expect(smartSearch("KEY", { path: "link" }, proj)).toStartWith("Odmowa");
    expect(smartSearch("KEY_OUTSIDE", {}, proj)).not.toContain("leak.ts");
  });

  test("file_pattern nie otwiera plików ukrytych, sekretów ani nie-kodu", () => {
    const s = smartSearch("KEY", { filePattern: "*" }, proj);
    expect(s).toContain("OPENROUTER_API_KEY");
    expect(s).not.toContain(FAKE_KEY);
    const hidden = [".env", "settings.json", ".credentials", "credentials.json", "secrets.yaml", "notes.txt", ".hidden"];
    for (const f of [...hidden, "KEY_HIDDEN", "leak.ts"]) expect(s).not.toContain(f);
    expect(smartSearch("KEY", { filePattern: "*.json" }, proj)).toContain("Brak trafień");
  });

  test("sekrety po nazwie: secrets.<ext> i credentials.<ext> (też kod) zablokowane, tak samo katalogi", () => {
    const blocked = [
      "credentials",
      "credentials.json",
      "credentials.local.json",
      "credentials.ts",
      "secrets.ts",
      "src/secrets.h",
      "src/secrets.py",
      "src/secrets.js",
      "config/secrets.yaml",
      "secrets.prod.toml",
      "secrets.md",
      "secrets.d/db.ts",
      "secrets.local/db.ts",
      // role, które zwykle trzymają wartości (atrapy, dane testowe), nie mają wyjątku modułu z rolą
      "src/secrets.mock.ts",
      "src/secrets.test.js",
      "src/credentials.store.ts",
      "src/secrets.spec.ts",
      "src/credentials.model.ts",
      "prod.env",
      "id_rsa",
      "id_ed25519.pub",
      "certs/server.key",
      "secrets/db.ts",
    ];
    for (const f of blocked) expect([f, smartOutline(f, proj).startsWith("Odmowa")]).toEqual([f, true]);
    expect(smartUnfold("src/secrets.js", "load", proj)).toStartWith("Odmowa");
    for (const p of ["secrets.d", "secrets.local"]) expect(smartSearch("KEY", { path: p }, proj)).toStartWith("Odmowa");
    // przeszukanie całego projektu ich nie otwiera
    const s = smartSearch("KEY", { filePattern: "*" }, proj);
    for (const name of ["KEY_SECRET", "KEY_CRED", "KEY_IN_D", "KEY_IN_LOCAL", "secrets.h", "secrets.py", "secrets.js"])
      expect([name, s.includes(name)]).toEqual([name, false]);
    expect(s).not.toContain(FAKE_KEY);
    expect(smartSearch("SECRET_PASS", {}, proj)).not.toContain("src/secrets.h");
    const store = smartSearch("wifiStore", {}, proj);
    expect(store).not.toContain("credentials.store.ts");
    expect(store).not.toContain(FAKE_PASS);
  });

  test("sekrety po nazwie: moduły z rolą i nazwy z sekretem w środku dostępne, wartości maskuje clean()", () => {
    const svc = smartUnfold("src/credentials.service.ts", "CredentialsService", proj);
    expect(svc).toContain("apiKey =");
    expect(svc).not.toContain(FAKE_KEY);
    const sec = smartUnfold("src/secrets.service.ts", "SecretsService", proj);
    expect(sec).toContain("SECRET_KEY =");
    expect(sec).toContain("signingKey =");
    expect(sec).not.toContain(FAKE_PASS);
    const ard = smartOutline("src/arduino_secrets.h", proj);
    expect(ard).toContain("connect_wifi");
    expect(smartSearch("SECRET_PASS", {}, proj)).not.toContain(FAKE_PASS);
    expect(smartSearch("connect_wifi", {}, proj)).toContain("src/arduino_secrets.h:2 [function]");
    for (const f of ["src/arduino_secrets.h", "src/secrets.service.ts", "src/credentials.service.ts"])
      expect([f, smartSearch(FAKE_PASS.slice(0, 12), { path: "src" }, proj).includes(f)]).toEqual([f, false]);
  });

  test("katalogi z kropką: .github, .gitea i .claude czytane, .claude/worktrees i reszta ukrytych nie", () => {
    expect(smartOutline(".github/scripts/release.ts", proj)).toContain("L1 export function publishRelease()");
    expect(smartUnfold(".gitea/actions/check.ps1", "Invoke-GiteaCheck", proj)).toContain("return 1");
    expect(smartOutline(".claude/agents/reviewer.md", proj)).toContain("Recenzent");
    const s = smartSearch("publishRelease", {}, proj);
    expect(s).toContain(".github/scripts/release.ts:1 [function]");
    expect(s).not.toContain("worktrees");
    expect(smartSearch("GiteaCheck", {}, proj)).toContain(".gitea/actions/check.ps1:1 [function]");
    expect(smartSearch("Recenzent", { path: ".claude" }, proj)).toContain("agents/reviewer.md:1");
    const hidden = smartSearch("KEY_HIDDEN", {}, proj);
    expect(hidden).not.toContain(".hidden");
    expect(hidden).not.toContain("KEY_HIDDEN =");
  });

  test("katalog konfiguracji Claude Code w projekcie: odmowa; projekt w jego środku czytany normalnie", () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = join(proj, ".claude");
      expect(smartOutline(".claude/agents/reviewer.md", proj)).toContain("katalog konfiguracji Claude Code");
      expect(smartSearch("Recenzent", {}, proj)).toContain("Brak trafień");
      expect(smartSearch("publishRelease", {}, proj)).toContain(".github/scripts/release.ts:1");
      process.env.CLAUDE_CONFIG_DIR = cfgDir;
      const skill = join(cfgDir, "skills", "s1");
      expect(smartOutline("SKILL.md", skill)).toContain("Skill");
      expect(smartSearch("Skill", {}, skill)).toContain("SKILL.md:1");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  test("~/.claude zakryty także wtedy, gdy CLAUDE_CONFIG_DIR wskazuje gdzie indziej (korzeń = katalog domowy)", () => {
    // sztuczny katalog domowy: os.homedir() czyta USERPROFILE (Windows) albo HOME przy każdym wywołaniu
    const home = join(base, "home");
    const otherCfg = join(base, "othercfg");
    mkdirSync(join(home, ".claude", "projects", "p", "memory"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "s", "scripts"), { recursive: true });
    mkdirSync(join(home, "src"), { recursive: true });
    mkdirSync(join(home, ".git"), { recursive: true }); // korzeń = home (dotfiles w git), nie przodek z repo
    mkdirSync(otherCfg, { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "p", "memory", "MEMORY.md"), "# Pamięć\n\nPIN do bramy 4711.\n");
    writeFileSync(join(home, ".claude", "skills", "s", "scripts", "run.py"), 'def run_skill():\n    return "ok"\n');
    writeFileSync(join(home, "src", "app.ts"), "export function homeApp() {\n  return 1;\n}\n");
    const keys = ["USERPROFILE", "HOME", "CLAUDE_CONFIG_DIR"] as const;
    const before = keys.map((k) => process.env[k]);
    try {
      process.env.USERPROFILE = home;
      process.env.HOME = home;
      for (const cfg of [otherCfg, join(home, ".claude")]) {
        process.env.CLAUDE_CONFIG_DIR = cfg;
        const label = cfg === otherCfg ? "othercfg" : "~/.claude";
        expect([label, smartOutline(".claude/projects/p/memory/MEMORY.md", home)]).toEqual([
          label,
          expect.stringContaining("katalog konfiguracji Claude Code"),
        ]);
        expect([label, smartSearch("PIN do bramy", {}, home)]).toEqual([label, expect.stringContaining("Brak trafień")]);
        expect([label, smartSearch("run_skill", {}, home)]).toEqual([label, expect.stringContaining("Brak trafień")]);
        expect([label, smartSearch("x", { path: ".claude" }, home)]).toEqual([label, expect.stringMatching(/^Odmowa/)]);
        expect([label, smartSearch("homeApp", {}, home)]).toEqual([label, expect.stringContaining("src/app.ts:1")]);
      }
    } finally {
      keys.forEach((k, i) => {
        if (before[i] === undefined) delete process.env[k];
        else process.env[k] = before[i];
      });
    }
  });

  test("credentials: zwykły kod z tym słowem dostępny", () => {
    expect(smartOutline("src/CredentialsForm.tsx", proj)).toContain("L1 export function CredentialsForm()");
    expect(smartUnfold("src/credentials-store.ts", "loadStore", proj)).toContain("return [];");
    const s = smartSearch("store", {}, proj);
    expect(s).toContain("src/credentials-store.ts:1 [function]");
    expect(smartSearch("CredentialsForm", {}, proj)).toContain("src/CredentialsForm.tsx:1 [function]");
  });

  test("file_pattern: powtórzone **/ bez wykładniczego cofania, znaczenie wzorców bez zmian", () => {
    const many = `${"**/".repeat(12)}*.ts`;
    // samo dopasowanie (długa ścieżka, która nie pasuje, nic do czytania): stare wyrażenie liczyło tu minutami
    const t0 = performance.now();
    expect(smartSearch("deep", { path: "src/deep", filePattern: many }, proj)).toContain("Brak trafień");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(smartSearch("double", { filePattern: many }, proj)).toContain("sample.ts:35");
    const hits = (pattern: string) => smartSearch("double", { filePattern: pattern }, proj).includes("sample.ts:35");
    for (const p of ["*.ts", "**/*.ts", "src/**/*.ts", "src/*.ts", "./src/*.ts", "src/*.{py,ts}", "*.TS", "SRC/*.ts"])
      expect([p, hits(p)]).toEqual([p, true]);
    for (const p of ["*.py", "docs/**/*.ts", "*.tsx", "sample", "src/deep/**/*.ts"]) expect([p, hits(p)]).toEqual([p, false]);
    expect(smartSearch("deep_module", { filePattern: "src/deep/**/*.py" }, proj)).toContain(`${DEEP}:1 [function]`);
  });

  test("cwd w podkatalogu: korzeniem jest repo git, nie cwd", () => {
    expect(smartOutline("../docs/sample.md", join(proj, "src"))).toContain("Instalacja");
    expect(smartOutline("../../outside/leak.ts", join(proj, "src"))).toStartWith("Odmowa");
  });
});

describe("redakcja wyników", () => {
  test("sekret w kodzie jest maskowany w smart_search, smart_outline i smart_unfold", () => {
    const s = smartSearch("OPENROUTER_API_KEY", {}, proj);
    expect(s).toContain("src/config.ts:2");
    expect(s).toContain("[REDACTED");
    expect(s).not.toContain(FAKE_KEY);
    const o = smartOutline("src/config.ts", proj);
    expect(o).toContain("OPENROUTER_API_KEY");
    expect(o).not.toContain(FAKE_KEY);
    const u = unfold("src/config.ts", "OPENROUTER_API_KEY");
    expect(u).toContain("[REDACTED");
    expect(u).not.toContain(FAKE_KEY);
  });

  test("szukanie samego sekretu nic nie zwraca (bez wyroczni)", () => {
    expect(smartSearch(FAKE_KEY.slice(0, 30), {}, proj)).toContain("Brak trafień");
  });

  test("przypisanie złamane przez formatter: wartość w następnej linii maskowana, numeracja bez zmian", () => {
    const line = (out: string, n: number) => body(out).find((l) => l.n === n)?.text;
    const pass = unfold("src/db.ts", "DATABASE_PASSWORD");
    expect(pass).not.toContain(FAKE_PASS);
    expect(line(pass, 2)).toBe("export const DATABASE_PASSWORD =");
    expect(line(pass, 3)).toBe('  "[REDACTED]";');
    const cfg = unfold("src/db.ts", "cfg");
    expect(cfg).not.toContain(FAKE_PASS);
    expect(body(cfg).map((l) => l.n)).toEqual([4, 5, 6, 7]);
    expect(line(cfg, 6)).toBe('    "[REDACTED]",');
    // zwykły tekst pod kluczem password zostaje (ta sama decyzja co clean() dla jednej linii)
    expect(unfold("src/db.ts", "messages")).toContain('"Hasło musi mieć co najmniej 8 znaków"');
    // if token: z kodem w następnej linii to nie przypisanie
    expect(unfold("src/settings.py", "connect")).toContain('headers["Authorization"] = f"Bearer {token}"');
    // bez wyroczni: prefiks hasła nie trafia w żadną linię (db.ts i Black w settings.py: = (\n "...")
    expect(smartSearch(FAKE_PASS.slice(0, 8), {}, proj)).toContain("Brak trafień");
    expect(smartSearch(FAKE_PASS.slice(0, 8), { path: "src/settings.py" }, proj)).toContain("Brak trafień");
  });

  test("złamane przypisania maskowane przez main zostają zamaskowane (szerszy klucz, ucięty PEM, maska w linii)", () => {
    for (const v of R5) expect([v, smartSearch(v.slice(0, 9), {}, proj)]).toEqual([v, expect.stringContaining("Brak trafień")]);
    const md = unfold("docs/deploy.md", "Konfiguracja R5");
    expect(md).toContain('    "[REDACTED]"');
    expect(md).not.toContain(R5[0]);
    for (const sym of ["make_r5", "same_line_r5"]) expect(unfold("src/cfg_r5.py", sym)).not.toContain(R5[1]);
    const pem = unfold("src/pem_r5.ts", "pemR5");
    expect(body(pem).map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
    expect(pem).toContain('= "[REDACTED]"');
    expect(pem).not.toContain(R5[2]);
  });

  test("ścieżka do pojedynczego pliku w smart_search", () => {
    const s = smartSearch("double", { path: "src/sample.ts" }, proj);
    expect(s).toContain("sample.ts:35 [function]");
  });
});
