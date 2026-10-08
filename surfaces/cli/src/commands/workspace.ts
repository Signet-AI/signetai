import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
	chooseWorkspaceCandidate,
	getWorkspaceStatus,
	listWorkspaceCandidates,
	setWorkspacePath,
} from "../features/workspace.js";
import { normalizeWorkspacePath } from "../lib/workspace.js";

interface WorkspaceDeps {
	readonly signetLogo: () => string;
}

export function registerWorkspaceCommands(program: Command, deps: WorkspaceDeps): void {
	const workspaceCmd = program.command("workspace").description("Manage the default Signet workspace location");

	workspaceCmd
		.command("status")
		.description("Show the effective workspace and where it comes from")
		.action(() => {
			console.log(deps.signetLogo());
			const status = getWorkspaceStatus();
			console.log(chalk.bold("  Workspace status\n"));
			console.log(chalk.dim(`  Active:  ${status.path}`));
			console.log(chalk.dim(`  State:   ${status.status}`));
			console.log(chalk.dim(`  Source:  ${status.source}`));
			console.log(chalk.dim(`  Config:  ${status.configPath}`));
			if (status.configuredPath) {
				console.log(chalk.dim(`  Stored:  ${status.configuredPath}`));
			}
			for (const reason of status.reasons) console.log(chalk.yellow(`  Note:    ${reason}`));
			console.log();
		});

	workspaceCmd
		.command("set [path]")
		.description("Set the default Signet workspace path")
		.option("--force", "Overwrite conflicting files in destination during migration", false)
		.option("--no-patch-openclaw", "Do not patch discovered OpenClaw-family configs")
		.action(async (path: string | undefined, options: { force?: boolean; patchOpenclaw?: boolean }) => {
			console.log(deps.signetLogo());
			const status = getWorkspaceStatus();
			let spinner: ReturnType<typeof ora> | null = null;
			try {
				const target = path ? normalizeWorkspacePath(path) : await pickWorkspace(status.path);
				spinner = ora("Updating workspace...").start();
				const result = await setWorkspacePath(target, {
					currentPath: status.path,
					force: options.force === true,
					patchOpenClaw: options.patchOpenclaw !== false,
				});
				spinner.succeed("Workspace updated");
				console.log(chalk.dim(`  Previous: ${result.previousPath}`));
				console.log(chalk.dim(`  Active:   ${result.nextPath}`));
				console.log(chalk.dim(`  Config:   ${result.configPath}`));
				if (result.migrated) {
					console.log(chalk.dim(`  Migrated: ${result.copiedFiles} copied, ${result.overwrittenFiles} overwritten`));
				}
				if (options.patchOpenclaw !== false) {
					console.log(chalk.dim(`  OpenClaw configs patched: ${result.patchedConfigs.length}`));
				}
				if (result.changed) {
					console.log(chalk.dim("  Restart the daemon to apply this workspace to active runtime processes."));
				}
				console.log();
			} catch (err) {
				if (spinner) {
					spinner.fail("Workspace update failed");
				}
				const msg = err instanceof Error ? err.message : String(err);
				console.error(chalk.red(`  Workspace update failed: ${msg}`));
				process.exit(1);
			}
		});
}

async function pickWorkspace(currentPath: string): Promise<string> {
	const fallback = chooseWorkspaceCandidate(currentPath);
	if (!process.stdout.isTTY) {
		throw new Error("workspace path is required in non-interactive mode");
	}

	const ranked = listWorkspaceCandidates(currentPath).slice(0, 8);
	if (ranked.length === 0) {
		return fallback;
	}

	const choices = ranked.map((candidate) => ({
		value: candidate.path,
		name: candidate.source === "detected" ? `${candidate.path} (detected)` : `${candidate.path} (preset)`,
	}));
	choices.push({ value: "__custom__", name: "Custom path..." });

	const picked = await select({
		message: "Select a workspace path:",
		choices,
		default: ranked[0].path,
	});
	if (picked !== "__custom__") {
		return picked;
	}

	const typed = await input({
		message: "Workspace path:",
		default: fallback,
	});
	return normalizeWorkspacePath(typed);
}
