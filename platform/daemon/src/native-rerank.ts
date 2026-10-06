import { type EmbeddingWorkerHandle, createEmbeddingWorkerHandle } from "./embedding-worker-handle";
import { nativeEmbeddingAssetPaths } from "./native-embedding";

const RECREATE_AFTER_FAILURE_MS = 300_000;

let current: { readonly modelId: string; readonly handle: Promise<EmbeddingWorkerHandle> } | null = null;
let failedAt = 0;
let inFlight = false;

async function handleFor(modelId: string): Promise<EmbeddingWorkerHandle> {
	if (current !== null && current.modelId !== modelId) await shutdownNativeReranker();
	if (current !== null) {
		const handle = await current.handle;
		if (!handle.isPermanentlyDisabled()) return handle;
		if (Date.now() - failedAt < RECREATE_AFTER_FAILURE_MS) {
			throw new Error(handle.getLastError() ?? "Cross-encoder disabled after a failure");
		}
		await shutdownNativeReranker();
	}
	const remoteHostOverride = process.env.SIGNET_EMBEDDING_REMOTE_HOST?.trim() || undefined;
	const assets = nativeEmbeddingAssetPaths();
	current = {
		modelId,
		handle: createEmbeddingWorkerHandle({
			modelId,
			task: "rerank",
			...(assets ?? {}),
			...(remoteHostOverride ? { remoteHostOverride } : {}),
		}),
	};
	return await current.handle;
}

export async function nativeRerank(modelId: string, query: string, documents: readonly string[]): Promise<number[]> {
	if (inFlight) throw new Error("cross-encoder busy with another recall");
	inFlight = true;
	try {
		const handle = await handleFor(modelId);
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
