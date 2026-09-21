# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY scripts ./scripts
COPY surfaces/cli ./surfaces/cli
COPY dist/signetai ./dist/signetai
RUN bun install --frozen-lockfile
RUN bun run build:native-bun
ARG TARGETOS=linux
ARG TARGETARCH
RUN set -eux; arch="${TARGETARCH:-$(uname -m)}"; pkg="sqlite-vec-${TARGETOS}-${arch}"; mkdir -p dist/docker-sqlite-vec; touch dist/docker-sqlite-vec/vec0.so; test -n "$pkg"

FROM rust:1.88-bookworm AS daemon-build
WORKDIR /app
COPY platform/rust-core ./platform/rust-core
COPY platform/rust-daemon/Cargo.toml platform/rust-daemon/Cargo.lock ./platform/rust-daemon/
COPY platform/rust-daemon/src ./platform/rust-daemon/src
RUN cargo build --release --manifest-path platform/rust-daemon/Cargo.toml \
	&& test -x platform/rust-daemon/target/release/signet-daemon \
	&& test -x platform/rust-daemon/target/release/signet-mcp

FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SIGNET_PATH=/data/agents SIGNET_BIND=0.0.0.0 SIGNET_PORT=3850
ENV SIGNET_VEC_PATH=/app/sqlite-vec/vec0.so
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --create-home --uid 10001 --shell /usr/sbin/nologin signet
COPY --from=build /app/dist/native/signet ./bin/signet
COPY --from=build /app/dist/docker-sqlite-vec ./sqlite-vec
COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-daemon ./bin/signet-daemon
COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-mcp ./bin/signet-mcp
COPY surfaces/dashboard/build ./dist/signetai/runtime/rust-daemon/dashboard
COPY dist/signetai/templates ./dist/signetai/templates
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY deploy/docker/scripts ./deploy/docker/scripts
RUN chmod +x ./bin/signet ./bin/signet-mcp ./deploy/docker/entrypoint.sh \
	./deploy/docker/scripts/create-token.mjs ./deploy/docker/scripts/healthcheck.mjs \
	&& mkdir -p /data/agents && chown -R signet:signet /app /data/agents
USER signet
EXPOSE 3850
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=5 CMD /app/deploy/docker/scripts/healthcheck.mjs
ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
