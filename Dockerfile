FROM oven/bun:1.2 AS base
WORKDIR /app
COPY package.json bun.lock ./
# bun install regenerates bun.lock (required after removing @supabase/supabase-js)
RUN bun install
COPY . .
USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
