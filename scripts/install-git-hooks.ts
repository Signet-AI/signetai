#!/usr/bin/env bun

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

interface GitResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

function runGit(args: readonly string[]): GitResult {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: ROOT,
		stderr: "pipe",
		stdout: "pipe",
	});
	const decoder = new TextDecoder();
	return {
		exitCode: result.exitCode,
		stderr: decoder.decode(result.stderr),
		stdout: decoder.decode(result.stdout),
	};
}

function describeFailure(result: GitResult): string {
	return result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.exitCode}`;
}

function main(): void {
	const repository = runGit(["rev-parse", "--show-toplevel"]);
	if (repository.exitCode !== 0) {
		console.log("Git repository not found; skipping hook installation.");
		return;
	}

	if (resolve(repository.stdout.trim()) !== ROOT) {
		throw new Error(`Git root is not ${ROOT}`);
	}

	const worktreeConfig = runGit(["config", "--get", "extensions.worktreeConfig"]);
	if (worktreeConfig.stdout.trim() !== "true") {
		const enable = runGit(["config", "extensions.worktreeConfig", "true"]);
		if (enable.exitCode !== 0) {
			throw new Error(`Could not enable worktree-local Git configuration: ${describeFailure(enable)}`);
		}
	}

	const hooks = runGit(["config", "--worktree", "core.hooksPath", ".githooks"]);
	if (hooks.exitCode !== 0) {
		throw new Error(`Could not configure the Git hooks path: ${describeFailure(hooks)}`);
	}

	console.log("Git hooks installed for this worktree: .githooks");
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
