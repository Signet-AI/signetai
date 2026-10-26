#!/usr/bin/env bash
set -euo pipefail
HOST=${POD_HOST:?set POD_HOST}
src=${1:--}
if [ "$src" = "-" ]; then body=$(cat); else body=$(cat "$src"); fi
b64=$(printf '%s\n' "$body" | base64 -w 76)
tag="M$RANDOM$RANDOM"
{
  echo "stty -echo"
  echo "base64 -d > /tmp/pod_cmd_$tag.sh <<'__B64__'"
  printf '%s\n' "$b64"
  echo "__B64__"
  echo "echo __BEGIN_$tag; bash /tmp/pod_cmd_$tag.sh 2>&1; echo __END_${tag}_rc=\$?; rm -f /tmp/pod_cmd_$tag.sh; exit"
} | timeout "${POD_TIMEOUT:-600}" ssh -tt -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR -o ServerAliveInterval=30 -i "${SSH_KEY:-$HOME/.ssh/id_ed25519}" "$HOST@ssh.runpod.io" 2>&1 \
  | tr -d '\r' | awk -v b="__BEGIN_$tag" -v e="__END_$tag" 'f && (i = index($0, e)) > 0 { if (i > 1) print substr($0, 1, i - 1); print substr($0, i); f = 0; next } f { print } $0 == b { f = 1 }'
