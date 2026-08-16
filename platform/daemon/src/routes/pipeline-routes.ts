import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSimpleYaml, readPipelinePauseState, setPipelinePaused } from "@signet/core";
import type { Context, Hono } from "hono";
import { resolveAgentId, resolveDaemonAgentId } from "../agent-id.js";
import { requirePermission, requireRateLimit } from "../auth";
import { getDbAccessor } from "../db-accessor.js";
import { getVacuumConversionStatus } from "../db-vacuum.js";
import { type QueueCounts, getQueueDiagnosticsSnapshot } from "../diagnostics-queue.js";
import { readEmbeddingUsageSummary } from "../embedding-usage";
import { getInferenceRouterOrNull } from "../inference-router.js";
import type { BackgroundWorkloadDiagnostics } from "../inference-router.js";
import { getLlmProvider } from "../llm.js";
import { getMcpWorkloadDiagnostics } from "../mcp/route.js";
import { getLlmConcurrencyStatus } from "../pipeline/provider.js";
import { graphWriteCaps, loadMemoryConfig } from "../memory-config.js";
import { listMemoryContentSafety, parseMemorySafetyReasons } from "../memory-content-safety.js";
import {
	getDreamingAttention,
	getDreamingEpisodicTokenBacklog,
	getDreamingEvidenceExclusions,
	getDreamingPasses,
	getDreamingPass,
	getActiveDreamingPasses,
	getDreamingQualityReport,
	getDreamingState,
	getDreamingToolCalls,
	getDreamingWorker,
	getDreamingWorkloadDiagnostics,
	getPipelineWorkerStatus,
	requestDreamingEvidenceRequeue,
} from "../pipeline";
import {
	DREAMING_LIVE_HEARTBEAT_MS,
	dreamingLiveEvents,
	type DreamingLiveEvent,
} from "../pipeline/dreaming-live-events";
import { getFeedbackTelemetry } from "../pipeline/aspect-feedback.js";
import { getDreamingCapability, getDreamingCapabilityManifest } from "../pipeline/dreaming-capabilities.js";
import { DREAMING_MAX_OPERATIONS_PER_REQUEST, applyDreamingOperations } from "../pipeline/dreaming-operations.js";
import { AlreadyRunningError } from "../pipeline/dreaming-worker.js";
import { getTraversalStatus } from "../pipeline/graph-traversal.js";
import {
	getAvailableModels,
	getModelsByProvider,
	getRegistryStatus,
	refreshRegistry,
} from "../pipeline/model-registry.js";
import { getResourceSnapshot } from "../resource-monitor.js";
import { activeSessionCount, getBypassedSessionKeys, getSessionTrackerStats } from "../session-tracker.js";
import { getTranscriptCaptureStatus } from "../transcript-capture-worker.js";
import { getTranscriptHealthReport } from "../transcript-health.js";
import {
	AGENTS_DIR,
	BIND_HOST,
	CURRENT_VERSION,
	HOST,
	LOG_DIR,
	MEMORY_DB,
	NETWORK_MODE,
	PORT,
	analyticsCollector,
	authAdminLimiter,
	authConfig,
	buildOpenClawHealth,
	getCachedDiagnosticsReport,
	getExtractionWorkloadState,
	getUpdateState,
	invalidateDiagnosticsCache,
	openClawHeartbeat,
	pipelineTransition,
	providerRuntimeResolution,
	readEnvTrimmed,
	readPipelineMode,
	restartPipelineRuntimeRef,
	setOpenClawHeartbeat,
	setPipelineTransition,
	telemetryRef,
} from "./state.js";
import { STATUS_CACHE_TTL, cachedEmbeddingStatus, resolveScopedAgentId, statusCacheTime } from "./utils.js";

interface PipelineQueueBlock {
	readonly memory: QueueCounts;
	readonly summary: QueueCounts;
	readonly oldestDeadSummaryJob: ReturnType<typeof getQueueDiagnosticsSnapshot>["oldestDeadSummaryJob"];
}

const EMPTY_QUEUE_COUNTS_SHAPE: QueueCounts = {
	pending: 0,
	leased: 0,
	completed: 0,
	failed: 0,
	dead: 0,
	oldestAgeSec: 0,
	oldestDeadAgeSec: 0,
	lastError: null,
	completeness: "exact",
};

const UNKNOWN_QUEUE_COUNTS_SHAPE: QueueCounts = {
	...EMPTY_QUEUE_COUNTS_SHAPE,
	completeness: "unknown",
};

export function pipelineQueueBlock(): PipelineQueueBlock {
	try {
		const accessor = getDbAccessor();
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
			const snapshot = getQueueDiagnosticsSnapshot(db);
			return {
				memory: snapshot.memory,
				summary: snapshot.summary,
				oldestDeadSummaryJob: snapshot.oldestDeadSummaryJob,
			};
		});
	} catch {
		return {
			memory: { ...UNKNOWN_QUEUE_COUNTS_SHAPE },
			summary: { ...UNKNOWN_QUEUE_COUNTS_SHAPE },
			oldestDeadSummaryJob: null,
		};
	}
}

function workloadDiagnosticsSnapshot(agentId: string): {
	readonly inference: BackgroundWorkloadDiagnostics;
	readonly mcp: ReturnType<typeof getMcpWorkloadDiagnostics>;
	readonly pi: {
		readonly active: number;
		readonly oldestAgeMs: number | null;
	};
	readonly providerSemaphore: ReturnType<typeof getLlmConcurrencyStatus>;
	readonly dreaming: ReturnType<typeof getDreamingWorkloadDiagnostics>;
} {
	const inference: BackgroundWorkloadDiagnostics = getInferenceRouterOrNull()?.getBackgroundWorkloadDiagnostics(
		agentId,
	) ?? {
		active: 0,
		agentSessions: 0,
		oldestAgeMs: null,
		oldestAgentSessionAgeMs: null,
		byOperation: {},
	};
	return {
		inference,
		mcp: getMcpWorkloadDiagnostics(agentId),
		pi: { active: inference.agentSessions, oldestAgeMs: inference.oldestAgentSessionAgeMs },
		providerSemaphore: getLlmConcurrencyStatus(),
		dreaming: getDreamingWorkloadDiagnostics(getDbAccessor(), agentId),
	};
}

function workloadDiagnostics(c: Context): Response {
	const requestedAgentId = c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id");
	const scopedAgent = resolveScopedAgentId(c, requestedAgentId, resolveDaemonAgentId());
	if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
	const agentId = resolveAgentId({ agentId: scopedAgent.agentId });
	return c.json({ agentId, ...workloadDiagnosticsSnapshot(agentId) });
}

const pipelineAdminGuard = async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
	const permDenied = await requirePermission("admin", authConfig)(c, () => Promise.resolve());
	if (permDenied) return permDenied;
	const rateDenied = await requireRateLimit("admin", authAdminLimiter, authConfig)(c, () => Promise.resolve());
	if (rateDenied) return rateDenied;
	await next();
};

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
	const value = record[key];
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function readArray(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] | undefined {
	const value = record[key];
	return Array.isArray(value) ? value : undefined;
}

function requestedDreamAgentId(c: Context, body: Readonly<Record<string, unknown>> = {}): string | undefined {
	return (
		readString(body, "agentId") ??
		readString(body, "agent_id") ??
		c.req.query("agentId") ??
		c.req.query("agent_id") ??
		c.req.header("x-signet-agent-id")
	);
}

export function resolveDreamRequestAgentId(c: Context, body: Readonly<Record<string, unknown>> = {}): string {
	return resolveAgentId({ agentId: requestedDreamAgentId(c, body) ?? resolveDaemonAgentId() });
}

function resolveScopedDreamAgent(
	c: Context,
	body: Readonly<Record<string, unknown>> = {},
): { readonly agentId: string; readonly error?: string } {
	return resolveScopedAgentId(c, requestedDreamAgentId(c, body), resolveDaemonAgentId());
}

function parseDreamingCursor(value: string | undefined): number | null | "invalid" {
	if (value === undefined || value.trim() === "") return null;
	if (!/^\d+$/.test(value.trim())) return "invalid";
	const cursor = Number.parseInt(value, 10);
	return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : "invalid";
}

function sseEncode(eventName: string, data: unknown, cursor?: number): Uint8Array {
	const id = cursor === undefined ? "" : `id: ${cursor}\n`;
	return new TextEncoder().encode(`${id}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isTerminalDreamingEvent(event: DreamingLiveEvent): boolean {
	return event.type === "pass_completed" || event.type === "pass_failed";
}

function dreamingEventForTransport(event: DreamingLiveEvent, verbose: boolean): DreamingLiveEvent {
	if (verbose) return event;
	if (event.type === "thinking_delta") return { ...event, data: { redacted: true } };
	if (!("raw" in event.data)) return event;
	const { raw: _raw, ...conciseData } = event.data;
	return { ...event, data: conciseData };
}

// A ReadableStream will otherwise keep accepting chunks while a client is
// paused. Closing a full stream lets the viewer reconnect from its last SSE id
// instead of allowing one slow terminal to accumulate an unbounded queue.
const DREAMING_LIVE_STREAM_QUEUE_SIZE = 64;

async function togglePipelinePause(c: Context, paused: boolean): Promise<Response> {
	if (pipelineTransition) {
		return c.json({ error: "Pipeline transition already in progress" }, 409);
	}

	const prev = readPipelinePauseState(AGENTS_DIR);
	if (!prev.exists) {
		return c.json({ error: "No Signet config file found" }, 404);
	}

	setPipelineTransition(true);
	try {
		const changed = prev.paused !== paused;
		const next = changed ? setPipelinePaused(AGENTS_DIR, paused) : prev;
		if (changed) {
			if (!restartPipelineRuntimeRef) {
				throw new Error("Pipeline runtime not initialized");
			}
			await restartPipelineRuntimeRef(loadMemoryConfig(AGENTS_DIR), telemetryRef);
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
		const { logger } = await import("../logger.js");
		logger.error(
			"pipeline",
			paused ? "Failed to pause pipeline" : "Failed to resume pipeline",
			err instanceof Error ? err : new Error(String(err)),
		);
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	} finally {
		setPipelineTransition(false);
	}
}

export function registerPipelineRoutes(app: Hono): void {
	app.use("/api/diagnostics", async (c, next) => {
		return requirePermission("diagnostics", authConfig)(c, next);
	});
	app.use("/api/diagnostics/*", async (c, next) => {
		return requirePermission("diagnostics", authConfig)(c, next);
	});
	app.get("/api/diagnostics/transcripts", async (c) => {
		const requestedAgentId = c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id");
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, resolveDaemonAgentId());
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const agentId = resolveAgentId({ agentId: scopedAgent.agentId });
		return c.json(await getTranscriptHealthReport(getDbAccessor(), AGENTS_DIR, agentId));
	});

	app.get("/api/diagnostics/workloads", (c) => workloadDiagnostics(c));

	app.get("/api/status", async (c) => {
		const config = loadMemoryConfig(AGENTS_DIR);
		const extractionWorkload = getExtractionWorkloadState({
			enabled: false,
			paused: config.pipelineV2.paused,
		});
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

		let transcriptCapture:
			| {
					pending: number;
					failed: number;
					dead: number;
					processing: number;
			  }
			| undefined;
		try {
			const capture = await getTranscriptCaptureStatus(getDbAccessor(), resolveDaemonAgentId());
			transcriptCapture = {
				pending: capture.pending,
				failed: capture.failed,
				dead: capture.dead,
				processing: capture.processing,
			};
		} catch {
			// DB may still be initializing; omit compact transcript health.
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
			agentId: resolveDaemonAgentId(),
			agentsDir: AGENTS_DIR,
			memoryDb: existsSync(MEMORY_DB),
			resources: getResourceSnapshot(),
			pipelineV2: config.pipelineV2,
			pipeline: {
				queue: pipelineQueueBlock(),
				dreaming: getDreamingWorker()?.scheduler ?? null,
			},
			providerResolution: { ...providerRuntimeResolution, extraction: extractionWorkload },
			logging: {
				logDir: configuredLogFile ? dirname(configuredLogFile) : configuredLogDir,
				logFile: configuredLogFile ?? datedLogFile,
			},
			activeSessions: activeSessionCount(),
			bypassedSessions: getBypassedSessionKeys().size,
			sessions: { lifecycle: getSessionTrackerStats() },
			...(transcriptCapture ? { transcripts: { capture: transcriptCapture } } : {}),
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
				...(cachedEmbeddingStatus && Date.now() - statusCacheTime < STATUS_CACHE_TTL
					? { available: cachedEmbeddingStatus.available }
					: {}),
				usage: readEmbeddingUsageSummary(getDbAccessor()),
			},
		});
	});

	let greetingCache: { greeting: string; cachedAt: string; expires: number } | null = null;

	app.get("/api/home/greeting", async (c) => {
		const now = Date.now();
		if (greetingCache && now < greetingCache.expires) {
			return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
		}

		const soulPath = join(AGENTS_DIR, "SOUL.md");
		let soulContent = "";
		try {
			soulContent = readFileSync(soulPath, "utf-8").slice(0, 500);
		} catch {
			/* no soul file */
		}

		const hour = new Date().getHours();
		const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

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

		const fallback = `good ${timeOfDay}`;
		greetingCache = { greeting: fallback, cachedAt: new Date().toISOString(), expires: now + 3600000 };
		return c.json({ greeting: greetingCache.greeting, cachedAt: greetingCache.cachedAt });
	});

	app.get("/api/diagnostics", (c) => {
		const report = getCachedDiagnosticsReport();
		const requestedAgentId = c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id");
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, resolveDaemonAgentId());
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = resolveAgentId({ agentId: scopedAgent.agentId });
		return c.json({
			...report,
			workloads: { agentId, ...workloadDiagnosticsSnapshot(agentId) },
		});
	});

	app.get("/api/diagnostics/memory-content-safety", (c) => {
		const requestedAgentId = c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id");
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, resolveDaemonAgentId());
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const limitRaw = c.req.query("limit");
		const offsetRaw = c.req.query("offset");
		const limit = limitRaw === undefined ? 100 : Number(limitRaw);
		const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
		}
		if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
			return c.json({ error: "offset must be a non-negative integer at most 100000" }, 400);
		}
		const status = c.req.query("status")?.trim() || undefined;
		if (status !== undefined && !["clean", "tainted", "blocked"].includes(status)) {
			return c.json({ error: "status must be clean, tainted, or blocked" }, 400);
		}
		const sourceKind = c.req.query("sourceKind")?.trim() || undefined;
		if (
			sourceKind !== undefined &&
			!["memory", "artifact", "transcript", "summary", "source_chunk"].includes(sourceKind)
		) {
			return c.json({ error: "sourceKind is invalid" }, 400);
		}
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const report: ReturnType<typeof listMemoryContentSafety> = getDbAccessor().withReadDb(
			(db: import("../db-accessor").ReadDb) =>
				listMemoryContentSafety(db, {
					agentId: resolveAgentId({ agentId: scopedAgent.agentId }),
					status,
					sourceKind,
					limit,
					offset,
				}),
		);
		return c.json({
			agentId: resolveAgentId({ agentId: scopedAgent.agentId }),
			policyVersion: report.policyVersion,
			counts: report.counts,
			items: report.items.map((item) => ({
				agentId: item.agent_id,
				sourceKind: item.source_kind,
				sourceId: item.source_id,
				status: item.status,
				contextEligible: item.context_eligible === 1,
				reasons: parseMemorySafetyReasons(item.reasons_json),
				policyVersion: item.policy_version,
				scannedAt: item.scanned_at,
			})),
		});
	});

	app.get("/api/diagnostics/:domain", async (c, next) => {
		const domain = c.req.param("domain");
		// These concrete routes are registered after this generic diagnostics
		// domain route. Let each return its own response rather than a cached
		// aggregate subobject. Any new single-segment diagnostics route must
		// either be registered before this route or be added here.
		if (domain === "queue" || domain === "openclaw" || domain === "workloads") return next();
		const report = getCachedDiagnosticsReport();

		const domainData = report[domain as keyof typeof report];
		if (!domainData || typeof domainData === "string") {
			return c.json({ error: `Unknown domain: ${domain}` }, 400);
		}
		return c.json(domainData);
	});

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
		const { logger } = await import("../logger.js");
		const newData: import("./state.js").OpenClawHeartbeatData = {
			pluginVersion: b.pluginVersion.slice(0, 128),
			hooksRegistered: Array.isArray(b.hooksRegistered)
				? (b.hooksRegistered as unknown[])
						.filter((x): x is string => typeof x === "string")
						.map((s) => s.slice(0, 128))
						.slice(0, 50)
				: [],
			lastHookCall: typeof b.lastHookCall === "string" ? b.lastHookCall.slice(0, 512) : null,
			lastError: typeof b.lastError === "string" ? b.lastError.slice(0, 512) : null,
			latencyMs: typeof b.latencyMs === "number" && Number.isFinite(b.latencyMs) ? b.latencyMs : 0,
			lastFailedDelta: Math.max(
				0,
				typeof b.hooksFailed === "number" ? b.hooksFailed : typeof b.errorCount === "number" ? b.errorCount : 0,
			),
			totalSucceeded:
				(prev?.totalSucceeded ?? 0) + Math.max(0, typeof b.hooksSucceeded === "number" ? b.hooksSucceeded : 0),
			totalFailed:
				(prev?.totalFailed ?? 0) +
				Math.max(
					0,
					typeof b.hooksFailed === "number" ? b.hooksFailed : typeof b.errorCount === "number" ? b.errorCount : 0,
				),
		};
		setOpenClawHeartbeat({
			timestamp: new Date().toISOString(),
			data: newData,
		});
		invalidateDiagnosticsCache();
		return c.json({ ok: true });
	});

	app.get("/api/diagnostics/openclaw", (c) => {
		return c.json(buildOpenClawHealth());
	});

	app.get("/api/pipeline/status", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const accessor = getDbAccessor();

		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const dbData = accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
			const memoryRows = db
				.prepare("SELECT status, COUNT(*) as count FROM memory_jobs GROUP BY status")
				.all() as Array<{
				status: string;
				count: number;
			}>;
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
					summary: toCountMap([]),
				},
			};
		});
		const diagnostics = getCachedDiagnosticsReport();

		const pipelineV2 = cfg.pipelineV2;
		const workers = getPipelineWorkerStatus();
		const mode = readPipelineMode(pipelineV2);

		return c.json({
			workers,
			databaseMaintenance: {
				vacuumConversion: getVacuumConversionStatus(accessor),
			},
			providerResolution: {
				...providerRuntimeResolution,
				extraction: getExtractionWorkloadState({
					enabled: false,
					paused: pipelineV2.paused,
				}),
			},
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
		});
	});

	app.use("/api/pipeline/pause", pipelineAdminGuard);
	app.use("/api/pipeline/resume", pipelineAdminGuard);

	app.post("/api/pipeline/pause", (c) => {
		return togglePipelinePause(c, true);
	});

	app.post("/api/pipeline/resume", (c) => {
		return togglePipelinePause(c, false);
	});

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
		await refreshRegistry();
		return c.json({
			models: getModelsByProvider(),
			registry: getRegistryStatus(),
		});
	});

	// External Dreaming agents get only the cited apply seam with a scoped
	// agent credential. Administrative status, trigger, and requeue controls
	// remain admin-only.
	app.use("/api/dream/operations", async (c, next) => {
		return requirePermission("modify", authConfig)(c, next);
	});
	app.use("/api/dream/tools/*", async (c, next) => {
		return requirePermission("modify", authConfig)(c, next);
	});
	app.use("/api/dream/tools", async (c, next) => {
		return requirePermission("modify", authConfig)(c, next);
	});
	app.use("/api/dream/*", async (c, next) => {
		if (
			c.req.path === "/api/dream/operations" ||
			c.req.path === "/api/dream/tools" ||
			c.req.path.startsWith("/api/dream/tools/")
		)
			return next();
		return requirePermission("admin", authConfig)(c, next);
	});

	app.get("/api/dream/status", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const accessor = getDbAccessor();
		const scopedAgent = resolveScopedDreamAgent(c);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent.agentId;

		const state = await getDreamingState(accessor, agentId);
		const episodicTokensPending = await getDreamingEpisodicTokenBacklog(accessor, agentId);
		const passes = await getDreamingPasses(accessor, agentId, 10);
		const exclusions = await getDreamingEvidenceExclusions(accessor, agentId);
		const attention = getDreamingAttention(accessor, agentId);
		const worker = getDreamingWorker();

		return c.json({
			worker: {
				running: worker !== null,
				active: worker?.activeAgentId === agentId,
				activeAgentId: worker?.activeAgentId ?? null,
			},
			scheduler: worker?.scheduler ?? null,
			state,
			episodicTokensPending,
			config: {
				tokenThreshold: cfg.dreaming.tokenThreshold,
				backfillOnFirstRun: cfg.dreaming.backfillOnFirstRun,
				maxInputTokens: cfg.dreaming.maxInputTokens,
				maxOutputTokens: cfg.dreaming.maxOutputTokens,
				timeout: cfg.dreaming.timeout,
				surprisal: cfg.dreaming.surprisal,
			},
			passes,
			attention,
			exclusions,
		});
	});

	/** List active passes for read-only attach selection in one agent scope. */
	app.get("/api/dream/passes/active", async (c) => {
		const scopedAgent = resolveScopedDreamAgent(c);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		return c.json({
			agentId: scopedAgent.agentId,
			items: await getActiveDreamingPasses(getDbAccessor(), scopedAgent.agentId),
		});
	});

	/**
	 * Stream one scoped Dreaming pass. The stream is observation-only: it has
	 * no request body and no action that can steer, abort, or retry the pass.
	 */
	app.get("/api/dream/passes/:passId/events", async (c) => {
		const scopedAgent = resolveScopedDreamAgent(c);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const passId = c.req.param("passId").trim();
		if (!passId) return c.json({ error: "Missing Dreaming pass id" }, 400);
		const pass = await getDreamingPass(getDbAccessor(), scopedAgent.agentId, passId);
		if (!pass) return c.json({ error: "Dreaming pass not found" }, 404);

		const cursorValue = c.req.query("after") ?? c.req.header("last-event-id");
		const afterCursor = parseDreamingCursor(cursorValue);
		if (afterCursor === "invalid") return c.json({ error: "after/Last-Event-ID must be a non-negative integer" }, 400);
		const verbose = c.req.query("verbose") === "1" || c.req.query("verbose") === "true";

		dreamingLiveEvents.ensurePass({
			passId: pass.id,
			agentId: pass.agentId,
			mode: pass.mode,
			startedAt: pass.startedAt,
			status: pass.status,
			completedAt: pass.completedAt,
			summary: pass.summary,
			error: pass.error,
		});

		const encoder = new TextEncoder();
		let closed = false;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let subscription: ReturnType<typeof dreamingLiveEvents.subscribe> | null = null;
		let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
		const requestSignal = c.req.raw.signal;
		const close = (): void => {
			if (closed) return;
			closed = true;
			if (heartbeat) clearInterval(heartbeat);
			subscription?.unsubscribe();
			requestSignal.removeEventListener("abort", close);
			try {
				controllerRef?.close();
			} catch {
				// The client may already have cancelled the stream.
			}
		};
		const write = (eventName: string, data: unknown, cursor?: number): void => {
			if (closed || !controllerRef) return;
			if (controllerRef.desiredSize !== null && controllerRef.desiredSize <= 0) {
				close();
				return;
			}
			try {
				controllerRef.enqueue(sseEncode(eventName, data, cursor));
			} catch {
				close();
			}
		};

		const stream = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					controllerRef = controller;
					requestSignal.addEventListener("abort", close, { once: true });
					if (requestSignal.aborted) {
						close();
						return;
					}
					const writeLiveEvent = (event: DreamingLiveEvent): void => {
						const transported = dreamingEventForTransport(event, verbose);
						write(transported.type, transported, transported.cursor);
						if (isTerminalDreamingEvent(event)) close();
					};
					try {
						subscription = dreamingLiveEvents.subscribe(passId, afterCursor, (event) => {
							writeLiveEvent(event);
						});
					} catch (error) {
						write("error", { error: error instanceof Error ? error.message : String(error) });
						close();
						return;
					}
					if (!subscription) {
						write("error", { error: "Dreaming pass live stream is unavailable" });
						close();
						return;
					}
					// Snapshot/gap frames describe state but do not claim the replay
					// cursor. Replay and live event ids must remain the only resume
					// checkpoints so a disconnect cannot skip older replay frames.
					write("snapshot", { type: "snapshot", passId, snapshot: subscription.snapshot });
					if (subscription.gap) {
						write("gap", { type: "gap", passId, gap: subscription.gap });
					}
					for (const event of subscription.replay) {
						writeLiveEvent(event);
					}
					if (closed || requestSignal.aborted) {
						close();
						return;
					}
					if (subscription.snapshot.status !== "running") {
						close();
						return;
					}
					heartbeat = setInterval(() => {
						if (closed || !controllerRef) return;
						if (controllerRef.desiredSize !== null && controllerRef.desiredSize <= 0) {
							close();
							return;
						}
						try {
							controllerRef.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
						} catch {
							close();
						}
					}, DREAMING_LIVE_HEARTBEAT_MS);
					heartbeat.unref?.();
				},
				cancel: close,
			},
			{ highWaterMark: DREAMING_LIVE_STREAM_QUEUE_SIZE, size: () => 1 },
		);

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	});

	/**
	 * Review the exact capability calls a Pi Dreaming agent made during one
	 * scoped pass. The trace is local, agent-scoped, and never written to logs.
	 */
	app.get("/api/dream/passes/:passId/tools", async (c) => {
		const scopedAgent = resolveScopedDreamAgent(c);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const passId = c.req.param("passId").trim();
		if (!passId) return c.json({ error: "Missing Dreaming pass id" }, 400);
		return c.json({
			agentId: scopedAgent.agentId,
			passId,
			items: await getDreamingToolCalls(getDbAccessor(), scopedAgent.agentId, passId),
		});
	});

	/** Deterministic semantic-quality measurements for the scoped Dreaming graph. */
	app.get("/api/dream/quality", async (c) => {
		const scopedAgent = resolveScopedDreamAgent(c);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		return c.json(await getDreamingQualityReport(getDbAccessor(), scopedAgent.agentId));
	});

	app.post("/api/dream/exclusions/requeue", async (c) => {
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null) return c.json({ error: "Malformed JSON body" }, 400);
		const body = asRecord(raw);
		const sourceKind = readString(body, "sourceKind");
		if (sourceKind === "summary") {
			return c.json({ error: "Summary evidence requeue is retired; requeue the completed transcript instead" }, 410);
		}
		if (sourceKind !== "memory" && sourceKind !== "artifact" && sourceKind !== "transcript") {
			return c.json({ error: "Invalid episodic source kind" }, 400);
		}
		const sourceId = readString(body, "sourceId");
		if (!sourceId) return c.json({ error: "Missing episodic source id" }, 400);
		const scopedAgent = resolveScopedDreamAgent(c, body);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent.agentId;
		const requeued = requestDreamingEvidenceRequeue(getDbAccessor(), agentId, sourceKind, sourceId);
		if (!requeued) return c.json({ error: "Dreaming evidence exclusion not found" }, 404);
		return c.json({ requeued: true, agentId, sourceKind, sourceId });
	});

	/**
	 * Daemon apply seam for external Dreaming agents. Unlike generic ontology
	 * operations, every write must carry a canonical episodic source reference
	 * and an exact quote; the daemon resolves it in the caller's agent scope.
	 */
	app.post("/api/dream/operations", async (c) => {
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null) return c.json({ error: "Malformed JSON body" }, 400);
		const body = asRecord(raw);
		const operations = readArray(body, "operations");
		if (!operations || operations.length === 0) return c.json({ error: "operations are required" }, 400);
		if (operations.length > DREAMING_MAX_OPERATIONS_PER_REQUEST) {
			return c.json({ error: `operations cannot exceed ${DREAMING_MAX_OPERATIONS_PER_REQUEST} items` }, 400);
		}
		const scopedAgent = resolveScopedDreamAgent(c, body);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent.agentId;
		const actor = readString(body, "actor") ?? c.req.header("x-signet-actor") ?? "dreaming-agent";
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId,
			actor,
			writeCaps: graphWriteCaps(loadMemoryConfig(AGENTS_DIR)),
			operations: operations.map((rawOperation) => {
				const operation = asRecord(rawOperation);
				return {
					operation: readString(operation, "operation") ?? "",
					payload: asRecord(operation.payload),
					reason: readString(operation, "reason") ?? readString(operation, "rationale"),
					evidence: readArray(operation, "evidence"),
					confidence: readNumber(operation, "confidence"),
					risk: readString(operation, "risk") ?? null,
				};
			}),
		});
		return c.json({ ...result, agentId }, result.ok ? 200 : result.retryable ? 503 : 400);
	});

	// Pi invokes this registry in-process; MCP and CLI use this transport
	// binding. The capability id and input schema are never copied here.
	app.get("/api/dream/tools", (c) => c.json({ items: getDreamingCapabilityManifest() }));
	app.post("/api/dream/tools/:capability", async (c) => {
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null) return c.json({ error: "Malformed JSON body" }, 400);
		const body = asRecord(raw);
		const scopedAgent = resolveScopedDreamAgent(c, body);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const capability = getDreamingCapability(
			{
				accessor: getDbAccessor(),
				agentId: scopedAgent.agentId,
				actor: readString(body, "actor") ?? c.req.header("x-signet-actor") ?? "dreaming-client",
				passId: readString(body, "passId") ?? undefined,
			},
			c.req.param("capability"),
		);
		if (!capability) return c.json({ error: "Unknown Dreaming capability" }, 404);
		const input = asRecord(body.input);
		const requestedInputAgent = readString(input, "agentId");
		if (requestedInputAgent !== undefined && requestedInputAgent !== scopedAgent.agentId) {
			return c.json({ error: "Dreaming capability agent scope does not match the credential" }, 403);
		}
		const result = await capability.invoke({ ...input, agentId: scopedAgent.agentId });
		return c.json({ ...result, agentId: scopedAgent.agentId }, result.ok ? 200 : result.retryable === true ? 503 : 400);
	});

	app.post("/api/dream/trigger", async (c) => {
		const worker = getDreamingWorker();
		if (!worker) {
			return c.json({ error: "Dreaming worker not running" }, 503);
		}

		const contentType = c.req.header("content-type") ?? "";
		let mode: "compact" | "incremental" = "incremental";
		let body: Record<string, unknown> = {};
		if (contentType.includes("application/json")) {
			const raw: unknown = await c.req.json().catch(() => null);
			if (raw === null) {
				return c.json({ error: "Malformed JSON body" }, 400);
			}
			body = asRecord(raw);
			if (body.mode === "compact") {
				mode = "compact";
			}
		}
		const scopedAgent = resolveScopedDreamAgent(c, body);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const agentId = scopedAgent.agentId;

		let passId: string;
		try {
			passId = await worker.triggerAsync(mode, agentId);
		} catch (e) {
			if (e instanceof AlreadyRunningError) return c.json({ error: e.message }, 409);
			const msg = e instanceof Error ? e.message : String(e);
			return c.json({ error: msg }, 500);
		}
		return c.json({ accepted: true, passId, status: "running", mode, agentId }, 202);
	});
}
