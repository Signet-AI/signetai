#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import type { Database } from "bun:sqlite";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync } from "node:fs";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
	CONNECTOR_PROVIDERS,
	type AgentDefinition,
	type ConnectorConfig,
	SIGNET_GIT_PROTECTED_PATHS,
	type SyncCursor,
	buildArchitectureDoc,
	buildSignetBlock,
	keywordSearch,
	mergeSignetGitignoreEntries,
	networkModeFromBindHost,
	parseSimpleYaml,
	readNetworkMode,
	readPipelinePauseState,
	resolveNetworkBinding,
	setPipelinePaused,
	stripSignetBlock,
	vectorSearch,
} from "@signet/core";
import { watch } from "chokidar";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { type AnalyticsCollector, type ErrorStage, createAnalyticsCollector } from "./analytics";
import {
	type AuthConfig,
	AuthRateLimiter,
	type TokenRole,
	type TokenScope,
	checkScope,
	createAuthMiddleware,
	createToken,
	loadOrCreateSecret,
	parseAuthConfig,
	requirePermission,
	requireRateLimit,
	requireScope,
} from "./auth";
import { resolveScopedAgent, resolveScopedProject as resolveScopedProjectForClaims, shouldEnforceScope } from "./request-scope";
import { migrateConfig } from "./config-migration";
import { createFilesystemConnector } from "./connectors/filesystem";
import {
	getConnector,
	listConnectors,
	registerConnector,
	removeConnector,
	updateConnectorStatus,
	updateCursor,
} from "./connectors/registry";
import { normalizeAndHashContent } from "./content-normalization";
import {
	type AgentMessage,
	type AgentMessageType,
	createAgentMessage,
	getAgentPresenceForSession,
	clearAllPresence,
	isMessageVisibleToAgent,
	listAgentMessages,
	listAgentPresence,
	relayMessageViaAcp,
	removeAgentPresence,
	subscribeCrossAgentEvents,
	touchAgentPresence,
	upsertAgentPresence,
} from "./cross-agent";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert, vectorToBlob } from "./db-helpers";
import {
	type DiagnosticsReport,
	type PredictorHealthParams,
	createProviderTracker,
	getDiagnostics,
	getPredictorHealth,
} from "./diagnostics";
import {
	fetchEmbedding,
	resolveEmbeddingApiKey,
	resolveEmbeddingBaseUrl,
	resolveOllamaUrl,
	setNativeFallbackToOllama,
} from "./embedding-fetch";
import { buildEmbeddingHealth } from "./embedding-health";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { getAllFeatureFlags, initFeatureFlags } from "./feature-flags";
import {
	getAttributesForAspectFiltered,
	getEntityAspectsWithCounts,
	getEntityDependenciesDetailed,
	getEntityHealth,
	getKnowledgeEntityDetail,
	getKnowledgeGraphForConstellation,
	getKnowledgeStats,
	getPinnedEntities,
	listKnowledgeEntities,
	pinEntity,
	unpinEntity,
} from "./knowledge-graph";
import { closeLlmProvider, getLlmProvider, initLlmProvider } from "./llm";
import { type LogEntry, logger } from "./logger";
import { type EmbeddingConfig, type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { walkImpact } from "./graph-impact";
import { buildMemoryTimeline } from "./memory-timeline";
import { type RecallParams, hybridRecall } from "./memory-search";
import { getAgentScope, resolveAgentId } from "./agent-id";
import { ONEPASSWORD_SERVICE_ACCOUNT_SECRET, importOnePasswordSecrets, listOnePasswordVaults } from "./onepassword.js";
import { expandTemporalNode } from "./temporal-expand";
import {
	DEFAULT_RETENTION,
	enqueueDocumentIngestJob,
	enqueueExtractionJob,
	getPipelineWorkerStatus,
	ensureRetentionWorker,
	getSynthesisWorker,
	nudgeExtractionWorker,
	readLastSynthesisTime,
	startPipeline,
	stopPipeline,
} from "./pipeline";
import { clusterEntities } from "./pipeline/community-detection";
import { getFeedbackTelemetry } from "./pipeline/aspect-feedback";
import { getGraphBoostIds } from "./pipeline/graph-search";
import { linkMemoryToEntities } from "./inline-entity-linker";
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
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createOllamaProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	ensureOpenCodeServer,
	resolveDefaultOllamaFallbackMaxContextTokens,
	stopOpenCodeServer,
} from "./pipeline/provider";
import { resolveRuntimeModel } from "./pipeline/provider-resolution";
import { type RerankCandidate, noopReranker, rerank } from "./pipeline/reranker";
import { createEmbeddingReranker } from "./pipeline/reranker-embedding";
import { type PredictorClient, createPredictorClient, resolvePredictorCheckpointPath } from "./predictor-client";
import { detectDrift } from "./predictor-comparison";
import {
	getComparisonsByEntity,
	getComparisonsByProject,
	listComparisons,
	listTrainingRuns,
} from "./predictor-comparisons";
import { getPredictorState } from "./predictor-state";
import {
	type RepairContext,
	type RepairResult,
	backfillSkippedSessions,
	checkFtsConsistency,
	cleanOrphanedEmbeddings,
	createRateLimiter,
	deduplicateMemories,
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
	triggerRetentionSweep,
	findDeadMemories,
	forgetDeadMemories,
} from "./repair-actions";
import {
	CRON_PRESETS,
	computeNextRun,
	isHarnessAvailable,
	resolveSkillPrompt,
	startSchedulerWorker,
	validateCron,
} from "./scheduler";
import { emitTaskStream, getTaskStreamSnapshot, subscribeTaskStream } from "./scheduler/task-stream";
import { deleteSecret, execWithSecrets, getSecret, hasSecret, listSecrets, putSecret } from "./secrets.js";
import {
	flushPendingCheckpoints,
	getCheckpointsByProject,
	getCheckpointsBySession,
	initCheckpointFlush,
	pruneCheckpoints,
	redactCheckpointRow,
} from "./session-checkpoints";
import { parseFeedback, recordAgentFeedback } from "./session-memories";
import { recordPathFeedback } from "./path-feedback";
import { closeSynthesisProvider, initSynthesisProvider } from "./synthesis-llm";
import { type TelemetryCollector, type TelemetryEventType, createTelemetryCollector } from "./telemetry";
import { type TimelineSources, buildTimeline } from "./timeline";
import {
	type MutationContext,
	txFinalizeAccessAndHistory,
	txForgetMemory,
	txIngestEnvelope,
	txModifyMemory,
	txRecoverMemory,
} from "./transactions";
import { cacheProjection, computeProjection, computeProjectionForQuery, getCachedProjection } from "./umap-projection";
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
import { closeWidgetProvider, initWidgetProvider } from "./widget-llm";

// Paths
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const DAEMON_DIR = join(AGENTS_DIR, ".daemon");
const PID_FILE = join(DAEMON_DIR, "pid");
const LOG_DIR = join(DAEMON_DIR, "logs");
const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");
const SCRIPTS_DIR = join(AGENTS_DIR, "scripts");

// Config
function readEnvTrimmed(key: string): string | undefined {
	const raw = process.env[key];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

function normalizeLoopbackHost(host: string): string {
	return host === "localhost" || host === "::1" ? "127.0.0.1" : host;
}

function parseOriginPort(url: URL): number | null {
	if (url.port.length > 0) {
		const port = Number.parseInt(url.port, 10);
		return Number.isInteger(port) ? port : null;
	}
	if (url.protocol === "http:") return 80;
	if (url.protocol === "https:") return 443;
	return null;
}

function normalizeOriginHost(host: string): string {
	return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackOriginHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}

function isTailscaleOriginHost(host: string): boolean {
	if (host.endsWith(".ts.net")) return true;
	if (host.startsWith("fd7a:115c:a1e0:")) return true;
	if (!host.startsWith("100.")) return false;
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	const second = Number.parseInt(parts[1], 10);
	return Number.isInteger(second) && second >= 64 && second <= 127;
}

function isAllowedOrigin(origin: string | undefined): boolean {
	if (!origin) return false;
	if (ALLOWED_ORIGINS.has(origin)) return true;
	if (NETWORK_MODE !== "tailscale") return false;

	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (parseOriginPort(url) !== PORT) return false;
		const host = normalizeOriginHost(url.hostname);
		if (isLoopbackOriginHost(host)) return false;
		return isTailscaleOriginHost(host);
	} catch {
		return false;
	}
}

function readConfiguredNetworkBinding(agentsDir: string): {
	readonly host: string;
	readonly bind: string;
} {
	for (const name of ["agent.yaml", "AGENT.yaml"]) {
		const path = join(agentsDir, name);
		if (!existsSync(path)) continue;
		try {
			return resolveNetworkBinding(readNetworkMode(parseSimpleYaml(readFileSync(path, "utf-8"))));
		} catch {
			// Ignore malformed config and keep scanning fallbacks.
		}
	}

	return resolveNetworkBinding("localhost");
}

function parsePort(raw: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

function normalizeRuntimeBaseUrl(url: string | undefined, fallback: string): string {
	const base = normalizeBaseUrl(url) ?? fallback;
	try {
		const parsed = new URL(base);
		if (parsed.hostname === "localhost" || parsed.hostname === "::1") {
			parsed.hostname = "127.0.0.1";
		}
		return normalizeBaseUrl(parsed.toString()) ?? fallback;
	} catch {
		return base;
	}
}

/**
 * Resolve the Ollama base URL for the model registry, returning undefined
 * when the current provider is not Ollama.
 */
function resolveRegistryOllamaBaseUrl(provider: string, endpoint: string | undefined): string | undefined {
	if (provider !== "ollama") return undefined;
	return normalizeRuntimeBaseUrl(endpoint, "http://127.0.0.1:11434");
}

function resolveRegistryOpenRouterBaseUrl(provider: string, endpoint: string | undefined): string | undefined {
	if (provider !== "openrouter") return undefined;
	return normalizeRuntimeBaseUrl(endpoint, "https://openrouter.ai/api/v1");
}

function isManagedOpenCodeLocalEndpoint(baseUrl: string): boolean {
	try {
		const parsed = new URL(baseUrl);
		const isLoopbackHost =
			parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
		if (!isLoopbackHost) return false;
		if (parsed.protocol !== "http:") return false;
		const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
		return port === 4096;
	} catch {
		return false;
	}
}

function redactUrlForLogs(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return normalizeBaseUrl(parsed.toString()) ?? url;
	} catch {
		return url;
	}
}

const PORT = parsePort(readEnvTrimmed("SIGNET_PORT"), 3850);
const NET = readConfiguredNetworkBinding(AGENTS_DIR);
const HOST = normalizeLoopbackHost(readEnvTrimmed("SIGNET_HOST") ?? NET.host);
const BIND_HOST = normalizeLoopbackHost(readEnvTrimmed("SIGNET_BIND") ?? NET.bind);
const NETWORK_MODE = networkModeFromBindHost(BIND_HOST);
const INTERNAL_SELF_HOST = BIND_HOST === "0.0.0.0" || BIND_HOST === "::" ? "127.0.0.1" : BIND_HOST;

type RuntimeProviderName =
	| "none"
	| "ollama"
	| "claude-code"
	| "opencode"
	| "codex"
	| "anthropic"
	| "openrouter";

type RuntimeSynthesisProviderName =
	| "none"
	| "ollama"
	| "claude-code"
	| "opencode"
	| "anthropic"
	| "openrouter";

interface ProviderRuntimeResolution {
	extraction: {
		configured: string | null;
		resolved: RuntimeProviderName;
		effective: RuntimeProviderName;
	};
	synthesis: {
		configured: string | null;
		resolved: RuntimeSynthesisProviderName | null;
		effective: RuntimeSynthesisProviderName | null;
	};
}

const providerRuntimeResolution: ProviderRuntimeResolution = {
	extraction: {
		configured: null,
		resolved: "claude-code",
		effective: "claude-code",
	},
	synthesis: {
		configured: null,
		resolved: null,
		effective: null,
	},
};

// Autonomous maintenance singletons
const providerTracker = createProviderTracker();
const analyticsCollector = createAnalyticsCollector();
const repairLimiter = createRateLimiter();

// Telemetry — assigned in main(), read by cleanup()
let telemetryRef: TelemetryCollector | undefined;
let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
let predictorClientRef: PredictorClient | null = null;
let shadowProcess: ChildProcess | null = null;
let skillReconcilerHandle: ReconcilerHandle | null = null;
let structuralBackfillTimer: ReturnType<typeof setTimeout> | null = null;
let pipelineTransition = false;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let checkpointPruneTimer: ReturnType<typeof setInterval> | undefined;
let httpServer: ReturnType<typeof serve> | null = null;
let shuttingDown = false;
let diagnosticsCache: {
	readonly report: DiagnosticsReport;
	readonly expiresAt: number;
} | null = null;
const DIAGNOSTICS_CACHE_TTL_MS = 2000;

// OpenClaw plugin health — updated by POST /api/diagnostics/openclaw/heartbeat
interface OpenClawHeartbeatData {
	readonly pluginVersion: string;
	readonly hooksRegistered: string[];
	readonly lastHookCall: string | null;
	readonly lastError: string | null;
	readonly latencyMs: number;
	/** Failures reported in the most recent heartbeat (delta, not cumulative). */
	readonly lastFailedDelta: number;
	readonly totalSucceeded: number;
	readonly totalFailed: number;
}
let openClawHeartbeat: { timestamp: string; data: OpenClawHeartbeatData } | null = null;
const OPENCLAW_STALE_MS = 10 * 60 * 1000; // 10 minutes

// Prevents concurrent UMAP computations for the same dimension count
const projectionInFlight = new Map<number, Promise<void>>();
const projectionErrors = new Map<number, { message: string; expires: number }>();
const PROJECTION_ERROR_TTL_MS = 30_000;
let hasMemoriesSessionIdColumnCache: boolean | null = null;

// Auth state — initialized lazily in main(), but middleware reads from here
let authConfig: AuthConfig = parseAuthConfig(undefined, AGENTS_DIR);
let authSecret: Buffer | null = null;
let authForgetLimiter = new AuthRateLimiter(60_000, 30);
let authModifyLimiter = new AuthRateLimiter(60_000, 60);
let authBatchForgetLimiter = new AuthRateLimiter(60_000, 5);
let authAdminLimiter = new AuthRateLimiter(60_000, 10);
const authCrossAgentMessageLimiter = new AuthRateLimiter(60_000, 120);

function hasMemoriesSessionIdColumn(db: Database): boolean {
	if (hasMemoriesSessionIdColumnCache !== null) {
		return hasMemoriesSessionIdColumnCache;
	}

	hasMemoriesSessionIdColumnCache = (
		db.prepare("PRAGMA table_info(memories)").all() as Array<{
			name?: unknown;
		}>
	).some((column) => column.name === "session_id");
	return hasMemoriesSessionIdColumnCache;
}

/** Public accessor for the predictor client singleton (used by hooks). */
export function getPredictorClient(): PredictorClient | null {
	return predictorClientRef;
}

/** Record predictor latency from hooks (exposed for cross-module use). */
export function recordPredictorLatency(operation: "predictor_score" | "predictor_train", ms: number): void {
	analyticsCollector.recordLatency(operation, ms);
}

function invalidateDiagnosticsCache(): void {
	diagnosticsCache = null;
}

function buildOpenClawHealth(): import("./diagnostics").OpenClawHealth {
	if (!openClawHeartbeat) {
		return { status: "never-seen", lastHeartbeat: null, pluginVersion: null, hooksRegistered: [], hooksSucceeded: 0, hooksFailed: 0, lastLatencyMs: 0, lastError: null };
	}
	const age = Date.now() - new Date(openClawHeartbeat.timestamp).getTime();
	const status = age < OPENCLAW_STALE_MS ? "connected" : "stale";
	const d = openClawHeartbeat.data;
	return {
		status,
		lastHeartbeat: openClawHeartbeat.timestamp,
		pluginVersion: d.pluginVersion,
		hooksRegistered: d.hooksRegistered,
		hooksSucceeded: d.totalSucceeded,
		hooksFailed: d.totalFailed,
		lastLatencyMs: d.latencyMs,
		lastError: d.lastError,
	};
}

function getCachedDiagnosticsReport(): DiagnosticsReport {
	const now = Date.now();
	if (diagnosticsCache !== null && diagnosticsCache.expiresAt > now) {
		return diagnosticsCache.report;
	}

	const report = getDbAccessor().withReadDb((db) =>
		getDiagnostics(db, providerTracker, getUpdateState(), buildPredictorHealthParams(), buildOpenClawHealth()),
	);
	diagnosticsCache = {
		report,
		expiresAt: now + DIAGNOSTICS_CACHE_TTL_MS,
	};
	return report;
}

// ---------------------------------------------------------------------------
// Shadow daemon helpers
// ---------------------------------------------------------------------------

function resolveDaemonBinary(): string | null {
	const ext = process.platform === "win32" ? ".exe" : "";
	const arch = process.arch;
	const plat = process.platform;
	// 1. dev build paths
	const monoRoot = join(import.meta.dir, "..", "..", "..");
	const devPaths = [
		join(monoRoot, "packages", "daemon-rs", "target", "release", `signet-daemon${ext}`),
		join(monoRoot, "packages", "daemon-rs", "target", "debug", `signet-daemon${ext}`),
		join(process.cwd(), "packages", "daemon-rs", "target", "release", `signet-daemon${ext}`),
	];
	for (const p of devPaths) {
		if (existsSync(p)) return p;
	}
	// 2. npm install location (bin/ dir alongside this package)
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
		// Copy WAL and SHM alongside the main DB so the shadow starts from a
		// consistent snapshot — without them it may see uncheckpointed pages as missing.
		copyFileSync(mainDb, shadowDb);
		for (const ext of ["-wal", "-shm"]) {
			const src = mainDb + ext;
			if (existsSync(src)) copyFileSync(src, shadowDb + ext);
		}
		logger.info("shadow", "Shadow DB refreshed");
	}

	// Copy agent.yaml so the shadow daemon uses real config (auth, pipeline flags, etc.)
	// rather than built-in defaults.
	const mainCfg = join(agentsDir, "agent.yaml");
	const shadowCfg = join(shadowRoot, "agent.yaml");
	if (existsSync(mainCfg)) copyFileSync(mainCfg, shadowCfg);

	return shadowRoot;
}

function appendDivergence(agentsDir: string, entry: Record<string, unknown>) {
	const logPath = join(agentsDir, ".daemon", "logs", "shadow-divergences.jsonl");
	appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

/**
 * Build predictor health params from current runtime state.
 * Fail-open: if anything goes wrong reading state, returns disabled.
 */
function buildPredictorHealthParams(): PredictorHealthParams {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const predictorCfg = cfg.pipelineV2.predictor;
	if (!predictorCfg?.enabled) {
		return {
			enabled: false,
			sidecarAlive: false,
			crashCount: 0,
			crashDisabled: false,
			modelVersion: 0,
			trainingSessions: 0,
			successRate: 0,
			alpha: 1.0,
			coldStartExited: false,
			lastTrainedAt: null,
		};
	}

	const client = getPredictorClient();
	const agentId = "default";
	const state = getPredictorState(agentId);

	// Training session count from DB
	let trainingSessions = 0;
	let modelVersion = 0;
	try {
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT COUNT(*) as cnt, MAX(model_version) as ver
				 FROM predictor_training_log
				 WHERE agent_id = ?`,
					)
					.get(agentId) as { cnt: number; ver: number | null } | undefined,
		);
		trainingSessions = row?.cnt ?? 0;
		modelVersion = row?.ver ?? 0;
	} catch {
		// table may not exist
	}

	// Latency from analytics collector
	const latencySnapshot = analyticsCollector.getLatency();
	const avgScoreLatencyMs = latencySnapshot.predictor_score.p50 > 0 ? latencySnapshot.predictor_score.p50 : undefined;

	// Drift detection (fail-open: false on error)
	let driftDetected = false;
	try {
		const accessor = getDbAccessor();
		const driftWindow = predictorCfg.driftResetWindow ?? 20;
		const driftResult = detectDrift(agentId, accessor, driftWindow);
		driftDetected = driftResult.drifting;
	} catch {
		// table may not exist or accessor not ready
	}

	return {
		enabled: true,
		sidecarAlive: client?.isAlive() ?? false,
		crashCount: client?.crashCount ?? 0,
		crashDisabled: client?.crashDisabled ?? false,
		modelVersion,
		trainingSessions,
		successRate: state.successRate,
		alpha: state.alpha,
		coldStartExited: state.coldStartExited,
		lastTrainedAt: state.lastTrainingAt,
		avgScoreLatencyMs,
		scoreTimeoutMs: predictorCfg.scoreTimeoutMs,
		driftDetected,
	};
}

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
	provider: "native" | "ollama" | "openai" | "none";
	model: string;
	available: boolean;
	modelCached?: boolean;
	dimensions?: number;
	base_url: string;
	error?: string;
	checkedAt: string;
}

function blobToVector(blob: Buffer, dimensions: number | null): number[] {
	const raw = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
	const vector = new Float32Array(raw);
	const size =
		typeof dimensions === "number" && dimensions > 0 && dimensions <= vector.length ? dimensions : vector.length;
	return Array.from(vector.slice(0, size));
}

/**
 * Split text into sentence-aware chunks of approximately targetChars.
 * Single sentences exceeding 2x target get hard-split at targetChars.
 */
function chunkBySentence(text: string, targetChars: number): readonly string[] {
	// Split on sentence-ending punctuation followed by whitespace/newline,
	// or on markdown bullet/heading boundaries (preserves list items as units)
	const sentences = text.split(/(?<=[.!?])\s+|(?=^[-*] |\n## )/m).filter(Boolean);
	const raw: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		// If a single sentence exceeds 2x target, hard-split it
		if (sentence.length > targetChars * 2) {
			if (current.length > 0) {
				raw.push(current.trim());
				current = "";
			}
			for (let i = 0; i < sentence.length; i += targetChars) {
				raw.push(sentence.slice(i, i + targetChars).trim());
			}
			continue;
		}

		const combined = current.length > 0 ? `${current} ${sentence}` : sentence;
		if (combined.length > targetChars && current.length > 0) {
			raw.push(current.trim());
			current = sentence;
		} else {
			current = combined;
		}
	}

	if (current.trim().length > 0) {
		raw.push(current.trim());
	}

	const filtered = raw.filter((c) => c.length > 0);
	if (filtered.length <= 1) return filtered;

	// Add overlap: append the first ~25% of the next chunk to each chunk.
	// This ensures information near boundaries appears in both chunks,
	// improving recall when search queries match boundary content.
	const chunks: string[] = [];
	for (let i = 0; i < filtered.length; i++) {
		if (i < filtered.length - 1) {
			const overlap = filtered[i + 1].slice(0, Math.floor(targetChars * 0.25));
			chunks.push(`${filtered[i]} ${overlap}`.trim());
		} else {
			chunks.push(filtered[i]);
		}
	}

	return chunks;
}

function parseTagsField(raw: string | null): string[] {
	if (!raw) return [];

	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((value): value is string => typeof value === "string");
		}
	} catch {
		// Fallback to comma-separated tags.
	}

	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function parseOptionalBoundedInt(raw: string | undefined, min: number, max: number): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.min(max, Math.max(min, parsed));
}

function parseOptionalBoundedFloat(raw: string | undefined, min: number, max: number): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.min(max, Math.max(min, parsed));
}

function parseCsvQuery(raw: string | undefined): string[] {
	if (!raw) return [];
	return [
		...new Set(
			raw
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		),
	];
}

function parseIsoDateQuery(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const value = raw.trim();
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

function getConfiguredProviderHints(agentsDir: string): {
	readonly extraction: string | null;
	readonly synthesis: string | null;
} {
	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml"), join(agentsDir, "config.yaml")];
	let extraction: string | null = null;
	let synthesis: string | null = null;

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = toRecord(parseSimpleYaml(readFileSync(path, "utf-8")));
			const mem = toRecord(yaml?.memory);
			const pipeline = toRecord(mem?.pipelineV2);
			const extractionObj = toRecord(pipeline?.extraction);
			const synthesisObj = toRecord(pipeline?.synthesis);
			const extractionInFile =
				typeof pipeline?.extractionProvider === "string"
					? pipeline.extractionProvider
					: typeof extractionObj?.provider === "string"
						? extractionObj.provider
						: null;
			const synthesisInFile = typeof synthesisObj?.provider === "string" ? synthesisObj.provider : null;
			if (extraction === null && extractionInFile !== null) {
				extraction = extractionInFile;
			}
			if (synthesis === null && synthesisInFile !== null) {
				synthesis = synthesisInFile;
			}
			if (extraction !== null && synthesis !== null) {
				break;
			}
		} catch {}
	}

	return { extraction, synthesis };
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

function defaultLegacyEmbeddingsResponse(limit: number, offset: number, error?: string): LegacyEmbeddingsResponse {
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
		return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	}

	if (typeof raw === "string") {
		return parseTagsField(raw);
	}

	return [];
}

function parseLegacyVector(raw: unknown): number[] | undefined {
	if (Array.isArray(raw)) {
		const values = raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		return values.length > 0 ? values : undefined;
	}

	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				const values = parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
				return values.length > 0 ? values : undefined;
			}
		} catch {
			// Ignore malformed JSON vectors from legacy scripts.
		}
	}

	return undefined;
}

function normalizeLegacyEmbeddingRow(raw: unknown, withVectors: boolean): Record<string, unknown> | null {
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
	const content = typeof rawContent === "string" ? rawContent : String(rawContent);
	const who = typeof row.who === "string" && row.who.length > 0 ? row.who : "unknown";

	const sourceType =
		typeof row.sourceType === "string"
			? row.sourceType
			: typeof row.source_type === "string"
				? row.source_type
				: "memory";

	const sourceIdRaw = row.sourceId ?? row.source_id ?? id;
	const sourceId = typeof sourceIdRaw === "string" || typeof sourceIdRaw === "number" ? String(sourceIdRaw) : id;

	const createdAtRaw = row.createdAt ?? row.created_at;
	const createdAt = typeof createdAtRaw === "string" ? createdAtRaw : undefined;

	const typeValue = typeof row.type === "string" ? row.type : null;
	const importance = typeof row.importance === "number" && Number.isFinite(row.importance) ? row.importance : 0.5;

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
		return defaultLegacyEmbeddingsResponse(limit, offset, "Legacy export returned invalid payload");
	}

	const data: Record<string, unknown> = Object.create(null);
	Object.assign(data, payload);
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

	const resolvedLimit = typeof data.limit === "number" && Number.isFinite(data.limit) ? data.limit : limit;

	const resolvedOffset = typeof data.offset === "number" && Number.isFinite(data.offset) ? data.offset : offset;

	const hasMore = typeof data.hasMore === "boolean" ? data.hasMore : resolvedOffset + resolvedLimit < total;

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
	const scriptPath = join(AGENTS_DIR, "memory", "scripts", "export_embeddings.py");
	if (!existsSync(scriptPath)) {
		return null;
	}

	const args = [scriptPath, "--limit", String(limit), "--offset", String(offset)];
	if (withVectors) {
		args.push("--with-vectors");
	}

	return await new Promise<LegacyEmbeddingsResponse>((resolve) => {
		const timeout = withVectors ? 120000 : 30000;
		const proc = spawn("python3", args, {
			cwd: AGENTS_DIR,
			stdio: "pipe",
			windowsHide: true,
		});

		// Bun's spawn() silently ignores `timeout` — enforce manually
		const timer = setTimeout(() => {
			proc.kill();
			resolve(defaultLegacyEmbeddingsResponse(limit, offset, `Legacy embeddings export timed out after ${timeout}ms`));
		}, timeout);

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
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
				resolve(defaultLegacyEmbeddingsResponse(limit, offset, "Legacy embeddings export returned empty output"));
				return;
			}

			try {
				const parsed: unknown = JSON.parse(stdout);
				resolve(normalizeLegacyEmbeddingsPayload(parsed, withVectors, limit, offset));
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
			clearTimeout(timer);
			resolve(defaultLegacyEmbeddingsResponse(limit, offset, error.message));
		});
	});
}

// Status cache for embedding provider
let cachedEmbeddingStatus: EmbeddingStatus | null = null;
let statusCacheTime = 0;
const STATUS_CACHE_TTL = 30000; // 30 seconds

async function checkEmbeddingProvider(cfg: EmbeddingConfig): Promise<EmbeddingStatus> {
	const now = Date.now();

	// Return cached status if fresh
	if (cachedEmbeddingStatus && now - statusCacheTime < STATUS_CACHE_TTL) {
		return cachedEmbeddingStatus;
	}

	const status: EmbeddingStatus = {
		provider: cfg.provider,
		model: cfg.model,
		base_url: resolveEmbeddingBaseUrl(cfg),
		available: false,
		checkedAt: new Date().toISOString(),
	};

	if (cfg.provider === "none") {
		status.available = false;
		status.error = "Embedding provider set to 'none' — vector search disabled";
		cachedEmbeddingStatus = status;
		statusCacheTime = now;
		return status;
	}

	try {
		if (cfg.provider === "native") {
			// Reuse the cached module from fetchEmbedding path
			const mod = await import("./native-embedding");
			const nativeStatus = await mod.checkNativeProvider();
			status.modelCached = nativeStatus.modelCached;
			if (nativeStatus.available) {
				status.available = true;
				status.dimensions = nativeStatus.dimensions;
			} else {
				// Native unavailable — check if ollama is available as fallback
				logger.warn("embedding", `Native provider unavailable: ${nativeStatus.error ?? "unknown"}`);
				try {
					const ollamaRes = await fetch(`${resolveOllamaUrl().replace(/\/$/, "")}/api/tags`, {
						method: "GET",
						signal: AbortSignal.timeout(3000),
					});
					if (ollamaRes.ok) {
						const ollamaData = (await ollamaRes.json()) as { models?: { name: string }[] };
						const models = ollamaData.models ?? [];
						const hasNomic = models.some((m) => m.name.startsWith("nomic-embed-text"));
						if (hasNomic) {
							status.available = true;
							status.dimensions = 768;
							status.error = "Native unavailable — using ollama fallback";
							setNativeFallbackToOllama(true);
							logger.info("embedding", "Ollama fallback available — will use ollama for embeddings");
						} else {
							status.error = `Native: ${nativeStatus.error ?? "not ready"}. Ollama available but nomic-embed-text not found.`;
						}
					} else {
						status.error = `Native: ${nativeStatus.error ?? "not ready"}. Ollama not available.`;
					}
				} catch {
					status.error = `Native: ${nativeStatus.error ?? "not ready"}. Ollama not reachable.`;
				}
			}
		} else if (cfg.provider === "ollama") {
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
			const apiKey = await resolveEmbeddingApiKey(cfg.api_key);
			if (!apiKey) {
				status.error = "Missing OpenAI API key";
				cachedEmbeddingStatus = status;
				statusCacheTime = now;
				return status;
			}
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

// Middleware — restrict CORS to localhost origins only
const ALLOWED_ORIGINS = new Set([
	"http://localhost:3850",
	"http://127.0.0.1:3850",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"tauri://localhost",
	"http://tauri.localhost",
]);
app.use(
	"*",
	cors({
		origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
		credentials: true,
	}),
);

// Reject non-health requests during shutdown so keep-alive connections
// get a clean 503 instead of a socket reset.
app.use("*", async (c, next) => {
	if (shuttingDown && c.req.path !== "/health") {
		c.status(503);
		return c.json({ error: "shutting down" });
	}
	return next();
});

// Auth middleware — reads from module-level authConfig/authSecret
// which are initialized properly in main(). In local mode this is a no-op.
// Guard: reject requests if auth is required but secret isn't initialized yet
// (startup race between middleware registration and main() completing).
app.use("*", async (c, next) => {
	if (authConfig.mode !== "local" && !authSecret) {
		c.status(503);
		return c.json({ error: "server initializing" });
	}
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
	analyticsCollector.recordRequest(c.req.method, c.req.path, c.res.status, duration, actor ?? undefined);
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

// Shadow request tap — fire-and-forget replay to Rust daemon on :3851
app.use("*", async (c, next) => {
	// Read body before next() — route handlers consume the stream; Hono caches
	// the result but only after the first read. Pre-reading here ensures mutating
	// replays carry the correct payload.
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

// Health check
app.get("/health", (c) => {
	const us = getUpdateState();
	let dbOk = false;
	try {
		getDbAccessor().withReadDb((db) => {
			db.prepare("SELECT 1").get();
			dbOk = true;
		});
	} catch {
		// DB unreachable
	}
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

// Feature flags
app.get("/api/features", (c) => {
	return c.json(getAllFeatureFlags());
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
	const validRoles = ["admin", "operator", "agent", "readonly"];
	if (!role || !validRoles.includes(role)) {
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

// Cross-agent collaboration: read inbox/presence with recall, mutate with remember
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

// Predictor reporting — read-only (uses analytics permission)
app.use("/api/predictor/*", async (c, next) => {
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

// Secrets — admin only (can exec commands, exfiltrate secrets)
app.use("/api/secrets", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/secrets/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

// Git operations — admin only (can push, change remotes)
app.use("/api/git/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

// Troubleshooter — admin only (can stop/restart daemon, run CLI commands)
app.use("/api/troubleshoot/*", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

// Config writes — admin only (can overwrite agent.yaml, AGENTS.md)
// Reject oversized bodies: content-length fast path + post-buffer check
// for chunked encoding. The server-level REQUEST_BODY_LIMIT caps all
// routes, but this gives a clear per-route error message.
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

// Per-memory PATCH and DELETE need method-specific guards + scope check
app.use("/api/memory/:id", async (c, next) => {
	// Scope enforcement on mutations: if token has project scope, verify
	// the target memory belongs to that project.
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
	const limit = Number.parseInt(c.req.query("limit") || "100", 10);
	const level = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
	const category = c.req.query("category") as any;
	const since = c.req.query("since") ? new Date(c.req.query("since")!) : undefined;

	const logs = logger.getRecent({ limit, level, category, since });
	return c.json({ logs, count: logs.length });
});

// Stream logs via Server-Sent Events
app.get("/api/logs/stream", (c) => {
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			let dead = false;
			const cleanup = () => {
				if (dead) return;
				dead = true;
				logger.off("log", onLog);
				try {
					controller.close();
				} catch {}
			};

			const onLog = (entry: LogEntry) => {
				if (dead) return;
				try {
					const data = `data: ${JSON.stringify(entry)}\n\n`;
					controller.enqueue(encoder.encode(data));
				} catch {
					cleanup();
				}
			};

			logger.on("log", onLog);

			try {
				controller.enqueue(encoder.encode(`data: {"type":"connected"}\n\n`));
			} catch {
				cleanup();
			}

			c.req.raw.signal.addEventListener("abort", cleanup);
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
		const configFiles = dirFiles.filter((f) => f.endsWith(".md") || f.endsWith(".yaml"));

		for (const fileName of configFiles) {
			const filePath = join(AGENTS_DIR, fileName);
			const fileStat = statSync(filePath);
			if (fileStat.isFile()) {
				const content = readFileSync(filePath, "utf-8");
				files.push({ name: fileName, content, size: fileStat.size });
			}
		}

		// Sort by priority
		const priority = ["agent.yaml", "AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
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

		// Defense-in-depth: also check after parse (content-length can be absent)
		if (content.length > MAX_CONFIG_BYTES) {
			return c.json({ error: `content exceeds ${MAX_CONFIG_BYTES} byte limit` }, 413);
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
			if (line.startsWith("- name:")) identity.name = line.replace("- name:", "").trim();
			if (line.startsWith("- creature:")) identity.creature = line.replace("- creature:", "").trim();
			if (line.startsWith("- vibe:")) identity.vibe = line.replace("- vibe:", "").trim();
		}

		return c.json(identity);
	} catch {
		return c.json({ name: "Unknown", creature: "", vibe: "" });
	}
});

// ============================================================================
// Agents API
// ============================================================================

interface AgentRow {
	id: string;
	name: string;
	read_policy: string;
	policy_group: string | null;
	created_at: string;
	updated_at: string;
}

app.get("/api/agents", (c) => {
	const agents = getDbAccessor().withReadDb(
		(db) => db.prepare("SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents ORDER BY name").all() as AgentRow[],
	);
	return c.json({ agents });
});

app.get("/api/agents/:name", (c) => {
	const name = c.req.param("name");
	const agent = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare("SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents WHERE name = ?")
				.get(name) as AgentRow | undefined,
	);
	if (!agent) return c.json({ error: "Agent not found" }, 404);
	return c.json(agent);
});

app.post("/api/agents", async (c) => {
	const body = toRecord(await c.req.json().catch(() => null));
	if (!body) return c.json({ error: "Invalid JSON body" }, 400);
	const name = parseOptionalString(body.name);
	if (!name) return c.json({ error: "name is required" }, 400);
	const readPolicy = parseOptionalString(body.read_policy) ?? "isolated";
	const group = parseOptionalString(body.policy_group) ?? null;
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(name, name, readPolicy, group, now, now);
	});
	const created = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare("SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents WHERE id = ?")
				.get(name) as AgentRow,
	);
	return c.json(created, 201);
});

app.delete("/api/agents/:name", (c) => {
	const name = c.req.param("name");
	if (name === "default") return c.json({ error: "Cannot remove the default agent" }, 400);
	const purge = c.req.query("purge") === "true";
	const agent = getDbAccessor().withReadDb(
		(db) => db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as { id: string } | undefined,
	);
	if (!agent) return c.json({ error: "Agent not found" }, 404);
	getDbAccessor().withWriteTx((db) => {
		if (purge) {
			db.prepare("DELETE FROM memories WHERE agent_id = ?").run(name);
		} else {
			// Archive: mark memories as visibility='archived' so they're excluded from search
			db.prepare("UPDATE memories SET visibility = 'archived' WHERE agent_id = ?").run(name);
		}
		db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
	});
	return c.json({ success: true, purged: purge });
});

// ============================================================================
// Memories API
// ============================================================================

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

// ============================================================================
// Memory Review Queue API
// ============================================================================

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

	const clause = parts.length ? ` AND ${parts.join(" AND ")}` : "";
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

	const clause = parts.length ? ` AND ${parts.join(" AND ")}` : "";
	return { clause, args };
}

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
		importance_min: c.req.query("importance_min") ? Number.parseFloat(c.req.query("importance_min")!) : null,
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

// ============================================================================
// Native Memory API - /api/memory/remember & /api/memory/recall
// ============================================================================

const MAX_MUTATION_BATCH = 200;
const FORGET_CONFIRM_THRESHOLD = 25;
const SOFT_DELETE_RETENTION_DAYS = 30;
const SOFT_DELETE_RETENTION_MS = SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface ForgetCandidatesRequest {
	query: string;
	type: string;
	tags: string;
	who: string;
	sourceType: string;
	since: string;
	until: string;
	scope: string | null;
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

async function readOptionalJsonObject(c: Context): Promise<Record<string, unknown> | null> {
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

function shouldEnforceAuthScope(c: Context): boolean {
	return shouldEnforceScope(authConfig.mode, c.get("auth")?.claims ?? null);
}

function resolveScopedAgentId(
	c: Context,
	requestedAgentId: string | undefined,
	fallbackAgentId = "default",
): { agentId: string; error?: string } {
	return resolveScopedAgent(c.get("auth")?.claims ?? null, authConfig.mode, requestedAgentId, fallbackAgentId);
}

function resolveScopedProject(
	c: Context,
	requestedProject: string | undefined,
): { project: string | undefined; error?: string } {
	return resolveScopedProjectForClaims(c.get("auth")?.claims ?? null, authConfig.mode, requestedProject);
}

function validateSessionAgentBinding(
	c: Context,
	sessionKey: string | undefined,
	agentId: string,
	options: { requireExisting: boolean; context: string },
): string | undefined {
	const normalizedSessionKey = parseOptionalString(sessionKey);
	if (!normalizedSessionKey || !shouldEnforceAuthScope(c)) {
		return undefined;
	}

	const existing = getAgentPresenceForSession(normalizedSessionKey);
	if (!existing) {
		return options.requireExisting ? `${options.context} is not an active session` : undefined;
	}

	if (existing.agentId !== agentId) {
		return `${options.context} belongs to a different agent`;
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
		if (value.some((entry) => typeof entry !== "string")) {
			return undefined;
		}
		const tags = value
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

const ACTOR_TYPES = new Set(["operator", "pipeline", "harness", "sdk", "daemon"]);

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
	const changedBy = headerActor ?? (fallback && fallback.trim().length > 0 ? fallback.trim() : "daemon");

	const rawType = parseOptionalString(c.req.header("x-signet-actor-type"));
	const actorType = rawType && ACTOR_TYPES.has(rawType) ? rawType : "operator";

	return {
		changedBy,
		actorType,
		sessionId: parseOptionalString(c.req.header("x-signet-session-id")),
		requestId: parseOptionalString(c.req.header("x-signet-request-id")),
	};
}

function buildForgetCandidatesWhere(req: ForgetCandidatesRequest, alias: string): { clause: string; args: unknown[] } {
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
	if (req.scope !== null) {
		parts.push(`${prefix}scope = ?`);
		args.push(req.scope);
	} else {
		parts.push(`${prefix}scope IS NULL`);
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
		const { clause, args } = buildForgetCandidatesWhere(req, withQuery ? "m" : "");

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

function loadForgetCandidatesByIds(requestedIds: readonly string[], limit: number): ForgetCandidate[] {
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
			.filter((row): row is { id: string; pinned: number; version: number } => Boolean(row))
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

	const hasField = (field: string): boolean => Object.prototype.hasOwnProperty.call(payload, field);

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
			normalized.normalizedContent.length > 0 ? normalized.normalizedContent : normalized.hashBasis;
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
		if (importance === undefined || importance < 0 || importance > 1 || !Number.isFinite(importance)) {
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
			error: "at least one of content, type, tags, importance, pinned is required",
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
		tags?: unknown;
		pinned?: boolean;
		sourceType?: string;
		sourceId?: string;
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
				aspect: string;
				attributes: Array<{
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
	// Skip chunking when structured data is provided — the caller has
	// already processed the content and provides entities/aspects/hints.
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
				// Dedup check + insert (scope-aware: same content in different scopes is not a duplicate)
				const inserted = getDbAccessor().withWriteTx((db) => {
					const byHash = scope !== null
						? db.prepare(`SELECT id FROM memories WHERE content_hash = ? AND scope = ? AND is_deleted = 0 LIMIT 1`)
							.get(chunkNormalized.contentHash, scope) as { id: string } | undefined
						: db.prepare(`SELECT id FROM memories WHERE content_hash = ? AND scope IS NULL AND is_deleted = 0 LIMIT 1`)
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
						extractionModel: pipelineEnqueueEnabled ? pipelineCfg.extractionModel : null,
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
							// Use memory-scoped content hash for embeddings so the same
							// content in different scopes each gets its own vector row
							// (vector search joins on source_id, not content_hash)
							const embHash = scope
								? `${chunkNormalized.contentHash}:${scope}`
								: chunkNormalized.contentHash;
							getDbAccessor().withWriteTx((db) => {
								syncVecDeleteBySourceId(db, "memory", chunkId);
								db.prepare(`DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`).run(chunkId);
								db.prepare(`
									INSERT INTO embeddings
									  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
									VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
								`).run(
									embId,
									embHash,
									blob,
									vec.length,
									chunkId,
									chunkNormalized.storageContent,
									now,
								);
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
						linkMemoryToEntities(db, chunkId, chunk, "default");
					});
				} catch {
					// Non-fatal — pipeline extraction handles deeper linking
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
	const tags = hasBodyTags ? bodyTags : parsed.tags;
	const memType = inferType(parsed.content);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const normalizedContent = normalizeAndHashContent(parsed.content);
	if (!normalizedContent.storageContent) {
		return c.json({ error: "content is required" }, 400);
	}
	const normalizedContentForInsert =
		normalizedContent.normalizedContent.length > 0 ? normalizedContent.normalizedContent : normalizedContent.hashBasis;
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
		// Single atomic write tx: check dedupe then insert.
		// On UNIQUE constraint race (two concurrent inserts with same
		// content_hash), catch the error and re-read the winner.
		const result = getDbAccessor().withWriteTx((db) => {
			// Check sourceId-based dedupe first (scope-aware)
			if (sourceId) {
				const bySource = (scope !== null
					? db.prepare(
						`SELECT id, type, tags, pinned, importance, content
						 FROM memories WHERE source_type = ? AND source_id = ? AND scope = ? AND is_deleted = 0 LIMIT 1`,
					).get(sourceType, sourceId, scope)
					: db.prepare(
						`SELECT id, type, tags, pinned, importance, content
						 FROM memories WHERE source_type = ? AND source_id = ? AND scope IS NULL AND is_deleted = 0 LIMIT 1`,
					).get(sourceType, sourceId)) as DedupeRow | undefined;
				if (bySource) return { deduped: true as const, row: bySource };
			}

			// Check content_hash dedupe (scope-aware: same content in different scopes is not a duplicate)
			const byHash = (scope !== null
				? db.prepare(
					`SELECT id, type, tags, pinned, importance, content
					 FROM memories WHERE content_hash = ? AND scope = ? AND is_deleted = 0 LIMIT 1`,
				).get(contentHash, scope)
				: db.prepare(
					`SELECT id, type, tags, pinned, importance, content
					 FROM memories WHERE content_hash = ? AND scope IS NULL AND is_deleted = 0 LIMIT 1`,
				).get(contentHash)) as DedupeRow | undefined;
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
				tags,
				pinned,
				isDeleted: 0,
				extractionStatus: hasStructured ? "complete" : (pipelineEnqueueEnabled ? "pending" : "none"),
				embeddingModel: null,
				extractionModel: hasStructured ? "structured-passthrough" : (pipelineEnqueueEnabled ? pipelineCfg.extractionModel : null),
				updatedBy: who,
				sourceType,
				sourceId,
				scope,
				agentId,
				visibility,
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

	// Lossless transcript storage: write raw conversation text to
	// session_transcripts so expand=true can join it at recall time.
	if (body.transcript && sourceId) {
		upsertSessionTranscript(sourceId, body.transcript, sourceType, project, agentId);
	}

	// Generate embedding asynchronously — save memory first so failures are
	// non-fatal (memory is still usable via keyword search)
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
				// Scope-qualify content hash so same content in different scopes
				// each gets its own embedding row for vector search
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
	// When a structured payload is provided, write entities/aspects/attributes/hints
	// synchronously and skip the async pipeline entirely. This is the path used by
	// benchmarks and clients that pre-compute their own extraction.
	let entitiesLinked = 0;
	let hintsWritten = 0;

	if (body.structured) {
		const { txPersistStructured } = await import("./pipeline/graph-transactions.js");
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
					content: body.content,
					agentId: "default",
					now,
				}),
			);
			entitiesLinked = result.mentionsLinked;
			logger.debug("memory", "Structured payload persisted", {
				id,
				entities: result.entitiesInserted + result.entitiesUpdated,
				relations: result.relationsInserted,
				aspects: result.aspectsCreated,
				attributes: result.attributesCreated,
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
						stmt.run(crypto.randomUUID(), id, "default", h, now);
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

		// Inline entity linking — immediate KG integration so KA traversal
		// can find this memory without waiting for async pipeline extraction.
		try {
			const linkResult = getDbAccessor().withWriteTx((db) =>
				linkMemoryToEntities(db, id, normalizedContent.storageContent, "default"),
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

		// Prospective hints: if client provides hints, write them directly.
		// Otherwise the pipeline worker will generate them asynchronously.
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
						stmt.run(crypto.randomUUID(), id, "default", h, now);
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
			// No client hints — enqueue async generation
			try {
				const { enqueueHintsJob } = await import("./pipeline/prospective-index.js");
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

// Alias matching the legacy spec path
app.post("/api/memory/save", async (c) => {
	// Re-use the same handler by forwarding to the internal fetch
	const body = await c.req.json().catch(() => ({}));
	return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
});

// Alias for Claude Code skill compatibility
app.post("/api/hook/remember", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
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

// Memory jobs — read-only (uses documents permission)
app.use("/api/memory/jobs", async (c, next) => {
	return requirePermission("documents", authConfig)(c, next);
});

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

// -----------------------------------------------------------------------
// POST /api/memory/feedback — record agent relevance feedback for memories
// -----------------------------------------------------------------------
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
			propagated: result.propagated,
			cooccurrenceUpdated: result.cooccurrenceUpdated,
			dependenciesUpdated: result.dependenciesUpdated,
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
	try {
		const agentId = resolveAgentId({ agentId: body.agentId, sessionKey: c.req.header("x-signet-session-key") });
		const agentScope = getAgentScope(agentId);
		// Enforce auth scope: scoped tokens may only read their own project.
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

// Alias: GET /api/memory/search?q=... (spec-compatible)
// Calls hybridRecall directly instead of self-fetching to avoid potential
// issues with loopback fetch in single-threaded runtimes.
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
	// Enforce auth scope: scoped tokens may only read their own project.
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

// ============================================================================
// Memory Similar API (Vector Search)
// ============================================================================

app.get("/memory/similar", async (c) => {
	const id = c.req.query("id");
	if (!id) {
		return c.json({ error: "id is required", results: [] }, 400);
	}

	const k = Number.parseInt(c.req.query("k") ?? "10", 10);
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
			const legacy = await runLegacyEmbeddingsExport(withVectors, limit, offset);
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
	const tracker = embeddingTrackerHandle?.getStats() ?? null;
	return c.json({ ...status, tracker });
});

app.get("/api/embeddings/health", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const providerStatus = await checkEmbeddingProvider(cfg.embedding);
	const report = getDbAccessor().withReadDb((db) => buildEmbeddingHealth(db, cfg.embedding, providerStatus));
	return c.json(report);
});

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
		const count = countRow !== undefined && typeof countRow.count === "number" ? countRow.count : 0;
		return { cached: cachedResult, total: count };
	});

	// Return cached result if embedding count hasn't changed
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

	// Check for recent computation error
	const recentError = projectionErrors.get(nComponents);
	if (recentError) {
		if (Date.now() > recentError.expires) {
			projectionErrors.delete(nComponents);
		} else {
			return c.json({ status: "error", message: recentError.message }, 500);
		}
	}

	// Kick off background computation if not already running
	if (!projectionInFlight.has(nComponents)) {
		projectionErrors.delete(nComponents);
		const computation = (async () => {
			try {
				const result = getDbAccessor().withReadDb((db) => computeProjection(db, nComponents));
				const count = getDbAccessor().withReadDb((db) => {
					const row = db.prepare("SELECT COUNT(*) as count FROM embeddings WHERE source_type = 'memory'").get();
					return row !== undefined && typeof row.count === "number" ? row.count : 0;
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
				? ((body.url as string | undefined) ?? null)
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

// GET /api/documents — list documents
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

// GET /api/documents/:id — single document details
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
		return db.prepare("SELECT id FROM documents WHERE id = ?").get(id) as { id: string } | undefined;
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

type ConnectorSyncStartOutcome =
	| { status: "syncing" }
	| { status: "already-syncing" }
	| { status: "unsupported"; provider: string }
	| { status: "error"; error: string };

function startConnectorSync(connectorId: string, mode: "incremental" | "full"): ConnectorSyncStartOutcome {
	const accessor = getDbAccessor();
	const connectorRow = getConnector(accessor, connectorId);
	if (!connectorRow) {
		return { status: "error", error: "Connector not found" };
	}

	if (connectorRow.status === "syncing") {
		return { status: "already-syncing" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(connectorRow.config_json);
	} catch {
		return { status: "error", error: "Connector config is invalid JSON" };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("provider" in parsed) ||
		typeof (parsed as Record<string, unknown>).provider !== "string" ||
		!(CONNECTOR_PROVIDERS as readonly string[]).includes((parsed as Record<string, unknown>).provider as string)
	) {
		return { status: "error", error: "Invalid connector config" };
	}
	// provider validated above — safe to treat as ConnectorConfig
	const config = parsed as ConnectorConfig;

	if (config.provider !== "filesystem") {
		return { status: "unsupported", provider: config.provider };
	}

	updateConnectorStatus(accessor, connectorId, "syncing");
	const connector = createFilesystemConnector(config, accessor);

	let incrementalCursor: SyncCursor | null = null;
	if (mode === "incremental") {
		if (!connectorRow.cursor_json) {
			incrementalCursor = { lastSyncAt: new Date(0).toISOString() };
		} else {
			try {
				const cursorParsed: unknown = JSON.parse(connectorRow.cursor_json);
				if (
					typeof cursorParsed === "object" &&
					cursorParsed !== null &&
					"lastSyncAt" in cursorParsed &&
					typeof (cursorParsed as Record<string, unknown>).lastSyncAt === "string"
				) {
					incrementalCursor = cursorParsed as SyncCursor;
				} else {
					incrementalCursor = { lastSyncAt: new Date(0).toISOString() };
				}
			} catch {
				incrementalCursor = { lastSyncAt: new Date(0).toISOString() };
			}
		}
	}

	const syncPromise =
		mode === "full"
			? connector.syncFull()
			: connector.syncIncremental(incrementalCursor ?? { lastSyncAt: new Date(0).toISOString() });

	syncPromise
		.then((result) => {
			updateCursor(accessor, connectorId, result.cursor);
			updateConnectorStatus(accessor, connectorId, "idle");
			logger.info("connectors", mode === "full" ? "Full sync completed" : "Sync completed", {
				connectorId,
				added: result.documentsAdded,
				updated: result.documentsUpdated,
			});
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			updateConnectorStatus(accessor, connectorId, "error", msg);
			logger.error("connectors", mode === "full" ? "Full sync failed" : "Sync failed", new Error(msg));
		});

	return { status: "syncing" };
}

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
		return c.json({ error: "provider must be filesystem, github-docs, or gdrive" }, 400);
	}

	const displayName = typeof body.displayName === "string" ? body.displayName : provider;
	const settings =
		typeof body.settings === "object" && body.settings !== null ? (body.settings as Record<string, unknown>) : {};

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
	const outcome = startConnectorSync(id, "incremental");
	if (outcome.status === "error") return c.json({ error: outcome.error }, 404);
	if (outcome.status === "already-syncing") {
		return c.json({ status: "syncing", message: "Already syncing" });
	}
	if (outcome.status === "unsupported") {
		return c.json({ error: `Provider ${outcome.provider} not yet supported` }, 501);
	}
	return c.json({ status: "syncing" });
});

// POST /api/connectors/resync — trigger incremental sync for all connectors
app.post("/api/connectors/resync", async (c) => {
	try {
		const accessor = getDbAccessor();
		const connectors = listConnectors(accessor);

		let started = 0;
		let alreadySyncing = 0;
		let unsupported = 0;
		let failed = 0;

		for (const conn of connectors) {
			const outcome = startConnectorSync(conn.id, "incremental");
			if (outcome.status === "syncing") started++;
			if (outcome.status === "already-syncing") alreadySyncing++;
			if (outcome.status === "unsupported") unsupported++;
			if (outcome.status === "error") failed++;
		}

		return c.json({
			status: "ok",
			total: connectors.length,
			started,
			alreadySyncing,
			unsupported,
			failed,
		});
	} catch (e) {
		logger.error("connectors", "Failed to trigger bulk resync", e instanceof Error ? e : new Error(String(e)));
		return c.json(
			{
				status: "error",
				error: "Failed to trigger connector re-sync",
				total: 0,
				started: 0,
				alreadySyncing: 0,
				unsupported: 0,
				failed: 0,
			},
			500,
		);
	}
});

// POST /api/connectors/:id/sync/full — trigger full resync
app.post("/api/connectors/:id/sync/full", async (c) => {
	const id = c.req.param("id");
	const confirm = c.req.query("confirm");
	if (confirm !== "true") {
		return c.json({ error: "Full resync requires ?confirm=true" }, 400);
	}

	const outcome = startConnectorSync(id, "full");
	if (outcome.status === "error") return c.json({ error: outcome.error }, 404);
	if (outcome.status === "already-syncing") {
		return c.json({ status: "syncing", message: "Already syncing" });
	}
	if (outcome.status === "unsupported") {
		return c.json({ error: `Provider ${outcome.provider} not yet supported` }, 501);
	}

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

import { type ReconcilerHandle, startReconciler } from "./pipeline/skill-reconciler.js";
// Skills routes (extracted to routes/skills.ts)
import { mountSkillsRoutes, setFetchEmbedding } from "./routes/skills.js";
mountSkillsRoutes(app);
setFetchEmbedding(fetchEmbedding);

// Marketplace routes (MCP servers catalog + routing)
import { mountMarketplaceRoutes } from "./routes/marketplace.js";
mountMarketplaceRoutes(app);

import { mountAppTrayRoutes } from "./routes/app-tray.js";
mountAppTrayRoutes(app);

// Widget generation routes (Signet OS widget rendering)
import { mountWidgetRoutes } from "./routes/widget.js";
mountWidgetRoutes(app);

// Event bus routes (Signet OS ambient awareness layer — Phase 3/5)
import { mountEventBusRoutes } from "./routes/event-bus.js";
mountEventBusRoutes(app);

// Marketplace review routes (Signet Reviews scaffold)
import { mountMarketplaceReviewsRoutes } from "./routes/marketplace-reviews.js";
mountMarketplaceReviewsRoutes(app);

// Changelog + roadmap routes (proxies GitHub raw content with local fallback)
import { mountChangelogRoutes } from "./routes/changelog.js";
mountChangelogRoutes(app);

// OS agent chat routes (natural language → MCP tool routing)
import { mountOsChatRoutes } from "./routes/os-chat.js";
mountOsChatRoutes(app);

// OS page-agent routes (visual GUI automation via PageController)
import { mountOsAgentRoutes } from "./routes/os-agent.js";
mountOsAgentRoutes(app);

// ============================================================================
// Harnesses API
// ============================================================================

app.get("/api/harnesses", async (c) => {
	const configs = [
		{ name: "Claude Code", id: "claude-code", path: join(homedir(), ".claude", "settings.json") },
		{
			name: "OpenCode",
			id: "opencode",
			path: join(homedir(), ".config", "opencode", "AGENTS.md"),
		},
		{ name: "OpenClaw", id: "openclaw", path: join(AGENTS_DIR, "AGENTS.md") },
	];

	const harnesses = configs.map((config) => ({
		name: config.name,
		id: config.id,
		path: config.path,
		exists: existsSync(config.path),
		lastSeen: harnessLastSeen.get(config.id) ?? null,
	}));

	return c.json({ harnesses });
});

app.post("/api/harnesses/regenerate", async (c) => {
	return new Promise<Response>((resolve) => {
		const script = join(SCRIPTS_DIR, "generate-harness-configs.py");

		if (!existsSync(script)) {
			resolve(c.json({ success: false, error: "Regeneration script not found" }, 404));
			return;
		}

		const proc = spawn("python3", [script], {
			timeout: 10000,
			cwd: AGENTS_DIR,
			windowsHide: true,
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

function parseOptionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value
		.map((entry) => parseOptionalString(entry))
		.filter((entry): entry is string => typeof entry === "string");
	return values.length > 0 ? values : undefined;
}

async function resolveOnePasswordToken(explicitToken?: string): Promise<string> {
	if (explicitToken && explicitToken.length > 0) {
		return explicitToken;
	}

	if (!hasSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET)) {
		throw new Error(
			"1Password service account token not configured. Set secret OP_SERVICE_ACCOUNT_TOKEN or call /api/secrets/1password/connect.",
		);
	}

	return getSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
}

app.get("/api/secrets/1password/status", async (c) => {
	const configured = hasSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
	if (!configured) {
		return c.json({ configured: false, connected: false, vaults: [] });
	}

	try {
		const token = await resolveOnePasswordToken();
		const vaults = await listOnePasswordVaults(token);
		return c.json({
			configured: true,
			connected: true,
			vaultCount: vaults.length,
			vaults,
		});
	} catch (e) {
		const err = e as Error;
		logger.warn("secrets", "1Password status check failed", { error: err.message });
		return c.json({
			configured: true,
			connected: false,
			error: err.message,
			vaults: [],
		});
	}
});

app.post("/api/secrets/1password/connect", async (c) => {
	try {
		const body = await readOptionalJsonObject(c);
		if (!body) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const token = parseOptionalString(body.token);
		if (!token) {
			return c.json({ error: "token is required" }, 400);
		}

		const vaults = await listOnePasswordVaults(token);
		await putSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET, token);

		logger.info("secrets", "Connected 1Password service account", {
			vaultCount: vaults.length,
		});

		return c.json({
			success: true,
			connected: true,
			vaultCount: vaults.length,
			vaults,
		});
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "Failed to connect 1Password service account", err);
		return c.json({ error: err.message }, 400);
	}
});

app.delete("/api/secrets/1password/connect", (c) => {
	try {
		const deleted = deleteSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
		return c.json({ success: true, disconnected: true, existed: deleted });
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "Failed to disconnect 1Password service account", err);
		return c.json({ error: err.message }, 500);
	}
});

app.get("/api/secrets/1password/vaults", async (c) => {
	try {
		const token = await resolveOnePasswordToken();
		const vaults = await listOnePasswordVaults(token);
		return c.json({ vaults, count: vaults.length });
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "Failed to list 1Password vaults", err);
		return c.json({ error: err.message }, 400);
	}
});

app.post("/api/secrets/1password/import", async (c) => {
	try {
		const body = await readOptionalJsonObject(c);
		if (!body) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const token = await resolveOnePasswordToken(parseOptionalString(body.token));
		const vaults = parseOptionalStringArray(body.vaults);
		const prefix = parseOptionalString(body.prefix) ?? "OP";
		const overwrite = parseOptionalBoolean(body.overwrite) ?? false;

		const result = await importOnePasswordSecrets({
			token,
			vaults,
			prefix,
			overwrite,
			hasSecret,
			putSecret,
		});

		logger.info("secrets", "Imported secrets from 1Password", {
			vaultsScanned: result.vaultsScanned,
			itemsScanned: result.itemsScanned,
			importedCount: result.importedCount,
			errorCount: result.errorCount,
		});

		return c.json({ success: true, ...result });
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "Failed to import 1Password secrets", err);
		return c.json({ error: err.message }, 400);
	}
});

// Execute a command with multiple secrets injected into the subprocess
// environment. The agent provides a secrets map (env var → secret name),
// never the actual values. Registered BEFORE parameterized /:name routes
// so Hono doesn't match "exec" as :name.
app.post("/api/secrets/exec", async (c) => {
	try {
		const body = (await c.req.json()) as {
			command?: string;
			secrets?: Record<string, string>;
		};

		if (!body.command) {
			return c.json({ error: "command is required" }, 400);
		}
		if (!body.secrets || Object.keys(body.secrets).length === 0) {
			return c.json({ error: "secrets map is required" }, 400);
		}

		const result = await execWithSecrets(body.command, body.secrets);
		logger.info("secrets", "exec_with_secrets completed", {
			secretCount: Object.keys(body.secrets).length,
			code: result.code,
		});
		return c.json(result);
	} catch (e) {
		const err = e as Error;
		logger.error("secrets", "exec_with_secrets failed", err);
		return c.json({ error: err.message }, 500);
	}
});

// Execute a command with secrets injected into the subprocess environment.
// The agent provides references (env var → secret name), never values.
// Legacy single-secret route — kept for backwards compatibility.
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

// Store a secret (registered after /exec routes so Hono doesn't match
// "exec" as :name)
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

// ============================================================================
// ============================================================================
// Hooks API
// ============================================================================

import {
	type PreCompactionRequest,
	type RecallRequest,
	type RememberRequest,
	type SessionEndRequest,
	type SessionStartRequest,
	type SynthesisRequest,
	type UserPromptSubmitRequest,
	handlePreCompaction,
	handleSessionEnd,
	handleSessionStart,
	handleSynthesisRequest,
	handleUserPromptSubmit,
	resetPromptDedup,
	writeMemoryMd,
} from "./hooks.js";
import { upsertSessionTranscript } from "./session-transcripts.js";

import {
	type RuntimePath,
	activeSessionCount,
	bypassSession,
	claimSession,
	getActiveSessions,
	getBypassedSessionKeys,
	getSessionPath,
	hasSession,
	isSessionBypassed,
	releaseAllSessions,
	releaseSession,
	renewSession,
	startSessionCleanup,
	stopSessionCleanup,
	unbypassSession,
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
		return c.json({ error: `session claimed by ${owner} path` }, 409) as unknown as Response;
	}
	return null;
}

// Start session cleanup timer
startSessionCleanup();

// Harness last-seen registry — in-memory, resets on daemon restart
const harnessLastSeen = new Map<string, string>();

function stampHarness(harness: string | undefined): void {
	if (harness) {
		harnessLastSeen.set(harness, new Date().toISOString());
	}
}

// Guard against recursive hook calls from spawned agent contexts
function isInternalCall(c: Context): boolean {
	return c.req.header("x-signet-no-hooks") === "1";
}

// Check whether the session is bypassed (hooks return no-op responses)
function checkBypass(body?: { sessionKey?: string; sessionId?: string }): boolean {
	const key = body?.sessionKey ?? body?.sessionId;
	if (!key) return false;
	return isSessionBypassed(key);
}

// Session start hook - provides context/memories for injection
app.post("/api/hooks/session-start", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ inject: "", memories: [] });
	}
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
				return c.json(
					{
						error: `session claimed by ${claim.claimedBy} path`,
					},
					409,
				);
			}
		}

		upsertAgentPresence({
			sessionKey: parseOptionalString(body.sessionKey),
			agentId: parseOptionalString(body.agentId) ?? "default",
			harness: body.harness,
			project: parseOptionalString(body.project),
			runtimePath,
			provider: body.harness,
		});

		stampHarness(body.harness);

		if (checkBypass(body)) {
			return c.json({ inject: "", memories: [], bypassed: true });
		}

		const result = await handleSessionStart(body);
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Session start hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// User prompt submit hook - inject relevant memories per prompt
app.post("/api/hooks/user-prompt-submit", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ inject: "", memoryCount: 0 });
	}
	try {
		const body = (await c.req.json()) as UserPromptSubmitRequest;

		const hasUserMessage = typeof body.userMessage === "string" && body.userMessage.trim().length > 0;
		const hasUserPrompt = typeof body.userPrompt === "string" && body.userPrompt.trim().length > 0;

		if (!body.harness || (!hasUserMessage && !hasUserPrompt)) {
			return c.json({ error: "harness and userMessage or userPrompt are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		// Capture before any claim refresh — false means the daemon restarted
		// mid-session (claimedSessions lost in memory) so the adapter can re-init.
		// Note: hasSession evicts expired entries as a side effect; calling it
		// before checkSessionClaim is intentional — an expired claim == no claim.
		const sessionKey = parseOptionalString(body.sessionKey);
		const known = sessionKey ? hasSession(sessionKey) : false;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;
		const agentId = parseOptionalString(body.agentId) ?? "default";
		if (sessionKey) {
			const touched = touchAgentPresence(sessionKey);
			if (!touched) {
				upsertAgentPresence({
					sessionKey,
					agentId,
					harness: body.harness,
					project: parseOptionalString(body.project),
					runtimePath,
					provider: body.harness,
				});
			}
		} else {
			upsertAgentPresence({
				agentId,
				harness: body.harness,
				project: parseOptionalString(body.project),
				runtimePath,
				provider: body.harness,
			});
		}

		stampHarness(body.harness);

		if (checkBypass(body)) {
			return c.json({ inject: "", memoryCount: 0, bypassed: true });
		}

		const result = await handleUserPromptSubmit(body);
		return c.json({ ...result, sessionKnown: known });
	} catch (e) {
		logger.error("hooks", "User prompt submit hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Session end hook - extract memories from transcript
app.post("/api/hooks/session-end", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ memoriesSaved: 0 });
	}
	try {
		const body = (await c.req.json()) as SessionEndRequest;

		if (!body.harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		stampHarness(body.harness);

		const sessionKey = body.sessionKey || body.sessionId;

		if (sessionKey && isSessionBypassed(sessionKey)) {
			// Still release session claim and agent presence on end
			releaseSession(sessionKey);
			removeAgentPresence(sessionKey);
			return c.json({ memoriesSaved: 0, bypassed: true });
		}

		try {
			const result = await handleSessionEnd(body);
			return c.json(result);
		} finally {
			// Always release session claim and agent presence, even if extraction throws
			if (sessionKey) {
				releaseSession(sessionKey);
				removeAgentPresence(sessionKey);
			}
		}
	} catch (e) {
		logger.error("hooks", "Session end hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Remember hook - explicit memory save
app.post("/api/hooks/remember", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ success: true, memories: [] });
	}
	try {
		const body = (await c.req.json()) as RememberRequest;

		if (!body.harness || !body.content) {
			return c.json({ error: "harness and content are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json({ success: true, memories: [], bypassed: true });
		}

		// Forward to the full remember endpoint for transcript, structured,
		// and pipeline support instead of the bare handleRemember path.
		const auth = c.req.header("authorization");
		const headers = auth
			? { "Content-Type": "application/json", Authorization: auth }
			: { "Content-Type": "application/json" };
		return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	} catch (e) {
		logger.error("hooks", "Remember hook failed", e as Error);
		return c.json({ error: "Hook execution failed" }, 500);
	}
});

// Recall hook - explicit memory query
app.post("/api/hooks/recall", async (c) => {
	if (isInternalCall(c)) {
		return c.json({ memories: [], count: 0 });
	}
	try {
		const body = (await c.req.json()) as RecallRequest;

		if (!body.harness || !body.query) {
			return c.json({ error: "harness and query are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		if (runtimePath) body.runtimePath = runtimePath;

		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json({ memories: [], count: 0, bypassed: true });
		}

		const agentId = resolveAgentId({
			agentId: c.req.header("x-signet-agent-id"),
			sessionKey: body.sessionKey,
		});
		const agentScope = getAgentScope(agentId);
		const result = await hybridRecall(
			{
				query: body.query,
				limit: body.limit,
				scope: body.project,
				agentId,
				readPolicy: agentScope.readPolicy,
				policyGroup: agentScope.policyGroup,
			},
			cfg,
			fetchEmbedding,
		);
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

		if (checkBypass(body)) {
			return c.json({ instructions: "", bypassed: true });
		}

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
			project?: string;
			agentId?: string;
			runtimePath?: string;
		};

		if (!body.harness || !body.summary) {
			return c.json({ error: "harness and summary are required" }, 400);
		}

		const runtimePath = resolveRuntimePath(c, body);
		const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
		if (conflict) return conflict;

		if (checkBypass(body)) {
			return c.json({ success: true, bypassed: true });
		}

		// Save the summary as a memory
		if (!existsSync(MEMORY_DB)) {
			return c.json({ error: "Memory database not found" }, 500);
		}

		const now = new Date().toISOString();
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({ agentId: body.agentId, sessionKey: body.sessionKey }),
		);
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const agentId = scopedAgent.agentId;
		const transcriptRow = body.sessionKey
			? getDbAccessor().withReadDb((db) =>
					db
						.prepare(
							`SELECT project
							 FROM session_transcripts
							 WHERE session_key = ? AND agent_id = ?`,
						)
						.get(body.sessionKey, agentId) as { project: string | null } | undefined,
				)
			: undefined;
		const requestedProject = transcriptRow?.project ?? parseOptionalString(body.project);
		const scopedProject = resolveScopedProject(c, requestedProject);
		if (scopedProject.error) {
			return c.json({ error: scopedProject.error }, 403);
		}
		const project = scopedProject.project ?? null;

		const summaryId = crypto.randomUUID();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, importance, source_id, source_type,
					who, tags, project, agent_id, created_at, updated_at, updated_by
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				summaryId,
				body.summary,
				"session_summary",
				0.8,
				body.sessionKey ?? null,
				body.harness,
				"system",
				`session,summary,${body.harness}`,
				project,
				agentId,
				now,
				now,
				"system",
			);

			const table = db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`)
				.get();
			if (table) {
				const nodeId = body.sessionKey
					? `${body.sessionKey}:compaction:${Date.parse(now)}`
					: crypto.randomUUID();
				db.prepare(
					`INSERT OR REPLACE INTO session_summaries (
						id, project, depth, kind, content, token_count,
						earliest_at, latest_at, session_key, harness,
						agent_id, source_type, source_ref, meta_json, created_at
					) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'compaction', ?, ?, ?)`,
				).run(
					nodeId,
					project,
					body.summary,
					Math.ceil(body.summary.length / 4),
					now,
					now,
					body.sessionKey ?? null,
					body.harness,
					agentId,
					body.sessionKey ?? null,
					JSON.stringify({ source: "compaction-complete" }),
					now,
				);
			}
		});

		logger.info("hooks", "Compaction summary saved", {
			harness: body.harness,
			memoryId: summaryId,
		});

		// Compaction wipes conversation context — reset prompt-submit dedup
		// so previously-injected memories are eligible for re-injection.
		if (body.sessionKey) {
			resetPromptDedup(body.sessionKey);
		}

		void getSynthesisWorker()?.triggerNow().catch((error) => {
			logger.warn("synthesis", "Failed to trigger MEMORY.md synthesis after compaction", {
				error: error instanceof Error ? error.message : String(error),
			});
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

const AGENT_MESSAGE_TYPES: readonly AgentMessageType[] = ["assist_request", "decision_update", "info", "question"];
const MAX_CROSS_AGENT_MESSAGE_CHARS = 65_536;

function parseAgentMessageType(value: string | undefined): AgentMessageType | undefined {
	if (!value) return undefined;
	for (const type of AGENT_MESSAGE_TYPES) {
		if (type === value) return type;
	}
	return undefined;
}

// ============================================================================
// Cross-Agent Collaboration API
// ============================================================================

app.get("/api/cross-agent/presence", (c) => {
	const includeSelf = parseOptionalBoolean(c.req.query("include_self")) ?? false;
	const limit = parseOptionalInt(c.req.query("limit")) ?? 50;
	const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
	const sessionKey = parseOptionalString(c.req.query("session_key"));
	const project = parseOptionalString(c.req.query("project"));
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: true,
		context: "session_key",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}

	const sessions = listAgentPresence({
		agentId: scopedAgent.agentId,
		sessionKey,
		project,
		includeSelf,
		limit,
	});

	return c.json({
		sessions,
		count: sessions.length,
	});
});

app.post("/api/cross-agent/presence", async (c) => {
	const payload = await readOptionalJsonObject(c);
	if (payload === null) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const harness = parseOptionalString(payload.harness);
	if (!harness) {
		return c.json({ error: "harness is required" }, 400);
	}

	const runtimePathRaw = parseOptionalString(payload.runtimePath);
	const runtimePath = runtimePathRaw === "plugin" || runtimePathRaw === "legacy" ? runtimePathRaw : undefined;
	const requestedAgentId = parseOptionalString(payload.agentId);
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionKey = parseOptionalString(payload.sessionKey);
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: false,
		context: "sessionKey",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}

	const presence = upsertAgentPresence({
		sessionKey,
		agentId: scopedAgent.agentId,
		harness,
		project: parseOptionalString(payload.project),
		runtimePath,
		provider: parseOptionalString(payload.provider) ?? harness,
	});

	return c.json({ presence });
});

app.delete("/api/cross-agent/presence/:sessionKey", (c) => {
	const sessionKey = c.req.param("sessionKey");
	const scopedAgent = resolveScopedAgentId(c, undefined, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: false,
		context: "sessionKey",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}
	const removed = removeAgentPresence(sessionKey);
	return c.json({ removed });
});

app.get("/api/cross-agent/messages", (c) => {
	const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
	const sessionKey = parseOptionalString(c.req.query("session_key"));
	const since = parseOptionalString(c.req.query("since"));
	const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
	const includeBroadcast = parseOptionalBoolean(c.req.query("include_broadcast")) ?? true;
	const limit = parseOptionalInt(c.req.query("limit")) ?? 100;
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: true,
		context: "session_key",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}

	const items = listAgentMessages({
		agentId: scopedAgent.agentId,
		sessionKey,
		since,
		includeSent,
		includeBroadcast,
		limit,
	});

	return c.json({
		items,
		count: items.length,
	});
});

app.post("/api/cross-agent/messages", async (c) => {
	const payload = await readOptionalJsonObject(c);
	if (payload === null) {
		return c.json({ error: "invalid request body" }, 400);
	}

	const content = parseOptionalString(payload.content);
	if (!content) {
		return c.json({ error: "content is required" }, 400);
	}
	if (content.length > MAX_CROSS_AGENT_MESSAGE_CHARS) {
		return c.json({ error: `content too large (max ${MAX_CROSS_AGENT_MESSAGE_CHARS} chars)` }, 400);
	}

	const deliveryPathRaw = parseOptionalString(payload.via);
	const deliveryPath = deliveryPathRaw === "acp" ? "acp" : "local";

	const rawType = parseOptionalString(payload.type);
	const parsedType = parseAgentMessageType(rawType);
	if (rawType && !parsedType) {
		return c.json({ error: `unsupported message type '${rawType}'` }, 400);
	}
	const type = parsedType ?? "info";
	const broadcast = parseOptionalBoolean(payload.broadcast) ?? false;
	const fromAgentId = parseOptionalString(payload.fromAgentId);
	const scopedSender = resolveScopedAgentId(c, fromAgentId, "default");
	if (scopedSender.error) {
		return c.json({ error: scopedSender.error }, 403);
	}
	const fromSessionKey = parseOptionalString(payload.fromSessionKey);
	const fromSessionError = validateSessionAgentBinding(c, fromSessionKey, scopedSender.agentId, {
		requireExisting: true,
		context: "fromSessionKey",
	});
	if (fromSessionError) {
		return c.json({ error: fromSessionError }, 403);
	}
	const toAgentId = parseOptionalString(payload.toAgentId);
	const toSessionKey = parseOptionalString(payload.toSessionKey);
	const hasLocalTarget = broadcast || !!toAgentId || !!toSessionKey;
	if (deliveryPath === "local" && !hasLocalTarget) {
		return c.json({ error: "local target required (toAgentId, toSessionKey, or broadcast=true)" }, 400);
	}

	let deliveryStatus: "queued" | "delivered" | "failed" = "delivered";
	let deliveryError: string | undefined;
	let deliveryReceipt: Record<string, unknown> | undefined;

	if (deliveryPath === "acp") {
		const acpPayload = toRecord(payload.acp);
		const baseUrl = parseOptionalString(acpPayload?.baseUrl) ?? parseOptionalString(acpPayload?.url);
		const targetAgentName =
			parseOptionalString(acpPayload?.targetAgentName) ?? parseOptionalString(acpPayload?.agentName);

		if (!baseUrl || !targetAgentName) {
			return c.json(
				{
					error: "acp.baseUrl and acp.targetAgentName are required when via='acp'",
				},
				400,
			);
		}

		const timeoutMs = parseOptionalInt(acpPayload?.timeoutMs);
		const metadata = toRecord(acpPayload?.metadata) ?? undefined;

		const relay = await relayMessageViaAcp({
			baseUrl,
			targetAgentName,
			content,
			fromAgentId: scopedSender.agentId,
			fromSessionKey,
			timeoutMs,
			metadata,
		});

		deliveryStatus = relay.ok ? "delivered" : "failed";
		deliveryError = relay.error;
		const receipt: Record<string, unknown> = {
			status: relay.status,
		};
		if (relay.runId) {
			receipt.runId = relay.runId;
		}
		deliveryReceipt = receipt;
	}

	let message: AgentMessage;
	try {
		message = createAgentMessage({
			fromAgentId: scopedSender.agentId,
			fromSessionKey,
			toAgentId,
			toSessionKey,
			content,
			type,
			broadcast,
			deliveryPath,
			deliveryStatus,
			deliveryError,
			deliveryReceipt,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return c.json({ error: msg }, 400);
	}

	return c.json({ message });
});

app.get("/api/cross-agent/stream", (c) => {
	const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
	const sessionKey = parseOptionalString(c.req.query("session_key"));
	const project = parseOptionalString(c.req.query("project"));
	const includeSelf = parseOptionalBoolean(c.req.query("include_self")) ?? false;
	const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
	const encoder = new TextEncoder();
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
		requireExisting: true,
		context: "session_key",
	});
	if (sessionError) {
		return c.json({ error: sessionError }, 403);
	}
	const agentId = scopedAgent.agentId;

	const stream = new ReadableStream({
		start(controller) {
			let dead = false;
			const cleanup = () => {
				if (dead) return;
				dead = true;
				clearInterval(keepAlive);
				unsubscribe();
				try {
					controller.close();
				} catch {}
			};

			const writeEvent = (event: unknown) => {
				if (dead) return;
				try {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					controller.enqueue(encoder.encode(data));
				} catch {
					cleanup();
				}
			};

			writeEvent({
				type: "connected",
				agentId,
				sessionKey,
				project,
				timestamp: new Date().toISOString(),
			});

			writeEvent({
				type: "snapshot",
				presence: listAgentPresence({
					agentId,
					sessionKey,
					project,
					includeSelf,
					limit: 50,
				}),
				messages: listAgentMessages({
					agentId,
					sessionKey,
					includeSent,
					includeBroadcast: true,
					limit: 20,
				}),
				timestamp: new Date().toISOString(),
			});

			const unsubscribe = subscribeCrossAgentEvents((event) => {
				if (event.type === "message") {
					if (
						!isMessageVisibleToAgent(event.message, {
							agentId,
							sessionKey,
							includeBroadcast: true,
						})
					) {
						if (!(includeSent && event.message.fromAgentId === agentId)) {
							return;
						}
					}
				}

				if (event.type === "presence" && !includeSelf && event.presence.agentId === agentId) {
					if (!sessionKey) {
						return;
					}
					if (!event.presence.sessionKey || event.presence.sessionKey === sessionKey) {
						return;
					}
				}
				if (event.type === "presence" && project && event.presence.project !== project) {
					return;
				}

				writeEvent(event);
			});

			const keepAlive = setInterval(() => {
				if (dead) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					cleanup();
				}
			}, 15_000);

			c.req.raw.signal.addEventListener("abort", cleanup);
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

// Get synthesis config
app.get("/api/hooks/synthesis/config", (c) => {
	const config = loadMemoryConfig(AGENTS_DIR).pipelineV2.synthesis;
	return c.json(config);
});

// Request MEMORY.md synthesis
app.post("/api/hooks/synthesis", async (c) => {
	try {
		const body = (await c.req.json()) as SynthesisRequest & { agentId?: string; sessionKey?: string };
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
				sessionKey: body.sessionKey ?? c.req.header("x-signet-session-key"),
			}),
		);
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const result = handleSynthesisRequest(body, { agentId: scopedAgent.agentId });
		return c.json(result);
	} catch (e) {
		logger.error("hooks", "Synthesis request failed", e as Error);
		return c.json({ error: "Synthesis request failed" }, 500);
	}
});

// Save synthesized MEMORY.md
app.post("/api/hooks/synthesis/complete", async (c) => {
	try {
		const body = (await c.req.json()) as { content: string; agentId?: string; sessionKey?: string };

		if (!body.content) {
			return c.json({ error: "content is required" }, 400);
		}

		const worker = getSynthesisWorker();
		if (!worker) {
			return c.json({ error: "Synthesis worker not running" }, 503);
		}

		let lockToken: number | null = null;
		if (!worker.running) {
			return c.json({ error: "Synthesis worker is shutting down" }, 503);
		}

		lockToken = worker.acquireWriteLock();
		if (lockToken === null) {
			return worker.running
				? c.json({ error: "Synthesis already in progress" }, 409)
				: c.json({ error: "Synthesis worker is shutting down" }, 503);
		}

		try {
			const scopedAgent = resolveScopedAgentId(
				c,
				resolveAgentId({
					agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
					sessionKey: body.sessionKey ?? c.req.header("x-signet-session-key"),
				}),
			);
			if (scopedAgent.error) {
				return c.json({ error: scopedAgent.error }, 403);
			}
			const result = writeMemoryMd(body.content, {
				agentId: scopedAgent.agentId,
				owner: "api-hooks-synthesis-complete",
			});
			if (!result.ok) {
				const status = result.code === "busy" ? 409 : 400;
				return c.json({ error: result.error }, status);
			}
			logger.info("hooks", "MEMORY.md synthesized");
		} finally {
			if (worker && lockToken !== null) {
				worker.releaseWriteLock(lockToken);
			}
		}

		return c.json({ success: true });
	} catch (e) {
		logger.error("hooks", "Synthesis complete failed", e instanceof Error ? e : new Error(String(e)));
		return c.json({ error: "Failed to save MEMORY.md" }, 500);
	}
});

// Trigger immediate MEMORY.md synthesis
app.post("/api/synthesis/trigger", async (c) => {
	try {
		const worker = getSynthesisWorker();
		if (!worker) {
			return c.json({ error: "Synthesis worker not running" }, 503);
		}
		const result = await worker.triggerNow();
		return c.json(result);
	} catch (e) {
		logger.error("synthesis", "Synthesis trigger failed", e as Error);
		return c.json({ error: "Synthesis trigger failed" }, 500);
	}
});

// Synthesis worker status
app.get("/api/synthesis/status", (c) => {
	const worker = getSynthesisWorker();
	const config = loadMemoryConfig(AGENTS_DIR).pipelineV2.synthesis;
	const lastRunAt = readLastSynthesisTime();
	return c.json({
		running: worker?.running ?? false,
		lastRunAt: lastRunAt > 0 ? new Date(lastRunAt).toISOString() : null,
		config,
	});
});

// ============================================================================
// Session API
// ============================================================================

// List active sessions with bypass status
app.get("/api/sessions", (c) => {
	const sessions = getActiveSessions();
	return c.json({ sessions, count: sessions.length });
});

// Get single session status
app.get("/api/sessions/:key{(?!summaries$)[^/]+}", (c) => {
	const key = c.req.param("key");
	const sessions = getActiveSessions();
	const session = sessions.find((s) => s.key === key);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}
	return c.json(session);
});

// Toggle bypass for a session
app.post("/api/sessions/:key{(?!summaries$)[^/]+}/bypass", async (c) => {
	const key = c.req.param("key");
	const sessions = getActiveSessions();
	const session = sessions.find((s) => s.key === key);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	const body = await readOptionalJsonObject(c);
	if (!body || typeof body.enabled !== "boolean") {
		return c.json({ error: "enabled (boolean) is required" }, 400);
	}
	const enabled = body.enabled === true;

	if (enabled) {
		const ok = bypassSession(key);
		if (!ok) {
			return c.json({ error: "Session not found or already released" }, 404);
		}
	} else {
		unbypassSession(key);
	}
	return c.json({ key, bypassed: enabled });
});

// Renew a session — reset TTL to prevent silent eviction
app.post("/api/sessions/:key{(?!summaries$)[^/]+}/renew", (c) => {
	const key = c.req.param("key");
	const expiresAt = renewSession(key);
	if (!expiresAt) {
		return c.json({ error: "Session not found" }, 404);
	}
	return c.json({ key, renewed: true, expiresAt });
});

// Session summaries DAG
app.get("/api/sessions/summaries", (c) => {
	const accessor = getDbAccessor();
	const scopedAgent = resolveScopedAgentId(
		c,
		resolveAgentId({
			agentId: c.req.query("agentId") ?? c.req.header("x-signet-agent-id"),
			sessionKey: c.req.query("sessionKey") ?? c.req.header("x-signet-session-key"),
		}),
	);
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const scopedProject = resolveScopedProject(c, c.req.query("project"));
	if (scopedProject.error) {
		return c.json({ error: scopedProject.error }, 403);
	}
	const agentId = scopedAgent.agentId;
	const project = scopedProject.project;
	const depthRaw = c.req.query("depth");
	const depthNum = depthRaw !== undefined ? Number(depthRaw) : undefined;
	if (
		depthNum !== undefined &&
		(Number.isNaN(depthNum) || !Number.isInteger(depthNum) || depthNum < 0 || depthRaw?.trim() === "")
	) {
		return c.json({ error: "depth must be a non-negative integer" }, 400);
	}
	const limitParsed = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParsed = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 0), 200) : 50;
	const offset = Number.isFinite(offsetParsed) ? Math.max(offsetParsed, 0) : 0;

	// Check table exists
	const tableExists = accessor.withReadDb((db) =>
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get(),
	);
	if (!tableExists) {
		return c.json({ summaries: [], total: 0 });
	}

	return accessor.withReadDb((db) => {
		let where = "WHERE agent_id = ?";
		const params: unknown[] = [agentId];

		if (project) {
			where += " AND project = ?";
			params.push(project);
		}
		if (depthNum !== undefined) {
			where += " AND depth = ?";
			params.push(depthNum);
		}

		const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM session_summaries ${where}`).get(...params) as
			| { cnt: number }
			| undefined;

		const summaries = db
			.prepare(
				`SELECT id, project, depth, kind, content, token_count,
				        earliest_at, latest_at, session_key, harness, agent_id,
				        source_type, source_ref, meta_json, created_at
				 FROM session_summaries
				 ${where}
				 ORDER BY latest_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as Array<Record<string, unknown>>;

		const childCountStmt = db.prepare("SELECT COUNT(*) as cnt FROM session_summary_children WHERE parent_id = ?");

		const enriched = summaries.map((s) => {
			const childRow = childCountStmt.get(s.id) as { cnt: number } | undefined;
			return { ...s, childCount: childRow?.cnt ?? 0 };
		});

		return c.json({
			summaries: enriched,
			total: countRow?.cnt ?? 0,
		});
	});
});

app.post("/api/sessions/summaries/expand", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const id = typeof body.id === "string" ? body.id.trim() : "";
	if (!id) {
		return c.json({ error: "id is required" }, 400);
	}

	const includeTranscript =
		typeof body.includeTranscript === "boolean" ? body.includeTranscript : true;
	const transcriptCharLimit =
		typeof body.transcriptCharLimit === "number" && Number.isFinite(body.transcriptCharLimit)
			? Math.max(200, Math.min(12000, Math.trunc(body.transcriptCharLimit)))
			: undefined;
	const scopedAgent = resolveScopedAgentId(
		c,
		resolveAgentId({
			agentId:
				typeof body.agentId === "string" ? body.agentId : c.req.header("x-signet-agent-id"),
			sessionKey:
				typeof body.sessionKey === "string" ? body.sessionKey : c.req.header("x-signet-session-key"),
		}),
	);
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const scopedProject = resolveScopedProject(c, undefined);
	if (scopedProject.error) {
		return c.json({ error: scopedProject.error }, 403);
	}

	const result = expandTemporalNode(id, scopedAgent.agentId, {
		includeTranscript,
		project: scopedProject.project,
		transcriptCharLimit,
	});
	if (!result) {
		return c.json({ error: "summary node not found" }, 404);
	}
	return c.json(result);
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
	if (body.syncInterval !== undefined) gitConfig.syncInterval = body.syncInterval;
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
			return c.json({ success: false, error: "autoInstall must be true or false" }, 400);
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
// Accepts optional { targetVersion } in body to skip redundant version check
app.post("/api/update/run", async (c) => {
	let targetVersion: string | undefined;

	try {
		const body = await c.req.json<{ targetVersion?: string }>();
		if (body.targetVersion && typeof body.targetVersion === "string") {
			targetVersion = body.targetVersion;
		}
	} catch {
		// No body or invalid JSON — fall through to check
	}

	// If caller already knows the target version, skip the redundant check
	if (!targetVersion) {
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

		targetVersion = check.latestVersion ?? undefined;
	}

	const result = await runUpdateImpl(targetVersion);
	return c.json(result);
});

// ============================================================================
// Scheduled Tasks API
// ============================================================================

app.get("/api/tasks/:id/stream", (c) => {
	const taskId = c.req.param("id");

	const taskExists = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ?").get(taskId),
	);

	if (!taskExists) {
		return c.json({ error: "Task not found" }, 404);
	}

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			let dead = false;
			const cleanup = () => {
				if (dead) return;
				dead = true;
				clearInterval(keepAlive);
				unsubscribe();
			};

			const writeEvent = (event: unknown) => {
				if (dead) return;
				try {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					controller.enqueue(encoder.encode(data));
				} catch {
					cleanup();
				}
			};

			writeEvent({
				type: "connected",
				taskId,
				timestamp: new Date().toISOString(),
			});

			const snapshot = getTaskStreamSnapshot(taskId);
			if (snapshot) {
				writeEvent({
					type: "run-started",
					taskId,
					runId: snapshot.runId,
					startedAt: snapshot.startedAt,
					timestamp: new Date().toISOString(),
				});

				for (const chunk of snapshot.stdoutChunks) {
					writeEvent({
						type: "run-output",
						taskId,
						runId: snapshot.runId,
						stream: "stdout",
						chunk,
						timestamp: new Date().toISOString(),
					});
				}

				for (const chunk of snapshot.stderrChunks) {
					writeEvent({
						type: "run-output",
						taskId,
						runId: snapshot.runId,
						stream: "stderr",
						chunk,
						timestamp: new Date().toISOString(),
					});
				}
			}

			const unsubscribe = subscribeTaskStream(taskId, (event) => {
				writeEvent(event);
			});

			const keepAlive = setInterval(() => {
				if (dead) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					cleanup();
				}
			}, 15_000);

			c.req.raw.signal.addEventListener("abort", cleanup);
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
	const { name, prompt, cronExpression, harness, workingDirectory, skillName, skillMode } = body;

	if (!name || !prompt || !cronExpression || !harness) {
		return c.json({ error: "name, prompt, cronExpression, and harness are required" }, 400);
	}

	if (!validateCron(cronExpression)) {
		return c.json({ error: "Invalid cron expression" }, 400);
	}

	if (harness !== "claude-code" && harness !== "opencode" && harness !== "codex") {
		return c.json({ error: "harness must be 'claude-code', 'codex', or 'opencode'" }, 400);
	}

	if (skillName && (skillName.includes("/") || skillName.includes(".."))) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	if (skillName && skillMode !== "inject" && skillMode !== "slash") {
		return c.json({ error: "skillMode must be 'inject' or 'slash' when skillName is set" }, 400);
	}

	if (!isHarnessAvailable(harness)) {
		return c.json(
			{
				error: `CLI for ${harness} not found on PATH`,
				warning: true,
			},
			400,
		);
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const nextRunAt = computeNextRun(cronExpression);

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO scheduled_tasks
			 (id, name, prompt, cron_expression, harness, working_directory,
			  enabled, next_run_at, skill_name, skill_mode, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
		).run(
			id,
			name,
			prompt,
			cronExpression,
			harness,
			workingDirectory || null,
			nextRunAt,
			skillName || null,
			skillMode || null,
			now,
			now,
		);
	});

	logger.info("scheduler", `Task created: ${name}`, { taskId: id });
	return c.json({ id, nextRunAt }, 201);
});

// Get a single task + recent runs
app.get("/api/tasks/:id", (c) => {
	const taskId = c.req.param("id");

	const task = getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId));

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
	const nextRunAt =
		body.cronExpression !== undefined || body.enabled !== undefined
			? enabled
				? computeNextRun(cronExpr as string)
				: existing.next_run_at
			: existing.next_run_at;

	const skillName = body.skillName !== undefined ? body.skillName || null : existing.skill_name;
	const skillMode = body.skillMode !== undefined ? body.skillMode || null : existing.skill_mode;

	if (skillName && (skillName.includes("/") || skillName.includes(".."))) {
		return c.json({ error: "Invalid skill name" }, 400);
	}

	if (skillName && skillMode !== null && skillMode !== "inject" && skillMode !== "slash") {
		return c.json({ error: "skillMode must be 'inject' or 'slash' when skillName is set" }, 400);
	}

	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`UPDATE scheduled_tasks SET
			 name = ?, prompt = ?, cron_expression = ?, harness = ?,
			 working_directory = ?, enabled = ?, next_run_at = ?,
			 skill_name = ?, skill_mode = ?, updated_at = ?
			 WHERE id = ?`,
		).run(
			body.name ?? existing.name,
			body.prompt ?? existing.prompt,
			cronExpr,
			body.harness ?? existing.harness,
			body.workingDirectory !== undefined ? body.workingDirectory : existing.working_directory,
			enabled,
			nextRunAt,
			skillName,
			skillMode,
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
		db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1").get(taskId),
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

		db.prepare("UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?").run(now, now, taskId);
	});

	emitTaskStream({
		type: "run-started",
		taskId,
		runId,
		startedAt: now,
		timestamp: new Date().toISOString(),
	});

	// Narrow task fields from raw SQL result
	const taskPrompt = typeof task.prompt === "string" ? task.prompt : null;
	const taskHarness =
		task.harness === "claude-code" || task.harness === "opencode" || task.harness === "codex" ? task.harness : null;
	if (!taskPrompt || !taskHarness) {
		return c.json({ error: "Task has invalid prompt or harness" }, 500);
	}
	const taskSkillName = typeof task.skill_name === "string" ? task.skill_name : null;
	const taskSkillMode = typeof task.skill_mode === "string" ? task.skill_mode : null;
	const taskWorkingDir = typeof task.working_directory === "string" ? task.working_directory : null;

	// Resolve skill content into prompt
	const effectivePrompt = resolveSkillPrompt(taskPrompt, taskSkillName, taskSkillMode);

	// Spawn in background (don't await)
	import("./scheduler/spawn").then((mod) => {
		mod
			.spawnTask(taskHarness, effectivePrompt, taskWorkingDir, undefined, {
				onStdoutChunk: (chunk) => {
					emitTaskStream({
						type: "run-output",
						taskId,
						runId,
						stream: "stdout",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
				onStderrChunk: (chunk) => {
					emitTaskStream({
						type: "run-output",
						taskId,
						runId,
						stream: "stderr",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
			})
			.then((result) => {
				const completedAt = new Date().toISOString();
				const status =
					result.error !== null || (result.exitCode !== null && result.exitCode !== 0) ? "failed" : "completed";

				getDbAccessor().withWriteTx((db) => {
					db.prepare(
						`UPDATE task_runs
					 SET status = ?, completed_at = ?, exit_code = ?,
					     stdout = ?, stderr = ?, error = ?
					 WHERE id = ?`,
					).run(status, completedAt, result.exitCode, result.stdout, result.stderr, result.error, runId);
				});

				emitTaskStream({
					type: "run-completed",
					taskId,
					runId,
					status,
					completedAt,
					exitCode: result.exitCode,
					error: result.error,
					timestamp: new Date().toISOString(),
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
		const row = db.prepare("SELECT COUNT(*) as count FROM task_runs WHERE task_id = ?").get(taskId) as {
			count: number;
		};
		return row.count;
	});

	return c.json({ runs, total, hasMore: offset + limit < total });
});

// ============================================================================
// Daemon Info
// ============================================================================

app.get("/api/status", (c) => {
	const config = loadMemoryConfig(AGENTS_DIR);
	const configuredLogFile = readEnvTrimmed("SIGNET_LOG_FILE");
	const configuredLogDir = readEnvTrimmed("SIGNET_LOG_DIR") ?? LOG_DIR;
	const datedLogFile = join(configuredLogDir, `signet-${new Date().toISOString().slice(0, 10)}.log`);

	let health: { score: number; status: string } | undefined;
	try {
		const report = getCachedDiagnosticsReport();
		health = report.composite;
	} catch {
		// DB not ready yet — omit health
	}

	const us = getUpdateState();

	// Read agent.created from agent.yaml for agentCreatedAt
	let agentCreatedAt: string | null = null;
	try {
		for (const p of [join(AGENTS_DIR, "agent.yaml"), join(AGENTS_DIR, "AGENT.yaml")]) {
			if (existsSync(p)) {
				const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
				const agent = yaml.agent as Record<string, unknown> | undefined;
				if (agent?.created) {
					agentCreatedAt = String(agent.created);
				}
				break;
			}
		}
	} catch {
		/* ignore parse errors */
	}

	return c.json({
		status: "running",
		version: CURRENT_VERSION,
		pid: process.pid,
		uptime: process.uptime(),
		startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
		port: PORT,
		host: HOST,
		bindHost: BIND_HOST,
		networkMode: NETWORK_MODE,
		agentsDir: AGENTS_DIR,
		memoryDb: existsSync(MEMORY_DB),
		pipelineV2: config.pipelineV2,
		providerResolution: providerRuntimeResolution,
		logging: {
			logDir: configuredLogFile ? dirname(configuredLogFile) : configuredLogDir,
			logFile: configuredLogFile ?? datedLogFile,
		},
		activeSessions: activeSessionCount(),
		bypassedSessions: getBypassedSessionKeys().size,
		agentCreatedAt,
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
			...(cachedEmbeddingStatus && Date.now() - statusCacheTime < STATUS_CACHE_TTL
				? { available: cachedEmbeddingStatus.available }
				: {}),
		},
	});
});

// ============================================================================
// Home greeting
// ============================================================================

let greetingCache: { greeting: string; cachedAt: string; expires: number } | null = null;

app.get("/api/home/greeting", async (c) => {
	const now = Date.now();
	if (greetingCache && now < greetingCache.expires) {
		return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
	}

	// Read SOUL.md for voice context
	const soulPath = join(AGENTS_DIR, "SOUL.md");
	let soulContent = "";
	try {
		soulContent = readFileSync(soulPath, "utf-8").slice(0, 500);
	} catch {
		/* no soul file */
	}

	const hour = new Date().getHours();
	const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

	// Try LLM greeting
	try {
		const provider = getLlmProvider();
		if (provider) {
			const prompt = `Given this agent personality description:\n\n${soulContent}\n\nGenerate a brief ${timeOfDay} greeting in this character's voice. Max 15 words. No emojis. No quotes around the greeting.`;
			const text = await provider.generate(prompt, { timeoutMs: 10000, maxTokens: 50 });
			const greeting = text.trim().replace(/^["']|["']$/g, "");
			greetingCache = { greeting, cachedAt: new Date().toISOString(), expires: now + 3600000 };
			return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
		}
	} catch {
		/* LLM unavailable */
	}

	// Fallback
	const fallback = `good ${timeOfDay}`;
	greetingCache = { greeting: fallback, cachedAt: new Date().toISOString(), expires: now + 3600000 };
	return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
});

// ============================================================================
// Diagnostics & Repair (Phase F)
// ============================================================================

app.get("/api/diagnostics", (c) => {
	const report = getCachedDiagnosticsReport();
	return c.json(report);
});

app.get("/api/diagnostics/:domain", (c) => {
	const domain = c.req.param("domain");
	const report = getCachedDiagnosticsReport();

	const domainData = report[domain as keyof typeof report];
	if (!domainData || typeof domainData === "string") {
		return c.json({ error: `Unknown domain: ${domain}` }, 400);
	}
	return c.json(domainData);
});

// ---------------------------------------------------------------------------
// OpenClaw plugin health diagnostics
// ---------------------------------------------------------------------------

// Unauthenticated — daemon is local-only, plugin may not carry auth token
app.post("/api/diagnostics/openclaw/heartbeat", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	if (!body || typeof body !== "object") {
		return c.json({ error: "Body must be an object" }, 400);
	}
	const b = body as Record<string, unknown>;
	if (typeof b.pluginVersion !== "string") {
		return c.json({ error: "pluginVersion (string) is required" }, 400);
	}
	const prev = openClawHeartbeat?.data;
	openClawHeartbeat = {
		timestamp: new Date().toISOString(),
		data: {
			pluginVersion: b.pluginVersion.slice(0, 128),
			hooksRegistered: Array.isArray(b.hooksRegistered)
				? (b.hooksRegistered as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s.slice(0, 128)).slice(0, 50)
				: [],
			lastHookCall: typeof b.lastHookCall === "string" ? b.lastHookCall.slice(0, 512) : null,
			lastError: typeof b.lastError === "string" ? b.lastError.slice(0, 512) : null,
			latencyMs: typeof b.latencyMs === "number" && Number.isFinite(b.latencyMs) ? b.latencyMs : 0,
			// Plugin sends per-heartbeat deltas, not cumulative totals. Clamp to
			// non-negative to guard against malformed or negative inputs corrupting counters.
			lastFailedDelta: Math.max(0, typeof b.hooksFailed === "number" ? b.hooksFailed : (typeof b.errorCount === "number" ? b.errorCount : 0)),
			totalSucceeded: (prev?.totalSucceeded ?? 0) + Math.max(0, typeof b.hooksSucceeded === "number" ? b.hooksSucceeded : 0),
			totalFailed: (prev?.totalFailed ?? 0) + Math.max(0, typeof b.hooksFailed === "number" ? b.hooksFailed : (typeof b.errorCount === "number" ? b.errorCount : 0)),
		},
	};
	invalidateDiagnosticsCache();
	return c.json({ ok: true });
});

app.get("/api/diagnostics/openclaw", (c) => {
	return c.json(buildOpenClawHealth());
});

// ---------------------------------------------------------------------------
// Pipeline status (composite snapshot for dashboard visualization)
// ---------------------------------------------------------------------------

app.get("/api/pipeline/status", (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const accessor = getDbAccessor();

	const dbData = accessor.withReadDb((db) => {
		const memoryRows = db.prepare("SELECT status, COUNT(*) as count FROM memory_jobs GROUP BY status").all() as Array<{
			status: string;
			count: number;
		}>;
		const summaryRows = db
			.prepare("SELECT status, COUNT(*) as count FROM summary_jobs GROUP BY status")
			.all() as Array<{ status: string; count: number }>;

		const toCountMap = (rows: Array<{ status: string; count: number }>): Record<string, number> => {
			const out: Record<string, number> = {
				pending: 0,
				leased: 0,
				completed: 0,
				failed: 0,
				dead: 0,
			};
			for (const r of rows) out[r.status] = r.count;
			return out;
		};

		return {
			queues: {
				memory: toCountMap(memoryRows),
				summary: toCountMap(summaryRows),
			},
		};
	});
	const diagnostics = getCachedDiagnosticsReport();

	const pipelineV2 = cfg.pipelineV2;
	const mode = readPipelineMode(pipelineV2);

	// Predictor sidecar snapshot for pipeline overview
	const predictorHealth = diagnostics.predictor;
	const predictorSnapshot = {
		running: predictorHealth.status !== "disabled" && predictorHealth.sidecarAlive,
		modelReady: predictorHealth.coldStartExited,
		coldStartExited: predictorHealth.coldStartExited,
		successRate: predictorHealth.successRate,
		alpha: predictorHealth.alpha,
	};

	return c.json({
		workers: getPipelineWorkerStatus(),
		queues: dbData.queues,
		diagnostics,
		latency: analyticsCollector.getLatency(),
		errorSummary: analyticsCollector.getErrorSummary(),
		mode,
		feedback: getFeedbackTelemetry(),
		traversal: {
			enabled: pipelineV2.graph.enabled && (pipelineV2.traversal?.enabled ?? true),
			lastRun: getTraversalStatus(),
		},
		predictor: predictorSnapshot,
	});
});

const pipelineAdminGuard = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
	const perm = requirePermission("admin", authConfig);
	const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
	return perm(c, async () => rate(c, next));
};

async function togglePipelinePause(c: Context, paused: boolean): Promise<Response> {
	if (shuttingDown) {
		return c.json({ error: "Daemon is shutting down" }, 503);
	}
	if (pipelineTransition) {
		return c.json({ error: "Pipeline transition already in progress" }, 409);
	}

	const prev = readPipelinePauseState(AGENTS_DIR);
	if (!prev.exists) {
		return c.json({ error: "No Signet config file found" }, 404);
	}

	pipelineTransition = true;
	try {
		const changed = prev.paused !== paused;
		const next = changed ? setPipelinePaused(AGENTS_DIR, paused) : prev;
		if (changed) {
			await restartPipelineRuntime(loadMemoryConfig(AGENTS_DIR), telemetryRef);
		}
		const liveCfg = loadMemoryConfig(AGENTS_DIR);
		return c.json({
			success: true,
			changed,
			paused: next.paused,
			file: next.file,
			mode: readPipelineMode(liveCfg.pipelineV2),
		});
	} catch (err) {
		logger.error("pipeline", paused ? "Failed to pause pipeline" : "Failed to resume pipeline", err);
		return c.json(
			{ error: err instanceof Error ? err.message : String(err) },
			500,
		);
	} finally {
		pipelineTransition = false;
	}
}

app.use("/api/pipeline/pause", pipelineAdminGuard);
app.use("/api/pipeline/resume", pipelineAdminGuard);
app.use("/api/pipeline/nudge", async (c, next) => {
	return requirePermission("admin", authConfig)(c, next);
});

app.post("/api/pipeline/pause", (c) => {
	return togglePipelinePause(c, true);
});

app.post("/api/pipeline/resume", (c) => {
	return togglePipelinePause(c, false);
});

app.post("/api/pipeline/nudge", (c) => {
	if (!nudgeExtractionWorker()) {
		return c.json({ error: "Extraction worker not running" }, 503);
	}
	return c.json({ nudged: true });
});

// ---------------------------------------------------------------------------
// Model Registry endpoints
// ---------------------------------------------------------------------------

app.get("/api/pipeline/models", (c) => {
	const provider = c.req.query("provider");
	const includeDeprecated = c.req.query("deprecated") === "true";
	return c.json({
		models: getAvailableModels(provider ?? undefined, includeDeprecated),
		registry: getRegistryStatus(),
	});
});

app.get("/api/pipeline/models/by-provider", (c) => {
	return c.json(getModelsByProvider());
});

let lastRefreshRequestAt = 0;
const REFRESH_COOLDOWN_MS = 60_000;

app.post("/api/pipeline/models/refresh", async (c) => {
	const now = Date.now();
	if (now - lastRefreshRequestAt < REFRESH_COOLDOWN_MS) {
		return c.json(
			{
				models: getModelsByProvider(),
				registry: getRegistryStatus(),
				throttled: true,
			},
			429,
		);
	}
	lastRefreshRequestAt = now;
	const cfg = loadMemoryConfig(AGENTS_DIR);
	let anthropicKey: string | undefined = process.env.ANTHROPIC_API_KEY;
	if (!anthropicKey) {
		try {
			anthropicKey = (await getSecret("ANTHROPIC_API_KEY")) ?? undefined;
		} catch {
			/* ignore */
		}
	}
	let openRouterKey: string | undefined = process.env.OPENROUTER_API_KEY;
	if (!openRouterKey) {
		try {
			openRouterKey = (await getSecret("OPENROUTER_API_KEY")) ?? undefined;
		} catch {
			/* ignore */
		}
	}
	await refreshRegistry(
		resolveRegistryOllamaBaseUrl(cfg.pipelineV2.extraction.provider, cfg.pipelineV2.extraction.endpoint),
		anthropicKey,
		openRouterKey,
		resolveRegistryOpenRouterBaseUrl(cfg.pipelineV2.extraction.provider, cfg.pipelineV2.extraction.endpoint),
	);
	return c.json({
		models: getModelsByProvider(),
		registry: getRegistryStatus(),
	});
});

app.get("/api/predictor/status", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const predictorCfg = cfg.pipelineV2.predictor;

	if (!predictorCfg?.enabled) {
		return c.json({ enabled: false, status: null });
	}

	const client = getPredictorClient();
	if (client === null) {
		return c.json({
			enabled: true,
			alive: false,
			crashCount: 0,
			crashDisabled: false,
			status: null,
		});
	}

	const status = await client.status();
	return c.json({
		enabled: true,
		alive: client.isAlive(),
		crashCount: client.crashCount,
		crashDisabled: client.crashDisabled,
		status,
	});
});

function resolveRepairContext(c: Context): RepairContext {
	const reason = c.req.header("x-signet-reason") ?? "manual repair";
	const actor = c.req.header("x-signet-actor") ?? "operator";
	const actorType = (c.req.header("x-signet-actor-type") ?? "operator") as "operator" | "agent" | "daemon";
	const requestId = c.req.header("x-signet-request-id") ?? crypto.randomUUID();
	return { reason, actor, actorType, requestId };
}

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
	// The retention handle is internal to pipeline — import not needed,
	// we can call the repair action with a minimal sweep handle via
	// the retention worker's public API. For now, return 501 if the
	// retention worker isn't running (pipeline not started).
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
			// Check if table exists
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
	const result = getDbAccessor().withWriteTx((db) =>
		clusterEntities(db, agentId),
	);
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

	// Find memories with no entity mentions
	const unlinked = accessor.withReadDb((db) =>
		db.prepare(
			`SELECT id, content FROM memories
			 WHERE is_deleted = 0
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)
			 LIMIT ?`,
		).all(batchSize) as Array<{ id: string; content: string }>,
	);

	if (unlinked.length === 0) {
		return c.json({ action: "relink-entities", linked: 0, remaining: 0, message: "all memories linked" });
	}

	let linked = 0;
	let entities = 0;
	let aspects = 0;
	let attributes = 0;

	for (const mem of unlinked) {
		const result = accessor.withWriteTx((db) =>
			linkMemoryToEntities(db, mem.id, mem.content, agentId),
		);
		linked += result.linked;
		entities += result.entityIds.length;
		aspects += result.aspects;
		attributes += result.attributes;
	}

	// Check how many remain
	const remaining = accessor.withReadDb((db) =>
		(db.prepare(
			`SELECT COUNT(*) as cnt FROM memories
			 WHERE is_deleted = 0
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)`,
		).get() as { cnt: number }).cnt,
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
	// Find unscoped memories that have no hints yet
	const unhinted = accessor.withReadDb((db) =>
		db.prepare(
			`SELECT m.id, m.content FROM memories m
			 WHERE m.is_deleted = 0 AND m.scope IS NULL
			   AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)
			 ORDER BY m.created_at DESC
			 LIMIT ?`,
		).all(batchSize) as Array<{ id: string; content: string }>,
	);

	if (unhinted.length === 0) {
		return c.json({ action: "backfill-hints", enqueued: 0, remaining: 0, message: "all unscoped memories have hints" });
	}

	const { enqueueHintsJob: enqueue } = await import("./pipeline/prospective-index.js");
	let enqueued = 0;
	accessor.withWriteTx((db) => {
		for (const mem of unhinted) {
			enqueue(db, mem.id, mem.content);
			enqueued++;
		}
	});

	const remaining = accessor.withReadDb((db) =>
		(db.prepare(
			`SELECT COUNT(*) as cnt FROM memories
			 WHERE is_deleted = 0 AND scope IS NULL
			   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)`,
		).get() as { cnt: number }).cnt,
	);

	return c.json({
		action: "backfill-hints",
		enqueued,
		remaining,
		message: remaining > 0 ? `${remaining} unscoped memories still need hints — call again` : "all unscoped memories have hints",
	});
});

// ---------------------------------------------------------------------------
// Dead memory hygiene
// ---------------------------------------------------------------------------

app.get("/api/repair/dead-memories", (c) => {
	const maxConfidence = Number(c.req.query("maxConfidence") ?? "0.1");
	const maxAccessDays = Number(c.req.query("maxAccessDays") ?? "90");
	const limit = Math.min(Number(c.req.query("limit") ?? "200"), 500);
	if (
		!Number.isFinite(maxConfidence) || !Number.isFinite(maxAccessDays) || !Number.isFinite(limit)
		|| maxConfidence < 0 || maxConfidence > 1 || maxAccessDays < 0 || limit < 0
	) {
		return c.json({ error: "maxConfidence must be 0–1, maxAccessDays and limit must be non-negative" }, 400);
	}
	const dead = getDbAccessor().withReadDb((db) =>
		findDeadMemories(db, { maxConfidence, maxAccessDays, limit }),
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
	const forgotten = forgetDeadMemories(getDbAccessor(), validIds);
	return c.json({ forgotten });
});

// ============================================================================
// Troubleshooter — live terminal command execution
// ============================================================================

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

	// Lifecycle commands (stop/restart) can't stream through the general
	// exec pipeline — the child process would kill its parent mid-stream.
	// Handle directly: flush SSE output, then schedule graceful shutdown.
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

				// Give the response time to flush, then trigger graceful shutdown.
				// SIGTERM triggers cleanup() which handles PID file, DB, watchers.
				setTimeout(async () => {
					if (key === "daemon-restart") {
						const { spawn: nodeSpawn } = await import("node:child_process");
						// Use array form — no shell, so paths with spaces are safe.
						// Inner delay lets cleanup() finish before the new daemon starts.
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

			// 60s timeout — SIGTERM first, force kill after 5s
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

// ============================================================================
// Session Checkpoints (Continuity Protocol)
// ============================================================================

app.get("/api/checkpoints", (c) => {
	const project = c.req.query("project");
	const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

	if (!project) {
		return c.json({ error: "project query parameter required" }, 400);
	}

	// Normalize project path for consistent matching
	let projectNormalized = project;
	try {
		projectNormalized = realpathSync(project);
	} catch {
		// Use raw path if realpath fails
	}

	const rows = getCheckpointsByProject(getDbAccessor(), projectNormalized, Math.min(limit, 100));
	const redacted = rows.map(redactCheckpointRow);
	return c.json({ checkpoints: redacted, count: redacted.length });
});

app.get("/api/checkpoints/:sessionKey", (c) => {
	const sessionKey = c.req.param("sessionKey");
	const rows = getCheckpointsBySession(getDbAccessor(), sessionKey);
	const redacted = rows.map(redactCheckpointRow);
	return c.json({ checkpoints: redacted, count: redacted.length });
});

// ============================================================================
// Knowledge Graph
// ============================================================================

app.get("/api/knowledge/entities", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
	const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

	return c.json({
		items: listKnowledgeEntities(getDbAccessor(), {
			agentId,
			type: c.req.query("type") ?? undefined,
			query: c.req.query("q") ?? undefined,
			limit,
			offset,
		}),
		limit,
		offset,
	});
});

app.post("/api/knowledge/entities/:id/pin", async (c) => {
	return requirePermission("modify", authConfig)(c, async () => {
		const agentId = c.req.query("agent_id") ?? "default";
		pinEntity(getDbAccessor(), c.req.param("id"), agentId);
		const entity = getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId);
		if (!entity?.entity.pinnedAt) {
			return c.json({ error: "Entity not found" }, 404);
		}
		return c.json({ pinned: true, pinnedAt: entity.entity.pinnedAt });
	});
});

app.delete("/api/knowledge/entities/:id/pin", async (c) => {
	return requirePermission("modify", authConfig)(c, async () => {
		const agentId = c.req.query("agent_id") ?? "default";
		unpinEntity(getDbAccessor(), c.req.param("id"), agentId);
		return c.json({ pinned: false });
	});
});

app.get("/api/knowledge/entities/pinned", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json(getPinnedEntities(getDbAccessor(), agentId));
});

app.get("/api/knowledge/entities/health", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const minComparisonsParam = Number.parseInt(c.req.query("min_comparisons") ?? "3", 10);
	return c.json(
		getEntityHealth(
			getDbAccessor(),
			agentId,
			c.req.query("since") ?? undefined,
			Number.isFinite(minComparisonsParam) ? Math.max(minComparisonsParam, 1) : 3,
		),
	);
});

app.get("/api/knowledge/entities/:id", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const entity = getKnowledgeEntityDetail(getDbAccessor(), c.req.param("id"), agentId);
	if (!entity) {
		return c.json({ error: "Entity not found" }, 404);
	}
	return c.json(entity);
});

app.get("/api/knowledge/entities/:id/aspects", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json({
		items: getEntityAspectsWithCounts(getDbAccessor(), c.req.param("id"), agentId),
	});
});

app.get("/api/knowledge/entities/:id/aspects/:aspectId/attributes", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
	const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;
	const kind = c.req.query("kind");
	const status = c.req.query("status");

	return c.json({
		items: getAttributesForAspectFiltered(getDbAccessor(), {
			entityId: c.req.param("id"),
			aspectId: c.req.param("aspectId"),
			agentId,
			kind: kind === "attribute" || kind === "constraint" ? kind : undefined,
			status: status === "active" || status === "superseded" || status === "deleted" ? status : undefined,
			limit,
			offset,
		}),
		limit,
		offset,
	});
});

app.get("/api/knowledge/entities/:id/dependencies", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const directionQuery = c.req.query("direction");
	const direction =
		directionQuery === "incoming" || directionQuery === "outgoing" || directionQuery === "both"
			? directionQuery
			: "both";
	return c.json({
		items: getEntityDependenciesDetailed(getDbAccessor(), {
			entityId: c.req.param("id"),
			agentId,
			direction,
		}),
	});
});

app.get("/api/knowledge/stats", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json(getKnowledgeStats(getDbAccessor(), agentId));
});

app.get("/api/knowledge/communities", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const rows = getDbAccessor().withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, name, cohesion, member_count, created_at, updated_at
				 FROM entity_communities
				 WHERE agent_id = ?
				 ORDER BY member_count DESC`,
			)
			.all(agentId) as ReadonlyArray<{
			id: string;
			name: string | null;
			cohesion: number;
			member_count: number;
			created_at: string;
			updated_at: string;
		}>;
	});
	return c.json({ items: rows, count: rows.length });
});

app.get("/api/knowledge/traversal/status", (c) => {
	return c.json({
		status: getTraversalStatus(),
	});
});

app.get("/api/knowledge/constellation", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	return c.json(getKnowledgeGraphForConstellation(getDbAccessor(), agentId));
});

app.post("/api/knowledge/expand", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const entityName = typeof body.entity === "string" ? body.entity.trim() : "";
	const aspectFilter = typeof body.aspect === "string" ? body.aspect.trim() : undefined;
	const maxTokens = typeof body.maxTokens === "number" ? Math.min(body.maxTokens, 10000) : 2000;

	if (!entityName) {
		return c.json({ error: "entity name is required" }, 400);
	}

	const agentId = "default";

	const focal = getDbAccessor().withReadDb((db) =>
		resolveFocalEntities(db, agentId, {
			queryTokens: entityName.split(/\s+/),
		}),
	);

	if (focal.entityIds.length === 0) {
		return c.json(
			{
				error: `Entity "${entityName}" not found`,
				entity: null,
				constraints: [],
				aspects: [],
				dependencies: [],
				memoryCount: 0,
				memories: [],
			},
			404,
		);
	}

	const cfg = loadMemoryConfig(AGENTS_DIR);
	const traversalCfg = cfg.pipelineV2.traversal ?? {
		maxAspectsPerEntity: 10,
		maxAttributesPerAspect: 20,
		maxDependencyHops: 10,
		minDependencyStrength: 0.3,
		maxBranching: 4,
		maxTraversalPaths: 50,
		minConfidence: 0.5,
		timeoutMs: 500,
	};

	const primaryEntityId = focal.entityIds[0];

	return getDbAccessor().withReadDb((db) => {
		const traversal = traverseKnowledgeGraph(focal.entityIds, db, agentId, {
			maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
			maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
			maxDependencyHops: traversalCfg.maxDependencyHops,
			minDependencyStrength: traversalCfg.minDependencyStrength,
			maxBranching: traversalCfg.maxBranching,
			maxTraversalPaths: traversalCfg.maxTraversalPaths,
			minConfidence: traversalCfg.minConfidence,
			timeoutMs: traversalCfg.timeoutMs,
			aspectFilter: aspectFilter || undefined,
		});

		// Hydrate entity details
		const entityRow = db
			.prepare(
				`SELECT id, name, entity_type, description
				 FROM entities WHERE id = ?`,
			)
			.get(primaryEntityId) as
			| {
					id: string;
					name: string;
					entity_type: string;
					description: string | null;
			  }
			| undefined;

		// Get aspects with their attributes
		const aspectFilterClause = aspectFilter ? "AND ea.canonical_name LIKE ?" : "";
		const aspectArgs = aspectFilter
			? [primaryEntityId, agentId, `%${aspectFilter}%`, traversalCfg.maxAspectsPerEntity]
			: [primaryEntityId, agentId, traversalCfg.maxAspectsPerEntity];

		const aspects = db
			.prepare(
				`SELECT ea.id, ea.canonical_name, ea.weight
				 FROM entity_aspects ea
				 WHERE ea.entity_id = ? AND ea.agent_id = ?
				 ${aspectFilterClause}
				 ORDER BY ea.weight DESC
				 LIMIT ?`,
			)
			.all(...aspectArgs) as Array<{
			id: string;
			canonical_name: string;
			weight: number;
		}>;

		const aspectsWithAttributes = aspects.map((aspect) => {
			const attrs = db
				.prepare(
					`SELECT content, kind, importance, confidence
					 FROM entity_attributes
					 WHERE aspect_id = ? AND agent_id = ?
					   AND status = 'active'
					 ORDER BY importance DESC
					 LIMIT ?`,
				)
				.all(aspect.id, agentId, traversalCfg.maxAttributesPerAspect) as Array<{
				content: string;
				kind: string;
				importance: number;
				confidence: number;
			}>;
			return {
				name: aspect.canonical_name,
				weight: aspect.weight,
				attributes: attrs,
			};
		});

		// Get dependencies
		const deps = db
			.prepare(
				`SELECT e.name as target, ed.dependency_type as type,
				        ed.strength
				 FROM entity_dependencies ed
				 JOIN entities e ON e.id = ed.target_entity_id
				 WHERE ed.source_entity_id = ?
				   AND ed.agent_id = ?
				   AND ed.strength >= ?
				 ORDER BY ed.strength DESC
				 LIMIT ?`,
			)
			.all(primaryEntityId, agentId, traversalCfg.minDependencyStrength, traversalCfg.maxDependencyHops) as Array<{
			target: string;
			type: string;
			strength: number;
		}>;

		// Hydrate memory content up to token budget
		let tokenBudget = maxTokens;
		const hydratedMemories: Array<{
			id: string;
			content: string;
		}> = [];
		for (const memId of traversal.memoryIds) {
			if (tokenBudget <= 0) break;
			const mem = db
				.prepare(
					`SELECT id, content FROM memories
					 WHERE id = ? AND is_deleted = 0`,
				)
				.get(memId) as { id: string; content: string } | undefined;
			if (mem) {
				const approxTokens = Math.ceil(mem.content.length / 4);
				if (approxTokens <= tokenBudget) {
					hydratedMemories.push(mem);
					tokenBudget -= approxTokens;
				}
			}
		}

		return c.json({
			entity: entityRow
				? {
						id: entityRow.id,
						name: entityRow.name,
						type: entityRow.entity_type,
						description: entityRow.description,
					}
				: null,
			constraints: traversal.constraints,
			aspects: aspectsWithAttributes,
			dependencies: deps,
			memoryCount: traversal.memoryIds.size,
			memories: hydratedMemories,
		});
	});
});

// ============================================================================
// Session Expansion (DP-4)
// ============================================================================

app.post("/api/knowledge/expand/session", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const entityName =
		typeof body.entityName === "string" ? body.entityName.trim() : "";
	const scopedAgent = resolveScopedAgentId(
		c,
		resolveAgentId({
			agentId:
				typeof body.agentId === "string"
					? body.agentId
					: c.req.header("x-signet-agent-id"),
			sessionKey:
				typeof body.sessionId === "string"
					? body.sessionId
					: c.req.header("x-signet-session-key"),
		}),
	);
	if (scopedAgent.error) {
		return c.json({ error: scopedAgent.error }, 403);
	}
	const scopedProject = resolveScopedProject(c, undefined);
	if (scopedProject.error) {
		return c.json({ error: scopedProject.error }, 403);
	}
	const agentId = scopedAgent.agentId;
	const sessionId =
		typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
	const timeRange =
		typeof body.timeRange === "string" ? body.timeRange.trim() : undefined;
	const maxResults =
		typeof body.maxResults === "number"
			? Math.max(1, Math.min(body.maxResults, 50))
			: 10;

	if (!entityName) {
		return c.json({ error: "entityName is required" }, 400);
	}

	return getDbAccessor().withReadDb((db) => {
		// Check if session_summaries table exists
		const tbl = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'",
			)
			.get() as { name: string } | undefined;
		if (!tbl) {
			return c.json({ entityName, summaries: [], total: 0 });
		}

		// Resolve entity by canonical_name match
		const entity = db
			.prepare(
				`SELECT id, name FROM entities
				 WHERE canonical_name LIKE ?
				   AND agent_id = ?
				 ORDER BY mentions DESC, updated_at DESC
				 LIMIT 1`,
			)
			.get(`%${entityName.toLowerCase()}%`, agentId) as
			| { id: string; name: string }
			| undefined;

		if (!entity) {
			return c.json({ entityName, summaries: [], total: 0 });
		}

		// Build query: session_summaries ← session_summary_memories
		//   ← memory_entity_mentions → entities
		const conditions = [
			"mem.entity_id = ?",
			"ss.agent_id = ?",
			"ss.kind = 'session'",
			"COALESCE(ss.source_type, 'summary') = 'summary'",
		];
		const args: Array<string | number> = [entity.id, agentId];

		if (scopedProject.project) {
			conditions.push("ss.project = ?");
			args.push(scopedProject.project);
		}

		if (sessionId) {
			conditions.push("ss.session_key = ?");
			args.push(sessionId);
		}

		if (timeRange === "last_week") {
			conditions.push(
				"ss.latest_at >= datetime('now', '-7 days')",
			);
		} else if (timeRange === "last_month") {
			conditions.push(
				"ss.latest_at >= datetime('now', '-30 days')",
			);
		} else if (timeRange && timeRange.length > 0) {
			conditions.push("ss.latest_at >= ?");
			args.push(timeRange);
		}

		const rows = db
			.prepare(
				`SELECT DISTINCT ss.id, ss.content, ss.session_key,
				        ss.harness, ss.earliest_at, ss.latest_at
				 FROM session_summaries ss
				 JOIN session_summary_memories ssm
				   ON ssm.summary_id = ss.id
				 JOIN memory_entity_mentions mem
				   ON mem.memory_id = ssm.memory_id
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY ss.latest_at DESC
				 LIMIT ?`,
			)
			.all(...args, maxResults) as Array<{
			id: string;
			content: string;
			session_key: string | null;
			harness: string | null;
			earliest_at: string;
			latest_at: string;
		}>;

		return c.json({
			entityName: entity.name,
			summaries: rows.map((row) => ({
				id: row.id,
				sessionKey: row.session_key,
				harness: row.harness,
				earliestAt: row.earliest_at,
				latestAt: row.latest_at,
				content: row.content,
			})),
			total: rows.length,
		});
	});
});

// ============================================================================
// Graph Impact Analysis (DP-4)
// ============================================================================

app.post("/api/graph/impact", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const entityId =
		typeof body.entityId === "string" ? body.entityId.trim() : "";
	const direction =
		body.direction === "upstream" ? "upstream" : "downstream";
	const maxDepth =
		typeof body.maxDepth === "number"
			? Math.max(1, Math.min(body.maxDepth, 10))
			: 3;

	if (!entityId) {
		return c.json({ error: "entityId is required" }, 400);
	}

	const result = getDbAccessor().withReadDb((db) =>
		walkImpact(db, { entityId, direction, maxDepth, timeoutMs: 200 }),
	);
	return c.json(result);
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
	const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
	return c.json({
		errors: analyticsCollector.getErrors({ stage, since, limit }),
		summary: analyticsCollector.getErrorSummary(),
	});
});

app.get("/api/analytics/latency", (c) => {
	return c.json(analyticsCollector.getLatency());
});

app.get("/api/analytics/logs", (c) => {
	const limit = Number.parseInt(c.req.query("limit") || "100", 10);
	const level = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
	const category = c.req.query("category") as any;
	const since = c.req.query("since") ? new Date(c.req.query("since")!) : undefined;
	const logs = logger.getRecent({ limit, level, category, since });
	return c.json({ logs, count: logs.length });
});

app.get("/api/analytics/memory-safety", (c) => {
	const mutationHealth = getDbAccessor().withReadDb((db) =>
		getDiagnostics(db, providerTracker, getUpdateState(), buildPredictorHealthParams()),
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
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);

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
	const trend = scoreValues.length >= 2 ? scoreValues[scoreValues.length - 1] - scoreValues[0] : 0;
	const avg = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0;

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

app.get("/api/predictor/comparisons/by-project", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const since = c.req.query("since") ?? undefined;
	return c.json({
		items: getComparisonsByProject(getDbAccessor(), agentId, since),
	});
});

app.get("/api/predictor/comparisons/by-entity", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const since = c.req.query("since") ?? undefined;
	return c.json({
		items: getComparisonsByEntity(getDbAccessor(), agentId, since),
	});
});

app.get("/api/predictor/comparisons", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
	const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

	const result = listComparisons(getDbAccessor(), {
		agentId,
		project: c.req.query("project") ?? undefined,
		entityId: c.req.query("entity_id") ?? undefined,
		since: c.req.query("since") ?? undefined,
		until: c.req.query("until") ?? undefined,
		limit,
		offset,
	});

	return c.json({
		total: result.total,
		limit,
		offset,
		items: result.rows,
	});
});

app.get("/api/predictor/training", (c) => {
	const agentId = c.req.query("agent_id") ?? "default";
	const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10);
	const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;

	return c.json({
		items: listTrainingRuns(getDbAccessor(), agentId, limit),
	});
});

app.get("/api/predictor/training-pairs-count", (c) => {
	const count = getDbAccessor().withReadDb(
		(db) => (db.prepare("SELECT COUNT(*) as c FROM predictor_training_pairs").get() as { c: number }).c,
	);
	return c.json({ count });
});

app.post("/api/predictor/train", async (c) => {
	const cfg = loadMemoryConfig(AGENTS_DIR);
	const predictorCfg = cfg.pipelineV2.predictor;
	if (!predictorCfg?.enabled) {
		return c.json({ error: "Predictor is not enabled" }, 400);
	}
	const client = getPredictorClient();
	if (!client || !client.isAlive()) {
		return c.json({ error: "Predictor sidecar is not running" }, 503);
	}

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		/* no body */
	}
	const limit = typeof body.limit === "number" ? body.limit : 5000;
	const epochs = typeof body.epochs === "number" ? body.epochs : 3;

	const dbPath = join(AGENTS_DIR, "memory", "memories.db");
	const checkpointPath = resolvePredictorCheckpointPath(predictorCfg);
	const result = await client.trainFromDb({
		db_path: dbPath,
		checkpoint_path: checkpointPath,
		limit,
		epochs,
	});
	if (!result) {
		return c.json({ error: "Training did not return a result" }, 500);
	}

	const checkpointSaved = result.checkpoint_saved || (await client.saveCheckpoint(checkpointPath));

	// Record the run in the training log and update state
	const agentId = "default";
	const { recordTrainingRun } = await import("./predictor-comparisons");
	const { updatePredictorState } = await import("./predictor-state");
	recordTrainingRun(getDbAccessor(), {
		agentId,
		modelVersion: result.step,
		loss: result.loss,
		sampleCount: result.samples_used,
		durationMs: result.duration_ms,
		canaryScoreVariance: result.canary_score_variance,
		canaryTopkChurn: result.canary_topk_stability,
	});
	updatePredictorState(agentId, { lastTrainingAt: new Date().toISOString() });
	invalidateDiagnosticsCache();

	return c.json({
		...result,
		checkpoint_path: checkpointPath,
		checkpoint_saved: checkpointSaved,
	});
});


// ---------------------------------------------------------------------------
// Telemetry endpoints
// ---------------------------------------------------------------------------

app.get("/api/telemetry/events", (c) => {
	if (!telemetryRef) {
		return c.json({ events: [], enabled: false });
	}
	const event = c.req.query("event") as TelemetryEventType | undefined;
	const since = c.req.query("since");
	const until = c.req.query("until");
	const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const events = telemetryRef.query({ event, since, until, limit });
	return c.json({ events, enabled: true });
});

app.get("/api/telemetry/stats", (c) => {
	if (!telemetryRef) {
		return c.json({ enabled: false });
	}
	const since = c.req.query("since");
	const events = telemetryRef.query({ since, limit: 10000 });

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCost = 0;
	let llmCalls = 0;
	let llmErrors = 0;
	let pipelineErrors = 0;
	const latencies: number[] = [];

	for (const e of events) {
		if (e.event === "llm.generate") {
			llmCalls++;
			if (typeof e.properties.inputTokens === "number") totalInputTokens += e.properties.inputTokens;
			if (typeof e.properties.outputTokens === "number") totalOutputTokens += e.properties.outputTokens;
			if (typeof e.properties.totalCost === "number") totalCost += e.properties.totalCost;
			if (e.properties.success === false) llmErrors++;
			if (typeof e.properties.durationMs === "number") latencies.push(e.properties.durationMs);
		}
		if (e.event === "pipeline.error") pipelineErrors++;
	}

	latencies.sort((a, b) => a - b);
	const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
	const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

	return c.json({
		enabled: true,
		totalEvents: events.length,
		llm: { calls: llmCalls, errors: llmErrors, totalInputTokens, totalOutputTokens, totalCost, p50, p95 },
		pipelineErrors,
	});
});

app.get("/api/telemetry/export", (c) => {
	if (!telemetryRef) {
		return c.text("telemetry not enabled", 404);
	}
	const since = c.req.query("since");
	const limit = Number.parseInt(c.req.query("limit") ?? "10000", 10);
	const events = telemetryRef.query({ since, limit });

	const lines = events.map((e) => JSON.stringify(e)).join("\n");
	return c.text(lines, 200, { "Content-Type": "application/x-ndjson" });
});

app.get("/api/telemetry/training-export", async (c) => {
	const { exportTrainingPairs } = await import("./predictor-training-pairs");
	const agentId = c.req.query("agent_id") ?? "default";
	const since = c.req.query("since");
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "1000", 10);
	const limit = Math.min(Math.max(1, rawLimit), 10000);
	const format = c.req.query("format") ?? "ndjson";

	const pairs = exportTrainingPairs(getDbAccessor(), agentId, { since, limit });

	if (format === "csv") {
		const header = [
			"id",
			"agent_id",
			"session_key",
			"memory_id",
			"recency_days",
			"access_count",
			"importance",
			"decay_factor",
			"embedding_similarity",
			"entity_slot",
			"aspect_slot",
			"is_constraint",
			"structural_density",
			"fts_hit_count",
			"agent_relevance_score",
			"continuity_score",
			"fts_overlap_score",
			"combined_label",
			"was_injected",
			"predictor_rank",
			"baseline_rank",
			"created_at",
		].join(",");

		// RFC 4180: escape fields containing commas, quotes, or newlines
		function csvEscape(value: unknown): string {
			const str = value === null || value === undefined ? "" : String(value);
			if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
				return `"${str.replace(/"/g, '""')}"`;
			}
			return str;
		}

		const rows = pairs.map((p) =>
			[
				p.id,
				p.agentId,
				p.sessionKey,
				p.memoryId,
				p.features.recencyDays,
				p.features.accessCount,
				p.features.importance,
				p.features.decayFactor,
				p.features.embeddingSimilarity ?? "",
				p.features.entitySlot ?? "",
				p.features.aspectSlot ?? "",
				p.features.isConstraint ? 1 : 0,
				p.features.structuralDensity ?? "",
				p.features.ftsHitCount,
				p.label.agentRelevanceScore ?? "",
				p.label.continuityScore ?? "",
				p.label.ftsOverlapScore ?? "",
				p.label.combined,
				p.wasInjected ? 1 : 0,
				p.predictorRank ?? "",
				p.baselineRank ?? "",
				p.createdAt,
			]
				.map(csvEscape)
				.join(","),
		);

		return c.text([header, ...rows].join("\n"), 200, {
			"Content-Type": "text/csv",
		});
	}

	// Default: NDJSON
	const ndjsonLines = pairs.map((p) => JSON.stringify(p)).join("\n");
	return c.text(ndjsonLines, 200, { "Content-Type": "application/x-ndjson" });
});

app.get("/api/timeline/:id", (c) => {
	const entityId = c.req.param("id");
	const timeline = getDbAccessor().withReadDb((db) =>
		buildTimeline(
			{
				db,
				getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
				getRecentErrors: (opts) => analyticsCollector.getErrors({ limit: opts?.limit }),
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
			getRecentErrors: (opts) => analyticsCollector.getErrors({ limit: opts?.limit }),
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

/**
 * Auto-detect the git branch for sync. Detection order:
 * 1. Remote default branch via `git symbolic-ref refs/remotes/{remote}/HEAD`
 * 2. Current local branch via `git rev-parse --abbrev-ref HEAD`
 * 3. Falls back to "main" if neither succeeds (no git repo, no remote, etc.)
 */
function detectGitBranch(remote: string): string {
	try {
		// Try remote's default branch first (e.g. refs/remotes/origin/HEAD -> origin/main)
		const ref = execFileSync("git", ["symbolic-ref", `refs/remotes/${remote}/HEAD`], {
			cwd: AGENTS_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		// ref looks like "refs/remotes/origin/main" — extract the branch name
		const prefix = `refs/remotes/${remote}/`;
		if (ref.startsWith(prefix)) {
			return ref.slice(prefix.length);
		}
	} catch {
		// Remote HEAD not set — fall through to local branch
	}

	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: AGENTS_DIR,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
			windowsHide: true,
		}).trim();
		if (branch && branch !== "HEAD") {
			return branch;
		}
	} catch {
		// Not a git repo or detached HEAD — fall through to default
	}

	return "main";
}

function loadGitConfig(): GitConfig {
	const defaults: GitConfig = {
		enabled: true,
		autoCommit: true,
		autoSync: true, // enabled by default - credentials auto-detected from gh, ssh, or credential helper
		syncInterval: 300, // 5 minutes
		remote: "origin",
		branch: "", // populated below after remote is resolved
	};

	const paths = [join(AGENTS_DIR, "agent.yaml"), join(AGENTS_DIR, "AGENT.yaml")];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
			const git = yaml.git as Record<string, any> | undefined;
			if (git) {
				if (git.enabled !== undefined) defaults.enabled = git.enabled === "true" || git.enabled === true;
				if (git.autoCommit !== undefined) defaults.autoCommit = git.autoCommit === "true" || git.autoCommit === true;
				if (git.autoSync !== undefined) defaults.autoSync = git.autoSync === "true" || git.autoSync === true;
				if (git.syncInterval !== undefined) defaults.syncInterval = Number.parseInt(git.syncInterval, 10);
				if (git.remote) defaults.remote = git.remote;
				if (git.branch) defaults.branch = git.branch;
			}
			break;
		} catch {
			// ignore parse errors
		}
	}

	// Auto-detect branch if not explicitly configured in agent.yaml
	if (!defaults.branch) {
		defaults.branch = detectGitBranch(defaults.remote);
	}

	return defaults;
}

const gitConfig = loadGitConfig();
let gitSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastGitSync: Date | null = null;
let gitSyncInProgress = false;
let gitSyncPromise: Promise<unknown> | null = null;

function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

// Git credential resolution result
interface GitCredentials {
	method: "token" | "gh" | "credential-helper" | "ssh" | "no-remote" | "none";
	authUrl?: string; // For HTTPS with embedded auth
	usePlainGit?: boolean; // For SSH - just run git without URL modification
}

// Run a command and return stdout/stderr
async function runCommand(
	cmd: string,
	args: string[],
	options?: { input?: string; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd: options?.cwd, stdio: "pipe", windowsHide: true });
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
async function getRemoteUrl(dir: string, remote: string): Promise<string | null> {
	const result = await runCommand("git", ["remote", "get-url", remote], {
		cwd: dir,
	});
	return result.code === 0 ? result.stdout.trim() : null;
}

// Build authenticated URL from token
function buildAuthUrlFromToken(baseUrl: string, token: string): string {
	// Convert SSH to HTTPS if needed (github-specific shorthand)
	let url = baseUrl;
	if (url.startsWith("git@github.com:")) {
		url = url.replace("git@github.com:", "https://github.com/");
	}

	// Embed token in any HTTPS URL — strip existing auth first
	if (url.startsWith("https://")) {
		url = url.replace(/https:\/\/[^@]+@/, "https://");
		return url.replace("https://", `https://${token}@`);
	}
	return url;
}

// Build authenticated URL from username/password
function buildAuthUrlFromCreds(baseUrl: string, creds: { username: string; password: string }): string {
	let url = baseUrl;
	// Convert SSH to HTTPS if needed (github-specific shorthand)
	if (url.startsWith("git@github.com:")) {
		url = url.replace("git@github.com:", "https://github.com/");
	}
	if (!url.startsWith("https://")) return url;
	// Remove existing auth if any, then embed credentials
	url = url.replace(/https:\/\/[^@]+@/, "https://");
	return url.replace(
		"https://",
		`https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@`,
	);
}

// Get credentials from git credential helper
async function getCredentialHelperToken(
	url: string,
	cwd?: string,
): Promise<{ username: string; password: string } | null> {
	try {
		// Parse URL to get host
		const urlObj = new URL(url);
		const input = `protocol=${urlObj.protocol.replace(":", "")}\nhost=${urlObj.host}\n\n`;
		const result = await runCommand("git", ["credential", "fill"], {
			input,
			cwd,
		});

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
	// No remote configured means nothing to push/pull
	if (!isGitRepo(AGENTS_DIR)) return false;
	const remoteUrl = await getRemoteUrl(AGENTS_DIR, gitConfig.remote);
	if (!remoteUrl) return false;

	// SSH remotes work without explicit tokens
	if (remoteUrl.startsWith("git@")) return true;

	// Credential helper — per-host, works for any forge
	if (remoteUrl.startsWith("https://")) {
		const creds = await getCredentialHelperToken(remoteUrl, AGENTS_DIR);
		if (creds) return true;
	}

	// GitHub-specific token methods
	const isGitHub = remoteUrl.includes("github.com");
	if (isGitHub) {
		if (await hasSecret("GITHUB_TOKEN")) return true;
		if (await getGhCliToken()) return true;
	}

	return false;
}

// Resolve git credentials using multiple methods
async function resolveGitCredentials(dir: string, remote: string): Promise<GitCredentials> {
	const remoteUrl = await getRemoteUrl(dir, remote);
	if (!remoteUrl) {
		logger.debug("git", `No remote '${remote}' configured in ${dir} — skipping push/pull`);
		return { method: "no-remote" };
	}

	// 1. SSH remotes — just work without URL modification
	if (remoteUrl.startsWith("git@")) {
		logger.debug("git", "Using SSH for authentication");
		return { method: "ssh", usePlainGit: true };
	}

	// 2. Try credential helper first — per-host, works for any git forge
	if (remoteUrl.startsWith("https://")) {
		try {
			const creds = await getCredentialHelperToken(remoteUrl, dir);
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

	// 3. GitHub-specific token methods — only for github.com remotes
	const isGitHub = remoteUrl.includes("github.com") || remoteUrl.includes("github.com:");

	if (isGitHub) {
		// 3a. Stored GITHUB_TOKEN
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

		// 3b. gh CLI auth token
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
	}

	return { method: "none" };
}

// Run a git command with optional authenticated remote
function runGitCommand(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: "pipe", windowsHide: true });
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

	if (creds.method === "no-remote") {
		return {
			success: true,
			message: `No remote '${gitConfig.remote}' configured — skipping pull`,
			changes: 0,
		};
	}

	let fetchResult: { code: number; stdout: string; stderr: string };

	if (creds.usePlainGit) {
		// SSH: use plain git pull
		fetchResult = await runGitCommand(["fetch", gitConfig.remote, gitConfig.branch], AGENTS_DIR);
	} else if (creds.authUrl) {
		// HTTPS with auth: use authenticated URL
		fetchResult = await runGitCommand(["fetch", creds.authUrl, gitConfig.branch], AGENTS_DIR);
	} else {
		return {
			success: false,
			message: "No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
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

	const incomingChanges = Number.parseInt(diffResult.stdout.trim(), 10) || 0;

	if (incomingChanges === 0) {
		return { success: true, message: "Already up to date", changes: 0 };
	}

	// Stash local changes if any
	const statusResult = await runGitCommand(["status", "--porcelain"], AGENTS_DIR);
	const hasLocalChanges = statusResult.stdout.trim().length > 0;

	let stashed = false;
	if (hasLocalChanges) {
		const stashResult = await runGitCommand(["stash", "push", "-m", "signet-auto-stash"], AGENTS_DIR);
		if (stashResult.code !== 0) {
			logger.warn("git", `Stash failed: ${stashResult.stderr}`);
			return {
				success: false,
				message: `Failed to stash local changes: ${stashResult.stderr}`,
			};
		}
		stashed = true;
	}

	// Pull (merge)
	const pullResult = await runGitCommand(["merge", `${gitConfig.remote}/${gitConfig.branch}`, "--ff-only"], AGENTS_DIR);

	// Restore stashed changes if any
	if (stashed) {
		const popResult = await runGitCommand(["stash", "pop"], AGENTS_DIR);
		if (popResult.code !== 0) {
			logger.warn("git", `Stash pop failed — local changes preserved in git stash: ${popResult.stderr}`);
		}
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

	if (creds.method === "no-remote") {
		return {
			success: true,
			message: `No remote '${gitConfig.remote}' configured — skipping push`,
			changes: 0,
		};
	}

	// Check for outgoing changes
	const diffResult = await runGitCommand(
		["rev-list", "--count", `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
		AGENTS_DIR,
	);

	const outgoingChanges = Number.parseInt(diffResult.stdout.trim(), 10) || 0;

	if (outgoingChanges === 0) {
		return { success: true, message: "Nothing to push", changes: 0 };
	}

	let pushResult: { code: number; stdout: string; stderr: string };

	if (creds.usePlainGit) {
		// SSH: use plain git push
		pushResult = await runGitCommand(["push", gitConfig.remote, `HEAD:${gitConfig.branch}`], AGENTS_DIR);
	} else if (creds.authUrl) {
		// HTTPS with auth: use authenticated URL
		pushResult = await runGitCommand(["push", creds.authUrl, `HEAD:${gitConfig.branch}`], AGENTS_DIR);
	} else {
		return {
			success: false,
			message: "No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.",
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

	gitSyncTimer = setInterval(() => {
		const work = (async () => {
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
		})().catch((e) => {
			logger.warn("git", "Periodic sync error", { error: String(e) });
		});
		gitSyncPromise = work;
		work.finally(() => {
			if (gitSyncPromise === work) gitSyncPromise = null;
		});
	}, intervalMs);
}

async function stopGitSyncTimer(): Promise<void> {
	if (gitSyncTimer) {
		clearInterval(gitSyncTimer);
		gitSyncTimer = null;
	}
	// Await in-flight sync so git operations finish before DB closes
	if (gitSyncPromise) {
		try {
			await gitSyncPromise;
		} catch {
			// best-effort — sync failure shouldn't block shutdown
		}
		gitSyncPromise = null;
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
	status.hasCredentials = creds.method !== "none" && creds.method !== "no-remote";
	status.authMethod = creds.method;

	// Get current branch
	const branchResult = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], AGENTS_DIR);
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
	const statusResult = await runGitCommand(["status", "--porcelain"], AGENTS_DIR);
	if (statusResult.code === 0) {
		status.uncommittedChanges = statusResult.stdout
			.trim()
			.split("\n")
			.filter((l) => l.trim()).length;
	}

	// Unpushed/unpulled commits (only if remote tracking branch exists)
	if (status.hasCredentials) {
		const unpushedResult = await runGitCommand(
			["rev-list", "--count", `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
			AGENTS_DIR,
		);
		if (unpushedResult.code === 0) {
			status.unpushedCommits = Number.parseInt(unpushedResult.stdout.trim(), 10) || 0;
		}

		const unpulledResult = await runGitCommand(
			["rev-list", "--count", `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
			AGENTS_DIR,
		);
		if (unpulledResult.code === 0) {
			status.unpulledCommits = Number.parseInt(unpulledResult.stdout.trim(), 10) || 0;
		}
	}

	return status;
}

let commitPending = false;
let commitTimer: ReturnType<typeof setTimeout> | null = null;
const COMMIT_DEBOUNCE_MS = 5000; // Wait 5 seconds after last change before committing

function ensureProtectedGitignore(dir: string): void {
	const gitignorePath = join(dir, ".gitignore");
	const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
	const nextContent = mergeSignetGitignoreEntries(existingContent);
	if (nextContent !== existingContent) {
		writeFileSync(gitignorePath, nextContent, "utf-8");
	}
}

async function gitUntrackProtectedFiles(dir: string): Promise<void> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["rm", "--cached", "--ignore-unmatch", "--quiet", "--", ...SIGNET_GIT_PROTECTED_PATHS], {
			cwd: dir,
			stdio: "pipe",
			windowsHide: true,
		});
		proc.on("close", () => resolve());
		proc.on("error", () => resolve());
	});
}

const GIT_AUTOCOMMIT_TIMEOUT_MS = 30_000;
let autocommitInFlight = false;

async function gitAutoCommit(dir: string, changedFiles: string[]): Promise<void> {
	if (!isGitRepo(dir)) return;
	// Prevent concurrent auto-commits from piling up
	if (autocommitInFlight) return;
	autocommitInFlight = true;

	try {
		ensureProtectedGitignore(dir);
		await gitUntrackProtectedFiles(dir);

		const fileList = changedFiles.map((f) => f.replace(`${dir}/`, "")).join(", ");
		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const message = `${timestamp}_auto_${fileList.slice(0, 50)}`;

		// Track the active child so the timeout can kill stalled processes
		// that hold .git/index.lock
		let active: ReturnType<typeof spawn> | null = null;

		const work = new Promise<void>((resolve) => {
			const add = spawn("git", ["add", "-A"], { cwd: dir, stdio: "pipe", windowsHide: true });
			active = add;
			add.on("close", (addCode) => {
				if (addCode !== 0) {
					logger.warn("git", "Git add failed");
					resolve();
					return;
				}
				const status = spawn("git", ["status", "--porcelain"], {
					cwd: dir,
					stdio: "pipe",
					windowsHide: true,
				});
				active = status;
				let statusOutput = "";
				status.stdout?.on("data", (d) => {
					statusOutput += d.toString();
				});
				status.on("close", (statusCode) => {
					if (statusCode !== 0 || !statusOutput.trim()) {
						resolve();
						return;
					}
					const commit = spawn("git", ["commit", "-m", message], {
						cwd: dir,
						stdio: "pipe",
						windowsHide: true,
					});
					active = commit;
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

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				logger.warn("git", "Auto-commit timed out after 30s");
				try {
					active?.kill("SIGTERM");
				} catch {}
				resolve();
			}, GIT_AUTOCOMMIT_TIMEOUT_MS);
		});

		await Promise.race([work, timeout]);
		clearTimeout(timer);
	} finally {
		autocommitInFlight = false;
	}
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

		const existingFiles = files.filter((f) => existsSync(join(AGENTS_DIR, f.name)));
		const fileList = existingFiles.map((f) => `#   - ~/.agents/${f.name} (${f.desc})`).join("\n");

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

	// Sync to OpenCode (~/.config/opencode/AGENTS.md)
	const opencodeDir = join(homedir(), ".config", "opencode");
	if (existsSync(opencodeDir)) {
		try {
			writeFileSync(join(opencodeDir, "AGENTS.md"), buildHeader("AGENTS.md") + composed);
			logger.sync.harness("opencode", "~/.config/opencode/AGENTS.md");
		} catch (e) {
			logger.sync.failed("opencode", e as Error);
		}
	}

	// Sync per-agent workspace dirs for OpenClaw multi-agent support
	syncAgentWorkspaces(AGENTS_DIR);
	ensureArchitectureDoc();
}

/**
 * For each agent subdirectory in ~/.agents/agents/,
 * assemble and write a workspace AGENTS.md with inherited + overridden
 * identity files. OpenClaw uses workspace: ~/.agents/agents/{name}/workspace.
 */
function syncAgentWorkspaces(agentsDir: string): void {
	const agentsRoot = join(agentsDir, "agents");
	if (!existsSync(agentsRoot)) return;

	let entries: string[];
	try {
		entries = readdirSync(agentsRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return;
	}

	for (const name of entries) {
		const agentDir = join(agentsRoot, name);
		const workspaceDir = join(agentDir, "workspace");

		// Base AGENTS.md: root AGENTS.md content
		const agentsMdPath = join(agentsDir, "AGENTS.md");
		if (!existsSync(agentsMdPath)) continue;

		try {
			const base = readFileSync(agentsMdPath, "utf-8");

			// Agent-specific overrides for SOUL.md and IDENTITY.md
			const agentIdentity = ["SOUL.md", "IDENTITY.md"]
				.map((f) => {
					const override = join(agentDir, f);
					const root = join(agentsDir, f);
					const p = existsSync(override) ? override : existsSync(root) ? root : null;
					if (!p) return "";
					const c = readFileSync(p, "utf-8").trim();
					return c ? `\n## ${f.replace(".md", "")}\n\n${c}` : "";
				})
				.filter(Boolean)
				.join("\n");

			// USER.md and MEMORY.md always from root
			const sharedIdentity = ["USER.md", "MEMORY.md"]
				.map((f) => {
					const p = join(agentsDir, f);
					if (!existsSync(p)) return "";
					const c = readFileSync(p, "utf-8").trim();
					return c ? `\n## ${f.replace(".md", "")}\n\n${c}` : "";
				})
				.filter(Boolean)
				.join("\n");

			const composed = base + agentIdentity + sharedIdentity;

			mkdirSync(workspaceDir, { recursive: true });
			writeFileSync(join(workspaceDir, "AGENTS.md"), composed);
			logger.sync.harness(`openclaw:${name}`, join(workspaceDir, "AGENTS.md"));
		} catch (e) {
			logger.error("sync", `Failed to sync agent workspace: ${name}`, e as Error);
		}
	}
}

/** Write SIGNET-ARCHITECTURE.md if missing or outdated. */
function ensureArchitectureDoc(): void {
	const archPath = join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md");
	try {
		const archContent = buildArchitectureDoc();
		const existing = existsSync(archPath) ? readFileSync(archPath, "utf-8") : "";
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
			join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md"),
			join(AGENTS_DIR, "memory"), // Watch entire memory directory for new/changed .md files
			join(AGENTS_DIR, "agents"), // Watch agent subdirectories for multi-agent identity changes
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

		// Reload auth config when agent.yaml changes on disk
		const base = basename(path);
		if (base === "agent.yaml" || base === "AGENT.yaml") {
			try {
				const cfg = loadMemoryConfig(AGENTS_DIR);
				if (!cfg.auth) throw new Error("Missing auth section in agent.yaml");
				if (!cfg.auth.rateLimits) throw new Error("Missing rateLimits in auth config");
				authConfig = cfg.auth;
				const rl = authConfig.rateLimits;
				authForgetLimiter = rl.forget
					? new AuthRateLimiter(rl.forget.windowMs, rl.forget.max)
					: new AuthRateLimiter(60_000, 30);
				authModifyLimiter = rl.modify
					? new AuthRateLimiter(rl.modify.windowMs, rl.modify.max)
					: new AuthRateLimiter(60_000, 60);
				authBatchForgetLimiter = rl.batchForget
					? new AuthRateLimiter(rl.batchForget.windowMs, rl.batchForget.max)
					: new AuthRateLimiter(60_000, 5);
				authAdminLimiter = rl.admin
					? new AuthRateLimiter(rl.admin.windowMs, rl.admin.max)
					: new AuthRateLimiter(60_000, 10);
				logger.info("config", "Auth config reloaded from disk");
			} catch (e) {
				logger.error("config", "Failed to reload auth config", e as Error);
			}
		}

		// If any identity file changed, sync to harness configs
		const SYNC_TRIGGER_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
		const normalizedForSync = path.replace(/\\/g, "/");
		const isAgentSubdir = normalizedForSync.includes(`${AGENTS_DIR.replace(/\\/g, "/")}/agents/`);
		if (SYNC_TRIGGER_FILES.some((f) => path.endsWith(f)) || isAgentSubdir) {
			scheduleSyncHarnessConfigs();
		}

		// Ingest memory markdown files (excluding MEMORY.md index)
		// Normalize path separators for Windows compatibility (watcher returns backslashes on Windows)
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
		// Recreate the architecture doc immediately if deleted at runtime
		if (path.endsWith("SIGNET-ARCHITECTURE.md")) {
			ensureArchitectureDoc();
		}
		scheduleAutoCommit(path);
	});

	watcher.on("add", (path) => {
		logger.info("watcher", "File added", { path });
		scheduleAutoCommit(path);

		// Ingest new memory markdown files
		// Normalize path separators for Windows compatibility
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

		// Extract project path from file path
		// e.g., ~/.claude/projects/-home-user-myproject/memory/MEMORY.md
		const match = filePath.match(/projects\/([^/]+)\/memory/);
		const projectId = match ? match[1] : "unknown";

		// Compute hash for deduplication
		const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
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

	// Regex for markdown headers (h1-h3)
	const headerPattern = /^(#{1,3})\s+(.+)$/;

	const flushSection = () => {
		if (currentContent.length === 0) return;

		const sectionText = currentContent.join("\n").trim();
		if (!sectionText) return;

		const sectionTokens = estimateTokens(sectionText);

		if (sectionTokens <= maxTokens) {
			// Section fits in one chunk - include header for context
			const textWithHeader = currentHeader ? `${currentHeader}\n\n${sectionText}` : sectionText;
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
				chunkTokens += paraTokens + 2; // +2 for paragraph break
			}

			// Final chunk for this section
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
			const response = await fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
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

/**
 * Import all existing memory markdown files on daemon startup.
 * Scans ~/.agents/memory/ for .md files and ingests them.
 *
 * @returns Total number of chunks inserted
 */
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

// ============================================================================
// Shutdown Handling
// ============================================================================

async function cleanup() {
	shuttingDown = true;
	logger.info("daemon", "Shutting down");

	// ------------------------------------------------------------------
	// Phase 0: Stop accepting new requests — close HTTP server first so
	// in-flight session-end hooks can still complete before we tear down
	// state, but no new requests arrive during shutdown. The 15s timeout
	// exceeds OpenClaw's WRITE_TIMEOUT (10s) so session-end hooks can
	// finish and respond before we force-close.
	// ------------------------------------------------------------------
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

	// ------------------------------------------------------------------
	// Phase 1: Cancel debounce timers — prevents callbacks from firing
	// after DB is closed. Must happen before any async awaits that could
	// let the event loop drain pending timeouts.
	// ------------------------------------------------------------------
	if (commitTimer) {
		clearTimeout(commitTimer);
		commitTimer = null;
	}
	commitPending = false;

	if (syncTimer) {
		clearTimeout(syncTimer);
		syncTimer = null;
	}
	syncPending = false;

	// Flush telemetry before closing DB
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	}
	if (checkpointPruneTimer) {
		clearInterval(checkpointPruneTimer);
		checkpointPruneTimer = undefined;
	}
	if (telemetryRef) {
		try {
			await telemetryRef.stop();
		} catch {
			// best-effort
		}
		telemetryRef = undefined;
	}

	// Flush any pending checkpoint writes before closing DB
	try {
		flushPendingCheckpoints();
	} catch {
		// best-effort
	}

	await stopPipelineRuntime();

	// Shut down native embedding WASM runtime
	try {
		const { shutdownNativeProvider } = await import("./native-embedding");
		await shutdownNativeProvider();
	} catch {
		// best-effort — module may not have been loaded
	}

	// ------------------------------------------------------------------
	// Phase 2: Release all session claims and presence so other daemons
	// and connectors see clean state immediately rather than waiting for
	// stale-session expiry (4h).
	// ------------------------------------------------------------------
	const released = releaseAllSessions();
	const cleared = clearAllPresence();
	if (released > 0 || cleared > 0) {
		logger.info("daemon", "Cleaned cross-agent state", { sessions: released, presence: cleared });
	}

	// Stop session cleanup timer before closing DB (in-flight cleanup may query DB)
	stopSessionCleanup();

	// Stop git sync timer and await in-flight sync
	await stopGitSyncTimer();
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

/**
 * Sync the agent roster from the manifest into the agents table.
 * Upserts each entry; preserves rows not in the roster.
 */
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
		} catch {
			// malformed yaml — skip
		}
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
			const policy = entry.memory?.read_policy;
			let readPolicy: string;
			let group: string | null = null;
			if (typeof policy === "string") {
				readPolicy = policy;
			} else if (policy && typeof policy === "object" && policy.type === "group") {
				readPolicy = "group";
				group = typeof policy.group === "string" ? policy.group : null;
			} else {
				readPolicy = "isolated";
			}
			stmt.run(entry.name, entry.name, readPolicy, group, now, now);
		}
	});
	logger.info("daemon", "Agent roster synced", { count: roster.length });
}


function readPipelineMode(cfg: ResolvedMemoryConfig["pipelineV2"]): string {
	if (!cfg.enabled) return "disabled";
	if (cfg.paused) return "paused";
	if (cfg.mutationsFrozen) return "frozen";
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
		skillReconcilerHandle.stop();
		skillReconcilerHandle = null;
	}

	if (shadowProcess) {
		try {
			shadowProcess.kill();
		} catch {
			// best-effort
		}
		shadowProcess = null;
	}

	if (predictorClientRef) {
		try {
			await predictorClientRef.stop();
		} catch {
			// best-effort
		}
		predictorClientRef = null;
	}

	if (embeddingTrackerHandle) {
		try {
			await embeddingTrackerHandle.stop();
		} catch {
			// best-effort
		}
		embeddingTrackerHandle = null;
	}

	try {
		await stopPipeline();
	} catch {
		// best-effort
	}

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

async function startPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	const pipelinePaused = memoryCfg.pipelineV2.paused;
	clearStructuralBackfillTimer();
	logger.info("config", "Resolved embedding config", {
		provider: memoryCfg.embedding.provider,
		model: memoryCfg.embedding.model,
		dimensions: memoryCfg.embedding.dimensions,
	});

	// Initialize auth
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

	const providerHints = getConfiguredProviderHints(AGENTS_DIR);
	const validExtractionProviders = new Set(["none", "ollama", "claude-code", "opencode", "codex", "anthropic", "openrouter"]);
	const validSynthesisProviders = new Set(["none", "ollama", "claude-code", "codex", "opencode", "anthropic", "openrouter"]);

	providerRuntimeResolution.extraction = {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: memoryCfg.pipelineV2.extraction.provider,
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

	// Auto-detect extraction provider: verify the configured provider is
	// available, falling back to ollama with a warning if not.
	let effectiveExtractionProvider = memoryCfg.pipelineV2.extraction.provider;
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
	const ollamaFallbackMaxContextTokens = resolveDefaultOllamaFallbackMaxContextTokens();
	const extractionOpenCodeShouldManage = isManagedOpenCodeLocalEndpoint(extractionOpenCodeBaseUrl);
	if (pipelinePaused) {
		logger.info("config", "Pipeline paused; extraction provider startup deferred");
		effectiveExtractionProvider = "none";
	} else if (effectiveExtractionProvider === "none") {
		logger.info("config", "Extraction provider set to 'none', pipeline LLM disabled");
	} else if (effectiveExtractionProvider === "opencode") {
		if (extractionOpenCodeShouldManage) {
			const serverReady = await ensureOpenCodeServer(4096);
			if (!serverReady) {
				logger.warn("config", "OpenCode server not available, falling back to ollama for extraction");
				effectiveExtractionProvider = "ollama";
			}
		} else {
			logger.info("config", "Using external OpenCode endpoint for extraction", {
				baseUrl: redactUrlForLogs(extractionOpenCodeBaseUrl),
			});
		}
	} else if (effectiveExtractionProvider === "claude-code") {
		// Resolve full path so .cmd wrappers on Windows are found correctly.
		const resolvedClaude = Bun.which("claude");
		if (resolvedClaude === null) {
			logger.warn("config", "Claude Code CLI not found, falling back to ollama for extraction");
			effectiveExtractionProvider = "ollama";
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
				logger.warn("config", "Claude Code CLI not found, falling back to ollama for extraction");
				effectiveExtractionProvider = "ollama";
			}
		}
	} else if (effectiveExtractionProvider === "codex") {
		const resolvedCodex = Bun.which("codex");
		if (resolvedCodex === null) {
			logger.warn("config", "Codex CLI not found, falling back to ollama for extraction");
			effectiveExtractionProvider = "ollama";
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
				logger.warn("config", "Codex CLI not found, falling back to ollama for extraction");
				effectiveExtractionProvider = "ollama";
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

	// Resolve Anthropic API key once — shared by extraction and synthesis
	let anthropicApiKey: string | undefined;
	const needsAnthropicForSynthesis =
		memoryCfg.pipelineV2.synthesis.enabled && memoryCfg.pipelineV2.synthesis.provider === "anthropic";
	if (effectiveExtractionProvider === "anthropic" || needsAnthropicForSynthesis) {
		anthropicApiKey = await getKey("ANTHROPIC_API_KEY");
		if (!anthropicApiKey) {
			logger.error(
				"config",
				"ANTHROPIC_API_KEY not found — falling back to ollama. Set via env or `signet secrets set ANTHROPIC_API_KEY`",
			);
			if (effectiveExtractionProvider === "anthropic") {
				effectiveExtractionProvider = "ollama";
			}
		}
	}

	// Resolve OpenRouter API key once — shared by extraction and synthesis
	let openRouterApiKey: string | undefined;
	const needsOpenRouterForSynthesis =
		memoryCfg.pipelineV2.synthesis.enabled && memoryCfg.pipelineV2.synthesis.provider === "openrouter";
	if (effectiveExtractionProvider === "openrouter" || needsOpenRouterForSynthesis) {
		openRouterApiKey = await getKey("OPENROUTER_API_KEY");
		if (!openRouterApiKey) {
			logger.error(
				"config",
				"OPENROUTER_API_KEY not found — falling back to ollama. Set via env or `signet secrets set OPENROUTER_API_KEY`",
			);
			if (effectiveExtractionProvider === "openrouter") {
				effectiveExtractionProvider = "ollama";
			}
		}
	}

	// When falling back to ollama, reset model so ollama uses its own default
	// instead of inheriting an anthropic-specific alias like "haiku".
	const effectiveExtractionModel = resolveRuntimeModel(
		effectiveExtractionProvider,
		memoryCfg.pipelineV2.extraction.provider,
		memoryCfg.pipelineV2.extraction.model,
	);
	const usingExtractionOllamaFallback =
		effectiveExtractionProvider === "ollama" && memoryCfg.pipelineV2.extraction.provider !== "ollama";
	providerRuntimeResolution.extraction = {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: effectiveExtractionProvider,
	};
	if (providerHints.extraction && providerHints.extraction !== effectiveExtractionProvider) {
		logger.warn("config", "Extraction provider resolved differently than configured", {
			configured: providerHints.extraction,
			resolved: memoryCfg.pipelineV2.extraction.provider,
			effective: effectiveExtractionProvider,
		});
	}
	logger.info("config", "Extraction provider", {
		configured: providerHints.extraction,
		resolved: memoryCfg.pipelineV2.extraction.provider,
		effective: effectiveExtractionProvider,
		endpoint: redactUrlForLogs(
			effectiveExtractionProvider === "ollama"
				? extractionOllamaFallbackBaseUrl
				: effectiveExtractionProvider === "opencode"
					? extractionOpenCodeBaseUrl
					: effectiveExtractionProvider === "openrouter"
						? extractionOpenRouterBaseUrl
				: undefined,
		),
	});
	const extractionModelName =
		effectiveExtractionModel ?? memoryCfg.pipelineV2.extraction.model;
	if (
		effectiveExtractionProvider === "anthropic" ||
		effectiveExtractionProvider === "openrouter" ||
		effectiveExtractionProvider === "opencode"
	) {
		logger.warn(
			"config",
			"Extraction is intended for Claude Code (Haiku), Codex CLI (GPT Mini) on Pro/Max, or local Ollama qwen3:4b+. Remote API extraction can create extreme fees fast. Set provider to 'none' to disable it on a VPS.",
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
		logger.warn(
			"config",
			"Claude Code extraction is safest on Haiku. Larger models increase cost significantly.",
			{
				model: extractionModelName,
			},
		);
	}
	if (
		effectiveExtractionProvider === "codex" &&
		extractionModelName &&
		!extractionModelName.toLowerCase().includes("mini")
	) {
		logger.warn(
			"config",
			"Codex extraction is safest on GPT Mini. Larger models increase cost significantly.",
			{
				model: extractionModelName,
			},
		);
	}

	// Create LLM provider once, register as daemon-wide singleton
	const llmProvider = effectiveExtractionProvider === "none"
		? null
		: effectiveExtractionProvider === "anthropic" && anthropicApiKey
			? createAnthropicProvider({
					model: effectiveExtractionModel || "haiku",
					apiKey: anthropicApiKey,
					defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
				})
			: effectiveExtractionProvider === "openrouter" && openRouterApiKey
				? createOpenRouterProvider({
						model: effectiveExtractionModel || "openai/gpt-4o-mini",
						apiKey: openRouterApiKey,
						baseUrl: extractionOpenRouterBaseUrl,
						referer: readEnvTrimmed("OPENROUTER_HTTP_REFERER"),
						title: readEnvTrimmed("OPENROUTER_TITLE"),
						defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
					})
				: effectiveExtractionProvider === "opencode"
					? createOpenCodeProvider({
							model: effectiveExtractionModel || "anthropic/claude-haiku-4-5-20251001",
							baseUrl: extractionOpenCodeBaseUrl,
							ollamaFallbackBaseUrl: extractionOllamaFallbackBaseUrl,
							ollamaFallbackMaxContextTokens: ollamaFallbackMaxContextTokens,
							defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
						})
					: effectiveExtractionProvider === "claude-code"
						? createClaudeCodeProvider({
								model: effectiveExtractionModel || "haiku",
								defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
							})
						: effectiveExtractionProvider === "codex"
							? createCodexProvider({
									model: effectiveExtractionModel || "gpt-5-codex-mini",
									defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
								})
							: createOllamaProvider({
									...(effectiveExtractionModel ? { model: effectiveExtractionModel } : {}),
									baseUrl: extractionOllamaFallbackBaseUrl,
									defaultTimeoutMs: memoryCfg.pipelineV2.extraction.timeout,
									...(usingExtractionOllamaFallback
										? {
												maxContextTokens: ollamaFallbackMaxContextTokens,
											}
										: {}),
								});
	if (llmProvider) {
		initLlmProvider(llmProvider);
	}

	// Initialize model registry for dynamic model discovery
	if (memoryCfg.pipelineV2.modelRegistry.enabled && !pipelinePaused) {
		const registryAnthropicApiKey = anthropicApiKey ?? (await getKey("ANTHROPIC_API_KEY"));
		const registryOpenRouterApiKey = openRouterApiKey ?? (await getKey("OPENROUTER_API_KEY"));
		initModelRegistry(
			memoryCfg.pipelineV2.modelRegistry,
			effectiveExtractionProvider === "ollama" ? extractionOllamaBaseUrl : undefined,
			registryAnthropicApiKey,
			registryOpenRouterApiKey,
			effectiveExtractionProvider === "openrouter" ? extractionOpenRouterBaseUrl : undefined,
		);
	}

	// Create synthesis provider — separate from extraction because synthesis
	// needs a smarter model that can reason across long context
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
		const synthesisOllamaBaseUrl = normalizeRuntimeBaseUrl(
			memoryCfg.pipelineV2.synthesis.endpoint,
			"http://127.0.0.1:11434",
		);
		const synthesisOllamaFallbackBaseUrl =
			memoryCfg.pipelineV2.synthesis.provider === "opencode" ? "http://127.0.0.1:11434" : synthesisOllamaBaseUrl;
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
					logger.warn("config", "OpenCode server not available for synthesis, falling back to ollama");
					effectiveSynthesisProvider = "ollama";
				}
			} else {
				logger.info("config", "Using external OpenCode endpoint for synthesis", {
					baseUrl: redactUrlForLogs(synthesisOpenCodeBaseUrl),
				});
			}
		} else if (effectiveSynthesisProvider === "anthropic") {
			if (!anthropicApiKey) {
				logger.warn("config", "ANTHROPIC_API_KEY not found for synthesis, falling back to ollama");
				effectiveSynthesisProvider = "ollama";
			}
		} else if (effectiveSynthesisProvider === "openrouter") {
			if (!openRouterApiKey) {
				logger.warn("config", "OPENROUTER_API_KEY not found for synthesis, falling back to ollama");
				effectiveSynthesisProvider = "ollama";
			}
		} else if (effectiveSynthesisProvider === "claude-code") {
			// Re-resolve here; extraction and synthesis may use different providers.
			const resolvedClaude = Bun.which("claude");
			if (resolvedClaude === null) {
				logger.warn("config", "Claude Code CLI not found, falling back to ollama for synthesis");
				effectiveSynthesisProvider = "ollama";
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
					logger.warn("config", "Claude Code CLI not found, falling back to ollama for synthesis");
					effectiveSynthesisProvider = "ollama";
				}
			}
		} else if (effectiveSynthesisProvider === "codex") {
			const resolvedCodex = Bun.which("codex");
			if (resolvedCodex === null) {
				logger.warn("config", "Codex CLI not found, falling back to ollama for synthesis");
				effectiveSynthesisProvider = "ollama";
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
					logger.warn("config", "Codex CLI not found, falling back to ollama for synthesis");
					effectiveSynthesisProvider = "ollama";
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
					: effectiveSynthesisProvider === "opencode"
						? synthesisOpenCodeBaseUrl
						: effectiveSynthesisProvider === "openrouter"
							? synthesisOpenRouterBaseUrl
							: undefined,
			),
		});

		// When falling back to ollama, reset model so ollama uses its own default
		const effectiveSynthesisModel = resolveRuntimeModel(
			effectiveSynthesisProvider,
			memoryCfg.pipelineV2.synthesis.provider,
			memoryCfg.pipelineV2.synthesis.model,
		);
		const usingSynthesisOllamaFallback =
			effectiveSynthesisProvider === "ollama" && memoryCfg.pipelineV2.synthesis.provider !== "ollama";

		const synthesisProvider =
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
							: createOllamaProvider({
									...(effectiveSynthesisModel ? { model: effectiveSynthesisModel } : {}),
									baseUrl: synthesisOllamaFallbackBaseUrl,
									defaultTimeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
									...(usingSynthesisOllamaFallback
										? {
												maxContextTokens: ollamaFallbackMaxContextTokens,
											}
										: {}),
								});
		initSynthesisProvider(synthesisProvider);
		// Widget provider defaults to synthesis provider (needs smart model for HTML gen)
		initWidgetProvider(synthesisProvider);
	} else {
		providerRuntimeResolution.synthesis = {
			configured: providerHints.synthesis,
			resolved: null,
			effective: null,
		};
		logger.info("config", "Synthesis disabled");
	}

	// Start extraction pipeline only when explicitly enabled and an LLM is available.
	// shadowMode controls behavior inside the enabled pipeline.
	if (memoryCfg.pipelineV2.enabled && !pipelinePaused && effectiveExtractionProvider !== "none") {
		startPipeline(
			getDbAccessor(),
			memoryCfg.pipelineV2,
			memoryCfg.embedding,
			fetchEmbedding,
			memoryCfg.search,
			providerTracker,
			analyticsCollector,
			telemetry,
		);
	} else {
		// Retention worker runs unconditionally — cleans up tombstones,
		// expired history, and dead jobs even without the full pipeline.
		ensureRetentionWorker(getDbAccessor(), DEFAULT_RETENTION);
	}

	// Start embedding tracker if provider is configured and tracker enabled
	if (memoryCfg.embedding.provider !== "none" && memoryCfg.pipelineV2.embeddingTracker.enabled && !pipelinePaused) {
		embeddingTrackerHandle = startEmbeddingTracker(
			getDbAccessor(),
			memoryCfg.embedding,
			memoryCfg.pipelineV2.embeddingTracker,
			fetchEmbedding,
			checkEmbeddingProvider,
		);
	}

	// One-time structural backfill: populate entity_aspects/attributes for
	// existing entities that predate the knowledge architecture migrations.
	// Runs in the background, rate-limited, so it doesn't block startup.
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

	// Spawn predictor sidecar if enabled
	if (memoryCfg.pipelineV2.predictor?.enabled && !pipelinePaused) {
		const predictorCfg = memoryCfg.pipelineV2.predictor;
		try {
			const client = createPredictorClient(predictorCfg, "default", memoryCfg.embedding.dimensions);
			await client.start();
			predictorClientRef = client;
			logger.info("predictor", "Predictor sidecar started");
		} catch (err) {
			// Fail open: predictor is optional
			logger.warn("predictor", "Failed to start predictor sidecar (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Spawn Rust daemon shadow if enabled (port 3851, isolated DB)
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

	// Start skill reconciler if procedural memory is enabled
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

async function main() {
	logger.info("daemon", "Signet Daemon starting");
	logger.info("daemon", "Agents directory", { path: AGENTS_DIR });
	logger.info("daemon", "Network configured", { port: PORT, host: HOST, bindHost: BIND_HOST });

	// Ensure daemon directory exists
	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Initialise singleton DB accessor (opens write connection, sets pragmas,
	// runs migrations). This is the sole schema authority and the only
	// production Bun SQLite constructor path, which keeps macOS custom
	// SQLite selection ahead of any live connection.
	initDbAccessor(MEMORY_DB, { agentsDir: AGENTS_DIR });

	// Sync agent roster from manifest into the agents table.
	syncAgentRoster(AGENTS_DIR);

	// Migrations may have created traversal tables — clear the cache
	invalidateTraversalCache();

	// Write PID file
	writeFileSync(PID_FILE, process.pid.toString());
	logger.info("daemon", "Process ID", { pid: process.pid });

	// Migrate config defaults before watcher starts (one-time, guarded by configVersion)
	try {
		migrateConfig(AGENTS_DIR);
	} catch (err) {
		logger.warn("config-migration", "Config migration failed; continuing startup", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Start file watcher
	startFileWatcher();
	logger.info("watcher", "File watcher started");

	// Ensure SIGNET-ARCHITECTURE.md exists on startup (file watcher uses
	// ignoreInitial:true so it won't recreate missing files on its own)
	ensureArchitectureDoc();

	// Load config and initialize telemetry before starting runtime.
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

		// Heartbeat: record daemon stats every 5 minutes using live config.
		const daemonStartTime = Date.now();
		heartbeatTimer = setInterval(() => {
			if (!telemetryRef) return;
			try {
				const liveCfg = loadMemoryConfig(AGENTS_DIR);
				const memoryCount = getDbAccessor().withReadDb((db) => {
					const row = db
						.prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 0 OR is_deleted IS NULL")
						.get() as { cnt: number } | undefined;
					return row?.cnt ?? 0;
				});
				const connectors = listConnectors();
				telemetryRef.record("daemon.heartbeat", {
					uptimeMs: Date.now() - daemonStartTime,
					memoryCount,
					connectorsActive: connectors.filter((cn) => cn.status === "active").length,
					pipelineMode: readPipelineMode(liveCfg.pipelineV2),
					extractionProvider: liveCfg.pipelineV2.extraction.provider,
					embeddingProvider: liveCfg.embedding.provider,
				});
			} catch {
				// best-effort
			}
		}, 5 * 60 * 1000);
	}

	await startPipelineRuntime(memoryCfg, telemetryCollector);

	// Initialize checkpoint flush queue for continuity protocol
	initCheckpointFlush(getDbAccessor());

	// Start scheduled task worker
	const schedulerHandle = startSchedulerWorker(getDbAccessor());

	// Checkpoint pruning timer — runs once per hour
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

	// Start git sync timer (if enabled and has token)
	startGitSyncTimer();
	initUpdateSystem(CURRENT_VERSION, AGENTS_DIR, () => {
		// Self-restart: spawn a replacement daemon process before exiting.
		// This mirrors the spawn pattern used by `signet daemon start` in the CLI.
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

	// Start HTTP server with global body size limit (10MB) to prevent
	// OOM from chunked-encoding requests that bypass content-length checks.
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
					// Send a proper 413 then destroy the socket so Hono's handler
					// doesn't try to write a second response (ERR_HTTP_HEADERS_SENT).
					if (!res.headersSent) {
						res.writeHead(413, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "payload too large" }), () => {
							// Destroy after flush so Hono's subsequent write fails
							// silently on a closed socket rather than emitting
							// ERR_HTTP_HEADERS_SENT on a finished response.
							req.socket?.destroy();
						});
					}
				}
			});
		});
		return server;
	};

	httpServer = serve(
		{
			fetch: app.fetch,
			port: PORT,
			hostname: BIND_HOST,
			createServer: createBoundedServer,
		},
		(info) => {
			logger.info("daemon", "Server listening", {
				address: info.address,
				port: info.port,
			});
			logger.info("daemon", "Daemon ready");

			// Detect version upgrade and log what's new
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
			} catch {
				// Best effort — DAEMON_DIR might not exist yet in edge cases
			}

			// Import existing memory markdown files (OpenClaw memory logs)
			// Do this after server starts so the HTTP API is available for ingestion
			importExistingMemoryFiles().catch((e) => {
				const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
				logger.error("daemon", "Failed to import existing memory files", undefined, errDetails);
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
