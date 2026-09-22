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

const DEFAULT_MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
const DEFAULT_DIMENSIONS = 768;
const READY_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 90_000;
const EMBED_TIMEOUT_MS = 15_000;
const COOLDOWN_MS = 300_000;

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
	readonly remoteHostOverride?: string;
	readonly workerFactory?: EmbeddingWorkerFactory;
	readonly readyTimeoutMs?: number;
	readonly initTimeoutMs?: number;
	readonly embedTimeoutMs?: number;
	readonly cooldownMs?: number;
	readonly embeddingWorkerPath?: string | null;
	readonly wasmAssetDir?: string | null;
	readonly transformersRuntimeAssetPath?: string | null;
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
	isPermanentlyDisabled(): boolean;
	stop(): Promise<void>;
}

export async function createEmbeddingWorkerHandle(opts: EmbeddingHandleOptions = {}): Promise<EmbeddingWorkerHandle> {
	const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
	const dimensions = opts.expectedDimensions ?? DEFAULT_DIMENSIONS;
	const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
	const initTimeoutMs = opts.initTimeoutMs ?? INIT_TIMEOUT_MS;
	const embedTimeoutMs = opts.embedTimeoutMs ?? EMBED_TIMEOUT_MS;
	const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;

	const cacheDir = opts.cacheDir ?? join(resolveDefaultBasePath(), ".models");
	const wasmDir = opts.wasmAssetDir !== undefined ? opts.wasmAssetDir : materializeEmbeddedWasmAssets();
	const transformersRuntimePath =
		opts.transformersRuntimeAssetPath !== undefined
			? opts.transformersRuntimeAssetPath
			: resolveEmbeddedWorkerPath("embedding-worker-transformers-runtime");

	const init: EmbeddingWorkerInit = {
		cacheDir,
		wasmDir,
		transformersRuntimePath,
		modelId,
		expectedDimensions: dimensions,
		...(opts.remoteHostOverride ? { remoteHostOverride: opts.remoteHostOverride } : {}),
	};

	const __dirname = dirname(fileURLToPath(import.meta.url));
	const bundled = join(__dirname, "embedding-worker.js");
	const workerPath =
		opts.embeddingWorkerPath !== undefined
			? (opts.embeddingWorkerPath ?? join(__dirname, "embedding-worker.ts"))
			: existsSync(bundled)
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
	let disabled = false;
	let embedQueue: Promise<void> = Promise.resolve();

	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const readyTimer = setTimeout(() => {
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

	function sendRpc(kind: "embed" | "checkAvailable", extra?: { text: string }): number {
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
					const id = sendRpc(kind, extra);
					const timer = setTimeout(() => {
						if (pending.has(id)) {
							clearPending(id);
							const message =
								kind === "embed"
									? `embed timed out after ${timeoutMs}ms (worker isolated; provider disabled until daemon restart)`
									: `checkAvailable timed out after ${timeoutMs}ms (worker isolated; provider marked unavailable)`;
							lastError = message;
							lastFailureAt = Date.now();
							status = { ...status, initialized: false, initializing: false, error: message };
							logger.warn("native-embedding", message);
							reject(new Error(message));
							if (kind === "embed") {
								disabled = true;
								try {
									const result = worker.terminate();
									if (result && typeof (result as Promise<unknown>).then === "function") {
										void Promise.resolve(result).catch(() => {});
									}
								} catch {}
							}
						}
					}, timeoutMs);
					pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
				}),
		);
	}
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
		if (!stopped && !disabled && code !== 0) {
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
			const run = embedQueue.then(() => {
				if (stopped) throw new Error("Native embedding provider shut down");
				if (disabled) throw new Error(lastError ?? "Native embedding provider disabled until daemon restart");
				if (inCooldown()) throw new Error(lastError ?? "Native embedding init on cooldown");
				return rpc<number[]>("embed", embedTimeoutMs, { text });
			});
			embedQueue = run.then(
				() => {},
				() => {},
			);
			return run;
		},

		async checkAvailable(): Promise<EmbeddingProviderStatus> {
			if (stopped) {
				return { available: false, error: "Native embedding provider shut down", dimensions, modelCached: false };
			}
			if (disabled) {
				return {
					available: false,
					error: lastError ?? "Native embedding provider disabled until daemon restart",
					dimensions,
					modelCached: false,
				};
			}
			if (inCooldown()) {
				return {
					available: false,
					error: lastError ?? "Native embedding init on cooldown",
					dimensions,
					modelCached: false,
				};
			}
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

		isPermanentlyDisabled(): boolean {
			return disabled;
		},

		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			try {
				worker.postMessage({ type: "shutdown" });
			} catch {}
			failAllPending(new Error("Native embedding provider shut down"));
			try {
				const result = worker.terminate();
				if (result && typeof (result as Promise<unknown>).then === "function") {
					await result;
				}
			} catch {}
			logger.info("native-embedding", "Provider shut down");
		},
	};

	return handle;
}

function createNodeWorker(workerPath: string, _init: EmbeddingWorkerInit, options: WorkerOptions): EmbeddingWorkerLike {
	return new Worker(workerPath, options) as unknown as EmbeddingWorkerLike;
}
