import {vectorSearch} from "@signet/core";
import type {Hono} from "hono";
import {getAgentScope, resolveAgentId} from "../agent-id";
import {checkScope, requirePermission, requireRateLimit} from "../auth";
import {normalizeAndHashContent} from "../content-normalization";
import {getDbAccessor} from "../db-accessor";
import {syncVecDeleteBySourceId, syncVecInsert, vectorToBlob} from "../db-helpers";
import {fetchEmbedding} from "../embedding-fetch";
import {buildEmbeddingHealth} from "../embedding-health";
import {linkMemoryToEntities} from "../inline-entity-linker";
import {logger} from "../logger";
import {loadMemoryConfig} from "../memory-config";
import {hybridRecall, type RecallParams} from "../memory-search";
import {buildMemoryTimeline} from "../memory-timeline";
import {recordPathFeedback} from "../path-feedback";
import {enqueueDocumentIngestJob} from "../pipeline";
import {parseFeedback, recordAgentFeedback} from "../session-memories";
import {upsertSessionTranscript} from "../session-transcripts";
import {txForgetMemory, txIngestEnvelope, txModifyMemory, txRecoverMemory} from "../transactions";
import {cacheProjection, computeProjection, computeProjectionForQuery, getCachedProjection} from "../umap-projection";
import {
	AGENTS_DIR,
	authBatchForgetLimiter,
	authConfig,
	authForgetLimiter,
	authModifyLimiter,
	authRecallLlmLimiter,
	embeddingTrackerHandle,
	hasMemoriesSessionIdColumnCache,
	INTERNAL_SELF_HOST,
	PORT,
	PROJECTION_ERROR_TTL_MS,
	projectionErrors,
	projectionInFlight,
	queueExtractionJob,
} from "./state";
import {
	blobToVector,
	buildForgetConfirmToken,
	buildWhere,
	buildWhereRaw,
	checkEmbeddingProvider,
	chunkBySentence,
	type FilterParams,
	type ForgetCandidatesRequest,
	inferType,
	isMissingEmbeddingsTableError,
	loadForgetCandidates,
	loadForgetCandidatesByIds,
	parseBoundedInt,
	parseCsvQuery,
	parseIsoDateQuery,
	parseModifyPatch,
	parseOptionalBoolean,
	parseOptionalBoundedFloat,
	parseOptionalBoundedInt,
	parseOptionalInt,
	parseOptionalString,
	parsePrefixes,
	parseTagsField,
	parseTagsMutation,
	readOptionalJsonObject,
	resolveMutationActor,
	runLegacyEmbeddingsExport,
	toRecord,
} from "./utils";

const MAX_MUTATION_BATCH = 200;
const FORGET_CONFIRM_THRESHOLD = 25;
const SOFT_DELETE_RETENTION_DAYS = 30;
const SOFT_DELETE_RETENTION_MS = SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function parseOptionalIsoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const ts = new Date(trimmed);
	return Number.isNaN(ts.getTime()) ? null : ts.toISOString();
}

function hasMemoriesSessionIdColumn(db: any): boolean {
	if (hasMemoriesSessionIdColumnCache !== null) {
		return hasMemoriesSessionIdColumnCache;
	}

	const result = (
		db.prepare("PRAGMA table_info(memories)").all() as Array<{
			name?: unknown;
		}>
	).some((column) => column.name === "session_id");
	return result;
}

export function registerMemoryRoutes(app: Hono): void {
	// =========================================================================
	// Permission guards — memory routes
	// =========================================================================

	app.use("/api/memory/remember", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/memory/save", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/hook/remember", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});

	// Recall / search — scope.project is enforced at the handler level.
	app.use("/api/memory/recall", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/memory/search", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/memory/search", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/memory/similar", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/memory/timeline", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});

	// Modify — with rate limiting
	app.use("/api/memory/modify", async (c, next) => {
		const perm = requirePermission("modify", authConfig);
		const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
		await perm(c, async () => {
			await rate(c, next);
		});
	});

	// Forget — with rate limiting
	app.use("/api/memory/forget", async (c, next) => {
		const perm = requirePermission("forget", authConfig);
		const rate = requireRateLimit("batchForget", authBatchForgetLimiter, authConfig);
		await perm(c, async () => {
			await rate(c, next);
		});
	});

	// Recover
	app.use("/api/memory/:id/recover", async (c, next) => {
		return requirePermission("recover", authConfig)(c, next);
	});

	// Documents
	app.use("/api/documents", async (c, next) => {
		return requirePermission("documents", authConfig)(c, next);
	});
	app.use("/api/documents/*", async (c, next) => {
		return requirePermission("documents", authConfig)(c, next);
	});

	// =========================================================================
	// Memory jobs — read-only (uses documents permission)
	// =========================================================================
	app.use("/api/memory/jobs", async (c, next) => {
		return requirePermission("documents", authConfig)(c, next);
	});

	app.use("/api/memory/:id", async (c, next) => {
		if (authConfig.mode !== "local" && (c.req.method === "PATCH" || c.req.method === "DELETE")) {
			const auth = c.get("auth");
			if (auth?.claims?.scope?.project) {
				const memoryId = c.req.param("id");
				const row = getDbAccessor().withReadDb(
					(db) =>
						db.prepare("SELECT project FROM memories WHERE id = ?").get(memoryId) as
							| { project: string | null }
							| undefined,
				);
				if (row) {
					const decision = checkScope(auth.claims, { project: row.project ?? undefined }, authConfig.mode);
					if (!decision.allowed) {
						return c.json({ error: decision.reason ?? "scope violation" }, 403);
					}
				}
			}
		}

		if (c.req.method === "PATCH") {
			const perm = requirePermission("modify", authConfig);
			const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
			return perm(c, async () => {
				await rate(c, next);
			});
		}
		if (c.req.method === "DELETE") {
			const perm = requirePermission("forget", authConfig);
			const rate = requireRateLimit("forget", authForgetLimiter, authConfig);
			return perm(c, async () => {
				await rate(c, next);
			});
		}
		if (c.req.method === "GET") {
			return requirePermission("recall", authConfig)(c, next);
		}
		return next();
	});

	// =========================================================================
	// GET /api/memories — list memories
	// =========================================================================
	app.get("/api/memories", (c) => {
		try {
			const limit = Number.parseInt(c.req.query("limit") || "100", 10);
			const offset = Number.parseInt(c.req.query("offset") || "0", 10);

			const result = getDbAccessor().withReadDb((db) => {
				const memories = db
					.prepare(`
      SELECT id, content, created_at, who, importance, tags, source_type, pinned, type
      FROM memories
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
					.all(limit, offset);

				const totalResult = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
				let embeddingsCount = 0;
				try {
					const embResult = db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number };
					embeddingsCount = embResult?.count ?? 0;
				} catch {
					// embeddings table might not exist
				}
				const critResult = db.prepare("SELECT COUNT(*) as count FROM memories WHERE importance >= 0.9").get() as {
					count: number;
				};

				return {
					memories,
					stats: {
						total: totalResult?.count ?? 0,
						withEmbeddings: embeddingsCount,
						critical: critResult?.count ?? 0,
					},
				};
			});

			return c.json(result);
		} catch (e) {
			logger.error("memory", "Error loading memories", e as Error);
			return c.json({
				memories: [],
				stats: { total: 0, withEmbeddings: 0, critical: 0 },
				error: "Failed to load memories",
			});
		}
	});

	// =========================================================================
	// GET /api/memories/most-used
	// =========================================================================
	app.get("/api/memories/most-used", (c) => {
		try {
			const raw = Number.parseInt(c.req.query("limit") || "6", 10);
			const limit = Number.isNaN(raw) || raw < 1 ? 6 : Math.min(raw, 200);
			const memories = getDbAccessor().withReadDb((db) =>
				db
					.prepare(`
					SELECT id, content, access_count, importance, type, tags
					FROM memories
					WHERE access_count > 0
					ORDER BY access_count DESC, importance DESC
					LIMIT ?
				`)
					.all(limit),
			);
			return c.json({ memories });
		} catch (e) {
			logger.error("memory", "Error loading most-used memories", e as Error);
			return c.json({ memories: [] });
		}
	});

	// =========================================================================
	// GET /api/memory/timeline
	// =========================================================================
	app.get("/api/memory/timeline", (c) => {
		try {
			const raw = Number.parseInt(c.req.query("tzOffset") || "0", 10);
			const tzOffsetMin = Number.isNaN(raw) ? 0 : Math.max(-840, Math.min(840, raw));
			const timeline = getDbAccessor().withReadDb((db) => buildMemoryTimeline(db, { tzOffsetMin }));
			return c.json(timeline);
		} catch (e) {
			logger.error("memory", "Error building memory timeline", e as Error);
			return c.json(
				{
					error: "Failed to build memory timeline",
					generatedAt: new Date().toISOString(),
					generatedFor: new Date().toISOString(),
					rangePreset: "today-last_week-one_month",
					totalMemories: 0,
					totalHistoryEvents: 0,
					invalidMemoryTimestamps: 0,
					invalidHistoryTimestamps: 0,
					buckets: [],
				},
				500,
			);
		}
	});

	// =========================================================================
	// GET /api/memory/review-queue
	// =========================================================================
	app.get("/api/memory/review-queue", (c) => {
		try {
			const rows = getDbAccessor().withReadDb((db) => {
				return db
					.prepare(
						`SELECT h.id, h.memory_id, h.event, h.old_content, h.new_content,
					        h.reason, h.metadata, h.created_at, h.session_id,
					        m.content AS current_content, m.type AS memory_type,
					        m.importance
					 FROM memory_history h
					 LEFT JOIN memories m ON m.id = h.memory_id
					 WHERE h.event IN ('DEDUP', 'REVIEW_NEEDED', 'BLOCKED_DESTRUCTIVE')
					   AND h.created_at > datetime('now', '-30 days')
					 ORDER BY h.created_at DESC
					 LIMIT 200`,
					)
					.all();
			});
			return c.json({ items: rows });
		} catch (e) {
			logger.error("memory", "Error fetching review queue", e as Error);
			return c.json({ error: "Failed to fetch review queue", items: [] }, 500);
		}
	});

	// =========================================================================
	// GET /memory/search — FTS + filter search
	// =========================================================================
	app.get("/memory/search", (c) => {
		const query = c.req.query("q") ?? "";
		const distinct = c.req.query("distinct");
		const limitParam = c.req.query("limit");
		const limit = limitParam ? Number.parseInt(limitParam, 10) : null;

		// Shortcut: return distinct values for a column
		if (distinct === "who") {
			try {
				const values = getDbAccessor().withReadDb((db) => {
					const rows = db.prepare("SELECT DISTINCT who FROM memories WHERE who IS NOT NULL ORDER BY who").all() as {
						who: string;
					}[];
					return rows.map((r) => r.who);
				});
				return c.json({ values });
			} catch {
				return c.json({ values: [] });
			}
		}

		const filterParams: FilterParams = {
			type: c.req.query("type") ?? "",
			tags: c.req.query("tags") ?? "",
			who: c.req.query("who") ?? "",
			pinned: c.req.query("pinned") === "1" || c.req.query("pinned") === "true",
			importance_min: c.req.query("importance_min") ? Number.parseFloat(c.req.query("importance_min") ?? "") : null,
			since: c.req.query("since") ?? "",
		};

		const hasFilters = Object.values(filterParams).some((v) => v !== "" && v !== false && v !== null);

		try {
			const results = getDbAccessor().withReadDb((db) => {
				let rows: unknown[] = [];

				if (query.trim()) {
					// FTS path
					const { clause, args } = buildWhere(filterParams);
					try {
						rows = (
							db.prepare(`
            SELECT m.id, m.content, m.created_at, m.who, m.importance, m.tags,
                   m.type, m.pinned, bm25(memories_fts) as score
            FROM memories_fts
            JOIN memories m ON memories_fts.rowid = m.rowid
            WHERE memories_fts MATCH ?${clause}
            ORDER BY score
            LIMIT ${limit ?? 20}
          `) as any
						).all(query, ...args);
					} catch {
						// FTS not available — fall back to LIKE
						const { clause: rc, args: rargs } = buildWhereRaw(filterParams);
						rows = (
							db.prepare(`
            SELECT id, content, created_at, who, importance, tags, type, pinned
            FROM memories
            WHERE (content LIKE ? OR tags LIKE ?)${rc}
            ORDER BY created_at DESC
            LIMIT ${limit ?? 20}
          `) as any
						).all(`%${query}%`, `%${query}%`, ...rargs);
					}
				} else if (hasFilters) {
					// Pure filter path
					const { clause, args } = buildWhereRaw(filterParams);
					rows = (
						db.prepare(`
          SELECT id, content, created_at, who, importance, tags, type, pinned,
                 CASE WHEN pinned = 1 THEN 1.0
                      ELSE importance * MAX(0.1, POWER(0.95,
                        CAST(JulianDay('now') - JulianDay(created_at) AS INTEGER)))
                 END AS score
          FROM memories
          WHERE 1=1${clause}
          ORDER BY score DESC
          LIMIT ${limit ?? 50}
        `) as any
					).all(...args);
				}

				return rows;
			});

			return c.json({ results });
		} catch (e) {
			logger.error("memory", "Error searching memories", e as Error);
			return c.json({ results: [], error: "Search failed" });
		}
	});

	// =========================================================================
	// POST /api/memory/remember
	// =========================================================================
	app.post("/api/memory/remember", async (c) => {
		let body: {
			content?: string;
			who?: string;
			project?: string;
			importance?: number;
			tags?: unknown;
			pinned?: boolean;
			sourceType?: string;
			sourceId?: string;
			createdAt?: string;
			scope?: string | null;
			agentId?: string;
			visibility?: "global" | "private" | "archived";
			hints?: string[];
			transcript?: string;
			structured?: {
				entities?: Array<{
					source: string;
					sourceType?: string;
					relationship: string;
					target: string;
					targetType?: string;
					confidence: number;
				}>;
				aspects?: Array<{
					entityName: string;
					entityType?: string;
					aspect: string;
					attributes: Array<{
						groupKey?: string;
						claimKey?: string;
						content: string;
						confidence?: number;
						importance?: number;
					}>;
				}>;
				hints?: string[];
			};
		};

		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const raw = body.content?.trim();
		if (!raw) return c.json({ error: "content is required" }, 400);
		const requestedCreatedAt = parseOptionalIsoTimestamp(body.createdAt);
		if (body.createdAt !== undefined && !requestedCreatedAt) {
			return c.json({ error: "createdAt must be a valid ISO timestamp" }, 400);
		}
		const scope = body.scope ?? null;
		const agentId = resolveAgentId({ agentId: body.agentId, sessionKey: c.req.header("x-signet-session-key") });
		const visibility = body.visibility === "private" ? "private" : "global";
		const hasBodyTags = Object.prototype.hasOwnProperty.call(body, "tags");
		const bodyTags = hasBodyTags ? parseTagsMutation(body.tags) : undefined;
		if (hasBodyTags && bodyTags === undefined) {
			return c.json({ error: "tags must be a string, string array, or null" }, 400);
		}

		// Pipeline v2 kill switch: refuse writes when mutations are frozen
		const fullCfg = loadMemoryConfig(AGENTS_DIR);
		const pipelineCfg = fullCfg.pipelineV2;
		if (pipelineCfg.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		// --- Auto-chunking for oversized memories ---
		const guardrails = pipelineCfg.guardrails;
		if (!body.structured && raw.length > guardrails.maxContentChars) {
			const chunks = chunkBySentence(raw, guardrails.chunkTargetChars);
			if (chunks.length === 0) {
				return c.json({ error: "content produced no valid chunks" }, 400);
			}

			const who = body.who ?? "daemon";
			const project = body.project ?? null;
			const sourceType = body.sourceType?.trim() || "manual";
			const sourceId = body.sourceId?.trim() || null;
			const parsedPrefixes = parsePrefixes(raw);
			const importance = body.importance ?? parsedPrefixes.importance;
			const pinned = (body.pinned ?? parsedPrefixes.pinned) ? 1 : 0;
			const tags = hasBodyTags ? bodyTags : parsedPrefixes.tags;
			const pipelineEnqueueEnabled = pipelineCfg.enabled;

			const groupId = crypto.randomUUID();
			const now = new Date().toISOString();
			const chunkIds: string[] = [];

			// Create chunk group entity
			try {
				getDbAccessor().withWriteTx((db) => {
					db.prepare(
						`INSERT INTO entities
						 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
						 VALUES (?, ?, ?, 'chunk_group', ?, 0, ?, ?)`,
					).run(groupId, `chunk-group:${groupId}`, `chunk-group:${groupId}`, agentId, now, now);
				});
			} catch (e) {
				logger.error("memory", "Failed to create chunk group entity", e as Error);
				return c.json({ error: "Failed to create chunk group" }, 500);
			}

			for (const chunk of chunks) {
				const chunkNormalized = normalizeAndHashContent(chunk);
				if (!chunkNormalized.storageContent) continue;

				const chunkId = crypto.randomUUID();
				const chunkContentForInsert =
					chunkNormalized.normalizedContent.length > 0 ? chunkNormalized.normalizedContent : chunkNormalized.hashBasis;
				const memType = inferType(chunk);

				try {
					const inserted = getDbAccessor().withWriteTx((db) => {
						const byHash =
							scope !== null
								? (db
										.prepare("SELECT id FROM memories WHERE content_hash = ? AND scope = ? AND is_deleted = 0 LIMIT 1")
										.get(chunkNormalized.contentHash, scope) as { id: string } | undefined)
								: (db
										.prepare(
											"SELECT id FROM memories WHERE content_hash = ? AND scope IS NULL AND is_deleted = 0 LIMIT 1",
										)
										.get(chunkNormalized.contentHash) as { id: string } | undefined);
						if (byHash) return false;

						txIngestEnvelope(db, {
							id: chunkId,
							content: chunkNormalized.storageContent,
							normalizedContent: chunkContentForInsert,
							contentHash: chunkNormalized.contentHash,
							who,
							why: pinned ? "explicit-critical" : "explicit",
							project,
							importance,
							type: memType,
							tags: tags ?? null,
							pinned,
							isDeleted: 0,
							extractionStatus: pipelineEnqueueEnabled ? "pending" : "none",
							embeddingModel: null,
							extractionModel: pipelineEnqueueEnabled ? pipelineCfg.extraction.model : null,
							updatedBy: who,
							sourceType: "chunk",
							sourceId: groupId,
							scope,
							agentId,
							visibility,
							createdAt: now,
						});

						// Link chunk to group entity
						db.prepare(
							`INSERT OR IGNORE INTO memory_entity_mentions
							 (memory_id, entity_id, mention_text, confidence, created_at)
							 VALUES (?, ?, 'chunk', 1.0, ?)`,
						).run(chunkId, groupId, now);

						return true;
					});

					if (!inserted) continue;
					chunkIds.push(chunkId);

					// Generate embedding async
					try {
						const vec = await fetchEmbedding(chunkNormalized.storageContent, fullCfg.embedding);
						if (vec) {
							if (vec.length !== fullCfg.embedding.dimensions) {
								logger.warn("memory", "Embedding dimension mismatch, skipping vector insert", {
									got: vec.length,
									expected: fullCfg.embedding.dimensions,
									memoryId: chunkId,
								});
							} else {
								const embId = crypto.randomUUID();
								const blob = vectorToBlob(vec);
								const embHash = scope ? `${chunkNormalized.contentHash}:${scope}` : chunkNormalized.contentHash;
								getDbAccessor().withWriteTx((db) => {
									syncVecDeleteBySourceId(db, "memory", chunkId);
									db.prepare(`DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`).run(chunkId);
									db.prepare(`
										INSERT INTO embeddings
										  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
										VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
									`).run(embId, embHash, blob, vec.length, chunkId, chunkNormalized.storageContent, now);
									syncVecInsert(db, embId, vec);
									db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(
										fullCfg.embedding.model,
										chunkId,
									);
								});
							}
						}
					} catch (e) {
						logger.warn("memory", "Chunk embedding failed (chunk saved without vector)", {
							chunkId,
							error: String(e),
						});
					}

					// Inline entity linking for chunk
					try {
						getDbAccessor().withWriteTx((db) => {
							linkMemoryToEntities(db, chunkId, chunk, agentId);
						});
					} catch {
						// Non-fatal — pipeline extraction handles deeper linking
					}

					// Enqueue pipeline extraction if enabled
					if (pipelineEnqueueEnabled) {
						try {
							queueExtractionJob(chunkId);
						} catch (e) {
							logger.warn("pipeline", "Failed to enqueue chunk extraction", {
								chunkId,
								error: String(e),
							});
						}
					}
				} catch (e) {
					logger.warn("memory", "Failed to save chunk", {
						chunkId,
						error: String(e),
					});
				}
			}

			logger.info("memory", "Chunked memory saved", {
				groupId,
				chunkCount: chunkIds.length,
			});

			return c.json({
				chunked: true,
				chunk_count: chunkIds.length,
				ids: chunkIds,
				group_id: groupId,
			});
		}

		const who = body.who ?? "daemon";
		const project = body.project ?? null;
		const sourceType = body.sourceType?.trim() || "manual";
		const sourceId = body.sourceId?.trim() || null;

		const parsed = parsePrefixes(raw);

		const importance = body.importance ?? parsed.importance;
		const pinned = (body.pinned ?? parsed.pinned) ? 1 : 0;
		const tags = hasBodyTags ? bodyTags : parsed.tags;
		const memType = inferType(parsed.content);

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const createdAt = requestedCreatedAt ?? now;
		const normalizedContent = normalizeAndHashContent(parsed.content);
		if (!normalizedContent.storageContent) {
			return c.json({ error: "content is required" }, 400);
		}
		const normalizedContentForInsert =
			normalizedContent.normalizedContent.length > 0
				? normalizedContent.normalizedContent
				: normalizedContent.hashBasis;
		const contentHash = normalizedContent.contentHash;
		const pipelineEnqueueEnabled = pipelineCfg.enabled;

		type DedupeRow = {
			id: string;
			type: string;
			tags: string | null;
			pinned: number;
			importance: number;
			content: string;
		};

		try {
			const result = getDbAccessor().withWriteTx((db) => {
				// Check sourceId-based dedupe first (scope-aware)
				if (sourceId) {
					const bySource = (
						scope !== null
							? db
									.prepare(
										`SELECT id, type, tags, pinned, importance, content
						 FROM memories WHERE source_type = ? AND source_id = ? AND scope = ? AND is_deleted = 0 LIMIT 1`,
									)
									.get(sourceType, sourceId, scope)
							: db
									.prepare(
										`SELECT id, type, tags, pinned, importance, content
						 FROM memories WHERE source_type = ? AND source_id = ? AND scope IS NULL AND is_deleted = 0 LIMIT 1`,
									)
									.get(sourceType, sourceId)
					) as DedupeRow | undefined;
					if (bySource) return { deduped: true as const, row: bySource };
				}

				// Check content_hash dedupe (scope-aware)
				const byHash = (
					scope !== null
						? db
								.prepare(
									`SELECT id, type, tags, pinned, importance, content
					 FROM memories WHERE content_hash = ? AND scope = ? AND is_deleted = 0 LIMIT 1`,
								)
								.get(contentHash, scope)
						: db
								.prepare(
									`SELECT id, type, tags, pinned, importance, content
					 FROM memories WHERE content_hash = ? AND scope IS NULL AND is_deleted = 0 LIMIT 1`,
								)
								.get(contentHash)
				) as DedupeRow | undefined;
				if (byHash) return { deduped: true as const, row: byHash };

				// No duplicate — insert
				const hasStructured = !!body.structured;
				txIngestEnvelope(db, {
					id,
					content: normalizedContent.storageContent,
					normalizedContent: normalizedContentForInsert,
					contentHash,
					who,
					why: pinned ? "explicit-critical" : "explicit",
					project,
					importance,
					type: memType,
					tags: tags ?? null,
					pinned,
					isDeleted: 0,
					extractionStatus: hasStructured ? "complete" : pipelineEnqueueEnabled ? "pending" : "none",
					embeddingModel: null,
					extractionModel: hasStructured
						? "structured-passthrough"
						: pipelineEnqueueEnabled
							? pipelineCfg.extraction.model
							: null,
					updatedBy: who,
					sourceType,
					sourceId,
					scope,
					agentId,
					visibility,
					createdAt,
				});
				return { deduped: false as const };
			});

			if (result.deduped) {
				return c.json({
					id: result.row.id,
					type: result.row.type,
					tags: result.row.tags || "",
					pinned: !!result.row.pinned,
					importance: result.row.importance,
					content: result.row.content,
					embedded: true,
					deduped: true,
				});
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : "";
			if (msg.includes("UNIQUE constraint")) {
				const existing = getDbAccessor().withReadDb(
					(db) =>
						db
							.prepare(
								`SELECT id, type, tags, pinned, importance, content
						 FROM memories
						 WHERE content_hash = ? AND is_deleted = 0 LIMIT 1`,
							)
							.get(contentHash) as DedupeRow | undefined,
				);
				if (existing) {
					return c.json({
						id: existing.id,
						type: existing.type,
						tags: existing.tags || "",
						pinned: !!existing.pinned,
						importance: existing.importance,
						content: existing.content,
						embedded: true,
						deduped: true,
					});
				}
			}
			logger.error("memory", "Failed to save memory", e as Error);
			return c.json({ error: "Failed to save memory" }, 500);
		}

		// Lossless transcript storage
		if (body.transcript && sourceId) {
			upsertSessionTranscript(sourceId, body.transcript, sourceType, project, agentId);
		}

		// Generate embedding asynchronously
		let embedded = false;
		try {
			const cfg = loadMemoryConfig(AGENTS_DIR);
			const vec = await fetchEmbedding(normalizedContent.storageContent, cfg.embedding);
			if (vec) {
				if (vec.length !== cfg.embedding.dimensions) {
					logger.warn("memory", "Embedding dimension mismatch, skipping vector insert", {
						got: vec.length,
						expected: cfg.embedding.dimensions,
						memoryId: id,
					});
				} else {
					const embHash = scope ? `${contentHash}:${scope}` : contentHash;
					const blob = vectorToBlob(vec);
					const embId = crypto.randomUUID();

					getDbAccessor().withWriteTx((db) => {
						syncVecDeleteBySourceId(db, "memory", id);
						db.prepare(`DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`).run(id);
						db.prepare(`
							INSERT INTO embeddings
							  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
							VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
						`).run(embId, embHash, blob, vec.length, id, normalizedContent.storageContent, now);
						syncVecInsert(db, embId, vec);
						db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(cfg.embedding.model, id);
					});
					embedded = true;
				}
			}
		} catch (e) {
			logger.warn("memory", "Embedding failed (memory saved without vector)", {
				id,
				error: String(e),
			});
		}

		// --- Structured vs pipeline path ---
		let entitiesLinked = 0;
		let hintsWritten = 0;

		if (body.structured) {
			const { txPersistStructured } = await import("../pipeline/graph-transactions.js");
			try {
				const result = getDbAccessor().withWriteTx((db) =>
					txPersistStructured(db, {
						entities: (body.structured?.entities ?? []).map((e) => ({
							source: e.source,
							sourceType: e.sourceType,
							relationship: e.relationship,
							target: e.target,
							targetType: e.targetType,
							confidence: e.confidence ?? 0.7,
						})),
						aspects: body.structured?.aspects ?? [],
						sourceMemoryId: id,
						content: normalizedContent.storageContent,
						agentId,
						now: createdAt,
					}),
				);
				entitiesLinked = result.mentionsLinked;
				logger.debug("memory", "Structured payload persisted", {
					id,
					entities: result.entitiesInserted + result.entitiesUpdated,
					relations: result.relationsInserted,
					aspects: result.aspectsCreated,
					attributes: result.attributesCreated,
					superseded: result.attributesSuperseded,
					mentions: result.mentionsLinked,
				});
			} catch (e) {
				logger.warn("memory", "Structured payload persistence failed (non-fatal)", {
					id,
					error: e instanceof Error ? e.message : String(e),
				});
			}

			// Write structured hints
			const allHints = [...(body.structured?.hints ?? []), ...(body.hints ?? [])];
			if (allHints.length > 0) {
				try {
					getDbAccessor().withWriteTx((db) => {
						const stmt = db.prepare(
							`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
							 VALUES (?, ?, ?, ?, ?)`,
						);
						for (const hint of allHints) {
							const h = typeof hint === "string" ? hint.trim() : "";
							if (h.length < 5 || h.length > 300) continue;
							stmt.run(crypto.randomUUID(), id, agentId, h, now);
							hintsWritten++;
						}
					});
				} catch (e) {
					logger.warn("memory", "Structured hints write failed (non-fatal)", {
						id,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		} else {
			// --- Default path: inline entity linking + async pipeline ---
			try {
				const linkResult = getDbAccessor().withWriteTx((db) =>
					linkMemoryToEntities(db, id, normalizedContent.storageContent, agentId),
				);
				entitiesLinked = linkResult.linked;
				if (linkResult.linked > 0) {
					logger.debug("memory", "Inline entity linking", {
						id,
						linked: linkResult.linked,
						aspects: linkResult.aspects,
						attributes: linkResult.attributes,
					});
				}
			} catch (e) {
				logger.warn("memory", "Inline entity linking failed (non-fatal)", {
					id,
					error: e instanceof Error ? e.message : String(e),
				});
			}

			// Enqueue pipeline extraction if enabled
			if (pipelineEnqueueEnabled) {
				try {
					queueExtractionJob(id);
				} catch (e) {
					getDbAccessor().withWriteTx((db) => {
						db.prepare(
							`UPDATE memories
								 SET extraction_status = 'failed', extraction_model = ?
								 WHERE id = ?`,
						).run(pipelineCfg.extraction.model, id);
					});
					logger.warn("pipeline", "Failed to enqueue extraction job", {
						memoryId: id,
						error: String(e),
					});
				}
			}

			// Prospective hints
			if (Array.isArray(body.hints) && body.hints.length > 0 && pipelineCfg.hints?.enabled) {
				try {
					getDbAccessor().withWriteTx((db) => {
						const stmt = db.prepare(
							`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
							 VALUES (?, ?, ?, ?, ?)`,
						);
						for (const hint of body.hints ?? []) {
							const h = typeof hint === "string" ? hint.trim() : "";
							if (h.length < 5 || h.length > 300) continue;
							stmt.run(crypto.randomUUID(), id, agentId, h, now);
							hintsWritten++;
						}
					});
				} catch (e) {
					logger.warn("memory", "Client-side hints write failed (non-fatal)", {
						id,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			} else if (pipelineCfg.hints?.enabled && pipelineEnqueueEnabled) {
				try {
					const { enqueueHintsJob } = await import("../pipeline/prospective-index.js");
					getDbAccessor().withWriteTx((db) => {
						enqueueHintsJob(db, id, normalizedContent.storageContent);
					});
				} catch (e) {
					logger.warn("memory", "Hints job enqueue failed (non-fatal)", {
						id,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}

		logger.info("memory", "Memory saved", {
			id,
			type: memType,
			pinned: !!pinned,
			embedded,
			entities: entitiesLinked,
			hints: hintsWritten,
			structured: !!body.structured,
		});

		return c.json({
			id,
			type: memType,
			tags,
			pinned: !!pinned,
			importance,
			content: normalizedContent.storageContent,
			embedded,
			entities_linked: entitiesLinked,
			hints_written: hintsWritten,
			structured: !!body.structured,
		});
	});

	// =========================================================================
	// POST /api/memory/save — alias
	// =========================================================================
	app.post("/api/memory/save", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	});

	// =========================================================================
	// POST /api/hook/remember — alias for Claude Code skill compatibility
	// =========================================================================
	app.post("/api/hook/remember", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	});

	// =========================================================================
	// GET /api/memory/:id
	// =========================================================================
	app.get("/api/memory/:id", (c) => {
		const memoryId = c.req.param("id")?.trim();
		if (!memoryId) {
			return c.json({ error: "memory id is required" }, 400);
		}

		const row = getDbAccessor().withReadDb((db) => {
			const sessionSelect = hasMemoriesSessionIdColumn(db) ? "session_id," : "NULL AS session_id,";

			return db
				.prepare(
					`SELECT id, content, type, importance, tags, pinned, who,
					        source_id, source_type, project, ${sessionSelect} confidence,
					        access_count, last_accessed, is_deleted, deleted_at,
					        extraction_status, embedding_model, version,
					        created_at, updated_at, updated_by
					 FROM memories WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`,
				)
				.get(memoryId) as Record<string, unknown> | undefined;
		});

		if (!row) {
			return c.json({ error: "not found" }, 404);
		}

		const sessionId =
			typeof row.session_id === "string"
				? row.session_id
				: typeof row.source_id === "string" &&
						typeof row.source_type === "string" &&
						row.source_type.startsWith("session")
					? row.source_id
					: undefined;

		return c.json({
			...row,
			sessionId,
		});
	});

	// =========================================================================
	// GET /api/memory/:id/history
	// =========================================================================
	app.get("/api/memory/:id/history", (c) => {
		const memoryId = c.req.param("id")?.trim();
		if (!memoryId) {
			return c.json({ error: "memory id is required" }, 400);
		}

		const limit = Math.min(parseOptionalInt(c.req.query("limit")) ?? 200, 1000);

		const exists = getDbAccessor().withReadDb((db) => {
			return db.prepare("SELECT id FROM memories WHERE id = ?").get(memoryId) as { id: string } | undefined;
		});
		if (!exists) {
			return c.json({ error: "Not found", memoryId }, 404);
		}

		const history = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT id, event, old_content, new_content, changed_by, reason,
					        metadata, created_at, actor_type, session_id, request_id
					 FROM memory_history
					 WHERE memory_id = ?
					 ORDER BY created_at ASC
					 LIMIT ?`,
				)
				.all(memoryId, limit) as Array<{
				id: string;
				event: string;
				old_content: string | null;
				new_content: string | null;
				changed_by: string;
				reason: string | null;
				metadata: string | null;
				created_at: string;
				actor_type: string | null;
				session_id: string | null;
				request_id: string | null;
			}>;
		});

		return c.json({
			memoryId,
			count: history.length,
			history: history.map((row) => {
				let metadata: unknown = row.metadata;
				if (row.metadata) {
					try {
						metadata = JSON.parse(row.metadata);
					} catch {
						metadata = row.metadata;
					}
				}
				return {
					id: row.id,
					event: row.event,
					oldContent: row.old_content,
					newContent: row.new_content,
					changedBy: row.changed_by,
					actorType: row.actor_type ?? undefined,
					reason: row.reason,
					metadata,
					createdAt: row.created_at,
					sessionId: row.session_id ?? undefined,
					requestId: row.request_id ?? undefined,
				};
			}),
		});
	});

	// =========================================================================
	// GET /api/memory/jobs/:id
	// =========================================================================
	app.get("/api/memory/jobs/:id", (c) => {
		const jobId = c.req.param("id")?.trim();
		if (!jobId) {
			return c.json({ error: "job id is required" }, 400);
		}

		const maybeRow = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT id, memory_id, document_id, job_type, status,
					        attempts, max_attempts, leased_at, completed_at,
					        failed_at, error, created_at, updated_at
					 FROM memory_jobs
					 WHERE id = ?
					 LIMIT 1`,
				)
				.get(jobId) as unknown;
		});

		type JobRow = {
			readonly id: string;
			readonly memory_id: string | null;
			readonly document_id: string | null;
			readonly job_type: string;
			readonly status: string;
			readonly attempts: number;
			readonly max_attempts: number;
			readonly leased_at: string | null;
			readonly completed_at: string | null;
			readonly failed_at: string | null;
			readonly error: string | null;
			readonly created_at: string;
			readonly updated_at: string;
		};

		const isJobRow = (val: unknown): val is JobRow => {
			if (!val || typeof val !== "object") return false;
			const obj = val as Record<string, unknown>;
			return (
				typeof obj.id === "string" &&
				typeof obj.job_type === "string" &&
				typeof obj.status === "string" &&
				typeof obj.attempts === "number" &&
				typeof obj.max_attempts === "number" &&
				typeof obj.created_at === "string" &&
				typeof obj.updated_at === "string"
			);
		};

		const row = isJobRow(maybeRow) ? maybeRow : null;

		if (!row) {
			return c.json({ error: "Job not found" }, 404);
		}

		return c.json({
			id: row.id,
			memory_id: row.memory_id,
			document_id: row.document_id,
			job_type: row.job_type,
			status: row.status,
			attempt_count: row.attempts,
			attempts: row.attempts,
			max_attempts: row.max_attempts,
			next_attempt_at: null,
			last_error: row.error,
			last_error_code: null,
			error: row.error,
			leased_at: row.leased_at,
			completed_at: row.completed_at,
			failed_at: row.failed_at,
			created_at: row.created_at,
			updated_at: row.updated_at,
		});
	});

	// =========================================================================
	// POST /api/memory/:id/recover
	// =========================================================================
	app.post("/api/memory/:id/recover", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const memoryId = c.req.param("id")?.trim();
		if (!memoryId) {
			return c.json({ error: "memory id is required" }, 400);
		}

		const reason = parseOptionalString(payload.reason) ?? parseOptionalString(c.req.query("reason"));
		if (!reason) {
			return c.json({ error: "reason is required" }, 400);
		}

		const hasIfVersionInBody = Object.prototype.hasOwnProperty.call(payload, "if_version");
		const ifVersionBody = parseOptionalInt(payload.if_version);
		if (hasIfVersionInBody && ifVersionBody === undefined) {
			return c.json({ error: "if_version must be a positive integer" }, 400);
		}

		const queryIfVersionRaw = c.req.query("if_version");
		const ifVersionQuery = parseOptionalInt(queryIfVersionRaw);
		if (queryIfVersionRaw !== undefined && ifVersionQuery === undefined) {
			return c.json({ error: "if_version must be a positive integer" }, 400);
		}
		const ifVersion = ifVersionBody ?? ifVersionQuery;

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (cfg.pipelineV2.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		const now = new Date().toISOString();
		const actor = resolveMutationActor(c, parseOptionalString(payload.changed_by));
		const txResult = getDbAccessor().withWriteTx((db) =>
			txRecoverMemory(db, {
				memoryId,
				reason,
				changedBy: actor.changedBy,
				changedAt: now,
				retentionWindowMs: SOFT_DELETE_RETENTION_MS,
				ifVersion,
				ctx: actor,
			}),
		);

		switch (txResult.status) {
			case "recovered":
				return c.json({
					id: txResult.memoryId,
					status: txResult.status,
					currentVersion: txResult.currentVersion,
					newVersion: txResult.newVersion,
					retentionDays: SOFT_DELETE_RETENTION_DAYS,
				});
			case "not_found":
				return c.json({ id: txResult.memoryId, status: txResult.status, error: "Not found" }, 404);
			case "not_deleted":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Memory is not deleted",
					},
					409,
				);
			case "retention_expired":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: `Recover window expired (${SOFT_DELETE_RETENTION_DAYS} days)`,
					},
					409,
				);
			case "version_conflict":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Version conflict",
					},
					409,
				);
		}

		return c.json({ error: "Unknown mutation result" }, 500);
	});

	// =========================================================================
	// PATCH /api/memory/:id
	// =========================================================================
	app.patch("/api/memory/:id", async (c) => {
		const payload = toRecord(await c.req.json().catch(() => null));
		if (!payload) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const memoryId = c.req.param("id")?.trim();
		if (!memoryId) {
			return c.json({ error: "memory id is required" }, 400);
		}

		const reason = parseOptionalString(payload.reason);
		if (!reason) {
			return c.json({ error: "reason is required" }, 400);
		}

		const hasIfVersion = Object.prototype.hasOwnProperty.call(payload, "if_version");
		const ifVersion = parseOptionalInt(payload.if_version);
		if (hasIfVersion && ifVersion === undefined) {
			return c.json({ error: "if_version must be a positive integer" }, 400);
		}

		const parsedPatch = parseModifyPatch(payload);
		if (!parsedPatch.ok) {
			return c.json({ error: parsedPatch.error }, 400);
		}

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (cfg.pipelineV2.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		let embeddingVector: number[] | null = null;
		if (parsedPatch.value.contentForEmbedding !== null) {
			embeddingVector = await fetchEmbedding(parsedPatch.value.contentForEmbedding, cfg.embedding);
		}

		const now = new Date().toISOString();
		const actor = resolveMutationActor(c, parseOptionalString(payload.changed_by));
		const txResult = getDbAccessor().withWriteTx((db) =>
			txModifyMemory(db, {
				memoryId,
				patch: parsedPatch.value.patch,
				reason,
				changedBy: actor.changedBy,
				changedAt: now,
				ifVersion,
				extractionStatusOnContentChange: "none",
				extractionModelOnContentChange: null,
				embeddingModelOnContentChange: cfg.embedding.model,
				embeddingVector,
				ctx: actor,
			}),
		);

		switch (txResult.status) {
			case "updated":
				return c.json({
					id: txResult.memoryId,
					status: txResult.status,
					currentVersion: txResult.currentVersion,
					newVersion: txResult.newVersion,
					contentChanged: txResult.contentChanged ?? false,
					embedded: txResult.contentChanged === true && embeddingVector !== null ? true : undefined,
				});
			case "no_changes":
				return c.json({
					id: txResult.memoryId,
					status: txResult.status,
					currentVersion: txResult.currentVersion,
				});
			case "not_found":
				return c.json({ id: txResult.memoryId, status: txResult.status, error: "Not found" }, 404);
			case "deleted":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Cannot modify deleted memory",
					},
					409,
				);
			case "version_conflict":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Version conflict",
					},
					409,
				);
			case "duplicate_content_hash":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						duplicateMemoryId: txResult.duplicateMemoryId,
						error: "Duplicate content hash",
					},
					409,
				);
		}

		return c.json({ error: "Unknown mutation result" }, 500);
	});

	// =========================================================================
	// DELETE /api/memory/:id
	// =========================================================================
	app.delete("/api/memory/:id", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const memoryId = c.req.param("id")?.trim();
		if (!memoryId) {
			return c.json({ error: "memory id is required" }, 400);
		}

		const reason = parseOptionalString(payload.reason) ?? parseOptionalString(c.req.query("reason"));
		if (!reason) {
			return c.json({ error: "reason is required" }, 400);
		}

		const hasForceInBody = Object.prototype.hasOwnProperty.call(payload, "force");
		const forceFromBody = parseOptionalBoolean(payload.force);
		if (hasForceInBody && forceFromBody === undefined) {
			return c.json({ error: "force must be a boolean" }, 400);
		}
		const forceFromQuery = parseOptionalBoolean(c.req.query("force"));
		const force = forceFromBody ?? forceFromQuery ?? false;

		const hasIfVersionInBody = Object.prototype.hasOwnProperty.call(payload, "if_version");
		const ifVersionBody = parseOptionalInt(payload.if_version);
		if (hasIfVersionInBody && ifVersionBody === undefined) {
			return c.json({ error: "if_version must be a positive integer" }, 400);
		}

		const queryIfVersionRaw = c.req.query("if_version");
		const ifVersionQuery = parseOptionalInt(queryIfVersionRaw);
		if (queryIfVersionRaw !== undefined && ifVersionQuery === undefined) {
			return c.json({ error: "if_version must be a positive integer" }, 400);
		}
		const ifVersion = ifVersionBody ?? ifVersionQuery;

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (cfg.pipelineV2.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		const now = new Date().toISOString();
		const actor = resolveMutationActor(c, parseOptionalString(payload.changed_by));
		const txResult = getDbAccessor().withWriteTx((db) =>
			txForgetMemory(db, {
				memoryId,
				reason,
				changedBy: actor.changedBy,
				changedAt: now,
				force,
				ifVersion,
				ctx: actor,
			}),
		);

		switch (txResult.status) {
			case "deleted":
				return c.json({
					id: txResult.memoryId,
					status: txResult.status,
					currentVersion: txResult.currentVersion,
					newVersion: txResult.newVersion,
				});
			case "not_found":
				return c.json({ id: txResult.memoryId, status: txResult.status, error: "Not found" }, 404);
			case "already_deleted":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
					},
					409,
				);
			case "version_conflict":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Version conflict",
					},
					409,
				);
			case "pinned_requires_force":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Pinned memories require force=true",
					},
					409,
				);
			case "autonomous_force_denied":
				return c.json(
					{
						id: txResult.memoryId,
						status: txResult.status,
						currentVersion: txResult.currentVersion,
						error: "Autonomous agents cannot force-delete pinned memories",
					},
					403,
				);
		}

		return c.json({ error: "Unknown mutation result" }, 500);
	});

	// =========================================================================
	// POST /api/memory/feedback
	// =========================================================================
	app.post("/api/memory/feedback", async (c) => {
		const payload = toRecord(await c.req.json().catch(() => null));
		if (!payload) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const sessionKey = parseOptionalString(payload.sessionKey);
		const feedback = payload.feedback;
		if (!sessionKey || !feedback) {
			return c.json({ error: "sessionKey and feedback required" }, 400);
		}

		const parsed = parseFeedback(feedback);
		if (!parsed) {
			return c.json({ error: "Invalid feedback format — expected map of ID to number (-1 to 1)" }, 400);
		}

		const agentId = parseOptionalString(payload.agentId) ?? "default";
		const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.feedback;
		try {
			const result = recordPathFeedback(getDbAccessor(), {
				sessionKey,
				agentId,
				ratings: parsed,
				paths: payload.paths,
				rewards: payload.rewards,
				maxAspectWeight: cfg?.maxAspectWeight,
				minAspectWeight: cfg?.minAspectWeight,
			});
			return c.json({
				ok: true,
				recorded: Object.keys(parsed).length,
				accepted: result.accepted,
				rejected: Math.max(0, Object.keys(parsed).length - result.accepted),
				propagated: result.propagated,
				cooccurrenceUpdated: result.cooccurrenceUpdated,
				dependenciesUpdated: result.dependenciesUpdated,
				acceptanceRule: "accepted means the memory id was recorded for this session and agent",
			});
		} catch (error) {
			recordAgentFeedback(sessionKey, parsed, agentId);
			logger.warn("daemon", "Path feedback failed; fell back to legacy feedback", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey,
			});
			return c.json({ ok: true, recorded: Object.keys(parsed).length, fallback: true });
		}
	});

	// =========================================================================
	// POST /api/memory/forget — batch forget
	// =========================================================================
	app.post("/api/memory/forget", async (c) => {
		const payload = toRecord(await c.req.json().catch(() => null));
		if (!payload) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const mode = parseOptionalString(payload.mode) ?? "preview";
		if (mode !== "preview" && mode !== "execute") {
			return c.json({ error: "mode must be preview or execute" }, 400);
		}

		const hasLimit = Object.prototype.hasOwnProperty.call(payload, "limit");
		const parsedLimit = parseOptionalInt(payload.limit);
		if (hasLimit && parsedLimit === undefined) {
			return c.json({ error: "limit must be a positive integer" }, 400);
		}
		const limit = Math.max(1, Math.min(parsedLimit ?? 20, MAX_MUTATION_BATCH));

		let ids: string[] = [];
		if (Object.prototype.hasOwnProperty.call(payload, "ids")) {
			if (!Array.isArray(payload.ids)) {
				return c.json({ error: "ids must be an array of strings" }, 400);
			}
			const parsedIds: string[] = [];
			for (const value of payload.ids) {
				if (typeof value !== "string" || value.trim().length === 0) {
					return c.json({ error: "ids must contain non-empty strings" }, 400);
				}
				parsedIds.push(value.trim());
			}
			ids = parsedIds;
		}

		const request: ForgetCandidatesRequest = {
			query: parseOptionalString(payload.query) ?? "",
			type: parseOptionalString(payload.type) ?? "",
			tags: parseOptionalString(payload.tags) ?? "",
			who: parseOptionalString(payload.who) ?? "",
			sourceType: parseOptionalString(payload.source_type) ?? "",
			since: parseOptionalString(payload.since) ?? "",
			until: parseOptionalString(payload.until) ?? "",
			scope: parseOptionalString(payload.scope) ?? null,
			limit,
		};

		const hasQueryScope =
			request.query.length > 0 ||
			request.type.length > 0 ||
			request.tags.length > 0 ||
			request.who.length > 0 ||
			request.sourceType.length > 0 ||
			request.since.length > 0 ||
			request.until.length > 0 ||
			request.scope !== null;
		if (ids.length === 0 && !hasQueryScope) {
			return c.json(
				{
					error: "query, ids, or at least one filter (type/tags/who/source_type/since/until) is required",
				},
				400,
			);
		}

		const candidates = ids.length > 0 ? loadForgetCandidatesByIds(ids, limit) : loadForgetCandidates(request);
		const candidateIds = candidates.map((candidate) => candidate.id);
		const confirmToken = buildForgetConfirmToken(candidateIds);
		const requiresConfirm = candidateIds.length > FORGET_CONFIRM_THRESHOLD;

		if (mode === "preview") {
			return c.json({
				mode: "preview",
				count: candidates.length,
				requiresConfirm,
				confirmToken,
				candidates: candidates.map((candidate) => ({
					id: candidate.id,
					score: Math.round(candidate.score * 1000) / 1000,
					pinned: candidate.pinned === 1,
					version: candidate.version,
				})),
			});
		}

		const reason = parseOptionalString(payload.reason);
		if (!reason) {
			return c.json({ error: "reason is required for execute mode" }, 400);
		}

		const hasForce = Object.prototype.hasOwnProperty.call(payload, "force");
		const force = parseOptionalBoolean(payload.force);
		if (hasForce && force === undefined) {
			return c.json({ error: "force must be a boolean" }, 400);
		}

		if (Object.prototype.hasOwnProperty.call(payload, "if_version")) {
			return c.json(
				{
					error: "if_version is not supported for batch forget; use DELETE /api/memory/:id for version-guarded deletes",
				},
				400,
			);
		}

		if (requiresConfirm) {
			const providedToken = parseOptionalString(payload.confirm_token);
			if (!providedToken || providedToken !== confirmToken) {
				return c.json(
					{
						error: "confirm_token is required for large forget operations; run preview first",
						requiresConfirm: true,
						confirmToken,
						count: candidates.length,
					},
					400,
				);
			}
		}

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (cfg.pipelineV2.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		const actor = resolveMutationActor(c, parseOptionalString(payload.changed_by));
		const changedAt = new Date().toISOString();

		const results: Array<{
			id: string;
			status: string;
			currentVersion?: number;
			newVersion?: number;
		}> = [];

		for (const memoryId of candidateIds) {
			const txResult = getDbAccessor().withWriteTx((db) =>
				txForgetMemory(db, {
					memoryId,
					reason,
					changedBy: actor.changedBy,
					changedAt,
					force: force ?? false,
					ctx: actor,
				}),
			);
			results.push({
				id: txResult.memoryId,
				status: txResult.status,
				currentVersion: txResult.currentVersion,
				newVersion: txResult.newVersion,
			});
		}

		return c.json({
			mode: "execute",
			requested: candidateIds.length,
			deleted: results.filter((result) => result.status === "deleted").length,
			results,
		});
	});

	// =========================================================================
	// POST /api/memory/modify — batch modify
	// =========================================================================
	app.post("/api/memory/modify", async (c) => {
		const payload = toRecord(await c.req.json().catch(() => null));
		if (!payload) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!Array.isArray(payload.patches) || payload.patches.length === 0) {
			return c.json({ error: "patches[] is required" }, 400);
		}
		if (payload.patches.length > MAX_MUTATION_BATCH) {
			return c.json(
				{
					error: `patches[] exceeds maximum batch size (${MAX_MUTATION_BATCH})`,
				},
				400,
			);
		}

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (cfg.pipelineV2.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		const defaultReason = parseOptionalString(payload.reason);
		const actor = resolveMutationActor(c, parseOptionalString(payload.changed_by));
		const changedAt = new Date().toISOString();

		const results: Array<{
			id: string | null;
			status: string;
			error?: string;
			currentVersion?: number;
			newVersion?: number;
			duplicateMemoryId?: string;
			contentChanged?: boolean;
			embedded?: boolean;
		}> = [];

		for (const rawPatch of payload.patches) {
			const patchPayload = toRecord(rawPatch);
			if (!patchPayload) {
				results.push({
					id: null,
					status: "invalid_request",
					error: "Each patch must be an object",
				});
				continue;
			}

			const memoryId = parseOptionalString(patchPayload.id);
			if (!memoryId) {
				results.push({
					id: null,
					status: "invalid_request",
					error: "Patch id is required",
				});
				continue;
			}

			const reason = parseOptionalString(patchPayload.reason) ?? defaultReason;
			if (!reason) {
				results.push({
					id: memoryId,
					status: "invalid_request",
					error: "reason is required",
				});
				continue;
			}

			const hasIfVersion = Object.prototype.hasOwnProperty.call(patchPayload, "if_version");
			const ifVersion = parseOptionalInt(patchPayload.if_version);
			if (hasIfVersion && ifVersion === undefined) {
				results.push({
					id: memoryId,
					status: "invalid_request",
					error: "if_version must be a positive integer",
				});
				continue;
			}

			const parsedPatch = parseModifyPatch(patchPayload);
			if (!parsedPatch.ok) {
				results.push({
					id: memoryId,
					status: "invalid_request",
					error: parsedPatch.error,
				});
				continue;
			}

			let embeddingVector: number[] | null = null;
			if (parsedPatch.value.contentForEmbedding !== null) {
				embeddingVector = await fetchEmbedding(parsedPatch.value.contentForEmbedding, cfg.embedding);
			}

			const txResult = getDbAccessor().withWriteTx((db) =>
				txModifyMemory(db, {
					memoryId,
					patch: parsedPatch.value.patch,
					reason,
					changedBy: actor.changedBy,
					changedAt,
					ifVersion,
					extractionStatusOnContentChange: "none",
					extractionModelOnContentChange: null,
					embeddingModelOnContentChange: cfg.embedding.model,
					embeddingVector,
					ctx: actor,
				}),
			);

			results.push({
				id: txResult.memoryId,
				status: txResult.status,
				currentVersion: txResult.currentVersion,
				newVersion: txResult.newVersion,
				duplicateMemoryId: txResult.duplicateMemoryId,
				contentChanged: txResult.contentChanged,
				embedded: txResult.contentChanged === true && embeddingVector !== null ? true : undefined,
			});
		}

		return c.json({
			total: results.length,
			updated: results.filter((result) => result.status === "updated").length,
			results,
		});
	});

	// =========================================================================
	// POST /api/memory/recall
	// =========================================================================
	app.post("/api/memory/recall", async (c) => {
		let body: RecallParams;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const query = body.query?.trim() ?? "";
		if (!query) return c.json({ error: "query is required" }, 400);

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (cfg.pipelineV2.reranker.enabled && cfg.pipelineV2.reranker.useExtractionModel && authConfig.mode !== "local") {
			const actor = c.get("auth")?.claims?.sub ?? "anonymous";
			const check = authRecallLlmLimiter.check(actor);
			if (!check.allowed) {
				c.header("Retry-After", String(Math.ceil((check.resetAt - Date.now()) / 1000)));
				return c.json({ error: "rate limit exceeded", retryAfter: check.resetAt }, 429);
			}
			authRecallLlmLimiter.record(actor);
		}
		try {
			const agentId = resolveAgentId({ agentId: body.agentId, sessionKey: c.req.header("x-signet-session-key") });
			const agentScope = getAgentScope(agentId);
			const scopeProject = c.get("auth")?.claims?.scope?.project;
			const result = await hybridRecall(
				{
					...body,
					query,
					agentId,
					readPolicy: agentScope.readPolicy,
					policyGroup: agentScope.policyGroup,
					...(scopeProject ? { project: scopeProject } : {}),
				},
				cfg,
				fetchEmbedding,
			);
			return c.json(result);
		} catch (e) {
			logger.error("memory", "Recall failed", e as Error);
			return c.json({ error: "Recall failed", results: [] }, 500);
		}
	});

	// =========================================================================
	// GET /api/memory/search — recall alias
	// =========================================================================
	app.get("/api/memory/search", async (c) => {
		const q = (c.req.query("q") ?? "").trim();
		if (!q) return c.json({ error: "query is required" }, 400);

		const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);
		const type = c.req.query("type");
		const tags = c.req.query("tags");
		const who = c.req.query("who");
		const pinned = c.req.query("pinned");
		const importanceMin = c.req.query("importance_min");
		const since = c.req.query("since");
		const expand = c.req.query("expand");

		const cfg = loadMemoryConfig(AGENTS_DIR);
		const scopeProject = c.get("auth")?.claims?.scope?.project;
		try {
			const result = await hybridRecall(
				{
					query: q,
					limit,
					type,
					tags,
					who,
					pinned: pinned === "1" || pinned === "true",
					importance_min: importanceMin ? Number.parseFloat(importanceMin) : undefined,
					since,
					expand: expand === "1" || expand === "true",
					...(scopeProject ? { project: scopeProject } : {}),
				},
				cfg,
				fetchEmbedding,
			);
			return c.json(result);
		} catch (e) {
			logger.error("memory", "Search (recall alias) failed", e as Error);
			return c.json({ error: "Recall failed", results: [] }, 500);
		}
	});

	// =========================================================================
	// GET /memory/similar — vector similarity search
	// =========================================================================
	app.get("/memory/similar", async (c) => {
		const id = c.req.query("id");
		if (!id) {
			return c.json({ error: "id is required", results: [] }, 400);
		}

		const k = Number.parseInt(c.req.query("k") ?? "10", 10);
		const type = c.req.query("type");

		try {
			const searchData = getDbAccessor().withReadDb((db) => {
				const embeddingRow = db
					.prepare(`
        SELECT vector
        FROM embeddings
        WHERE source_type = 'memory' AND source_id = ?
        LIMIT 1
      `)
					.get(id) as { vector: Buffer } | undefined;

				if (!embeddingRow) return null;

				const queryVector = new Float32Array(
					embeddingRow.vector.buffer.slice(
						embeddingRow.vector.byteOffset,
						embeddingRow.vector.byteOffset + embeddingRow.vector.byteLength,
					),
				);

				return vectorSearch(db as any, queryVector, {
					limit: k + 1,
					type: type as "fact" | "preference" | "decision" | undefined,
				});
			});

			if (!searchData) {
				return c.json({ error: "No embedding found for this memory", results: [] }, 404);
			}

			const filteredResults = searchData.filter((r) => r.id !== id).slice(0, k);

			if (filteredResults.length === 0) {
				return c.json({ results: [] });
			}

			const ids = filteredResults.map((r) => r.id);
			const placeholders = ids.map(() => "?").join(", ");

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(`
        SELECT id, content, type, tags, confidence, created_at
        FROM memories
        WHERE id IN (${placeholders})
      `)
						.all(...ids) as Array<{
						id: string;
						content: string;
						type: string;
						tags: string | null;
						confidence: number;
						created_at: string;
					}>,
			);

			const rowMap = new Map(rows.map((r) => [r.id, r]));
			const results = filteredResults
				.filter((r) => rowMap.has(r.id))
				.map((r) => {
					const row = rowMap.get(r.id);
					if (!row) return null;
					return {
						id: r.id,
						content: row.content,
						type: row.type,
						tags: parseTagsField(row.tags),
						score: Math.round(r.score * 100) / 100,
						confidence: row.confidence,
						created_at: row.created_at,
					};
				})
				.filter((r): r is NonNullable<typeof r> => r !== null);

			return c.json({ results });
		} catch (e) {
			logger.error("memory", "Similarity search failed", e as Error);
			return c.json({ error: "Similarity search failed", results: [] }, 500);
		}
	});

	// =========================================================================
	// GET /api/embeddings
	// =========================================================================
	app.get("/api/embeddings", async (c) => {
		const withVectors = c.req.query("vectors") === "true";
		const limit = parseBoundedInt(c.req.query("limit"), 600, 50, 5000);
		const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 100000);

		type EmbeddingRow = {
			id: string;
			content: string;
			who: string | null;
			importance: number | null;
			type: string | null;
			tags: string | null;
			source_type: string | null;
			source_id: string | null;
			created_at: string;
			vector?: Buffer;
			dimensions?: number | null;
		};

		try {
			const { total, rows } = getDbAccessor().withReadDb((db) => {
				const totalRow = db
					.prepare(`
				SELECT COUNT(*) AS count
				FROM embeddings e
				INNER JOIN memories m ON m.id = e.source_id
				WHERE e.source_type = 'memory'
			`)
					.get() as { count: number } | undefined;

				const rowData = withVectors
					? (db
							.prepare(`
					SELECT
						m.id, m.content, m.who, m.importance, m.type, m.tags,
						m.source_type, m.source_id, m.created_at,
						e.vector, e.dimensions
					FROM embeddings e
					INNER JOIN memories m ON m.id = e.source_id
					WHERE e.source_type = 'memory'
					ORDER BY m.created_at DESC
					LIMIT ? OFFSET ?
				`)
							.all(limit, offset) as EmbeddingRow[])
					: (db
							.prepare(`
					SELECT
						m.id, m.content, m.who, m.importance, m.type, m.tags,
						m.source_type, m.source_id, m.created_at
					FROM embeddings e
					INNER JOIN memories m ON m.id = e.source_id
					WHERE e.source_type = 'memory'
					ORDER BY m.created_at DESC
					LIMIT ? OFFSET ?
				`)
							.all(limit, offset) as EmbeddingRow[]);

				return { total: totalRow?.count ?? 0, rows: rowData };
			});

			const embeddings = rows.map((row) => ({
				id: row.id,
				content: row.content,
				text: row.content,
				who: row.who ?? "unknown",
				importance: typeof row.importance === "number" ? row.importance : 0.5,
				type: row.type,
				tags: parseTagsField(row.tags),
				sourceType: row.source_type ?? "memory",
				sourceId: row.source_id ?? row.id,
				createdAt: row.created_at,
				vector: withVectors && row.vector ? blobToVector(row.vector, row.dimensions ?? null) : undefined,
			}));

			return c.json({
				embeddings,
				count: embeddings.length,
				total,
				limit,
				offset,
				hasMore: offset + embeddings.length < total,
			});
		} catch (e) {
			if (isMissingEmbeddingsTableError(e)) {
				const legacy = await runLegacyEmbeddingsExport(withVectors, limit, offset, AGENTS_DIR);
				if (legacy) {
					if (legacy.error) {
						logger.warn("memory", "Legacy embeddings export failed", {
							error: legacy.error,
						});
						return c.json(legacy, 500);
					}
					return c.json(legacy);
				}
			}

			return c.json({
				error: (e as Error).message,
				embeddings: [],
				count: 0,
				total: 0,
				limit,
				offset,
				hasMore: false,
			});
		}
	});

	// =========================================================================
	// GET /api/embeddings/status
	// =========================================================================
	app.get("/api/embeddings/status", async (c) => {
		const config = loadMemoryConfig(AGENTS_DIR);
		const status = await checkEmbeddingProvider(config.embedding);
		const tracker = embeddingTrackerHandle?.getStats() ?? null;
		return c.json({ ...status, tracker });
	});

	// =========================================================================
	// GET /api/embeddings/health
	// =========================================================================
	app.get("/api/embeddings/health", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const providerStatus = await checkEmbeddingProvider(cfg.embedding);
		const report = getDbAccessor().withReadDb((db) => buildEmbeddingHealth(db, cfg.embedding, providerStatus));
		return c.json(report);
	});

	// =========================================================================
	// GET /api/embeddings/projection
	// =========================================================================
	app.get("/api/embeddings/projection", async (c) => {
		const dimParam = c.req.query("dimensions");
		const nComponents: 2 | 3 = dimParam === "3" ? 3 : 2;
		const limit = parseOptionalBoundedInt(c.req.query("limit"), 1, 5000);
		const offset = parseOptionalBoundedInt(c.req.query("offset"), 0, 100000) ?? 0;

		const query = parseOptionalString(c.req.query("q"));
		const whoFilters = [...new Set([...parseCsvQuery(c.req.query("who")), ...parseCsvQuery(c.req.query("harness"))])];
		const typeFilters = (() => {
			const list = parseCsvQuery(c.req.query("types"));
			if (list.length > 0) return list;
			const single = parseOptionalString(c.req.query("type"));
			return single ? [single] : [];
		})();
		const sourceTypeFilters = (() => {
			const list = parseCsvQuery(c.req.query("sourceTypes"));
			if (list.length > 0) return list;
			const legacy = parseCsvQuery(c.req.query("source_type"));
			if (legacy.length > 0) return legacy;
			const single = parseOptionalString(c.req.query("sourceType"));
			return single ? [single] : [];
		})();
		const tagFilters = parseCsvQuery(c.req.query("tags"));
		const pinned = parseOptionalBoolean(c.req.query("pinned"));
		const since = parseIsoDateQuery(c.req.query("since"));
		const until = parseIsoDateQuery(c.req.query("until"));
		let importanceMin =
			parseOptionalBoundedFloat(c.req.query("importanceMin"), 0, 1) ??
			parseOptionalBoundedFloat(c.req.query("importance_min"), 0, 1);
		let importanceMax =
			parseOptionalBoundedFloat(c.req.query("importanceMax"), 0, 1) ??
			parseOptionalBoundedFloat(c.req.query("importance_max"), 0, 1);
		if (typeof importanceMin === "number" && typeof importanceMax === "number" && importanceMin > importanceMax) {
			const swap = importanceMin;
			importanceMin = importanceMax;
			importanceMax = swap;
		}

		const hasFilters =
			query !== undefined ||
			whoFilters.length > 0 ||
			typeFilters.length > 0 ||
			sourceTypeFilters.length > 0 ||
			tagFilters.length > 0 ||
			pinned !== undefined ||
			since !== undefined ||
			until !== undefined ||
			importanceMin !== undefined ||
			importanceMax !== undefined;
		const useCachedProjection = !hasFilters && limit === undefined && offset === 0;

		if (!useCachedProjection) {
			try {
				const projection = getDbAccessor().withReadDb((db) =>
					computeProjectionForQuery(db, nComponents, {
						limit,
						offset,
						filters: hasFilters
							? {
									query,
									who: whoFilters,
									types: typeFilters,
									sourceTypes: sourceTypeFilters,
									tags: tagFilters,
									pinned,
									since,
									until,
									importanceMin,
									importanceMax,
								}
							: undefined,
					}),
				);

				return c.json({
					status: "ready",
					dimensions: nComponents,
					count: projection.count,
					total: projection.total,
					limit: projection.limit,
					offset: projection.offset,
					hasMore: projection.hasMore,
					nodes: projection.result.nodes,
					edges: projection.result.edges,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return c.json({ status: "error", message }, 500);
			}
		}

		const { cached, total } = getDbAccessor().withReadDb((db) => {
			const cachedResult = getCachedProjection(db, nComponents);
			const countRow = db.prepare("SELECT COUNT(*) as count FROM embeddings WHERE source_type = 'memory'").get();
			const count = typeof countRow === "object" && countRow !== null && "count" in countRow && typeof countRow.count === "number" ? countRow.count : 0;
			return { cached: cachedResult, total: count };
		});

		if (cached !== null && cached.embeddingCount === total) {
			return c.json({
				status: "ready",
				dimensions: nComponents,
				count: total,
				total,
				limit: total,
				offset: 0,
				hasMore: false,
				nodes: cached.result.nodes,
				edges: cached.result.edges,
				cachedAt: cached.cachedAt,
			});
		}

		const recentError = projectionErrors.get(nComponents);
		if (recentError) {
			if (Date.now() > recentError.expires) {
				projectionErrors.delete(nComponents);
			} else {
				return c.json({ status: "error", message: recentError.message }, 500);
			}
		}

		if (!projectionInFlight.has(nComponents)) {
			projectionErrors.delete(nComponents);
			const computation = (async () => {
				try {
					const result = getDbAccessor().withReadDb((db) => computeProjection(db, nComponents));
					const count = getDbAccessor().withReadDb((db) => {
					const row = db.prepare("SELECT COUNT(*) as count FROM embeddings WHERE source_type = 'memory'").get();
					return typeof row === "object" && row !== null && "count" in row && typeof row.count === "number" ? row.count : 0;
					});
					getDbAccessor().withWriteTx((db) => cacheProjection(db, nComponents, result, count));
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.error("projection", "UMAP computation failed", err instanceof Error ? err : new Error(msg));
					projectionErrors.set(nComponents, {
						message: msg,
						expires: Date.now() + PROJECTION_ERROR_TTL_MS,
					});
				} finally {
					projectionInFlight.delete(nComponents);
				}
			})();
			projectionInFlight.set(nComponents, computation);
		}

		return c.json({ status: "computing", dimensions: nComponents }, 202);
	});

	// =========================================================================
	// POST /api/documents — create a document for ingestion
	// =========================================================================
	app.post("/api/documents", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = (await c.req.json()) as Record<string, unknown>;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const sourceType = body.source_type as string | undefined;
		if (!sourceType || !["text", "url", "file"].includes(sourceType)) {
			return c.json({ error: "source_type must be text, url, or file" }, 400);
		}

		if (sourceType === "text" && typeof body.content !== "string") {
			return c.json({ error: "content is required for text source_type" }, 400);
		}
		if (sourceType === "url" && typeof body.url !== "string") {
			return c.json({ error: "url is required for url source_type" }, 400);
		}

		const sourceUrl =
			sourceType === "url"
				? (body.url as string)
				: sourceType === "file"
					? ((body.url as string | undefined) ?? null)
					: null;

		const accessor = getDbAccessor();

		try {
			const id = crypto.randomUUID();
			const now = new Date().toISOString();

			const result = accessor.withWriteTx((db) => {
				if (sourceUrl) {
					const existing = db
						.prepare(
							`SELECT id, status FROM documents
							 WHERE source_url = ?
							   AND status NOT IN ('failed', 'deleted')
							 LIMIT 1`,
						)
						.get(sourceUrl) as { id: string; status: string } | undefined;
					if (existing) {
						return { deduplicated: true as const, existing };
					}
				}

				db.prepare(
					`INSERT INTO documents
					 (id, source_url, source_type, content_type, title,
					  raw_content, status, connector_id, chunk_count,
					  memory_count, metadata_json, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?)`,
				).run(
					id,
					sourceUrl,
					sourceType,
					(body.content_type as string | undefined) ?? null,
					(body.title as string | undefined) ?? null,
					sourceType === "text" ? (body.content as string) : null,
					(body.connector_id as string | undefined) ?? null,
					body.metadata ? JSON.stringify(body.metadata) : null,
					now,
					now,
				);

				return { deduplicated: false as const };
			});

			if (result.deduplicated) {
				return c.json({
					id: result.existing.id,
					status: result.existing.status,
					deduplicated: true,
				});
			}

			const jobId = enqueueDocumentIngestJob(accessor, id);
			return c.json({ id, status: "queued", jobId: jobId ?? undefined }, 201);
		} catch (e) {
			logger.error("documents", "Failed to create document", e as Error);
			return c.json({ error: "Failed to create document" }, 500);
		}
	});

	// =========================================================================
	// GET /api/documents — list documents
	// =========================================================================
	app.get("/api/documents", (c) => {
		const status = c.req.query("status");
		const limit = Math.min(Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50), 500);
		const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);

		try {
			const accessor = getDbAccessor();
			const result = accessor.withReadDb((db) => {
				const countSql = status
					? "SELECT COUNT(*) AS cnt FROM documents WHERE status = ?"
					: "SELECT COUNT(*) AS cnt FROM documents";
				const countRow = (status ? db.prepare(countSql).get(status) : db.prepare(countSql).get()) as
					| { cnt: number }
					| undefined;
				const total = countRow?.cnt ?? 0;

				const listSql = status
					? `SELECT * FROM documents WHERE status = ?
					   ORDER BY created_at DESC LIMIT ? OFFSET ?`
					: `SELECT * FROM documents
					   ORDER BY created_at DESC LIMIT ? OFFSET ?`;
				const documents = status
					? db.prepare(listSql).all(status, limit, offset)
					: db.prepare(listSql).all(limit, offset);

				return { documents, total };
			});

			return c.json({ ...result, limit, offset });
		} catch (e) {
			logger.error("documents", "Failed to list documents", e as Error);
			return c.json({ error: "Failed to list documents" }, 500);
		}
	});

	// =========================================================================
	// GET /api/documents/:id — single document details
	// =========================================================================
	app.get("/api/documents/:id", (c) => {
		const id = c.req.param("id");
		try {
			const accessor = getDbAccessor();
			const doc = accessor.withReadDb((db) => {
				return db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
			});
			if (!doc) return c.json({ error: "Document not found" }, 404);
			return c.json(doc);
		} catch (e) {
			logger.error("documents", "Failed to get document", e as Error);
			return c.json({ error: "Failed to get document" }, 500);
		}
	});

	// =========================================================================
	// GET /api/documents/:id/chunks — list memories linked to document
	// =========================================================================
	app.get("/api/documents/:id/chunks", (c) => {
		const id = c.req.param("id");
		try {
			const accessor = getDbAccessor();
			const chunks = accessor.withReadDb((db) => {
				return db
					.prepare(
						`SELECT m.id, m.content, m.type, m.created_at,
					        dm.chunk_index
					 FROM document_memories dm
					 JOIN memories m ON m.id = dm.memory_id
					 WHERE dm.document_id = ? AND m.is_deleted = 0
					 ORDER BY dm.chunk_index ASC`,
					)
					.all(id);
			});
			return c.json({ chunks, count: chunks.length });
		} catch (e) {
			logger.error("documents", "Failed to list chunks", e as Error);
			return c.json({ error: "Failed to list chunks" }, 500);
		}
	});

	// =========================================================================
	// DELETE /api/documents/:id — soft-delete document and derived memories
	// =========================================================================
	app.delete("/api/documents/:id", async (c) => {
		const id = c.req.param("id");
		const reason = c.req.query("reason");
		if (!reason) {
			return c.json({ error: "reason query parameter is required" }, 400);
		}

		const accessor = getDbAccessor();
		const doc = accessor.withReadDb((db) => {
			return db.prepare("SELECT id FROM documents WHERE id = ?").get(id) as { id: string } | undefined;
		});
		if (!doc) return c.json({ error: "Document not found" }, 404);

		try {
			const now = new Date().toISOString();
			const actor = resolveMutationActor(c, "document-api");

			const linkedMemories = accessor.withReadDb((db) => {
				return db
					.prepare(
						`SELECT memory_id FROM document_memories
						 WHERE document_id = ?`,
					)
					.all(id) as ReadonlyArray<{ memory_id: string }>;
			});

			let memoriesRemoved = 0;
			for (const link of linkedMemories) {
				accessor.withWriteTx((db) => {
					const mem = db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get(link.memory_id) as
						| { is_deleted: number }
						| undefined;
					if (!mem || mem.is_deleted === 1) return;

					db.prepare(
						`UPDATE memories
						 SET is_deleted = 1, deleted_at = ?, updated_at = ?,
						     updated_by = ?, version = version + 1
						 WHERE id = ?`,
					).run(now, now, actor.changedBy, link.memory_id);

					const histId = crypto.randomUUID();
					db.prepare(
						`INSERT INTO memory_history
						 (id, memory_id, event, old_content, new_content,
						  changed_by, reason, metadata, created_at)
						 VALUES (?, ?, 'deleted', NULL, NULL, ?, ?, NULL, ?)`,
					).run(histId, link.memory_id, actor.changedBy, `Document deleted: ${reason}`, now);

					memoriesRemoved++;
				});
			}

			accessor.withWriteTx((db) => {
				db.prepare(
					`UPDATE documents
					 SET status = 'deleted', error = ?, updated_at = ?
					 WHERE id = ?`,
				).run(reason, now, id);
			});

			return c.json({ deleted: true, memoriesRemoved });
		} catch (e) {
			logger.error("documents", "Failed to delete document", e as Error);
			return c.json({ error: "Failed to delete document" }, 500);
		}
	});
}
