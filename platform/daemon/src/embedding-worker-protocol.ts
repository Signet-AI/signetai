/**
 * IPC protocol for the native embedding worker thread.
 *
 * Why a worker exists (see native-embedding.ts / embedding-worker.ts):
 * the ONNX-WASM embedding runtime performs long, partly-synchronous
 * work — first-run model download, WASM compile, and per-call forward
 * passes. Running that on the daemon's main event loop starves every
 * HTTP handler including /health (the bug fixed by this change). A
 * worker_threads Worker cannot block the main loop, so isolation is the
 * structural guarantee; the main-thread handle adds bounded RPC
 * timeouts on top for fail-fast.
 *
 * Main thread spawns a node:worker_threads Worker with EmbeddingWorkerInit
 * as workerData. Communication uses postMessage only — no MessageChannel,
 * BroadcastChannel, or receiveMessageOnPort (mirrors extraction-thread-protocol.ts).
 */

// ---------------------------------------------------------------------------
// Serializable init config (passed via workerData)
// ---------------------------------------------------------------------------

/**
 * Everything the worker needs to self-initialize. Computed on the main
 * thread (which owns the compiled-binary asset globals) and passed in,
 * because a worker has an isolated globalThis and cannot itself read
 * `__SIGNET_NATIVE_RUNTIME_ASSETS__` / call materializeEmbeddedWasmAssets().
 */
export interface EmbeddingWorkerInit {
	/** Cache directory for the transformers model (<agentsDir>/.models). */
	readonly cacheDir: string;
	/**
	 * Directory holding the materialized ONNX WASM assets, or null in
	 * source mode where onnxruntime-wasm resolves its .wasm from node_modules.
	 * Main thread obtains this via materializeEmbeddedWasmAssets().
	 */
	readonly wasmDir: string | null;
	readonly modelId: string;
	readonly expectedDimensions: number;
	/**
	 * Optional override for transformers `env.remoteHost` — test seam used
	 * by the event-loop isolation test to point the model fetch at a local
	 * blackhole so download "hangs" hermetically (no real network in CI).
	 */
	readonly remoteHostOverride?: string;
}

// ---------------------------------------------------------------------------
// Main → Worker messages
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
	| { readonly type: "embed"; readonly id: number; readonly text: string }
	| { readonly type: "checkAvailable"; readonly id: number }
	| { readonly type: "shutdown" };

// ---------------------------------------------------------------------------
// Worker → Main messages
// ---------------------------------------------------------------------------

/**
 * Proactive status snapshots pushed whenever the worker's init state
 * transitions, so the main thread can answer getNativeProviderStatus()
 * synchronously without awaiting an RPC round-trip.
 */
export interface EmbeddingWorkerStatus {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly modelCached: boolean;
	readonly error: string | null;
}

export type WorkerToMainMessage =
	| { readonly type: "ready" }
	| { readonly type: "status"; readonly status: EmbeddingWorkerStatus }
	| { readonly type: "embed_result"; readonly id: number; readonly vector: number[] }
	| { readonly type: "embed_error"; readonly id: number; readonly error: string }
	| { readonly type: "check_result"; readonly id: number; readonly available: boolean; readonly error: string | null }
	| { readonly type: "log"; readonly level: string; readonly message: string; readonly data?: Record<string, unknown> }
	| { readonly type: "error"; readonly error: string; readonly stack?: string };
