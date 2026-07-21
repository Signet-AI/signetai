/**
 * signet ingest — thin HTTP client over the daemon's unified ingest queue
 * (#913). Mirrors `signet dream`: the daemon is the single writer, this CLI
 * only talks HTTP. The agentic two-phase contract is fixed — built against it
 * exactly:
 *
 *   POST /api/ingest/lease        {agent_id, context_budget?}
 *     → {eligible, jobId, leaseToken, leaseExpiresAt,
 *        context:{source, dreamingMd, graphSlice, focalEntityIds, budget, tokens, oversize}}
 *   POST /api/ingest/apply-plan   {plan, lease_token}
 *     → {jobId, completed, memories[], graph, filePatches[], planHash}
 *   GET  /api/ingest/status
 *     → {agentId, queue:{pending, active, dead}}
 *
 * Daemon-down / non-200 surface as a clear structured error (reason category +
 * HTTP status). The daemon base URL (SIGNET_HOST/port), auth header, and
 * timeouts come from the shared daemon-client helper (`fetchDaemonResult`),
 * the same variant `signet hook` uses for structured lifecycle errors. Status
 * passes the agent via the `x-signet-agent-id` header because the GET route
 * does not parse a body.
 */

import { readFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";

type IngestFetchReason = "offline" | "timeout" | "http" | "invalid-json";

type IngestFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly reason: IngestFetchReason; readonly status?: number };

/** The failure branch of {@link IngestFetchResult}, for error-reporting helpers. */
type IngestFetchFailure = Extract<IngestFetchResult<unknown>, { readonly ok: false }>;

export interface IngestDeps {
	readonly fetchDaemonResult: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<IngestFetchResult<T>>;
}

// ---------------------------------------------------------------------------
// Response shapes (mirror the daemon's /api/ingest/* contract — #913).
// All fields optional on the client side: the CLI renders defensively and
// never trusts shape beyond what fetchDaemonResult parsed as JSON.
// ---------------------------------------------------------------------------

interface IngestSourceContext {
	readonly kind?: string;
	readonly id?: string;
	readonly content?: string;
	readonly sourceKind?: string;
	readonly sourceId?: string;
	readonly sourcePath?: string | null;
	readonly project?: string | null;
}

interface IngestLeaseContext {
	readonly source?: IngestSourceContext;
	readonly dreamingMd?: string;
	readonly graphSlice?: string;
	readonly focalEntityIds?: readonly string[];
	readonly budget?: { readonly window?: number; readonly inputBudget?: number };
	readonly tokens?: {
		readonly source?: number;
		readonly dreamingMd?: number;
		readonly graphSlice?: number;
		readonly total?: number;
	};
	readonly oversize?: boolean;
}

interface IngestLeaseResponse {
	readonly eligible: boolean;
	readonly jobId: string | null;
	readonly leaseToken?: string;
	readonly leaseExpiresAt?: string;
	readonly context?: IngestLeaseContext;
}

interface IngestApplyResponse {
	readonly jobId?: string;
	readonly completed: boolean;
	readonly memories?: readonly { readonly outcome?: string; readonly reason?: string }[];
	readonly graph?: { readonly applied?: number; readonly failed?: number; readonly errors?: readonly string[] };
	readonly filePatches?: readonly { readonly outcome?: string; readonly reason?: string }[];
	readonly planHash?: string;
}

interface IngestStatusResponse {
	readonly agentId?: string;
	readonly queue?: { readonly pending?: number; readonly active?: number; readonly dead?: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPLY_TIMEOUT_MS = 120_000; // embed + graph ops + file patches can run long
const LEASE_TIMEOUT_MS = 15_000; // graph-slice query + DREAMING.md read

function parsePositiveInt(value: string | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	const parsed = Number.parseInt(trimmed, 10);
	if (!/^\d+$/.test(trimmed) || Number.isNaN(parsed) || parsed <= 0) {
		console.error(chalk.red(`  Invalid ${label} value: "${value}" (must be a positive integer)`));
		process.exit(1);
	}
	return parsed;
}

/** Load and JSON-parse the plan file, exiting with a clear error on failure. */
function loadPlanFile(filePath: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (e) {
		console.error(
			chalk.red(`  Could not read plan file "${filePath}": ${e instanceof Error ? e.message : String(e)}`),
		);
		process.exit(1);
	}
	try {
		return JSON.parse(raw);
	} catch (e) {
		console.error(
			chalk.red(`  Plan file "${filePath}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`),
		);
		process.exit(1);
	}
}

/**
 * Surface a fetchDaemonResult failure as a clear structured error and exit.
 * The reason category distinguishes daemon-down (offline/timeout) from a
 * reachable daemon that returned a non-200 (http) or a non-JSON body.
 */
function reportIngestError(res: IngestFetchFailure, op: string): never {
	console.error(chalk.red(`  Failed to ${op}.`));
	switch (res.reason) {
		case "offline":
			console.error(chalk.red("  Could not reach the Signet daemon. Start it with: signet daemon start"));
			break;
		case "timeout":
			console.error(chalk.red("  Request timed out waiting for the Signet daemon."));
			break;
		case "http":
			console.error(chalk.red(`  Daemon returned HTTP ${res.status ?? "unknown"}.`));
			break;
		case "invalid-json":
			console.error(chalk.red("  Daemon returned a non-JSON response."));
			break;
	}
	process.exit(1);
}

function countOutcomes(items: readonly { readonly outcome?: string }[]): {
	readonly applied: number;
	readonly skipped: number;
	readonly failed: number;
} {
	let applied = 0;
	let skipped = 0;
	let failed = 0;
	for (const it of items) {
		if (it.outcome === "applied") applied++;
		else if (it.outcome === "skipped") skipped++;
		else failed++;
	}
	return { applied, skipped, failed };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIngestCommands(program: Command, deps: IngestDeps): void {
	const ingest = program
		.command("ingest")
		.description("Drive the unified ingest queue over HTTP (agentic two-phase protocol)");

	ingest
		.command("lease")
		.description("Lease the next eligible ingest job and print the planning context bundle")
		.option("--agent <id>", "Agent scope (defaults to the daemon's default agent)")
		.option("--context-budget <tokens>", "Effective context window in tokens (declared to the daemon)")
		.option("--json", "Print the full lease response as JSON")
		.action(
			async (opts: { agent?: string; contextBudget?: string; json?: boolean }) => {
				const body: Record<string, unknown> = {};
				if (opts.agent) body.agent_id = opts.agent;
				const contextBudget = parsePositiveInt(opts.contextBudget, "--context-budget");
				if (contextBudget !== undefined) body.context_budget = contextBudget;

				const res = await deps.fetchDaemonResult<IngestLeaseResponse>("/api/ingest/lease", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					timeout: LEASE_TIMEOUT_MS,
				});
				if (!res.ok) return reportIngestError(res, "lease ingest job");

				const data = res.data;
				if (opts.json) {
					console.log(JSON.stringify(data, null, 2));
					return;
				}

				console.log(chalk.bold("\n  Ingest Lease\n"));

				if (!data.eligible || !data.jobId) {
					// 200 + eligible:false — no pending work. Not an error.
					console.log(chalk.dim("  No eligible ingest jobs in the queue."));
					console.log(JSON.stringify({ eligible: false, jobId: null }));
					console.log();
					return;
				}

				console.log(`  ${chalk.dim("Job ID:")}        ${data.jobId}`);
				console.log(`  ${chalk.dim("Lease Token:")}   ${data.leaseToken ?? ""}`);
				if (data.leaseExpiresAt) console.log(`  ${chalk.dim("Expires At:")}   ${data.leaseExpiresAt}`);

				const ctx = data.context;
				if (ctx) {
					const sourceLen = ctx.source?.content?.length ?? 0;
					const oversize = ctx.oversize === true ? chalk.yellow("yes") : chalk.green("no");
					console.log(`  ${chalk.dim("Source:")}       ${ctx.source?.kind ?? "unknown"} (${sourceLen} chars)`);
					console.log(`  ${chalk.dim("Tokens:")}       ${ctx.tokens?.source ?? "?"} source / ${ctx.tokens?.total ?? "?"} total`);
					console.log(`  ${chalk.dim("Budget:")}       ${ctx.budget?.inputBudget ?? "?"} of ${ctx.budget?.window ?? "?"} tokens`);
					console.log(`  ${chalk.dim("Oversize:")}     ${oversize}`);
					if ((ctx.focalEntityIds?.length ?? 0) > 0) {
						console.log(`  ${chalk.dim("Focal:")}        ${ctx.focalEntityIds!.length} entit(y|ies)`);
					}
				}

				// Machine-readable trailer so a harness can consume the lease without
				// parsing the human block. Use --json for the full bundle.
				console.log(
					`\nlease_token=${data.leaseToken ?? ""} job_id=${data.jobId} eligible=true\n`,
				);
			},
		);

	ingest
		.command("apply-plan")
		.description("Apply an authored IngestPlan back under a held lease (the daemon is the single writer)")
		.requiredOption("--file <path>", "Path to a JSON IngestPlan file")
		.requiredOption("--lease-token <token>", "Lease token returned by `signet ingest lease`")
		.option("--agent <id>", "Agent scope (validated against plan.agentId when present)")
		.option("--json", "Print the full apply response as JSON")
		.action(
			async (opts: { file: string; leaseToken: string; agent?: string; json?: boolean }) => {
				const plan = loadPlanFile(opts.file);

				// Optional client-side guard: catch a harness wiring mismatch before
				// the round-trip. The daemon authoritatively derives the agent from
				// the leased job; --agent is not sent (the body contract is fixed).
				if (opts.agent && plan !== null && typeof plan === "object") {
					const planAgent = Reflect.get(plan as Record<string, unknown>, "agentId");
					if (typeof planAgent === "string" && planAgent.length > 0 && planAgent !== opts.agent) {
						console.error(
							chalk.red(
								`  --agent "${opts.agent}" does not match plan.agentId "${planAgent}". Aborting before apply.`,
							),
						);
						process.exit(1);
					}
				}

				const res = await deps.fetchDaemonResult<IngestApplyResponse>("/api/ingest/apply-plan", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ plan, lease_token: opts.leaseToken }),
					timeout: APPLY_TIMEOUT_MS,
				});
				if (!res.ok) return reportIngestError(res, "apply ingest plan");

				const data = res.data;
				if (opts.json) {
					console.log(JSON.stringify(data, null, 2));
					return;
				}

				console.log(chalk.bold("\n  Ingest Apply\n"));
				const status = data.completed ? chalk.green("completed") : chalk.yellow("not completed");
				console.log(`  ${chalk.dim("Status:")}      ${status}`);
				if (data.jobId) console.log(`  ${chalk.dim("Job ID:")}      ${data.jobId}`);
				if (data.planHash) console.log(`  ${chalk.dim("Plan hash:")}   ${data.planHash}`);

				const mem = countOutcomes(data.memories ?? []);
				console.log(
					`  ${chalk.dim("Memories:")}    ${mem.applied} applied / ${mem.skipped} skipped / ${mem.failed} failed`,
				);

				const graph = data.graph;
				if (graph) {
					console.log(
						`  ${chalk.dim("Graph:")}        ${graph.applied ?? 0} applied / ${graph.failed ?? 0} failed`,
					);
					for (const err of graph.errors ?? []) console.log(chalk.red(`    ${err}`));
				}

				const fp = countOutcomes(data.filePatches ?? []);
				console.log(
					`  ${chalk.dim("File patches:")} ${fp.applied} applied / ${fp.skipped} skipped / ${fp.failed} failed`,
				);
				console.log();
			},
		);

	ingest
		.command("status")
		.description("Show the per-agent ingest queue depth (pending / active / dead)")
		.option("--agent <id>", "Agent scope (defaults to the daemon's default agent)")
		.option("--json", "Print the full status response as JSON")
		.action(async (opts: { agent?: string; json?: boolean }) => {
			// The GET route reads the agent from the x-signet-agent-id header only
			// (no body parse on GET), so scope via the header, not a body.
			const headers: Record<string, string> = {};
			if (opts.agent) headers["x-signet-agent-id"] = opts.agent;

			const res = await deps.fetchDaemonResult<IngestStatusResponse>("/api/ingest/status", {
				method: "GET",
				headers,
			});
			if (!res.ok) return reportIngestError(res, "read ingest status");

			const data = res.data;
			if (opts.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}

			const q = data.queue;
			console.log(chalk.bold("\n  Ingest Queue\n"));
			console.log(`  ${chalk.dim("Agent:")}    ${data.agentId ?? "default"}`);
			console.log(`  ${chalk.dim("Pending:")}  ${q?.pending ?? 0}`);
			console.log(`  ${chalk.dim("Active:")}   ${q?.active ?? 0}`);
			console.log(`  ${chalk.dim("Dead:")}     ${q?.dead ?? 0}`);
			console.log();
		});
}
