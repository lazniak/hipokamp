---
name: how-it-works
description: Wyjaśnia, jak działa pamięć hipokampa: co i kiedy zapisuje, kiedy coś przypomina, gdzie leżą dane, ile to kosztuje i jak to wyłączyć. Użyj przy pytaniach „jak działa pamięć?”, „co ten hipokamp robi?”, „skąd Claude to wie?”, „how does the memory work?”.
---

# Jak działa hipokamp

Odpowiadaj krótko, po polsku, konkretami z tej listy. Gdy pytanie dotyczy stanu (ile notatek, czy działa), uruchom `hipokamp status` albo `hipokamp doctor` i podaj liczby.

**Zapis (bez żadnego LLM, 0 zł).** Po każdej turze hook czyta transkrypt sesji od miejsca, w którym skończył, i robi z tury jedną notatkę: tytuł i narracja z końcowej odpowiedzi Claude, fakty z narzędzi (pliki, komendy, błędy, decyzje). Sekrety są maskowane przed zapisem, fragmenty w `<private>...</private>` pomijane, narzędzia sejfu nie trafiają do pamięci wcale. Jeśli hook nie zdąży (zamknięte okno), worker dociąga zaległości co 10 minut, bo transkrypt jest trwałą kolejką.

**Przypominanie (trzy miejsca).**
- Start sesji: otwarte listy pracy, ostatnie sesje, najważniejsze notatki projektu (do ok. 1600 tokenów).
- Każdy prompt: tylko gdy trafienie w pamięci jest pewne (próg 0,62), max 5 krótkich wpisów.
- Otwarcie albo edycja pliku: pułapki i decyzje dotyczące tego pliku, z ostrzeżeniem ⚠, gdy plik zmienił się po notatce.

Nic nie powtarza się w tej samej sesji. Ranking: trafność (BM25 + wektory bge-m3), świeżość i częstość użycia (ACT-R), powiązania przez pliki i pojęcia, ważność; notatki wstrzykiwane i nieużywane schodzą niżej.

**Dane.** `~/.hipokamp/hipokamp.db` (SQLite), kopie co 24 h w `~/.hipokamp/backups/db`, logi w `~/.hipokamp/logs`. Nic nie wychodzi z komputera; jedyny ruch sieciowy to jednorazowe pobranie modelu wektorów. Brak telemetrii i kont.

**Narzędzia.** `search`, `timeline`, `get_observations`, `get_tool_uses` (przeszukiwanie), `remember`, `forget` (zapis i usuwanie), `work_state_read`, `work_state_write` (listy pracy), korpusy, `smart_*` (kod). Podgląd: `hipokamp open` (przeglądarka z jednorazowym linkiem, potem ciasteczko na 30 dni; bez niego http://127.0.0.1:47777 pokazuje tylko instrukcję wejścia).

**Sterowanie.** `hipokamp config` (ustawienia w `~/.hipokamp/config.json`), `hipokamp sleep` (konsolidacja), `hipokamp backup` / `restore`, `hipokamp rollback` (powrót do claude-mem). Wykluczenie projektu: `capture.excludeProjects`. Opcjonalne, domyślnie wyłączone: `hipokamp notify` (powiadomienia lokalne, `notify.enabled`), `hipokamp llm check` (lokalny LLM w śnie, `consolidation.llm.enabled`). Pamięć automatyczna Claude Code: `hipokamp import-automemory` (plan, `--apply` zapisuje i włącza dociąganie zmian w workerze); eksport decyzji do vaulta: `hipokamp export-vault <katalog>`.
