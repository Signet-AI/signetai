import { dirname } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
	createWorkspaceSnapshot,
	getGitRemoteState,
	getSnapshotProtection,
	hasOpenClawWorkspaceLink,
	saveSnapshotProtection,
	setOriginRemote,
} from "../lib/workspace-protection.js";

export interface SetupProtectionOptions {
	readonly basePath: string;
	readonly nonInteractive: boolean;
	readonly allowUnprotectedWorkspace: boolean;
	readonly createLocalBackup: boolean;
	readonly assumeOpenClawLinked?: boolean;
}

export interface SetupProtectionResult {
	readonly state: "not-applicable" | "remote" | "snapshot" | "bypass";
	readonly openclawLinked: boolean;
	readonly origin: string | null;
	readonly snapshotPath: string | null;
}

export function printSetupProtectionSummary(result: SetupProtectionResult): void {
	if (result.state === "not-applicable") {
		return;
	}
	if (result.state === "remote") {
		console.log(chalk.green("  ✓ Workspace protection: origin remote configured"));
		console.log(chalk.dim(`    origin: ${result.origin}`));
		return;
	}
	if (result.state === "snapshot") {
		console.log(chalk.yellow("  ⚠ Workspace protection: local snapshot created"));
		console.log(chalk.dim(`    snapshot: ${result.snapshotPath}`));
		return;
	}
	console.log(chalk.red("  ⚠ Workspace protection bypassed"));
	console.log(chalk.dim("    Configure a git origin or create an out-of-workspace backup immediately."));
}

export function refreshSnapshotProtection(basePath: string, result: SetupProtectionResult): SetupProtectionResult {
	if (result.state !== "snapshot") {
		return result;
	}
	const root = result.snapshotPath ? dirname(result.snapshotPath) : undefined;
	const snap = root ? createWorkspaceSnapshot(basePath, root) : createWorkspaceSnapshot(basePath);
	saveSnapshotProtection(basePath, snap.path);
	return {
		...result,
		snapshotPath: snap.path,
	};
}

function printRisk(path: string): void {
	console.log();
	console.log(chalk.red.bold("  CRITICAL: OpenClaw uninstall can delete this workspace."));
	console.log(chalk.red(`  Workspace: ${path}`));
	console.log(chalk.dim("  If no remote backup exists, your Signet identity and memory history may be unrecoverable."));
}

export async function enforceSetupProtection(opts: SetupProtectionOptions): Promise<SetupProtectionResult> {
	const openclawLinked = opts.assumeOpenClawLinked === true || hasOpenClawWorkspaceLink(opts.basePath);
	const remote = getGitRemoteState(opts.basePath);
	const snapshot = getSnapshotProtection(opts.basePath);
	if (!openclawLinked) {
		return {
			state: "not-applicable",
			openclawLinked: false,
			origin: remote.origin,
			snapshotPath: snapshot,
		};
	}

	if (remote.origin) {
		return {
			state: "remote",
			openclawLinked: true,
			origin: remote.origin,
			snapshotPath: null,
		};
	}

	if (snapshot) {
		return {
			state: "snapshot",
			openclawLinked: true,
			origin: null,
			snapshotPath: snapshot,
		};
	}

	if (opts.nonInteractive) {
		if (opts.createLocalBackup) {
			const snap = createWorkspaceSnapshot(opts.basePath);
			saveSnapshotProtection(opts.basePath, snap.path);
			return {
				state: "snapshot",
				openclawLinked: true,
				origin: null,
				snapshotPath: snap.path,
			};
		}
		if (opts.allowUnprotectedWorkspace) {
			return {
				state: "bypass",
				openclawLinked: true,
				origin: null,
				snapshotPath: null,
			};
		}
		throw new Error(
			"OpenClaw workspace is linked to this Signet path without an origin remote. Re-run setup with --create-local-backup or --allow-unprotected-workspace.",
		);
	}

	printRisk(opts.basePath);

	while (true) {
		const action = await select({
			message: "Protect this workspace before setup completes:",
			choices: [
				{ value: "remote", name: "Set git origin now (recommended)" },
				{ value: "snapshot", name: "Create local snapshot backup now" },
				{ value: "bypass", name: "Continue anyway (I understand the risk)" },
			],
		});

		if (action === "remote") {
			const url = await input({
				message: "Origin URL (ssh or https):",
				validate: (value) => (value.trim().length > 0 ? true : "Origin URL is required"),
			});
			try {
				setOriginRemote(opts.basePath, url.trim());
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.log(chalk.red(`  Could not set origin: ${message}`));
				continue;
			}
			const updated = getGitRemoteState(opts.basePath);
			if (updated.origin) {
				return {
					state: "remote",
					openclawLinked: true,
					origin: updated.origin,
					snapshotPath: null,
				};
			}
			console.log(chalk.yellow("  Could not verify origin. Please try again."));
			continue;
		}

		if (action === "snapshot") {
			const snap = createWorkspaceSnapshot(opts.basePath);
			saveSnapshotProtection(opts.basePath, snap.path);
			console.log(chalk.green(`  ✓ Snapshot created at ${snap.path}`));
			return {
				state: "snapshot",
				openclawLinked: true,
				origin: null,
				snapshotPath: snap.path,
			};
		}

		const proceed = await confirm({
			message: "Continue without remote or snapshot backup?",
			default: false,
		});
		if (!proceed) {
			continue;
		}
		return {
			state: "bypass",
			openclawLinked: true,
			origin: null,
			snapshotPath: null,
		};
	}
}
