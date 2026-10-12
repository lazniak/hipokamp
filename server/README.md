# Hub synchronizacji hipokampa: pliki wdrożeniowe

Hub to `src/sync/server.ts` (+ `src/sync/protocol.ts`): jeden proces Buna z SQLite, bez zależności npm. Opis protokołu, szyfrowania i numeracji: [docs/SYNC.md](../docs/SYNC.md). Wdrożenie na własnym serwerze: kroki w docs/SYNC.md, sekcja 10.

| plik | gdzie na serwerze | co |
|---|---|---|
| `Dockerfile` (+ `Dockerfile.dockerignore`) | `/opt/hipokamp-sync/app/server/` | obraz `oven/bun:1.3-alpine` z dwoma plikami huba, użytkownik `bun`, healthcheck |
| `docker-compose.yml` | `/opt/hipokamp-sync/docker-compose.yml` | kontener `hipokamp-sync`, dane w `./data`, port tylko `127.0.0.1:47790`, system plików tylko do odczytu, bez uprawnień |
| `hub.env.example` | `/opt/hipokamp-sync/.env` (chmod 600) | skrót sekretu bootstrapu i opcjonalne limity |
| `nginx-hub.example.com.conf` | `/etc/nginx/sites-available/` | proxy HTTPS (certbot) do `127.0.0.1:47790`, `X-Real-IP`, `limit_req` na każdą ścieżkę (ostrzej na prośby o dołączenie, health i bootstrap) |

Kroki wdrożenia, sprawdzenia i wycofania: [docs/SYNC.md, sekcja 10](../docs/SYNC.md#10-wdrożenie-huba-na-własnym-serwerze).

Lokalna próba bez Dockera (port 47790, baza w `./data/hub.db`, bez bootstrapu):

```bash
bun src/sync/server.ts
curl -s http://127.0.0.1:47790/v1/health
```

Zmienne środowiskowe huba: `HIPOKAMP_SYNC_DB`, `HIPOKAMP_SYNC_HOST`, `HIPOKAMP_SYNC_PORT`, `HIPOKAMP_SYNC_PUBLIC_HOSTS`, `HIPOKAMP_SYNC_REQUIRE_HTTPS`, `HIPOKAMP_SYNC_TRUST_PROXY`, `HIPOKAMP_SYNC_TRUSTED_PROXIES`, `HIPOKAMP_SYNC_BOOTSTRAP_SHA256`, `HIPOKAMP_SYNC_RESTORED`, `HIPOKAMP_SYNC_MAX_TOTAL_MB`, `HIPOKAMP_SYNC_RATE_PER_MIN` (opis w `startFromEnv`, `src/sync/server.ts`). `HIPOKAMP_SYNC_TRUST_PROXY=1` tylko za nginx, który nadpisuje `X-Real-IP`; hub i tak bierze ten nagłówek wyłącznie z połączeń od adresu loopback albo prywatnego (nginx przez bramę Dockera) albo z `HIPOKAMP_SYNC_TRUSTED_PROXIES`, a przy nasłuchu poza 127.0.0.1 ostrzega w dzienniku przy starcie.

Kopia `data/hub.db` przywrócona po awarii cofa dziennik i zapomina urządzenia dołączone po kopii, a numer urządzenia wydany drugi raz gubi notatki po cichu. Przywrócenie, w tej kolejności (docs/SYNC.md, sekcja 9):

1. W `.env` huba nowa wartość `HIPOKAMP_SYNC_RESTORED` (np. data przywrócenia), potem `docker compose up -d`: hub startuje w trybie odzyskiwania i nie zatwierdza żadnego urządzenia.
2. `hipokamp sync resync` na **każdym** urządzeniu, które hub zna; na wszystkich z rolą admin obowiązkowo (każdy admin podnosi licznik numerów do tych, które sam nadał).
3. Urządzenia, których hub nie zna (komunikat o nieznanym kluczu): `hipokamp sync leave --yes`, potem `hipokamp sync join`.
4. Gdy wszystkie prośby czekają (`hipokamp sync joins`): `hipokamp sync add-device <kod> --ack-lost-devices` (koniec trybu odzyskiwania), dalej zwykłe `add-device`.
