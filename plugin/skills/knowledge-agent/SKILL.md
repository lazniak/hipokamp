---
name: knowledge-agent
description: Buduje z pamięci hipokampa tematyczny korpus wiedzy („mózg” o jednym temacie) i odpowiada na pytania na jego podstawie, za darmo. Użyj, gdy użytkownik chce zebrać całą wiedzę o temacie, projekcie albo technologii, zapytać o wzorce w dawnej pracy, albo przygotować ekspercki przegląd („zbierz wszystko o X”, „czego się nauczyliśmy o Y”, „build a knowledge base about Z”).
---

# Korpusy wiedzy

W claude-mem te same narzędzia uruchamiają płatnego „knowledge agenta”. W hipokampie korpus to zapisany filtr i lista `#id`, a syntezę robisz Ty z dowodów, które zwraca narzędzie. Bez dodatkowych kosztów.

## Przebieg

1. **`build_corpus`**: nazwa (krótka, np. `auth-hexart`), opis i filtry: `project`, `types`, `concepts`, `files`, `dateStart`, `dateEnd`, opcjonalnie `query` i `limit` (domyślnie 500 notatek). Zacznij szeroko; za mały korpus to puste odpowiedzi.
2. **`prime_corpus`**: przegląd (liczby, typy, okres, 40 najważniejszych notatek). Przeczytaj go, zanim odpowiesz na pierwsze pytanie.
3. **`query_corpus`** z pytaniem: dostajesz do 8 notatek-dowodów (ranking BM25 + wektory w obrębie korpusu). Odpowiedź buduj tylko z nich i cytuj `#id`. Gdy dowodów brak, powiedz to.
4. Po nowej pracy w temacie: **`rebuild_corpus`** (filtry jeszcze raz na świeżych danych), potem **`reprime_corpus`**.

`list_corpora` pokazuje istniejące korpusy. Szczegóły pojedynczej notatki: `get_observations`.
