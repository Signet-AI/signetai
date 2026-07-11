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

export type NativeProviderStatus = EmbeddingProviderStatus;
export type NativeProviderSnapshot = EmbeddingProviderSnapshot;

// ---------------------------------------------------------------------------
// Singleton handle
// ---------------------------------------------------------------------------

let handlePromise: Promise<EmbeddingWorkerHandle> | null = null;
let resolvedHandle: EmbeddingWorkerHandle | null = null;
let workerFactoryOverride: EmbeddingWorkerFactory | null = null;

// Tracks the most recent init/warm-up attempt. When the daemon's startup
// probe calls checkNativeProvider(), this promise is set. nativeEmbed()
// awaits it before calling embed() so the first `signet remember` after a
// daemon restart waits for the native worker to finish initializing (model
// load + WASM compile) instead of racing the 15 s embed timeout and losing
// (#920).
let initPromise: Promise<unknown> | null = null;

function getHandle(): Promise<EmbeddingWorkerHandle> {
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
					? { remoteHostOverride }
					: {},
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
	return handle.embed(text);
}

export async function checkNativeProvider(): Promise<NativeProviderStatus> {
	const handle = await getHandle();
	const p = handle.checkAvailable();
	initPromise = p;
	// Clear once settled so subsequent nativeEmbed calls don't await a stale promise.
	p.finally(() => {
		if (initPromise === p) initPromise = null;
	});
	return p;
}

export function getNativeProviderStatus(): NativeProviderSnapshot {
	if (resolvedHandle) return resolvedHandle.getStatus();
	// No handle resolved yet: report "initializing" if creation is in flight,
	// otherwise the default pre-init snapshot. Never awaits.
	return { initialized: false, initializing: handlePromise !== null, modelCached: false };
}

export async function shutdownNativeProvider(): Promise<void> {
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
}
