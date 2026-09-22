import {
	type EmbeddingProviderSnapshot,
	type EmbeddingProviderStatus,
	type EmbeddingWorkerFactory,
	type EmbeddingWorkerHandle,
	createEmbeddingWorkerHandle,
} from "./embedding-worker-handle";
import {
	DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS,
	MAX_NATIVE_EMBEDDING_IDLE_TTL_MS,
	MIN_NATIVE_EMBEDDING_IDLE_TTL_MS,
} from "./memory-config";
import { logger } from "./logger";

export type NativeProviderStatus = EmbeddingProviderStatus;
export type NativeProviderSnapshot = EmbeddingProviderSnapshot;

let handlePromise: Promise<EmbeddingWorkerHandle> | null = null;
let resolvedHandle: EmbeddingWorkerHandle | null = null;
let workerFactoryOverride: EmbeddingWorkerFactory | null = null;
let nativeIdleTtlMs = DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeUses = 0;
let idleShutdownPromise: Promise<void> | null = null;
let assetPathsOverride: {
	readonly embeddingWorkerPath: string | null;
	readonly wasmAssetDir: string | null;
	readonly transformersRuntimeAssetPath: string | null;
} | null = null;
export function configureNativeEmbeddingAssets(paths: {
	readonly embeddingWorkerPath: string | null;
	readonly wasmAssetDir: string | null;
	readonly transformersRuntimeAssetPath: string | null;
}): void {
	assetPathsOverride = paths;
}
let initPromise: Promise<unknown> | null = null;

function clearIdleTimer(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

function scheduleIdleEviction(): void {
	clearIdleTimer();
	if (activeUses > 0 || !resolvedHandle || resolvedHandle.isPermanentlyDisabled() || idleShutdownPromise) return;

	const expectedHandle = resolvedHandle;
	idleTimer = setTimeout(() => {
		idleTimer = null;
		if (
			activeUses > 0 ||
			resolvedHandle !== expectedHandle ||
			expectedHandle.isPermanentlyDisabled() ||
			idleShutdownPromise
		) {
			if (activeUses === 0) scheduleIdleEviction();
			return;
		}

		logger.info("native-embedding", "Evicting idle embedding worker", { idleTtlMs: nativeIdleTtlMs });
		const shutdown = shutdownNativeProvider();
		idleShutdownPromise = shutdown;
		void shutdown.then(
			() => {
				if (idleShutdownPromise === shutdown) idleShutdownPromise = null;
				if (activeUses === 0 && resolvedHandle) scheduleIdleEviction();
			},
			(error) => {
				if (idleShutdownPromise === shutdown) idleShutdownPromise = null;
				logger.warn("native-embedding", "Idle embedding worker eviction failed", { error: String(error) });
				if (activeUses === 0 && resolvedHandle) scheduleIdleEviction();
			},
		);
	}, nativeIdleTtlMs);
	idleTimer.unref?.();
}

function beginUse(): void {
	activeUses++;
	clearIdleTimer();
}

function endUse(): void {
	activeUses = Math.max(0, activeUses - 1);
	if (activeUses === 0) scheduleIdleEviction();
}
export function configureNativeEmbeddingLifecycle(options: { readonly idleTtlMs?: number }): void {
	if (options.idleTtlMs !== undefined && Number.isFinite(options.idleTtlMs)) {
		nativeIdleTtlMs = Math.max(
			MIN_NATIVE_EMBEDDING_IDLE_TTL_MS,
			Math.min(MAX_NATIVE_EMBEDDING_IDLE_TTL_MS, Math.trunc(options.idleTtlMs)),
		);
		if (activeUses === 0 && resolvedHandle && !idleShutdownPromise) scheduleIdleEviction();
	}
}

async function getHandle(): Promise<EmbeddingWorkerHandle> {
	if (idleShutdownPromise) await idleShutdownPromise;
	if (!handlePromise) {
		const remoteHostOverride = process.env.SIGNET_EMBEDDING_REMOTE_HOST?.trim() || undefined;
		handlePromise = createEmbeddingWorkerHandle(
			workerFactoryOverride
				? { workerFactory: workerFactoryOverride }
				: remoteHostOverride
					? { remoteHostOverride, ...(assetPathsOverride ?? {}) }
					: { ...(assetPathsOverride ?? {}) },
		).then((h) => {
			resolvedHandle = h;
			return h;
		});
	}
	return handlePromise;
}

export async function nativeEmbed(text: string): Promise<number[]> {
	beginUse();
	try {
		const handle = await getHandle();
		if (initPromise && !resolvedHandle?.getStatus().initialized) {
			await initPromise.catch(() => {});
			initPromise = null;
		}
		return await handle.embed(text);
	} finally {
		endUse();
	}
}

export async function checkNativeProvider(): Promise<NativeProviderStatus> {
	beginUse();
	try {
		const handle = await getHandle();
		const p = handle.checkAvailable();
		initPromise = p;
		void p.then(
			() => {
				if (initPromise === p) initPromise = null;
			},
			() => {
				if (initPromise === p) initPromise = null;
			},
		);
		return await p;
	} finally {
		endUse();
	}
}

export function getNativeProviderStatus(): NativeProviderSnapshot {
	if (resolvedHandle) return resolvedHandle.getStatus();
	return { initialized: false, initializing: handlePromise !== null, modelCached: false };
}

export async function shutdownNativeProvider(): Promise<void> {
	clearIdleTimer();
	const pending = handlePromise;
	handlePromise = null;
	initPromise = null;
	const h = resolvedHandle;
	resolvedHandle = null;
	if (h) {
		await h.stop();
	} else if (pending) {
		try {
			await (await pending).stop();
		} catch {}
	}
}
export function __setEmbeddingWorkerFactoryForTests(factory: EmbeddingWorkerFactory | null): void {
	workerFactoryOverride = factory;
}
export async function __resetEmbeddingProviderForTests(): Promise<void> {
	await shutdownNativeProvider();
	workerFactoryOverride = null;
	assetPathsOverride = null;
	nativeIdleTtlMs = DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS;
	activeUses = 0;
}
