import chalk from "chalk";
import type { Command } from "commander";

interface SessionDeps {
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
}

export function registerSessionCommands(program: Command, deps: SessionDeps): void {
	program
		.command("bypass")
		.description("Toggle per-session bypass (disable Signet hooks for one session)")
		.argument("[session-key]", "Session key to bypass")
		.option("--list", "List active sessions with bypass status")
		.option("--off", "Disable bypass (re-enable Signet)")
		.action(async (sessionKey: string | undefined, options: { list?: boolean; off?: boolean }) => {
			if (options.off && !sessionKey) {
				console.error(chalk.red("Error: a session-key is required when using --off"));
				process.exit(1);
			}

			if (options.list || !sessionKey) {
				const data = await deps.fetchFromDaemon<{
					sessions: Array<{ key: string; runtimePath: string; claimedAt: string; bypassed: boolean }>;
					count: number;
				}>("/api/sessions");
				if (!data) {
					console.error(chalk.red("Failed to get sessions (is the daemon running?)"));
					process.exit(1);
				}
				if (data.sessions.length === 0) {
					console.log(chalk.dim("  No active sessions"));
					return;
				}
				console.log(chalk.bold("Active Sessions\n"));
				console.log(
					`  ${chalk.dim("KEY".padEnd(38))}${chalk.dim("PATH".padEnd(10))}${chalk.dim("AGE".padEnd(10))}${chalk.dim("BYPASS")}`,
				);
				for (const session of data.sessions) {
					const age = formatAge(session.claimedAt);
					const bypassLabel = session.bypassed ? chalk.yellow("bypassed") : chalk.dim("-");
					console.log(`  ${session.key.padEnd(38)}${session.runtimePath.padEnd(10)}${age.padEnd(10)}${bypassLabel}`);
				}
				return;
			}

			const result = await deps.fetchFromDaemon<{ key: string; bypassed: boolean }>(
				`/api/sessions/${encodeURIComponent(sessionKey)}/bypass`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: !options.off }),
				},
			);
			if (!result) {
				console.error(chalk.red("Failed to toggle bypass (session not found or daemon not running)"));
				process.exit(1);
			}
			if (result.bypassed) {
				console.log(chalk.yellow(`  Session ${sessionKey.slice(0, 12)} bypassed — hooks will return empty responses`));
				return;
			}
			console.log(chalk.green(`  Session ${sessionKey.slice(0, 12)} bypass removed — hooks re-enabled`));
		});
}

function formatAge(isoDate: string): string {
	const deltaMs = Date.now() - new Date(isoDate).getTime();
	if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";
	const sec = Math.floor(deltaMs / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	return `${Math.floor(hr / 24)}d`;
}
