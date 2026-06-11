import { mergeSignetGitignoreEntries, SIGNET_GIT_PROTECTED_PATHS } from "@signet/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

export async function gitInit(dir: string): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["init"], { cwd: dir, stdio: "pipe", windowsHide: true });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

export async function gitAddAndCommit(dir: string, message: string): Promise<boolean> {
	ensureProtectedGitignore(dir);
	await gitUntrackProtectedFiles(dir);

	return new Promise((resolve) => {
		const add = spawn("git", ["add", "-A"], { cwd: dir, stdio: "pipe", windowsHide: true });
		add.on("close", (addCode) => {
			if (addCode !== 0) {
				resolve(false);
				return;
			}

			const status = spawn("git", ["status", "--porcelain"], {
				cwd: dir,
				stdio: "pipe",
				windowsHide: true,
			});
			let out = "";
			status.stdout?.on("data", (data) => {
				out += data.toString();
			});
			status.on("close", (statusCode) => {
				if (statusCode !== 0 || out.trim().length === 0) {
					resolve(true);
					return;
				}

				const commit = spawn("git", ["commit", "-m", message], {
					cwd: dir,
					stdio: "pipe",
					windowsHide: true,
				});
				commit.on("close", (code) => resolve(code === 0));
				commit.on("error", () => resolve(false));
			});
			status.on("error", () => resolve(false));
		});
		add.on("error", () => resolve(false));
	});
}

function ensureProtectedGitignore(dir: string): void {
	const path = join(dir, ".gitignore");
	const prev = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const next = mergeSignetGitignoreEntries(prev);
	if (next !== prev) {
		writeFileSync(path, next, "utf-8");
	}
}

async function gitUntrackProtectedFiles(dir: string): Promise<void> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["rm", "--cached", "--ignore-unmatch", "--quiet", "--", ...SIGNET_GIT_PROTECTED_PATHS], {
			cwd: dir,
			stdio: "pipe",
			windowsHide: true,
		});
		proc.on("close", () => resolve());
		proc.on("error", () => resolve());
	});
}
