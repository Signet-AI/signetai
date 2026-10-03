#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  printf 'Usage: %s <smoke-runner.ts> <resources-root> <bun-executable>\n' "$0" >&2
  exit 2
fi

smoke_runner=$1
resources_root=$2
bun_path=$3
for command in dbus-run-session gnome-keyring-daemon busctl mktemp; do
  command -v "$command" >/dev/null || { printf 'Required command not found: %s\n' "$command" >&2; exit 1; }
done
test -x "$bun_path" || { printf 'Bun executable not found: %s\n' "$bun_path" >&2; exit 1; }

exec dbus-run-session -- bash -euo pipefail -c '
  smoke_runner=$1
  resources_root=$2
  bun_path=$3
  keyring_home=$(mktemp -d "${TMPDIR:-/tmp}/signet-keyring-XXXXXX")
  keyring_pid=""
  cleanup() {
    if [[ -n "$keyring_pid" ]]; then
      kill "$keyring_pid" 2>/dev/null || true
      wait "$keyring_pid" 2>/dev/null || true
    fi
    rm -rf "$keyring_home"
  }
  trap cleanup EXIT

  export HOME="$keyring_home"
  export XDG_DATA_HOME="$keyring_home/.local/share"
  export XDG_RUNTIME_DIR="$keyring_home/run"
  mkdir -p "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  unset GNOME_KEYRING_CONTROL GNOME_KEYRING_PID SSH_AUTH_SOCK

  gnome-keyring-daemon --foreground --components=secrets --control-directory="$XDG_RUNTIME_DIR/keyring" >"$keyring_home/keyring.log" 2>&1 &
  keyring_pid=$!

  ready=0
  for _ in $(seq 1 100); do
    if busctl --user get-property org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service Collections >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" != 1 ]]; then
    printf "Private Secret Service did not become ready\\n" >&2
    cat "$keyring_home/keyring.log" >&2
    exit 1
  fi
  busctl --user call org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service SetAlias so default /org/freedesktop/secrets/collection/session

  "$bun_path" "$smoke_runner" --resources-root "$resources_root"
' private-keyring-smoke "$smoke_runner" "$resources_root" "$bun_path"
