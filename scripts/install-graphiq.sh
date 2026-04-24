#!/usr/bin/env bash
set -euo pipefail

REPO="aaf2tbz/graphiq"
INSTALL_DIR="${GRAPHIQ_INSTALL_DIR:-$HOME/.local/bin}"
TIMEOUT="${GRAPHIQ_INSTALL_TIMEOUT:-120}"

log()  { printf "[graphiq] %s\n" "$*" >&2; }
die()  { log "$@"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

detect_target() {
	local os arch
	os="$(uname -s | tr '[:upper:]' '[:lower:]')"
	arch="$(uname -m)"
	case "$os-$arch" in
		darwin-arm64)  echo "aarch64-apple-darwin"   ;;
		darwin-x86_64) echo "x86_64-apple-darwin"    ;;
		linux-x86_64)  echo "x86_64-unknown-linux-gnu" ;;
		linux-aarch64) echo "aarch64-unknown-linux-gnu" ;;
		*) die "Unsupported platform: $os-$arch"      ;;
	esac
}

fetch() {
	local url="$1" dest="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --max-time "$TIMEOUT" -o "$dest" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -q --timeout="$TIMEOUT" -O "$dest" "$url"
	else
		die "Neither curl nor wget found"
	fi
}

latest_tag() {
	local url="https://api.github.com/repos/${REPO}/releases/latest"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --max-time 15 "$url" 2>/dev/null | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- --timeout=15 "$url" 2>/dev/null | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
	fi
}

cmd_install() {
	need tar
	local target tag url tmpdir tarball
	target="$(detect_target)"
	tag="${GRAPHIQ_VERSION:-$(latest_tag)}"
	[ -n "$tag" ] || die "Could not determine latest release tag"
	tarball="graphiq-${target}.tar.gz"
	url="https://github.com/${REPO}//releases/download/${tag}/${tarball}"

	log "Installing graphiq ${tag} for ${target}..."

	mkdir -p "$INSTALL_DIR"
	tmpdir="$(mktemp -d)"
	trap 'rm -rf "$tmpdir"' EXIT

	fetch "$url" "${tmpdir}/${tarball}"
	tar -xzf "${tmpdir}/${tarball}" -C "$tmpdir"

	local bin="${tmpdir}/graphiq"
	[ -f "$bin" ] || bin="$(find "$tmpdir" -name graphiq -type f | head -1)"
	[ -f "$bin" ] || die "graphiq binary not found in archive"

	chmod +x "$bin"
	mv "$bin" "${INSTALL_DIR}/graphiq"

	log "Installed graphiq to ${INSTALL_DIR}/graphiq"

	if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
		log "WARNING: ${INSTALL_DIR} is not on PATH. Add it with:"
		log "  export PATH=\"${INSTALL_DIR}:\$PATH\""
	fi
}

cmd_update() {
	cmd_install
	log "Update complete"
}

cmd_uninstall() {
	local bin="${INSTALL_DIR}/graphiq"
	if [ -f "$bin" ]; then
		rm -f "$bin"
		log "Removed ${bin}"
	else
		log "graphiq not found at ${bin}"
	fi
}

cmd_version() {
	if command -v graphiq >/dev/null 2>&1; then
		graphiq --version 2>/dev/null || echo "unknown"
	else
		echo "not installed"
	fi
}

usage() {
	cat <<'EOF'
Usage: install-graphiq.sh <command>

Commands:
  install    Download and install graphiq from GitHub releases
  update     Re-download latest version (same as install)
  uninstall  Remove the installed binary
  version    Print installed version

Environment:
  GRAPHIQ_INSTALL_DIR    Installation directory (default: ~/.local/bin)
  GRAPHIQ_VERSION        Pin to a specific release tag (default: latest)
  GRAPHIQ_INSTALL_TIMEOUT  Download timeout in seconds (default: 120)
EOF
}

case "${1:-}" in
	install)   cmd_install   ;;
	update)    cmd_update     ;;
	uninstall) cmd_uninstall  ;;
	version)   cmd_version    ;;
	*)         usage; exit 0  ;;
esac
