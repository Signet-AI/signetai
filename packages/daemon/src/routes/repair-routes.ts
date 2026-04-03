import type { Context, Hono } from "hono";
import { getDbAccessor } from "../db-accessor.js";
import { fetchEmbedding } from "../embedding-fetch.js";
import { linkMemoryToEntities } from "../inline-entity-linker.js";
import { getLlmProvider } from "../llm.js";
import { loadMemoryConfig } from "../memory-config.js";
import { clusterEntities } from "../pipeline/community-detection.js";
import {
	type RepairContext,
	type RepairResult,
	backfillSkippedSessions,
	checkFtsConsistency,
	cleanOrphanedEmbeddings,
	deduplicateMemories,
	findDeadMemories,
	forgetDeadMemories,
	getDedupStats,
	getEmbeddingGapStats,
	pruneChunkGroupEntities,
	pruneSingletonExtractedEntities,
	reclassifyEntities,
	reembedMissingMemories,
	releaseStaleLeases,
	requeueDeadJobs,
	resyncVectorIndex,
	structuralBackfill,
} from "../repair-actions.js";
import { AGENTS_DIR, repairLimiter } from "./state.js";

function resolveRepairContext(c: Context): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "manual repair";
	const actor = c.req.header("x-signet-actor") ?? "operator";
	const actorType = (c.req.header("x-signet-actor-type") ?? "operator") as "operator" | "agent" | "daemon";
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

function repairHttpStatus(result: RepairResult): number {
	if (result.success) return 200;
	if (
		/cooldown active|hourly budget exhausted|denied by policy gate|autonomous\.|agents cannot trigger repairs|already in progress/i.test(
			result.message,
		)
	) {
		return 429;
	}
	return 500;
}

export function registerRepairRoutes(app: Hono): void {
	app.post("/api/repair/requeue-dead", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = requeueDeadJobs(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
		return c.json(result, result.success ? 200 : 429);
	});

	app.post("/api/repair/release-leases", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = releaseStaleLeases(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
		return c.json(result, result.success ? 200 : 429);
	});

	app.post("/api/repair/check-fts", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let repair = false;
		try {
			const body = await c.req.json();
			repair = body?.repair === true;
		} catch {
			// no body or invalid JSON — default repair=false
		}
		const result = checkFtsConsistency(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, repair);
		return c.json(result, result.success ? 200 : 429);
	});

	app.post("/api/repair/retention-sweep", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		return c.json(
			{
				action: "triggerRetentionSweep",
				success: false,
				affected: 0,
				message: "Use the maintenance worker for automated sweeps; manual sweep via this endpoint is not yet wired",
			},
			501,
		);
	});

	app.get("/api/repair/embedding-gaps", (c) => {
		const stats = getEmbeddingGapStats(getDbAccessor());
		return c.json(stats);
	});

	app.post("/api/repair/re-embed", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let batchSize = 50;
		let dryRun = false;
		let fullSweep = false;

		try {
			const body = await c.req.json();
			if (typeof body.batchSize === "number") batchSize = body.batchSize;
			if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
			if (typeof body.fullSweep === "boolean") fullSweep = body.fullSweep;
		} catch {
			// no body or invalid JSON — use defaults
		}

		const result = await reembedMissingMemories(
			getDbAccessor(),
			cfg.pipelineV2,
			ctx,
			repairLimiter,
			fetchEmbedding,
			cfg.embedding,
			batchSize,
			dryRun,
			fullSweep,
			fullSweep && ctx.actorType === "operator" ? 0 : undefined,
		);

		return c.json(result, repairHttpStatus(result));
	});

	app.post("/api/repair/resync-vec", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = resyncVectorIndex(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
		return c.json(result, repairHttpStatus(result));
	});

	app.post("/api/repair/clean-orphans", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		const result = cleanOrphanedEmbeddings(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter);
		return c.json(result, repairHttpStatus(result));
	});

	app.get("/api/repair/dedup-stats", (c) => {
		const stats = getDedupStats(getDbAccessor());
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
		const result = await deduplicateMemories(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, options);
		return c.json(result, repairHttpStatus(result));
	});

	app.post("/api/repair/backfill-skipped", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let limit = 50;
		let dryRun = false;
		try {
			const body = await c.req.json();
			if (typeof body?.limit === "number") limit = body.limit;
			if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const result = backfillSkippedSessions(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
			limit,
			dryRun,
		});
		return c.json(result, repairHttpStatus(result));
	});

	app.post("/api/repair/reclassify-entities", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let batchSize = 50;
		let dryRun = false;
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") batchSize = body.batchSize;
			if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
		} catch {
			// no body or invalid JSON — use defaults
		}
		let provider: import("@signet/core").LlmProvider | null = null;
		try {
			provider = getLlmProvider();
		} catch {
			// provider not initialized
		}
		const result = await reclassifyEntities(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, provider, {
			batchSize,
			dryRun,
		});
		return c.json(result, repairHttpStatus(result));
	});

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
		const result = pruneChunkGroupEntities(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
			batchSize,
			dryRun,
		});
		return c.json(result, repairHttpStatus(result));
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
		const result = pruneSingletonExtractedEntities(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
			batchSize,
			dryRun,
			maxMentions,
		});
		return c.json(result, repairHttpStatus(result));
	});

	app.post("/api/repair/structural-backfill", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const ctx = resolveRepairContext(c);
		let batchSize = 100;
		let dryRun = false;
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") batchSize = body.batchSize;
			if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
		} catch {
			// no body or invalid JSON — use defaults
		}
		const result = structuralBackfill(getDbAccessor(), cfg.pipelineV2, ctx, repairLimiter, {
			batchSize,
			dryRun,
		});
		return c.json(result, repairHttpStatus(result));
	});

	app.get("/api/repair/cold-stats", (c) => {
		const accessor = getDbAccessor();
		return c.json(
			accessor.withReadDb((db) => {
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
			}),
		);
	});

	app.post("/api/repair/cluster-entities", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const result = getDbAccessor().withWriteTx((db) => clusterEntities(db, agentId));
		return c.json(result);
	});

	app.post("/api/repair/relink-entities", async (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		let batchSize = 500;
		try {
			const body = await c.req.json();
			if (typeof body?.batchSize === "number") batchSize = body.batchSize;
		} catch {
			// defaults
		}
		const accessor = getDbAccessor();

		const unlinked = accessor.withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, content FROM memories
			 WHERE is_deleted = 0
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)
			 LIMIT ?`,
					)
					.all(batchSize) as Array<{ id: string; content: string }>,
		);

		if (unlinked.length === 0) {
			return c.json({ action: "relink-entities", linked: 0, remaining: 0, message: "all memories linked" });
		}

		let linked = 0;
		let entities = 0;
		let aspects = 0;
		let attributes = 0;

		for (const mem of unlinked) {
			const result = accessor.withWriteTx((db) => linkMemoryToEntities(db, mem.id, mem.content, agentId));
			linked += result.linked;
			entities += result.entityIds.length;
			aspects += result.aspects;
			attributes += result.attributes;
		}

		const remaining = accessor.withReadDb(
			(db) =>
				(
					db
						.prepare(
							`SELECT COUNT(*) as cnt FROM memories
			 WHERE is_deleted = 0
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)`,
						)
						.get() as { cnt: number }
				).cnt,
		);

		return c.json({
			action: "relink-entities",
			processed: unlinked.length,
			linked,
			entities,
			aspects,
			attributes,
			remaining,
			message: remaining > 0 ? `${remaining} memories still need linking — call again` : "all memories linked",
		});
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

		const accessor = getDbAccessor();
		const unhinted = accessor.withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.id, m.content FROM memories m
			 WHERE m.is_deleted = 0 AND m.scope IS NULL
			   AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)
			 ORDER BY m.created_at DESC
			 LIMIT ?`,
					)
					.all(batchSize) as Array<{ id: string; content: string }>,
		);

		if (unhinted.length === 0) {
			return c.json({
				action: "backfill-hints",
				enqueued: 0,
				remaining: 0,
				message: "all unscoped memories have hints",
			});
		}

		const { enqueueHintsJob: enqueue } = await import("../pipeline/prospective-index.js");
		let enqueued = 0;
		accessor.withWriteTx((db) => {
			for (const mem of unhinted) {
				enqueue(db, mem.id, mem.content);
				enqueued++;
			}
		});

		const remaining = accessor.withReadDb(
			(db) =>
				(
					db
						.prepare(
							`SELECT COUNT(*) as cnt FROM memories
			 WHERE is_deleted = 0 AND scope IS NULL
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)`,
						)
						.get() as { cnt: number }
				).cnt,
		);

		return c.json({
			action: "backfill-hints",
			enqueued,
			remaining,
			message:
				remaining > 0
					? `${remaining} unscoped memories still need hints — call again`
					: "all unscoped memories have hints",
		});
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
		const dead = getDbAccessor().withReadDb((db) => findDeadMemories(db, { maxConfidence, maxAccessDays, limit }));
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
		const forgotten = forgetDeadMemories(getDbAccessor(), validIds);
		return c.json({ forgotten });
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
		const resolved = Bun.which(bin);
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
