import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	test("does not retry a non-transient 401", () => {
		const command = writeFakeCommand("echo 'HTTP 401: Bad credentials' >&2; exit 1");
		const result = runFakeCommand(command);

		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain("retrying");
	});
});
