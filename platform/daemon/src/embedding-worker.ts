/**
 * Native embedding worker — runs nomic-embed-text ONNX (via
 * @huggingface/transformers WASM runtime) inside a worker_threads Worker.
 *
 * This is the thread that performs the long, partly-synchronous work:
 * first-run model download, WASM compile, and per-call forward passes.
 * Keeping it off the daemon's main event loop is what guarantees that
 * /health and every HTTP handler stay responsive regardless of embedding
 * state. The main-thread adapter (embedding-worker-handle.ts) bounds each
 * RPC with a timeout so callers fail fast even if this worker is grinding.
 *
 * Loaded in the worker via:
 *   - source mode: `new Worker(new URL("./embedding-worker.ts", import.meta.url))`
 *     → resolves @huggingface/transformers from node_modules.
 *   - compiled binary: the worker is bun-bundled into an embedded worker
 *     asset (see scripts/build-native-bun.ts workerEntries) with transformers
 *     inlined, and the main thread passes the materialized wasmDir via
 *     workerData (the worker cannot read the main-thread asset globals).
 */

import { mkdirSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { type EmbeddingWasmConfig, configureEmbeddingWasm } from "./embedding-wasm-config";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";

// Lazy, narrow transformers typing — keeps the contract we use without
// dragging in the library's complex generics (same approach as the prior
// in-process implementation).
interface TransformersEnv {
	cacheDir?: string;
	localModelPath?: string;
	allowLocalModels?: boolean;
	remoteHost?: string;
	backends?: {
		onnx?: {
			wasm?: EmbeddingWasmConfig;
		};
	};
}
interface TransformersBindings {
	readonly env: TransformersEnv;
	readonly pipeline: (
		task: string,
		model: string,
		opts: {
			dtype: "q8";
			progress_callback?: (progress: { status: string; progress?: number; file?: string }) => void;
		},
	) => Promise<unknown>;
}
interface EmbedCallable {
	(text: string, opts?: { pooling?: string; normalize?: boolean }): Promise<{ data: Float32Array }>;
	dispose?: () => Promise<void>;
}

const workerInit = workerData as EmbeddingWorkerInit | undefined;

if (isMainThread || !parentPort || !workerInit) {
	// Defensive: should never be imported on the main thread. Bail loudly
	// rather than silently no-op'ing.
	throw new Error("embedding-worker.ts must run as a worker_threads Worker with EmbeddingWorkerInit workerData");
}

const init: EmbeddingWorkerInit = workerInit;

const port = parentPort;

function post(msg: WorkerToMainMessage): void {
	port.postMessage(msg);
}

function log(level: string, message: string, data?: Record<string, unknown>): void {
	post({ type: "log", level, message, data });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let transformers: TransformersBindings | null = null;
let embedFn: EmbedCallable | null = null;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;
let modelCached = false;

function snapshot() {
	return {
		initialized: embedFn !== null,
		initializing: initPromise !== null && embedFn === null,
		modelCached,
		error: initError,
	};
}

function pushStatus(): void {
	post({ type: "status", status: snapshot() });
}

// ---------------------------------------------------------------------------
// Transformers loading + init
// ---------------------------------------------------------------------------

async function loadTransformers(): Promise<TransformersBindings> {
	// The worker cannot use the compiled binary's main-thread
	// __SIGNET_NATIVE_TRANSFORMERS_BINDINGS__ global (isolated globalThis),
	// so load via the bundled runtime entry. In source mode this resolves
	// @huggingface/transformers from node_modules; in the compiled binary
	// the worker .mjs has transformers inlined by the bun build.
	//
	// In the compiled binary, transformers resolves to the Node entry which
	// tries to load native onnxruntime .node bindings that don't exist in a
	// Bun-compiled executable. The main thread registers a WASM runtime via
	// globalThis[Symbol.for("onnxruntime")], but the worker has an isolated
	// globalThis so that registration does NOT propagate.
	//
	// Fix: when transformersRuntimePath is set (compiled binary mode), import
	// the materialized WASM runtime first — it registers onnxruntime-web on
	// the worker's own globalThis and exports env/pipeline from the patched
	// web entry. Fall back to the standard import in source mode.
	if (init.transformersRuntimePath) {
		const mod = (await import(init.transformersRuntimePath)) as {
			env: TransformersEnv;
			pipeline: TransformersBindings["pipeline"];
		};
		return { env: mod.env, pipeline: mod.pipeline };
	}
	const mod = (await import("./transformers-runtime")) as {
		env: TransformersEnv;
		pipeline: TransformersBindings["pipeline"];
	};
	return { env: mod.env, pipeline: mod.pipeline };
}

async function ensureInitialized(): Promise<void> {
	if (embedFn) return;
	if (initPromise) return initPromise;
	initPromise = doInit();
	try {
		await initPromise;
	} finally {
		// Keep initPromise around only while in-flight; clear on settle so
		// retries (after cooldown, controlled by the main thread) can re-init.
		initPromise = null;
	}
	return;
}

async function doInit(): Promise<void> {
	try {
		initError = null;
		pushStatus();

		mkdirSync(init.cacheDir, { recursive: true });
		transformers = await loadTransformers();

		// Configure cache + LOCAL load path. Setting localModelPath to the
		// same cacheDir is the fix for the "Unable to load from local path
		// /models/…" noise: without it transformers defaults localModelPath
		// to a root "/models" that never exists, so every load pointlessly
		// probes-and-fails locally before hitting the network. With this, a
		// cached model loads straight from disk on subsequent starts.
		transformers.env.cacheDir = init.cacheDir;
		transformers.env.localModelPath = init.cacheDir;
		transformers.env.allowLocalModels = true;
		if (init.remoteHostOverride) {
			transformers.env.remoteHost = init.remoteHostOverride;
		}
		configureEmbeddingWasm(transformers.env.backends?.onnx?.wasm, init.wasmDir);

		log("info", `Initializing ${init.modelId} (q8 quantization)`, {
			cachePath: init.cacheDir,
			wasmPath: init.wasmDir ?? "node_modules",
			remoteHost: transformers.env.remoteHost,
		});

		const pipe = await transformers.pipeline("feature-extraction", init.modelId, {
			dtype: "q8",
			progress_callback: (progress) => {
				if (progress.status === "download" && typeof progress.progress === "number") {
					log("info", `Downloading ${progress.file ?? "model"}: ${Math.round(progress.progress)}%`);
				} else if (progress.status === "ready") {
					log("info", "Model ready");
				}
			},
		});

		const embed = toEmbedCallable(pipe);
		// Warm-up to verify output shape before declaring readiness.
		const warmup = await embed("test", { pooling: "mean", normalize: true });
		if (warmup.data.length !== init.expectedDimensions) {
			throw new Error(`Expected ${init.expectedDimensions} dimensions but got ${warmup.data.length}`);
		}

		embedFn = embed;
		modelCached = true;
		log("info", `Ready — ${init.expectedDimensions}-dim embeddings`);
		pushStatus();
	} catch (err) {
		initError = err instanceof Error ? err.message : String(err);
		embedFn = null;
		modelCached = false;
		log("error", `Init failed: ${initError}`);
		pushStatus();
		throw err;
	}
}

function toEmbedCallable(value: unknown): EmbedCallable {
	if (typeof value !== "function") throw new Error("Transformers pipeline is not callable");
	const callable = value as (
		text: string,
		opts?: { pooling?: string; normalize?: boolean },
	) => Promise<{
		data: Float32Array;
	}>;
	const embed: EmbedCallable = async (text, opts) => {
		const output = await Promise.resolve(callable(text, opts));
		if (!(output?.data instanceof Float32Array)) {
			throw new Error("Transformers pipeline returned non-Float32Array data");
		}
		return { data: output.data };
	};
	const dispose = (value as { dispose?: () => Promise<void> }).dispose;
	if (typeof dispose === "function") embed.dispose = dispose;
	return embed;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

async function handleEmbed(id: number, text: string): Promise<void> {
	try {
		await ensureInitialized();
		if (!embedFn) throw new Error(initError ?? "Native embedding pipeline not initialized");
		const output = await embedFn(text, { pooling: "mean", normalize: true });
		post({ type: "embed_result", id, vector: Array.from(output.data) });
	} catch (err) {
		post({ type: "embed_error", id, error: err instanceof Error ? err.message : String(err) });
	}
}

async function handleCheckAvailable(id: number): Promise<void> {
	try {
		await ensureInitialized();
		post({ type: "check_result", id, available: embedFn !== null, error: embedFn ? null : (initError ?? "not ready") });
	} catch (err) {
		post({ type: "check_result", id, available: false, error: err instanceof Error ? err.message : String(err) });
	}
}

async function handleShutdown(): Promise<void> {
	if (embedFn?.dispose) {
		try {
			await embedFn.dispose();
		} catch {
			// best-effort
		}
	}
	embedFn = null;
	modelCached = false;
	initPromise = null;
	initError = null;
}

port.on("message", (msg: MainToWorkerMessage) => {
	switch (msg.type) {
		case "embed":
			void handleEmbed(msg.id, msg.text);
			break;
		case "checkAvailable":
			void handleCheckAvailable(msg.id);
			break;
		case "shutdown":
			void handleShutdown();
			break;
	}
});

port.on("error", (err: Error) => {
	post({ type: "error", error: err.message, stack: err.stack });
});

post({ type: "ready" });
