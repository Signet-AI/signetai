#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { watch } from "chokidar";
import { logger, LogEntry } from "./logger";
import { loadMemoryConfig, type EmbeddingConfig } from "./memory-config";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import {
	writeFileSync,
	readFileSync,
	existsSync,
	mkdirSync,
	unlinkSync,
	readdirSync,
	statSync,
	appendFileSync,
	rmSync,
} from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { initDbAccessor, getDbAccessor, closeDbAccessor } from "./db-accessor";
import { initLlmProvider, closeLlmProvider } from "./llm";
import { syncVecInsert, syncVecDeleteBySourceId } from "./db-helpers";
import {
	putSecret,
	getSecret,
	hasSecret,
	listSecrets,
	deleteSecret,
	execWithSecrets,
} from "./secrets.js";
import {
	parseSimpleYaml,
	buildSignetBlock,
	buildArchitectureDoc,
	stripSignetBlock,
	vectorSearch,
	keywordSearch,
	resolvePrimaryPackageManager,
	getSkillsRunnerCommand,
} from "@signet/core";
import {
	initUpdateSystem,
	getUpdateState,
	checkForUpdates as checkForUpdatesImpl,
	runUpdate as runUpdateImpl,
	parseBooleanFlag,
	parseUpdateInterval,
	setUpdateConfig,
	startUpdateTimer,
	stopUpdateTimer,
	MIN_UPDATE_INTERVAL_SECONDS,
	MAX_UPDATE_INTERVAL_SECONDS,
	type UpdateConfig,
} from "./update-system";
import {
	txIngestEnvelope,
	txFinalizeAccessAndHistory,
	txForgetMemory,
	txModifyMemory,
	txRecoverMemory,
	type MutationContext,
} from "./transactions";
import {
	startPipeline,
	stopPipeline,
	startRetentionWorker,
	DEFAULT_RETENTION,
	enqueueExtractionJob,
	enqueueDocumentIngestJob,
	startSummaryWorker,
} from "./pipeline";
import {
	startSchedulerWorker,
	validateCron,
	computeNextRun,
	isHarnessAvailable,
	CRON_PRESETS,
} from "./scheduler";
import {
	createOllamaProvider,
	createClaudeCodeProvider,
} from "./pipeline/provider";
import {
	registerConnector,
	getConnector,
	listConnectors,
	updateConnectorStatus,
	updateCursor,
	removeConnector,
} from "./connectors/registry";
import { createFilesystemConnector } from "./connectors/filesystem";
import { normalizeAndHashContent } from "./content-normalization";
import { getGraphBoostIds } from "./pipeline/graph-search";
import { rerank, noopReranker, type RerankCandidate } from "./pipeline/reranker";
import { createEmbeddingReranker } from "./pipeline/reranker-embedding";
import { createProviderTracker, getDiagnostics } from "./diagnostics";
import { buildEmbeddingHealth } from "./embedding-health";
import {
	createAnalyticsCollector,
	type AnalyticsCollector,
	type ErrorStage,
} from "./analytics";
import { buildTimeline, type TimelineSources } from "./timeline";
import {
	createRateLimiter,
	requeueDeadJobs,
	releaseStaleLeases,
	checkFtsConsistency,
	triggerRetentionSweep,
	reembedMissingMemories,
	getEmbeddingGapStats,
	cleanOrphanedEmbeddings,
	getDedupStats,
	deduplicateMemories,
	type RepairContext,
} from "./repair-actions";
import {
	createAuthMiddleware,
	requirePermission,
	requireScope,
	requireRateLimit,
	checkScope,
	loadOrCreateSecret,
	createToken,
	parseAuthConfig,
	AuthRateLimiter,
	type AuthConfig,
	type TokenRole,
	type TokenScope,
} from "./auth";
import {
	getCachedProjection,
	computeProjection,
	cacheProjection,
} from "./umap-projection";

// Paths
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const DAEMON_DIR = join(AGENTS_DIR, ".daemon");
const SKILLS_DIR = join(AGENTS_DIR, "skills");
const PID_FILE = join(DAEMON_DIR, "pid");
const LOG_DIR = join(DAEMON_DIR, "logs");
const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");
const SCRIPTS_DIR = join(AGENTS_DIR, "scripts");

// Config
const PORT = parseInt(process.env.SIGNET_PORT || "3850", 10);
const HOST = process.env.SIGNET_HOST || "localhost";

// Autonomous maintenance singletons
const providerTracker = createProviderTracker();
const analyticsCollector = createAnalyticsCollector();
const repairLimiter = createRateLimiter();

// Prevents concurrent UMAP computations for the same dimension count
const projectionInFlight = new Map<number, Promise<void>>();
const projectionErrors = new Map<number, { message: string; expires: number }>();
const PROJECTION_ERROR_TTL_MS = 30_000;

// Auth state — initialized lazily in main(), but middleware reads from here
let authConfig: AuthConfig = parseAuthConfig(undefined, AGENTS_DIR);
let authSecret: Buffer | null = null;
let authForgetLimiter = new AuthRateLimiter(60_000, 30);
let authModifyLimiter = new AuthRateLimiter(60_000, 60);
let authBatchForgetLimiter = new AuthRateLimiter(60_000, 5);
let authAdminLimiter = new AuthRateLimiter(60_000, 10);

function getVersionFromPackageJson(packageJsonPath: string): string | null {
	if (!existsSync(packageJsonPath)) {
		return null;
	}

	try {
		const raw = readFileSync(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function getDaemonVersion(): string {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	const candidates = [
		join(__dirname, "..", "package.json"),
		join(__dirname, "..", "..", "signetai", "package.json"),
		join(__dirname, "..", "..", "package.json"),
	];

	for (const candidate of candidates) {
		const version = getVersionFromPackageJson(candidate);
		if (version) {
			return version;
		}
	}

	return "0.0.0";
}

const CURRENT_VERSION = getDaemonVersion();

// ============================================================================
// Memory helpers - config, embedding, type inference
// ============================================================================

interface EmbeddingStatus {
	provider: "ollama" | "openai";
	model: string;
	available: boolean;
	dimensions?: number;
	base_url: string;
	error?: string;
	checkedAt: string;
}

async function fetchEmbedding(
	text: string,
	cfg: EmbeddingConfig,
): Promise<number[] | null> {
	try {
		if (cfg.provider === "ollama") {
			const res = await fetch(
				`${cfg.base_url.replace(/\/$/, "")}/api/embeddings`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: cfg.model, prompt: text }),
					signal: AbortSignal.timeout(30000),
				},
			);
			if (!res.ok) return null;
			const data = (await res.json()) as { embedding: number[] };
			return data.embedding ?? null;
		} else {
			// OpenAI-compatible
			const apiKey = cfg.api_key ?? process.env.OPENAI_API_KEY ?? "";
			const res = await fetch(`${cfg.base_url.replace(/\/$/, "")}/embeddings`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ model: cfg.model, input: text }),
				signal: AbortSignal.timeout(30000),
			});
			if (!res.ok) return null;
			const data = (await res.json()) as {
				data: Array<{ embedding: number[] }>;
			};
			return data.data?.[0]?.embedding ?? null;
		}
	} catch {
		return null;
	}
}

function vectorToBlob(vec: number[]): Buffer {
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer);
}

function blobToVector(blob: Buffer, dimensions: number | null): number[] {
	const raw = blob.buffer.slice(
		blob.byteOffset,
		blob.byteOffset + blob.byteLength,
	);
	const vector = new Float32Array(raw);
	const size =
		typeof dimensions === "number" &&
		dimensions > 0 &&
		dimensions <= vector.length
			? dimensions
			: vector.length;
	return Array.from(vector.slice(0, size));
}

/**
 * Split text into sentence-aware chunks of approximately targetChars.
 * Single sentences exceeding 2x target get hard-split at targetChars.
 */
function chunkBySentence(text: string, targetChars: number): readonly string[] {
	// Split on sentence-ending punctuation followed by whitespace/newline
	const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
	const chunks: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		// If a single sentence exceeds 2x target, hard-split it
		if (sentence.length > targetChars * 2) {
			if (current.length > 0) {
				chunks.push(current.trim());
				current = "";
			}
			for (let i = 0; i < sentence.length; i += targetChars) {
				chunks.push(sentence.slice(i, i + targetChars).trim());
			}
			continue;
		}

		const combined = current.length > 0 ? `${current} ${sentence}` : sentence;
		if (combined.length > targetChars && current.length > 0) {
			chunks.push(current.trim());
			current = sentence;
		} else {
			current = combined;
		}
	}

	if (current.trim().length > 0) {
		chunks.push(current.trim());
	}

	return chunks.filter((c) => c.length > 0);
}

function parseTagsField(raw: string | null): string[] {
	if (!raw) return [];

	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(value): value is string => typeof value === "string",
			);
		}
	} catch {
		// Fallback to comma-separated tags.
	}

	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

function parseBoundedInt(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

interface LegacyEmbeddingsResponse {
	embeddings: Array<Record<string, unknown>>;
	count: number;
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
	error?: string;
}

function defaultLegacyEmbeddingsResponse(
	limit: number,
	offset: number,
	error?: string,
): LegacyEmbeddingsResponse {
	return {
		embeddings: [],
		count: 0,
		total: 0,
		limit,
		offset,
		hasMore: false,
		error,
	};
}

function parseLegacyTagsField(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		);
	}

	if (typeof raw === "string") {
		return parseTagsField(raw);
	}

	return [];
}

function parseLegacyVector(raw: unknown): number[] | undefined {
	if (Array.isArray(raw)) {
		const values = raw.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value),
		);
		return values.length > 0 ? values : undefined;
	}

	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				const values = parsed.filter(
					(value): value is number =>
						typeof value === "number" && Number.isFinite(value),
				);
				return values.length > 0 ? values : undefined;
			}
		} catch {
			// Ignore malformed JSON vectors from legacy scripts.
		}
	}

	return undefined;
}

function normalizeLegacyEmbeddingRow(
	raw: unknown,
	withVectors: boolean,
): Record<string, unknown> | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}

	const row = raw as Record<string, unknown>;
	const rawId = row.id ?? row.source_id;
	if (typeof rawId !== "string" && typeof rawId !== "number") {
		return null;
	}

	const id = String(rawId);
	const rawContent = row.content ?? row.text ?? "";
	const content =
		typeof rawContent === "string" ? rawContent : String(rawContent);
	const who =
		typeof row.who === "string" && row.who.length > 0 ? row.who : "unknown";

	const sourceType =
		typeof row.sourceType === "string"
			? row.sourceType
			: typeof row.source_type === "string"
				? row.source_type
				: "memory";

	const sourceIdRaw = row.sourceId ?? row.source_id ?? id;
	const sourceId =
		typeof sourceIdRaw === "string" || typeof sourceIdRaw === "number"
			? String(sourceIdRaw)
			: id;

	const createdAtRaw = row.createdAt ?? row.created_at;
	const createdAt = typeof createdAtRaw === "string" ? createdAtRaw : undefined;

	const typeValue = typeof row.type === "string" ? row.type : null;
	const importance =
		typeof row.importance === "number" && Number.isFinite(row.importance)
			? row.importance
			: 0.5;

	const normalized: Record<string, unknown> = {
		id,
		content,
		text: content,
		who,
		importance,
		type: typeValue,
		tags: parseLegacyTagsField(row.tags),
		sourceType,
		sourceId,
		createdAt,
	};

	if (withVectors) {
		const vector = parseLegacyVector(row.vector);
		if (vector) {
			normalized.vector = vector;
		}
	}

	return normalized;
}

function normalizeLegacyEmbeddingsPayload(
	payload: unknown,
	withVectors: boolean,
	limit: number,
	offset: number,
): LegacyEmbeddingsResponse {
	if (typeof payload !== "object" || payload === null) {
		return defaultLegacyEmbeddingsResponse(
			limit,
			offset,
			"Legacy export returned invalid payload",
		);
	}

	const data = payload as Record<string, unknown>;
	const rawEmbeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
	const embeddings = rawEmbeddings
		.map((entry) => normalizeLegacyEmbeddingRow(entry, withVectors))
		.filter((entry): entry is Record<string, unknown> => entry !== null);

	const total =
		typeof data.total === "number" && Number.isFinite(data.total)
			? data.total
			: typeof data.count === "number" && Number.isFinite(data.count)
				? data.count
				: embeddings.length;

	const resolvedLimit =
		typeof data.limit === "number" && Number.isFinite(data.limit)
			? data.limit
			: limit;

	const resolvedOffset =
		typeof data.offset === "number" && Number.isFinite(data.offset)
			? data.offset
			: offset;

	const hasMore =
		typeof data.hasMore === "boolean"
			? data.hasMore
			: resolvedOffset + resolvedLimit < total;

	const error = typeof data.error === "string" ? data.error : undefined;

	return {
		embeddings,
		count: embeddings.length,
		total,
		limit: resolvedLimit,
		offset: resolvedOffset,
		hasMore,
		error,
	};
}

function isMissingEmbeddingsTableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("no such table: embeddings");
}

async function runLegacyEmbeddingsExport(
	withVectors: boolean,
	limit: number,
	offset: number,
): Promise<LegacyEmbeddingsResponse | null> {
	const scriptPath = join(
		AGENTS_DIR,
		"memory",
		"scripts",
		"export_embeddings.py",
	);
	if (!existsSync(scriptPath)) {
		return null;
	}

	const args = [
		scriptPath,
		"--limit",
		String(limit),
		"--offset",
		String(offset),
	];
	if (withVectors) {
		args.push("--with-vectors");
	}

	return await new Promise<LegacyEmbeddingsResponse>((resolve) => {
		const proc = spawn("python3", args, {
			cwd: AGENTS_DIR,
			stdio: "pipe",
			timeout: withVectors ? 120000 : 30000,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				resolve(
					defaultLegacyEmbeddingsResponse(
						limit,
						offset,
						stderr.trim() || `Legacy embeddings export failed (exit ${code})`,
					),
				);
				return;
			}

			if (!stdout.trim()) {
				resolve(
					defaultLegacyEmbeddingsResponse(
						limit,
						offset,
						"Legacy embeddings export returned empty output",
					),
				);
				return;
			}

			try {
				const parsed: unknown = JSON.parse(stdout);
				resolve(
					normalizeLegacyEmbeddingsPayload(parsed, withVectors, limit, offset),
				);
			} catch (error) {
				resolve(
					defaultLegacyEmbeddingsResponse(
						limit,
						offset,
						`Legacy embeddings export returned invalid JSON: ${(error as Error).message}`,
					),
				);
			}
		});

		proc.on("error", (error) => {
			resolve(defaultLegacyEmbeddingsResponse(limit, offset, error.message));
		});
	});
}

// Status cache for embedding provider
let cachedEmbeddingStatus: EmbeddingStatus | null = null;
let statusCacheTime = 0;
const STATUS_CACHE_TTL = 30000; // 30 seconds

async function checkEmbeddingProvider(
	cfg: EmbeddingConfig,
): Promise<EmbeddingStatus> {
	const now = Date.now();

	// Return cached status if fresh
	if (cachedEmbeddingStatus && now - statusCacheTime < STATUS_CACHE_TTL) {
		return cachedEmbeddingStatus;
	}

	const status: EmbeddingStatus = {
		provider: cfg.provider,
		model: cfg.model,
		base_url: cfg.base_url,
		available: false,
		checkedAt: new Date().toISOString(),
	};

	try {
		if (cfg.provider === "ollama") {
			// Check Ollama API availability
			const res = await fetch(`${cfg.base_url.replace(/\/$/, "")}/api/tags`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (!res.ok) {
				status.error = `Ollama returned ${res.status}`;
			} else {
				const data = (await res.json()) as { models?: { name: string }[] };
				const models = data.models ?? [];
				const modelExists = models.some((m) => m.name.startsWith(cfg.model));

				if (!modelExists) {
					status.error = `Model '${cfg.model}' not found. Available: ${models.map((m) => m.name).join(", ") || "none"}`;
				} else {
					status.available = true;
					status.dimensions = cfg.dimensions;
				}
			}
		} else {
			// OpenAI: test with a minimal embedding request
			const testResult = await fetchEmbedding("test", cfg);
			if (testResult) {
				status.available = true;
				status.dimensions = testResult.length;
			} else {
				status.error = "Failed to generate test embedding";
			}
		}
	} catch (err) {
		status.error = err instanceof Error ? err.message : "Unknown error";
	}

	cachedEmbeddingStatus = status;
	statusCacheTime = now;
	return status;
}

// Type inference from content keywords
const TYPE_HINTS: Array<[string, string]> = [
	["prefer", "preference"],
	["likes", "preference"],
	["want", "preference"],
	["decided", "decision"],
	["agreed", "decision"],
	["will use", "decision"],
	["learned", "learning"],
	["discovered", "learning"],
	["til ", "learning"],
	["bug", "issue"],
	["issue", "issue"],
	["broken", "issue"],
	["never", "rule"],
	["always", "rule"],
	["must", "rule"],
];

function inferType(content: string): string {
	const lower = content.toLowerCase();
	for (const [hint, type] of TYPE_HINTS) {
		if (lower.includes(hint)) return type;
	}
	return "fact";
}

interface ParsedMemory {
	content: string;
	tags: string | null;
	pinned: boolean;
	importance: number;
}

function parsePrefixes(raw: string): ParsedMemory {
	let content = raw.trim();
	let pinned = false;
	let importance = 0.8;
	let tags: string | null = null;

	if (content.toLowerCase().startsWith("critical:")) {
		content = content.slice(9).trim();
		pinned = true;
		importance = 1.0;
	}

	const tagMatch = content.match(/^\[([^\]]+)\]:\s*(.+)$/s);
	if (tagMatch) {
		tags = tagMatch[1]
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean)
			.join(",");
		content = tagMatch[2].trim();
	}

	return { content, tags, pinned, importance };
}

// Resolve dashboard static files location
function getDashboardPath(): string | null {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	// Check various locations for the built dashboard
	const candidates = [
		// When running from workspace
		join(__dirname, "..", "..", "cli", "dashboard", "build"),
		// When installed as package
		join(__dirname, "..", "..", "..", "cli", "dashboard", "build"),
		// Bundled with daemon
		join(__dirname, "..", "dashboard"),
		join(__dirname, "dashboard"),
	];

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "index.html"))) {
			return candidate;
		}
	}

	return null;
}

// Create the Hono app
export const app = new Hono();

// Middleware
app.use("*", cors());

// Auth middleware — reads from module-level authConfig/authSecret
// which are initialized properly in main(). In local mode this is a no-op.
app.use("*", async (c, next) => {
	const mw = createAuthMiddleware(authConfig, authSecret);
	return mw(c, next);
});

// Request logging + analytics middleware
app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const duration = Date.now() - start;
	logger.api.request(c.req.method, c.req.path, c.res.status, duration);
	const actor = c.req.header("x-signet-actor");
	analyticsCollector.recordRequest(
		c.req.method,
		c.req.path,
		c.res.status,
		duration,
		actor ?? undefined,
	);
	// Record latency histograms for key operations
	const p = c.req.path;
	if (p.includes("/remember") || p.includes("/save")) {
		analyticsCollector.recordLatency("remember", duration);
	} else if (p.includes("/recall") || p.includes("/search") || p.includes("/similar")) {
		analyticsCollector.recordLatency("recall", duration);
	} else if (p.includes("/modify") || p.includes("/forget") || p.includes("/recover")) {
		analyticsCollector.recordLatency("mutate", duration);
	}
});

// Health check
app.get("/health", (c) => {
	const us = getUpdateState();
	return c.json({
		status: "healthy",
		uptime: process.uptime(),
		pid: process.pid,
		version: CURRENT_VERSION,
		port: PORT,
		agentsDir: AGENTS_DIR,
		updateAvailable: us.lastCheck?.updateAvailable ?? false,
		pendingRestart: us.pendingRestartVersion !== null,
	});
});

// ============================================================================
// MCP Server (Streamable HTTP at /mcp)
// ============================================================================

import { mountMcpRoute } from "./mcp/route.js";
mountMcpRoute(app);

// ============================================================================
// Auth API
// ============================================================================

app.get("/api/auth/whoami", (c) => {
	const auth = c.get("auth");
	return c.json({
		authenticated: auth?.authenticated ?? false,
		claims: auth?.claims ?? null,
		mode: authConfig.mode,
	});
});

// Token creation uses the same permission + rate limit pattern as other admin routes
app.use("/api/auth/token", async (c, next) => {
	const perm = requirePermission("admin", authConfig);
	const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
	await perm(c, async () => { await rate(c, next); });
});

app.post("/api/auth/token", async (c) => {
	if (!authSecret) {
		return c.json(
			{ error: "auth secret not available (local mode?)" },
			400,
		);
	}

	const payload = (await c.req.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!payload) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const role = payload.role as string | undefined;
	const validRoles = ["admin", "operator", "agent", "readonly"];
	if (!role || !validRoles.includes(role)) {
		return c.json(
			{ error: `role must be one of: ${validRoles.join(", ")}` },
			400,
		);
	}

	const scope = (payload.scope ?? {}) as TokenScope;
	const ttl =
		typeof payload.ttlSeconds === "number" && payload.ttlSeconds > 0
			? payload.ttlSeconds
			: authConfig.defaultTokenTtlSeconds;

	const token = createToken(
		authSecret,
		{ sub: `token:${role}`, scope, role: role as TokenRole },
		ttl,
	);

	const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
	return c.json({ token, expiresAt });
});

// ============================================================================
// Route-level permission guards
// ============================================================================

// Remember
app.use("/api/memory/remember", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/memory/save", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/hook/remember", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});

// Recall / search
// TODO(Phase J follow-up): Scoped tokens should have their project/agent
// scope injected as a mandatory filter into the search query itself, so
// recall results are restricted to the token's scope. Currently, scope
// enforcement only applies to mutations, not reads. This is acceptable
// for v1 single-tenant local, but must be addressed before team mode GA.
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

// Modify — with rate limiting
app.use("/api/memory/modify", async (c, next) => {
	const perm = requirePermission("modify", authConfig);
	const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
	await perm(c, async () => { await rate(c, next); });
});

// Forget — with rate limiting
app.use("/api/memory/forget", async (c, next) => {
	const perm = requirePermission("forget", authConfig);
	const rate = requireRateLimit("batchForget", authBatchForgetLimiter, authConfig);
	await perm(c, async () => { await rate(c, next); });
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

// Connectors — admin only
app.use("/api/connectors", async (c, next) => {
	if (c.req.method === "GET") return next();
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/connectors/*", async (c, next) => {
	if (c.req.method === "GET") return next();
	return requirePermission("admin", authConfig)(c, next);
});

// Diagnostics — read-only
app.use("/api/diagnostics", async (c, next) => {
	return requirePermission("diagnostics", authConfig)(c, next);
});
app.use("/api/diagnostics/*", async (c, next) => {
	return requirePermission("diagnostics", authConfig)(c, next);
});

// Analytics — read-only
app.use("/api/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});

// Timeline — read-only (uses analytics permission)
app.use("/api/timeline/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});

// Repair — admin only
app.use("/api/repair/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

// Per-memory PATCH and DELETE need method-specific guards + scope check
app.use("/api/memory/:id", async (c, next) => {
	// Scope enforcement on mutations: if token has project scope, verify
	// the target memory belongs to that project.
	if (
		authConfig.mode !== "local" &&
		(c.req.method === "PATCH" || c.req.method === "DELETE")
	) {
		const auth = c.get("auth");
		if (auth?.claims?.scope?.project) {
			const memoryId = c.req.param("id");
			const row = getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT project FROM memories WHERE id = ?")
					.get(memoryId) as { project: string | null } | undefined,
			);
			if (row) {
				const decision = checkScope(
					auth.claims,
					{ project: row.project ?? undefined },
					authConfig.mode,
				);
				if (!decision.allowed) {
					return c.json({ error: decision.reason ?? "scope violation" }, 403);
				}
			}
		}
	}

	if (c.req.method === "PATCH") {
		const perm = requirePermission("modify", authConfig);
		const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
		return perm(c, async () => { await rate(c, next); });
	}
	if (c.req.method === "DELETE") {
		const perm = requirePermission("forget", authConfig);
		const rate = requireRateLimit("forget", authForgetLimiter, authConfig);
		return perm(c, async () => { await rate(c, next); });
	}
	// GET for memory detail + history — recall permission
	if (c.req.method === "GET") {
		return requirePermission("recall", authConfig)(c, next);
	}
	return next();
});

// ============================================================================
// Logs API
// ============================================================================

// Get recent logs
app.get("/api/logs", (c) => {
	const limit = parseInt(c.req.query("limit") || "100", 10);
	const level = c.req.query("level") as
		| "debug"
		| "info"
		| "warn"
		| "error"
		| undefined;
	const category = c.req.query("category") as any;
	const since = c.req.query("since")
		? new Date(c.req.query("since")!)
		: undefined;

	const logs = logger.getRecent({ limit, level, category, since });
	return c.json({ logs, count: logs.length });
});

// Stream logs via Server-Sent Events
app.get("/api/logs/stream", (c) => {
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			const onLog = (entry: LogEntry) => {
				const data = `data: ${JSON.stringify(entry)}\n\n`;
				controller.enqueue(encoder.encode(data));
			};

			logger.on("log", onLog);

			// Send initial connection message
			controller.enqueue(encoder.encode(`data: {"type":"connected"}\n\n`));

			// Cleanup on close
			c.req.raw.signal.addEventListener("abort", () => {
				logger.off("log", onLog);
			});
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

// ============================================================================
// Config API
// ============================================================================

app.get("/api/config", async (c) => {
	try {
		const files: Array<{ name: string; content: string; size: number }> = [];
		const dirFiles = readdirSync(AGENTS_DIR);
		const configFiles = dirFiles.filter(
			(f) => f.endsWith(".md") || f.endsWith(".yaml"),
		);

		for (const fileName of configFiles) {
			const filePath = join(AGENTS_DIR, fileName);
			const fileStat = statSync(filePath);
			if (fileStat.isFile()) {
				const content = readFileSync(filePath, "utf-8");
				files.push({ name: fileName, content, size: fileStat.size });
			}
		}

		// Sort by priority
		const priority = [
			"agent.yaml",
			"AGENTS.md",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
		];
		files.sort((a, b) => {
			const aIdx = priority.indexOf(a.name);
			const bIdx = priority.indexOf(b.name);
			if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name);
			if (aIdx === -1) return 1;
			if (bIdx === -1) return -1;
			return aIdx - bIdx;
		});

		return c.json({ files });
	} catch (e) {
		logger.error("api", "Error loading config files", e as Error);
		return c.json({ files: [], error: "Failed to load config files" });
	}
});

app.post("/api/config", async (c) => {
	try {
		const { file, content } = await c.req.json();

		if (!file || typeof content !== "string") {
			return c.json({ error: "Invalid request" }, 400);
		}

		if (file.includes("/") || file.includes("..")) {
			return c.json({ error: "Invalid file name" }, 400);
		}

		if (!file.endsWith(".md") && !file.endsWith(".yaml")) {
			return c.json({ error: "Invalid file type" }, 400);
		}

		writeFileSync(join(AGENTS_DIR, file), content, "utf-8");
		logger.info("api", "Config file updated", { file });
		return c.json({ success: true });
	} catch (e) {
		logger.error("api", "Error saving config file", e as Error);
		return c.json({ error: "Failed to save file" }, 500);
	}
});

// ============================================================================
// Identity API
// ============================================================================

app.get("/api/identity", (c) => {
	try {
		const content = readFileSync(join(AGENTS_DIR, "IDENTITY.md"), "utf-8");
		const lines = content.split("\n");
		const identity: { name: string; creature: string; vibe: string } = {
			name: "",
			creature: "",
			vibe: "",
		};

		for (const line of lines) {
			if (line.startsWith("- name:"))
				identity.name = line.replace("- name:", "").trim();
			if (line.startsWith("- creature:"))
				identity.creature = line.replace("- creature:", "").trim();
			if (line.startsWith("- vibe:"))
				identity.vibe = line.replace("- vibe:", "").trim();
		}

		return c.json(identity);
	} catch {
		return c.json({ name: "Unknown", creature: "", vibe: "" });
	}
});

// ============================================================================
// Memories API
// ============================================================================

app.get("/api/memories", (c) => {
	try {
		const limit = parseInt(c.req.query("limit") || "100", 10);
		const offset = parseInt(c.req.query("offset") || "0", 10);

		const result = getDbAccessor().withReadDb((db) => {
			const memories = db
				.prepare(`
      SELECT id, content, created_at, who, importance, tags, source_type, pinned, type
      FROM memories
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
				.all(limit, offset);

			const totalResult = db
				.prepare("SELECT COUNT(*) as count FROM memories")
				.get() as { count: number };
			let embeddingsCount = 0;
			try {
				const embResult = db
					.prepare("SELECT COUNT(*) as count FROM embeddings")
					.get() as { count: number };
				embeddingsCount = embResult?.count ?? 0;
			} catch {
				// embeddings table might not exist
			}
			const critResult = db
				.prepare(
					"SELECT COUNT(*) as count FROM memories WHERE importance >= 0.9",
				)
				.get() as { count: number };

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

// ============================================================================
// Memory Search API
// ============================================================================

interface FilterParams {
	type: string;
	tags: string;
	who: string;
	pinned: boolean;
	importance_min: number | null;
	since: string;
}

function buildWhereRaw(p: FilterParams): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];

	if (p.type) {
		parts.push("type = ?");
		args.push(p.type);
	}
	if (p.tags) {
		const tagList = p.tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		for (const tag of tagList) {
			parts.push("tags LIKE ?");
			args.push(`%${tag}%`);
		}
	}
	if (p.who) {
		parts.push("who = ?");
		args.push(p.who);
	}
	if (p.pinned) {
		parts.push("pinned = 1");
	}
	if (p.importance_min !== null) {
		parts.push("importance >= ?");
		args.push(p.importance_min);
	}
	if (p.since) {
		parts.push("created_at >= ?");
		args.push(p.since);
	}

	const clause = parts.length ? " AND " + parts.join(" AND ") : "";
	return { clause, args };
}

function buildWhere(p: FilterParams): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];

	if (p.type) {
		parts.push("m.type = ?");
		args.push(p.type);
	}
	if (p.tags) {
		const tagList = p.tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		for (const tag of tagList) {
			parts.push("m.tags LIKE ?");
			args.push(`%${tag}%`);
		}
	}
	if (p.who) {
		parts.push("m.who = ?");
		args.push(p.who);
	}
	if (p.pinned) {
		parts.push("m.pinned = 1");
	}
	if (p.importance_min !== null) {
		parts.push("m.importance >= ?");
		args.push(p.importance_min);
	}
	if (p.since) {
		parts.push("m.created_at >= ?");
		args.push(p.since);
	}

	const clause = parts.length ? " AND " + parts.join(" AND ") : "";
	return { clause, args };
}

app.get("/memory/search", (c) => {
	const query = c.req.query("q") ?? "";
	const distinct = c.req.query("distinct");
	const limitParam = c.req.query("limit");
	const limit = limitParam ? parseInt(limitParam, 10) : null;

	// Shortcut: return distinct values for a column
	if (distinct === "who") {
		try {
			const values = getDbAccessor().withReadDb((db) => {
				const rows = db
					.prepare(
						"SELECT DISTINCT who FROM memories WHERE who IS NOT NULL ORDER BY who",
					)
					.all() as { who: string }[];
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
		importance_min: c.req.query("importance_min")
			? parseFloat(c.req.query("importance_min")!)
			: null,
		since: c.req.query("since") ?? "",
	};

	const hasFilters = Object.values(filterParams).some(
		(v) => v !== "" && v !== false && v !== null,
	);

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

// ============================================================================
// Native Memory API - /api/memory/remember & /api/memory/recall
// ============================================================================

const MAX_MUTATION_BATCH = 200;
const FORGET_CONFIRM_THRESHOLD = 25;
const SOFT_DELETE_RETENTION_DAYS = 30;
const SOFT_DELETE_RETENTION_MS =
	SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface ForgetCandidatesRequest {
	query: string;
	type: string;
	tags: string;
	who: string;
	sourceType: string;
	since: string;
	until: string;
	limit: number;
}

interface ForgetCandidate {
	id: string;
	pinned: number;
	version: number;
	score: number;
}

function toRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value;
}

async function readOptionalJsonObject(
	c: Context,
): Promise<Record<string, unknown> | null> {
	const raw = await c.req.raw.text();
	if (!raw.trim()) return {};
	try {
		return toRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

function parseOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseOptionalInt(value: unknown): number | undefined {
	const parsed = parseOptionalNumber(value);
	if (parsed === undefined) return undefined;
	if (!Number.isInteger(parsed)) return undefined;
	if (parsed <= 0) return undefined;
	return parsed;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return undefined;
	}
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (lower === "1" || lower === "true") return true;
		if (lower === "0" || lower === "false") return false;
	}
	return undefined;
}

function parseTagsMutation(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value === "string") {
		const trimmed = value
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0)
			.join(",");
		return trimmed.length > 0 ? trimmed : null;
	}
	if (Array.isArray(value)) {
		const tags = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0)
			.join(",");
		return tags.length > 0 ? tags : null;
	}
	return undefined;
}

interface MutationActor {
	changedBy: string;
	actorType: string;
	sessionId: string | undefined;
	requestId: string | undefined;
}

const ACTOR_TYPES = new Set([
	"operator",
	"pipeline",
	"harness",
	"sdk",
	"daemon",
]);

function resolveMutationActor(c: Context, fallback?: string): MutationActor {
	// Prefer token claims for identity when available
	const auth = c.get("auth");
	if (auth?.claims) {
		return {
			changedBy: auth.claims.sub,
			actorType: auth.claims.role,
			sessionId: parseOptionalString(c.req.header("x-signet-session-id")),
			requestId: parseOptionalString(c.req.header("x-signet-request-id")),
		};
	}

	const headerActor = parseOptionalString(c.req.header("x-signet-actor"));
	const changedBy =
		headerActor ??
		(fallback && fallback.trim().length > 0 ? fallback.trim() : "daemon");

	const rawType = parseOptionalString(c.req.header("x-signet-actor-type"));
	const actorType = rawType && ACTOR_TYPES.has(rawType) ? rawType : "operator";

	return {
		changedBy,
		actorType,
		sessionId: parseOptionalString(c.req.header("x-signet-session-id")),
		requestId: parseOptionalString(c.req.header("x-signet-request-id")),
	};
}

function buildForgetCandidatesWhere(
	req: ForgetCandidatesRequest,
	alias: string,
): { clause: string; args: unknown[] } {
	const parts: string[] = [];
	const args: unknown[] = [];
	const prefix = alias.length > 0 ? `${alias}.` : "";

	if (req.type) {
		parts.push(`${prefix}type = ?`);
		args.push(req.type);
	}
	if (req.tags) {
		const tags = req.tags
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
		for (const tag of tags) {
			parts.push(`${prefix}tags LIKE ?`);
			args.push(`%${tag}%`);
		}
	}
	if (req.who) {
		parts.push(`${prefix}who = ?`);
		args.push(req.who);
	}
	if (req.sourceType) {
		parts.push(`${prefix}source_type = ?`);
		args.push(req.sourceType);
	}
	if (req.since) {
		parts.push(`${prefix}created_at >= ?`);
		args.push(req.since);
	}
	if (req.until) {
		parts.push(`${prefix}created_at <= ?`);
		args.push(req.until);
	}

	const clause = parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
	return { clause, args };
}

function loadForgetCandidates(req: ForgetCandidatesRequest): ForgetCandidate[] {
	return getDbAccessor().withReadDb((db) => {
		const limit = Math.max(1, Math.min(req.limit, MAX_MUTATION_BATCH));
		const withQuery = req.query.trim().length > 0;
		const { clause, args } = buildForgetCandidatesWhere(
			req,
			withQuery ? "m" : "",
		);

		if (withQuery) {
			try {
				const rows = (
					db.prepare(
						`SELECT m.id, m.pinned, m.version, bm25(memories_fts) AS raw_score
						 FROM memories_fts
						 JOIN memories m ON memories_fts.rowid = m.rowid
						 WHERE memories_fts MATCH ? AND m.is_deleted = 0${clause}
						 ORDER BY raw_score
						 LIMIT ?`,
					) as any
				).all(req.query, ...args, limit) as Array<{
					id: string;
					pinned: number;
					version: number;
					raw_score: number;
				}>;
				return rows.map((row) => ({
					id: row.id,
					pinned: row.pinned,
					version: row.version,
					score: 1 / (1 + Math.abs(row.raw_score ?? 0)),
				}));
			} catch {
				// Fall through to LIKE fallback.
			}

			const fallbackRows = (
				db.prepare(
					`SELECT m.id, m.pinned, m.version
					 FROM memories m
					 WHERE m.is_deleted = 0
					   AND (m.content LIKE ? OR m.tags LIKE ?)${clause}
					 ORDER BY m.updated_at DESC
					 LIMIT ?`,
				) as any
			).all(`%${req.query}%`, `%${req.query}%`, ...args, limit) as Array<{
				id: string;
				pinned: number;
				version: number;
			}>;
			return fallbackRows.map((row) => ({
				id: row.id,
				pinned: row.pinned,
				version: row.version,
				score: 0,
			}));
		}

		const rows = (
			db.prepare(
				`SELECT id, pinned, version
				 FROM memories
				 WHERE is_deleted = 0${clause}
				 ORDER BY pinned DESC, importance DESC, updated_at DESC
				 LIMIT ?`,
			) as any
		).all(...args, limit) as Array<{
			id: string;
			pinned: number;
			version: number;
		}>;
		return rows.map((row) => ({
			id: row.id,
			pinned: row.pinned,
			version: row.version,
			score: 0,
		}));
	});
}

function loadForgetCandidatesByIds(
	requestedIds: readonly string[],
	limit: number,
): ForgetCandidate[] {
	const dedupedIds = [...new Set(requestedIds)]
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.slice(0, Math.max(1, Math.min(limit, MAX_MUTATION_BATCH)));
	if (dedupedIds.length === 0) return [];

	return getDbAccessor().withReadDb((db) => {
		const placeholders = dedupedIds.map(() => "?").join(", ");
		const rows = db
			.prepare(
				`SELECT id, pinned, version
				 FROM memories
				 WHERE is_deleted = 0 AND id IN (${placeholders})`,
			)
			.all(...dedupedIds) as Array<{
			id: string;
			pinned: number;
			version: number;
		}>;
		const rowById = new Map(rows.map((row) => [row.id, row]));
		return dedupedIds
			.map((id) => rowById.get(id))
			.filter((row): row is { id: string; pinned: number; version: number } =>
				Boolean(row),
			)
			.map((row) => ({
				id: row.id,
				pinned: row.pinned,
				version: row.version,
				score: 0,
			}));
	});
}

function buildForgetConfirmToken(memoryIds: readonly string[]): string {
	const canonical = [...new Set(memoryIds)].sort().join("|");
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

interface ParsedModifyPatch {
	patch: {
		content?: string;
		normalizedContent?: string;
		contentHash?: string;
		type?: string;
		tags?: string | null;
		importance?: number;
		pinned?: number;
	};
	contentForEmbedding: string | null;
}

function parseModifyPatch(
	payload: Record<string, unknown>,
): { ok: true; value: ParsedModifyPatch } | { ok: false; error: string } {
	const patch: ParsedModifyPatch["patch"] = {};
	let changed = false;
	let contentForEmbedding: string | null = null;

	const hasField = (field: string): boolean =>
		Object.prototype.hasOwnProperty.call(payload, field);

	if (hasField("content")) {
		if (typeof payload.content !== "string") {
			return { ok: false, error: "content must be a string" };
		}
		const normalized = normalizeAndHashContent(payload.content);
		if (!normalized.storageContent) {
			return { ok: false, error: "content must not be empty" };
		}
		patch.content = normalized.storageContent;
		patch.normalizedContent =
			normalized.normalizedContent.length > 0
				? normalized.normalizedContent
				: normalized.hashBasis;
		patch.contentHash = normalized.contentHash;
		contentForEmbedding = normalized.storageContent;
		changed = true;
	}

	if (hasField("type")) {
		const type = parseOptionalString(payload.type);
		if (!type) {
			return { ok: false, error: "type must be a non-empty string" };
		}
		patch.type = type;
		changed = true;
	}

	if (hasField("tags")) {
		const tags = parseTagsMutation(payload.tags);
		if (tags === undefined) {
			return {
				ok: false,
				error: "tags must be a string, string array, or null",
			};
		}
		patch.tags = tags;
		changed = true;
	}

	if (hasField("importance")) {
		const importance = parseOptionalNumber(payload.importance);
		if (
			importance === undefined ||
			importance < 0 ||
			importance > 1 ||
			!Number.isFinite(importance)
		) {
			return {
				ok: false,
				error: "importance must be a finite number between 0 and 1",
			};
		}
		patch.importance = importance;
		changed = true;
	}

	if (hasField("pinned")) {
		const pinned = parseOptionalBoolean(payload.pinned);
		if (pinned === undefined) {
			return { ok: false, error: "pinned must be a boolean" };
		}
		patch.pinned = pinned ? 1 : 0;
		changed = true;
	}

	if (!changed) {
		return {
			ok: false,
			error:
				"at least one of content, type, tags, importance, pinned is required",
		};
	}

	return { ok: true, value: { patch, contentForEmbedding } };
}

app.post("/api/memory/remember", async (c) => {
	let body: {
		content?: string;
		who?: string;
		project?: string;
		importance?: number;
		tags?: string;
		pinned?: boolean;
		sourceType?: string;
		sourceId?: string;
	};

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const raw = body.content?.trim();
	if (!raw) return c.json({ error: "content is required" }, 400);

	// Pipeline v2 kill switch: refuse writes when mutations are frozen
	const fullCfg = loadMemoryConfig(AGENTS_DIR);
	const pipelineCfg = fullCfg.pipelineV2;
	if (pipelineCfg.mutationsFrozen) {
		return c.json({ error: "Mutations are frozen (kill switch active)" }, 503);
	}

	// --- Auto-chunking for oversized memories ---
	const guardrails = pipelineCfg.guardrails;
	if (raw.length > guardrails.maxContentChars) {
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
		const tags = body.tags ?? parsedPrefixes.tags;
		const pipelineEnqueueEnabled = pipelineCfg.enabled || pipelineCfg.shadowMode;

		const groupId = crypto.randomUUID();
		const now = new Date().toISOString();
		const chunkIds: string[] = [];

		// Create chunk group entity
		try {
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'chunk_group', 0, ?, ?)`,
				).run(groupId, `chunk-group:${groupId}`, `chunk-group:${groupId}`, now, now);
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
				chunkNormalized.normalizedContent.length > 0
					? chunkNormalized.normalizedContent
					: chunkNormalized.hashBasis;
			const memType = inferType(chunk);

			try {
				// Dedup check + insert
				const inserted = getDbAccessor().withWriteTx((db) => {
					const byHash = db
						.prepare(
							`SELECT id FROM memories WHERE content_hash = ? AND is_deleted = 0 LIMIT 1`,
						)
						.get(chunkNormalized.contentHash) as { id: string } | undefined;
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
						tags,
						pinned,
						isDeleted: 0,
						extractionStatus: pipelineEnqueueEnabled ? "pending" : "none",
						embeddingModel: null,
						extractionModel: pipelineEnqueueEnabled
							? pipelineCfg.extractionModel
							: null,
						updatedBy: who,
						sourceType: "chunk",
						sourceId: groupId,
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
					const vec = await fetchEmbedding(
						chunkNormalized.storageContent,
						fullCfg.embedding,
					);
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
							getDbAccessor().withWriteTx((db) => {
								syncVecDeleteBySourceId(db, "memory", chunkId);
								db.prepare(
									`DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`,
								).run(chunkId);
								db.prepare(`
									INSERT INTO embeddings
									  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
									VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
								`).run(embId, chunkNormalized.contentHash, blob, vec.length, chunkId, chunkNormalized.storageContent, now);
								syncVecInsert(db, embId, vec);
								db.prepare(`UPDATE memories SET embedding_model = ? WHERE id = ?`).run(
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

				// Enqueue pipeline extraction if enabled
				if (pipelineEnqueueEnabled) {
					try {
						enqueueExtractionJob(getDbAccessor(), chunkId);
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

	// Parse prefixes (critical:, [tags]:) then infer type
	const parsed = parsePrefixes(raw);

	// Body-level overrides for importance/tags/pinned
	const importance = body.importance ?? parsed.importance;
	const pinned = (body.pinned ?? parsed.pinned) ? 1 : 0;
	const tags = body.tags ?? parsed.tags;
	const memType = inferType(parsed.content);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const normalizedContent = normalizeAndHashContent(parsed.content);
	if (!normalizedContent.storageContent) {
		return c.json({ error: "content is required" }, 400);
	}
	const normalizedContentForInsert =
		normalizedContent.normalizedContent.length > 0
			? normalizedContent.normalizedContent
			: normalizedContent.hashBasis;
	const contentHash = normalizedContent.contentHash;
	const pipelineEnqueueEnabled = pipelineCfg.enabled || pipelineCfg.shadowMode;

	type DedupeRow = {
		id: string;
		type: string;
		tags: string | null;
		pinned: number;
		importance: number;
		content: string;
	};

	try {
		// Single atomic write tx: check dedupe then insert.
		// On UNIQUE constraint race (two concurrent inserts with same
		// content_hash), catch the error and re-read the winner.
		const result = getDbAccessor().withWriteTx((db) => {
			// Check sourceId-based dedupe first
			if (sourceId) {
				const bySource = db
					.prepare(
						`SELECT id, type, tags, pinned, importance, content
						 FROM memories WHERE source_type = ? AND source_id = ? AND is_deleted = 0 LIMIT 1`,
					)
					.get(sourceType, sourceId) as DedupeRow | undefined;
				if (bySource) return { deduped: true as const, row: bySource };
			}

			// Check content_hash dedupe
			const byHash = db
				.prepare(
					`SELECT id, type, tags, pinned, importance, content
					 FROM memories
					 WHERE content_hash = ? AND is_deleted = 0 LIMIT 1`,
				)
				.get(contentHash) as DedupeRow | undefined;
			if (byHash) return { deduped: true as const, row: byHash };

			// No duplicate — insert
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
				tags,
				pinned,
				isDeleted: 0,
				extractionStatus: pipelineEnqueueEnabled ? "pending" : "none",
				embeddingModel: null,
				extractionModel: pipelineEnqueueEnabled
					? pipelineCfg.extractionModel
					: null,
				updatedBy: who,
				sourceType,
				sourceId,
				createdAt: now,
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
		// UNIQUE constraint violation = concurrent insert race. Re-read
		// the winner and return it as a deduped result.
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

	// Generate embedding asynchronously — save memory first so failures are
	// non-fatal (memory is still usable via keyword search)
	let embedded = false;
	try {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const vec = await fetchEmbedding(
			normalizedContent.storageContent,
			cfg.embedding,
		);
		if (vec) {
			if (vec.length !== cfg.embedding.dimensions) {
				logger.warn("memory", "Embedding dimension mismatch, skipping vector insert", {
					got: vec.length,
					expected: cfg.embedding.dimensions,
					memoryId: id,
				});
			} else {
				const hash = contentHash;
				const blob = vectorToBlob(vec);
				const embId = crypto.randomUUID();

				getDbAccessor().withWriteTx((db) => {
					syncVecDeleteBySourceId(db, "memory", id);
					db.prepare(
						`DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`,
					).run(id);
					db.prepare(`
						INSERT INTO embeddings
						  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
						VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
					`).run(
						embId,
						hash,
						blob,
						vec.length,
						id,
						normalizedContent.storageContent,
						now,
					);
					syncVecInsert(db, embId, vec);
					db.prepare(`UPDATE memories SET embedding_model = ? WHERE id = ?`).run(
						cfg.embedding.model,
						id,
					);
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

	// Enqueue pipeline extraction if enabled
	if (pipelineEnqueueEnabled) {
		try {
			enqueueExtractionJob(getDbAccessor(), id);
		} catch (e) {
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`UPDATE memories
						 SET extraction_status = 'failed', extraction_model = ?
						 WHERE id = ?`,
				).run(pipelineCfg.extractionModel, id);
			});
			logger.warn("pipeline", "Failed to enqueue extraction job", {
				memoryId: id,
				error: String(e),
			});
		}
	}

	logger.info("memory", "Memory saved", {
		id,
		type: memType,
		pinned: !!pinned,
		embedded,
	});

	return c.json({
		id,
		type: memType,
		tags,
		pinned: !!pinned,
		importance,
		content: normalizedContent.storageContent,
		embedded,
	});
});

// Alias matching the legacy spec path
app.post("/api/memory/save", async (c) => {
	// Re-use the same handler by forwarding to the internal fetch
	const body = await c.req.json().catch(() => ({}));
	return fetch(`http://${HOST}:${PORT}/api/memory/remember`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
});

// Alias for Claude Code skill compatibility
app.post("/api/hook/remember", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	return fetch(`http://${HOST}:${PORT}/api/memory/remember`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
});

// Get a single memory by ID
// Note: Hono's router prioritizes static segments over :id params,
// so /api/memory/search, /api/memory/recall etc. match their own
// routes even though they're registered later in this file.
app.get("/api/memory/:id", (c) => {
	const memoryId = c.req.param("id")?.trim();
	if (!memoryId) {
		return c.json({ error: "memory id is required" }, 400);
	}

	const row = getDbAccessor().withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, content, type, importance, tags, pinned, who,
				        source_type, project, session_id, confidence,
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

	return c.json(row);
});

app.get("/api/memory/:id/history", (c) => {
	const memoryId = c.req.param("id")?.trim();
	if (!memoryId) {
		return c.json({ error: "memory id is required" }, 400);
	}

	const limit = Math.min(parseOptionalInt(c.req.query("limit")) ?? 200, 1000);

	const exists = getDbAccessor().withReadDb((db) => {
		return db.prepare(`SELECT id FROM memories WHERE id = ?`).get(memoryId) as
			| { id: string }
			| undefined;
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

app.post("/api/memory/:id/recover", async (c) => {
	const payload = await readOptionalJsonObject(c);
	if (payload === null) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const memoryId = c.req.param("id")?.trim();
	if (!memoryId) {
		return c.json({ error: "memory id is required" }, 400);
	}

	const reason =
		parseOptionalString(payload.reason) ??
		parseOptionalString(c.req.query("reason"));
	if (!reason) {
		return c.json({ error: "reason is required" }, 400);
	}

	const hasIfVersionInBody = Object.prototype.hasOwnProperty.call(
		payload,
		"if_version",
	);
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
	const actor = resolveMutationActor(
		c,
		parseOptionalString(payload.changed_by),
	);
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
			return c.json(
				{ id: txResult.memoryId, status: txResult.status, error: "Not found" },
				404,
			);
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

	const hasIfVersion = Object.prototype.hasOwnProperty.call(
		payload,
		"if_version",
	);
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
		embeddingVector = await fetchEmbedding(
			parsedPatch.value.contentForEmbedding,
			cfg.embedding,
		);
	}

	const now = new Date().toISOString();
	const actor = resolveMutationActor(
		c,
		parseOptionalString(payload.changed_by),
	);
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
				embedded:
					txResult.contentChanged === true && embeddingVector !== null
						? true
						: undefined,
			});
		case "no_changes":
			return c.json({
				id: txResult.memoryId,
				status: txResult.status,
				currentVersion: txResult.currentVersion,
			});
		case "not_found":
			return c.json(
				{ id: txResult.memoryId, status: txResult.status, error: "Not found" },
				404,
			);
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

app.delete("/api/memory/:id", async (c) => {
	const payload = await readOptionalJsonObject(c);
	if (payload === null) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const memoryId = c.req.param("id")?.trim();
	if (!memoryId) {
		return c.json({ error: "memory id is required" }, 400);
	}

	const reason =
		parseOptionalString(payload.reason) ??
		parseOptionalString(c.req.query("reason"));
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

	const hasIfVersionInBody = Object.prototype.hasOwnProperty.call(
		payload,
		"if_version",
	);
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
	const actor = resolveMutationActor(
		c,
		parseOptionalString(payload.changed_by),
	);
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
			return c.json(
				{ id: txResult.memoryId, status: txResult.status, error: "Not found" },
				404,
			);
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
		limit,
	};

	const hasQueryScope =
		request.query.length > 0 ||
		request.type.length > 0 ||
		request.tags.length > 0 ||
		request.who.length > 0 ||
		request.sourceType.length > 0 ||
		request.since.length > 0 ||
		request.until.length > 0;
	if (ids.length === 0 && !hasQueryScope) {
		return c.json(
			{
				error:
					"query, ids, or at least one filter (type/tags/who/source_type/since/until) is required",
			},
			400,
		);
	}

	const candidates =
		ids.length > 0
			? loadForgetCandidatesByIds(ids, limit)
			: loadForgetCandidates(request);
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
				error:
					"if_version is not supported for batch forget; use DELETE /api/memory/:id for version-guarded deletes",
			},
			400,
		);
	}

	if (requiresConfirm) {
		const providedToken = parseOptionalString(payload.confirm_token);
		if (!providedToken || providedToken !== confirmToken) {
			return c.json(
				{
					error:
						"confirm_token is required for large forget operations; run preview first",
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

	const actor = resolveMutationActor(
		c,
		parseOptionalString(payload.changed_by),
	);
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
	const actor = resolveMutationActor(
		c,
		parseOptionalString(payload.changed_by),
	);
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

		const hasIfVersion = Object.prototype.hasOwnProperty.call(
			patchPayload,
			"if_version",
		);
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
			embeddingVector = await fetchEmbedding(
				parsedPatch.value.contentForEmbedding,
				cfg.embedding,
			);
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
			embedded:
				txResult.contentChanged === true && embeddingVector !== null
					? true
					: undefined,
		});
	}

	return c.json({
		total: results.length,
		updated: results.filter((result) => result.status === "updated").length,
		results,
	});
});

app.post("/api/memory/recall", async (c) => {
	let body: {
		query?: string;
		limit?: number;
		type?: string;
		tags?: string;
		who?: string;
		pinned?: boolean;
		importance_min?: number;
		since?: string;
		until?: string;
	};

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const query = body.query?.trim() ?? "";
	if (!query) return c.json({ error: "query is required" }, 400);

	const cfg = loadMemoryConfig(AGENTS_DIR);
	const limit = body.limit ?? 10;
	const alpha = cfg.search.alpha;
	const minScore = cfg.search.min_score;

	// Build optional filter clause
	const filterParts: string[] = [];
	const filterArgs: unknown[] = [];
	if (body.type) {
		filterParts.push("m.type = ?");
		filterArgs.push(body.type);
	}
	if (body.tags) {
		for (const t of body.tags
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			filterParts.push("m.tags LIKE ?");
			filterArgs.push(`%${t}%`);
		}
	}
	if (body.who) {
		filterParts.push("m.who = ?");
		filterArgs.push(body.who);
	}
	if (body.pinned) {
		filterParts.push("m.pinned = 1");
	}
	if (typeof body.importance_min === "number") {
		filterParts.push("m.importance >= ?");
		filterArgs.push(body.importance_min);
	}
	if (body.since) {
		filterParts.push("m.created_at >= ?");
		filterArgs.push(body.since);
	}
	if (body.until) {
		filterParts.push("m.created_at <= ?");
		filterArgs.push(body.until);
	}
	const filterClause = filterParts.length
		? " AND " + filterParts.join(" AND ")
		: "";

	// --- BM25 keyword search via FTS5 ---
	const bm25Map = new Map<string, number>();
	try {
		getDbAccessor().withReadDb((db) => {
			// bm25() in FTS5 returns negative values (lower = better match),
			// so we negate and normalise to [0,1] via a simple 1/(1+|score|) approach
			const ftsRows = (
				db.prepare(`
        SELECT m.id, bm25(memories_fts) AS raw_score
        FROM memories_fts
        JOIN memories m ON memories_fts.rowid = m.rowid
        WHERE memories_fts MATCH ?${filterClause}
        ORDER BY raw_score
        LIMIT ?
      `) as any
			).all(query, ...filterArgs, cfg.search.top_k) as Array<{
				id: string;
				raw_score: number;
			}>;

			// Min-max normalize BM25 scores to [0,1] within the batch
			// (bm25() returns negative values — lower = better — so we use abs)
			const rawScores = ftsRows.map((r) => Math.abs(r.raw_score));
			const maxRaw = Math.max(...rawScores, 1);
			for (const row of ftsRows) {
				const normalised = Math.abs(row.raw_score) / maxRaw;
				bm25Map.set(row.id, normalised);
			}
		});
	} catch (e) {
		logger.warn("memory", "FTS search failed, continuing with vector only", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	// --- Vector search via sqlite-vec ---
	const vectorMap = new Map<string, number>();
	let queryVecF32: Float32Array | null = null;
	try {
		const queryVec = await fetchEmbedding(query, cfg.embedding);
		if (queryVec) {
			queryVecF32 = new Float32Array(queryVec);
			getDbAccessor().withReadDb((db) => {
				const vecResults = vectorSearch(db as any, queryVecF32!, {
					limit: cfg.search.top_k,
					type: body.type as "fact" | "preference" | "decision" | undefined,
				});
				for (const r of vecResults) {
					vectorMap.set(r.id, r.score);
				}
			});
		}
	} catch (e) {
		logger.warn("memory", "Vector search failed, using keyword only", {
			error: String(e),
		});
	}

	// --- Merge scores ---
	const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
	const scored: Array<{ id: string; score: number; source: string }> = [];

	for (const id of allIds) {
		const bm25 = bm25Map.get(id) ?? 0;
		const vec = vectorMap.get(id) ?? 0;
		let score: number;
		let source: string;

		if (bm25 > 0 && vec > 0) {
			score = alpha * vec + (1 - alpha) * bm25;
			source = "hybrid";
		} else if (vec > 0) {
			score = vec;
			source = "vector";
		} else {
			score = bm25;
			source = "keyword";
		}

		if (score >= minScore) scored.push({ id, score, source });
	}

	scored.sort((a, b) => b.score - a.score);

	// --- Rehearsal boost: frequently accessed memories rank higher ---
	if (cfg.search.rehearsal_enabled && cfg.search.rehearsal_weight > 0 && scored.length > 0) {
		try {
			const rehearsalIds = scored.map((s) => s.id);
			const placeholders = rehearsalIds.map(() => "?").join(", ");
			const accessRows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT id, access_count, last_accessed
							 FROM memories
							 WHERE id IN (${placeholders})`,
						)
						.all(...rehearsalIds) as Array<{
						id: string;
						access_count: number;
						last_accessed: string | null;
					}>,
			);

			const nowMs = Date.now();
			const halfLifeMs = cfg.search.rehearsal_half_life_days * 86_400_000;
			const rw = cfg.search.rehearsal_weight;

			const accessMap = new Map(accessRows.map((r) => [r.id, r]));
			for (const s of scored) {
				const row = accessMap.get(s.id);
				if (!row || row.access_count <= 0) continue;

				const daysSinceAccess = row.last_accessed
					? (nowMs - new Date(row.last_accessed).getTime()) / 86_400_000
					: cfg.search.rehearsal_half_life_days;
				const recencyFactor = Math.pow(0.5, daysSinceAccess / cfg.search.rehearsal_half_life_days);
				const boost = rw * Math.log(row.access_count + 1) * recencyFactor;
				s.score *= 1 + boost;
			}
			scored.sort((a, b) => b.score - a.score);
		} catch (e) {
			logger.warn("memory", "Rehearsal boost failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Graph boost: pull up memories linked via knowledge graph ---
	if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.graph.boostWeight > 0) {
		try {
			const graphResult = getDbAccessor().withReadDb((db) =>
				getGraphBoostIds(query, db, cfg.pipelineV2.graph.boostTimeoutMs),
			);
			if (graphResult.graphLinkedIds.size > 0) {
				const gw = cfg.pipelineV2.graph.boostWeight;
				for (const s of scored) {
					if (graphResult.graphLinkedIds.has(s.id)) {
						s.score = (1 - gw) * s.score + gw;
					}
				}
				scored.sort((a, b) => b.score - a.score);
			}
		} catch (e) {
			logger.warn("memory", "Graph boost failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Optional reranker hook ---
	if (cfg.pipelineV2.reranker.enabled) {
		try {
			const topForRerank = scored.slice(0, cfg.pipelineV2.reranker.topN);
			const rerankIds = topForRerank.map((s) => s.id);
			const rerankPlaceholders = rerankIds.map(() => "?").join(", ");

			// Fetch content for reranker — cross-encoders need document text
			const contentRows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT id, content FROM memories
							 WHERE id IN (${rerankPlaceholders})`,
						)
						.all(...rerankIds) as Array<{ id: string; content: string }>,
			);
			const contentMap = new Map(contentRows.map((r) => [r.id, r.content]));

			const candidates: RerankCandidate[] = topForRerank.map((s) => ({
				id: s.id,
				content: contentMap.get(s.id) ?? "",
				score: s.score,
			}));
			// Use embedding reranker when query vector is available, else noop
		const provider = queryVecF32
			? createEmbeddingReranker(getDbAccessor(), queryVecF32)
			: noopReranker;
		const reranked = await rerank(query, candidates, provider, {
				topN: cfg.pipelineV2.reranker.topN,
				timeoutMs: cfg.pipelineV2.reranker.timeoutMs,
				model: cfg.pipelineV2.reranker.model,
			});
			// Update scores from reranked results
			const rerankedMap = new Map(reranked.map((r, i) => [r.id, i]));
			for (const s of scored) {
				const idx = rerankedMap.get(s.id);
				if (idx !== undefined) {
					// Preserve relative order from reranker
					s.score = 1 - idx / reranked.length;
				}
			}
			scored.sort((a, b) => b.score - a.score);
		} catch (e) {
			logger.warn("memory", "Reranker failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	const topIds = scored.slice(0, limit).map((s) => s.id);

	if (topIds.length === 0) {
		return c.json({ results: [], query, method: "hybrid" });
	}

	// --- Fetch full memory rows ---
	try {
		const placeholders = topIds.map(() => "?").join(", ");

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(`
        SELECT id, content, type, tags, pinned, importance, who, project, created_at
        FROM memories
        WHERE id IN (${placeholders})
      `)
					.all(...topIds) as Array<{
					id: string;
					content: string;
					type: string;
					tags: string | null;
					pinned: number;
					importance: number;
					who: string;
					project: string | null;
					created_at: string;
				}>,
		);

		// Update access tracking (don't fail if this fails)
		try {
			getDbAccessor().withWriteTx((db) => {
				db.prepare(`
          UPDATE memories
          SET last_accessed = datetime('now'), access_count = access_count + 1
          WHERE id IN (${placeholders})
        `).run(...topIds);
			});
		} catch (e) {
			logger.warn("memory", "Failed to update access tracking", e as Error);
		}

		const rowMap = new Map(rows.map((r) => [r.id, r]));
		const recallTruncate = cfg.pipelineV2.guardrails.recallTruncateChars;
		const results = scored
			.slice(0, limit)
			.filter((s) => rowMap.has(s.id))
			.map((s) => {
				const r = rowMap.get(s.id)!;
				const isTruncated = r.content.length > recallTruncate;
				return {
					id: r.id,
					content: isTruncated
						? r.content.slice(0, recallTruncate) + " [truncated]"
						: r.content,
					content_length: r.content.length,
					truncated: isTruncated,
					score: Math.round(s.score * 100) / 100,
					source: s.source,
					type: r.type,
					tags: r.tags,
					pinned: !!r.pinned,
					importance: r.importance,
					who: r.who,
					project: r.project,
					created_at: r.created_at,
				};
			});

		// --- Decision-rationale linking: auto-fetch linked rationale memories ---
		const decisionIds = results
			.filter((r) => r.type === "decision")
			.map((r) => r.id);
		const existingIds = new Set(results.map((r) => r.id));

		if (decisionIds.length > 0 && cfg.pipelineV2.graph.enabled) {
			try {
				const supplementary = getDbAccessor().withReadDb((db) => {
					// Find entities linked to decision memories
					const dPlaceholders = decisionIds.map(() => "?").join(", ");
					const entityIds = db
						.prepare(
							`SELECT DISTINCT entity_id FROM memory_entity_mentions
							 WHERE memory_id IN (${dPlaceholders})`,
						)
						.all(...decisionIds) as Array<{ entity_id: string }>;

					if (entityIds.length === 0) return [];

					// Find rationale memories linked to same entities
					const ePlaceholders = entityIds.map(() => "?").join(", ");
					const eIds = entityIds.map((r) => r.entity_id);

					return db
						.prepare(
							`SELECT DISTINCT m.id, m.content, m.type, m.tags, m.pinned,
							        m.importance, m.who, m.project, m.created_at
							 FROM memory_entity_mentions mem
							 JOIN memories m ON m.id = mem.memory_id
							 WHERE mem.entity_id IN (${ePlaceholders})
							   AND m.type = 'rationale'
							   AND m.is_deleted = 0
							 LIMIT 10`,
						)
						.all(...eIds) as Array<{
						id: string;
						content: string;
						type: string;
						tags: string | null;
						pinned: number;
						importance: number;
						who: string;
						project: string | null;
						created_at: string;
					}>;
				});

				for (const r of supplementary) {
					if (existingIds.has(r.id)) continue;
					existingIds.add(r.id);
					const isTrunc = r.content.length > recallTruncate;
					results.push({
						id: r.id,
						content: isTrunc
							? r.content.slice(0, recallTruncate) + " [truncated]"
							: r.content,
						content_length: r.content.length,
						truncated: isTrunc,
						score: 0,
						source: "graph",
						type: r.type,
						tags: r.tags,
						pinned: !!r.pinned,
						importance: r.importance,
						who: r.who,
						project: r.project,
						created_at: r.created_at,
						supplementary: true,
					});
				}
			} catch (e) {
				logger.warn("memory", "Rationale linking failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		return c.json({
			results,
			query,
			method: vectorMap.size > 0 ? "hybrid" : "keyword",
		});
	} catch (e) {
		logger.error("memory", "Failed to fetch recall results", e as Error);
		return c.json({ error: "Recall failed", results: [] }, 500);
	}
});

// Alias: GET /api/memory/search?q=... (spec-compatible)
app.get("/api/memory/search", async (c) => {
	const q = c.req.query("q") ?? "";
	const limit = parseInt(c.req.query("limit") ?? "10", 10);
	const type = c.req.query("type");
	const tags = c.req.query("tags");
	const who = c.req.query("who");
	const pinned = c.req.query("pinned");
	const importanceMin = c.req.query("importance_min");
	const since = c.req.query("since");

	return fetch(`http://${HOST}:${PORT}/api/memory/recall`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			query: q,
			limit,
			type,
			tags,
			who,
			pinned: pinned === "1" || pinned === "true",
			importance_min: importanceMin ? parseFloat(importanceMin) : undefined,
			since,
		}),
	});
});

// ============================================================================
// Memory Similar API (Vector Search)
// ============================================================================

app.get("/memory/similar", async (c) => {
	const id = c.req.query("id");
	if (!id) {
		return c.json({ error: "id is required", results: [] }, 400);
	}

	const k = parseInt(c.req.query("k") ?? "10", 10);
	const type = c.req.query("type");

	try {
		// Get embedding + run vector search in one read
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

			const searchResults = vectorSearch(db as any, queryVector, {
				limit: k + 1,
				type: type as "fact" | "preference" | "decision" | undefined,
			});

			return searchResults;
		});

		if (!searchData) {
			return c.json(
				{ error: "No embedding found for this memory", results: [] },
				404,
			);
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
					tags: row.tags ? JSON.parse(row.tags) : [],
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

// ============================================================================
// Embeddings API
// ============================================================================

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
			vector:
				withVectors && row.vector
					? blobToVector(row.vector, row.dimensions ?? null)
					: undefined,
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
			const legacy = await runLegacyEmbeddingsExport(
				withVectors,
				limit,
				offset,
			);
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

app.get("/api/embeddings/status", async (c) => {
	const config = loadMemoryConfig(AGENTS_DIR);
	const status = await checkEmbeddingProvider(config.embedding);
	return c.json(status);
});

app.get("/api/embeddings/health", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const providerStatus = await checkEmbeddingProvider(cfg.embedding);
	const report = getDbAccessor().withReadDb((db) =>
		buildEmbeddingHealth(db, cfg.embedding, providerStatus),
	);
	return c.json(report);
});

app.get("/api/embeddings/projection", async (c) => {
	const dimParam = c.req.query("dimensions");
	const nComponents: 2 | 3 = dimParam === "3" ? 3 : 2;

	const { cached, total } = getDbAccessor().withReadDb((db) => {
		const cachedResult = getCachedProjection(db, nComponents);
		const countRow = db
			.prepare(
				"SELECT COUNT(*) as count FROM embeddings WHERE source_type = 'memory'",
			)
			.get();
		const count =
			countRow !== undefined && typeof countRow.count === "number"
				? countRow.count
				: 0;
		return { cached: cachedResult, total: count };
	});

	// Return cached result if embedding count hasn't changed
	if (cached !== null && cached.embeddingCount === total) {
		return c.json({
			status: "ready",
			dimensions: nComponents,
			count: total,
			total,
			nodes: cached.result.nodes,
			edges: cached.result.edges,
			cachedAt: cached.cachedAt,
		});
	}

	// Check for recent computation error
	const recentError = projectionErrors.get(nComponents);
	if (recentError) {
		if (Date.now() > recentError.expires) {
			projectionErrors.delete(nComponents);
		} else {
			return c.json(
				{ status: "error", message: recentError.message },
				500,
			);
		}
	}

	// Kick off background computation if not already running
	if (!projectionInFlight.has(nComponents)) {
		projectionErrors.delete(nComponents);
		const computation = (async () => {
			try {
				const result = getDbAccessor().withReadDb((db) =>
					computeProjection(db, nComponents),
				);
				const count = getDbAccessor().withReadDb((db) => {
					const row = db
						.prepare(
							"SELECT COUNT(*) as count FROM embeddings WHERE source_type = 'memory'",
						)
						.get();
					return row !== undefined && typeof row.count === "number"
						? row.count
						: 0;
				});
				getDbAccessor().withWriteTx((db) =>
					cacheProjection(db, nComponents, result, count),
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error(
					"projection",
					"UMAP computation failed",
					err instanceof Error ? err : new Error(msg),
				);
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

// ============================================================================
// Documents API
// ============================================================================

// POST /api/documents — create a document for ingestion
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
				? (body.url as string | undefined) ?? null
				: null;

	const accessor = getDbAccessor();

	try {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		// Dedup check + insert in same write transaction to prevent races
		const result = accessor.withWriteTx((db) => {
			if (sourceUrl) {
				const existing = db
					.prepare(
						`SELECT id, status FROM documents
						 WHERE source_url = ?
						   AND status NOT IN ('failed', 'deleted')
						 LIMIT 1`,
					)
					.get(sourceUrl) as
					| { id: string; status: string }
					| undefined;
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
				sourceType === "text"
					? (body.content as string)
					: null,
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

		enqueueDocumentIngestJob(accessor, id);

		return c.json({ id, status: "queued" }, 201);
	} catch (e) {
		logger.error("documents", "Failed to create document", e as Error);
		return c.json({ error: "Failed to create document" }, 500);
	}
});

// GET /api/documents — list documents
app.get("/api/documents", (c) => {
	const status = c.req.query("status");
	const limit = Math.min(
		Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50),
		500,
	);
	const offset = Math.max(
		0,
		Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
	);

	try {
		const accessor = getDbAccessor();
		const result = accessor.withReadDb((db) => {
			const countSql = status
				? "SELECT COUNT(*) AS cnt FROM documents WHERE status = ?"
				: "SELECT COUNT(*) AS cnt FROM documents";
			const countRow = (
				status
					? db.prepare(countSql).get(status)
					: db.prepare(countSql).get()
			) as { cnt: number } | undefined;
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

// GET /api/documents/:id — single document details
app.get("/api/documents/:id", (c) => {
	const id = c.req.param("id");
	try {
		const accessor = getDbAccessor();
		const doc = accessor.withReadDb((db) => {
			return db
				.prepare("SELECT * FROM documents WHERE id = ?")
				.get(id);
		});
		if (!doc) return c.json({ error: "Document not found" }, 404);
		return c.json(doc);
	} catch (e) {
		logger.error("documents", "Failed to get document", e as Error);
		return c.json({ error: "Failed to get document" }, 500);
	}
});

// GET /api/documents/:id/chunks — list memories linked to document
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

// DELETE /api/documents/:id — soft-delete document and derived memories
app.delete("/api/documents/:id", async (c) => {
	const id = c.req.param("id");
	const reason = c.req.query("reason");
	if (!reason) {
		return c.json({ error: "reason query parameter is required" }, 400);
	}

	const accessor = getDbAccessor();
	const doc = accessor.withReadDb((db) => {
		return db
			.prepare("SELECT id FROM documents WHERE id = ?")
			.get(id) as { id: string } | undefined;
	});
	if (!doc) return c.json({ error: "Document not found" }, 404);

	try {
		const now = new Date().toISOString();
		const actor = resolveMutationActor(c, "document-api");

		// Get linked memory IDs
		const linkedMemories = accessor.withReadDb((db) => {
			return db
				.prepare(
					`SELECT memory_id FROM document_memories
					 WHERE document_id = ?`,
				)
				.all(id) as ReadonlyArray<{ memory_id: string }>;
		});

		// Soft-delete each linked memory
		let memoriesRemoved = 0;
		for (const link of linkedMemories) {
			accessor.withWriteTx((db) => {
				const mem = db
					.prepare(
						"SELECT is_deleted FROM memories WHERE id = ?",
					)
					.get(link.memory_id) as
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
				).run(
					histId,
					link.memory_id,
					actor.changedBy,
					`Document deleted: ${reason}`,
					now,
				);

				memoriesRemoved++;
			});
		}

		// Mark document as failed/removed
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

// ============================================================================
// Connectors API
// ============================================================================

// GET /api/connectors — list all connectors
app.get("/api/connectors", (c) => {
	try {
		const accessor = getDbAccessor();
		const connectors = listConnectors(accessor);
		return c.json({ connectors, count: connectors.length });
	} catch (e) {
		logger.error("connectors", "Failed to list", e as Error);
		return c.json({ error: "Failed to list connectors" }, 500);
	}
});

// POST /api/connectors — register a new connector
app.post("/api/connectors", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = (await c.req.json()) as Record<string, unknown>;
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const provider = body.provider as string | undefined;
	if (!provider || !["filesystem", "github-docs", "gdrive"].includes(provider)) {
		return c.json(
			{ error: "provider must be filesystem, github-docs, or gdrive" },
			400,
		);
	}

	const displayName =
		typeof body.displayName === "string" ? body.displayName : provider;
	const settings =
		typeof body.settings === "object" && body.settings !== null
			? (body.settings as Record<string, unknown>)
			: {};

	try {
		const accessor = getDbAccessor();
		const config = {
			id: crypto.randomUUID(),
			provider: provider as "filesystem" | "github-docs" | "gdrive",
			displayName,
			settings,
			enabled: true,
		};

		const id = registerConnector(accessor, config);
		return c.json({ id }, 201);
	} catch (e) {
		logger.error("connectors", "Failed to register", e as Error);
		return c.json({ error: "Failed to register connector" }, 500);
	}
});

// GET /api/connectors/:id — connector details
app.get("/api/connectors/:id", (c) => {
	const id = c.req.param("id");
	try {
		const accessor = getDbAccessor();
		const connector = getConnector(accessor, id);
		if (!connector) return c.json({ error: "Connector not found" }, 404);
		return c.json(connector);
	} catch (e) {
		logger.error("connectors", "Failed to get connector", e as Error);
		return c.json({ error: "Failed to get connector" }, 500);
	}
});

// POST /api/connectors/:id/sync — trigger incremental sync
app.post("/api/connectors/:id/sync", async (c) => {
	const id = c.req.param("id");
	const accessor = getDbAccessor();

	const connectorRow = getConnector(accessor, id);
	if (!connectorRow) return c.json({ error: "Connector not found" }, 404);

	if (connectorRow.status === "syncing") {
		return c.json({ status: "syncing", message: "Already syncing" });
	}

	const config = JSON.parse(connectorRow.config_json) as {
		id: string;
		provider: "filesystem" | "github-docs" | "gdrive";
		displayName: string;
		settings: Record<string, unknown>;
		enabled: boolean;
	};

	// Only filesystem is supported for now
	if (config.provider !== "filesystem") {
		return c.json(
			{ error: `Provider ${config.provider} not yet supported` },
			501,
		);
	}

	updateConnectorStatus(accessor, id, "syncing");

	// Fire and forget — caller polls GET /api/connectors/:id for status
	const connector = createFilesystemConnector(config, accessor);
	const cursor = connectorRow.cursor_json
		? (JSON.parse(connectorRow.cursor_json) as {
				lastSyncAt: string;
				checkpoint?: string;
				version?: number;
			})
		: { lastSyncAt: new Date(0).toISOString() };

	connector
		.syncIncremental(cursor)
		.then((result) => {
			updateCursor(accessor, id, result.cursor);
			updateConnectorStatus(accessor, id, "idle");
			logger.info("connectors", "Sync completed", {
				connectorId: id,
				added: result.documentsAdded,
				updated: result.documentsUpdated,
			});
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			updateConnectorStatus(accessor, id, "error", msg);
			logger.error("connectors", "Sync failed", new Error(msg));
		});

	return c.json({ status: "syncing" });
});

// POST /api/connectors/:id/sync/full — trigger full resync
app.post("/api/connectors/:id/sync/full", async (c) => {
	const id = c.req.param("id");
	const confirm = c.req.query("confirm");
	if (confirm !== "true") {
		return c.json(
			{ error: "Full resync requires ?confirm=true" },
			400,
		);
	}

	const accessor = getDbAccessor();
	const connectorRow = getConnector(accessor, id);
	if (!connectorRow) return c.json({ error: "Connector not found" }, 404);

	const config = JSON.parse(connectorRow.config_json) as {
		id: string;
		provider: "filesystem" | "github-docs" | "gdrive";
		displayName: string;
		settings: Record<string, unknown>;
		enabled: boolean;
	};

	if (config.provider !== "filesystem") {
		return c.json(
			{ error: `Provider ${config.provider} not yet supported` },
			501,
		);
	}

	updateConnectorStatus(accessor, id, "syncing");

	const connector = createFilesystemConnector(config, accessor);

	connector
		.syncFull()
		.then((result) => {
			updateCursor(accessor, id, result.cursor);
			updateConnectorStatus(accessor, id, "idle");
			logger.info("connectors", "Full sync completed", {
				connectorId: id,
				added: result.documentsAdded,
			});
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			updateConnectorStatus(accessor, id, "error", msg);
			logger.error("connectors", "Full sync failed", new Error(msg));
		});

	return c.json({ status: "syncing" });
});

/** Escape LIKE special characters for safe prefix matching. */
function escapeLikePrefix(value: string): string {
	return `${value.replace(/[%_\\]/g, "\\$&")}%`;
}

// DELETE /api/connectors/:id — remove connector
app.delete("/api/connectors/:id", (c) => {
	const id = c.req.param("id");
	const cascade = c.req.query("cascade") === "true";

	try {
		const accessor = getDbAccessor();
		const connectorRow = getConnector(accessor, id);
		if (!connectorRow) {
			return c.json({ error: "Connector not found" }, 404);
		}

		if (cascade) {
			// Find documents created by this connector via source_url pattern
			const config = JSON.parse(connectorRow.config_json) as {
				settings?: { rootPath?: string };
			};
			const rootPath = config.settings?.rootPath;
			if (rootPath) {
				const docs = accessor.withReadDb((db) => {
					return db
						.prepare(
							`SELECT id FROM documents
							 WHERE source_url LIKE ? ESCAPE '\\'`,
						)
						.all(escapeLikePrefix(rootPath)) as ReadonlyArray<{ id: string }>;
				});
				const now = new Date().toISOString();
				for (const doc of docs) {
					accessor.withWriteTx((db) => {
						db.prepare(
							`UPDATE documents
							 SET status = 'deleted',
							     error = 'Connector removed',
							     updated_at = ?
							 WHERE id = ?`,
						).run(now, doc.id);
					});
				}
			}
		}

		const removed = removeConnector(accessor, id);
		return c.json({ deleted: removed });
	} catch (e) {
		logger.error("connectors", "Failed to remove", e as Error);
		return c.json({ error: "Failed to remove connector" }, 500);
	}
});

// GET /api/connectors/:id/health — connector health
app.get("/api/connectors/:id/health", (c) => {
	const id = c.req.param("id");
	try {
		const accessor = getDbAccessor();
		const connectorRow = getConnector(accessor, id);
		if (!connectorRow) {
			return c.json({ error: "Connector not found" }, 404);
		}

		const docCount = accessor.withReadDb((db) => {
			const config = JSON.parse(connectorRow.config_json) as {
				settings?: { rootPath?: string };
			};
			const rootPath = config.settings?.rootPath;
			if (!rootPath) return 0;
			const row = db
				.prepare(
					`SELECT COUNT(*) AS cnt FROM documents
					 WHERE source_url LIKE ? ESCAPE '\\'`,
				)
				.get(escapeLikePrefix(rootPath)) as { cnt: number } | undefined;
			return row?.cnt ?? 0;
		});

		return c.json({
			id: connectorRow.id,
			status: connectorRow.status,
			lastSyncAt: connectorRow.last_sync_at,
			lastError: connectorRow.last_error,
			documentCount: docCount,
		});
	} catch (e) {
		logger.error("connectors", "Failed to get health", e as Error);
		return c.json({ error: "Failed to get connector health" }, 500);
	}
});

// ============================================================================
// Skills API
// ============================================================================

interface SkillMeta {
	description: string;
	version?: string;
	author?: string;
	license?: string;
	user_invocable?: boolean;
	arg_hint?: string;
}

function parseSkillFrontmatter(content: string): SkillMeta {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { description: "" };

	const fm = match[1];
	const get = (key: string) => {
		const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
	};

	return {
		description: get("description"),
		version: get("version") || undefined,
		author: get("author") || undefined,
		license: get("license") || undefined,
		user_invocable: /^user_invocable:\s*true$/m.test(fm),
		arg_hint: get("arg_hint") || undefined,
	};
}

function listInstalledSkills() {
	if (!existsSync(SKILLS_DIR)) return [];

	return readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			const skillMdPath = join(SKILLS_DIR, d.name, "SKILL.md");
			if (!existsSync(skillMdPath)) return [];
			try {
				const content = readFileSync(skillMdPath, "utf-8");
				const meta = parseSkillFrontmatter(content);
				return [{ name: d.name, ...meta, path: join(SKILLS_DIR, d.name) }];
			} catch {
				return [];
			}
		});
}

// GET /api/skills - list installed skills
app.get("/api/skills", (c) => {
	try {
		const skills = listInstalledSkills();
		return c.json({ skills, count: skills.length });
	} catch (e) {
		logger.error("skills", "Error listing skills", e as Error);
		return c.json({ skills: [], count: 0, error: "Failed to list skills" });
	}
});

// --- skills.sh catalog cache for browse tabs ---
type CatalogEntry = {
	source: string;
	skillId: string;
	name: string;
	installs: number;
};
let catalogCache: CatalogEntry[] = [];
let catalogFetchedAt = 0;
const CATALOG_TTL = 10 * 60 * 1000;

function formatInstalls(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
	const now = Date.now();
	if (catalogCache.length > 0 && now - catalogFetchedAt < CATALOG_TTL) {
		return catalogCache;
	}
	logger.info("skills", "Fetching skills.sh catalog");
	try {
		const res = await fetch("https://skills.sh", {
			headers: { "User-Agent": "signet-daemon" },
		});
		const html = await res.text();
		const entries: CatalogEntry[] = [];
		const re =
			/\{\\"source\\":\\"([^\\]+)\\",\\"skillId\\":\\"([^\\]+)\\",\\"name\\":\\"([^\\]+)\\",\\"installs\\":(\d+)\}/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			entries.push({
				source: m[1],
				skillId: m[2],
				name: m[3],
				installs: Number(m[4]),
			});
		}
		if (entries.length > 0) {
			catalogCache = entries;
			catalogFetchedAt = now;
			logger.info("skills", `Cached ${entries.length} skills`);
		}
		return entries.length > 0 ? entries : catalogCache;
	} catch (err) {
		logger.error("skills", "Catalog fetch failed", err as Error);
		return catalogCache;
	}
}

// --- ClawHub catalog cache ---
type ClawhubItem = {
	slug: string;
	displayName: string;
	summary: string;
	tags: { latest: string };
	stats: {
		downloads: number;
		installsAllTime: number;
		installsCurrent: number;
		stars: number;
		comments: number;
		versions: number;
	};
	createdAt: number;
	updatedAt: number;
	latestVersion: {
		version: string;
		createdAt: number;
		changelog: string;
	};
};
let clawhubCache: ClawhubItem[] = [];
let clawhubFetchedAt = 0;

async function fetchClawhubCatalog(): Promise<ClawhubItem[]> {
	const now = Date.now();
	if (clawhubCache.length > 0 && now - clawhubFetchedAt < CATALOG_TTL) {
		return clawhubCache;
	}
	logger.info("skills", "Fetching ClawHub catalog");
	try {
		const items: ClawhubItem[] = [];
		let cursor: string | undefined;
		const MAX_ITEMS = 500;
		const MAX_PAGES = 10;
		let page = 0;
		while (page < MAX_PAGES && items.length < MAX_ITEMS) {
			const url = new URL("https://clawhub.ai/api/v1/skills");
			url.searchParams.set("sort", "downloads");
			url.searchParams.set("limit", "50");
			if (cursor) url.searchParams.set("cursor", cursor);

			const res = await fetch(url.toString(), {
				headers: { "User-Agent": "signet-daemon" },
			});
			if (!res.ok) throw new Error(`ClawHub returned ${res.status}`);
			const data = (await res.json()) as {
				items: ClawhubItem[];
				nextCursor: string | null;
			};
			items.push(...data.items);
			if (!data.nextCursor) break;
			cursor = data.nextCursor;
			page++;
		}
		if (items.length > 0) {
			clawhubCache = items;
			clawhubFetchedAt = now;
			logger.info("skills", `Cached ${items.length} ClawHub skills`);
		}
		return items.length > 0 ? items : clawhubCache;
	} catch (err) {
		logger.error("skills", "ClawHub catalog fetch failed", err as Error);
		return clawhubCache;
	}
}

type SkillBrowseResult = {
	name: string;
	fullName: string;
	installs: string;
	installsRaw: number;
	description: string;
	installed: boolean;
	provider: "skills.sh" | "clawhub";
	stars?: number;
	downloads?: number;
	versions?: number;
	author?: string;
};

// GET /api/skills/browse - browse all skills (skills.sh + ClawHub)
app.get("/api/skills/browse", async (c) => {
	const [skillsShCatalog, clawhubItems] = await Promise.all([
		fetchCatalog(),
		fetchClawhubCatalog(),
	]);
	const installed = listInstalledSkills().map((s) => s.name);

	const skillsShResults: SkillBrowseResult[] = skillsShCatalog.map((s) => ({
		name: s.name,
		fullName: `${s.source}@${s.skillId}`,
		installs: formatInstalls(s.installs),
		installsRaw: s.installs,
		description: "",
		installed: installed.includes(s.name),
		provider: "skills.sh" as const,
		downloads: s.installs,
	}));

	const clawhubResults: SkillBrowseResult[] = clawhubItems.map((s) => ({
		name: s.slug,
		fullName: `clawhub@${s.slug}`,
		installs: formatInstalls(s.stats.installsAllTime),
		installsRaw: s.stats.installsAllTime,
		description: s.summary,
		installed: installed.includes(s.slug),
		provider: "clawhub" as const,
		stars: s.stats.stars,
		downloads: s.stats.downloads,
		versions: s.stats.versions,
		author: s.displayName,
	}));

	const results = [...skillsShResults, ...clawhubResults].sort(
		(a, b) => b.installsRaw - a.installsRaw,
	);
	return c.json({ results, total: results.length });
});

// GET /api/skills/search?q=query - search both skills.sh and ClawHub
app.get("/api/skills/search", async (c) => {
	const query = c.req.query("q");
	if (!query) {
		return c.json(
			{ results: [], error: "Query parameter q is required" },
			400,
		);
	}

	logger.info("skills", "Searching skills", { query });
	const installed = listInstalledSkills().map((s) => s.name);
	const lowerQuery = query.toLowerCase();

	// Search skills.sh API + filter cached ClawHub in parallel
	const [skillsShResults, clawhubFiltered] = await Promise.all([
		(async (): Promise<SkillBrowseResult[]> => {
			try {
				const res = await fetch(
					`https://skills.sh/api/search?q=${encodeURIComponent(query)}`,
					{ headers: { "User-Agent": "signet-daemon" } },
				);
				if (!res.ok) throw new Error(`skills.sh returned ${res.status}`);
				const data = (await res.json()) as {
					skills: Array<{
						id: string;
						skillId: string;
						name: string;
						installs: number;
						source: string;
					}>;
				};
				return (data.skills ?? []).map((s) => ({
					name: s.name,
					fullName: `${s.source}@${s.skillId}`,
					installs: formatInstalls(s.installs),
					installsRaw: s.installs,
					description: "",
					installed: installed.includes(s.name),
					provider: "skills.sh" as const,
					downloads: s.installs,
				}));
			} catch (err) {
				logger.error("skills", "skills.sh search failed", err as Error);
				return [];
			}
		})(),
		(async (): Promise<SkillBrowseResult[]> => {
			const cached = await fetchClawhubCatalog();
			return cached
				.filter(
					(s) =>
						s.slug.toLowerCase().includes(lowerQuery) ||
						s.displayName.toLowerCase().includes(lowerQuery) ||
						s.summary.toLowerCase().includes(lowerQuery),
				)
				.map((s) => ({
					name: s.slug,
					fullName: `clawhub@${s.slug}`,
					installs: formatInstalls(s.stats.installsAllTime),
					installsRaw: s.stats.installsAllTime,
					description: s.summary,
					installed: installed.includes(s.slug),
					provider: "clawhub" as const,
					stars: s.stats.stars,
					downloads: s.stats.downloads,
					versions: s.stats.versions,
					author: s.displayName,
				}));
		})(),
	]);

	const results = [...skillsShResults, ...clawhubFiltered].sort(
		(a, b) => b.installsRaw - a.installsRaw,
	);
	return c.json({ results });
});

// GET /api/skills/:name - get skill details and SKILL.md content
app.get("/api/skills/:name", async (c) => {
	const name = c.req.param("name");
	if (!name || name.includes("/") || name.includes("..")) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	// Try local install first
	const skillMdPath = join(SKILLS_DIR, name, "SKILL.md");
	if (existsSync(skillMdPath)) {
		try {
			const content = readFileSync(skillMdPath, "utf-8");
			const meta = parseSkillFrontmatter(content);
			return c.json({
				name,
				...meta,
				path: join(SKILLS_DIR, name),
				content,
			});
		} catch (e) {
			logger.error("skills", "Error reading skill", e as Error);
			return c.json({ error: "Failed to read skill" }, 500);
		}
	}

	// Fallback: fetch SKILL.md from GitHub via repo tree search
	const source = c.req.query("source");
	const repo = source
		? source.split("@")[0]
		: catalogCache.find((s) => s.name === name)?.source;

	if (repo) {
		try {
			// Search repo tree for the SKILL.md path
			const treeRes = await fetch(
				`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
				{ headers: { Accept: "application/vnd.github.v3+json" } },
			);
			if (treeRes.ok) {
				const tree = (await treeRes.json()) as {
					tree: { path: string }[];
				};
				const needle = `${name}/SKILL.md`;
				const match = tree.tree.find((t) => t.path.endsWith(needle));
				if (match) {
					const rawUrl = `https://raw.githubusercontent.com/${repo}/main/${match.path}`;
					const mdRes = await fetch(rawUrl);
					if (mdRes.ok) {
						const content = await mdRes.text();
						const meta = parseSkillFrontmatter(content);
						return c.json({ name, ...meta, content });
					}
				}
			}
		} catch (e) {
			logger.warn("skills", "GitHub SKILL.md fetch failed", {
				name,
				error: (e as Error).message,
			});
		}
	}

	return c.json({ error: `Skill '${name}' not found` }, 404);
});

// POST /api/skills/install - install a skill
app.post("/api/skills/install", async (c) => {
	let body: { name?: string; source?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const { name, source } = body;
	if (!name) {
		return c.json({ error: "name is required" }, 400);
	}

	// Sanitize: allow alphanumeric, dash, underscore, slash (for owner/repo)
	if (!/^[\w\-./]+$/.test(name)) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	const pkg = source || name;
	logger.info("skills", "Installing skill", { name, pkg });
	const packageManager = resolvePrimaryPackageManager({
		agentsDir: AGENTS_DIR,
		env: process.env,
	});
	const skillsCommand = getSkillsRunnerCommand(packageManager.family, [
		"add",
		pkg,
		"--global",
		"--yes",
	]);

	logger.info("skills", "Using package manager", {
		command: `${skillsCommand.command} ${skillsCommand.args.join(" ")}`,
		family: packageManager.family,
		source: packageManager.source,
		reason: packageManager.reason,
	});

	return new Promise<Response>((resolve) => {
		const proc = spawn(skillsCommand.command, skillsCommand.args, {
			env: { ...process.env },
			timeout: 60000,
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		proc.on("close", (code) => {
			if (code === 0) {
				logger.info("skills", "Skill installed", { name });
				resolve(c.json({ success: true, name, output: stdout }));
			} else {
				const errMsg = stderr || stdout || `Install exited with code ${code}`;
				logger.error("skills", "Skill install failed", undefined, { stderr });
				resolve(c.json({ success: false, error: errMsg }, 500));
			}
		});

		proc.on("error", (err: Error) => {
			resolve(c.json({ success: false, error: err.message }, 500));
		});
	});
});

// DELETE /api/skills/:name - uninstall a skill
app.delete("/api/skills/:name", (c) => {
	const name = c.req.param("name");
	if (!name || name.includes("/") || name.includes("..")) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	const skillDir = join(SKILLS_DIR, name);
	if (!existsSync(skillDir)) {
		return c.json({ error: `Skill '${name}' not found` }, 404);
	}

	try {
		rmSync(skillDir, { recursive: true, force: true });
		logger.info("skills", "Skill removed", { name });
		return c.json({ success: true, name, message: `Removed ${name}` });
	} catch (e) {
		logger.error("skills", "Error removing skill", e as Error);
		return c.json({ success: false, error: "Failed to remove skill" }, 500);
	}
});

// ============================================================================
// Harnesses API
// ============================================================================

app.get("/api/harnesses", async (c) => {
	const configs = [
		{ name: "Claude Code", path: join(homedir(), ".claude", "CLAUDE.md") },
		{
			name: "OpenCode",
			path: join(homedir(), ".config", "opencode", "AGENTS.md"),
		},
		{ name: "OpenClaw (Source)", path: join(AGENTS_DIR, "AGENTS.md") },
	];

	const harnesses = configs.map((config) => ({
		name: config.name,
		path: config.path,
		exists: existsSync(config.path),
	}));

	return c.json({ harnesses });
});

app.post("/api/harnesses/regenerate", async (c) => {
	return new Promise<Response>((resolve) => {
		const script = join(SCRIPTS_DIR, "generate-harness-configs.py");

		if (!existsSync(script)) {
			resolve(
				c.json({ success: false, error: "Regeneration script not found" }, 404),
			);
			return;
		}

		const proc = spawn("python3", [script], {
			timeout: 10000,
			cwd: AGENTS_DIR,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (code === 0) {
				logger.info("harness", "Harness configs regenerated");
				resolve(
					c.json({
						success: true,
						message: "Configs regenerated successfully",
						output: stdout,
					}),
				);
			} else {
				resolve(
					c.json(
						{
							success: false,
							error: stderr || `Script exited with code ${code}`,
						},
						500,
					),
				);
			}
		});

		proc.on("error", (err) => {
			resolve(c.json({ success: false, error: err.message }, 500));
		});
	});
});

// ============================================================================
// Secrets API
// ============================================================================

// Store a secret
app.post("/api/secrets/:name", async (c) => {
	const { name } = c.req.param();
	try {
		const body = (await c.req.json()) as { value?: string };
		if (typeof body.value !== "string" || body.value.length === 0) {
			return c.json({ error: "value is required" }, 400);
		}
		await putSecret(name, body.value);
		logger.info("secrets", "Secret stored", { name });
		return c.json({ success: true, name });
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "Failed to store secret", err, { name });
		return c.json({ error: err.message }, 400);
	}
});

// List secret names (never values)
app.get("/api/secrets", (c) => {
	try {
		const names = listSecrets();
		return c.json({ secrets: names });
	} catch (e) {
		logger.error("secrets", "Failed to list secrets", e as Error);
		return c.json({ error: "Failed to list secrets" }, 500);
	}
});

// Delete a secret
app.delete("/api/secrets/:name", (c) => {
	const { name } = c.req.param();
	try {
		const deleted = deleteSecret(name);
		if (!deleted) return c.json({ error: `Secret '${name}' not found` }, 404);
		logger.info("secrets", "Secret deleted", { name });
		return c.json({ success: true, name });
	} catch (e) {
		logger.error("secrets", "Failed to delete secret", e as Error, { name });
		return c.json({ error: (e as Error).message }, 500);
	}
});

// Execute a command with secrets injected into the subprocess environment.
// The agent provides references (env var → secret name), never values.
app.post("/api/secrets/:name/exec", async (c) => {
	const { name } = c.req.param();
	try {
		const body = (await c.req.json()) as {
			command?: string;
			secrets?: Record<string, string>;
		};

		if (!body.command) {
			return c.json({ error: "command is required" }, 400);
		}

		// By default inject the named secret under its own env var name.
		// Callers can pass a full secrets map to inject multiple secrets.
		const secretRefs: Record<string, string> = body.secrets ?? { [name]: name };

		const result = await execWithSecrets(body.command, secretRefs);
		logger.info("secrets", "exec_with_secrets completed", {
			name,
			code: result.code,
		});
		return c.json(result);
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "exec_with_secrets failed", err, { name });
		return c.json({ error: err.message }, 500);
	}
});

// ============================================================================
// ============================================================================
// Hooks API
// ============================================================================

import {
	handleSessionStart,
	handlePreCompaction,
	handleSynthesisRequest,
	getSynthesisConfig,
	handleUserPromptSubmit,
	handleSessionEnd,
	handleRemember,
	handleRecall,
	type SessionStartRequest,
	type PreCompactionRequest,
	type SynthesisRequest,
	type UserPromptSubmitRequest,
	type SessionEndRequest,
	type RememberRequest,
	type RecallRequest,
} from "./hooks.js";

import {
	claimSession,
	getSessionPath,
	releaseSession,
	startSessionCleanup,
	type RuntimePath,
} from "./session-tracker.js";

/** Read the runtime path from header or body, preferring header. */
function resolveRuntimePath(c: Context, body?: { runtimePath?: string }): RuntimePath | undefined {
	const header = c.req.header("x-signet-runtime-path");
	const val = header || body?.runtimePath;
	if (val === "plugin" || val === "legacy") return val;
	return undefined;
}

/**
 * Check that a mid-session hook call is from the path that claimed the
 * session. Returns a 409 Response if there's a conflict, or null if ok.
 */
function checkSessionClaim(
	c: Context,
	sessionKey: string | undefined,
	runtimePath: RuntimePath | undefined,
): Response | null {
	if (!sessionKey || !runtimePath) return null;

	const owner = getSessionPath(sessionKey);
	if (owner && owner !== runtimePath) {
		return c.json(
			{ error: `session claimed by ${owner} path` },
			409,
		) as unknown as Response;
	}
	return null;
}

// Start session cleanup timer
startSessionCleanup();

// Session start hook - provides context/memories for injection
app.post("/api/hooks/session-start", async (c) => {
	try {
		const body = (await c.req.json()) as SessionStartRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		// Enforce single runtime path per session
		if (body.sessionKey && runtimePath) {
			const claim = claimSession(body.sessionKey, runtimePath);
			if (!claim.ok) {
				return c.json({
					error: `session claimed by ${claim.claimedBy} path`,
				}, 409);
			}
		}

		const result = handleSessionStart(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Session start hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// User prompt submit hook - inject relevant memories per prompt
app.post("/api/hooks/user-prompt-submit", async (c) => {
	try {
		const body = (await c.req.json()) as UserPromptSubmitRequest;

		if (!body.harness || !body.userPrompt) {
			return c.json({ error: "harness and userPrompt are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		const result = handleUserPromptSubmit(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "User prompt submit hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Session end hook - extract memories from transcript
app.post("/api/hooks/session-end", async (c) => {
	try {
		const body = (await c.req.json()) as SessionEndRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const result = await handleSessionEnd(body);

		// Release session claim on end
		const sessionKey = body.sessionKey || body.sessionId;
		if (sessionKey) {
			releaseSession(sessionKey);
		}

		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Session end hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Remember hook - explicit memory save
app.post("/api/hooks/remember", async (c) => {
	try {
		const body = (await c.req.json()) as RememberRequest;

		if (!body.harness || !body.content) {
			return c.json({ error: "harness and content are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		const result = handleRemember(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Remember hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Recall hook - explicit memory query
app.post("/api/hooks/recall", async (c) => {
	try {
		const body = (await c.req.json()) as RecallRequest;

		if (!body.harness || !body.query) {
			return c.json({ error: "harness and query are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		const result = handleRecall(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Recall hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Pre-compaction hook - provides summary instructions
app.post("/api/hooks/pre-compaction", async (c) => {
	try {
		const body = (await c.req.json()) as PreCompactionRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		const result = handlePreCompaction(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Pre-compaction hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Save compaction summary (convenience endpoint)
app.post("/api/hooks/compaction-complete", async (c) => {
	try {
		const body = (await c.req.json()) as {
			harness: string;
			summary: string;
			sessionKey?: string;
			runtimePath?: string;
		};

		if (!body.harness || !body.summary) {
			return c.json({ error: "harness and summary are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		// Save the summary as a memory
		if (!existsSync(MEMORY_DB)) {
			return c.json({ error: "Memory database not found" }, 500);
		}

		const now = new Date().toISOString();

		const summaryId = crypto.randomUUID();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(`
        INSERT INTO memories (id, content, type, importance, source_type, who, tags, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
				summaryId,
				body.summary,
				"session_summary",
				0.8,
				body.harness,
				"system",
				JSON.stringify(["session", "summary", body.harness]),
				now,
				now,
				"system",
			);
		});

		logger.info("hooks", "Compaction summary saved", {
			harness: body.harness,
			memoryId: summaryId,
		});

		return c.json({
			success: true,
			memoryId: summaryId,
		});
	} catch (e) {
		logger.error("hooks", "Compaction complete failed", e as Error);
		return c.json({ error: "Failed to save summary" }, 500);
	}
});

// Get synthesis config
app.get("/api/hooks/synthesis/config", (c) => {
	const config = getSynthesisConfig();
	return c.json(config);
});

// Request MEMORY.md synthesis
app.post("/api/hooks/synthesis", async (c) => {
	try {
		const body = (await c.req.json()) as SynthesisRequest;
		const result = handleSynthesisRequest(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Synthesis request failed", e as Error);
		return c.json({ error: "Synthesis request failed" }, 500);
	}
});

// Save synthesized MEMORY.md
app.post("/api/hooks/synthesis/complete", async (c) => {
	try {
		const body = (await c.req.json()) as { content: string };

		if (!body.content) {
			return c.json({ error: "content is required" }, 400);
		}

		const memoryMdPath = join(AGENTS_DIR, "MEMORY.md");

		// Backup existing
		if (existsSync(memoryMdPath)) {
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.slice(0, 19);
			const backupPath = join(
				AGENTS_DIR,
				"memory",
				`MEMORY.backup-${timestamp}.md`,
			);
			mkdirSync(join(AGENTS_DIR, "memory"), { recursive: true });
			writeFileSync(backupPath, readFileSync(memoryMdPath, "utf-8"));
		}

		// Write new MEMORY.md with timestamp header
		const header = `<!-- generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} -->\n\n`;
		writeFileSync(memoryMdPath, header + body.content);

		logger.info("hooks", "MEMORY.md synthesized");

		return c.json({ success: true });
	} catch (e) {
		logger.error("hooks", "Synthesis complete failed", e as Error);
		return c.json({ error: "Failed to save MEMORY.md" }, 500);
	}
});

// ============================================================================
// Git Sync API
// ============================================================================

// Get git status
app.get("/api/git/status", async (c) => {
	const status = await getGitStatus();
	return c.json(status);
});

// Pull changes from remote
app.post("/api/git/pull", async (c) => {
	const result = await gitPull();
	return c.json(result);
});

// Push changes to remote
app.post("/api/git/push", async (c) => {
	const result = await gitPush();
	return c.json(result);
});

// Full sync (pull + push)
app.post("/api/git/sync", async (c) => {
	const result = await gitSync();
	return c.json(result);
});

// Get/set git config
app.get("/api/git/config", (c) => {
	return c.json(gitConfig);
});

app.post("/api/git/config", async (c) => {
	const body = (await c.req.json()) as Partial<GitConfig>;

	// Update in-memory config
	if (body.autoSync !== undefined) gitConfig.autoSync = body.autoSync;
	if (body.syncInterval !== undefined)
		gitConfig.syncInterval = body.syncInterval;
	if (body.remote) gitConfig.remote = body.remote;
	if (body.branch) gitConfig.branch = body.branch;

	// Restart sync timer if needed
	if (body.autoSync !== undefined || body.syncInterval !== undefined) {
		stopGitSyncTimer();
		if (gitConfig.autoSync) {
			startGitSyncTimer();
		}
	}

	return c.json({ success: true, config: gitConfig });
});

// ============================================================================
// Update System (extracted to ./update-system.ts)
// ============================================================================

// API: Check for updates
app.get("/api/update/check", async (c) => {
	const force = c.req.query("force") === "true";
	const us = getUpdateState();

	if (!force && us.lastCheck && us.lastCheckTime) {
		const age = Date.now() - us.lastCheckTime.getTime();
		if (age < 3600000) {
			return c.json({
				...us.lastCheck,
				cached: true,
				checkedAt: us.lastCheckTime.toISOString(),
			});
		}
	}

	const result = await checkForUpdatesImpl();
	const after = getUpdateState();
	return c.json({
		...result,
		cached: false,
		checkedAt: after.lastCheckTime?.toISOString(),
	});
});

// API: Get/set update config
app.get("/api/update/config", (c) => {
	const us = getUpdateState();
	return c.json({
		...us.config,
		minInterval: MIN_UPDATE_INTERVAL_SECONDS,
		maxInterval: MAX_UPDATE_INTERVAL_SECONDS,
		pendingRestartVersion: us.pendingRestartVersion,
		lastAutoUpdateAt: us.lastAutoUpdateAt?.toISOString(),
		lastAutoUpdateError: us.lastAutoUpdateError,
		updateInProgress: us.installInProgress,
	});
});

app.post("/api/update/config", async (c) => {
	type UpdateConfigBody = Partial<{
		autoInstall: boolean | string;
		auto_install: boolean | string;
		checkInterval: number | string;
		check_interval: number | string;
	}>;

	const body = (await c.req.json()) as UpdateConfigBody;
	const autoInstallRaw = body.autoInstall ?? body.auto_install;
	const checkIntervalRaw = body.checkInterval ?? body.check_interval;

	let autoInstall: boolean | undefined;
	let checkInterval: number | undefined;

	if (autoInstallRaw !== undefined) {
		const parsed = parseBooleanFlag(autoInstallRaw);
		if (parsed === null) {
			return c.json(
				{ success: false, error: "autoInstall must be true or false" },
				400,
			);
		}
		autoInstall = parsed;
	}

	if (checkIntervalRaw !== undefined) {
		const parsed = parseUpdateInterval(checkIntervalRaw);
		if (parsed === null) {
			return c.json(
				{
					success: false,
					error: `checkInterval must be between ${MIN_UPDATE_INTERVAL_SECONDS} and ${MAX_UPDATE_INTERVAL_SECONDS} seconds`,
				},
				400,
			);
		}
		checkInterval = parsed;
	}

	const changed = autoInstall !== undefined || checkInterval !== undefined;
	let persisted = true;

	if (changed) {
		const result = setUpdateConfig({ autoInstall, checkInterval });
		persisted = result.persisted;
	}

	const us = getUpdateState();
	return c.json({
		success: true,
		config: us.config,
		persisted,
		pendingRestartVersion: us.pendingRestartVersion,
		lastAutoUpdateAt: us.lastAutoUpdateAt?.toISOString(),
		lastAutoUpdateError: us.lastAutoUpdateError,
	});
});

// API: Run update
app.post("/api/update/run", async (c) => {
	const check = await checkForUpdatesImpl();

	if (check.restartRequired && !check.updateAvailable) {
		return c.json({
			success: true,
			message: `Update ${check.pendingVersion || check.latestVersion || "already"} installed. Restart daemon to apply.`,
			installedVersion: check.pendingVersion || check.latestVersion,
			restartRequired: true,
		});
	}

	if (!check.updateAvailable && check.latestVersion) {
		return c.json({
			success: true,
			message: "Already running the latest version.",
			installedVersion: check.latestVersion,
			restartRequired: false,
		});
	}

	const result = await runUpdateImpl(check.latestVersion ?? undefined);
	return c.json(result);
});

// ============================================================================
// Scheduled Tasks API
// ============================================================================

// List all tasks (joined with last run status)
app.get("/api/tasks", (c) => {
	const tasks = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT t.*,
				        r.status AS last_run_status,
				        r.exit_code AS last_run_exit_code
				 FROM scheduled_tasks t
				 LEFT JOIN task_runs r ON r.id = (
				     SELECT id FROM task_runs
				     WHERE task_id = t.id
				     ORDER BY started_at DESC LIMIT 1
				 )
				 ORDER BY t.created_at DESC`,
			)
			.all(),
	);

	return c.json({ tasks, presets: CRON_PRESETS });
});

// Create a new task
app.post("/api/tasks", async (c) => {
	const body = await c.req.json();
	const { name, prompt, cronExpression, harness, workingDirectory } = body;

	if (!name || !prompt || !cronExpression || !harness) {
		return c.json({ error: "name, prompt, cronExpression, and harness are required" }, 400);
	}

	if (!validateCron(cronExpression)) {
		return c.json({ error: "Invalid cron expression" }, 400);
	}

	if (harness !== "claude-code" && harness !== "opencode") {
		return c.json({ error: "harness must be 'claude-code' or 'opencode'" }, 400);
	}

	if (!isHarnessAvailable(harness)) {
		return c.json({
			error: `CLI for ${harness} not found on PATH`,
			warning: true,
		}, 400);
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const nextRunAt = computeNextRun(cronExpression);

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, working_directory,
			  enabled, next_run_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
		).run(id, name, prompt, cronExpression, harness, workingDirectory || null, nextRunAt, now, now);
	});

	logger.info("scheduler", `Task created: ${name}`, { taskId: id });
	return c.json({ id, nextRunAt }, 201);
});

// Get a single task + recent runs
app.get("/api/tasks/:id", (c) => {
	const taskId = c.req.param("id");

	const task = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId),
	);

	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}

	const runs = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT * FROM task_runs
				 WHERE task_id = ?
				 ORDER BY started_at DESC
				 LIMIT 20`,
			)
			.all(taskId),
	);

	return c.json({ task, runs });
});

// Update a task
app.patch("/api/tasks/:id", async (c) => {
	const taskId = c.req.param("id");
	const body = await c.req.json();

	const existing = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId),
	) as Record<string, unknown> | undefined;

	if (!existing) {
		return c.json({ error: "Task not found" }, 404);
	}

	if (body.cronExpression !== undefined && !validateCron(body.cronExpression)) {
		return c.json({ error: "Invalid cron expression" }, 400);
	}

	const now = new Date().toISOString();
	const cronExpr = body.cronExpression ?? existing.cron_expression;
	const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
	const nextRunAt = body.cronExpression !== undefined || body.enabled !== undefined
		? (enabled ? computeNextRun(cronExpr as string) : existing.next_run_at)
		: existing.next_run_at;

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`UPDATE scheduled_tasks SET
			 name = ?, prompt = ?, cron_expression = ?, harness = ?,
			 working_directory = ?, enabled = ?, next_run_at = ?, updated_at = ?
			 WHERE id = ?`,
		).run(
			body.name ?? existing.name,
			body.prompt ?? existing.prompt,
			cronExpr,
			body.harness ?? existing.harness,
			body.workingDirectory !== undefined ? body.workingDirectory : existing.working_directory,
			enabled,
			nextRunAt,
			now,
			taskId,
		);
	});

	return c.json({ success: true });
});

// Delete a task (cascade deletes runs)
app.delete("/api/tasks/:id", (c) => {
	const taskId = c.req.param("id");

	const result = getDbAccessor().withWriteTx((db) => {
		const info = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(taskId);
		return info;
	});

	return c.json({ success: true });
});

// Trigger an immediate manual run
app.post("/api/tasks/:id/run", async (c) => {
	const taskId = c.req.param("id");

	const task = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId),
	) as Record<string, unknown> | undefined;

	if (!task) {
		return c.json({ error: "Task not found" }, 404);
	}

	// Check if already running
	const running = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				"SELECT 1 FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1",
			)
			.get(taskId),
	);

	if (running) {
		return c.json({ error: "Task is already running" }, 409);
	}

	const runId = crypto.randomUUID();
	const now = new Date().toISOString();

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO task_runs (id, task_id, status, started_at)
			 VALUES (?, ?, 'running', ?)`,
		).run(runId, taskId, now);

		db.prepare(
			"UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?",
		).run(now, now, taskId);
	});

	// Spawn in background (don't await)
	import("./scheduler/spawn").then((mod) => {
		mod.spawnTask(
			task.harness as "claude-code" | "opencode",
			task.prompt as string,
			task.working_directory as string | null,
		).then((result) => {
			const completedAt = new Date().toISOString();
			const status =
				result.error !== null || (result.exitCode !== null && result.exitCode !== 0)
					? "failed"
					: "completed";

			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`UPDATE task_runs
					 SET status = ?, completed_at = ?, exit_code = ?,
					     stdout = ?, stderr = ?, error = ?
					 WHERE id = ?`,
				).run(status, completedAt, result.exitCode, result.stdout, result.stderr, result.error, runId);
			});
		});
	});

	return c.json({ runId, status: "running" }, 202);
});

// Get paginated run history for a task
app.get("/api/tasks/:id/runs", (c) => {
	const taskId = c.req.param("id");
	const limit = Number(c.req.query("limit") ?? 20);
	const offset = Number(c.req.query("offset") ?? 0);

	const runs = getDbAccessor().withReadDb((db) =>
		db
			.prepare(
				`SELECT * FROM task_runs
				 WHERE task_id = ?
				 ORDER BY started_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(taskId, limit, offset),
	);

	const total = getDbAccessor().withReadDb((db) => {
		const row = db
			.prepare("SELECT COUNT(*) as count FROM task_runs WHERE task_id = ?")
			.get(taskId) as { count: number };
		return row.count;
	});

	return c.json({ runs, total, hasMore: offset + limit < total });
});

// ============================================================================
// Daemon Info
// ============================================================================

app.get("/api/status", (c) => {
	const config = loadMemoryConfig(AGENTS_DIR);

	let health: { score: number; status: string } | undefined;
	try {
		const report = getDbAccessor().withReadDb((db) =>
			getDiagnostics(db, providerTracker, getUpdateState()),
		);
		health = report.composite;
	} catch {
		// DB not ready yet — omit health
	}

	const us = getUpdateState();
	return c.json({
		status: "running",
		version: CURRENT_VERSION,
		pid: process.pid,
		uptime: process.uptime(),
		startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
		port: PORT,
		host: HOST,
		agentsDir: AGENTS_DIR,
		memoryDb: existsSync(MEMORY_DB),
		pipelineV2: config.pipelineV2,
		...(health ? { health } : {}),
		update: {
			currentVersion: us.currentVersion,
			latestVersion: us.lastCheck?.latestVersion ?? null,
			updateAvailable: us.lastCheck?.updateAvailable ?? false,
			pendingRestart: us.pendingRestartVersion,
			autoInstall: us.config.autoInstall,
			checkInterval: us.config.checkInterval,
			lastCheckAt: us.lastCheckTime?.toISOString() ?? null,
			lastError: us.lastAutoUpdateError,
			timerActive: us.timerActive,
		},
		embedding: {
			provider: config.embedding.provider,
			model: config.embedding.model,
			// Don't block on status check for /api/status - use cached if available
			...(cachedEmbeddingStatus &&
			Date.now() - statusCacheTime < STATUS_CACHE_TTL
				? { available: cachedEmbeddingStatus.available }
				: {}),
		},
	});
});

// ============================================================================
// Diagnostics & Repair (Phase F)
// ============================================================================

app.get("/api/diagnostics", (c) => {
	const report = getDbAccessor().withReadDb((db) =>
		getDiagnostics(db, providerTracker, getUpdateState()),
	);
	return c.json(report);
});

app.get("/api/diagnostics/:domain", (c) => {
	const domain = c.req.param("domain");
	const report = getDbAccessor().withReadDb((db) =>
		getDiagnostics(db, providerTracker, getUpdateState()),
	);

	const domainData = report[domain as keyof typeof report];
	if (!domainData || typeof domainData === "string") {
		return c.json({ error: `Unknown domain: ${domain}` }, 400);
	}
	return c.json(domainData);
});

function resolveRepairContext(c: Context): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "manual repair";
	const actor = c.req.header("x-signet-actor") ?? "operator";
	const actorType = (c.req.header("x-signet-actor-type") ?? "operator") as
		| "operator"
		| "agent"
		| "daemon";
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

app.post("/api/repair/requeue-dead", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = requeueDeadJobs(
		getDbAccessor(),
		cfg.pipelineV2,
		ctx,
		repairLimiter,
	);
	return c.json(result, result.success ? 200 : 429);
});

app.post("/api/repair/release-leases", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = releaseStaleLeases(
		getDbAccessor(),
		cfg.pipelineV2,
		ctx,
		repairLimiter,
	);
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
	const result = checkFtsConsistency(
		getDbAccessor(),
		cfg.pipelineV2,
		ctx,
		repairLimiter,
		repair,
	);
	return c.json(result, result.success ? 200 : 429);
});

app.post("/api/repair/retention-sweep", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	// The retention handle is internal to pipeline — import not needed,
	// we can call the repair action with a minimal sweep handle via
	// the retention worker's public API. For now, return 501 if the
	// retention worker isn't running (pipeline not started).
	return c.json({
		action: "triggerRetentionSweep",
		success: false,
		affected: 0,
		message: "Use the maintenance worker for automated sweeps; manual sweep via this endpoint is not yet wired",
	}, 501);
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

	try {
		const body = await c.req.json();
		if (typeof body.batchSize === "number") batchSize = body.batchSize;
		if (typeof body.dryRun === "boolean") dryRun = body.dryRun;
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
	);

	return c.json(result, result.success ? 200 : 429);
});

app.post("/api/repair/clean-orphans", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	const result = cleanOrphanedEmbeddings(
		getDbAccessor(),
		cfg.pipelineV2,
		ctx,
		repairLimiter,
	);
	return c.json(result, result.success ? 200 : 429);
});

app.get("/api/repair/dedup-stats", (c) => {
	const stats = getDedupStats(getDbAccessor());
	return c.json(stats);
});

app.post("/api/repair/deduplicate", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const ctx = resolveRepairContext(c);
	let options: {
		batchSize?: number;
		dryRun?: boolean;
		semanticThreshold?: number;
		semanticEnabled?: boolean;
	} = {};
	try {
		const body = await c.req.json();
		if (typeof body?.batchSize === "number") options.batchSize = body.batchSize;
		if (typeof body?.dryRun === "boolean") options.dryRun = body.dryRun;
		if (typeof body?.semanticThreshold === "number")
			options.semanticThreshold = body.semanticThreshold;
		if (typeof body?.semanticEnabled === "boolean")
			options.semanticEnabled = body.semanticEnabled;
	} catch {
		// no body or invalid JSON — use defaults
	}
	const result = await deduplicateMemories(
		getDbAccessor(),
		cfg.pipelineV2,
		ctx,
		repairLimiter,
		options,
	);
	return c.json(result, result.success ? 200 : 429);
});

// ============================================================================
// Analytics & Timeline (Phase K)
// ============================================================================

app.get("/api/analytics/usage", (c) => {
	return c.json(analyticsCollector.getUsage());
});

app.get("/api/analytics/errors", (c) => {
	const stage = c.req.query("stage") as ErrorStage | undefined;
	const since = c.req.query("since") ?? undefined;
	const limit = c.req.query("limit")
		? parseInt(c.req.query("limit")!, 10)
		: undefined;
	return c.json({
		errors: analyticsCollector.getErrors({ stage, since, limit }),
		summary: analyticsCollector.getErrorSummary(),
	});
});

app.get("/api/analytics/latency", (c) => {
	return c.json(analyticsCollector.getLatency());
});

app.get("/api/analytics/logs", (c) => {
	const limit = parseInt(c.req.query("limit") || "100", 10);
	const level = c.req.query("level") as
		| "debug" | "info" | "warn" | "error" | undefined;
	const category = c.req.query("category") as any;
	const since = c.req.query("since")
		? new Date(c.req.query("since")!)
		: undefined;
	const logs = logger.getRecent({ limit, level, category, since });
	return c.json({ logs, count: logs.length });
});

app.get("/api/analytics/memory-safety", (c) => {
	const mutationHealth = getDbAccessor().withReadDb((db) =>
		getDiagnostics(db, providerTracker, getUpdateState()),
	);
	const recentMutationErrors = analyticsCollector.getErrors({
		stage: "mutation",
		limit: 50,
	});
	return c.json({
		mutation: mutationHealth.mutation,
		recentErrors: recentMutationErrors,
		errorSummary: analyticsCollector.getErrorSummary(),
	});
});

app.get("/api/analytics/continuity", (c) => {
	const project = c.req.query("project");
	const limit = parseInt(c.req.query("limit") ?? "50", 10);

	const scores = getDbAccessor().withReadDb((db) => {
		if (project) {
			return db
				.prepare(
					`SELECT id, session_key, project, harness, score,
					        memories_recalled, memories_used, novel_context_count,
					        reasoning, created_at
					 FROM session_scores
					 WHERE project = ?
					 ORDER BY created_at DESC
					 LIMIT ?`,
				)
				.all(project, limit) as Array<Record<string, unknown>>;
		}
		return db
			.prepare(
				`SELECT id, session_key, project, harness, score,
				        memories_recalled, memories_used, novel_context_count,
				        reasoning, created_at
				 FROM session_scores
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(limit) as Array<Record<string, unknown>>;
	});

	// Compute trend
	const scoreValues = scores.map((s) => s.score as number).reverse();
	const trend =
		scoreValues.length >= 2
			? scoreValues[scoreValues.length - 1] - scoreValues[0]
			: 0;
	const avg =
		scoreValues.length > 0
			? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
			: 0;

	return c.json({
		scores,
		summary: {
			count: scores.length,
			average: Math.round(avg * 100) / 100,
			trend: Math.round(trend * 100) / 100,
			latest: scores[0]?.score ?? null,
		},
	});
});

app.get("/api/analytics/continuity/latest", (c) => {
	const scores = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT project, score, created_at
					 FROM session_scores
					 WHERE id IN (
					   SELECT id FROM session_scores s2
					   WHERE s2.project = session_scores.project
					   ORDER BY s2.created_at DESC
					   LIMIT 1
					 )
					 ORDER BY created_at DESC`,
				)
				.all() as Array<{
				project: string | null;
				score: number;
				created_at: string;
			}>,
	);

	return c.json({ scores });
});

app.get("/api/timeline/:id", (c) => {
	const entityId = c.req.param("id");
	const timeline = getDbAccessor().withReadDb((db) =>
		buildTimeline(
			{
				db,
				getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
				getRecentErrors: (opts) =>
					analyticsCollector.getErrors({ limit: opts?.limit }),
			},
			entityId,
		),
	);
	return c.json(timeline);
});

app.get("/api/timeline/:id/export", (c) => {
	const entityId = c.req.param("id");
	const timeline = getDbAccessor().withReadDb((db) => {
		const sources: TimelineSources = {
			db,
			getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
			getRecentErrors: (opts) =>
				analyticsCollector.getErrors({ limit: opts?.limit }),
		};
		return buildTimeline(sources, entityId);
	});
	return c.json({
		meta: {
			version: CURRENT_VERSION,
			exportedAt: new Date().toISOString(),
			entityId,
		},
		timeline,
	});
});

// ============================================================================
// Static Dashboard
// ============================================================================

const dashboardPath = getDashboardPath();

function setupStaticServing() {
	if (dashboardPath) {
		logger.info("daemon", "Serving dashboard", { path: dashboardPath });

		// Skip static serving for API routes (let them 404 properly if not matched)
		app.use("/*", async (c, next) => {
			const path = c.req.path;
			if (path.startsWith("/api/") || path === "/health" || path === "/sse") {
				return next();
			}
			return serveStatic({
				root: dashboardPath,
				rewriteRequestPath: (p) => {
					// SPA fallback: if no extension, serve index.html
					if (!p.includes(".") || p === "/") {
						return "/index.html";
					}
					return p;
				},
			})(c, next);
		});
	} else {
		logger.warn("daemon", "Dashboard not found - API-only mode");
		app.get("/", (c) => {
			return c.html(`
        <!DOCTYPE html>
        <html>
        <head><title>Signet Daemon</title></head>
        <body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>◈ Signet Daemon</h1>
          <p>The daemon is running, but the dashboard is not installed.</p>
          <p>API endpoints:</p>
          <ul>
            <li><a href="/health">/health</a> - Health check</li>
            <li><a href="/api/status">/api/status</a> - Daemon status</li>
            <li><a href="/api/config">/api/config</a> - Config files</li>
            <li><a href="/api/memories">/api/memories</a> - Memories</li>
            <li><a href="/api/harnesses">/api/harnesses</a> - Harnesses</li>
            <li><a href="/api/skills">/api/skills</a> - Skills</li>
          </ul>
        </body>
        </html>
      `);
		});
	}
}

setupStaticServing();

// ============================================================================
// File Watcher
// ============================================================================

let watcher: ReturnType<typeof watch> | null = null;

// ============================================================================
// Git Sync System
// ============================================================================

interface GitConfig {
	enabled: boolean;
	autoCommit: boolean;
	autoSync: boolean;
	syncInterval: number; // seconds
	remote: string;
	branch: string;
}

function loadGitConfig(): GitConfig {
	const defaults: GitConfig = {
		enabled: true,
		autoCommit: true,
		autoSync: true, // enabled by default - credentials auto-detected from gh, ssh, or credential helper
		syncInterval: 300, // 5 minutes
		remote: "origin",
		branch: "main",
	};

	const paths = [
		join(AGENTS_DIR, "agent.yaml"),
		join(AGENTS_DIR, "AGENT.yaml"),
	];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
			const git = yaml.git as Record<string, any> | undefined;
			if (git) {
				if (git.enabled !== undefined)
					defaults.enabled = git.enabled === "true" || git.enabled === true;
				if (git.autoCommit !== undefined)
					defaults.autoCommit =
						git.autoCommit === "true" || git.autoCommit === true;
				if (git.autoSync !== undefined)
					defaults.autoSync = git.autoSync === "true" || git.autoSync === true;
				if (git.syncInterval !== undefined)
					defaults.syncInterval = parseInt(git.syncInterval, 10);
				if (git.remote) defaults.remote = git.remote;
				if (git.branch) defaults.branch = git.branch;
			}
			break;
		} catch {
			// ignore parse errors
		}
	}

	return defaults;
}

let gitConfig = loadGitConfig();
let gitSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastGitSync: Date | null = null;
let gitSyncInProgress = false;

function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

// Git credential resolution result
interface GitCredentials {
	method: "token" | "gh" | "credential-helper" | "ssh" | "none";
	authUrl?: string; // For HTTPS with embedded auth
	usePlainGit?: boolean; // For SSH - just run git without URL modification
}

// Run a command and return stdout/stderr
async function runCommand(
	cmd: string,
	args: string[],
	options?: { input?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { stdio: "pipe" });
		let stdout = "";
		let stderr = "";

		if (options?.input) {
			proc.stdin?.write(options.input);
			proc.stdin?.end();
		}

		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? 1 });
		});
		proc.on("error", () => {
			resolve({ stdout: "", stderr: "", code: 1 });
		});
	});
}

// Get remote URL for a given remote
async function getRemoteUrl(
	dir: string,
	remote: string,
): Promise<string | null> {
	const result = await runCommand("git", ["remote", "get-url", remote]);
	return result.code === 0 ? result.stdout.trim() : null;
}

// Build authenticated URL from token
function buildAuthUrlFromToken(baseUrl: string, token: string): string {
	// Convert SSH to HTTPS if needed
	let url = baseUrl;
	if (url.startsWith("git@github.com:")) {
		url = url.replace("git@github.com:", "https://github.com/");
	}

	// Embed token in HTTPS URL
	if (url.startsWith("https://github.com/")) {
		return url.replace("https://github.com/", `https://${token}@github.com/`);
	} else if (url.startsWith("https://") && url.includes("github.com")) {
		return url.replace(
			/https:\/\/([^@]+@)?github\.com/,
			`https://${token}@github.com`,
		);
	}
	return url;
}

// Build authenticated URL from username/password
function buildAuthUrlFromCreds(
	baseUrl: string,
	creds: { username: string; password: string },
): string {
	let url = baseUrl;
	if (url.startsWith("git@github.com:")) {
		url = url.replace("git@github.com:", "https://github.com/");
	}
	// Remove existing auth if any
	url = url.replace(/https:\/\/[^@]+@/, "https://");
	return url.replace(
		"https://",
		`https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@`,
	);
}

// Get credentials from git credential helper
async function getCredentialHelperToken(
	url: string,
): Promise<{ username: string; password: string } | null> {
	try {
		// Parse URL to get host
		const urlObj = new URL(url);
		const input = `protocol=${urlObj.protocol.replace(":", "")}\nhost=${urlObj.host}\n\n`;
		const result = await runCommand("git", ["credential", "fill"], { input });

		if (result.code !== 0) return null;

		// Parse output: "protocol=https\nhost=github.com\nusername=...\npassword=..."
		const lines = result.stdout.split("\n");
		const username = lines.find((l) => l.startsWith("username="))?.slice(9);
		const password = lines.find((l) => l.startsWith("password="))?.slice(9);

		return username && password ? { username, password } : null;
	} catch {
		return null;
	}
}

// Get token from gh CLI
async function getGhCliToken(): Promise<string | null> {
	try {
		const result = await runCommand("gh", ["auth", "token"]);
		return result.code === 0 ? result.stdout.trim() : null;
	} catch {
		return null;
	}
}

// Check if any git credentials are available (for status checks)
async function hasAnyGitCredentials(): Promise<boolean> {
	// Check stored token
	if (await hasSecret("GITHUB_TOKEN")) return true;

	// Check gh CLI
	if (await getGhCliToken()) return true;

	// Check if remote uses SSH
	if (isGitRepo(AGENTS_DIR)) {
		const remoteUrl = await getRemoteUrl(AGENTS_DIR, gitConfig.remote);
		if (remoteUrl?.startsWith("git@")) return true;

		// Check credential helper for HTTPS
		if (remoteUrl?.startsWith("https://")) {
			const creds = await getCredentialHelperToken(remoteUrl);
			if (creds) return true;
		}
	}

	return false;
}

// Resolve git credentials using multiple methods
async function resolveGitCredentials(
	dir: string,
	remote: string,
): Promise<GitCredentials> {
	const remoteUrl = await getRemoteUrl(dir, remote);
	if (!remoteUrl) {
		return { method: "none" };
	}

	// 1. Try stored GITHUB_TOKEN first (highest priority)
	try {
		const token = await getSecret("GITHUB_TOKEN");
		if (token) {
			logger.debug("git", "Using stored GITHUB_TOKEN for authentication");
			return {
				method: "token",
				authUrl: buildAuthUrlFromToken(remoteUrl, token),
			};
		}
	} catch {
		/* ignore */
	}

	// 2. Try gh CLI auth token
	try {
		const ghToken = await getGhCliToken();
		if (ghToken) {
			logger.debug("git", "Using gh CLI token for authentication");
			return {
				method: "gh",
				authUrl: buildAuthUrlFromToken(remoteUrl, ghToken),
			};
		}
	} catch {
		/* ignore */
	}

	// 3. Check for SSH remote (works without modification)
	if (remoteUrl.startsWith("git@")) {
		logger.debug("git", "Using SSH for authentication");
		return { method: "ssh", usePlainGit: true };
	}

	// 4. Try credential helper for HTTPS
	if (remoteUrl.startsWith("https://")) {
		try {
			const creds = await getCredentialHelperToken(remoteUrl);
			if (creds) {
				logger.debug("git", "Using git credential helper for authentication");
				return {
					method: "credential-helper",
					authUrl: buildAuthUrlFromCreds(remoteUrl, creds),
				};
			}
		} catch {
			/* ignore */
		}
	}

	return { method: "none" };
}

// Run a git command with optional authenticated remote
function runGitCommand(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: "pipe" });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		proc.on("error", (e) => {
			resolve({ code: 1, stdout: "", stderr: e.message });
		});
	});
}

// Pull changes from remote
async function gitPull(): Promise<{
	success: boolean;
	message: string;
	changes?: number;
}> {
	if (!isGitRepo(AGENTS_DIR)) {
		return { success: false, message: "Not a git repository" };
	}

	const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);

	let fetchResult: { code: number; stdout: string; stderr: string };

	if (creds.usePlainGit) {
		// SSH: use plain git pull
		fetchResult = await runGitCommand(
			["fetch", gitConfig.remote, gitConfig.branch],
			AGENTS_DIR,
		);
	} else if (creds.authUrl) {
		// HTTPS with auth: use authenticated URL
		fetchResult = await runGitCommand(
			["fetch", creds.authUrl, gitConfig.branch],
			AGENTS_DIR,
		);
	} else {
		return {
			success: false,
			message:
				"No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
		};
	}

	if (fetchResult.code !== 0) {
		logger.warn("git", `Fetch failed: ${fetchResult.stderr}`);
		return { success: false, message: `Fetch failed: ${fetchResult.stderr}` };
	}

	// Check for incoming changes
	const diffResult = await runGitCommand(
		["rev-list", "--count", `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
		AGENTS_DIR,
	);

	const incomingChanges = parseInt(diffResult.stdout.trim(), 10) || 0;

	if (incomingChanges === 0) {
		return { success: true, message: "Already up to date", changes: 0 };
	}

	// Stash local changes if any
	const statusResult = await runGitCommand(
		["status", "--porcelain"],
		AGENTS_DIR,
	);
	const hasLocalChanges = statusResult.stdout.trim().length > 0;

	if (hasLocalChanges) {
		await runGitCommand(
			["stash", "push", "-m", "signet-auto-stash"],
			AGENTS_DIR,
		);
	}

	// Pull (merge)
	const pullResult = await runGitCommand(
		["merge", `${gitConfig.remote}/${gitConfig.branch}`, "--ff-only"],
		AGENTS_DIR,
	);

	// Restore stashed changes if any
	if (hasLocalChanges) {
		await runGitCommand(["stash", "pop"], AGENTS_DIR);
	}

	if (pullResult.code !== 0) {
		logger.warn("git", `Pull failed: ${pullResult.stderr}`);
		return { success: false, message: `Pull failed: ${pullResult.stderr}` };
	}

	logger.git.sync("pull", incomingChanges);
	return {
		success: true,
		message: `Pulled ${incomingChanges} commits`,
		changes: incomingChanges,
	};
}

// Push changes to remote
async function gitPush(): Promise<{
	success: boolean;
	message: string;
	changes?: number;
}> {
	if (!isGitRepo(AGENTS_DIR)) {
		return { success: false, message: "Not a git repository" };
	}

	const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);

	// Check for outgoing changes
	const diffResult = await runGitCommand(
		["rev-list", "--count", `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
		AGENTS_DIR,
	);

	const outgoingChanges = parseInt(diffResult.stdout.trim(), 10) || 0;

	if (outgoingChanges === 0) {
		return { success: true, message: "Nothing to push", changes: 0 };
	}

	let pushResult: { code: number; stdout: string; stderr: string };

	if (creds.usePlainGit) {
		// SSH: use plain git push
		pushResult = await runGitCommand(
			["push", gitConfig.remote, `HEAD:${gitConfig.branch}`],
			AGENTS_DIR,
		);
	} else if (creds.authUrl) {
		// HTTPS with auth: use authenticated URL
		pushResult = await runGitCommand(
			["push", creds.authUrl, `HEAD:${gitConfig.branch}`],
			AGENTS_DIR,
		);
	} else {
		return {
			success: false,
			message:
				"No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
		};
	}

	if (pushResult.code !== 0) {
		logger.warn("git", `Push failed: ${pushResult.stderr}`);
		return { success: false, message: `Push failed: ${pushResult.stderr}` };
	}

	logger.git.sync("push", outgoingChanges);
	return {
		success: true,
		message: `Pushed ${outgoingChanges} commits`,
		changes: outgoingChanges,
	};
}

// Full sync: pull then push
async function gitSync(): Promise<{
	success: boolean;
	message: string;
	pulled?: number;
	pushed?: number;
}> {
	if (gitSyncInProgress) {
		return { success: false, message: "Sync already in progress" };
	}

	gitSyncInProgress = true;

	try {
		// Pull first
		const pullResult = await gitPull();
		if (!pullResult.success) {
			return { success: false, message: pullResult.message };
		}

		// Then push
		const pushResult = await gitPush();
		if (!pushResult.success) {
			return {
				success: false,
				message: pushResult.message,
				pulled: pullResult.changes,
			};
		}

		lastGitSync = new Date();
		return {
			success: true,
			message: "Sync complete",
			pulled: pullResult.changes,
			pushed: pushResult.changes,
		};
	} finally {
		gitSyncInProgress = false;
	}
}

// Start periodic git sync
function startGitSyncTimer() {
	if (gitSyncTimer) {
		clearInterval(gitSyncTimer);
	}

	if (!gitConfig.autoSync || gitConfig.syncInterval <= 0) {
		logger.debug("git", "Auto-sync disabled");
		return;
	}

	const intervalMs = gitConfig.syncInterval * 1000;
	logger.info("git", `Auto-sync enabled: every ${gitConfig.syncInterval}s`);

	gitSyncTimer = setInterval(async () => {
		// Check if any credentials are available (gh, ssh, credential helper, or stored token)
		const hasCreds = await hasAnyGitCredentials();
		if (!hasCreds) {
			// Silently skip if no credentials configured
			return;
		}

		logger.debug("git", "Running periodic sync...");
		const result = await gitSync();
		if (!result.success) {
			logger.warn("git", `Periodic sync failed: ${result.message}`);
		}
	}, intervalMs);
}

function stopGitSyncTimer() {
	if (gitSyncTimer) {
		clearInterval(gitSyncTimer);
		gitSyncTimer = null;
	}
}

// Get git status info
async function getGitStatus(): Promise<{
	isRepo: boolean;
	branch?: string;
	remote?: string;
	hasCredentials: boolean;
	authMethod?: string;
	autoSync: boolean;
	lastSync?: string;
	uncommittedChanges?: number;
	unpushedCommits?: number;
	unpulledCommits?: number;
}> {
	const status: any = {
		isRepo: isGitRepo(AGENTS_DIR),
		hasCredentials: false,
		autoSync: gitConfig.autoSync,
	};

	if (!status.isRepo) return status;

	// Check credentials and auth method
	const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);
	status.hasCredentials = creds.method !== "none";
	status.authMethod = creds.method;

	// Get current branch
	const branchResult = await runGitCommand(
		["rev-parse", "--abbrev-ref", "HEAD"],
		AGENTS_DIR,
	);
	if (branchResult.code === 0) {
		status.branch = branchResult.stdout.trim();
	}

	// Get remote
	status.remote = gitConfig.remote;

	// Last sync time
	if (lastGitSync) {
		status.lastSync = lastGitSync.toISOString();
	}

	// Uncommitted changes
	const statusResult = await runGitCommand(
		["status", "--porcelain"],
		AGENTS_DIR,
	);
	if (statusResult.code === 0) {
		status.uncommittedChanges = statusResult.stdout
			.trim()
			.split("\n")
			.filter((l) => l.trim()).length;
	}

	// Unpushed commits (only if we have credentials)
	if (status.hasCredentials) {
		const unpushedResult = await runGitCommand(
			["rev-list", "--count", `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
			AGENTS_DIR,
		);
		if (unpushedResult.code === 0) {
			status.unpushedCommits = parseInt(unpushedResult.stdout.trim(), 10) || 0;
		}
	}

	return status;
}

let commitPending = false;
let commitTimer: ReturnType<typeof setTimeout> | null = null;
const COMMIT_DEBOUNCE_MS = 5000; // Wait 5 seconds after last change before committing

async function gitAutoCommit(
	dir: string,
	changedFiles: string[],
): Promise<void> {
	if (!isGitRepo(dir)) return;

	const fileList = changedFiles.map((f) => f.replace(dir + "/", "")).join(", ");
	const now = new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const message = `${timestamp}_auto_${fileList.slice(0, 50)}`;

	return new Promise((resolve) => {
		// git add -A
		const add = spawn("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
		add.on("close", (addCode) => {
			if (addCode !== 0) {
				logger.warn("git", "Git add failed");
				resolve();
				return;
			}
			// Check for changes
			const status = spawn("git", ["status", "--porcelain"], {
				cwd: dir,
				stdio: "pipe",
			});
			let statusOutput = "";
			status.stdout?.on("data", (d) => {
				statusOutput += d.toString();
			});
			status.on("close", (statusCode) => {
				if (statusCode !== 0 || !statusOutput.trim()) {
					resolve();
					return;
				}
				// Commit
				const commit = spawn("git", ["commit", "-m", message], {
					cwd: dir,
					stdio: "pipe",
				});
				commit.on("close", (commitCode) => {
					if (commitCode === 0) {
						logger.git.commit(message, changedFiles.length);
					}
					resolve();
				});
				commit.on("error", () => resolve());
			});
			status.on("error", () => resolve());
		});
		add.on("error", () => resolve());
	});
}

let pendingChanges: string[] = [];

function scheduleAutoCommit(changedPath: string) {
	pendingChanges.push(changedPath);

	if (commitTimer) {
		clearTimeout(commitTimer);
	}

	commitTimer = setTimeout(async () => {
		if (commitPending) return;
		commitPending = true;

		const changes = [...pendingChanges];
		pendingChanges = [];

		await gitAutoCommit(AGENTS_DIR, changes);
		commitPending = false;
	}, COMMIT_DEBOUNCE_MS);
}

// Auto-sync AGENTS.md to harness configs
async function syncHarnessConfigs() {
	const agentsMdPath = join(AGENTS_DIR, "AGENTS.md");
	if (!existsSync(agentsMdPath)) return;

	const rawContent = readFileSync(agentsMdPath, "utf-8");
	const content = stripSignetBlock(rawContent);
	const withBlock = buildSignetBlock() + content;

	// Build header with cross-references to other documents
	const buildHeader = (targetName: string) => {
		const files = [
			{ name: "SOUL.md", desc: "Personality & tone" },
			{ name: "IDENTITY.md", desc: "Agent identity" },
			{ name: "USER.md", desc: "User profile & preferences" },
			{ name: "MEMORY.md", desc: "Working memory context" },
			{ name: "agent.yaml", desc: "Configuration & settings" },
		];

		const existingFiles = files.filter((f) =>
			existsSync(join(AGENTS_DIR, f.name)),
		);
		const fileList = existingFiles
			.map((f) => `#   - ~/.agents/${f.name} (${f.desc})`)
			.join("\n");

		return `# ${targetName}
# ============================================================================
# AUTO-GENERATED from ~/.agents/AGENTS.md by Signet
# Generated: ${new Date().toISOString()}
# 
# DO NOT EDIT THIS FILE - changes will be overwritten
# Edit the source file instead: ~/.agents/AGENTS.md
#
# Signet Agent Home: ~/.agents/
# Dashboard: http://localhost:3850
# CLI: signet --help
#
# Related documents:
${fileList}
#
# Memory commands: /remember <content> | /recall <query>
# ============================================================================

`;
	};

	// Read and compose additional identity files
	const identityExtras = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]
		.map((name) => {
			const p = join(AGENTS_DIR, name);
			if (!existsSync(p)) return "";
			try {
				const c = readFileSync(p, "utf-8").trim();
				if (!c) return "";
				const header = name.replace(".md", "");
				return `\n## ${header}\n\n${c}`;
			} catch {
				return "";
			}
		})
		.filter(Boolean)
		.join("\n");

	const composed = withBlock + identityExtras;

	// Sync to Claude Code (~/.claude/CLAUDE.md)
	const claudeDir = join(homedir(), ".claude");
	if (existsSync(claudeDir)) {
		try {
			writeFileSync(
				join(claudeDir, "CLAUDE.md"),
				buildHeader("CLAUDE.md") + composed,
			);
			logger.sync.harness("claude-code", "~/.claude/CLAUDE.md");
		} catch (e) {
			logger.sync.failed("claude-code", e as Error);
		}
	}

	// Sync to OpenCode (~/.config/opencode/AGENTS.md)
	const opencodeDir = join(homedir(), ".config", "opencode");
	if (existsSync(opencodeDir)) {
		try {
			writeFileSync(
				join(opencodeDir, "AGENTS.md"),
				buildHeader("AGENTS.md") + composed,
			);
			logger.sync.harness("opencode", "~/.config/opencode/AGENTS.md");
		} catch (e) {
			logger.sync.failed("opencode", e as Error);
		}
	}

	// Write SIGNET-ARCHITECTURE.md if missing or outdated
	const archPath = join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md");
	try {
		const archContent = buildArchitectureDoc();
		const existing = existsSync(archPath)
			? readFileSync(archPath, "utf-8")
			: "";
		if (existing !== archContent) {
			writeFileSync(archPath, archContent);
			logger.info("sync", "SIGNET-ARCHITECTURE.md updated");
		}
	} catch (e) {
		logger.error("sync", "Failed to write SIGNET-ARCHITECTURE.md", e as Error);
	}
}

let syncPending = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

function scheduleSyncHarnessConfigs() {
	if (syncTimer) {
		clearTimeout(syncTimer);
	}

	syncTimer = setTimeout(async () => {
		if (syncPending) return;
		syncPending = true;
		await syncHarnessConfigs();
		syncPending = false;
	}, SYNC_DEBOUNCE_MS);
}

function startFileWatcher() {
	watcher = watch(
		[
			join(AGENTS_DIR, "agent.yaml"),
			join(AGENTS_DIR, "AGENTS.md"),
			join(AGENTS_DIR, "SOUL.md"),
			join(AGENTS_DIR, "MEMORY.md"),
			join(AGENTS_DIR, "IDENTITY.md"),
			join(AGENTS_DIR, "USER.md"),
			join(AGENTS_DIR, "memory"), // Watch entire memory directory for new/changed .md files
		],
		{
			persistent: true,
			ignoreInitial: true,
		},
	);

	watcher.on("change", (path) => {
		logger.info("watcher", "File changed", { path });
		scheduleAutoCommit(path);

		// If any identity file changed, sync to harness configs
		const SYNC_TRIGGER_FILES = [
			"AGENTS.md",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"MEMORY.md",
		];
		if (SYNC_TRIGGER_FILES.some((f) => path.endsWith(f))) {
			scheduleSyncHarnessConfigs();
		}

		// Ingest memory markdown files (excluding MEMORY.md index)
		if (
			path.includes("/memory/") &&
			path.endsWith(".md") &&
			!path.endsWith("MEMORY.md")
		) {
			ingestMemoryMarkdown(path).catch((e) =>
				logger.error("watcher", "Ingestion failed", undefined, {
					path,
					error: String(e),
				}),
			);
		}
	});

	watcher.on("add", (path) => {
		logger.info("watcher", "File added", { path });
		scheduleAutoCommit(path);

		// Ingest new memory markdown files
		if (
			path.includes("/memory/") &&
			path.endsWith(".md") &&
			!path.endsWith("MEMORY.md")
		) {
			ingestMemoryMarkdown(path).catch((e) =>
				logger.error("watcher", "Ingestion failed", undefined, {
					path,
					error: String(e),
				}),
			);
		}
	});

	// Watch Claude Code project memories
	startClaudeMemoryWatcher();
}

// Track synced memories to avoid duplicates
const syncedClaudeMemories = new Set<string>();

function startClaudeMemoryWatcher() {
	const claudeProjectsDir = join(homedir(), ".claude", "projects");
	if (!existsSync(claudeProjectsDir)) return;

	// NOTE: initial sync of existing files is deferred to the server listen
	// callback so the HTTP API is available. Only the watcher starts here.

	const claudeWatcher = watch(
		join(claudeProjectsDir, "**", "memory", "MEMORY.md"),
		{ persistent: true, ignoreInitial: true },
	);

	claudeWatcher.on("change", async (filePath) => {
		logger.info("watcher", "Claude memory changed", { path: filePath });
		await syncClaudeMemoryFile(filePath);
	});

	claudeWatcher.on("add", async (filePath) => {
		logger.info("watcher", "Claude memory added", { path: filePath });
		await syncClaudeMemoryFile(filePath);
	});
}

async function syncExistingClaudeMemories(claudeProjectsDir: string) {
	try {
		const projects = readdirSync(claudeProjectsDir);
		let totalSynced = 0;

		for (const project of projects) {
			const memoryFile = join(
				claudeProjectsDir,
				project,
				"memory",
				"MEMORY.md",
			);
			if (existsSync(memoryFile)) {
				const count = await syncClaudeMemoryFile(memoryFile);
				totalSynced += count;
			}
		}

		if (totalSynced > 0) {
			logger.info("watcher", "Synced existing Claude memories", {
				count: totalSynced,
			});
		}
	} catch (e) {
		logger.error(
			"watcher",
			"Failed to sync existing Claude memories",
			undefined,
			{ error: String(e) },
		);
	}
}

async function syncClaudeMemoryFile(filePath: string): Promise<number> {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (!content.trim()) return 0;

		// Extract project path from file path
		// e.g., ~/.claude/projects/-home-user-myproject/memory/MEMORY.md
		const match = filePath.match(/projects\/([^/]+)\/memory/);
		const projectId = match ? match[1] : "unknown";

		// Compute hash for deduplication
		const contentHash = createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 16);
		const existingHash = ingestedMemoryFiles.get(filePath);
		if (existingHash === contentHash) {
			logger.debug("watcher", "Claude memory file unchanged, skipping", {
				path: filePath,
			});
			return 0;
		}
		ingestedMemoryFiles.set(filePath, contentHash);

		// Use hierarchical chunking to preserve section structure
		const chunks = chunkMarkdownHierarchically(content, 512);
		let inserted = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];

			// Extract section name from header for tagging
			const sectionMatch = chunk.header.match(/^#+\s+(.+)$/);
			const sectionName = sectionMatch ? sectionMatch[1].toLowerCase() : "";

			// Dedupe by content hash within this project
			const chunkKey = `claude:${projectId}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 16)}`;
			if (syncedClaudeMemories.has(chunkKey)) continue;
			syncedClaudeMemories.add(chunkKey);

			try {
				const response = await fetch(
					`http://${HOST}:${PORT}/api/memory/remember`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							content: chunk.text,
							who: "claude-code",
							importance: chunk.level === "section" ? 0.65 : 0.55,
							sourceType: "claude-project-memory",
							sourceId: chunkKey,
							tags: [
								"claude-code",
								"claude-project-memory",
								sectionName,
								`project:${projectId}`,
								chunk.level === "section"
									? "hierarchical-section"
									: "hierarchical-paragraph",
							]
								.filter(Boolean)
								.join(","),
						}),
					},
				);

				if (response.ok) {
					inserted++;
					logger.info("watcher", "Synced Claude memory chunk", {
						content: chunk.text.slice(0, 50),
						section: sectionName || "(no section)",
						level: chunk.level,
					});
				}
			} catch (e) {
				const errDetails =
					e instanceof Error ? { message: e.message } : { error: String(e) };
				logger.error(
					"watcher",
					"Failed to sync Claude memory chunk",
					undefined,
					{
						path: filePath,
						chunkIndex: i,
						...errDetails,
					},
				);
			}
		}

		if (inserted > 0) {
			logger.info("watcher", "Synced Claude memory file", {
				path: filePath,
				projectId,
				chunks: inserted,
				sections: chunks.filter((c) => c.level === "section").length,
			});
		}
		return inserted;
	} catch (e) {
		const errDetails =
			e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error("watcher", "Failed to read Claude memory file", undefined, {
			path: filePath,
			...errDetails,
		});
		return 0;
	}
}

// ============================================================================
// OpenClaw Memory Markdown Ingestion
// ============================================================================

// Track ingested files to avoid re-processing (path -> content hash)
const ingestedMemoryFiles = new Map<string, string>();

/**
 * Estimate token count for a given text.
 * Uses a simple heuristic: ~4 characters per token on average.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Split markdown content into hierarchical chunks that preserve section structure.
 * Each chunk includes its section header for context.
 */
function chunkMarkdownHierarchically(
	content: string,
	maxTokens: number = 512,
): {
	text: string;
	tokenCount: number;
	header: string;
	level: "section" | "paragraph";
}[] {
	const results: {
		text: string;
		tokenCount: number;
		header: string;
		level: "section" | "paragraph";
	}[] = [];
	const lines = content.split("\n");

	let currentHeader = "";
	let currentContent: string[] = [];

	// Regex for markdown headers (h1-h3)
	const headerPattern = /^(#{1,3})\s+(.+)$/;

	const flushSection = () => {
		if (currentContent.length === 0) return;

		const sectionText = currentContent.join("\n").trim();
		if (!sectionText) return;

		const sectionTokens = estimateTokens(sectionText);

		if (sectionTokens <= maxTokens) {
			// Section fits in one chunk - include header for context
			const textWithHeader = currentHeader
				? `${currentHeader}\n\n${sectionText}`
				: sectionText;
			results.push({
				text: textWithHeader,
				tokenCount: estimateTokens(textWithHeader),
				header: currentHeader,
				level: "section",
			});
		} else {
			// Split section into paragraph chunks with header context
			const paragraphs = sectionText.split(/\n\n+/);
			let chunkParas: string[] = [];
			let chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;

			for (const para of paragraphs) {
				const paraTokens = estimateTokens(para);

				// If single paragraph exceeds max, it needs to stand alone
				if (paraTokens > maxTokens) {
					// Flush current chunk first
					if (chunkParas.length > 0) {
						const text = currentHeader
							? `${currentHeader}\n\n${chunkParas.join("\n\n")}`
							: chunkParas.join("\n\n");
						results.push({
							text,
							tokenCount: chunkTokens,
							header: currentHeader,
							level: "paragraph",
						});
						chunkParas = [];
						chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
					}

					// Add large paragraph as its own chunk (with header context)
					const text = currentHeader ? `${currentHeader}\n\n${para}` : para;
					results.push({
						text,
						tokenCount: estimateTokens(text),
						header: currentHeader,
						level: "paragraph",
					});
					continue;
				}

				if (chunkTokens + paraTokens + 2 > maxTokens && chunkParas.length > 0) {
					// Flush current chunk
					const text = currentHeader
						? `${currentHeader}\n\n${chunkParas.join("\n\n")}`
						: chunkParas.join("\n\n");
					results.push({
						text,
						tokenCount: chunkTokens,
						header: currentHeader,
						level: "paragraph",
					});
					chunkParas = [];
					chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
				}

				chunkParas.push(para);
				chunkTokens += paraTokens + 2; // +2 for paragraph break
			}

			// Final chunk for this section
			if (chunkParas.length > 0) {
				const text = currentHeader
					? `${currentHeader}\n\n${chunkParas.join("\n\n")}`
					: chunkParas.join("\n\n");
				results.push({
					text,
					tokenCount: chunkTokens,
					header: currentHeader,
					level: "paragraph",
				});
			}
		}

		currentContent = [];
	};

	for (const line of lines) {
		const match = line.match(headerPattern);
		if (match) {
			flushSection();
			currentHeader = line; // Keep full header with # marks
		} else {
			currentContent.push(line);
		}
	}

	flushSection(); // Final section

	// Handle content with no headers at all
	if (results.length === 0 && content.trim()) {
		const text = content.trim();
		results.push({
			text,
			tokenCount: estimateTokens(text),
			header: "",
			level: "section",
		});
	}

	return results;
}

/**
 * Ingest a single OpenClaw memory markdown file into the database.
 * Uses hierarchical chunking to preserve section structure.
 *
 * @param filePath - Path to the memory markdown file
 * @returns Number of chunks inserted
 */
async function ingestMemoryMarkdown(filePath: string): Promise<number> {
	// Skip MEMORY.md (index file, not content)
	if (filePath.endsWith("MEMORY.md")) return 0;

	// Read file content
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch (e) {
		logger.error("watcher", "Failed to read memory file", undefined, {
			path: filePath,
			error: String(e),
		});
		return 0;
	}

	if (!content.trim()) return 0;

	// Compute hash for deduplication
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	if (ingestedMemoryFiles.get(filePath) === hash) {
		logger.debug("watcher", "Memory file unchanged, skipping", {
			path: filePath,
		});
		return 0;
	}
	ingestedMemoryFiles.set(filePath, hash);

	// Extract metadata from filename
	const filename = basename(filePath, ".md");
	const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
	const date = dateMatch ? dateMatch[1] : null;

	// Use hierarchical chunking
	const chunks = chunkMarkdownHierarchically(content, 512);
	let inserted = 0;

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const chunkKey = `openclaw:${filename}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 16)}`;
		try {
			const response = await fetch(
				`http://${HOST}:${PORT}/api/memory/remember`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: chunk.text,
						who: "openclaw-memory",
						importance: chunk.level === "section" ? 0.65 : 0.55, // Slightly higher for sections
						sourceType: "openclaw-memory-log",
						sourceId: chunkKey,
						tags: [
							"openclaw",
							"memory-log",
							date || "named",
							filename,
							chunk.level === "section"
								? "hierarchical-section"
								: "hierarchical-paragraph",
						]
							.filter(Boolean)
							.join(","),
					}),
				},
			);

			if (response.ok) {
				inserted++;
			} else {
				logger.warn("watcher", "Failed to ingest memory chunk", {
					path: filePath,
					chunkIndex: i,
					status: response.status,
				});
			}
		} catch (e) {
			const errDetails =
				e instanceof Error ? { message: e.message } : { error: String(e) };
			logger.error("watcher", "Failed to ingest memory chunk", undefined, {
				path: filePath,
				chunkIndex: i,
				...errDetails,
			});
		}
	}

	if (inserted > 0) {
		logger.info("watcher", "Ingested memory file", {
			path: filePath,
			chunks: inserted,
			sections: chunks.filter((c) => c.level === "section").length,
			filename,
		});
	}
	return inserted;
}

/**
 * Import all existing memory markdown files on daemon startup.
 * Scans ~/.agents/memory/ for .md files and ingests them.
 *
 * @returns Total number of chunks inserted
 */
async function importExistingMemoryFiles(): Promise<number> {
	const memoryDir = join(AGENTS_DIR, "memory");
	if (!existsSync(memoryDir)) {
		logger.debug(
			"daemon",
			"Memory directory does not exist, skipping initial import",
		);
		return 0;
	}

	let files: string[];
	try {
		files = readdirSync(memoryDir).filter(
			(f) => f.endsWith(".md") && f !== "MEMORY.md",
		);
	} catch (e) {
		const errDetails =
			e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error(
			"daemon",
			"Failed to read memory directory",
			undefined,
			errDetails,
		);
		return 0;
	}

	let totalChunks = 0;
	for (const file of files) {
		const count = await ingestMemoryMarkdown(join(memoryDir, file));
		totalChunks += count;
	}

	if (totalChunks > 0) {
		logger.info("daemon", "Imported existing memory files", {
			files: files.length,
			chunks: totalChunks,
		});
	}
	return totalChunks;
}

// ============================================================================
// Shutdown Handling
// ============================================================================

async function cleanup() {
	logger.info("daemon", "Shutting down");

	// Drain pipeline before closing DB so in-flight jobs finish writes
	try {
		await stopPipeline();
	} catch {
		// best-effort
	}

	closeLlmProvider();

	// Stop git sync timer
	stopGitSyncTimer();
	stopUpdateTimer();

	closeDbAccessor();

	if (watcher) {
		watcher.close();
	}

	if (existsSync(PID_FILE)) {
		try {
			unlinkSync(PID_FILE);
		} catch {
			// Ignore
		}
	}
}

process.on("SIGINT", () => {
	cleanup().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
	cleanup().finally(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
	logger.error("daemon", "Uncaught exception", err);
	cleanup().finally(() => process.exit(1));
});

// ============================================================================
// Main
// ============================================================================

// initMemorySchema is no longer needed — the migration runner in
// db-accessor.ts is the sole schema authority. See migrations/ in @signet/core.

async function main() {
	logger.info("daemon", "Signet Daemon starting");
	logger.info("daemon", "Agents directory", { path: AGENTS_DIR });
	logger.info("daemon", "Port configured", { port: PORT });

	// Ensure daemon directory exists
	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Initialise singleton DB accessor (opens write connection, sets pragmas,
	// runs migrations). This is the sole schema authority.
	initDbAccessor(MEMORY_DB);

	// Write PID file
	writeFileSync(PID_FILE, process.pid.toString());
	logger.info("daemon", "Process ID", { pid: process.pid });

	// Start file watcher
	startFileWatcher();
	logger.info("watcher", "File watcher started");

	// Initialize auth
	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	authConfig = memoryCfg.auth;
	if (authConfig.mode !== "local") {
		authSecret = loadOrCreateSecret(authConfig.secretPath);
		logger.info("auth", "Auth initialized", { mode: authConfig.mode });
	} else {
		logger.info("auth", "Running in local mode (no auth)");
	}

	// Rebuild rate limiters from config
	const rl = authConfig.rateLimits;
	if (rl.forget) authForgetLimiter = new AuthRateLimiter(rl.forget.windowMs, rl.forget.max);
	if (rl.modify) authModifyLimiter = new AuthRateLimiter(rl.modify.windowMs, rl.modify.max);
	if (rl.batchForget) authBatchForgetLimiter = new AuthRateLimiter(rl.batchForget.windowMs, rl.batchForget.max);
	if (rl.admin) authAdminLimiter = new AuthRateLimiter(rl.admin.windowMs, rl.admin.max);

	// Create LLM provider once, register as daemon-wide singleton
	const llmProvider =
		memoryCfg.pipelineV2.extraction.provider === "claude-code"
			? createClaudeCodeProvider({
					model: memoryCfg.pipelineV2.extraction.model || "haiku",
					defaultTimeoutMs:
						memoryCfg.pipelineV2.extraction.timeout || 60000,
				})
			: createOllamaProvider({
					model: memoryCfg.pipelineV2.extraction.model || "qwen3:4b",
					defaultTimeoutMs:
						memoryCfg.pipelineV2.extraction.timeout || 90000,
				});
	initLlmProvider(llmProvider);

	// Start extraction pipeline if enabled
	if (memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode) {
		startPipeline(
			getDbAccessor(),
			memoryCfg.pipelineV2,
			memoryCfg.embedding,
			fetchEmbedding,
			memoryCfg.search,
			providerTracker,
			analyticsCollector,
		);
	} else {
		// Retention worker runs unconditionally — cleans up tombstones,
		// expired history, and dead jobs even without the full pipeline.
		startRetentionWorker(getDbAccessor(), DEFAULT_RETENTION);

		// Summary worker runs regardless of pipeline state — session
		// summaries are a core feature, not gated on extraction pipeline.
		startSummaryWorker(getDbAccessor());
	}

	// Start scheduled task worker
	const schedulerHandle = startSchedulerWorker(getDbAccessor());

	// Start git sync timer (if enabled and has token)
	startGitSyncTimer();
	initUpdateSystem(CURRENT_VERSION, AGENTS_DIR);
	startUpdateTimer();

	// Start HTTP server
	serve(
		{
			fetch: app.fetch,
			port: PORT,
			hostname: HOST,
		},
		(info) => {
			logger.info("daemon", "Server listening", {
				address: info.address,
				port: info.port,
			});
			logger.info("daemon", "Daemon ready");

			// Import existing memory markdown files (OpenClaw memory logs)
			// Do this after server starts so the HTTP API is available for ingestion
			importExistingMemoryFiles().catch((e) => {
				const errDetails =
					e instanceof Error
						? { message: e.message, stack: e.stack }
						: { error: String(e) };
				logger.error(
					"daemon",
					"Failed to import existing memory files",
					undefined,
					errDetails,
				);
			});

			// Sync existing Claude Code project memories (also needs HTTP API)
			const claudeProjectsDir = join(homedir(), ".claude", "projects");
			if (existsSync(claudeProjectsDir)) {
				syncExistingClaudeMemories(claudeProjectsDir);
			}
		},
	);
}

if (import.meta.main) {
	main().catch((err) => {
		logger.error("daemon", "Fatal error", err);
		process.exit(1);
	});
}
