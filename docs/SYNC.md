# Synchronizacja między komputerami (faza 2, T-01)

Stan na 2026-10-06 (po trzech rundach recenzji PR #9 i dopasowaniu do main z #5, #6, #7, #10, #12, #13 i #14): kod klienta i huba, testy i pliki wdrożeniowe są gotowe. Hub uruchamiasz na własnym serwerze (sekcja 10). Bez `hipokamp sync init` albo `join` nic się nie zmienia: żadnej sieci, żadnych nowych procesów, tabele synchronizacji puste.

## 1. Co to daje

Jedna pamięć na kilku komputerach (stacja główna, Desktop2, laptop) bez cudzej chmury i bez kont. Każdy komputer ma pełną lokalną bazę i działa bez sieci tak jak dziś; hub jest tylko skrzynką na zaszyfrowany dziennik zmian. Hub nie zna treści: widzi szyfrogramy, numer urządzenia, rozmiar i czas przyjęcia.

```
  stacja (urządzenie 1)            hub na własnym VPS               Desktop2 (urządzenie 3)
  ~/.hipokamp/hipokamp.db  ──push──▶  dziennik wpisów   ◀──push──   ~/.hipokamp/hipokamp.db
                           ◀──pull──  (szyfrogramy)     ──pull──▶
  wektory liczone lokalnie          nginx HTTPS → 127.0.0.1:47790   wektory liczone lokalnie
```

## 2. Dziennik operacji

Wpis dziennika to paczka operacji jednego urządzenia (do ok. 512 KB JSON przed kompresją). Operacje:

| operacja | kiedy powstaje (przy `push`) | jak ją stosuje odbiorca |
|---|---|---|
| `session` | sesja tej maszyny nowa albo zmieniona (skrót pól), z zegarem wersji | wiersz sesji ze źródłem `sync`, bez ścieżki transkryptu i offsetu (to cudzy dysk); tylko wersja nowsza od już przyjętej nadpisuje pola (powtórka dziennika od zera ani wpis dociągnięty później nie cofną sesji) |
| `prompt` | prompt bez wpisu w `sync_map` | `insertTurnPrompt` (zajęty numer w sesji: ten sam tekst to ten sam prompt, inny tekst idzie pod następny numer) |
| `obs` | notatka bez wpisu w `sync_map` (każdy status, także scalone) | `insertObservation` z encjami grafu (pliki, pojęcia), FTS; bez odcisków plików, zakresu transkryptu i liczników użycia |
| `status` | stan notatki inny niż w rejestrze `sync_status` | rejestr LWW (sekcja 3), potem status, cel scalenia, następca i ślad decyzji (`m`: zapomnienie, przywrócenie, cofnięte zastąpienie) w notatce |
| `sum` | podsumowanie bez wpisu w `sync_map` | `insertSummary`; podsumowanie `digest` (budowane od nowa przy każdym końcu sesji) zastępuje poprzednie tej sesji |
| `ws` | wpis listy pracy bez wpisu w `sync_map` | `appendWorkState` |

**Idempotencja.** Każdy wiersz z hubu ma gid i trafia do `sync_map`; ta sama operacja drugi raz nic nie zmienia (test „powtórka”). Wiersz liczy się jako wysłany dopiero po potwierdzeniu przez hub, a kursor odbioru zapisuje się w tej samej transakcji co ostatni kawałek operacji wpisu (odbiór kawałkami, sekcja 7), więc przerwanie w dowolnym miejscu kończy się powtórką, nie dziurą. Hub deduplikuje wpisy po identyfikatorze (HMAC z listy operacji), więc ponowiona wysyłka tej samej partii nic nie dodaje.

**Notatki są niezmienne.** Treść notatki jedzie raz. Późniejsze poprawki treści na komputerze źródłowym (`redigest`, redakcja sekretów w `repair`) nie są przenoszone (sekcja 8).

**Redakcja przy wysyłce i przy odbiorze.** Każde pole tekstowe przechodzi przez `clean()` (maskowanie sekretów i `<private>`) dwa razy: zanim wpis zostanie zaszyfrowany i zanim operacja trafi do bazy odbiorcy. Urządzenie ze starszymi regułami, notatka z importu claude-mem sprzed `repair` albo klient bez redakcji nie rozniosą sekretu po innych bazach, a dziennik huba (którego treści nie da się później poprawić) dostaje już tekst po redakcji. Reguły redakcji są wzorcami sekretów (klucze, tokeny, hasła w przypisaniach), więc identyfikator bez sekretu (UUID sesji, nazwa projektu, skrót commita) przechodzi bez zmian, a z sekretem traci tylko sekret. Test „redakcja każdego pola” wkłada sekret do każdego pola z tabeli i sprawdza odszyfrowane wpisy huba, surowe bajty jego bazy i bazę odbiorcy.

| operacja | pola po `clean()` | bez `clean()` |
|---|---|---|
| `session` | identyfikator sesji, projekt, katalog, gałąź, tytuł, pierwszy prompt, model, stan | liczby (czasy, licznik promptów), zegar wersji (format sprawdzany) |
| `prompt` | identyfikator sesji, projekt, tekst, źródło | numer w sesji, czas, gid |
| `obs` | identyfikator sesji, projekt, typ, warstwa, tytuł, podtytuł, opis, fakty, pojęcia, pliki, tekst, źródło, klucz tury, `git_head`, `meta` (całość jako JSON, także klucze), klucze encji (polecenie, adres, plik, pojęcie…; encja, z której zostaje sam znacznik redakcji, jest pomijana) | **`content_hash`** (skrót, deduplikacja u odbiorcy), liczby, gid, rodzaj i rola encji (tylko ze znanych zbiorów) |
| `sum` | identyfikator sesji, projekt, wszystkie pola tekstowe, pliki, źródło, `meta` | liczby, gid |
| `ws` | projekt, nazwa listy, pola (całość jako JSON), źródło | czas, numer z claude-mem, gid |
| `status` | powód zapomnienia (`m.forget_reason`, też ucięty do 300 znaków) | gid notatki, celu i następcy oraz zegar (format sprawdzany), stan (tylko ze zbioru), czasy w `m` (tylko liczby) |

**Ślady maszyny.** `sessions.meta` (katalog startowy sesji `root` i jego werdykt `rootProject`, kotwica w transkrypcie `anchor`, numer tury `n`) nie jedzie wcale: sesja ma stałą listę pól. Z `meta` notatki i podsumowania przy wysyłce i przy odbiorze wypadają klucze opisujące maszynę (`root`, `rootProject`, `anchor`, `n`, `cwd`, offsety i ścieżki transkryptu, odciski, wyniki lokalnego LLM `llm` z numerami notatek tej bazy) i wartości wyglądające na ścieżkę bezwzględną (`C:\…`, `\\serwer\…`, `/home/…`, `/Users/…`, `~/…`). Notatka pamięci automatycznej (`source = 'automemory'`, #10) traci więc u odbiorcy ścieżkę pliku (`meta.automemory.file`): import pamięci odbiorcy jej nie rusza (to nie jego plik), a jej stan (nowa wersja, plik usunięty) przychodzi statusami ze źródła.

**Pochodzenie wiersza.** Notatkę, prompt, podsumowanie i wpis listy pracy przyjmuje się tylko od urządzenia, które jest źródłem gid (`gid` z prefiksem numeru nadawcy wpisu, który hub zna z klucza dostępu). Urządzenie nie zajmie więc cudzego gid i nie zablokuje prawdziwego wiersza. Status może zmienić każde urządzenie.

**Zatruty wpis.** Treść z sieci przechodzi pełną kontrolę typów każdego pola każdej operacji (schemat `OP_SCHEMA` w `store.ts`: napis, liczba, liczba całkowita, `null` tam, gdzie wolno, format gid i zegara, znane stany), a każda operacja stosuje się w osobnym `SAVEPOINT`. Operacja o złym kształcie, nieznanego rodzaju, z cudzym gid albo taka, przy której baza zgłosi błąd w połowie, jest odrzucana i cofana w całości (`odrzucone` w `sync pull`, kod 3); reszta wpisu wchodzi, a kursor idzie dalej. Jeden zły wpis (błąd innej wersji, złośliwy członek grupy) nie zatrzyma więc odbioru całej grupy (test „zatruty wpis”).

**Kolejność list pracy.** Stan listy pracy to „najnowsza wartość klucza wygrywa”. Wpis z innego komputera dostaje lokalnie późniejszy numer, więc lista składa się teraz po czasie wpisu (`ORDER BY created_at, id` w `workStateEntries` i `workStateAll`), a nie po numerze. Bez synchronizacji zmienia to wynik tylko tam, gdzie numer nie rośnie z czasem: wpisy z importu claude-mem dopisane do listy, która ma już nowsze wpisy hipokampa, albo dwa wpisy z tym samym czasem (wtedy rozstrzyga numer, jak dotąd). W obu przypadkach wygrywa wpis późniejszy w czasie, co jest bliższe intencji niż kolejność importu.

## 3. Statusy: zegar hybrydowy i LWW

Konflikty dotyczą tylko statusów notatek (`active`, `archived`, `merged`, `superseded`), bo tylko one zmieniają się po zapisie. Każda notatka ma rejestr „ostatni zapis wygrywa” (`sync_status`): wygrywa zmiana z późniejszym zegarem.

- **Zegar hybrydowy (HLC)**: `czas ms . licznik . numer urządzenia`, napis porównywalny leksykograficznie (`src/sync/store.ts`, `hlcString`). Zmiana lokalna dostaje zegar z chwili zmiany statusu, ale nigdy mniejszy niż ostatni zegar widziany z innych urządzeń, więc zmiana zrobiona po odebraniu cudzej zawsze z nią wygrywa, nawet przy rozjechanych zegarach systemowych.
- **Zegar z przyszłości.** Operacja `status` albo `session` z zegarem dalej niż dobę przed czasem odbiorcy (`MAX_CLOCK_AHEAD_MS`) jest odrzucana (`rejected` w `sync pull`) i nie przesuwa zegara odbiorcy. Bez tej granicy zegar systemowy przestawiony o lata albo złośliwy członek grupy wygrałby każdy późniejszy konflikt statusu i pociągnął zegary wszystkich urządzeń. Koszt: zmiany statusu i wersje sesji z urządzenia z zegarem systemowym ponad dobę w przód są odrzucane, dopóki czas odbiorców nie dogoni zapamiętanego zegara tego urządzenia (zegar hybrydowy się nie cofa); odrzucone nie wracają same, po poprawieniu zegara i upływie tego czasu wyśle je ponownie `hipokamp sync resync` na tym urządzeniu. Test „zegar ponad dobę w przyszłości”.
- **Ostrzeżenia zegara** (T-37, `clockWarnings` w `src/sync/store.ts`). Dwa przypadki, które wcześniej przechodziły po cichu, pokazują `hipokamp sync status` (linia `ZEGAR:`), `hipokamp doctor` (przy `sync.enabled`) i log workera (raz na rodzaj, nie co obieg; ponownie dopiero, gdy ostrzeżenie zniknie i wróci):
  - **Zapamiętany zegar wyprzedza zegar systemowy** ponad dobę (`meta.sync_hlc`): zegar systemowy był przestawiony w przód i wrócił, a zegar hybrydowy się nie cofa. Wszyscy odbiorcy odrzucają wtedy zmiany statusu i wersje sesji z tego urządzenia, a `sync resync` nie pomaga (wysyła te same zegary). Ostrzeżenie podaje datę, od której zmiany zaczną przechodzić (zapamiętany zegar minus doba); zmiany odrzucone wcześniej same nie wrócą, więc po tej dacie trzeba je wysłać ponownie (`sync resync` na tym urządzeniu) albo odebrać od nowa (`sync pull --full` na pozostałych). Ten sam objaw daje zegar systemowy, który się teraz spóźnia: wtedy trzeba go poprawić, a zmiany innych komputerów odrzucone w tym czasie odzyskać jak niżej.
  - **Odbiorca z zegarem w tył** odrzuca poprawne operacje innych urządzeń jako „z przyszłości”, a kursor idzie dalej, więc bez śladu zgubiłby te zmiany. Odbiór zapisuje liczbę takich odrzuceń, czas i najdalszy zegar w `meta.sync_clock_rejected` (`sync pull` dopisuje je do linii `ODRZUCONE`), w tej samej transakcji co kursor wpisu, więc przerwany odbiór śladu nie gubi. Zwykły odbiór dopisuje; odbiór od początku dziennika (`pull --full`, `resync`, pierwszy odbiór po dołączeniu) zastępuje ślad przy pierwszym wpisie (te same operacje nie liczą się dwa razy), a bez odrzuceń go czyści. Zwykły odbiór bez odrzuceń śladu nie czyści: zgubione zmiany wciąż czekają. **Odzysk:** popraw zegar tej maszyny, potem `hipokamp sync pull --full`: odbiór od początku dziennika stosuje odrzucone operacje jeszcze raz (pozostałe są idempotentne). Gdy to nadawca miał zegar w przód, jego zmiany przejdą u odbiorcy dopiero, gdy czas odbiorcy dogoni ich zegar (też przez `pull --full`). Testy „zegar ponad dobę w przyszłości” (ślad, odzysk, ostrzeżenie o zegarze bazy) i „ostrzeżenia zegara w logu workera”.
- **Chwila zmiany statusu** to `sync_status_at`: wyzwalacz w bazie zapisuje ją przy każdej zmianie statusu, celu scalenia, następcy albo ważności notatki (tylko po `sync init/join`). Nie jest to `updated_at`, bo ten podbijają też zmiany, które statusu nie dotyczą (powtórka treści w `insertObservation`, poprawki treści): stara niewysłana zmiana statusu z nowym `updated_at` wygrywałaby z nowszą zdalną. Dla zmian sprzed `sync init` zostaje `updated_at`. Test „zegar statusu”.
- **Remis** (ten sam czas i licznik) rozstrzyga numer urządzenia: wyższy wygrywa. Test „remis zegara”.
- **Zmiana niewysłana przy odbiorze**: gdy lokalny stan różni się od rejestru (zmiana jeszcze nie wysłana), liczy się z zegarem z chwili zmiany; późniejsza lokalna zostaje i po wysyłce wygrywa wszędzie. Test „zmiana niewysłana”.
- **Cel scalenia** (`merged_into`) i następca (`superseded_by`) jadą jako gid (przy kilku gid jednej notatki: ten o najwyższym numerze urządzenia, sekcja 4). Gdy cel jeszcze nie dotarł, odnośnik uzupełnia się w chwili jego przyjęcia.
- **Scalenia w krzyż.** Rejestr LWW jest osobny dla każdej notatki, więc „X w Y” z jednej maszyny i „Y w X” z drugiej przeszłyby oba i obie notatki zniknęłyby z przypominania. Odbiorca, który po zastosowaniu statusu widzi cykl scaleń, przywraca do stanu aktywnego notatkę o najmniejszym gid w cyklu (ten sam wybór na każdej maszynie); ta zmiana idzie dalej jak każda lokalna i wszystkie maszyny kończą z tą samą aktywną notatką (test „scalenia w krzyż”).
- **Ryzyko: zastąpienia w krzyż.** Przerywanie cykli dotyczy tylko `merged`. „X zastąpione przez Y” na jednej maszynie i „Y zastąpione przez X” na drugiej (`superseded`, np. dwa przebiegi snu albo `remember` z poprawką na dwóch komputerach naraz) też przejdą oba i obie notatki wypadną z przypominania jako nieaktualne. Treść nie ginie (zostaje w bazie, `get_observations` ją pokaże), a nowsza poprawka przywraca stan. Rozszerzenie `breakMergeCycle` na łańcuchy `superseded_by` jest proste, ale zmienia zachowanie snu (#5, zastępowanie z digestu jest domyślnie tylko propozycją): do decyzji. `key` dopisywany do notatki przy deduplikacji `remember` (#5) to zmiana treści po zapisie i nie jedzie (sekcja 8): drugi komputer zna klucz tylko z pierwszego zapisu notatki.
- **Ślad decyzji jedzie ze statusem** (pole `m` operacji `status`, kolumna `intent` rejestru). Zmiana statusu z ręki człowieka albo modelu zostawia w `meta` znacznik, który steruje dalszym zachowaniem: `forgotten_at` i `forget_reason` (forget z MCP albo podglądu, #7), `restored_at` (przywrócenie z archiwum snu: sen nie odkłada notatki drugi raz) i `supersede_undone` (cofnięte zastąpienie: sen nie zastąpi notatki drugi raz, #5). Bez nich status wracałby z innego komputera: jego sen odłożyłby przywróconą notatkę do archiwum z nowszym zegarem. Odbiorca, przy którym zmiana wygrywa, ustawia te cztery klucze dokładnie jak u źródła (brak klucza = usunięcie), reszta `meta` zostaje; z `supersede_undone` jedzie tylko czas (odsyłacz `by` to numer lokalny). Wyjątek: zwycięska zmiana daje notatce stan, który już ma (forget tutaj, a na drugim komputerze równolegle archiwum snu z późniejszym zegarem). Wtedy ślad się łączy: grupa pól z sieci (zapomnienie: czas i powód razem; przywrócenie; cofnięte zastąpienie) zastępuje lokalną, a brakująca zostaje, więc cudzy sen nie wymaże decyzji człowieka. Zbieranie statusów wysyła też notatki ze stanem równym rejestrowi, ale innym śladem, więc połączony ślad trafia z powrotem do drugiego komputera i obie strony kończą z tym samym. Dla notatki aktywnej z aktywnym rejestrem ta różnica nie jest wysyłana (wymagałoby to przeglądu wszystkich aktywnych notatek): ślad zostaje lokalnie i pójdzie z następną zmianą statusu. Rejestr pamięta ślad, więc `sync resync` i notatka dociągnięta po swoim statusie dostają go tak samo. Kolumnę dodaje migracja 8 jako przebudowę tabeli (`src/db/schema.ts`): baza z pośredniego commitu PR #9, która ma już `intent`, przechodzi ją bez błędu i z zachowanym śladem (test „migracja synchronizacji…”, T-37). Testy „forget z powodem…”, „przywrócenie z archiwum snu…” (z prawdziwym snem na obu komputerach), „cofnięte zastąpienie…” i „ten sam stan z dwóch stron…”.
- Sen działa na każdej maszynie osobno. Wybór „starsza w nowszą” zależy od czasu utworzenia (ten sam wszędzie), a remis czasu rozstrzyga skrót treści (`content_hash`, też ten sam wszędzie), nie kolejność pętli ani numer lokalny; maszyny scalają więc tę samą parę w tę samą stronę. Liczniki użycia, wstrzyknięcia i ważność podbita powtórkami zostają lokalne.

## 4. Numery `#id`

Wymaganie: notatki z różnych urządzeń nie kolidują, a `#id` cytowane w rozmowach i notatkach (także z claude-mem) dalej wskazują to samo.

**Tożsamość globalna (gid)** to `urządzenie źródłowe:numer u źródła`, np. `1:10003117`. Mapa `sync_map` łączy gid z numerem lokalnym. To jest kanoniczna tożsamość wiersza w dzienniku.

**Rozłączne przestrzenie numerów** dla nowych notatek i podsumowań:

| urządzenie | własne numery | uwagi |
|---|---|---|
| 1 (`sync init`, stacja główna) | 10 000 001 … 100 000 000 | bez zmian wobec dzisiejszej numeracji (migracja 3) |
| 2 | 200 000 001 … 300 000 000 | |
| n | n·10⁸ + 1 … (n+1)·10⁸ | z pierwszej cyfry widać źródło; n najwyżej 999 999 |

**Numer urządzenia** wyznacza jego przestrzeń numerów i prefiks gid, więc musi być poprawny i nigdy nie może wrócić do użycia (dwa urządzenia z tym samym numerem wysyłałyby różne notatki pod tymi samymi gid, a odbiorcy po cichu odrzucaliby drugą):

- `sync init` daje zawsze nr 1 z rolą admin; inną odpowiedź huba klient odrzuca.
- Nowy numer nadaje **admin**, nie hub: większy od każdego, jaki zna (własne numery, urządzenia z odebranych wpisów, z listy urządzeń i z wcześniejszych zatwierdzeń) i jaki zna hub, i nie mniejszy niż `min_device` z prośby (baza, która była już w grupie, ma licznik notatek w przestrzeni starego numeru i zna numery innych). Numer jest w podpisie zatwierdzenia (`mac`), a `min_device` w `proof`, więc hub nie zmieni żadnego z nich. Nowe urządzenie przyjmuje tylko liczbę całkowitą z zakresu i nie niższą niż `min_device`; inaczej nic nie zapisuje, a licznik notatek zostaje nietknięty (test „złośliwy hub: numer urządzenia”, wartości 1e11, 5e10, −3, 1, 0, 2,5, napis, NaN, `null` i poprawna liczba inna niż podpisana).
- Hub pamięta najwyższy numer, jaki wydał albo o jakim usłyszał (`max_device`), i odrzuca zatwierdzenie z numerem nie większym (409; zatwierdzenie ponawia się kilka razy z losową przerwą, więc równoległe `add-device` dwóch adminów dostają różne numery, test S5). Każde urządzenie przy kotwicach (przed wysyłką i odbiorem) podaje najwyższy numer, jaki zna; hub, który zna niższy (przywrócony z kopii), zatrzymuje synchronizację i zatwierdzanie z komunikatem. Licznik huba podnosi tylko `sync resync` urządzenia z rolą **admin** i najwyżej o 1000 ponad najwyższy numer na liście urządzeń huba: członek grupy nie zablokuje numeracji, wpisując 999999 (test S3). Po przywróceniu huba z kopii zatwierdzanie czeka w trybie odzyskiwania (sekcja 9, testy „hub z kopii a numery urządzeń” i S10).
- Ta sama baza dołączona drugi raz (`sync leave`, potem `sync join`: po odcięciu albo gdy hub z kopii jej nie zna) dostaje nowy, wyższy numer. Jej własne wiersze z poprzednich numerów tracą wpis w mapie gid i idą do huba jeszcze raz pod nowym numerem (pod starym gid odbiorcy by je odrzucili jako cudze); odbiorcy, którzy już je mają, rozpoznają je i nic się nie dubluje: notatki po numerze i treści, prompty po sesji i numerze tury, podsumowania po numerze i czasie, wpisy list pracy po projekcie, liście, czasie i polach (test S9). `#id` zostaje ten sam (np. `200000001` urządzenia 2 dalej jest `#200000001`, także u nowych komputerów). Notatka ma wtedy u starszych odbiorców dwa gid; odnośniki (cel scalenia, następca) idą pod gid o najwyższym numerze urządzenia, czyli pod nowym, który zna i samo źródło, i każdy nowy komputer (test S1b).

Odbiorca wstawia notatkę pod numerem źródła, jeśli jest wolny i leży poza jego własną przestrzenią. Dzięki temu nowe notatki mają ten sam `#id` na każdym komputerze, a numery z importu claude-mem (poniżej 10 000 001) też zostają.

**Licznik.** SQLite z `AUTOINCREMENT` dałby następnej własnej notatce `max(id) + 1`, czyli numer z cudzej, wyższej przestrzeni. Dlatego `insertObservation` i `insertSummary` biorą numer z licznika `sqlite_sequence` (`COALESCE(?, seq + 1)`), a odbiór po każdym wpisie przywraca licznik do własnej przestrzeni. Bez synchronizacji to dokładnie to samo co `AUTOINCREMENT` (licznik nigdy nie jest niższy niż `max(id)`). Strumień podglądu (SSE) śledzi tylko własne nowe notatki (`Repo.observationIdsAfter` i `maxObservationId`: numer do licznika; tak samo powtórka po `Last-Event-ID`), więc notatka z wyższej przestrzeni nie przestawia jego kursora; nowe notatki z innych komputerów widać w podglądzie po odświeżeniu (test w `worker.test.ts`), a zmiany statusu (także przysłane, np. forget z drugiego komputera) idą na żywo zdarzeniem `status` (wyzwalacz `tr_obs_status`, #7).

**Kolizje historii sprzed synchronizacji.** Notatki, które powstały przed dołączeniem urządzenia, mają numery z tej samej przestrzeni 10 000 001+ na każdym komputerze. Przy kolizji (numer zajęty przez inną treść albo leży we własnej przestrzeni odbiorcy) notatka dostaje lokalnie nowy numer, a `sync_map` pamięta gid. Ta sama notatka pod tym samym numerem (wspólny import claude-mem: ta sama treść i czas) albo ta sama tura (`turn_key`) to jeden wiersz, a identyczna treść w projekcie to też jeden wiersz (bez podbijania powtórek).

**Kompromisy.**

| wariant | `#id` takie samo wszędzie | koszt |
|---|---|---|
| tylko gid i mapa (każdy komputer numeruje po swojemu) | nie | `#id` z rozmowy na stacji nic nie znaczy na laptopie |
| tylko rozłączne zakresy | tak, dla nowych | historia sprzed synchronizacji koliduje i wymaga przenumerowania, a numery są święte |
| **zakresy + gid z mapą (wybrane)** | tak dla nowych i dla historii stacji głównej; nie dla kolizji z historii innych urządzeń | numery 9-cyfrowe na urządzeniach 2+ (ok. 1 token więcej na `#id` w kontekście), licznik pilnowany przy odbiorze |

Stacja główna ma `sync init` (urządzenie 1), więc jej historia (np. ponad 100 tys. notatek) zachowuje numery wszędzie. Kolizje dotyczą tylko notatek, które inne urządzenie miało przed dołączeniem.

**Ryzyko: numery claude-mem poniżej 10 000 001 na innych komputerach.** Notatki stacji z importu claude-mem przychodzą na laptop i Desktop2 pod swoimi numerami (np. `#1234`), bo tam te numery są wolne. Jeśli później na takim komputerze ktoś zaimportuje jego własną bazę claude-mem (inną niż stacji, np. po `hipokamp rollback` i powrocie, albo pierwszy import po dołączeniu), notatki claude-mem tego komputera z tymi samymi numerami nie dostaną swoich `#id`: import przeniesie je pod numery zastępcze i zapisze stary numer w `meta.cm_id` (tak jak dziś przy kolizji z bazą 0.1). Treść nie ginie, ale `#id` z rozmów prowadzonych na tamtym komputerze przed importem wskazywałyby wtedy notatkę stacji. Zalecenie: import claude-mem robić na każdym komputerze **przed** `sync join` (wtedy kolizje rozstrzyga mapa gid, a lokalne numery zostają), a na komputerach bez własnej historii claude-mem nie importować go wcale. Poprawka w kodzie (np. osobna przestrzeń dla obcych numerów poniżej 10 mln) zmieniłaby `#id` notatek stacji na innych komputerach, więc świadomie jej nie ma.

## 5. Szyfrowanie i klucze

Wszystko z `node:crypto` wbudowanego w Buna (`src/sync/crypto.ts`), bez zależności.

- **Klucz grupy**: 32 losowe bajty, wspólne dla urządzeń. HKDF-SHA256 wyprowadza z niego klucz AES-256-GCM i klucz HMAC identyfikatorów wpisów. Identyfikator klucza (`kid`, 8 znaków hex) jest jawny.
- **Wpis**: JSON → deflate → AES-256-GCM, nonce 96 bitów losowy dla każdego wpisu. AAD wiąże szyfrogram z hubem, `kid` i identyfikatorem wpisu: serwer nie przestawi szyfrogramu pod inny wpis. Treść podpisana jako inne urządzenie niż to, które według huba wysłało wpis, jest odrzucana jak uszkodzony szyfrogram.
- **Granica rozpakowania**: treść wpisu po rozpakowaniu ma najwyżej 4 MB (`LIMITS.maxEntryPlainBytes`). Odbiorca przerywa rozpakowanie na tej granicy (`inflateRawSync` z `maxOutputLength`) i traktuje wpis jak uszkodzony szyfrogram, więc kilka KB „bomby deflate” od członka grupy nie zajmie gigabajtów pamięci workera; nadawca takiego wpisu nie wysyła (dzieli partię, a pojedynczą za dużą operację pomija i zgłasza jak wiersz za duży dla huba). Test „bomba deflate”.
- **Klucz dostępu urządzenia** (`hks_` + 32 losowe bajty) powstaje na urządzeniu. Hub trzyma tylko jego skrót SHA-256. Odcięcie urządzenia unieważnia ten jeden klucz.

| hub widzi | hub nie widzi |
|---|---|
| numer i nazwę urządzenia, rolę, czas ostatniego kontaktu | klucza grupy, kluczy dostępu (tylko skróty) |
| identyfikator wpisu (HMAC), `kid`, wersję koperty, rozmiar, czas przyjęcia | treści, tytułów, projektów, ścieżek, liczby i rodzaju operacji we wpisie |
| klucz publiczny X25519, skrót klucza dostępu i dowód kodu (`proof`, HMAC) w prośbie o dołączenie; skrót adresu IP prośby | kodu dołączania i zapieczętowanego klucza grupy (otwiera go tylko nowe urządzenie) |

**Gdzie leżą sekrety**: `~/.hipokamp/state/sync-secret.json` (klucz dostępu i klucze grupy). Na POSIX plik ma tryb 0600. Na Windows tryb nie działa: chroni ACL katalogu, a profil użytkownika (`C:\Users\<nazwa>`) ma ACL tylko dla właściciela, systemu i administratorów. Gdy `HIPOKAMP_HOME` leży poza profilem (np. `D:\dane`), ACL dziedziczy się z tamtego katalogu i może wpuszczać innych lokalnych użytkowników: `hipokamp doctor` to wykrywa i podaje komendę, która zostawia dostęp tylko właścicielowi (`icacls "<plik>" /inheritance:r /grant:r "%USERNAME%:F"`; hipokamp nie uruchamia jej sam, bo zasada repo zabrania procesów potomnych poza instalatorem). Alternatywa: zmienna `HIPOKAMP_SYNC_SECRET` z treścią tego pliku (np. z menedżera sekretów); worker w tle potrzebuje jednak pliku. Żadna komenda nie wypisuje kluczy (test CLI sprawdza wyjście `init`, `join`, `pull` i `status`). Kopia klucza grupy nie jest krytyczna: każdy komputer ma pełną bazę lokalnie, a utrata klucza oznacza tylko nowy hub.

### Pierwsze urządzenie (bootstrap)

Hub przyjmuje pierwsze urządzenie tylko z sekretem bootstrapu, którego skrót SHA-256 jest w konfiguracji huba (`HIPOKAMP_SYNC_BOOTSTRAP_SHA256`). Bez skrótu `init` jest wyłączony, a po pierwszym urządzeniu bootstrap nie działa wcale (409). Sekret generuje menedżer sekretów, skrót daje `hipokamp sync bootstrap-hash`, a `sync init` czyta sekret ze zmiennej `HIPOKAMP_SYNC_BOOTSTRAP`: sekret nie przechodzi przez czat.

### Dołączanie urządzenia (jednorazowy kod)

Hub nie może być stroną zaufaną przy dołączaniu: zna klucz publiczny nowego urządzenia, więc mógłby sam „zatwierdzić” prośbę i zapieczętować dla niego **własny** klucz grupy (wtedy czytałby wszystko, co to urządzenie wyśle, i mógłby mu wstrzykiwać notatki do kontekstu sesji), albo podmienić klucz publiczny w prośbie, żeby admin zapieczętował klucz grupy dla niego. Dlatego obie strony uwierzytelnia sekret, który do huba nie trafia nigdy:

1. Nowe urządzenie: `hipokamp sync join --server …` tworzy klucz dostępu, parę kluczy X25519 i **jednorazowy kod** (16 znaków, 80 losowych bitów, np. `K7QM-2XRA-9DTE-WB4H`). Z kodu liczy klucz (scrypt) i wysyła prośbę: nazwa, skrót klucza dostępu, klucz publiczny, najniższy numer urządzenia, jaki ta baza może przyjąć (`min_device`, sekcja 4), i `proof` = HMAC z klucza kodu po tych czterech polach. Kod pokazuje tylko na swoim ekranie.
2. Urządzenie z rolą admin: `hipokamp sync add-device <kod>`. Klient najpierw sprawdza kotwice (hub przywrócony z kopii zatrzymuje zatwierdzanie, zanim wyda drugi raz czyjś numer), potem liczy klucz z przepisanego kodu i szuka wśród oczekujących próśb tej, której `proof` się zgadza. Podmieniony klucz publiczny, obniżony `min_device` albo cudza prośba nie mają poprawnego `proof`, więc nic nie zostanie zatwierdzone („kod nie pasuje”). Admin wybiera numer urządzenia (sekcja 4). Klucz grupy jedzie do huba zapieczętowany kluczem publicznym nowego urządzenia (efemeryczny X25519, ECDH, HKDF, AES-256-GCM), razem z numerem i `mac` = HMAC z klucza kodu po identyfikatorze huba, prośbie, kluczu publicznym, skrócie klucza dostępu, roli, zapieczętowanym kluczu i numerze urządzenia.
3. Nowe urządzenie przyjmuje klucz grupy i numer tylko z poprawnym `mac`. Hub, który zatwierdzi prośbę sam, podsunie inny klucz, zmieni rolę, numer urządzenia albo identyfikator huba, nie zna kodu, więc podpisu nie podrobi: urządzenie nic nie zapisuje i przerywa (testy „złośliwy hub”). Po odebraniu klucza kasuje prośbę z huba.

Hub zna `proof`, więc mógłby zgadywać kod offline; 80 bitów i scrypt (N=2^14) czynią to niewykonalnym także w ciągu 15 minut życia prośby. Kod jest **jednorazowym sekretem**: przepisz go ręcznie z terminala nowego urządzenia. Jeśli przejdzie przez czat z modelem, ryzyko jest tylko takie, że ktoś, kto widzi czat i jednocześnie kontroluje hub, w ciągu tych 15 minut mógłby podstawić siebie; po zatwierdzeniu kod nic już nie znaczy.

Prośba wygasa po 15 minutach. Limity bez klucza są per adres IP, a IPv6 per podsieć /64 (sekcja 6): najwyżej 5 nowych próśb na 15 minut i 3 oczekujące z jednego adresu, 50 oczekujących łącznie. Admin widzi oczekujące prośby (`hipokamp sync joins`) i odrzuca zbędne (`hipokamp sync reject <prośba>`), a odpytywanie własnej prośby przez nowe urządzenie ma osobny kubełek. Zalew z wielu adresów może jednak trzymać kolejkę pełną (odrzucone prośby wracają), więc admin daje nowemu urządzeniu **zaproszenie**: `hipokamp sync invite` drukuje jednorazowy klucz `hki_…` (ważny 15 minut, najwyżej 10 naraz), a nowe urządzenie dołącza z `hipokamp sync join --server … --invite hki_…`. Prośba z zaproszeniem omija limity próśb bez klucza i kolejkę; zatwierdzenie nadal wymaga kodu z ekranu, więc zaproszenie samo nic nie daje i może przejść przez czat.

### Odcięcie urządzenia i rotacja klucza

`hipokamp sync revoke <numer>` (rola admin) odcina urządzenie: hub odrzuca jego klucz (403 z `revoked`), pozostałe urządzenia działają dalej (test „odcięcie”). Odcięte urządzenie zna jednak klucz grupy i wszystko, co już pobrało. Rotacja klucza grupy (nowy klucz dla pozostałych, stare wpisy czytelne starym) jest przygotowana w formacie (pęk kluczy, `kid` we wpisie), ale bez komendy: pytanie otwarte 3.

## 6. Hub

`src/sync/server.ts`: osobny proces Buna, SQLite (WAL) jako magazyn, zależy tylko od `protocol.ts`. Jedna instancja = jedna grupa. Nasłuchuje na 127.0.0.1 (w kontenerze 0.0.0.0, a port jest publikowany tylko na 127.0.0.1 hosta).

| ścieżka | kto | co |
|---|---|---|
| `GET /v1/health` | każdy | `{ok, protocol}` |
| `POST /v1/bootstrap` | sekret bootstrapu | pierwsze urządzenie (admin), identyfikator huba |
| `POST /v1/join` | każdy (limity per IP) albo z zaproszeniem (`x-hipokamp-invite`) | prośba o dołączenie (`name`, `token_hash`, `pubkey`, `min_device`, `proof`); zaproszenie zużywa się w tej samej transakcji co zapis prośby (równoległe żądania z jednym zaproszeniem: jedna prośba, reszta 403, test S2b) |
| `POST /v1/invites` | admin | jednorazowe zaproszenie `hki_…` (15 minut, najwyżej 10 naraz; hub trzyma tylko skrót) |
| `GET /v1/joins` | admin | oczekujące prośby (z `proof` i `min_device`, po których klient admina rozpoznaje kod) |
| `GET /v1/join/:id` | admin albo samo urządzenie | szczegóły prośby albo status, numer, zapieczętowany klucz i `mac`; tylko odczyt (wygasłe prośby sprząta osobny cykl) |
| `POST /v1/join/:id/approve` | admin | nowe urządzenie z numerem wybranym przez admina i rolą `member` albo `admin` (`device`, `sealed`, `mac`, w trybie odzyskiwania `ack_lost`); numer nie większy od najwyższego znanego hubowi: 409 z `max_device`; tryb odzyskiwania: 409 z `recovery` i listą adminów bez resync (`waiting`) albo `ack_required` |
| `DELETE /v1/join/:id` | samo urządzenie albo admin | sprzątanie po odebraniu klucza; odrzucenie przez admina (zatwierdzona, nieodebrana: urządzenie odcięte) |
| `GET /v1/me`, `GET /v1/devices` | urządzenie | tożsamość, lista urządzeń z liczbą wpisów |
| `POST /v1/devices/:no/revoke` | admin | odcięcie (nie siebie) |
| `POST /v1/entries` | urządzenie | wysyłka wpisów; odpowiedź ma numer każdego wpisu (kotwica) |
| `GET /v1/entries?after=&limit=&own=` | urządzenie | odbiór od kursora; domyślnie bez własnych wpisów |
| `GET /v1/anchors?seqs=&maxdev=&raise=` | urządzenie | identyfikatory wpisów pod podanymi numerami, najwyższy numer wpisu, najwyższy znany numer urządzenia i tryb odzyskiwania (wykrycie cofniętego dziennika); `raise=1` (`sync resync`): admin podnosi licznik numerów do `maxdev` (najwyżej 1000 ponad listę urządzeń, inaczej 400) i włącza tryb odzyskiwania, członek tylko się zgłasza |

Każde żądanie `/v1/*` (poza health) musi mieć nagłówek `x-hipokamp-sync: 1`; inna wersja dostaje 426 z wersją huba. Wpis ma jawną wersję koperty, a treść po odszyfrowaniu własną. Klient, który dostanie wpis w nieznanej wersji koperty albo treści, albo zaszyfrowany kluczem grupy, którego nie ma, pomija go, zapamiętuje (`meta.sync_skipped`, `sync status` to pokazuje) i odbiera dalej; po aktualizacji hipokampa albo po otrzymaniu klucza taki wpis wraca sam przy następnym odbiorze (test „niezgodna wersja” i „nieznany klucz”).

**Obrona**: `Host` tylko z `HIPOKAMP_SYNC_PUBLIC_HOSTS` albo lokalny (inaczej 421), publiczny `Host` tylko z `X-Forwarded-Proto: https`, żądanie z nagłówkiem `Origin` (przeglądarka) odrzucone, POST tylko jako JSON, porównania sekretów w stałym czasie, brak CORS, dziennik bez treści i bez kluczy. Odbiór najpierw czyta numery i rozmiary, a szyfrogramy tylko w budżecie bajtów odpowiedzi (200 wpisów po 2 MB nie trafia naraz do pamięci kontenera z limitem 512 MB).

| limit | domyślnie | zmienna |
|---|---|---|
| ciało żądania | 8 MB (413) | |
| jeden wpis | 2 MB (413) | |
| treść wpisu po rozpakowaniu (pilnuje klient) | 4 MB (wpis uszkodzony) | |
| wpisów w żądaniu | 64 | |
| odpowiedź odbioru | 200 wpisów albo 8 MB | |
| cały magazyn | 4 GB (507) | `HIPOKAMP_SYNC_MAX_TOTAL_MB` |
| żądania urządzenia | 600 na minutę (429) | `HIPOKAMP_SYNC_RATE_PER_MIN` |
| health i bootstrap bez klucza | 60 na minutę z jednego adresu IP (osobne kubełki) | |
| inne żądania bez klucza albo z nieznanym kluczem | 60 na minutę z jednego adresu IP | |
| nowe prośby o dołączenie | 5 na 15 minut z jednego adresu IP (prośba z zaproszeniem bez limitu) | |
| oczekujące prośby | 3 z jednego adresu IP, 50 łącznie (prośby z zaproszeniem się nie liczą); wygasają po 15 minutach | |
| odpytywanie własnej prośby | 60 na minutę na prośbę | |
| zaproszenia | 10 ważnych naraz, 15 minut, jednorazowe | |
| kubełki limitów w pamięci | 10 000 (najdawniej używane wypadają) | |
| podniesienie licznika numerów urządzeń przez resync admina | najwyżej 1000 ponad najwyższy numer na liście urządzeń huba (400) | |

Adres IP to `X-Real-IP` od nginx (`HIPOKAMP_SYNC_TRUST_PROXY=1` w `docker-compose.yml`). Hub bierze ten nagłówek tylko z połączenia od adresu loopback albo prywatnego (nginx na hoście łączy się przez bramę Dockera) albo od adresu z `HIPOKAMP_SYNC_TRUSTED_PROXIES`; od innego nadawcy liczy adres połączenia, więc klient z internetu nie zmieni swojego adresu nagłówkiem, nawet gdy port huba wystawiono bez nginx. Przy `TRUST_PROXY` i nasłuchu poza 127.0.0.1 hub ostrzega w dzienniku przy starcie. Adresy IPv6 liczą się po podsieci /64 (jeden klient ma ich zwykle całą pulę), a IPv4 zapisany jako IPv6 (`::ffff:…`) jak IPv4. W bazie huba leży tylko skrót adresu z losową solą tej instancji (`meta.ip_salt`), więc wyciek bazy nie pozwala sprawdzić znanych adresów słownikiem. nginx ma dodatkowo `limit_req` na `/v1/join`, `/v1/health`, `/v1/bootstrap` i luźniejszy na resztę API (po pojedynczym adresie; podsieć /64 pilnuje dopiero hub).

## 7. Klient

| komenda | co robi |
|---|---|
| `hipokamp sync init --server https://… [--name n]` | pierwsze urządzenie (sekret z `HIPOKAMP_SYNC_BOOTSTRAP`), drukuje, jak dodać drugie |
| `hipokamp sync join --server https://… [--name n] [--wait s] [--invite hki_…]` | prośba o dołączenie, jednorazowy kod, czekanie na zatwierdzenie (domyślnie 600 s; potem samo `sync join` kończy); z zaproszeniem omija limity próśb bez klucza |
| `hipokamp sync add-device <kod> [--admin] [--ack-lost-devices]` | zatwierdzenie prośby urządzenia, które pokazuje ten kod; numer urządzenia wybiera ta komenda (sekcja 4). `--ack-lost-devices` tylko po przywróceniu huba z kopii: potwierdza, że urządzenia nieznane hubowi złożyły już prośby (sekcja 9) |
| `hipokamp sync invite` | jednorazowe zaproszenie dla nowego urządzenia (rola admin, sekcja 5) |
| `hipokamp sync joins`, `sync reject <prośba>` | oczekujące prośby, odrzucenie (rola admin) |
| `hipokamp sync devices`, `sync revoke <numer>` | urządzenia grupy, odcięcie |
| `hipokamp sync leave --yes [--abandon-group]` | odłączenie tej bazy od grupy: kasuje stan, klucz grupy i klucz dostępu z `state/` (notatki zostają); potem można `sync join` od nowa do tego samego huba (baza pamięta hub; nowy numer, sekcja 4). Bez `--yes` tylko opisuje skutki. Jedyny aktywny admin odmawia (po nim nikt nie zatwierdzi nowego urządzenia, a bootstrap działa raz): najpierw drugi admin (`add-device --admin`) albo świadomie `--abandon-group` |
| `hipokamp sync status` | hub, urządzenie, `kid` kluczy grupy, zaległości do wysłania, kursor, wpisy uszkodzone i nieczytelne, wiersze za duże dla huba, wstrzymanie po cofniętym dzienniku, tryb odzyskiwania huba, ostrzeżenia zegara (sekcja 3) |
| `hipokamp sync push`, `sync pull [--full]`, `sync now` | wysyłka, odbiór, oba (kod 3, gdy coś pominięto) |
| `hipokamp sync resync` | odbudowa po przywróceniu huba z kopii (sekcja 9) |
| `hipokamp sync bootstrap-hash` | skrót sekretu bootstrapu do `.env` huba |

**W tle** (opt-in): `"sync": { "enabled": true, "intervalMin": 10 }` w `~/.hipokamp/config.json`. Worker co `intervalMin` minut robi wysyłkę i odbiór; synchronizacja nie liczy się jako aktywność, więc nie trzyma workera przy życiu. Ustawienia czyta z pliku przy każdym cyklu (`refreshConfig`), więc `"enabled": false` zatrzymuje następny obieg bez restartu. Obieg jest zadaniem pociętym w diagnostyce przestojów (`track("sync", …, { sliced: true })`, `/api/health`): winę za przestój dostaje najdłuższy kawałek synchroniczny, a czekanie na hub (sieć, ponowienia) liczy się poza kawałkami (`waitOutside` w `src/util/slice.ts`). Domyślnie wyłączone: harmonogram (`src/sync/background.ts`) nie ładuje wtedy klienta i nie otwiera żadnego połączenia (test „w tle”).

**Wiersz za duży dla huba** (pojedyncza operacja, której szyfrogram przekracza limit jednego wpisu, np. notatka z kilkoma MB losowego tekstu): klient dzieli wpisy na pół aż do pojedynczej operacji, a tej jednej nie wysyła, zapisuje ją w `meta.sync_skipped_rows` i pokazuje w `sync status`; reszta idzie. Bez tego wysyłka stawałaby na 413 przy każdej próbie.

**Odbiór kawałkami.** Wpis ma do 512 KB JSON-u, czyli setki operacji; zastosowany w jednej transakcji trzymałby bazę (i pętlę workera, a z nią hooki z budżetem 1000 ms) przez 250 do 400 ms. Odbiór stosuje operacje wpisu w transakcjach po ok. 40 ms i oddaje pętlę zdarzeń między nimi; kursor idzie w transakcji ostatniego kawałka. Przerwanie w środku wpisu zostawia kursor przed nim, a następny odbiór stosuje wpis od początku (operacje są idempotentne). Na 3000 notatkach w 6 wpisach najdłuższy przestój pętli spadł z 375 do 69 ms (test S6).

**Wysyłka kawałkami.** Zbieranie zmian przegląda tabele zakresami po 4000 numerów od kursora (`collectBatch`): sesje po identyfikatorze z budżetem sprawdzanym po każdej sesji (redakcja pól i skrót to praca na każdą: 5000 sesji z pierwszym promptem 1,6 KB to ok. 290 ms także wtedy, gdy nic się nie zmieniło; wcześniej jednym ciągiem ok. 305 ms w workerze, teraz kawałki najwyżej ok. 40 ms), niewysłane wiersze, potem statusy w dwóch przebiegach (nieaktywne notatki zakresami numerów, z odsianiem w SQL wierszy na pewno równych rejestrowi; aktywne notatki z nieaktywnym rejestrem zakresami gid). W workerze (`collectMs` = 40 ms) zbieranie wraca po budżecie z tym, co ma, a pętla zdarzeń dostaje głos; kompresja i szyfrowanie każdego wpisu oraz zapis znaczników partii też są przedzielone przerwą. Statusy zbiera się dopiero po zatwierdzeniu przez hub wierszy z tego samego wywołania (status tylko dla notatki znanej hubowi), więc nowa notatka i jej status idą w jednym `push`. Pomiar na syntetycznej bazie (100 tys. notatek, 30 tys. nieaktywnych, wszystko już wysłane, czyli zwykły obieg w tle bez zmian): wcześniej jeden ciąg ok. 270 ms co `intervalMin`, teraz ok. 210 ms łącznie w kawałkach najwyżej ok. 45 ms (przy budżecie 0 najdłuższy kawałek 7 ms). Zapytania przeglądu mają kolejność złączeń wymuszoną `CROSS JOIN`: bez statystyk (`ANALYZE`) planista brał mapę gid i czytał ją do końca przy każdym kawałku. CLI (`hipokamp sync push`) zbiera bez budżetu (własny proces, większe partie). Testy „zbieranie kawałkami” i „przegląd sesji kawałkami” (4000 sesji, zegar budżetu podmieniony na licznik odczytów, więc wynik nie zależy od szybkości maszyny: każda sesja dokładnie raz i w kolejności, najwyżej tyle sesji na wywołanie, ile wynosi budżet).

**Znacznik najwyższego własnego numeru** (`hwm` w `state/sync.json`) zapisuje się po każdej potwierdzonej partii, więc przerwana pierwsza wysyłka (np. ponad 100 tys. notatek) nie zostawia wykrywania przywróconej kopii bazy wyłączonego (test „przerwana wysyłka”).

**Wektory nie jadą** przez hub (każda maszyna liczy swoje tym samym modelem, mniej ruchu, brak zależności od modelu drugiej strony). Nowe notatki z innych komputerów nie mają wektora, więc pętla wektorów workera dolicza je sama (`sync pull` budzi workera). Po pierwszym dużym odbiorze szybciej: `hipokamp embed` (GPU).

**Wykluczenia**: `sync.excludeProjects` (wielkość liter bez znaczenia) zatrzymuje notatki, prompty, sesje, podsumowania i listy pracy tych projektów na tej maszynie.

**Pierwsza wysyłka stacji głównej**: cała baza (np. ponad 100 tys. notatek) idzie partiami po ok. 4 MB JSON (8 wpisów po 512 KB przed kompresją). Rozmiaru po kompresji nie mierzyłem na prawdziwej bazie (zasada: testy nie dotykają `~/.hipokamp`); szacunek z rozmiaru bazy bez wektorów to dziesiątki MB na hubie. Pierwszy odbiór na nowym urządzeniu to wstawienie wszystkich notatek z FTS i encjami: lepiej ręcznie `hipokamp sync pull`, potem `hipokamp embed`, a dopiero potem `sync.enabled`.

## 8. Czego synchronizacja nie przenosi

- **Wektory** (sekcja 7) i **ślady użycia**: liczniki dostępu, wstrzyknięcia, log dostępu, ważność podbita powtórkami. To sygnały pracy na danej maszynie.
- **Odciski plików i zakres transkryptu** notatki: dotyczą dysku źródła. Notatka z innego komputera nie ma ostrzeżenia ⚠ o zmianie pliku, a `get_tool_uses` dla niej nie ma skąd czytać.
- **Zmiany treści po zapisie** (`redigest`, redakcja w `repair`, `key` dopisany przy deduplikacji `remember`, `meta.supersede` z powodem zastąpienia, `meta.automemory.removed_at` pamięci automatycznej; wyjątek: ślad decyzji przy statusie, sekcja 3) i **twarde usunięcia** (`purgeSessions`, prompty usunięte przez `repair`). Pytanie otwarte 4.
- **Naprawy i scalenia projektów** (`hipokamp repair`, `hipokamp project merge`) przepisują wiersze tylko lokalnie, a wysyłka bierze tylko wiersze jeszcze niewysłane. Zasada „najpierw repair, potem sync” (`src/core/sync-guard.ts`, docs/MIGRACJA.md): obie komendy uruchamia się na **każdym** komputerze **przed** `sync init` albo `sync join`; na bazie już połączonej z hubem odmawiają zapisu bez `--force-sync-warning`. Gdy scalenie projektów trzeba zrobić później, świadomie z tą flagą na każdym komputerze: odbiorca przepuszcza projekt każdej przychodzącej operacji przez własne scalenia (`mergedProject`), więc nowe wiersze lądują w scalonym projekcie, ale wiersze wysłane przed scaleniem zostają u innych pod starym kluczem, dopóki tam też nie wykonasz scalenia.
- **Przypadki brzegowe numeracji**: nowa notatka z innego komputera nie trafia do strumienia SSE podglądu (sekcja 4).
- **Powiadomienia** (`notify`, #10): tylko o notatkach tej maszyny. Notatka z innego komputera zachowuje `created_at`, więc odebrana w oknie `maxAgeMin` dałaby powiadomienie na każdym komputerze; `isLocalNote` pomija notatki z wpisem w `sync_map` o cudzym pochodzeniu (`Repo.isForeignObservation`), także tę samą treść zapisaną tu i przysłaną (deduplikacja przy odbiorze), bo o niej powiadomił już komputer źródłowy. Test „notatka z innego komputera nie daje powiadomienia”.
- **Pamięć automatyczna** (#10): identyfikator instalacji (`meta.install_id`) odróżnia pliki pamięci tej maszyny. Baza skopiowana z innego komputera (kopia `~/.hipokamp`, przywrócenie na innym dysku) miałaby jego identyfikator, a dwa komputery z jednym identyfikatorem archiwizowałyby i zastępowały nawzajem swoje notatki. Dołączenie (`sync init` i `join`) usuwa więc identyfikator, gdy żadna notatka pamięci automatycznej z nim nie ma nazwy tego komputera (`foreignInstallId`); importer wylosuje nowy. Ograniczenie: komputer, którego nazwę zmieniono po imporcie pamięci automatycznej, a przed `sync init/join`, też dostanie nowy identyfikator i następny import zapisze jego pliki pamięci jeszcze raz (stare notatki zostają, nowe dublują treść). Test „identyfikator instalacji pamięci automatycznej”.
- **Wyniki lokalnego LLM** (`meta.llm`, sprzeczności i lekcje, #10): liczy je każda maszyna z włączonym `consolidation.llm` sama (numery notatek w `conflicts` są lokalne).

## 9. Odzyskiwanie

- **Przywrócona kopia bazy** (`hipokamp restore`): plik stanu `state/sync.json` leży poza bazą i pamięta ostatnio wysłany własny numer. `push` na bazie, która go nie zna, odmawia i prosi o `hipokamp sync pull --full` (odbiór od początku, razem z własnymi wpisami). To przywraca utracone notatki pod ich numerami albo, gdy numer zajęła już nowa notatka, pod nowym; nowa notatka idzie potem pod gid z przyrostkiem (`1:10003117~1`), który odbiorcy numerują po swojemu (test „przywrócona kopia”). Najlepiej `pull --full` od razu po `restore`, zanim otworzysz sesje.
- **Hub przywrócony z kopii (cofnięty dziennik)**: klient pamięta numer i identyfikator ostatniego odebranego wpisu (kursor) i ostatniego własnego wpisu potwierdzonego przez hub. Przed każdą wysyłką i odbiorem pyta hub o te numery (`/v1/anchors`). Gdy hub ich nie ma, ma pod nimi inne wpisy albo jego najwyższy numer jest niższy, synchronizacja staje z komunikatem (inaczej po cichu: odbiorca nie dostałby nowych wpisów spod tych samych numerów, nowe urządzenie nie dostałoby tego, co hub zgubił, a nadawca nie wysłałby tego ponownie, bo ma to za wysłane). Odbudowa: na **każdym** urządzeniu `hipokamp sync resync` (zapomina kursor i kotwice, wysyła ponownie wszystkie własne wiersze pod tymi samymi gid, własne sesje i wszystkie znane rejestry statusów, potem odbiera od początku). Operacje są idempotentne, więc to, co hub i odbiorcy już mają, nic nie zmienia; koszt to jednorazowa pełna wysyłka i odbiór (test „hub przywrócony z kopii”).
- **Hub z kopii a numery urządzeń (tryb odzyskiwania)**: kopia nie zna urządzeń dołączonych po jej dacie, więc jej licznik wydałby ich numery drugi raz, a dwa urządzenia z jednym numerem mają te same gid (odbiorca bierze notatkę drugiego za notatkę pierwszego i po cichu ją gubi). Najwyższy wydany numer zna admin, który go nadał, a adminów może być kilku (także taki, którego kopia nie zna). Dlatego:
  - Każde urządzenie przy kotwicach podaje najwyższy numer urządzenia, jaki zna (`meta.sync_max_device`: własne numery, autorzy odebranych wpisów, lista urządzeń, zatwierdzenia); hub, który zna niższy, zatrzymuje synchronizację i `add-device` z komunikatem.
  - Pierwszy `sync resync` urządzenia z rolą admin (albo start huba z nowym znacznikiem `HIPOKAMP_SYNC_RESTORED`, który ustawia ten, kto przywraca kopię) włącza na hubie **tryb odzyskiwania**. Hub nie zatwierdza wtedy żadnego urządzenia, dopóki **każdy** aktywny admin z jego listy nie zrobi `sync resync` (resync admina podnosi licznik do numerów, które sam zna) i dopóki admin nie potwierdzi jawnie `hipokamp sync add-device <kod> --ack-lost-devices`, że urządzenia nieznane hubowi złożyły już prośby. Przy potwierdzeniu nowy numer jest wyższy także od `min_device` każdej czekającej prośby (urządzenie, które było w grupie, zna numery do `min_device − 1`). Pierwsze zatwierdzenie z potwierdzeniem kończy tryb. Admina, którego maszyny już nie ma, odcina `sync revoke` i wtedy na niego nie czeka.
  - Kolejność: 1) `hipokamp sync resync` na **wszystkich** urządzeniach, które hub zna (admini obowiązkowo; członek, który zna wyższy numer niż hub, czeka na resync admina albo ponowne dołączenie urządzeń nieznanych hubowi); 2) każde urządzenie, którego hub nie zna (komunikat o nieznanym kluczu dostępu): `hipokamp sync leave --yes`, potem `hipokamp sync join`; 3) gdy wszystkie prośby czekają (`hipokamp sync joins`): `add-device --ack-lost-devices` dla pierwszego, dalej zwykłe `add-device`. Urządzenie dołączone ponownie dostaje nowy, wyższy numer, a jego własne wiersze idą pod nim jeszcze raz (sekcja 4). Wyjątku ani ręcznego czyszczenia tabel to nie wymaga (testy „hub z kopii a numery urządzeń” i S10: dwóch adminów, drugi nadał numer po dacie kopii).
  - Granica: potwierdzenie to deklaracja admina. Urządzenie nieznane hubowi, które nie złożyło prośby przed potwierdzeniem, a zna numer nadany przez innego nieznanego hubowi admina, nie jest chronione; stąd wymóg, żeby prośby złożyły wszystkie, zanim padnie `--ack-lost-devices`.
- **Czego kotwice nie wykryją**: złośliwy hub (albo ktoś z dostępem do jego bazy) nie przeczyta treści i nie podrobi wpisu, ale może **po cichu wstrzymywać** wybrane wpisy (nie oddać ich przy odbiorze), **pokazywać różnym urządzeniom różne wersje dziennika** (każdemu spójną z tym, co samo widziało) albo zatrzymać synchronizację. Kotwice łapią tylko cofnięcie albo podmianę tego, co dane urządzenie już widziało; porównanie stanu między urządzeniami (wspólna suma kontrolna, podpisy wpisów nadawcy) wykracza poza fazę 2.
- **Uszkodzony szyfrogram**: wpis jest pomijany, jego numer trafia do `meta.sync_bad` i `sync status`, `pull` kończy się kodem 3, reszta przychodzi (test „uszkodzony szyfrogram”).
- **Zatruty wpis** (poprawnie zaszyfrowany, ale z operacją o złym kształcie albo taką, której baza nie przyjmie): każda operacja idzie we własnym punkcie zapisu (SAVEPOINT), więc błąd cofa tylko ją, liczy się jako odrzucona, a odbiór idzie dalej (sekcja 2, test „zatruty wpis”).
- **Nowa wersja formatu albo nieznany klucz grupy**: starszy klient pomija taki wpis, zapisuje go w `meta.sync_skipped` (numer, powód, potrzebna wersja albo `kid`) i odbiera dalej; `sync status` pokazuje listę. Po aktualizacji hipokampa (albo gdy urządzenie dostanie klucz) następny odbiór sam dociąga te wpisy po numerze. Lista ma najwyżej 500 pozycji; nadmiar nie znika, tylko trafia do zakresu `meta.sync_skipped_overflow` (najniższy i najwyższy numer oraz potrzebne wersje i klucze). Gdy którykolwiek z nich staje się czytelny, odbiór przegląda dziennik huba od najniższego pominiętego numeru jeszcze raz (już zapisane operacje są idempotentne), więc po aktualizacji wracają wszystkie, nie tylko ostatnie 500 (test „wiele nieczytelnych wpisów”).
- **Nowy hub**: baza pamięta swój hub (`meta.sync_hub`) i odmawia innego. Przejście na nowy hub wymaga czystego stanu synchronizacji w bazie (ręcznie: tabele `sync_*` i klucze `sync_*` w `meta`); świadomie bez komendy, do decyzji.

## 10. Wdrożenie huba na własnym serwerze

Wymaga serwera z Dockerem i nginx (dostęp root) oraz własnej domeny. W przykładach host to `hub.example.com`, a adres serwera `203.0.113.10`; swoje wartości wpisz w `docker-compose.yml` i w konfiguracji nginx.

1. **DNS**: rekord A `hub.example.com` → 203.0.113.10.
2. **Sekret bootstrapu** (lokalnie, na stacji głównej): wygeneruj losowy sekret (np. `openssl rand -base64 32`, najlepiej w menedżerze sekretów) i uruchom `hipokamp sync bootstrap-hash` z tym sekretem w zmiennej `HIPOKAMP_SYNC_BOOTSTRAP`. Wynik to skrót (nie sekret).
3. **Katalog na serwerze**:
   ```bash
   mkdir -p /opt/hipokamp-sync/data && cd /opt/hipokamp-sync
   git clone https://github.com/lazniak/hipokamp app      # albo scp src/sync/{server,protocol}.ts i server/
   cp app/server/docker-compose.yml .
   cp app/server/hub.env.example .env && chmod 600 .env      # wpisz HIPOKAMP_SYNC_BOOTSTRAP_SHA256=<skrót z kroku 2>
   chown 1000:1000 data
   ```
4. **Kontener**: `docker compose up -d --build`, potem `curl -s http://127.0.0.1:47790/v1/health` (oczekiwane `{"app":"hipokamp-sync","ok":true,"protocol":1}`) i `docker compose logs --tail 20`.
5. **nginx i certyfikat**:
   ```bash
   cp app/server/nginx-hub.example.com.conf /etc/nginx/sites-available/hub.example.com.conf
   ln -s /etc/nginx/sites-available/hub.example.com.conf /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d hub.example.com --non-interactive --agree-tos -m admin@example.com
   curl -s https://hub.example.com/v1/health
   ```
   Sprawdzenie, że HTTP nie dotyka danych: `curl -s -H 'x-hipokamp-sync: 1' http://hub.example.com/v1/me` ma dać przekierowanie albo 403.
6. **Naprawa baz przed synchronizacją** (na **każdym** komputerze, zanim dotknie huba): `hipokamp backup`, `hipokamp repair --dry-run`, potem `hipokamp repair`, i ewentualne `hipokamp project merge` (też najpierw z `--dry-run`). Obie komendy przepisują wiersze już zapisane, a po pierwszej wysyłce zmiana nie dotarłaby do innych komputerów; na bazie połączonej z hubem odmawiają zapisu bez `--force-sync-warning` (sekcja 8, docs/MIGRACJA.md).
7. **Stacja główna** (urządzenie 1): z sekretem w zmiennej `HIPOKAMP_SYNC_BOOTSTRAP`: `hipokamp sync init --server https://hub.example.com --name stacja`, potem `hipokamp sync push` (pierwsza wysyłka całej bazy, kilka minut) i `hipokamp sync status`.
8. **Desktop2 i laptop** (po kroku 6 na nim): na stacji `hipokamp sync invite` (zaproszenie omija kolejkę próśb, gdy ktoś ją zapcha; może przejść przez czat); na nim, w terminalu: `hipokamp sync join --server https://hub.example.com --name desktop2 --invite hki_…` (pokaże jednorazowy kod); na stacji `hipokamp sync add-device <kod>` (kod przepisz ręcznie, nie przez czat); na nim `hipokamp sync pull`, `hipokamp embed`, `hipokamp sync push`.
9. **Włączenie w tle** na każdym komputerze: `"sync": { "enabled": true }` w `~/.hipokamp/config.json`, `hipokamp restart`.
10. **Kopie huba**: `data/hub.db` to tylko replika (każdy komputer ma pełną bazę). Kopia jest przydatna tylko jako szybsza droga dla nowego urządzenia; przywrócenie jej cofa dziennik i licznik urządzeń: przy starcie huba z kopią ustaw nową wartość `HIPOKAMP_SYNC_RESTORED` (np. datę przywrócenia) w `.env`, potem `hipokamp sync resync` na każdym urządzeniu, które hub zna (wszyscy admini obowiązkowo), urządzenia dołączone po dacie kopii `sync leave --yes` i `sync join` od nowa, a dopiero na końcu `add-device --ack-lost-devices` (sekcja 9, server/README.md). Alternatywa po awarii: pusty hub, `sync init` na stacji i ponowne dołączenie pozostałych; dziś wymaga ręcznego wyczyszczenia stanu synchronizacji w bazach (sekcja 9, „Nowy hub”), pytanie otwarte 8.
11. **Wycofanie**: `docker compose down` i usunięcie strony z nginx; na komputerach `"sync": { "enabled": false }`. Dane lokalne zostają nietknięte.

Aktualizacja huba: `cd /opt/hipokamp-sync/app && git pull && cd .. && docker compose up -d --build`.

