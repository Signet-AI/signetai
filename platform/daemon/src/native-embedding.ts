/**
 * Native embedding provider — public facade.
 *
 * The ONNX (nomic-embed-text) runtime now lives in a worker_threads Worker
 * (see embedding-worker.ts / embedding-worker-handle.ts). Running download,
 * WASM compile, and per-call inference off the daemon's main event loop is
 * what keeps /health and every HTTP handler responsive regardless of
 * embedding state — the bug this file previously hosted ran all of that
 * in-process on the main thread and could wedge the whole daemon during a
 * first-run model download.
 *
 * This module preserves the exact public API the rest of the daemon depends
 * on (`embedding-fetch.ts`, `routes/utils.ts`, `daemon.ts`), delegating to a
 * lazily-created singleton worker handle. `getNativeProviderStatus()` stays
 * synchronous (it reads a cache the worker pushes to), so status/health
 * paths never await the worker.
 */

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

// ---------------------------------------------------------------------------
// Singleton handle
// ---------------------------------------------------------------------------

let handlePromise: Promise<EmbeddingWorkerHandle> | null = null;
let resolvedHandle: EmbeddingWorkerHandle | null = null;
let workerFactoryOverride: EmbeddingWorkerFactory | null = null;
let nativeIdleTtlMs = DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeUses = 0;
let idleShutdownPromise: Promise<void> | null = null;

/**
 * Pre-resolved native asset paths, set by configureNativeEmbeddingAssets()
 * when the daemon starts. When set, createEmbeddingWorkerHandle() uses these
 * instead of calling resolveEmbeddedWorkerPath()/materializeEmbeddedWasmAssets()
 * — necessary because the extraction worker thread spawns its own embedding
 * worker handle, and `globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__` is not
 * registered inside worker threads (#922).
 */
let assetPathsOverride: {
	readonly embeddingWorkerPath: string | null;
	readonly wasmAssetDir: string | null;
	readonly transformersRuntimeAssetPath: string | null;
} | null = null;

/**
 * Configure pre-resolved native asset paths for the embedding worker. Called
 * once from the main thread (daemon startup) after registerNativeAssets().
 * The values are inherited by all subsequent createEmbeddingWorkerHandle()
 * calls — including those from inside the extraction worker thread, which
 * reads this module's module-level state.
 *
 * In source mode (no native assets), pass nulls.
 */
export function configureNativeEmbeddingAssets(paths: {
	readonly embeddingWorkerPath: string | null;
	readonly wasmAssetDir: string | null;
	readonly transformersRuntimeAssetPath: string | null;
}): void {
	assetPathsOverride = paths;
}

// Tracks the most recent init/warm-up attempt. When the daemon's startup
// probe calls checkNativeProvider(), this promise is set. nativeEmbed()
// awaits it before calling embed() so the first `signet remember` after a
// daemon restart waits for the native worker to finish initializing (model
// load + WASM compile) instead of racing the 15 s embed timeout and losing
// (#920).
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

/** Configure the native worker's bounded idle lifetime from canonical config. */
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
		// SIGNET_EMBEDDING_REMOTE_HOST: test/debug seam that redirects the
		// transformers model fetch (env.remoteHost). The event-loop isolation
		// test points it at a local blackhole so first-run download "hangs"
		// hermetically, without real network.
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

// ---------------------------------------------------------------------------
// Public API (unchanged signatures)
// ---------------------------------------------------------------------------

export async function nativeEmbed(text: string): Promise<number[]> {
	beginUse();
	try {
		const handle = await getHandle();
		// If an init/warm-up is in flight (e.g., the startup probe hasn't
		// completed yet), await it before embedding. This ensures the first
		// `signet remember` after a daemon restart waits for the native worker
		// to finish initializing instead of racing the 15 s embed timeout and
		// silently saving without an embedding (#920).
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
		// Clear once settled so subsequent nativeEmbed calls don't await a stale promise.
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
	// No handle resolved yet: report "initializing" if creation is in flight,
	// otherwise the default pre-init snapshot. Never awaits.
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
		// Handle was still coming up; await then stop it.
		try {
			await (await pending).stop();
		} catch {
			// best-effort during teardown
		}
	}
}

// ---------------------------------------------------------------------------
// Test-only seams
// ---------------------------------------------------------------------------

/** @internal Inject a worker factory (e.g. a fake that speaks the IPC
 *  protocol) BEFORE the first call. Call __resetEmbeddingProviderForTests()
 *  to clear the singleton between tests. */
export function __setEmbeddingWorkerFactoryForTests(factory: EmbeddingWorkerFactory | null): void {
	workerFactoryOverride = factory;
}

/** @internal Reset the singleton handle between tests. */
export async function __resetEmbeddingProviderForTests(): Promise<void> {
	await shutdownNativeProvider();
	workerFactoryOverride = null;
	assetPathsOverride = null;
	nativeIdleTtlMs = DEFAULT_NATIVE_EMBEDDING_IDLE_TTL_MS;
	activeUses = 0;
}
