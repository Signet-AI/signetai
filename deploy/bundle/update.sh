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

RED='\033[0;31m'
info()  { printf "${CYAN}  →${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  !${NC} %s\n" "$1"; }
err()   { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

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
LOCKFILE="$SIGNET_INSTALL_DIR/.lock"
trap 'rm -rf "$TMPDIR"; rm -rf "$LOCKFILE"' EXIT

mkdir -p "$SIGNET_INSTALL_DIR"
if ! mkdir "$LOCKFILE" 2>/dev/null; then
  LOCK_AGE="$(($(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0)))"
  if [ "$LOCK_AGE" -lt 300 ]; then
    err "Another update or install is already running (lock is ${LOCK_AGE}s old)"
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

SHA256_CMD=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
fi

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
  warn "jq not found — performing full reinstall"
  rm -rf "$LOCKFILE"
  curl -fsSL "${DOWNLOAD_BASE}/install.sh" | SIGNET_INSTALL_DIR="$SIGNET_INSTALL_DIR" bash
  exit $?
fi

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
STAGED=""

# Clean stale .old dirs from any previous failed update
find "$SIGNET_INSTALL_DIR/runtime" -maxdepth 1 -name '*.old' -type d 2>/dev/null | while read -r olddir; do
  warn "Cleaning stale backup: $(basename "$olddir")"
  rm -rf "$olddir"
done
UPDATED=0
FAILED=0

for comp in $COMPONENTS; do
  LOCAL_SHA="$(jq -r ".components.\"$comp\".sha256 // \"\"" "$LOCAL_MANIFEST" 2>/dev/null || echo "")"
  REMOTE_SHA="$(jq -r ".components.\"$comp\".sha256 // \"\"" "$REMOTE_MANIFEST")"
  REMOTE_URL="$(jq -r ".components.\"$comp\".url // \"\"" "$REMOTE_MANIFEST")"

  if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    continue
  fi

  if [ -z "$REMOTE_URL" ]; then
    err "Component $comp has no download URL — cannot update"
    FAILED=$((FAILED + 1))
    continue
  fi

  FILENAME="$(basename "$REMOTE_URL")"
  info "Updating $comp..."

  curl -fsSL "$REMOTE_URL" -o "$TMPDIR/$FILENAME" || {
    warn "Failed to download $comp"
    FAILED=$((FAILED + 1))
    continue
  }

  if [ -n "$REMOTE_SHA" ]; then
    if [ -z "$SHA256_CMD" ]; then
      err "No checksum tool available — cannot verify $comp. Install sha256sum or shasum and retry."
      rm -f "$TMPDIR/$FILENAME"
      FAILED=$((FAILED + 1))
      continue
    fi
    ACTUAL_SHA="$($SHA256_CMD "$TMPDIR/$FILENAME" | awk '{print $1}')"
    if [ "$ACTUAL_SHA" != "$REMOTE_SHA" ]; then
      err "Checksum mismatch for $comp (expected $REMOTE_SHA, got $ACTUAL_SHA)"
      rm -f "$TMPDIR/$FILENAME"
      FAILED=$((FAILED + 1))
      continue
    fi
  fi

  STAGE="$TMPDIR/staged/$comp"
  if ! safe_tar_extract "$TMPDIR/$FILENAME" "$STAGE"; then
    err "Failed to safely extract $comp"
    rm -rf "$STAGE"
    FAILED=$((FAILED + 1))
    continue
  fi
  STAGED="$STAGED $comp"
  UPDATED=$((UPDATED + 1))
done

if [ "$FAILED" -gt 0 ]; then
  echo ""
  err "$FAILED component(s) failed — nothing installed, re-run to retry"
  rm -rf "$TMPDIR/staged"
  exit 1
fi

if [ -n "$STAGED" ]; then
  mkdir -p "$SIGNET_INSTALL_DIR/runtime"
  PROMOTED=""
  # Stage 1: Move old components aside (keep backups for rollback)
  for comp in $STAGED; do
    DEST="$SIGNET_INSTALL_DIR/runtime/$comp"
    OLD="${DEST}.old"
    if [ -d "$DEST" ]; then mv "$DEST" "$OLD"; fi
  done
  # Stage 2: Promote staged components
  for comp in $STAGED; do
    DEST="$SIGNET_INSTALL_DIR/runtime/$comp"
    if mv "$TMPDIR/staged/$comp" "$DEST" 2>/dev/null; then
      OLD="${DEST}.old"
      rm -rf "$OLD"
      touch "$DEST/.complete"
      ok "$comp updated"
      PROMOTED="$PROMOTED $comp"
    else
      err "Failed to install $comp"
      rm -rf "$DEST"
      # Roll back all components that already succeeded
      for prev in $PROMOTED; do
        PDEST="$SIGNET_INSTALL_DIR/runtime/$prev"
        rm -rf "$PDEST"
      done
      # Restore all .old backups (promoted + failed)
      for comp2 in $STAGED; do
        OLD2="$SIGNET_INSTALL_DIR/runtime/$comp2.old"
        DEST2="$SIGNET_INSTALL_DIR/runtime/$comp2"
        if [ -d "$OLD2" ]; then mv "$OLD2" "$DEST2"; fi
      done
      rm -rf "$TMPDIR/staged"
      err "Update failed — all components rolled back"
      exit 1
    fi
  done
fi

rm -rf "$TMPDIR/staged"

cp "$REMOTE_MANIFEST" "$LOCAL_MANIFEST"
echo "$REMOTE_VERSION" > "$SIGNET_INSTALL_DIR/VERSION"

echo ""
if [ "$UPDATED" -gt 0 ]; then
  ok "$UPDATED component(s) updated to v$REMOTE_VERSION"
  info "Restart the daemon to apply changes: signet daemon restart"
else
  ok "No updates needed"
fi
