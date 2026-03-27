# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json biome.json ./
COPY AGENTS.md CLAUDE.md LICENSE README.md ./
COPY scripts ./scripts
COPY packages ./packages
COPY public ./public
COPY web ./web

RUN bun install --frozen-lockfile
RUN bun run build:dashboard
RUN bun run build:signetai

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV SIGNET_PATH=/data/agents
ENV SIGNET_BIND=0.0.0.0
ENV SIGNET_PORT=3850

COPY --from=build /app/packages/signetai/dist ./packages/signetai/dist
COPY --from=build /app/packages/signetai/dashboard ./packages/signetai/dashboard
COPY --from=build /app/packages/signetai/templates ./packages/signetai/templates
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY deploy/docker/scripts ./deploy/docker/scripts

RUN chmod +x ./deploy/docker/entrypoint.sh ./deploy/docker/scripts/create-token.mjs

EXPOSE 3850

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.SIGNET_PORT ?? '3850') + '/health'); if (!r.ok) process.exit(1);"

ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
