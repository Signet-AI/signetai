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
	configureNativeEmbeddingLifecycle,
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
	terminated = false;

	on(event: "message" | "error" | "exit", listener: (...a: never[]) => void): this {
		this.listeners[event].push(listener as never);
		return this;
	}

	postMessage(msg: MainToWorkerMessage): void {
		this.posted.push(msg);
	}

	terminate(): number {
		this.terminated = true;
		return 0;
	}

	emit(msg: WorkerToMainMessage): void {
		for (const cb of this.listeners.message) cb(msg as never);
	}
}
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
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		const req = worker.posted.find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: req?.type === "embed" ? req.id : -1, vector: vec() });
		const result = await p;
		expect(result).toHaveLength(DIM);
	});

	it("checkNativeProvider resolves with available:false on init failure (does not reject)", async () => {
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
		const spawnsBefore = worker.posted.length;
		const second = nativeEmbed("b");
		await flush();
		const r2 = [...worker.posted].reverse().find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: r2?.type === "embed" ? r2.id : -1, vector: vec() });
		await second;
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

	it("evicts the idle worker and recreates it on the next embedding", async () => {
		configureNativeEmbeddingLifecycle({ idleTtlMs: 1000 });
		const workers: FakeWorker[] = [];
		__setEmbeddingWorkerFactoryForTests((_path, _init, _options) => {
			const next = new FakeWorker();
			workers.push(next);
			return next;
		});

		const first = nativeEmbed("before eviction");
		await flush();
		workers[0]?.emit({ type: "ready" });
		await flush();
		const firstReq = workers[0]?.posted.find((m) => m.type === "embed");
		workers[0]?.emit({
			type: "embed_result",
			id: firstReq?.type === "embed" ? firstReq.id : -1,
			vector: vec(),
		});
		await first;

		await Bun.sleep(1200);
		expect(workers[0]?.terminated).toBe(true);
		expect(getNativeProviderStatus().initialized).toBe(false);

		const second = nativeEmbed("after eviction");
		await flush();
		expect(workers).toHaveLength(2);
		workers[1]?.emit({ type: "ready" });
		await flush();
		const secondReq = workers[1]?.posted.find((m) => m.type === "embed");
		workers[1]?.emit({
			type: "embed_result",
			id: secondReq?.type === "embed" ? secondReq.id : -1,
			vector: vec(0.02),
		});
		await expect(second).resolves.toHaveLength(DIM);
	});

	it("★ nativeEmbed awaits in-flight init before embedding (warm-up race #920)", async () => {
		const checkP = checkNativeProvider();
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		expect(worker.posted.some((m) => m.type === "checkAvailable")).toBe(true);
		expect(worker.posted.some((m) => m.type === "embed")).toBe(false);
		const embedP = nativeEmbed("warm-start test");
		await flush();
		expect(worker.posted.some((m) => m.type === "embed")).toBe(false);
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
		expect(worker.posted.some((m) => m.type === "embed")).toBe(true);
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
		const p = nativeEmbed("direct");
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		expect(worker.posted.some((m) => m.type === "checkAvailable")).toBe(false);
		expect(worker.posted.some((m) => m.type === "embed")).toBe(true);

		const req = worker.posted.find((m) => m.type === "embed");
		worker.emit({ type: "embed_result", id: req?.type === "embed" ? req.id : -1, vector: vec() });
		await expect(p).resolves.toHaveLength(DIM);
	});

	it("nativeEmbed still embeds when init check returns unavailable (graceful degradation)", async () => {
		const checkP = checkNativeProvider();
		await flush();
		worker.emit({ type: "ready" });
		await flush();
		const checkReq = worker.posted.find((m) => m.type === "checkAvailable");
		worker.emit({
			type: "check_result",
			id: checkReq?.type === "checkAvailable" ? checkReq.id : -1,
			available: false,
			error: "not ready yet",
		});
		await checkP;
		const embedP = nativeEmbed("after-unavailable");
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
		});

		await settle(worker);

		expect(capturedInits).toHaveLength(1);
		expect(capturedInits[0].wasmDir).toBeNull();
		expect(capturedInits[0].transformersRuntimePath).toBeNull();

		await handle.stop();
	});
});
