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

export interface NativeEmbeddingRuntimeOptions {
	readonly runtime?: "wasm" | "onnxruntime";
	readonly onnxRuntimePath?: string;
}

interface ProviderSlot {
	readonly key: string;
	readonly runtime: NativeEmbeddingRuntimeOptions;
	handlePromise: Promise<EmbeddingWorkerHandle> | null;
	resolvedHandle: EmbeddingWorkerHandle | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	activeUses: number;
	idleShutdownPromise: Promise<void> | null;
	initPromise: Promise<unknown> | null;
}

const slots = new Map<string, ProviderSlot>();
let workerFactoryOverride: EmbeddingWorkerFactory | null = null;
let nativeIdleTtlMs = DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS;
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
export function nativeEmbeddingAssetPaths(): typeof assetPathsOverride {
	return assetPathsOverride;
}

function normalizeRuntime(runtime: NativeEmbeddingRuntimeOptions | undefined): NativeEmbeddingRuntimeOptions {
	if (runtime?.runtime !== "onnxruntime") return { runtime: "wasm" };
	return { runtime: "onnxruntime", ...(runtime.onnxRuntimePath ? { onnxRuntimePath: runtime.onnxRuntimePath } : {}) };
}

function slotKey(runtime: NativeEmbeddingRuntimeOptions): string {
	return JSON.stringify([runtime.runtime, runtime.onnxRuntimePath ?? ""]);
}

function slotFor(runtime: NativeEmbeddingRuntimeOptions | undefined): ProviderSlot {
	const normalized = normalizeRuntime(runtime);
	const key = slotKey(normalized);
	let slot = slots.get(key);
	if (!slot) {
		slot = {
			key,
			runtime: normalized,
			handlePromise: null,
			resolvedHandle: null,
			idleTimer: null,
			activeUses: 0,
			idleShutdownPromise: null,
			initPromise: null,
		};
		slots.set(key, slot);
	}
	return slot;
}

function clearIdleTimer(slot: ProviderSlot): void {
	if (slot.idleTimer) {
		clearTimeout(slot.idleTimer);
		slot.idleTimer = null;
	}
}

function scheduleIdleEviction(slot: ProviderSlot): void {
	clearIdleTimer(slot);
	if (
		slot.activeUses > 0 ||
		!slot.resolvedHandle ||
		slot.resolvedHandle.isPermanentlyDisabled() ||
		slot.idleShutdownPromise
	)
		return;

	const expectedHandle = slot.resolvedHandle;
	slot.idleTimer = setTimeout(() => {
		slot.idleTimer = null;
		if (
			slot.activeUses > 0 ||
			slot.resolvedHandle !== expectedHandle ||
			expectedHandle.isPermanentlyDisabled() ||
			slot.idleShutdownPromise
		) {
			if (slot.activeUses === 0) scheduleIdleEviction(slot);
			return;
		}

		logger.info("native-embedding", "Evicting idle embedding worker", {
			idleTtlMs: nativeIdleTtlMs,
			runtime: slot.runtime.runtime,
		});
		const shutdown = shutdownSlot(slot);
		slot.idleShutdownPromise = shutdown;
		void shutdown.then(
			() => {
				if (slot.idleShutdownPromise === shutdown) slot.idleShutdownPromise = null;
				if (slot.activeUses === 0 && slot.resolvedHandle) scheduleIdleEviction(slot);
			},
			(error) => {
				if (slot.idleShutdownPromise === shutdown) slot.idleShutdownPromise = null;
				logger.warn("native-embedding", "Idle embedding worker eviction failed", { error: String(error) });
				if (slot.activeUses === 0 && slot.resolvedHandle) scheduleIdleEviction(slot);
			},
		);
	}, nativeIdleTtlMs);
	slot.idleTimer.unref?.();
}

function beginUse(slot: ProviderSlot): void {
	slot.activeUses++;
	clearIdleTimer(slot);
}

function endUse(slot: ProviderSlot): void {
	slot.activeUses = Math.max(0, slot.activeUses - 1);
	if (slot.activeUses === 0) scheduleIdleEviction(slot);
}
export function configureNativeEmbeddingLifecycle(options: { readonly idleTtlMs?: number }): void {
	if (options.idleTtlMs !== undefined && Number.isFinite(options.idleTtlMs)) {
		nativeIdleTtlMs = Math.max(
			MIN_NATIVE_EMBEDDING_IDLE_TTL_MS,
			Math.min(MAX_NATIVE_EMBEDDING_IDLE_TTL_MS, Math.trunc(options.idleTtlMs)),
		);
		for (const slot of slots.values()) {
			if (slot.activeUses === 0 && slot.resolvedHandle && !slot.idleShutdownPromise) scheduleIdleEviction(slot);
		}
	}
}

async function getHandle(slot: ProviderSlot): Promise<EmbeddingWorkerHandle> {
	if (slot.idleShutdownPromise) await slot.idleShutdownPromise;
	if (!slot.handlePromise) {
		const remoteHostOverride = process.env.SIGNET_EMBEDDING_REMOTE_HOST?.trim() || undefined;
		const runtimeOptions =
			slot.runtime.runtime === "onnxruntime"
				? {
						runtime: "onnxruntime" as const,
						...(slot.runtime.onnxRuntimePath ? { onnxRuntimePath: slot.runtime.onnxRuntimePath } : {}),
					}
				: {};
		slot.handlePromise = createEmbeddingWorkerHandle(
			workerFactoryOverride
				? { workerFactory: workerFactoryOverride, ...runtimeOptions }
				: remoteHostOverride
					? { remoteHostOverride, ...(assetPathsOverride ?? {}), ...runtimeOptions }
					: { ...(assetPathsOverride ?? {}), ...runtimeOptions },
		).then((h) => {
			slot.resolvedHandle = h;
			return h;
		});
	}
	return slot.handlePromise;
}

export async function nativeEmbed(text: string, runtime?: NativeEmbeddingRuntimeOptions): Promise<number[]> {
	const slot = slotFor(runtime);
	beginUse(slot);
	try {
		const handle = await getHandle(slot);
		if (slot.initPromise && !slot.resolvedHandle?.getStatus().initialized) {
			await slot.initPromise.catch(() => {});
			slot.initPromise = null;
		}
		return await handle.embed(text);
	} finally {
		endUse(slot);
	}
}

export async function checkNativeProvider(runtime?: NativeEmbeddingRuntimeOptions): Promise<NativeProviderStatus> {
	const slot = slotFor(runtime);
	beginUse(slot);
	try {
		const handle = await getHandle(slot);
		const p = handle.checkAvailable();
		slot.initPromise = p;
		void p.then(
			() => {
				if (slot.initPromise === p) slot.initPromise = null;
			},
			() => {
				if (slot.initPromise === p) slot.initPromise = null;
			},
		);
		return await p;
	} finally {
		endUse(slot);
	}
}

export function getNativeProviderStatus(runtime?: NativeEmbeddingRuntimeOptions): NativeProviderSnapshot {
	const slot = slots.get(slotKey(normalizeRuntime(runtime)));
	if (slot?.resolvedHandle) return slot.resolvedHandle.getStatus();
	return { initialized: false, initializing: slot?.handlePromise != null, modelCached: false };
}

async function shutdownSlot(slot: ProviderSlot): Promise<void> {
	clearIdleTimer(slot);
	const pending = slot.handlePromise;
	slot.handlePromise = null;
	slot.initPromise = null;
	const h = slot.resolvedHandle;
	slot.resolvedHandle = null;
	if (h) {
		await h.stop();
	} else if (pending) {
		try {
			await (await pending).stop();
		} catch {}
	}
}

export async function shutdownNativeProvider(): Promise<void> {
	await Promise.all([...slots.values()].map((slot) => shutdownSlot(slot)));
}
export function __setEmbeddingWorkerFactoryForTests(factory: EmbeddingWorkerFactory | null): void {
	workerFactoryOverride = factory;
}
export async function __resetEmbeddingProviderForTests(): Promise<void> {
	await shutdownNativeProvider();
	slots.clear();
	workerFactoryOverride = null;
	assetPathsOverride = null;
	nativeIdleTtlMs = DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS;
}
