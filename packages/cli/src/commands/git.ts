import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

interface GitDeps {
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
}

export function registerGitCommands(program: Command, deps: GitDeps): void {
	const gitCmd = program.command("git").description("Git sync management");

	gitCmd
		.command("status")
		.description("Show git sync status")
		.action(async () => {
			const data = await deps.fetchFromDaemon<{
				isRepo?: boolean;
				branch?: string;
				remote?: string;
				hasCredentials?: boolean;
				authMethod?: string;
				autoSync?: boolean;
				lastSync?: string;
				uncommittedChanges?: number;
				unpushedCommits?: number;
				unpulledCommits?: number;
			}>("/api/git/status");

			if (!data) {
				console.error(chalk.red("Failed to get git status"));
				process.exit(1);
			}

			console.log(chalk.bold("Git Status\n"));
			if (!data.isRepo) {
				console.log(chalk.yellow("  Not a git repository"));
				console.log(chalk.dim("  Run: cd ~/.agents && git init"));
				return;
			}

			console.log(`  ${chalk.dim("Branch:")}     ${data.branch || "unknown"}`);
			console.log(`  ${chalk.dim("Remote:")}     ${data.remote || "none"}`);
			if (data.authMethod === "no-remote") {
				console.log(`  ${chalk.dim("Auth:")}       ${chalk.dim("no remote configured")}`);
			} else if (data.hasCredentials) {
				console.log(`  ${chalk.dim("Auth:")}       ${chalk.green(data.authMethod || "configured")}`);
			} else {
				console.log(`  ${chalk.dim("Auth:")}       ${chalk.yellow("no credentials")}`);
			}
			console.log(`  ${chalk.dim("Auto-sync:")}  ${data.autoSync ? chalk.green("enabled") : chalk.dim("disabled")}`);
			if (data.lastSync) console.log(`  ${chalk.dim("Last sync:")}  ${data.lastSync}`);
			if ((data.uncommittedChanges || 0) > 0) {
				console.log(`  ${chalk.dim("Uncommitted:")} ${chalk.yellow(`${data.uncommittedChanges} changes`)}`);
			}
			if ((data.unpushedCommits || 0) > 0) {
				console.log(`  ${chalk.dim("Unpushed:")}   ${chalk.cyan(`${data.unpushedCommits} commits`)}`);
			}
			if ((data.unpulledCommits || 0) > 0) {
				console.log(`  ${chalk.dim("Unpulled:")}   ${chalk.cyan(`${data.unpulledCommits} commits`)}`);
			}
			if (data.authMethod === "no-remote") {
				console.log(chalk.dim("\n  To enable sync: git -C ~/.agents remote add origin <url>"));
			} else if (!data.hasCredentials) {
				console.log(chalk.dim("\n  To enable sync: gh auth login, or signet secret put GITHUB_TOKEN"));
			}
		});

	gitCmd
		.command("sync")
		.description("Sync with remote (pull + push)")
		.action(async () => {
			const spinner = ora("Syncing with remote...").start();
			const data = await deps.fetchFromDaemon<{
				success?: boolean;
				message?: string;
				pulled?: number;
				pushed?: number;
			}>("/api/git/sync", { method: "POST" });
			if (!data?.success) {
				spinner.fail(data?.message || "Sync failed");
				process.exit(1);
			}
			spinner.succeed("Sync complete");
			console.log(chalk.dim(`  Pulled: ${data.pulled || 0} commits`));
			console.log(chalk.dim(`  Pushed: ${data.pushed || 0} commits`));
		});

	gitCmd
		.command("pull")
		.description("Pull changes from remote")
		.action(async () => {
			const spinner = ora("Pulling from remote...").start();
			const data = await deps.fetchFromDaemon<{ success?: boolean; message?: string; changes?: number }>(
				"/api/git/pull",
				{
					method: "POST",
				},
			);
			if (!data?.success) {
				spinner.fail(data?.message || "Pull failed");
				process.exit(1);
			}
			spinner.succeed(data.message || "Pull complete");
			if (typeof data.changes === "number") console.log(chalk.dim(`  ${data.changes} commits`));
		});

	gitCmd
		.command("push")
		.description("Push changes to remote")
		.action(async () => {
			const spinner = ora("Pushing to remote...").start();
			const data = await deps.fetchFromDaemon<{ success?: boolean; message?: string; changes?: number }>(
				"/api/git/push",
				{
					method: "POST",
				},
			);
			if (!data?.success) {
				spinner.fail(data?.message || "Push failed");
				process.exit(1);
			}
			spinner.succeed(data.message || "Push complete");
			if (typeof data.changes === "number") console.log(chalk.dim(`  ${data.changes} commits`));
		});

	gitCmd
		.command("enable")
		.description("Enable auto-sync")
		.option("-i, --interval <seconds>", "Sync interval in seconds", "300")
		.action(async (options) => {
			const data = await deps.fetchFromDaemon<{ success?: boolean }>("/api/git/config", {
				method: "POST",
				body: JSON.stringify({ autoSync: true, syncInterval: Number.parseInt(options.interval, 10) }),
			});
			if (!data?.success) {
				console.error(chalk.red("Failed to enable auto-sync"));
				process.exit(1);
			}
			console.log(chalk.green("✓ Auto-sync enabled"));
			console.log(chalk.dim(`  Interval: every ${options.interval}s`));
		});

	gitCmd
		.command("disable")
		.description("Disable auto-sync")
		.action(async () => {
			const data = await deps.fetchFromDaemon<{ success?: boolean }>("/api/git/config", {
				method: "POST",
				body: JSON.stringify({ autoSync: false }),
			});
			if (!data?.success) {
				console.error(chalk.red("Failed to disable auto-sync"));
				process.exit(1);
			}
			console.log(chalk.green("✓ Auto-sync disabled"));
		});
}
