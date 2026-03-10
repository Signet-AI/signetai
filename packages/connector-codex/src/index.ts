import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";

const SHELL_BLOCK_START = "# >>> signet codex >>>";
const SHELL_BLOCK_END = "# <<< signet codex <<<";
const SHELL_BLOCK = `${SHELL_BLOCK_START}
if [ -d "$HOME/.config/signet/bin" ]; then
	case ":$PATH:" in
		*":$HOME/.config/signet/bin:"*) ;;
		*) export PATH="$HOME/.config/signet/bin:$PATH" ;;
	esac
fi
${SHELL_BLOCK_END}
`;

function stripBlock(content: string): string {
	const start = content.indexOf(SHELL_BLOCK_START);
	if (start < 0) return content;
	const end = content.indexOf(SHELL_BLOCK_END, start);
	if (end < 0) return content;
	const after = content.slice(end + SHELL_BLOCK_END.length);
	const before = content.slice(0, start).trimEnd();
	return `${before}${before ? "\n\n" : ""}${after.trimStart()}`.trimEnd() + "\n";
}

function appendBlock(content: string): string {
	const stripped = stripBlock(content).trimEnd();
	return `${stripped}${stripped ? "\n\n" : ""}${SHELL_BLOCK}`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildWrapper(realCodexBin: string): string {
	return `#!/bin/sh
set -eu

REAL_CODEX_BIN=${shellSingleQuote(realCodexBin)}
SIGNET_BIN="\${SIGNET_CODEX_SIGNET_BIN:-signet}"
SESSION_ROOT="\${HOME}/.codex/sessions"
TMP_ROOT="\${TMPDIR:-/tmp}/signet-codex-\$\$"
SESSION_KEY=""
START_MARKER=""
INSTRUCTIONS_FILE=""

cleanup() {
	rm -rf "$TMP_ROOT"
}

# Escape a string for embedding in a JSON value (backslash, double-quote, newlines)
json_escape() {
	printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/	/\\\\t/g' | tr '\\n' ' '
}

session_start() {
	mkdir -p "$TMP_ROOT"
	START_MARKER="$TMP_ROOT/start.marker"
	INSTRUCTIONS_FILE="$TMP_ROOT/model-instructions.md"
	: > "$START_MARKER"
	SESSION_KEY="$(uuidgen 2>/dev/null || printf "codex-%s-%s" "$(date +%s)" "$$")"

	payload="$(printf '{"session_id":"%s","cwd":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$PWD")")"
	if printf "%s" "$payload" | "$SIGNET_BIN" hook session-start -H codex --project "$PWD" > "$INSTRUCTIONS_FILE" 2>/dev/null; then
		if [ ! -s "$INSTRUCTIONS_FILE" ]; then
			rm -f "$INSTRUCTIONS_FILE"
			INSTRUCTIONS_FILE=""
		fi
	else
		rm -f "$INSTRUCTIONS_FILE"
		INSTRUCTIONS_FILE=""
	fi
}

find_session_file() {
	if [ ! -d "$SESSION_ROOT" ] || [ -z "$START_MARKER" ] || [ ! -f "$START_MARKER" ]; then
		return 0
	fi

	find "$SESSION_ROOT" -type f -name '*.jsonl' -newer "$START_MARKER" 2>/dev/null | sort | tail -n 1
}

session_end() {
	if [ -z "$SESSION_KEY" ]; then
		return 0
	fi

	TRANSCRIPT_PATH="$(find_session_file)"
	payload="$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$TRANSCRIPT_PATH")" "$(json_escape "$PWD")")"
	printf "%s" "$payload" | "$SIGNET_BIN" hook session-end -H codex >/dev/null 2>&1 || true
}

if [ "\${SIGNET_NO_HOOKS:-}" = "1" ] || [ "\${SIGNET_CODEX_BYPASS_WRAPPER:-}" = "1" ]; then
	exec "$REAL_CODEX_BIN" "$@"
fi

if [ ! -x "$REAL_CODEX_BIN" ]; then
	echo "[signet] codex wrapper could not find real binary at $REAL_CODEX_BIN" >&2
	exit 1
fi

trap 'cleanup' EXIT

session_start

set +e
if [ -n "$INSTRUCTIONS_FILE" ]; then
	"$REAL_CODEX_BIN" -c "model_instructions_file=$INSTRUCTIONS_FILE" "$@"
else
	"$REAL_CODEX_BIN" "$@"
fi
EXIT_CODE=$?
set -e

session_end
exit "$EXIT_CODE"
`;
}

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	private getCodexHome(): string {
		return join(homedir(), ".codex");
	}

	private getWrapperDir(): string {
		return join(homedir(), ".config", "signet", "bin");
	}

	private getWrapperPath(): string {
		return join(this.getWrapperDir(), "codex");
	}

	private getShellConfigPaths(): string[] {
		return [join(homedir(), ".zshrc"), join(homedir(), ".bashrc"), join(homedir(), ".bash_profile")];
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	private resolveRealCodexBin(): string | null {
		const wrapperPath = this.getWrapperPath();
		const proc = Bun.spawnSync(["which", "-a", "codex"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) return null;

		const candidates = proc.stdout
			.toString()
			.split(/\r?\n/)
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0);

		for (const candidate of candidates) {
			if (candidate !== wrapperPath) return candidate;
		}
		return null;
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];

		const realCodexBin = this.resolveRealCodexBin();
		if (!realCodexBin) {
			throw new Error("Could not find Codex CLI on PATH");
		}

		const wrapperDir = this.getWrapperDir();
		mkdirSync(wrapperDir, { recursive: true });

		const wrapperPath = this.getWrapperPath();
		writeFileSync(wrapperPath, buildWrapper(realCodexBin), { mode: 0o755 });
		filesWritten.push(wrapperPath);

		for (const shellPath of this.getShellConfigPaths()) {
			const existing = existsSync(shellPath) ? readFileSync(shellPath, "utf-8") : "";
			const next = appendBlock(existing);
			if (next !== existing) {
				writeFileSync(shellPath, next);
				configsPatched.push(shellPath);
			}
		}

		return {
			success: true,
			message: "Codex integration installed successfully",
			filesWritten,
			configsPatched,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		const wrapperPath = this.getWrapperPath();
		if (existsSync(wrapperPath)) {
			rmSync(wrapperPath, { force: true });
			filesRemoved.push(wrapperPath);
		}

		for (const shellPath of this.getShellConfigPaths()) {
			if (!existsSync(shellPath)) continue;
			const existing = readFileSync(shellPath, "utf-8");
			const next = stripBlock(existing);
			if (next !== existing) {
				writeFileSync(shellPath, next);
				configsPatched.push(shellPath);
			}
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		if (!existsSync(this.getWrapperPath())) return false;
		return this.getShellConfigPaths().some((shellPath) => {
			if (!existsSync(shellPath)) return false;
			try {
				return readFileSync(shellPath, "utf-8").includes(SHELL_BLOCK_START);
			} catch {
				return false;
			}
		});
	}
}
