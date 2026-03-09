FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
