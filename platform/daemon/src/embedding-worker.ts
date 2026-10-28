import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { RerankDeadlineError, pairLengths, planLengthBuckets, scoreInGroups } from "./cross-encoder-buckets";
import { type EmbeddingWasmConfig, configureEmbeddingWasm } from "./embedding-wasm-config";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";
const TRANSFORMERS_LOG_LEVEL_NONE = 50;
interface TransformersEnv {
	logLevel?: number;
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
			dtype?: "q8" | "fp32";
			device?: "cuda" | "cpu";
			session_options?: { intraOpNumThreads: number; interOpNumThreads: number };
			progress_callback?: (progress: { status: string; progress?: number; file?: string }) => void;
		},
	): Promise<T>;
}
interface TransformersBindings {
	readonly env: TransformersEnv;
	readonly AutoTokenizer: PretrainedLoader<RerankTokenizer>;
	readonly AutoModelForSequenceClassification: PretrainedLoader<RerankModel>;
	readonly Tensor?: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;
	readonly pipeline: (
		task: string,
		model: string,
		opts: {
			dtype: "q8";
			device?: "cpu";
			session_options?: { intraOpNumThreads: number; interOpNumThreads: number };
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
let rerankFn: ((query: string, documents: readonly string[], deadlineAt?: number) => Promise<number[]>) | null = null;
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

const RTLD_NOW = 0x2;
const RTLD_GLOBAL = 0x100;
const SHARED_LIBRARY_FILE = /\.so(?:\.\d+)+$/;

async function preloadCudaLibraries(dirs: readonly string[]): Promise<number> {
	if (dirs.length === 0) return 0;
	const { FFIType, dlopen, ptr } = await import("bun:ffi");
	const libc = dlopen("libc.so.6", {
		dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
		dlerror: { args: [], returns: FFIType.cstring },
	});
	let pending = dirs.flatMap((dir) =>
		readdirSync(dir)
			.filter((name) => SHARED_LIBRARY_FILE.test(name))
			.sort()
			.map((name) => join(dir, name)),
	);
	let loaded = 0;
	let lastError = "";
	while (pending.length > 0) {
		const failed: string[] = [];
		for (const path of pending) {
			const handle = libc.symbols.dlopen(ptr(Buffer.from(`${path}\0`)), RTLD_NOW | RTLD_GLOBAL);
			if (handle) loaded++;
			else {
				failed.push(path);
				lastError = String(libc.symbols.dlerror() ?? "");
			}
		}
		if (failed.length === pending.length) {
			log("warn", "Some CUDA libraries could not be preloaded", { count: failed.length, lastError });
			break;
		}
		pending = failed;
	}
	libc.close();
	return loaded;
}

async function prepareNativeOnnxRuntime(purpose: string): Promise<void> {
	const preloaded = await preloadCudaLibraries(init.cudaLibraryPaths ?? []);
	if (init.transformersRuntimePath) {
		if (!init.onnxRuntimeModulePath) throw new Error("This Signet build does not include the native ONNX runtime");
		if (!init.onnxRuntimePath) {
			throw new Error(`onnxRuntimePath is required for the ${purpose}`);
		}
		const manifest = JSON.parse(readFileSync(join(init.onnxRuntimePath, "package.json"), "utf8")) as {
			version?: unknown;
		};
		const expectedVersion = readFileSync(init.onnxRuntimeModulePath, "utf8").match(
			/export const signetOnnxRuntimeNodeVersion = "([^"]+)";/,
		)?.[1];
		if (typeof manifest.version !== "string" || !expectedVersion || manifest.version !== expectedVersion) {
			throw new Error(
				`onnxruntime-node at ${init.onnxRuntimePath} is ${String(manifest.version)}; this Signet build needs ${String(expectedVersion)}`,
			);
		}
		(globalThis as Record<symbol, unknown>)[Symbol.for("signet.onnxruntimeNodeBinding")] = join(
			init.onnxRuntimePath,
			"bin",
			"napi-v6",
			process.platform,
			process.arch,
			"onnxruntime_binding.node",
		);
		const runtime = (await import(init.onnxRuntimeModulePath)) as { default?: unknown };
		(globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = runtime.default ?? runtime;
	}
	log("info", `Prepared native ONNX runtime for the ${purpose}`, {
		preloadedLibraries: preloaded,
		nativeRuntime: init.onnxRuntimePath ?? null,
	});
}

const CROSS_ENCODER_MAX_TOKENS = 512;

interface NativePairTokenizer {
	encodePairs(
		query: string,
		documents: string[],
	): {
		readonly inputIds: readonly number[];
		readonly attentionMask: readonly number[];
		readonly tokenTypeIds: readonly number[];
		readonly batchSize: number;
		readonly sequenceLength: number;
	};
}

function loadNativePairTokenizer(modelId: string): NativePairTokenizer | null {
	const tokenizerPath = join(init.cacheDir, modelId, "tokenizer.json");
	if (!existsSync(tokenizerPath)) return null;
	try {
		const requireNative = createRequire(import.meta.url);
		const addon = requireNative(init.nativeAddonPath ?? "@signet/native") as {
			PairTokenizer?: new (path: string, maxLength: number) => NativePairTokenizer;
		};
		if (typeof addon.PairTokenizer !== "function") return null;
		return new addon.PairTokenizer(tokenizerPath, CROSS_ENCODER_MAX_TOKENS);
	} catch (error) {
		log("warn", "Native cross-encoder tokenizer unavailable; using transformers.js", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function ensureInitialized(): Promise<void> {
	if (embedFn || rerankFn) return;
	if (initPromise) return initPromise;
	initPromise = doInit();
	try {
		await initPromise;
	} finally {
		initPromise = null;
		pushStatus();
	}
	return;
}

async function doInit(): Promise<void> {
	try {
		initError = null;
		pushStatus();

		mkdirSync(init.cacheDir, { recursive: true });
		const cuda = init.task === "rerank" && init.device === "cuda";
		const nativeEmbedding = init.task !== "rerank" && init.runtime === "onnxruntime";
		const nativeCpuRerank = init.task === "rerank" && !cuda && init.runtime === "onnxruntime";
		if (cuda) await prepareNativeOnnxRuntime("CUDA cross-encoder");
		if (nativeCpuRerank) await prepareNativeOnnxRuntime("native ONNX runtime cross-encoder");
		if (nativeEmbedding) await prepareNativeOnnxRuntime("native ONNX runtime embedding");
		transformers = await loadTransformers();
		transformers.env.logLevel = TRANSFORMERS_LOG_LEVEL_NONE;
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
			const precision = cuda ? "fp32" : "q8";
			const deviceLabel = cuda ? ", CUDA" : nativeCpuRerank ? ", native CPU" : "";
			log("info", `Initializing cross-encoder ${init.modelId} (${precision}${deviceLabel})`, {
				cachePath: init.cacheDir,
			});
			const tokenizer = await transformers.AutoTokenizer.from_pretrained(init.modelId, { progress_callback });
			const model = await transformers.AutoModelForSequenceClassification.from_pretrained(init.modelId, {
				dtype: precision,
				...(cuda ? { device: "cuda" as const } : {}),
				...(nativeCpuRerank
					? {
							device: "cpu" as const,
							session_options: {
								intraOpNumThreads: Math.max(1, Math.min(4, availableParallelism() - 1)),
								interOpNumThreads: 1,
							},
						}
					: {}),
				progress_callback,
			});
			const pairTokenizer = loadNativePairTokenizer(init.modelId);
			const tensorClass = transformers.Tensor;
			const nativeInputs =
				pairTokenizer !== null && tensorClass !== undefined
					? (query: string, documents: readonly string[]): RerankInputs => {
							const batch = pairTokenizer.encodePairs(query, [...documents]);
							const dims = [batch.batchSize, batch.sequenceLength];
							const tensor = (values: readonly number[]) =>
								new tensorClass(
									"int64",
									BigInt64Array.from(values, (value) => BigInt(value)),
									dims,
								);
							return {
								input_ids: tensor(batch.inputIds),
								attention_mask: tensor(batch.attentionMask),
								token_type_ids: tensor(batch.tokenTypeIds),
							};
						}
					: null;
			log("info", `Cross-encoder tokenizer: ${nativeInputs === null ? "transformers.js" : "native"}`);
			const scoreBatch = async (query: string, documents: readonly string[]): Promise<number[]> => {
				if (documents.length === 0) return [];
				const inputs =
					nativeInputs !== null
						? nativeInputs(query, documents)
						: tokenizer(new Array<string>(documents.length).fill(query), {
								text_pair: [...documents],
								padding: true,
								truncation: true,
								max_length: 512,
							});
				const { logits } = await model(inputs);
				const width = logits.dims.at(-1) ?? 1;
				return documents.map((_, index) => Number(logits.data[index * width + width - 1]));
			};
			const planGroups = (query: string, documents: readonly string[]): number[][] =>
				cuda && pairTokenizer !== null && nativeInputs !== null
					? planLengthBuckets(pairLengths(pairTokenizer.encodePairs(query, [...documents])))
					: documents.map((_, index) => [index]);
			const score = (query: string, documents: readonly string[], deadlineAt?: number): Promise<number[]> =>
				scoreInGroups(
					documents.length <= 1 ? documents.map((_, index) => [index]) : planGroups(query, documents),
					documents.length,
					(group) =>
						scoreBatch(
							query,
							group.map((index) => documents[index] ?? ""),
						),
					deadlineAt,
				);
			const warmup = await score("test", ["test"]);
			if (warmup.length !== 1 || !Number.isFinite(warmup[0])) throw new Error("Cross-encoder warmup returned no score");
			rerankModel = model;
			rerankFn = score;
			modelCached = true;
			log("info", "Cross-encoder ready", { device: cuda ? "cuda" : nativeCpuRerank ? "cpu" : "default" });
			pushStatus();
			return;
		}

		log(
			"info",
			`Initializing ${init.modelId} (q8 quantization, ${nativeEmbedding ? "native ONNX runtime" : "default runtime"})`,
			{
				cachePath: init.cacheDir,
				wasmPath: init.wasmDir ?? "node_modules",
				remoteHost: transformers.env.remoteHost,
			},
		);

		const pipe = await transformers.pipeline("feature-extraction", init.modelId, {
			dtype: "q8",
			progress_callback,
			...(nativeEmbedding
				? {
						device: "cpu" as const,
						session_options: {
							intraOpNumThreads: Math.max(1, Math.min(4, availableParallelism() - 1)),
							interOpNumThreads: 1,
						},
					}
				: {}),
		});

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

async function handleRerank(
	id: number,
	query: string,
	documents: readonly string[],
	deadlineAt: number | undefined,
): Promise<void> {
	try {
		await ensureInitialized();
		if (!rerankFn) throw new Error(initError ?? "Cross-encoder not initialized");
		post({ type: "rerank_result", id, scores: await rerankFn(query, documents, deadlineAt) });
	} catch (err) {
		post({
			type: "rerank_error",
			id,
			error: err instanceof Error ? err.message : String(err),
			...(err instanceof RerankDeadlineError ? { cancelled: true } : {}),
		});
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
			void handleRerank(msg.id, msg.query, msg.documents, msg.deadlineAt);
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
