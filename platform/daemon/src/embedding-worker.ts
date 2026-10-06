import { mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { type EmbeddingWasmConfig, configureEmbeddingWasm } from "./embedding-wasm-config";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";
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
interface RerankInputs {
	readonly [key: string]: unknown;
}
type RerankTokenizer = (
	texts: string[],
	opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
) => RerankInputs;
interface RerankModel {
	(inputs: RerankInputs): Promise<{ logits: { data: ArrayLike<number>; dims: readonly number[] } }>;
	dispose?: () => Promise<void>;
}
interface PretrainedLoader<T> {
	from_pretrained(
		model: string,
		opts?: {
			dtype?: "q8";
			progress_callback?: (progress: { status: string; progress?: number; file?: string }) => void;
		},
	): Promise<T>;
}
interface TransformersBindings {
	readonly env: TransformersEnv;
	readonly AutoTokenizer: PretrainedLoader<RerankTokenizer>;
	readonly AutoModelForSequenceClassification: PretrainedLoader<RerankModel>;
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

let transformers: TransformersBindings | null = null;
let embedFn: EmbedCallable | null = null;
let rerankFn: ((query: string, documents: readonly string[]) => Promise<number[]>) | null = null;
let rerankModel: RerankModel | null = null;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;
let modelCached = false;

function snapshot() {
	return {
		initialized: embedFn !== null || rerankFn !== null,
		initializing: initPromise !== null && embedFn === null && rerankFn === null,
		modelCached,
		error: initError,
	};
}

function pushStatus(): void {
	post({ type: "status", status: snapshot() });
}

async function loadTransformers(): Promise<TransformersBindings> {
	if (init.transformersRuntimePath) {
		return (await import(init.transformersRuntimePath)) as TransformersBindings;
	}
	return (await import("./transformers-runtime")) as unknown as TransformersBindings;
}

async function ensureInitialized(): Promise<void> {
	if (embedFn || rerankFn) return;
	if (initPromise) return initPromise;
	initPromise = doInit();
	try {
		await initPromise;
	} finally {
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
		transformers.env.cacheDir = init.cacheDir;
		transformers.env.localModelPath = init.cacheDir;
		transformers.env.allowLocalModels = true;
		if (init.remoteHostOverride) {
			transformers.env.remoteHost = init.remoteHostOverride;
		}
		configureEmbeddingWasm(transformers.env.backends?.onnx?.wasm, init.wasmDir);
		if (init.task === "rerank" && transformers.env.backends?.onnx?.wasm) {
			transformers.env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, availableParallelism() - 1));
		}
		if (init.wasmDir && transformers.env.backends?.onnx?.wasm) {
			const wasmBytes = readFileSync(join(init.wasmDir, "ort-wasm-simd-threaded.wasm"));
			transformers.env.backends.onnx.wasm.wasmBinary = wasmBytes.buffer.slice(
				wasmBytes.byteOffset,
				wasmBytes.byteOffset + wasmBytes.byteLength,
			) as ArrayBuffer;
		}

		const progress_callback = (progress: { status: string; progress?: number; file?: string }) => {
			if (progress.status === "download" && typeof progress.progress === "number") {
				log("info", `Downloading ${progress.file ?? "model"}: ${Math.round(progress.progress)}%`);
			} else if (progress.status === "ready") {
				log("info", "Model ready");
			}
		};
		if (init.task === "rerank") {
			log("info", `Initializing cross-encoder ${init.modelId} (q8 quantization)`, { cachePath: init.cacheDir });
			const tokenizer = await transformers.AutoTokenizer.from_pretrained(init.modelId, { progress_callback });
			const model = await transformers.AutoModelForSequenceClassification.from_pretrained(init.modelId, {
				dtype: "q8",
				progress_callback,
			});
			const score = async (query: string, documents: readonly string[]): Promise<number[]> => {
				if (documents.length === 0) return [];
				const inputs = tokenizer(new Array<string>(documents.length).fill(query), {
					text_pair: [...documents],
					padding: true,
					truncation: true,
					max_length: 512,
				});
				const { logits } = await model(inputs);
				const width = logits.dims.at(-1) ?? 1;
				return documents.map((_, index) => Number(logits.data[index * width + width - 1]));
			};
			const warmup = await score("test", ["test"]);
			if (warmup.length !== 1 || !Number.isFinite(warmup[0])) throw new Error("Cross-encoder warmup returned no score");
			rerankModel = model;
			rerankFn = score;
			modelCached = true;
			log("info", "Cross-encoder ready");
			pushStatus();
			return;
		}

		log("info", `Initializing ${init.modelId} (q8 quantization)`, {
			cachePath: init.cacheDir,
			wasmPath: init.wasmDir ?? "node_modules",
			remoteHost: transformers.env.remoteHost,
		});

		const pipe = await transformers.pipeline("feature-extraction", init.modelId, { dtype: "q8", progress_callback });

		const embed = toEmbedCallable(pipe);
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
		rerankFn = null;
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

async function handleRerank(id: number, query: string, documents: readonly string[]): Promise<void> {
	try {
		await ensureInitialized();
		if (!rerankFn) throw new Error(initError ?? "Cross-encoder not initialized");
		post({ type: "rerank_result", id, scores: await rerankFn(query, documents) });
	} catch (err) {
		post({ type: "rerank_error", id, error: err instanceof Error ? err.message : String(err) });
	}
}

async function handleCheckAvailable(id: number): Promise<void> {
	try {
		await ensureInitialized();
		const ready = embedFn !== null || rerankFn !== null;
		post({ type: "check_result", id, available: ready, error: ready ? null : (initError ?? "not ready") });
	} catch (err) {
		post({ type: "check_result", id, available: false, error: err instanceof Error ? err.message : String(err) });
	}
}

async function handleShutdown(): Promise<void> {
	if (embedFn?.dispose) {
		try {
			await embedFn.dispose();
		} catch {}
	}
	if (rerankModel?.dispose) {
		try {
			await rerankModel.dispose();
		} catch {}
	}
	embedFn = null;
	rerankFn = null;
	rerankModel = null;
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
		case "rerank":
			void handleRerank(msg.id, msg.query, msg.documents);
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
