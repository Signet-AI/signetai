import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkModeFromBindHost, parseSimpleYaml, readNetworkMode, resolveNetworkBinding } from "@signet/core";
import { type AnalyticsCollector, createAnalyticsCollector } from "../analytics";
import { type AuthConfig, AuthRateLimiter, loadOrCreateSecret, parseAuthConfig } from "../auth";
import { getDbAccessor } from "../db-accessor";
import {
	type DiagnosticsReport,
	type PredictorHealthParams,
	createProviderTracker,
	getDiagnostics,
	getPredictorHealth,
} from "../diagnostics";
import type { EmbeddingTrackerHandle } from "../embedding-tracker";
import { logger } from "../logger";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "../memory-config";
import { enqueueExtractionJob as enqueueExtractionJobBase } from "../pipeline";
import { deadLetterExtractionJob } from "../pipeline/extraction-fallback";
import type { PredictorClient } from "../predictor-client";
import { createRateLimiter } from "../repair-actions";
import type { TelemetryCollector } from "../telemetry";
import { getUpdateState } from "../update-system";

// Paths
export const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
export const DAEMON_DIR = join(AGENTS_DIR, ".daemon");
export const PID_FILE = join(DAEMON_DIR, "pid");
export const LOG_DIR = join(DAEMON_DIR, "logs");
export const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");
export const SCRIPTS_DIR = join(AGENTS_DIR, "scripts");

// Config utilities
export function readEnvTrimmed(key: string): string | undefined {
	const raw = process.env[key];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeBaseUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function normalizeLoopbackHost(host: string): string {
	return host === "localhost" || host === "::1" ? "127.0.0.1" : host;
}

export function parseOriginPort(url: URL): number | null {
	if (url.port.length > 0) {
		const port = Number.parseInt(url.port, 10);
		return Number.isInteger(port) ? port : null;
	}
	if (url.protocol === "http:") return 80;
	if (url.protocol === "https:") return 443;
	return null;
}

export function normalizeOriginHost(host: string): string {
	return host.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackOriginHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}

export function isTailscaleOriginHost(host: string): boolean {
	if (host.endsWith(".ts.net")) return true;
	if (host.startsWith("fd7a:115c:a1e0:")) return true;
	if (!host.startsWith("100.")) return false;
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	const second = Number.parseInt(parts[1], 10);
	return Number.isInteger(second) && second >= 64 && second <= 127;
}

export function parsePort(raw: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

export function normalizeRuntimeBaseUrl(url: string | undefined, fallback: string): string {
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

export function resolveRegistryLlamaCppBaseUrl(provider: string, endpoint: string | undefined): string | undefined {
	if (provider !== "llama-cpp") return undefined;
	return normalizeRuntimeBaseUrl(endpoint, "http://127.0.0.1:8080");
}

export function resolveRegistryOllamaBaseUrl(provider: string, endpoint: string | undefined): string | undefined {
	if (provider !== "ollama") return undefined;
	return normalizeRuntimeBaseUrl(endpoint, "http://127.0.0.1:11434");
}

export function resolveRegistryOpenRouterBaseUrl(provider: string, endpoint: string | undefined): string | undefined {
	if (provider !== "openrouter") return undefined;
	return normalizeRuntimeBaseUrl(endpoint, "https://openrouter.ai/api/v1");
}

export function isManagedOpenCodeLocalEndpoint(baseUrl: string): boolean {
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

export function redactUrlForLogs(url: string | undefined): string | undefined {
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

export function readConfiguredNetworkBinding(agentsDir: string): {
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

// Network constants
export const PORT = parsePort(readEnvTrimmed("SIGNET_PORT"), 3850);
const NET = readConfiguredNetworkBinding(AGENTS_DIR);
export const HOST = normalizeLoopbackHost(readEnvTrimmed("SIGNET_HOST") ?? NET.host);
export const BIND_HOST = normalizeLoopbackHost(readEnvTrimmed("SIGNET_BIND") ?? NET.bind);
export const NETWORK_MODE = networkModeFromBindHost(BIND_HOST);
export const INTERNAL_SELF_HOST = BIND_HOST === "0.0.0.0" || BIND_HOST === "::" ? "127.0.0.1" : BIND_HOST;

// isAllowedOrigin must come after ALLOWED_ORIGINS is defined, so declare origins first
const _ALLOWED_ORIGINS = new Set([
	"http://localhost:3850",
	"http://127.0.0.1:3850",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"app://signet",
]);
export const ALLOWED_ORIGINS = _ALLOWED_ORIGINS;

export function isAllowedOrigin(origin: string | undefined): boolean {
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

// Types
export type RuntimeProviderName =
	| "none"
	| "ollama"
	| "llama-cpp"
	| "claude-code"
	| "opencode"
	| "codex"
	| "anthropic"
	| "openrouter"
	| "command";

export type RuntimeSynthesisProviderName =
	| "none"
	| "ollama"
	| "llama-cpp"
	| "claude-code"
	| "codex"
	| "opencode"
	| "anthropic"
	| "openrouter";

export interface ProviderRuntimeResolution {
	extraction: {
		configured: string | null;
		resolved: RuntimeProviderName;
		effective: RuntimeProviderName;
		fallbackProvider: "llama-cpp" | "ollama" | "none";
		status: "active" | "degraded" | "blocked" | "disabled" | "paused";
		degraded: boolean;
		fallbackApplied: boolean;
		reason: string | null;
		since: string | null;
	};
	synthesis: {
		configured: string | null;
		resolved: RuntimeSynthesisProviderName | null;
		effective: RuntimeSynthesisProviderName | null;
	};
}

// Runtime state singletons
export const providerRuntimeResolution: ProviderRuntimeResolution = {
	extraction: {
		configured: null,
		resolved: "claude-code",
		effective: "claude-code",
		fallbackProvider: "llama-cpp",
		status: "active",
		degraded: false,
		fallbackApplied: false,
		reason: null,
		since: null,
	},
	synthesis: {
		configured: null,
		resolved: null,
		effective: null,
	},
};

export let telemetryRef: TelemetryCollector | undefined;
export let embeddingTrackerHandle: EmbeddingTrackerHandle | null = null;
export let predictorClientRef: PredictorClient | null = null;
export let pipelineTransition = false;
export const harnessLastSeen = new Map<string, string>();
export let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
export let checkpointPruneTimer: ReturnType<typeof setInterval> | undefined;
export let shuttingDown = false;
export const bindAbort = new AbortController();
export let diagnosticsCache: {
	readonly report: DiagnosticsReport;
	readonly expiresAt: number;
} | null = null;
export const DIAGNOSTICS_CACHE_TTL_MS = 2000;

// OpenClaw health state
export interface OpenClawHeartbeatData {
	readonly pluginVersion: string;
	readonly hooksRegistered: string[];
	readonly lastHookCall: string | null;
	readonly lastError: string | null;
	readonly latencyMs: number;
	readonly lastFailedDelta: number;
	readonly totalSucceeded: number;
	readonly totalFailed: number;
}
export let openClawHeartbeat: { timestamp: string; data: OpenClawHeartbeatData } | null = null;
export const OPENCLAW_STALE_MS = 10 * 60 * 1000;

// Projection state
export const projectionInFlight = new Map<number, Promise<void>>();
export const projectionErrors = new Map<number, { message: string; expires: number }>();
export const PROJECTION_ERROR_TTL_MS = 30_000;
export const hasMemoriesSessionIdColumnCache: boolean | null = null;

// Auth state
export let authConfig: AuthConfig = parseAuthConfig(undefined, AGENTS_DIR);
export let authSecret: Buffer | null = null;
export let authForgetLimiter = new AuthRateLimiter(60_000, 30);
export let authModifyLimiter = new AuthRateLimiter(60_000, 60);
export let authBatchForgetLimiter = new AuthRateLimiter(60_000, 5);
export let authAdminLimiter = new AuthRateLimiter(60_000, 10);
export let authRecallLlmLimiter = new AuthRateLimiter(60_000, 60);
export const authCrossAgentMessageLimiter = new AuthRateLimiter(60_000, 120);

// Provider tracker and analytics singletons
export const providerTracker = createProviderTracker();
export const analyticsCollector = createAnalyticsCollector();
export const repairLimiter = createRateLimiter();

export function queueExtractionJob(memoryId: string): void {
	if (providerRuntimeResolution.extraction.status === "blocked") {
		deadLetterExtractionJob(getDbAccessor(), memoryId, {
			reason: providerRuntimeResolution.extraction.reason ?? "Configured extraction provider unavailable at startup",
		});
		return;
	}
	enqueueExtractionJobBase(getDbAccessor(), memoryId);
}

// Version
function getDaemonVersion(): string {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = join(__filename, "..");

	const candidates = [
		join(__dirname, "..", "package.json"),
		join(__dirname, "..", "..", "signetai", "package.json"),
		join(__dirname, "..", "..", "package.json"),
	];

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const raw = readFileSync(candidate, "utf8");
			const parsed = JSON.parse(raw) as { version?: unknown };
			if (typeof parsed.version === "string" && parsed.version) {
				return parsed.version;
			}
		} catch {
			// skip
		}
	}

	return "0.0.0";
}

export const CURRENT_VERSION = getDaemonVersion();

// Diagnostics helpers
export function invalidateDiagnosticsCache(): void {
	diagnosticsCache = null;
}

export function buildOpenClawHealth(): import("../diagnostics").OpenClawHealth {
	if (!openClawHeartbeat) {
		return {
			status: "never-seen",
			lastHeartbeat: null,
			pluginVersion: null,
			hooksRegistered: [],
			hooksSucceeded: 0,
			hooksFailed: 0,
			lastLatencyMs: 0,
			lastError: null,
		};
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

export function getCachedDiagnosticsReport(): DiagnosticsReport {
	const now = Date.now();
	if (diagnosticsCache !== null && diagnosticsCache.expiresAt > now) {
		return diagnosticsCache.report;
	}

	const report = getDbAccessor().withReadDb((db: Database) =>
		getDiagnostics(db, providerTracker, getUpdateState(), buildPredictorHealthParams(), buildOpenClawHealth()),
	);
	diagnosticsCache = {
		report,
		expiresAt: now + DIAGNOSTICS_CACHE_TTL_MS,
	};
	return report;
}

export function buildPredictorHealthParams(): PredictorHealthParams {
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

export function setPipelineTransition(value: boolean): void {
	pipelineTransition = value;
}

export function setTelemetryRef(value: TelemetryCollector | undefined): void {
	telemetryRef = value;
}

export function setPredictorClientRef(value: PredictorClient | null): void {
	predictorClientRef = value;
}

export function setHeartbeatTimer(value: ReturnType<typeof setInterval> | undefined): void {
	heartbeatTimer = value;
}

export function setCheckpointPruneTimer(value: ReturnType<typeof setInterval> | undefined): void {
	checkpointPruneTimer = value;
}

export function setShuttingDown(value: boolean): void {
	shuttingDown = value;
}

export function setEmbeddingTrackerHandle(value: EmbeddingTrackerHandle | null): void {
	embeddingTrackerHandle = value;
}

export function reloadAuthState(agentsDir: string): void {
	const cfg = loadMemoryConfig(agentsDir);
	if (!cfg.auth) throw new Error("Missing auth section in agent.yaml");
	if (!cfg.auth.rateLimits) throw new Error("Missing rateLimits in auth config");

	authConfig = cfg.auth;
	authSecret = authConfig.mode !== "local" ? loadOrCreateSecret(authConfig.secretPath) : null;

	if (authConfig.mode !== "local" && !authSecret) {
		logger.error(
			"auth",
			"reloadAuthState: token/team mode active but authSecret is null — all non-local requests will be rejected with 503",
		);
	}

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
	authAdminLimiter = rl.admin ? new AuthRateLimiter(rl.admin.windowMs, rl.admin.max) : new AuthRateLimiter(60_000, 10);
	authRecallLlmLimiter = rl.recallLlm
		? new AuthRateLimiter(rl.recallLlm.windowMs, rl.recallLlm.max)
		: new AuthRateLimiter(60_000, 60);
}

export function setOpenClawHeartbeat(value: { timestamp: string; data: OpenClawHeartbeatData } | null): void {
	openClawHeartbeat = value;
}

// Feature flag and session helpers that use AGENTS_DIR
export { AGENTS_DIR as default };

export { getUpdateState };

function readPipelineMode(cfg: ResolvedMemoryConfig["pipelineV2"]): string {
	if (!cfg.enabled) return "disabled";
	if (cfg.paused) return "paused";
	if (cfg.mutationsFrozen) return "frozen";
	if (cfg.nativeShadowEnabled) return "shadow";
	if (cfg.shadowMode) return "shadow";
	return "controlled-write";
}

export { readPipelineMode };

export let restartPipelineRuntimeRef:
	| ((memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector) => Promise<void>)
	| null = null;

export function setRestartPipelineRuntime(
	fn: (memoryCfg: ResolvedMemoryConfig, telemetry?: TelemetryCollector) => Promise<void>,
): void {
	restartPipelineRuntimeRef = fn;
}
