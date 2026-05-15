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

is_expected_asset_url() {
  local name="$1" url="$2" filename="$3"
  case "$url" in
    "$DOWNLOAD_BASE"/*) ;;
    *) return 1 ;;
  esac
  case "$filename" in
    ""|"."|".."|*/*|*\?*|*#*) return 1 ;;
  esac
  case "$filename" in
    signet-"$name".tar.gz|signet-"$name"-"$PLATFORM".tar.gz) return 0 ;;
    *) return 1 ;;
  esac
}

# Download latest manifest
REMOTE_MANIFEST="$TMPDIR/manifest-latest.json"
curl -fsSL "${DOWNLOAD_BASE}/manifest-${PLATFORM}.json" -o "$REMOTE_MANIFEST" || {
  echo "Failed to fetch remote manifest"
  exit 1
}

if ! command -v jq >/dev/null 2>&1 && [ ! -x "$SIGNET_INSTALL_DIR/runtime/node/bin/node" ]; then
  warn "jq and bundled node not found — performing full reinstall"
  rm -rf "$LOCKFILE"
  curl -fsSL "${DOWNLOAD_BASE}/install.sh" | SIGNET_INSTALL_DIR="$SIGNET_INSTALL_DIR" bash
  exit $?
fi

safe_tar_extract() {
  local archive="$1" dest="$2"
  local unsafe
  unsafe="$(tar tvf "$archive" 2>/dev/null | while read -r line; do
    local entry
    entry="$(printf '%s' "$line" | sed 's/^.* //')"
    case "$line" in
      l*|h*)
        local link_target
        link_target="$(printf '%s' "$line" | sed 's/.*-> //' 2>/dev/null || true)"
        case "$link_target" in
          /*) echo "abs-symlink:$entry -> $link_target" ;;
        esac
        ;;
      *)
        case "$entry" in
          ../*|*/../*|*/..|..) echo "$entry" ;;
          /*) echo "$entry" ;;
        esac
        ;;
    esac
  done)"
  if [ -n "$unsafe" ]; then
    err "Archive contains unsafe paths or symlinks:"
    echo "$unsafe"
    return 1
  fi
  mkdir -p "$dest"
  tar xzf "$archive" -C "$dest"
  local escaped
  escaped="$(find "$dest" -type l 2>/dev/null | while read -r link; do
    local target
    target="$(readlink "$link")"
    case "$target" in
      /*) echo "$link -> $target" ;;
      *)
        local resolved
        resolved="$(cd "$(dirname "$link")" && cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")"
        case "$resolved" in
          "$dest"/*) ;;
          *) echo "$link -> $resolved" ;;
        esac
        ;;
    esac
  done)"
  if [ -n "$escaped" ]; then
    err "Extracted archive contains symlinks escaping dest dir:"
    echo "$escaped"
    rm -rf "$dest"
    return 1
  fi
}

json_value() {
  local key="$1" file="${2:-${TMPDIR}/manifest-latest.json}"
  if [ "$key" = ".version" ]; then
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1
    return
  fi
  local name field
  name="$(printf '%s' "$key" | sed 's/.*\."//;s/".*//')"
  field="$(printf '%s' "$key" | sed 's/.*\.\([a-zA-Z0-9_]*\)$/\1/')"
  # Parse only first-level fields in the component object, ignoring nested metadata.
  awk -v name="$name" -v field="$field" '
    $0 ~ "\"" name "\"[[:space:]]*:" { in_component = 1; depth = 0 }
    in_component {
      line = $0
      if (depth == 1) {
        prefix = "^[[:space:]]*\"" field "\"[[:space:]]*:[[:space:]]*\""
        if (line ~ prefix) {
          sub(prefix, "", line)
          sub("\".*", "", line)
          print line
          exit
        }
      }
      opens = gsub(/\{/, "{", line)
      closes = gsub(/\}/, "}", line)
      depth += opens - closes
      if (depth <= 0 && closes > 0) exit
    }
  ' "$file"
}

get_manifest_value() {
  local key="$1" file="${2:-$REMOTE_MANIFEST}"
  local val=""
  if command -v jq >/dev/null 2>&1; then
    val="$(jq -r "$key" "$file" 2>/dev/null)"
    if [ "$val" = "null" ] || [ -z "$val" ]; then
      val=""
    fi
    printf '%s' "$val"
  elif [ -x "$SIGNET_INSTALL_DIR/runtime/node/bin/node" ]; then
    "$SIGNET_INSTALL_DIR/runtime/node/bin/node" -e '
      const fs = require("fs");
      const [file, key] = process.argv.slice(1);
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      const parts = key.split(".").filter(Boolean).map((p) => p.replace(/^"|"$/g, ""));
      let v = d;
      for (const p of parts) v = v?.[p];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    ' "$file" "$key" 2>/dev/null || true
  else
    json_value "$key" "$file"
  fi
}

validate_component_name() {
  local comp="$1"
  case "$comp" in
    ""|*[!a-zA-Z0-9_-]*)
      err "Manifest contains invalid component name: $comp"
      exit 1
      ;;
  esac
}

manifest_keys() {
  local file="${1:-$REMOTE_MANIFEST}"
  if command -v jq >/dev/null 2>&1; then
    local invalid
    invalid="$(jq -r '.components | keys[] | select(test("^[A-Za-z0-9_-]+$") | not)' "$file" 2>/dev/null | head -1)"
    if [ -n "$invalid" ]; then
      validate_component_name "$invalid"
    fi
    jq -r '.components | keys[]' "$file" 2>/dev/null
  elif [ -x "$SIGNET_INSTALL_DIR/runtime/node/bin/node" ]; then
    "$SIGNET_INSTALL_DIR/runtime/node/bin/node" -e '
      const fs = require("fs");
      const [file] = process.argv.slice(1);
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const key of Object.keys(d.components || {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(key)) {
          console.error(`Manifest contains invalid component name: ${key}`);
          process.exit(1);
        }
        process.stdout.write(`${key}\n`);
      }
    ' "$file"
  else
    sed -n '/"components"/,/^}/p' "$file" | sed -n 's/^[[:space:]]*"\([^"]*\)"[[:space:]]*:.*/\1/p' | grep -v '^components$' | while IFS= read -r comp; do
      validate_component_name "$comp"
      printf '%s\n' "$comp"
    done
  fi
}

component_runtime_path() {
  local name="$1"
  case "$name" in
    plugin-*) printf '%s/runtime/plugins/%s' "$SIGNET_INSTALL_DIR" "${name#plugin-}" ;;
    *) printf '%s/runtime/%s' "$SIGNET_INSTALL_DIR" "$name" ;;
  esac
}

cleanup_legacy_plugin_paths() {
  for dir in "$SIGNET_INSTALL_DIR/runtime"/plugin-*/; do
    [ -d "$dir" ] || continue
    warn "Removing legacy plugin component path: $(basename "$dir")"
    rm -rf "$dir"
  done
}

require_remote_manifest_superset() {
  local remote_keys="$1"
  local local_keys
  local_keys="$(manifest_keys "$LOCAL_MANIFEST")"
  for comp in $local_keys; do
    case " $remote_keys " in
      *" $comp "*) ;;
      *)
        err "Remote manifest dropped installed component '$comp'; refusing update without explicit obsolete marker"
        exit 1
        ;;
    esac
  done
}

# Compare versions
LOCAL_VERSION="$(get_manifest_value '.version' "$LOCAL_MANIFEST")"
REMOTE_VERSION="$(get_manifest_value '.version' "$REMOTE_MANIFEST")"
REMOTE_KEYS="$(manifest_keys "$REMOTE_MANIFEST")"
require_remote_manifest_superset "$REMOTE_KEYS"

if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
  # Check individual component checksums
  CHANGED=0
  COMPONENTS="$REMOTE_KEYS"
  for comp in $COMPONENTS; do
    LOCAL_SHA="$(get_manifest_value ".components.\"$comp\".sha256" "$LOCAL_MANIFEST")"
    REMOTE_SHA="$(get_manifest_value ".components.\"$comp\".sha256" "$REMOTE_MANIFEST")"
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
COMPONENTS="$REMOTE_KEYS"
STAGED=""

# Clean stale .old dirs from any previous failed update
find "$SIGNET_INSTALL_DIR/runtime" -maxdepth 1 -name '*.old' -type d 2>/dev/null | while read -r olddir; do
  warn "Cleaning stale backup: $(basename "$olddir")"
  rm -rf "$olddir"
done
if [ -d "$SIGNET_INSTALL_DIR/runtime/plugins" ]; then
  find "$SIGNET_INSTALL_DIR/runtime/plugins" -maxdepth 1 -name '*.old' -type d 2>/dev/null | while read -r olddir; do
    warn "Cleaning stale plugin backup: $(basename "$olddir")"
    rm -rf "$olddir"
  done
fi
UPDATED=0
FAILED=0

for comp in $COMPONENTS; do
  LOCAL_SHA="$(get_manifest_value ".components.\"$comp\".sha256" "$LOCAL_MANIFEST")"
  REMOTE_SHA="$(get_manifest_value ".components.\"$comp\".sha256" "$REMOTE_MANIFEST")"
  REMOTE_URL="$(get_manifest_value ".components.\"$comp\".url" "$REMOTE_MANIFEST")"

  if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    continue
  fi

  if [ -z "$REMOTE_URL" ]; then
    err "Component $comp has no download URL — cannot update"
    FAILED=$((FAILED + 1))
    continue
  fi

  FILENAME="$(basename "$REMOTE_URL")"
  if ! is_expected_asset_url "$comp" "$REMOTE_URL" "$FILENAME"; then
    err "Manifest URL for $comp is outside expected release assets: $REMOTE_URL"
    FAILED=$((FAILED + 1))
    continue
  fi

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
    DEST="$(component_runtime_path "$comp")"
    OLD="${DEST}.old"
    mkdir -p "$(dirname "$DEST")"
    if [ -d "$DEST" ]; then mv "$DEST" "$OLD"; fi
  done
  # Stage 2: Promote staged components
  for comp in $STAGED; do
    DEST="$(component_runtime_path "$comp")"
    mkdir -p "$(dirname "$DEST")"
    if mv "$TMPDIR/staged/$comp" "$DEST" 2>/dev/null; then
      touch "$DEST/.complete"
      ok "$comp updated"
      PROMOTED="$PROMOTED $comp"
    else
      err "Failed to install $comp"
      rm -rf "$DEST"
      # Roll back all components that already succeeded
      for prev in $PROMOTED; do
        PDEST="$(component_runtime_path "$prev")"
        rm -rf "$PDEST"
      done
      # Restore all .old backups (promoted + failed)
      for comp2 in $STAGED; do
        DEST2="$(component_runtime_path "$comp2")"
        OLD2="${DEST2}.old"
        mkdir -p "$(dirname "$DEST2")"
        if [ -d "$OLD2" ]; then mv "$OLD2" "$DEST2"; fi
      done
      rm -rf "$TMPDIR/staged"
      err "Update failed — all components rolled back"
      exit 1
    fi
  done
  # All promoted successfully — safe to remove backups
  for comp in $STAGED; do
    rm -rf "$(component_runtime_path "$comp").old"
  done
fi

rm -rf "$TMPDIR/staged"
cleanup_legacy_plugin_paths

cp "$REMOTE_MANIFEST" "$LOCAL_MANIFEST"
echo "$REMOTE_VERSION" > "$SIGNET_INSTALL_DIR/VERSION"

echo ""
if [ "$UPDATED" -gt 0 ]; then
  ok "$UPDATED component(s) updated to v$REMOTE_VERSION"
  info "Restart the daemon to apply changes: signet daemon restart"
else
  ok "No updates needed"
fi
