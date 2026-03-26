FROM oven/bun:1.2 AS base
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
USER bun
EXPOSE 8080
CMD ["bun", "/app/src/index.ts"]
