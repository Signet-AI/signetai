# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS build
WORKDIR /app

# The daemon image does not run the Electron desktop application. Skipping
# Electron's postinstall download keeps this daemon-only build independent of
# the GitHub release asset network.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock bunfig.toml tsconfig.json biome.json ./
COPY AGENTS.md CLAUDE.md LICENSE README.md ./
COPY scripts ./scripts
COPY skills ./skills
COPY memorybench ./memorybench
COPY platform ./platform
COPY surfaces ./surfaces
COPY integrations ./integrations
COPY libs ./libs
COPY dist ./dist
COPY plugins ./plugins
COPY public ./public
COPY web ./web

RUN bun install --frozen-lockfile
# @signet/sdk bundles @signet/core. Keep the core package's optional native
# dependencies materialized for that build even when their postinstall cannot
# produce a Node addon in this Bun-only image. The runtime uses Bun's SQLite
# implementation, so no better-sqlite3 addon is copied into the final image.
RUN bun install --frozen-lockfile --ignore-scripts --filter '@signet/core'
RUN test -e platform/core/node_modules/better-sqlite3
ARG TARGETOS=linux
ARG TARGETARCH
RUN set -eux; \
	arch="${TARGETARCH:-$(uname -m)}"; \
	case "$arch" in \
		amd64|x86_64) arch="x64" ;; \
		aarch64) arch="arm64" ;; \
	esac; \
	pkg="sqlite-vec-${TARGETOS}-${arch}"; \
	vec_path="$(find node_modules -path "*/${pkg}/vec0.so" -type f | head -n 1)"; \
	test -n "$vec_path"; \
	mkdir -p dist/docker-sqlite-vec; \
	cp "$vec_path" dist/docker-sqlite-vec/vec0.so
RUN bun run build:core
RUN bun run build:connector-base
RUN bun run build:opencode-plugin
# The Docker image intentionally does not install Rust. The image uses the
# bundled Bun native build below, so skip the optional N-API addon build.
RUN SIGNET_SKIP_NATIVE_BUILD=1 bun run build:native
RUN bun run build:oh-my-pi-extension
RUN bun run build:connector-oh-my-pi
RUN bun run build:pi-extension
RUN bun run build:connector-pi
RUN bun run build:deps
RUN bun run build:dashboard
RUN bun run build:signetai
RUN bun run build:native-bun

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV SIGNET_PATH=/data/agents
ENV SIGNET_BIND=0.0.0.0
ENV SIGNET_PORT=3850
ENV SIGNET_DAEMON_ENTRYPOINT=1
ENV SIGNET_VEC_PATH=/app/sqlite-vec/vec0.so
ENV PATH="/root/.bun/bin:${PATH}"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates nodejs \
	&& rm -rf /var/lib/apt/lists/*

ARG CODEX_CLI_VERSION=0.142.5
RUN bun install -g @openai/codex@${CODEX_CLI_VERSION}

COPY --from=build /app/dist/native/signet ./bin/signet
COPY --from=build /app/dist/docker-sqlite-vec ./sqlite-vec
COPY --from=build /app/dist/signetai/templates ./dist/signetai/templates
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY deploy/docker/scripts ./deploy/docker/scripts

RUN chmod +x ./bin/signet ./deploy/docker/entrypoint.sh ./deploy/docker/scripts/create-token.mjs ./deploy/docker/scripts/healthcheck.mjs

EXPOSE 3850

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 CMD bun /app/deploy/docker/scripts/healthcheck.mjs

ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
