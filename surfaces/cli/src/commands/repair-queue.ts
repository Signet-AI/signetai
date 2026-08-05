/**
 * Issue #901 — register `signet repair queue {requeue|cancel|prune}`.
 *
 * All subcommands default to dry-run; --apply mutates. Mirrors
 * `POST /api/diagnostics/queue/repair` exactly.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { parseCsvFlag, parseDurationFlag, parseTablesFlag, runRepairQueue } from "../features/repair-queue.js";

export interface RepairQueueDeps {
	readonly apiCall: (
		method: string,
		path: string,
		body?: unknown,
	) => Promise<{ readonly ok: boolean; readonly data: unknown }>;
	readonly baseUrl: string;
}

/**
 * Parse the `--tables` enum list, routing an invalid value to a Commander
 * error (stderr + help + exit 1) instead of silently degrading into the
 * both-queue default (issue #1050).
 */
function parseTablesOption(value: unknown, program: Command): ("memory" | "summary")[] | undefined {
	try {
		return parseTablesFlag(typeof value === "string" ? value : undefined);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		program.error(`error: ${message}`);
		return undefined;
	}
}

export function registerRepairQueueCommands(program: Command, deps: RepairQueueDeps): void {
	const queue = program
		.command("repair")
		.description("Operator repair commands")
		.command("queue")
		.description("Repair the memory/summary job queues (issue #901)");

	queue
		.command("requeue")
		.description("Reset dead jobs to pending (default: dry-run)")
		.option("--ids <list>", "comma-separated ids to requeue")
		.option("--tables <list>", "memory|summary (default: both)")
		.option("--older-than <duration>", "e.g. 7d, 12h, 30m, 60000ms")
		.option("--error-pattern <pattern>", "LIKE %pattern% over error column")
		.option("--max-batch <n>", "cap on rows touched (default: 50)")
		.option("--apply", "mutate; without this the command only previews")
		.action(async (opts: Record<string, unknown>) => {
			const dryRun = opts.apply !== true;
			const tables = parseTablesOption(opts.tables, program);
			const result = await runRepairQueue(
				{
					action: "requeue",
					dryRun,
					ids: parseCsvFlag(typeof opts.ids === "string" ? opts.ids : undefined),
					tables,
					olderThanMs: parseDurationFlag(typeof opts.olderThan === "string" ? opts.olderThan : undefined),
					errorPattern: typeof opts.errorPattern === "string" ? opts.errorPattern : undefined,
					maxBatch: typeof opts.maxBatch === "string" ? Number(opts.maxBatch) : undefined,
				},
				{
					baseUrl: deps.baseUrl,
					apiCall: deps.apiCall,
					stdout: (line) => console.log(line),
					chalk,
				},
			);
			if (!result.success) {
				process.exitCode = 1;
			}
		});

	queue
		.command("cancel")
		.description("Cancel obsolete dead/completed jobs (audit-preserving). Default: dry-run.")
		.option("--ids <list>", "comma-separated ids")
		.option("--tables <list>", "memory|summary (default: both)")
		.option("--older-than <duration>", "default: 30d")
		.option("--error-pattern <pattern>", "LIKE %pattern% over error column")
		.option("--apply", "mutate; without this the command only previews")
		.action(async (opts: Record<string, unknown>) => {
			const dryRun = opts.apply !== true;
			const tables = parseTablesOption(opts.tables, program);
			const result = await runRepairQueue(
				{
					action: "cancel",
					dryRun,
					ids: parseCsvFlag(typeof opts.ids === "string" ? opts.ids : undefined),
					tables,
					olderThanMs: parseDurationFlag(typeof opts.olderThan === "string" ? opts.olderThan : undefined),
					errorPattern: typeof opts.errorPattern === "string" ? opts.errorPattern : undefined,
				},
				{
					baseUrl: deps.baseUrl,
					apiCall: deps.apiCall,
					stdout: (line) => console.log(line),
					chalk,
				},
			);
			if (!result.success) {
				process.exitCode = 1;
			}
		});

	queue
		.command("prune")
		.description("Prune cancelled/dead/completed jobs (archive-preserving). Default: dry-run.")
		.option("--ids <list>", "comma-separated ids")
		.option("--tables <list>", "memory|summary (default: both)")
		.option("--older-than <duration>", "retention window (default: 90d). All matched rows must be older than this.")
		.option("--max-batch <n>", "cap on rows touched (default: 1000, hard cap)")
		.option("--apply", "mutate; without this the command only previews")
		.action(async (opts: Record<string, unknown>) => {
			const dryRun = opts.apply !== true;
			const tables = parseTablesOption(opts.tables, program);
			const result = await runRepairQueue(
				{
					action: "prune",
					dryRun,
					ids: parseCsvFlag(typeof opts.ids === "string" ? opts.ids : undefined),
					tables,
					retentionMs: parseDurationFlag(typeof opts.olderThan === "string" ? opts.olderThan : undefined),
					maxBatch: typeof opts.maxBatch === "string" ? Number(opts.maxBatch) : undefined,
				},
				{
					baseUrl: deps.baseUrl,
					apiCall: deps.apiCall,
					stdout: (line) => console.log(line),
					chalk,
				},
			);
			if (!result.success) {
				process.exitCode = 1;
			}
		});
}
