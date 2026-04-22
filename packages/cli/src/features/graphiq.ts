import { spawn } from "node:child_process";
import { constants, accessSync, existsSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
	SIGNET_GRAPHIQ_PLUGIN_ID,
	disableGraphiqState,
	enableGraphiqState,
	getGraphiqProjectDbPath,
	readGraphiqState,
	updateGraphiqActiveProject,
} from "@signet/core";
import chalk from "chalk";
import ora from "ora";
import { readSetupCorePluginEnabled, writeSetupCorePluginRegistry } from "./setup-plugins.js";

export interface GraphiqDeps {
	readonly agentsDir: string;
}

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface GraphiqIndexOptions {
	readonly install?: boolean;
}

export interface GraphiqUninstallOptions {
	readonly purgeIndexes?: boolean;
}

type GraphiqInstallSource = "homebrew" | "source" | "existing";
const GRAPHIQ_SOURCE_REV = "156f31daf366e9b68d75bdaa4069058666ecc518";

export function hasCommand(command: string): boolean {
	const path = process.env.PATH ?? "";
	const candidates = path
		.split(delimiter)
		.filter((entry) => entry.length > 0)
		.map((entry) => join(entry, command));
	if (process.platform === "win32") {
		const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
		for (const candidate of candidates) {
			for (const extension of extensions) {
				if (isExecutable(`${candidate}${extension.toLowerCase()}`) || isExecutable(`${candidate}${extension}`)) {
					return true;
				}
			}
		}
		return false;
	}
	return candidates.some(isExecutable);
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function ensureGraphiqInstalled(options: {
	installIfMissing: boolean;
}): Promise<GraphiqInstallSource | null> {
	if (hasCommand("graphiq")) return "existing";
	if (!options.installIfMissing) return null;

	if (hasCommand("brew")) {
		const spinner = ora("Installing GraphIQ with Homebrew...").start();
		const tap = await runCommand("brew", ["tap", "aaf2tbz/graphiq"]);
		if (tap.code === 0 || tap.stderr.includes("already tapped")) {
			const install = await runCommand("brew", ["install", "graphiq"]);
			if (install.code === 0 && hasCommand("graphiq")) {
				spinner.succeed("GraphIQ installed");
				return "homebrew";
			}
			spinner.warn("Homebrew install failed; trying source fallback");
		} else {
			spinner.warn("Homebrew tap failed; trying source fallback");
		}
	} else {
		console.log(chalk.yellow("  Homebrew not found; trying source fallback."));
	}

	if (!hasCommand("cargo")) {
		console.log(chalk.red("  GraphIQ install failed: cargo is required for source fallback."));
		return null;
	}

	const spinner = ora("Installing GraphIQ from source...").start();
	const sourceArgs = ["install", "--git", "https://github.com/aaf2tbz/graphiq", "--rev", GRAPHIQ_SOURCE_REV];
	const cli = await runCommand("cargo", [...sourceArgs, "graphiq-cli"]);
	if (cli.code !== 0) {
		spinner.fail("GraphIQ source install failed");
		if (cli.stderr.trim()) console.error(chalk.dim(cli.stderr.trim()));
		return null;
	}
	const mcp = await runCommand("cargo", [...sourceArgs, "graphiq-mcp"]);
	if (mcp.code !== 0) {
		spinner.warn("GraphIQ CLI installed, but graphiq-mcp source install failed");
		if (mcp.stderr.trim()) console.error(chalk.dim(mcp.stderr.trim()));
	} else {
		spinner.succeed("GraphIQ installed from source");
	}
	return hasCommand("graphiq") ? "source" : null;
}

export async function installGraphiqPlugin(deps: GraphiqDeps): Promise<boolean> {
	const source = await ensureGraphiqInstalled({ installIfMissing: true });
	if (!source) {
		writeGraphiqPluginRegistryEnabled(deps.agentsDir, false);
		disableGraphiqState(deps.agentsDir);
		return false;
	}
	writeGraphiqPluginRegistryEnabled(deps.agentsDir, true);
	enableGraphiqState(deps.agentsDir, { installSource: source });
	console.log(chalk.green(`  GraphIQ plugin enabled (${source}).`));
	return true;
}

export async function indexWithGraphiq(
	projectPath: string,
	options: GraphiqIndexOptions,
	deps: GraphiqDeps,
): Promise<void> {
	const installSource = await ensureGraphiqInstalled({ installIfMissing: options.install !== false });
	if (!installSource) {
		console.error(chalk.red("GraphIQ is not installed."));
		console.error(chalk.dim("Run `brew tap aaf2tbz/graphiq && brew install graphiq`, or rerun without --no-install."));
		return;
	}

	const resolved = resolve(projectPath);
	if (!existsSync(resolved)) {
		console.error(chalk.red(`Project path does not exist: ${resolved}`));
		return;
	}

	const spinner = ora(`Indexing ${resolved} with GraphIQ...`).start();
	const result = await runCommand("graphiq", ["index", resolved]);
	if (result.code !== 0) {
		spinner.fail("GraphIQ indexing failed");
		if (result.stderr.trim()) console.error(result.stderr.trim());
		if (result.stdout.trim()) console.log(result.stdout.trim());
		return;
	}

	const stats = parseIndexStats(result.stdout);
	writeGraphiqPluginRegistryEnabled(deps.agentsDir, true);
	updateGraphiqActiveProject(deps.agentsDir, {
		projectPath: resolved,
		installSource,
		...stats,
	});

	spinner.succeed(`GraphIQ indexed ${resolved}`);
	if (result.stdout.trim()) console.log(result.stdout.trim());
	console.log(chalk.dim(`  Active code project: ${resolved}`));
}

export async function showGraphiqStatus(deps: GraphiqDeps): Promise<void> {
	const state = readGraphiqState(deps.agentsDir);
	if (!state.enabled || !state.activeProject) {
		console.log(chalk.yellow("GraphIQ plugin is not active. Run `signet index <path>` first."));
		return;
	}
	await runGraphiqForActiveProject("status", deps);
}

export async function runGraphiqDoctor(deps: GraphiqDeps): Promise<void> {
	await runGraphiqForActiveProject("doctor", deps);
}

export async function upgradeGraphiqIndex(deps: GraphiqDeps): Promise<void> {
	await runGraphiqForActiveProject("upgrade-index", deps);
}

export async function uninstallGraphiqPlugin(options: GraphiqUninstallOptions, deps: GraphiqDeps): Promise<void> {
	writeGraphiqPluginRegistryEnabled(deps.agentsDir, false);
	const state = disableGraphiqState(deps.agentsDir);
	if (options.purgeIndexes === true) {
		let skipped = 0;
		for (const project of state.indexedProjects) {
			const dir = validatedGraphiqIndexDir(project);
			if (!dir) {
				skipped += 1;
				continue;
			}
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		console.log(chalk.yellow("GraphIQ plugin disabled and known .graphiq indexes removed."));
		if (skipped > 0) {
			console.log(chalk.dim(`  Skipped ${skipped} index record(s) with invalid GraphIQ path metadata.`));
		}
		return;
	}
	console.log(chalk.green("GraphIQ plugin disabled."));
	console.log(chalk.dim("  Existing project .graphiq indexes were left in place."));
}

function validatedGraphiqIndexDir(project: { readonly path: string; readonly dbPath: string }): string | null {
	const expectedDbPath = resolve(getGraphiqProjectDbPath(project.path));
	if (resolve(project.dbPath) !== expectedDbPath) return null;
	return dirname(expectedDbPath);
}

function writeGraphiqPluginRegistryEnabled(agentsDir: string, enabled: boolean): void {
	const signetSecretsEnabled = readSetupCorePluginEnabled(agentsDir) ?? true;
	writeSetupCorePluginRegistry(agentsDir, { signetSecretsEnabled, graphiqEnabled: enabled });
}

async function runGraphiqForActiveProject(
	command: "status" | "doctor" | "upgrade-index",
	deps: GraphiqDeps,
): Promise<void> {
	const state = readGraphiqState(deps.agentsDir);
	if (!state.enabled || !state.activeProject) {
		console.log(chalk.yellow("GraphIQ plugin is not active. Run `signet index <path>` first."));
		return;
	}
	if (!hasCommand("graphiq")) {
		console.error(chalk.red("GraphIQ is not installed or not on PATH."));
		return;
	}
	const dbPath = state.indexedProjects.find((entry) => entry.path === state.activeProject)?.dbPath;
	if (!dbPath) {
		console.error(chalk.red(`GraphIQ index metadata is missing for active project: ${state.activeProject}`));
		console.error(chalk.dim("Run `signet index <path>` again to restore the active project record."));
		return;
	}
	if (!existsSync(dbPath)) {
		console.error(chalk.red(`GraphIQ database not found for active project: ${dbPath}`));
		console.error(chalk.dim("Run `signet index <path>` again to rebuild the project index."));
		return;
	}
	const args = [command, "--db", dbPath];
	const result = await runCommand("graphiq", args);
	if (result.stdout.trim()) console.log(result.stdout.trim());
	if (result.stderr.trim()) console.error(result.stderr.trim());
	if (result.code !== 0) {
		console.error(chalk.red(`graphiq ${command} exited with code ${result.code}`));
	}
}

function parseIndexStats(output: string): { files?: number; symbols?: number; edges?: number } {
	const match = output.match(/Files:\s+(\d+)\s+Symbols:\s+(\d+).*?Edges:\s+(\d+)/s);
	if (!match) return {};
	return {
		files: Number.parseInt(match[1] ?? "", 10),
		symbols: Number.parseInt(match[2] ?? "", 10),
		edges: Number.parseInt(match[3] ?? "", 10),
	};
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const proc = spawn(command, [...args], { stdio: "pipe", windowsHide: true });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (err) => {
			resolveResult({ code: 1, stdout, stderr: `${stderr}${err.message}` });
		});
		proc.on("close", (code) => {
			resolveResult({ code: code ?? 1, stdout, stderr });
		});
	});
}

export { SIGNET_GRAPHIQ_PLUGIN_ID };
