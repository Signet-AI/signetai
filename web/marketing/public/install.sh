#!/usr/bin/env bash
set -euo pipefail

REPO="${SIGNET_RELEASE_REPO:-Signet-AI/signetai}"
DOWNLOAD_DIR="${SIGNET_DOWNLOAD_DIR:-$HOME/.signet/downloads}"
RELEASES_API_BASE="${SIGNET_RELEASES_API_BASE:-https://api.github.com/repos/${REPO}/releases}"
RELEASES_DOWNLOAD_BASE="${SIGNET_RELEASES_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}"

if command -v curl >/dev/null 2>&1; then
	DOWNLOAD=(curl -fsSL)
elif command -v wget >/dev/null 2>&1; then
	DOWNLOAD=(wget -q -O -)
else
	echo "curl or wget is required" >&2
	exit 1
fi

download_to() {
	local url="$1"
	local out="$2"
	if [ "${DOWNLOAD[0]}" = "curl" ]; then
		curl -fsSL -o "$out" "$url"
	else
		wget -q -O "$out" "$url"
	fi
}

download_text() {
	local url="$1"
	"${DOWNLOAD[@]}" "$url"
}

resolve_download_base() {
	if [ -n "${SIGNET_DOWNLOAD_BASE:-}" ]; then
		printf '%s\n' "$SIGNET_DOWNLOAD_BASE"
		return
	fi
	if [ -n "${SIGNET_RELEASE_TAG:-}" ]; then
		printf '%s/%s\n' "$RELEASES_DOWNLOAD_BASE" "$SIGNET_RELEASE_TAG"
		return
	fi
	if [ -n "${SIGNET_VERSION:-}" ]; then
		printf '%s/v%s\n' "$RELEASES_DOWNLOAD_BASE" "$SIGNET_VERSION"
		return
	fi

	local releases_json
	local release_tag
	releases_json="$(download_text "$RELEASES_API_BASE")"
	if command -v jq >/dev/null 2>&1; then
		release_tag="$(printf '%s' "$releases_json" | jq -r '[.[] | select(.draft | not)][0].tag_name // empty')"
	else
		release_tag="$(printf '%s\n' "$releases_json" | tr '{' '\n' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	fi
	if [ -z "$release_tag" ]; then
		echo "Could not resolve latest Signet release, including prereleases" >&2
		exit 1
	fi
	printf '%s/%s\n' "$RELEASES_DOWNLOAD_BASE" "$release_tag"
}

case "$(uname -s)" in
	Darwin) os="darwin" ;;
	Linux) os="linux" ;;
	MINGW* | MSYS* | CYGWIN*) os="win32" ;;
	*) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
	x86_64 | amd64) cpu="x64" ;;
	arm64 | aarch64) cpu="arm64" ;;
	*) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$os" = "darwin" ] && [ "$cpu" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
	cpu="arm64"
fi

platform="${os}-${cpu}"
case "$platform" in
	linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | win32-x64) ;;
	*) echo "Unsupported platform: $platform. Published Signet native binaries: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64" >&2; exit 1 ;;
esac
asset="signet-${platform}"
[ "$os" = "win32" ] && asset="${asset}.exe"

mkdir -p "$DOWNLOAD_DIR"
DOWNLOAD_BASE="$(resolve_download_base)"
manifest_path="$DOWNLOAD_DIR/native-manifest.json"
binary_path="$DOWNLOAD_DIR/$asset"

download_to "$DOWNLOAD_BASE/native-manifest.json" "$manifest_path"

checksum=""
if command -v jq >/dev/null 2>&1; then
	checksum="$(jq -r --arg platform "$platform" '.assets[] | select(.platform == $platform) | .sha256' "$manifest_path")"
else
	manifest="$(tr -d '\n\r\t' < "$manifest_path" | sed 's/ \+/ /g')"
	if [[ $manifest =~ \"platform\"[[:space:]]*:[[:space:]]*\"$platform\"[^}]*\"sha256\"[[:space:]]*:[[:space:]]*\"([a-f0-9]{64})\" ]]; then
		checksum="${BASH_REMATCH[1]}"
	fi
fi

if [ -z "$checksum" ] || [[ ! "$checksum" =~ ^[a-f0-9]{64}$ ]]; then
	echo "No Signet native binary found for $platform in manifest" >&2
	exit 1
fi

download_to "$DOWNLOAD_BASE/$asset" "$binary_path"

if command -v sha256sum >/dev/null 2>&1; then
	actual="$(sha256sum "$binary_path" | awk '{print $1}')"
else
	actual="$(shasum -a 256 "$binary_path" | awk '{print $1}')"
fi

if [ "$actual" != "$checksum" ]; then
	echo "Checksum verification failed for $asset" >&2
	rm -f "$binary_path"
	exit 1
fi

chmod +x "$binary_path"
"$binary_path" install "$@"
rm -f "$binary_path"
