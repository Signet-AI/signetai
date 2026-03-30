# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json biome.json ./
COPY AGENTS.md CLAUDE.md LICENSE README.md ./
COPY scripts ./scripts
COPY skills ./skills
COPY packages ./packages
COPY public ./public
COPY web ./web

RUN bun install --frozen-lockfile
RUN bun run build:core
RUN bun run build:connector-base
RUN bun run build:opencode-plugin
RUN bun run --filter '@signet/oh-my-pi-extension' build
RUN bun run --filter '@signet/connector-claude-code' --filter '@signet/connector-codex' --filter '@signet/connector-openclaw' --filter '@signet/connector-opencode' --filter '@signet/connector-oh-my-pi' build
RUN bun run build:native
RUN bun run build:dashboard
RUN bun run build:signetai

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV SIGNET_PATH=/data/agents
ENV SIGNET_BIND=0.0.0.0
ENV SIGNET_PORT=3850

COPY --from=build /app/packages/signetai/package.json ./packages/signetai/package.json
RUN cd /app/packages/signetai && bun install --production

COPY --from=build /app/packages/signetai/dist ./packages/signetai/dist
COPY --from=build /app/packages/signetai/dashboard ./packages/signetai/dashboard
COPY --from=build /app/packages/signetai/skills ./packages/signetai/skills
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY deploy/docker/scripts ./deploy/docker/scripts

RUN chmod +x ./deploy/docker/entrypoint.sh ./deploy/docker/scripts/create-token.mjs ./deploy/docker/scripts/healthcheck.mjs

EXPOSE 3850

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 CMD bun /app/deploy/docker/scripts/healthcheck.mjs

ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
