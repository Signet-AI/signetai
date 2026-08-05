import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonFetch, DaemonFetchFailure, DaemonFetchResult } from "../lib/daemon.js";

interface DreamDeps {
	readonly fetchFromDaemon: DaemonFetch;
	readonly fetchDaemonResult: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<DaemonFetchResult<T>>;
	/** Poll cadence for `dream trigger` (test seams; defaults match production). */
	readonly pollIntervalMs?: number;
	readonly minWaitMs?: number;
}

export type { DreamDeps };

interface DreamState {
	readonly consecutiveFailures: number;
	readonly lastPassAt: string | null;
	readonly evidenceCursor: { readonly capturedAt: string; readonly kind: string | null; readonly id: string } | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

interface DreamPass {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
}

interface DreamStatus {
	readonly worker: { readonly running: boolean; readonly active: boolean };
	readonly state: DreamState;
	readonly episodicTokensPending: number;
	readonly config: {
		readonly tokenThreshold: number;
		readonly backfillOnFirstRun: boolean;
	};
	readonly passes: readonly DreamPass[];
}

interface TriggerAccepted {
	readonly accepted: boolean;
	readonly passId: string;
	readonly status: string;
	readonly mode: string;
	readonly error?: string;
}

/**
 * Name the real cause instead of a generic connectivity message. A timed-out
 * probe means the daemon process is up but its event loop is blocked (for
 * example, a wedged worker) — a restart often re-triggers the same wedge, so
 * point at the logs rather than advising one (#1074).
 */
function reportDaemonUnavailable(reason: DaemonFetchFailure, status: number | undefined, action: string): void {
	if (reason === "timeout") {
		console.error(chalk.red(`${action} — the daemon is not responding (its event loop may be blocked).`));
		console.error(chalk.dim("  Check `signet daemon logs`; a restart may not clear a wedged worker."));
		return;
	}
	if (reason === "http") {
		console.error(chalk.red(`${action} — daemon returned HTTP ${status ?? "error"}.`));
		return;
	}
	console.error(chalk.red(`${action} (is the daemon running?)`));
}

export function registerDreamCommands(program: Command, deps: DreamDeps): void {
	const dream = program.command("dream").description("Manage dreaming memory consolidation");

	dream
		.command("capabilities")
		.description("List the daemon-owned Dreaming capability registry")
		.option("--json", "Output as JSON")
		.action(async (options: { json?: boolean }) => {
			const data = await deps.fetchFromDaemon<{
				readonly items?: readonly { readonly id: string; readonly description: string }[];
			}>("/api/dream/tools");
			if (!data) {
				console.error(chalk.red("Failed to get Dreaming capabilities (is the daemon running?)"));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			for (const capability of data.items ?? []) console.log(`${capability.id}\t${capability.description}`);
		});

	dream
		.command("tool <capability>")
		.description("Invoke one daemon-owned Dreaming capability with a JSON input object")
		.requiredOption("--input <json>", "Capability input JSON object")
		.option("--agent <id>", "Agent scope")
		.option("--pass-id <id>", "Current Dreaming pass (required by runbook_write)")
		.action(async (capability: string, options: { input: string; agent?: string; passId?: string }) => {
			let input: unknown;
			try {
				input = JSON.parse(options.input);
			} catch {
				console.error(chalk.red("--input must be a JSON object"));
				process.exit(1);
				return;
			}
			if (!input || typeof input !== "object" || Array.isArray(input)) {
				console.error(chalk.red("--input must be a JSON object"));
				process.exit(1);
				return;
			}
			const result = await deps.fetchDaemonResult<unknown>(`/api/dream/tools/${encodeURIComponent(capability)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					input,
					...(options.agent ? { agentId: options.agent } : {}),
					...(options.passId ? { passId: options.passId } : {}),
				}),
			});
			if (!result.ok) {
				if (result.reason === "http" && result.error) {
					console.error(chalk.red(`Dreaming capability failed: ${result.error}`));
				} else {
					reportDaemonUnavailable(result.reason, result.status, "Dreaming capability failed");
				}
				process.exit(1);
			}
			console.log(JSON.stringify(result.data, null, 2));
		});

	dream
		.command("status")
		.description("Show dreaming worker status and recent passes")
		.action(async () => {
			const result = await deps.fetchDaemonResult<DreamStatus>("/api/dream/status");
			if (!result.ok) {
				if (result.reason === "http" && result.error) {
					console.error(chalk.red(`Failed to get dreaming status: ${result.error}`));
				} else {
					reportDaemonUnavailable(result.reason, result.status, "Failed to get dreaming status");
				}
				process.exit(1);
			}
			const data = result.data;

			console.log(chalk.bold("\n  Dreaming Status\n"));

			const worker = data.worker.running
				? data.worker.active
					? chalk.yellow("running pass")
					: chalk.green("idle")
				: chalk.dim("stopped");

			console.log(`  ${chalk.dim("Worker:")}     ${worker}`);
			console.log(
				`  ${chalk.dim("Threshold:")}  ${data.episodicTokensPending} / ${data.config.tokenThreshold} episodic tokens`,
			);

			if (data.state.lastPassAt) {
				console.log(`  ${chalk.dim("Last pass:")}  ${data.state.lastPassAt} (${data.state.lastPassMode})`);
			} else {
				console.log(`  ${chalk.dim("Last pass:")}  ${chalk.dim("never")}`);
			}

			if (data.passes.length > 0) {
				console.log(chalk.bold("\n  Recent Passes\n"));
				console.log(
					`  ${chalk.dim("STATUS".padEnd(12))}${chalk.dim("MODE".padEnd(14))}${chalk.dim("MUTATIONS".padEnd(24))}${chalk.dim("STARTED")}`,
				);
				for (const pass of data.passes) {
					const status =
						pass.status === "completed"
							? chalk.green(pass.status)
							: pass.status === "failed"
								? chalk.red(pass.status)
								: chalk.yellow(pass.status);
					const mutations =
						pass.mutationsApplied !== null
							? `${pass.mutationsApplied}ok/${pass.mutationsSkipped ?? 0}skip/${pass.mutationsFailed ?? 0}err`
							: "-";
					console.log(
						`  ${status.padEnd(12 + (status.length - pass.status.length))}${pass.mode.padEnd(14)}${mutations.padEnd(24)}${pass.startedAt}`,
					);
					if (pass.summary) {
						console.log(`  ${chalk.dim(pass.summary.slice(0, 100))}`);
					}
					if (pass.error) {
						console.log(`  ${chalk.red(pass.error.slice(0, 100))}`);
					}
				}
			}
			console.log();
		});

	dream
		.command("trigger")
		.description("Manually trigger a dreaming pass")
		.option("--compact", "Run in compaction mode (full graph cleanup)")
		.option("--wait-secs <seconds>", "Max seconds to wait for pass completion (default: 720)", "720")
		.action(async (opts: { compact?: boolean; waitSecs?: string }) => {
			const mode = opts.compact ? "compact" : "incremental";
			// Poll ceiling: default 720s (12 min) > default LLM timeout 300s.
			// Increase with --wait-secs if your dreaming.timeout config exceeds 5 min.
			const rawWait = (opts.waitSecs ?? "720").trim();
			const parsedWait = Number.parseInt(rawWait, 10);
			if (!/^\d+$/.test(rawWait) || Number.isNaN(parsedWait) || parsedWait <= 0) {
				console.error(
					chalk.red(`  Invalid --wait-secs value: "${opts.waitSecs}" (must be a positive integer, e.g. 720)`),
				);
				process.exit(1);
			}
			const pollInterval = deps.pollIntervalMs ?? 5_000;
			const maxWait = Math.max(deps.minWaitMs ?? 30_000, parsedWait * 1000);
			const maxPolls = Math.ceil(maxWait / pollInterval);
			console.log(chalk.dim(`\n  Triggering ${mode} dreaming pass...\n`));

			const acceptedResult = await deps.fetchDaemonResult<TriggerAccepted>("/api/dream/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
			});

			if (!acceptedResult.ok) {
				if (acceptedResult.reason === "http" && acceptedResult.error) {
					console.error(chalk.red(`Failed to trigger dreaming pass: ${acceptedResult.error}`));
				} else {
					reportDaemonUnavailable(acceptedResult.reason, acceptedResult.status, "Failed to trigger dreaming pass");
				}
				process.exit(1);
			}
			const accepted = acceptedResult.data;

			if (accepted.error) {
				console.error(chalk.red(`  Error: ${accepted.error}`));
				process.exit(1);
			}

			console.log(chalk.dim(`  Pass ${accepted.passId} accepted, polling for result...\n`));

			// Poll status until the pass completes or fails. The first probe
			// runs immediately so a fast terminal failure is surfaced without
			// a full poll interval.
			let pass: DreamPass | undefined;
			let statusUnavailable: DaemonFetchFailure | null = null;
			for (let i = 0; i < maxPolls; i++) {
				if (i > 0) await new Promise((r) => setTimeout(r, pollInterval));
				const statusResult = await deps.fetchDaemonResult<DreamStatus>("/api/dream/status");
				if (!statusResult.ok) {
					statusUnavailable = statusResult.reason;
					break;
				}
				pass = statusResult.data.passes.find((p) => p.id === accepted.passId);
				if (pass && pass.status !== "running") break;
			}

			if (!pass) {
				if (statusUnavailable === "timeout") {
					console.log(
						chalk.yellow("  Daemon is not responding (its event loop may be blocked); the pass result is unknown."),
					);
					console.log(
						chalk.dim("  Check `signet daemon logs` for the pass error; a restart may not clear a wedged worker."),
					);
				} else if (statusUnavailable !== null) {
					console.log(
						chalk.yellow(
							`  Could not retrieve pass result (${statusUnavailable === "offline" ? "daemon unreachable" : "daemon returned an error"}).`,
						),
					);
					console.log(chalk.dim("  Check `signet dream status` once the daemon is healthy."));
				} else {
					console.log(
						chalk.yellow(`  Pass ${accepted.passId} did not appear in status within ${Math.round(maxWait / 1000)}s.`),
					);
					console.log(chalk.dim("  Check `signet dream status` for the pass outcome."));
				}
				console.log();
				return;
			}

			if (pass.status === "running") {
				console.log(chalk.yellow(`  Pass ${pass.id} is still running after ${Math.round(maxWait / 1000)}s.`));
				console.log(chalk.dim("  Check `signet dream status` for the outcome."));
				console.log();
				return;
			}

			if (pass.status === "failed") {
				console.error(chalk.red("  Dreaming pass failed"));
				if (pass.error) console.error(chalk.red(`  Error: ${pass.error}`));
				process.exit(1);
			}

			console.log(chalk.green("  Dreaming pass complete"));
			console.log(`  ${chalk.dim("Pass ID:")}    ${pass.id}`);
			console.log(`  ${chalk.dim("Applied:")}    ${pass.mutationsApplied ?? 0} mutations`);
			console.log(`  ${chalk.dim("Skipped:")}    ${pass.mutationsSkipped ?? 0} mutations`);
			console.log(`  ${chalk.dim("Failed:")}     ${pass.mutationsFailed ?? 0} mutations`);
			if (pass.summary) console.log(`  ${chalk.dim("Summary:")}    ${pass.summary}`);
			console.log();
		});
}
