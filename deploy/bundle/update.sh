#!/usr/bin/env bash
# Signet Native Bundle Updater
#
# Usage: signet update
#        bash update.sh
#
# Compares local manifest against latest GitHub Release manifest
# and downloads only changed components.

set -euo pipefail

SIGNET_INSTALL_DIR="${SIGNET_INSTALL_DIR:-$HOME/.signet}"
SIGNET_REPO="Signet-AI/signetai"
SIGNET_RELEASE_TAG="bundle-latest"
DOWNLOAD_BASE="https://github.com/${SIGNET_REPO}/releases/download/${SIGNET_RELEASE_TAG}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { printf "${CYAN}  →${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  !${NC} %s\n" "$1"; }

# Detect platform
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os:$arch" in
    darwin:arm64)  echo "darwin-arm64" ;;
    darwin:x86_64) echo "darwin-x64" ;;
    linux:aarch64) echo "linux-arm64" ;;
    linux:x86_64|linux:amd64) echo "linux-x64" ;;
    *) echo "unknown" ;;
  esac
}

PLATFORM="$(detect_platform)"
LOCAL_MANIFEST="$SIGNET_INSTALL_DIR/manifest.json"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

if [ ! -f "$LOCAL_MANIFEST" ]; then
  echo "No Signet installation found at $SIGNET_INSTALL_DIR"
  echo "Run the installer first: curl -fsSL https://signetai.sh/install.sh | bash"
  exit 1
fi

info "Checking for updates..."

# Download latest manifest
REMOTE_MANIFEST="$TMPDIR/manifest-latest.json"
curl -fsSL "${DOWNLOAD_BASE}/manifest-${PLATFORM}.json" -o "$REMOTE_MANIFEST" || {
  echo "Failed to fetch remote manifest"
  exit 1
}

if ! command -v jq >/dev/null 2>&1; then
  warn "jq not found — performing full update"
  bash "$SIGNET_INSTALL_DIR/../../../deploy/bundle/install.sh"
  exit 0
fi

# Compare versions
LOCAL_VERSION="$(jq -r '.version' "$LOCAL_MANIFEST")"
REMOTE_VERSION="$(jq -r '.version' "$REMOTE_MANIFEST")"

if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
  # Check individual component checksums
  CHANGED=0
  COMPONENTS="$(jq -r '.components | keys[]' "$REMOTE_MANIFEST")"
  for comp in $COMPONENTS; do
    LOCAL_SHA="$(jq -r ".components.\"$comp\".sha256 // \"\"" "$LOCAL_MANIFEST")"
    REMOTE_SHA="$(jq -r ".components.\"$comp\".sha256 // \"\"" "$REMOTE_MANIFEST")"
    if [ "$LOCAL_SHA" != "$REMOTE_SHA" ] && [ -n "$REMOTE_SHA" ]; then
      CHANGED=$((CHANGED + 1))
    fi
  done

  if [ "$CHANGED" -eq 0 ]; then
    ok "Already up to date (v$LOCAL_VERSION)"
    exit 0
  fi

  info "$CHANGED component(s) updated"
else
  info "New version available: v$REMOTE_VERSION (current: v$LOCAL_VERSION)"
fi

# Download changed components
COMPONENTS="$(jq -r '.components | keys[]' "$REMOTE_MANIFEST")"
UPDATED=0

for comp in $COMPONENTS; do
  LOCAL_SHA="$(jq -r ".components.\"$comp\".sha256 // \"\"" "$LOCAL_MANIFEST" 2>/dev/null || echo "")"
  REMOTE_SHA="$(jq -r ".components.\"$comp\".sha256 // \"\"" "$REMOTE_MANIFEST")"
  REMOTE_URL="$(jq -r ".components.\"$comp\".url // \"\"" "$REMOTE_MANIFEST")"

  if [ "$LOCAL_SHA" = "$REMOTE_SHA" ] || [ -z "$REMOTE_URL" ]; then
    continue
  fi

  FILENAME="$(basename "$REMOTE_URL")"
  info "Updating $comp..."

  curl -fsSL "$REMOTE_URL" -o "$TMPDIR/$FILENAME" || {
    warn "Failed to download $comp"
    continue
  }

  DEST="$SIGNET_INSTALL_DIR/runtime/$comp"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  tar xzf "$TMPDIR/$FILENAME" -C "$DEST"
  UPDATED=$((UPDATED + 1))
  ok "$comp updated"
done

# Save new manifest
cp "$REMOTE_MANIFEST" "$LOCAL_MANIFEST"
echo "$REMOTE_VERSION" > "$SIGNET_INSTALL_DIR/VERSION"

echo ""
if [ "$UPDATED" -gt 0 ]; then
  ok "$UPDATED component(s) updated to v$REMOTE_VERSION"
  info "Restart the daemon to apply changes: signet daemon restart"
else
  ok "No updates needed"
fi
