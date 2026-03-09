/**
 * Process spawning for scheduled task execution.
 * Uses Bun.spawn to run Claude Code or OpenCode CLI processes.
 */

import type { TaskHarness } from "@signet/core";
import { spawn as nodeSpawn } from "node:child_process";
import { logger } from "../logger";

const MAX_OUTPUT_CHARS = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface SpawnHooks {
	readonly onStdoutChunk?: (chunk: string) => void;
	readonly onStderrChunk?: (chunk: string) => void;
}

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
	model?: string,
): readonly [string, ReadonlyArray<string>] {
	switch (harness) {
		case "claude-code":
			return ["claude", ["--dangerously-skip-permissions", "-p", prompt]];
		case "codex": {
			const args = ["exec", "--skip-git-repo-check", "--json"];
			if (model) {
				args.push("--model", model);
			}
			args.push(prompt);
			return ["codex", args];
		}
		case "opencode":
			return ["opencode", ["run", "--format", "json", prompt]];
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
	hooks?: SpawnHooks,
	model?: string,
): Promise<SpawnResult> {
	const [bin, args] = buildCommand(harness, prompt, model);
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

	// Strip CLAUDECODE to avoid nested-session detection, and strip
	// SIGNET_NO_HOOKS sentinel before re-injecting to prevent hook loops
	const { CLAUDECODE: _cc, SIGNET_NO_HOOKS: _, ...baseEnv } = process.env;

	const child = nodeSpawn(resolvedBin, args, {
		cwd: workingDirectory ?? undefined,
		stdio: "pipe",
		windowsHide: true,
		env: { ...baseEnv, SIGNET_NO_HOOKS: "1" } as NodeJS.ProcessEnv,
	});

	const procStdout = new ReadableStream<Uint8Array>({
		start(controller) {
			child.stdout?.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			child.stdout?.on("end", () => { try { controller.close(); } catch {} });
			child.stdout?.on("error", (err) => { try { controller.error(err); } catch {} });
		},
	});
	const procStderr = new ReadableStream<Uint8Array>({
		start(controller) {
			child.stderr?.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			child.stderr?.on("end", () => { try { controller.close(); } catch {} });
			child.stderr?.on("error", (err) => { try { controller.error(err); } catch {} });
		},
	});
	const procExited = new Promise<number>((resolve) => {
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		// Force kill after 5s if still alive
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already dead
			}
		}, 5000);
	}, timeoutMs);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readProcessStream(procStdout, hooks?.onStdoutChunk),
			readProcessStream(procStderr, hooks?.onStderrChunk),
			procExited,
		]);

		clearTimeout(timer);

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

async function readProcessStream(
	stream: ReadableStream<Uint8Array>,
	onChunk?: (chunk: string) => void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";

	while (true) {
		const result = await reader.read();
		if (result.done) break;

		const chunkText = decoder.decode(result.value, { stream: true });
		if (chunkText.length > 0) {
			onChunk?.(chunkText);
			if (output.length < MAX_OUTPUT_CHARS) {
				const remaining = MAX_OUTPUT_CHARS - output.length;
				output += chunkText.slice(0, remaining);
			}
		}
	}

	const tail = decoder.decode();
	if (tail.length > 0) {
		onChunk?.(tail);
		if (output.length < MAX_OUTPUT_CHARS) {
			const remaining = MAX_OUTPUT_CHARS - output.length;
			output += tail.slice(0, remaining);
		}
	}

	return output;
}
