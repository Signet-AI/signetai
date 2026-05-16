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

validate_safe_dir() {
  local label="$1" value="$2" normalized_value normalized_home
  normalized_value="$(normalize_path_for_guard "$value")"
  normalized_home="$(normalize_path_for_guard "$HOME")"
  if [ -z "$value" ] || [ "$normalized_value" = "/" ] || [ "$normalized_value" = "$normalized_home" ]; then
    echo "Error: $label is a dangerous path ($value). Refusing to continue." >&2
    exit 1
  fi
  printf '%s' "$normalized_value"
}

SIGNET_INSTALL_DIR="$(validate_safe_dir "install dir" "$SIGNET_INSTALL_DIR")"

remove_path_from_rc() {
  local rc="$1" bindir="$SIGNET_INSTALL_DIR/bin" tmp
  tmp="${rc}.signet.$$"
  awk -v bindir="$bindir" '
    $0 == "# Signet PATH" { in_signet = 1; next }
    in_signet && $0 == "# End Signet PATH" { in_signet = 0; next }
    in_signet { next }
    $0 == "# Signet" { legacy_marker = 1; next }
    legacy_marker {
      if ($0 == "export PATH=\"" bindir ":$PATH\"") {
        legacy_marker = 0
        next
      }
      print "# Signet"
      legacy_marker = 0
    }
    $0 == "export PATH=\"" bindir ":$PATH\"" { next }
    { print }
    END {
      if (legacy_marker) print "# Signet"
    }
  ' "$rc" > "$tmp" && mv "$tmp" "$rc"
  rm -f "$tmp"
}

# Stop daemon if running
if [ -f "$SIGNET_INSTALL_DIR/bin/signet" ]; then
  export PATH="$SIGNET_INSTALL_DIR/bin:$PATH"
  if signet daemon stop 2>/dev/null; then
    ok "Daemon stopped"
  fi
fi

# Remove PATH from shell config
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -Fq "export PATH=\"$SIGNET_INSTALL_DIR/bin:\$PATH\"" "$rc"; then
    info "Removing PATH from $(basename "$rc")..."
    remove_path_from_rc "$rc"
    ok "Cleaned $(basename "$rc")"
  fi
done

# Remove installation
if [ -d "$SIGNET_INSTALL_DIR" ]; then
  if [ ! -f "$SIGNET_INSTALL_DIR/manifest.json" ]; then
    echo "Error: $SIGNET_INSTALL_DIR does not appear to be a Signet installation (no manifest.json)"
    echo "Refusing to remove. Set SIGNET_INSTALL_DIR to the correct path."
    exit 1
  fi
  info "Removing $SIGNET_INSTALL_DIR..."
  rm -rf "$SIGNET_INSTALL_DIR"
  ok "Installation removed"
fi

# Optionally purge user data
if [ "$PURGE" = "--purge" ]; then
  AGENTS_DIR="${SIGNET_PATH:-$HOME/.agents}"
  AGENTS_DIR="$(validate_safe_dir "agents dir" "$AGENTS_DIR")"
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
