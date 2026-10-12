// Syntetyczne pliki sesji innych harnessów (kształty jak w ich formatach, treść wymyślona, bez prawdziwych danych):
// Gemini CLI (JSONL: metadane, wiadomości dopisywane ponownie z wywołaniami narzędzi), Cursor (stary .txt i nowy
// .jsonl z `role`), OpenCode (wiadomości SDK: {info, parts}).
export const T0 = Date.parse("2026-10-05T09:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

export const GEMINI_ID = "0a1b2c3d-0000-4000-8000-00000000a001";

/** Sesja Gemini CLI: prompt, odpowiedź z tekstem, ta sama wiadomość z wywołaniami (bez wyniku, potem z wynikiem). */
export function geminiSession(id = GEMINI_ID, kind = "main"): object[] {
  const calls = (done: boolean) => [
    {
      id: "call-read",
      name: "read_file",
      args: { file_path: "src/app.ts" },
      status: done ? "success" : "executing",
      ...(done
        ? { result: [{ functionResponse: { id: "call-read", name: "read_file", response: { output: "export {}" } } }] }
        : {}),
      timestamp: iso(T0 + 2000),
    },
    {
      id: "call-write",
      name: "write_file",
      args: { file_path: "src/nowy.ts", content: "export const x = 1;" },
      status: done ? "success" : "executing",
      ...(done
        ? { result: [{ functionResponse: { response: { output: "Successfully created and wrote to new file: src/nowy.ts" } } }] }
        : {}),
      timestamp: iso(T0 + 2500),
    },
    {
      id: "call-sh",
      name: "run_shell_command",
      args: { command: "bun test" },
      status: done ? "error" : "executing",
      ...(done ? { result: [{ functionResponse: { response: { error: "1 fail" } } }] } : {}),
      timestamp: iso(T0 + 3000),
    },
  ];
  return [
    { sessionId: id, projectHash: "demo", startTime: iso(T0), lastUpdated: iso(T0), kind },
    {
      id: "u1",
      timestamp: iso(T0 + 1000),
      type: "user",
      content: [{ text: "dodaj moduł nowy i uruchom testy w projekcie demo" }],
    },
    { id: "g1", timestamp: iso(T0 + 1500), type: "gemini", content: "Czytam app.ts i dodaję moduł.", model: "gemini-test" },
    {
      id: "g1",
      timestamp: iso(T0 + 1500),
      type: "gemini",
      content: "Czytam app.ts i dodaję moduł.",
      model: "gemini-test",
      toolCalls: calls(false),
    },
    {
      id: "g1",
      timestamp: iso(T0 + 1500),
      type: "gemini",
      content: "Czytam app.ts i dodaję moduł.",
      model: "gemini-test",
      toolCalls: calls(true),
    },
    { $set: { summary: "Moduł nowy", lastUpdated: iso(T0 + 3500) } },
    {
      id: "g2",
      timestamp: iso(T0 + 4000),
      type: "gemini",
      content: "Dodałem src/nowy.ts; jeden test nie przechodzi.",
      model: "gemini-test",
    },
    { id: "i1", timestamp: iso(T0 + 4100), type: "info", content: "komunikat interfejsu" },
    { id: "u2", timestamp: iso(T0 + 5000), type: "user", content: "/memory show" },
  ];
}

/**
 * Starszy zapis Gemini CLI: cała sesja jako jeden obiekt JSON (`session-*.json`, wcięcie 2 spacje), wiadomości
 * w `messages` bez ponownych wersji. Id wiadomości z przedrostkiem `p` (klucze tur są globalne).
 */
export function geminiJsonRecord(id: string, p = "j"): string {
  const rec = {
    sessionId: id,
    projectHash: "demo",
    startTime: iso(T0),
    lastUpdated: iso(T0 + 9000),
    messages: [
      { id: `${p}-u1`, timestamp: iso(T0 + 1000), type: "user", content: "popraw walidację formularza w module demo" },
      {
        id: `${p}-g1`,
        timestamp: iso(T0 + 2000),
        type: "gemini",
        content: "Poprawiłem walidację w src/form.ts: pole email jest wymagane.",
        model: "gemini-old",
        toolCalls: [
          {
            id: `${p}-c1`,
            name: "replace",
            args: { file_path: "src/form.ts", old_string: "a", new_string: "b" },
            status: "success",
            result: [{ functionResponse: { response: { output: "ok" } } }],
            timestamp: iso(T0 + 1500),
          },
        ],
      },
      { id: `${p}-u2`, timestamp: iso(T0 + 5000), type: "user", content: "dopisz test walidacji pola email w demo" },
      {
        id: `${p}-g2`,
        timestamp: iso(T0 + 6000),
        type: "gemini",
        content: "Dodałem test w test/form.test.ts; przechodzi.",
        model: "gemini-old",
      },
    ],
  };
  return `${JSON.stringify(rec, null, 2)}\n`;
}

/** Sesja Gemini CLI z cofnięciem: dwie tury, `$rewindTo` do drugiego promptu, nowa tura po nim (id z przedrostkiem). */
export function geminiRewindSession(id: string, p = "r", upTo: "before" | "all" = "all"): object[] {
  const turn = (n: number, at: number, prompt: string, answer: string): object[] => [
    { id: `${p}-u${n}`, timestamp: iso(T0 + at), type: "user", content: [{ text: `${prompt} (${p})` }] },
    {
      id: `${p}-g${n}`,
      timestamp: iso(T0 + at + 500),
      type: "gemini",
      content: `${answer} (${p})`,
      model: "gemini-test",
      toolCalls: [
        {
          id: `${p}-c${n}`,
          name: "write_file",
          args: { file_path: `src/platnosci${n}.ts`, content: "export {}" },
          status: "success",
          result: [
            { functionResponse: { response: { output: `Successfully created and wrote to new file: src/platnosci${n}.ts` } } },
          ],
          timestamp: iso(T0 + at + 400),
        },
        {
          id: `${p}-s${n}`,
          name: "run_shell_command",
          args: { command: "bun test" },
          status: "success",
          result: [{ functionResponse: { response: { output: "3 pass" } } }],
          timestamp: iso(T0 + at + 450),
        },
      ],
    },
  ];
  const head = [
    { sessionId: id, projectHash: "demo", startTime: iso(T0), lastUpdated: iso(T0), kind: "main" },
    ...turn(
      1,
      1000,
      "opisz moduł płatności w projekcie demo",
      "DECYZJA: moduł płatności zostaje w trzech warstwach: API, usługa i baza.",
    ),
    ...turn(
      2,
      3000,
      "przepisz moduł płatności na kolejkę zdarzeń",
      "DECYZJA: płatności idą przez kolejkę zdarzeń z ponowieniami.",
    ),
  ];
  if (upTo === "before") return head;
  return [
    ...head,
    { $rewindTo: `${p}-u2` },
    ...turn(
      3,
      9000,
      "zostaw płatności, dopisz tylko logowanie błędów",
      "DECYZJA: błędy płatności logujemy do pliku z rotacją dzienną.",
    ),
  ];
}

export const CURSOR_ID = "0a1b2c3d-0000-4000-8000-00000000c001";

/** Stary transkrypt Cursora (.txt): bloki ról, <think>, [Tool call] z parametrami, puste [Tool result]; bez \n na końcu. */
export function cursorTxt(): string {
  return [
    "user:",
    "<user_query>",
    "napraw błąd w module demo, który psuje logowanie",
    "</user_query>",
    "",
    "assistant:",
    "<think>",
    "Najpierw przeczytam plik.",
    "user:",
    "</think>",
    "Sprawdzam moduł logowania.",
    "",
    "[Tool call] Read",
    "  path: src/login.ts",
    "[Tool call] Shell",
    "  command: bun test",
    "  description: testy",
    "",
    "[Tool result] Read",
    "",
    "[Tool result] Shell",
    "",
    "assistant:",
    "[Tool call] StrReplace",
    "  path: src/login.ts",
    "  old_string: a",
    "druga linia",
    "  new_string: b",
    "",
    "[Tool result] StrReplace",
    "",
    "assistant:",
    "Poprawiłem warunek w src/login.ts.",
    "",
    "user:",
    "<user_query>",
    "a teraz dopisz test regresji dla logowania",
    "</user_query>",
    "",
    "assistant:",
    "[Tool call] Write",
    "  path: test/login.test.ts",
    "  contents: test()",
    "",
    "[Tool result] Write",
    "",
    "assistant:",
    "Dopisałem test regresji.",
  ].join("\n");
}

/** Nowy transkrypt Cursora (.jsonl): `role` zamiast `type`, prompt w <user_query>, bez czasu i narzędzi. */
export function cursorJsonl(): object[] {
  return [
    {
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>\nopisz architekturę modułu płatności w demo\n</user_query>" }] },
    },
    {
      role: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Moduł płatności ma trzy warstwy: adapter bramki, kolejkę zdarzeń i księgowanie. Decyzja: księgowanie idzie przez kolejkę, żeby awaria bramki nie gubiła wpłat.",
          },
        ],
      },
    },
    { role: "user", message: { content: [{ type: "text", text: "<user_query>\ndzięki\n</user_query>" }] } },
  ];
}

/**
 * Narzędzia sejfu w nazwach Gemini CLI i Cursora (capture.privateTools) i sekret w prompcie. `secret` składa test
 * (wzorzec klucza budowany w locie, żeby skaner sekretów nie widział go w repo).
 */
export function geminiPrivateSession(id: string, secret: string): object[] {
  return [
    { sessionId: id, projectHash: "demo", startTime: iso(T0), lastUpdated: iso(T0), kind: "main" },
    {
      id: `${id}-u1`,
      timestamp: iso(T0 + 1000),
      type: "user",
      content: [{ text: `zapisz klucz ${secret} do .env projektu demo` }],
    },
    {
      id: `${id}-g1`,
      timestamp: iso(T0 + 2000),
      type: "gemini",
      content: "Zapisuję klucz przez sejf.",
      model: "gemini-test",
      toolCalls: [
        // bez konfliktu nazw: goła nazwa, serwer tylko w displayName
        {
          id: "c1",
          name: "write_env",
          displayName: "write_env (sejf MCP Server)",
          args: { path: ".env", value: secret },
          status: "success",
          result: [{ functionResponse: { response: { output: `zapisano ${secret}` } } }],
        },
        // przy konflikcie nazw: serwer__narzędzie
        {
          id: "c2",
          name: "sejf__list_secrets",
          args: { filter: `KLUCZ_${secret}` },
          status: "success",
          result: [{ functionResponse: { response: { output: `API_KEY=${secret}` } } }],
        },
      ],
    },
    {
      id: `${id}-g2`,
      timestamp: iso(T0 + 3000),
      type: "gemini",
      content: "Gotowe: klucz zapisany w .env projektu demo przez sejf, nic nie trafiło do repozytorium.",
      model: "gemini-test",
    },
  ];
}

export function cursorPrivateTxt(secret: string): string {
  return [
    "user:",
    "<user_query>",
    `uruchom migrację bazy demo z hasłem ${secret}`,
    "</user_query>",
    "",
    "assistant:",
    "Uruchamiam migrację przez sejf.",
    "",
    "[Tool call] mcp_sejf_run_with_secrets",
    "  command: bun run migrate",
    `  env: DB_PASS=${secret}`,
    "",
    "[Tool result] mcp_sejf_run_with_secrets",
    "",
    "assistant:",
    "Migracja przeszła; baza demo ma nową kolumnę.",
  ].join("\n");
}

export const OPENCODE_ID = "ses_demo0001";

/** Wiadomości sesji OpenCode z SDK (client.session.messages): prompt, odpowiedź z narzędziami i tekstem. */
export function opencodeMessages(cwd: string, done = true): any[] {
  return [
    {
      info: { id: "msg_u1", sessionID: OPENCODE_ID, role: "user", time: { created: T0 } },
      parts: [
        { type: "text", text: "zmień port serwera demo na 8081 i uruchom testy" },
        { type: "text", text: "<treść pliku dołączona przez OpenCode>", synthetic: true },
      ],
    },
    {
      info: {
        id: "msg_a1",
        sessionID: OPENCODE_ID,
        role: "assistant",
        modelID: "model-test",
        path: { cwd, root: cwd },
        time: done ? { created: T0 + 1000, completed: T0 + 5000 } : { created: T0 + 1000 },
        finish: done ? "stop" : undefined,
      },
      parts: [
        { type: "step-start" },
        {
          type: "tool",
          callID: "c1",
          tool: "read",
          state: { status: "completed", input: { filePath: `${cwd}/server.ts` }, output: "listen(8080)" },
        },
        {
          type: "tool",
          callID: "c2",
          tool: "edit",
          state: { status: "completed", input: { filePath: `${cwd}/server.ts` }, output: "ok" },
        },
        { type: "tool", callID: "c3", tool: "bash", state: { status: "error", input: { command: "bun test" }, error: "1 fail" } },
        {
          type: "tool",
          callID: "c4",
          tool: "sejf_reveal_secret",
          state: { status: "completed", input: { name: "x" }, output: "TAJNE" },
        },
        { type: "text", text: "Port zmieniony na 8081 w server.ts; jeden test nie przechodzi." },
        { type: "step-finish" },
      ],
    },
  ];
}
