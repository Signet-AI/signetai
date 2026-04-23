import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readGraphiqState } from "@signet/core";

export interface GraphiqCommandResult {
	readonly activeProject: string;
	readonly stdout: string;
	readonly stderr: string;
}

export function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

export function getActiveGraphiqDbPath(): { readonly activeProject: string; readonly dbPath: string } | null {
	const state = readGraphiqState(getAgentsDir());
	if (!state.enabled || !state.activeProject) return null;
	const project = state.indexedProjects.find((entry) => entry.path === state.activeProject);
	if (!project?.dbPath) return null;
	return { activeProject: state.activeProject, dbPath: project.dbPath };
}

export async function runGraphiqCli(args: readonly string[], timeoutMs = 15_000): Promise<GraphiqCommandResult> {
	const active = getActiveGraphiqDbPath();
	if (!active) {
		throw new Error("GraphIQ has no active indexed project. Run `signet index <path>` first.");
	}
	if (!existsSync(active.dbPath)) {
		throw new Error(`GraphIQ database not found for active project: ${active.dbPath}`);
	}

	const result = await runCommand("graphiq", [...args, "--db", active.dbPath], timeoutMs);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `graphiq exited with code ${result.code}`);
	}
	return {
		activeProject: active.activeProject,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export function runCommand(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolveResult) => {
		const proc = spawn(command, [...args], { stdio: "pipe", windowsHide: true });
		const hardKillGraceMs = Math.min(1_000, Math.max(100, Math.floor(timeoutMs / 4)));
		let settled = false;
		let stdout = "";
		let stderr = "";
		let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
		let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

		const clearTimers = () => {
			clearTimeout(timer);
			if (hardKillTimer) clearTimeout(hardKillTimer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
		};
		const resolveOnce = (result: { readonly code: number; readonly stdout: string; readonly stderr: string }) => {
			if (settled) return;
			settled = true;
			clearTimers();
			resolveResult(result);
		};
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			stderr += `Timed out after ${timeoutMs}ms`;
			hardKillTimer = setTimeout(() => {
				if (settled) return;
				stderr += `; force killed after ${hardKillGraceMs}ms`;
				proc.kill("SIGKILL");
				fallbackTimer = setTimeout(() => {
					resolveOnce({ code: 1, stdout, stderr });
				}, hardKillGraceMs);
			}, hardKillGraceMs);
		}, timeoutMs);
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (err) => {
			resolveOnce({ code: 1, stdout, stderr: `${stderr}${err.message}` });
		});
		proc.on("close", (code) => {
			resolveOnce({ code: code ?? 1, stdout, stderr });
		});
	});
}
