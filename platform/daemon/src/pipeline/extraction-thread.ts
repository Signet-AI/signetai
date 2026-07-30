/**
 * Worker thread entry point for the extraction pipeline.
 *
 * Runs inside a node:worker_threads Worker. Self-initializes from
 * WorkerInit passed via workerData:
 *   1. Opens own bun:sqlite connection via initDbAccessorLite()
 *   2. Creates own inference router from agentsDir config files
 *   3. Calls startWorker() with a LogSink that forwards to main via IPC
 *   4. Listens for stop/nudge control messages from main thread
 *   5. Forwards stats periodically
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { LlmProvider } from "@signet/core";
import type { AnalyticsCollector } from "../analytics";
import { getDbAccessor } from "../db-accessor";
import { initDbAccessorLite } from "../db-accessor";
import { fetchEmbedding } from "../embedding-fetch";
import type { EmbeddingConfig, MemorySearchConfig, PipelineV2Config } from "../memory-config";
import { configureNativeEmbeddingAssets } from "../native-embedding";
import type { TelemetryCollector } from "../telemetry";
import type { DecisionConfig } from "./decision";
import type { MainToWorkerMessage, WorkerInit, WorkerToMainMessage } from "./extraction-thread-protocol";
import type { LogSink } from "./worker";
import { startWorker } from "./worker";

// ---------------------------------------------------------------------------
// Guard: must run as a worker thread
// ---------------------------------------------------------------------------

if (isMainThread) {
	throw new Error("extraction-thread.ts must be loaded as a worker thread");
}

const port = parentPort;
if (!port) throw new Error("parentPort unavailable");
const workerPort = port;
const init = workerData as WorkerInit;

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function send(msg: WorkerToMainMessage): void {
	workerPort.postMessage(msg);
}

const pendingGenerate = new Map<
	string,
	{ readonly resolve: (value: string) => void; readonly reject: (error: Error) => void }
>();
let generateSeq = 0;

function createMainThreadProviderProxy(): LlmProvider {
	return {
		name: "main-thread-proxy",
		generate(prompt, opts) {
			const id = `generate-${++generateSeq}`;
			return new Promise<string>((resolve, reject) => {
				pendingGenerate.set(id, { resolve, reject });
				send({
					type: "generate",
					id,
					prompt,
					options: {
						timeoutMs: opts?.timeoutMs,
						maxTokens: opts?.maxTokens,
						temperature: opts?.temperature,
						responseFormat: opts?.responseFormat,
						think: opts?.think,
					},
				});
			});
		},
		async generateWithUsage(prompt, opts) {
			const text = await this.generate(prompt, opts);
			return { text, usage: null };
		},
		async available() {
			return true;
		},
	};
}

// ---------------------------------------------------------------------------
// LogSink that forwards to main thread via IPC
// ---------------------------------------------------------------------------

const ipcLog: LogSink = {
	info(category: string, message: string, data?: Record<string, unknown>): void {
		send({ type: "log", level: "info", category, message, data });
	},
	warn(category: string, message: string, data?: Record<string, unknown>): void {
		send({ type: "log", level: "warn", category, message, data });
	},
	error(category: string, message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
		const errStr = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
		const merged = errStr ? { ...data, errorMessage: errStr } : data;
		send({ type: "log", level: "error", category, message, data: merged });
	},
};

// ---------------------------------------------------------------------------
// IPC proxy collectors — forward analytics/telemetry to main thread
// ---------------------------------------------------------------------------

/** Proxy that forwards telemetry.record() calls to the main thread via IPC. */
const ipcTelemetry: TelemetryCollector = {
	enabled: true,
	record(event, properties): void {
		send({ type: "telemetry", event, data: properties as Record<string, unknown> });
	},
	/* Lifecycle and query methods are no-ops — the main thread owns the store. */
	flush: () => Promise.resolve(),
	start(): void {},
	stop: () => Promise.resolve(),
	query: () => [],
};

/** Proxy that forwards analytics calls to the main thread via IPC. */
const ipcAnalytics: AnalyticsCollector = {
	recordRequest(method, path, status, durationMs, actor): void {
		send({ type: "analytics", method: "recordRequest", args: [method, path, status, durationMs, actor] });
	},
	recordProvider(provider, durationMs, success): void {
		send({ type: "analytics", method: "recordProvider", args: [provider, durationMs, success] });
	},
	recordConnector(connectorId, event, count): void {
		send({ type: "analytics", method: "recordConnector", args: [connectorId, event, count] });
	},
	recordError(entry): void {
		send({ type: "analytics", method: "recordError", args: [entry] });
	},
	recordLatency(operation, ms): void {
		send({ type: "analytics", method: "recordLatency", args: [operation, ms] });
	},
	/* Query/read methods are no-ops — the main thread owns the store. */
	getUsage: () => ({ endpoints: {}, actors: {}, providers: {}, connectors: {} }),
	getErrors: () => [],
	getErrorSummary: () => ({}),
	getLatency: () => ({}) as ReturnType<AnalyticsCollector["getLatency"]>,
	reset(): void {},
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const STATS_INTERVAL_MS = 10_000;

async function bootstrap(): Promise<void> {
	try {
		// Configure pre-resolved native embedding asset paths BEFORE any
		// embedding can happen. The extraction worker thread has an isolated
		// globalThis — `globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__` is not
		// registered here, so resolveEmbeddedWorkerPath() returns null and
		// the embedding worker crashes with ModuleNotFound when the
		// extraction thread tries to spawn its own embedding sub-worker (#922).
		// The main thread resolves these paths and passes them via WorkerInit.
		if (
			init.nativeEmbeddingWorkerPath !== undefined ||
			init.nativeWasmDir !== undefined ||
			init.nativeTransformersRuntimePath !== undefined
		) {
			configureNativeEmbeddingAssets({
				embeddingWorkerPath: init.nativeEmbeddingWorkerPath ?? null,
				wasmAssetDir: init.nativeWasmDir ?? null,
				transformersRuntimeAssetPath: init.nativeTransformersRuntimePath ?? null,
			});
		}

		// 1. Init DB — opens own bun:sqlite WAL connection
		initDbAccessorLite(init.dbPath, init.vecExtensionPath);
		const accessor = getDbAccessor();

		const provider = createMainThreadProviderProxy();

		// 3. Reconstruct typed configs from serialized workerData
		const pipelineCfg = init.pipelineConfig as unknown as PipelineV2Config;
		const embeddingCfg = init.embeddingConfig as unknown as EmbeddingConfig;
		const searchCfg = init.searchConfig as unknown as MemorySearchConfig;

		const decisionCfg: DecisionConfig = {
			embedding: embeddingCfg,
			search: searchCfg,
			timeoutMs: pipelineCfg.extraction.timeout,
			fetchEmbedding: (text: string, cfg: EmbeddingConfig, role) => fetchEmbedding(text, cfg, role),
		};

		// 4. Start extraction worker with IPC-backed instrumentation
		const handle = startWorker(
			accessor,
			provider,
			pipelineCfg,
			decisionCfg,
			ipcAnalytics,
			ipcTelemetry,
			undefined,
			ipcLog,
		);

		// 5. Forward stats periodically
		const statsTimer = setInterval(() => {
			send({ type: "stats", stats: handle.stats });
		}, STATS_INTERVAL_MS);

		// 6. Listen for control messages from main thread
		workerPort.on("message", async (msg: MainToWorkerMessage) => {
			if (msg.type === "stop") {
				for (const [id, pending] of pendingGenerate) {
					pending.reject(new Error("extraction worker stopped"));
					pendingGenerate.delete(id);
				}
				clearInterval(statsTimer);
				await handle.stop();
				send({ type: "stopped" });
			} else if (msg.type === "nudge") {
				handle.nudge();
			} else if (msg.type === "generateResult") {
				const pending = pendingGenerate.get(msg.id);
				if (!pending) return;
				pendingGenerate.delete(msg.id);
				pending.resolve(msg.text);
			} else if (msg.type === "generateError") {
				const pending = pendingGenerate.get(msg.id);
				if (!pending) return;
				pendingGenerate.delete(msg.id);
				pending.reject(new Error(msg.error));
			}
		});

		// 7. Signal ready
		send({ type: "ready" });
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		send({ type: "error", error: error.message, stack: error.stack });
		process.exit(1);
	}
}

bootstrap();
