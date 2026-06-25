# syntax=docker/dockerfile:1

FROM oven/bun:1-slim AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim AS rita

ENV NODE_ENV=production
ENV PORT=7777

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const port = process.env.PORT || '7777'; const res = await fetch(`http://127.0.0.1:${port}/status`); if (!res.ok) process.exit(1);"]

USER bun

CMD ["bun", "src/server.ts"]
