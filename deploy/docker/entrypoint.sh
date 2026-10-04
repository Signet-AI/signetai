#!/bin/sh
set -eu

root="${SIGNET_PATH:-/data/agents}"
cfg="$root/agent.yaml"

if [ ! -f "$cfg" ]; then
	mkdir -p "$root"
	cat > "$cfg" <<'YAML'
auth:
  mode: team
YAML
	printf '%s\n' "[docker] wrote default auth.mode=team to $cfg"
fi
layout="$root/workspace-layout.json"
if [ ! -f "$layout" ] && [ ! -f "$root/memory/memories.db" ]; then
	printf '{\n  "version": 2\n}\n' > "$layout"
	printf '%s\n' "[docker] created workspace layout v2 at $layout"
fi
if grep -Eq '"version"[[:space:]]*:[[:space:]]*2' "$layout" 2>/dev/null; then
	db="$root/data/signet.db"
else
	db="$root/memory/memories.db"
fi
if [ ! -f "$db" ] && ! grep -q '"database"' "$layout" 2>/dev/null; then
	mkdir -p "$(dirname "$db")"
	bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); db.close();' "$db"
	printf '%s\n' "[docker] initialized workspace database at $db"
fi

tpl="/app/dist/signetai/templates"

if [ -d "$tpl/scripts" ] && [ ! -d "$root/scripts" ]; then
	mkdir -p "$root/scripts"
	cp -R "$tpl/scripts/." "$root/scripts/"
fi

if [ -d "$tpl/skills" ] && [ ! -d "$root/skills" ]; then
	mkdir -p "$root/skills"
	cp -R "$tpl/skills/." "$root/skills/"
fi

exec /app/bin/signet
