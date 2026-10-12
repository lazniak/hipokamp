# Hub synchronizacji hipokampa (docs/SYNC.md). Obraz ma tylko dwa pliki z repo: src/sync/server.ts i protocol.ts,
# bez zależności npm. Kontekst budowania = korzeń repo (docker-compose.yml: context ./app).
FROM oven/bun:1.3-alpine

WORKDIR /app
COPY src/sync/server.ts src/sync/protocol.ts ./src/sync/

# w kontenerze 0.0.0.0, ale docker-compose publikuje port tylko na 127.0.0.1 hosta (z zewnątrz wyłącznie nginx z HTTPS)
ENV HIPOKAMP_SYNC_HOST=0.0.0.0 \
    HIPOKAMP_SYNC_PORT=47790 \
    HIPOKAMP_SYNC_DB=/data/hub.db \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    NODE_ENV=production

RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 47790

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:47790/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "src/sync/server.ts"]
