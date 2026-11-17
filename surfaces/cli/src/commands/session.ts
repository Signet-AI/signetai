import chalk from "chalk";
import type { Command } from "commander";

interface SessionDeps {
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
}

interface SessionSearchHit {
	readonly sessionKey: string;
	readonly project?: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly rank: number;
}

export function registerSessionCommands(program: Command, deps: SessionDeps): void {
	const session = program.command("session").description("Search transcripts and manage active sessions");

	session
		.command("delete-transcript <session-key>")
		.description("Delete a session transcript and its attributable derived state")
		.option("--agent <name>", "Owning agent ID")
		.option("--project <project>", "Restrict deletion to this project")
		.option("--hard-purge", "Permanently purge derived memories and history (admin only)", false)
		.option("--json", "Output the deletion result as JSON", false)
		.action(
			async (
				key: string,
				options: {
					readonly agent?: string;
					readonly project?: string;
					readonly hardPurge?: boolean;
					readonly json?: boolean;
				},
			): Promise<void> => {
				const query = new URLSearchParams();
				if (options.agent) query.set("agent_id", options.agent);
				if (options.project) query.set("project", options.project);
				if (options.hardPurge) query.set("purge", "hard");
				const data = await deps.fetchFromDaemon<{
					readonly status?: string;
					readonly pendingCleanup?: readonly string[];
					readonly counts?: Readonly<Record<string, number>>;
					readonly error?: string;
				}>(`/api/sessions/${encodeURIComponent(key)}/transcript${query.size ? `?${query}` : ""}`, {
					method: "DELETE",
					timeout: 65_000,
				});
				if (!data || data.error || data.status !== "deleted") {
					console.error(chalk.red(data?.error ?? "Failed to delete transcript"));
					process.exitCode = 1;
					return;
				}
				if (options.json) console.log(JSON.stringify(data, null, 2));
				if (data.pendingCleanup?.length) {
					console.error(
						chalk.yellow(`Cleanup pending: ${data.pendingCleanup.join(", ")}. Retry the same delete command.`),
					);
					process.exitCode = 2;
					return;
				}
				if (!options.json) console.log(`Deleted transcript ${key}: ${JSON.stringify(data.counts ?? {})}`);
			},
		);

	session
		.command("search <query>")
		.description("Search active or completed session transcripts")
		.option("--session-key <key>", "Specific transcript session key to search")
		.option("--current-session-key <key>", "Current session key; sub-agent lineage may resolve to the parent")
		.option("--agent <name>", "Agent ID scope")
		.option("--project <project>", "Filter by project")
		.option("-l, --limit <n>", "Max results (default 10, max 20)", Number.parseInt, 10)
		.option("--json", "Output as JSON", false)
		.action(
			async (
				query: string,
				options: {
					sessionKey?: string;
					currentSessionKey?: string;
					agent?: string;
					project?: string;
					limit?: number;
					json?: boolean;
				},
			) => {
				const data = await deps.fetchFromDaemon<{
					query: string;
					hits: SessionSearchHit[];
					count: number;
					error?: string;
				}>("/api/sessions/search", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						query,
						sessionKey: options.sessionKey,
						currentSessionKey: options.currentSessionKey,
						agentId: options.agent,
						project: options.project,
						limit: options.limit,
					}),
					timeout: 30_000,
				});
				if (!data || data.error) {
					console.error(chalk.red(data?.error ?? "Failed to search transcripts (is the daemon running?)"));
					process.exit(1);
				}

				if (options.json) {
					console.log(JSON.stringify(data, null, 2));
					return;
				}

				if (data.hits.length === 0) {
					console.log(chalk.dim("  No transcripts found"));
					return;
				}

				console.log(chalk.bold(`\n  Transcript Search: ${data.query}\n`));
				for (const hit of data.hits) {
					const project = hit.project ? ` ${chalk.dim(hit.project)}` : "";
					console.log(`  ${chalk.cyan(hit.sessionKey)} ${chalk.dim(formatSessionSearchDate(hit.updatedAt))}${project}`);
					console.log(`  ${hit.excerpt}`);
					console.log();
				}
			},
		);

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

function formatSessionSearchDate(isoDate: string): string {
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) return isoDate;
	return date.toISOString().slice(0, 10);
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
