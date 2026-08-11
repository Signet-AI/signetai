#!/usr/bin/env bash
set -eu
if (set -o pipefail) 2>/dev/null; then
	set -o pipefail
fi

REPO="${SIGNET_RELEASE_REPO:-Signet-AI/signetai}"
DOWNLOAD_DIR="${SIGNET_DOWNLOAD_DIR:-$HOME/.signet/downloads}"
RELEASES_API_BASE="${SIGNET_RELEASES_API_BASE:-https://api.github.com/repos/${REPO}/releases}"
RELEASES_DOWNLOAD_BASE="${SIGNET_RELEASES_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}"
LATEST_RELEASE_API="${SIGNET_LATEST_RELEASE_API:-${RELEASES_API_BASE}/latest}"
NIGHTLY_VERSION_API="${SIGNET_NIGHTLY_VERSION_API:-https://registry.npmjs.org/signetai/next}"
SIGNET_CHANNEL="${SIGNET_CHANNEL:-stable}"

case "$SIGNET_CHANNEL" in
	stable | nightly) ;;
	*)
		echo "SIGNET_CHANNEL must be stable or nightly" >&2
		exit 1
		;;
esac

if command -v curl >/dev/null 2>&1; then
	DOWNLOAD_COMMAND="curl"
elif command -v wget >/dev/null 2>&1; then
	DOWNLOAD_COMMAND="wget"
else
	echo "curl or wget is required" >&2
	exit 1
fi

download_to() {
	local url="$1"
	local out="$2"
	if [ "$DOWNLOAD_COMMAND" = "curl" ]; then
		curl -fsSL -o "$out" "$url"
	else
		wget -q -O "$out" "$url"
	fi
}

download_text() {
	local url="$1"
	if [ "$DOWNLOAD_COMMAND" = "curl" ]; then
		curl -fsSL "$url"
	else
		wget -q -O - "$url"
	fi
}

json_string() {
	local json="$1"
	local key="$2"
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$json" | jq -r --arg key "$key" '.[$key] // empty'
	else
		printf '%s' "$json" |
			tr -d '\n\r' |
			sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"
	fi
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
	local explicit_version="${SIGNET_VERSION:-${VERSION:-}}"
	if [ -n "$explicit_version" ]; then
		printf '%s/v%s\n' "$RELEASES_DOWNLOAD_BASE" "$explicit_version"
		return
	fi

	local release_tag
	if [ "$SIGNET_CHANNEL" = "stable" ]; then
		local release_json
		release_json="$(download_text "$LATEST_RELEASE_API")"
		release_tag="$(json_string "$release_json" "tag_name")"
	else
		local nightly_json
		local nightly_version
		nightly_json="$(download_text "$NIGHTLY_VERSION_API")"
		nightly_version="$(json_string "$nightly_json" "version")"
		release_tag="${nightly_version:+v${nightly_version}}"
	fi
	if [ -z "$release_tag" ]; then
		echo "Could not resolve latest Signet ${SIGNET_CHANNEL} release" >&2
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
	manifest="$(tr -d '\n\r	' < "$manifest_path" | sed 's/ \+/ /g')"
	checksum="$(printf '%s\n' "$manifest" | sed -n "s/.*\"platform\"[[:space:]]*:[[:space:]]*\"$platform\"[^}]*\"sha256\"[[:space:]]*:[[:space:]]*\"\([a-f0-9]\{64\}\)\".*/\1/p")"
fi

if [ -z "$checksum" ] || [ "${#checksum}" -ne 64 ]; then
	echo "No Signet native binary found for $platform in manifest" >&2
	exit 1
fi
case "$checksum" in
	*[!a-f0-9]*)
		echo "No Signet native binary found for $platform in manifest" >&2
		exit 1
		;;
esac

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

# Connector plugin assets. Newer releases ship a tarball listed under
# `components.connectors` in the manifest; older ones have no entry and
# we silently skip. The tarball is passed to `signet install` so the
# native command can extract it to the install location and point
# `SIGNET_DIR` at it.
connector_url=""
connector_sha=""
if command -v jq >/dev/null 2>&1; then
	connector_url="$(jq -r '.components.connectors.url // empty' "$manifest_path")"
	connector_sha="$(jq -r '.components.connectors.sha256 // empty' "$manifest_path")"
fi

connector_path=""
if [ -n "$connector_url" ] && [ -n "$connector_sha" ]; then
	# The wrapper exposes `connector_url` as a relative path; promote it
	# to a full GitHub release URL when only the basename was given.
	case "$connector_url" in
		http*) connector_full="$connector_url" ;;
		*)     connector_full="$DOWNLOAD_BASE/$connector_url" ;;
	esac
	connector_path="$DOWNLOAD_DIR/$(basename "$connector_full")"
	download_to "$connector_full" "$connector_path"
	actual_conn="$(sha256sum "$connector_path" 2>/dev/null | awk '{print $1}')"
	if [ -z "$actual_conn" ]; then
		actual_conn="$(shasum -a 256 "$connector_path" | awk '{print $1}')"
	fi
	if [ "$actual_conn" != "$connector_sha" ]; then
		echo "Checksum verification failed for $(basename "$connector_full")" >&2
		rm -f "$connector_path" "$binary_path"
		exit 1
	fi
fi

# `signet install` accepts a `--connector-assets <path>` flag so it can
# verify and extract the tarball next to the binary at its final
# install location. Older binaries without the flag ignore the unknown
# argument and continue working.
if [ -n "$connector_path" ]; then
	"$binary_path" install --force --connector-assets "$connector_path" "$@"
else
	"$binary_path" install --force "$@"
fi
rm -f "$binary_path"
if [ -n "$connector_path" ]; then
	rm -f "$connector_path"
fi
