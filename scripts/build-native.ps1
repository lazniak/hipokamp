# Buduje natywny hook (native/hook/hipokamp-hook.exe) z Go: vet, testy, build, test dymny, podmiana pliku.
# Binarka nie trafia do repo (.gitignore). Potem `hipokamp install` (hooks.mode auto albo native) wpisze ją do hooks.json.
# Użycie: pwsh scripts/build-native.ps1
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '..\native\hook'
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'brak Go (https://go.dev/dl/); hipokamp działa dalej z hookiem Buna' }
$win = $IsWindows -or $env:OS -eq 'Windows_NT'
$ext = if ($win) { '.exe' } else { '' }
$exe = "hipokamp-hook$ext"
# rozszerzenie na końcu: PowerShell uruchamia tylko pliki z rozszerzeniem z PATHEXT (hipokamp-hook.exe.new otworzyłby okno „Otwórz za pomocą”)
$new = "hipokamp-hook.new$ext"
# wersja, której oczekuje kod TS (src/hooks/modes.ts); niezgodna = instalator i doctor odrzucą binarkę
$modes = Get-Content -Raw (Join-Path $PSScriptRoot '..\src\hooks\modes.ts')
$want = if ($modes -match 'NATIVE_VERSION = (\d+)') { [int]$Matches[1] } else { throw 'brak NATIVE_VERSION w src/hooks/modes.ts' }
Push-Location $dir
try {
  go vet ./...
  if ($LASTEXITCODE) { throw 'go vet nieudany' }
  go test ./...
  if ($LASTEXITCODE) { throw 'testy Go nieudane' }
  go build -trimpath -ldflags '-s -w' -o $new .
  if ($LASTEXITCODE) { throw 'go build nieudany' }
  $smoke = & (Join-Path (Get-Location) $new) --smoke | ConvertFrom-Json
  if ($smoke.app -ne 'hipokamp-hook' -or -not $smoke.hookTs) { throw "test dymny nieudany: $($smoke | ConvertTo-Json -Compress)" }
  if ($smoke.version -ne $want) { throw "wersja $($smoke.version) w main.go, a src/hooks/modes.ts oczekuje $want (podbij obie razem)" }
  # Podmiana. Na Windows pliku .exe, który właśnie działa (hook trwającej sesji), nie da się nadpisać ani usunąć,
  # ale da się zmienić mu nazwę: stary plik odkładamy jako hipokamp-hook.old-<czas>.exe (sprzątany przy następnym
  # budowaniu), nowy wchodzi na jego miejsce. Antywirus potrafi chwilę trzymać świeży plik, stąd kilka prób.
  Get-ChildItem -Filter "hipokamp-hook.old-*$ext" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
  $done = $false
  $why = ''
  for ($i = 1; $i -le 10 -and -not $done; $i++) {
    $old = $null
    try {
      if (Test-Path $exe) {
        $old = "hipokamp-hook.old-$(Get-Date -Format 'yyyyMMddHHmmssfff')$ext"
        Move-Item $exe $old
      }
      Move-Item $new $exe
      $done = $true
    } catch {
      $why = $_.Exception.Message
      # nowy nie wszedł: stary wraca na swoje miejsce przed kolejną próbą (inaczej po nieudanych próbach nie byłoby żadnego)
      if ($old -and -not (Test-Path $exe) -and (Test-Path $old)) {
        try { Move-Item $old $exe } catch { $why += "; powrót starego pliku: $($_.Exception.Message)" }
      }
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $done) {
    $state = if (Test-Path $exe) { 'stary plik działa dalej' } else { "nie ma $exe, hooki idą przez Buna (zapas po ||)" }
    throw "nie mogę podmienić $exe po 10 próbach ($why). Plik trzyma inny proces (antywirus albo hook sesji); $state. Uruchom skrypt ponownie za chwilę."
  }
  Write-Host "gotowe: $(Join-Path $dir $exe) (wersja $($smoke.version)). Teraz: hipokamp install"
} finally {
  if (Test-Path $new) { Remove-Item -Force $new -ErrorAction SilentlyContinue }
  Pop-Location
}
