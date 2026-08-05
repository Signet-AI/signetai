/**
 * Issue #901 — `signet repair queue` subcommands. They all default to
 * dry-run and require `--apply` to mutate. The HTTP path is
 * `POST /api/diagnostics/queue/repair`; this CLI is a thin wrapper.
 */

import chalk from "chalk";

export function getDaemonBaseUrl(port = 3850): string {
	return process.env.SIGNET_DAEMON_URL ?? `http://localhost:${port}`;
}

export interface RepairQueueActionResult {
	readonly action: string;
	readonly success: boolean;
	readonly affected: number;
	readonly message: string;
	readonly preview?: readonly string[];
	readonly totalMatching?: number;
}

export interface DispatchRepairArgs {
	readonly action: "requeue" | "cancel" | "prune";
	readonly dryRun: boolean;
	readonly ids?: readonly string[];
	readonly tables?: readonly ("memory" | "summary")[];
	readonly olderThanMs?: number;
	readonly errorPattern?: string;
	readonly retentionMs?: number;
	readonly maxBatch?: number;
}

export interface RepairQueueDeps {
	readonly apiCall: (
		method: string,
		path: string,
		body?: unknown,
	) => Promise<{ readonly ok: boolean; readonly data: unknown }>;
	readonly baseUrl: string;
	readonly chalk?: typeof chalk;
	readonly stdout: (line: string) => void;
}

export async function runRepairQueue(
	args: DispatchRepairArgs,
	deps: RepairQueueDeps,
): Promise<RepairQueueActionResult> {
	const body: Record<string, unknown> = {
		action: args.action,
		dryRun: args.dryRun,
	};
	if (args.ids && args.ids.length > 0) body.ids = [...args.ids];
	if (args.tables && args.tables.length > 0) body.tables = [...args.tables];
	if (args.olderThanMs !== undefined) body.olderThanMs = args.olderThanMs;
	if (args.errorPattern !== undefined && args.errorPattern !== "") body.errorPattern = args.errorPattern;
	if (args.retentionMs !== undefined) body.retentionMs = args.retentionMs;
	if (args.maxBatch !== undefined) body.maxBatch = args.maxBatch;

	const res = await deps.apiCall("POST", "/api/diagnostics/queue/repair", body);
	const data = res.data as Partial<RepairQueueActionResult> | undefined;
	const ok = res.ok && data && typeof data.action === "string";
	const result: RepairQueueActionResult = ok
		? (data as RepairQueueActionResult)
		: {
				action: args.action,
				success: false,
				affected: 0,
				message: `request failed: ${res.ok ? "no data" : "non-2xx"}`,
			};
	render(result, args.dryRun, deps);
	return result;
}

function render(result: RepairQueueActionResult, dryRun: boolean, deps: RepairQueueDeps): void {
	const c = deps.chalk ?? chalk;
	const head = dryRun ? c.yellow("[dry-run]") : result.success ? c.green("[apply]") : c.red("[denied]");
	deps.stdout(`${head} ${result.action}: ${result.message}`);
	if (typeof result.totalMatching === "number") {
		deps.stdout(`  total matching: ${result.totalMatching}`);
	}
	const preview = result.preview ?? [];
	if (preview.length > 0) {
		deps.stdout(`  preview (${preview.length}):`);
		for (const id of preview.slice(0, 10)) {
			deps.stdout(`    - ${id}`);
		}
		if (preview.length > 10) {
			deps.stdout(`    …and ${preview.length - 10} more`);
		}
	}
}

/** Parse `--ids=a,b,c` and `--tables=summary,memory` flags into arrays. */
export function parseCsvFlag(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Validate the `--tables` enum list. Returns the validated selectors, or
 * `undefined` when the flag was omitted (the intentional both-queue default).
 * Throws on any invalid value so a typo can never degrade into the broadest
 * repair selection (issue #1050).
 */
export function parseTablesFlag(value: string | undefined): ("memory" | "summary")[] | undefined {
	if (value === undefined) return undefined;
	const parts: ("memory" | "summary")[] = [];
	for (const rawPart of value.split(",")) {
		const part = rawPart.trim();
		if (part !== "memory" && part !== "summary") {
			throw new Error(`invalid --tables value "${part}"; expected memory or summary`);
		}
		parts.push(part);
	}
	return parts;
}

/** Parse `--older-than=7d` / `--older-than=12h` / `--older-than=30m` into ms. */
export function parseDurationFlag(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2];
	switch (unit) {
		case "ms":
			return n;
		case "s":
			return n * 1000;
		case "m":
			return n * 60 * 1000;
		case "h":
			return n * 60 * 60 * 1000;
		case "d":
			return n * 24 * 60 * 60 * 1000;
		default:
			return undefined;
	}
}
