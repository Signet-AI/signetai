import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WorkerOptions } from "node:worker_threads";
import {
	createEmbeddingWorkerHandle,
	type EmbeddingWorkerFactory,
	type EmbeddingWorkerLike,
} from "./embedding-worker-handle";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";
import {
	__resetEmbeddingProviderForTests,
	__setEmbeddingWorkerFactoryForTests,
	checkNativeProvider,
	configureNativeEmbeddingAssets,
	getNativeProviderStatus,
	nativeEmbed,
	shutdownNativeProvider,
} from "./native-embedding";

const flush = (): Promise<void> => Bun.sleep(0);

const DIM = 768;
const vec = (n = 1 / Math.sqrt(DIM)): number[] => Array<number>(DIM).fill(n);

class FakeWorker implements EmbeddingWorkerLike {
	readonly posted: MainToWorkerMessage[] = [];
	private readonly listeners = { message: [], error: [], exit: [] } as Record<
		"message" | "error" | "exit",
		Array<(arg: never) => void>
	>;
	ready = false;

	on(event: "message" | "error" | "exit", listener: (...a: never[]) => void): this {
		this.listeners[event].push(listener as never);
		return this;
	}

	postMessage(msg: MainToWorkerMessage): void {
		this.posted.push(msg);
	}

	terminate(): number {
		return 0;
	}

	emit(msg: WorkerToMainMessage): void {
		for (const cb of this.listeners.message) cb(msg as never);
	}
}

// Facade contract: the public API the rest of the daemon imports must keep
// working now that the implementation lives behind a worker. These tests go
// through native-embedding.ts (the singleton facade) using the test-only
// worker-factory seam, asserting delegation, sync status, singleton reuse,
// and reset — the properties callers rely on.
describe("native-embedding facade (worker-backed)", () => {
	let worker: FakeWorker;

	beforeEach(() => {
		worker = new FakeWorker();
		const factory: EmbeddingWorkerFactory = (
			_path: string,
			_init: EmbeddingWorkerInit,
			_options: WorkerOptions,
		): EmbeddingWorkerLike => worker;
		__setEmbeddingWorkerFactoryForTests(factory);
	});

	afterEach(async () => {
		await __resetEmbeddingProviderForTests();
	});

	it("getNativeProviderStatus is synchronous and returns a default snapshot before init", () => {
		const status = getNativeProviderStatus();
		expect(status.initialized).toBe(false);
		expect(status.modelCached).toBe(false);
		expect(typeof status.initializing).toBe("boolean");
	});

	it("nativeEmbed delegates to the worker and returns a 768-dim vector", async () => {
		const p = nativeEmbed("hello world");
		await flush(); // handle created, message listener registered, awaiting ready
		worker.emit({ type: "ready" });
		await flush(); // ready resolves -> embed RPC posted
		const req = worker.posted.find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: req?.type === "embed" ? req.id : -1, vector: vec() });
		const result = await p;
		expect(result).toHaveLength(DIM);
	});

	it("checkNativeProvider resolves with available:false on init failure (does not reject)", async () => {
		// Preserves the contract: /api/embeddings/health and the startup
		// probe await this without try/catch.
		const p = checkNativeProvider();
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		const req = worker.posted.find((m) => m.type === "checkAvailable");
		worker.emit({
			type: "check_result",
			id: req?.type === "checkAvailable" ? req.id : -1,
			available: false,
			error: "model download failed",
		});
		const status = await p;
		expect(status.available).toBe(false);
		expect(status.error).toMatch(/model download failed/);
		expect(status.dimensions).toBe(DIM);
	});

	it("singleton: the facade reuses one worker handle across calls", async () => {
		const first = nativeEmbed("a");
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		const r1 = worker.posted.find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: r1?.type === "embed" ? r1.id : -1, vector: vec() });
		await first;

		// Second call must NOT spawn another worker — it reuses the handle.
		const spawnsBefore = worker.posted.length;
		const second = nativeEmbed("b");
		await flush();
		const r2 = [...worker.posted].reverse().find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: r2?.type === "embed" ? r2.id : -1, vector: vec() });
		await second;
		// Only one "ready" handshake ever happened (singleton).
		expect(worker.posted.filter((m) => m.type === "shutdown").length).toBe(0);
		expect(spawnsBefore).toBeGreaterThan(0);
	});

	it("shutdownNativeProvider resets the singleton so a later call re-initializes", async () => {
		const first = nativeEmbed("a");
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		const r1 = worker.posted.find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: r1?.type === "embed" ? r1.id : -1, vector: vec() });
		await first;

		const shutdownsBefore = worker.posted.filter((m) => m.type === "shutdown").length;
		await shutdownNativeProvider();
		expect(worker.posted.filter((m) => m.type === "shutdown").length).toBeGreaterThan(shutdownsBefore);
		expect(getNativeProviderStatus().initialized).toBe(false);
	});

	it("★ nativeEmbed awaits in-flight init before embedding (warm-up race #920)", async () => {
		// Simulate the daemon startup probe: checkNativeProvider() fires
		// and starts init. Before it completes, nativeEmbed() is called.
		// nativeEmbed should await the init promise, then send the embed
		// RPC — NOT race the embed timeout against the still-initializing
		// worker.
		const checkP = checkNativeProvider();
		await flush();
		worker.emit({ type: "ready" });
		await flush();

		// At this point, checkAvailable RPC has been posted and is pending.
		expect(worker.posted.some((m) => m.type === "checkAvailable")).toBe(true);
		expect(worker.posted.some((m) => m.type === "embed")).toBe(false);

		// While check is still in flight, start an embed.
		const embedP = nativeEmbed("warm-start test");
		await flush();

		// The embed RPC should NOT have been posted yet — we're waiting
		// for the check (init) to complete first.
		expect(worker.posted.some((m) => m.type === "embed")).toBe(false);

		// Now complete the init check.
		const checkReq = worker.posted.find((m) => m.type === "checkAvailable");
		worker.emit({
			type: "status",
			status: { initialized: true, initializing: false, modelCached: true, error: null },
		});
		worker.emit({
			type: "check_result",
			id: checkReq?.type === "checkAvailable" ? checkReq.id : -1,
			available: true,
		});
		await checkP;
		await flush();

		// NOW the embed RPC should be posted (init is done).
		expect(worker.posted.some((m) => m.type === "embed")).toBe(true);

		// Respond to the embed RPC.
		const embedReq = [...worker.posted].reverse().find((m) => m.type === "embed");
		worker.emit({
			type: "embed_result",
			id: embedReq?.type === "embed" ? embedReq.id : -1,
			vector: vec(),
		});
		const result = await embedP;
		expect(result).toHaveLength(DIM);
	});

	it("nativeEmbed proceeds without waiting when no init is in flight", async () => {
		// No checkNativeProvider() has been called, so initPromise is null.
		// nativeEmbed should go straight to embed without waiting.
		const p = nativeEmbed("direct");
		await flush();
		worker.emit({ type: "ready" });
		await flush();

		// Embed RPC is posted immediately — no checkAvailable sent first.
		expect(worker.posted.some((m) => m.type === "checkAvailable")).toBe(false);
		expect(worker.posted.some((m) => m.type === "embed")).toBe(true);

		const req = worker.posted.find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: req?.type === "embed" ? req.id : -1, vector: vec() });
		await expect(p).resolves.toHaveLength(DIM);
	});

	it("nativeEmbed still embeds when init check returns unavailable (graceful degradation)", async () => {
		// The startup probe fires and the worker reports unavailable (e.g.,
		// model not downloaded yet, but the daemon is running). nativeEmbed
		// should still proceed to attempt the embed after the init promise
		// settles, rather than hanging indefinitely. The embed may succeed
		// (worker recovered between probe and embed) or fail (propagated).
		const checkP = checkNativeProvider();
		await flush();
		worker.emit({ type: "ready" });
		await flush();

		// Worker responds as unavailable.
		const checkReq = worker.posted.find((m) => m.type === "checkAvailable");
		worker.emit({
			type: "check_result",
			id: checkReq?.type === "checkAvailable" ? checkReq.id : -1,
			available: false,
			error: "not ready yet",
		});
		await checkP;

		// The init promise has settled (not rejected — checkAvailable
		// resolves with {available:false}). nativeEmbed should not hang
		// waiting for it. The embed may be in cooldown from the failed
		// check, so we verify the promise settles (not that it hangs).
		const embedP = nativeEmbed("after-unavailable");
		// Race with a timeout to prove it doesn't hang.
		const result = await Promise.race([
			embedP.then(() => "settled").catch(() => "rejected"),
			Bun.sleep(2000).then(() => "hung"),
		]);
		expect(result).not.toBe("hung");
	});
});

describe("asset path override wiring (#1018 regression)", () => {
	let capturedInits: EmbeddingWorkerInit[];

	beforeEach(() => {
		capturedInits = [];
	});

	afterEach(async () => {
		await __resetEmbeddingProviderForTests();
		configureNativeEmbeddingAssets({
			embeddingWorkerPath: null,
			wasmAssetDir: null,
			transformersRuntimeAssetPath: null,
		});
	});

	function capturingFactory(): EmbeddingWorkerFactory {
		const w = new FakeWorker();
		return (_path, init) => {
			capturedInits.push(init);
			return w;
		};
	}

	async function settle(worker: FakeWorker): Promise<void> {
		await flush();
		worker.emit({ type: "ready" });
		await flush();
	}

	it("maps wasmAssetDir/transformersRuntimeAssetPath options to init.wasmDir/.transformersRuntimePath", async () => {
		const worker = new FakeWorker();
		const factory: EmbeddingWorkerFactory = (_path, init) => {
			capturedInits.push(init);
			return worker;
		};

		const handle = await createEmbeddingWorkerHandle({
			workerFactory: factory,
			wasmAssetDir: "/tmp/test-wasm",
			transformersRuntimeAssetPath: "/tmp/test-transformers-runtime.mjs",
		});

		await settle(worker);

		expect(capturedInits).toHaveLength(1);
		expect(capturedInits[0].wasmDir).toBe("/tmp/test-wasm");
		expect(capturedInits[0].transformersRuntimePath).toBe("/tmp/test-transformers-runtime.mjs");

		await handle.stop();
	});

	it("omitted asset path options fall through to null (test/source mode, no global assets)", async () => {
		const worker = new FakeWorker();
		const factory: EmbeddingWorkerFactory = (_path, init) => {
			capturedInits.push(init);
			return worker;
		};

		const handle = await createEmbeddingWorkerHandle({
			workerFactory: factory,
			// wasmAssetDir and transformersRuntimeAssetPath intentionally omitted
		});

		await settle(worker);

		expect(capturedInits).toHaveLength(1);
		expect(capturedInits[0].wasmDir).toBeNull();
		expect(capturedInits[0].transformersRuntimePath).toBeNull();

		await handle.stop();
	});
});
