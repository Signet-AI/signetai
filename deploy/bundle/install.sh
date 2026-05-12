#!/usr/bin/env bash
# Signet Native Bundle Installer
#
# Usage:
#   curl -fsSL https://signetai.sh/install.sh | bash
#   curl -fsSL https://github.com/Signet-AI/signetai/releases/download/bundle-latest/install.sh | bash
#
# Environment options:
#   SIGNET_INSTALL_DIR  — install location (default: ~/.signet)
#   SIGNET_VERSION      — version tag or "latest" (default: latest)
#   SIGNET_NO_START     — set to "1" to skip daemon start
#   SIGNET_NO_SETUP     — set to "1" to skip setup wizard
#   SIGNET_NO_PATH      — set to "1" to skip PATH modification

set -euo pipefail

SIGNET_INSTALL_DIR="${SIGNET_INSTALL_DIR:-$HOME/.signet}"
SIGNET_AGENTS_DIR="${SIGNET_PATH:-$HOME/.agents}"
SIGNET_VERSION="${SIGNET_VERSION:-latest}"
SIGNET_REPO="Signet-AI/signetai"
SIGNET_RELEASE_TAG="bundle-${SIGNET_VERSION}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { printf "${CYAN}  →${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  !${NC} %s\n" "$1"; }
err()   { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

banner() {
  echo ""
  printf "${BOLD}  ╔══════════════════════════════════════╗${NC}\n"
  printf "${BOLD}  ║         Signet Installer            ║${NC}\n"
  printf "${BOLD}  ║    Portable AI Agent Identity        ║${NC}\n"
  printf "${BOLD}  ╚══════════════════════════════════════╝${NC}\n"
  echo ""
}

# ── Platform detection ──

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os:$arch" in
    darwin:arm64)  echo "darwin-arm64" ;;
    darwin:x86_64) echo "darwin-x64" ;;
    linux:aarch64) echo "linux-arm64" ;;
    linux:x86_64)  echo "linux-x64" ;;
    linux:amd64)   echo "linux-x64" ;;
    *)
      err "Unsupported platform: $os $arch"
      err "Signet requires macOS (ARM64/x64) or Linux (ARM64/x64)"
      exit 1
      ;;
  esac
}

PLATFORM="$(detect_platform)"

# ── Dependencies ──

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command '$1' not found. Please install it and re-run."
    exit 1
  fi
}

require_cmd curl
require_cmd tar

# sha256sum or shasum
SHA256_CMD=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
else
  warn "No sha256 tool found — checksums will not be verified"
fi

# ── Download helpers ──

DOWNLOAD_BASE="https://github.com/${SIGNET_REPO}/releases/download/${SIGNET_RELEASE_TAG}"

tmpdir=""
cleanup() {
  if [ -n "$tmpdir" ] && [ -d "$tmpdir" ]; then
    rm -rf "$tmpdir"
  fi
}
trap cleanup EXIT
tmpdir="$(mktemp -d)"

sha_verify() {
  local file="$1" expected="$2"
  if [ -z "$SHA256_CMD" ]; then return 0; fi
  if [ -z "$expected" ]; then return 0; fi
  echo "$expected  $file" | $SHA256_CMD -c --quiet 2>/dev/null
}

safe_tar_extract() {
  local archive="$1" dest="$2"
  if tar tf "$archive" 2>/dev/null | grep -qE '^(\.\./|/)'; then
    err "Archive contains unsafe paths (absolute or parent traversal)"
    return 1
  fi
  mkdir -p "$dest"
  tar xzf "$archive" -C "$dest" --strip-components=0
}

download() {
  local name="$1" filename="$2" sha="$3" dest="$4"
  local url="${DOWNLOAD_BASE}/${filename}"
  local tmp="${tmpdir}/${filename}"

  if [ -f "$dest/.complete" ] && [ -f "$SIGNET_INSTALL_DIR/manifest.json" ]; then
    local old_sha=""
    if command -v jq >/dev/null 2>&1; then
      old_sha="$(jq -r ".components.\"${name}\".sha256 // \"\"" "$SIGNET_INSTALL_DIR/manifest.json" 2>/dev/null || true)"
    fi
    if [ -n "$old_sha" ] && [ "$old_sha" = "$sha" ]; then
      ok "$name (up to date)"
      return 0
    fi
  fi

  rm -f "$dest/.complete"
  info "Downloading $name..."
  curl -fsSL "$url" -o "$tmp" || {
    err "Failed to download $name"
    return 1
  }

  if [ -n "$sha" ]; then
    if [ -z "$SHA256_CMD" ]; then
      err "No checksum tool available — cannot verify $name"
      rm -f "$tmp"
      return 1
    fi
    if ! sha_verify "$tmp" "$sha"; then
      err "Checksum mismatch for $name"
      rm -f "$tmp"
      return 1
    fi
  fi

  local tmp_extract="${tmpdir}/extract-${name}"
  mkdir -p "$tmp_extract"
  if ! safe_tar_extract "$tmp" "$tmp_extract"; then
    err "Failed to safely extract $name"
    rm -rf "$tmp_extract" "$tmp"
    return 1
  fi
  local stage_dir="$SIGNET_INSTALL_DIR/runtime/staging/$name"
  mkdir -p "$stage_dir"
  rm -rf "$stage_dir"
  mv "$tmp_extract" "$stage_dir"
  rm -f "$tmp"
  ok "$name"
  return 0
}

# ── Fetch manifest ──

fetch_manifest() {
  local url="${DOWNLOAD_BASE}/manifest-${PLATFORM}.json"
  info "Fetching manifest for $PLATFORM..."
  curl -fsSL "$url" -o "${tmpdir}/manifest.json" || {
    err "Failed to fetch manifest. Bundle may not be available for $PLATFORM yet."
    err "URL: $url"
    exit 1
  }
  ok "Manifest fetched"
}

get_manifest_value() {
  local key="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "$key" "${tmpdir}/manifest.json" 2>/dev/null
  else
    python3 -c "import json,sys; d=json.load(open('${tmpdir}/manifest.json')); print($key)" 2>/dev/null || true
  fi
}

# ── Component list (Node.js runtime) ──

COMPONENTS=(
  "node:signet-node-${PLATFORM}"
  "cli:signet-cli"
  "daemon-js:signet-daemon-js"
  "daemon-rs:signet-daemon-rs-${PLATFORM}"
  "predictor:signet-predictor-${PLATFORM}"
  "dashboard:signet-dashboard"
  "connectors:signet-connectors"
  "plugin-opencode:signet-plugin-opencode"
  "plugin-oh-my-pi:signet-plugin-oh-my-pi"
  "plugin-pi:signet-plugin-pi"
  "native:signet-native-${PLATFORM}"
  "onnxruntime:signet-onnxruntime-${PLATFORM}"
  "sqlite-vec:signet-sqlite-vec-${PLATFORM}"
  "skills:signet-skills"
  "templates:signet-templates"
)

# ── Generate wrapper scripts (Bun-only) ──

generate_wrappers() {
  local bindir="$SIGNET_INSTALL_DIR/bin"
  mkdir -p "$bindir"

  cat > "${bindir}/signet" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_DIR
exec "$SIGNET_DIR/runtime/node/bin/node" "$SIGNET_DIR/runtime/cli/cli.js" "$@"
WRAPPER
  chmod +x "${bindir}/signet"

  cat > "${bindir}/signet-daemon" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_DIR
exec "$SIGNET_DIR/runtime/node/bin/node" "$SIGNET_DIR/runtime/daemon-js/daemon.js" "$@"
WRAPPER
  chmod +x "${bindir}/signet-daemon"

  cat > "${bindir}/signet-mcp" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_DIR
exec "$SIGNET_DIR/runtime/node/bin/node" "$SIGNET_DIR/runtime/cli/cli.js" mcp "$@"
WRAPPER
  chmod +x "${bindir}/signet-mcp"

  if [ -f "$SIGNET_INSTALL_DIR/runtime/predictor/signet-predictor" ]; then
    ln -sf "$SIGNET_INSTALL_DIR/runtime/predictor/signet-predictor" "${bindir}/signet-predictor"
  fi

  curl -fsSL "${DOWNLOAD_BASE}/uninstall.sh" -o "${bindir}/signet-uninstall" 2>/dev/null && chmod +x "${bindir}/signet-uninstall" || warn "Could not download uninstaller"
  curl -fsSL "${DOWNLOAD_BASE}/update.sh" -o "${bindir}/signet-update" 2>/dev/null && chmod +x "${bindir}/signet-update" || warn "Could not download updater"

  ok "Wrapper scripts created"
}

# ── PATH setup ──

setup_path() {
  if [ "${SIGNET_NO_PATH:-}" = "1" ]; then
    return 0
  fi

  local bindir="$SIGNET_INSTALL_DIR/bin"
  local shell_rc=""

  if [ -n "${ZSH_VERSION:-}" ] || [ "${SHELL:-}" = */zsh ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -n "${BASH_VERSION:-}" ] || [ "${SHELL:-}" = */bash ]; then
    shell_rc="$HOME/.bashrc"
  elif [ -f "$HOME/.zshrc" ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    shell_rc="$HOME/.bashrc"
  fi

  if [ -z "$shell_rc" ]; then
    warn "Could not detect shell config file. Add to PATH manually:"
    echo "  export PATH=\"$bindir:\$PATH\""
    return 0
  fi

  if grep -q 'signet/bin' "$shell_rc" 2>/dev/null; then
    ok "PATH already configured in $(basename "$shell_rc")"
    return 0
  fi

  printf '\n# Signet\nexport PATH="%s:$PATH"\n' "$bindir" >> "$shell_rc"
  ok "Added to PATH in $(basename "$shell_rc")"
}

# ── Main ──

main() {
  banner
  info "Platform: $PLATFORM"
  info "Install dir: $SIGNET_INSTALL_DIR"
  info "Agent data: $SIGNET_AGENTS_DIR"
  echo ""

  if [ -f "$SIGNET_INSTALL_DIR/manifest.json" ]; then
    warn "Existing installation found at $SIGNET_INSTALL_DIR"
    info "Updating..."
    echo ""
  fi

  fetch_manifest
  echo ""

  mkdir -p "$SIGNET_INSTALL_DIR/runtime"

  printf "${BOLD}  Downloading components...${NC}\n"
  echo ""

  REQUIRED_COMPONENTS="node cli daemon-js"

  for entry in "${COMPONENTS[@]}"; do
    name="${entry%%:*}"
    artifact="${entry#*:}"
    filename="${artifact}.tar.gz"

    sha=""
    if command -v jq >/dev/null 2>&1; then
      sha="$(jq -r ".components.\"${name}\".sha256 // \"\"" "${tmpdir}/manifest.json" 2>/dev/null || true)"
    fi

    if [ -z "$sha" ]; then
      sha_url="${DOWNLOAD_BASE}/${filename}.sha256"
      sha="$(curl -fsSL "$sha_url" 2>/dev/null | awk '{print $1}' || true)"
    fi

    dest="$SIGNET_INSTALL_DIR/runtime/${name}"
  download "$name" "$filename" "$sha" "$dest" || {
    case " $REQUIRED_COMPONENTS " in
      *" $name "*)
        err "Required component '$name' failed — aborting"
        rm -rf "$SIGNET_INSTALL_DIR/runtime/staging"
        exit 1
        ;;
      *)
        warn "'$name' not available for $PLATFORM"
        ;;
    esac
  }
done

STAGING="$SIGNET_INSTALL_DIR/runtime/staging"
if [ -d "$STAGING" ]; then
  for dir in "$STAGING"/*/; do
    [ -d "$dir" ] || continue
    comp_name="$(basename "$dir")"
    rm -rf "$SIGNET_INSTALL_DIR/runtime/$comp_name"
    mv "$dir" "$SIGNET_INSTALL_DIR/runtime/$comp_name"
    touch "$SIGNET_INSTALL_DIR/runtime/$comp_name/.complete"
  done
  rm -rf "$STAGING"
fi

  cp "${tmpdir}/manifest.json" "$SIGNET_INSTALL_DIR/manifest.json"
  echo ""

  generate_wrappers
  setup_path

  VERSION_VAL="$(get_manifest_value '.version' 2>/dev/null || echo "unknown")"
  echo "$VERSION_VAL" > "$SIGNET_INSTALL_DIR/VERSION"

  echo ""
  printf "${BOLD}  ──────────────────────────────────────${NC}\n"
  echo ""

  export PATH="$SIGNET_INSTALL_DIR/bin:$PATH"

  if [ "${SIGNET_NO_SETUP:-}" != "1" ]; then
    info "Running initial setup..."
    signet setup --non-interactive --embedding-provider none --extraction-provider none 2>/dev/null || {
      warn "Setup had issues — run 'signet setup' manually later"
    }
    ok "Setup complete"
  fi

  if [ "${SIGNET_NO_START:-}" != "1" ]; then
    info "Starting daemon..."
    if signet daemon start 2>/dev/null; then
      ok "Daemon started"
    else
      warn "Daemon start failed — run 'signet daemon start' manually"
    fi
  fi

  echo ""
  printf "${GREEN}${BOLD}  ✓ Signet v${VERSION_VAL} installed!${NC}\n"
  echo ""
  echo "  signet              — Main CLI"
  echo "  signet status       — Check status"
  echo "  signet remember     — Save a memory"
  echo "  signet recall       — Search memories"
  echo "  signet dashboard    — Open web UI"
  echo ""
  echo "  Dashboard: http://localhost:3850"
  echo "  Config:    $SIGNET_AGENTS_DIR"
  echo ""
  printf "${DIM}  Run 'source ~/.zshrc' or restart your terminal.${NC}\n"
  echo ""
}

main "$@"
