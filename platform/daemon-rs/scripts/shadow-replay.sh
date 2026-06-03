#!/usr/bin/env bash
#
# Shadow replay setup: runs TS daemon (primary :3850) and Rust daemon
# (shadow :3851) with the shadow proxy (:3849) comparing responses.
#
# Usage:
#   ./scripts/shadow-replay.sh start    # start all three processes
#   ./scripts/shadow-replay.sh stop     # stop all processes
#   ./scripts/shadow-replay.sh analyze  # analyze divergence log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_RS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DAEMON_RS_DIR/../.." && pwd)"

AGENTS_DIR="${SIGNET_PATH:-$HOME/.agents}"
SHADOW_DB_DIR="$AGENTS_DIR/.shadow-replay"
SHADOW_DB="$SHADOW_DB_DIR/memory/memories.db"
LIVE_DB="$AGENTS_DIR/memory/memories.db"

RUST_DAEMON="$DAEMON_RS_DIR/target/release/signet-daemon"
RUST_SHADOW="$DAEMON_RS_DIR/target/release/signet-shadow"

PID_DIR="$AGENTS_DIR/.daemon"
PROXY_PORT="${SIGNET_SHADOW_PROXY_PORT:-3849}"
PRIMARY_PORT="${SIGNET_SHADOW_PRIMARY_PORT:-3850}"
SHADOW_PORT="${SIGNET_SHADOW_RUST_PORT:-3851}"

case "${1:-help}" in
  start)
    echo "=== Shadow Replay Setup ==="
    echo ""

    # Build Rust binaries
    echo "Building Rust daemon (release)..."
    (cd "$DAEMON_RS_DIR" && cargo build --release -p signet-daemon -p signet-shadow --quiet)

    # Create isolated shadow DB directory
    echo "Setting up isolated shadow DB..."
    mkdir -p "$SHADOW_DB_DIR/memory"
    mkdir -p "$SHADOW_DB_DIR/.daemon/logs"
    mkdir -p "$PID_DIR"

    # Copy live DB to shadow (isolated copy)
    if [ -f "$LIVE_DB" ]; then
      cp "$LIVE_DB" "$SHADOW_DB"
      # Also copy WAL if exists
      [ -f "$LIVE_DB-wal" ] && cp "$LIVE_DB-wal" "$SHADOW_DB-wal" || true
      [ -f "$LIVE_DB-shm" ] && cp "$LIVE_DB-shm" "$SHADOW_DB-shm" || true
      echo "Copied live DB to shadow: $(du -h "$SHADOW_DB" | cut -f1)"
    else
      echo "WARNING: No live DB found at $LIVE_DB. Shadow will use fresh DB."
    fi

    # Copy agent.yaml to shadow
    [ -f "$AGENTS_DIR/agent.yaml" ] && cp "$AGENTS_DIR/agent.yaml" "$SHADOW_DB_DIR/" || true

    # Start TS daemon on the primary port (if not already running)
    if curl -s "http://localhost:$PRIMARY_PORT/health" | grep -q '"status"[[:space:]]*:[[:space:]]*"healthy"' 2>/dev/null; then
      echo "TS daemon already running on :$PRIMARY_PORT"
    else
      echo "Starting TS daemon on :$PRIMARY_PORT..."
      (
        cd "$REPO_ROOT/platform/daemon"
        nohup env SIGNET_PATH="$AGENTS_DIR" SIGNET_PORT="$PRIMARY_PORT" SIGNET_BIND=127.0.0.1 \
          bun src/daemon.ts >"$PID_DIR/ts-daemon.log" 2>&1 &
        echo $! > "$PID_DIR/ts-daemon.pid"
      )
      sleep 3
    fi

    # Start Rust daemon on the shadow port (shadow, isolated DB)
    echo "Starting Rust daemon on :$SHADOW_PORT (shadow)..."
    nohup env SIGNET_PATH="$SHADOW_DB_DIR" SIGNET_PORT="$SHADOW_PORT" SIGNET_BIND=127.0.0.1 \
      "$RUST_DAEMON" >"$PID_DIR/rust-shadow.log" 2>&1 &
    echo $! > "$PID_DIR/rust-shadow.pid"
    sleep 2

    # Verify both daemons
    echo ""
    echo "Verifying daemons..."
    echo -n "  TS  (:$PRIMARY_PORT): "
    curl -s "http://localhost:$PRIMARY_PORT/health" | head -c 100
    echo ""
    echo -n "  Rust (:$SHADOW_PORT): "
    curl -s "http://localhost:$SHADOW_PORT/health" | head -c 100
    echo ""

    # Start shadow proxy on the proxy port
    echo ""
    echo "Starting shadow proxy on :$PROXY_PORT..."
    nohup env SIGNET_PATH="$AGENTS_DIR" SIGNET_PARITY_RULES="$DAEMON_RS_DIR/contracts/parity-rules.json" \
      "$RUST_SHADOW" \
        --proxy-port "$PROXY_PORT" \
        --primary-port "$PRIMARY_PORT" \
        --shadow-port "$SHADOW_PORT" >"$PID_DIR/shadow-proxy.log" 2>&1 &
    echo $! > "$PID_DIR/shadow-proxy.pid"
    sleep 1

    echo ""
    echo "=== Shadow Replay Running ==="
    echo ""
    echo "  Proxy (use this):  http://localhost:$PROXY_PORT"
    echo "  Primary (TS):      http://localhost:$PRIMARY_PORT"
    echo "  Shadow (Rust):     http://localhost:$SHADOW_PORT"
    echo ""
    echo "  Divergence log:    $AGENTS_DIR/.daemon/logs/shadow-divergences.jsonl"
    echo ""
    echo "  To stop:    $0 stop"
    echo "  To analyze: $0 analyze"
    echo ""
    echo "Point your connectors/tools at port $PROXY_PORT instead of $PRIMARY_PORT to"
    echo "exercise shadow comparison during normal usage."
    ;;

  stop)
    echo "Stopping shadow replay processes..."
    for pidfile in "$PID_DIR/shadow-proxy.pid" "$PID_DIR/rust-shadow.pid" "$PID_DIR/ts-daemon.pid"; do
      if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
          kill "$pid" 2>/dev/null || true
          echo "  Stopped PID $pid ($(basename "$pidfile" .pid))"
        fi
        rm -f "$pidfile"
      fi
    done
    echo "Done."
    ;;

  analyze)
    LOG="$AGENTS_DIR/.daemon/logs/shadow-divergences.jsonl"
    if [ ! -f "$LOG" ]; then
      echo "No divergence log found at $LOG"
      echo "Start shadow replay first: $0 start"
      exit 1
    fi
    "$RUST_SHADOW" --analyze --log "$LOG"
    ;;

  *)
    echo "Usage: $0 {start|stop|analyze}"
    echo ""
    echo "  start    Start TS daemon, Rust daemon, and shadow proxy"
    echo "  stop     Stop all shadow replay processes"
    echo "  analyze  Analyze divergence log"
    exit 1
    ;;
esac
