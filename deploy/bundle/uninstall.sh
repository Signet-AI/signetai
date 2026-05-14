#!/usr/bin/env bash
# Signet Native Bundle Uninstaller
#
# Usage: bash uninstall.sh
#
# Removes the Signet runtime, wrapper scripts, and PATH config.
# Preserves user data at ~/.agents/ (unless --purge is passed).

set -euo pipefail

SIGNET_INSTALL_DIR="${SIGNET_INSTALL_DIR:-$HOME/.signet}"
PURGE="${1:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}  →${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  !${NC} %s\n" "$1"; }

# Stop daemon if running
if [ -f "$SIGNET_INSTALL_DIR/bin/signet" ]; then
  export PATH="$SIGNET_INSTALL_DIR/bin:$PATH"
  if signet daemon stop 2>/dev/null; then
    ok "Daemon stopped"
  fi
fi

# Remove PATH from shell config
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -q 'signet/bin' "$rc"; then
    info "Removing PATH from $(basename "$rc")..."
    sed -i.bak '/# Signet/d; /signet\/bin/d' "$rc"
    rm -f "${rc}.bak"
    ok "Cleaned $(basename "$rc")"
  fi
done

# Remove installation
if [ -d "$SIGNET_INSTALL_DIR" ]; then
  if [ ! -f "$SIGNET_INSTALL_DIR/manifest.json" ] && [ ! -d "$SIGNET_INSTALL_DIR/bin" ]; then
    echo "Error: $SIGNET_INSTALL_DIR does not appear to be a Signet installation (no manifest.json or bin/)"
    echo "Refusing to remove. Set SIGNET_INSTALL_DIR to the correct path."
    exit 1
  fi
  if [ "$SIGNET_INSTALL_DIR" = "/" ] || [ "$SIGNET_INSTALL_DIR" = "$HOME" ] || [ -z "$SIGNET_INSTALL_DIR" ]; then
    echo "Error: install dir is a dangerous path ($SIGNET_INSTALL_DIR). Refusing to remove."
    exit 1
  fi
  info "Removing $SIGNET_INSTALL_DIR..."
  rm -rf "$SIGNET_INSTALL_DIR"
  ok "Installation removed"
fi

# Optionally purge user data
if [ "$PURGE" = "--purge" ]; then
  AGENTS_DIR="${SIGNET_PATH:-$HOME/.agents}"
  if [ "$AGENTS_DIR" = "/" ] || [ "$AGENTS_DIR" = "$HOME" ] || [ -z "$AGENTS_DIR" ]; then
    echo "Error: agents dir is a dangerous path ($AGENTS_DIR). Refusing to purge."
    exit 1
  fi
  if [ -d "$AGENTS_DIR" ]; then
    warn "Purging user data at $AGENTS_DIR..."
    rm -rf "$AGENTS_DIR"
    ok "User data purged"
  fi
else
  echo ""
  printf "${YELLOW}  User data preserved at ${SIGNET_PATH:-$HOME/.agents}${NC}"
  echo "  Run with --purge to remove it too."
fi

echo ""
printf "${GREEN}  ✓ Signet uninstalled${NC}\n"
echo "  Restart your terminal to clean up PATH."
echo ""
