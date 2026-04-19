import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSimpleYaml, readPipelinePauseState, setPipelinePaused } from "@signet/core";
import type { Context, Hono } from "hono";
import { resolveAgentId } from "../agent-id.js";
import { requirePermission, requireRateLimit } from "../auth";
import { getDbAccessor } from "../db-accessor.js";
import { getLlmProvider } from "../llm.js";
import { loadMemoryConfig } from "../memory-config.js";
import {
	getDreamingPasses,
	getDreamingState,
	getDreamingWorker,
	getPipelineWorkerStatus,
	nudgeExtractionWorker,
} from "../pipeline";
import { getFeedbackTelemetry } from "../pipeline/aspect-feedback.js";
import { AlreadyRunningError } from "../pipeline/dreaming-worker.js";
import { getTraversalStatus } from "../pipeline/graph-traversal.js";
import {
	getAvailableModels,
	getModelsByProvider,
	getRegistryStatus,
	refreshRegistry,
} from "../pipeline/model-registry.js";
import { getSecret } from "../secrets.js";
import { activeSessionCount, getBypassedSessionKeys } from "../session-tracker.js";
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
	getUpdateState,
	invalidateDiagnosticsCache,
	openClawHeartbeat,
	pipelineTransition,
	predictorClientRef,
	providerRuntimeResolution,
	readEnvTrimmed,
	readPipelineMode,
	resolveRegistryLlamaCppBaseUrl,
	resolveRegistryOllamaBaseUrl,
	resolveRegistryOpenRouterBaseUrl,
	restartPipelineRuntimeRef,
	setOpenClawHeartbeat,
	setPipelineTransition,
	telemetryRef,
} from "./state.js";
import { STATUS_CACHE_TTL, cachedEmbeddingStatus, statusCacheTime } from "./utils.js";

const pipelineAdminGuard = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
	const permDenied = await requirePermission("admin", authConfig)(c, () => Promise.resolve());
	if (permDenied) return permDenied;
	const rateDenied = await requireRateLimit("admin", authAdminLimiter, authConfig)(c, () => Promise.resolve());
	if (rateDenied) return rateDenied;
	await next();
};

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
		logger.error("pipeline", paused ? "Failed to pause pipeline" : "Failed to resume pipeline", err instanceof Error ? err : new Error(String(err)));
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
	app.use("/api/predictor/*", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});

	app.get("/api/status", (c) => {
		const config = loadMemoryConfig(AGENTS_DIR);
		const workerStatus = getPipelineWorkerStatus();
		const extractionWorker = workerStatus.extraction;
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
			pipeline: {
				extraction: {
					running: extractionWorker.running,
					overloaded: extractionWorker.stats?.overloaded ?? false,
					loadPerCpu: extractionWorker.stats?.loadPerCpu ?? null,
					maxLoadPerCpu: extractionWorker.stats?.maxLoadPerCpu ?? null,
					overloadBackoffMs: extractionWorker.stats?.overloadBackoffMs ?? null,
					overloadSince: extractionWorker.stats?.overloadSince ?? null,
					nextTickInMs: extractionWorker.stats?.nextTickInMs ?? null,
				},
			},
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
				...(cachedEmbeddingStatus && Date.now() - statusCacheTime < STATUS_CACHE_TTL
					? { available: cachedEmbeddingStatus.available }
					: {}),
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

		const dbData = accessor.withReadDb((db) => {
			const memoryRows = db
				.prepare("SELECT status, COUNT(*) as count FROM memory_jobs GROUP BY status")
				.all() as Array<{
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
			resolveRegistryLlamaCppBaseUrl(cfg.pipelineV2.extraction.provider, cfg.pipelineV2.extraction.endpoint),
		);
		return c.json({
			models: getModelsByProvider(),
			registry: getRegistryStatus(),
		});
	});

	app.use("/api/dream/*", async (c, next) => {
		return requirePermission("admin", authConfig)(c, next);
	});

	app.get("/api/dream/status", (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const accessor = getDbAccessor();
		const agentId = resolveAgentId({
			agentId: c.req.query("agentId") ?? c.req.header("x-signet-agent-id"),
		});

		const state = getDreamingState(accessor, agentId);
		const passes = getDreamingPasses(accessor, agentId, 10);
		const defaultAgent = resolveAgentId({});
		const worker = agentId === defaultAgent ? getDreamingWorker() : null;

		return c.json({
			enabled: cfg.dreaming.enabled,
			worker: { running: worker !== null, active: worker?.running ?? false },
			state,
			config: {
				tokenThreshold: cfg.dreaming.tokenThreshold,
				backfillOnFirstRun: cfg.dreaming.backfillOnFirstRun,
				maxInputTokens: cfg.dreaming.maxInputTokens,
				maxOutputTokens: cfg.dreaming.maxOutputTokens,
				timeout: cfg.dreaming.timeout,
			},
			passes,
		});
	});

	app.post("/api/dream/trigger", async (c) => {
		const worker = getDreamingWorker();
		if (!worker) {
			return c.json({ error: "Dreaming worker not running" }, 503);
		}

		const contentType = c.req.header("content-type") ?? "";
		let mode: "compact" | "incremental" = "incremental";
		if (contentType.includes("application/json")) {
			const raw: unknown = await c.req.json().catch(() => null);
			if (raw === null) {
				return c.json({ error: "Malformed JSON body" }, 400);
			}
			if (typeof raw === "object") {
				const body = raw as { mode?: unknown };
				if (body.mode === "compact") {
					mode = "compact";
				}
			}
		}

		let passId: string;
		try {
			passId = worker.triggerAsync(mode);
		} catch (e) {
			if (e instanceof AlreadyRunningError) return c.json({ error: e.message }, 409);
			const msg = e instanceof Error ? e.message : String(e);
			return c.json({ error: msg }, 500);
		}
		return c.json({ accepted: true, passId, status: "running", mode }, 202);
	});

	app.get("/api/predictor/status", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const predictorCfg = cfg.pipelineV2.predictor;

		if (!predictorCfg?.enabled) {
			return c.json({ enabled: false, status: null });
		}

		const client = predictorClientRef;
		if (client == null) {
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
}
