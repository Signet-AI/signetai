import { type EmbeddingWorkerHandle, createEmbeddingWorkerHandle } from "./embedding-worker-handle";
import { logger } from "./logger";
import { nativeEmbeddingAssetPaths } from "./native-embedding";

const RECREATE_AFTER_FAILURE_MS = 300_000;

export interface NativeRerankRuntime {
	readonly device: "default" | "cuda";
	readonly onnxRuntimePath?: string;
	readonly cudaLibraryPaths?: readonly string[];
}

const DEFAULT_RUNTIME: NativeRerankRuntime = { device: "default" };

function runtimeKey(modelId: string, runtime: NativeRerankRuntime): string {
	return JSON.stringify([modelId, runtime.device, runtime.onnxRuntimePath ?? "", ...(runtime.cudaLibraryPaths ?? [])]);
}

let current: {
	readonly key: string;
	readonly requestedKey: string;
	readonly device: "default" | "cuda";
	readonly handle: Promise<EmbeddingWorkerHandle>;
} | null = null;
let failedAt = 0;
let cudaFailedKey: string | null = null;
let inFlight = false;

function createHandle(modelId: string, runtime: NativeRerankRuntime): Promise<EmbeddingWorkerHandle> {
	const remoteHostOverride = process.env.SIGNET_EMBEDDING_REMOTE_HOST?.trim() || undefined;
	const assets = nativeEmbeddingAssetPaths();
	return createEmbeddingWorkerHandle({
		modelId,
		task: "rerank",
		...(assets ?? {}),
		...(remoteHostOverride ? { remoteHostOverride } : {}),
		...(runtime.device === "cuda"
			? {
					device: "cuda" as const,
					...(runtime.onnxRuntimePath ? { onnxRuntimePath: runtime.onnxRuntimePath } : {}),
					...(runtime.cudaLibraryPaths?.length ? { cudaLibraryPaths: runtime.cudaLibraryPaths } : {}),
				}
			: {}),
	});
}

function cudaInitFailed(handle: EmbeddingWorkerHandle): boolean {
	if (handle.isPermanentlyDisabled()) return true;
	const status = handle.getStatus();
	return !status.initialized && !status.initializing && handle.getLastError() !== null;
}

async function handleFor(modelId: string, requested: NativeRerankRuntime): Promise<EmbeddingWorkerHandle> {
	const requestedKey = runtimeKey(modelId, requested);
	const runtime = requested.device === "cuda" && cudaFailedKey === requestedKey ? DEFAULT_RUNTIME : requested;
	const key = runtimeKey(modelId, runtime);
	if (current !== null && (current.key !== key || current.requestedKey !== requestedKey))
		await shutdownNativeReranker();
	if (current !== null) {
		const handle = await current.handle;
		if (current.device === "cuda" && cudaInitFailed(handle)) {
			cudaFailedKey = requestedKey;
			logger.warn("memory", "CUDA cross-encoder unavailable; using the default ONNX runtime", {
				model: modelId,
				error: handle.getLastError(),
			});
			await shutdownNativeReranker();
			return await handleFor(modelId, requested);
		}
		if (!handle.isPermanentlyDisabled()) return handle;
		if (Date.now() - failedAt < RECREATE_AFTER_FAILURE_MS) {
			throw new Error(handle.getLastError() ?? "Cross-encoder disabled after a failure");
		}
		await shutdownNativeReranker();
	}
	current = { key, requestedKey, device: runtime.device, handle: createHandle(modelId, runtime) };
	return await current.handle;
}

export function nativeRerankActiveDevice(): "default" | "cuda" | null {
	return current?.device ?? null;
}

export async function nativeRerank(
	modelId: string,
	query: string,
	documents: readonly string[],
	runtime: NativeRerankRuntime = DEFAULT_RUNTIME,
): Promise<number[]> {
	if (inFlight) throw new Error("cross-encoder busy with another recall");
	inFlight = true;
	try {
		const handle = await handleFor(modelId, runtime);
		if (!handle.getStatus().initialized) {
			if (!handle.getStatus().initializing) void handle.checkAvailable();
			throw new Error("cross-encoder loading");
		}
		try {
			return await handle.rerank(query, documents);
		} catch (error) {
			if (handle.isPermanentlyDisabled()) failedAt = Date.now();
			throw error;
		}
	} finally {
		inFlight = false;
	}
}

export async function shutdownNativeReranker(): Promise<void> {
	const previous = current;
	current = null;
	if (previous === null) return;
	try {
		await (await previous.handle).stop();
	} catch {}
}
