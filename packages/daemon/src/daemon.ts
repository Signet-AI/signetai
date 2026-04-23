#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { createAdaptorServer } from "@hono/node-server";
import {
	type AgentDefinition,
	type PipelineSynthesisConfig,
	buildArchitectureDoc,
	normalizeAgentRosterEntry,
	parseSimpleYaml,
	stripSignetBlock,
} from "@signet/core";
import { watch } from "chokidar";
import { Hono } from "hono";
import { resolveAgentId, resolveDaemonAgentId } from "./agent-id";
import { requirePermission } from "./auth";
import { bindWithRetry } from "./bind-with-retry";
import { migrateConfig } from "./config-migration";
import { listConnectors } from "./connectors/registry";
import { clearAllPresence } from "./cross-agent";
import { closeDbAccessor, getDbAccessor, getVectorRuntimeStatus, initDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { type EmbeddingTrackerHandle, startEmbeddingTracker } from "./embedding-tracker";
import { initFeatureFlags } from "./feature-flags";
import { writeFileIfChangedAsync } from "./file-sync";
import { syncAgentWorkspaces } from "./identity-sync";
import { getOrCreateInferenceRouter } from "./inference-router.js";
import { closeInferenceProviderResolver, getInferenceProvider, initInferenceProviderResolver } from "./llm";
import { logger } from "./logger";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { registerGlobalMiddleware } from "./middleware";
import { DEFAULT_RETENTION, ensureRetentionWorker, setDreamingWorker, startPipeline, stopPipeline } from "./pipeline";
import { type DreamingWorkerHandle, startDreamingWorker } from "./pipeline/dreaming-worker";
import { invalidateTraversalCache } from "./pipeline/graph-traversal";
import { stopModelRegistry } from "./pipeline/model-registry";
import { stopOpenCodeServer } from "./pipeline/provider";
import { startReconciler } from "./pipeline/skill-reconciler";
import { type PredictorClient, createPredictorClient } from "./predictor-client";
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
	setPredictorClientRef,
	setRestartPipelineRuntime,
	setShuttingDown,
	setTelemetryRef,
	shuttingDown,
} from "./routes/state.js";
import { startSchedulerWorker } from "./scheduler";
import { getSecret } from "./secrets.js";
import { flushPendingCheckpoints, initCheckpointFlush, pruneCheckpoints } from "./session-checkpoints";
import { releaseAllSessions, startSessionCleanup, stopSessionCleanup } from "./session-tracker";
import { createSingleFlightRunner } from "./single-flight-runner";
import { type TelemetryCollector, createTelemetryCollector } from "./telemetry";

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
import { mountEventBusRoutes } from "./routes/event-bus.js";
import {
	getGitStatus,
	gitConfig,
	gitPull,
	gitPush,
	gitSync,
	scheduleAutoCommit,
	startGitSyncTimer,
	stopGitSyncTimer,
} from "./routes/git-sync.js";
import { mountHealthRoutes } from "./routes/health.js";
import { registerHooksRoutes } from "./routes/hooks-routes.js";
import { mountInferenceRoutes } from "./routes/inference.js";
import { registerKnowledgeRoutes } from "./routes/knowledge-routes.js";
import { mountMarketplaceReviewsRoutes } from "./routes/marketplace-reviews.js";
import { mountMarketplaceRoutes } from "./routes/marketplace.js";
import { mountMcpAnalyticsRoutes } from "./routes/mcp-analytics.js";
import { registerMemoryRoutes } from "./routes/memory-routes.js";
import { registerMiscRoutes } from "./routes/misc-routes.js";
import { mountOsAgentRoutes } from "./routes/os-agent.js";
import { mountOsChatRoutes } from "./routes/os-chat.js";
import { registerPipelineRoutes } from "./routes/pipeline-routes.js";
import { registerPluginRoutes } from "./routes/plugins-routes.js";
import { registerRepairRoutes } from "./routes/repair-routes.js";
import { registerSecretRoutes } from "./routes/secrets-routes.js";
import { registerSessionRoutes } from "./routes/session-routes.js";
import { mountSkillAnalyticsRoutes } from "./routes/skill-analytics.js";
import { mountSkillsRoutes, setFetchEmbedding } from "./routes/skills.js";
import { registerTelemetryRoutes } from "./routes/telemetry-routes.js";
import { checkEmbeddingProvider } from "./routes/utils.js";
import { mountWidgetRoutes } from "./routes/widget.js";
import { isReadyResponse } from "./synthesis-worker-protocol";
import { initUpdateSystem, startUpdateTimer, stopUpdateTimer } from "./update-system";
import { createAgentsWatcherIgnoreMatcher } from "./watcher-ignore";

let httpServer: import("node:net").Server | null = null;
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

export function countConnectorsActive(connectors: readonly { readonly status: string }[]): number {
	// ConnectorStatus is "idle" | "syncing" | "error"; there is no "active"
	// state. The heartbeat field keeps its historical name, but means
	// connectors that are registered and not currently errored.
	return connectors.filter((cn) => cn.status !== "error").length;
}

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

registerGlobalMiddleware(app, { getShadowProcess: () => shadowProcess });
getOrCreateInferenceRouter(AGENTS_DIR);

mountHealthRoutes(app);
mountMcpRoute(app);
registerAuthRoutes(app);

registerMemoryRoutes(app);
registerHooksRoutes(app);
registerKnowledgeRoutes(app);
registerRepairRoutes(app);
registerConnectorRoutes(app);
registerPluginRoutes(app);
registerSecretRoutes(app);
registerSessionRoutes(app, { gitConfig, stopGitSyncTimer, startGitSyncTimer, getGitStatus, gitPull, gitPush, gitSync });
registerPipelineRoutes(app);
registerTelemetryRoutes(app);
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
setupDashboardRoutes(app);

// ============================================================================
// File Watcher
// ============================================================================

let watcher: ReturnType<typeof watch> | null = null;

// Track ingested files to avoid re-processing (path -> content hash)
const ingestedMemoryFiles = new Map<string, string>();
const MEMORY_IMPORT_POLL_MS = 30_000;
let memoryImportTimer: ReturnType<typeof setInterval> | null = null;
let memoryImportInFlight = false;

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
		files = readdirSync(memoryDir)
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
	// Do NOT watch the memory/ directory directly — Bun's fs.watch()
	// opens one O_RDONLY FD per file in a watched directory and never
	// releases them on close(), leaking ~8 000 FDs with canonical
	// artifacts present. Canonical artifacts and backups are intentionally
	// ignored; rare legacy non-artifact memory markdown imports are handled
	// by the lightweight poller started after daemon readiness.
	watcher = watch(
		[
			join(AGENTS_DIR, "agent.yaml"),
			join(AGENTS_DIR, "AGENTS.md"),
			join(AGENTS_DIR, "SOUL.md"),
			join(AGENTS_DIR, "MEMORY.md"),
			join(AGENTS_DIR, "IDENTITY.md"),
			join(AGENTS_DIR, "USER.md"),
			join(AGENTS_DIR, "SIGNET-ARCHITECTURE.md"),
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

	closeInferenceProviderResolver();
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

	const router = getOrCreateInferenceRouter(AGENTS_DIR);
	const defaultAgentId = resolveDaemonAgentId();
	initInferenceProviderResolver((workload) => {
		switch (workload) {
			case "memoryExtraction":
				return router.createWorkloadProvider("memory_extraction", defaultAgentId);
			case "sessionSynthesis":
				return router.createWorkloadProvider("session_synthesis", defaultAgentId);
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
	const executorForBinding = (binding: string | undefined): string | null => {
		if (!binding?.includes("/")) return null;
		const targetId = binding.split("/", 1)[0];
		return targetId ? (statusValue?.targets[targetId]?.executor ?? null) : null;
	};
	const commandExtractionMode = memoryCfg.pipelineV2.extraction.provider === "command";
	const extractionAvailable =
		!pipelinePaused && (commandExtractionMode || (await router.hasWorkload("memory_extraction")));
	const synthesisAvailable = !pipelinePaused && (await router.hasWorkload("session_synthesis"));
	const extractionEffective = commandExtractionMode
		? "command"
		: (executorForBinding(statusValue?.workloadBindings.memoryExtraction) ??
			(extractionAvailable ? "inference" : "none"));
	const synthesisEffective =
		executorForBinding(statusValue?.workloadBindings.sessionSynthesis) ?? (synthesisAvailable ? "inference" : null);
	providerRuntimeResolution.extraction = {
		configured: memoryCfg.pipelineV2.extraction.provider,
		resolved: commandExtractionMode
			? "command"
			: explicitInference
				? "inference"
				: memoryCfg.pipelineV2.extraction.provider,
		effective: extractionEffective,
		fallbackProvider: memoryCfg.pipelineV2.extraction.fallbackProvider,
		status: pipelinePaused ? "paused" : extractionAvailable ? "active" : "disabled",
		degraded: false,
		fallbackApplied: false,
		reason: pipelinePaused
			? "Pipeline paused"
			: extractionAvailable
				? null
				: "No inference workload is configured for memoryExtraction",
		since: extractionAvailable ? null : new Date().toISOString(),
	};
	providerRuntimeResolution.synthesis = {
		configured: memoryCfg.pipelineV2.synthesis.enabled ? memoryCfg.pipelineV2.synthesis.provider : null,
		resolved: synthesisAvailable ? (explicitInference ? "inference" : memoryCfg.pipelineV2.synthesis.provider) : null,
		effective: synthesisEffective,
	};

	logger.info("config", "Inference router workloads", {
		extraction: extractionAvailable,
		synthesis: synthesisAvailable,
		interactive: await router.hasWorkload("interactive"),
		default: await router.hasWorkload("default"),
	});

	if (memoryCfg.pipelineV2.enabled && !pipelinePaused && extractionAvailable) {
		startPipeline(
			getDbAccessor(),
			memoryCfg.pipelineV2,
			memoryCfg.embedding,
			fetchEmbedding,
			memoryCfg.search,
			defaultAgentId,
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
	stopMemoryImportPoller();

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

	await stopGitSyncTimer();
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

	initDbAccessor(MEMORY_DB, { agentsDir: AGENTS_DIR });
	startSessionCleanup();
	logFdSnapshot("post-db-init");
	startEventLoopMonitor();
	startFdPollMonitor();

	const { extensionPath } = getVectorRuntimeStatus();
	const bundled = join(import.meta.dir, "synthesis-render-worker.js");
	const workerPath = existsSync(bundled) ? bundled : join(import.meta.dir, "synthesis-render-worker.ts");
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
	} catch (err) {
		logger.warn("config-migration", "Config migration failed; continuing startup", {
			error: err instanceof Error ? err.message : String(err),
		});
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
	logFdSnapshot("post-pipeline");

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

if (import.meta.main) {
	main().catch((err) => {
		logger.error("daemon", "Fatal error", err);
		process.exit(1);
	});
}
