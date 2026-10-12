# hipokamp: zasady repo

Darmowa, lokalna pamięć długoterminowa dla Claude Code (następca claude-mem). Opis dla ludzi: [README.md](README.md), szczegóły techniczne: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md).

## Stos

- Bun 1.3 + TypeScript (ESM), `bun:sqlite` (WAL, FTS5), `sqlite-vec` (wektory binarne), `@huggingface/transformers` 4 (ONNX Runtime: CPU i DirectML), `@modelcontextprotocol/sdk` 1.32 + zod 4.
- Podgląd: czysty HTML/CSS/JS w `viewer/` (bez bundlera), design HEXART z lokalnymi zasobami w `viewer/assets/`.
- Lint i format: Biome (`biome.json`, tylko `src/` i `test/`).
- Natywny hook (opcjonalny): Go 1.25, tylko biblioteka standardowa, `native/hook/`; budowa `scripts/build-native.ps1` albo `.sh` (vet, testy, build, test dymny, podmiana działającego pliku; uruchamiają ją `hipokamp install` i `update`, `src/install/native.ts`), binarka poza repo (`native/hook/hipokamp-hook*` w `.gitignore`). Zmiana zachowania = podbicie `version` w `main.go` i `NATIVE_VERSION` w `src/hooks/modes.ts` razem (skrypty, instalator i doctor odrzucają niezgodną binarkę).

## Komendy

```bash
bun run lint && bun run typecheck && bun test
```

Wszystkie trzy muszą przejść przed PR; to samo uruchamia CI (`.github/workflows/ci.yml`).

Przydatne: `hipokamp status`, `hipokamp logs`, `hipokamp doctor`, `bun run demo` (podgląd na wymyślonych danych, osobny port i baza tymczasowa), `bun spikes/hook-latency.ts` (p50/p95 hooków w trybach command, native i mcp, z workerem i bez; baza testowa z syntetycznymi notatkami i własny worker, wszystko sprzątane).

## Twarde zasady

1. **Hook nigdy nie blokuje.** Zawsze exit 0 (nigdy 2), twarde limity czasu, błąd ląduje w logu albo w spoolu. Kontekst ≤ 9500 znaków.
2. **Zero procesów potomnych w workerze.** Żadnego Pythona, `uvx`, sidecarów. Jedyne `spawn` to podniesienie workera przez klienta (odłączony); zapasowy hook Buna uruchamiany przez natywny hook (gdy worker nie odpowiada albo oddaje duży zapis tury) i przez powłokę po `||` w komendzie hooka (gdy natywnego pliku nie da się uruchomić); plugin OpenCode (w procesie OpenCode, nie w workerze) uruchamia `hook.ts`: Stop odłączony, start sesji i prompt z odpowiedzią i twardym limitem czasu; w instalatorze `claude plugin ...`, `schtasks`, test dymny natywnego hooka i jego budowa przez `scripts/build-native.*` (uruchamiana wyłącznie przez `hipokamp install` i `hipokamp update`, nigdy ręcznie w worktree live); `git` w `doctor` i `update`; `bun install` w `update` oraz lista procesów bun (PowerShell, CIM) w `update` przed `bun install`; domyślna przeglądarka w `hipokamp open` (lista argumentów, bez powłoki, z plikiem przekierowania zamiast biletu w linii poleceń), tam też `whoami`, `icacls` i PowerShell `Get-Acl` na Windows (prywatny katalog `state/open/`, bez dziedziczenia, tylko użytkownik, SYSTEM i Administratorzy, właściciel sprawdzany) i `xdg-settings` na Linux (wykrycie przeglądarki ze snapa albo flatpaka); wszystko w `src/worker/viewer-open.ts`, którego worker nie importuje. Klucz workera (T-17) po stronie klienta: `icacls` i `whoami` w `install` i `doctor` (`src/worker/keyacl.ts`), a przed zatrzymaniem starego workera w `update` odczyt chwili startu i linii poleceń procesu (PowerShell z CIM na Windows, `/proc` albo `/bin/ps` gdzie indziej, `src/worker/legacy.ts`); zadanie Harmonogramu przez PowerShell w instalatorze (`src/install/harness.ts`). Powiadomienia (opt-in, `notify.enabled`) uruchamiają procesy wyłącznie z procesu hooka Buna: hook Stop podnosi odłączony proces wysyłki (`src/notify/run.ts`), a ten uruchamia PowerShell (toast) albo polecenie użytkownika jako listę argumentów, bez powłoki (`.cmd`/`.bat`, także znalezione przez `PATHEXT`, odrzucone). Stop obsłużony w workerze (hook natywny) albo w serwerze MCP wysyła w procesie, bez spawnu: tylko `file` (zapis do pliku) i `webhook` (`loopbackFetch`), a powiadomienie wstrzymane limitem częstości dosyła jeden zegar (`setTimeout` z `unref`); `toast` i `command` działają tylko dla Stop obsłużonego przez proces hooka, a `doctor` ostrzega.
3. **Zero LLM i zero sieci w ścieżce domyślnej.** Wyjątek: jednorazowe pobranie modelu wektorów z Hugging Face. Opcjonalny lokalny LLM (`consolidation.llm`) i webhook powiadomień są domyślnie wyłączone i łączą się wyłącznie przez `loopbackFetch` (`src/util/net.ts`). Egzekwowane w kodzie: host spoza 127.0.0.0/8 i `::1` (także po dekodowaniu adresu) to wyjątek przed połączeniem, dane logowania w adresie odrzucone, odpowiedź 3xx to błąd (bez podążania), proxy z `HTTP(S)_PROXY` pominięte (`NO_PROXY` procesu), modele chmurowe Ollamy (`…-cloud`, `…:cloud`) odrzucone. Poza kontrolą kodu: sam serwer Ollamy (jego funkcje chmurowe wyłącza `OLLAMA_NO_CLOUD=1`) i to, dokąd dane wyśle polecenie z `notify.command`. Wyjątek opt-in: synchronizacja (docs/SYNC.md): połączenia wychodzące tylko po `sync.enabled: true` (worker) albo ręcznym `hipokamp sync …`, tylko do huba z konfiguracji synchronizacji, treść szyfrowana po stronie klienta. Przy `sync.enabled: false` worker nie ładuje klienta i nie otwiera żadnego połączenia (test „w tle”). Żadnej telemetrii, kont, banerów. Płatne API nigdy bez wyraźnej decyzji użytkownika.
4. **Prywatność przed zapisem.** Każdy tekst z transkryptu przechodzi przez `clean()` (redakcja sekretów + `<private>`). Narzędzia z `capture.privateTools` (sejf) nie trafiają do pamięci.
5. **Zgodność z claude-mem.** Nazwy i parametry narzędzi MCP jak w claude-mem; numery `#id` z importu są święte (nie renumerować, nie kasować twardo). Usuwanie = status `archived`/`merged`.
6. **Tylko 127.0.0.1.** Nowe endpointy przechodzą przez kontrolę `Host`/`Origin` w `route()`; nic nie wstawia treści jako HTML w podglądzie.
7. **SQL tylko w `src/db/repo.ts`** (wyjątki: importery, sen i miejsca z komentarzem). Zmiana schematu = nowa migracja w `src/db/schema.ts`. Zmiana sposobu indeksowania FTS = podbicie `FTS_VERSION` (worker przebuduje indeks sam).
8. **Testy nigdy nie dotykają prawdziwej bazy.** Zawsze `HIPOKAMP_HOME` w katalogu tymczasowym z `hipokamp-test` w nazwie (ziarno sprawdza to samo), osobny port, `CLAUDE_CONFIG_DIR` na pusty katalog, `HIPOKAMP_NO_WORKER=1` w testach MCP.
9. **UI = design HEXART** (skill `hexart`). Tokeny, fonty i ikony lokalnie, bez CDN.

## Pułapki

- **Heredoc w Bash psuje `\n` i `\r`** (Git Bash na Windows): w pliku lądują prawdziwe znaki. Kod z escape'ami pisz narzędziem Write/Edit albo skryptem zapisanym przez Write.
- **DirectML kompiluje graf dla każdego kształtu wejścia.** Masowe liczenie wektorów musi mieć stałe kształty (kubełki 128/256/512, stały batch), inaczej spada z 29/s do ok. 3/s.
- **Litera ł nie rozkłada się w Unicode** (`remove_diacritics` jej nie zdejmuje). Zwijanie ł→l musi być po obu stronach FTS: w indeksie (`ftsRow`) i w zapytaniu (`normKey`).
- **`SessionEnd` ma w Claude Code domyślnie 1,5 s.** Nie licz, że ostatni hook sesji dokończy pracę; od tego jest nadrabianie w workerze.
- **Transkrypty obserwatora claude-mem** (`claude-mem-observer`) to nie praca użytkownika: są wykluczone z zapisu i backfillu.
- **Bun ma domyślny limit bezczynności połączenia 120 s.** SSE wyłącza go per żądanie (`server.timeout(req, 0)`) i wysyła ping co 30 s.
- **`Subprocess.killed` w Bun na Windows bywa `true` po zwykłym zakończeniu procesu.** Przekroczenie limitu czasu liczymy sami (`runWithStdin` w `src/notify/channels.ts`).
- **`fetch` Buna (1.3) kieruje przez `HTTP_PROXY` także żądania na 127.0.0.1.** Ruch na pętlę zwrotną tylko przez `loopbackFetch` (dopisuje hosty do `NO_PROXY`, który Bun czyta przy każdym żądaniu).
- **`Bun.which` bez opcji widzi `PATH` z chwili startu procesu.** Zmiana `process.env.PATH` w locie wymaga `Bun.which(x, { PATH: process.env.PATH })`.
- **PowerShell 5.1 czyta stdin w stronie kodowej OEM.** Treść z polskimi znakami podawaj jako base64 z UTF-8 i dekoduj w skrypcie (toast).

## Git

- Repozytorium: https://github.com/lazniak/hipokamp. `main` tylko przez Pull Request (squash), po zielonym CI.
- Gałąź per zadanie. Conventional Commits.
- Plugin uruchamiaj z osobnego, czystego checkoutu (np. worktree `live`), nie z katalogu, w którym piszesz kod: hooki i serwer MCP czytają pliki `.ts` prosto z katalogu instalacji, więc zmiana gałęzi albo niedokończona edycja od razu zmienia pamięć wszystkich sesji (docs/MIGRACJA.md, „Worktree live”).
- Nie commituj baz, `.env`, `plugin/hooks/hooks.json` ani `plugin/.mcp.json` (generowane przez `hipokamp install` ze ścieżkami tej maszyny).
- Dokumentacja rozjechana z kodem jest poprawiana w tym samym PR co kod.
