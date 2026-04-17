/**
 * Native embedding provider — runs nomic-embed-text ONNX directly
 * via @huggingface/transformers (WASM runtime).
 *
 * Lazy-initialized singleton with mutex-based init to handle
 * concurrent callers during model download.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NativeProviderStatus {
	readonly available: boolean;
	readonly error?: string;
	readonly dimensions: number;
	readonly modelCached: boolean;
}

interface NativeProviderSnapshot {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly modelCached: boolean;
}

// We keep a narrow callable type for the pipeline return.
// transformers.js FeatureExtractionPipeline is callable but its
// full type drags in complex generics — this captures the contract
// we actually use and avoids `as unknown as` casts.
interface EmbedFn {
	(
		text: string,
		opts?: { pooling?: string; normalize?: boolean },
	): Promise<{
		data: Float32Array;
	}>;
	dispose?: () => Promise<void>;
}

interface ProgressInfo {
	readonly status: string;
	readonly progress?: number;
	readonly file?: string;
}

interface TransformersBindings {
	readonly env: Record<string, unknown>;
	readonly pipeline: (
		task: string,
		model: string,
		opts: {
			dtype: "q8";
			progress_callback?: (progress: ProgressInfo) => void;
		},
	) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
const EXPECTED_DIMS = 768;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readTransformersBindings(value: unknown): TransformersBindings | null {
	if (!isRecord(value)) return null;
	const env = value.env;
	const pipeline = value.pipeline;
	if (!isRecord(env) || typeof pipeline !== "function") return null;
	return {
		env,
		pipeline: (task, model, opts) => Promise.resolve(Reflect.apply(pipeline, undefined, [task, model, opts])),
	};
}

async function loadTransformersBindings(): Promise<TransformersBindings> {
	const importBySpecifier = (specifier: string): Promise<unknown> => {
		return import(specifier);
	};

	const resolveImportMetaSpecifier = (specifier: string): string => {
		const resolver = Reflect.get(import.meta, "resolve");
		if (typeof resolver !== "function") {
			throw new Error("import.meta.resolve is not available");
		}
		return String(Reflect.apply(resolver, import.meta, [specifier]));
	};

	const loadTransformersWebRuntime = async (): Promise<unknown> => {
		const packageJsonUrl = resolveImportMetaSpecifier("@huggingface/transformers/package.json");
		const packageJsonPath = fileURLToPath(packageJsonUrl);
		const webRuntimePath = join(dirname(packageJsonPath), "dist", "transformers.web.js");
		return import(pathToFileURL(webRuntimePath).href);
	};

	const importCandidates: ReadonlyArray<{
		readonly source: string;
		readonly load: () => Promise<unknown>;
	}> = [
		{
			source: "bundled runtime",
			load: () => import("./transformers-runtime"),
		},
		{
			source: "@huggingface/transformers",
			load: () => importBySpecifier("@huggingface/transformers"),
		},
		{
			source: "@huggingface/transformers dist web runtime",
			load: () => loadTransformersWebRuntime(),
		},
	];

	const failures: string[] = [];

	for (const candidate of importCandidates) {
		let mod: unknown;
		try {
			mod = await candidate.load();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failures.push(`${candidate.source}: ${message}`);
			continue;
		}

		const direct = readTransformersBindings(mod);
		if (direct !== null) return direct;

		if (isRecord(mod) && "default" in mod) {
			const fromDefault = readTransformersBindings(mod.default);
			if (fromDefault !== null) return fromDefault;
		}

		failures.push(`${candidate.source}: unsupported export shape (missing env/pipeline)`);
	}

	throw new Error(`Failed to load @huggingface/transformers: ${failures.join("; ")}`);
}

function toEmbedFn(value: unknown): EmbedFn {
	if (typeof value !== "function") {
		throw new Error("Transformers pipeline is not callable");
	}

	const callable = value;
	const embed: EmbedFn = async (text, opts) => {
		const output = await Promise.resolve(Reflect.apply(callable, undefined, [text, opts]));
		if (!isRecord(output)) {
			throw new Error("Transformers pipeline returned invalid output");
		}
		const data = output.data;
		if (!(data instanceof Float32Array)) {
			throw new Error("Transformers pipeline returned non-Float32Array data");
		}
		return { data };
	};

	const dispose = Reflect.get(callable, "dispose");
	if (typeof dispose === "function") {
		embed.dispose = async () => {
			await Promise.resolve(Reflect.apply(dispose, callable, []));
		};
	}

	return embed;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let embedFn: EmbedFn | null = null;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;
let modelCached = false;
let lastInitFailure = 0;

const INIT_RETRY_COOLDOWN_MS = 300_000;

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

function getCacheDir(): string {
	const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
	return join(agentsDir, ".models");
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

async function ensureInitialized(): Promise<void> {
	if (embedFn) return;
	if (initPromise) return initPromise;
	if (lastInitFailure > 0 && Date.now() - lastInitFailure < INIT_RETRY_COOLDOWN_MS) {
		throw new Error(initError ?? "Native embedding init on cooldown");
	}
	initPromise = doInit();
	return initPromise;
}

async function doInit(): Promise<void> {
	try {
		initError = null;

		const cacheDir = getCacheDir();
		mkdirSync(cacheDir, { recursive: true });

		// Dynamic import to avoid top-level WASM load
		const transformers = await loadTransformersBindings();

		// Configure cache directory
		transformers.env.cacheDir = cacheDir;
		transformers.env.allowLocalModels = true;

		logger.info("native-embedding", `Initializing ${MODEL_ID} (q8 quantization)`);
		logger.info("native-embedding", `Model cache: ${cacheDir}`);

		const pipe = await transformers.pipeline("feature-extraction", MODEL_ID, {
			dtype: "q8" as const,
			progress_callback: (progress: ProgressInfo) => {
				if (progress.status === "download" && typeof progress.progress === "number") {
					logger.info("native-embedding", `Downloading ${progress.file ?? "model"}: ${Math.round(progress.progress)}%`);
				} else if (progress.status === "ready") {
					logger.info("native-embedding", "Model ready");
				}
			},
		});

		// Warm-up to verify output shape
		const embed = toEmbedFn(pipe);
		const warmup = await embed("test", { pooling: "mean", normalize: true });
		const dims = warmup.data.length;
		if (dims !== EXPECTED_DIMS) {
			throw new Error(`Expected ${EXPECTED_DIMS} dimensions but got ${dims}`);
		}

		// The pipeline return is callable — assign to our narrow interface.
		// We verify the contract via the warmup call above rather than
		// relying on type assertions.
		embedFn = embed;
		modelCached = true;
		logger.info("native-embedding", `Ready — ${EXPECTED_DIMS}-dim embeddings`);
	} catch (err) {
		initError = err instanceof Error ? err.message : String(err);
		initPromise = null;
		lastInitFailure = Date.now();
		logger.error("native-embedding", `Init failed: ${initError}`);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function nativeEmbed(text: string): Promise<number[]> {
	await ensureInitialized();
	if (embedFn === null) {
		throw new Error("Native embedding pipeline failed to initialize");
	}
	const output = await embedFn(text, { pooling: "mean", normalize: true });
	return Array.from(output.data);
}

export async function checkNativeProvider(): Promise<NativeProviderStatus> {
	try {
		await ensureInitialized();
		return {
			available: true,
			dimensions: EXPECTED_DIMS,
			modelCached,
		};
	} catch {
		return {
			available: false,
			error: initError ?? "Native embedding provider not ready",
			dimensions: EXPECTED_DIMS,
			modelCached: false,
		};
	}
}

export async function shutdownNativeProvider(): Promise<void> {
	if (embedFn) {
		if (typeof embedFn.dispose === "function") {
			try {
				await embedFn.dispose();
			} catch {
				// best-effort
			}
		}
		logger.info("native-embedding", "Provider shut down");
	}
	embedFn = null;
	initPromise = null;
	initError = null;
	modelCached = false;
	lastInitFailure = 0;
}

export function getNativeProviderStatus(): NativeProviderSnapshot {
	return {
		initialized: embedFn !== null,
		initializing: initPromise !== null && embedFn === null,
		modelCached,
	};
}
