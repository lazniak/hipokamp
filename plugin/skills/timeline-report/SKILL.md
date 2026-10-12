---
name: timeline-report
description: Tworzy raport z historii projektu na podstawie pamięci hipokampa: etapy, decyzje, przełomy, powracające problemy, stan obecny. Użyj przy prośbach „historia projektu”, „podsumuj, jak powstawał X”, „raport z prac nad Y”, „timeline report”, „project history”.
---

# Raport z historii projektu

1. Ustal projekt (bieżący albo wskazany) i okres. `search` z `project`, `type: "sessions"` i `orderBy: "date_asc"` (zakres: `dateStart`, `dateEnd`) daje szkielet: sesje z podsumowaniami w kolejności.
2. Znajdź punkty zwrotne: `search` z `type` równym `decision`, `gotcha`, `bugfix` i zapytaniami o kluczowe tematy projektu. Notuj `#id`.
3. Dla 5 do 10 najważniejszych momentów: `timeline` wokół `#id` (kontekst przed i po), potem `get_observations` tylko dla tego, czego nie da się opisać z indeksu.
4. Napisz raport po polsku:
   - **Okres i skala**: daty, liczba sesji i notatek.
   - **Etapy**: 3 do 6 faz, każda z datami i jednym zdaniem, co się w niej stało.
   - **Decyzje**: co postanowiono i dlaczego (z `#id`).
   - **Problemy, które wracały**: błędy i pułapki, ile razy, czy zamknięte.
   - **Stan obecny i otwarte wątki**: ostatnie podsumowania, otwarte listy pracy (`work_state_read`).
5. Fakty tylko z pamięci, z numerami `#id`. Luki (okresy bez notatek) nazwij wprost. Notatki z ⚠ (plik zmieniony) opisuj jako stan historyczny.

Raport dla zespołu albo do udostępnienia: zaproponuj zapis do pliku albo stronę.
