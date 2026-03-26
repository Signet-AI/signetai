#!/bin/bash
# Forge installer from the Signet monorepo releases
# Usage: curl -sSL https://raw.githubusercontent.com/Signet-AI/signetai/main/packages/forge/install.sh | bash

set -euo pipefail

REPO="Signet-AI/signetai"
BINARY="forge"
TAG_PREFIX="forge-v"

echo "Forge Installer"
echo "==============="
echo ""

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Error: unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  darwin) PLATFORM="macos-${ARCH}" ;;
  linux) PLATFORM="linux-${ARCH}" ;;
  *) echo "Error: unsupported OS: $OS"; exit 1 ;;
esac

for cmd in curl tar; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not installed."
    exit 1
  fi
done

echo "Fetching latest Forge release..."
LATEST=$(
  curl -sSL "https://api.github.com/repos/${REPO}/releases?per_page=30" \
    | grep '"tag_name"' \
    | cut -d'"' -f4 \
    | grep "^${TAG_PREFIX}" \
    | head -1
)
if [ -z "$LATEST" ]; then
  echo "Error: failed to locate a Forge release tag in ${REPO}."
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${LATEST}/forge-${PLATFORM}.tar.gz"
echo "Installing Forge ${LATEST} for ${PLATFORM}..."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

HTTP_CODE=$(curl -sSL -w "%{http_code}" "$URL" -o "${TMP}/forge.tar.gz")
if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: download failed (HTTP ${HTTP_CODE})."
  echo "URL: ${URL}"
  exit 1
fi

tar xzf "${TMP}/forge.tar.gz" -C "$TMP"

if [ ! -f "${TMP}/${BINARY}" ]; then
  FOUND=$(find "$TMP" -name "$BINARY" -type f | head -1)
  if [ -z "$FOUND" ]; then
    echo "Error: '${BINARY}' not found in the downloaded archive."
    exit 1
  fi
  mv "$FOUND" "${TMP}/${BINARY}"
fi

if [ -d "$HOME/.cargo/bin" ]; then
  DEST="$HOME/.cargo/bin"
else
  DEST="$HOME/.local/bin"
  mkdir -p "$DEST"
fi

mv "${TMP}/${BINARY}" "${DEST}/${BINARY}"
chmod +x "${DEST}/${BINARY}"

echo ""
echo "Forge ${LATEST} installed to ${DEST}/${BINARY}"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$DEST"; then
  echo ""
  echo "Warning: ${DEST} is not in your PATH."
  echo "Add it to your shell profile:"
  echo "  export PATH=\"${DEST}:\$PATH\""
fi

echo ""
echo "Run 'forge' to get started."
