#!/usr/bin/env bash
set -euo pipefail
umask 077

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
ATTEMPT=$DIR/attempt-$RUN
FAILED=$DIR/failed-$RUN-$(date +%Y%m%dT%H%M%S)

mkdir -p "$DIR"
if [ "$(stat -c %u "$DIR")" != "$(id -u)" ] || (($(stat -c %#a "$DIR") & 077)); then
	echo "$DIR must be owned by you and closed to other users (chmod 700)" >&2
	exit 1
fi
for name in datasets home ws; do
	if [ -L "$DIR/$name" ]; then
		echo "$DIR/$name is a symlink; the harness writes there, so it must be a real directory" >&2
		exit 1
	fi
done
exec 9> "$DIR/.replay.lock"
if ! flock -n 9; then
	echo "another replay is using $DIR" >&2
	exit 1
fi

if ss -tln | grep -q ":$PORT "; then
	echo "port $PORT is already in use" >&2
	exit 1
fi
DATASET=$(realpath -e "$DIR/dataset" 2>/dev/null) || { echo "no prepared dataset in $DIR; run prepare.py first" >&2; exit 1; }
for file in manifest.json pristine.db agent.yaml workspace-layout.json transcripts.json; do
	[ -f "$DATASET/$file" ] || { echo "missing $DATASET/$file; run prepare.py again" >&2; exit 1; }
done

rm -rf "$WS" "$ATTEMPT"
mkdir -p "$WS/data" "$WS/runtime/plugins" "$WS/runtime/logs" "$DIR/home" "$ATTEMPT"
cp "$DATASET/manifest.json" "$DATASET/transcripts.json" "$ATTEMPT/"
cp "$DATASET/pristine.db" "$WS/data/signet.db"
cp "$DATASET/agent.yaml" "$WS/agent.yaml"
cp "$DATASET/workspace-layout.json" "$WS/workspace-layout.json"
[ -f "$DATASET/plugin-registry.json" ] && cp "$DATASET/plugin-registry.json" "$WS/runtime/plugins/registry-v1.json"

UNSET=()
for name in $(compgen -e); do
	case $name in SIGNET_* | HERMES_* | XDG_* | PI_* | OPENCODE_* | CLAUDE_* | CODEX_*) UNSET+=(-u "$name") ;; esac
done
SANDBOX=$DIR/home
env "${UNSET[@]}" HOME="$SANDBOX" XDG_CONFIG_HOME="$SANDBOX/.config" XDG_DATA_HOME="$SANDBOX/.local/share" \
	XDG_STATE_HOME="$SANDBOX/.local/state" XDG_CACHE_HOME="$SANDBOX/.cache" HERMES_HOME="$SANDBOX/.hermes" \
	SIGNET_DAEMON_ENTRYPOINT=1 SIGNET_PATH="$WS" SIGNET_PORT="$PORT" SIGNET_HOST=127.0.0.1 SIGNET_TELEMETRY_OPTOUT=1 \
	setsid "$BIN" > "$ATTEMPT/daemon-$RUN.log" 2>&1 9>&- &
DAEMON=$!
DRIVER=
step() {
	"$@" > "$ATTEMPT/step.log" 2>&1 &
	DRIVER=$!
	local status=0
	wait "$DRIVER" || status=$?
	DRIVER=
	tail -1 "$ATTEMPT/step.log"
	return "$status"
}
stop() {
	if [ -n "$DRIVER" ]; then
		kill -TERM "$DRIVER" 2>/dev/null || true
		wait "$DRIVER" 2>/dev/null || true
		DRIVER=
	fi
	kill -TERM -- "-$DAEMON" 2>/dev/null || return 0
	for _ in $(seq 1 30); do
		kill -0 -- "-$DAEMON" 2>/dev/null || break
		sleep 1
	done
	kill -KILL -- "-$DAEMON" 2>/dev/null || true
	wait "$DAEMON" 2>/dev/null || true
	while kill -0 -- "-$DAEMON" 2>/dev/null; do sleep 1; done
}
fail() {
	stop
	rm -rf "$WS"
	if [ -d "$ATTEMPT" ]; then
		mv "$ATTEMPT" "$FAILED"
		echo "$RUN did not finish; its partial output is in $FAILED" >&2
	fi
}
trap fail EXIT
trap "exit 143" TERM
trap "exit 130" INT
trap "exit 129" HUP

HEALTHY=
for _ in $(seq 1 120); do
	if curl -s -m 2 "127.0.0.1:$PORT/health" | grep -q '"healthy"'; then
		HEALTHY=1
		break
	fi
	sleep 2
done
if [ -z "$HEALTHY" ]; then
	echo "daemon did not report healthy within 4 minutes; see daemon-$RUN.log" >&2
	exit 1
fi
curl -s -m 10 "127.0.0.1:$PORT/health" | python3 -c "import json,sys;d=json.load(sys.stdin);print('health',d['status'],d['agentsDir'])"
LOG=$(ls -t "$WS"/runtime/logs/signet-*.log | head -1)

SETTLED=
for _ in $(seq 1 180); do
	status=0
	python3 "$HERE/settled.py" "$LOG" || status=$?
	case $status in
		0) SETTLED=1 && break ;;
		1) sleep 5 ;;
		*) break ;;
	esac
done
if [ -z "$SETTLED" ]; then
	echo "startup integrity checks did not finish cleanly within 15 minutes; see daemon-log-unsettled.log" >&2
	cp "$LOG" "$ATTEMPT/daemon-log-unsettled.log"
	exit 1
fi
echo "startup integrity checks finished"

curl -s -f -m 120 -X POST "127.0.0.1:$PORT/api/memory/recall" -H 'content-type: application/json' \
	-d "{\"query\":\"warm up the embedder and reranker\",\"agentId\":\"$AGENT_ID\",\"limit\":5}" > /dev/null
sleep 2
grep -a -o '"Cross-encoder ready","data":{[^}]*}' "$LOG" | tail -1 || echo "no cross-encoder line in the daemon log"

for session in $(python3 -c "import json,sys;print(' '.join(json.load(open(sys.argv[1]))))" "$ATTEMPT/transcripts.json"); do
	harness=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]]['harness'])" "$ATTEMPT/transcripts.json" "$session")
	case $harness in
		pi | opencode) step env REPLAY_DIR="$ATTEMPT" REPLAY_AGENT_ID="$AGENT_ID" REAL_HOME="$HOME" timeout 300 bun "$HERE/drive.ts" "$RUN" "$PORT" "$session" ;;
		*) step timeout 400 python3 "$HERE/drive.py" "$RUN" "$PORT" "$session" --dir "$ATTEMPT" --agent-id "$AGENT_ID" ;;
	esac
done
if [ -n "${PROBE:-}" ]; then
	step timeout 1800 python3 "$HERE/probe.py" "$RUN" "$PORT" --dir "$ATTEMPT" --agent-id "$AGENT_ID"
fi

stop
cat "$WS"/runtime/logs/signet-*.log > "$ATTEMPT/daemon-log-$RUN.ndjson"
sqlite3 -readonly -json "$WS/data/signet.db" "SELECT session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, created_at FROM session_recall_events WHERE session_key LIKE '$RUN-%'" > "$ATTEMPT/ledger-$RUN.json"
RECORDS=$(wc -l < "$ATTEMPT/results-$RUN.jsonl")
rm -rf "$WS" "$ATTEMPT/step.log"
python3 -c "import hashlib,json,sys;print(json.dumps({'run':sys.argv[1],'records':int(sys.argv[2]),'dataset':json.load(open(sys.argv[3]))['dataset'],'transcriptsSha256':hashlib.sha256(open(sys.argv[4],'rb').read()).hexdigest()}))" \
	"$RUN" "$RECORDS" "$ATTEMPT/manifest.json" "$ATTEMPT/transcripts.json" > "$ATTEMPT/complete.json"
rm -rf "$DIR/run-$RUN"
mv "$ATTEMPT" "$DIR/run-$RUN"
trap - EXIT TERM INT HUP
echo "$RUN finished: $RECORDS records in $DIR/run-$RUN"
