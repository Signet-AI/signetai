#!/usr/bin/env bash
#
# Cutover script: switch from TS daemon to Rust daemon.
#
# Prerequisites:
#   - cargo build --release has been run
#   - shadow replay has passed (0 critical divergences)
#   - canary has been validated (24h minimum)
#
# Usage:
#   ./scripts/cutover.sh           # full cutover
#   ./scripts/cutover.sh --dry-run # show what would be done
#   ./scripts/cutover.sh --rollback # revert to TS daemon

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_RS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DAEMON_RS_DIR/../.." && pwd)"
TS_DAEMON_DIR="$REPO_ROOT/platform/daemon"

RUST_DAEMON_BIN="$DAEMON_RS_DIR/target/release/signet-daemon"
RUST_MCP_BIN="$DAEMON_RS_DIR/target/release/signet-mcp-stdio"
RUST_SHADOW_BIN="$DAEMON_RS_DIR/target/release/signet-shadow"

DRY_RUN=false
ROLLBACK=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --rollback) ROLLBACK=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--rollback]"
      echo ""
      echo "  --dry-run   Show what would be done without making changes"
      echo "  --rollback  Revert to TS daemon"
      exit 0
      ;;
  esac
done

log() {
  echo "[cutover] $*"
}

run() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------

if $ROLLBACK; then
  log "Rolling back to TS daemon..."

  # Stop Rust daemon service if running
  if systemctl --user is-active signet.service >/dev/null 2>&1; then
    log "Stopping Rust daemon service..."
    run systemctl --user stop signet.service
  elif launchctl list ai.signet.daemon >/dev/null 2>&1; then
    log "Stopping Rust daemon service..."
    run launchctl unload ~/Library/LaunchAgents/ai.signet.daemon.plist 2>/dev/null || true
  fi

  # Start TS daemon
  log "Starting TS daemon..."
  run bash -c "cd '$TS_DAEMON_DIR' && bun src/daemon.ts &"

  log "Rollback complete. TS daemon should be running on port 3850."
  log "Verify: curl -s http://localhost:3850/health"
  exit 0
fi

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

log "Running pre-flight checks..."

# Check Rust binary exists
if [ ! -f "$RUST_DAEMON_BIN" ]; then
  echo "ERROR: Rust daemon binary not found at $RUST_DAEMON_BIN"
  echo "Run: cd $DAEMON_RS_DIR && cargo build --release"
  exit 1
fi

if [ ! -f "$RUST_MCP_BIN" ]; then
  echo "ERROR: Rust MCP binary not found at $RUST_MCP_BIN"
  echo "Run: cd $DAEMON_RS_DIR && cargo build --release"
  exit 1
fi

# Check binary sizes
DAEMON_SIZE=$(stat -f%z "$RUST_DAEMON_BIN" 2>/dev/null || stat -c%s "$RUST_DAEMON_BIN" 2>/dev/null || echo 0)
MCP_SIZE=$(stat -f%z "$RUST_MCP_BIN" 2>/dev/null || stat -c%s "$RUST_MCP_BIN" 2>/dev/null || echo 0)
DAEMON_MB=$((DAEMON_SIZE / 1024 / 1024))
MCP_MB=$((MCP_SIZE / 1024 / 1024))

log "Binary sizes: daemon=${DAEMON_MB}MB, mcp=${MCP_MB}MB"

if [ "$DAEMON_MB" -gt 30 ]; then
  echo "WARNING: daemon binary exceeds 30MB SLO target"
fi

# Check shadow divergence log
SHADOW_LOG="${SIGNET_PATH:-$HOME/.agents}/.daemon/logs/shadow-divergences.jsonl"
if [ -f "$SHADOW_LOG" ]; then
  CRITICAL_COUNT=$("$RUST_SHADOW_BIN" --analyze --log "$SHADOW_LOG" 2>/dev/null | grep -c "FAIL" || echo 0)
  if [ "$CRITICAL_COUNT" -gt 0 ]; then
    echo "WARNING: Shadow replay has critical divergences. Review before cutover."
    "$RUST_SHADOW_BIN" --analyze --log "$SHADOW_LOG" 2>/dev/null || true
    if ! $DRY_RUN; then
      read -rp "Continue anyway? [y/N] " confirm
      if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        exit 1
      fi
    fi
  else
    log "Shadow replay: PASS"
  fi
fi

# Check tests pass
log "Running test suite..."
if ! $DRY_RUN; then
  (cd "$DAEMON_RS_DIR" && cargo test --workspace --quiet) || {
    echo "ERROR: Tests failed. Fix before cutover."
    exit 1
  }
fi

# ---------------------------------------------------------------------------
# Cutover
# ---------------------------------------------------------------------------

log "Starting cutover..."

# 1. Stop TS daemon if running
if pgrep -f "bun.*daemon.ts" >/dev/null 2>&1; then
  log "Stopping TS daemon..."
  run pkill -f "bun.*daemon.ts" || true
  sleep 2
fi

# Also stop via systemd/launchd if installed
if systemctl --user is-active signet.service >/dev/null 2>&1; then
  log "Stopping existing service..."
  run systemctl --user stop signet.service
fi

# 2. Install Rust daemon as service
log "Installing Rust daemon as system service..."
run "$RUST_DAEMON_BIN" --install-service

# 3. Verify health
sleep 2
if ! $DRY_RUN; then
  HEALTH=$(curl -s http://localhost:3850/health 2>/dev/null || echo '{"status":"error"}')
  if echo "$HEALTH" | grep -q '"status"[[:space:]]*:[[:space:]]*"healthy"'; then
    log "Health check: PASS"
  else
    echo "ERROR: Health check failed after cutover: $HEALTH"
    echo "Rolling back..."
    "$0" --rollback
    exit 1
  fi
fi

# 4. Print summary
log ""
log "=== Cutover Complete ==="
log ""
log "Rust daemon is now the primary."
log "  Binary:  $RUST_DAEMON_BIN"
log "  MCP:     $RUST_MCP_BIN"
log "  Health:  curl -s http://localhost:3850/health"
log "  Version: curl -s http://localhost:3850/api/version"
log ""
log "To rollback: $0 --rollback"
log ""
log "Post-cutover checklist:"
log "  [ ] Dashboard loads at http://localhost:3850"
log "  [ ] MCP tools respond (claude-code connector test)"
log "  [ ] Pipeline processes jobs correctly"
log "  [ ] Monitor ~/.agents/.daemon/logs/ for errors"
log "  [ ] Archive TS daemon source (keep, don't delete)"
