#!/usr/bin/env bash
# Buduje natywny hook (native/hook/hipokamp-hook[.exe]) z Go: vet, testy, build, test dymny, podmiana pliku.
# Binarka nie trafia do repo (.gitignore). Potem `hipokamp install` (hooks.mode auto albo native) wpisze ją do hooks.json.
# Użycie: bash scripts/build-native.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/native/hook"
command -v go >/dev/null || { echo "brak Go (https://go.dev/dl/); hipokamp działa dalej z hookiem Buna" >&2; exit 1; }
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ext=.exe ;; *) ext= ;; esac
exe="hipokamp-hook$ext"
# rozszerzenie na końcu, jak w build-native.ps1 (na Windows uruchamia się tylko plik .exe)
new="hipokamp-hook.new$ext"
# wersja, której oczekuje kod TS (src/hooks/modes.ts); niezgodna = instalator i doctor odrzucą binarkę
want="$(sed -n 's/.*NATIVE_VERSION = \([0-9][0-9]*\).*/\1/p' "$root/src/hooks/modes.ts")"
[ -n "$want" ] || { echo "brak NATIVE_VERSION w src/hooks/modes.ts" >&2; exit 1; }
cd "$dir"
trap 'rm -f "$new"' EXIT
go vet ./...
go test ./...
go build -trimpath -ldflags '-s -w' -o "$new" .
smoke="$("./$new" --smoke)"
case "$smoke" in
  *'"app":"hipokamp-hook"'*'"hookTs":true'*) ;;
  *) echo "test dymny nieudany: $smoke" >&2; exit 1 ;;
esac
got="$(printf '%s' "$smoke" | sed -n 's/.*"version":\([0-9][0-9]*\).*/\1/p')"
[ "$got" = "$want" ] || { echo "wersja $got w main.go, a src/hooks/modes.ts oczekuje $want (podbij obie razem)" >&2; exit 1; }
# Podmiana. Linux i macOS: rename podmienia plik atomowo, działający hook trzyma stary i-węzeł. Windows (Git Bash):
# działającego .exe nie da się nadpisać, ale da się zmienić mu nazwę, więc stary odkładamy jako .old-<czas>
# (sprzątany przy następnym budowaniu). Antywirus potrafi chwilę trzymać świeży plik, stąd kilka prób.
rm -f hipokamp-hook.old-* 2>/dev/null || true
ok=
for _ in 1 2 3 4 5 6 7 8 9 10; do
  old=
  if [ -n "$ext" ] && [ -e "$exe" ]; then
    old="hipokamp-hook.old-$(date +%Y%m%d%H%M%S)-$$-$RANDOM$ext"
    mv "$exe" "$old" 2>/dev/null || { sleep 0.3; continue; }
  fi
  if mv -f "$new" "$exe" 2>/dev/null; then ok=1; break; fi
  # nowy nie wszedł: stary wraca na swoje miejsce przed kolejną próbą (inaczej po nieudanych próbach nie byłoby żadnego)
  if [ -n "$old" ] && [ ! -e "$exe" ]; then mv "$old" "$exe" 2>/dev/null || true; fi
  sleep 0.3
done
if [ -z "$ok" ]; then
  if [ -e "$exe" ]; then state="stary plik działa dalej"; else state="nie ma $exe, hooki idą przez Buna (zapas po ||)"; fi
  echo "nie mogę podmienić $exe po 10 próbach: plik trzyma inny proces (antywirus albo hook sesji); $state. Uruchom skrypt ponownie za chwilę" >&2
  exit 1
fi
echo "gotowe: $dir/$exe (wersja $got). Teraz: hipokamp install"
