import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const retryScript = join(import.meta.dir, "retry-github-release.sh");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeFakeCommand(output: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-release-retry-test-"));
	tempDirs.push(dir);
	const command = join(dir, "fake-gh.sh");
	writeFileSync(command, `#!/usr/bin/env bash\n${output}\n`);
	chmodSync(command, 0o755);
	return command;
}

function runFakeCommand(command: string): ReturnType<typeof spawnSync> {
	return spawnSync("bash", [retryScript, command], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			RELEASE_API_RETRY_DELAY_SECONDS: "0",
		},
	});
}

describe("retry-github-release", () => {
	test("retries a transient 502 and succeeds", () => {
		const command = writeFakeCommand(
			'count=$(cat "$STATE" 2>/dev/null || printf 0); count=$((count + 1)); printf \'%s\' "$count" > "$STATE"; if [ "$count" -eq 1 ]; then echo \'HTTP 502: Server Error\' >&2; exit 1; fi; echo success',
		);
		const state = join(tempDirs[0], "state");
		const result = spawnSync("bash", [retryScript, command], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				STATE: state,
				RELEASE_API_RETRY_DELAY_SECONDS: "0",
			},
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("success");
		expect(result.stderr).toContain("retrying");
	});

	test("retries an HTTP 408 upload timeout and preserves upload arguments", () => {
		const command = writeFakeCommand(
			'printf "%s\\n" "$@" > "$ARGS"; count=$(cat "$STATE" 2>/dev/null || printf 0); count=$((count + 1)); printf "%s" "$count" > "$STATE"; if [ "$count" -lt 3 ]; then echo "HTTP 408: Upload body timed out due to inactivity" >&2; exit 1; fi; echo uploaded',
		);
		const state = join(tempDirs[0], "state");
		const args = join(tempDirs[0], "args");
		const uploadArgs = ["release", "upload", "v0.0.0", "Signet fixture.dmg", "--clobber", "--repo", "owner/repo"];
		const result = spawnSync("bash", [retryScript, command, ...uploadArgs], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, STATE: state, ARGS: args, RELEASE_API_RETRY_DELAY_SECONDS: "0" },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("uploaded");
		expect(readFileSync(state, "utf8")).toBe("3");
		expect(readFileSync(args, "utf8").trim().split("\n")).toEqual(uploadArgs);
	});

	test("stops after three persistent HTTP 408 upload failures", () => {
		const command = writeFakeCommand(
			'count=$(cat "$STATE" 2>/dev/null || printf 0); count=$((count + 1)); printf "%s" "$count" > "$STATE"; echo "HTTP 408: Upload body timed out due to inactivity" >&2; exit 7',
		);
		const state = join(tempDirs[0], "state");
		const result = spawnSync("bash", [retryScript, command], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, STATE: state, RELEASE_API_RETRY_DELAY_SECONDS: "0" },
		});
		expect(result.status).toBe(7);
		expect(readFileSync(state, "utf8")).toBe("3");
	});

	test("does not retry a 4xx response whose body contains timeout", () => {
		const command = writeFakeCommand("echo 'HTTP 400: request timeout is invalid' >&2; exit 1");
		const result = runFakeCommand(command);

		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain("retrying");
	});

	test("does not retry a non-transient 401", () => {
		const command = writeFakeCommand("echo 'HTTP 401: Bad credentials' >&2; exit 1");
		const result = runFakeCommand(command);

		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain("retrying");
	});
});
