# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY scripts ./scripts
COPY integrations ./integrations
COPY libs ./libs
COPY memorybench ./memorybench
COPY platform/core ./platform/core
COPY platform/native ./platform/native
COPY surfaces ./surfaces
COPY web ./web
COPY dist ./dist
RUN bun install --no-frozen-lockfile --force
RUN SIGNET_SKIP_NATIVE_BUILD=1 bun run build:native
RUN bun run build:dashboard
RUN bun run --filter '@signet/core' build
RUN bun run build:connector-base && bun run build:opencode-plugin && bun run build:oh-my-pi-extension && bun run build:connector-oh-my-pi && bun run build:pi-extension && bun run build:connector-pi && bun run build:deps
RUN bun run build:native-bun
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

FROM rust:1.88-bookworm AS daemon-build
WORKDIR /app
COPY platform/rust-core ./platform/rust-core
COPY platform/rust-daemon/Cargo.toml platform/rust-daemon/Cargo.lock ./platform/rust-daemon/
COPY platform/rust-daemon/src ./platform/rust-daemon/src
RUN cargo build --release --manifest-path platform/rust-daemon/Cargo.toml \
	&& test -x platform/rust-daemon/target/release/signet-daemon \
	&& test -x platform/rust-daemon/target/release/signet-mcp \
	&& test -x platform/rust-daemon/target/release/signet-healthcheck

FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SIGNET_PATH=/data/agents SIGNET_BIND=0.0.0.0 SIGNET_PORT=3850 SIGNET_DAEMON_ENTRYPOINT=1 SIGNET_DAEMON_PATH=/app/bin/signet-daemon
ENV SIGNET_VEC_PATH=/app/sqlite-vec/vec0.so
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --create-home --uid 10001 --shell /usr/sbin/nologin signet
COPY --from=build /app/dist/native/signet ./bin/signet
COPY --from=build /app/dist/docker-sqlite-vec ./sqlite-vec
COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-daemon ./bin/signet-daemon
COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-mcp ./bin/signet-mcp
COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-healthcheck ./bin/signet-healthcheck
COPY --from=build /app/surfaces/dashboard/build ./dist/signetai/runtime/rust-daemon/dashboard
COPY dist/signetai/templates ./dist/signetai/templates
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY deploy/docker/scripts/create-token.mjs ./deploy/docker/scripts/create-token.mjs
RUN chmod +x ./bin/signet ./bin/signet-mcp ./bin/signet-healthcheck ./deploy/docker/entrypoint.sh \
	./deploy/docker/scripts/create-token.mjs \
	&& mkdir -p /data/agents && chown -R signet:signet /app /data/agents
USER signet
EXPOSE 3850
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 CMD /app/bin/signet-healthcheck
ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
