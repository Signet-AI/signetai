#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 3 ]; then
	echo "usage: run.sh <run-name> <port> <signet-daemon-binary>" >&2
	exit 2
fi
RUN=$1
PORT=$2
if ! [[ $RUN =~ ^[A-Za-z0-9-]+$ && $PORT =~ ^[0-9]+$ && ${REPLAY_AGENT_ID:-default} =~ ^[A-Za-z0-9_-]+$ ]]; then
	echo "run name must be letters, digits, or dashes; port must be a number; REPLAY_AGENT_ID must be letters, digits, dashes, or underscores" >&2
	exit 2
fi
BIN=$(realpath "$3")
HERE=$(cd "$(dirname "$0")" && pwd)
AGENT_ID=${REPLAY_AGENT_ID:-default}
DIR=$(realpath -m "${REPLAY_DIR:-$HERE/runs}")
WS=$DIR/ws

if ss -tln | grep -q ":$PORT "; then
	echo "port $PORT is already in use" >&2
	exit 1
fi
for file in pristine.db agent.yaml workspace-layout.json transcripts.json; do
	[ -f "$DIR/$file" ] || { echo "missing $DIR/$file; run prepare.py first" >&2; exit 1; }
done

rm -rf "$WS" "$DIR/results-$RUN.jsonl"
mkdir -p "$WS/data" "$WS/runtime/plugins" "$WS/runtime/logs" "$DIR/home"
cp "$DIR/pristine.db" "$WS/data/signet.db"
cp "$DIR/agent.yaml" "$WS/agent.yaml"
cp "$DIR/workspace-layout.json" "$WS/workspace-layout.json"
[ -f "$DIR/plugin-registry.json" ] && cp "$DIR/plugin-registry.json" "$WS/runtime/plugins/registry-v1.json"

UNSET=()
for name in $(compgen -e); do
	case $name in SIGNET_* | HERMES_* | XDG_* | PI_* | OPENCODE_* | CLAUDE_* | CODEX_*) UNSET+=(-u "$name") ;; esac
done
SANDBOX=$DIR/home
env "${UNSET[@]}" HOME="$SANDBOX" XDG_CONFIG_HOME="$SANDBOX/.config" XDG_DATA_HOME="$SANDBOX/.local/share" \
	XDG_STATE_HOME="$SANDBOX/.local/state" XDG_CACHE_HOME="$SANDBOX/.cache" HERMES_HOME="$SANDBOX/.hermes" \
	SIGNET_DAEMON_ENTRYPOINT=1 SIGNET_PATH="$WS" SIGNET_PORT="$PORT" SIGNET_HOST=127.0.0.1 SIGNET_TELEMETRY_OPTOUT=1 \
	setsid "$BIN" > "$DIR/daemon-$RUN.log" 2>&1 &
DAEMON=$!
stop() {
	kill -TERM -- "-$DAEMON" 2>/dev/null || return 0
	for _ in $(seq 1 30); do
		kill -0 -- "-$DAEMON" 2>/dev/null || break
		sleep 1
	done
	kill -KILL -- "-$DAEMON" 2>/dev/null || true
	wait "$DAEMON" 2>/dev/null || true
	while kill -0 -- "-$DAEMON" 2>/dev/null; do sleep 1; done
}
trap stop EXIT

for _ in $(seq 1 120); do
	curl -s -m 2 "127.0.0.1:$PORT/health" | grep -q '"healthy"' && break
	sleep 2
done
curl -s "127.0.0.1:$PORT/health" | python3 -c "import json,sys;d=json.load(sys.stdin);print('health',d['status'],d['agentsDir'])"
LOG=$(ls -t "$WS"/runtime/logs/signet-*.log | head -1)

for _ in $(seq 1 180); do
	if grep -a -q "Global integrity check passed" "$LOG"; then
		LAST=$(grep -a "Incremental database integrity progress" "$LOG" | tail -1 | python3 -c "import sys,json,datetime;l=sys.stdin.read().strip();print(datetime.datetime.fromisoformat(json.loads(l)['timestamp'].replace('Z','+00:00')).timestamp() if l else 0)")
		python3 -c "import time,sys;sys.exit(0 if time.time()-float('$LAST')>20 else 1)" && break
	fi
	sleep 5
done
echo "startup maintenance settled"

curl -s -X POST "127.0.0.1:$PORT/api/memory/recall" -H 'content-type: application/json' \
	-d "{\"query\":\"warm up the embedder and reranker\",\"agentId\":\"$AGENT_ID\",\"limit\":5}" > /dev/null
sleep 2
grep -a -o '"Cross-encoder ready","data":{[^}]*}' "$LOG" | tail -1 || echo "no cross-encoder line in the daemon log"

for session in $(python3 -c "import json,sys;print(' '.join(json.load(open(sys.argv[1]))))" "$DIR/transcripts.json"); do
	harness=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]]['harness'])" "$DIR/transcripts.json" "$session")
	case $harness in
		pi | opencode) REPLAY_DIR="$DIR" REPLAY_AGENT_ID="$AGENT_ID" REAL_HOME="$HOME" timeout 300 bun "$HERE/drive.ts" "$RUN" "$PORT" "$session" 2>&1 | tail -1 ;;
		*) timeout 400 python3 "$HERE/drive.py" "$RUN" "$PORT" "$session" --dir "$DIR" --agent-id "$AGENT_ID" 2>&1 | tail -1 ;;
	esac
done
[ -n "${PROBE:-}" ] && python3 "$HERE/probe.py" "$RUN" "$PORT" --dir "$DIR" --agent-id "$AGENT_ID" 2>&1 | tail -1

stop
trap - EXIT
cat $(ls -tr "$WS"/runtime/logs/signet-*.log) > "$DIR/daemon-log-$RUN.ndjson"
sqlite3 -readonly -json "$WS/data/signet.db" "SELECT session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, created_at FROM session_recall_events WHERE session_key LIKE '$RUN-%'" > "$DIR/ledger-$RUN.json"
rm -rf "$WS"
echo "$RUN finished: $(wc -l < "$DIR/results-$RUN.jsonl") records"
