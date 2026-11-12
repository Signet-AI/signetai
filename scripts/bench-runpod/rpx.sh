#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [ -n "${RUNPOD_API_KEY:-}" ]; then exec python3 "$here/rp.py" "$@"; fi
out=$(signet secret exec --secret RUNPOD_API_KEY -- python3 "$here/rp.py" "$@" 2>&1)
id=$(printf '%s\n' "$out" | sed -n 's/^Secret exec queued: //p')
if [ -z "$id" ]; then printf '%s\n' "$out"; exit 1; fi
for _ in $(seq 1 180); do
  st=$(signet secret exec-status "$id" 2>&1 || true)
  if ! printf '%s\n' "$st" | head -1 | grep -q 'running\|queued\|pending'; then
    printf '%s\n' "$st" | sed '1{/^Status: /d}'
    exit 0
  fi
  sleep 1
done
echo "timed out waiting for $id"; exit 1
