#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import "./bun-socket-polyfill";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { readFile as readFileAsync, unlink as unlinkAsync } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	type AgentDefinition,
	type PipelineSynthesisConfig,
	buildArchitectureDoc,
	identityModeManagesFiles,
	loadConfiguredHarnesses,
	loadIdentityMode,
	loadSourcesConfig,
	normalizeAgentRosterEntry,
	parseRoutingTargetRef,
	parseSimpleYaml,
	resolveDefaultBasePath,
	stripSignetBlock,
} from "@signet/core";
import { watch } from "chokidar";
import { Hono } from "hono";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { requirePermission } from "./auth";
import { bindWithRetry } from "./bind-with-retry";
import {
	migrateConfig,
	migrateInferenceProviders,
	migrateLegacyRoutingToRegistry,
	migrateSessionSynthesisRoute,
} from "./config-migration";
import { listConnectors } from "./connectors/registry";
import { clearAllPresence } from "./cross-agent";
import { closeDbAccessor, getDbAccessor, getVectorRuntimeStatus, initDbAccessorAsync } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { resolveActiveEmbeddingConfig } from "./embedding-index-state";
import { type EmbeddingIndexMigrationHandle, startEmbeddingIndexMigration } from "./embedding-index-migration";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { firstCandidateBlockedBy } from "./extraction-status";
import { initFeatureFlags } from "./feature-flags";
import { writeFileIfChangedAsync } from "./file-sync";
import { createSignetHttpServer } from "./http-server";
import { syncAgentWorkspaces } from "./identity-sync";
import { type InferenceStatusSummary, getOrCreateInferenceRouter } from "./inference-router.js";
import { closeInferenceProviderResolver, getInferenceProvider, initInferenceProviderResolver } from "./llm";
import { logger } from "./logger";
import { type ResolvedMemoryConfig, loadMemoryConfig, shouldWarnGraphExtractionWritesDisabled } from "./memory-config";
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
	ensureSummaryRecovery,
	ensureSummaryWorker,
	setDreamingWorker,
	startPipeline,
	stopPipeline,
} from "./pipeline";
import { type DreamingWorkerHandle, startDreamingWorker } from "./pipeline/dreaming-worker";
import type { WorkerInit } from "./pipeline/extraction-thread-protocol";
import { invalidateTraversalCache } from "./pipeline/graph-traversal";
import { stopModelRegistry } from "./pipeline/model-registry";
import { configureLlmConcurrency } from "./pipeline/provider";
import { startReconciler } from "./pipeline/skill-reconciler";
import { type RepairContext, structuralBackfill } from "./repair-actions";
import { logFdSnapshot, startEventLoopMonitor, startFdPollMonitor, stopResourceMonitors } from "./resource-monitor";
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
import { startSchedulerWorker } from "./scheduler";
import { getSecret } from "./secrets.js";
import { flushPendingCheckpoints, initCheckpointFlush, pruneCheckpoints } from "./session-checkpoints";
import { releaseAllSessions, startSessionCleanup, stopSessionCleanup } from "./session-tracker";
import { createSingleFlightRunner } from "./single-flight-runner";
import {
	beginSourceIndexJob,
	clearSourceIndexInFlight,
	completeSourceIndexJobFromProgress,
	failSourceIndexJob,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
} from "./source-index-progress";
import { type TelemetryCollector, createTelemetryCollector } from "./telemetry";
import { type TranscriptCaptureWorkerHandle, startTranscriptCaptureWorker } from "./transcript-capture-worker";

import {
	getSynthesisWorker as getSynthesisRenderWorker,
	setSynthesisWorker as setSynthesisRenderWorker,
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
import { registerSourcesRoutes } from "./routes/sources-routes.js";
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
let shadowProcess: ChildProcess | null = null;
let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
let embeddingIndexMigrationHandle: EmbeddingIndexMigrationHandle | null = null;
let skillReconcilerHandle: ReturnType<typeof startReconciler> | null = null;
let schedulerHandle: { stop(): Promise<void> } | null = null;
let transcriptCaptureWorkerHandle: TranscriptCaptureWorkerHandle | null = null;
let structuralBackfillTimer: ReturnType<typeof setTimeout> | null = null;
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

registerGlobalMiddleware(app, { getShadowProcess: () => shadowProcess });
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
const MEMORY_IMPORT_FILE_DELAY_MS = 50;
let memoryImportTimer: ReturnType<typeof setInterval> | null = null;
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
			const response = await fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
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
// Shadow daemon helpers
// ============================================================================

function resolveDaemonBinary(): string | null {
	const ext = process.platform === "win32" ? ".exe" : "";
	const arch = process.arch;
	const plat = process.platform;
	const monoRoot = join(__dirname, "..", "..", "..");
	const devPaths = [
		join(monoRoot, "platform", "daemon-rs", "target", "release", `signet-daemon${ext}`),
		join(monoRoot, "platform", "daemon-rs", "target", "debug", `signet-daemon${ext}`),
		join(process.cwd(), "platform", "daemon-rs", "target", "release", `signet-daemon${ext}`),
	];
	for (const p of devPaths) {
		if (existsSync(p)) return p;
	}
	const name = `signet-daemon-${plat}-${arch}${ext}`;
	const npmPath = join(__dirname, "..", "bin", name);
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
			await Promise.resolve(skillReconcilerHandle.stop());
		} catch {}
		skillReconcilerHandle = null;
	}

	if (shadowProcess) {
		try {
			shadowProcess.kill();
		} catch {}
		shadowProcess = null;
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

	if (schedulerHandle) {
		try {
			await schedulerHandle.stop();
		} catch {}
		schedulerHandle = null;
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

function runtimeReasonForTarget(
	decision: Awaited<ReturnType<RouterHandle["explain"]>> | null,
	targetRef: string | undefined,
): string | null {
	if (!targetRef || !decision?.ok) return null;
	const candidate = decision.value.trace.candidates.find((entry) => entry.targetRef === targetRef);
	return candidate?.blockedBy[0] ?? candidate?.runtime.unavailableReason ?? null;
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
	const activeEmbeddingCfg = getDbAccessor().withReadDb((db) => resolveActiveEmbeddingConfig(db, memoryCfg.embedding));
	configureLlmConcurrency(memoryCfg.pipelineV2.worker.maxLlmConcurrency);
	clearStructuralBackfillTimer();
	if (shouldWarnGraphExtractionWritesDisabled(memoryCfg)) {
		logger.warn("pipeline", "Graph extraction writes are disabled while graph reads are enabled", {
			graphEnabled: memoryCfg.pipelineV2.graph.enabled,
			extractionWritesEnabled: memoryCfg.pipelineV2.graph.extractionWritesEnabled,
			hint: "Set memory.pipelineV2.graph.extractionWritesEnabled: true to persist entities extracted by the background worker.",
		});
	}
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
	const explicitInference = statusValue?.source === "explicit";
	const commandExtractionConfigured = memoryCfg.pipelineV2.extraction.provider === "command";
	const commandExtractionMode = memoryCfg.pipelineV2.enabled && commandExtractionConfigured;
	const extractionWorkloadConfigured = commandExtractionConfigured || (await router.hasWorkload("memory_extraction"));
	const synthesisWorkloadConfigured = await router.hasWorkload("session_synthesis");
	const extractionDecision =
		!commandExtractionConfigured && extractionWorkloadConfigured
			? await router.explain({ agentId: defaultAgentId, operation: "memory_extraction" })
			: null;
	const synthesisDecision =
		!pipelinePaused && synthesisWorkloadConfigured
			? await router.explain({ agentId: defaultAgentId, operation: "session_synthesis" })
			: null;
	const extractionAvailable = commandExtractionConfigured || Boolean(extractionDecision?.ok);
	const synthesisAvailable = Boolean(synthesisDecision?.ok);
	const extractionBinding = statusValue?.workloadBindings.memoryExtraction;
	const extractionSelectedRef = extractionDecision?.ok ? extractionDecision.value.targetRef : undefined;
	const extractionSelectedRuntime = extractionSelectedRef
		? statusValue?.runtimeSnapshot.targets[extractionSelectedRef]
		: undefined;
	const extractionFallbackApplied = Boolean(
		extractionSelectedRef && extractionBinding?.includes("/") && extractionSelectedRef !== extractionBinding,
	);
	const extractionDegraded = extractionFallbackApplied || extractionSelectedRuntime?.health === "degraded";
	const extractionStatus = !memoryCfg.pipelineV2.enabled
		? "disabled"
		: pipelinePaused
			? "paused"
			: !extractionWorkloadConfigured
				? "disabled"
				: extractionDecision?.ok
					? extractionDegraded
						? "degraded"
						: "active"
					: "blocked";
	const statusSince =
		extractionStatus === "active" || extractionStatus === "disabled" ? null : new Date().toISOString();
	const extractionResolved = commandExtractionConfigured
		? "command"
		: ((statusValue && executorForTargetRef(statusValue, extractionSelectedRef)) ??
			(statusValue && executorForTargetRef(statusValue, extractionBinding)) ??
			"none");
	const extractionEffective = extractionAvailable ? extractionResolved : "none";
	const synthesisEffective =
		(statusValue &&
			(executorForTargetRef(
				statusValue,
				synthesisDecision?.ok ? synthesisDecision.value.targetRef : undefined,
			) as RuntimeSynthesisProviderName | null)) ??
		(synthesisAvailable ? "inference" : null);
	// After #949, the retired flat pipelineV2.extraction.fallbackProvider field
	// was dropped from this status object, which made `signet status` print
	// "fallback: unknown". Restore the field with runtime-derived semantics:
	// when a fallback is in use (fallbackApplied), `effective` is the fallback
	// executor; otherwise report "none". (The decision's fallbackTargetRefs is
	// NOT the right source — it holds candidates remaining AFTER selection, so
	// it is empty when the fallback became the selected target.) NOTE: this is
	// an applied-vs-configured semantic shift from pre-#949 — in the "blocked"
	// case the field reports "none" even if a fallback was configured but also
	// failed, because the decision carries no candidates when blocked. The
	// `reason` field carries the failure detail in that case.
	const extractionFallbackProvider: RuntimeProviderName = extractionFallbackApplied ? extractionEffective : "none";
	providerRuntimeResolution.extraction = {
		// Configured/resolved now derive from the routing registry (the workload
		// binding's target executor), not the retired legacy flat fields.
		configured: commandExtractionConfigured
			? "command"
			: statusValue
				? executorForTargetRef(statusValue, extractionBinding)
				: null,
		resolved: extractionResolved,
		effective: extractionEffective,
		fallbackProvider: commandExtractionConfigured ? "none" : extractionFallbackProvider,
		status: extractionStatus,
		degraded: extractionDegraded,
		fallbackApplied: extractionFallbackApplied,
		reason: !memoryCfg.pipelineV2.enabled
			? "Pipeline disabled"
			: pipelinePaused
				? "Pipeline paused"
				: extractionStatus === "disabled"
					? "No inference workload is configured for memoryExtraction"
					: extractionStatus === "blocked"
						? extractionDecision && !extractionDecision.ok
							? extractionDecision.error.message
							: "No memoryExtraction route available"
						: extractionFallbackApplied
							? (runtimeReasonForTarget(extractionDecision, extractionBinding) ??
								`Configured extraction provider unavailable; using ${extractionEffective} fallback`)
							: (extractionSelectedRuntime?.unavailableReason ?? null),
		blockedBy:
			extractionStatus === "blocked" && extractionDecision && !extractionDecision.ok
				? firstCandidateBlockedBy(extractionDecision.error.details)
				: [],
		since: statusSince,
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
		extraction: extractionAvailable,
		synthesis: synthesisAvailable,
		interactive: await router.hasWorkload("interactive"),
		default: await router.hasWorkload("default"),
	});

	// Summary worker — shared infrastructure, owned here not by startPipeline.
	// Both pipelineV2 and dreaming consume session summaries. Command-mode
	// extraction also checkpoints through summary_jobs and remains runnable
	// without synthesis; all other queued work requires an effective route.
	const isSummarySynthesisAvailable = async (): Promise<boolean> =>
		(await router.explain({ agentId: defaultAgentId, operation: "session_synthesis" }, true)).ok;
	const hasSummaryConsumers = memoryCfg.pipelineV2.enabled || memoryCfg.dreaming.enabled;
	const summarySynthesisAvailable = hasSummaryConsumers ? await isSummarySynthesisAvailable() : false;
	if (hasSummaryConsumers && !pipelinePaused && (commandExtractionMode || summarySynthesisAvailable)) {
		ensureSummaryWorker(getDbAccessor(), {
			isSynthesisAvailable: isSummarySynthesisAvailable,
		});
	} else if (hasSummaryConsumers) {
		ensureSummaryRecovery(getDbAccessor(), {
			workerOptions: { isSynthesisAvailable: isSummarySynthesisAvailable },
			shouldStartWorker: async () => {
				const liveCfg = loadMemoryConfig(AGENTS_DIR);
				if ((!liveCfg.pipelineV2.enabled && !liveCfg.dreaming.enabled) || liveCfg.pipelineV2.paused) return false;
				return (
					(liveCfg.pipelineV2.enabled && liveCfg.pipelineV2.extraction.provider === "command") ||
					(await isSummarySynthesisAvailable())
				);
			},
		});
	}

	if (memoryCfg.pipelineV2.enabled && !pipelinePaused && extractionAvailable) {
		const workerInit: WorkerInit | undefined = memoryCfg.pipelineV2.worker.threadedExtraction
			? {
					dbPath: MEMORY_DB,
					vecExtensionPath: getVectorRuntimeStatus().extensionPath ?? "",
					agentsDir: AGENTS_DIR,
					agentId: defaultAgentId,
					embeddingConfig: {
						provider: activeEmbeddingCfg.provider,
						model: activeEmbeddingCfg.model,
						dimensions: activeEmbeddingCfg.dimensions ?? 768,
						base_url: activeEmbeddingCfg.base_url,
						api_key: activeEmbeddingCfg.api_key,
					},
					pipelineConfig: memoryCfg.pipelineV2 as unknown as Record<string, unknown>,
					searchConfig: memoryCfg.search as unknown as Record<string, unknown>,
					// Resolve native asset paths on the main thread, where
					// globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__ is registered.
					// The extraction worker thread has an isolated globalThis
					// and cannot resolve these itself (#922). Null in source mode.
					nativeEmbeddingWorkerPath: resolveEmbeddedWorkerPath("embedding-worker"),
					nativeWasmDir: materializeEmbeddedWasmAssets(),
					nativeTransformersRuntimePath: resolveEmbeddedWorkerPath("embedding-worker-transformers-runtime"),
				}
			: undefined;

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
			workerInit,
		);

		// Configure the main thread's own native embedding handle with the
		// same pre-resolved asset paths. This is not strictly necessary on
		// the main thread (it has the asset globals), but it ensures
		// consistency and makes the main thread path identical to the
		// extraction-thread path (#922).
		const { configureNativeEmbeddingAssets } = await import("./native-embedding");
		configureNativeEmbeddingAssets({
			embeddingWorkerPath: resolveEmbeddedWorkerPath("embedding-worker"),
			wasmAssetDir: materializeEmbeddedWasmAssets(),
			transformersRuntimeAssetPath: resolveEmbeddedWorkerPath("embedding-worker-transformers-runtime"),
		});
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
			fetchEmbedding,
			checkProvider: checkEmbeddingProvider,
			pollMs: memoryCfg.pipelineV2.embeddingTracker.pollMs,
			batchSize: memoryCfg.pipelineV2.embeddingTracker.batchSize,
			onPromoted: () => {
				// The tracker and extraction worker hold their embedding config at
				// construction time. Recreate them only after the new generation is
				// committed, never while the active slot is still serving recall.
				void restartPipelineRuntime(loadMemoryConfig(AGENTS_DIR), telemetry).catch((error) => {
					logger.error("embedding", "Promoted index but could not restart embedding workers", undefined, {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			},
		});
	}

	if (memoryCfg.dreaming.enabled && !pipelinePaused && !memoryCfg.pipelineV2.mutationsFrozen) {
		try {
			dreamingWorkerHandle = startDreamingWorker(getDbAccessor(), memoryCfg.dreaming, AGENTS_DIR, defaultAgentId);
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
					return getInferenceProvider("repair");
				} catch {
					return null;
				}
			},
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
	logger.error(
		"daemon",
		"Unhandled rejection",
		reason instanceof Error ? reason : undefined,
		reason instanceof Error ? undefined : { reason: String(reason) },
	);
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

	await initDbAccessorAsync(MEMORY_DB, { agentsDir: AGENTS_DIR });
	startSessionCleanup();
	logFdSnapshot("post-db-init");
	startEventLoopMonitor();
	startFdPollMonitor();

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

	try {
		migrateConfig(AGENTS_DIR);
		migrateInferenceProviders(AGENTS_DIR);
		migrateLegacyRoutingToRegistry(AGENTS_DIR);
		migrateSessionSynthesisRoute(AGENTS_DIR);
	} catch (err) {
		logger.warn("config-migration", "Config migration failed; continuing startup", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	if (ensureWorkspaceGitignore()) {
		scheduleAutoCommit(join(AGENTS_DIR, ".gitignore"));
	}

	startFileWatcher();
	logger.info("watcher", "File watcher started");
	logFdSnapshot("post-watcher");

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
						connectorsActive: countConnectorsActive(connectors),
						pipelineMode: readPipelineMode(liveCfg.pipelineV2),
						extractionProvider: providerRuntimeResolution.extraction.effective,
						embeddingProvider: liveCfg.embedding.provider,
					});
				} catch {}
			},
			5 * 60 * 1000,
		);
		setHeartbeatTimer(heartbeatTimer);
	}

	await startPipelineRuntime(memoryCfg, telemetryCollector);
	logFdSnapshot("post-pipeline");

	initCheckpointFlush(getDbAccessor());

	schedulerHandle = startSchedulerWorker(getDbAccessor());
	if (!transcriptCaptureWorkerHandle) {
		transcriptCaptureWorkerHandle = startTranscriptCaptureWorker(getDbAccessor(), AGENTS_DIR);
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
				SIGNET_DAEMON_ENTRYPOINT: "1",
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

		if (!nativeMemoryBridge) {
			const startupSourceJobs = new Map<string, string>();
			for (const source of loadSourcesConfig(AGENTS_DIR).sources) {
				if (!source.enabled || source.kind !== "obsidian") continue;
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
					}
				})
				.catch((e) => {
					for (const [sourceId, jobId] of startupSourceJobs) failSourceIndexJob(sourceId, jobId, e);
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
		process.exit(1);
	});
}
