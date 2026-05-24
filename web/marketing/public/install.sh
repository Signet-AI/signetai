#!/usr/bin/env bash
set -euo pipefail

# Signet public installer shim.
# The release-hosted native bundle installer is the source of truth for
# platform detection, checksums, lock handling, setup, and daemon startup.

INSTALLER_URL="https://github.com/Signet-AI/signetai/releases/download/bundle-latest/install.sh"

if ! command -v curl >/dev/null 2>&1; then
  printf 'Signet installer requires curl. Install curl and re-run this command.\n' >&2
  exit 1
fi

curl -fsSL "$INSTALLER_URL" | bash
