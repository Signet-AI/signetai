import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { vectorSearch } from "@signet/core";
import type { Hono } from "hono";
import { getAgentScope, resolveAgentId } from "../agent-id";
import { aggregateRecall, parseAggregateRecallBudget, readAggregateRecallBudgetInput } from "../aggregate-recall";
import { checkScope, requirePermission, requireRateLimit } from "../auth";
import { normalizeAndHashContent } from "../content-normalization";
import { type WriteDb, getDbAccessor } from "../db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert, vectorToBlob } from "../db-helpers";
import { fetchEmbedding } from "../embedding-fetch";
import { buildEmbeddingHealth } from "../embedding-health";
import { getInferenceRouterOrNull } from "../inference-router";
import { linkMemoryToEntities } from "../inline-entity-linker";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { type RecallParams, buildAgentScopeClause, hybridRecall } from "../memory-search";
import { recordMemorySearchTelemetry } from "../memory-search-telemetry";
import { resolveMemorySearchTelemetryProject } from "../memory-search-telemetry-project";
import { buildMemoryTimeline } from "../memory-timeline";
import { recordPathFeedback } from "../path-feedback";
import { enqueueDocumentIngestJob } from "../pipeline";
import { parseFeedback, recordAgentFeedback } from "../session-memories";
import { upsertSessionTranscript } from "../session-transcripts";
import { txForgetMemory, txIngestEnvelope, txModifyMemory, txRecoverMemory } from "../transactions";
import { cacheProjection, computeProjection, computeProjectionForQuery, getCachedProjection } from "../umap-projection";
import {
	AGENTS_DIR,
	INTERNAL_SELF_HOST,
	PORT,
	PROJECTION_ERROR_TTL_MS,
	authBatchForgetLimiter,
	authConfig,
	authForgetLimiter,
	authModifyLimiter,
	authRecallLlmLimiter,
	embeddingTrackerHandle,
	hasMemoriesSessionIdColumnCache,
	projectionErrors,
	projectionInFlight,
	queueExtractionJob,
} from "./state";
import {
	type FilterParams,
	type ForgetCandidatesRequest,
	blobToVector,
	buildForgetConfirmToken,
	buildWhere,
	buildWhereRaw,
	checkEmbeddingProvider,
	chunkBySentence,
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

export interface MemoryRoutesDeps {
	readonly aggregateRecall?: typeof aggregateRecall;
	readonly hybridRecall?: typeof hybridRecall;
	readonly fetchEmbedding?: typeof fetchEmbedding;
	readonly getInferenceRouterOrNull?: typeof getInferenceRouterOrNull;
}

function parseOptionalIsoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const ts = new Date(trimmed);
	return Number.isNaN(ts.getTime()) ? null : ts.toISOString();
}

function codexHome(): string {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function noteSlug(title: string | undefined, content: string): string {
	const seed = title?.trim() || content.slice(0, 80);
	const slug = seed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || createHash("sha256").update(content).digest("hex").slice(0, 12);
}

interface CodexNativeNoteWriteOptions {
	readonly now?: Date;
	readonly uniqueSuffix?: () => string;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === code
	);
}

export function writeCodexNativeNote(
	input: { readonly content: string; readonly title?: string; readonly tags?: string },
	options: CodexNativeNoteWriteOptions = {},
): string {
	const now = options.now ?? new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const slug = noteSlug(input.title, input.content);
	const dir = join(codexHome(), "memories", "extensions", "ad_hoc", "notes");
	mkdirSync(dir, { recursive: true });
	const baseName = `${timestamp}-${slug}`;
	const frontmatter = [
		"---",
		"source: signet_save_note",
		`created_at: ${JSON.stringify(now.toISOString())}`,
		...(input.title?.trim() ? [`title: ${JSON.stringify(input.title.trim())}`] : []),
		...(input.tags?.trim() ? [`tags: ${JSON.stringify(input.tags.trim())}`] : []),
		"---",
		"",
	].join("\n");
	const noteContent = `${frontmatter}${input.content.trim()}\n`;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const suffix = attempt === 0 ? "" : `-${options.uniqueSuffix?.() ?? randomUUID().slice(0, 8)}`;
		const path = join(dir, `${baseName}${suffix}.md`);
		try {
			writeFileSync(path, noteContent, { encoding: "utf-8", flag: "wx" });
			return path;
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) continue;
			throw error;
		}
	}
	throw new Error("Failed to allocate a unique Codex native note path");
}

interface RememberRowProvenance {
	readonly sourcePath?: string;
	readonly runtimePath?: string;
	readonly idempotencyKey?: string;
}

interface RememberDedupeScope {
	readonly agentId: string;
	readonly visibility: "global" | "private" | "archived";
	readonly scope: string | null;
}

interface RememberDedupeRow {
	readonly id: string;
	readonly type: string;
	readonly tags: string | null;
	readonly pinned: number;
	readonly importance: number;
	readonly content: string;
}

interface RememberDedupeIdRow {
	readonly id: string;
	readonly sourceId: string | null;
}

interface RememberChunkDedupeRow extends RememberDedupeIdRow {
	readonly contentHash: string | null;
	readonly idempotencyKey: string;
}

function pickOptionalString(...values: readonly unknown[]): string | undefined {
	for (const value of values) {
		const parsed = parseOptionalString(value);
		if (parsed) return parsed;
	}
	return undefined;
}

function parseRememberRowProvenance(body: Record<string, unknown>): RememberRowProvenance {
	const metadata = toRecord(body.metadata) ?? {};
	return {
		sourcePath: pickOptionalString(
			body.sourcePath,
			body.source_path,
			body.source,
			metadata.sourcePath,
			metadata.source_path,
			metadata.source,
		),
		runtimePath: pickOptionalString(body.runtimePath, body.runtime_path, metadata.runtimePath, metadata.runtime_path),
		idempotencyKey: pickOptionalString(
			body.idempotencyKey,
			body.idempotency_key,
			metadata.idempotencyKey,
			metadata.idempotency_key,
		),
	};
}

function idempotencyKeyForChunk(baseKey: string | undefined, index: number): string | undefined {
	return baseKey ? `${baseKey}:chunk:${index + 1}` : undefined;
}

function chunkGroupIdForIdempotencyKey(baseKey: string | undefined, input: RememberDedupeScope): string | undefined {
	if (!baseKey) return undefined;
	const hash = createHash("sha256")
		.update(input.agentId || "default")
		.update("\0")
		.update(input.visibility)
		.update("\0")
		.update(input.scope ?? "__NULL__")
		.update("\0")
		.update(baseKey)
		.digest("hex")
		.slice(0, 32);
	return `chunk-group:${hash}`;
}

function escapeSqlLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

function chunkIdempotencyIndex(baseKey: string, key: string): number | null {
	const prefix = `${baseKey}:chunk:`;
	if (!key.startsWith(prefix)) return null;
	const index = Number.parseInt(key.slice(prefix.length), 10);
	return Number.isSafeInteger(index) && index > 0 ? index - 1 : null;
}

function scopedMemoryPredicate(input: RememberDedupeScope): {
	readonly sql: string;
	readonly params: readonly string[];
} {
	return {
		sql: `
			COALESCE(NULLIF(agent_id, ''), 'default') = ?
			AND COALESCE(visibility, 'global') = ?
			AND COALESCE(scope, '__NULL__') = ?
		`,
		params: [input.agentId || "default", input.visibility, input.scope ?? "__NULL__"],
	};
}

function scopedContentHashPredicate(input: RememberDedupeScope): {
	readonly sql: string;
	readonly params: readonly string[];
} {
	return {
		sql: `
			COALESCE(NULLIF(agent_id, ''), 'default') = ?
			AND COALESCE(scope, '__NULL__') = ?
		`,
		params: [input.agentId || "default", input.scope ?? "__NULL__"],
	};
}

function getScopedIdempotencyMemoryId(
	db: WriteDb,
	key: string | undefined,
	input: RememberDedupeScope,
): RememberDedupeIdRow | undefined {
	if (!key) return undefined;
	const scoped = scopedMemoryPredicate(input);
	return db
		.prepare(
			`SELECT id, source_id AS sourceId
			 FROM memories
			 WHERE idempotency_key = ? AND ${scoped.sql} AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(key, ...scoped.params) as RememberDedupeIdRow | undefined;
}

function getScopedIdempotencyDedupeRow(
	db: WriteDb,
	key: string | undefined,
	input: RememberDedupeScope,
): RememberDedupeRow | undefined {
	if (!key) return undefined;
	const scoped = scopedMemoryPredicate(input);
	return db
		.prepare(
			`SELECT id, type, tags, pinned, importance, content
			 FROM memories
			 WHERE idempotency_key = ? AND ${scoped.sql} AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(key, ...scoped.params) as RememberDedupeRow | undefined;
}

function getScopedContentHashMemoryId(
	db: WriteDb,
	contentHash: string,
	input: RememberDedupeScope,
): { readonly id: string } | undefined {
	const scoped = scopedContentHashPredicate(input);
	return db
		.prepare(
			`SELECT id
			 FROM memories
			 WHERE content_hash = ? AND ${scoped.sql} AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(contentHash, ...scoped.params) as { readonly id: string } | undefined;
}

function isMemoryContentHashUniqueError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.message.includes("idx_memories_content_hash_unique") || err.message.includes("memories.content_hash");
}

function getScopedContentHashDedupeRow(
	db: WriteDb,
	contentHash: string,
	input: RememberDedupeScope,
): RememberDedupeRow | undefined {
	const scoped = scopedContentHashPredicate(input);
	return db
		.prepare(
			`SELECT id, type, tags, pinned, importance, content
			 FROM memories
			 WHERE content_hash = ? AND ${scoped.sql} AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(contentHash, ...scoped.params) as RememberDedupeRow | undefined;
}

function getScopedChunkIdempotencyRows(
	db: WriteDb,
	baseKey: string | undefined,
	input: RememberDedupeScope,
): readonly RememberChunkDedupeRow[] {
	if (!baseKey) return [];
	const scoped = scopedMemoryPredicate(input);
	return (
		db
			.prepare(
				`SELECT id, source_id AS sourceId, content_hash AS contentHash, idempotency_key AS idempotencyKey
				 FROM memories
				 WHERE idempotency_key LIKE ? ESCAPE '\\' AND ${scoped.sql} AND is_deleted = 0`,
			)
			.all(`${escapeSqlLike(baseKey)}:chunk:%`, ...scoped.params) as RememberChunkDedupeRow[]
	)
		.filter((row) => chunkIdempotencyIndex(baseKey, row.idempotencyKey) !== null)
		.sort((left, right) => {
			const leftIndex = chunkIdempotencyIndex(baseKey, left.idempotencyKey);
			const rightIndex = chunkIdempotencyIndex(baseKey, right.idempotencyKey);
			return (leftIndex ?? 0) - (rightIndex ?? 0);
		});
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

function recordRecallQaTelemetry(input: {
	readonly route: string;
	readonly agentId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly params: RecallParams;
	readonly result: Awaited<ReturnType<typeof hybridRecall>>;
	readonly cfg: ReturnType<typeof loadMemoryConfig>;
}): void {
	if (!input.cfg.pipelineV2.telemetry.memorySearchQaEnabled) return;
	recordMemorySearchTelemetry(getDbAccessor(), {
		route: input.route,
		agentId: input.agentId,
		sessionKey: input.sessionKey,
		project: input.project,
		params: input.params,
		response: input.result,
		retentionDays: input.cfg.pipelineV2.telemetry.retentionDays,
	});
}

export function registerMemoryRoutes(app: Hono, deps: MemoryRoutesDeps = {}): void {
	const aggregateRecallFn = deps.aggregateRecall ?? aggregateRecall;
	const hybridRecallFn = deps.hybridRecall ?? hybridRecall;
	const fetchEmbeddingFn = deps.fetchEmbedding ?? fetchEmbedding;
	const getInferenceRouterOrNullFn = deps.getInferenceRouterOrNull ?? getInferenceRouterOrNull;
	// =========================================================================
	// Permission guards — memory routes
	// =========================================================================

	app.use("/api/memory/remember", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/memory/save", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/memory/codex-native-note", async (c, next) => {
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
      WHERE COALESCE(is_deleted, 0) = 0
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
					.all(limit, offset);

				const totalResult = db
					.prepare("SELECT COUNT(*) as count FROM memories WHERE COALESCE(is_deleted, 0) = 0")
					.get() as {
					count: number;
				};
				let embeddingsCount = 0;
				try {
					const embResult = db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number };
					embeddingsCount = embResult?.count ?? 0;
				} catch {
					// embeddings table might not exist
				}
				const critResult = db
					.prepare("SELECT COUNT(*) as count FROM memories WHERE COALESCE(is_deleted, 0) = 0 AND importance >= 0.9")
					.get() as {
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
	// POST /api/memory/codex-native-note
	// =========================================================================
	app.post("/api/memory/codex-native-note", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const content = typeof body.content === "string" ? body.content.trim() : "";
		if (!content) return c.json({ error: "content is required" }, 400);
		if (content.length > 8000) return c.json({ error: "content must be at most 8000 characters" }, 400);
		const title = typeof body.title === "string" ? body.title : undefined;
		const tags = typeof body.tags === "string" ? body.tags : undefined;

		const pipelineCfg = loadMemoryConfig(AGENTS_DIR).pipelineV2;
		if (pipelineCfg.mutationsFrozen) {
			return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
		}

		try {
			const path = writeCodexNativeNote({ content, title, tags });
			logger.info("memory", "Saved Codex native memory note", {
				path,
				actor: c.get("auth")?.claims?.sub ?? c.req.header("x-signet-actor") ?? "anonymous",
			});
			return c.json({ ok: true, path });
		} catch (e) {
			logger.error("memory", "Failed to save Codex native memory note", e as Error);
			return c.json({ error: "Failed to save Codex native memory note" }, 500);
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
			sourcePath?: string;
			source_path?: string;
			source?: string;
			runtimePath?: string;
			runtime_path?: string;
			idempotencyKey?: string;
			idempotency_key?: string;
			metadata?: Record<string, unknown>;
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
		const rowProvenance = parseRememberRowProvenance(body as Record<string, unknown>);
		const agentId = resolveAgentId({ agentId: body.agentId, sessionKey: c.req.header("x-signet-session-key") });
		const visibility = body.visibility === "private" ? "private" : "global";
		const dedupeScope = { agentId, visibility, scope };
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

			const chunkPlans = chunks
				.map((chunk, index) => {
					const normalized = normalizeAndHashContent(chunk);
					if (!normalized.storageContent) return null;
					return {
						chunk,
						contentForInsert:
							normalized.normalizedContent.length > 0 ? normalized.normalizedContent : normalized.hashBasis,
						idempotencyKey: idempotencyKeyForChunk(rowProvenance.idempotencyKey, index),
						memType: inferType(chunk),
						normalized,
					};
				})
				.filter((plan): plan is NonNullable<typeof plan> => plan !== null);
			if (chunkPlans.length === 0) {
				return c.json({ error: "content produced no valid chunks" }, 400);
			}

			const baseIdempotencyMemory = getDbAccessor().withReadDb((db) =>
				getScopedIdempotencyMemoryId(db, rowProvenance.idempotencyKey, dedupeScope),
			);
			if (baseIdempotencyMemory) {
				return c.json({ error: "idempotencyKey already used for non-chunk content" }, 409);
			}

			const existingChunks = getDbAccessor().withReadDb((db) =>
				getScopedChunkIdempotencyRows(db, rowProvenance.idempotencyKey, dedupeScope),
			);
			if (existingChunks.length > 0) {
				const groupIds = new Set(existingChunks.map((row) => row.sourceId).filter((id): id is string => !!id));
				const matchesExistingPlan =
					groupIds.size === 1 &&
					existingChunks.length === chunkPlans.length &&
					existingChunks.every((row, index) => {
						const plan = chunkPlans[index];
						return row.idempotencyKey === plan.idempotencyKey && row.contentHash === plan.normalized.contentHash;
					});
				if (!matchesExistingPlan) {
					return c.json({ error: "idempotencyKey already used for different chunked content" }, 409);
				}

				return c.json({
					chunked: true,
					chunk_count: existingChunks.length,
					ids: existingChunks.map((row) => row.id),
					group_id: Array.from(groupIds)[0],
					deduped: true,
				});
			}
			const contentHashes = new Set<string>();
			for (const plan of chunkPlans) {
				if (contentHashes.has(plan.normalized.contentHash)) {
					return c.json({ error: "chunked content contains duplicate chunks" }, 409);
				}
				contentHashes.add(plan.normalized.contentHash);
				const byHash = getDbAccessor().withReadDb((db) =>
					getScopedContentHashMemoryId(db, plan.normalized.contentHash, dedupeScope),
				);
				if (byHash) {
					return c.json({ error: "chunk content already exists for this agent and scope" }, 409);
				}
			}

			const groupId = chunkGroupIdForIdempotencyKey(rowProvenance.idempotencyKey, dedupeScope) ?? crypto.randomUUID();
			const now = new Date().toISOString();
			const plannedChunkIds = chunkPlans.map(() => crypto.randomUUID());
			type ChunkInsertResult =
				| { readonly ids: readonly string[]; readonly status: "inserted" }
				| { readonly groupId: string | undefined; readonly ids: readonly string[]; readonly status: "deduped" }
				| { readonly status: "chunk_idempotency_conflict" }
				| { readonly status: "content_conflict" }
				| { readonly status: "non_chunk_idempotency_conflict" };

			try {
				const result: ChunkInsertResult = getDbAccessor().withWriteTx((db) => {
					const baseMemory = getScopedIdempotencyMemoryId(db, rowProvenance.idempotencyKey, dedupeScope);
					if (baseMemory) return { status: "non_chunk_idempotency_conflict" };

					const txExistingChunks = getScopedChunkIdempotencyRows(db, rowProvenance.idempotencyKey, dedupeScope);
					if (txExistingChunks.length > 0) {
						const groupIds = new Set(txExistingChunks.map((row) => row.sourceId).filter((id): id is string => !!id));
						const matchesExistingPlan =
							groupIds.size === 1 &&
							txExistingChunks.length === chunkPlans.length &&
							txExistingChunks.every((row, index) => {
								const plan = chunkPlans[index];
								return row.idempotencyKey === plan.idempotencyKey && row.contentHash === plan.normalized.contentHash;
							});
						if (!matchesExistingPlan) return { status: "chunk_idempotency_conflict" };

						return {
							groupId: Array.from(groupIds)[0],
							ids: txExistingChunks.map((row) => row.id),
							status: "deduped",
						};
					}

					for (const plan of chunkPlans) {
						const byHash = getScopedContentHashMemoryId(db, plan.normalized.contentHash, dedupeScope);
						if (byHash) return { status: "content_conflict" };
					}

					db.prepare(
						`INSERT OR IGNORE INTO entities
						 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
						 VALUES (?, ?, ?, 'chunk_group', ?, 0, ?, ?)`,
					).run(groupId, `chunk-group:${groupId}`, `chunk-group:${groupId}`, agentId, now, now);

					for (let chunkIndex = 0; chunkIndex < chunkPlans.length; chunkIndex += 1) {
						const plan = chunkPlans[chunkIndex];
						const chunkId = plannedChunkIds[chunkIndex];
						txIngestEnvelope(db, {
							id: chunkId,
							content: plan.normalized.storageContent,
							normalizedContent: plan.contentForInsert,
							contentHash: plan.normalized.contentHash,
							who,
							why: pinned ? "explicit-critical" : "explicit",
							project,
							importance,
							type: plan.memType,
							tags: tags ?? null,
							pinned,
							isDeleted: 0,
							extractionStatus: pipelineEnqueueEnabled ? "pending" : "none",
							embeddingModel: null,
							extractionModel: pipelineEnqueueEnabled ? pipelineCfg.extraction.model : null,
							updatedBy: who,
							sourceType: "chunk",
							sourceId: groupId,
							sourcePath: rowProvenance.sourcePath ?? null,
							runtimePath: rowProvenance.runtimePath ?? null,
							idempotencyKey: plan.idempotencyKey ?? null,
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
					}

					return { ids: plannedChunkIds, status: "inserted" };
				});

				if (result.status === "non_chunk_idempotency_conflict") {
					return c.json({ error: "idempotencyKey already used for non-chunk content" }, 409);
				}
				if (result.status === "chunk_idempotency_conflict") {
					return c.json({ error: "idempotencyKey already used for different chunked content" }, 409);
				}
				if (result.status === "content_conflict") {
					return c.json({ error: "chunk content already exists for this agent and scope" }, 409);
				}
				if (result.status === "deduped") {
					return c.json({
						chunked: true,
						chunk_count: result.ids.length,
						ids: result.ids,
						group_id: result.groupId,
						deduped: true,
					});
				}

				const savedChunkIds = [...result.ids];

				for (let chunkIndex = 0; chunkIndex < chunkPlans.length; chunkIndex += 1) {
					const plan = chunkPlans[chunkIndex];
					const chunkId = savedChunkIds[chunkIndex];
					// Generate embedding async
					try {
						const vec = await fetchEmbedding(plan.normalized.storageContent, fullCfg.embedding);
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
								const embHash = scope ? `${plan.normalized.contentHash}:${scope}` : plan.normalized.contentHash;
								getDbAccessor().withWriteTx((db) => {
									syncVecDeleteBySourceId(db, "memory", chunkId);
									db.prepare(`DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`).run(chunkId);
									db.prepare(`
										INSERT INTO embeddings
										  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
										VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
									`).run(embId, embHash, blob, vec.length, chunkId, plan.normalized.storageContent, now);
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
							linkMemoryToEntities(db, chunkId, plan.chunk, agentId);
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
				}

				logger.info("memory", "Chunked memory saved", {
					groupId,
					chunkCount: savedChunkIds.length,
				});

				return c.json({
					chunked: true,
					chunk_count: savedChunkIds.length,
					ids: savedChunkIds,
					group_id: groupId,
				});
			} catch (e) {
				if (isMemoryContentHashUniqueError(e)) {
					return c.json({ error: "chunk content already exists for this agent and scope" }, 409);
				}
				logger.warn("memory", "Failed to save chunked memory", {
					groupId,
					error: String(e),
				});
				return c.json({ error: "Failed to save chunks" }, 500);
			}
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
		const chunkedIdempotencyMemory =
			rowProvenance.idempotencyKey === undefined
				? []
				: getDbAccessor().withReadDb((db) =>
						getScopedChunkIdempotencyRows(db, rowProvenance.idempotencyKey, dedupeScope),
					);
		if (chunkedIdempotencyMemory.length > 0) {
			return c.json({ error: "idempotencyKey already used for chunked content" }, 409);
		}

		type DedupeRow = RememberDedupeRow;

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

				const byIdempotencyKey = getScopedIdempotencyDedupeRow(db, rowProvenance.idempotencyKey, dedupeScope);
				if (byIdempotencyKey) return { deduped: true as const, row: byIdempotencyKey };

				// Check content_hash dedupe using the same agent/scope tuple as the unique index.
				const byHash = getScopedContentHashDedupeRow(db, contentHash, dedupeScope);
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
					sourcePath: rowProvenance.sourcePath ?? null,
					runtimePath: rowProvenance.runtimePath ?? null,
					idempotencyKey: rowProvenance.idempotencyKey ?? null,
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
				const existing = getDbAccessor().withReadDb((db) => {
					const byIdempotencyKey = getScopedIdempotencyDedupeRow(db, rowProvenance.idempotencyKey, dedupeScope);
					if (byIdempotencyKey) return byIdempotencyKey;
					return getScopedContentHashDedupeRow(db, contentHash, dedupeScope);
				});
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

		const sessionKeyRaw = c.req.header("x-signet-session-key");
		const agentId = resolveAgentId({
			agentId: c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id"),
			sessionKey: sessionKeyRaw,
		});
		const agentScope = getAgentScope(agentId);
		const access = buildAgentScopeClause(agentId, agentScope.readPolicy, agentScope.policyGroup);
		const scopeProject = c.get("auth")?.claims?.scope?.project;
		const projectSql = scopeProject ? " AND m.project = ?" : "";
		const row = getDbAccessor().withReadDb((db) => {
			const sessionSelect = hasMemoriesSessionIdColumn(db) ? "m.session_id," : "NULL AS session_id,";

			return db
				.prepare(
					`SELECT m.id, m.content, m.type, m.importance, m.tags, m.pinned, m.who,
					        m.source_id, m.source_type, m.source_path, m.runtime_path,
					        m.idempotency_key, m.project, ${sessionSelect} m.confidence,
					        m.access_count, m.last_accessed, m.is_deleted, m.deleted_at,
					        m.extraction_status, m.embedding_model, m.version,
					        m.created_at, m.updated_at, m.updated_by
					 FROM memories m
					 WHERE m.id = ?
					   AND (m.is_deleted = 0 OR m.is_deleted IS NULL)
					   ${access.sql}
					   ${projectSql}`,
				)
				.get(memoryId, ...access.args, ...(scopeProject ? [scopeProject] : [])) as Record<string, unknown> | undefined;
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
			sourcePath: row.source_path,
			runtimePath: row.runtime_path,
			idempotencyKey: row.idempotency_key,
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
		const aggregateBudgetInput = readAggregateRecallBudgetInput(body);
		const aggregateBudget = parseAggregateRecallBudget(aggregateBudgetInput);
		if (aggregateBudgetInput !== undefined && aggregateBudget === null) {
			return c.json({ error: "Invalid aggregateBudget. Expected one of: small, medium, large." }, 400);
		}

		const aggregateSaveRequested =
			body.aggregate === true && body.saveAggregate !== false && body.save_aggregate !== false;
		if (aggregateSaveRequested) {
			const denied = await requirePermission("remember", authConfig)(c, () => Promise.resolve());
			if (denied) return denied;
		}

		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (
			((cfg.pipelineV2.reranker.enabled && cfg.pipelineV2.reranker.useExtractionModel) || body.aggregate === true) &&
			authConfig.mode !== "local"
		) {
			const actor = c.get("auth")?.claims?.sub ?? "anonymous";
			const check = authRecallLlmLimiter.check(actor);
			if (!check.allowed) {
				c.header("Retry-After", String(Math.ceil((check.resetAt - Date.now()) / 1000)));
				return c.json({ error: "rate limit exceeded", retryAfter: check.resetAt }, 429);
			}
			authRecallLlmLimiter.record(actor);
		}
		try {
			const sessionKeyRaw = body.sessionKey ?? c.req.header("x-signet-session-key");
			const sessionKey = sessionKeyRaw ?? null;
			const agentId = resolveAgentId({ agentId: body.agentId, sessionKey: sessionKeyRaw });
			const agentScope = getAgentScope(agentId);
			const scopeProject = c.get("auth")?.claims?.scope?.project;
			const params = {
				...body,
				query,
				aggregate: body.aggregate,
				aggregateBudget,
				aggregate_budget: aggregateBudget,
				saveAggregate: body.saveAggregate ?? body.save_aggregate,
				save_aggregate: body.save_aggregate ?? body.saveAggregate,
				agentId,
				readPolicy: agentScope.readPolicy,
				policyGroup: agentScope.policyGroup,
				sessionKey: sessionKeyRaw,
				includeRecalled: body.includeRecalled === true,
				recallSurface: "api.memory.recall",
				recallMode: "direct",
				...(scopeProject ? { project: scopeProject } : {}),
			};
			const result =
				body.aggregate === true
					? await aggregateRecallFn(params, cfg, {
							router: getInferenceRouterOrNullFn(),
							embedFn: fetchEmbeddingFn,
						})
					: await hybridRecallFn(params, cfg, fetchEmbeddingFn);
			recordRecallQaTelemetry({
				route: "POST /api/memory/recall",
				agentId,
				sessionKey,
				project: resolveMemorySearchTelemetryProject(params),
				params,
				result,
				cfg,
			});
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
		const project = c.req.query("project");
		const includeRecalled = c.req.query("includeRecalled") ?? c.req.query("include_recalled");

		const cfg = loadMemoryConfig(AGENTS_DIR);
		const scopeProject = c.get("auth")?.claims?.scope?.project;
		try {
			const sessionKeyRaw =
				c.req.query("sessionKey") ?? c.req.query("session_key") ?? c.req.header("x-signet-session-key");
			const sessionKey = sessionKeyRaw ?? null;
			const agentId = resolveAgentId({
				agentId: c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id"),
				sessionKey: sessionKeyRaw,
			});
			const agentScope = getAgentScope(agentId);
			const params = {
				query: q,
				limit,
				type,
				tags,
				who,
				pinned: pinned === "1" || pinned === "true",
				importance_min: importanceMin ? Number.parseFloat(importanceMin) : undefined,
				since,
				expand: expand === "1" || expand === "true",
				project,
				agentId,
				readPolicy: agentScope.readPolicy,
				policyGroup: agentScope.policyGroup,
				sessionKey: sessionKeyRaw,
				includeRecalled: includeRecalled === "1" || includeRecalled === "true",
				recallSurface: "api.memory.search",
				recallMode: "direct",
				...(scopeProject ? { project: scopeProject } : {}),
			};
			const result = await hybridRecall(params, cfg, fetchEmbedding);
			recordRecallQaTelemetry({
				route: "GET /api/memory/search",
				agentId,
				sessionKey,
				project: resolveMemorySearchTelemetryProject(params),
				params,
				result,
				cfg,
			});
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
			const count =
				typeof countRow === "object" && countRow !== null && "count" in countRow && typeof countRow.count === "number"
					? countRow.count
					: 0;
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
						return typeof row === "object" && row !== null && "count" in row && typeof row.count === "number"
							? row.count
							: 0;
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
