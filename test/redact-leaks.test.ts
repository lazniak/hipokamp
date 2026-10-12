// Korpus regresji wycieków clean(): sekrety (fałszywe, składane w locie z kawałków, żeby w repo nie leżał żaden
// gotowy token) w kontekstach, w których pojawiają się w transkryptach, wejściach narzędzi i plikach. Każdy przypadek,
// który maskowała wersja sprzed przepisania redact.ts (origin/main przed PR #8), jest tu testem; luki wspólne obu
// wersji są wypisane w KNOWN_GAPS (świadome kompromisy, opisane w docs/ARCHITEKTURA.md §4). Test „nadzbiór main”
// pilnuje znak po znaku, że nowa wersja maskuje co najmniej to, co maskowała tamta.
import { describe, expect, test } from "bun:test";
import { clean, redact } from "../src/capture/redact.ts";
import { maskBlocks } from "../src/mcp/code.ts";

let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (alpha: string, n: number) => Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64U = `${AN}_-`;
const HEXA = "0123456789abcdef";
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const j = (...p: string[]) => p.join("");

const S = {
  ant: j("sk-", "ant-api03-", pick(B64U, 93)),
  oai: j("sk-", "proj-", pick(B64U, 48)),
  oaiOld: j("sk-", pick(AN, 48)),
  or: j("sk-", "or-v1-", pick(HEXA, 64)),
  ghp: j("gh", "p_", pick(AN, 36)),
  gho: j("gh", "o_", pick(AN, 36)),
  ghpat: j("github", "_pat_", pick(AN, 22), "_", pick(AN, 59)),
  glpat: j("gl", "pat-", pick(B64U, 20)),
  xoxb: j("xo", "xb-", pick("0123456789", 12), "-", pick("0123456789", 13), "-", pick(AN, 24)),
  akia: j("AK", "IA", pick(UP, 16)),
  aiza: j("AI", "za", pick(B64U, 35)),
  hf: j("h", "f_", pick(AN, 34)),
  npm: j("np", "m_", pick(AN, 36)),
  pypi: j("py", "pi-", "AgEIcHlwaS5vcmc", pick(B64U, 60)),
  sg: j("S", "G.", pick(B64U, 22), ".", pick(B64U, 43)),
  stripe: j("sk", "_live_", pick(AN, 24)),
  eleven: j("s", "k_", pick(HEXA, 48)),
  jwt: j("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ", ".", pick(B64U, 43)),
  opaque: pick(AN, 40),
  pw: j("Xk9", "mQ2vL8", "Zp"),
  pwAmp: j("x7", "&Kq9#", "mP2wZ"),
  pwAmp2: j("Abc12", "&xyz7", "89Q"),
  pwSpace: j("Zielony ", "Kot ", "Skacze 2024"),
  pwParen: j("Wiosna", "(2024)", "!x"),
  pwBracket: j("Lato", "[2026]", "pl"),
  pwDots: j("correct", ".horse", ".battery", ".staple"),
  pwEnv: j("env", "-Xk92", "!mQq"),
  pwApp: j("app", ".Xk9m", "Q2vL8"),
  pwHash: j("Zq8", "#real", "!Pw77"),
  pwAt: j("KoTeK7", "@2!xy"),
  b64: j("dXNlcj", "pwYXNzd29yZA", "=="),
};

interface Case {
  cat: string;
  text: string;
  secret: string;
}
const C: Case[] = [];
const add = (cat: string, secret: string, ...texts: string[]) => {
  for (const text of texts) C.push({ cat, text, secret });
};

// 1. tokeny dostawców
const ctx = (v: string) => [
  v,
  `klucz ${v} w tekście`,
  `"${v}"`,
  `'${v}'`,
  `{"key":"${v}"}`,
  `https://api.example.com/v1?key=${v}&x=1`,
  `x-${v}`,
  `=${v}`,
  `(${v})`,
  `\`${v}\``,
  `- ${v}`,
  `curl -H "Authorization: Bearer ${v}" https://x`,
  `export X=${v}`,
];
const TOKENS = [
  "ant",
  "oai",
  "oaiOld",
  "or",
  "ghp",
  "gho",
  "ghpat",
  "glpat",
  "xoxb",
  "akia",
  "aiza",
  "hf",
  "stripe",
  "eleven",
  "npm",
  "pypi",
  "sg",
];
for (const k of TOKENS as (keyof typeof S)[]) add(`token:${k}`, S[k], ...ctx(S[k]));

// 2. JWT (B4: także po myślniku i podkreślniku)
const jwt = S.jwt;
add(
  "jwt",
  jwt,
  `Authorization: Bearer ${jwt}`,
  `authorization:bearer ${jwt}`,
  `x-${jwt}`,
  `x-auth-token: ${jwt}`,
  `X-Amz-Security-Token-${jwt}`,
  `=${jwt}`,
  `"${jwt}"`,
  `{"access_token":"${jwt}","expires_in":3600}`,
  `{"jwt": "${jwt}"}`,
  `https://app.example.com/callback#id_token=${jwt}&state=x`,
  `https://app.example.com/reset/${jwt}`,
  `https://app.example.com/reset?t=${jwt}`,
  `Cookie: session=${jwt}; theme=dark`,
  `Set-Cookie: jwt=${jwt}; HttpOnly`,
  `token-${jwt}`,
  `Bearer-${jwt}`,
  `_${jwt}`,
  `.${jwt}`,
  `:${jwt}`,
  `\n${jwt}\n`,
  `\t${jwt}`,
  `,${jwt}`,
  `--jwt-${jwt}`,
  `kubectl --token=${jwt} get pods`,
  `CI_JOB_JWT=${jwt}`,
  `echo ${jwt} | base64 -d`,
  `\\"${jwt}\\"`,
  `idToken: ${jwt}`,
);

// 3. dane logowania w URL
const pw = S.pw;
for (const [t, s] of [
  [`https://jan:${pw}@git.example.com/repo.git`, pw],
  [`postgres://app:${pw}@db.internal:5432/prod`, pw],
  [`postgresql://app:${pw}@localhost/x`, pw],
  [`mongodb+srv://admin:${pw}@cluster0.abcde.mongodb.net/test`, pw],
  [`redis://default:${pw}@redis:6379/0`, pw],
  [`redis://:${pw}@redis:6379/0`, pw],
  [`amqp://guest:${pw}@rabbit:5672/`, pw],
  [`git+https://u:${S.ghp}@github.com/a/b.git`, S.ghp],
  [`jdbc:mysql://root:${pw}@db:3306/app`, pw],
  [`HTTPS://JAN:${pw}@HOST.PL/`, pw],
  [`DATABASE_URL="postgres://app:${pw}@db/x"`, pw],
  [`(https://jan:${pw}@host.pl)`, pw],
  [`ftp://jan:${S.pwHash}@ftp.host.pl/`, S.pwHash],
  [`smtp://jan%40firma.pl:${pw}@smtp.host.pl:587`, pw],
  [`https://jan:${S.pwAmp}@host.pl/`, S.pwAmp],
  [`a.https://jan:${pw}@host.pl/`, pw],
  [`x-https://jan:${pw}@host.pl/`, pw],
  [`sqlserver://sa:${pw}@host:1433`, pw],
  [`https://${S.ghp}:x-oauth-basic@github.com/a/b`, S.ghp],
  [`https://oauth2:${S.glpat}@gitlab.com/a/b.git`, S.glpat],
])
  add("url-cred", s, t);

// 4. pary „adres / hasło”
add(
  "login-pair",
  pw,
  `login: jan.nowak@firma.pl / ${pw}`,
  `jan@firma.pl | ${pw}`,
  `jan@firma.pl/ ${pw}`,
  `jan@firma.pl  /  ${pw}`,
  `konto: ola+test@sub.dept.firma.com.pl / ${pw} (nie zmieniać)`,
  `jan@firma.photography / ${pw}`,
  `JAN@FIRMA.PL / ${pw}`,
  `(jan@firma.pl / ${pw})`,
  `user: "jan@firma.pl / ${pw}"`,
  `jan@${"a".repeat(70)}.pl / ${pw}`,
);
add("login-pair", S.pwAt, `ola@firma.pl / ${S.pwAt}`);

// 5. PEM (W1: także ucięty, z nagłówkami szyfrowania, we wcięciu YAML, w JSON-ie)
const pemBody = Array.from({ length: 6 }, () => pick(`${AN}+/`, 64)).join("\n");
const pem = (label: string, body = pemBody, nl = "\n") =>
  `${j("-----BEGIN ", label, "-----")}${nl}${body.split("\n").join(nl)}${nl}${j("-----END ", label, "-----")}`;
const pemLine = pemBody.split("\n")[2];
for (const l of [
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
  "PRIVATE KEY",
  "DSA PRIVATE KEY",
])
  add(
    `pem:${l}`,
    pemLine,
    pem(l),
    `klucz:\n${pem(l)}\nkoniec`,
    pem(l, pemBody, "\r\n"),
    JSON.stringify({ key: pem(l) }),
    `${pem(l).split("\n").slice(0, 4).join("\n")}\n...`,
  );
add(
  "pem:PGP",
  pemLine,
  `${j("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----")}\n\n${pemBody}\n${j("-----END PGP ", "PRIVATE KEY BLOCK-----")}`,
);
add(
  "pem:truncated-encrypted",
  pemLine,
  `${j("-----BEGIN RSA ", "PRIVATE KEY-----")}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF0123456789\n\n${pemBody}\n`,
);
add("pem:yaml-indent", pemLine, `tls:\n  key: |\n    ${pem("PRIVATE KEY").split("\n").join("\n    ")}\n`);

// 6. <private>
add(
  "private",
  S.opaque,
  `a <private>${S.opaque}</private> b`,
  `a <PRIVATE>${S.opaque}</Private> b`,
  `a <private>\nlinia\n${S.opaque}\n</private> b`,
  `a <private>x<private>${S.opaque}</private>y</private> b`,
  `a <private>${S.opaque} bez końca`,
  `a <private >${S.opaque}</private> b`,
);

// 7. .env, YAML, JSON (B1: & w wartości, B3: wartości podobne do kodu)
const NAMES = [
  "PASSWORD",
  "DB_PASSWORD",
  "DB_PASS",
  "SECRET",
  "API_KEY",
  "APIKEY",
  "TOKEN",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "CLIENT_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "PRIVATE_KEY",
  "AUTH_TOKEN",
  "STRIPE_KEY",
  "SENDGRID_API_KEY",
  "WEBHOOK_SECRET",
  "JWT_SECRET",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "MASTER_KEY",
  "SMTP_PASSWORD",
  "REDIS_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "PGPASSWORD",
  "MYSQL_PWD",
  "PASSPHRASE",
  "SECRET_KEY_BASE",
  "APP_KEY",
  "WIFI_PSK",
  "MQTT_PW",
  "CREDENTIALS",
  "DB_PWD",
  "ADMIN_PASS",
];
const VALS = [
  "pw",
  "pwAmp",
  "pwAmp2",
  "pwSpace",
  "pwParen",
  "pwBracket",
  "pwDots",
  "pwEnv",
  "pwApp",
  "pwHash",
  "pwAt",
  "opaque",
  "b64",
] as const;
for (const n of NAMES)
  for (const vk of VALS) {
    const v = S[vk];
    const sp = v.includes(" ");
    const forms = [
      sp ? null : `${n}=${v}`,
      sp ? null : `export ${n}=${v}`,
      `${n}="${v}"`,
      `${n}='${v}'`,
      `export ${n}="${v}"`,
      sp ? null : `${n}: ${v}`,
      `${n}: "${v}"`,
      `"${n}": "${v}"`,
      `${n.toLowerCase()}: "${v}"`,
      sp ? null : `${n.toLowerCase()}=${v}`,
      `${n} = \`${v}\``,
      sp ? null : `docker run -e ${n}=${v} img`,
      `      - ${n}=${v}`,
      JSON.stringify({ command: `export ${n}="${v}" && ./run` }),
    ].filter((x): x is string => x !== null);
    add(`env:${vk}`, v, ...forms);
  }

// 8. przypisania w kodzie
for (const vk of VALS) {
  const v = S[vk];
  add(
    `code:${vk}`,
    v,
    `password = "${v}"`,
    `db_password='${v}'`,
    `self.password = "${v}"`,
    `conn = psycopg2.connect(host="db", password="${v}")`,
    `{'password': '${v}', 'user': 'app'}`,
    `const password = "${v}";`,
    `const apiKey = '${v}';`,
    `headers: { 'X-API-Key': '${v}' }`,
    `password := "${v}"`,
    `let password = "${v}";`,
    `const API_KEY: &str = "${v}";`,
    `let password: String = "${v}".into();`,
    `password: str = "${v}"`,
    `const apiKey: string = "${v}";`,
    `$password = "${v}";`,
    `'password' => '${v}',`,
    `:password => "${v}"`,
    `password: "${v}"`,
    `#define WIFI_PASSWORD "${v}"`,
    `#define SECRET_PASS "${v}"`,
    `const char* password = "${v}";`,
    `const string ApiKey = "${v}";`,
    `private static final String API_KEY = "${v}";`,
    `private static final String PASSWORD = "${v}";`,
    `export PASSWORD='${v}'`,
    `$env:API_KEY = "${v}"`,
    `val password: String = "${v}"`,
    `var password string = "${v}"`,
    `secret_key = "${v}"`,
    `signingKey: "${v}"`,
    `SECRET_KEY = "${v}"`,
    `STRIPE_KEY = "${v}"`,
    `MQTT_PW = "${v}"`,
    `{"content":${JSON.stringify(JSON.stringify({ password: v }))}}`,
  );
}

// 9. polski, CLI, connection stringi, zapytania URL
add("pl", pw, `hasło: ${pw}`, `Hasło: ${pw}`, `haslo=${pw}`, `hasło to ${pw}`, `Hasło do wifi: ${pw}`, `PIN ${pw}`, `kod: ${pw}`);
add(
  "cli",
  pw,
  `curl -H "x-api-key: ${pw}" https://x`,
  `curl -H 'X-Api-Key:${pw}' https://x`,
  `curl -u admin:${pw} https://x`,
  `mysql -u root -p${pw} db`,
  `mysql --password=${pw} db`,
  `psql --password ${pw}`,
  `sshpass -p ${pw} ssh host`,
  `--token ${pw}`,
  `--token=${pw}`,
  `--api-key=${pw}`,
  `--client-secret=${pw}`,
  `--passphrase ${pw}`,
  `gh auth login --with-token <<< ${pw}`,
);
add(
  "connstr",
  pw,
  `Server=db;Database=app;User Id=sa;Password=${pw};`,
  `Server=db;Database=app;User Id=sa;Pwd=${pw};`,
  `DRIVER={ODBC};SERVER=db;UID=sa;PWD=${pw};`,
  `Data Source=db;Initial Catalog=x;Password=${pw}`,
  `host=db user=app password=${pw} dbname=x`,
);
add("connstr-amp", S.pwAmp, `Server=db;Password=${S.pwAmp};`, `password=${S.pwAmp} dbname=x`, `DB_PASSWORD=${S.pwAmp}`);
add(
  "query",
  S.opaque,
  `https://x/api?api_key=${S.opaque}&page=2`,
  `https://x/api?apikey=${S.opaque}`,
  `https://x/api?access_token=${S.opaque}&x=1`,
  `https://x/api?token=${S.opaque}`,
  `https://x/api?client_secret=${S.opaque}&grant_type=x`,
  `https://x/api?password=${S.opaque}`,
  `https://x/api?sig=${S.opaque}`,
  `https://x/api?key=${S.opaque}`,
  `https://x/api?KEY=${S.opaque}`,
  `https://x/api?auth=1&token=${S.opaque}`,
);
add(
  "aws",
  S.opaque,
  `AWS_SECRET_ACCESS_KEY=${S.opaque}`,
  `aws_secret_access_key = ${S.opaque}`,
  `"SecretAccessKey": "${S.opaque}"`,
  `secretAccessKey: '${S.opaque}'`,
);
// 10. B2: cudzysłów po słowie kluczowym, który zamyka argument, nie może zjeść dalszego przypisania
add(
  "quote-consume",
  pw,
  `grep "password=" config.ini && sed -i 's/x/y/' a; echo password=${pw}`,
  `echo "DB_PASSWORD=" >> .env && echo DB_PASSWORD=${pw} >> .env`,
  `rg -n 'token:' src; export TOKEN=${pw}`,
  `print("password: " + x); password=${pw}`,
  `grep 'secret=' -r . && SECRET=${pw} ./run.sh`,
  `if line.startswith("password="): password=${pw}`,
  `"password": "", password=${pw}`,
  `password: "a", "x"; password=${pw}`,
  `echo "STRIPE_KEY=" >> .env && echo API_KEY=${pw}`,
);
add(
  "bearer",
  S.opaque,
  `Authorization: Bearer ${S.opaque}`,
  `Authorization: Basic ${S.b64}${S.opaque}`,
  `Authorization: Token ${S.opaque}`,
);

/**
 * Luki wspólne z wersją sprzed przepisania (świadome kompromisy, docs/ARCHITEKTURA.md §4): samo *_KEY bez członu
 * sekretu z wartością, która nie wygląda na wygenerowany klucz (STORAGE_KEY = "…" to zwykle nazwa), wartość bez
 * cudzysłowu ze spacjami (maskowane pierwsze słowo), deklaracja Go z typem, proza („hasło to X”), mysql -pX,
 * --with-token <<< X i <private> bez zamknięcia (zgodność z claude-mem).
 */
const KNOWN_GAPS: ((c: Case) => boolean)[] = [
  (c) => /\b(?:STRIPE|APP)_KEY\b/i.test(c.text),
  (c) => c.secret.includes(" ") && /=Zielony Kot/.test(c.text),
  (c) => /\bvar \w+ string = /.test(c.text),
  (c) => c.cat === "pl" && !/^(?:hasło|Hasło|haslo)[:=]/.test(c.text),
  (c) => /\bmysql .*-p\S|--with-token <<</.test(c.text),
  (c) => c.cat === "private" && !/<\/private/i.test(c.text),
];
const known = (c: Case) => KNOWN_GAPS.some((g) => g(c));

/** Najdłuższy wspólny fragment ciągły sekretu i wyjścia (ucięcie maski zostawia kawałek sekretu). */
function longestShared(secret: string, out: string): number {
  let best = 0;
  for (let i = 0; i < secret.length; i++)
    for (let k = secret.length; k > i + best; k--) if (out.includes(secret.slice(i, k))) best = Math.max(best, k - i);
  return best;
}
const leaks = (out: string, secret: string) => {
  if (out.includes(secret)) return true;
  const l = longestShared(secret, out);
  return l >= 6 && l >= secret.length * 0.4;
};

describe("redakcja: korpus regresji wycieków", () => {
  test(`${C.length} przypadków: sekret nie przechodzi przez clean() (poza KNOWN_GAPS), wynik jest punktem stałym`, () => {
    const bad: string[] = [];
    let gaps = 0;
    for (const c of C) {
      const out = clean(c.text);
      if (clean(out) !== out) bad.push(`nieidempotentne [${c.cat}] ${JSON.stringify(c.text).slice(0, 160)}`);
      if (!leaks(out, c.secret)) continue;
      if (known(c)) gaps++;
      else bad.push(`[${c.cat}] ${JSON.stringify(c.text).slice(0, 160)} -> ${JSON.stringify(out).slice(0, 160)}`);
    }
    expect(bad).toEqual([]);
    expect(C.length).toBeGreaterThan(6000);
    expect(gaps).toBeLessThan(C.length / 15); // luki to wąskie klasy, nie połowa korpusu
  });

  test("B1: & należy do wartości (także dalsze pola zapytania, jak w main)", () => {
    expect(clean(`DB_PASSWORD=${S.pwAmp}`)).toBe("DB_PASSWORD=[REDACTED]");
    expect(clean(`Server=db;Password=${S.pwAmp};Database=x`)).toBe("Server=db;Password=[REDACTED];Database=x");
    expect(clean(`password=${S.pwAmp} dbname=x`)).toBe("password=[REDACTED] dbname=x");
    expect(clean(`https://x/api?token=${S.opaque}&page=2&x=1`)).toBe("https://x/api?token=[REDACTED]");
    expect(clean(`https://x/api?auth=1&token=${S.opaque}`)).toBe("https://x/api?auth=[REDACTED]");
  });

  test("B2: odrzucona wartość (cudzysłów zamykający argument) nie zjada dalszego przypisania", () => {
    expect(clean(`echo "DB_PASSWORD=" >> .env && echo DB_PASSWORD=${pw} >> .env`)).toBe(
      'echo "DB_PASSWORD=" >> .env && echo DB_PASSWORD=[REDACTED] >> .env',
    );
    expect(clean(`grep 'secret=' -r . && SECRET=${pw} ./run.sh`)).toBe("grep 'secret=' -r . && SECRET=[REDACTED] ./run.sh");
  });

  test("B3: hasło podobne do kodu jest hasłem; kod po nazwie sekretu też jest maskowany (bez wyjątków, jak w main)", () => {
    for (const v of [S.pwParen, S.pwBracket, S.pwEnv, S.pwApp, S.pwDots])
      expect(clean(`ADMIN_PASS=${v}`)).toBe("ADMIN_PASS=[REDACTED]");
    // świadomy koszt: odczyt ze środowiska, wywołanie i pole obiektu po nazwie sekretu to fałszywe trafienia
    for (const [code, out] of [
      ['SECRET_KEY = os.environ["SECRET_KEY"]', 'SECRET_KEY = [REDACTED]"SECRET_KEY"]'],
      ["token = ENV.fetch('TOKEN')", "token = [REDACTED]'TOKEN')"],
      ["secret_key = settings.SECRET_KEY", "secret_key = [REDACTED]"],
      ["password = getPassword(user)", "password = [REDACTED]"],
      ["api_key = config.api.key", "api_key = [REDACTED]"],
    ])
      expect(clean(code)).toBe(out);
  });

  test("B4: JWT po myślniku i podkreślniku", () => {
    for (const pre of ["x-", "token-", "X-Amz-Security-Token-", "--jwt-", "id_token_"])
      expect(clean(`${pre}${jwt} koniec`)).toBe(`${pre}[REDACTED:jwt] koniec`);
  });

  test("W1: kilka uciętych kluczy PEM: każdy maskowany, wynik idempotentny", () => {
    const head = j("-----BEGIN ", "PRIVATE KEY-----");
    const lines = pemBody.split("\n");
    const t = `a\n${head}\n${lines[0]}\n${lines[1]}\n\nśrodek\n${head}\n${lines[2]}\nkoniec`;
    const out = clean(t);
    expect(out).toBe("a\n[REDACTED:private-key]\n\nśrodek\n[REDACTED:private-key]\nkoniec");
    expect(clean(out)).toBe(out);
    expect(redact(t).hits).toBe(2);
  });

  test("nowe tokeny i opcje: npm_, pypi-, SG., PASSPHRASE, --password X, curl -u, sshpass -p, ;Pwd=, ?sig=", () => {
    expect(clean(`npm config set //registry.npmjs.org/:_authToken ${S.npm}`)).not.toContain(S.npm);
    expect(clean(`TWINE_PASSWORD=${S.pypi}`)).not.toContain(S.pypi);
    expect(clean(`sg.setApiKey("${S.sg}")`)).not.toContain(S.sg);
    expect(clean(`PASSPHRASE=${pw}`)).toBe("PASSPHRASE=[REDACTED]");
    expect(clean(`psql --password ${pw} -h db`)).toBe("psql --password [REDACTED] -h db");
    expect(clean(`curl -u admin:${pw} https://x`)).toBe("curl -u admin:[REDACTED] https://x");
    // użytkownik zamaskowany wcześniej to cały znacznik: drugie clean() nic nie zmienia (piąta recenzja)
    for (const [t, want] of [
      [`curl -u ${S.ghp} https://api.github.com/user`, "curl -u [REDACTED:github-token] https://api.github.com/user"],
      [`curl -u ${S.ghp}:${pw} https://x`, "curl -u [REDACTED:github-token]:[REDACTED] https://x"],
      [`curl --user ${S.oai}:x-oauth-basic https://x`, "curl --user [REDACTED:openai-key]:[REDACTED] https://x"],
    ]) {
      expect([t, clean(t)]).toEqual([t, want]);
      expect(clean(want)).toBe(want);
    }
    expect(clean(`sshpass -p ${pw} ssh host`)).toBe("sshpass -p [REDACTED] ssh host");
    expect(clean(`Server=db;Uid=sa;Pwd=${pw};`)).toBe("Server=db;Uid=sa;Pwd=[REDACTED];");
    expect(clean(`https://x/a.png?sig=${S.opaque}&se=2026`)).toBe("https://x/a.png?sig=[REDACTED]&se=2026");
    // zostaje: uid:gid w -u, PWD powłoki, krótki ?key=
    for (const keep of ["docker run -u 1000:1000 img", "PWD=/home/jan/projekt", "https://x/?key=value&page=2", "cd $PWD; pwd"])
      expect(clean(keep)).toBe(keep);
  });

  test("JSON w JSON-ie, adnotacje typów, => i := maskują wartość (typ od 6 znaków też, jak w main)", () => {
    expect(clean(JSON.stringify({ command: `export PASSWORD="${pw}" && ./run` }))).toBe(
      '{"command":"export PASSWORD=\\"[REDACTED]\\" && ./run"}',
    );
    expect(clean(`let password: String = "${pw}".into();`)).toBe('let password: [REDACTED] = "[REDACTED]".into();');
    expect(clean(`password: str = "${pw}"`)).toBe('password: str = "[REDACTED]"');
    expect(clean(`'password' => '${pw}',`)).toBe("'password' => '[REDACTED]',");
    expect(clean(`password := "${pw}"`)).toBe('password := "[REDACTED]"');
    // typ i funkcja strzałkowa po nazwie sekretu to fałszywe trafienia, świadomie (wyjątek dawał wycieki)
    for (const [code, out] of [
      ["token: string;", "token: [REDACTED];"],
      ["password: string | null;", "password: [REDACTED] | null;"],
      ["credential => credential.id", "credential => [REDACTED]"],
      ["users.map(token => token.trim())", "users.map(token => [REDACTED]"],
    ])
      expect(clean(code)).toBe(out);
  });

  test("D1: nazwy i ścieżki pod *_KEY, opisy pod *_PROMPT/_HEADER/_NAME zostają (poza kluczami przypisań)", () => {
    for (const keep of [
      'const PROJECT_MERGES_KEY = "projectMerges2";',
      'const AUTH_KEY = "auth_token";',
      'const CLIENT_KEY = "client-id";',
      'SSH_KEY = "~/.ssh/id_ed25519"',
      'const SSH_KEY = "id_ed25519";',
      'const STORAGE_KEY = "hipokamp-viewer-theme-v2";',
      'REDIS_KEY = "session:user:12345:profile"',
      'S3_KEY = "uploads/2024/10/avatar12345"',
      'const QUERY_KEY = "observations2024list";',
      'COMMIT_KEY = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39"',
      '#define PASSWORD_PROMPT "Enter password:"',
      'API_KEY_HEADER = "x-api-key"',
      'SECRET_NAME = "prod/db/password"',
      "DIR_PWD=/home/jan/x",
    ])
      expect(clean(keep)).toBe(keep);
    // nazwa z ASSIGN (session_key, credentials) maskuje każdą wartość od 6 znaków, także nazwę i ścieżkę
    expect(clean('const SESSION_KEY = "app_session";')).toBe('const SESSION_KEY = "[REDACTED]";');
    expect(clean("GOOGLE_APPLICATION_CREDENTIALS=/srv/keys/sa.json")).toBe("GOOGLE_APPLICATION_CREDENTIALS=[REDACTED]");
  });

  // Nadzbiór względem main: wyjścia clean() z origin/main sprzed PR #8 zamrożone dla przypadków z recenzji. Każdy znak
  // zamaskowany tam musi być zamaskowany i teraz. Zbiory liczone z wyjść: wyjście to wejście z fragmentami zamienionymi
  // na znaczniki, więc znak „może być zamaskowany” w main albo „może zostać” w nowej wersji w którymkolwiek
  // dopasowaniu; przecięcie tych zbiorów to naruszenie. (Pełny dowód na ~200 tys. wejść: skrypt różnicowy w PR #8.)
  const MAIN_OUT: [string, string][] = [
    ["password: Wiosna(2024)!x", "password: [REDACTED]"],
    ["client_secret = Lato[pl]2026x", "client_secret = [REDACTED]"],
    ["pass = [Abc]123xyz", "pass = [REDACTED]"],
    ["token: (x7Kq9)mP2wZ", "token: [REDACTED]"],
    ["api_key: Secret(Key)99", "api_key: [REDACTED]"],
    ["token = mytoken", "token = [REDACTED]"],
    ["secret = topsecret", "secret = [REDACTED]"],
    ["password = hunter_password", "password = [REDACTED]"],
    ["token=>token.trim()", "token=[REDACTED]"],
    ["password: String", "password: [REDACTED]"],
    ["token: string;", "token: [REDACTED];"],
    ["https://x/api?token=Xk9mQ2vL8Zp&page=2", "https://x/api?token=[REDACTED]"],
    ["password=`abcdefg`", "password=[REDACTED]"],
    ["password=<hasło>]}.", "password=[REDACTED]"],
    ["password=%DB_PASS%", "password=[REDACTED]"],
    ["token=process.env.API_password=SECRETxyz1", "token=[REDACTED]"],
    ["a <private>A</private >Xk9mQ2vL8Zp</private> b", "a [prywatne] b"],
    [
      "https://jan:Xk9mQ2vL8Zp@host.pl i ola@firma.pl / Lato2026!x",
      "https://jan:[REDACTED]@host.pl i ola@firma.pl / [REDACTED:login]",
    ],
    ["Authorization: Bearer\t\tXk9mQ2vL8ZpXk9mQ2vL8Zp", "Authorization: Bearer [REDACTED:bearer]"],
    [
      'cfg = {"password": "correct horse battery", "auth": "Wiosna(2024)!x"}',
      'cfg = {"password": "correct horse battery", "auth": "[REDACTED]"}',
    ],
  ];
  const MARK = / \[REDACTED:bearer\]|\[REDACTED(?::[a-z0-9-]*)?\]?|\[prywatne\]/g;
  /** Znaki wejścia, które w jakimś dopasowaniu wyjścia są pod znacznikiem (masked) albo zostają (kept). */
  function masks(input: string, output: string): { masked: boolean[]; kept: boolean[] } {
    const L = output.split(MARK);
    const k = L.length - 1;
    const n = input.length;
    const masked: boolean[] = new Array(n).fill(false);
    const kept: boolean[] = new Array(n).fill(k === 0);
    if (k === 0) return { masked, kept };
    // najwcześniejszy (f) i najpóźniejszy (b) początek każdego kawałka tekstu; znacznik pokrywa co najmniej 1 znak
    const f = [0];
    for (let i = 1; i <= k; i++) f[i] = i === k ? n - L[k].length : input.indexOf(L[i], f[i - 1] + L[i - 1].length + 1);
    const b: number[] = [];
    b[k] = n - L[k].length;
    for (let i = k - 1; i >= 0; i--) b[i] = i === 0 ? 0 : input.lastIndexOf(L[i], b[i + 1] - 1 - L[i].length);
    const ok = (x: number, i: number) => x >= 0 && x <= b[i] && (i === 0 || x > f[i - 1] + L[i - 1].length);
    expect(input.startsWith(L[0]) && input.endsWith(L[k]) && f.every(ok)).toBe(true);
    for (let i = 0; i <= k; i++)
      for (let o = input.indexOf(L[i], f[i]); L[i] && o >= 0 && o <= b[i]; o = input.indexOf(L[i], o + 1))
        kept.fill(true, o, o + L[i].length);
    for (let i = 1; i <= k; i++) masked.fill(true, f[i - 1] + L[i - 1].length, b[i]);
    return { masked, kept };
  }

  test("nadzbiór main: przypadki czwartej recenzji (.env w JSON-ie, hasła z ( i [, końcówka słowa) i reszta", () => {
    for (const [input, main] of MAIN_OUT) {
      const out = clean(input);
      const m = masks(input, main).masked;
      const k = masks(input, out).kept;
      expect([input, out, [...input].filter((_, x) => m[x] && k[x]).join("")]).toEqual([input, out, ""]);
    }
    // (1) .env w JSON-ie dłuższy niż 200 znaków: wartość za znacznikiem (tu: main też ją przepuszczał) nie przeskakuje
    // sekretów w dalszych liniach
    const env = [
      "APP_URL=https://hipokamp.example.com/panel/ustawienia/konto",
      "DESCRIPTION=Pamięć-długoterminowa-dla-Claude-Code-bez-LLM-i-bez-sieci",
      "DB_PASSWORD=Xk9mQ2vL8Zp",
      "PASSPHRASE=Wiosna(2024)!x",
      "WIFI_PSK=Lato[pl]2026x",
      "ADMIN_PASS=Secret(Key)99",
    ].join("\n");
    for (const t of [
      JSON.stringify({ content: `TOKEN=[REDACTED:jwt]\n${env}` }),
      JSON.stringify({ auth: env }),
      JSON.stringify({ command: `cat > .env <<EOF\nX_KEY=a.b\n${env}\nEOF` }),
      JSON.stringify(JSON.stringify({ file: ".env", content: `TOKEN=[REDACTED]\n${env}` })),
    ]) {
      expect(t.length).toBeGreaterThan(200);
      const out = clean(t);
      for (const s of ["Xk9mQ2vL8Zp", "Wiosna(2024)!x", "Lato[pl]2026x", "Secret(Key)99"])
        expect([t, out.includes(s)]).toEqual([t, false]);
    }
    // (2) nawias albo [ przed literą to dalej hasło, w każdej formie klucza
    for (const v of ["Wiosna(2024)!x", "Lato[pl]2026x", "Secret(Key)99", "(x7Kq9)mP2wZ", "[Abc]123xyz"])
      for (const t of [`password: ${v}`, `PASSPHRASE=${v}`, `client_secret = ${v}`, `"token": "${v}"`, `api_key := ${v}`])
        expect([t, clean(t).includes(v)]).toEqual([t, false]);
    // (3) wartość kończąca się nazwą klucza to nie „nazwa innej zmiennej”
    for (const t of ["token = mytoken", "secret = topsecret", "password = hunter_password", "auth = oauth2_token"])
      expect([t, clean(t)]).toEqual([t, t.replace(/= .*/, "= [REDACTED]")]);
  });

  // smart_* (piąta recenzja): linia źródła po maskBlocks i clean() maskuje co najmniej to, co potok main. Wyjścia main
  // zamrożone: szerszy klucz ścisły (credentials, session_key) zjadał literał, w którym zaczynało się złamane przypisanie
  // main; ucięty PEM i <private > zasłaniały klucz; maska ścisła zasłaniała klucz, od którego clean() z main maskował
  // dalej w tej samej linii. (Pełny dowód: skrypt różnicowy smart_* w PR #8.)
  test("nadzbiór main w smart_*: złamane przypisania pod szerszym kluczem, ucięty PEM, <private >, maska w linii", () => {
    const view = (t: string) => maskBlocks(t).split(/\r?\n/).map(clean).join("\n");
    const v1 = j("Wiosna", "2026xQ");
    const v2 = j("Lato", "2026xyzQ");
    const v3 = j("Secret", "123xyz");
    const rsa = j("-----BEGIN RSA ", "PRIVATE KEY-----");
    for (const [input, main, secret] of [
      [`credentials:\n  "token":\n    "${v1}"`, 'credentials:\n  "token":\n    "[REDACTED]"', v1],
      [`"session_key":\n  "x password":\n  "${v2}"`, '"session_key":\n  "x password":\n  "[REDACTED]"', v2],
      [`${rsa}\nMIIEowIBAAKCAQEAwordpassword\n= "${v3}"`, `${rsa}\nMIIEowIBAAKCAQEAwordpassword\n= "[REDACTED]"`, v3],
      [`x <private >a</private>password\n= "${v3}"`, 'x <private >a</private>password\n= "[REDACTED]"', v3],
      [`session_key:\n  "the password": "${v2}"`, 'session_key:\n  "the password": "[REDACTED]"', v2],
      [`credentials:\n  'my_haslo': '${v3}'`, "credentials:\n  'my_haslo': '[REDACTED]'", v3],
    ]) {
      const out = view(input);
      expect([input, out.includes(secret)]).toEqual([input, false]);
      const m = masks(input, main).masked;
      const k = masks(input, out).kept;
      expect([input, out, [...input].filter((_, x) => m[x] && k[x]).join("")]).toEqual([input, out, ""]);
    }
  });

  test("złośliwe wejścia nowych reguł po 1 MB: liniowo", () => {
    const MB = 1_000_000;
    const one = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
    const best = (s: string) => {
      let min = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        clean(s);
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    const base = best(one('export const STORAGE_KEY = "hipokamp.viewer.theme"; const x = foo(bar, baz);\n'));
    const limit = Math.max(150, 5 * base);
    const B = "\\";
    for (const [label, s] of [
      ["password=x&&&…", `password=x${one("&")}`],
      ["password=x&a&a…", `password=x${one("&a")}`],
      ["password=_a._a.…", `password=${one("_a.")}`],
      ["-eyJ-eyJ…", one("-eyJ")],
      ["_eyJ_eyJ…", one("_eyJ")],
      ['token="token="…', one('token="')],
      ['password=\\"…', one(`password=${B}"`)],
      ["password: T = …", one("password: T = ")],
      ["'password' => …", one("'password' => ")],
      ["a_b_key=…", one("a_b_key=")],
      [";pwd=…", one(";pwd=")],
      ["?sig=…", one("?sig=")],
      ["redis://:…", one("redis://:")],
      ["jan@x.pl / x@a.a.a…", `jan@x.pl / x@${one("a.")}`],
      ["hasło: żółć…", one("hasło: żółć😀 ")],
      ["password=`…", one("password=`")],
      [" -u [REDACTED…", one(" -u [REDACTED")],
    ] as const)
      expect([label, best(s) < limit]).toEqual([label, true]);
    // próg jest względny (base), a 17 wejść po 3 przebiegi na obciążonej maszynie przekracza domyślne 5 s
  }, 30_000);

  test("W3: bloki i złamane przypisania w smart_unfold/outline (code.ts) liczone liniowo", () => {
    const one = (unit: string, n: number) => unit.repeat(n);
    const B = "\\";
    for (const s of [
      one("// <private>\n", 100_000),
      one("// -----BEGIN PRIVATE KEY-----\n", 60_000),
      one("// </private>\n", 100_000),
      one('password:\n  "x"\n', 50_000),
      one("// <private >\n", 70_000),
      // literał bez zamknięcia od każdego klucza do końca linii: dawniej kwadratowo (100 kB: kilka sekund)
      one(`password=${B}"`, 90_000),
      one(`secret_key=${B}"`, 80_000),
      one(`token: ${B}"`, 110_000),
      one(`credentials:\n "token":\n "x"\n`, 30_000),
    ]) {
      const t0 = performance.now();
      maskBlocks(s);
      expect([s.slice(0, 16), performance.now() - t0 < 500]).toEqual([s.slice(0, 16), true]);
    }
    const lines = pemBody.split("\n");
    expect(maskBlocks(`a\n${j("-----BEGIN ", "PRIVATE KEY-----")}\n${lines[0]}\nb`)).toBe(
      "a\n[REDACTED:private-key]\n[REDACTED:private-key]\nb",
    );
  });
});
