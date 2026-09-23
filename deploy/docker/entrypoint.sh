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

# The fresh Rust daemon creates and migrates memory/memories.db through its
# owner boundary. The entrypoint must not open SQLite with Bun or another
# client-side runtime before the daemon starts.


# seed default workspace scripts/skills for fresh volumes
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
