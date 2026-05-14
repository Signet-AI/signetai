#!/usr/bin/env bash
set -euo pipefail

REPO="aaf2tbz/graphiq"
INSTALL_DIR="${GRAPHIQ_INSTALL_DIR:-$HOME/.local/bin}"
TIMEOUT="${GRAPHIQ_INSTALL_TIMEOUT:-120}"
tmpdir=""

log()  { printf "[graphiq] %s\n" "$*" >&2; }
die()  { log "$@"; exit 1; }

cleanup_tmpdir() {
	if [ -n "${tmpdir:-}" ] && [ -d "${tmpdir:-}" ]; then
		rm -rf "$tmpdir"
	fi
}

trap cleanup_tmpdir EXIT

need() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

detect_target() {
	local os arch
	os="$(uname -s | tr '[:upper:]' '[:lower:]')"
	arch="$(uname -m)"
	case "$os-$arch" in
		darwin-arm64)  echo "aarch64-apple-darwin"   ;;
		darwin-x86_64) echo "x86_64-apple-darwin"    ;;
		linux-x86_64)  echo "x86_64-unknown-linux-gnu" ;;
		linux-aarch64|linux-arm64|linux-armv8l) echo "aarch64-unknown-linux-gnu" ;;
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

sha256_file() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		die "Neither shasum nor sha256sum found (required for integrity check)"
	fi
}

fetch_release_json() {
	local url="$1"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --max-time 15 "$url" 2>/dev/null
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- --timeout=15 "$url" 2>/dev/null
	fi
}

release_json_for_tag() {
	local tag="$1"
	if [ -z "$tag" ]; then
		fetch_release_json "https://api.github.com/repos/${REPO}/releases/latest"
		return
	fi
	fetch_release_json "https://api.github.com/repos/${REPO}/releases/tags/${tag}"
}

extract_asset_sha256() {
	local json="$1" asset_name="$2"
	if command -v jq >/dev/null 2>&1; then
		echo "$json" | jq -r --arg name "$asset_name" \
			'.assets[] | select(.name == $name) | .digest // ""' 2>/dev/null \
			| sed -E 's/^sha256://'
		return
	fi
	echo "$json" | awk -v name="$asset_name" '
		BEGIN { RS = "{"; in_asset = 0; asset_name = "" }
		/"name"\s*:\s*"/ { gsub(/.*"name"\s*:\s*"/, ""); gsub(/".*/, ""); asset_name = $0 }
		/"digest"\s*:\s*"/ && asset_name == name {
			gsub(/.*"digest"\s*:\s*"/, ""); gsub(/".*/, "");
			gsub(/^sha256:/, ""); print; found = 1; exit
		}
	' 2>/dev/null
}

cmd_install() {
	need tar
	local target tag tarball url
	target="$(detect_target)"
	tarball="graphiq-${target}.tar.gz"

	if [ -n "${GRAPHIQ_VERSION:-}" ]; then
		tag="$GRAPHIQ_VERSION"
	else
		[ "${GRAPHIQ_ALLOW_LATEST:-}" = "1" ] || die "Set GRAPHIQ_VERSION to pin a release tag, or GRAPHIQ_ALLOW_LATEST=1 to opt into latest"
		tag=""
	fi

	local release_json
	release_json="$(release_json_for_tag "$tag")"
	[ -n "$release_json" ] || die "Could not fetch release metadata from GitHub"

	if [ -z "$tag" ]; then
		if command -v jq >/dev/null 2>&1; then
			tag="$(echo "$release_json" | jq -r '.tag_name // empty' 2>/dev/null)"
		else
			tag="$(echo "$release_json" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
		fi
	fi
	[ -n "$tag" ] || die "Could not determine release tag"

	local expected_sha
	expected_sha="$(extract_asset_sha256 "$release_json" "$tarball")"

	url="https://github.com/${REPO}/releases/download/${tag}/${tarball}"

	log "Installing graphiq ${tag} for ${target}..."

	mkdir -p "$INSTALL_DIR"
	tmpdir="$(mktemp -d)"

	fetch "$url" "${tmpdir}/${tarball}"

	[ -n "$expected_sha" ] || die "No checksum found in release metadata for ${tarball} — refusing to install without integrity verification"
	local actual_sha
	actual_sha="$(sha256_file "${tmpdir}/${tarball}")"
	if [ "$actual_sha" != "$expected_sha" ]; then
		die "SHA256 mismatch for ${tarball}: expected ${expected_sha}, got ${actual_sha}"
	fi
	log "Integrity verified (sha256)"

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
	local bin="${INSTALL_DIR}/graphiq"
	if [ -f "$bin" ]; then
		"$bin" --version 2>/dev/null || echo "unknown"
	elif command -v graphiq >/dev/null 2>&1; then
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
  GRAPHIQ_VERSION        Pin to a specific release tag (required unless GRAPHIQ_ALLOW_LATEST=1)
  GRAPHIQ_ALLOW_LATEST   Set to 1 to allow downloading the latest release tag
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
