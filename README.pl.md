# hipokamp

[English](README.md) · **Polski**

Darmowa, lokalna pamięć długoterminowa dla Claude Code. Zastępuje claude-mem bez utraty danych: przejmuje jego bazę wiedzy (numery `#id` zostają te same), udostępnia narzędzia MCP o tych samych nazwach i parametrach, a do zapisu notatek nie potrzebuje żadnego modelu językowego. Działa wyłącznie na tej maszynie, bez kont, telemetrii i chmury.

Nazwa pochodzi od hipokampa, części mózgu, która zamienia przeżyte epizody w trwałą pamięć. Tu epizodem jest tura rozmowy z Claude Code.

## Dlaczego nie claude-mem

Liczby zmierzone na komputerze autora (Windows 11, Bun 1.3.14, październik 2026) albo przytoczone ze zgłoszeń w repo claude-mem.

| | claude-mem 13.29 | hipokamp 0.1 |
|---|---|---|
| Zapis notatki | wywołanie LLM (obserwator) przy każdej turze; u jednego użytkownika +63,9% kosztu kodowania | deterministyczny skrót tury z transkryptu, **0 zł** |
| Gdy limit obserwatora się wyczerpie | nic się nie zapisuje („inference allowance exhausted”) | zapis nie zależy od żadnego limitu |
| Opóźnienie hooka na Windows | mediana 1842 ms na PostToolUse ([#3449](https://github.com/thedotmack/claude-mem/issues/3449)) | hook Buna p50 155 ms (post-tool), 252 ms (prompt), z czego ok. 80 do 190 ms to start Buna; hook natywny (`hooks.mode: native`) z działającym workerem p50 29 ms i 33 ms (baza testowa, 3000 notatek; [pomiar](docs/ARCHITEKTURA.md#hooki-tryby-wywołania-hooksmode)) |
| Procesy potomne | chroma-mcp, uvx; osierocone gniazda na porcie ([#3482](https://github.com/thedotmack/claude-mem/issues/3482)) | zero; jeden proces workera |
| Wyszukiwanie | Chroma (Python przez uvx) albo samo FTS5 | FTS5 z polską fleksją i literą ł + wektory bge-m3 (lokalnie) + RRF |
| Przypominanie | start sesji, odczyt pliku; przy prompcie tylko opcja `CLAUDE_MEM_SEMANTIC_INJECT` (domyślnie wyłączona) | start sesji, każdy prompt (tylko przy pewnym trafieniu, domyślnie włączone), odczyt i edycja pliku |
| Telemetria, konto, promocja Pro | PostHog domyślnie włączony, linia Pro w każdym starcie sesji | brak |
| Usuwanie wspomnień | dodane po 9 miesiącach | `forget` od pierwszej wersji, z cofnięciem |
| Import historii | brak backfillu z transkryptów | `backfill` z `~/.claude/projects` |
| Trafność na danych autora (nDCG@10, `hipokamp eval`) | 22,1% (kontekst startowy), 31,0% (wyszukiwanie FTS5) | 37,7% |

Migracja dużej bazy (ponad 100 tys. notatek z claude-mem i 5 GB transkryptów) trwa kilka minut, a pierwsze liczenie wektorów na GPU (DirectML fp16) niecałą godzinę. Baza hipokampa z wektorami jest ok. 2,5 raza mniejsza od bazy claude-mem.

## Szybki start

Wymagania: [Bun](https://bun.sh) 1.3+, Claude Code z obsługą pluginów. GPU niepotrzebne (przyspiesza tylko pierwsze liczenie wektorów).

```bash
bun install
bun link
```

Po `bun link` komenda `hipokamp` działa w każdym terminalu (inaczej: `bun src/cli.ts <komenda>`). Jeśli na tej maszynie będziesz też zmieniać kod hipokampa, rób to od razu w osobnym worktree `live` (niżej, „Plugin działa z osobnego worktree”).

```bash
hipokamp import-claude-mem
```

Kopiuje bazę claude-mem (`~/.claude-mem/claude-mem.db`, tylko odczyt, przyrostowo). Źródło zostaje nietknięte.

```bash
hipokamp backfill
```

Dopisuje notatki z transkryptów sesji, których claude-mem nie zapisał. Tury już opisane przez claude-mem są pomijane.

```bash
hipokamp embed --device dml --dtype fp16
```

Liczy wektory na GPU przez DirectML. Bez GPU: `--device cpu --dtype q8` (wolniej, ale też działa). Można to też zostawić workerowi, który dolicza wektory w tle.

```bash
hipokamp install --replace-claude-mem
```

Instaluje plugin (hooki + serwer MCP) z lokalnego marketplace tego repo, robi kopię ustawień Claude Code i wyłącza plugin claude-mem. Dane claude-mem zostają na dysku. Działa od nowych sesji. Najpierw można sprawdzić plan: `--dry-run`.

`--replace-claude-mem` sprząta też claude-mem w innych harnessach, żeby sesje nie szły do pamięci dwa razy: zdejmuje jego hooki z `~/.cursor/hooks.json` (tylko skrypt workera claude-mem, cudze hooki zostają) i przenosi jego plugin `plugins/claude-mem.js` z katalogu OpenCode do `~/.hipokamp/backups/<czas>/opencode-plugins/`. Przed zmianą idzie kopia pliku, a `hipokamp rollback` wstawia hooki z powrotem na ich miejsca i odkłada plugin.

Szybsze hooki (opcjonalnie, potrzebne Go): gdy jest Go, `hipokamp install` sam buduje `native/hook/hipokamp-hook.exe` (`scripts/build-native.ps1` albo `.sh`) i wpisuje go do hooków (`hooks.mode: auto`), a `hipokamp update` przebudowuje go, gdy zmienią się jego źródła. Hook natywny startuje w ok. 20 ms zamiast ok. 80 ms samego Buna i zostawia pracę workerowi; gdy worker nie odpowiada albo plik zniknie, działa hook Buna jak dotąd, a `hipokamp doctor` podpowie `hipokamp install`. Bez Go nic się nie zmienia: hooki idą przez Buna.

Ta sama komenda podłącza Codexa (`~/.codex`): hooki SessionStart, UserPromptSubmit, PostToolUse (przypominanie przy pliku zmienianym łatką) i Stop w `hooks.json` (dopisane na końcu list, cudze hooki zostają na swoich pozycjach) i serwer MCP w `config.toml`. Codex przy następnym starcie poprosi o zatwierdzenie nowych hooków. Sesje Codexa trafiają do tej samej pamięci: hook Stop czyta rollout (`~/.codex/sessions/RRRR/MM/DD/rollout-*.jsonl`), a nadrabianie i `backfill` dociągają resztę. Pomijane są wątki podagentów (strażnik zgód, `thread_spawn`) i historia zaimportowana z Claude Code (już jest w pamięci). Na Windows `install` rejestruje też zadanie Harmonogramu `hipokamp-worker` (worker przy logowaniu, bez okna konsoli); z `workerIdleExitMin: 0` worker działa stale. Bez Codexa: `--no-codex`, bez autostartu: `--no-autostart`.

Ta sama komenda podłącza też inne harnessy, ale tylko te, które są na tej maszynie (ich katalog konfiguracji istnieje): wszędzie dopisuje serwer MCP hipokampa (czytanie pamięci i `remember`), a tam, gdzie da się czytać sesje, także ich zapis. Pliki konfiguracji zmienia punktowo: cudze wpisy, komentarze (JSONC), wcięcia i końce linii zostają, a przed zmianą kopia idzie do `~/.hipokamp/backups/<czas>/`. Sesje z innych harnessów mają klucz z przedrostkiem (`gemini:`, `cursor:`, `opencode:`, `desktop:`), więc nie mieszają się z sesjami Claude Code i Codexa, i przechodzą przez ten sam zapis (maskowanie sekretów, narzędzia z `capture.privateTools` bez wejścia i wyniku także pod nazwami innych harnessów, projekt z katalogu, nadrabianie, `backfill`). Zapis sesji harnessu rusza dopiero po `install`, który go podłączył (sama obecność harnessu na maszynie nie wystarcza), i staje po `rollback`.

| harness | MCP | zapis sesji |
|---|---|---|
| Gemini CLI (`~/.gemini/settings.json`) | tak | hooki SessionStart, BeforeAgent, AfterTool, AfterAgent, PreCompress i SessionEnd oraz sesje z `~/.gemini/tmp/*/chats/session-*.jsonl` (bez podagentów) i starsze `session-*.json` (czytane w całości po 12 h ciszy pliku); tura cofnięta w Gemini CLI (`$rewindTo`) nie trafia do pamięci, a jej notatka zapisana wcześniej idzie do archiwum |
| Cursor (`~/.cursor/mcp.json`, `hooks.json`) | tak | hooki sessionStart (kontekst), postToolUse (przypomnienie przy czytanym albo zmienianym pliku), stop i sessionEnd oraz transkrypty agenta z `~/.cursor/projects/*/agent-transcripts` (`.jsonl` i starsze `.txt`) |
| OpenCode (`~/.config/opencode/opencode.json[c]`) | tak | plugin `plugins/hipokamp.js`: po każdym zatrzymaniu sesji pobiera jej wiadomości przez SDK OpenCode do `~/.hipokamp/transcripts/opencode/` (tekst po maskowaniu sekretów, narzędzia prywatne bez treści; przeczytane pliki starsze niż `capture.opencodeKeepDays` worker usuwa) i woła hook Stop; kontekst pamięci na start sesji (w prompcie systemowym, stałym przez sesję) i przypomnienie przy prompcie (dopisane do wiadomości) |
| Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`) | tak | sesje Cowork (`local-agent-mode-sessions/…/.claude/projects/*.jsonl`) w projekcie katalogu wybranego w Cowork, a bez niego w projekcie `cowork`; karta Code pisze do `~/.claude`, więc zapisuje ją zwykły plugin |
| Antigravity (`~/.gemini/antigravity*/mcp_config.json`) | tak | nie: rozmowy leżą w SQLite z blobami protobuf bez opisu formatu |

`hipokamp install --dry-run` pokazuje plan per plik bez żadnego zapisu: co dopisze (serwer MCP, hooki według zdarzeń, plugin), co zastąpi (ręczny wpis `hipokamp`, który rollback odda), co zdejmie albo przeniesie (`--replace-claude-mem`) i gdzie pójdzie kopia. Nowe hooki działają od nowych sesji (Gemini CLI, Cursor), plugin OpenCode po jego restarcie. Wyłączenie jednego harnessu: `--no-gemini`, `--no-antigravity`, `--no-cursor`, `--no-opencode`, `--no-claude-desktop` albo `capture.harnesses` w konfiguracji. `hipokamp doctor` pokazuje stan każdego z nich (także „wykryty, niepodłączony” i hooki albo plugin claude-mem, które zostały obok hipokampa), a `hipokamp rollback` zdejmuje wpisy hipokampa: pliki i klucze założone przez instalację usuwa, wpis `hipokamp` dopisany wcześniej ręcznie zostawia (a nadpisany przez instalację wraca do swojej wartości), plik pusty przed instalacją wraca pusty. Hooki dopisane przez użytkownika po instalacji zostają (w Cursorze razem z `version`). Błąd zapisu jednego pliku (np. tylko do odczytu) trafia do komunikatu, a reszta instalacji i rollbacku idzie dalej.

```bash
hipokamp doctor
```

Diagnoza: baza, wektory, worker, hooki, plugin, nic, co mogłoby zablokować prompt. Sprawdza też, z którego katalogu naprawdę działa plugin (ścieżki w kopii pluginu w cache Claude Code) i ostrzega, gdy to nie jest czysty checkout gałęzi `live` albo `main`, gdy jest za `origin/main` albo gdy komenda `hipokamp` działa z innego katalogu niż plugin.

**Plugin działa z osobnego worktree `live`.** Hooki i serwer MCP uruchamiają pliki `.ts` prosto z katalogu, z którego zrobiono `hipokamp install`. Zmiana gałęzi, niedokończona edycja albo błąd składni w tym katalogu od razu zmienia pamięć wszystkich otwartych sesji. Dlatego na maszynie, na której rozwijasz hipokampa, plugin działa z osobnego worktree na gałęzi `live`, a kod piszesz gdzie indziej:

```bash
git -C ~/hipokamp fetch origin
git -C ~/hipokamp worktree add -b live ~/hipokamp-live origin/main
cd ~/hipokamp-live
bun install
bun link
hipokamp install --dry-run
hipokamp install
hipokamp restart
hipokamp doctor
```

`install` wykrywa, że marketplace `hipokamp` jest zarejestrowany z innego katalogu, i przepina go na bieżący (kopia ustawień, wpis w `~/.hipokamp/state/install.json`, powrót do starego katalogu, gdy nowy się nie przyjmie). Szczegóły i powrót: [docs/MIGRACJA.md](docs/MIGRACJA.md#worktree-live).

Aktualizacja po scaleniu PR do `main`:

```bash
hipokamp update
```

W worktree `live`: `git fetch`, `git merge --ff-only origin/main`, `bun install --frozen-lockfile` (tylko gdy zmienił się `bun.lock` albo `package.json`, po zatrzymaniu workera i z ostrzeżeniem, gdy działają serwery MCP hipokampa z tego katalogu; po błędzie drzewo wraca do poprzedniego commitu), potem już nowym kodem: pliki pluginu, odświeżenie kopii pluginu w Claude Code (po `claude plugin validate`, z kopią ustawień i powrotem do poprzedniej kopii przy błędzie), restart workera i `doctor`. Nieudany drugi etap kończy się commitem sprzed scalenia i komendą powrotu, a kolejne `hipokamp update` go powtarza. Odmawia, gdy katalog ma niezacommitowane zmiany, stoi na innej gałęzi niż `live`/`main` albo ma commity spoza `origin/main`. Plan bez scalania: `--dry-run` (sam `fetch` i lista nowych commitów).

Powrót do claude-mem w każdej chwili:

```bash
hipokamp rollback
```

## Jak działa

1. **Zapis bez LLM.** Hooki `Stop`, `PreCompact` i `SessionEnd` czytają transkrypt sesji od zapamiętanego miejsca (offset w bazie). Każda tura zamienia się w jedną notatkę: tytuł i narracja z końcowej odpowiedzi Claude, fakty z wywołań narzędzi (pliki, komendy, błędy, decyzje). Sekrety są maskowane przed zapisem. Transkrypt jest trwałą kolejką: gdy hook zostanie ucięty, worker dociąga zaległości co 10 minut.
2. **Wyszukiwanie hybrydowe.** BM25 (SQLite FTS5 z rdzeniowaniem przez prefiks, więc „wyłączania”, „wyłączaniu” i „wylaczanie” trafiają w to samo) plus wektory bge-m3 liczone lokalnie, połączone przez Reciprocal Rank Fusion. Wektory łapią to, czego prefiks nie złapie (np. „błąd” i „błędy”, synonimy, inny język).
3. **Przypominanie w trzech miejscach.** Na starcie sesji (otwarte listy pracy, ostatnie sesje, najważniejsze notatki pod budżet 1600 tokenów), przy każdym prompcie (tylko gdy pewność trafienia przekracza próg) i przy otwarciu pliku (notatki o tym pliku, z ostrzeżeniem, gdy treść pliku zmieniła się po notatce; sam `git checkout`, który zmienia tylko datę pliku, ostrzeżenia nie daje).
4. **Ranking jak w ludzkiej pamięci.** Aktywacja ACT-R (częste i świeże użycia), rozprzestrzenianie po grafie encji (pliki, pojęcia, narzędzia), ważność, kara za wstrzykiwanie bez użycia, wybór pod budżet tokenów z karą za powtórzenia (MMR).
5. **Sen.** W bezczynności worker scala niemal identyczne notatki, proponuje zastąpienie starszych decyzji i preferencji nowszymi o tym samym temacie, archiwizuje wygasłe, przycina logi, sprząta wektory notatek usuniętych i scalonych, a aktywnym bez wektora binarnego oddaje wektor do przeliczenia. Bez LLM. Zastępowanie z digestu jest ostrożne i domyślnie tylko proponowane (`consolidation.supersedeDigest: "propose"`): pary trafiają do `~/.hipokamp/logs/sleep-RRRR-MM-DD.jsonl` (każda raz, następne sny jej nie powtarzają) i do `hipokamp supersede --dry-run`, a baza zostaje bez zmian; wybrane zatwierdzasz `hipokamp supersede --ids 12,34`. `"apply"` zastępuje, `false` wyłącza; sen czyta `config.json` przy każdym przebiegu, więc zmiana trybu nie wymaga restartu workera. Reguła: zawsze ten sam projekt i typ, starsza nie zmieniała innych plików niż nowsza, tytuły nie różnią się podmianą nazwy (inne repo, projekt, preset; znane projekty z bazy także małą literą i odmienione: „Worker hipokampa” i „Worker sejfa” to dwie decyzje), a temat musi się zgadzać w wektorach: podobny tytuł (te same liczby, wspólny zmieniony plik albo konkretne pojęcie) i cosinus ≥ 0,85 albo to samo konkretne pytanie zadane użytkownikowi i cosinus ≥ 0,75 (ogólne typu „Jak chcesz kontynuować?” się nie liczy). Para bez wektorów czeka na następny sen; przy wyłączonym modelu wektorów zastępuje tylko wspólny zmieniony plik. Przy wspólnym pytaniu podmieniona nazwa nie wetuje, jeśli stoi w odpowiedziach na to pytanie („bge-m3” → „e5-small”, „GitHub” → „Gitea”). Ograniczenia: zmiana wartości zapisana nazwą własną bez wspólnego pytania („Domyślny shell to PowerShell” → „… Bash”) zostaje zawetowana, a zmiana samej wartości liczbowej (port, próg, godzina) nie przechodzi drogą tytułu; obie zapisuj przez `remember` z `key`: ta droga zastępuje zawsze i od razu. Weto rozpoznaje odmianę po pierwszych 5 literach nazwy, więc nazwa z obocznością w rdzeniu („łączka” → „łączce”) może się prześlizgnąć. Cofa `forget` z `undo`. Opcjonalnie (domyślnie wyłączone) lokalny model w Ollamie na 127.0.0.1 szuka sprzecznych decyzji i pisze jednozdaniowe lekcje jako dodatkowe pola notatek, nigdy zamiast nich.
6. **Pamięć automatyczna Claude Code.** `hipokamp import-automemory` pokazuje plan, `--apply` zamienia pliki `~/.claude/projects/*/memory/*.md` w notatki z kluczem projektu jak dla sesji. Od pierwszego `--apply` z domyślnego katalogu worker sam dociąga zmiany (`capture.autoMemory`). Zmieniony plik zastępuje poprzednią notatkę, usunięty idzie do archiwum; notatka zapomniana przez `forget` albo zastąpiona przez `remember` nie wraca. Te notatki są w wyszukiwaniu i przy prompcie, ale nie w kontekście startowym (Claude Code i tak wczytuje `MEMORY.md`).
7. **Powiadomienia (opt-in).** Nowe ważne decyzje, pułapki i preferencje jako dymek Windows, wpis w pliku, webhook na 127.0.0.1 albo własne polecenie, z limitem częstości i grupowaniem. Bez usług zewnętrznych.

Szczegóły i wzory: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md). Migracja krok po kroku: [docs/MIGRACJA.md](docs/MIGRACJA.md).

## Narzędzia MCP

Te same nazwy i parametry co w claude-mem, więc istniejące nawyki, skille i prompty działają bez zmian. Wyniki są zwięzłym markdownem zamiast JSON-a (mniej tokenów, ta sama treść).

| narzędzie | co robi | różnica wobec claude-mem |
|---|---|---|
| `search` | indeks notatek, sesji i promptów (`#id`, data, typ, tytuł, koszt w tokenach) | hybryda BM25 + wektory; bez filtra projektu szuka wszędzie, bieżący projekt wyżej; `includeArchived` dokłada archiwum i notatki zastąpione (ze statusem i odsyłaczem `→ #id` do aktualnej wersji) |
| `timeline` | oś czasu wokół notatki (`#id`, `S<id>`, `P<id>`) albo zapytania | |
| `get_observations` | pełne notatki | ostrzega, gdy plik z notatki zmienił się od tamtej pory |
| `get_tool_uses` | surowe wejście i wyjście narzędzi stojących za notatką | działa też dla notatek zaimportowanych z claude-mem |
| `important_workflow` | opis przepływu w 4 warstwach | |
| `work_state_read`, `work_state_write` | listy zadań i stan pracy, pokazywane na starcie sesji | |
| `session_start_context` | kontekst startowy dla innych klientów | |
| `build_corpus`, `list_corpora`, `prime_corpus`, `reprime_corpus`, `query_corpus`, `rebuild_corpus` | korpusy wiedzy o nazwach | darmowe: ranking zamiast płatnego „knowledge agenta” |
| `smart_search`, `smart_outline`, `smart_unfold` | nawigacja po kodzie (symbole, zarys pliku, rozwinięcie funkcji) | bez tree-sittera i modułów natywnych; tylko w obrębie projektu (korzeń git), bez plików ukrytych (czytane są tylko katalogi `.github`, `.gitea`, `.claude`) i plików z sekretami (`.env`, klucze, `secrets.*` i `credentials.*` z każdym rozszerzeniem, też `secrets.ts` czy `secrets.h`; moduły z rolą jak `credentials.service.ts` są dostępne), bez katalogu konfiguracji Claude Code (`~/.claude` i `CLAUDE_CONFIG_DIR`), wynik przez redakcję sekretów |
| `remember` | jawne zapamiętanie decyzji, pułapki, preferencji; `key` (temat) sprawia, że nowsza decyzja albo preferencja o tym samym kluczu zastępuje starsze | nowe |
| `forget` | miękkie usunięcie (archiwum) z cofnięciem; `undo` przywraca też notatkę zastąpioną (po kluczu, przez sen albo `supersedes`) | nowe |

### Tryb `slim`: mniej tokenów na definicje narzędzi

Klient MCP wysyła modelowi definicję każdego narzędzia (nazwa, opis, JSON Schema parametrów) przy każdym zapytaniu. Claude Code ładuje schematy leniwie (ToolSearch), więc tam 19 narzędzi kosztuje głównie spis nazw. Klienci bez leniwego ładowania (Codex, Cursor, Claude Desktop, inne harnessy) płacą pełne definicje za każdym razem. Dla nich jest tryb `slim`: `"mcp": { "tools": "slim" }` w `~/.hipokamp/config.json` albo `HIPOKAMP_MCP_TOOLS=slim` w środowisku serwera MCP jednego klienta (np. `[mcp_servers.hipokamp.env]` w `config.toml` Codexa).

W trybie `slim` serwer wystawia 4 narzędzia: `search`, `get_observations` i `remember` z krótkimi opisami oraz `memory(cmd, args)` dla reszty. `cmd` to nazwa narzędzia z trybu `compat` (`timeline`, `work_state_write`, `smart_outline`…), `args` jego parametry, więc wskazówki w wynikach i w skillach (`timeline(anchor=ID)`) czyta się wprost jako komendy `memory`. `memory(cmd="help", args={cmd})` zwraca pełny opis komendy. Domyślnie zostaje `compat` (19 narzędzi zgodnych z claude-mem).

Pomiar (`bun spikes/mcp-tools-cost.ts`, pusta baza tymczasowa). Tokenizera Claude nie ma lokalnie, więc dwa przybliżenia: znaki/3,5 i znaki/3,2.

| | `compat` | `slim` |
|---|---|---|
| narzędzia | 19 | 4 |
| definicje (nazwa, opis, schemat) | 11 715 znaków, ok. 3350 do 3650 tokenów | 3726 znaków, ok. 1060 do 1160 tokenów |
| instrukcje serwera (z tym, kiedy sięgać po pamięć) | 610 znaków, ok. 175 do 190 tokenów | 595 znaków, ok. 170 do 185 tokenów |
| sam spis nazw (Claude Code z ToolSearch) | 848 znaków, ok. 240 do 265 tokenów | 164 znaki, ok. 50 tokenów |

Definicje `slim` to 32% kosztu `compat`: ok. 2,3 do 2,5 tys. tokenów mniej w każdym zapytaniu klienta bez leniwego ładowania, ok. 200 tokenów mniej w Claude Code.

## CLI

| komenda | opis |
|---|---|
| `status` | stan workera, bazy, wektorów (także osieroconych) i ostatniego snu (zastąpione, zaproponowane, usunięte i oddane do przeliczenia wektory) oraz tryb zastępowania w śnie |
| `start`, `stop`, `restart` | worker w tle (127.0.0.1:47777) |
| `open [--print]` | podgląd w przeglądarce: jednorazowy link (2 min), który worker zamienia na ciasteczko na 30 dni; `--print` tylko wypisuje link |
| `logs [--n 60]` | końcówka logu workera |
| `search <zapytanie>` | szukanie hybrydowe (`--project`, `--limit`, `--type`) |
| `show <id...>` | pełne notatki |
| `timeline <id>` | oś czasu wokół notatki (`--before`, `--after`) |
| `context` | podgląd kontekstu startowego (`--project`, `--prompt "…"`, `--budget`) |
| `remember "<tekst>"` | zapamiętaj jawnie (`--project`, `--type decision\|gotcha\|preference`, `--key temat`) |
| `recall-stats` | rekomendacja progu przypominania przy prompcie z dziennika decyzji (`--days 14`, `--window 60`, `--min-n 20`, `--threshold`, `--json`); niżej „Strojenie progu” |
| `import-claude-mem` | kopiuje bazę wiedzy claude-mem (`--db`, `--dry-run`) |
| `backfill` | notatki z transkryptów (`--since RRRR-MM-DD`, `--limit`) |
| `embed` | brakujące wektory (`--device dml\|cpu`, `--dtype fp16\|q8`) |
| `sleep [--full] [--llm]` | konsolidacja; `--llm` dokłada etap z lokalnym LLM (gdy `consolidation.llm.enabled`) |
| `supersede [--dry-run \| --ids 12,34]` | zastępowanie starszych decyzji i preferencji z digestu nowszymi (ten sam etap co w śnie, bez względu na tryb snu): pary `#starsza → #nowsza` z powodem; `--dry-run` tylko plan na bazie otwartej do odczytu (`--days 120`, `--json`); `--ids` zatwierdza tylko pary o podanych numerach starszych notatek (z propozycji snu w logu albo z planu; obie notatki muszą być nadal aktywne, reszta zostaje) |
| `import-automemory` | plan importu pamięci automatycznej Claude Code (`~/.claude/projects/*/memory/*.md`); `--apply` zapisuje i od tej chwili worker dociąga zmiany sam, `--all` pokazuje też pliki bez zmian, `--root` inny katalog projektów (import z niego nie włącza nadrabiania w workerze) |
| `export-vault <katalog>` | decyzje i pułapki jako markdown (np. do vaulta Obsidiana), tylko pod jawnie podanym katalogiem; nie nadpisuje plików bez znacznika `hipokamp_export` (`--project`, `--types`, `--per-project`, `--dry-run`) |
| `notify status\|test\|run` | powiadomienia: stan i kolejka, próbna wysyłka przez skonfigurowane kanały, wysyłka teraz |
| `llm check\|run [--max n]` | lokalny LLM: adres, dostępne modele w Ollamie (hipokamp nigdy ich nie pobiera), ręczny przebieg |
| `reindex` | przebudowa indeksów pełnotekstowych |
| `redigest` | ponowny skrót tur z transkryptu po poprawkach parsera (`--all`, `--ids`, `--dry-run`) |
| `repair` | jednorazowa naprawa bazy z wersji 0.1: notatki pominięte przy kolizji numerów, duplikaty tur opisanych przez claude-mem (tylko o tej samej treści), numeracja tur (także promptów i notatek claude-mem), zdublowane prompty, sekrety w danych z claude-mem, tury bez notatki w przeczytanych już transkryptach, klucze plików względem katalogu repo; przy zatrzymanym workerze, kopia `pre-repair` przed zmianami (`--dry-run`, `--db`); przed pierwszym `sync`, potem tylko z `--force-sync-warning` |
| `project list`, `project merge` | klucze projektów z liczbą notatek i sesji, pisowniami i kluczami złożonymi `repo/worktree` z claude-mem (`--json`); `list --suspicious` pokazuje podejrzane klucze z importu claude-mem do ręcznej oceny. `merge <from> <into>` przenosi całą pamięć klucza pod inny klucz (`--rename`, gdy celu jeszcze nie ma), `merge --worktrees` scala klucze `repo/worktree` z kluczem repo. Kopia `pre-project-merge` przed zmianami (`--dry-run`); po pierwszym `sync` tylko z `--force-sync-warning` |
| `sync <komenda>` | synchronizacja z własnym hubem: `init`, `join`, `add-device`, `invite`, `joins`, `reject`, `devices`, `revoke`, `leave`, `status`, `push`, `pull`, `now`, `resync`, `bootstrap-hash` ([docs/SYNC.md](docs/SYNC.md)) |
| `backup [--keep n]` | kopia bazy do `~/.hipokamp/backups/db` |
| `restore <plik>` | przywraca kopię (bez pliku: lista kopii) |
| `eval` | benchmark trafności na własnych danych |
| `install [--replace-claude-mem] [--no-codex] [--no-<harness>] [--no-autostart] [--dry-run]` | plugin Claude Code, hooki i MCP w Codexie, MCP oraz hooki albo plugin w wykrytych harnessach (Gemini CLI, Antigravity, Cursor, OpenCode, Claude Desktop), autostart workera (Windows); najpierw `claude plugin validate`; marketplace zarejestrowany z innego katalogu przepina na bieżący, kopię pluginu w cache różną od `plugin/` (hooki, skille, manifest) instaluje od nowa; gdy `uninstall` albo instalacja nie przejdzie lub kopia dalej się różni, przywraca poprzednią i kończy się błędem z komendą naprawczą |
| `update [--dry-run]` | worktree `live`: `fetch`, `merge --ff-only origin/main`, zależności przy zmianie lockfile, pliki pluginu, restart workera, `doctor`; odmawia przy zmianach, innej gałęzi i rozjeździe |
| `rollback` | wraca do claude-mem; zdejmuje hipokamp z Codexa i innych harnessów |
| `doctor` | diagnoza (także tryb snu i jego ostatni wynik, stan innych harnessów), w tym katalog, z którego działa plugin (czysty checkout `live`/`main`), i różnice kopii pluginu w cache względem `plugin/` (pliki inne, brakujące, zbędne, nieczytelne) |
| `config [--defaults]` | konfiguracja |

## Podgląd

Podgląd otwiera `hipokamp open` (worker serwuje go pod http://127.0.0.1:47777; jednorazowy link zamienia się w ciasteczko przeglądarki na 30 dni, a bez niego podgląd pokazuje ekran z instrukcją). Na wymyślonych danych, bez ruszania własnej pamięci: `bun run demo`. Start to **Dashboard**: kafelki liczb, **zbiorcze TODO ze wszystkich projektów** (praca w toku: filtry po statusie, projekcie i tekście, zalegające 14+ dni, grupowanie, zmiana statusu i dodawanie zadań, kopiowanie jako lista Markdown), aktywność dzień po dniu, projekty, ostatnie notatki i sesje oraz stan workera; widżety można ukryć (wybór zostaje w przeglądarce). Dalej: strumień notatek na żywo, szukanie z filtrami, sesje z podsumowaniami, projekty, listy pracy, statystyki (z „Uruchom sen”) i oś czasu. Jasny i ciemny motyw, układ na telefon i desktop, design HEXART. Sygnet HEXART w lewym górnym rogu prowadzi do https://hexart.io. Zrzuty (dane demo, `bun run demo`): [docs/screenshots](docs/screenshots).

**Zapomnij i przywróć.** Notatka w strumieniu, w wynikach szukania i w panelu szczegółów (otwieranym z każdego widoku) ma przycisk „Zapomnij” (okno z potwierdzeniem i opcjonalnym powodem) albo „Przywróć”. To miękkie usunięcie: notatka dostaje status `archived`, zachowuje numer i wraca jednym kliknięciem, także przez „Cofnij” w komunikacie. Przełącznik „Archiwum” w strumieniu pokazuje notatki odłożone. Zmiany statusu z dowolnego źródła (podgląd, `forget` z MCP, sen, CLI) docierają do otwartych kart na żywo, bez przeładowania; masowa zmiana (np. sen) odświeża widok jednym ruchem. Po potwierdzeniu fokus przechodzi na tytuł notatki, nie na „Przywróć”, więc kolejny Enter niczego nie cofa.

**Języki.** Interfejs jest po angielsku i po polsku. Domyślnie angielski; polski jest językiem głównym tylko wtedy, gdy pierwszym językiem przeglądarki lub systemu jest polski. Przełącznik PL/EN pojawia się wyłącznie wtedy, gdy polski jest wśród języków przeglądarki lub systemu (w przeciwnym razie nie ma żadnego wyboru, jest angielski). Wybór zapamiętuje przeglądarka; `?lang=pl` albo `?lang=en` w adresie ustawia język na to otwarcie. Teksty leżą w `viewer/i18n/` (słowniki `en.js`, `pl.js`, `*-dash.js`), silnik w `viewer/i18n.js`; test pilnuje zgodności kluczy i braku polskich literałów w kodzie widoków.

## Konfiguracja

Plik `~/.hipokamp/config.json` nadpisuje wartości domyślne (pełna lista: `hipokamp config --defaults`). Najważniejsze:

| klucz | domyślnie | znaczenie |
|---|---|---|
| `port` | 47777 | port workera (też `HIPOKAMP_PORT`) |
| `workerIdleExitMin` | 180 | worker wyłącza się po tylu minutach bezczynności; hook podnosi go ponownie. `0`: działa stale (z autostartem) |
| `hooks.mode` | `auto` | jak Claude Code woła hooki: `command` (proces Buna), `native` (plik wykonywalny Go, rozmowa z workerem, zapasowo Bun), `mcp` (narzędzia działającego serwera MCP), `auto` (`native`, gdy zbudowany i przechodzi test dymny, inaczej `command`; `install` buduje go, gdy jest Go). Działa po `hipokamp install`; pomiary w [ARCHITEKTURA.md](docs/ARCHITEKTURA.md#hooki-tryby-wywołania-hooksmode) |
| `embed.model` | `Xenova/bge-m3` | model wektorów (1024 wymiary, wielojęzyczny) |
| `embed.device`, `embed.dtype` | `cpu`, `q8` | wektory zapytań |
| `embed.bulkDevice`, `embed.bulkDtype` | `dml`, `fp16` | liczenie masowe (import, backfill) |
| `context.sessionStartBudget` | 1600 | budżet tokenów kontekstu na starcie sesji |
| `context.promptBudget` | 350 | budżet przypomnienia przy prompcie |
| `context.promptMinScore` | 0.62 | próg pewności przypomnienia przy prompcie (strojenie: `hipokamp recall-stats`) |
| `context.fileBudget` | 160 | budżet przypomnienia przy pliku |
| `capture.excludeTranscriptDirs` | `["claude-mem-observer"]` | katalogi transkryptów pomijane przy zapisie |
| `capture.codex` | `true` | sesje Codexa (hooki, nadrabianie, backfill); `CODEX_HOME` wskazuje inny katalog Codexa |
| `capture.harnesses` | wszystkie `null` | `gemini`, `antigravity`, `cursor`, `opencode`, `claudeDesktop`: `null` = `install` podłącza harness, który jest na tej maszynie, a zapis jego sesji działa od tego `install` do `rollback`; `true` = zapis zawsze; `false` wyłącza (install go pomija, hooki i plugin milczą, nadrabianie nie czyta jego sesji) |
| `capture.opencodeKeepDays` | `30` | po tylu dniach bez zmian worker usuwa przeczytany do końca transkrypt pluginu OpenCode (`~/.hipokamp/transcripts/opencode`); `0` = nigdy |
| `capture.privateTools` | `mcp__sejf__`, `mcp__plugin_sejf`, `reveal_secret` | narzędzia, których wejście i wyjście nigdy nie trafia do pamięci |
| `capture.redactSecrets` | `true` | maskowanie kluczy, tokenów i haseł przed zapisem |
| `backup` | co 24 h, 7 kopii | automatyczne kopie bazy w bezczynności |
| `consolidation.supersedeDigest` | `"propose"` | sen a starsze decyzje i preferencje z digestu o tym samym temacie co nowsze: `"propose"` tylko log `sleep-*.jsonl` i `hipokamp supersede --dry-run`, `"apply"` zastępuje, `false` wyłącza (jawny `key` w `remember` działa zawsze); wielkość liter i spacje bez znaczenia, nieznana wartość działa jak `"propose"` i `doctor` o niej ostrzega |
| `capture.autoMemory` | `null` | nadrabianie w workerze czyta pamięć automatyczną Claude Code (`projects/*/memory/*.md`): `null` dopiero po pierwszym `import-automemory --apply` z domyślnego katalogu, `true` (albo `"true"`) zawsze, `false` (albo `"false"`) nigdy, inna wartość wyłącza z ostrzeżeniem (`hipokamp doctor` pokazuje stan) |
| `consolidation.llm.enabled` | `false` | lokalny LLM w śnie: sprzeczności między decyzjami i lekcje dla najważniejszych notatek |
| `consolidation.llm.baseUrl`, `.model` | `http://127.0.0.1:11434`, pusty | Ollama tylko na 127.0.0.1 (adres zdalny = odmowa); model trzeba wskazać, np. `qwen2.5:14b` |
| `consolidation.llm.maxCallsPerRun`, `.maxRunSec`, `.callTimeoutSec` | 30, 300, 90 | limity jednego przebiegu; każdy prompt w workerze przerywa przebieg |
| `consolidation.llm.minIdleMin`, `.everyHours` | 15, 24 | przebieg tylko po tylu minutach bezczynności i nie częściej niż co tyle godzin |
| `notify.enabled` | `false` | powiadomienia o nowych notatkach |
| `notify.types`, `.minImportance`, `.sources`, `.projects` | decyzje, pułapki, preferencje; 0.6; `digest`, `agent`; wszystkie | co powiadamia (import i backfill nigdy) |
| `notify.channels` | `["toast"]` | `toast` (Windows), `file` (`notify.file`, domyślnie `~/.hipokamp/notify/outbox.jsonl`), `webhook` (`notify.webhook`, tylko 127.0.0.1), `command` (`notify.command`: program i argumenty jako lista, treść JSON na stdin, bez powłoki; `.cmd`/`.bat` odrzucone, także znalezione w `PATH`). Przy hooku natywnym i w trybie mcp `toast` i `command` nie działają dla Stop obsłużonego w workerze albo w serwerze MCP (tylko `file` i `webhook`, wstrzymane przez limit dosyła zegar tego procesu); działają, gdy Stop obsłużył proces hooka Buna. `hipokamp doctor` ostrzega |
| `notify.minIntervalSec`, `.maxPerHour`, `.maxItems` | 120, 12, 5 | odstęp między powiadomieniami, limit na godzinę, pozycje w jednym grupowym |
| `sync.enabled`, `sync.intervalMin` | `false`, 10 | synchronizacja z hubem w tle przez workera (po `hipokamp sync init` albo `join`) |
| `sync.excludeProjects` | `[]` | projekty, które nie wychodzą z tej maszyny przy synchronizacji |
| `mcp.tools` | `compat` | zestaw narzędzi MCP: `compat` (19 jak w claude-mem) albo `slim` (4, ok. 32% tokenów definicji); też `HIPOKAMP_MCP_TOOLS` |

### Strojenie progu

Każda decyzja przypominania przy prompcie trafia do `~/.hipokamp/logs/recall-RRRR-MM-DD.jsonl`: bez treści promptu, z najlepszymi kandydatami i ich pewnością, wynikiem (`zwrócone`, `wstrzyknięte`, `poniżej-progu`, …) i czasem etapów. `hipokamp recall-stats` czyta te logi (domyślnie 14 dni) razem ze śladami `get_observations` w bazie (tylko do odczytu) i odpowiada na dwa pytania: ile decyzji „poniżej progu” skończyło się i tak pobraniem tej notatki w ciągu `--window` minut (próg za wysoki) i ile wstrzykniętych notatek ktoś potem pobrał (próg za niski). Wynik to tabela w przedziałach pewności co 0,05 i rekomendacja:

- **za mało danych**: mniej niż 200 decyzji z wektorami (decyzje bez modelu mają inną skalę pewności i nie wchodzą do analizy);
- **obniż**: przedziały tuż pod progiem (każdy z co najmniej `--min-n` decyzjami), z których notatki i tak pobierano w co najmniej 15% decyzji i co najmniej w połowie tak często, jak używane są notatki wstrzyknięte; próg schodzi do dolnej granicy najniższego takiego przedziału, nie niżej niż 0,40;
- **podnieś**: przedziały tuż nad progiem, z których wstrzyknięte notatki pobierano w mniej niż 5%;
- **zostaw** w pozostałych przypadkach.

Analiza obejmuje tylko decyzje podjęte przy jednym progu: `--threshold` (domyślnie bieżący `context.promptMinScore`). Każdy wpis logu ma pole `min` z progiem z chwili decyzji, a decyzje z innym progiem (np. sprzed ręcznej zmiany) są pomijane i liczone osobno, bo ten sam przedział pewności raz był „poniżej progu”, a raz „wstrzyknięty”. Dane starego progu ogląda się przez `--threshold <stary próg>`.

Narzędzie niczego nie zmienia; nowy próg ustawia się ręcznie w `config.json` (`context.promptMinScore`). Pobranie liczy się z dowolnej sesji, bo serwer MCP zna tylko ostatnio aktywną sesję projektu; zgodność sesji jest podana osobno.

Zmienne środowiskowe: `HIPOKAMP_HOME` (katalog danych, domyślnie `~/.hipokamp`), `HIPOKAMP_PORT`, `HIPOKAMP_MCP_TOOLS` (`compat` albo `slim`, ma pierwszeństwo przed `mcp.tools`), `HIPOKAMP_NO_WORKER` (tryb bez workera, tylko FTS), `HIPOKAMP_DEBUG`, `CLAUDE_CONFIG_DIR` (katalog Claude Code, jak w samym Claude Code), `CLAUDE_MEM_DB` (ścieżka bazy claude-mem).

## Prywatność i bezpieczeństwo

- Dane leżą w `~/.hipokamp` (SQLite). Nic nie wychodzi z maszyny. Jedyny ruch sieciowy to jednorazowe pobranie modelu wektorów z Hugging Face do `~/.hipokamp/models`. Opcjonalny lokalny LLM i webhook powiadomień (oba domyślnie wyłączone) łączą się wyłącznie z 127.0.0.1: adres zdalny jest odrzucany przed wysłaniem czegokolwiek, przekierowania i proxy z `HTTP_PROXY` nie działają, modele chmurowe Ollamy (`…-cloud`) są odrzucane. Uwaga: sama Ollama ma własne funkcje chmurowe (`OLLAMA_NO_CLOUD=1` je wyłącza), a dymek Windows to `powershell.exe -EncodedCommand`, który antywirusy bywają skłonne oznaczać. Wyjątek tylko na życzenie: synchronizacja z własnym hubem (`hipokamp sync`), który dostaje wyłącznie szyfrogramy (klucz grupy zostaje na komputerach, [docs/SYNC.md](docs/SYNC.md)).
- Worker słucha tylko na 127.0.0.1 i odrzuca obce nagłówki `Host` i `Origin` (obrona przed DNS rebinding i CSRF z przeglądarki). Ciało żądania ma limit 8 MB (zapomnij i przywróć: 64 KB). Podgląd ma CSP, `X-Frame-Options: DENY` i nie wstawia treści jako HTML.
- Hooki, serwer MCP i CLI rozmawiają z workerem dopiero po wyzwaniu HMAC z kluczem z `~/.hipokamp/state/worker.key` (uprawnienia tylko dla Ciebie: na Windows ACL przez `icacls`, na Linuksie i macOS 0600). Proces, który zajmie port workera, nie zna klucza, więc nie dostanie promptów i nie dopisze nic do kontekstu: hooki pracują wtedy jak bez workera. Podgląd w przeglądarce wymaga ciasteczka podglądu (T-34): `hipokamp open` otwiera jednorazowy link z biletem HMAC z klucza workera (ważny 2 min), który worker wymienia na ciasteczko `HttpOnly; SameSite=Strict` na 30 dni; zapis z przeglądarki wymaga też zgodnego nagłówka `Origin`. Inne programy na tej maszynie bez klucza nie przeczytają pamięci ani nie dopiszą nic do list pracy. Unieważnienie wszystkich ciasteczek: usuń `worker.key`, potem `hipokamp restart`. Po aktualizacji z wersji bez uwierzytelnienia: `hipokamp restart` (albo start nowej sesji, bo serwer MCP sam podmienia starego workera). `hipokamp doctor` sprawdza klucz i jego uprawnienia.
- Powód zapomnienia przechodzi przez tę samą redakcję sekretów co transkrypt.
- Sekrety są maskowane przed zapisem. Narzędzia sejfu (`mcp__sejf__*`) nie trafiają do pamięci wcale.
- Hooki nigdy nie blokują pracy: zawsze kończą się kodem 0, mają twarde limity czasu, a kontekst przycinają do limitu Claude Code (10 000 znaków).
- Brak telemetrii, kont, banerów i aktualizacji w tle.

## Kilka komputerów

Jedna pamięć na kilku komputerach bez cudzej chmury: każdy komputer ma pełną bazę, a własny hub (osobny proces Buna na VPS za HTTPS) przechowuje tylko zaszyfrowany dziennik zmian. Szyfrowanie po stronie klienta (AES-256-GCM), osobny klucz dostępu każdego urządzenia, dołączanie nowego urządzenia z jednorazowym kodem, którego hub nie zna (klucz grupy jedzie zapieczętowany i podpisany, nie przez czat), sekrety maskowane także przy wysyłce i odbiorze, `#id` nowych notatek takie same na każdym komputerze, wektory liczone lokalnie. Domyślnie wyłączone. Opis, kompromisy i kroki wdrożenia: [docs/SYNC.md](docs/SYNC.md), pliki serwera: [server/](server/).

## Kopie i powrót

- `hipokamp backup` i automatyczna kopia co 24 h (`VACUUM INTO`, spójna przy działających hookach), 7 ostatnich kopii.
- `hipokamp restore <plik>`: bieżąca baza idzie do `pre-restore-*`, nic nie znika.
- `hipokamp rollback`: wyłącza plugin hipokampa i włącza claude-mem z powrotem (o ile był włączony przed instalacją), zdejmuje hooki i serwer MCP z Codexa oraz innych harnessów (z kopią plików). Dane obu systemów zostają.

## Rozwój

```bash
bun run lint && bun run typecheck && bun test
```

Testy: jednostkowe (FTS i polskie litery, redakcja z korpusem regresji wycieków sekretów i testem nadzbioru względem wersji sprzed przepisania (także w `smart_*`), parser transkryptów, ranking, przeterminowanie po treści, zastępowanie po kluczu, ścieżka promptu, statystyki progu), e2e serwera MCP po stdio, integracyjne workera na tymczasowej bazie oraz instalacji i `update` z udawanym `claude` w PATH i tymczasowymi repozytoriami git. Profil ścieżki promptu i koszt zastępowania w śnie na syntetycznych bazach: `spikes/prompt-path.ts`, `spikes/sleep-supersede.ts` (tylko z `HIPOKAMP_HOME` testowym). Prawdziwa baza ani ustawienia Claude Code nie są dotykane, sieć i model wektorów niepotrzebne. Zasady repo: [CLAUDE.md](CLAUDE.md).

CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (lint, typecheck i testy na push do `main` i na PR).

Repo: https://github.com/lazniak/hipokamp. Licencja MIT ([LICENSE](LICENSE)). © HEXART Sp. z o.o.

Tekst napisany z pomocą AI.
