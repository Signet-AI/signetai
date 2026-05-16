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
RELEASE_DOWNLOAD_PREFIX="https://github.com/${SIGNET_REPO}/releases/download"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

RED='\033[0;31m'
info()  { printf "${CYAN}  →${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  !${NC} %s\n" "$1"; }
err()   { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

normalize_path_for_guard() {
  local path="$1" absolute current part next old_ifs
  local -a parts
  if [ -z "$path" ]; then
    printf '%s' ""
    return
  fi
  case "$path" in
    /*) absolute="$path" ;;
    *) absolute="$(pwd -P)/$path" ;;
  esac
  current="/"
  old_ifs="$IFS"
  IFS='/'
  read -r -a parts <<< "$absolute"
  IFS="$old_ifs"
  for part in "${parts[@]}"; do
    case "$part" in
      ""|.) continue ;;
      ..)
        if [ "$current" != "/" ]; then
          current="${current%/*}"
          [ -n "$current" ] || current="/"
        fi
        continue
        ;;
    esac
    if [ "$current" = "/" ]; then
      next="/$part"
    else
      next="$current/$part"
    fi
    if [ -d "$next" ]; then
      next="$(cd "$next" 2>/dev/null && pwd -P || printf '%s' "$next")"
    fi
    current="$next"
  done
  printf '%s' "$current"
}

validate_install_dir() {
  local install_dir normalized_dir normalized_home
  install_dir="$1"
  normalized_dir="$(normalize_path_for_guard "$install_dir")"
  normalized_home="$(normalize_path_for_guard "$HOME")"
  if [ -z "$install_dir" ] || [ "$normalized_dir" = "/" ] || [ "$normalized_dir" = "$normalized_home" ]; then
    err "Install dir is a dangerous path ($install_dir). Set SIGNET_INSTALL_DIR to a dedicated directory."
    exit 1
  fi
  case "$install_dir" in
    *'$'*|*'`'*|*'"'*|*"'"*|*\\*|*$'\n'*|*$'\r'*)
      err "Install dir contains shell-significant characters ($install_dir). Set SIGNET_INSTALL_DIR to a path without quotes, dollar signs, backticks, backslashes, or newlines."
      exit 1
      ;;
  esac
  printf '%s' "$normalized_dir"
}

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
    *)
      err "Unsupported platform: $os $arch"
      err "Signet requires macOS (ARM64/x64) or Linux (ARM64/x64)"
      exit 1
      ;;
  esac
}

PLATFORM="$(detect_platform)"
SIGNET_INSTALL_DIR="$(validate_install_dir "$SIGNET_INSTALL_DIR")"
LOCAL_MANIFEST="$SIGNET_INSTALL_DIR/manifest.json"
TMPDIR="$(mktemp -d)"
LOCKFILE="$SIGNET_INSTALL_DIR/.lock"
LOCK_ACQUIRED=0
cleanup() {
  rm -rf "$TMPDIR"
  if [ "$LOCK_ACQUIRED" = "1" ]; then
    rm -rf "$LOCKFILE"
  fi
}
trap cleanup EXIT

mkdir -p "$SIGNET_INSTALL_DIR"
if mkdir "$LOCKFILE" 2>/dev/null; then
  LOCK_ACQUIRED=1
else
  LOCK_PID="$(cat "$LOCKFILE/pid" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    err "Another update or install is already running (pid $LOCK_PID)"
    exit 1
  fi
  LOCK_AGE="$(($(date +%s) - $(stat -f %m "$LOCKFILE" 2>/dev/null || stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0)))"
  warn "Stale lock found (${LOCK_AGE}s old, pid ${LOCK_PID:-unknown} not running) — removing"
  rm -rf "$LOCKFILE"
  if ! mkdir "$LOCKFILE" 2>/dev/null; then
    err "Failed to acquire lock after clearing stale lock"
    exit 1
  fi
  LOCK_ACQUIRED=1
fi
echo "$$" > "$LOCKFILE/pid"

SHA256_CMD=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
fi

sha_verify() {
  local file="$1" expected="$2"
  if [ -z "$SHA256_CMD" ]; then return 1; fi
  if [ -z "$expected" ]; then return 1; fi
  local actual
  actual="$($SHA256_CMD "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ]
}

if [ ! -f "$LOCAL_MANIFEST" ]; then
  echo "No Signet installation found at $SIGNET_INSTALL_DIR"
  echo "Run the installer first: curl -fsSL https://signetai.sh/install.sh | bash"
  exit 1
fi

info "Checking for updates..."

is_expected_release_url() {
  local url="$1" filename="$2" rel tag asset
  case "$filename" in
    ""|"."|".."|*/*|*\?*|*#*) return 1 ;;
  esac
  case "$url" in
    "$RELEASE_DOWNLOAD_PREFIX"/*) ;;
    *) return 1 ;;
  esac
  rel="${url#"$RELEASE_DOWNLOAD_PREFIX"/}"
  tag="${rel%%/*}"
  asset="${rel#*/}"
  if [ "$asset" = "$rel" ]; then return 1; fi
  case "$tag" in
    bundle-*) ;;
    *) return 1 ;;
  esac
  [ "$asset" = "$filename" ]
}

is_expected_asset_url() {
  local name="$1" url="$2" filename="$3"
  is_expected_release_url "$url" "$filename" || return 1
  case "$filename" in
    ""|"."|".."|*/*|*\?*|*#*) return 1 ;;
  esac
  case "$filename" in
    signet-"$name".tar.gz|signet-"$name"-"$PLATFORM".tar.gz) return 0 ;;
    *) return 1 ;;
  esac
}

is_expected_script_url() {
  local script="$1" url="$2" filename="$3"
  is_expected_release_url "$url" "$filename" || return 1
  case "$filename" in
    "$script") return 0 ;;
    *) return 1 ;;
  esac
}

# Download latest manifest
REMOTE_MANIFEST="$TMPDIR/manifest-latest.json"
curl -fsSL "${DOWNLOAD_BASE}/manifest-${PLATFORM}.json" -o "$REMOTE_MANIFEST" || {
  echo "Failed to fetch remote manifest"
  exit 1
}

safe_tar_extract() {
  local archive="$1" dest="$2"
  local unsafe
  unsafe="$(tar tzf "$archive" 2>/dev/null | awk '$0 == "" || $0 == ".." || $0 ~ /[[:space:]]/ || $0 ~ /^\// || $0 ~ /^\.\.\// || $0 ~ /(^|\/)\.\.($|\/)/ { print }')"
  if [ -n "$unsafe" ]; then
    err "Archive contains unsafe paths:"
    echo "$unsafe"
    return 1
  fi
  local unsafe_links
  unsafe_links="$(awk '
    function clean(path, parts, stack, depth, n, i, p, out) {
      if (path ~ /^\//) return "__ABS__"
      n = split(path, parts, "/")
      depth = 0
      for (i = 1; i <= n; i++) {
        p = parts[i]
        if (p == "" || p == ".") continue
        if (p == "..") {
          if (depth == 0) return "__ESCAPE__"
          depth--
          continue
        }
        stack[++depth] = p
      }
      out = ""
      for (i = 1; i <= depth; i++) out = out (out == "" ? "" : "/") stack[i]
      return out
    }

    FNR == NR {
      if ($1 ~ /^h/) {
        print "hard link entry: " $0
        next
      }
      if ($1 ~ /^l/) {
        line = $0
        split(line, arrow, " -> ")
        if (!(2 in arrow)) {
          print "unparseable symlink entry: " line
          next
        }
        left = arrow[1]
        target = arrow[2]
        n = split(left, fields, /[[:space:]]+/)
        link = fields[n]
        sub(/^\.\//, "", link)
        normalized_link = clean(link)
        if (normalized_link == "__ESCAPE__" || normalized_link == "__ABS__") {
          print "unsafe symlink path: " link
          next
        }
        if (target ~ /^\//) {
          print "absolute symlink target: " link " -> " target
          next
        }
        base = normalized_link
        sub(/\/?[^\/]*$/, "", base)
        resolved = clean((base == "" ? "" : base "/") target)
        if (resolved == "__ESCAPE__" || resolved == "__ABS__") {
          print "escaping symlink target: " link " -> " target
          next
        }
        links[normalized_link] = 1
      }
      next
    }

    {
      entry = $0
      sub(/^\.\//, "", entry)
      normalized_entry = clean(entry)
      for (link in links) {
        if (normalized_entry != link && index(normalized_entry, link "/") == 1) {
          print "member descends through symlink: " entry " via " link
        }
      }
    }
  ' <(tar tvf "$archive" 2>/dev/null) <(tar tzf "$archive" 2>/dev/null))"
  if [ -n "$unsafe_links" ]; then
    err "Archive contains unsafe links:"
    echo "$unsafe_links"
    return 1
  fi
  mkdir -p "$dest"
  tar xzf "$archive" -C "$dest"
  local escaped
  escaped="$(find "$dest" -type l 2>/dev/null | while read -r link; do
    local target
    target="$(readlink "$link")"
    if [ "${target#/}" != "$target" ]; then
      echo "$link -> $target"
      continue
    fi
    local resolved
    resolved="$(cd "$(dirname "$link")" && cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")"
    if [ "$resolved" != "$dest" ] && [ "${resolved#"$dest"/}" = "$resolved" ]; then
      echo "$link -> $resolved"
    fi
  done)"
  if [ -n "$escaped" ]; then
    err "Extracted archive contains symlinks escaping dest dir:"
    echo "$escaped"
    rm -rf "$dest"
    return 1
  fi
}

# Dependency-free manifest lookup for the no-jq/no-node reinstall path.
# Handles .version plus first-level fields under .components and .scripts.
json_value() {
  local key="$1" file="${2:-${TMPDIR}/manifest-latest.json}"
  if [ "$key" = ".version" ]; then
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1
    return
  fi
  local collection name field
  collection="$(printf '%s' "$key" | sed -n 's/^\.\([a-zA-Z0-9_]*\)\..*/\1/p')"
  name="$(printf '%s' "$key" | sed 's/.*\."//;s/".*//')"
  field="$(printf '%s' "$key" | sed 's/.*\.\([a-zA-Z0-9_]*\)$/\1/')"
  case "$collection" in
    components|scripts) ;;
    *) return ;;
  esac
  # Parse only first-level fields in the target manifest object, ignoring nested metadata.
  awk -v collection="$collection" -v name="$name" -v field="$field" '
    $0 ~ "\"" collection "\"[[:space:]]*:" { in_collection = 1; collection_depth = 0 }
    in_collection && !in_item && $0 ~ "\"" name "\"[[:space:]]*:" { in_item = 1; item_depth = 0 }
    in_collection {
      line = $0
      if (in_item && item_depth == 1) {
        prefix = "^[[:space:]]*\"" field "\"[[:space:]]*:[[:space:]]*\""
        if (line ~ prefix) {
          sub(prefix, "", line)
          sub("\".*", "", line)
          print line
          exit
        }
      }
      item_line = $0
      item_opens = gsub(/\{/, "{", item_line)
      item_closes = gsub(/\}/, "}", item_line)
      if (in_item) {
        item_depth += item_opens - item_closes
        if (item_depth <= 0 && item_closes > 0) exit
      }
      collection_line = $0
      collection_opens = gsub(/\{/, "{", collection_line)
      collection_closes = gsub(/\}/, "}", collection_line)
      collection_depth += collection_opens - collection_closes
      if (!in_item && collection_depth <= 0 && collection_closes > 0) exit
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

download_verified_script() {
  local script="$1" dest="$2"
  local url sha filename tmp
  url="$(get_manifest_value ".scripts.\"${script}\".url" "$REMOTE_MANIFEST")"
  sha="$(get_manifest_value ".scripts.\"${script}\".sha256" "$REMOTE_MANIFEST")"

  if [ -z "$url" ] || [ -z "$sha" ]; then
    err "Manifest missing checksum metadata for helper script '$script'"
    return 1
  fi
  if [ -z "$SHA256_CMD" ]; then
    err "No checksum tool available — cannot verify helper script '$script'. Install sha256sum or shasum and retry."
    return 1
  fi

  filename="$(basename "$url")"
  if ! is_expected_script_url "$script" "$url" "$filename"; then
    err "Manifest URL for helper script '$script' is outside expected release assets: $url"
    return 1
  fi

  tmp="${dest}.tmp"
  rm -f "$tmp"
  curl -fsSL "$url" -o "$tmp" || {
    err "Failed to download helper script '$script'"
    rm -f "$tmp"
    return 1
  }
  if ! sha_verify "$tmp" "$sha"; then
    err "Checksum mismatch for helper script '$script'"
    rm -f "$tmp"
    return 1
  fi
  chmod +x "$tmp"
  mv "$tmp" "$dest"
}

if ! command -v jq >/dev/null 2>&1 && [ ! -x "$SIGNET_INSTALL_DIR/runtime/node/bin/node" ]; then
  warn "jq and bundled node not found — performing full reinstall"
  INSTALLER="$TMPDIR/install.sh"
  download_verified_script "install.sh" "$INSTALLER" || {
    err "Failed to fetch verified installer for reinstall"
    exit 1
  }
  rm -rf "$LOCKFILE"
  LOCK_ACQUIRED=0
  trap 'rm -rf "$TMPDIR"' EXIT
  SIGNET_INSTALL_DIR="$SIGNET_INSTALL_DIR" bash "$INSTALLER"
  exit $?
fi

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

path_exists_or_symlink() {
  [ -e "$1" ] || [ -L "$1" ]
}

cleanup_legacy_plugin_paths() {
  for dir in "$SIGNET_INSTALL_DIR/runtime"/plugin-*/; do
    [ -d "$dir" ] || continue
    warn "Removing legacy plugin component path: $(basename "$dir")"
    rm -rf "$dir"
  done
}

refresh_wrappers() {
  local bindir="$SIGNET_INSTALL_DIR/bin"
  mkdir -p "$bindir"

  cat > "${bindir}/signet" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_DIR
export SIGNET_DASHBOARD_DIR="$SIGNET_DIR/runtime/dashboard"
export SIGNET_SKILLS_SOURCE="$SIGNET_DIR/runtime/skills"
export SIGNET_TEMPLATES_DIR="$SIGNET_DIR/runtime/templates"
export NODE_PATH="$SIGNET_DIR/runtime/daemon-js/node_modules"
case "$(uname -s)" in
  Linux)  export LD_LIBRARY_PATH="$SIGNET_DIR/runtime/native${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  Darwin) export DYLD_LIBRARY_PATH="$SIGNET_DIR/runtime/native${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" ;;
esac
exec "$SIGNET_DIR/runtime/node/bin/node" "$SIGNET_DIR/runtime/cli/cli.js" "$@"
WRAPPER
  chmod +x "${bindir}/signet"

  cat > "${bindir}/signet-daemon" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_DIR
export SIGNET_DASHBOARD_DIR="$SIGNET_DIR/runtime/dashboard"
export SIGNET_SKILLS_SOURCE="$SIGNET_DIR/runtime/skills"
export SIGNET_TEMPLATES_DIR="$SIGNET_DIR/runtime/templates"
export SIGNET_DAEMON_ENTRYPOINT=1
export NODE_PATH="$SIGNET_DIR/runtime/daemon-js/node_modules"
case "$(uname -s)" in
  Linux)  export LD_LIBRARY_PATH="$SIGNET_DIR/runtime/native${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  Darwin) export DYLD_LIBRARY_PATH="$SIGNET_DIR/runtime/native${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" ;;
esac
exec "$SIGNET_DIR/runtime/node/bin/node" "$SIGNET_DIR/runtime/daemon-js/daemon.js" "$@"
WRAPPER
  chmod +x "${bindir}/signet-daemon"

  cat > "${bindir}/signet-mcp" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_DIR
export SIGNET_DASHBOARD_DIR="$SIGNET_DIR/runtime/dashboard"
export SIGNET_SKILLS_SOURCE="$SIGNET_DIR/runtime/skills"
export SIGNET_TEMPLATES_DIR="$SIGNET_DIR/runtime/templates"
export NODE_PATH="$SIGNET_DIR/runtime/daemon-js/node_modules"
case "$(uname -s)" in
  Linux)  export LD_LIBRARY_PATH="$SIGNET_DIR/runtime/native${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  Darwin) export DYLD_LIBRARY_PATH="$SIGNET_DIR/runtime/native${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" ;;
esac
exec "$SIGNET_DIR/runtime/node/bin/node" "$SIGNET_DIR/runtime/cli/cli.js" mcp "$@"
WRAPPER
  chmod +x "${bindir}/signet-mcp"

  if download_verified_script "uninstall.sh" "${bindir}/_uninstall.sh"; then
    cat > "${bindir}/signet-uninstall" << WRAPPER
#!/usr/bin/env bash
SIGNET_INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_INSTALL_DIR
exec "\$SIGNET_INSTALL_DIR/bin/_uninstall.sh" "\$@"
WRAPPER
    chmod +x "${bindir}/signet-uninstall"
  else
    err "Could not refresh verified uninstaller helper"
    exit 1
  fi

  if download_verified_script "update.sh" "${bindir}/_update.sh"; then
    cat > "${bindir}/signet-update" << WRAPPER
#!/usr/bin/env bash
SIGNET_INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_INSTALL_DIR
exec "\$SIGNET_INSTALL_DIR/bin/_update.sh" "\$@"
WRAPPER
    chmod +x "${bindir}/signet-update"
  else
    err "Could not refresh verified updater helper"
    exit 1
  fi
}

REQUIRED_COMPONENTS="node cli daemon-js daemon-rs dashboard connectors plugin-opencode plugin-oh-my-pi plugin-pi native skills templates"

is_required_component() {
  local comp="$1"
  case " $REQUIRED_COMPONENTS " in
    *" $comp "*) return 0 ;;
    *) return 1 ;;
  esac
}

has_manifest_key() {
  local keys="$1" comp="$2"
  printf '%s\n' "$keys" | grep -Fx -- "$comp" >/dev/null 2>&1
}

collect_obsolete_components() {
  local remote_keys="$1"
  local local_keys obsolete
  local_keys="$(manifest_keys "$LOCAL_MANIFEST")"
  obsolete=""
  for comp in $local_keys; do
    if has_manifest_key "$remote_keys" "$comp"; then
      continue
    fi
    if is_required_component "$comp"; then
      err "Remote manifest is missing required installed component '$comp'"
      exit 1
    fi
    warn "Remote manifest no longer includes optional component '$comp'; removing it during this update" >&2
    obsolete="${obsolete:+$obsolete }$comp"
  done
  printf '%s' "$obsolete"
}

# Compare versions
LOCAL_VERSION="$(get_manifest_value '.version' "$LOCAL_MANIFEST")"
REMOTE_VERSION="$(get_manifest_value '.version' "$REMOTE_MANIFEST")"
REMOTE_KEYS="$(manifest_keys "$REMOTE_MANIFEST")"
OBSOLETE_COMPONENTS="$(collect_obsolete_components "$REMOTE_KEYS")"

if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
  # Check individual component checksums
  CHANGED=0
  for comp in $OBSOLETE_COMPONENTS; do
    CHANGED=$((CHANGED + 1))
  done
  COMPONENTS="$REMOTE_KEYS"
  for comp in $COMPONENTS; do
    LOCAL_SHA="$(get_manifest_value ".components.\"$comp\".sha256" "$LOCAL_MANIFEST")"
    REMOTE_SHA="$(get_manifest_value ".components.\"$comp\".sha256" "$REMOTE_MANIFEST")"
    if [ "$LOCAL_SHA" != "$REMOTE_SHA" ] && [ -n "$REMOTE_SHA" ]; then
      CHANGED=$((CHANGED + 1))
    fi
  done
  for script in update.sh uninstall.sh; do
    LOCAL_SHA="$(get_manifest_value ".scripts.\"$script\".sha256" "$LOCAL_MANIFEST")"
    REMOTE_SHA="$(get_manifest_value ".scripts.\"$script\".sha256" "$REMOTE_MANIFEST")"
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
REMOVED=0

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

refresh_wrappers

if [ -n "$STAGED" ]; then
  mkdir -p "$SIGNET_INSTALL_DIR/runtime"
  PROMOTED=""
  # Stage 1: Move old components aside (keep backups for rollback)
  for comp in $STAGED; do
    DEST="$(component_runtime_path "$comp")"
    OLD="${DEST}.old"
    mkdir -p "$(dirname "$DEST")"
    if path_exists_or_symlink "$OLD"; then
      warn "Cleaning stale backup: $(basename "$OLD")"
      rm -rf "$OLD"
    fi
    if path_exists_or_symlink "$DEST"; then mv "$DEST" "$OLD"; fi
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
        if path_exists_or_symlink "$OLD2"; then mv "$OLD2" "$DEST2"; fi
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

for comp in $OBSOLETE_COMPONENTS; do
  DEST="$(component_runtime_path "$comp")"
  if path_exists_or_symlink "$DEST"; then
    rm -rf "$DEST" "${DEST}.old"
    ok "$comp removed"
    REMOVED=$((REMOVED + 1))
  fi
done

rm -rf "$TMPDIR/staged"
cleanup_legacy_plugin_paths

cp "$REMOTE_MANIFEST" "$LOCAL_MANIFEST"
echo "$REMOTE_VERSION" > "$SIGNET_INSTALL_DIR/VERSION"

echo ""
if [ "$UPDATED" -gt 0 ] || [ "$REMOVED" -gt 0 ]; then
  ok "$UPDATED component(s) updated, $REMOVED obsolete component(s) removed to v$REMOTE_VERSION"
  info "Restart the daemon to apply changes: signet daemon restart"
else
  ok "No updates needed"
fi
