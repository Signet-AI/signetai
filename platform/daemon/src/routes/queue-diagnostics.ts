import { resolveKnowledgeReadScope } from "./read-scope";
import type { Context, Hono } from "hono";
import { requirePermission } from "../auth";
import type { DbAccessor } from "../db-accessor";
import { getDbAccessor } from "../db-accessor.js";
import {
	DEFAULT_QUEUE_THRESHOLDS,
	getQueueDiagnosticsSnapshotAsync,
	invalidateQueueDiagnosticsCache,
	type QueueThresholds,
} from "../diagnostics-queue.js";
import { loadMemoryConfig } from "../memory-config.js";
import {
	cancelObsoleteJobs,
	createRateLimiter,
	pruneTerminalJobs,
	type RepairContext,
	type RepairResult,
	requeueDeadJobs,
} from "../repair-actions.js";
import { jsonBody } from "../request-body";
import { authConfig as daemonAuthConfig, repairLimiter } from "./state.js";
import { resolveOperationalActor } from "./utils";

function resolveAgentsDir(): string {
	return process.env.SIGNET_AGENTS_DIR ?? process.env.AGENTS_DIR ?? `${process.env.HOME ?? "/tmp"}/.agents`;
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
	const dryRun = r.dryRun !== false;
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

function resolveRepairContext(c: Context): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "queue repair";
	const { actor, actorType } = resolveOperationalActor(c);
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

function repairHttpStatus(result: RepairResult): 200 | 410 | 429 | 500 {
	if (result.success) return 200;
	if (/summary worker retired/i.test(result.message)) return 410;
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

	app.get("/api/diagnostics/queue", adminGuard, async (c) => {
		const scope = await resolveKnowledgeReadScope(c, c.req.query("agent_id") ?? c.req.query("agentId"));
		try {
			const snapshot = await getQueueDiagnosticsSnapshotAsync(scope, deps.accessor);
			return c.json({
				timestamp: new Date().toISOString(),
				queues: { memory: snapshot.memory, summary: snapshot.summary },
				oldestDeadSummaryJob: snapshot.oldestDeadSummaryJob,
				oldestDeadMemoryJob: snapshot.oldestDeadMemoryJob,
				thresholds: loadThresholds(),
			});
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
		}
	});

	app.post("/api/diagnostics/queue/repair", adminGuard, async (c) => {
		if (c.get("organization"))
			return c.json({ error: "Queue repair has no content read scope", reason: "org_policy" }, 403);
		let rawBody: unknown;
		try {
			rawBody = await jsonBody(c)();
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
			result = await dispatchRepairWith(ctx, resolveAccessor(), limiter, parsed.action, options);
		} catch (err) {
			result = {
				action: parsed.action,
				success: false,
				affected: 0,
				message: err instanceof Error ? err.message : String(err),
			};
		}
		if (result.success && !parsed.dryRun) invalidateQueueDiagnosticsCache();
		const code = repairHttpStatus(result);
		return c.json(result, code as 200 | 410 | 429 | 500);
	});
}

async function dispatchRepairWith(
	ctx: RepairContext,
	accessor: DbAccessor,
	limiter: ReturnType<typeof createRateLimiter>,
	action: "requeue" | "cancel" | "prune",
	options: Record<string, unknown>,
): Promise<RepairResult> {
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
	if (action === "requeue") return await requeueDeadJobs(accessor, cfg, ctx, limiter, options as never);
	if (action === "cancel") return await cancelObsoleteJobs(accessor, cfg, ctx, limiter, options as never);
	return await pruneTerminalJobs(accessor, cfg, ctx, limiter, options as never);
}
