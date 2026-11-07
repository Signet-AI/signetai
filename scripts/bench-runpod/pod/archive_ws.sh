#!/usr/bin/env bash
set -u
source /workspace/kit/pod/env.sh
run=$1; ws=$WS_ROOT/$run-ws
[ -d "$ws" ] || { echo "no workspace $ws"; exit 0; }
[ "$ws" = "/workspace/runs/$run-ws" ] && { echo "$ws already on the volume"; exit 0; }
exec 7> /root/.archive_$run.lock
flock -w 3600 7 || { echo "another archive of $run is still running"; exit 1; }
out=/workspace/evidence/${run}_ws.tgz
rm -f "$out".tmp.*
tmp=$out.tmp.$$
stage=$(mktemp -d /root/.archive.XXXX)
trap 'rm -rf "$stage" "$tmp"' EXIT
trap 'exit 1' TERM INT HUP
tar cf - -C "$WS_ROOT" --exclude='signet.db' --exclude='signet.db-wal' --exclude='signet.db-shm' "$run-ws" | tar xf - -C "$stage" || exit 1
db=$ws/agents/data/signet.db
if [ -f "$db" ]; then
  mkdir -p "$stage/$run-ws/agents/data"
  python3 -c "
import sqlite3,sys
s=sqlite3.connect('file:$db?mode=ro',uri=True,timeout=120); d=sqlite3.connect('$stage/$run-ws/agents/data/signet.db')
s.backup(d); d.close()" || exit 1
fi
tar czf "$tmp" -C "$stage" "$run-ws" && gzip -t "$tmp" && mv "$tmp" "$out" || { rm -f "$tmp"; echo "archive of $ws failed"; exit 1; }
echo "archived $ws -> $out ($(du -h "$out" | cut -f1))"
