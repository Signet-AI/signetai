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
LOCKFILE="$SIGNET_INSTALL_DIR/.lock"
cleanup() {
  if [ -n "$tmpdir" ] && [ -d "$tmpdir" ]; then
    rm -rf "$tmpdir"
  fi
  rm -rf "$LOCKFILE"
}
trap cleanup EXIT

mkdir -p "$SIGNET_INSTALL_DIR"
if ! mkdir "$LOCKFILE" 2>/dev/null; then
  LOCK_AGE="$(($(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0)))"
  if [ "$LOCK_AGE" -lt 300 ]; then
    err "Another install or update is already running (lock is ${LOCK_AGE}s old)"
    exit 1
  fi
  warn "Stale lock found (${LOCK_AGE}s old) — removing"
  rm -rf "$LOCKFILE"
  if ! mkdir "$LOCKFILE" 2>/dev/null; then
    err "Failed to acquire lock after clearing stale lock"
    exit 1
  fi
fi
echo "$$" > "$LOCKFILE/pid"

tmpdir="$(mktemp -d)"

sha_verify() {
  local file="$1" expected="$2"
  if [ -z "$SHA256_CMD" ]; then return 0; fi
  if [ -z "$expected" ]; then return 0; fi
  local actual
  actual="$($SHA256_CMD "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ]
}

safe_tar_extract() {
  local archive="$1" dest="$2"
  local unsafe
  unsafe="$(tar tf "$archive" 2>/dev/null | while read -r entry; do
    case "$entry" in
      ../*|*/../*|*/..|..) echo "$entry" ;;
      /*) echo "$entry" ;;
    esac
  done)"
  if [ -n "$unsafe" ]; then
    err "Archive contains unsafe paths:"
    echo "$unsafe"
    return 1
  fi
  mkdir -p "$dest"
  tar xzf "$archive" -C "$dest"
}

download_url() {
  local name="$1" url="$2" filename="$3" sha="$4" dest="$5"
  local tmp="${tmpdir}/${filename}"

  if [ -f "$dest/.complete" ] && [ -f "$SIGNET_INSTALL_DIR/manifest.json" ]; then
    local old_sha=""
    if command -v jq >/dev/null 2>&1; then
      old_sha="$(jq -r ".components.\"${name}\".sha256 // \"\"" "$SIGNET_INSTALL_DIR/manifest.json" 2>/dev/null || true)"
    else
      old_sha="$(json_value ".components.\"${name}\".sha256" "$SIGNET_INSTALL_DIR/manifest.json")"
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

# POSIX-safe JSON value extraction (no jq/node/python required)
# Handles: .version, .components."name".sha256, .components."name".url
json_value() {
  local key="$1" file="${2:-${tmpdir}/manifest.json}"
  if [ "$key" = ".version" ]; then
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1
    return
  fi
  # Parse .components."NAME".FIELD
  local name field
  name="$(printf '%s' "$key" | sed -n 's/.*\."([^"]*)"\..*/\1/p' 2>/dev/null || echo "")"
  if [ -z "$name" ]; then
    name="$(printf '%s' "$key" | sed "s/\\.components\\.//;s/\\..*//" | tr -d '"')"
  fi
  field="$(printf '%s' "$key" | sed 's/.*\.\([a-zA-Z0-9_]*\)$/\1/')"
  # Find the line with the component key, then scan forward for the field
  sed -n "/\"${name}\"/,/}/p" "$file" | sed -n "s/^[[:space:]]*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

get_manifest_value() {
  local key="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "$key" "${tmpdir}/manifest.json" 2>/dev/null
  elif [ -x "$SIGNET_INSTALL_DIR/runtime/node/bin/node" ]; then
    "$SIGNET_INSTALL_DIR/runtime/node/bin/node" -e "
      const fs=require('fs');
      const d=JSON.parse(fs.readFileSync('${tmpdir}/manifest.json','utf8'));
      const parts='${key}'.split('.').filter(Boolean);
      let v=d; for(const p of parts) v=v?.[p];
      if(v!==undefined) process.stdout.write(String(v));
    " 2>/dev/null || true
  else
    json_value "$key" "${tmpdir}/manifest.json"
  fi
}

# ── Component list (Node.js runtime) ──

COMPONENTS=(
  node cli daemon-js daemon-rs predictor dashboard
  connectors plugin-opencode plugin-oh-my-pi plugin-pi
  native onnxruntime sqlite-vec skills templates
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

  REQUIRED_COMPONENTS="node cli daemon-js native onnxruntime sqlite-vec"

  for name in "${COMPONENTS[@]}"; do
    sha=""
    comp_url=""
    sha="$(get_manifest_value ".components.\"${name}\".sha256")"
    comp_url="$(get_manifest_value ".components.\"${name}\".url")"

    # Skip components not in the manifest
    if [ -z "$comp_url" ]; then
      case " $REQUIRED_COMPONENTS " in
        *" $name "*)
          err "Required component '$name' not in manifest — aborting"
          exit 1
          ;;
        *)
          continue
          ;;
      esac
    fi

    filename="$(basename "$comp_url")"

    if [ -z "$sha" ]; then
      case " $REQUIRED_COMPONENTS " in
        *" $name "*)
          err "Required component '$name' has no checksum in manifest — aborting"
          exit 1
          ;;
        *)
          warn "'$name' has no checksum — skipping"
          continue
          ;;
      esac
    fi

    dest="$SIGNET_INSTALL_DIR/runtime/${name}"
  download_url "$name" "$comp_url" "$filename" "$sha" "$dest" || {
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
  MOVED=""
  for dir in "$STAGING"/*/; do
    [ -d "$dir" ] || continue
    comp_name="$(basename "$dir")"
    DEST="$SIGNET_INSTALL_DIR/runtime/$comp_name"
    OLD="${DEST}.old"
    if [ -d "$DEST" ]; then mv "$DEST" "$OLD"; fi
    if mv "$dir" "$DEST" 2>/dev/null; then
      rm -rf "$OLD"
      touch "$DEST/.complete"
      MOVED="$MOVED $comp_name"
    else
      err "Failed to promote $comp_name — rolling back"
      rm -rf "$DEST"
      if [ -d "$OLD" ]; then mv "$OLD" "$DEST"; fi
      for prev in $MOVED; do
        PDEST="$SIGNET_INSTALL_DIR/runtime/$prev"
        POLD="${PDEST}.old"
        if [ -d "$PDEST" ]; then mv "$PDEST" "$POLD"; fi
        if [ -d "$POLD" ]; then mv "$POLD" "$PDEST"; fi
      done
      rm -rf "$STAGING"
      exit 1
    fi
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

  SETUP_RC=0
  if [ "${SIGNET_NO_SETUP:-}" != "1" ]; then
    info "Running initial setup..."
    signet setup --non-interactive --embedding-provider none --extraction-provider none 2>/dev/null || SETUP_RC=$?
    if [ "$SETUP_RC" -ne 0 ]; then
      warn "Setup had issues — run 'signet setup' manually later"
    else
      ok "Setup complete"
    fi
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
