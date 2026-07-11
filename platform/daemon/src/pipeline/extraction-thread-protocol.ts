/**
 * IPC protocol for the extraction worker thread.
 *
 * Main thread spawns a node:worker_threads Worker with WorkerInit as
 * workerData. Communication uses postMessage only — no MessageChannel,
 * BroadcastChannel, or receiveMessageOnPort.
 */

import type { WorkerStats } from "./worker";

// ---------------------------------------------------------------------------
// Serializable init config (passed via workerData)
// ---------------------------------------------------------------------------

/**
 * Embedding config that can cross the thread boundary.
 * Subset of EmbeddingConfig — only serializable fields.
 */
export interface SerializedEmbeddingConfig {
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;
	readonly base_url?: string;
	readonly api_key?: string;
}

/** Everything the worker thread needs to self-initialize. */
export interface WorkerInit {
	readonly dbPath: string;
	readonly vecExtensionPath: string;
	/** Agents directory — worker creates its own inference router from config files here. */
	readonly agentsDir: string;
	readonly agentId: string;
	readonly embeddingConfig: SerializedEmbeddingConfig;
	/** Full pipeline config — already a plain object, fully serializable. */
	readonly pipelineConfig: Record<string, unknown>;
	/** Search config for decision phase. */
	readonly searchConfig: Record<string, unknown>;
	/**
	 * Pre-resolved native embedding worker path (main thread resolves via
	 * resolveEmbeddedWorkerPath, since the extraction worker thread cannot
	 * read `globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__`). Null in source
	 * mode (#922).
	 */
	readonly nativeEmbeddingWorkerPath?: string | null;
	/** Pre-resolved WASM assets directory. Null in source mode (#922). */
	readonly nativeWasmDir?: string | null;
	/** Pre-resolved transformers runtime path. Null in source mode (#922). */
	readonly nativeTransformersRuntimePath?: string | null;
}

export interface SerializedGenerateOptions {
	readonly timeoutMs?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly responseFormat?: "json";
	readonly think?: boolean;
}

// ---------------------------------------------------------------------------
// Main → Worker messages
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
	| { readonly type: "stop" }
	| { readonly type: "nudge" }
	| { readonly type: "generateResult"; readonly id: string; readonly text: string }
	| { readonly type: "generateError"; readonly id: string; readonly error: string };

// ---------------------------------------------------------------------------
// Worker → Main messages
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
	| { readonly type: "ready" }
	| { readonly type: "stopped" }
	| {
			readonly type: "generate";
			readonly id: string;
			readonly prompt: string;
			readonly options?: SerializedGenerateOptions;
	  }
	| { readonly type: "stats"; readonly stats: WorkerStats }
	| {
			readonly type: "log";
			readonly level: string;
			readonly category: string;
			readonly message: string;
			readonly data?: Record<string, unknown>;
	  }
	| { readonly type: "telemetry"; readonly event: string; readonly data: Record<string, unknown> }
	| { readonly type: "analytics"; readonly method: string; readonly args: readonly unknown[] }
	| { readonly type: "error"; readonly error: string; readonly stack?: string };
