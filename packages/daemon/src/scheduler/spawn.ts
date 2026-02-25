/**
 * Process spawning for scheduled task execution.
 * Uses Bun.spawn to run Claude Code or OpenCode CLI processes.
 */

import type { TaskHarness } from "@signet/core";
import { logger } from "../logger";

const MAX_OUTPUT_BYTES = 1_048_576; // 1MB
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface SpawnResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error: string | null;
	readonly timedOut: boolean;
}

function buildCommand(
	harness: TaskHarness,
	prompt: string,
): readonly [string, ReadonlyArray<string>] {
	switch (harness) {
		case "claude-code":
			return ["claude", ["--dangerously-skip-permissions", "-p", prompt]];
		case "opencode":
			return ["opencode", ["-m", prompt]];
	}
}

/** Check if the CLI binary for a harness is available on PATH. */
export function isHarnessAvailable(harness: TaskHarness): boolean {
	const [bin] = buildCommand(harness, "");
	return Bun.which(bin) !== null;
}

/** Spawn a CLI process for a scheduled task and capture output. */
export async function spawnTask(
	harness: TaskHarness,
	prompt: string,
	workingDirectory: string | null,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SpawnResult> {
	const [bin, args] = buildCommand(harness, prompt);
	const resolvedBin = Bun.which(bin);

	if (resolvedBin === null) {
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: `CLI binary "${bin}" not found on PATH`,
			timedOut: false,
		};
	}

	logger.info("scheduler", `Spawning ${harness}`, {
		bin: resolvedBin,
		cwd: workingDirectory,
	});

	// Strip existing sentinel and re-inject to prevent recursive hook loops
	const { SIGNET_NO_HOOKS: _, ...baseEnv } = process.env;

	const proc = Bun.spawn([resolvedBin, ...args], {
		cwd: workingDirectory ?? undefined,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...baseEnv, SIGNET_NO_HOOKS: "1" },
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		// Force kill after 5s if still alive
		setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// already dead
			}
		}, 5000);
	}, timeoutMs);

	try {
		const [stdoutBuf, stderrBuf] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).arrayBuffer(),
		]);

		const exitCode = await proc.exited;
		clearTimeout(timer);

		const stdout = new TextDecoder()
			.decode(stdoutBuf.slice(0, MAX_OUTPUT_BYTES));
		const stderr = new TextDecoder()
			.decode(stderrBuf.slice(0, MAX_OUTPUT_BYTES));

		return {
			exitCode,
			stdout,
			stderr,
			error: timedOut ? `Process timed out after ${timeoutMs}ms` : null,
			timedOut,
		};
	} catch (err) {
		clearTimeout(timer);
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: err instanceof Error ? err.message : String(err),
			timedOut,
		};
	}
}
