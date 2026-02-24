#!/usr/bin/env bash
set -euo pipefail

# ◈ Signet — curl installer
# Usage: curl -sL https://signetai.sh/install | bash

RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"

info()  { printf "  %b\n" "$1"; }
warn()  { printf "  ${YELLOW}⚠ %b${RESET}\n" "$1"; }
error() { printf "  ${RED}✗ %b${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓ %b${RESET}\n" "$1"; }

# --- Banner ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
info "${CYAN}${BOLD}◈ Signet${RESET} installer"
info "${DIM}Portable AI agent identity${RESET}"
echo ""

# --- OS detection ---
OS="$(uname -s)"
case "$OS" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *)
    error "Unsupported OS: $OS"
    info "Signet supports macOS and Linux. Windows users: install via WSL."
    exit 1
    ;;
esac
ok "OS: $OS_NAME"

# --- Arch detection ---
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *)
    warn "Unknown architecture: $ARCH (proceeding anyway)"
    ARCH_NAME="$ARCH"
    ;;
esac
ok "Arch: $ARCH_NAME"

# --- Check for bun ---
HAS_BUN=false
if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo "unknown")"
  ok "Bun: v$BUN_VERSION"
  HAS_BUN=true
fi

# --- Check for node 18+ ---
HAS_NODE=false
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null || echo "v0")"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node.js: $NODE_VERSION"
    HAS_NODE=true
  else
    warn "Node.js $NODE_VERSION found (need >= 18)"
  fi
fi

# --- Install bun if missing ---
if [ "$HAS_BUN" = false ]; then
  if [ "$HAS_NODE" = false ]; then
    info ""
    info "No JavaScript runtime found. Installing Bun..."
    info "${DIM}(Bun is required for the Signet daemon)${RESET}"
    info ""
  else
    info ""
    info "Installing Bun (required for the Signet daemon)..."
    info ""
  fi

  if ! curl -fsSL https://bun.sh/install | bash; then
    error "Bun installation failed"
    info "Install manually: https://bun.sh"
    exit 1
  fi

  # Source bun env so it's available in this session
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  if [ -f "$BUN_INSTALL/bin/bun" ]; then
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi

  if command -v bun >/dev/null 2>&1; then
    BUN_VERSION="$(bun --version 2>/dev/null || echo "unknown")"
    ok "Bun installed: v$BUN_VERSION"
    HAS_BUN=true
  else
    error "Bun installed but not found in PATH"
    info "Restart your shell and re-run this script."
    exit 1
  fi
fi

echo ""

# --- Install signetai ---
info "Installing signetai..."
echo ""

if [ "$HAS_BUN" = true ]; then
  if ! bun add -g signetai; then
    error "bun install failed"
    if [ "$HAS_NODE" = true ]; then
      info "Falling back to npm..."
      NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
      case "$NPM_PREFIX" in
        /usr/local*|/usr/*)
          warn "npm global prefix is $NPM_PREFIX (requires sudo)"
          info "Fixing to ~/.npm-global to avoid permission issues..."
          mkdir -p "$HOME/.npm-global"
          npm config set prefix "$HOME/.npm-global"
          export PATH="$HOME/.npm-global/bin:$PATH"
          ;;
      esac
      if ! npm install -g signetai; then
        error "npm install also failed"
        exit 1
      fi
    else
      exit 1
    fi
  fi
elif [ "$HAS_NODE" = true ]; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
  case "$NPM_PREFIX" in
    /usr/local*|/usr/*)
      warn "npm global prefix is $NPM_PREFIX (requires sudo)"
      info "Fixing to ~/.npm-global to avoid permission issues..."
      mkdir -p "$HOME/.npm-global"
      npm config set prefix "$HOME/.npm-global"
      export PATH="$HOME/.npm-global/bin:$PATH"
      # Persist PATH fix
      SHELL_RC=""
      case "$(basename "${SHELL:-bash}")" in
        zsh)  SHELL_RC="$HOME/.zshrc" ;;
        *)    SHELL_RC="$HOME/.bashrc" ;;
      esac
      if [ -n "$SHELL_RC" ] && ! grep -q '.npm-global' "$SHELL_RC" 2>/dev/null; then
        printf '\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$SHELL_RC"
        info "${DIM}Added PATH to $SHELL_RC${RESET}"
      fi
      ;;
  esac
  if ! npm install -g signetai; then
    error "npm install failed"
    exit 1
  fi
fi

echo ""

# --- Verify installation ---
if command -v signet >/dev/null 2>&1; then
  SIGNET_VERSION="$(signet --version 2>/dev/null || echo "unknown")"
  ok "signet installed: v$SIGNET_VERSION"
else
  # Check common global bin paths that might not be in PATH yet
  for BIN_DIR in "$HOME/.bun/bin" "$HOME/.npm-global/bin"; do
    if [ -f "$BIN_DIR/signet" ]; then
      warn "signet installed to $BIN_DIR but not in PATH"
      info "Restart your shell or run: export PATH=\"$BIN_DIR:\$PATH\""
      break
    fi
  done
  if ! command -v signet >/dev/null 2>&1; then
    error "signet not found after install"
    info "Try restarting your shell and running: signet --version"
    exit 1
  fi
fi

# --- Success ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
info "${GREEN}${BOLD}Ready!${RESET} Run the setup wizard to get started:"
echo ""
info "  ${CYAN}signet setup${RESET}"
echo ""
info "${DIM}Docs: https://signetai.sh${RESET}"
info "${DIM}Dashboard: http://localhost:3850 (after setup)${RESET}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
