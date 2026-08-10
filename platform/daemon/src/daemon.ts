#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import "./bun-socket-polyfill";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { readFile as readFileAsync, unlink as unlinkAsync } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	type AgentDefinition,
	buildArchitectureDoc,
	configuredRoutingTargetRefs,
	identityModeManagesFiles,
	isLocalInferenceEndpoint,
	loadConfiguredHarnesses,
	loadIdentityMode,
	loadSourcesConfig,
	normalizeAgentRosterEntry,
	parseRoutingConfig,
	parseRoutingTargetRef,
	parseSimpleYaml,
	resolveDefaultBasePath,
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
import { listConnectors } from "./connectors/registry";
import { clearAllPresence, reconcileAcpDeliveries } from "./cross-agent";
import { closeDbAccessor, getDbAccessor, getVectorRuntimeStatus, initDbAccessorAsync } from "./db-accessor";
import { getQueueDiagnosticsSnapshot, getQueuePressureSnapshot } from "./diagnostics-queue";
import { fetchEmbedding } from "./embedding-fetch";
import { type EmbeddingIndexMigrationHandle, startEmbeddingIndexMigration } from "./embedding-index-migration";
import { resolveActiveEmbeddingConfig } from "./embedding-index-state";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { initFeatureFlags } from "./feature-flags";
import { writeFileIfChangedAsync } from "./file-sync";
import { createSignetHttpServer } from "./http-server";
import { syncAgentWorkspaces } from "./identity-sync";
import { type InferenceStatusSummary, getOrCreateInferenceRouter } from "./inference-router.js";
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
import { type ResolvedMemoryConfig, graphWriteCaps, loadMemoryConfig } from "./memory-config";
import { registerGlobalMiddleware } from "./middleware";
import {
	type NativeMemoryBridgeHandle,
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
import { recordDreamingPassTelemetry } from "./pipeline/dreaming";
import { type DreamingWorkerHandle, startDreamingWorker } from "./pipeline/dreaming-worker";
import { retireLegacyExtractionJobs } from "./pipeline/extraction-fallback";
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
	readEnvTrimmed,
	reloadAuthState,
	repairLimiter,
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
import { startSchedulerWorker } from "./scheduler";
import { flushPendingCheckpoints, initCheckpointFlush, pruneCheckpoints } from "./session-checkpoints";
import { createSessionClaimStore } from "./session-claims";
import {
	releaseAllSessions,
	restorePersistedSessions,
	setSessionClaimStore,
	setSessionEvictionHandler,
	startSessionCleanup,
	stopSessionCleanup,
} from "./session-tracker";
import { createTtlEvictionHandler } from "./session-ttl-finalizer";
import { createSingleFlightRunner } from "./single-flight-runner";
import {
	beginSourceIndexJob,
	clearSourceIndexInFlight,
	completeSourceIndexJobFromProgress,
	failSourceIndexJob,
	getSourceIndexJob,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
} from "./source-index-progress";
import { recordSourceConnected, recordSourceIndexOperation, sourceFailureClass } from "./source-lifecycle-telemetry";
import { runStartupRecovery } from "./startup-recovery";
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

import {
	getSynthesisWorker as getSynthesisRenderWorker,
	setSynthesisWorker as setSynthesisRenderWorker,
	sweepStaleSessions,
} from "./hooks";
import { mountMcpRoute } from "./mcp";
import { mountAppTrayRoutes } from "./routes/app-tray.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { mountChangelogRoutes } from "./routes/changelog.js";
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
let dreamingWorkerHandle: DreamingWorkerHandle | null = null;
let reflectionWorkerHandle: ReflectionWorkerHandle | null = null;
let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
let embeddingIndexMigrationHandle: EmbeddingIndexMigrationHandle | null = null;
let embeddingPromotionRestart: Promise<void> | null = null;
let skillReconcilerHandle: ReturnType<typeof startReconciler> | null = null;
let schedulerHandle: { stop(): Promise<void> } | null = null;
let transcriptCaptureWorkerHandle: TranscriptCaptureWorkerHandle | null = null;
let transcriptRecoveryWorkerHandle: TranscriptRecoveryWorkerHandle | null = null;
// These are mirrored into state.ts via setters for read access by
// route modules. Only daemon.ts should assign or clear them.
let telemetryRef: TelemetryCollector | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let checkpointPruneTimer: ReturnType<typeof setInterval> | undefined;

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

registerGlobalMiddleware(app);
getOrCreateInferenceRouter(resolveDefaultBasePath());

mountHealthRoutes(app);
mountMcpRoute(app);
registerAuthRoutes(app);

registerMemoryRoutes(app);
registerHooksRoutes(app);
registerKnowledgeRoutes(app);
registerOntologyRoutes(app);
registerRepairRoutes(app);
registerConnectorRoutes(app);
registerPluginRoutes(app);
registerGraphiqRoutes(app);
registerSecretRoutes(app);
registerSessionRoutes(app, { gitConfig, stopGitSyncTimer, startGitSyncTimer, getGitStatus, gitPull, gitPush, gitSync });
registerSourcesRoutes(app);
registerImportRoutes(app);
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
					const fileContent = (await readFileAsync(identityPath, "utf8")).trim();
					if (!fileContent) return "";
					if (name === "MEMORY.md" && !scanMemoryContent(fileContent).contextEligible) return "";
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

function legacyMarkdownFileState(filePath: string): LegacyMarkdownFileState | null {
	try {
		const stat = statSync(filePath);
		return { mtimeMs: Math.round(stat.mtimeMs), ctimeMs: Math.round(stat.ctimeMs), size: stat.size };
	} catch {
		return null;
	}
}

function readLegacyMarkdownImportState(filePath: string): {
	readonly mtime_ms: number;
	readonly ctime_ms: number;
	readonly size: number;
	readonly content_hash: string;
	readonly importer_version: number;
	readonly chunk_count: number;
	readonly status: string;
} | null {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare(
					`SELECT mtime_ms, ctime_ms, size, content_hash, importer_version, chunk_count, status
					 FROM legacy_markdown_imports
					 WHERE path = ?`,
				)
				.get(filePath) as
				| {
						mtime_ms: number;
						ctime_ms: number;
						size: number;
						content_hash: string;
						importer_version: number;
						chunk_count: number;
						status: string;
				  }
				| undefined;
			return row ?? null;
		});
	} catch {
		// Older/unmigrated DBs fall back to the legacy importer behavior.
		return null;
	}
}

function legacyMarkdownImportIsCurrent(
	row: ReturnType<typeof readLegacyMarkdownImportState>,
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

function writeLegacyMarkdownImportState(args: {
	readonly filePath: string;
	readonly state: LegacyMarkdownFileState;
	readonly contentHash: string;
	readonly chunkCount: number;
	readonly status: "imported" | "empty" | "failed";
	readonly error?: string | null;
}): void {
	try {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
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
			).run(
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
			);
		});
	} catch {
		// Non-fatal: importer correctness still falls back to idempotency/source dedupe.
	}
}

function legacyMarkdownChunkKnown(filePath: string, chunkHash: string): boolean {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare("SELECT 1 FROM legacy_markdown_chunks WHERE file_path = ? AND chunk_hash = ?")
				.get(filePath, chunkHash);
			return row !== undefined;
		});
	} catch {
		return false;
	}
}

function recordLegacyMarkdownChunk(args: {
	readonly filePath: string;
	readonly chunkHash: string;
	readonly chunkIndex: number;
	readonly memoryId: string | null;
	readonly sourceId: string;
}): void {
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO legacy_markdown_chunks
				 (file_path, chunk_hash, chunk_index, memory_id, source_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(file_path, chunk_hash) DO UPDATE SET
				   chunk_index = excluded.chunk_index,
				   memory_id = COALESCE(excluded.memory_id, legacy_markdown_chunks.memory_id),
				   source_id = excluded.source_id`,
			).run(args.filePath, args.chunkHash, args.chunkIndex, args.memoryId, args.sourceId, new Date().toISOString());
		});
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

	const fileState = legacyMarkdownFileState(filePath);
	if (fileState === null) return 0;

	const priorState = readLegacyMarkdownImportState(filePath);
	if (legacyMarkdownImportIsCurrent(priorState, fileState)) return 0;

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

	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	if (
		priorState?.content_hash === hash &&
		priorState.importer_version === LEGACY_MARKDOWN_IMPORTER_VERSION &&
		(priorState.status === "imported" || priorState.status === "empty")
	) {
		writeLegacyMarkdownImportState({
			filePath,
			state: fileState,
			contentHash: hash,
			chunkCount: priorState.chunk_count,
			status: priorState.status === "empty" ? "empty" : "imported",
		});
		return 0;
	}

	if (!content.trim()) {
		writeLegacyMarkdownImportState({
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
		if (legacyMarkdownChunkKnown(filePath, chunkHash)) {
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
				recordLegacyMarkdownChunk({ filePath, chunkHash, chunkIndex: i, memoryId, sourceId: chunkKey });
				imported++;
			} else if (response.status === 409) {
				// Existing historical imports can predate this manifest table. A 409 still
				// proves this deterministic chunk should not be posted again on every
				// daemon restart, so persist a manifest row without a memory id.
				recordLegacyMarkdownChunk({ filePath, chunkHash, chunkIndex: i, memoryId: null, sourceId: chunkKey });
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
		writeLegacyMarkdownImportState({
			filePath,
			state: fileState,
			contentHash: hash,
			chunkCount: imported,
			status: "failed",
			error: `${transientFailures} transient chunk import failure(s)`,
		});
	} else {
		ingestedMemoryFiles.set(filePath, hash);
		writeLegacyMarkdownImportState({
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

async function importExistingMemoryFiles(): Promise<number> {
	const memoryDir = join(AGENTS_DIR, "memory");
	if (!existsSync(memoryDir)) {
		logger.debug("daemon", "Memory directory does not exist, skipping initial import");
		return 0;
	}

	let files: string[];
	try {
		files = (await readdir(memoryDir))
			.filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
			.filter((f) => !ARTIFACT_FILENAME_RE.test(f) && !MEMORY_BACKUP_FILENAME_RE.test(f));
	} catch (e) {
		const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
		logger.error("daemon", "Failed to read memory directory", undefined, errDetails);
		return 0;
	}

	if (files.length === 0) {
		logger.debug("daemon", "importExistingMemoryFiles: all files are artifacts/backups, skipping");
		return 0;
	}

	let totalChunks = 0;
	const yielder = yieldEvery(10);
	for (const file of files) {
		const count = await ingestMemoryMarkdown(join(memoryDir, file));
		totalChunks += count;
		await yielder();
		if (count > 0) await sleep(MEMORY_IMPORT_FILE_DELAY_MS);
	}

	if (totalChunks > 0) {
		logger.info("daemon", "Imported existing memory files", {
			files: files.length,
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
		try {
			const reconciled = reconcileAcpDeliveries();
			if (reconciled > 0) logger.info("daemon", "Reconciled abandoned ACP delivery attempts", { reconciled });
		} catch (error) {
			logger.warn("daemon", "ACP delivery reconciliation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
		scheduleAutoCommit(path);

		const base = basename(path);
		if (base === "agent.yaml" || base === "AGENT.yaml" || base === "config.yaml") {
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

	if (schedulerHandle) {
		try {
			await schedulerHandle.stop();
		} catch {}
		schedulerHandle = null;
	}

	if (transcriptRecoveryWorkerHandle) {
		try {
			await transcriptRecoveryWorkerHandle.stop();
		} catch {}
		transcriptRecoveryWorkerHandle = null;
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

type RouterHandle = ReturnType<typeof getOrCreateInferenceRouter>;

function executorForTargetRef(
	statusValue: InferenceStatusSummary,
	targetRef: string | undefined,
): RuntimeProviderName | null {
	if (!targetRef) return null;
	const parsed = parseRoutingTargetRef(targetRef);
	if (!parsed.ok) return null;
	return (statusValue.targets[parsed.value.targetId]?.executor as RuntimeProviderName | undefined) ?? null;
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

const LOCAL_INFERENCE_EXECUTORS = new Set(["none", "llama-cpp", "ollama"]);
const INFERENCE_CONFIG_FILES = ["agent.yaml", "AGENT.yaml"] as const;

function targetIsRemote(target: {
	readonly executor: string;
	readonly endpoint?: string;
	readonly privacy?: string;
}): boolean {
	if (target.privacy === "local_only") return false;
	if (target.executor === "openai-compatible") return !isLocalInferenceEndpoint(target.endpoint);
	return !LOCAL_INFERENCE_EXECUTORS.has(target.executor);
}

function configuredInferenceMode(agentsDir: string): "local" | "remote" {
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
				return targets.some((target) => targetIsRemote(target)) ? "remote" : "local";
			}
		} catch {
			// An invalid router config is reported by the router itself. Do not
			// infer a mode from retired memory.pipelineV2 provider fields.
		}
		break;
	}

	return "local";
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
		const deadLettered = retireLegacyExtractionJobs(getDbAccessor(), {
			reason: "Dreaming cutover: legacy extraction worker not started",
		});
		if (deadLettered > 0) {
			logger.info("dreaming", "Retired legacy extraction jobs", {
				count: deadLettered,
			});
		}
	}

	const activeEmbeddingCfg = getDbAccessor().withReadDb((db) => resolveActiveEmbeddingConfig(db, memoryCfg.embedding));
	configureLlmConcurrency(memoryCfg.pipelineV2.worker.maxLlmConcurrency);
	logger.info("config", "Resolved embedding config", {
		provider: memoryCfg.embedding.provider,
		model: memoryCfg.embedding.model,
		dimensions: memoryCfg.embedding.dimensions,
	});

	reloadAuthState(AGENTS_DIR);
	if (!transcriptCaptureWorkerHandle) {
		transcriptCaptureWorkerHandle = startTranscriptCaptureWorker(getDbAccessor(), AGENTS_DIR);
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
		ensureRetentionWorker(getDbAccessor(), DEFAULT_RETENTION);
	}

	if (activeEmbeddingCfg.provider !== "none" && memoryCfg.pipelineV2.embeddingTracker.enabled && !pipelinePaused) {
		embeddingTrackerHandle = startEmbeddingTracker(
			getDbAccessor(),
			activeEmbeddingCfg,
			memoryCfg.pipelineV2.embeddingTracker,
			fetchEmbedding,
			checkEmbeddingProvider,
		);
		setEmbeddingTrackerHandle(embeddingTrackerHandle);
	}

	if (!pipelinePaused) {
		embeddingIndexMigrationHandle = startEmbeddingIndexMigration({
			accessor: getDbAccessor(),
			configured: memoryCfg.embedding,
			// Re-read agent.yaml each tick so a mid-build config edit restarts
			// the build against the new profile instead of spinning on the
			// stale persisted one (#1160).
			readConfigured: () => loadMemoryConfig(AGENTS_DIR).embedding,
			fetchEmbedding,
			checkProvider: checkEmbeddingProvider,
			pollMs: memoryCfg.pipelineV2.embeddingTracker.pollMs,
			batchSize: memoryCfg.pipelineV2.embeddingTracker.batchSize,
			onPromoted: () => {
				restartAfterEmbeddingPromotion(telemetry);
			},
		});
	}

	if (!pipelinePaused && !memoryCfg.pipelineV2.mutationsFrozen) {
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
	if (telemetryRef) {
		try {
			await telemetryRef.stop();
		} catch {}
		telemetryRef = undefined;
		setTelemetryRef(undefined);
		setActiveTelemetry(undefined);
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

	await stopGitSyncTimer({ shutdown: true });
	stopUpdateTimer();

	const renderWorker = getSynthesisRenderWorker();
	if (renderWorker !== null) {
		setSynthesisRenderWorker(null);
		renderWorker.terminate().catch((e) => {
			logger.debug("daemon", "render worker terminate failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		});
	}

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
	requestShutdown("error:unhandledRejection", 1, reason);
});

// ============================================================================
// Main
// ============================================================================

async function main() {
	logger.info("daemon", "Signet Daemon starting");
	logger.info("daemon", `File logging to ${logger.logFilePath}`);
	logger.info("daemon", "Agents directory", { path: AGENTS_DIR });
	logger.info("daemon", "Network configured", { port: PORT, host: HOST, bindHost: BIND_HOST });

	mkdirSync(DAEMON_DIR, { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Acquire an exclusive lock to prevent multiple daemon instances from
	// competing for the SQLite write lock. Without this, a respawn (systemd,
	// launchd, or a script calling `signet daemon start`) starts a second
	// instance that fights the first for the DB lock, causing
	// "SQLiteError: database is locked" crashes on every write.
	const lockPath = join(DAEMON_DIR, "daemon.lock");
	const lockFd = openSync(lockPath, "w");
	if (!tryLockSync(lockFd)) {
		logger.error("daemon", "Another daemon instance is already running — exiting");
		process.exit(0);
	}
	process.on("exit", () => {
		try {
			closeSync(lockFd);
		} catch {}
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

	await initDbAccessorAsync(MEMORY_DB, { agentsDir: AGENTS_DIR });
	setSessionClaimStore(createSessionClaimStore(getDbAccessor()));
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
	const restoredSessions = restorePersistedSessions();
	if (restoredSessions.active > 0 || restoredSessions.expired > 0 || restoredSessions.ended > 0) {
		logger.info("session-tracker", "Restored durable session lifecycle state", restoredSessions);
	}
	logFdSnapshot("post-db-init");
	startEventLoopMonitor();
	startFdPollMonitor();

	// Clean accumulated crash-loop damage (dead jobs, stagnant staging buffer,
	// WAL bloat) before any worker starts. Fully synchronous — no yielding to
	// the event loop — because pending boot operations (plugin init, route
	// registration) would interfere with the DB write connection if allowed
	// to run between recovery batches (#1059).
	const startupRecovery = runStartupRecovery(getDbAccessor());
	if (
		startupRecovery.databaseIntegrity.state === "corrupt" ||
		startupRecovery.databaseIntegrity.state === "unavailable"
	) {
		throw new Error(
			`Database integrity check failed before workers started (${startupRecovery.databaseIntegrity.state}). Resolve the database issue offline; if only the audit store prevents a verified telemetry repair, restart once with SIGNET_ALLOW_UNAUDITED_TELEMETRY_REPAIR=1.`,
		);
	}

	// Purge artifacts of sources deleted while the daemon was down (e.g.
	// crash-loop-disabled sources). This needs the DB accessor, so it runs
	// here in the startup sequence — not at route registration, which
	// executes before DB init and crashed the daemon whenever a tombstone
	// existed at boot (#1143). Failures are tolerated inside the cleanup;
	// failed purges defer to the next boot.
	cleanupSourceDeletionTombstones(AGENTS_DIR);

	const { extensionPath } = getVectorRuntimeStatus();
	const bundled = join(__dirname, "synthesis-render-worker.js");
	const workerPath = existsSync(bundled)
		? bundled
		: (resolveEmbeddedWorkerPath("synthesis-render-worker") ?? join(__dirname, "synthesis-render-worker.ts"));
	let synthWorker: Worker | null = null;
	try {
		synthWorker = new Worker(workerPath);
	} catch (err) {
		logger.warn(
			"daemon",
			"synthesis worker creation failed — using sync rendering",
			err instanceof Error ? err : undefined,
		);
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

	syncAgentRoster(AGENTS_DIR);

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

	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	let telemetryCollector: TelemetryCollector | undefined;
	if (memoryCfg.pipelineV2.telemetryEnabled && !telemetryDisabledByEnv()) {
		const posthogApiKey = memoryCfg.pipelineV2.telemetry.posthogApiKey;
		const resolvedTelemetryCfg = {
			...memoryCfg.pipelineV2.telemetry,
			posthogApiKey,
		};
		telemetryCollector = createTelemetryCollector(getDbAccessor(), resolvedTelemetryCfg, CURRENT_VERSION, {
			telemetryLogPath: defaultTelemetryLogPath(AGENTS_DIR),
			configSnapshot: buildTelemetryConfigSnapshot(AGENTS_DIR, memoryCfg),
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
		// A daemon restart turns any still-running pass into a failed pass. Emit
		// a bounded, content-free outcome once telemetry is initialized so those
		// failures are not silently lost at the recovery boundary.
		for (let index = 0; index < Math.min(startupRecovery.orphanedPassesSwept, 100); index++) {
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
					durationMs: startupRecovery.durationMs,
				},
				usage: null,
			});
		}
		for (const source of loadSourcesConfig(AGENTS_DIR).sources) {
			if (source.enabled) recordSourceConnected(source, resolveDaemonAgentId());
		}

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
					let runtimePressure: ReturnType<typeof buildRuntimePressureEnvelope> | undefined;
					let resourceTelemetry: ReturnType<typeof buildResourceUtilizationTelemetry> | undefined;
					try {
						const queue = getDbAccessor().withReadDb((db) => getQueuePressureSnapshot(db));
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
						// Pressure context is best-effort; a slow or unavailable
						// subsystem must never suppress the liveness heartbeat.
					}
					telemetryRef.record("daemon.heartbeat", {
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
					if (runtimePressure?.recoveryOutcome === "restarted") {
						restartedHeartbeatPending = false;
					}
				} catch {}
			},
			5 * 60 * 1000,
		);
		setHeartbeatTimer(heartbeatTimer);
	}

	// Grace period: defer all background workers for 10s after startup so the
	// event-loop monitor can calibrate and migrations can settle before any
	// background write work piles on (#1059 thundering-herd prevention).
	reportStartupGrace();
	await startPipelineRuntime(memoryCfg, telemetryCollector);
	logFdSnapshot("post-pipeline");

	initCheckpointFlush(getDbAccessor());

	schedulerHandle = startSchedulerWorker(getDbAccessor());
	if (!transcriptCaptureWorkerHandle) {
		transcriptCaptureWorkerHandle = startTranscriptCaptureWorker(getDbAccessor(), AGENTS_DIR);
	}
	if (!transcriptRecoveryWorkerHandle) {
		transcriptRecoveryWorkerHandle = startTranscriptRecoveryWorker(getDbAccessor(), AGENTS_DIR, resolveDaemonAgentId());
	}

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
	initUpdateSystem(CURRENT_VERSION, AGENTS_DIR, (preferredExecutablePath) => {
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
	});
	initFeatureFlags(AGENTS_DIR);
	startUpdateTimer();

	const REQUEST_BODY_LIMIT = 10 * 1_048_576;
	const { createServer: nodeCreateServer } = await import("node:http");
	const createBoundedServer = (...args: Parameters<typeof nodeCreateServer>) => {
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
		logFdSnapshot("server-ready");
		writeDaemonLifecycle(AGENTS_DIR, buildLifecycleRecord("running"));

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
		startMemoryImportPoller();
		startStaleSessionSweeper();
		startAcpDeliveryReconciliation();

		if (!nativeMemoryBridge) {
			const startupSourceJobs = new Map<string, string>();
			for (const source of loadSourcesConfig(AGENTS_DIR).sources) {
				if (!source.enabled || source.kind !== "obsidian") continue;
				recordSourceConnected(source, resolveDaemonAgentId());
				const job = beginSourceIndexJob(source.id, "source-startup");
				startupSourceJobs.set(source.id, job.id);
				markSourceIndexInFlight(source.id);
				markSourceIndexJobRunning(source.id, job.id);
			}
			nativeMemoryBridge = startNativeMemoryBridge([], {
				agentsDir: AGENTS_DIR,
				includeConfiguredSources: true,
				pollIntervalMs: 0,
				sourceCleanupEnabled: false,
				sourceGraphEnabled: false,
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
					});
				},
			});
			nativeMemoryBridge
				.syncExisting()
				.then(() => {
					for (const [sourceId, jobId] of startupSourceJobs) {
						completeSourceIndexJobFromProgress(sourceId, jobId);
						const source = loadSourcesConfig(AGENTS_DIR).sources.find((entry) => entry.id === sourceId);
						const job = getSourceIndexJob(sourceId);
						if (source) {
							recordSourceIndexOperation({
								source,
								agentId: resolveDaemonAgentId(),
								discovered: job?.scanned ?? 0,
								accepted: job?.indexed ?? 0,
								durationMs:
									job?.startedAt && job.finishedAt
										? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt))
										: 0,
								outcome: "success",
							});
						}
					}
				})
				.catch((e) => {
					for (const [sourceId, jobId] of startupSourceJobs) {
						const source = loadSourcesConfig(AGENTS_DIR).sources.find((entry) => entry.id === sourceId);
						const job = getSourceIndexJob(sourceId);
						if (source) {
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
							});
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
				createServer: createBoundedServer as typeof nodeCreateServer,
			}),
		onBound: (server) => {
			httpServer = server;
		},
		onListening,
	});
}

/** Try to acquire an exclusive flock on fd. Returns false if held. */
function tryLockSync(fd: number): boolean {
	try {
		const fs = require("node:fs") as { flockSync?: (fd: number, op: string) => void };
		if (typeof fs.flockSync === "function") {
			fs.flockSync(fd, "exnb"); // LOCK_EX | LOCK_NB
			return true;
		}
		return true; // no flock available — allow startup (best effort)
	} catch {
		return false;
	}
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
