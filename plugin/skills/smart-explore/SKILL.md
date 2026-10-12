---
name: smart-explore
description: Oszczędna w tokenach nawigacja po kodzie narzędziami smart_search, smart_outline i smart_unfold zamiast czytania całych plików. Użyj, gdy trzeba zrozumieć strukturę kodu, znaleźć definicję funkcji albo klasy, albo poznać nieznany fragment repo („gdzie jest X”, „jak zbudowany jest moduł Y”, „find the function”, „explore the codebase”).
---

# Nawigacja po kodzie (smart_*)

Trzy narzędzia, od najtańszego:

1. **`smart_search`** (`query`, opcjonalnie `path`, `file_pattern`, `max_results`): symbole (funkcje, klasy, typy, metody) pasujące do zapytania plus trafienia w tekście. Zaczynaj tu, gdy nie wiesz, gdzie coś jest.
2. **`smart_outline`** (`file_path`): zarys pliku, czyli sygnatury z numerami linii, bez ciał. Zamiast `Read` całego pliku, gdy chcesz wiedzieć, co w nim jest.
3. **`smart_unfold`** (`file_path`, `symbol_name`, także `Klasa.metoda`): pełne ciało jednego symbolu z komentarzem dokumentacyjnym i dekoratorami.

Typowy przebieg: `smart_search` (gdzie), `smart_outline` (co jest obok), `smart_unfold` (konkretna funkcja), a `Read` z `offset` i `limit` dopiero wtedy, gdy potrzebny jest szerszy fragment albo plik do edycji.

Granice: narzędzia działają tylko w obrębie bieżącego projektu (korzeń git, bez repo katalog roboczy). Pliki i katalogi ukryte (`.env`, `.git`) są niedostępne, z wyjątkiem katalogów `.github`, `.gitea` i `.claude`. Pliki z sekretami też: `.env`, klucze, `secrets.*` i `credentials.*` z każdym rozszerzeniem (`secrets.ts`, `secrets.h`, `credentials.json`), katalogi `secrets/`, `secrets.d/`; dostępne są moduły z rolą (`credentials.service.ts`). Katalog konfiguracji Claude Code (`~/.claude`) jest zakryty, gdy korzeniem jest katalog domowy. Do zablokowanych plików i do plików spoza projektu użyj `Read`.

Języki: TypeScript i JavaScript, Python, Go, Rust, C, C++, C#, Java, Kotlin, Swift, PHP, PowerShell, Markdown (nagłówki). To wzorce sygnatur, nie pełny parser: przy nietypowej składni zarys może coś pominąć, wtedy wróć do `Grep` i `Read`. W C, C++, C# i Swifcie zarys obejmuje wszystkie gałęzie `#if`/`#else`.

Wynik przechodzi przez redakcję sekretów, która woli zamaskować za dużo: wartość po nazwie sekretu bywa `[REDACTED]` także wtedy, gdy to kod (`token: [REDACTED];`, `password = [REDACTED]`). To nie błąd zarysu; dokładny tekst pokaże `Read`.

Gdy serwer działa w trybie `slim` (`mcp.tools`), te narzędzia wołasz przez `memory(cmd="smart_search", args={...})` z tymi samymi parametrami.

Przed edycją pliku i tak przeczytaj go narzędziem `Read` (wymóg narzędzia `Edit`).
