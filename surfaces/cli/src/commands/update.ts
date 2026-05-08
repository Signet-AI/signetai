import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

interface UpdateDeps {
	readonly AGENTS_DIR: string;
	readonly MAX_AUTO_UPDATE_INTERVAL: number;
	readonly MIN_AUTO_UPDATE_INTERVAL: number;
	readonly configureHarnessHooks: (harness: string, basePath: string) => Promise<void>;
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
	readonly getTemplatesDir: () => string;
	readonly isOpenClawInstalled: () => boolean;
	readonly isOhMyPiInstalled: () => boolean;
	readonly isPiInstalled: () => boolean;
	readonly getSkillsSourceDir: () => string;
	readonly syncBuiltinSkills: (
		skillsSourceDir: string,
		basePath: string,
	) => { installed: string[]; updated: string[]; skipped: string[] };
}

const UPDATE_INSTALL_TIMEOUT_MS = 15 * 60_000;

type UpdateChannel = "stable" | "nightly";

function parseUpdateChannel(value: unknown): UpdateChannel | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "stable" || normalized === "latest") return "stable";
	if (normalized === "nightly" || normalized === "next") return "nightly";
	return null;
}

function formatUpdateChannel(channel: string | undefined): string {
	if (channel === "nightly") return chalk.yellow("nightly");
	return chalk.green("stable");
}

export function registerUpdateCommands(program: Command, deps: UpdateDeps): void {
	const updateCmd = program.command("update").description("Check, install, and manage auto-updates");

	updateCmd
		.command("check")
		.description("Check for available updates")
		.option("-f, --force", "Force check (ignore cache)")
		.action(async (options) => {
			const spinner = ora("Checking for updates...").start();
			const data = await deps.fetchFromDaemon<{
				currentVersion?: string;
				latestVersion?: string;
				updateAvailable?: boolean;
				releaseUrl?: string;
				publishedAt?: string;
				checkError?: string;
				restartRequired?: boolean;
				pendingVersion?: string;
			}>(`/api/update/check${options.force ? "?force=true" : ""}`);

			if (!data) {
				spinner.fail("Could not connect to daemon");
				return;
			}

			if (data.checkError) {
				spinner.warn("Could not fully check for updates");
				console.log(chalk.dim(`  Error: ${data.checkError}`));
				if (!data.restartRequired) return;
			}

			if (data.updateAvailable) {
				spinner.succeed(chalk.green(`Update available: v${data.latestVersion}`));
				console.log(chalk.dim(`  Current: v${data.currentVersion}`));
				if (data.restartRequired && data.pendingVersion) {
					console.log(chalk.dim(`  Pending restart: v${data.pendingVersion} already installed`));
				}
				if (data.publishedAt) {
					console.log(chalk.dim(`  Released: ${new Date(data.publishedAt).toLocaleDateString()}`));
				}
				if (data.releaseUrl) {
					console.log(chalk.dim(`  ${data.releaseUrl}`));
				}
				console.log(chalk.cyan("\n  Run: signet update install"));
				return;
			}

			if (data.restartRequired) {
				spinner.succeed(
					chalk.yellow(`Update installed: v${data.pendingVersion || data.latestVersion}. Restart required.`),
				);
				console.log(chalk.cyan("\n  Restart daemon to apply: signet daemon restart"));
				return;
			}

			spinner.succeed("Already up to date");
			console.log(chalk.dim(`  Version: v${data.currentVersion}`));
		});

	updateCmd
		.command("install")
		.description("Install the latest update")
		.action(async () => {
			const check = await deps.fetchFromDaemon<{
				updateAvailable?: boolean;
				latestVersion?: string;
				restartRequired?: boolean;
				pendingVersion?: string;
			}>("/api/update/check?force=true");

			if (!check) {
				console.error(chalk.red("Could not connect to daemon"));
				process.exit(1);
			}

			if (check.restartRequired && !check.updateAvailable) {
				console.log(chalk.yellow(`✓ Update already installed (v${check.pendingVersion || check.latestVersion})`));
				console.log(chalk.cyan("  Restart daemon to apply: signet daemon restart"));
				return;
			}

			if (!check.updateAvailable) {
				console.log(chalk.green("✓ Already running the latest version"));
				return;
			}

			console.log(chalk.cyan(`Installing v${check.latestVersion}...`));
			const spinner = ora("Downloading and installing...").start();
			const data = await deps.fetchFromDaemon<{
				success?: boolean;
				message?: string;
				output?: string;
				restartRequired?: boolean;
				desktopUpdate?: { status?: string; message?: string };
			}>("/api/update/run", {
				method: "POST",
				timeout: UPDATE_INSTALL_TIMEOUT_MS,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ targetVersion: check.latestVersion }),
			});

			if (!data?.success) {
				spinner.fail(data?.message || "Update failed");
				if (data?.output) {
					console.log(chalk.dim(data.output));
				}
				process.exit(1);
			}

			spinner.succeed(data.message || "Update installed");
			if (data.desktopUpdate?.status === "updated") {
				console.log(chalk.green(`  ✓ ${data.desktopUpdate.message}`));
			} else if (data.desktopUpdate?.status === "error") {
				console.log(chalk.yellow(`  ⚠ ${data.desktopUpdate.message}`));
			} else if (data.desktopUpdate?.status === "skipped") {
				console.log(chalk.dim(`  Desktop: ${data.desktopUpdate.message}`));
			}
			try {
				const skillResult = deps.syncBuiltinSkills(deps.getSkillsSourceDir(), deps.AGENTS_DIR);
				const totalSynced = skillResult.installed.length + skillResult.updated.length;
				if (totalSynced > 0) {
					console.log(chalk.green(`  ✓ ${totalSynced} skills synced`));
				}

				const harnesses: string[] = [];
				if (existsSync(join(homedir(), ".claude", "settings.json"))) harnesses.push("claude-code");
				if (
					existsSync(join(homedir(), ".config", "signet", "bin", "codex")) ||
					existsSync(join(homedir(), ".codex", "config.toml"))
				) {
					harnesses.push("codex");
				}
				if (existsSync(join(homedir(), ".config", "opencode"))) harnesses.push("opencode");
				if (deps.isOpenClawInstalled()) harnesses.push("openclaw");
				if (deps.isOhMyPiInstalled()) harnesses.push("oh-my-pi");
				if (deps.isPiInstalled()) harnesses.push("pi");

				for (const harness of harnesses) {
					try {
						await deps.configureHarnessHooks(harness, deps.AGENTS_DIR);
						console.log(chalk.green(`  ✓ hooks re-registered for ${harness}`));
					} catch {
						// best effort
					}
				}
			} catch {
				// best effort
			}

			if (data.restartRequired) {
				console.log(chalk.cyan("\n  Restart daemon to apply: signet daemon restart"));
			}
		});

	updateCmd
		.command("status")
		.description("Show auto-update settings and status")
		.action(async () => {
			const data = await deps.fetchFromDaemon<{
				autoInstall?: boolean;
				checkInterval?: number;
				channel?: string;
				pendingRestartVersion?: string;
				lastAutoUpdateAt?: string;
				lastAutoUpdateError?: string;
				updateInProgress?: boolean;
			}>("/api/update/config");

			if (!data) {
				console.error(chalk.red("Failed to get update status"));
				process.exit(1);
			}

			console.log(chalk.bold("Update Status\n"));
			console.log(
				`  ${chalk.dim("Auto-install:")} ${data.autoInstall ? chalk.green("enabled") : chalk.dim("disabled")}`,
			);
			console.log(`  ${chalk.dim("Interval:")}     every ${data.checkInterval || "?"}s`);
			console.log(`  ${chalk.dim("Channel:")}      ${formatUpdateChannel(data.channel)}`);
			console.log(`  ${chalk.dim("In progress:")}  ${data.updateInProgress ? chalk.yellow("yes") : chalk.dim("no")}`);
			if (data.pendingRestartVersion) {
				console.log(`  ${chalk.dim("Pending:")}      v${data.pendingRestartVersion} (restart required)`);
			}
			if (data.lastAutoUpdateAt) {
				console.log(`  ${chalk.dim("Last success:")} ${new Date(data.lastAutoUpdateAt).toLocaleString()}`);
			}
			if (data.lastAutoUpdateError) {
				console.log(`  ${chalk.dim("Last error:")}   ${chalk.yellow(data.lastAutoUpdateError)}`);
			}
		});

	updateCmd
		.command("channel [channel]")
		.description("Show or set the update channel (stable or nightly)")
		.action(async (rawChannel?: string) => {
			if (!rawChannel) {
				const data = await deps.fetchFromDaemon<{ channel?: string }>("/api/update/config");
				if (!data) {
					console.error(chalk.red("Failed to get update channel"));
					process.exit(1);
				}
				console.log(`Update channel: ${formatUpdateChannel(data.channel)}`);
				console.log(chalk.dim("  stable = default tested releases; nightly = opt-in next builds"));
				return;
			}

			const channel = parseUpdateChannel(rawChannel);
			if (!channel) {
				console.error(chalk.red("Channel must be stable or nightly"));
				process.exit(1);
			}

			const data = await deps.fetchFromDaemon<{
				success?: boolean;
				persisted?: boolean;
				config?: { channel?: string };
			}>("/api/update/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ channel }),
			});

			if (!data?.success) {
				console.error(chalk.red("Failed to set update channel"));
				process.exit(1);
			}

			console.log(chalk.green(`✓ Update channel set to ${data.config?.channel ?? channel}`));
			if (channel === "nightly") {
				console.log(chalk.yellow("  Nightly tracks @next builds and may be unstable."));
			}
			if (data.persisted === false) {
				console.log(chalk.yellow("  ⚠ Could not persist updates block to agent.yaml"));
			}
		});

	updateCmd
		.command("enable")
		.description("Enable unattended auto-update installs")
		.option(
			"-i, --interval <seconds>",
			`Check interval in seconds (${deps.MIN_AUTO_UPDATE_INTERVAL}-${deps.MAX_AUTO_UPDATE_INTERVAL})`,
			"21600",
		)
		.action(async (options) => {
			const interval = Number.parseInt(options.interval, 10);
			if (
				!Number.isFinite(interval) ||
				interval < deps.MIN_AUTO_UPDATE_INTERVAL ||
				interval > deps.MAX_AUTO_UPDATE_INTERVAL
			) {
				console.error(
					chalk.red(
						`Interval must be between ${deps.MIN_AUTO_UPDATE_INTERVAL} and ${deps.MAX_AUTO_UPDATE_INTERVAL} seconds`,
					),
				);
				process.exit(1);
			}

			const data = await deps.fetchFromDaemon<{ success?: boolean; persisted?: boolean }>("/api/update/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ autoInstall: true, checkInterval: interval }),
			});

			if (!data?.success) {
				console.error(chalk.red("Failed to enable auto-update"));
				process.exit(1);
			}

			console.log(chalk.green("✓ Auto-update enabled"));
			console.log(chalk.dim(`  Interval: every ${interval}s`));
			console.log(chalk.dim("  Updates install in the background"));
			if (data.persisted === false) {
				console.log(chalk.yellow("  ⚠ Could not persist updates block to agent.yaml"));
			}
		});

	updateCmd
		.command("disable")
		.description("Disable unattended auto-update installs")
		.action(async () => {
			const data = await deps.fetchFromDaemon<{ success?: boolean; persisted?: boolean }>("/api/update/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ autoInstall: false }),
			});

			if (!data?.success) {
				console.error(chalk.red("Failed to disable auto-update"));
				process.exit(1);
			}

			console.log(chalk.green("✓ Auto-update disabled"));
			if (data.persisted === false) {
				console.log(chalk.yellow("  ⚠ Could not persist updates block to agent.yaml"));
			}
		});

	updateCmd.action(async () => {
		const spinner = ora("Checking for updates...").start();
		const data = await deps.fetchFromDaemon<{
			currentVersion?: string;
			latestVersion?: string;
			updateAvailable?: boolean;
			checkError?: string;
			restartRequired?: boolean;
			pendingVersion?: string;
		}>("/api/update/check?force=true");

		if (!data) {
			spinner.fail("Could not connect to daemon");
			return;
		}

		if (data.checkError) {
			spinner.warn("Could not fully check for updates");
			console.log(chalk.dim(`  Error: ${data.checkError}`));
			if (!data.restartRequired) return;
		}

		if (data.updateAvailable) {
			spinner.succeed(chalk.green(`Update available: v${data.latestVersion}`));
			console.log(chalk.dim(`  Current: v${data.currentVersion}`));
			console.log(chalk.cyan("\n  Run: signet update install"));
			return;
		}

		if (data.restartRequired) {
			spinner.succeed(
				chalk.yellow(`Update installed: v${data.pendingVersion || data.latestVersion}. Restart required.`),
			);
			console.log(chalk.cyan("\n  Run: signet daemon restart"));
			return;
		}

		spinner.succeed("Already up to date");
		console.log(chalk.dim(`  Version: v${data.currentVersion}`));
	});
}
