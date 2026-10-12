# Migracja z claude-mem

Przejście jest odwracalne na każdym kroku. claude-mem i jego dane (`~/.claude-mem`) zostają nietknięte: importer czyta bazę tylko do odczytu, a instalacja wyłącza plugin claude-mem, nie usuwa go.

## Co się przenosi

| claude-mem | hipokamp | uwagi |
|---|---|---|
| `observations` | `observations` | **te same numery `#id`**. Typy generowane przez LLM (ponad 700 wariantów) sprowadzone do zbioru kanonicznego, oryginał zostaje w `meta`. Numer zajęty przez notatkę hipokampa: nowy numer, stary w `meta.cm_id` |
| `session_summaries` | `summaries` | te same numery, przy kolizji jak wyżej |
| `sdk_sessions` | `sessions` | |
| `user_prompts` | `prompts` | |
| `work_state_entries` | `work_state` | otwarte listy pracy dalej pokazują się na starcie sesji |
| pliki i pojęcia z notatek | `entities`, `obs_entities` | graf budowany przy imporcie |
| suma `discovery_tokens` | `meta.cm_discovery_tokens` | do porównań kosztu |

Czego importer nie kopiuje:

- **Surowych `tool_uses`** (ok. 145 tys. wierszy, większość objętości bazy claude-mem). Zostają w bazie claude-mem, a `get_tool_uses` czyta je stamtąd na żądanie (tylko odczyt).
- **Wektorów Chromy.** Hipokamp liczy własne (bge-m3) lokalnie: `hipokamp embed`.
- **Ustawień z kluczami API.** Hipokamp nie potrzebuje żadnego LLM ani klucza.
- **Sesji obserwatora** (`~/.claude/projects/*claude-mem-observer*`). To rozmowy samego claude-mem z modelem, nie Twoja praca; są wykluczone także z backfillu.

Import jest przyrostowy: drugi raz dociąga tylko to, co przybyło od poprzedniego (stan w `meta.cm_last_*`). Notatkę już zaimportowaną rozpoznaje numer i czas utworzenia albo hash, także pod nowym numerem. Taka notatka jest pomijana. Wpis listy pracy pamięta swój numer z claude-mem (`cm_id`, migracja 4), więc import od zera go nie dubluje, a wpis z wcześniejszego importu bez numeru dostaje go przy następnym imporcie. Kursor przesuwa się w tej samej transakcji co zapis partii. Teksty z claude-mem, ścieżki plików, pojęcia, klucze encji i listy pracy przechodzą przez tę samą redakcję sekretów co zapis hipokampa.

Przestrzeń numerów: nowe notatki i podsumowania hipokampa dostają numery od 10 000 001, więc numery, które claude-mem nada w okresie przejściowym, zostają wolne dla importu. Baza założona wcześniejszą wersją dostaje ten próg przy pierwszym otwarciu do zapisu (migracja 3).

## Kroki

1. Przygotowanie (repo i komenda `hipokamp`):

   ```bash
   bun install
   bun link
   ```

2. Podgląd importu bez zapisu (baza tylko do odczytu, bez migracji), potem import:

   ```bash
   hipokamp import-claude-mem --dry-run
   hipokamp import-claude-mem
   ```

   Import ponad 100 tys. notatek trwa ok. 2 minuty. Inna lokalizacja bazy: `--db <ścieżka>` albo `CLAUDE_MEM_DB`.

3. Sesje, których claude-mem nie zapisał (awaria workera, wyczerpany limit obserwatora, sesje sprzed instalacji):

   ```bash
   hipokamp backfill
   ```

   Tury już opisane przez claude-mem (prompt o tym samym tekście, do 10 minut różnicy, z notatką claude-mem) są pomijane. Ok. 1300 transkryptów (5 GB) przechodzi w ok. 2 minuty. Zakres można zawęzić: `--since 2026-09-01`.

   Baza założona wersją 0.1 (import i backfill sprzed poprawek numeracji tur i kolizji numerów) wymaga jednorazowej naprawy:

   ```bash
   hipokamp repair --dry-run
   hipokamp repair
   ```

   Naprawa wymaga zatrzymanego workera (`hipokamp stop`) i zamkniętych sesji Claude Code, przy działającym workerze odmawia. Próba działa zawsze i otwiera bazę tylko do odczytu. Naprawa dociąga notatki claude-mem pominięte przy kolizji numerów. Notatka tury opisanej już przez claude-mem dostaje status `merged` z odsyłaczem do najbardziej podobnej notatki claude-mem tej tury, ale tylko powyżej progu podobieństwa; poniżej obie zostają aktywne. Ślady użycia (dostępy i wstrzyknięcia) przechodzą na notatkę docelową. Prompty i notatki (także z claude-mem, razem z ich podsumowaniami) dostają numery tur z transkryptu, licznik promptów sesji razem z `meta.n`. Prompt claude-mem bez tury w transkrypcie (obieg pętli, wiadomość innej sesji) idzie pod numer 2 000 000 + numer w claude-mem, a numer zastępczy promptu, którego tura ma zajęty numer, to 1 000 000 + numer tury. Podgląd i narzędzia MCP pokazują numer zastępczy jako numer jego tury z dopiskiem „numer zastępczy”, a prompt bez tury jako „bez tury (claude-mem nr n)”; pole `prompt_number` w JSON-ie zostaje liczbą (obok etykieta `prompt_label`). Ponowny import claude-mem trzyma się nowych numerów (`sessions.meta.cm_n`). Klucze plików z importu (ścieżki absolutne, prefiksy `.claude/worktrees/<nazwa>/`) stają się względne wobec katalogu repo projektu, a encje tego samego pliku łączą się. Sesje Codexa i innych harnessów (Cowork, Gemini CLI, Cursor, OpenCode) naprawia się tak samo jak sesje Claude Code. Sekrety są redagowane obecnymi regułami we wszystkich danych (także własnych, zapisanych starszymi regułami), w tym w ścieżkach plików, napisach w `meta` notatek, kluczach encji i listach pracy. Tury, które parser 0.1 zgubił w przeczytanych już transkryptach albo pominął numerem claude-mem, choć claude-mem ich nie opisał, dostają notatki (wektory policzy worker w tle). Przed zmianami robi kopię `pre-repair` w `~/.hipokamp/backups/db` (kopie z tagiem nie podlegają retencji), każdą zmianę zapisuje w `~/.hipokamp/logs/repair-*.jsonl` (przy kluczach plików stary i nowy klucz, `from` i `to`), a drugi przebieg nic nie zmienia. Próby generalne na kopii bazy znalazły wcześniej dwa przypadki, w których drugi przebieg nie dawał zera (prompt z samych symboli, klucz tury powtórzony w transkrypcie); oba są poprawione i mają testy.

   Baza naprawiona już wcześniejszą wersją dostaje nowe kroki tym samym poleceniem, bo naprawa jest idempotentna: robi tylko to, czego jeszcze nie zrobiono. Kolejność:

   ```bash
   hipokamp stop                     # i zamknąć sesje Claude Code
   hipokamp repair --dry-run         # podgląd, baza tylko do odczytu
   hipokamp repair                   # kopia pre-repair, potem zmiany i dziennik
   hipokamp repair --dry-run         # kontrola: „zmian razem: 0”
   hipokamp start
   ```

   **Najpierw `repair` (i `project merge`), potem `sync`.** Obie komendy zmieniają wiersze już zapisane: numery promptów, `prompt_n` notatek, klucze projektów i plików. Synchronizacja z hubem wysyła tylko wiersze jeszcze niewysłane, więc naprawa po pierwszym `hipokamp sync push` zostawiłaby na innych komputerach stare numery i ścieżki absolutne. Dlatego przy śladzie synchronizacji w bazie (`meta.sync_hub`, plik `~/.hipokamp/state/sync.json` albo wiersze `sync_map`) obie komendy odmawiają zapisu (kod 1, bez kopii i zmian) i wyjaśniają dlaczego; próba (`--dry-run`) tylko ostrzega. Zapis na bazie już zsynchronizowanej to świadoma decyzja: `--force-sync-warning` (zmiany wierszy wysłanych wcześniej nie dotrą wtedy do innych komputerów).

   Nowe w tej wersji: numery promptów i notatek claude-mem (punkt b), odciski plików odzyskanych notatek (punkt d, tylko dla tur odzyskanych od teraz) i klucze plików względem repo (punkt e). Próba (`--dry-run`) przewiduje przebieg właściwy, a drugi przebieg nic nie zmienia. Gdy baza claude-mem jest i brakuje w hipokampie jej wpisów (punkt a), próba ich nie wstawia, więc punkt b przebiegu właściwego może pokazać więcej notatek za promptem i więcej zmian (raport próby mówi to wprost); kontrolą jest wtedy druga próba po naprawie.

   Klucze złożone `repo/worktree` z importu claude-mem (hipokamp daje worktree klucz repo, ARCHITEKTURA, sekcja 2) scala osobna komenda:

   ```bash
   hipokamp project merge --worktrees --dry-run
   hipokamp project merge --worktrees
   ```

   Cel każdego klucza to klucz, który hipokamp liczy dziś dla katalogu sesji. Katalog pochodzi z kolumny `cwd` albo z początku transkryptu. Przed zmianami komenda robi kopię `pre-project-merge`, każdą zmianę zapisuje w `~/.hipokamp/logs/project-merge-*.jsonl`, a drugi przebieg nic nie zmienia. Próba otwiera bazę tylko do odczytu.

   Import claude-mem kieruje klucze przez zapisane scalenia, więc scalony klucz nie wraca przy kolejnym imporcie. Nowy klucz złożony (worktree założony w claude-mem po scaleniu) scala dopiero kolejne `hipokamp project merge --worktrees`. Lista kluczy: `hipokamp project list`, pojedyncze scalenie: `hipokamp project merge <from> <into>`. Scalenie normalizuje też klucze plików źródła względem repo celu (jak krok e naprawy), a otwarte sesje Claude Code widzą nowy klucz od następnego wywołania narzędzia hipokampa, bez restartu.

   Podejrzane klucze z importu claude-mem (claude-mem przypisywał czasem pamięć do fragmentu słowa albo katalogu zbiorczego, np. `prze` z tysiącami notatek w jednej sesji, `do`, `we`, `dod`, `stw`, `prz`, a z katalogów zadań Codexa `System32` i `code`) nie są scalane automatycznie. Kontener projektów (katalog domowy, tymczasowy, konfiguracji Claude, korzeń dysku, `System32` i katalog z podprojektami, jak `D:/code`; ta sama reguła co przy katalogu startowym sesji) nie jest korzeniem projektu dla kluczy plików: pliki innych repo zapisane pod kluczem `code` zostają absolutne, a ręczne scalenie z właściwym repo sprowadza je do kluczy względnych tego repo. Lista do oceny, z liczbą notatek, katalogami sesji i trzema najnowszymi tytułami:

   ```bash
   hipokamp project list --suspicious
   ```

   Dla każdego klucza z listy decyzja należy do człowieka. Gdy tytuły i katalogi wskazują jeden projekt, scalenie ręczne:

   ```bash
   hipokamp project merge prze <projekt> --dry-run
   hipokamp project merge prze <projekt>
   ```

   Próba pokazuje, co przejdzie (notatki, sesje, encje, wektory, klucze plików). Po pierwszej synchronizacji scalenie wymaga `--force-sync-warning` (zasada „najpierw porządki, potem sync” wyżej). Klucz, w którym pamięć z kilku projektów jest wymieszana, albo taki, który jest prawdziwym projektem, zostaje: lista dalej go pokazuje, ale nic się z nim nie dzieje. Scalenie robi kopię `pre-project-merge` i dziennik jak wyżej, a cofnięcie to `hipokamp restore <kopia>` przy zatrzymanym workerze.

4. Wektory (na GPU, jeśli jest):

   ```bash
   hipokamp embed --device dml --dtype fp16
   ```

   Bez GPU: `--device cpu --dtype q8`. Krok można pominąć: worker dolicza brakujące wektory sam, w tle. Do tego czasu wyszukiwanie działa na samym BM25.

5. Sprawdzenie trafności na własnych danych (opcjonalnie):

   ```bash
   hipokamp eval
   ```

6. Ostatni import tuż przed przełączeniem (dociąga notatki, które claude-mem zapisał w międzyczasie), potem instalacja:

   ```bash
   hipokamp import-claude-mem
   hipokamp install --replace-claude-mem
   ```

   Instalacja: przy `hooks.mode` `auto` albo `native` buduje natywny hook (`scripts/build-native.*`), gdy jest Go, a pliku brak albo ma inną wersję; generuje `plugin/hooks/hooks.json` (tryb `native` tylko po udanym teście dymnym pliku z tego repo, inaczej `command`; zmiana `hooks.mode` działa po kolejnym `install`, bo nowy hooks.json wymusza nową kopię pluginu w cache) i `plugin/.mcp.json` z absolutnymi ścieżkami, robi kopię `settings.json`, `installed_plugins.json` i `known_marketplaces.json` do `~/.hipokamp/backups/<czas>/`, dodaje lokalny marketplace tego repo (zarejestrowany z innego katalogu przepina, sekcja „Worktree live”), instaluje i włącza plugin `hipokamp@hipokamp`, wyłącza `claude-mem@thedotmack` i zadanie harmonogramu `claude-mem-watchdog` (nie miałoby czego pilnować). Podłącza też wykryte harnessy (Gemini CLI, Antigravity, Cursor, OpenCode, Claude Desktop): serwer MCP hipokampa, a w Gemini CLI i Cursorze hooki zapisu sesji, w OpenCode plugin (README, „Inne harnessy”); kopie ich plików konfiguracji idą do tego samego katalogu kopii, pominięcie jednego: `--no-<harness>`. Wpis serwera pod kluczem `hipokamp` dopisany wcześniej ręcznie jest podmieniany na ścieżki z bieżącego repo, nie dublowany, a `rollback` oddaje mu poprzednią wartość (wpis pod inną nazwą zostaje i trzeba go usunąć ręcznie). Zapis sesji podłączonych harnessów rusza od tej instalacji, nie od samego wykrycia. Plan bez zmian: `--dry-run`.

   Po instalacji: kopia ustawień w `~/.hipokamp/backups/<czas>/`, plugin zainstalowany i włączony, claude-mem wyłączony. Worker claude-mem działa dalej na porcie 37777: wyłączenie pluginu go nie zatrzymuje, a dane w `~/.claude-mem` zostają.

7. Diagnoza:

   ```bash
   hipokamp doctor
   ```

8. Nowa sesja Claude Code (bieżące sesje mają jeszcze stare hooki). Na starcie w kontekście powinien być nagłówek `# Pamięć: <projekt> (hipokamp)`. Podgląd: `hipokamp open` (otwiera przeglądarkę z jednorazowym linkiem; sam adres http://127.0.0.1:47777 bez ciasteczka pokazuje tylko instrukcję wejścia).

9. Na maszynie, na której rozwijasz hipokampa: przeniesienie pluginu do worktree `live` (następna sekcja).

## Worktree live

Kopia pluginu w cache Claude Code (`~/.claude/plugins/cache/hipokamp/…`) ma w `hooks/hooks.json` i `.mcp.json` absolutne ścieżki do repo, z którego zrobiono `hipokamp install`. Hooki, serwer MCP, worker (autostart) i hooki Codexa uruchamiają więc pliki `.ts` prosto z tego katalogu. Gdy to katalog roboczy (np. `~/hipokamp`), zmiana gałęzi, niedokończona edycja albo błąd składni od razu zmienia pamięć wszystkich otwartych sesji (TASKS.md, T-31). Plugin działa więc z osobnego worktree na lokalnej gałęzi `live`, który zmienia się tylko przez `hipokamp update`; kod piszemy w `~/hipokamp` albo w osobnych worktree, nigdy w `~/hipokamp-live`.

Jedyne, co poza `git` powstaje w `hipokamp-live`, to artefakty budowane przez same komendy hipokampa: `node_modules` (`bun install` w `update`) i natywny hook (`scripts/build-native.*`, wynik w `native/hook/`), który budują `hipokamp install` i `hipokamp update`, odkąd repo go ma. Nikt nie uruchamia tam tych skryptów ręcznie ani nie edytuje kodu; artefakty są w `.gitignore`, więc drzewo zostaje czyste, a `update` nie odmawia.

`hipokamp doctor` pokazuje, z którego katalogu działa plugin (ścieżka z hooks.json kopii w cache), i ostrzega, gdy to nie jest czysty checkout `live` albo `main`, gdy ma niezacommitowane zmiany, gdy jest za `origin/main` (według ostatniego `fetch`), gdy komenda `hipokamp` działa z innego katalogu niż plugin albo gdy kopia pluginu w cache Claude Code różni się od `plugin/` w katalogu marketplace (wypisuje pliki inne, brakujące, zbędne i nieczytelne; sesje dostają hooki, skille i MCP z kopii, nie z repo). Osobno sprawdza hooks.json z kopii w cache: tryb, a dla `native` plik z komendy (czy jest, test dymny, wersja) i zgodność z `hooks.mode` w config.

### Utworzenie i przepięcie (jednorazowo)

Przy zamkniętych albo bezczynnych sesjach Claude Code i Codexa (przez kilka sekund przepinania plugin jest odinstalowany):

```powershell
git -C ~/hipokamp fetch origin
git -C ~/hipokamp worktree add -b live ~/hipokamp-live origin/main
cd ~/hipokamp-live
bun install --frozen-lockfile
bun link
hipokamp doctor          # „komenda hipokamp działa z ~/hipokamp-live, a plugin z ~/hipokamp” = bun link zadziałał
hipokamp install --dry-run
hipokamp install
hipokamp restart
hipokamp doctor
```

- `bun link` w `hipokamp-live` przestawia globalną komendę `hipokamp` na ten katalog. Jeśli `doctor` dalej pokazuje komendę z `~/hipokamp`, wykonaj `bun unlink` w `~/hipokamp` i ponownie `bun link` w `hipokamp-live`.
- `install` bez `--replace-claude-mem`: zastąpienie claude-mem jest już zapisane w stanie instalacji i kolejne instalacje go nie zmieniają.
- `install` widzi w `known_marketplaces.json`, że marketplace `hipokamp` wskazuje `~/hipokamp`, i przepina go: kopia `settings.json`, `installed_plugins.json` i `known_marketplaces.json` do `~/.hipokamp/backups/<czas>/`, `claude plugin validate` repo i `plugin/` (zepsuty manifest kończy pracę bez żadnej zmiany), potem `claude plugin marketplace remove hipokamp`, `marketplace add ~/hipokamp-live`, `plugin install` i `plugin enable hipokamp@hipokamp`. Claude Code nie odświeża kopii pluginu tej samej wersji (`marketplace update`, `plugin install` i `plugin update` zostawiają ją bez zmian), więc gdy drzewo kopii w cache różni się od `plugin/` (hooki, skille, manifest; bez danych Claude Code jak `.in_use/` i `.orphaned_at`), plugin jest instalowany od nowa (`plugin uninstall --keep-data`, `install`, `enable`). Przed `uninstall` katalog kopii i wpis z `installed_plugins.json` trafiają do kopii zapasowej (`~/.hipokamp/backups/<czas>/plugin-cache`). Gdy `uninstall` nie przejdzie (wtedy `install` odpowiada „already installed” i niczego nie podmienia), instalacja nie przejdzie albo kopia po niej dalej różni się od `plugin/` (także plik nieczytelny, np. zablokowany przez inny proces), `install` przywraca stan sprzed próby i kończy się błędem z listą różnic i komendą naprawczą. Katalog kopii wraca przez kopię obok (`<wersja>.hipokamp-nowy`) i zmianę nazwy, z ponowieniami przy chwilowej blokadzie; gdy i to nie wyjdzie, komunikat podaje ścieżkę kopii zapasowej. Gdy nowy katalog się nie przyjmie, `install` wraca do starego i kończy się błędem; gdy i powrót nie wyjdzie, stary katalog zostaje zapisany w stanie (`marketplace.previous`, `marketplace.failed`). Udana instalacja to wpis w `installed_plugins.json` i włączenie, nie samo `enabledPlugins` (`plugin enable` przechodzi też dla niezainstalowanego pluginu; `doctor` sprawdza oba). Przepięcie trafia do `~/.hipokamp/state/install.json` (`marketplace.path`, `marketplace.previous`, `marketplace.relocatedAt`).
- Ta sama komenda przepina hooki i serwer MCP Codexa (Codex poprosi o zatwierdzenie zmienionych hooków), wpisy hipokampa w innych harnessach (serwer MCP, hooki Gemini CLI i Cursora, plugin OpenCode: stary wpis podmieniony, nie zdublowany) i zadanie `hipokamp-worker` na ścieżki z `hipokamp-live`. `hipokamp restart` zamienia działającego workera na proces z nowego katalogu.
- Na końcu `doctor` powinien pokazać `✓ plugin działa z czystego checkoutu ~/hipokamp-live (gałąź live, …)` i żadnego ostrzeżenia o katalogu. Nowe sesje Claude Code używają już `hipokamp-live`; otwarte sesje mają stare hooki do restartu.
- `~/hipokamp` zostaje bez zmian i wraca do roli zwykłego katalogu roboczego.

### Aktualizacja

Po scaleniu PR do `main`:

```powershell
hipokamp update --dry-run   # fetch i lista nowych commitów, bez zmian w drzewie
hipokamp update
```

`update` działa w katalogu, z którego działa komenda `hipokamp` (po `bun link`: `hipokamp-live`). Kolejno: sprawdza, że drzewo jest czyste i stoi na `live` albo `main` (inaczej odmawia), `git fetch origin`, odmawia, gdy gałąź ma commity spoza `origin/main`, `git merge --ff-only origin/main`, `bun install --frozen-lockfile`, gdy zmienił się `bun.lock` albo `package.json` (po błędzie `git reset --keep` na poprzedni commit i ponowne `bun install` starego lockfile, żeby hooki nie startowały z kodu bez zależności). Zmiana bibliotek natywnych (`sqlite-vec`, ONNX Runtime) na Windows wymaga zamkniętych sesji Claude Code i Codexa oraz `hipokamp stop`: serwery MCP i worker trzymają te pliki otwarte, więc `bun install` przy otwartych sesjach się nie uda, a `update` wróci do poprzedniej wersji (workera zatrzymuje sam przed `bun install`, a gdy działają procesy `bun …/src/mcp/server.ts` z tego katalogu, ostrzega i podaje ich liczbę, ale nie odmawia). Drugi etap uruchamia już nowy kod (`hipokamp update --finish <commit>`): gdy `hooks.mode` to `auto` albo `native`, a zmieniły się źródła natywnego hooka (`native/hook/`) albo plik nie przechodzi testu dymnego (brak, inna wersja niż `NATIVE_VERSION`), przebudowuje go przez `scripts/build-native.*` (z Go; bez Go ostrzega, a hooki idą przez Buna, bo stary plik z nową wersją kodu odpada w teście dymnym i `hooks.json` dostaje tryb `command`); potem generuje pliki pluginu, a gdy pliki pluginu się zmieniły albo kopia w cache jest nieaktualna, robi kopię ustawień Claude Code i odświeża rejestrację (z tymi samymi zabezpieczeniami co `install`); potem restartuje workera i pokazuje `doctor`. Kod hooków działa od razu po scaleniu, zmiana plików pluginu (nowe zdarzenia hooków, skille) od nowych sesji.

Gdy drugi etap się nie uda (np. worker nie wstał albo rejestracja nie przeszła), `update` wypisuje commit sprzed scalenia i komendy: dokończenie (`hipokamp update` powtarza niedokończony drugi etap, stan w `~/.hipokamp/state/update.json`) albo powrót (`git -C ~/hipokamp-live reset --keep <commit>`, potem `hipokamp install` i `hipokamp restart`).

### Powrót do katalogu roboczego

```powershell
cd ~/hipokamp
bun link
hipokamp install
hipokamp restart
```

`install` z `~/hipokamp` przepina marketplace z powrotem (te same zabezpieczenia). Worktree `hipokamp-live` można potem usunąć: `git -C ~/hipokamp worktree remove ~/hipokamp-live` i `git -C ~/hipokamp branch -D live`.

## Nazwy narzędzi MCP

Nazwy narzędzi są te same, zmienia się prefiks serwera:

| claude-mem | hipokamp |
|---|---|
| `mcp__plugin_claude-mem_mcp-search__search` | `mcp__plugin_hipokamp_hipokamp__search` |
| `mcp__plugin_claude-mem_mcp-search__get_observations` | `mcp__plugin_hipokamp_hipokamp__get_observations` |
| (i tak dalej dla każdego narzędzia) | |

Skille, polecenia i pliki `CLAUDE.md`, które wymieniają pełne nazwy z prefiksem claude-mem, trzeba przepisać na nowy prefiks. Odwołania do `#id` działają bez zmian.

## Ustawienia claude-mem i ich odpowiedniki

Klucze z `~/.claude-mem/settings.json`, odpowiedniki w `~/.hipokamp/config.json`:

| claude-mem | hipokamp | uwagi |
|---|---|---|
| `CLAUDE_MEM_WORKER_PORT` (37777) | `port` (47777) | różne porty: oba systemy mogą działać równolegle w okresie przejściowym |
| `CLAUDE_MEM_DATA_DIR` | `HIPOKAMP_HOME` | |
| `CLAUDE_MEM_CLAUDE_CONFIG_DIR` | `CLAUDE_CONFIG_DIR` | ta sama zmienna co w Claude Code |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` (30) | `context.sessionStartBudget` (1600 tokenów) | budżet w tokenach zamiast liczby notatek |
| `CLAUDE_MEM_CONTEXT_FULL_COUNT` (3) | `context.fullCount` (3) | |
| `CLAUDE_MEM_CONTEXT_SESSION_COUNT` | `context.recentSessions` (3) | |
| `CLAUDE_MEM_SEMANTIC_INJECT` (false), `..._LIMIT` (5) | `context.promptRecall` (true), `context.promptBudget`, `context.promptMinScore` | przypominanie przy prompcie z progiem pewności |
| `CLAUDE_MEM_EXCLUDED_PROJECTS` | `capture.excludeProjects` | |
| `CLAUDE_MEM_PROJECT_ENVIRONMENTS`, `CLAUDE_MEM_PROJECT_NAME_SOURCE` (`path`) | brak | klucz projektu jak w trybie `path` (ARCHITEKTURA, sekcja 2); środowisk nazwanych i nazw z `origin` ta instalacja nie używa (stan 2026-10-05) |
| tagi `<private>` i redakcja | `capture.redactSecrets`, `capture.privateTools` | narzędzia sejfu nigdy nie trafiają do pamięci |
| `CLAUDE_MEM_PROVIDER`, `..._MODEL`, klucze OpenRouter, Gemini, OpenAI, tryby kolejki i serwera | brak | zapis nie używa LLM |
| `CLAUDE_MEM_CHROMA_*`, `CLAUDE_MEM_PYTHON_VERSION` | brak | wektory w SQLite, bez Pythona |
| `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` | brak, celowo | pliki `CLAUDE.md` w każdym katalogu były jedną z głównych skarg na claude-mem |
| `CLAUDE_MEM_WELCOME_HINT_ENABLED`, `CLAUDE_MEM_CONTEXT_SHOW_*` | brak | hipokamp nie wyświetla banerów ani promocji |
| `CLAUDE_MEM_TELEGRAM_*` | `notify.*` (domyślnie wyłączone) | powiadomienia o wybranych notatkach tylko lokalnie: dymek Windows, plik JSONL, webhook na 127.0.0.1 albo własne polecenie (np. skrypt, który sam przekaże dalej); bez Telegrama ani innych usług (ARCHITEKTURA, sekcja 11) |

## Okres przejściowy

Można przez jakiś czas zostawić claude-mem włączony i co jakiś czas powtarzać `hipokamp import-claude-mem`. Hipokamp nie pisze do bazy claude-mem, a porty się nie gryzą. Gdy oba pluginy są włączone, oba hooki działają (dwa razy więcej kontekstu na starcie sesji), więc na dłużej lepiej zostawić jeden.

Tura, którą hipokamp opisał wcześniej (hook albo nadrabianie), a claude-mem później (notatka przyszła dopiero z ponownym importem), ma w hipokampie dwie notatki: zapis tury pomija tylko tury, które claude-mem opisał przed nim. Po imporcie w okresie przejściowym wystarczy `hipokamp repair` (przy zatrzymanym workerze, najpierw `--dry-run`): krok b oznacza notatkę hipokampa jako `merged` ze wskazaniem notatki claude-mem (numery zostają, nic nie znika twardo). Warunki: transkrypt sesji jeszcze istnieje (Claude Code kasuje je domyślnie po 30 dniach), prompt tury paruje się z promptem claude-mem po tekście i czasie, a któraś aktywna notatka claude-mem tej tury mówi to samo (podobieństwo co najmniej `MERGE_MIN`: cosinus wektorów bge-m3 0,78, bez wektorów co najmniej połowa rdzeni słów). Inaczej obie notatki zostają aktywne. Po wyłączeniu claude-mem (od 2026-10-05) nowe notatki claude-mem nie powstają, więc problem dotyczy tylko powrotu do pracy równoległej.

## Powrót

```bash
hipokamp rollback
```

Wyłącza plugin hipokampa, włącza z powrotem claude-mem (o ile był włączony przed instalacją) i zadanie `claude-mem-watchdog`. Usuwa też hooki i serwer MCP hipokampa z Codexa, wpisy hipokampa z innych harnessów podłączonych przez `install` (serwer MCP, hooki Gemini CLI i Cursora, plugin OpenCode; pliki i klucze założone przez instalację znikają, wpis `hipokamp` sprzed instalacji zostaje albo wraca do swojej wartości, z kopią w `~/.hipokamp/backups/<czas>/`; zapis sesji tych harnessów staje) oraz zadanie `hipokamp-worker`; plugin claude-mem w Codexie (`[plugins."claude-mem@claude-mem-local"] enabled`) trzeba włączyć ręcznie. Działa od nowych sesji. Dane obu systemów zostają. Kopie ustawień Claude Code sprzed instalacji leżą w `~/.hipokamp/backups/<czas>/`.


## Zalecenie: dłuższe życie transkryptów

Claude Code domyślnie usuwa transkrypty po 30 dniach (`cleanupPeriodDays`). Notatki hipokampa zostają, ale `get_tool_uses` dla starszych notatek nie ma już skąd czytać surowych wywołań, a `backfill` nie odtworzy usuniętych sesji. Warto ustawić w `~/.claude/settings.json` np. `"cleanupPeriodDays": 365`.
