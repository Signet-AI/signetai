#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
	type AgentDefinition,
	buildArchitectureDoc,
	networkModeFromBindHost,
	normalizeAgentRosterEntry,
	parseSimpleYaml,
	stripSignetBlock,
} from "@signet/core";
import { watch } from "chokidar";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolveAgentId, resolveDaemonAgentId } from "./agent-id";
import {
	type TokenRole,
	type TokenScope,
	checkScope,
	createAuthMiddleware,
	createToken,
	requirePermission,
	requireRateLimit,
} from "./auth";
import { bindWithRetry } from "./bind-with-retry";
import { migrateConfig } from "./config-migration";
import { listConnectors } from "./connectors/registry";
import { normalizeAndHashContent } from "./content-normalization";
import { clearAllPresence } from "./cross-agent";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert } from "./db-helpers";
import { fetchEmbedding } from "./embedding-fetch";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { getAllFeatureFlags, initFeatureFlags } from "./feature-flags";
import { writeFileIfChangedAsync } from "./file-sync";
import { syncAgentWorkspaces } from "./identity-sync";
import { closeLlmProvider, getLlmProvider, initLlmProvider } from "./llm";
import { type LogEntry, logger } from "./logger";
import { type EmbeddingConfig, type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import {
	DEFAULT_RETENTION,
	enqueueDocumentIngestJob,
	ensureRetentionWorker,
	getDreamingPasses,
	getDreamingState,
	getDreamingWorker,
	getPipelineWorkerStatus,
	getSynthesisWorker,
	nudgeExtractionWorker,
	readLastSynthesisTime,
	setDreamingWorker,
	startPipeline,
	stopPipeline,
} from "./pipeline";
import { AlreadyRunningError, type DreamingWorkerHandle, startDreamingWorker } from "./pipeline/dreaming-worker";
import { deadLetterExtractionJob, deadLetterPendingExtractionJobs } from "./pipeline/extraction-fallback";
import { getGraphBoostIds } from "./pipeline/graph-search";
import {
	getTraversalStatus,
	invalidateTraversalCache,
	resolveFocalEntities,
	traverseKnowledgeGraph,
} from "./pipeline/graph-traversal";
import {
	getAvailableModels,
	getModelsByProvider,
	getRegistryStatus,
	initModelRegistry,
	refreshRegistry,
	stopModelRegistry,
} from "./pipeline/model-registry";
import {
	DEFAULT_OLLAMA_FALLBACK_MODEL,
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createLlamaCppProvider,
	createOllamaProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	ensureOpenCodeServer,
	resolveDefaultOllamaFallbackMaxContextTokens,
	stopOpenCodeServer,
	withRateLimit,
} from "./pipeline/provider";
import { resolveRuntimeModel } from "./pipeline/provider-resolution";
import { startReconciler } from "./pipeline/skill-reconciler";
import { type PredictorClient, createPredictorClient } from "./predictor-client";
import { detectDrift } from "./predictor-comparison";
import { getPredictorState } from "./predictor-state";
import { type RepairContext, structuralBackfill } from "./repair-actions";
import {
	AGENTS_DIR,
	ALLOWED_ORIGINS,
	BIND_HOST,
	CURRENT_VERSION,
	DAEMON_DIR,
	HOST,
	INTERNAL_SELF_HOST,
	LOG_DIR,
	MEMORY_DB,
	NETWORK_MODE,
	PID_FILE,
	PORT,
	analyticsCollector,
	authAdminLimiter,
	authBatchForgetLimiter,
	authConfig,
	authCrossAgentMessageLimiter,
	authForgetLimiter,
	authModifyLimiter,
	authSecret,
	bindAbort,
	invalidateDiagnosticsCache,
	isAllowedOrigin,
	isManagedOpenCodeLocalEndpoint,
	normalizeRuntimeBaseUrl,
	providerRuntimeResolution,
	providerTracker,
	queueExtractionJob,
	readEnvTrimmed,
	redactUrlForLogs,
	reloadAuthState,
	repairLimiter,
	setCheckpointPruneTimer,
	setEmbeddingTrackerHandle,
	setHeartbeatTimer,
	setPredictorClientRef,
	setRestartPipelineRuntime,
	setShuttingDown,
	setTelemetryRef,
	shuttingDown,
} from "./routes/state.js";
import { isHarnessAvailable, startSchedulerWorker } from "./scheduler/index.js";
import { getSecret, hasSecret } from "./secrets.js";
import { flushPendingCheckpoints, initCheckpointFlush, pruneCheckpoints } from "./session-checkpoints";
import { releaseAllSessions, startSessionCleanup, stopSessionCleanup } from "./session-tracker";
import { createSingleFlightRunner } from "./single-flight-runner";
import { closeSynthesisProvider, initSynthesisProvider } from "./synthesis-llm";
import { type TelemetryCollector, type TelemetryEventType, createTelemetryCollector } from "./telemetry";
import { closeWidgetProvider, initWidgetProvider } from "./widget-llm";

import { mountMcpRoute } from "./mcp/route.js";
import { mountAppTrayRoutes } from "./routes/app-tray.js";
import { mountChangelogRoutes } from "./routes/changelog.js";
import { registerConnectorRoutes } from "./routes/connectors-routes.js";
import { mountEventBusRoutes } from "./routes/event-bus.js";
import { getGitStatus, gitSync, scheduleAutoCommit, startGitSyncTimer, stopGitSyncTimer } from "./routes/git-sync.js";
import { registerHooksRoutes } from "./routes/hooks-routes.js";
import { registerKnowledgeRoutes } from "./routes/knowledge-routes.js";
import { mountMarketplaceReviewsRoutes } from "./routes/marketplace-reviews.js";
import { mountMarketplaceRoutes } from "./routes/marketplace.js";
import { mountMcpAnalyticsRoutes } from "./routes/mcp-analytics.js";
import { registerMemoryRoutes } from "./routes/memory-routes.js";
import { registerMiscRoutes } from "./routes/misc-routes.js";
import { mountOsAgentRoutes } from "./routes/os-agent.js";
import { mountOsChatRoutes } from "./routes/os-chat.js";
import { registerPipelineRoutes } from "./routes/pipeline-routes.js";
import { registerRepairRoutes } from "./routes/repair-routes.js";
import { registerSecretRoutes } from "./routes/secrets-routes.js";
import { registerSessionRoutes } from "./routes/session-routes.js";
import { mountSkillAnalyticsRoutes } from "./routes/skill-analytics.js";
import { mountSkillsRoutes, setFetchEmbedding } from "./routes/skills.js";
import { registerTelemetryRoutes } from "./routes/telemetry-routes.js";
import { checkEmbeddingProvider, getConfiguredProviderHints } from "./routes/utils.js";
import { mountWidgetRoutes } from "./routes/widget.js";
import {
	MAX_UPDATE_INTERVAL_SECONDS,
	MIN_UPDATE_INTERVAL_SECONDS,
	type UpdateConfig,
	checkForUpdates as checkForUpdatesImpl,
	getUpdateState,
	initUpdateSystem,
	parseBooleanFlag,
	parseUpdateInterval,
	runUpdate as runUpdateImpl,
	setUpdateConfig,
	startUpdateTimer,
	stopUpdateTimer,
} from "./update-system";
import { createAgentsWatcherIgnoreMatcher } from "./watcher-ignore";

let httpServer: ReturnType<typeof createAdaptorServer> | null = null;
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;
let shadowProcess: ChildProcess | null = null;
let predictorClientRef: PredictorClient | null = null;
let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
let skillReconcilerHandle: ReturnType<typeof startReconciler> | null = null;
let schedulerHandle: { stop(): Promise<void> } | null = null;
let structuralBackfillTimer: ReturnType<typeof setTimeout> | null = null;
// These are mirrored into state.ts via setters for read access by
// route modules. Only daemon.ts should assign or clear them.
// predictorClientRef follows the same pattern (see getPredictorClient).
let telemetryRef: TelemetryCollector | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let checkpointPruneTimer: ReturnType<typeof setInterval> | undefined;

export function getPredictorClient(): PredictorClient | null {
	return predictorClientRef;
}

export function recordPredictorLatency(operation: "predictor_score" | "predictor_train", durationMs: number): void {
	analyticsCollector.recordLatency(operation, durationMs);
}

// ============================================================================
// Hono App
// ============================================================================

export const app = new Hono();

// ============================================================================
// Middleware
// ============================================================================

app.use(
	"*",
	cors({
		origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
		credentials: true,
	}),
);

app.use("*", async (c, next) => {
	if (shuttingDown && c.req.path !== "/health") {
		c.status(503);
		return c.json({ error: "shutting down" });
	}
	return next();
});

app.use("*", async (c, next) => {
	if (authConfig.mode !== "local" && !authSecret) {
		c.status(503);
		return c.json({ error: "server initializing" });
	}
	const mw = createAuthMiddleware(authConfig, authSecret);
	return mw(c, next);
});

app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const duration = Date.now() - start;
	logger.api.request(c.req.method, c.req.path, c.res.status, duration);
	const actor = c.req.header("x-signet-actor");
	analyticsCollector.recordRequest(c.req.method, c.req.path, c.res.status, duration, actor ?? undefined);
	const p = c.req.path;
	if (p.includes("/remember") || p.includes("/save")) {
		analyticsCollector.recordLatency("remember", duration);
	} else if (p.includes("/recall") || p.includes("/search") || p.includes("/similar")) {
		analyticsCollector.recordLatency("recall", duration);
	} else if (p.includes("/modify") || p.includes("/forget") || p.includes("/recover")) {
		analyticsCollector.recordLatency("mutate", duration);
	}
});

app.use("*", async (c, next) => {
	const method = c.req.method;
	const bodyP = ["POST", "PUT", "PATCH"].includes(method)
		? c.req.text().catch(() => undefined)
		: Promise.resolve(undefined);
	await next();
	if (!shadowProcess) return;
	const reqPath = c.req.path;
	const search = new URL(c.req.url).search;
	const primaryStatus = c.res.status;
	bodyP
		.then((rawBody) =>
			fetch(`http://localhost:3851${reqPath}${search}`, {
				method,
				headers: Object.fromEntries(c.req.raw.headers),
				body: rawBody,
				signal: AbortSignal.timeout(5000),
			}),
		)
		.then((shadow) => {
			if (primaryStatus !== shadow.status) {
				appendDivergence(AGENTS_DIR, {
					path: reqPath,
					method,
					primaryStatus,
					shadowStatus: shadow.status,
				});
			}
			return shadow.body?.cancel();
		})
		.catch(() => {});
});

// ============================================================================
// Health + Features
// ============================================================================

app.get("/health", (c) => {
	const us = getUpdateState();
	let dbOk = false;
	try {
		getDbAccessor().withReadDb((db) => {
			db.prepare("SELECT 1").get();
			dbOk = true;
		});
	} catch {}
	const workers = getPipelineWorkerStatus();
	const extraction = workers.extraction;
	const stalled =
		extraction.running &&
		extraction.stats !== undefined &&
		extraction.stats.pending > 0 &&
		Date.now() - extraction.stats.lastProgressAt > 60_000;

	return c.json({
		status: shuttingDown ? "shutting_down" : "healthy",
		uptime: process.uptime(),
		pid: process.pid,
		version: CURRENT_VERSION,
		port: PORT,
		agentsDir: AGENTS_DIR,
		db: dbOk,
		shuttingDown,
		updateAvailable: us.lastCheck?.updateAvailable ?? false,
		pendingRestart: us.pendingRestartVersion !== null,
		pipeline: {
			extractionRunning: extraction.running,
			extractionStalled: stalled,
			extractionPending: extraction.stats?.pending ?? 0,
			extractionBackoffMs: extraction.stats?.backoffMs ?? 0,
		},
	});
});

app.get("/api/features", (c) => {
	return c.json(getAllFeatureFlags());
});

// ============================================================================
// MCP Server
// ============================================================================

mountMcpRoute(app);

app.get("/api/auth/whoami", (c) => {
	const auth = c.get("auth");
	return c.json({
		authenticated: auth?.authenticated ?? false,
		claims: auth?.claims ?? null,
		mode: authConfig.mode,
	});
});

app.use("/api/auth/token", async (c, next) => {
	const perm = requirePermission("admin", authConfig);
	const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
	await perm(c, async () => {
		await rate(c, next);
	});
});

app.post("/api/auth/token", async (c) => {
	if (!authSecret) {
		return c.json({ error: "auth secret not available (local mode?)" }, 400);
	}

	const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!payload) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const role = payload.role as string | undefined;
	const validRoles: TokenRole[] = ["admin", "operator", "agent", "readonly"];
	if (!role || !validRoles.includes(role as TokenRole)) {
		return c.json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
	}

	const scope = (payload.scope ?? {}) as TokenScope;
	const ttl =
		typeof payload.ttlSeconds === "number" && payload.ttlSeconds > 0
			? payload.ttlSeconds
			: authConfig.defaultTokenTtlSeconds;

	const token = createToken(authSecret, { sub: `token:${role}`, scope, role: role as TokenRole }, ttl);
	const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
	return c.json({ token, expiresAt });
});

// ============================================================================
// Route-level permission guards
// ============================================================================

app.use("/api/memory/remember", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/memory/save", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/hook/remember", async (c, next) => {
	return requirePermission("remember", authConfig)(c, next);
});
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
app.use("/api/sessions/summaries", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/knowledge/expand", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/knowledge/expand/session", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});
app.use("/api/graph/impact", async (c, next) => {
	return requirePermission("recall", authConfig)(c, next);
});

app.use("/api/memory/modify", async (c, next) => {
	const perm = requirePermission("modify", authConfig);
	const rate = requireRateLimit("modify", authModifyLimiter, authConfig);
	await perm(c, async () => {
		await rate(c, next);
	});
});

app.use("/api/memory/forget", async (c, next) => {
	const perm = requirePermission("forget", authConfig);
	const rate = requireRateLimit("batchForget", authBatchForgetLimiter, authConfig);
	await perm(c, async () => {
		await rate(c, next);
	});
});

app.use("/api/memory/:id/recover", async (c, next) => {
	return requirePermission("recover", authConfig)(c, next);
});

app.use("/api/documents", async (c, next) => {
	return requirePermission("documents", authConfig)(c, next);
});
app.use("/api/documents/*", async (c, next) => {
	return requirePermission("documents", authConfig)(c, next);
});

app.use("/api/connectors", async (c, next) => {
	if (c.req.method === "GET") return next();
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/connectors/*", async (c, next) => {
	if (c.req.method === "GET") return next();
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/diagnostics", async (c, next) => {
	return requirePermission("diagnostics", authConfig)(c, next);
});
app.use("/api/diagnostics/*", async (c, next) => {
	return requirePermission("diagnostics", authConfig)(c, next);
});

app.use("/api/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/mcp/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/mcp/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/skills/analytics", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/skills/analytics/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});

app.use("/api/cross-agent", async (c, next) => {
	if (c.req.method === "GET") {
		return requirePermission("recall", authConfig)(c, next);
	}
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/cross-agent/*", async (c, next) => {
	if (c.req.method === "GET") {
		return requirePermission("recall", authConfig)(c, next);
	}
	return requirePermission("remember", authConfig)(c, next);
});
app.use("/api/cross-agent/messages", async (c, next) => {
	if (c.req.method !== "POST") {
		await next();
		return;
	}
	return requireRateLimit("cross-agent-message", authCrossAgentMessageLimiter, authConfig)(c, next);
});

app.use("/api/predictor/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});
app.use("/api/timeline/*", async (c, next) => {
	return requirePermission("analytics", authConfig)(c, next);
});

app.use("/api/repair/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/secrets", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/secrets/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/git/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.use("/api/troubleshoot/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

const MAX_CONFIG_BYTES = 1_048_576;
app.use("/api/config", async (c, next) => {
	if (c.req.method === "POST") {
		const cl = c.req.header("content-length");
		if (cl && Number(cl) > MAX_CONFIG_BYTES) {
			return c.json({ error: `payload exceeds ${MAX_CONFIG_BYTES} byte limit` }, 413);
		}
		return requirePermission("admin", authConfig)(c, next);
	}
	return next();
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

// ============================================================================
// Register all route modules
// ============================================================================

registerMemoryRoutes(app);
registerHooksRoutes(app);
registerKnowledgeRoutes(app);
registerRepairRoutes(app);
registerConnectorRoutes(app);
registerSecretRoutes(app);
registerSessionRoutes(app, { getGitStatus, gitSync });
registerPipelineRoutes(app);
registerTelemetryRoutes(app);
registerMiscRoutes(app);

// ============================================================================
// Additional route modules (from main)
// ============================================================================

setFetchEmbedding(fetchEmbedding);
mountSkillsRoutes(app);
mountMarketplaceRoutes(app);
mountMcpAnalyticsRoutes(app);
mountSkillAnalyticsRoutes(app);
mountAppTrayRoutes(app);
mountWidgetRoutes(app);
mountEventBusRoutes(app);
mountMarketplaceReviewsRoutes(app);
mountChangelogRoutes(app);
mountOsChatRoutes(app);
mountOsAgentRoutes(app);

// ============================================================================
// Dashboard static serving
// ============================================================================

function getDashboardCandidates(): string[] {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	return [
		join(__dirname, "..", "..", "cli", "dashboard", "build"),
		join(__dirname, "..", "..", "..", "cli", "dashboard", "build"),
		join(__dirname, "..", "dashboard"),
		join(__dirname, "dashboard"),
	];
}

function getDashboardPath(): string | null {
	const candidates = getDashboardCandidates();

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "index.html"))) {
			return candidate;
		}
	}

	return null;
}

function setupStaticServing() {
	const dashboardPath = getDashboardPath();

	if (dashboardPath) {
		app.use("/*", async (c, next) => {
			const path = c.req.path;
			if (path.startsWith("/api/") || path === "/health" || path === "/sse") {
				return next();
			}
			return serveStatic({
				root: dashboardPath,
				rewriteRequestPath: (p) => {
					if (!p.includes(".") || p === "/") {
						return "/index.html";
					}
					return p;
				},
			})(c, next);
		});
	} else {
		logger.warn("daemon", "Dashboard not found - API-only mode", {
			candidates: getDashboardCandidates(),
		});
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

// Track ingested files to avoid re-processing (path -> content hash)
const ingestedMemoryFiles = new Map<string, string>();

// Track synced memories to avoid duplicates
const syncedClaudeMemories = new Set<string>();

let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

async function syncHarnessConfigs() {
	const agentsMdPath = join(AGENTS_DIR, "AGENTS.md");
	if (!existsSync(agentsMdPath)) return;

	const rawContent = await Bun.file(agentsMdPath).text();
	const content = stripSignetBlock(rawContent);

	const buildHeader = (targetName: string) => {
		const files = [
			{ name: "SOUL.md", desc: "Personality & tone" },
			{ name: "IDENTITY.md", desc: "Agent identity" },
			{ name: "USER.md", desc: "User profile & preferences" },
			{ name: "MEMORY.md", desc: "Working memory context" },
			{ name: "agent.yaml", desc: "Configuration & settings" },
		];

		const safe = (p: string) => p.replace(/[\n\r]/g, "");

		const existingFiles = files.filter((f) => existsSync(join(AGENTS_DIR, f.name)));
		const fileList = existingFiles.map((f) => `#   - ${safe(join(AGENTS_DIR, f.name))} (${f.desc})`).join("\n");

		return `# ${targetName}
# ============================================================================
# AUTO-GENERATED from ${safe(agentsMdPath)} by Signet
# Generated: ${new Date().toISOString()}
#
# DO NOT EDIT THIS FILE - changes will be overwritten
# Edit the source file instead: ${safe(agentsMdPath)}
#
# Signet Agent Home: ${safe(AGENTS_DIR)}
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

	const identityExtras = (
		await Promise.all(
			["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].map(async (name) => {
				const identityPath = join(AGENTS_DIR, name);
				if (!existsSync(identityPath)) return "";
				try {
					const fileContent = (await Bun.file(identityPath).text()).trim();
					if (!fileContent) return "";
					const header = name.replace(".md", "");
					return `\n## ${header}\n\n${fileContent}`;
				} catch {
					return "";
				}
			}),
		)
	)
		.filter(Boolean)
		.join("\n");

	const composed = content + identityExtras;

	const opencodeDir = join(homedir(), ".config", "opencode");
	if (existsSync(opencodeDir)) {
		try {
			const opencodeAgentsPath = join(opencodeDir, "AGENTS.md");
			if (await writeFileIfChangedAsync(opencodeAgentsPath, buildHeader("AGENTS.md") + composed)) {
				logger.sync.harness("opencode", "~/.config/opencode/AGENTS.md");
			}
		} catch (error) {
			logger.sync.failed("opencode", error instanceof Error ? error : new Error(String(error)));
		}
	}

	await syncAgentWorkspaces({
		agentsDir: AGENTS_DIR,
		onWorkspaceSynced: (name, workspaceAgentsPath) => {
			logger.sync.harness(`openclaw:${name}`, workspaceAgentsPath);
		},
		onError: (name, error) => {
			logger.error("sync", `Failed to sync agent workspace: ${name}`, error);
		},
	});
	await ensureArchitectureDoc();
}

async function ensureArchitectureDoc(): Promise<void> {
	const archPath = join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md");
	try {
		const archContent = buildArchitectureDoc(AGENTS_DIR);
		if (await writeFileIfChangedAsync(archPath, archContent)) {
			logger.info("sync", "SIGNET-ARCHITECTURE.md updated");
		}
	} catch (error) {
		logger.error(
			"sync",
			"Failed to write SIGNET-ARCHITECTURE.md",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

const syncRunner = createSingleFlightRunner(
	async () => {
		await syncHarnessConfigs();
	},
	(error) => {
		logger.error("sync", "Harness sync failed", error);
	},
);

function scheduleSyncHarnessConfigs() {
	if (syncTimer) {
		clearTimeout(syncTimer);
	}

	syncTimer = setTimeout(async () => {
		if (syncRunner.running) {
			syncRunner.requestRerun();
			return;
		}
		await syncRunner.execute();
	}, SYNC_DEBOUNCE_MS);
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function chunkMarkdownHierarchically(
	content: string,
	maxTokens = 512,
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
	const headerPattern = /^(#{1,3})\s+(.+)$/;

	const flushSection = () => {
		if (currentContent.length === 0) return;

		const sectionText = currentContent.join("\n").trim();
		if (!sectionText) return;

		const sectionTokens = estimateTokens(sectionText);

		if (sectionTokens <= maxTokens) {
			const textWithHeader = currentHeader ? `${currentHeader}\n\n${sectionText}` : sectionText;
			results.push({
				text: textWithHeader,
				tokenCount: estimateTokens(textWithHeader),
				header: currentHeader,
				level: "section",
			});
		} else {
			const paragraphs = sectionText.split(/\n\n+/);
			let chunkParas: string[] = [];
			let chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;

			for (const para of paragraphs) {
				const paraTokens = estimateTokens(para);

				if (paraTokens > maxTokens) {
					if (chunkParas.length > 0) {
						const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
						results.push({
							text,
							tokenCount: chunkTokens,
							header: currentHeader,
							level: "paragraph",
						});
						chunkParas = [];
						chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
					}

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
					const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
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
				chunkTokens += paraTokens + 2;
			}

			if (chunkParas.length > 0) {
				const text = currentHeader ? `${currentHeader}\n\n${chunkParas.join("\n\n")}` : chunkParas.join("\n\n");
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
			currentHeader = line;
		} else {
			currentContent.push(line);
		}
	}

	flushSection();

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

export const ARTIFACT_FILENAME_RE = /--(?:summary|transcript|compaction|manifest)\.md$/;
export const MEMORY_BACKUP_FILENAME_RE = /^MEMORY\.(?:backup|bak|pre)-.+\.md$/;

async function ingestMemoryMarkdown(filePath: string): Promise<number> {
	if (filePath.endsWith("MEMORY.md")) return 0;

	const filenameWithExt = basename(filePath);
	if (MEMORY_BACKUP_FILENAME_RE.test(filenameWithExt) || ARTIFACT_FILENAME_RE.test(filenameWithExt)) return 0;

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

	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	if (ingestedMemoryFiles.get(filePath) === hash) {
		logger.debug("watcher", "Memory file unchanged, skipping", {
			path: filePath,
		});
		return 0;
	}
	ingestedMemoryFiles.set(filePath, hash);

	const filename = basename(filePath, ".md");
	const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
	const date = dateMatch ? dateMatch[1] : null;

	const chunks = chunkMarkdownHierarchically(content, 512);
	let inserted = 0;

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];

		const body =
			chunk.header && chunk.text.startsWith(chunk.header)
				? chunk.text.slice(chunk.header.length).trim()
				: chunk.text.trim();
		if (body.length < 80) continue;

		const chunkKey = `openclaw:${filename}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 16)}`;
		try {
			const response = await fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: chunk.text,
					who: "openclaw-memory",
					importance: chunk.level === "section" ? 0.65 : 0.55,
					sourceType: "openclaw-memory-log",
					sourceId: chunkKey,
					tags: [
						"openclaw",
						"memory-log",
						date || "named",
						filename,
						chunk.level === "section" ? "hierarchical-section" : "hierarchical-paragraph",
					]
						.filter(Boolean)
						.join(","),
				}),
			});

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
			const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
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

async function importExistingMemoryFiles(): Promise<number> {
	const memoryDir = join(AGENTS_DIR, "memory");
	if (!existsSync(memoryDir)) {
		logger.debug("daemon", "Memory directory does not exist, skipping initial import");
		return 0;
	}

	let files: string[];
	try {
		files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
	} catch (e) {
		const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error("daemon", "Failed to read memory directory", undefined, errDetails);
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

function startClaudeMemoryWatcher() {
	const claudeProjectsDir = join(homedir(), ".claude", "projects");
	if (!existsSync(claudeProjectsDir)) return;

	const claudeWatcher = watch(join(claudeProjectsDir, "**", "memory", "MEMORY.md"), {
		persistent: true,
		ignoreInitial: true,
	});

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
			const memoryFile = join(claudeProjectsDir, project, "memory", "MEMORY.md");
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
		logger.error("watcher", "Failed to sync existing Claude memories", undefined, { error: String(e) });
	}
}

async function syncClaudeMemoryFile(filePath: string): Promise<number> {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (!content.trim()) return 0;

		const match = filePath.match(/projects\/([^/]+)\/memory/);
		const projectId = match ? match[1] : "unknown";

		const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
		const existingHash = ingestedMemoryFiles.get(filePath);
		if (existingHash === contentHash) {
			logger.debug("watcher", "Claude memory file unchanged, skipping", {
				path: filePath,
			});
			return 0;
		}
		ingestedMemoryFiles.set(filePath, contentHash);

		const chunks = chunkMarkdownHierarchically(content, 512);
		let inserted = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];

			const sectionMatch = chunk.header.match(/^#+\s+(.+)$/);
			const sectionName = sectionMatch ? sectionMatch[1].toLowerCase() : "";

			const chunkKey = `claude:${projectId}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 16)}`;
			if (syncedClaudeMemories.has(chunkKey)) continue;
			syncedClaudeMemories.add(chunkKey);

			try {
				const response = await fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
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
							chunk.level === "section" ? "hierarchical-section" : "hierarchical-paragraph",
						]
							.filter(Boolean)
							.join(","),
					}),
				});

				if (response.ok) {
					inserted++;
					logger.info("watcher", "Synced Claude memory chunk", {
						content: chunk.text.slice(0, 50),
						section: sectionName || "(no section)",
						level: chunk.level,
					});
				}
			} catch (e) {
				const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
				logger.error("watcher", "Failed to sync Claude memory chunk", undefined, {
					path: filePath,
					chunkIndex: i,
					...errDetails,
				});
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
		const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error("watcher", "Failed to read Claude memory file", undefined, {
			path: filePath,
			...errDetails,
		});
		return 0;
	}
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
			join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md"),
			join(AGENTS_DIR, "memory"),
			join(AGENTS_DIR, "agents"),
		],
		{
			persistent: true,
			ignoreInitial: true,
			ignored: createAgentsWatcherIgnoreMatcher(AGENTS_DIR),
		},
	);

	watcher.on("change", (path) => {
		logger.info("watcher", "File changed", { path });
		scheduleAutoCommit(path);

		const base = basename(path);
		if (base === "agent.yaml" || base === "AGENT.yaml") {
			try {
				reloadAuthState(AGENTS_DIR);
				logger.info("config", "Auth config reloaded from disk");
			} catch (e) {
				logger.error("config", "Failed to reload auth config", e as Error);
			}
		}

		const SYNC_TRIGGER_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
		const normalizedForSync = path.replace(/\\/g, "/");
		const isAgentSubdir = normalizedForSync.includes(`${AGENTS_DIR.replace(/\\/g, "/")}/agents/`);
		if (SYNC_TRIGGER_FILES.some((f) => path.endsWith(f)) || isAgentSubdir) {
			scheduleSyncHarnessConfigs();
		}

		const normalizedPath = path.replace(/\\/g, "/");
		if (
			normalizedPath.includes("/memory/") &&
			normalizedPath.endsWith(".md") &&
			!normalizedPath.endsWith("MEMORY.md")
		) {
			ingestMemoryMarkdown(path).catch((e) =>
				logger.error("watcher", "Ingestion failed", undefined, {
					path,
					error: String(e),
				}),
			);
		}
	});

	watcher.on("unlink", (path) => {
		logger.info("watcher", "File removed", { path });
		if (path.endsWith("SIGNET-ARCHITECTURE.md")) {
			void ensureArchitectureDoc();
		}
		scheduleAutoCommit(path);
	});

	watcher.on("add", (path) => {
		logger.info("watcher", "File added", { path });
		scheduleAutoCommit(path);

		const normalizedAddPath = path.replace(/\\/g, "/");
		if (
			normalizedAddPath.includes("/memory/") &&
			normalizedAddPath.endsWith(".md") &&
			!normalizedAddPath.endsWith("MEMORY.md")
		) {
			ingestMemoryMarkdown(path).catch((e) =>
				logger.error("watcher", "Ingestion failed", undefined, {
					path,
					error: String(e),
				}),
			);
		}
	});

	startClaudeMemoryWatcher();
}

// ============================================================================
// Shadow daemon helpers
// ============================================================================

function resolveDaemonBinary(): string | null {
	const ext = process.platform === "win32" ? ".exe" : "";
	const arch = process.arch;
	const plat = process.platform;
	const monoRoot = join(import.meta.dir, "..", "..", "..");
	const devPaths = [
		join(monoRoot, "packages", "daemon-rs", "target", "release", `signet-daemon${ext}`),
		join(monoRoot, "packages", "daemon-rs", "target", "debug", `signet-daemon${ext}`),
		join(process.cwd(), "packages", "daemon-rs", "target", "release", `signet-daemon${ext}`),
	];
	for (const p of devPaths) {
		if (existsSync(p)) return p;
	}
	const name = `signet-daemon-${plat}-${arch}${ext}`;
	const npmPath = join(import.meta.dir, "..", "bin", name);
	if (existsSync(npmPath)) return npmPath;
	return null;
}

function setupShadowDb(agentsDir: string): string {
	const shadowRoot = join(agentsDir, ".shadow");
	const shadowMemDir = join(shadowRoot, "memory");
	mkdirSync(shadowMemDir, { recursive: true });

	const mainDb = join(agentsDir, "memory", "memories.db");
	const shadowDb = join(shadowMemDir, "memories.db");
	const stale = !existsSync(shadowDb) || Date.now() - statSync(shadowDb).mtimeMs > 24 * 60 * 60 * 1000;
	if (stale && existsSync(mainDb)) {
		copyFileSync(mainDb, shadowDb);
		for (const ext of ["-wal", "-shm"]) {
			const src = mainDb + ext;
			if (existsSync(src)) copyFileSync(src, shadowDb + ext);
		}
		logger.info("shadow", "Shadow DB refreshed");
	}

	const mainCfg = join(agentsDir, "agent.yaml");
	const shadowCfg = join(shadowRoot, "agent.yaml");
	if (existsSync(mainCfg)) copyFileSync(mainCfg, shadowCfg);

	return shadowRoot;
}

function appendDivergence(agentsDir: string, entry: Record<string, unknown>) {
	const logPath = join(agentsDir, ".daemon", "logs", "shadow-divergences.jsonl");
	appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ============================================================================
// Pipeline runtime
// ============================================================================

function readPipelineMode(cfg: ResolvedMemoryConfig["pipelineV2"]): string {
	if (!cfg.enabled) return "disabled";
	if (cfg.paused) return "paused";
	if (cfg.mutationsFrozen) return "frozen";
	if (cfg.nativeShadowEnabled) return "shadow";
	if (cfg.shadowMode) return "shadow";
	return "controlled-write";
}

function clearStructuralBackfillTimer(): void {
	if (!structuralBackfillTimer) return;
	clearTimeout(structuralBackfillTimer);
	structuralBackfillTimer = null;
}

async function stopPipelineRuntime(): Promise<void> {
	clearStructuralBackfillTimer();

	if (skillReconcilerHandle) {
		try {
			await skillReconcilerHandle.stop();
		} catch {}
		skillReconcilerHandle = null;
	}

	if (shadowProcess) {
		try {
			shadowProcess.kill();
		} catch {}
		shadowProcess = null;
	}

	if (predictorClientRef) {
		try {
			await predictorClientRef.stop();
		} catch {}
		predictorClientRef = null;
		setPredictorClientRef(null);
	}

	if (embeddingTrackerHandle) {
		try {
			await embeddingTrackerHandle.stop();
		} catch {}
		embeddingTrackerHandle = null;
		setEmbeddingTrackerHandle(null);
	}

	if (dreamingWorkerHandle) {
		dreamingWorkerHandle.stop();
		if (dreamingWorkerHandle.activePass) {
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
			await Promise.race([dreamingWorkerHandle.activePass.catch(() => undefined), timeout]);
		}
		dreamingWorkerHandle = null;
		setDreamingWorker(null);
	}

	if (schedulerHandle) {
		try {
			await schedulerHandle.stop();
		} catch {}
		schedulerHandle = null;
	}

	try {
		await stopPipeline();
	} catch {}

	closeLlmProvider();
	closeSynthesisProvider();
	closeWidgetProvider();
	stopOpenCodeServer();
	stopModelRegistry();
	invalidateDiagnosticsCache();
}

async function restartPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	await stopPipelineRuntime();
	await startPipelineRuntime(memoryCfg, telemetry);
}

function syncAgentRoster(agentsDir: string): void {
	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];
	let roster: readonly AgentDefinition[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8")) as Record<string, unknown>;
			const agents = yaml.agents as Record<string, unknown> | undefined;
			const raw = agents?.roster;
			if (Array.isArray(raw)) {
				roster = raw as AgentDefinition[];
			}
		} catch {}
		break;
	}
	if (roster.length === 0) return;

	const db = getDbAccessor();
	const now = new Date().toISOString();
	db.withWriteTx((w) => {
		const stmt = w.prepare(
			`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   read_policy = excluded.read_policy,
			   policy_group = excluded.policy_group,
			   updated_at = excluded.updated_at`,
		);
		for (const entry of roster) {
			const normalized = normalizeAgentRosterEntry(entry);
			if (!normalized) continue;
			stmt.run(normalized.name, normalized.name, normalized.readPolicy, normalized.policyGroup, now, now);
		}
	});
	logger.info("daemon", "Agent roster synced", { count: roster.length });
}

async function startPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	const pipelinePaused = memoryCfg.pipelineV2.paused;
	clearStructuralBackfillTimer();
	logger.info("config", "Resolved embedding config", {
		provider: memoryCfg.embedding.provider,
		model: memoryCfg.embedding.model,
		dimensions: memoryCfg.embedding.dimensions,
	});

	reloadAuthState(AGENTS_DIR);

	const providerHints = getConfiguredProviderHints(AGENTS_DIR);
	const validExtractionProviders = new Set([
		"none",
		"llama-cpp",
		"ollama",
		"claude-code",
		"opencode",
		"codex",
		"anthropic",
		"openrouter",
		"command",
	]);
	const validSynthesisProviders = new Set([
		"none",
		"llama-cpp",
		"ollama",
		"claude-code",
		"codex",
		"opencode",
		"anthropic",
		"openrouter",
	]);

	providerRuntimeResolution.extraction = {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: memoryCfg.pipelineV2.extraction.provider,
		fallbackProvider: memoryCfg.pipelineV2.extraction.fallbackProvider,
		status: "active",
		degraded: false,
		fallbackApplied: false,
		reason: null,
		since: null,
	};
	providerRuntimeResolution.synthesis = {
		configured: providerHints.synthesis,
		resolved: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
		effective: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
	};
	if (providerHints.extraction && !validExtractionProviders.has(providerHints.extraction)) {
		logger.warn("config", "Unsupported extraction provider configured, using resolved fallback", {
			configured: providerHints.extraction,
			resolved: memoryCfg.pipelineV2.extraction.provider,
		});
	}
	if (
		providerHints.synthesis &&
		memoryCfg.pipelineV2.synthesis.enabled &&
		!validSynthesisProviders.has(providerHints.synthesis)
	) {
		logger.warn("config", "Unsupported synthesis provider configured, using resolved fallback", {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.provider,
		});
	}

	const extractionFallbackProvider = memoryCfg.pipelineV2.extraction.fallbackProvider;
	let effectiveExtractionProvider = memoryCfg.pipelineV2.extraction.provider;
	let extractionStatus: "active" | "degraded" | "blocked" | "disabled" | "paused" = "active";
	let extractionDegraded = false;
	let extractionFallbackApplied = false;
	let extractionReason: string | null = null;
	let extractionSince: string | null = null;
	const extractionOllamaBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"http://127.0.0.1:11434",
	);
	const extractionOllamaFallbackBaseUrl =
		memoryCfg.pipelineV2.extraction.provider === "opencode" ? "http://127.0.0.1:11434" : extractionOllamaBaseUrl;
	const extractionOpenCodeBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"http://127.0.0.1:4096",
	);
	const extractionOpenRouterBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"https://openrouter.ai/api/v1",
	);
	const extractionLlamaCppBaseUrl = normalizeRuntimeBaseUrl(
		memoryCfg.pipelineV2.extraction.endpoint,
		"http://127.0.0.1:8080",
	);
	const ollamaFallbackMaxContextTokens = resolveDefaultOllamaFallbackMaxContextTokens();
	const extractionOpenCodeShouldManage = isManagedOpenCodeLocalEndpoint(extractionOpenCodeBaseUrl);

	const markExtractionUnavailable = (reason: string): void => {
		extractionReason = reason;
		extractionSince = new Date().toISOString();
		extractionDegraded = true;
		const localFallback = extractionFallbackProvider === "llama-cpp" ? "llama-cpp" : "ollama";
		if (
			(extractionFallbackProvider === "llama-cpp" || extractionFallbackProvider === "ollama") &&
			effectiveExtractionProvider !== localFallback
		) {
			effectiveExtractionProvider = localFallback;
			extractionStatus = "degraded";
			extractionFallbackApplied = true;
			return;
		}
		effectiveExtractionProvider = "none";
		extractionStatus = "blocked";
		extractionFallbackApplied = false;
	};

	if (pipelinePaused) {
		logger.info("config", "Pipeline paused; extraction provider startup deferred");
		effectiveExtractionProvider = "none";
		extractionStatus = "paused";
	} else if (effectiveExtractionProvider === "none") {
		logger.info("config", "Extraction provider set to 'none', pipeline LLM disabled");
		extractionStatus = "disabled";
	} else if (effectiveExtractionProvider === "command") {
		logger.info(
			"config",
			"Extraction provider set to 'command'; summary worker will execute pipelineV2.extraction.command",
		);
	} else if (effectiveExtractionProvider === "opencode") {
		if (extractionOpenCodeShouldManage) {
			const serverReady = await ensureOpenCodeServer(4096);
			if (!serverReady) {
				markExtractionUnavailable("OpenCode server not available for extraction startup preflight");
			}
		} else {
			logger.info("config", "Using external OpenCode endpoint for extraction", {
				baseUrl: redactUrlForLogs(extractionOpenCodeBaseUrl),
			});
		}
	} else if (effectiveExtractionProvider === "claude-code") {
		const resolvedClaude = Bun.which("claude");
		if (resolvedClaude === null) {
			markExtractionUnavailable("Claude Code CLI not found during extraction startup preflight");
		} else {
			try {
				const exitCode = await new Promise<number>((resolve) => {
					const proc = spawn(resolvedClaude, ["--version"], {
						stdio: "pipe",
						windowsHide: true,
						env: { ...process.env, SIGNET_NO_HOOKS: "1" },
					});
					proc.on("close", (code) => resolve(code ?? 1));
					proc.on("error", () => resolve(1));
				});
				if (exitCode !== 0) throw new Error("non-zero exit");
			} catch {
				markExtractionUnavailable("Claude Code CLI failed extraction startup preflight");
			}
		}
	} else if (effectiveExtractionProvider === "codex") {
		const resolvedCodex = Bun.which("codex");
		if (resolvedCodex === null) {
			markExtractionUnavailable("Codex CLI not found during extraction startup preflight");
		} else {
			try {
				const exitCode = await new Promise<number>((resolve) => {
					const proc = spawn(resolvedCodex, ["--version"], {
						stdio: "pipe",
						windowsHide: true,
						env: {
							...process.env,
							SIGNET_NO_HOOKS: "1",
							SIGNET_CODEX_BYPASS_WRAPPER: "1",
						},
					});
					proc.on("close", (code) => resolve(code ?? 1));
					proc.on("error", () => resolve(1));
				});
				if (exitCode !== 0) throw new Error("non-zero exit");
			} catch {
				markExtractionUnavailable("Codex CLI failed extraction startup preflight");
			}
		}
	}
	const keyCache = new Map<"ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY", string | undefined>();
	const getKey = async (name: "ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY"): Promise<string | undefined> => {
		if (keyCache.has(name)) return keyCache.get(name);
		let key = process.env[name];
		if (!key) {
			try {
				key = (await getSecret(name)) ?? undefined;
			} catch {
				logger.warn("config", `Failed to resolve ${name} from secrets store`);
			}
		}
		keyCache.set(name, key);
		return key;
	};

	let anthropicApiKey: string | undefined;
	const needsAnthropicForSynthesis =
		memoryCfg.pipelineV2.synthesis.enabled && memoryCfg.pipelineV2.synthesis.provider === "anthropic";
	if (effectiveExtractionProvider === "anthropic" || needsAnthropicForSynthesis) {
		anthropicApiKey = await getKey("ANTHROPIC_API_KEY");
		if (!anthropicApiKey) {
			logger.error(
				"config",
				`ANTHROPIC_API_KEY not found — falling back to ${extractionFallbackProvider}. Set via env or 'signet secrets set ANTHROPIC_API_KEY'`,
			);
			if (effectiveExtractionProvider === "anthropic") {
				markExtractionUnavailable("ANTHROPIC_API_KEY not found for extraction startup preflight");
			}
		}
	}

	let openRouterApiKey: string | undefined;
	const needsOpenRouterForSynthesis =
		memoryCfg.pipelineV2.synthesis.enabled && memoryCfg.pipelineV2.synthesis.provider === "openrouter";
	if (effectiveExtractionProvider === "openrouter" || needsOpenRouterForSynthesis) {
		openRouterApiKey = await getKey("OPENROUTER_API_KEY");
		if (!openRouterApiKey) {
			logger.error(
				"config",
				`OPENROUTER_API_KEY not found — falling back to ${extractionFallbackProvider}. Set via env or 'signet secrets set OPENROUTER_API_KEY'`,
			);
			if (effectiveExtractionProvider === "openrouter") {
				markExtractionUnavailable("OPENROUTER_API_KEY not found for extraction startup preflight");
			}
		}
	}

	const createExtractionProvider = (provider: typeof effectiveExtractionProvider) => {
		const model = resolveRuntimeModel(
			provider,
			memoryCfg.pipelineV2.extraction.provider,
			memoryCfg.pipelineV2.extraction.model,
		);
		const usingExtractionOllamaFallback =
			provider === "ollama" && memoryCfg.pipelineV2.extraction.provider !== "ollama";
		if (provider === "none") return null;
		if (provider === "anthropic") {
			if (!anthropicApiKey) return null;
			return createAnthropicProvider({
				model: model || "haiku",
				apiKey: anthropicApiKey,
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "openrouter") {
			if (!openRouterApiKey) return null;
			return createOpenRouterProvider({
				model: model || "openai/gpt-4o-mini",
				apiKey: openRouterApiKey,
				baseUrl: extractionOpenRouterBaseUrl,
				referer: readEnvTrimmed("OPENROUTER_HTTP_REFERER"),
				title: readEnvTrimmed("OPENROUTER_TITLE"),
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "opencode") {
			return createOpenCodeProvider({
				model: model || "anthropic/claude-haiku-4-5-20251001",
				baseUrl: extractionOpenCodeBaseUrl,
				ollamaFallbackBaseUrl: extractionOllamaFallbackBaseUrl,
				ollamaFallbackMaxContextTokens: ollamaFallbackMaxContextTokens,
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
				enableStructuredOutput: memoryCfg.pipelineV2.extraction.structuredOutput,
			});
		}
		if (provider === "claude-code") {
			return createClaudeCodeProvider({
				model: model || "haiku",
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "codex") {
			return createCodexProvider({
				model: model || "gpt-5-codex-mini",
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		if (provider === "llama-cpp") {
			return createLlamaCppProvider({
				model: model || "qwen3.5:4b",
				baseUrl: extractionLlamaCppBaseUrl,
				defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			});
		}
		return createOllamaProvider({
			...(model ? { model } : {}),
			baseUrl: extractionOllamaFallbackBaseUrl,
			defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
			...(usingExtractionOllamaFallback
				? {
						maxContextTokens: ollamaFallbackMaxContextTokens,
					}
				: {}),
		});
	};

	let llmProvider = createExtractionProvider(effectiveExtractionProvider);
	if (llmProvider) {
		const preflightOk = await llmProvider.available();
		if (!preflightOk) {
			const failedProvider = effectiveExtractionProvider;
			const failedReason = extractionReason ?? `Extraction provider ${failedProvider} failed startup preflight`;
			const localFallback = extractionFallbackProvider === "llama-cpp" ? "llama-cpp" : "ollama";
			if (
				failedProvider !== localFallback &&
				(extractionFallbackProvider === "llama-cpp" || extractionFallbackProvider === "ollama")
			) {
				extractionReason = failedReason;
				extractionSince = extractionSince ?? new Date().toISOString();
				extractionDegraded = true;
				extractionFallbackApplied = true;
				extractionStatus = "degraded";
				effectiveExtractionProvider = localFallback;
				llmProvider = createExtractionProvider(localFallback);
				if (!llmProvider || !(await llmProvider.available())) {
					effectiveExtractionProvider = "none";
					extractionStatus = "blocked";
					extractionFallbackApplied = false;
					extractionReason = `${failedReason}; ${localFallback} fallback startup preflight failed`;
					llmProvider = null;
				}
			} else {
				effectiveExtractionProvider = "none";
				extractionStatus = "blocked";
				extractionDegraded = true;
				extractionFallbackApplied = false;
				extractionReason =
					extractionFallbackProvider === "none" ? `${failedReason}; fallbackProvider is none` : failedReason;
				extractionSince = extractionSince ?? new Date().toISOString();
				llmProvider = null;
			}
		}
	}

	const effectiveExtractionModel = resolveRuntimeModel(
		effectiveExtractionProvider,
		memoryCfg.pipelineV2.extraction.provider,
		memoryCfg.pipelineV2.extraction.model,
	);
	providerRuntimeResolution.extraction = {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: effectiveExtractionProvider,
		fallbackProvider: extractionFallbackProvider,
		status: extractionStatus,
		degraded: extractionDegraded,
		fallbackApplied: extractionFallbackApplied,
		reason: extractionReason,
		since: extractionSince,
	};
	if (providerHints.extraction && providerHints.extraction !== effectiveExtractionProvider) {
		logger.warn("config", "Extraction provider resolved differently than configured", {
			configured: providerHints.extraction,
			resolved: memoryCfg.pipelineV2.extraction.provider,
			effective: effectiveExtractionProvider,
			fallbackProvider: extractionFallbackProvider,
			status: extractionStatus,
			reason: extractionReason,
		});
	}
	logger.info("config", "Extraction provider", {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: effectiveExtractionProvider,
		fallbackProvider: extractionFallbackProvider,
		status: extractionStatus,
		degraded: extractionDegraded,
		reason: extractionReason,
		endpoint: redactUrlForLogs(
			effectiveExtractionProvider === "ollama"
				? extractionOllamaFallbackBaseUrl
				: effectiveExtractionProvider === "llama-cpp"
					? extractionLlamaCppBaseUrl
					: effectiveExtractionProvider === "opencode"
						? extractionOpenCodeBaseUrl
						: effectiveExtractionProvider === "openrouter"
							? extractionOpenRouterBaseUrl
							: undefined,
		),
	});
	const extractionModelName = effectiveExtractionModel ?? memoryCfg.pipelineV2.extraction.model;
	if (
		effectiveExtractionProvider === "anthropic" ||
		effectiveExtractionProvider === "openrouter" ||
		effectiveExtractionProvider === "opencode"
	) {
		logger.warn(
			"config",
			"Extraction is intended for Claude Code (Haiku), Codex CLI (GPT Mini) on Pro/Max, or local llama.cpp qwen3.5:4b+ / Ollama qwen3:4b+. Remote API extraction can create extreme fees fast. Set provider to 'none' to disable it on a VPS.",
			{
				provider: effectiveExtractionProvider,
				model: extractionModelName,
			},
		);
	}

	if (
		effectiveExtractionProvider === "claude-code" &&
		extractionModelName &&
		!extractionModelName.toLowerCase().includes("haiku")
	) {
		logger.warn("config", "Claude Code extraction is safest on Haiku. Larger models increase cost significantly.", {
			model: extractionModelName,
		});
	}
	if (
		effectiveExtractionProvider === "codex" &&
		extractionModelName &&
		!extractionModelName.toLowerCase().includes("mini")
	) {
		logger.warn("config", "Codex extraction is safest on GPT Mini. Larger models increase cost significantly.", {
			model: extractionModelName,
		});
	}

	const startupExtractionBlocked = extractionStatus === "blocked" && extractionReason !== null;
	if (startupExtractionBlocked && !llmProvider) {
		const blockedReason = extractionReason ?? "Extraction provider unavailable during startup preflight";
		const deadLettered = deadLetterPendingExtractionJobs(getDbAccessor(), {
			reason: blockedReason,
			extractionModel: effectiveExtractionModel || undefined,
		});
		if (deadLettered > 0) {
			logger.warn("pipeline", "Dead-lettered pending extraction jobs at startup", {
				count: deadLettered,
				reason: blockedReason,
			});
		}
	}
	if (llmProvider) {
		llmProvider = withRateLimit(llmProvider, memoryCfg.pipelineV2.extraction.rateLimit);
		initLlmProvider(llmProvider);
	}

	if (memoryCfg.pipelineV2.modelRegistry.enabled && !pipelinePaused) {
		const registryAnthropicApiKey = anthropicApiKey ?? (await getKey("ANTHROPIC_API_KEY"));
		const registryOpenRouterApiKey = openRouterApiKey ?? (await getKey("OPENROUTER_API_KEY"));
		initModelRegistry(
			memoryCfg.pipelineV2.modelRegistry,
			effectiveExtractionProvider === "ollama" ? extractionOllamaBaseUrl : undefined,
			registryAnthropicApiKey,
			registryOpenRouterApiKey,
			effectiveExtractionProvider === "openrouter" ? extractionOpenRouterBaseUrl : undefined,
			effectiveExtractionProvider === "llama-cpp" ? extractionLlamaCppBaseUrl : undefined,
		);
	}

	if (pipelinePaused) {
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
			effective: null,
		};
		logger.info("config", "Pipeline paused; synthesis provider startup deferred");
	} else if (memoryCfg.pipelineV2.synthesis.provider === "none") {
		logger.info("config", "Synthesis provider set to 'none', synthesis disabled");
	} else if (memoryCfg.pipelineV2.synthesis.enabled) {
		let effectiveSynthesisProvider = memoryCfg.pipelineV2.synthesis.provider;
		const synthesisFallback =
			extractionFallbackProvider === "llama-cpp"
				? "llama-cpp"
				: extractionFallbackProvider === "none"
					? null
					: "ollama";
		const synthesisOllamaBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"http://127.0.0.1:11434",
		);
		const synthesisOllamaFallbackBaseUrl =
			memoryCfg.pipelineV2.synthesis.provider === "opencode" ? "http://127.0.0.1:11434" : synthesisOllamaBaseUrl;
		const synthesisLlamaCppBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"http://127.0.0.1:8080",
		);
		const synthesisOpenCodeBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"http://127.0.0.1:4096",
		);
		const synthesisOpenRouterBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"https://openrouter.ai/api/v1",
		);
		const synthesisOpenCodeShouldManage = isManagedOpenCodeLocalEndpoint(synthesisOpenCodeBaseUrl);
		if (effectiveSynthesisProvider === "opencode") {
			if (synthesisOpenCodeShouldManage) {
				const serverReady = await ensureOpenCodeServer(4096);
				if (!serverReady) {
					if (synthesisFallback) {
						logger.warn("config", `OpenCode server not available for synthesis, falling back to ${synthesisFallback}`);
						effectiveSynthesisProvider = synthesisFallback;
					} else {
						logger.warn(
							"config",
							"OpenCode server not available for synthesis, fallback disabled (fallbackProvider: none)",
						);
						effectiveSynthesisProvider = "none";
					}
				}
			} else {
				logger.info("config", "Using external OpenCode endpoint for synthesis", {
					baseUrl: redactUrlForLogs(synthesisOpenCodeBaseUrl),
				});
			}
		} else if (effectiveSynthesisProvider === "anthropic") {
			if (!anthropicApiKey) {
				if (synthesisFallback) {
					logger.warn("config", `ANTHROPIC_API_KEY not found for synthesis, falling back to ${synthesisFallback}`);
					effectiveSynthesisProvider = synthesisFallback;
				} else {
					logger.warn(
						"config",
						"ANTHROPIC_API_KEY not found for synthesis, fallback disabled (fallbackProvider: none)",
					);
					effectiveSynthesisProvider = "none";
				}
			}
		} else if (effectiveSynthesisProvider === "openrouter") {
			if (!openRouterApiKey) {
				if (synthesisFallback) {
					logger.warn("config", `OPENROUTER_API_KEY not found for synthesis, falling back to ${synthesisFallback}`);
					effectiveSynthesisProvider = synthesisFallback;
				} else {
					logger.warn(
						"config",
						"OPENROUTER_API_KEY not found for synthesis, fallback disabled (fallbackProvider: none)",
					);
					effectiveSynthesisProvider = "none";
				}
			}
		} else if (effectiveSynthesisProvider === "claude-code") {
			const resolvedClaude = Bun.which("claude");
			if (resolvedClaude === null) {
				if (synthesisFallback) {
					logger.warn("config", `Claude Code CLI not found, falling back to ${synthesisFallback} for synthesis`);
					effectiveSynthesisProvider = synthesisFallback;
				} else {
					logger.warn("config", "Claude Code CLI not found, fallback disabled (fallbackProvider: none)");
					effectiveSynthesisProvider = "none";
				}
			} else {
				try {
					const exitCode = await new Promise<number>((resolve) => {
						const proc = spawn(resolvedClaude, ["--version"], {
							stdio: "pipe",
							windowsHide: true,
							env: { ...process.env, SIGNET_NO_HOOKS: "1" },
						});
						proc.on("close", (code) => resolve(code ?? 1));
						proc.on("error", () => resolve(1));
					});
					if (exitCode !== 0) throw new Error("non-zero exit");
				} catch {
					if (synthesisFallback) {
						logger.warn("config", `Claude Code CLI not found, falling back to ${synthesisFallback} for synthesis`);
						effectiveSynthesisProvider = synthesisFallback;
					} else {
						logger.warn("config", "Claude Code CLI not found, fallback disabled (fallbackProvider: none)");
						effectiveSynthesisProvider = "none";
					}
				}
			}
		} else if (effectiveSynthesisProvider === "codex") {
			const resolvedCodex = Bun.which("codex");
			if (resolvedCodex === null) {
				if (synthesisFallback) {
					logger.warn("config", `Codex CLI not found, falling back to ${synthesisFallback} for synthesis`);
					effectiveSynthesisProvider = synthesisFallback;
				} else {
					logger.warn("config", "Codex CLI not found, fallback disabled (fallbackProvider: none)");
					effectiveSynthesisProvider = "none";
				}
			} else {
				try {
					const exitCode = await new Promise<number>((resolve) => {
						const proc = spawn(resolvedCodex, ["--version"], {
							stdio: "pipe",
							windowsHide: true,
							env: {
								...process.env,
								SIGNET_NO_HOOKS: "1",
								SIGNET_CODEX_BYPASS_WRAPPER: "1",
							},
						});
						proc.on("close", (code) => resolve(code ?? 1));
						proc.on("error", () => resolve(1));
					});
					if (exitCode !== 0) throw new Error("non-zero exit");
				} catch {
					if (synthesisFallback) {
						logger.warn("config", `Codex CLI not found, falling back to ${synthesisFallback} for synthesis`);
						effectiveSynthesisProvider = synthesisFallback;
					} else {
						logger.warn("config", "Codex CLI not found, fallback disabled (fallbackProvider: none)");
						effectiveSynthesisProvider = "none";
					}
				}
			}
		}
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.provider,
			effective: effectiveSynthesisProvider,
		};
		if (providerHints.synthesis && providerHints.synthesis !== effectiveSynthesisProvider) {
			logger.warn("config", "Synthesis provider resolved differently than configured", {
				configured: providerHints.synthesis,
				resolved: memoryCfg.pipelineV2.synthesis.provider,
				effective: effectiveSynthesisProvider,
			});
		}
		logger.info("config", "Synthesis provider", {
			configured: providerHints.synthesis,
			resolved: memoryCfg.pipelineV2.synthesis.provider,
			effective: effectiveSynthesisProvider,
			endpoint: redactUrlForLogs(
				effectiveSynthesisProvider === "ollama"
					? synthesisOllamaFallbackBaseUrl
					: effectiveSynthesisProvider === "llama-cpp"
						? synthesisLlamaCppBaseUrl
						: effectiveSynthesisProvider === "opencode"
							? synthesisOpenCodeBaseUrl
							: effectiveSynthesisProvider === "openrouter"
								? synthesisOpenRouterBaseUrl
								: undefined,
			),
		});

		const effectiveSynthesisModel = resolveRuntimeModel(
			effectiveSynthesisProvider,
			memoryCfg.pipelineV2.synthesis.provider,
			memoryCfg.pipelineV2.synthesis.model,
		);
		const usingSynthesisLocalFallback =
			(effectiveSynthesisProvider === "ollama" || effectiveSynthesisProvider === "llama-cpp") &&
			memoryCfg.pipelineV2.synthesis.provider !== effectiveSynthesisProvider;

		let synthesisProvider =
			effectiveSynthesisProvider === "anthropic" && anthropicApiKey
				? createAnthropicProvider({
						model: effectiveSynthesisModel || "haiku",
						apiKey: anthropicApiKey,
						defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
					})
				: effectiveSynthesisProvider === "openrouter" && openRouterApiKey
					? createOpenRouterProvider({
							model: effectiveSynthesisModel || "openai/gpt-4o-mini",
							apiKey: openRouterApiKey,
							baseUrl: synthesisOpenRouterBaseUrl,
							referer: readEnvTrimmed("OPENROUTER_HTTP_REFERER"),
							title: readEnvTrimmed("OPENROUTER_TITLE"),
							defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
						})
					: effectiveSynthesisProvider === "opencode"
						? createOpenCodeProvider({
								model: effectiveSynthesisModel || "anthropic/claude-haiku-4-5-20251001",
								baseUrl: synthesisOpenCodeBaseUrl,
								ollamaFallbackBaseUrl: synthesisOllamaFallbackBaseUrl,
								ollamaFallbackMaxContextTokens: ollamaFallbackMaxContextTokens,
								defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
								enableStructuredOutput: memoryCfg.pipelineV2.synthesis.structuredOutput,
							})
						: effectiveSynthesisProvider === "codex"
							? createCodexProvider({
									model: effectiveSynthesisModel || "gpt-5-codex-mini",
									defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
								})
							: effectiveSynthesisProvider === "claude-code"
								? createClaudeCodeProvider({
										model: effectiveSynthesisModel || "haiku",
										defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
									})
								: effectiveSynthesisProvider === "llama-cpp"
									? createLlamaCppProvider({
											model: effectiveSynthesisModel || "qwen3.5:4b",
											baseUrl: synthesisLlamaCppBaseUrl,
											defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
										})
									: createOllamaProvider({
											...(effectiveSynthesisModel ? { model: effectiveSynthesisModel } : {}),
											baseUrl: synthesisOllamaFallbackBaseUrl,
											defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
											...(usingSynthesisLocalFallback
												? {
														maxContextTokens: ollamaFallbackMaxContextTokens,
													}
												: {}),
										});
		initSynthesisProvider(synthesisProvider);
		const widgetProvider = synthesisProvider;
		synthesisProvider = withRateLimit(synthesisProvider, memoryCfg.pipelineV2.synthesis.rateLimit);
		initSynthesisProvider(synthesisProvider);
		// Widget generation uses the same model family by default, but should not
		// consume the background synthesis rate-limit budget.
		if (
			memoryCfg.pipelineV2.synthesis.rateLimit !== undefined &&
			Object.keys(memoryCfg.pipelineV2.synthesis.rateLimit).length > 0
		) {
			logger.info("pipeline", "Widget synthesis provider is exempt from the synthesis rate limit", {
				rateLimit: memoryCfg.pipelineV2.synthesis.rateLimit,
			});
		}
		initWidgetProvider(widgetProvider);
	} else {
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: null,
			effective: null,
		};
		logger.info("config", "Synthesis disabled");
	}

	if (memoryCfg.pipelineV2.enabled && !pipelinePaused && effectiveExtractionProvider !== "none") {
		startPipeline(
			getDbAccessor(),
			memoryCfg.pipelineV2,
			memoryCfg.embedding,
			fetchEmbedding,
			memoryCfg.search,
			resolveDaemonAgentId(),
			providerTracker,
			analyticsCollector,
			telemetry,
		);
	} else {
		ensureRetentionWorker(getDbAccessor(), DEFAULT_RETENTION);
	}

	if (memoryCfg.embedding.provider !== "none" && memoryCfg.pipelineV2.embeddingTracker.enabled && !pipelinePaused) {
		embeddingTrackerHandle = startEmbeddingTracker(
			getDbAccessor(),
			memoryCfg.embedding,
			memoryCfg.pipelineV2.embeddingTracker,
			fetchEmbedding,
			checkEmbeddingProvider,
		);
		setEmbeddingTrackerHandle(embeddingTrackerHandle);
	}

	if (memoryCfg.dreaming.enabled && !pipelinePaused && !memoryCfg.pipelineV2.mutationsFrozen) {
		try {
			dreamingWorkerHandle = startDreamingWorker(getDbAccessor(), memoryCfg.dreaming, AGENTS_DIR, resolveAgentId({}));
			setDreamingWorker(dreamingWorkerHandle);
		} catch (err) {
			logger.warn("dreaming", "Failed to start dreaming worker (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (memoryCfg.pipelineV2.graph.enabled && memoryCfg.pipelineV2.structural.enabled && !pipelinePaused) {
		const backfillCtx: RepairContext = {
			reason: "post-upgrade structural backfill",
			actor: "daemon",
			actorType: "daemon",
		};
		structuralBackfillTimer = setTimeout(() => {
			structuralBackfillTimer = null;
			try {
				const result = structuralBackfill(getDbAccessor(), memoryCfg.pipelineV2, backfillCtx, repairLimiter, {
					batchSize: 50,
				});
				if (result.affected > 0) {
					logger.info("pipeline", "Structural backfill completed", {
						affected: result.affected,
						message: result.message,
					});
				}
			} catch (err) {
				logger.warn("pipeline", "Structural backfill failed (non-fatal)", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}, 10_000);
	}

	if (memoryCfg.pipelineV2.predictor?.enabled && !pipelinePaused) {
		const predictorCfg = memoryCfg.pipelineV2.predictor;
		try {
			const client = createPredictorClient(predictorCfg, "default", memoryCfg.embedding.dimensions);
			await client.start();
			predictorClientRef = client;
			setPredictorClientRef(client);
			logger.info("predictor", "Predictor sidecar started");
		} catch (err) {
			logger.warn("predictor", "Failed to start predictor sidecar (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (memoryCfg.pipelineV2.nativeShadowEnabled) {
		const binary = resolveDaemonBinary();
		if (binary) {
			const shadowAgentsDir = setupShadowDb(AGENTS_DIR);
			shadowProcess = spawn(binary, [], {
				env: { ...process.env, SIGNET_PORT: "3851", SIGNET_PATH: shadowAgentsDir },
				stdio: "ignore",
				windowsHide: true,
			});
			shadowProcess.unref();
			logger.info("shadow", "Rust daemon shadow started", {
				pid: shadowProcess.pid,
				port: 3851,
			});
		} else {
			logger.warn("shadow", "shadowEnabled but signet-daemon binary not found — skipping");
		}
	}

	if (memoryCfg.pipelineV2.procedural.enabled && !pipelinePaused) {
		skillReconcilerHandle = startReconciler({
			accessor: getDbAccessor(),
			pipelineConfig: memoryCfg.pipelineV2,
			embeddingConfig: memoryCfg.embedding,
			fetchEmbedding,
			getProvider: () => {
				try {
					return getLlmProvider();
				} catch {
					return null;
				}
			},
			agentsDir: AGENTS_DIR,
		});
	}

	invalidateDiagnosticsCache();
}

setRestartPipelineRuntime(restartPipelineRuntime);

// ============================================================================
// Shutdown
// ============================================================================

async function cleanup() {
	setShuttingDown(true);
	bindAbort.abort();
	logger.info("daemon", "Shutting down");

	if (httpServer) {
		const srv = httpServer;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				logger.warn("daemon", "HTTP server drain timed out, forcing close");
				if ("closeAllConnections" in srv && typeof srv.closeAllConnections === "function") {
					srv.closeAllConnections();
				}
				resolve();
			}, 15_000);
			srv.close(() => {
				clearTimeout(timeout);
				resolve();
			});
		});
		httpServer = null;
	}

	if (syncTimer) {
		clearTimeout(syncTimer);
		syncTimer = null;
	}

	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		setHeartbeatTimer(undefined);
	}
	if (checkpointPruneTimer) {
		clearInterval(checkpointPruneTimer);
		checkpointPruneTimer = undefined;
		setCheckpointPruneTimer(undefined);
	}
	if (telemetryRef) {
		try {
			await telemetryRef.stop();
		} catch {}
		telemetryRef = undefined;
		setTelemetryRef(undefined);
	}

	try {
		flushPendingCheckpoints();
	} catch {}

	await stopPipelineRuntime();

	try {
		const { shutdownNativeProvider } = await import("./native-embedding");
		await shutdownNativeProvider();
	} catch {}

	const released = releaseAllSessions();
	const cleared = clearAllPresence();
	if (released > 0 || cleared > 0) {
		logger.info("daemon", "Cleaned cross-agent state", { sessions: released, presence: cleared });
	}

	stopSessionCleanup();

	await stopGitSyncTimer();
	stopUpdateTimer();

	closeDbAccessor();

	if (watcher) {
		watcher.close();
	}

	if (existsSync(PID_FILE)) {
		try {
			unlinkSync(PID_FILE);
		} catch {}
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
	if (shuttingDown) return;
	setShuttingDown(true);
	cleanup().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
	logger.error("daemon", "Unhandled rejection", {
		error: reason instanceof Error ? reason : String(reason),
		stack: reason instanceof Error ? reason.stack : undefined,
	});
	if (shuttingDown) return;
	setShuttingDown(true);
	cleanup().finally(() => process.exit(1));
});

// ============================================================================
// Main
// ============================================================================

async function main() {
	logger.info("daemon", "Signet Daemon starting");
	logger.info("daemon", "Agents directory", { path: AGENTS_DIR });
	logger.info("daemon", "Network configured", { port: PORT, host: HOST, bindHost: BIND_HOST });

	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	initDbAccessor(MEMORY_DB, { agentsDir: AGENTS_DIR });
	startSessionCleanup();

	syncAgentRoster(AGENTS_DIR);

	invalidateTraversalCache();

	writeFileSync(PID_FILE, process.pid.toString());
	logger.info("daemon", "Process ID", { pid: process.pid });

	try {
		migrateConfig(AGENTS_DIR);
	} catch (err) {
		logger.warn("config-migration", "Config migration failed; continuing startup", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	startFileWatcher();
	logger.info("watcher", "File watcher started");

	await ensureArchitectureDoc();

	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	let telemetryCollector: TelemetryCollector | undefined;
	if (memoryCfg.pipelineV2.telemetryEnabled) {
		let posthogApiKey = memoryCfg.pipelineV2.telemetry.posthogApiKey;
		if (!posthogApiKey) {
			try {
				posthogApiKey = await getSecret("POSTHOG_API_KEY");
			} catch {
				posthogApiKey = "";
			}
		}
		const resolvedTelemetryCfg = {
			...memoryCfg.pipelineV2.telemetry,
			posthogApiKey,
		};
		telemetryCollector = createTelemetryCollector(getDbAccessor(), resolvedTelemetryCfg, CURRENT_VERSION);
		telemetryCollector.start();
		telemetryRef = telemetryCollector;
		setTelemetryRef(telemetryCollector);

		const daemonStartTime = Date.now();
		heartbeatTimer = setInterval(
			() => {
				if (!telemetryRef) return;
				try {
					const liveCfg = loadMemoryConfig(AGENTS_DIR);
					const memoryCount = getDbAccessor().withReadDb((db) => {
						const row = db
							.prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 0 OR is_deleted IS NULL")
							.get() as { cnt: number } | undefined;
						return row?.cnt ?? 0;
					});
					const connectors = listConnectors(getDbAccessor());
					telemetryRef.record("daemon.heartbeat", {
						uptimeMs: Date.now() - daemonStartTime,
						memoryCount,
						connectorsActive: connectors.filter((cn) => cn.status === "active").length,
						pipelineMode: readPipelineMode(liveCfg.pipelineV2),
						extractionProvider: liveCfg.pipelineV2.extraction.provider,
						embeddingProvider: liveCfg.embedding.provider,
					});
				} catch {}
			},
			5 * 60 * 1000,
		);
		setHeartbeatTimer(heartbeatTimer);
	}

	await startPipelineRuntime(memoryCfg, telemetryCollector);

	initCheckpointFlush(getDbAccessor());

	schedulerHandle = startSchedulerWorker(getDbAccessor());

	checkpointPruneTimer = setInterval(() => {
		try {
			const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
			if (cfg.enabled) {
				pruneCheckpoints(getDbAccessor(), cfg.retentionDays);
			}
		} catch (err) {
			logger.warn("daemon", "Checkpoint pruning failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, 3600_000);
	setCheckpointPruneTimer(checkpointPruneTimer);

	startGitSyncTimer();
	initUpdateSystem(CURRENT_VERSION, AGENTS_DIR, () => {
		const daemonScript = process.argv[1] ?? "";
		if (!daemonScript) {
			logger.warn("daemon", "Cannot self-restart: process.argv[1] is empty, falling back to clean exit");
			setTimeout(() => {
				process.exit(0);
			}, 500);
			return;
		}

		logger.info("daemon", "Spawning replacement daemon process", {
			execPath: process.execPath,
			script: daemonScript,
		});

		const replacement = spawn(process.execPath, [daemonScript], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: {
				...process.env,
				SIGNET_PORT: String(PORT),
				SIGNET_HOST: HOST,
				SIGNET_BIND: BIND_HOST,
				SIGNET_PATH: AGENTS_DIR,
			},
		});
		replacement.unref();

		logger.info("daemon", "Replacement daemon spawned, exiting current process");
		setTimeout(() => {
			process.exit(0);
		}, 500);
	});
	initFeatureFlags(AGENTS_DIR);
	startUpdateTimer();

	const REQUEST_BODY_LIMIT = 10 * 1_048_576;
	const { createServer: nodeCreateServer } = await import("node:http");
	const createBoundedServer: typeof nodeCreateServer = (...args: Parameters<typeof nodeCreateServer>) => {
		const server = nodeCreateServer(...args);
		server.on("request", (req, res) => {
			let bytes = 0;
			let aborted = false;
			req.on("data", (chunk: Buffer) => {
				if (aborted) return;
				bytes += chunk.length;
				if (bytes > REQUEST_BODY_LIMIT) {
					aborted = true;
					logger.warn("http", "Request body exceeded limit", { bytes, limit: REQUEST_BODY_LIMIT });
					if (!res.headersSent) {
						res.writeHead(413, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "payload too large" }), () => {
							req.socket?.destroy();
						});
					}
				}
			});
		});
		return server;
	};

	const BIND_MAX_DELAY_MS = 30_000;
	const BIND_RETRY_BASE_MS = 1000;

	const onListening = (info: { address: string; port: number }): void => {
		logger.info("daemon", "Server listening", {
			address: info.address,
			port: info.port,
		});
		logger.info("daemon", "Daemon ready");

		const healthStampPath = join(DAEMON_DIR, "last-healthy-start");
		try {
			let previousVersion: string | null = null;
			if (existsSync(healthStampPath)) {
				const prev = JSON.parse(readFileSync(healthStampPath, "utf-8"));
				previousVersion = typeof prev.version === "string" ? prev.version : null;
			}
			writeFileSync(
				healthStampPath,
				JSON.stringify({
					version: CURRENT_VERSION,
					startedAt: new Date().toISOString(),
					pid: process.pid,
				}),
			);
			if (previousVersion && previousVersion !== CURRENT_VERSION && CURRENT_VERSION !== "0.0.0") {
				logger.info("daemon", `Upgraded from ${previousVersion} to ${CURRENT_VERSION}`, {
					previousVersion,
					currentVersion: CURRENT_VERSION,
				});
				logger.info(
					"daemon",
					"What's new: knowledge graph, session continuity, constellation entity overlay, predictive scorer (opt-in)",
				);
			}
		} catch {}

		importExistingMemoryFiles().catch((e) => {
			const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
			logger.error("daemon", "Failed to import existing memory files", undefined, errDetails);
		});

		const claudeProjectsDir = join(homedir(), ".claude", "projects");
		if (existsSync(claudeProjectsDir)) {
			syncExistingClaudeMemories(claudeProjectsDir);
		}
	};

	bindWithRetry({
		port: PORT,
		hostname: BIND_HOST,
		signal: bindAbort.signal,
		maxDelayMs: BIND_MAX_DELAY_MS,
		baseDelayMs: BIND_RETRY_BASE_MS,
		createServer: () =>
			createAdaptorServer({
				fetch: app.fetch,
				hostname: BIND_HOST,
				createServer: createBoundedServer,
			}),
		onBound: (server) => {
			httpServer = server;
		},
		onListening,
	});
}

if (import.meta.main) {
	main().catch((err) => {
		logger.error("daemon", "Fatal error", err);
		process.exit(1);
	});
}
