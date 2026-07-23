/**
 * Issue #901 — surface queue diagnostics and provide a safe repair
 * endpoint. Mounted next to the existing `/api/diagnostics/*` and
 * `/api/repair/*` routes.
 *
 *  - `GET /api/diagnostics/queue` reads `getDiagnostics(...)` plus the
 *    oldest-dead summaries.
 *  - `POST /api/diagnostics/queue/repair` dispatches to
 *    `requeueDeadJobs` / `cancelObsoleteJobs` / `pruneTerminalJobs`
 *    with the caller's filters. Always dry-runs unless the request
 *    body sets `dryRun: false`.
 */

import type { Hono } from "hono";
import { requirePermission } from "../auth";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { getDbAccessor } from "../db-accessor.js";
import {
	DEFAULT_QUEUE_THRESHOLDS,
	type QueueCounts,
	type QueueThresholds,
	type getOldestDeadJob,
	getQueueDiagnosticsSnapshot,
	invalidateQueueDiagnosticsCache,
} from "../diagnostics-queue.js";
import { loadMemoryConfig } from "../memory-config.js";
import {
	type RepairContext,
	type RepairResult,
	cancelObsoleteJobs,
	createRateLimiter,
	pruneTerminalJobs,
	requeueDeadJobs,
} from "../repair-actions.js";
import { authConfig as daemonAuthConfig, repairLimiter } from "./state.js";

function resolveAgentsDir(): string {
	return process.env.SIGNET_AGENTS_DIR ?? process.env.AGENTS_DIR ?? `${process.env.HOME ?? "/tmp"}/.agents`;
}

interface QueueDiagnosticsResponse {
	readonly timestamp: string;
	readonly queues: {
		readonly memory: QueueCounts;
		readonly summary: QueueCounts;
		readonly extraction: QueueCounts;
	};
	readonly oldestDeadSummaryJob: ReturnType<typeof getOldestDeadJob>;
	readonly oldestDeadMemoryJob: ReturnType<typeof getOldestDeadJob>;
	readonly oldestDeadExtractionJob: ReturnType<typeof getOldestDeadJob>;
	readonly thresholds: QueueThresholds;
}

function loadThresholds(): QueueThresholds {
	try {
		const cfg = loadMemoryConfig(resolveAgentsDir());
		const block = (cfg.pipelineV2 as unknown as { health?: { queue?: Partial<QueueThresholds> } }).health?.queue;
		if (!block) return DEFAULT_QUEUE_THRESHOLDS;
		return { ...DEFAULT_QUEUE_THRESHOLDS, ...block };
	} catch {
		return DEFAULT_QUEUE_THRESHOLDS;
	}
}

function buildQueueDiagnosticsResponse(db: ReadDb): QueueDiagnosticsResponse {
	const snapshot = getQueueDiagnosticsSnapshot(db, { fresh: true });
	return {
		timestamp: new Date().toISOString(),
		queues: {
			memory: snapshot.memory,
			summary: snapshot.summary,
			extraction: snapshot.extraction,
		},
		oldestDeadSummaryJob: snapshot.oldestDeadSummaryJob,
		oldestDeadMemoryJob: snapshot.oldestDeadMemoryJob,
		oldestDeadExtractionJob: snapshot.oldestDeadExtractionJob,
		thresholds: loadThresholds(),
	};
}

interface RepairRequestBody {
	readonly action?: unknown;
	readonly dryRun?: unknown;
	readonly ids?: unknown;
	readonly tables?: unknown;
	readonly olderThanMs?: unknown;
	readonly errorPattern?: unknown;
	readonly retentionMs?: unknown;
	readonly maxBatch?: unknown;
}

function parseRepairBody(body: unknown): {
	action: "requeue" | "cancel" | "prune";
	dryRun: boolean;
	options: {
		ids?: readonly string[];
		tables?: readonly ("memory" | "summary")[];
		olderThanMs?: number;
		errorPattern?: string;
		retentionMs?: number;
		maxBatch?: number;
	};
} | null {
	if (!body || typeof body !== "object") return null;
	const r = body as RepairRequestBody;
	const actionRaw = typeof r.action === "string" ? r.action.toLowerCase() : "";
	if (actionRaw !== "requeue" && actionRaw !== "cancel" && actionRaw !== "prune") {
		return null;
	}
	const dryRun = r.dryRun !== false; // default to dry-run for safety
	const ids: string[] = Array.isArray(r.ids)
		? r.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
		: [];
	const tables: ("memory" | "summary")[] = Array.isArray(r.tables)
		? r.tables.filter((v): v is "memory" | "summary" => v === "memory" || v === "summary")
		: [];
	const options: {
		ids?: readonly string[];
		tables?: readonly ("memory" | "summary")[];
		olderThanMs?: number;
		errorPattern?: string;
		retentionMs?: number;
		maxBatch?: number;
	} = {};
	if (ids.length > 0) options.ids = ids;
	if (tables.length > 0) options.tables = tables;
	if (typeof r.olderThanMs === "number" && r.olderThanMs > 0) options.olderThanMs = r.olderThanMs;
	if (typeof r.errorPattern === "string" && r.errorPattern.length > 0) options.errorPattern = r.errorPattern;
	if (typeof r.retentionMs === "number" && r.retentionMs > 0) options.retentionMs = r.retentionMs;
	if (typeof r.maxBatch === "number" && r.maxBatch > 0) options.maxBatch = r.maxBatch;
	return { action: actionRaw, dryRun, options };
}

function resolveRepairContext(c: { req: { header(name: string): string | undefined } }): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "queue repair";
	const actor = c.req.header("x-signet-actor") ?? "operator";
	const actorType = (c.req.header("x-signet-actor-type") ?? "operator") as "operator" | "agent" | "daemon";
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

function repairHttpStatus(result: RepairResult): 200 | 429 | 500 {
	if (result.success) return 200;
	if (
		/cooldown active|hourly budget exhausted|denied by policy gate|autonomous\.|agents cannot trigger repairs/i.test(
			result.message,
		)
	) {
		return 429;
	}
	return 500;
}

export function registerQueueDiagnosticsRoutes(
	app: Hono,
	deps: {
		accessor?: DbAccessor;
		limiter?: ReturnType<typeof createRateLimiter>;
		authConfig?: Parameters<typeof requirePermission>[1];
	} = {},
): void {
	const adminGuard = requirePermission("admin", deps.authConfig ?? daemonAuthConfig);
	const limiter = deps.limiter ?? repairLimiter ?? createRateLimiter();

	function resolveAccessor(): DbAccessor {
		return deps.accessor ?? getDbAccessor();
	}

	app.get("/api/diagnostics/queue", adminGuard, (c) => {
		try {
			const response = resolveAccessor().withReadDb((db) => buildQueueDiagnosticsResponse(db));
			return c.json(response);
		} catch (err) {
			return c.json({ error: (err as Error).message }, 500);
		}
	});

	app.post("/api/diagnostics/queue/repair", adminGuard, async (c) => {
		let rawBody: unknown;
		try {
			rawBody = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const parsed = parseRepairBody(rawBody);
		if (!parsed) {
			return c.json({ error: "missing or invalid action" }, 400);
		}
		const ctx = resolveRepairContext(c);
		const options = { dryRun: parsed.dryRun, ...parsed.options };
		let result: RepairResult;
		try {
			result = dispatchRepairWith(ctx, resolveAccessor(), limiter, parsed.action, options);
		} catch (err) {
			// Repair actions throw synchronously from inside withWriteTx (e.g. a
			// missing migrations table, a closed DbAccessor, or a SQLite error).
			// Mirror the GET sibling and the Rust parity handler by returning the
			// documented structured RepairResult instead of an unstructured 500.
			result = {
				action: parsed.action,
				success: false,
				affected: 0,
				message: err instanceof Error ? err.message : String(err),
			};
		}
		if (result.success && !parsed.dryRun) invalidateQueueDiagnosticsCache();
		const code = repairHttpStatus(result);
		return c.json(result, code as 200 | 429 | 500);
	});
}

function dispatchRepairWith(
	ctx: RepairContext,
	accessor: DbAccessor,
	limiter: ReturnType<typeof createRateLimiter>,
	action: "requeue" | "cancel" | "prune",
	options: Record<string, unknown>,
): RepairResult {
	let cfg: ReturnType<typeof loadMemoryConfig>["pipelineV2"];
	try {
		cfg = loadMemoryConfig(resolveAgentsDir()).pipelineV2;
	} catch (err) {
		return {
			action,
			success: false,
			affected: 0,
			message: `config unavailable: ${(err as Error).message}`,
		};
	}
	if (action === "requeue") return requeueDeadJobs(accessor, cfg, ctx, limiter, options as never);
	if (action === "cancel") return cancelObsoleteJobs(accessor, cfg, ctx, limiter, options as never);
	return pruneTerminalJobs(accessor, cfg, ctx, limiter, options as never);
}
