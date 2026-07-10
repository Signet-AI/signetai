/**
 * Main-thread adapter for the native embedding worker.
 *
 * Spawns a node:worker_threads Worker running embedding-worker.ts and
 * exposes the embedding provider contract used by the rest of the daemon
 * (native-embedding.ts facade). All potentially-long work happens in the
 * worker; this handle never blocks the main event loop:
 *
 *   - getStatus() is synchronous — it returns a cache fed by proactive
 *     "status" pushes from the worker, so /health and status endpoints
 *     never await the worker.
 *   - embed()/checkAvailable() are RPC calls, each bounded by a
 *     Promise.race timeout. If the worker is grinding (e.g. stuck on an
 *     unreachable model CDN), these fail fast and mark the provider
 *     unavailable instead of hanging — but crucially the main loop keeps
 *     serving other requests the entire time, because the grinding happens
 *     in the worker, not here.
 *
 * Mirrors the established worker pattern (see pipeline/extraction-thread-handle.ts):
 * embedded-worker-asset fallback for the compiled binary, workerData init,
 * ready handshake with timeout, injectable workerFactory for tests.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { resolveDefaultBasePath } from "@signet/core";
import type {
	EmbeddingWorkerInit,
	EmbeddingWorkerStatus,
	MainToWorkerMessage,
	WorkerToMainMessage,
} from "./embedding-worker-protocol";
import { logger } from "./logger";
import { materializeEmbeddedWasmAssets, resolveEmbeddedWorkerPath } from "./native-runtime-assets";

// ---------------------------------------------------------------------------
// Constants (overridable via options for deterministic tests)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
const DEFAULT_DIMENSIONS = 768;
const READY_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 90_000; // first-run model download can take a while
const EMBED_TIMEOUT_MS = 15_000;
const COOLDOWN_MS = 300_000; // match prior in-process behaviour

// ---------------------------------------------------------------------------
// Injectable worker surface (for tests)
// ---------------------------------------------------------------------------

export interface EmbeddingWorkerLike {
	on(event: "message", listener: (msg: WorkerToMainMessage) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
	on(event: "exit", listener: (code: number) => void): unknown;
	postMessage(msg: MainToWorkerMessage): void;
	terminate(): Promise<number> | number;
}

export type EmbeddingWorkerFactory = (
	workerPath: string,
	init: EmbeddingWorkerInit,
	options: WorkerOptions,
) => EmbeddingWorkerLike;

export interface EmbeddingHandleOptions {
	readonly modelId?: string;
	readonly expectedDimensions?: number;
	readonly cacheDir?: string;
	/** Test seam: point transformers env.remoteHost at a local blackhole. */
	readonly remoteHostOverride?: string;
	readonly workerFactory?: EmbeddingWorkerFactory;
	readonly readyTimeoutMs?: number;
	readonly initTimeoutMs?: number;
	readonly embedTimeoutMs?: number;
	readonly cooldownMs?: number;
}

interface PendingRpc {
	readonly resolve: (value: unknown) => void;
	readonly reject: (err: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export interface EmbeddingProviderStatus {
	readonly available: boolean;
	readonly error?: string;
	readonly dimensions: number;
	readonly modelCached: boolean;
}

export interface EmbeddingProviderSnapshot {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly modelCached: boolean;
}

export interface EmbeddingWorkerHandle {
	embed(text: string): Promise<number[]>;
	checkAvailable(): Promise<EmbeddingProviderStatus>;
	getStatus(): EmbeddingProviderSnapshot;
	getLastError(): string | null;
	stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createEmbeddingWorkerHandle(opts: EmbeddingHandleOptions = {}): Promise<EmbeddingWorkerHandle> {
	const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
	const dimensions = opts.expectedDimensions ?? DEFAULT_DIMENSIONS;
	const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
	const initTimeoutMs = opts.initTimeoutMs ?? INIT_TIMEOUT_MS;
	const embedTimeoutMs = opts.embedTimeoutMs ?? EMBED_TIMEOUT_MS;
	const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;

	const cacheDir = opts.cacheDir ?? join(resolveDefaultBasePath(), ".models");
	// Main thread owns the compiled-binary asset globals; materialize WASM
	// here and hand the directory to the worker (which has an isolated
	// globalThis and cannot read them itself). Null in source mode, where
	// onnxruntime-wasm resolves its .wasm from node_modules.
	const wasmDir = materializeEmbeddedWasmAssets();

	const init: EmbeddingWorkerInit = {
		cacheDir,
		wasmDir,
		modelId,
		expectedDimensions: dimensions,
		...(opts.remoteHostOverride ? { remoteHostOverride: opts.remoteHostOverride } : {}),
	};

	const __dirname = dirname(fileURLToPath(import.meta.url));
	const bundled = join(__dirname, "embedding-worker.js");
	const workerPath = existsSync(bundled)
		? bundled
		: (resolveEmbeddedWorkerPath("embedding-worker") ?? join(__dirname, "embedding-worker.ts"));
	const workerOptions = { workerData: init, type: "module" } as const;
	const worker = (opts.workerFactory ?? createNodeWorker)(workerPath, init, workerOptions);

	let nextId = 1;
	const pending = new Map<number, PendingRpc>();
	let status: EmbeddingWorkerStatus = { initialized: false, initializing: false, modelCached: false, error: null };
	let lastError: string | null = null;
	let lastFailureAt = 0;
	let stopped = false;

	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const readyTimer = setTimeout(() => {
		// If the worker never signals ready, unblock anyway so callers fail
		// fast via RPC (the worker may have crashed before its first post).
		resolveReady();
	}, readyTimeoutMs);
	readyTimer.unref?.();

	function clearPending(id: number): PendingRpc | undefined {
		const entry = pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			pending.delete(id);
		}
		return entry;
	}

	function failAllPending(err: Error): void {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
		pending.clear();
	}

	function sendRpc(kind: "embed" | "checkAvailable", timeoutMs: number, extra?: { text: string }): number {
		const id = nextId++;
		const msg: MainToWorkerMessage =
			kind === "embed" ? { type: "embed", id, text: extra?.text ?? "" } : { type: "checkAvailable", id };
		worker.postMessage(msg);
		return id;
	}

	function rpc<T>(kind: "embed" | "checkAvailable", timeoutMs: number, extra?: { text: string }): Promise<T> {
		return ready.then(
			() =>
				new Promise<T>((resolve, reject) => {
					const id = sendRpc(kind, timeoutMs, extra);
					const timer = setTimeout(() => {
						if (pending.has(id)) {
							clearPending(id);
							const message = `${kind} timed out after ${timeoutMs}ms (worker isolated; provider marked unavailable)`;
							lastError = message;
							lastFailureAt = Date.now();
							status = { ...status, initialized: false, initializing: false, error: message };
							logger.warn("native-embedding", message);
							reject(new Error(message));
						}
					}, timeoutMs);
					pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
				}),
		);
	}

	// Single message listener: resolves the ready handshake on first "ready",
	// then dispatches everything else.
	worker.on("message", (msg: WorkerToMainMessage) => {
		switch (msg.type) {
			case "ready":
				clearTimeout(readyTimer);
				resolveReady();
				break;
			case "status":
				status = msg.status;
				if (msg.status.error) lastError = msg.status.error;
				break;
			case "embed_result": {
				const entry = clearPending(msg.id);
				entry?.resolve(msg.vector);
				break;
			}
			case "embed_error": {
				const entry = clearPending(msg.id);
				if (entry) {
					lastError = msg.error;
					entry.reject(new Error(msg.error));
				}
				break;
			}
			case "check_result": {
				const entry = clearPending(msg.id);
				if (entry) {
					if (!msg.available) {
						lastError = msg.error ?? "native embedding unavailable";
						lastFailureAt = Date.now();
					}
					entry.resolve({
						available: msg.available,
						error: msg.error ?? undefined,
						dimensions,
						modelCached: status.modelCached,
					});
				}
				break;
			}
			case "log": {
				const message = msg.message;
				if (msg.level === "error") {
					logger.error("native-embedding", message, undefined, msg.data);
				} else if (msg.level === "warn") {
					logger.warn("native-embedding", message, msg.data);
				} else {
					logger.info("native-embedding", message, msg.data);
				}
				break;
			}
			case "error":
				logger.error("native-embedding", "Embedding worker error", undefined, { error: msg.error, stack: msg.stack });
				lastError = msg.error;
				break;
		}
	});

	worker.on("error", (err: Error) => {
		logger.error("native-embedding", "Embedding worker crashed", err);
		lastError = err.message;
		lastFailureAt = Date.now();
		status = { initialized: false, initializing: false, modelCached: false, error: err.message };
		failAllPending(new Error(`Embedding worker crashed: ${err.message}`));
	});

	worker.on("exit", (code: number) => {
		if (!stopped && code !== 0) {
			logger.warn("native-embedding", "Embedding worker exited unexpectedly", { code });
		}
		status = {
			initialized: false,
			initializing: false,
			modelCached: false,
			error: lastError ?? `worker exited (${code})`,
		};
		failAllPending(new Error(`Embedding worker exited (code ${code})`));
	});

	function inCooldown(): boolean {
		return lastFailureAt > 0 && Date.now() - lastFailureAt < cooldownMs;
	}

	const handle: EmbeddingWorkerHandle = {
		async embed(text: string): Promise<number[]> {
			if (stopped) throw new Error("Native embedding provider shut down");
			if (inCooldown()) throw new Error(lastError ?? "Native embedding init on cooldown");
			return rpc<number[]>("embed", embedTimeoutMs, { text });
		},

		async checkAvailable(): Promise<EmbeddingProviderStatus> {
			if (stopped) {
				return { available: false, error: "Native embedding provider shut down", dimensions, modelCached: false };
			}
			if (inCooldown()) {
				return {
					available: false,
					error: lastError ?? "Native embedding init on cooldown",
					dimensions,
					modelCached: false,
				};
			}
			// checkAvailable triggers init (model download), so it gets the init budget.
			// Resolves with {available:false} on timeout/failure to preserve the
			// checkNativeProvider contract (callers like /api/embeddings/health do
			// not catch). Only embed() rejects.
			try {
				return await rpc<EmbeddingProviderStatus>("checkAvailable", initTimeoutMs);
			} catch (err) {
				return {
					available: false,
					error: err instanceof Error ? err.message : String(err),
					dimensions,
					modelCached: false,
				};
			}
		},

		getStatus(): EmbeddingProviderSnapshot {
			return {
				initialized: status.initialized,
				initializing: status.initializing,
				modelCached: status.modelCached,
			};
		},

		getLastError(): string | null {
			return lastError;
		},

		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			try {
				worker.postMessage({ type: "shutdown" });
			} catch {
				// worker may already be gone
			}
			failAllPending(new Error("Native embedding provider shut down"));
			// A real Worker.terminate() resolves once the thread is gone; a fake
			// returns a sync number. Either way this bounds teardown without
			// waiting on an "exit" event the peer may never emit.
			try {
				const result = worker.terminate();
				if (result && typeof (result as Promise<unknown>).then === "function") {
					await result;
				}
			} catch {
				// best-effort
			}
			logger.info("native-embedding", "Provider shut down");
		},
	};

	return handle;
}

function createNodeWorker(workerPath: string, _init: EmbeddingWorkerInit, options: WorkerOptions): EmbeddingWorkerLike {
	// node:worker_threads Worker structurally satisfies EmbeddingWorkerLike
	// (on/postMessage/terminate). Exposed as a factory so tests inject a fake.
	return new Worker(workerPath, options) as unknown as EmbeddingWorkerLike;
}
