import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WorkerOptions } from "node:worker_threads";
import type { EmbeddingWorkerFactory, EmbeddingWorkerLike } from "./embedding-worker-handle";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";
import {
	__resetEmbeddingProviderForTests,
	__setEmbeddingWorkerFactoryForTests,
	checkNativeProvider,
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
});
