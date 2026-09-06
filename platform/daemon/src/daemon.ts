#!/usr/bin/env node
import { requestMemoryHead } from "./memory-head";
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import "./bun-socket-polyfill";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { opendir, readFile as readFileAsync, stat as statAsync, unlink as unlinkAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	type AgentDefinition,
	buildArchitectureDoc,
	configuredRoutingTargetRefs,
	identityModeManagesFiles,
	loadConfiguredHarnesses,
	loadIdentityMode,
	loadSourcesConfig,
	normalizeAgentRosterEntry,
	parseRoutingConfig,
	parseRoutingTargetRef,
	parseSimpleYaml,
	preflightWorkspace,
	formatWorkspacePreflightError,
	resolveDefaultBasePath,
	routingTargetLocality,
	scanMemoryContent,
	stripSignetBlock,
} from "@signet/core";
import { watch } from "chokidar";
import { Hono } from "hono";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { createToken, requirePermission } from "./auth";
import { bindWithRetry } from "./bind-with-retry";
import {
	migrateConfig,
	migrateEmbeddingBaseUrl,
	migrateInferenceProviders,
	migrateLegacyRoutingToRegistry,
	migrateRetiredExtractionWriterConfig,
	migrateRetiredMemoryPipelineRoutingV9,
	migrateSessionSynthesisRoute,
} from "./config-migration";
import { findSqliteVecExtension } from "@signet/core";
import { clearAllPresence, reconcileAcpDeliveries } from "./cross-agent";
import {
	MIGRATION_VERIFY_FAILED_STATUS,
	MIGRATION_VERIFY_PARKED_STATUS,
	readMigrationVerifyCheckpoint,
	runIncrementalDatabaseIntegrityCheck,
} from "./incremental-database-integrity";
import {
	createMigrationVerifySetupRetry,
	migrationVerifyCheckpointKey,
	runMigrationIntegrityVerifyGate,
} from "./migration-integrity-verify";
import { readRetainedMigrationVerifyStatus } from "./daemon-migration-startup";
import {
	getDatabaseIntegrityStatus,
	publishDatabaseIntegrityStatus,
	resetGlobalIntegrityLatch,
} from "./database-integrity";
import {
	closeDbAccessor,
	DatabaseIntegrityCorruptError,
	getDbAccessor,
	getVectorRuntimeStatus,
	VEC_EMBEDDING_POST_READY_BUDGET_MS,
	pendingMigrationBackupPath,
	initDbAccessorLite,
	initDbAccessorReadOnly,
	isVectorRuntimeUsable,
	pruneMigrationBackupsAfterIntegrity,
	resolveSqliteRuntimeConfig,
	registerDbOwnerHealthProvider,
	setDatabaseIntegrityWritesBlocked,
} from "./db-accessor";
import { type VacuumConversionHandle, startVacuumConversionWorker } from "./db-vacuum-worker";
import { createDbOwnerClient, type DbOwnerClient, type DbOwnerClientOptions, DbOwnerError } from "./db-owner-client";
import {
	type DbOwnerMaintenance,
	createDbOwnerMaintenance,
	ownerQueryAll,
	ownerQueryOne,
	ownerRunStatement,
	ownerTransaction,
	registerDbOwnerMaintenance,
} from "./db-owner-maintenance";
import { createDeferredRuntimeGate, createDeferredRuntimeScheduler } from "./deferred-runtime-gate";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import type { QueuePressureSnapshot } from "./diagnostics-queue";
import { fetchEmbedding } from "./embedding-fetch";
import { type EmbeddingIndexMigrationHandle, startEmbeddingIndexMigration } from "./embedding-index-migration";
import {
	type EmbeddingIndexStateRow,
	parseEmbeddingIndexStateRow,
	resolveActiveEmbeddingConfigFromState,
} from "./embedding-index-state";
import { completeFtsStartupRecovery } from "./fts-startup-recovery";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { initFeatureFlags } from "./feature-flags";
import { writeFileIfChangedAsync } from "./file-sync";
import { createSignetHttpServer } from "./http-server";
import { syncAgentWorkspaces } from "./identity-sync";
import {
	type InferenceStatusSummary,
	getOrCreateInferenceRouter,
	isInferenceRouterConfigPath,
} from "./inference-router.js";
import { fetchInternal } from "./internal-fetch";
import {
	type DaemonLifecycle,
	classifyPreviousDaemonExit,
	previousExitTelemetryProperties,
	readDaemonLifecycle,
	writeDaemonLifecycle,
} from "./lifecycle";
import { closeInferenceProviderResolver, initInferenceProviderResolver } from "./llm";
import { logger } from "./logger";
import { type ResolvedMemoryConfig, graphWriteCaps, loadMemoryConfig, readRuntimeConfig } from "./memory-config";
import { registerGlobalMiddleware } from "./middleware";
import {
	type NativeMemoryBridgeHandle,
	configuredNativeMemorySources,
	resolveEmbeddingBridgeOptions,
	startNativeMemoryBridge,
} from "./native-memory-sources";
import { materializeEmbeddedWasmAssets, resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import {
	DEFAULT_RETENTION,
	ensureRetentionWorker,
	getPipelineWorkerStatus,
	setDreamingWorker,
	startPipeline,
	stopPipeline,
} from "./pipeline";
import { randomUUID } from "node:crypto";
import { recordDreamingPassTelemetry } from "./pipeline/dreaming";
import { dbOwnerTransaction } from "./db-owner-runtime";
import { type DreamingWorkerHandle, startDreamingWorker } from "./pipeline/dreaming-worker";
import { retireLegacyExtractionJobsAsync } from "./pipeline/extraction-fallback";
import { invalidateTraversalCache } from "./pipeline/graph-traversal";
import { stopModelRegistry } from "./pipeline/model-registry";
import { configureLlmConcurrency } from "./pipeline/provider";
import { type ReflectionWorkerHandle, startReflectionWorker } from "./pipeline/reflection-worker";
import { startReconciler } from "./pipeline/skill-reconciler";
import {
	getResourceSnapshot,
	logFdSnapshot,
	startEventLoopMonitor,
	startFdPollMonitor,
	stopResourceMonitors,
} from "./resource-monitor";
import { buildResourceUtilizationTelemetry } from "./resource-telemetry";
import {
	AGENTS_DIR,
	BIND_HOST,
	CURRENT_VERSION,
	DAEMON_DIR,
	HOST,
	INTERNAL_SELF_HOST,
	LOG_DIR,
	MEMORY_DB,
	PID_FILE,
	PORT,
	type RuntimeProviderName,
	type RuntimeSynthesisProviderName,
	analyticsCollector,
	authConfig,
	authSecret,
	bindAbort,
	invalidateDiagnosticsCache,
	providerRuntimeResolution,
	providerTracker,
	reloadAuthState,
	setCheckpointPruneTimer,
	setEmbeddingTrackerHandle,
	setHeartbeatTimer,
	setRestartPipelineRuntime,
	setShuttingDown,
	setTelemetryRef,
	embeddingTrackerHandle as sharedEmbeddingTrackerHandle,
	shuttingDown,
} from "./routes/state.js";
import {
	type PressureRecoveryOutcome,
	buildRuntimePressureEnvelope,
	countActiveWorkers,
	setRuntimePressureEnvelope,
} from "./runtime-pressure";
import { flushPendingCheckpoints, initCheckpointFlush, pruneCheckpointsAsync } from "./session-checkpoints";
import { createSessionClaimStore } from "./session-claims";
import {
	releaseAllSessions,
	restorePersistedSessionsAsync,
	setSessionClaimStore,
	setSessionEvictionHandler,
	startSessionCleanup,
	stopSessionCleanup,
} from "./session-tracker";
import { createTtlEvictionHandler } from "./session-ttl-finalizer";
import { createSingleFlightRunner } from "./single-flight-runner";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./single-instance-lock";
import {
	beginSourceIndexJob,
	clearSourceIndexInFlight,
	completeSourceIndexJobFromProgress,
	failSourceIndexJob,
	getSourceIndexJob,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	pauseSourceIndexJob,
	updateSourceIndexJobProgress,
} from "./source-index-progress";
import {
	flushPendingSourceLifecycleTelemetry,
	recordSourceConnected,
	recordSourceIndexOperation,
	sourceFailureClass,
	trackSourceLifecycleWrite,
} from "./source-lifecycle-telemetry";
import { getStartupRecoveryCompletion, runStartupRecovery } from "./startup-recovery";
import { getPressureRecoveryOutcome, getSystemPressure, reportStartupGrace } from "./system-pressure";
import {
	type TelemetryCollector,
	type TelemetryConfigSnapshot,
	createTelemetryCollector,
	defaultTelemetryLogPath,
	sanitizeCrashError,
	setActiveTelemetry,
	stopActiveTelemetry,
	telemetryDisabledByEnv,
} from "./telemetry";
import { type TranscriptCaptureWorkerHandle, startTranscriptCaptureWorker } from "./transcript-capture-worker";
import { type TranscriptRecoveryWorkerHandle, startTranscriptRecoveryWorker } from "./transcript-recovery-worker";
import { type TranscriptImportWorkerHandle, startTranscriptImportWorker } from "./transcript-import-worker";
import { createOwnerTranscriptImportStore } from "./transcript-import-store";

import { resolveDaemonRestartMode } from "./daemon-restart";
import {
	getSynthesisWorker as getSynthesisRenderWorker,
	setSynthesisWorker as setSynthesisRenderWorker,
	sweepStaleSessions,
} from "./hooks";
import { mountMcpRoute } from "./mcp";
import { mountAppTrayRoutes } from "./routes/app-tray.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { mountChangelogRoutes } from "./routes/changelog.js";
import { registerHarnessInstallRoutes, stopHarnessInstall } from "./routes/harness-install";
import { registerConnectorRoutes } from "./routes/connectors-routes.js";
import { setupDashboardRoutes } from "./routes/dashboard.js";
import { registerDatabaseDiagnosticsRoutes } from "./routes/database-diagnostics.js";
import { mountEventBusRoutes } from "./routes/event-bus.js";
import {
	ensureWorkspaceGitignore,
	getGitStatus,
	gitConfig,
	gitPull,
	gitPush,
	gitSync,
	scheduleAutoCommit,
	startGitSyncTimer,
	stopGitSyncTimer,
} from "./routes/git-sync.js";
import { registerGraphiqRoutes } from "./routes/graphiq-routes.js";
import { mountHealthRoutes } from "./routes/health.js";
import { registerHooksRoutes } from "./routes/hooks-routes.js";
import { registerImportRoutes } from "./routes/import-routes.js";
import { registerTranscriptImportRoutes } from "./routes/transcript-import-routes.js";
import { mountInferenceRoutes } from "./routes/inference.js";
import { registerKnowledgeRoutes } from "./routes/knowledge-routes.js";
import { mountMarketplaceReviewsRoutes } from "./routes/marketplace-reviews.js";
import { mountMarketplaceRoutes } from "./routes/marketplace.js";
import { mountMcpAnalyticsRoutes } from "./routes/mcp-analytics.js";
import { registerMemoryRoutes } from "./routes/memory-routes.js";
import { registerMiscRoutes } from "./routes/misc-routes.js";
import { registerOntologyRoutes } from "./routes/ontology-routes.js";
import { mountOsAgentRoutes } from "./routes/os-agent.js";
import { mountOsChatRoutes } from "./routes/os-chat.js";
import { registerPipelineRoutes } from "./routes/pipeline-routes.js";
import { registerPluginRoutes } from "./routes/plugins-routes.js";
import { registerQueueDiagnosticsRoutes } from "./routes/queue-diagnostics.js";
import { registerReflectionRoutes } from "./routes/reflection-routes.js";
import { registerRepairRoutes } from "./routes/repair-routes.js";
import { registerSecretRoutes } from "./routes/secrets-routes.js";
import { registerSessionRoutes } from "./routes/session-routes.js";
import { mountSkillAnalyticsRoutes } from "./routes/skill-analytics.js";
import { mountSkillsRoutes, setFetchEmbedding } from "./routes/skills.js";
import {
	cleanupSourceDeletionTombstones,
	registerSourcesRoutes,
	stopSourceIndexJobs,
} from "./routes/sources-routes.js";
import { registerTelemetryRoutes } from "./routes/telemetry-routes.js";
import { checkEmbeddingProvider } from "./routes/utils.js";
import { mountWidgetRoutes } from "./routes/widget.js";
import { isReadyResponse } from "./synthesis-worker-protocol";
import { initUpdateSystem, startUpdateTimer, stopUpdateTimer } from "./update-system";
import { createAgentsWatcherIgnoreMatcher } from "./watcher-ignore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let httpServer: import("node:net").Server | null = null;
let dbOwnerClient: DbOwnerClient | null = null;
let dbOwnerMaintenanceHandle: DbOwnerMaintenance | null = null;
let globalVerifyInFlight = false;
let migrationIntegrityWritesBlocked = false;
let migrationWritesDeferred = false;
let recallDbOwner: DbOwnerClient | null = null;
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;
let reflectionWorkerHandle: ReflectionWorkerHandle | null = null;
let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
let embeddingIndexMigrationHandle: EmbeddingIndexMigrationHandle | null = null;
let vacuumConversionHandle: VacuumConversionHandle | null = null;
let embeddingPromotionRestart: Promise<void> | null = null;
let skillReconcilerHandle: ReturnType<typeof startReconciler> | null = null;
let transcriptCaptureWorkerHandle: TranscriptCaptureWorkerHandle | null = null;
let transcriptRecoveryWorkerHandle: TranscriptRecoveryWorkerHandle | null = null;
let transcriptImportWorkerHandle: TranscriptImportWorkerHandle | null = null;
// These are mirrored into state.ts via setters for read access by
// route modules. Only daemon.ts should assign or clear them.
let telemetryRef: TelemetryCollector | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let checkpointPruneTimer: ReturnType<typeof setInterval> | undefined;

function armMigrationIntegrityWriteBlock(): void {
	migrationIntegrityWritesBlocked = true;
	migrationWritesDeferred = false;
	process.env.SIGNET_DB_WRITES_BLOCKED = "1";
	setDatabaseIntegrityWritesBlocked(true);
	dbOwnerClient?.setWriteBlocked(true);
	recallDbOwner?.setWriteBlocked(true);
	void transcriptRecoveryWorkerHandle?.stop().catch((error: unknown) => {
		logger.error("startup-recovery", "Failed to stop transcript recovery after integrity failure", undefined, {
			error: error instanceof Error ? error.message : String(error),
		});
	});
}

function releaseMigrationIntegrityWriteBlock(): void {
	migrationIntegrityWritesBlocked = false;
	migrationWritesDeferred = false;
	delete process.env.SIGNET_DB_WRITES_BLOCKED;
	setDatabaseIntegrityWritesBlocked(false);
	dbOwnerClient?.setWriteBlocked(false);
	recallDbOwner?.setWriteBlocked(false);
}

function deferMigrationWriters(): void {
	migrationIntegrityWritesBlocked = true;
	migrationWritesDeferred = true;
	process.env.SIGNET_DB_WRITES_BLOCKED = "1";
	setDatabaseIntegrityWritesBlocked(true);
	dbOwnerClient?.setWriteBlocked(true);
	recallDbOwner?.setWriteBlocked(true);
}

async function ownerQueuePressure(
	owner: DbOwnerClient,
	source: "memory" | "summary",
): Promise<{ readonly depth: number; readonly oldestAt: string | null } | undefined> {
	const table = source === "memory" ? "memory_jobs" : "summary_jobs";
	const statusIndex = source === "memory" ? "idx_memory_jobs_pressure_status" : "idx_summary_jobs_pressure_status";
	const createdIndex =
		source === "memory" ? "idx_memory_jobs_pressure_created_at" : "idx_summary_jobs_pressure_created_at";
	const predicate = source === "memory" ? " AND job_type <> 'extract'" : "";
	try {
		const exists = await ownerQueryOne<{ readonly present: number }>(
			owner,
			`heartbeat.queue-pressure.${source}.schema`,
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			[table],
			{ deadlineMs: 5_000 },
		);
		if (exists === undefined) return undefined;
		const rows = await ownerQueryAll<{ readonly present: number }>(
			owner,
			`heartbeat.queue-pressure.${source}.depth`,
			`SELECT 1 AS present
			 FROM ${table} INDEXED BY ${statusIndex}
			 WHERE status IN ('pending', 'leased')${predicate}
			 LIMIT 1001`,
			[],
			{ deadlineMs: 5_000 },
		);
		const oldest = await ownerQueryOne<{ readonly oldestAt?: string | null }>(
			owner,
			`heartbeat.queue-pressure.${source}.oldest`,
			`SELECT created_at AS oldestAt
			 FROM ${table} INDEXED BY ${createdIndex}
			 WHERE status IN ('pending', 'leased')${predicate}
			 ORDER BY created_at ASC
			 LIMIT 1`,
			[],
			{ deadlineMs: 5_000 },
		);
		return { depth: rows.length, oldestAt: oldest?.oldestAt ?? null };
	} catch {
		return undefined;
	}
}

function queuePressureAgeSec(value: string | null): number {
	if (!value) return 0;
	const timestamp = new Date(value).getTime();
	if (!Number.isFinite(timestamp)) return 0;
	return Math.max(0, (Date.now() - timestamp) / 1000);
}

async function ownerQueuePressureSnapshot(owner: DbOwnerClient): Promise<QueuePressureSnapshot> {
	const [memory, summary] = await Promise.all([
		ownerQueuePressure(owner, "memory"),
		ownerQueuePressure(owner, "summary"),
	]);
	const oldestAt = [memory?.oldestAt, summary?.oldestAt].filter(
		(value): value is string => value !== undefined && value !== null,
	);
	const ages = oldestAt.map(queuePressureAgeSec);
	return {
		memoryQueueDepth: memory?.depth,
		summaryQueueDepth: summary?.depth,
		oldestJobAgeSec: ages.length === 0 ? undefined : Math.max(...ages),
	};
}

async function ownerHasPendingVecBackfill(owner: DbOwnerClient, expectedDimensions: number): Promise<boolean> {
	const rowidsHandle = owner.submit<{ readonly present?: number } | undefined>(
		{
			kind: "query",
			statement: {
				sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings_rowids' LIMIT 1",
				result: "get",
				transactional: false,
				readonly: true,
			},
		},
		{ operation: "maintenance.vec-backfill-probe-schema", lane: "read", deadlineMs: 5_000 },
	);
	const rowids = await owner.awaitResult(rowidsHandle, 5_000);
	const targetTable = rowids === undefined ? "vec_embeddings" : "vec_embeddings_rowids";
	const pendingHandle = owner.submit<{ readonly present?: number } | undefined>(
		{
			kind: "query",
			statement: {
				sql: `SELECT 1 AS present FROM embeddings e
				LEFT JOIN ${targetTable} v ON v.id = e.id
				LEFT JOIN vec_embeddings_quarantine q ON q.rowid = e.id
				WHERE v.id IS NULL AND q.rowid IS NULL AND e.dimensions = ? LIMIT 1`,
				params: [expectedDimensions],
				result: "get",
				transactional: false,
				readonly: true,
			},
		},
		{ operation: "maintenance.vec-backfill-probe", lane: "read", deadlineMs: 5_000 },
	);
	// `undefined` is a successful empty result. Errors must escape so the
	// bounded retry path can distinguish an operational failure from "no work".
	return (await owner.awaitResult(pendingHandle, 5_000)) !== undefined;
}

export function countConnectorsActive(connectors: readonly { readonly status: string }[]): number {
	// ConnectorStatus is "idle" | "syncing" | "error"; there is no "active"
	// state. The heartbeat field keeps its historical name, but means
	// connectors that are registered and not currently errored.
	return connectors.filter((cn) => cn.status !== "error").length;
}

// ============================================================================
// Hono App
// ============================================================================

export const app = new Hono();

// Once migration verification has confirmed corruption, keep every mutating
// HTTP surface fail-closed while continuing to serve readonly routes and the
// existing repair guidance used by /health/ready.
app.use("*", async (c, next) => {
	if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return await next();
	if (!migrationIntegrityWritesBlocked) return await next();
	const databaseIntegrity = getDatabaseIntegrityStatus();
	const error = migrationWritesDeferred
		? "Writes are blocked: upgrade deferred pending prior-generation verification; restart completes it"
		: new DatabaseIntegrityCorruptError().message;
	return c.json(
		{
			error,
			repairGuidance: databaseIntegrity.repairGuidance,
		},
		503,
	);
});

// Resolve the custom SQLite runtime once so both owner lanes use the same
// runtime selected for this daemon instance.
const sqliteRuntime = resolveSqliteRuntimeConfig({ agentsDir: AGENTS_DIR });

export function createRecallDbOwnerOptions(sqlitePath: string | undefined): DbOwnerClientOptions {
	return { dbPath: MEMORY_DB, sqlitePath, workerRole: "recall" };
}

// Recall uses its own child-process lane so request reads never wait behind
// maintenance or write work in the generic owner.
const recallOwner = createDbOwnerClient(createRecallDbOwnerOptions(sqliteRuntime.choice?.path));
recallDbOwner = recallOwner;

registerGlobalMiddleware(app);
getOrCreateInferenceRouter(resolveDefaultBasePath());

mountHealthRoutes(app);
mountMcpRoute(app);
registerAuthRoutes(app);

registerMemoryRoutes(app, { recallOwner });
registerHooksRoutes(app);
registerKnowledgeRoutes(app);
registerOntologyRoutes(app);
registerRepairRoutes(app);
registerConnectorRoutes(app);
registerHarnessInstallRoutes(app);
registerPluginRoutes(app);
registerGraphiqRoutes(app);
registerSecretRoutes(app);
registerSessionRoutes(app, { gitConfig, stopGitSyncTimer, startGitSyncTimer, getGitStatus, gitPull, gitPush, gitSync });
registerSourcesRoutes(app);
registerImportRoutes(app);
registerTranscriptImportRoutes(app);
registerPipelineRoutes(app);
registerReflectionRoutes(app);
registerTelemetryRoutes(app);
registerDatabaseDiagnosticsRoutes(app);
registerQueueDiagnosticsRoutes(app);
registerMiscRoutes(app);
app.use("/api/inference", async (c, next) => {
	if (c.req.method === "GET") return requirePermission("diagnostics", authConfig)(c, next);
	return requirePermission("admin", authConfig)(c, next);
});
app.use("/api/inference/*", async (c, next) => {
	if (c.req.method === "GET") return requirePermission("diagnostics", authConfig)(c, next);
	return requirePermission("admin", authConfig)(c, next);
});
mountInferenceRoutes(app, {
	getAuthMode: () => authConfig.mode,
	getTelemetry: () => telemetryRef,
});

// ============================================================================
// Additional route modules (from main)
// ============================================================================

setFetchEmbedding(fetchEmbedding);
// Mount the literal /api/skills/analytics before mountSkillsRoutes, whose
// /api/skills/:name route would otherwise match "analytics" as a skill name.
mountSkillAnalyticsRoutes(app);
mountSkillsRoutes(app);
mountMarketplaceRoutes(app);
mountMcpAnalyticsRoutes(app);
mountAppTrayRoutes(app);
mountWidgetRoutes(app);
mountEventBusRoutes(app);
mountMarketplaceReviewsRoutes(app);
mountChangelogRoutes(app);
mountOsChatRoutes(app);
mountOsAgentRoutes(app);
setupDashboardRoutes(app);

// ============================================================================
// File Watcher
// ============================================================================

let watcher: ReturnType<typeof watch> | null = null;
let nativeMemoryBridge: NativeMemoryBridgeHandle | null = null;

// Fast in-process cache layered on top of the persistent legacy_markdown_imports
// manifest. The DB manifest is the authoritative restart-safe skip state;
// this map only avoids duplicate work within a single daemon lifetime.
const ingestedMemoryFiles = new Map<string, string>();
const LEGACY_MARKDOWN_IMPORTER_VERSION = 1;
const MEMORY_IMPORT_POLL_MS = 30_000;

// #1172: harnesses that never signal session-end (closed/abandoned desktop
// chats) leave live-retained transcripts unclosed; sweep the stale sessions
// and fire the deferred session-end on a timer.
const STALE_SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const ACP_DELIVERY_RECONCILIATION_INTERVAL_MS = 30_000;
const STALE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MEMORY_IMPORT_FILE_DELAY_MS = 50;
let memoryImportTimer: ReturnType<typeof setInterval> | null = null;
let staleSessionSweepTimer: ReturnType<typeof setInterval> | null = null;
let acpDeliveryReconciliationTimer: ReturnType<typeof setInterval> | null = null;
let memoryImportInFlight = false;

let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

async function syncHarnessConfigs() {
	const identityMode = loadIdentityMode(AGENTS_DIR);
	if (!identityModeManagesFiles(identityMode)) {
		// Clean up stale generated harness identity files when mode is off
		await cleanupStaleHarnessIdentity();
		await ensureArchitectureDoc();
		return;
	}
	const agentsMdPath = join(AGENTS_DIR, "AGENTS.md");
	if (!existsSync(agentsMdPath)) return;
	const activeHarnesses = new Set(loadConfiguredHarnesses(AGENTS_DIR));

	const rawContent = await readFileAsync(agentsMdPath, "utf8");
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
# Dashboard: http://127.0.0.1:3850
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
					const fileContent = (await readFileAsync(identityPath, "utf8")).trim();
					if (!fileContent) return "";
					if (
						name === "MEMORY.md" &&
						(!scanMemoryContent(fileContent).contextEligible ||
							(
								await requestMemoryHead<{ generated: boolean }>({
									action: "inspect",
									agentId: "default",
									content: fileContent,
								})
							).generated)
					)
						return "";
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
	if (activeHarnesses.has("opencode") && existsSync(opencodeDir)) {
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

/**
 * Remove Signet-generated harness identity files when identity mode is off.
 * Only deletes files whose first lines match Signet-generated markers.
 */
async function cleanupStaleHarnessIdentity(): Promise<void> {
	const activeHarnesses = new Set(loadConfiguredHarnesses(AGENTS_DIR));
	const targets: Array<{ path: string; harness: string }> = [];

	const opencodeDir = join(homedir(), ".config", "opencode");
	if (activeHarnesses.has("opencode") && existsSync(opencodeDir)) {
		targets.push({ path: join(opencodeDir, "AGENTS.md"), harness: "opencode" });
	}

	// Gemini uses a configurable GEMINI.md path; check the standard and custom locations
	if (activeHarnesses.has("gemini")) {
		const geminiDir = join(homedir(), ".gemini");
		if (existsSync(geminiDir)) {
			targets.push({ path: join(geminiDir, "GEMINI.md"), harness: "gemini" });
			// Also check for custom context-file path from settings.json
			try {
				const settingsPath = join(geminiDir, "settings.json");
				if (existsSync(settingsPath)) {
					const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
					const ctx =
						typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).context : null;
					if (typeof ctx === "object" && ctx !== null) {
						const fn = (ctx as Record<string, unknown>).fileName;
						if (Array.isArray(fn) && typeof fn[0] === "string") {
							const custom = resolve(geminiDir, fn[0]);
							if (custom.startsWith(resolve(geminiDir) + sep) && custom !== join(geminiDir, "GEMINI.md")) {
								targets.push({ path: custom, harness: "gemini" });
							}
						}
					}
				}
			} catch {
				// Non-fatal — default path already covered
			}
		}
	}

	for (const { path: targetPath, harness } of targets) {
		if (!existsSync(targetPath)) continue;
		try {
			const raw = await readFileAsync(targetPath, "utf8");
			const lines = raw.split("\n").slice(0, 5);
			const isGenerated = lines.some(
				(line, i) =>
					/^#\s+AUTO-GENERATED\s+from\s+.*\s+by\s+Signet/i.test(line) ||
					(/^#\s+Auto-generated\s+from\s+/.test(line) && i + 1 < lines.length && /^#\s+Source:\s+/.test(lines[i + 1])),
			);
			if (isGenerated) {
				await unlinkAsync(targetPath);
				logger.sync.harness(harness, `cleaned stale generated file: ${targetPath}`);
			}
		} catch {
			// Non-fatal
		}
	}
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

interface LegacyMarkdownFileState {
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly size: number;
}

function daemonDbOwner(): DbOwnerClient {
	if (dbOwnerClient === null) throw new Error("DB owner is unavailable");
	return dbOwnerClient;
}

async function resolveActiveEmbeddingConfigThroughOwner(
	owner: DbOwnerClient,
	configured: ResolvedMemoryConfig["embedding"],
	operation: string,
): Promise<ResolvedMemoryConfig["embedding"]> {
	if (configured.profile) return configured;
	const row = await ownerQueryOne<EmbeddingIndexStateRow>(
		owner,
		operation,
		"SELECT active_profile_json, staging_profile_json, state, last_error FROM embedding_index_state WHERE id = 1",
		[],
		{ deadlineMs: 5_000 },
	);
	return resolveActiveEmbeddingConfigFromState(configured, parseEmbeddingIndexStateRow(row ?? null));
}

async function legacyMarkdownFileState(filePath: string): Promise<LegacyMarkdownFileState | null> {
	try {
		const fileStat = await statAsync(filePath);
		return { mtimeMs: Math.round(fileStat.mtimeMs), ctimeMs: Math.round(fileStat.ctimeMs), size: fileStat.size };
	} catch {
		return null;
	}
}

async function readLegacyMarkdownImportState(filePath: string): Promise<{
	readonly mtime_ms: number;
	readonly ctime_ms: number;
	readonly size: number;
	readonly content_hash: string;
	readonly importer_version: number;
	readonly chunk_count: number;
	readonly status: string;
} | null> {
	try {
		const row = await ownerQueryOne<{
			readonly mtime_ms: number;
			readonly ctime_ms: number;
			readonly size: number;
			readonly content_hash: string;
			readonly importer_version: number;
			readonly chunk_count: number;
			readonly status: string;
		}>(
			daemonDbOwner(),
			"startup.legacy-markdown-import-state",
			`SELECT mtime_ms, ctime_ms, size, content_hash, importer_version, chunk_count, status
			 FROM legacy_markdown_imports
			 WHERE path = ?`,
			[filePath],
			{ deadlineMs: 5_000 },
		);
		return row ?? null;
	} catch {
		// Older/unmigrated DBs fall back to the legacy importer behavior.
		return null;
	}
}

function legacyMarkdownImportIsCurrent(
	row: Awaited<ReturnType<typeof readLegacyMarkdownImportState>>,
	state: LegacyMarkdownFileState,
): boolean {
	return (
		row !== null &&
		row.importer_version === LEGACY_MARKDOWN_IMPORTER_VERSION &&
		row.mtime_ms === state.mtimeMs &&
		row.ctime_ms === state.ctimeMs &&
		row.size === state.size &&
		(row.status === "imported" || row.status === "empty")
	);
}

async function writeLegacyMarkdownImportState(args: {
	readonly filePath: string;
	readonly state: LegacyMarkdownFileState;
	readonly contentHash: string;
	readonly chunkCount: number;
	readonly status: "imported" | "empty" | "failed";
	readonly error?: string | null;
}): Promise<void> {
	try {
		const now = new Date().toISOString();
		await ownerTransaction(
			daemonDbOwner(),
			"startup.legacy-markdown-import-state-write",
			[
				ownerRunStatement(
					`INSERT INTO legacy_markdown_imports
					 (path, mtime_ms, ctime_ms, size, content_hash, importer_version, chunk_count,
					  last_imported_at, last_seen_at, status, error)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(path) DO UPDATE SET
					   mtime_ms = excluded.mtime_ms,
					   ctime_ms = excluded.ctime_ms,
					   size = excluded.size,
					   content_hash = excluded.content_hash,
					   importer_version = excluded.importer_version,
					   chunk_count = excluded.chunk_count,
					   last_imported_at = excluded.last_imported_at,
					   last_seen_at = excluded.last_seen_at,
					   status = excluded.status,
					   error = excluded.error`,
					[
						args.filePath,
						args.state.mtimeMs,
						args.state.ctimeMs,
						args.state.size,
						args.contentHash,
						LEGACY_MARKDOWN_IMPORTER_VERSION,
						args.chunkCount,
						now,
						now,
						args.status,
						args.error ?? null,
					],
				),
			],
			{ deadlineMs: 5_000 },
		);
	} catch {
		// Non-fatal: importer correctness still falls back to idempotency/source dedupe.
	}
}

async function legacyMarkdownChunkKnown(filePath: string, chunkHash: string): Promise<boolean> {
	try {
		const row = await ownerQueryOne<{ readonly present: number }>(
			daemonDbOwner(),
			"startup.legacy-markdown-chunk-known",
			"SELECT 1 AS present FROM legacy_markdown_chunks WHERE file_path = ? AND chunk_hash = ?",
			[filePath, chunkHash],
			{ deadlineMs: 5_000 },
		);
		return row !== undefined;
	} catch {
		return false;
	}
}

async function recordLegacyMarkdownChunk(args: {
	readonly filePath: string;
	readonly chunkHash: string;
	readonly chunkIndex: number;
	readonly memoryId: string | null;
	readonly sourceId: string;
}): Promise<void> {
	try {
		await ownerTransaction(
			daemonDbOwner(),
			"startup.legacy-markdown-chunk-write",
			[
				ownerRunStatement(
					`INSERT INTO legacy_markdown_chunks
					 (file_path, chunk_hash, chunk_index, memory_id, source_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(file_path, chunk_hash) DO UPDATE SET
					   chunk_index = excluded.chunk_index,
					   memory_id = COALESCE(excluded.memory_id, legacy_markdown_chunks.memory_id),
					   source_id = excluded.source_id`,
					[args.filePath, args.chunkHash, args.chunkIndex, args.memoryId, args.sourceId, new Date().toISOString()],
				),
			],
			{ deadlineMs: 5_000 },
		);
	} catch {
		// Non-fatal.
	}
}

function memoryIdFromRememberResponse(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return null;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

async function ingestMemoryMarkdown(filePath: string): Promise<number> {
	if (filePath.endsWith("MEMORY.md")) return 0;

	const filenameWithExt = basename(filePath);
	if (MEMORY_BACKUP_FILENAME_RE.test(filenameWithExt) || ARTIFACT_FILENAME_RE.test(filenameWithExt)) return 0;

	const fileState = await legacyMarkdownFileState(filePath);
	if (fileState === null) return 0;

	const priorState = await readLegacyMarkdownImportState(filePath);
	if (legacyMarkdownImportIsCurrent(priorState, fileState)) return 0;

	let content: string;
	try {
		content = await readFileAsync(filePath, "utf-8");
	} catch (e) {
		logger.error("watcher", "Failed to read memory file", undefined, {
			path: filePath,
			error: String(e),
		});
		return 0;
	}

	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	if (
		priorState?.content_hash === hash &&
		priorState.importer_version === LEGACY_MARKDOWN_IMPORTER_VERSION &&
		(priorState.status === "imported" || priorState.status === "empty")
	) {
		await writeLegacyMarkdownImportState({
			filePath,
			state: fileState,
			contentHash: hash,
			chunkCount: priorState.chunk_count,
			status: priorState.status === "empty" ? "empty" : "imported",
		});
		return 0;
	}

	if (!content.trim()) {
		await writeLegacyMarkdownImportState({
			filePath,
			state: fileState,
			contentHash: hash,
			chunkCount: 0,
			status: "empty",
		});
		return 0;
	}

	const filename = basename(filePath, ".md");
	const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
	const date = dateMatch ? dateMatch[1] : null;

	const chunks = chunkMarkdownHierarchically(content, 512);
	let imported = 0;
	let transientFailures = 0;
	let eligibleChunks = 0;
	const yielder = yieldEvery(1);

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];

		const body =
			chunk.header && chunk.text.startsWith(chunk.header)
				? chunk.text.slice(chunk.header.length).trim()
				: chunk.text.trim();
		if (body.length < 80) {
			await yielder();
			continue;
		}
		eligibleChunks++;

		const chunkHash = createHash("sha256").update(chunk.text).digest("hex").slice(0, 16);
		const chunkKey = `openclaw:${filename}:${chunkHash}`;
		if (await legacyMarkdownChunkKnown(filePath, chunkHash)) {
			imported++;
			await yielder();
			continue;
		}

		try {
			const response = await fetchInternal(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: chunk.text,
					who: "openclaw-memory",
					importance: chunk.level === "section" ? 0.65 : 0.55,
					sourceType: "openclaw-memory-log",
					sourceId: chunkKey,
					idempotencyKey: chunkKey,
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
				let memoryId: string | null = null;
				try {
					memoryId = memoryIdFromRememberResponse(await response.json());
				} catch {
					memoryId = null;
				}
				await recordLegacyMarkdownChunk({ filePath, chunkHash, chunkIndex: i, memoryId, sourceId: chunkKey });
				imported++;
			} else if (response.status === 409) {
				// Existing historical imports can predate this manifest table. A 409 still
				// proves this deterministic chunk should not be posted again on every
				// daemon restart, so persist a manifest row without a memory id.
				await recordLegacyMarkdownChunk({ filePath, chunkHash, chunkIndex: i, memoryId: null, sourceId: chunkKey });
				imported++;
				logger.debug("watcher", "Legacy memory chunk already exists", { path: filePath, chunkIndex: i });
			} else {
				transientFailures++;
				logger.warn("watcher", "Failed to ingest memory chunk", {
					path: filePath,
					chunkIndex: i,
					status: response.status,
				});
			}
		} catch (e) {
			transientFailures++;
			const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
			logger.error("watcher", "Failed to ingest memory chunk", undefined, {
				path: filePath,
				chunkIndex: i,
				...errDetails,
			});
		}
		await yielder();
	}

	if (transientFailures > 0) {
		ingestedMemoryFiles.delete(filePath);
		await writeLegacyMarkdownImportState({
			filePath,
			state: fileState,
			contentHash: hash,
			chunkCount: imported,
			status: "failed",
			error: `${transientFailures} transient chunk import failure(s)`,
		});
	} else {
		ingestedMemoryFiles.set(filePath, hash);
		await writeLegacyMarkdownImportState({
			filePath,
			state: fileState,
			contentHash: hash,
			chunkCount: imported,
			status: eligibleChunks === 0 ? "empty" : "imported",
		});
	}

	if (imported > 0) {
		logger.info("watcher", "Ingested memory file", {
			path: filePath,
			chunks: imported,
			sections: chunks.filter((c) => c.level === "section").length,
			filename,
		});
	}
	return imported;
}

async function* legacyMarkdownFiles(memoryDir: string): AsyncGenerator<string> {
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(memoryDir);
	} catch (error) {
		const errDetails = error instanceof Error ? { message: error.message } : { error: String(error) };
		logger.error("daemon", "Failed to read memory directory", undefined, errDetails);
		return;
	}
	for await (const entry of directory) {
		if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
		if (ARTIFACT_FILENAME_RE.test(entry.name) || MEMORY_BACKUP_FILENAME_RE.test(entry.name)) continue;
		yield join(memoryDir, entry.name);
	}
}

async function importExistingMemoryFiles(): Promise<number> {
	const memoryDir = join(AGENTS_DIR, "memory");
	if (!existsSync(memoryDir)) {
		logger.debug("daemon", "Memory directory does not exist, skipping initial import");
		return 0;
	}

	let totalChunks = 0;
	let fileCount = 0;
	const yielder = yieldEvery(10);
	for await (const filePath of legacyMarkdownFiles(memoryDir)) {
		fileCount++;
		const count = await ingestMemoryMarkdown(filePath);
		totalChunks += count;
		await yielder();
		if (count > 0) await sleep(MEMORY_IMPORT_FILE_DELAY_MS);
	}

	if (fileCount === 0) {
		logger.debug("daemon", "importExistingMemoryFiles: all files are artifacts/backups, skipping");
		return 0;
	}
	if (totalChunks > 0) {
		logger.info("daemon", "Imported existing memory files", {
			files: fileCount,
			chunks: totalChunks,
		});
	}
	return totalChunks;
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function startMemoryImportPoller(): void {
	if (memoryImportTimer !== null) return;
	memoryImportTimer = setInterval(() => {
		if (memoryImportInFlight) return;
		memoryImportInFlight = true;
		importExistingMemoryFiles()
			.catch((e) => {
				const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
				logger.error("daemon", "Failed to import memory files", undefined, errDetails);
			})
			.finally(() => {
				memoryImportInFlight = false;
			});
	}, MEMORY_IMPORT_POLL_MS);
	memoryImportTimer.unref?.();
	logger.debug("watcher", "Started memory import poller", { intervalMs: MEMORY_IMPORT_POLL_MS });
}

function stopMemoryImportPoller(): void {
	if (memoryImportTimer === null) return;
	clearInterval(memoryImportTimer);
	memoryImportTimer = null;
	memoryImportInFlight = false;
}

function startStaleSessionSweeper(): void {
	if (staleSessionSweepTimer !== null) return;
	staleSessionSweepTimer = setInterval(() => {
		// Keep each timer tick small. The sweep is single-flight and yields
		// between finalizations, so a large abandoned-session backlog cannot
		// monopolize the daemon or fan out downstream capture work.
		sweepStaleSessions({ staleOlderThanMs: STALE_SESSION_TTL_MS, limit: 10 }).catch((e) => {
			logger.error("daemon", "Stale session sweep failed", undefined, {
				message: e instanceof Error ? e.message : String(e),
			});
		});
	}, STALE_SESSION_SWEEP_INTERVAL_MS);
	staleSessionSweepTimer.unref?.();
	logger.debug("watcher", "Started stale session sweeper", {
		intervalMs: STALE_SESSION_SWEEP_INTERVAL_MS,
		ttlMs: STALE_SESSION_TTL_MS,
	});
}

function stopStaleSessionSweeper(): void {
	if (staleSessionSweepTimer === null) return;
	clearInterval(staleSessionSweepTimer);
	staleSessionSweepTimer = null;
}

function startAcpDeliveryReconciliation(): void {
	if (acpDeliveryReconciliationTimer !== null) return;
	acpDeliveryReconciliationTimer = setInterval(() => {
		void reconcileAcpDeliveries()
			.then((reconciled) => {
				if (reconciled > 0) logger.info("daemon", "Reconciled abandoned ACP delivery attempts", { reconciled });
			})
			.catch((error) => {
				logger.warn("daemon", "ACP delivery reconciliation failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}, ACP_DELIVERY_RECONCILIATION_INTERVAL_MS);
	acpDeliveryReconciliationTimer.unref?.();
	logger.debug("watcher", "Started ACP delivery reconciliation", {
		intervalMs: ACP_DELIVERY_RECONCILIATION_INTERVAL_MS,
	});
}

function stopAcpDeliveryReconciliation(): void {
	if (acpDeliveryReconciliationTimer === null) return;
	clearInterval(acpDeliveryReconciliationTimer);
	acpDeliveryReconciliationTimer = null;
}

function invalidateInferenceConfigForPath(path: string): void {
	if (!isInferenceRouterConfigPath(AGENTS_DIR, path)) return;
	getOrCreateInferenceRouter(AGENTS_DIR).invalidateConfig();
}

function startFileWatcher() {
	// Do NOT watch the memory/ directory directly — Bun's fs.watch()
	// opens one O_RDONLY FD per file in a watched directory and never
	// releases them on close(), leaking ~8 000 FDs with canonical
	// artifacts present. Canonical artifacts and backups are intentionally
	// ignored; rare legacy non-artifact memory markdown imports are handled
	// by the lightweight poller started after daemon readiness.
	watcher = watch(
		[
			join(AGENTS_DIR, "agent.yaml"),
			join(AGENTS_DIR, "AGENT.yaml"),
			join(AGENTS_DIR, "config.yaml"),
			join(AGENTS_DIR, "AGENTS.md"),
			join(AGENTS_DIR, "SOUL.md"),
			join(AGENTS_DIR, "MEMORY.md"),
			join(AGENTS_DIR, "IDENTITY.md"),
			join(AGENTS_DIR, "USER.md"),
			join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md"),
			join(AGENTS_DIR, ".sigignore"),
			join(AGENTS_DIR, "agents"),
		],
		{
			persistent: true,
			ignoreInitial: true,
			ignored: createAgentsWatcherIgnoreMatcher(AGENTS_DIR),
		},
	);

	watcher.on("error", (error) => {
		logger.error("watcher", "File watcher error", error instanceof Error ? error : new Error(String(error)));
	});

	watcher.on("change", (path) => {
		logger.info("watcher", "File changed", { path });
		const base = basename(path);
		const isRuntimeConfig = base === "agent.yaml" || base === "AGENT.yaml" || base === "config.yaml";
		if (isRuntimeConfig) {
			try {
				// Keep the accepted runtime state and its derived reload paths intact
				// when a newly selected config is invalid. In particular, do not
				// invalidate routing or auto-commit the rejected document.
				loadMemoryConfig(AGENTS_DIR);
			} catch (error) {
				logger.error(
					"config",
					"Rejected runtime config change",
					error instanceof Error ? error : new Error("invalid runtime configuration"),
				);
				return;
			}
		}
		invalidateInferenceConfigForPath(path);
		scheduleAutoCommit(path);

		if (isRuntimeConfig) {
			try {
				reloadAuthState(AGENTS_DIR);
				logger.info("config", "Auth config reloaded from disk");
			} catch (e) {
				logger.error("config", "Failed to reload auth config", e as Error);
			}
			try {
				if (!loadMemoryConfig(AGENTS_DIR).pipelineV2.telemetryEnabled) {
					setTelemetryRef(undefined);
					void stopActiveTelemetry();
					logger.info("telemetry", "Telemetry disabled from configuration");
				}
			} catch (e) {
				logger.error("telemetry", "Failed to apply telemetry configuration; telemetry state unchanged", e as Error);
			}
		}

		const SYNC_TRIGGER_FILES = [
			"agent.yaml",
			"AGENT.yaml",
			"config.yaml",
			"AGENTS.md",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"MEMORY.md",
		];
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
		invalidateInferenceConfigForPath(path);
		if (path.endsWith("SIGNET-ARCHITECTURE.md")) {
			void ensureArchitectureDoc();
		}
		scheduleAutoCommit(path);
	});

	watcher.on("add", (path) => {
		logger.info("watcher", "File added", { path });
		invalidateInferenceConfigForPath(path);
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
}

// ============================================================================
// Pipeline runtime
// ============================================================================

function readPipelineMode(cfg: ResolvedMemoryConfig["pipelineV2"]): string {
	if (!cfg.enabled) return "disabled";
	if (cfg.paused) return "paused";
	if (cfg.mutationsFrozen) return "frozen";
	if (cfg.shadowMode) return "shadow";
	return "controlled-write";
}

async function stopPipelineRuntime(): Promise<void> {
	if (vacuumConversionHandle) {
		vacuumConversionHandle.stop();
		vacuumConversionHandle = null;
	}
	if (skillReconcilerHandle) {
		try {
			await Promise.resolve(skillReconcilerHandle.stop());
		} catch {}
		skillReconcilerHandle = null;
	}

	if (embeddingTrackerHandle) {
		try {
			await embeddingTrackerHandle.stop();
		} catch {}
		embeddingTrackerHandle = null;
		setEmbeddingTrackerHandle(null);
	}
	if (embeddingIndexMigrationHandle) {
		try {
			await embeddingIndexMigrationHandle.stop();
		} catch {}
		embeddingIndexMigrationHandle = null;
	}
	if (sharedEmbeddingTrackerHandle) {
		try {
			await sharedEmbeddingTrackerHandle.stop();
		} catch {}
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

	if (reflectionWorkerHandle) {
		reflectionWorkerHandle.stop();
		reflectionWorkerHandle = null;
	}

	if (transcriptCaptureWorkerHandle) {
		try {
			transcriptCaptureWorkerHandle.stop();
		} catch {}
		transcriptCaptureWorkerHandle = null;
	}

	try {
		await stopPipeline();
	} catch {}

	closeInferenceProviderResolver();
	stopModelRegistry();
	invalidateDiagnosticsCache();
}

async function restartPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	await stopPipelineRuntime();
	await startPipelineRuntime(memoryCfg, telemetry);
}

function restartAfterEmbeddingPromotion(telemetry?: TelemetryCollector): void {
	if (embeddingPromotionRestart) return;
	const activePass = dreamingWorkerHandle?.activePass;
	embeddingPromotionRestart = (async () => {
		// An embedding-index promotion changes recall infrastructure, not the
		// evidence window already being reasoned over. Let that bounded pass
		// finish instead of orphaning it during the broad worker restart.
		if (activePass) {
			logger.info("embedding", "Deferring embedding worker restart until Dreaming pass completes");
			await activePass.catch(() => undefined);
		}
		if (shuttingDown) return;
		await restartPipelineRuntime(loadMemoryConfig(AGENTS_DIR), telemetry);
	})()
		.catch((error) => {
			logger.error("embedding", "Promoted index but could not restart embedding workers", undefined, {
				error: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => {
			embeddingPromotionRestart = null;
		});
}

export async function stopDaemonRuntimeForTests(): Promise<void> {
	await stopPipelineRuntime();
}

function executorForTargetRef(
	statusValue: InferenceStatusSummary,
	targetRef: string | undefined,
): RuntimeProviderName | null {
	if (!targetRef) return null;
	const parsed = parseRoutingTargetRef(targetRef);
	if (!parsed.ok) return null;
	return (statusValue.targets[parsed.value.targetId]?.executor as RuntimeProviderName | undefined) ?? null;
}

async function syncAgentRoster(agentsDir: string): Promise<void> {
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

	const now = new Date().toISOString();
	const statements = roster.flatMap((entry) => {
		const normalized = normalizeAgentRosterEntry(entry);
		if (!normalized) return [];
		return [
			ownerStatement(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   name = excluded.name,
				   read_policy = excluded.read_policy,
				   policy_group = excluded.policy_group,
				   updated_at = excluded.updated_at`,
				[normalized.name, normalized.name, normalized.readPolicy, normalized.policyGroup, now, now],
			),
		];
	});
	if (statements.length > 0) {
		await dbOwnerBatch(statements, {
			operation: "startup.sync-agent-roster",
			lane: "write",
			deadlineMs: 5_000,
			estimatedWorkUnits: statements.length,
		});
	}
	logger.info("daemon", "Agent roster synced", { count: roster.length });
}

const INFERENCE_CONFIG_FILES = ["agent.yaml", "AGENT.yaml"] as const;

function configuredInferenceMode(agentsDir: string): "local" | "remote" | "unknown" {
	for (const name of INFERENCE_CONFIG_FILES) {
		const path = join(agentsDir, name);
		if (!existsSync(path)) continue;
		try {
			const routing = parseRoutingConfig(parseSimpleYaml(readFileSync(path, "utf-8")));
			if (routing.ok && routing.value.enabled) {
				const targets = configuredRoutingTargetRefs(routing.value).flatMap((ref) => {
					const [targetId] = ref.split("/", 1);
					const target = routing.value.targets[targetId];
					return target ? [target] : [];
				});
				const localities = targets.map(routingTargetLocality);
				if (localities.includes("remote")) return "remote";
				if (localities.includes("unknown")) return "unknown";
				return "local";
			}
		} catch {
			// An invalid router config is reported by the router itself. Do not
			// infer a mode from retired memory.pipelineV2 provider fields.
		}
		break;
	}

	return "unknown";
}

function buildTelemetryConfigSnapshot(agentsDir: string, memoryCfg: ResolvedMemoryConfig): TelemetryConfigSnapshot {
	return {
		graphEnabled: memoryCfg.pipelineV2.graph.enabled,
		rerankerEnabled: memoryCfg.pipelineV2.reranker.enabled,
		autonomousEnabled: memoryCfg.pipelineV2.autonomous.enabled,
		semanticContradictionEnabled: memoryCfg.pipelineV2.semanticContradictionEnabled,
		embeddingProvider: memoryCfg.embedding.provider,
		embeddingModel: memoryCfg.embedding.model,
		inferenceMode: configuredInferenceMode(agentsDir),
		harnesses: [...new Set(loadConfiguredHarnesses(agentsDir))].sort().join(","),
	};
}

async function startPipelineRuntime(memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector): Promise<void> {
	const pipelinePaused = memoryCfg.pipelineV2.paused;
	logger.info("dreaming", "Dreaming owns all semantic writes; legacy extraction is retired");
	// Terminalize every pre-existing legacy `extract` job. The source keeps its
	// provenance and memory kind, so only already-episodic evidence remains
	// reachable by the Dreaming cursor; derived rows are never reclassified.
	// Leased rows are terminalized too because no legacy worker remains. Runs on
	// cold boot and live-reload config transitions (#913).
	if (!pipelinePaused) {
		const deadLettered = await retireLegacyExtractionJobsAsync({
			reason: "Dreaming cutover: legacy extraction worker not started",
		});
		if (deadLettered > 0) {
			logger.info("dreaming", "Retired legacy extraction jobs", {
				count: deadLettered,
			});
		}
	}

	const activeEmbeddingCfg = await resolveActiveEmbeddingConfigThroughOwner(
		daemonDbOwner(),
		memoryCfg.embedding,
		"startup.resolve-active-embedding",
	);
	configureLlmConcurrency(memoryCfg.pipelineV2.worker.maxLlmConcurrency);
	logger.info("config", "Resolved embedding config", {
		provider: memoryCfg.embedding.provider,
		model: memoryCfg.embedding.model,
		dimensions: memoryCfg.embedding.dimensions,
	});

	if (!transcriptCaptureWorkerHandle) {
		transcriptCaptureWorkerHandle = await startTranscriptCaptureWorker(getDbAccessor(), AGENTS_DIR);
	}

	const router = getOrCreateInferenceRouter(AGENTS_DIR);
	// Surface broken routing references (defaultPolicy, workload targets, etc.) at
	// boot before any route is attempted (#1005). Never blocks daemon startup.
	void router.validateConfigReferences();
	const defaultAgentId = resolveDaemonAgentId();
	initInferenceProviderResolver((workload) => {
		switch (workload) {
			case "memoryExtraction":
				return router.createWorkloadProvider("memory_extraction", defaultAgentId);
			case "sessionSynthesis":
				return router.createWorkloadProvider("session_synthesis", defaultAgentId);
			case "aggregateRecall":
				return router.createWorkloadProvider("aggregate_recall", defaultAgentId);
			case "widgetGeneration":
				return router.createWorkloadProvider("widget_generation", defaultAgentId);
			case "repair":
				return router.createWorkloadProvider("repair", defaultAgentId);
			case "interactive":
				return router.createWorkloadProvider("interactive", defaultAgentId);
			case "default":
				return router.createWorkloadProvider("default", defaultAgentId);
		}
	});

	const routerStatus = await router.status(false);
	const statusValue = routerStatus.ok ? routerStatus.value : null;
	const extractionWorkloadConfigured = await router.hasWorkload("memory_extraction");
	const synthesisWorkloadConfigured = await router.hasWorkload("session_synthesis");
	const synthesisDecision =
		!pipelinePaused && synthesisWorkloadConfigured
			? await router.explain({ agentId: defaultAgentId, operation: "session_synthesis" })
			: null;
	const synthesisAvailable = Boolean(synthesisDecision?.ok);
	const synthesisEffective =
		(statusValue &&
			(executorForTargetRef(
				statusValue,
				synthesisDecision?.ok ? synthesisDecision.value.targetRef : undefined,
			) as RuntimeSynthesisProviderName | null)) ??
		(synthesisAvailable ? "inference" : null);
	// Dreaming owns all semantic writes (#913 hard cutover). Legacy extraction
	// is always disabled; the memory_extraction workload binding is still
	// resolved by the router because Dreaming uses it for inference calls.
	providerRuntimeResolution.extraction = {
		configured: null,
		resolved: "none",
		effective: "none",
		fallbackProvider: "none",
		status: "disabled",
		degraded: false,
		fallbackApplied: false,
		reason: "Dreaming owns semantic writes",
		blockedBy: [],
		since: null,
	};
	providerRuntimeResolution.synthesis = {
		configured: synthesisAvailable
			? statusValue
				? (executorForTargetRef(statusValue, synthesisDecision?.ok ? synthesisDecision.value.targetRef : undefined) ??
					null)
				: null
			: null,
		resolved: synthesisAvailable ? (synthesisEffective as RuntimeSynthesisProviderName | null) : null,
		effective: synthesisEffective,
	};

	logger.info("config", "Inference router workloads", {
		extraction: extractionWorkloadConfigured,
		synthesis: synthesisAvailable,
		interactive: await router.hasWorkload("interactive"),
		default: await router.hasWorkload("default"),
	});

	if (dbOwnerMaintenanceHandle === null) {
		dbOwnerMaintenanceHandle = createDbOwnerMaintenance({ dbPath: MEMORY_DB, owner: dbOwnerClient ?? undefined });
		registerDbOwnerMaintenance(dbOwnerMaintenanceHandle);
		registerDbOwnerHealthProvider(dbOwnerMaintenanceHandle.health);
	}

	if (memoryCfg.pipelineV2.enabled && !pipelinePaused) {
		startPipeline(
			getDbAccessor(),
			memoryCfg.pipelineV2,
			activeEmbeddingCfg,
			fetchEmbedding,
			memoryCfg.search,
			defaultAgentId,
			providerTracker,
			analyticsCollector,
			telemetry,
			dbOwnerMaintenanceHandle ?? undefined,
		);

		// Configure the main thread's own native embedding handle — but ONLY when
		// the provider is actually native. On x86_64, native ONNX warmup wedges
		// the event loop for 70+ seconds even when provider is ollama/openai
		// (#1073). A non-native provider must not trigger native warming, and
		// warmNative: false kills the native path outright even when the active
		// embedding profile is native.
		if (activeEmbeddingCfg.provider === "native" && activeEmbeddingCfg.warmNative !== false) {
			const { configureNativeEmbeddingAssets } = await import("./native-embedding");
			configureNativeEmbeddingAssets({
				embeddingWorkerPath: resolveEmbeddedWorkerPath("embedding-worker"),
				wasmAssetDir: materializeEmbeddedWasmAssets(),
				transformersRuntimeAssetPath: resolveEmbeddedWorkerPath("embedding-worker-transformers-runtime"),
			});
		}
	} else {
		ensureRetentionWorker(getDbAccessor(), DEFAULT_RETENTION, dbOwnerMaintenanceHandle ?? undefined);
	}

	if (activeEmbeddingCfg.provider !== "none" && memoryCfg.pipelineV2.embeddingTracker.enabled && !pipelinePaused) {
		embeddingTrackerHandle = startEmbeddingTracker(
			getDbAccessor(),
			activeEmbeddingCfg,
			memoryCfg.pipelineV2.embeddingTracker,
			memoryCfg.pipelineV2.repair,
			fetchEmbedding,
			checkEmbeddingProvider,
		);
		setEmbeddingTrackerHandle(embeddingTrackerHandle);
	}

	if (!pipelinePaused) {
		embeddingIndexMigrationHandle = await startEmbeddingIndexMigration({
			accessor: getDbAccessor(),
			configured: memoryCfg.embedding,
			// Re-read agent.yaml each tick so a mid-build config edit restarts
			// the build against the new profile instead of spinning on the
			// stale persisted one (#1160).
			readConfigured: () => loadMemoryConfig(AGENTS_DIR).embedding,
			fetchEmbedding,
			checkProvider: checkEmbeddingProvider,
			owner: dbOwnerClient ?? undefined,
			pollMs: memoryCfg.pipelineV2.embeddingTracker.pollMs,
			batchSize: memoryCfg.pipelineV2.embeddingTracker.batchSize,
			onPromoted: () => {
				restartAfterEmbeddingPromotion(telemetry);
			},
		});
	}

	if (memoryCfg.dreaming.enabled && !pipelinePaused && !memoryCfg.pipelineV2.mutationsFrozen) {
		try {
			dreamingWorkerHandle = startDreamingWorker(
				getDbAccessor(),
				memoryCfg.dreaming,
				AGENTS_DIR,
				defaultAgentId,
				{
					acpxMcp: {
						daemonUrl: `http://${INTERNAL_SELF_HOST}:${PORT}`,
						authorizationTokenForAgent: (agentId) =>
							authSecret
								? createToken(
										authSecret,
										{ sub: `dreaming:${agentId}`, role: "agent", scope: { agent: agentId } },
										Math.max(900, Math.ceil(memoryCfg.dreaming.timeout / 1000) + 60),
									)
								: undefined,
					},
					evidenceRetry: {
						cooldownMs: memoryCfg.pipelineV2.repair.requeueCooldownMs,
						hourlyBudget: memoryCfg.pipelineV2.repair.requeueHourlyBudget,
						maxAttempts: 3,
					},
					ownerMaintenance: dbOwnerMaintenanceHandle ?? undefined,
				},
				graphWriteCaps(memoryCfg),
			);
			setDreamingWorker(dreamingWorkerHandle);
		} catch (err) {
			logger.warn("dreaming", "Failed to start dreaming worker (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (memoryCfg.pipelineV2.reflections.enabled && !pipelinePaused) {
		try {
			reflectionWorkerHandle = startReflectionWorker(memoryCfg.pipelineV2.reflections);
		} catch (err) {
			logger.warn("reflections", "Failed to start reflection worker (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (memoryCfg.pipelineV2.procedural.enabled && !pipelinePaused) {
		skillReconcilerHandle = startReconciler({
			accessor: getDbAccessor(),
			pipelineConfig: memoryCfg.pipelineV2,
			embeddingConfig: memoryCfg.embedding,
			fetchEmbedding,
			agentsDir: AGENTS_DIR,
		});
	}

	invalidateDiagnosticsCache();
}

queueMicrotask(() => setRestartPipelineRuntime(restartPipelineRuntime));

// ============================================================================
// Shutdown
// ============================================================================

async function cleanup() {
	setShuttingDown(true);
	bindAbort.abort();
	await stopHarnessInstall();
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
	stopMemoryImportPoller();
	stopStaleSessionSweeper();
	stopAcpDeliveryReconciliation();
	await stopSourceIndexJobs();
	if (nativeMemoryBridge) {
		await nativeMemoryBridge.close();
		nativeMemoryBridge = null;
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
	stopResourceMonitors();
	logFdSnapshot("cleanup-start");
	await flushPendingSourceLifecycleTelemetry();
	if (telemetryRef) {
		try {
			await telemetryRef.stop();
		} catch {}
		telemetryRef = undefined;
		setTelemetryRef(undefined);
		setActiveTelemetry(undefined);
	}

	try {
		await flushPendingCheckpoints();
	} catch {}

	// Source ingestion survives inference reconfiguration; only daemon shutdown drains it.
	if (transcriptImportWorkerHandle) {
		try {
			await transcriptImportWorkerHandle.stop();
		} catch {}
		transcriptImportWorkerHandle = null;
	}
	if (transcriptRecoveryWorkerHandle) {
		try {
			await transcriptRecoveryWorkerHandle.stop();
		} catch {}
		transcriptRecoveryWorkerHandle = null;
	}
	await stopPipelineRuntime();

	if (dbOwnerMaintenanceHandle !== null) {
		await dbOwnerMaintenanceHandle.close().catch(() => {});
		dbOwnerMaintenanceHandle = null;
		registerDbOwnerMaintenance(null);
		registerDbOwnerHealthProvider(null);
	}

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

	await stopGitSyncTimer({ shutdown: true });
	stopUpdateTimer();

	const renderWorker = getSynthesisRenderWorker();
	if (renderWorker !== null) {
		setSynthesisRenderWorker(null);
		await renderWorker.terminate().catch((e) => {
			logger.debug("daemon", "render worker terminate failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		});
	}

	if (dbOwnerClient !== null) {
		await dbOwnerClient.close();
		dbOwnerClient = null;
	}
	await recallDbOwner?.close();
	recallDbOwner = null;
	closeDbAccessor();

	if (watcher) {
		logFdSnapshot("pre-cleanup-watcher");
		await watcher.close();
		logFdSnapshot("post-cleanup-watcher");
	}

	if (existsSync(PID_FILE)) {
		try {
			unlinkSync(PID_FILE);
		} catch {}
	}
}

let lifecycleStartedAt = "";

function buildLifecycleRecord(state: DaemonLifecycle["state"], extra: Partial<DaemonLifecycle> = {}): DaemonLifecycle {
	return {
		state,
		pid: process.pid,
		version: CURRENT_VERSION,
		startedAt: lifecycleStartedAt,
		systemdUnit: process.env.SIGNET_DAEMON_UNIT || undefined,
		...extra,
	};
}

let exitFlushInFlight: Promise<void> | null = null;

async function flushAndExit(exitCode: number): Promise<void> {
	if (exitFlushInFlight) return exitFlushInFlight;
	exitFlushInFlight = (async () => {
		// Update handoffs and repeated signals bypass normal cleanup. Give the
		// telemetry collector a bounded final drain before process.exit so a
		// wedge/crash record is not discarded on those paths.
		if (telemetryRef) {
			const timeout = new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 2_000);
				if (timer.unref) timer.unref();
			});
			await Promise.race([telemetryRef.stop(), timeout]).catch(() => {});
		}
		// The logger buffers file writes and flushes on a 1s timer; without an
		// explicit flush the final log lines can be lost on exit.
		logger.shutdown();
		process.exit(exitCode);
	})();
	return exitFlushInFlight;
}

function buildTerminalLifecycleRecord(reason: string, exitCode: number, error?: unknown): DaemonLifecycle {
	return buildLifecycleRecord(error === undefined ? "clean" : "error", {
		exitedAt: new Date().toISOString(),
		exitCode,
		reason,
		...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
	});
}

/** Bounds the draining cleanup so a wedged shutdown can never zombie the daemon. */
const SHUTDOWN_CLEANUP_DEADLINE_MS = 20_000;

/**
 * Single exit path for every catchable termination (signals and fatal
 * errors). Logs the exit path, records it in the lifecycle file, flushes the
 * logger buffer synchronously so the final lines actually land, then exits.
 * SIGKILL cannot be caught — a kill leaves the lifecycle record stuck at
 * "starting"/"running", which `signet status`/`doctor` report as an
 * unrecorded death instead of silence (issue #1148).
 *
 * The terminal lifecycle record is written only after cleanup completes (or
 * the hard deadline forces the exit): writing it earlier would leave a
 * "clean" record on a process still alive while cleanup hangs.
 *
 * `runCleanup` is disabled only for the update handoff: the replacement
 * daemon is already spawned and needs the port immediately, so the exit is
 * recorded and flushed but skips the draining cleanup.
 */
function requestShutdown(reason: string, exitCode: number, error?: unknown, runCleanup = true): void {
	if (shuttingDown) {
		// A second signal while draining must not wedge the process; flush and
		// exit immediately so the operator is never stuck with a zombie — and
		// the final log lines still land.
		void flushAndExit(exitCode);
		return;
	}
	setShuttingDown(true);
	logger.info("daemon", `Received ${reason}; shutting down`, { exitCode });
	if (!runCleanup) {
		writeDaemonLifecycle(AGENTS_DIR, buildTerminalLifecycleRecord(reason, exitCode, error));
		void flushAndExit(exitCode);
		return;
	}
	const cleanupDeadline = setTimeout(() => {
		logger.warn("daemon", "Shutdown cleanup timed out; forcing exit", {
			reason,
			exitCode,
			deadlineMs: SHUTDOWN_CLEANUP_DEADLINE_MS,
		});
		writeDaemonLifecycle(AGENTS_DIR, buildTerminalLifecycleRecord(reason, exitCode, error));
		void flushAndExit(exitCode);
	}, SHUTDOWN_CLEANUP_DEADLINE_MS);
	cleanup()
		.catch(() => {})
		.finally(() => {
			clearTimeout(cleanupDeadline);
			writeDaemonLifecycle(AGENTS_DIR, buildTerminalLifecycleRecord(reason, exitCode, error));
			void flushAndExit(exitCode);
		});
}

process.on("SIGINT", () => {
	requestShutdown("signal:SIGINT", 0);
});

process.on("SIGTERM", () => {
	requestShutdown("signal:SIGTERM", 0);
});

process.on("uncaughtException", (err) => {
	logger.error("daemon", "Uncaught exception", err);
	// Sanitized crash report: truncated message, home-stripped stack frames,
	// uptime. No memory content. Joinable to the install's heartbeat context.
	telemetryRef?.record("error.occurred", sanitizeCrashError(err, process.uptime() * 1000));
	requestShutdown("error:uncaughtException", 1, err);
});

process.on("unhandledRejection", (reason) => {
	logger.error(
		"daemon",
		"Unhandled rejection",
		reason instanceof Error ? reason : undefined,
		reason instanceof Error ? undefined : { reason: String(reason) },
	);
	// Sanitized crash report for rejections too (primitives degrade to a
	// truncated string).
	telemetryRef?.record("error.occurred", sanitizeCrashError(reason, process.uptime() * 1000));
	// DB owner errors are bounded-availability degradations by design:
	// deadline exhaustion cancels the job, queue-full rejects admission, and
	// the owner protocol keeps serving. Fire-and-forget background callers
	// (deferred maintenance, recovery, watchers) legitimately race these
	// rejections at startup, so killing the process here turns recoverable
	// queue pressure into a crash loop. Crash on unknown rejections; survive
	// DB owner availability errors.
	if (reason instanceof DbOwnerError) return;
	requestShutdown("error:unhandledRejection", 1, reason);
});

// ============================================================================
// Main
// ============================================================================

async function main() {
	const workspace = preflightWorkspace();
	if (workspace.status === "missing" || workspace.status === "incomplete") {
		console.error(formatWorkspacePreflightError(workspace));
		logger.shutdown(false);
		process.exitCode = 1;
		return;
	}

	// Validate the selected runtime configuration before acquiring the daemon
	// lock, running migrations, opening the database, or writing lifecycle/PID
	// state. The loader intentionally reports only file and field diagnostics;
	// malformed user content must never be echoed during startup failure.
	try {
		readRuntimeConfig(AGENTS_DIR);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "invalid runtime configuration";
		console.error(`Signet cannot start: ${detail}`);
		logger.shutdown(false);
		process.exitCode = 1;
		return;
	}

	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });
	mkdirSync(dirname(MEMORY_DB), { recursive: true });

	logger.info("daemon", "Signet Daemon starting");
	logger.info("daemon", `File logging to ${logger.logFilePath}`);
	logger.info("daemon", "Agents directory", { path: AGENTS_DIR });
	logger.info("daemon", "Network configured", { port: PORT, host: HOST, bindHost: BIND_HOST });

	// Acquire an exclusive lock to prevent multiple daemon instances from
	// competing for the SQLite write lock. Without this, a respawn (systemd,
	// launchd, or a script calling `signet daemon start`) starts a second
	// instance that fights the first for the DB lock, causing
	// "SQLiteError: database is locked" crashes on every write.
	const lock = acquireSingleInstanceLock(join(DAEMON_DIR, "daemon.lock"));
	if (lock === null) {
		logger.error("daemon", "Another daemon instance is already running or the lock is unavailable. Exiting.");
		process.exit(0);
	}
	process.on("exit", () => {
		releaseSingleInstanceLock(lock);
	});

	const previousLifecycle = readDaemonLifecycle(AGENTS_DIR);
	lifecycleStartedAt = new Date().toISOString();
	const previousExit = classifyPreviousDaemonExit(previousLifecycle, lifecycleStartedAt);
	let restartedHeartbeatPending = previousExit !== null && previousExit.classification !== "clean";
	writeDaemonLifecycle(AGENTS_DIR, buildLifecycleRecord("starting"));

	// Config migrations must precede every initialization path that resolves
	// memory config, including DB setup below.
	try {
		migrateConfig(AGENTS_DIR);
		migrateInferenceProviders(AGENTS_DIR);
		migrateLegacyRoutingToRegistry(AGENTS_DIR);
		migrateSessionSynthesisRoute(AGENTS_DIR);
		migrateRetiredExtractionWriterConfig(AGENTS_DIR);
		migrateEmbeddingBaseUrl(AGENTS_DIR);
		migrateRetiredMemoryPipelineRoutingV9(AGENTS_DIR);
	} catch (err) {
		logger.warn("config-migration", "Config migration failed; continuing startup", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
	// Compatibility migrations translate supported legacy configuration into the
	// canonical form. Resolve it again before opening the database so migration
	// output is subject to the same strict runtime validation.
	const startupMemoryConfig = loadMemoryConfig(AGENTS_DIR);
	// Apply the validated auth policy before binding the listener. Keeping this
	// on foreground startup closes the grace period in which middleware could
	// still hold the module's local-auth default while pipeline workers waited
	// to start.
	reloadAuthState(AGENTS_DIR);

	// Expensive schema/FTS initialization must execute in the killable owner
	// process, not merely behind an async function on this isolate.
	dbOwnerClient = createDbOwnerClient({ dbPath: MEMORY_DB, sqlitePath: sqliteRuntime.choice?.path });
	await dbOwnerClient.start();
	const owner = dbOwnerClient;

	// Read the retained migration verdict through a strictly read-only owner
	// query before any mutating database initialization can run. A confirmed
	// corrupt restart skips initialize() entirely and opens only a readonly
	// accessor for status and recovery guidance.
	const retainedMigrationBackupPath = pendingMigrationBackupPath(MEMORY_DB);
	let retainedMigrationCorrupt = false;
	let retainedMigrationStatus: string | null = null;
	let retainedMigrationReadFailed = false;
	if (retainedMigrationBackupPath !== null) {
		try {
			retainedMigrationStatus = await readRetainedMigrationVerifyStatus(
				owner,
				migrationVerifyCheckpointKey(retainedMigrationBackupPath),
				retainedMigrationBackupPath,
			);
			retainedMigrationCorrupt = retainedMigrationStatus === MIGRATION_VERIFY_FAILED_STATUS;
		} catch (error) {
			retainedMigrationReadFailed = true;
			logger.warn(
				"startup-recovery",
				"Could not read retained migration verification checkpoint before initialization; deferring mutating startup",
				{ error: error instanceof Error ? error.message : String(error) },
			);
		}
	}

	const initResult =
		retainedMigrationCorrupt || retainedMigrationReadFailed ? null : await owner.initialize(AGENTS_DIR);
	// The owner resolves sqlite-vec in its own process. Carry that path across
	// the protocol so the parent accessor loads the same extension; retained
	// paths still fall back to local discovery for older owner protocols.
	const initExtensionPath =
		initResult?.extensionPath ?? getVectorRuntimeStatus().extensionPath ?? findSqliteVecExtension() ?? "";
	const deferredMigrationVerification = initResult?.deferredMigrationVerification === true;
	if (retainedMigrationCorrupt) {
		armMigrationIntegrityWriteBlock();
		publishDatabaseIntegrityStatus("corrupt", ["global integrity verification previously failed"], owner);
		initDbAccessorReadOnly(MEMORY_DB, initExtensionPath ?? "", { agentsDir: AGENTS_DIR });
		logger.error(
			"startup-recovery",
			"Retained migration verification confirmed database corruption; startup writes disabled before initialization",
		);
	} else if (retainedMigrationReadFailed) {
		deferMigrationWriters();
		publishDatabaseIntegrityStatus("degraded", ["degraded:integrity-unverified"], owner);
		initDbAccessorReadOnly(MEMORY_DB, initExtensionPath ?? "", { agentsDir: AGENTS_DIR });
		logger.warn(
			"startup-recovery",
			"Retained migration verification could not be read; serving reads with writes blocked until verification recovers",
		);
	} else if (deferredMigrationVerification) {
		deferMigrationWriters();
		publishDatabaseIntegrityStatus(
			"degraded",
			["upgrade deferred pending prior-generation verification; restart completes it"],
			owner,
		);
		initDbAccessorReadOnly(MEMORY_DB, initExtensionPath ?? "", { agentsDir: AGENTS_DIR });
		logger.warn(
			"startup-recovery",
			"Prior-generation migration verification is still running; serving reads with writes blocked until restart",
		);
	} else {
		initDbAccessorLite(MEMORY_DB, initExtensionPath ?? "");
		releaseMigrationIntegrityWriteBlock();
		if (retainedMigrationStatus === MIGRATION_VERIFY_PARKED_STATUS || retainedMigrationReadFailed) {
			publishDatabaseIntegrityStatus(
				"degraded",
				retainedMigrationStatus === MIGRATION_VERIFY_PARKED_STATUS
					? ["degraded:integrity-unverified", "manual integrity verification is available"]
					: ["degraded:integrity-unverified"],
				owner,
			);
		}
	}
	const pendingVecBackfillFromInitialization = initResult?.pendingVecBackfill === true;

	setSessionClaimStore(createSessionClaimStore(getDbAccessor()));
	if (!migrationIntegrityWritesBlocked) {
		startSessionCleanup();
		// Formal TTL lifecycle (#902): when stale-session cleanup evicts a claim
		// whose harness never sent session-end, checkpoint the residual continuity
		// state and mark the retained transcript complete instead of silently
		// dropping the in-memory lifecycle state.
		setSessionEvictionHandler(
			createTtlEvictionHandler({
				accessor: getDbAccessor(),
				maxCheckpointsPerSession: loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity.maxCheckpointsPerSession,
			}),
		);
		const restoredSessions = await restorePersistedSessionsAsync();
		if (restoredSessions.active > 0 || restoredSessions.expired > 0 || restoredSessions.ended > 0) {
			logger.info("session-tracker", "Restored durable session lifecycle state", restoredSessions);
		}
	} else {
		logger.warn("startup-recovery", "Skipping session restoration and cleanup because database writes are fail-closed");
	}
	logFdSnapshot("post-db-init");
	startEventLoopMonitor();
	startFdPollMonitor();

	dbOwnerMaintenanceHandle = createDbOwnerMaintenance({ dbPath: MEMORY_DB, owner: dbOwnerClient });
	registerDbOwnerMaintenance(dbOwnerMaintenanceHandle);
	// Clean accumulated crash-loop damage through the owner. This remains a
	// deferred call, so owner startup and the bounded drain never delay readiness.
	if (!migrationIntegrityWritesBlocked) runStartupRecovery(getDbAccessor(), { owner: dbOwnerClient });

	// Source-deletion cleanup runs in the post-ready deferred lane below. Do not
	// put it before binding the HTTP server: its lifecycle-state delete uses the
	// bounded async writer and must not make readiness depend on that queue.

	const { extensionPath } = getVectorRuntimeStatus();
	const bundled = join(__dirname, "synthesis-render-worker.js");
	const workerPath = existsSync(bundled)
		? bundled
		: (resolveEmbeddedWorkerPath("synthesis-render-worker") ?? join(__dirname, "synthesis-render-worker.ts"));
	let synthWorker: Worker | null = null;
	if (!migrationIntegrityWritesBlocked) {
		try {
			synthWorker = new Worker(workerPath);
		} catch (err) {
			logger.warn(
				"daemon",
				"synthesis worker creation failed — using sync rendering",
				err instanceof Error ? err : undefined,
			);
		}
	} else {
		logger.warn("startup-recovery", "Skipping synthesis worker initialization because database writes are fail-closed");
	}
	let synthWorkerReady = false;
	if (synthWorker) {
		const w = synthWorker;
		w.postMessage({ type: "init", dbPath: MEMORY_DB, vecExtensionPath: extensionPath ?? "" });
		await new Promise<void>((res, rej) => {
			const timer = setTimeout(() => {
				rej(new Error("synthesis worker init timeout"));
			}, 10_000);
			// Attach error/exit handlers during init to prevent unhandled
			// 'error' events from crashing the main thread (EventEmitter
			// convention: unhandled 'error' re-throws in the listener context).
			const onErr = (err: unknown): void => {
				clearTimeout(timer);
				rej(err instanceof Error ? err : new Error(String(err)));
			};
			const onExit = (code: number): void => {
				clearTimeout(timer);
				rej(new Error(`worker exited during init (code=${code})`));
			};
			w.on("error", onErr);
			w.on("exit", onExit);
			w.once("message", (msg: unknown) => {
				clearTimeout(timer);
				w.removeListener("error", onErr);
				w.removeListener("exit", onExit);
				if (isReadyResponse(msg)) {
					synthWorkerReady = true;
					res();
				} else {
					rej(new Error("unexpected init response"));
				}
			});
		}).catch((err) => {
			logger.warn("daemon", "synthesis worker failed", err instanceof Error ? err : undefined);
			w.terminate().catch((e) => {
				logger.debug("daemon", "synthesis worker terminate failed", {
					error: e instanceof Error ? e.message : String(e),
				});
			});
		});
	}
	if (synthWorker && synthWorkerReady) {
		setSynthesisRenderWorker(synthWorker);
		synthWorker.on("error", (err) => {
			logger.error("daemon", "synthesis worker error", err);
			setSynthesisRenderWorker(null);
		});
		synthWorker.on("exit", (code) => {
			logger.warn("daemon", `synthesis worker exited with code ${code}`);
			setSynthesisRenderWorker(null);
		});
	}

	if (!migrationIntegrityWritesBlocked) await syncAgentRoster(AGENTS_DIR);
	else logger.warn("startup-recovery", "Skipping agent roster sync because database writes are fail-closed");

	invalidateTraversalCache();

	writeFileSync(PID_FILE, process.pid.toString());
	logger.info("daemon", "Process ID", { pid: process.pid });

	if (ensureWorkspaceGitignore()) {
		scheduleAutoCommit(join(AGENTS_DIR, ".gitignore"));
	}

	startFileWatcher();
	logger.info("watcher", "File watcher started");
	logFdSnapshot("post-watcher");

	await ensureArchitectureDoc();

	const memoryCfg = startupMemoryConfig;
	let telemetryCollector: TelemetryCollector | undefined;
	if (!migrationIntegrityWritesBlocked && memoryCfg.pipelineV2.telemetryEnabled && !telemetryDisabledByEnv()) {
		const posthogApiKey = memoryCfg.pipelineV2.telemetry.posthogApiKey;
		const resolvedTelemetryCfg = {
			...memoryCfg.pipelineV2.telemetry,
			posthogApiKey,
		};
		telemetryCollector = createTelemetryCollector(getDbAccessor(), resolvedTelemetryCfg, CURRENT_VERSION, {
			telemetryLogPath: defaultTelemetryLogPath(AGENTS_DIR),
			configSnapshot: buildTelemetryConfigSnapshot(AGENTS_DIR, memoryCfg),
			owner: daemonDbOwner(),
			dbPath: MEMORY_DB,
		});
		telemetryCollector.start();
		telemetryRef = telemetryCollector;
		setTelemetryRef(telemetryCollector);
		setActiveTelemetry(telemetryCollector);

		if (previousExit !== null) {
			telemetryCollector.record("daemon.previous_exit", previousExitTelemetryProperties(previousExit));
		}

		// Lifecycle event (issue #1026 Phase 2): version + platform only.
		telemetryCollector.record("daemon.started", {
			version: CURRENT_VERSION,
			platform: process.platform,
			uptimeMs: 0,
		});
		// A daemon restart turns any still-running pass into a failed pass. Wait
		// for the bounded drain to finish before emitting telemetry. The immediate
		// compatibility report is deliberately marked "draining" and has no final
		// orphan count yet.
		void getStartupRecoveryCompletion().then((recovery) => {
			if (recovery.recoveryPhase !== "complete") return;
			for (let index = 0; index < Math.min(recovery.orphanedPassesSwept, 100); index++) {
				recordDreamingPassTelemetry({
					mode: "startup-recovery",
					outcome: "failed",
					outcomeCode: "error",
					effects: {
						artifactsConsidered: 0,
						memoriesCreated: 0,
						memoriesUpdated: 0,
						memoriesSuperseded: 0,
						memoriesRetired: 0,
						claimsChanged: 0,
						relationshipsChanged: 0,
						provenanceLinksChanged: 0,
						toolCalls: 0,
						durationMs: recovery.durationMs,
					},
					usage: null,
				});
			}
		});
		for (const source of loadSourcesConfig(AGENTS_DIR).sources) {
			if (source.enabled) {
				// Server readiness must not wait on best-effort telemetry, but shutdown must drain it.
				void trackSourceLifecycleWrite(recordSourceConnected(source, resolveDaemonAgentId()));
			}
		}

		const daemonStartTime = Date.now();
		heartbeatTimer = setInterval(
			() => {
				void (async () => {
					if (!telemetryRef) return;
					try {
						const liveCfg = loadMemoryConfig(AGENTS_DIR);
						const owner = daemonDbOwner();
						const [memoryRow, connectors, queue] = await Promise.all([
							dbOwnerQuery<{ readonly cnt?: number } | null>(
								ownerStatement(
									"SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 0 OR is_deleted IS NULL",
									[],
									"get",
								),
								{ operation: "heartbeat.memory-count", lane: "read", deadlineMs: 5_000 },
							),
							dbOwnerQuery<readonly { readonly status: string }[]>(
								ownerStatement("SELECT * FROM connectors ORDER BY created_at DESC", [], "all"),
								{ operation: "heartbeat.list-connectors", lane: "read", deadlineMs: 5_000 },
							),
							ownerQueuePressureSnapshot(owner),
						]);
						const memoryCount = memoryRow?.cnt ?? 0;
						let runtimePressure: ReturnType<typeof buildRuntimePressureEnvelope> | undefined;
						let resourceTelemetry: ReturnType<typeof buildResourceUtilizationTelemetry> | undefined;
						try {
							const workers = getPipelineWorkerStatus();
							const resources = getResourceSnapshot();
							resourceTelemetry = buildResourceUtilizationTelemetry(
								resources,
								getSystemPressure(),
								dreamingWorkerHandle?.running === true,
							);
							const recoveryOutcome: PressureRecoveryOutcome = restartedHeartbeatPending
								? "restarted"
								: getPressureRecoveryOutcome();
							runtimePressure = buildRuntimePressureEnvelope({
								memoryQueueDepth: queue.memoryQueueDepth,
								summaryQueueDepth: queue.summaryQueueDepth,
								oldestJobAgeSec: queue.oldestJobAgeSec,
								activeWorkers: countActiveWorkers(
									[
										workers.summary.running,
										workers.document.running,
										workers.retention.running,
										workers.maintenance.running,
										workers.synthesis.running,
										workers.hints.running,
										workers.dreaming.running,
									],
									workers.llmConcurrency.concurrency.running,
								),
								batchSize: liveCfg.pipelineV2.embeddingTracker.batchSize,
								memoryRssMb: resources.rss,
								cpuPercent: resources.cpuPercent,
								recoveryOutcome,
							});
							setRuntimePressureEnvelope(runtimePressure);
						} catch {
							// Pressure context is best-effort; a slow or unavailable subsystem must never suppress liveness.
						}
						telemetryRef?.record("daemon.heartbeat", {
							uptimeMs: Date.now() - daemonStartTime,
							version: CURRENT_VERSION,
							platform: process.platform,
							memoryCount,
							connectorsActive: countConnectorsActive(connectors),
							pipelineMode: readPipelineMode(liveCfg.pipelineV2),
							extractionProvider: providerRuntimeResolution.extraction.effective,
							embeddingProvider: liveCfg.embedding.provider,
							...(runtimePressure ?? {}),
							...(resourceTelemetry ?? {}),
						});
						if (runtimePressure?.recoveryOutcome === "restarted") restartedHeartbeatPending = false;
					} catch {
						// Database pressure is diagnostic only; preserve the heartbeat if the owner is unavailable.
					}
				})();
			},
			5 * 60 * 1000,
		);
		setHeartbeatTimer(heartbeatTimer);
	}

	const deferredRuntimeGate = createDeferredRuntimeGate();
	const deferredRuntimeScheduler = createDeferredRuntimeScheduler({
		gate: deferredRuntimeGate,
		schedule: (callback, delayMs) => setTimeout(callback, delayMs),
		onPipelineError: (error): void => {
			logger.error("daemon", "Deferred pipeline runtime startup failed", undefined, {
				error: error instanceof Error ? error.message : String(error),
			});
		},
		onMaintenanceError: (error): void => {
			logger.warn("daemon", "Deferred FTS startup maintenance failed", {
				error: error instanceof Error ? error.message : String(error),
				cause: "fts_index_incomplete",
			});
		},
		onIntegrityFailure: (error): void => {
			logger.error("startup-recovery", "Deferred integrity maintenance rejected", undefined, {
				error: error instanceof Error ? error.message : String(error),
			});
			publishDatabaseIntegrityStatus("degraded", ["degraded:integrity-callback-rejected"], dbOwnerClient ?? undefined);
		},
		completeIntegrityOnCallback: false,
	});

	let daemonPendingVecBackfill = pendingVecBackfillFromInitialization;
	let vecBackfillScheduled = false;
	const probePendingVecBackfill = async (): Promise<boolean> => {
		if (migrationIntegrityWritesBlocked) return false;
		const activeEmbedding = await resolveActiveEmbeddingConfigThroughOwner(
			daemonDbOwner(),
			memoryCfg.embedding,
			"maintenance.vec-backfill-config",
		);
		return await ownerHasPendingVecBackfill(owner, activeEmbedding.dimensions);
	};
	const probePendingVecBackfillWithRetry = async (): Promise<boolean> => {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (migrationIntegrityWritesBlocked) return false;
			try {
				return await probePendingVecBackfill();
			} catch (error) {
				logger.warn("startup-recovery", "Vector backfill probe failed", {
					attempt: attempt + 1,
					error: error instanceof Error ? error.message : String(error),
				});
				if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			}
		}
		logger.error("startup-recovery", "Vector backfill probe gave up after one retry");
		return false;
	};
	const schedulePendingVecBackfill = (): void => {
		if (migrationIntegrityWritesBlocked || vecBackfillScheduled) return;
		void probePendingVecBackfillWithRetry()
			.then((pending) => {
				daemonPendingVecBackfill = pending;
				if (!pending || migrationIntegrityWritesBlocked) return;
				vecBackfillScheduled = true;
				deferredRuntimeScheduler.scheduleMaintenance(async (): Promise<void> => {
					let budgetExpired = false;
					try {
						const activeEmbedding = await resolveActiveEmbeddingConfigThroughOwner(
							daemonDbOwner(),
							memoryCfg.embedding,
							"maintenance.vec-backfill-config",
						);
						if (migrationIntegrityWritesBlocked) return;
						if (!isVectorRuntimeUsable()) {
							logger.warn("startup-recovery", "Skipping vector backfill slice because sqlite-vec is unavailable");
							return;
						}
						const deadlineAt = Date.now() + VEC_EMBEDDING_POST_READY_BUDGET_MS;
						for (;;) {
							if (migrationIntegrityWritesBlocked) return;
							if (Date.now() >= deadlineAt) {
								budgetExpired = true;
								return;
							}
							const remainingMs = Math.max(1, Math.floor(deadlineAt - Date.now()));
							if (remainingMs <= 5_000) {
								budgetExpired = true;
								return;
							}
							const vectorBackfillOwner = dbOwnerClient;
							if (vectorBackfillOwner === null) return;
							const backfill = vectorBackfillOwner.submit<{ readonly completed: boolean }>(
								{
									kind: "vector_backfill",
									expectedDimensions: activeEmbedding.dimensions,
									maxBatches: 1,
									batchSize: 500,
								},
								{
									operation: "maintenance.vec-backfill",
									lane: "maintenance",
									deadlineMs: remainingMs,
									estimatedWorkUnits: 1,
								},
							);
							await vectorBackfillOwner.awaitResult(backfill, remainingMs);
							// Yield after every bounded owner batch so health and ready can run
							// between slices without this isolate executing SQLite writes.
							await new Promise<void>((resolve) => setImmediate(resolve));
							if (!(await probePendingVecBackfillWithRetry())) return;
						}
					} finally {
						vecBackfillScheduled = false;
						if (budgetExpired && !migrationIntegrityWritesBlocked) {
							// Probe after the bounded slice and give the serialized
							// maintenance scheduler a short breather before arming the
							// next slice. Errors are handled by the bounded probe retry.
							const timer = setTimeout(() => schedulePendingVecBackfill(), 100);
							timer.unref?.();
						}
					}
				});
			})
			.catch((error: unknown) => {
				logger.error("startup-recovery", "Vector backfill probe unexpectedly rejected", undefined, {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	};
	// The owner initialization result seeds daemon knowledge, while this probe
	// remains authoritative so restarts and cross-process drift cannot strand a
	// pending backfill behind the owner boundary.
	if (daemonPendingVecBackfill) schedulePendingVecBackfill();
	else
		void probePendingVecBackfillWithRetry()
			.then((pending) => {
				if (pending) schedulePendingVecBackfill();
			})
			.catch((error: unknown) => {
				logger.error("startup-recovery", "Vector backfill probe unexpectedly rejected", undefined, {
					error: error instanceof Error ? error.message : String(error),
				});
			});

	// Grace period: defer all background workers for 10s after startup so the
	// event-loop monitor can calibrate and migrations can settle before any
	// background write work piles on (#1059 thundering-herd prevention).
	const startPostReadyRuntime = async (): Promise<void> => {
		await deferredRuntimeGate.waitForIntegrity();
		if (migrationIntegrityWritesBlocked) {
			logger.warn("startup-recovery", "Skipping post-ready runtime startup because database writes are fail-closed");
			return;
		}
		reportStartupGrace();
		await startPipelineRuntime(memoryCfg, telemetryCollector);
		logFdSnapshot("post-pipeline");

		initCheckpointFlush(getDbAccessor());

		if (!transcriptCaptureWorkerHandle) {
			transcriptCaptureWorkerHandle = await startTranscriptCaptureWorker(getDbAccessor(), AGENTS_DIR);
		}
		if (!transcriptRecoveryWorkerHandle) {
			transcriptRecoveryWorkerHandle = startTranscriptRecoveryWorker(
				getDbAccessor(),
				AGENTS_DIR,
				resolveDaemonAgentId(),
			);
		}
		if (!transcriptImportWorkerHandle) {
			transcriptImportWorkerHandle = startTranscriptImportWorker({
				store: createOwnerTranscriptImportStore(),
				agentId: resolveDaemonAgentId(),
				workspaceRoot: AGENTS_DIR,
				onBatch: async (_jobId, sourceId) => {
					const agentId = resolveDaemonAgentId();
					const subjectRef = `source:${sourceId}`;
					const details = JSON.stringify({ sourceId, reason: "transcript-import-committed" });
					await dbOwnerTransaction(
						[
							{
								sql: `INSERT INTO dreaming_attention
									(id, agent_id, kind, subject_ref, details_json, priority)
									VALUES (?, ?, 'evidence_requeue', ?, ?, 50)
									ON CONFLICT(agent_id, kind, subject_ref) DO UPDATE SET
									  details_json = excluded.details_json,
									  priority = MAX(dreaming_attention.priority, excluded.priority),
									  generation = dreaming_attention.generation + 1,
									  resolved_at = NULL,
									  resolved_by_pass_id = NULL`,
								params: [randomUUID(), agentId, subjectRef, details],
								result: "run",
							},
						],
						{ operation: "sources.import.dreaming-attention", lane: "write" },
					);
				},
			});
		}

		checkpointPruneTimer = setInterval(() => {
			try {
				const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
				if (cfg.enabled) {
					void pruneCheckpointsAsync(getDbAccessor(), cfg.retentionDays).catch((err: unknown) => {
						logger.warn("daemon", "Checkpoint pruning failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			} catch (err) {
				logger.warn("daemon", "Checkpoint pruning failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}, 3600_000);
		setCheckpointPruneTimer(checkpointPruneTimer);

		startGitSyncTimer();
		initUpdateSystem(
			CURRENT_VERSION,
			AGENTS_DIR,
			(preferredExecutablePath) => {
				if (resolveDaemonRestartMode() === "service-manager") {
					logger.info("daemon", "Update installed; releasing lock for launchd KeepAlive restart");
					setTimeout(() => {
						requestShutdown("update:launchd-restart", 0, undefined, false);
					}, 500);
					return;
				}

				const daemonScript = process.argv[1] ?? "";
				if (!daemonScript) {
					logger.warn("daemon", "Cannot self-restart: process.argv[1] is empty, falling back to clean exit");
					setTimeout(() => {
						requestShutdown("update:no-self-restart", 0, undefined, false);
					}, 500);
					return;
				}

				logger.info("daemon", "Spawning replacement daemon process", {
					execPath: preferredExecutablePath ?? process.execPath,
					script: daemonScript,
				});

				const replacement = spawn(preferredExecutablePath ?? process.execPath, [daemonScript], {
					detached: true,
					stdio: "ignore",
					windowsHide: true,
					env: {
						...process.env,
						SIGNET_PORT: String(PORT),
						SIGNET_HOST: HOST,
						SIGNET_BIND: BIND_HOST,
						SIGNET_PATH: AGENTS_DIR,
						SIGNET_DAEMON_ENTRYPOINT: "1",
					},
				});
				replacement.unref();

				logger.info("daemon", "Replacement daemon spawned, exiting current process");
				setTimeout(() => {
					requestShutdown("update:replacement-spawned", 0, undefined, false);
				}, 500);
			},
			{
				logger,
				onUpgraded: (from, to) => telemetryRef?.record("version.upgraded", { from, to }),
			},
		);
		initFeatureFlags(AGENTS_DIR);
		startUpdateTimer();
	};
	deferredRuntimeScheduler.schedulePipeline(startPostReadyRuntime);
	// Cleanup is retryable maintenance. It must not hold up pipeline startup if
	// the async writer is blocked or unavailable.
	if (!migrationIntegrityWritesBlocked) {
		deferredRuntimeScheduler.scheduleMaintenance(async (): Promise<void> => {
			try {
				await cleanupSourceDeletionTombstones(AGENTS_DIR);
			} catch (error) {
				logger.error(
					"daemon",
					"Deferred source-deletion tombstone cleanup failed; retry remains available",
					undefined,
					{
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		});
	}

	const { createServer: nodeCreateServer } = await import("node:http");

	const BIND_MAX_DELAY_MS = 30_000;
	const BIND_RETRY_BASE_MS = 1000;
	// SQLite's global quick_check is one opaque native operation. Integrity
	// maintenance therefore advances one table at a time and checkpoints after
	// every owner job instead of monopolizing the post-ready owner lane.
	const INCREMENTAL_INTEGRITY_TABLES_PER_RUN = 8;
	const INCREMENTAL_INTEGRITY_RUN_BUDGET_MS = 5_000;
	const INCREMENTAL_INTEGRITY_OWNER_DEADLINE_MS = 1_000;

	const onListening = (info: { address: string; port: number }): void => {
		logger.info("daemon", "Server listening", {
			address: info.address,
			port: info.port,
		});
		logger.info("daemon", "Daemon ready");
		if (!migrationIntegrityWritesBlocked) {
			deferredRuntimeScheduler.scheduleMaintenance(async (): Promise<void> => {
				const maintenance = dbOwnerMaintenanceHandle;
				if (maintenance === null) throw new Error("DB owner maintenance is unavailable for FTS startup recovery");
				const result = await completeFtsStartupRecovery({
					backfill: maintenance.backfillFts,
					backfillOptions: { checkpointKey: "fts.memories.startup" },
					scheduleContinuation: (callback): void => {
						const timer = setTimeout(callback, 0);
						timer.unref?.();
					},
				});
				logger.info("daemon", "FTS startup maintenance finished", { ...result });
			});
		}
		let retainedCorruptMaintenanceLogged = false;
		deferredRuntimeScheduler.scheduleIntegrity(async (): Promise<void> => {
			if (retainedMigrationCorrupt) {
				if (!retainedCorruptMaintenanceLogged) {
					retainedCorruptMaintenanceLogged = true;
					logger.warn(
						"startup-recovery",
						"Skipping all mutating post-ready maintenance because database corruption is retained",
					);
				}
				deferredRuntimeGate.completeIntegrity();
				return;
			}
			logFdSnapshot("server-ready");
			writeDaemonLifecycle(AGENTS_DIR, buildLifecycleRecord("running"));
			const owner = dbOwnerClient;
			const migrationBackupPath = pendingMigrationBackupPath(MEMORY_DB);
			let currentDatabaseSizeBytes = 0;
			try {
				currentDatabaseSizeBytes = (await statAsync(MEMORY_DB)).size;
			} catch (error) {
				logger.warn("startup-recovery", "Could not stat current database for integrity budget", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			const migrationBackupPending = migrationBackupPath !== null;
			if (owner === null) throw new Error("DB owner is unavailable for incremental integrity maintenance");
			const startVacuumConversion = (): void => {
				if (vacuumConversionHandle !== null) return;
				vacuumConversionHandle = startVacuumConversionWorker(getDbAccessor(), { owner });
			};
			if (!migrationBackupPending) startVacuumConversion();

			// ── Migration backup prune gate ──────────────────────────────────
			// Global `PRAGMA integrity_check` is the ONLY result that may delete
			// the rollback backup. Each completed backup generation gets its own
			// checkpoint key, so a parked or failed prior generation cannot suppress
			// verification of this generation.
			let integritySliceTimer: ReturnType<typeof setTimeout> | null = null;
			let integritySlicePending = false;
			let migrationIntegrityGateActive = false;
			let integrityGateCompleted = false;
			let migrationWritersAllowed = Promise.resolve(true);
			let runIntegritySlice: () => Promise<void>;
			const scheduleIntegritySlice = (delayMs: number): void => {
				if (retainedMigrationCorrupt) {
					if (!retainedCorruptMaintenanceLogged) {
						retainedCorruptMaintenanceLogged = true;
						logger.warn(
							"startup-recovery",
							"Skipping incremental integrity maintenance because database corruption is retained",
						);
					}
					return;
				}
				integritySlicePending = true;
				if (globalVerifyInFlight || integritySliceTimer !== null) return;
				integritySliceTimer = setTimeout(() => {
					integritySliceTimer = null;
					if (globalVerifyInFlight) return;
					integritySlicePending = false;
					void runIntegritySlice().catch((error) => {
						logger.error("startup-recovery", "Incremental database integrity continuation rejected", error);
					});
				}, delayMs);
				integritySliceTimer.unref?.();
			};
			let scheduledVerifyRuntimeGateReleased = false;
			const publishMigrationVerifyStatus = (
				state: "healthy" | "corrupt" | "degraded",
				messages?: readonly string[],
			): void => {
				// The terminal callback is intentionally injected into the gate so
				// `if (state === "corrupt") armMigrationIntegrityWriteBlock();` runs
				// only after the checkpoint and sidecar have been attempted.
				publishDatabaseIntegrityStatus(state, messages, owner);
				if (state === "degraded" && !scheduledVerifyRuntimeGateReleased) {
					scheduledVerifyRuntimeGateReleased = true;
					deferredRuntimeGate.completeIntegrity();
				}
			};
			if (migrationBackupPending && migrationBackupPath !== null) {
				migrationIntegrityGateActive = true;
				let migrationCheckpoint: Awaited<ReturnType<typeof readMigrationVerifyCheckpoint>> = {
					attemptCount: 0,
					status: "running",
				};
				try {
					migrationCheckpoint = await readMigrationVerifyCheckpoint(
						owner,
						migrationVerifyCheckpointKey(migrationBackupPath),
						5_000,
					);
				} catch (error) {
					logger.error(
						"startup-recovery",
						"Migration verification checkpoint read failed; retrying verification",
						error instanceof Error ? error : undefined,
					);
					publishMigrationVerifyStatus("degraded", ["degraded:integrity-unverified"]);
				}
				const retainedTerminalCheckpoint =
					migrationCheckpoint.status === MIGRATION_VERIFY_FAILED_STATUS ||
					migrationCheckpoint.status === MIGRATION_VERIFY_PARKED_STATUS;
				let resolveMigrationWriters: ((allowed: boolean) => void) | undefined;
				if (retainedTerminalCheckpoint) {
					migrationWritersAllowed = new Promise<boolean>((resolve) => {
						resolveMigrationWriters = resolve;
					});
				}
				let runMigrationVerifyGate: () => Promise<Awaited<ReturnType<typeof runMigrationIntegrityVerifyGate>>>;
				const releaseVerifyLatch = (): void => {
					if (!globalVerifyInFlight) return;
					globalVerifyInFlight = false;
					if (integritySlicePending) scheduleIntegritySlice(0);
				};
				const migrationVerifyGateOptions: Parameters<typeof runMigrationIntegrityVerifyGate>[0] = {
					owner,
					backupPath: migrationBackupPath,
					databaseSizeBytes: currentDatabaseSizeBytes,
					pruneBackup: () => pruneMigrationBackupsAfterIntegrity(MEMORY_DB, undefined, migrationBackupPath),
					publishStatus: publishMigrationVerifyStatus,
					armWriteBlock: armMigrationIntegrityWriteBlock,
					resetGlobalLatch: resetGlobalIntegrityLatch,
					onProgress: (progress): void => {
						logger.info("startup-recovery", "Migration integrity verify attempt", { ...progress });
					},
					continuation: () => runMigrationVerifyGate(),
					log: (message, details): void => {
						logger.info("startup-recovery", message, details);
					},
					onContinuationRejection: (callback, error): void => setupRetry.handleRejection(callback, error),
				};
				runMigrationVerifyGate = async (): Promise<Awaited<ReturnType<typeof runMigrationIntegrityVerifyGate>>> => {
					globalVerifyInFlight = true;
					let resolveWorker: () => void = () => {};
					let workerSettledResolved = false;
					const settleWorker = (): void => {
						if (workerSettledResolved) return;
						workerSettledResolved = true;
						resolveWorker();
					};
					const workerSettled = new Promise<void>((resolve) => {
						resolveWorker = resolve;
					});
					try {
						const result = await runMigrationIntegrityVerifyGate({
							...migrationVerifyGateOptions,
							// Do not let the 30-minute continuation race a deadline-abandoned
							// worker. Scheduling after settlement makes the global latch a true
							// single-flight guard even when an old worker settles late.
							scheduleNextAttempt: (callback, delayMs): void => {
								void workerSettled.then(() => {
									const timer = setTimeout(callback, delayMs);
									timer.unref?.();
								});
							},
							onWorkerSettled: settleWorker,
							onAdmissionFailure: () => {
								settleWorker();
								// No owner job exists to settle after a synchronous admission
								// rejection, so the integrity lane can be released now.
								releaseVerifyLatch();
							},
						});
						if (result.phase === "pass") {
							/* if (result.phase === "pass") {
							startVacuumConversion(); */
							if (deferredMigrationVerification) {
								logger.info(
									"startup-recovery",
									"Prior-generation verification passed; scheduling graceful restart before admitting migration",
								);
								setTimeout(() => {
									requestShutdown("migration-verify-complete-restart", 0, undefined, false);
								}, 0);
							} else {
								startVacuumConversion();
							}
						} else if (result.phase === "parked" || result.phase === "failed" || result.phase === "terminal") {
							logger.warn("startup-recovery", "Migration verification retained the rollback backup; VACUUM deferred", {
								phase: result.phase,
							});
						}
						if (resolveMigrationWriters !== undefined) {
							const allowed =
								result.phase !== "failed" &&
								!(result.phase === "terminal" && migrationCheckpoint.status === MIGRATION_VERIFY_FAILED_STATUS);
							resolveMigrationWriters(allowed);
							resolveMigrationWriters = undefined;
						}
						if (result.phase === "incomplete" && result.admitted) void workerSettled.then(releaseVerifyLatch);
						else releaseVerifyLatch();
						return result;
					} catch (error) {
						releaseVerifyLatch();
						throw error;
					}
				};
				let setupRetry: ReturnType<typeof createMigrationVerifySetupRetry>;
				setupRetry = createMigrationVerifySetupRetry({
					run: runMigrationVerifyGate,
					publishStatus: publishMigrationVerifyStatus,
					logWarn: (message, details): void => logger.warn("startup-recovery", message, details),
					logError: (message, error, details): void => logger.error("startup-recovery", message, error, details),
				});
				setupRetry.run();
			}

			runIntegritySlice = async (): Promise<void> => {
				if (retainedMigrationCorrupt) {
					if (!retainedCorruptMaintenanceLogged) {
						retainedCorruptMaintenanceLogged = true;
						logger.warn(
							"startup-recovery",
							"Skipping incremental integrity maintenance because database corruption is retained",
						);
					}
					integritySlicePending = false;
					return;
				}
				if (globalVerifyInFlight) {
					integritySlicePending = true;
					return;
				}
				const result = await runIncrementalDatabaseIntegrityCheck({
					owner,
					checkpointKey: "database.quick-check",
					tablesPerRun: INCREMENTAL_INTEGRITY_TABLES_PER_RUN,
					runBudgetMs: INCREMENTAL_INTEGRITY_RUN_BUDGET_MS,
					ownerDeadlineMs: INCREMENTAL_INTEGRITY_OWNER_DEADLINE_MS,
					onProgress: (progress): void => {
						logger.info("startup-recovery", "Incremental database integrity progress", { ...progress });
					},
				});
				logger.info("startup-recovery", "Incremental database integrity slice complete", { ...result });
				if (result.phase === "unavailable" || result.failedObjects > 0) {
					logger.error("startup-recovery", "Incremental database integrity found a problem", undefined, {
						phase: result.phase,
						errors: result.errors,
						lastObject: result.lastObject,
					});
				}
				if (result.phase === "running" || result.phase === "timed_out" || result.phase === "unavailable") {
					scheduleIntegritySlice(result.phase === "running" ? 0 : 1000);
				}
				if (!migrationIntegrityGateActive && !integrityGateCompleted) {
					integrityGateCompleted = true;
					deferredRuntimeGate.completeIntegrity();
				}
			};
			scheduleIntegritySlice(0);
			if (owner.health().state === "failed") {
				logger.error("startup-recovery", "DB owner failed during incremental integrity maintenance", undefined, {
					ownerState: owner.health().state,
				});
			}

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

			const writersAllowed = await migrationWritersAllowed;
			if (!writersAllowed) {
				logger.error(
					"startup-recovery",
					"Skipping startup DB writers because migration verification confirmed corruption",
					undefined,
					{
						checkpointStatus: MIGRATION_VERIFY_FAILED_STATUS,
					},
				);
				return;
			}
			importExistingMemoryFiles().catch((e) => {
				const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
				logger.error("daemon", "Failed to import existing memory files", undefined, errDetails);
			});
			startMemoryImportPoller();
			startStaleSessionSweeper();
			startAcpDeliveryReconciliation();

			setTimeout(() => {
				if (!nativeMemoryBridge) {
					const startupSourceJobs = new Map<string, string>();
					for (const source of loadSourcesConfig(AGENTS_DIR).sources) {
						if (!source.enabled || source.kind !== "obsidian") continue;
						// Startup indexing is asynchronous; keep its lifecycle write in the shutdown drain.
						void trackSourceLifecycleWrite(recordSourceConnected(source, resolveDaemonAgentId()));
						const job = beginSourceIndexJob(source.id, "source-startup");
						startupSourceJobs.set(source.id, job.id);
						markSourceIndexInFlight(source.id);
						markSourceIndexJobRunning(source.id, job.id);
					}
					nativeMemoryBridge = startNativeMemoryBridge(configuredNativeMemorySources(AGENTS_DIR), {
						agentsDir: AGENTS_DIR,
						includeConfiguredSources: true,
						pollIntervalMs: 10_000,
						sourceCleanupEnabled: true,
						shouldCleanupSource: (source) => source.harness !== "obsidian",
						sourceGraphEnabled: true,
						workerOwnedIndexing: true,
						...resolveEmbeddingBridgeOptions(memoryCfg.embedding, fetchEmbedding),
						onFileIndexed: (event) => {
							const sourceId = event.source.sourceId;
							if (!sourceId) return;
							const jobId = startupSourceJobs.get(sourceId);
							if (!jobId) return;
							updateSourceIndexJobProgress(sourceId, jobId, {
								scanned: event.scanned,
								total: event.total,
								indexed: event.changed,
								currentPath: event.filePath,
								statusMessage: event.status,
							});
						},
					});
					nativeMemoryBridge
						.syncExisting()
						.then(() => {
							const syncResult = nativeMemoryBridge?.getLastSyncResult?.();
							for (const [sourceId, jobId] of startupSourceJobs) {
								const paused = syncResult?.pausedSources.find((result) => result.sourceId === sourceId);
								if (syncResult?.status === "paused" && paused) {
									pauseSourceIndexJob(sourceId, jobId, {
										pauseReason: paused.pauseReason ?? "provider_unavailable",
										resumeFrontier: paused.resumeFrontier,
										scanned: paused.scanned,
										indexed: paused.indexed,
									});
								} else {
									completeSourceIndexJobFromProgress(sourceId, jobId);
								}
								const source = loadSourcesConfig(AGENTS_DIR).sources.find((entry) => entry.id === sourceId);
								const job = getSourceIndexJob(sourceId);
								if (source) {
									// Index completion is intentionally fire-and-forget, but tracked until shutdown.
									void trackSourceLifecycleWrite(
										recordSourceIndexOperation({
											source,
											agentId: resolveDaemonAgentId(),
											discovered: job?.scanned ?? 0,
											accepted: job?.indexed ?? 0,
											durationMs:
												job?.startedAt && job.finishedAt
													? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt))
													: 0,
											outcome: syncResult?.status === "paused" && paused ? "partial" : "success",
											failureClass:
												syncResult?.status === "paused" && paused
													? sourceFailureClass(new Error("network provider unavailable"))
													: undefined,
											updateFreshness: syncResult?.status === "paused" && paused ? false : undefined,
											searchable: syncResult?.status === "paused" && paused ? (job?.indexed ?? 0) > 0 : undefined,
										}),
									);
								}
							}
						})
						.catch((e) => {
							for (const [sourceId, jobId] of startupSourceJobs) {
								const source = loadSourcesConfig(AGENTS_DIR).sources.find((entry) => entry.id === sourceId);
								const job = getSourceIndexJob(sourceId);
								if (source) {
									// Failed indexing follows the same tracked best-effort shutdown path.
									void trackSourceLifecycleWrite(
										recordSourceIndexOperation({
											source,
											agentId: resolveDaemonAgentId(),
											discovered: job?.scanned ?? 0,
											accepted: job?.indexed ?? 0,
											failed: 1,
											durationMs: job?.startedAt ? Math.max(0, Date.now() - Date.parse(job.startedAt)) : 0,
											outcome: (job?.indexed ?? 0) > 0 ? "partial" : "failed",
											failureClass: sourceFailureClass(e),
											searchable: (job?.indexed ?? 0) > 0,
										}),
									);
								}
								failSourceIndexJob(sourceId, jobId, e);
							}
							const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
							logger.error("daemon", "Failed to sync native memory sources", undefined, errDetails);
						})
						.finally(() => {
							for (const sourceId of startupSourceJobs.keys()) clearSourceIndexInFlight(sourceId);
						});
				}
			}, 30_000);

			const startupCfg = loadMemoryConfig(AGENTS_DIR);
			if (startupCfg.embedding.provider !== "none") {
				checkEmbeddingProvider(startupCfg.embedding)
					.then((embeddingStatus) => {
						if (!embeddingStatus.available) {
							logger.warn(
								"daemon",
								`Embedding provider '${startupCfg.embedding.provider}' is unavailable: ${embeddingStatus.error ?? "unknown error"}`,
							);
							logger.warn(
								"daemon",
								"Vector search and memory embeddings will not work until this is resolved. Run 'signet sync' or reconfigure with 'signet setup'.",
							);
						} else if (embeddingStatus.error) {
							logger.warn("daemon", `Embedding provider using fallback: ${embeddingStatus.error}`);
						} else {
							logger.info(
								"daemon",
								`Embedding provider '${startupCfg.embedding.provider}' is ready (model: ${startupCfg.embedding.model})`,
							);
						}
					})
					.catch((e) => {
						logger.warn(
							"daemon",
							`Embedding provider health check failed: ${e instanceof Error ? e.message : String(e)}`,
						);
					});
			}
		});
	};

	bindWithRetry({
		port: PORT,
		hostname: BIND_HOST,
		signal: bindAbort.signal,
		maxDelayMs: BIND_MAX_DELAY_MS,
		baseDelayMs: BIND_RETRY_BASE_MS,
		createServer: () =>
			createSignetHttpServer({
				fetch: app.fetch,
				hostname: BIND_HOST,
				// Type assertion needed: arrow functions cannot satisfy overloaded
				// function types. The wrapper passes all args through to nodeCreateServer
				// so it is correct at runtime for every overload.
				createServer: nodeCreateServer,
			}),
		onBound: (server) => {
			httpServer = server;
		},
		onListening,
	});
}

function isMainEntrypoint(): boolean {
	if (process.env.SIGNET_DAEMON_ENTRYPOINT === "1") return true;
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(__filename);
	} catch {
		return false;
	}
}

if (isMainEntrypoint()) {
	main().catch((err) => {
		logger.error("daemon", "Fatal error", err);
		requestShutdown("error:startup", 1, err);
	});
}
