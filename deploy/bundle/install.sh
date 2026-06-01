#!/usr/bin/env bash
# Signet Native Bundle Installer
#
# Usage:
#   curl -fsSL https://signetai.sh/install.sh | bash
#   curl -fsSL https://signetai.sh/install.sh | bash -s -- -- --name Agent --harness codex --deployment-type local --embedding-provider native --extraction-provider codex
#   curl -fsSL https://github.com/Signet-AI/signetai/releases/download/bundle-latest/install.sh | bash
#
# Environment options:
#   SIGNET_INSTALL_DIR  — install location (default: ~/.signet)
#   SIGNET_NO_START     — set to "1" to skip daemon start
#   SIGNET_NO_SETUP     — set to "1" to skip setup (same as SIGNET_SETUP_MODE=skip)
#   SIGNET_SETUP_MODE   — auto|interactive|noninteractive|skip (default: auto)
#   SIGNET_SETUP_*      — setup flags for SIGNET_SETUP_MODE=noninteractive
#   SIGNET_NO_PATH      — set to "1" to skip PATH modification

set -euo pipefail

SIGNET_INSTALL_DIR="${SIGNET_INSTALL_DIR:-$HOME/.signet}"
SIGNET_AGENTS_DIR="${SIGNET_PATH:-$HOME/.agents}"
SIGNET_SETUP_MODE="${SIGNET_SETUP_MODE:-auto}"
SIGNET_VERSION="${SIGNET_VERSION:-latest}"
SIGNET_REPO="Signet-AI/signetai"
SIGNET_RELEASE_TAG="bundle-${SIGNET_VERSION}"
INSTALLER_SETUP_ARGS=()

show_usage() {
  cat <<'EOF'
Signet native bundle installer

Usage:
  curl -fsSL https://signetai.sh/install.sh | bash
  curl -fsSL https://signetai.sh/install.sh | bash -s -- --help
  curl -fsSL https://signetai.sh/install.sh | bash -s -- --no-setup
  curl -fsSL https://signetai.sh/install.sh | bash -s -- -- --name Agent --harness codex --deployment-type local --embedding-provider native --extraction-provider codex

Installer options:
  --help                         Show this help text and exit.
  --no-setup                     Install only. Run `signet setup` later.
  --interactive-setup            Require the interactive setup wizard.
  --noninteractive-setup         Require non-interactive setup from SIGNET_SETUP_* env vars.
  --setup-mode <mode>            auto, interactive, noninteractive, or skip.
  --                             Treat remaining args as `signet setup --non-interactive` flags.

Required setup flags after `--` for agent-driven setup:
  --name <name>
  --harness <claude-code|codex|opencode|openclaw|oh-my-pi|pi|hermes-agent|gemini>
  --deployment-type <local|vps|server>
  --embedding-provider <native|llama-cpp|ollama|openai|none>
  --extraction-provider <acpx|claude-code|codex|opencode|ollama|openai|openai-compatible|llama-cpp|none>

Environment options:
  SIGNET_INSTALL_DIR             Install location. Default: ~/.signet
  SIGNET_PATH                    Agent data location. Default: ~/.agents
  SIGNET_NO_START=1              Skip daemon start.
  SIGNET_NO_SETUP=1              Skip setup. Same as --no-setup.
  SIGNET_NO_PATH=1               Skip shell PATH modification.
  SIGNET_SETUP_MODE              auto, interactive, noninteractive, or skip.
  SIGNET_SETUP_*                 Setup choices for --noninteractive-setup.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      show_usage
      exit 0
      ;;
  esac
done

if [ "$SIGNET_VERSION" != "latest" ]; then
  echo "SIGNET_VERSION is not supported by the native bundle installer yet; use SIGNET_VERSION=latest."
  exit 1
fi

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

banner() {
  echo ""
  printf "${CYAN}${BOLD}  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}\n"
  printf "${CYAN}${BOLD}  ┃${NC}  ${BOLD}SIGNET${NC} ${DIM}native bundle installer${NC}       ${CYAN}${BOLD}┃${NC}\n"
  printf "${CYAN}${BOLD}  ┃${NC}  ${DIM}portable identity · memory · skills${NC}   ${CYAN}${BOLD}┃${NC}\n"
  printf "${CYAN}${BOLD}  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}\n"
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

SIGNET_INSTALL_DIR="$(validate_install_dir "$SIGNET_INSTALL_DIR")"

parse_installer_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        show_usage
        exit 0
        ;;
      --setup-mode)
        shift
        if [ "$#" -eq 0 ]; then
          err "--setup-mode requires a value"
          exit 1
        fi
        SIGNET_SETUP_MODE="$1"
        ;;
      --setup-mode=*)
        SIGNET_SETUP_MODE="${1#*=}"
        ;;
      --no-setup)
        SIGNET_SETUP_MODE="skip"
        ;;
      --interactive-setup)
        SIGNET_SETUP_MODE="interactive"
        ;;
      --noninteractive-setup|--non-interactive-setup)
        SIGNET_SETUP_MODE="noninteractive"
        ;;
      --)
        shift
        INSTALLER_SETUP_ARGS=("$@")
        if [ "${#INSTALLER_SETUP_ARGS[@]}" -gt 0 ]; then
          SIGNET_SETUP_MODE="noninteractive"
        fi
        return
        ;;
      *)
        err "Unknown installer option: $1"
        err "Use --no-setup, --setup-mode <mode>, or -- followed by signet setup flags."
        exit 1
        ;;
    esac
    shift
  done
}

parse_installer_args "$@"

# sha256sum or shasum
SHA256_CMD=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
else
  err "No checksum tool available — install sha256sum or shasum and retry."
  exit 1
fi

# ── Download helpers ──

DOWNLOAD_BASE="https://github.com/${SIGNET_REPO}/releases/download/${SIGNET_RELEASE_TAG}"
RELEASE_DOWNLOAD_PREFIX="https://github.com/${SIGNET_REPO}/releases/download"

tmpdir=""
LOCKFILE="$SIGNET_INSTALL_DIR/.lock"
LOCK_ACQUIRED=0
cleanup() {
  if [ -n "$tmpdir" ] && [ -d "$tmpdir" ]; then
    rm -rf "$tmpdir"
  fi
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
    err "Another install or update is already running (pid $LOCK_PID)"
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

tmpdir="$(mktemp -d)"

sha_verify() {
  local file="$1" expected="$2"
  if [ -z "$SHA256_CMD" ]; then return 1; fi
  if [ -z "$expected" ]; then return 0; fi
  local actual
  actual="$($SHA256_CMD "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ]
}

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
  mkdir -p "$SIGNET_INSTALL_DIR/runtime/staging"
  rm -rf "$stage_dir"
  mv "$tmp_extract" "$stage_dir"
  rm -f "$tmp"
  ok "$name"
  return 0
}

download_verified_script() {
  local script="$1" dest="$2"
  local url sha filename tmp
  url="$(get_manifest_value ".scripts.\"${script}\".url")"
  sha="$(get_manifest_value ".scripts.\"${script}\".sha256")"

  if [ -z "$url" ] || [ -z "$sha" ]; then
    err "Manifest missing checksum metadata for helper script '$script'"
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
# Handles: .version plus .components."name".FIELD and .scripts."name".FIELD
json_value() {
  local key="$1" file="${2:-${tmpdir}/manifest.json}"
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
  local key="$1"
  local val=""
  if command -v jq >/dev/null 2>&1; then
    val="$(jq -r "$key" "${tmpdir}/manifest.json" 2>/dev/null)"
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
    ' "${tmpdir}/manifest.json" "$key" 2>/dev/null || true
  else
    json_value "$key" "${tmpdir}/manifest.json"
  fi
}

# ── Component list (Node.js runtime) ──

COMPONENTS=(
  node cli daemon-js daemon-rs dashboard
  connectors plugin-opencode plugin-oh-my-pi plugin-pi
  native skills templates
)

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

# ── Generate wrapper scripts (Bun-only) ──

generate_wrappers() {
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
    cat > "${bindir}/signet-uninstall" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_INSTALL_DIR
exec "$SIGNET_INSTALL_DIR/bin/_uninstall.sh" "$@"
WRAPPER
    chmod +x "${bindir}/signet-uninstall"
  else
    err "Could not install verified uninstaller helper"
    exit 1
  fi

  if download_verified_script "update.sh" "${bindir}/_update.sh"; then
    cat > "${bindir}/signet-update" << 'WRAPPER'
#!/usr/bin/env bash
SIGNET_INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export SIGNET_INSTALL_DIR
exec "$SIGNET_INSTALL_DIR/bin/_update.sh" "$@"
WRAPPER
    chmod +x "${bindir}/signet-update"
  else
    err "Could not install verified updater helper"
    exit 1
  fi

  ok "Wrapper scripts created"
}

# ── PATH setup ──

setup_path() {
  if [ "${SIGNET_NO_PATH:-}" = "1" ]; then
    return 0
  fi

  local bindir="$SIGNET_INSTALL_DIR/bin"
  local shell_rc=""

  case "${SHELL:-}" in
    */zsh) shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
  esac

  if [ -z "$shell_rc" ] && [ -n "${ZSH_VERSION:-}" ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -z "$shell_rc" ] && [ -n "${BASH_VERSION:-}" ]; then
    shell_rc="$HOME/.bashrc"
  elif [ -z "$shell_rc" ] && [ -f "$HOME/.zshrc" ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -z "$shell_rc" ] && [ -f "$HOME/.bashrc" ]; then
    shell_rc="$HOME/.bashrc"
  fi

  if [ -z "$shell_rc" ]; then
    warn "Could not detect shell config file. Add to PATH manually:"
    echo "  export PATH=\"$bindir:\$PATH\""
    return 0
  fi

  if grep -Fq "export PATH=\"$bindir:\$PATH\"" "$shell_rc" 2>/dev/null; then
    ok "PATH already configured in $(basename "$shell_rc")"
    return 0
  fi

  printf '\n# Signet PATH\nexport PATH="%s:$PATH"\n# End Signet PATH\n' "$bindir" >> "$shell_rc"
  ok "Added to PATH in $(basename "$shell_rc")"
}

# ── Entrypoint verification ──

verify_entrypoints() {
  local missing=0
  local node_bin="$SIGNET_INSTALL_DIR/runtime/node/bin/node"
  local cli_js="$SIGNET_INSTALL_DIR/runtime/cli/cli.js"
  local daemon_js="$SIGNET_INSTALL_DIR/runtime/daemon-js/daemon.js"

  if [ ! -x "$node_bin" ]; then
    err "Required entrypoint missing: $node_bin"
    missing=$((missing + 1))
  fi
  if [ ! -f "$cli_js" ]; then
    err "Required entrypoint missing: $cli_js"
    missing=$((missing + 1))
  fi
  if [ ! -f "$daemon_js" ]; then
    err "Required entrypoint missing: $daemon_js"
    missing=$((missing + 1))
  fi
  if [ "$missing" -gt 0 ]; then
    err "$missing required entrypoint(s) missing — install is incomplete"
    exit 1
  fi
}

append_setup_flag() {
  local flag="$1" value="$2"
  if [ -n "$value" ]; then
    setup_args+=("$flag" "$value")
  fi
}

append_setup_bool_flag() {
  local flag="$1" value="$2"
  case "$value" in
    1|true|TRUE|yes|YES) setup_args+=("$flag") ;;
    ""|0|false|FALSE|no|NO) ;;
    *)
      err "$flag expects a boolean env value (1/0, true/false, yes/no)"
      exit 1
      ;;
  esac
}

append_setup_harnesses() {
  local raw="$1" old_ifs harness
  old_ifs="$IFS"
  IFS=','
  for harness in $raw; do
    harness="${harness#"${harness%%[![:space:]]*}"}"
    harness="${harness%"${harness##*[![:space:]]}"}"
    if [ -n "$harness" ]; then
      setup_args+=("--harness" "$harness")
    fi
  done
  IFS="$old_ifs"
}

setup_args_include_flag() {
  local flag="$1" arg
  for arg in "${INSTALLER_SETUP_ARGS[@]}"; do
    if [ "$arg" = "$flag" ] || [[ "$arg" == "$flag="* ]]; then
      return 0
    fi
  done
  return 1
}

require_noninteractive_setup_env() {
  local missing=""
  if [ -z "${SIGNET_SETUP_NAME:-}" ] && ! setup_args_include_flag "--name"; then missing="$missing --name"; fi
  if [ -z "${SIGNET_SETUP_HARNESS:-}" ] && ! setup_args_include_flag "--harness"; then missing="$missing --harness"; fi
  if [ -z "${SIGNET_SETUP_DEPLOYMENT_TYPE:-}" ] && ! setup_args_include_flag "--deployment-type"; then missing="$missing --deployment-type"; fi
  if [ -z "${SIGNET_SETUP_EMBEDDING_PROVIDER:-}" ] && ! setup_args_include_flag "--embedding-provider"; then missing="$missing --embedding-provider"; fi
  if [ -z "${SIGNET_SETUP_EXTRACTION_PROVIDER:-}" ] && ! setup_args_include_flag "--extraction-provider"; then missing="$missing --extraction-provider"; fi
  if [ -n "$missing" ]; then
    err "Agent-driven setup requires explicit setup choices:$missing"
    err "Example:"
    err "  curl -fsSL https://signetai.sh/install.sh | bash -s -- -- \\"
    err "    --name Agent --harness codex --deployment-type local \\"
    err "    --embedding-provider native --extraction-provider codex"
    exit 1
  fi
}

run_noninteractive_setup() {
  require_noninteractive_setup_env

  setup_args=(setup --non-interactive)
  if [ "${#INSTALLER_SETUP_ARGS[@]}" -gt 0 ]; then
    setup_args+=("${INSTALLER_SETUP_ARGS[@]}")
  else
    append_setup_flag "--name" "${SIGNET_SETUP_NAME:-}"
    append_setup_flag "--description" "${SIGNET_SETUP_DESCRIPTION:-}"
    append_setup_flag "--deployment-type" "${SIGNET_SETUP_DEPLOYMENT_TYPE:-}"
    append_setup_flag "--network-mode" "${SIGNET_SETUP_NETWORK_MODE:-}"
    append_setup_harnesses "${SIGNET_SETUP_HARNESS:-}"
    append_setup_flag "--embedding-provider" "${SIGNET_SETUP_EMBEDDING_PROVIDER:-}"
    append_setup_flag "--embedding-model" "${SIGNET_SETUP_EMBEDDING_MODEL:-}"
    append_setup_flag "--extraction-provider" "${SIGNET_SETUP_EXTRACTION_PROVIDER:-}"
    append_setup_flag "--extraction-model" "${SIGNET_SETUP_EXTRACTION_MODEL:-}"
    append_setup_flag "--extraction-endpoint" "${SIGNET_SETUP_EXTRACTION_ENDPOINT:-}"
    append_setup_flag "--search-balance" "${SIGNET_SETUP_SEARCH_BALANCE:-}"
    append_setup_flag "--openclaw-runtime-path" "${SIGNET_SETUP_OPENCLAW_RUNTIME_PATH:-}"
    append_setup_flag "--identity-preset" "${SIGNET_SETUP_IDENTITY_PRESET:-}"
    append_setup_bool_flag "--skip-git" "${SIGNET_SETUP_SKIP_GIT:-}"
    append_setup_bool_flag "--open-dashboard" "${SIGNET_SETUP_OPEN_DASHBOARD:-}"
    append_setup_bool_flag "--configure-openclaw-workspace" "${SIGNET_SETUP_CONFIGURE_OPENCLAW_WORKSPACE:-}"
    append_setup_bool_flag "--allow-unprotected-workspace" "${SIGNET_SETUP_ALLOW_UNPROTECTED_WORKSPACE:-}"
    append_setup_bool_flag "--create-local-backup" "${SIGNET_SETUP_CREATE_LOCAL_BACKUP:-}"
    append_setup_bool_flag "--disable-signet-secrets" "${SIGNET_SETUP_DISABLE_SIGNET_SECRETS:-}"
    append_setup_bool_flag "--with-graphiq" "${SIGNET_SETUP_WITH_GRAPHIQ:-}"
    append_setup_bool_flag "--disable-graphiq" "${SIGNET_SETUP_DISABLE_GRAPHIQ:-}"
  fi

  signet "${setup_args[@]}"
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

  REQUIRED_COMPONENTS="node cli daemon-js daemon-rs dashboard connectors plugin-opencode plugin-oh-my-pi plugin-pi native skills templates"

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
    if ! is_expected_asset_url "$name" "$comp_url" "$filename"; then
      err "Manifest URL for '$name' is outside expected release assets: $comp_url"
      exit 1
    fi

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

    dest="$(component_runtime_path "$name")"
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
    # Stage 1: Move all old components aside
    for dir in "$STAGING"/*/; do
      [ -d "$dir" ] || continue
      comp_name="$(basename "$dir")"
      DEST="$(component_runtime_path "$comp_name")"
      OLD="${DEST}.old"
      mkdir -p "$(dirname "$DEST")"
      if path_exists_or_symlink "$OLD"; then
        warn "Cleaning stale backup: $(basename "$OLD")"
        rm -rf "$OLD"
      fi
      if path_exists_or_symlink "$DEST"; then mv "$DEST" "$OLD"; fi
      MOVED="$MOVED $comp_name"
    done
    # Stage 2: Promote all staged components
    PROMOTED=""
    for dir in "$STAGING"/*/; do
      [ -d "$dir" ] || continue
      comp_name="$(basename "$dir")"
      DEST="$(component_runtime_path "$comp_name")"
      mkdir -p "$(dirname "$DEST")"
      if mv "$dir" "$DEST" 2>/dev/null; then
        touch "$DEST/.complete"
        PROMOTED="$PROMOTED $comp_name"
      else
        err "Failed to promote $comp_name — rolling back"
        rm -rf "$DEST"
        for prev in $MOVED; do
          PDEST="$(component_runtime_path "$prev")"
          POLD="${PDEST}.old"
          if path_exists_or_symlink "$PDEST"; then rm -rf "$PDEST"; fi
          mkdir -p "$(dirname "$PDEST")"
          if path_exists_or_symlink "$POLD"; then mv "$POLD" "$PDEST"; fi
        done
        rm -rf "$STAGING"
        exit 1
      fi
    done
    # All promoted — safe to remove backups
    for prev in $MOVED; do
      rm -rf "$(component_runtime_path "$prev").old"
    done
    rm -rf "$STAGING"
  fi
  cleanup_legacy_plugin_paths

  # Verify critical entrypoints exist before declaring success
  verify_entrypoints

  generate_wrappers
  setup_path

  VERSION_VAL="$(get_manifest_value '.version' 2>/dev/null || echo "unknown")"

  echo ""
  printf "${BOLD}  ──────────────────────────────────────${NC}\n"
  echo ""

  export PATH="$SIGNET_INSTALL_DIR/bin:$PATH"

  SETUP_DONE=0
  if [ "${SIGNET_NO_SETUP:-}" = "1" ]; then
    SIGNET_SETUP_MODE="skip"
  fi

  case "$SIGNET_SETUP_MODE" in
    auto)
      if [ -r /dev/tty ] && [ -w /dev/tty ]; then
        info "Launching setup wizard..."
        if signet setup < /dev/tty; then
          SETUP_DONE=1
          ok "Setup complete"
        else
          warn "Setup had issues — run 'signet setup' manually later"
        fi
      else
        warn "No interactive terminal available — run 'signet setup' to finish setup"
      fi
      ;;
    interactive)
      if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
        err "SIGNET_SETUP_MODE=interactive requires an interactive terminal"
        exit 1
      fi
      info "Launching setup wizard..."
      if signet setup < /dev/tty; then
        SETUP_DONE=1
        ok "Setup complete"
      else
        err "Setup failed"
        exit 1
      fi
      ;;
    noninteractive|non-interactive)
      info "Running non-interactive setup..."
      if run_noninteractive_setup; then
        SETUP_DONE=1
        ok "Setup complete"
      else
        err "Non-interactive setup failed"
        exit 1
      fi
      ;;
    skip)
      ;;
    *)
      err "Unknown SIGNET_SETUP_MODE: $SIGNET_SETUP_MODE"
      err "Expected auto, interactive, noninteractive, or skip"
      exit 1
      ;;
  esac

  if [ "${SIGNET_NO_START:-}" != "1" ]; then
    if [ "$SETUP_DONE" = "1" ] || [ -f "$SIGNET_AGENTS_DIR/agent.yaml" ]; then
      info "Restarting daemon..."
      if signet daemon restart --no-sync 2>/dev/null; then
        ok "Daemon restarted"
      elif signet daemon start 2>/dev/null; then
        ok "Daemon started"
      else
        warn "Daemon restart failed — run 'signet daemon restart' manually"
      fi
    else
      warn "Skipping daemon start until setup creates $SIGNET_AGENTS_DIR/agent.yaml"
    fi
  fi

  cp "${tmpdir}/manifest.json" "$SIGNET_INSTALL_DIR/manifest.json"
  echo "$VERSION_VAL" > "$SIGNET_INSTALL_DIR/VERSION"

  echo ""
  printf "${GREEN}${BOLD}  ✓ Signet v${VERSION_VAL} installed!${NC}\n"
  echo ""
  echo "  signet              — Main CLI"
  echo "  signet status       — Check status"
  echo "  signet remember     — Save a memory"
  echo "  signet recall       — Search memories"
  echo "  signet dashboard    — Open web UI"
  echo ""
  echo "  Config:    $SIGNET_AGENTS_DIR"
  if [ -f "$SIGNET_AGENTS_DIR/agent.yaml" ]; then
    echo "  Dashboard: http://localhost:3850"
  else
    echo ""
    echo "  Next step: signet setup"
  fi
  echo ""
  printf "${DIM}  Run 'source ~/.zshrc' or restart your terminal.${NC}\n"
  echo ""
}

main "$@"
