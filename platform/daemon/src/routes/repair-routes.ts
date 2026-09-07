import type { Context, Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { type AuthConfig, requirePermission } from "../auth";
import { type DbAccessor, getDbAccessor } from "../db-accessor.js";
import { fetchEmbedding } from "../embedding-fetch.js";
import { linkMemoryToEntities, previewMemoryEntityLinks } from "../inline-entity-linker.js";
import { loadMemoryConfig } from "../memory-config.js";
import type { ResolvedPipelineV2Config } from "../memory-config.js";
import { clusterEntities } from "../pipeline/community-detection.js";
import { DEFAULT_RETENTION, runRetentionSweepOnce } from "../pipeline/retention-worker.js";
import { resolveScopedAgent } from "../request-scope";
import {
	type RepairContext,
	type RepairResult,
	type RateLimiter,
	runRepairWithAdmission,
	checkFtsConsistency,
	cleanOrphanedEmbeddings,
	deduplicateMemories,
	findDeadMemories,
	forgetDeadMemories,
	getDedupStats,
	getEmbeddingGapStats,
	integrityCheck,
	pruneChunkGroupEntities,
	pruneGenericEntities,
	pruneSingletonExtractedEntities,
	rebuildDerivedIndexes,
	reembedMissingMemories,
	reembedModelMigration,
	releaseStaleLeases,
	requeueDeadJobs,
	resyncVectorIndex,
} from "../repair-actions.js";
import { which } from "../which.js";
import { AGENTS_DIR, authConfig, repairLimiter } from "./state.js";

function resolveRepairContext(c: Context): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "manual repair";
	const actor = c.req.header("x-signet-actor") ?? "operator";
	const actorType = (c.req.header("x-signet-actor-type") ?? "operator") as "operator" | "agent" | "daemon";
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

function repairHttpStatus(result: RepairResult): 200 | 429 | 500 {
	if (result.success) return 200;
	if (result.code === "repair_admission_denied") return 429;
	if (
		/repair admission|cooldown active|hourly budget exhausted|denied by policy gate|autonomous\.|agents cannot trigger repairs|already in progress/i.test(
			result.message,
		)
	) {
		return 429;
	}
	return 500;
}

type RouteRepairOutcome = RepairResult;

async function runRouteRepair<T extends RouteRepairOutcome>(
	accessor: DbAccessor,
	cfg: ResolvedPipelineV2Config,
	ctx: RepairContext,
	limiter: RateLimiter,
	action: string,
	cooldownMs: number,
	hourlyBudget: number,
	scope: string | undefined,
	dryRun: boolean,
	denied: (message: string, retryAfterMs?: number) => T,
	work: () => Promise<T>,
): Promise<T> {
	return await runRepairWithAdmission(
		accessor,
		cfg,
		ctx,
		limiter,
		action,
		cooldownMs,
		hourlyBudget,
		scope ?? "global",
		dryRun,
		denied,
		work,
	);
}

function repairResponse(c: Context, result: RepairResult): Response {
	const headers: Record<string, string> = {};
	if (result.retryAfterMs !== undefined) {
		headers["Retry-After"] = String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
	}
	return c.json(result, repairHttpStatus(result), headers);
}

interface RelinkRepairResult extends RepairResult {
	readonly dryRun: boolean;
	readonly processed: number;
	readonly linked: number;
	readonly entities: number;
	readonly aspects: number;
	readonly attributes: number;
	readonly remaining: number;
	readonly projectedRemaining?: number;
}

async function relinkEntities(
	accessor: DbAccessor,
	agentId: string,
	batchSize: number,
	dryRun: boolean,
): Promise<RelinkRepairResult> {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const unlinked = accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			db
				.prepare(
					`SELECT id, content FROM memories
				 WHERE is_deleted = 0
				   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?
				   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)
				 LIMIT ?`,
				)
				.all(agentId, batchSize) as Array<{ id: string; content: string }>,
		"db:repair.relink-entities.select",
	);

	if (unlinked.length === 0) {
		return {
			action: "relink-entities",
			success: true,
			affected: 0,
			message: "all memories linked",
			dryRun,
			processed: 0,
			linked: 0,
			entities: 0,
			aspects: 0,
			attributes: 0,
			remaining: 0,
			...(dryRun ? { projectedRemaining: 0 } : {}),
		};
	}

	if (dryRun) {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const preview = accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
			let linked = 0;
			let entities = 0;
			let aspects = 0;
			let attributes = 0;
			let linkedMemories = 0;

			for (const mem of unlinked) {
				const result = previewMemoryEntityLinks(db, mem.id, mem.content, agentId);
				linked += result.linked;
				entities += result.entityIds.length;
				aspects += result.aspects;
				attributes += result.attributes;
				if (result.linked > 0) linkedMemories++;
			}

			const remaining = (
				db
					.prepare(
						`SELECT COUNT(*) as cnt FROM memories
							 WHERE is_deleted = 0
							   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?
							   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)`,
					)
					.get(agentId) as { cnt: number }
			).cnt;

			return { linked, entities, aspects, attributes, linkedMemories, remaining };
		}, "db:repair.relink-entities.preview");
		const projectedRemaining = Math.max(0, preview.remaining - preview.linkedMemories);
		return {
			action: "relink-entities",
			success: true,
			affected: 0,
			message: `dry run: ${preview.linked} link(s) would be added across ${preview.linkedMemories} memories; ${projectedRemaining} would remain unlinked`,
			dryRun: true,
			processed: unlinked.length,
			linked: preview.linked,
			entities: preview.entities,
			aspects: preview.aspects,
			attributes: preview.attributes,
			remaining: preview.remaining,
			projectedRemaining,
		};
	}

	let linked = 0;
	let entities = 0;
	let aspects = 0;
	let attributes = 0;
	for (const mem of unlinked) {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		const result = accessor.withWriteTx(
			(db: import("../db-accessor").WriteDb) => linkMemoryToEntities(db, mem.id, mem.content, agentId),
			"db:repair.relink-entities.write",
		);
		linked += result.linked;
		entities += result.entityIds.length;
		aspects += result.aspects;
		attributes += result.attributes;
	}

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const remaining = accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			(
				db
					.prepare(
						`SELECT COUNT(*) as cnt FROM memories
						 WHERE is_deleted = 0
						   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?
						   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)`,
					)
					.get(agentId) as { cnt: number }
			).cnt,
		"db:repair.relink-entities.remaining",
	);
	return {
		action: "relink-entities",
		success: true,
		affected: linked,
		message: remaining > 0 ? `${remaining} memories still need linking — call again` : "all memories linked",
		dryRun: false,
		processed: unlinked.length,
		linked,
		entities,
		aspects,
		attributes,
		remaining,
	};
}

interface BackfillHintsResult extends RepairResult {
	readonly enqueued: number;
	readonly remaining: number;
}

interface ClusterRepairResult extends RouteRepairOutcome {
	readonly action: string;
	readonly communities: number;
	readonly modularity: number;
	readonly quality: "fragmented" | "moderate" | "strong";
	readonly members: ReadonlyArray<{
		readonly id: string;
		readonly name: string | null;
		readonly count: number;
		readonly cohesion: number;
	}>;
	readonly code?: "repair_admission_denied";
	readonly retryAfterMs?: number;
	readonly message: string;
}

interface ForgetRepairResult extends RepairResult {
	readonly forgotten: number;
}

async function backfillHints(accessor: DbAccessor, batchSize: number): Promise<BackfillHintsResult> {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const unhinted = accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			db
				.prepare(
					`SELECT m.id, m.content FROM memories m
					 WHERE m.is_deleted = 0 AND m.scope IS NULL
					   AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)
					 ORDER BY m.created_at DESC
					 LIMIT ?`,
				)
				.all(batchSize) as Array<{ id: string; content: string }>,
		"db:repair.backfill-hints.select",
	);
	if (unhinted.length === 0) {
		return {
			action: "backfill-hints",
			success: true,
			affected: 0,
			enqueued: 0,
			remaining: 0,
			message: "all unscoped memories have hints",
		};
	}

	const { enqueueHintsJob: enqueue } = await import("../pipeline/prospective-index.js");
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		for (const mem of unhinted) enqueue(db, mem.id, mem.content);
	}, "db:repair.backfill-hints.enqueue");
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const remaining = accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			(
				db
					.prepare(
						`SELECT COUNT(*) as cnt FROM memories
						 WHERE is_deleted = 0 AND scope IS NULL
						   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)`,
					)
					.get() as { cnt: number }
			).cnt,
		"db:repair.backfill-hints.remaining",
	);
	return {
		action: "backfill-hints",
		success: true,
		affected: unhinted.length,
		enqueued: unhinted.length,
		remaining,
		message:
			remaining > 0
				? `${remaining} unscoped memories still need hints — call again`
				: "all unscoped memories have hints",
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function registerRepairRoutes(
	app: Hono,
	deps: {
		readonly authConfig?: AuthConfig;
		readonly getDbAccessor?: () => DbAccessor;
		readonly limiter?: RateLimiter;
		readonly pipelineConfig?: ResolvedPipelineV2Config;
	} = {},
): void {
	const effectiveAuthConfig = deps.authConfig ?? authConfig;
	const resolveAccessor = (): DbAccessor => deps.getDbAccessor?.() ?? getDbAccessor();
	const limiter = deps.limiter ?? repairLimiter;

	// Permission guards
	app.use("/api/repair/*", async (c, next) => {
		return requirePermission("admin", effectiveAuthConfig)(c, next);
	});
	app.use("/api/troubleshoot/*", async (c, next) => {
		return requirePermission("admin", effectiveAuthConfig)(c, next);
	});

	app.post("/api/repair/requeue-dead", async (c) => {
		const pipeline = deps.pipelineConfig ?? loadMemoryConfig(AGENTS_DIR).pipelineV2;
		const ctx = resolveRepairContext(c);
		const result = await requeueDeadJobs(resolveAccessor(), pipeline, ctx, limiter);
		return repairResponse(c, result);
	});

	app.post("/api/repair/release-leases", async (c) => {
		const pipeline = deps.pipelineConfig ?? loadMemoryConfig(AGENTS_DIR).pipelineV2;
		const ctx = resolveRepairContext(c);
		const result = await releaseStaleLeases(resolveAccessor(), pipeline, ctx, limiter);
		return repairResponse(c, result);
	});

	app.post("/api/repair/check-fts", async (c) => {
		const pipeline = deps.pipelineConfig ?? loadMemoryConfig(AGENTS_DIR).pipelineV2;
		const ctx = resolveRepairContext(c);
		let repair = false;
		try {
			const body = await c.req.json();
			repair = body?.repair === true;
		} catch {
			// no body or invalid JSON — default repair=false
		}
		const result = await checkFtsConsistency(resolveAccessor(), pipeline, ctx, limiter, repair);
		return repairResponse(c, result);
	});

	app.post("/api/repair/retention-sweep", async (c) => {
		const pipeline = deps.pipelineConfig ?? loadMemoryConfig(AGENTS_DIR).pipelineV2;
		const accessor = resolveAccessor();
		const ctx = resolveRepairContext(c);
		const result = await runRouteRepair<RepairResult>(
			accessor,
			pipeline,
			ctx,
			limiter,
			"triggerRetentionSweep",
			pipeline.repair.requeueCooldownMs,
			pipeline.repair.requeueHourlyBudget,
			undefined,
			false,
			(message, retryAfterMs) => ({
				action: "triggerRetentionSweep",
				success: false,
				affected: 0,
				message,
				code: "repair_admission_denied" as const,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
			async () => {
				const details = await runRetentionSweepOnce(accessor, DEFAULT_RETENTION);
				const affected =
					details.graphLinksPurged +
					details.entitiesOrphaned +
					details.embeddingsPurged +
					details.tombstonesPurged +
					details.historyPurged +
					details.completedJobsPurged +
					details.deadJobsPurged;
				return {
					action: "retention_sweep",
					success: true,
					affected,
					message: `retention sweep completed; ${affected} row(s) purged`,
					details: { ...details },
				};
			},
		);
		return repairResponse(c, result);
	});

	app.get("/api/repair/embedding-gaps", async (c) => {
		const accessor = deps.getDbAccessor?.() ?? getDbAccessor();
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const stats = await getEmbeddingGapStats(accessor, scoped.agentId);
		return c.json(stats);
	});

	app.post("/api/repair/re-embed", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const accessor = resolveAccessor();
		const ctx = resolveRepairContext(c);
		let batchSize = 50;
		let dryRun = false;
		let fullSweep = false;

		let body: Record<string, unknown> = {};
		try {
			body = asRecord(await c.req.json());
			if (typeof body.batchSize === "number") batchSize = body.batchSize;
			if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
			if (typeof body.fullSweep === "boolean") fullSweep = body.fullSweep;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			readString(body, "agentId") ??
				readString(body, "agent_id") ??
				c.req.query("agentId") ??
				c.req.query("agent_id") ??
				c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);

		const result = await reembedMissingMemories(
			accessor,
			cfg.pipelineV2,
			ctx,
			limiter,
			fetchEmbedding,
			cfg.embedding,
			scoped.agentId,
			batchSize,
			dryRun,
			fullSweep,
		);

		return repairResponse(c, result);
	});

	app.post("/api/repair/re-embed-migration", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const body = asRecord(await c.req.json().catch(() => ({})));
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			readString(body, "agentId") ??
				readString(body, "agent_id") ??
				c.req.query("agentId") ??
				c.req.query("agent_id") ??
				c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const result = await reembedModelMigration(
			resolveAccessor(),
			cfg.pipelineV2,
			resolveRepairContext(c),
			limiter,
			fetchEmbedding,
			cfg.embedding,
			scoped.agentId,
			typeof body.batchSize === "number" ? body.batchSize : 50,
			body.dryRun === true,
			body.all === true,
		);
		return repairResponse(c, result);
	});

	app.post("/api/repair/resync-vec", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = await resyncVectorIndex(resolveAccessor(), cfg.pipelineV2, ctx, limiter);
		return repairResponse(c, result);
	});

	app.post("/api/repair/clean-orphans", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const result = await cleanOrphanedEmbeddings(
			resolveAccessor(),
			cfg.pipelineV2,
			ctx,
			limiter,
			Number.MAX_SAFE_INTEGER,
			scoped.agentId,
		);
		return repairResponse(c, result);
	});

	app.get("/api/repair/dedup-stats", async (c) => {
		const stats = await getDedupStats(getDbAccessor());
		return c.json(stats);
	});

	app.post("/api/repair/deduplicate", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const options: {
			batchSize?: number;
			dryRun?: boolean;
			semanticThreshold?: number;
			semanticEnabled?: boolean;
		} = {};
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") options.batchSize = body.batchSize;
			if (typeof body?.dryRun === "boolean") options.dryRun = body.dryRun;
			if (typeof body?.semanticThreshold === "number") options.semanticThreshold = body.semanticThreshold;
			if (typeof body?.semanticEnabled === "boolean") options.semanticEnabled = body.semanticEnabled;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const result = await deduplicateMemories(resolveAccessor(), cfg.pipelineV2, ctx, limiter, options);
		return repairResponse(c, result);
	});

	app.post("/api/repair/backfill-skipped", (c) =>
		c.json(
			{
				error:
					"backfill-skipped is retired; session transcripts are completed at session end and consumed directly by Dreaming",
			},
			410,
		),
	);

	app.post("/api/repair/prune-chunk-groups", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let batchSize = 500;
		let dryRun = false;
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") batchSize = body.batchSize;
			if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const result = await pruneChunkGroupEntities(resolveAccessor(), cfg.pipelineV2, ctx, limiter, {
			batchSize,
			dryRun,
		});
		return repairResponse(c, result);
	});

	app.post("/api/repair/prune-singleton-entities", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let batchSize = 200;
		let dryRun = false;
		let maxMentions = 1;
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") batchSize = body.batchSize;
			if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
			if (typeof body?.maxMentions === "number") maxMentions = body.maxMentions;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const result = await pruneSingletonExtractedEntities(resolveAccessor(), cfg.pipelineV2, ctx, limiter, {
			batchSize,
			dryRun,
			maxMentions,
		});
		return repairResponse(c, result);
	});

	app.post("/api/repair/prune-generic-entities", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let batchSize = 100;
		let dryRun = true;
		let body: Record<string, unknown> = {};
		try {
			body = asRecord(await c.req.json());
			if (typeof body?.batchSize === "number") batchSize = body.batchSize;
			if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			readString(body, "agentId") ??
				readString(body, "agent_id") ??
				c.req.query("agentId") ??
				c.req.query("agent_id") ??
				c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const result = await pruneGenericEntities(resolveAccessor(), cfg.pipelineV2, ctx, limiter, {
			batchSize,
			dryRun,
			agentId: scoped.agentId,
		});
		return repairResponse(c, result);
	});

	app.get("/api/repair/cold-stats", (c) => {
		const accessor = getDbAccessor();
		return c.json(
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
				const tableExists = db
					.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_cold'`)
					.get();

				if (!tableExists) {
					return { count: 0, message: "Cold tier not yet initialized (migration pending)" };
				}

				const stats = db
					.prepare(`
			SELECT
				COUNT(*) as total,
				MIN(archived_at) as oldest,
				MAX(archived_at) as newest,
				SUM(LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(COALESCE(original_row_json, '') AS BLOB))) as total_bytes
			FROM memories_cold
		`)
					.get() as
					| { total: number; oldest: string | null; newest: string | null; total_bytes: number | null }
					| undefined;

				const byReason = db
					.prepare(`
			SELECT archived_reason, COUNT(*) as count
			FROM memories_cold
			GROUP BY archived_reason
		`)
					.all() as Array<{ archived_reason: string | null; count: number }>;

				return {
					count: stats?.total ?? 0,
					oldest: stats?.oldest ?? null,
					newest: stats?.newest ?? null,
					totalBytes: stats?.total_bytes ?? 0,
					byReason: Object.fromEntries(byReason.map((r) => [r.archived_reason ?? "unknown", r.count])),
				};
			}, "db:repair.cold-stats.read"),
		);
	});

	app.post("/api/repair/cluster-entities", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const accessor = resolveAccessor();
		const ctx = resolveRepairContext(c);
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const result = await runRouteRepair<ClusterRepairResult>(
			accessor,
			cfg.pipelineV2,
			ctx,
			limiter,
			"clusterEntities",
			60_000,
			5,
			scoped.agentId,
			false,
			(message, retryAfterMs) => ({
				action: "clusterEntities",
				success: false,
				affected: 0,
				message,
				communities: 0,
				modularity: 0,
				quality: "fragmented",
				members: [],
				code: "repair_admission_denied",
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
			async () => {
				// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
				const clustered = accessor.withWriteTx(
					(db: import("../db-accessor").WriteDb) => clusterEntities(db, scoped.agentId),
					"db:repair.cluster-entities.write",
				);
				return {
					...clustered,
					action: "clusterEntities",
					success: true,
					affected: clustered.communities,
					message: `clustered ${clustered.communities} community(ies)`,
				};
			},
		);
		return repairResponse(c, result);
	});

	app.post("/api/repair/relink-entities", async (c) => {
		let batchSize = 500;
		let dryRun = false;
		let body: Record<string, unknown> = {};
		try {
			body = asRecord(await c.req.json());
			if (typeof body.batchSize === "number" && Number.isFinite(body.batchSize) && body.batchSize > 0) {
				batchSize = Math.min(Math.floor(body.batchSize), 500);
			}
			if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
		} catch {
			// defaults
		}
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			effectiveAuthConfig.mode,
			readString(body, "agentId") ??
				readString(body, "agent_id") ??
				c.req.query("agentId") ??
				c.req.query("agent_id") ??
				c.req.header("x-signet-agent-id"),
			resolveDaemonAgentId(),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const accessor = resolveAccessor();
		const ctx = resolveRepairContext(c);
		const result = await runRouteRepair<RelinkRepairResult>(
			accessor,
			deps.pipelineConfig ?? loadMemoryConfig(AGENTS_DIR).pipelineV2,
			ctx,
			limiter,
			"relink-entities",
			60_000,
			10,
			scoped.agentId,
			dryRun,
			(message, retryAfterMs) => ({
				action: "relink-entities",
				success: false,
				affected: 0,
				message,
				dryRun,
				processed: 0,
				linked: 0,
				entities: 0,
				aspects: 0,
				attributes: 0,
				remaining: 0,
				code: "repair_admission_denied",
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
			async () => await relinkEntities(accessor, scoped.agentId, batchSize, dryRun),
		);
		return repairResponse(c, result);
	});

	app.post("/api/repair/backfill-hints", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (!cfg.pipelineV2.hints?.enabled) {
			return c.json({ error: "Hints disabled in pipeline config" }, 400);
		}

		let batchSize = 50;
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") batchSize = Math.min(body.batchSize, 200);
		} catch {
			// defaults
		}

		const accessor = resolveAccessor();
		const ctx = resolveRepairContext(c);
		const result = await runRouteRepair<BackfillHintsResult>(
			accessor,
			cfg.pipelineV2,
			ctx,
			limiter,
			"backfill-hints",
			60_000,
			10,
			undefined,
			false,
			(message, retryAfterMs) => ({
				action: "backfill-hints",
				success: false,
				affected: 0,
				enqueued: 0,
				remaining: 0,
				message,
				code: "repair_admission_denied",
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
			async () => await backfillHints(accessor, batchSize),
		);
		return repairResponse(c, result);
	});

	app.get("/api/repair/dead-memories", (c) => {
		const maxConfidence = Number(c.req.query("maxConfidence") ?? "0.1");
		const maxAccessDays = Number(c.req.query("maxAccessDays") ?? "90");
		const limit = Math.min(Number(c.req.query("limit") ?? "200"), 500);
		if (
			!Number.isFinite(maxConfidence) ||
			!Number.isFinite(maxAccessDays) ||
			!Number.isFinite(limit) ||
			maxConfidence < 0 ||
			maxConfidence > 1 ||
			maxAccessDays < 0 ||
			limit < 0
		) {
			return c.json({ error: "maxConfidence must be 0–1, maxAccessDays and limit must be non-negative" }, 400);
		}
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const dead = getDbAccessor().withReadDb(
			(db: import("../db-accessor").ReadDb) => findDeadMemories(db, { maxConfidence, maxAccessDays, limit }),
			"db:repair.dead-memories.read",
		);
		return c.json({ count: dead.length, memories: dead });
	});

	app.post("/api/repair/dead-memories/forget", async (c) => {
		let ids: unknown;
		try {
			const body = await c.req.json();
			ids = body?.ids;
		} catch {
			return c.json({ error: "Request body must be JSON with an ids array" }, 400);
		}
		if (!Array.isArray(ids) || ids.length === 0) {
			return c.json({ error: "ids must be a non-empty array" }, 400);
		}
		if (ids.length > 500) {
			return c.json({ error: "Maximum 500 ids per batch" }, 400);
		}
		const validIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
		if (validIds.length !== ids.length) {
			return c.json({ error: "All ids must be non-empty strings" }, 400);
		}
		const accessor = resolveAccessor();
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = await runRouteRepair<ForgetRepairResult>(
			accessor,
			cfg.pipelineV2,
			ctx,
			limiter,
			"forgetDeadMemories",
			cfg.pipelineV2.repair.requeueCooldownMs,
			cfg.pipelineV2.repair.requeueHourlyBudget,
			undefined,
			false,
			(message, retryAfterMs) => ({
				action: "forgetDeadMemories",
				success: false,
				affected: 0,
				forgotten: 0,
				message,
				code: "repair_admission_denied",
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
			async () => {
				const forgotten = await forgetDeadMemories(accessor, validIds, ctx);
				return {
					action: "forgetDeadMemories",
					success: true,
					affected: forgotten,
					forgotten,
					message: `soft-deleted ${forgotten} dead memories`,
					details: { forgotten },
				};
			},
		);
		return repairResponse(c, result);
	});

	const TROUBLESHOOT_COMMANDS: Record<string, readonly [string, ReadonlyArray<string>]> = {
		status: ["signet", ["status"]],
		"daemon-status": ["signet", ["daemon", "status"]],
		"daemon-logs": ["signet", ["daemon", "logs", "--lines", "50"]],
		"embed-audit": ["signet", ["embed", "audit"]],
		"embed-backfill": ["signet", ["embed", "backfill"]],
		sync: ["signet", ["sync"]],
		"recall-test": ["signet", ["recall", "test query"]],
		"skill-list": ["signet", ["skill", "list"]],
		"secret-list": ["signet", ["secret", "list"]],
		"daemon-stop": ["signet", ["daemon", "stop"]],
		"daemon-restart": ["signet", ["daemon", "restart"]],
		update: ["signet", ["update", "install"]],
	};

	app.get("/api/repair/integrity-check", (c) => {
		const result = integrityCheck(getDbAccessor());
		return c.json(result);
	});

	app.post("/api/repair/rebuild-indexes", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = await rebuildDerivedIndexes(
			resolveAccessor(),
			cfg.pipelineV2,
			ctx,
			limiter,
			fetchEmbedding,
			cfg.embedding,
		);
		return repairResponse(c, result);
	});

	app.get("/api/troubleshoot/commands", (c) => {
		return c.json({
			commands: Object.entries(TROUBLESHOOT_COMMANDS).map(([key, [bin, args]]) => ({
				key,
				display: `${bin} ${args.join(" ")}`,
			})),
		});
	});

	app.post("/api/troubleshoot/exec", async (c) => {
		const body = await c.req.json().catch(() => null);
		const key = typeof body === "object" && body !== null && "key" in body ? String(body.key) : "";

		const cmd = TROUBLESHOOT_COMMANDS[key];
		if (!cmd) {
			return c.json({ error: `Unknown command: ${key}` }, 400);
		}

		const [bin, args] = cmd;
		const resolved = which(bin);
		if (!resolved) {
			return c.json({ error: `Binary not found: ${bin}` }, 500);
		}

		const { CLAUDECODE: _cc, SIGNET_NO_HOOKS: _, ...baseEnv } = process.env;
		const encoder = new TextEncoder();

		if (key === "daemon-stop" || key === "daemon-restart") {
			const action = key === "daemon-stop" ? "stop" : "restart";
			const lifecycle = new ReadableStream({
				start(controller) {
					const write = (event: unknown): void => {
						try {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						} catch {}
					};

					write({ type: "started", key, command: `signet daemon ${action}` });
					write({ type: "stdout", data: `Daemon ${action} initiated (PID ${process.pid})\n` });
					if (key === "daemon-stop") {
						write({ type: "stdout", data: "Dashboard will lose connection.\n" });
					}
					write({ type: "exit", code: 0 });
					try {
						controller.close();
					} catch {}

					setTimeout(async () => {
						if (key === "daemon-restart") {
							const { spawn: nodeSpawn } = await import("node:child_process");
							setTimeout(() => {
								const child = nodeSpawn(resolved, ["daemon", "start"], {
									detached: true,
									stdio: "ignore",
									env: { ...baseEnv, SIGNET_NO_HOOKS: "1" } as NodeJS.ProcessEnv,
								});
								child.unref();
							}, 1000);
						}
						process.kill(process.pid, "SIGTERM");
					}, 1000);
				},
			});

			return new Response(lifecycle, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		}

		const stream = new ReadableStream({
			async start(controller) {
				const write = (event: unknown) => {
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
					} catch {}
				};

				write({ type: "started", key, command: `${bin} ${args.join(" ")}` });

				const { spawn: nodeSpawn } = await import("node:child_process");
				const child = nodeSpawn(resolved, args as string[], {
					stdio: "pipe",
					windowsHide: true,
					env: { ...baseEnv, SIGNET_NO_HOOKS: "1", FORCE_COLOR: "0" } as NodeJS.ProcessEnv,
				});

				child.stdout?.on("data", (chunk: Buffer) => {
					try {
						write({ type: "stdout", data: chunk.toString("utf-8") });
					} catch {
						clearTimeout(killTimer);
						try {
							child.kill("SIGTERM");
						} catch {}
					}
				});

				child.stderr?.on("data", (chunk: Buffer) => {
					try {
						write({ type: "stderr", data: chunk.toString("utf-8") });
					} catch {
						clearTimeout(killTimer);
						try {
							child.kill("SIGTERM");
						} catch {}
					}
				});

				const killTimer = setTimeout(() => {
					try {
						child.kill("SIGTERM");
					} catch {}
					setTimeout(() => {
						try {
							child.kill();
						} catch {}
					}, 5_000);
				}, 60_000);

				child.on("close", (code) => {
					clearTimeout(killTimer);
					write({ type: "exit", code: code ?? 1 });
					try {
						controller.close();
					} catch {}
				});

				child.on("error", (err) => {
					clearTimeout(killTimer);
					write({ type: "error", message: err.message });
					try {
						controller.close();
					} catch {}
				});
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	});
}
