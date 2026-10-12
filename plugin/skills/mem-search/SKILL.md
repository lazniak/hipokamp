---
name: mem-search
description: Przeszukuje pamięć hipokampa z poprzednich sesji Claude Code. Użyj, gdy pada pytanie w stylu „czy już to rozwiązywaliśmy?”, „jak zrobiliśmy X ostatnio?”, „co ustaliliśmy o Y?”, „did we already solve this?”, „how did we do X last time?”, albo gdy zadanie wygląda na powrót do wcześniejszej pracy.
---

# Szukanie w pamięci (hipokamp)

Pamięć to notatki z wcześniejszych tur (po jednej na turę), podsumowania sesji i prompty użytkownika. Każda notatka ma numer `#id`, który nie zmienia się nigdy (także dla notatek zaimportowanych z claude-mem).

## Przepływ: od taniego do drogiego

1. **`search`** z krótkim zapytaniem (3 do 8 słów, po polsku albo angielsku; fleksja i brak polskich znaków nie przeszkadzają). Wynik to indeks: `#id data [typ] tytuł ~tokeny`. Nie pobieraj jeszcze treści.
   - Bez `project` szuka we wszystkich projektach; bieżący jest wyżej, obce są oznaczone `{projekt}`.
   - Zawężanie: `type` (`bugfix`, `decision`, `gotcha`, `feature`, `discovery`, ..., albo `sessions` / `prompts`), `dateStart`, `dateEnd`, `orderBy`.
2. **`timeline`** wokół najlepszego trafienia (`anchor` = `#id`, `S<id>` dla sesji, `P<id>` dla promptu), gdy liczy się kontekst: co było przed i po.
3. **`get_observations`** tylko dla 1 do 5 wybranych `#id`. Dopiero tu jest pełna treść: narracja, fakty, pliki.
4. **`get_tool_uses`** tylko wtedy, gdy potrzebny jest dokładny przebieg (komenda, wynik, diff) stojący za notatką.

## Zasady

- `⚠plik zmieniony` przy notatce oznacza, że plik zmienił się po jej powstaniu. Traktuj notatkę jako wskazówkę i sprawdź aktualny kod, zanim na niej oprzesz odpowiedź.
- Cytuj numery: „wg #48213 przyczyną był ...”. Cytowanie wzmacnia notatkę w pamięci (lepszy ranking w przyszłości).
- Brak trafień to też informacja: powiedz, że w pamięci tego nie ma, zamiast zgadywać.
- Nie pobieraj hurtem: 20 notatek po 300 tokenów to 6 tys. tokenów kontekstu. Indeks wystarcza do decyzji, co czytać.
- Nowa trwała wiedza (decyzja, pułapka, preferencja użytkownika) warta jawnego zapisu: `remember`. Coś nieaktualnego albo błędnego: `forget` z powodem (da się cofnąć: `undo`).
