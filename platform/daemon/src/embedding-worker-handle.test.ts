import { afterEach, describe, expect, it } from "bun:test";
import type { WorkerOptions } from "node:worker_threads";
import {
	type EmbeddingWorkerFactory,
	type EmbeddingWorkerLike,
	createEmbeddingWorkerHandle,
} from "./embedding-worker-handle";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";
const flush = (): Promise<void> => Bun.sleep(0);

interface FakeWorkerListeners {
	message: Array<(msg: WorkerToMainMessage) => void>;
	error: Array<(err: Error) => void>;
	exit: Array<(code: number) => void>;
}

class FakeWorker implements EmbeddingWorkerLike {
	readonly posted: MainToWorkerMessage[] = [];
	private readonly listeners: FakeWorkerListeners = { message: [], error: [], exit: [] };
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
		for (const cb of this.listeners.message) cb(msg);
	}

	emitError(err: Error): void {
		for (const cb of this.listeners.error) cb(err);
	}

	emitExit(code: number): void {
		for (const cb of this.listeners.exit) cb(code);
	}
}

function fakePair(): { worker: FakeWorker; factory: EmbeddingWorkerFactory } {
	const worker = new FakeWorker();
	const factory: EmbeddingWorkerFactory = (
		_path: string,
		_init: EmbeddingWorkerInit,
		_options: WorkerOptions,
	): EmbeddingWorkerLike => worker;
	return { worker, factory };
}

const DIM = 768;
const vec = (n = 1 / Math.sqrt(DIM)): number[] => Array<number>(DIM).fill(n);

const handles: Array<{ stop: () => Promise<void> }> = [];

async function makeHandle(worker: FakeWorker, factory: EmbeddingWorkerFactory, opts: Record<string, number> = {}) {
	const handle = await createEmbeddingWorkerHandle({ workerFactory: factory, expectedDimensions: DIM, ...opts });
	worker.emit({ type: "ready" });
	handles.push(handle);
	return handle;
}

afterEach(async () => {
	for (const h of handles.splice(0)) {
		try {
			await h.stop();
		} catch {}
	}
});

function lastEmbedId(worker: FakeWorker): number {
	const req = [...worker.posted].reverse().find((m) => m.type === "embed");
	return req?.type === "embed" ? req.id : -1;
}

function lastCheckId(worker: FakeWorker): number {
	const req = [...worker.posted].reverse().find((m) => m.type === "checkAvailable");
	return req?.type === "checkAvailable" ? req.id : -1;
}

describe("embedding-worker-handle", () => {
	it("embeds via RPC", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		const p = handle.embed("hello");
		await flush();
		expect(worker.posted.some((m) => m.type === "embed" && m.text === "hello")).toBe(true);

		worker.emit({ type: "embed_result", id: lastEmbedId(worker), vector: vec() });
		await expect(p).resolves.toHaveLength(DIM);
	});

	it("checkAvailable reports available when the worker inits", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		const p = handle.checkAvailable();
		await flush();
		worker.emit({ type: "status", status: { initialized: true, initializing: false, modelCached: true, error: null } });
		worker.emit({ type: "check_result", id: lastCheckId(worker), available: true });

		const status = await p;
		expect(status.available).toBe(true);
		expect(status.modelCached).toBe(true);
	});

	it("getStatus() is synchronous and reflects the latest worker status push — even while init is pending", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		void handle.checkAvailable().catch(() => {});
		expect(handle.getStatus().initialized).toBe(false);

		worker.emit({
			type: "status",
			status: { initialized: false, initializing: true, modelCached: false, error: null },
		});
		expect(handle.getStatus().initializing).toBe(true);

		worker.emit({ type: "status", status: { initialized: true, initializing: false, modelCached: true, error: null } });
		expect(handle.getStatus().initialized).toBe(true);
		expect(handle.getStatus().modelCached).toBe(true);
	});

	it("★ main event loop stays responsive while an RPC is stuck (the regression this fixes)", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory, { initTimeoutMs: 10_000 });

		const pending = handle.checkAvailable();
		void pending.catch(() => {});

		const intervals: number[] = [];
		const start = Date.now();
		for (let i = 0; i < 5; i++) {
			await Bun.sleep(25);
			intervals.push(Date.now() - start);
			expect(typeof handle.getStatus().initialized).toBe("boolean");
		}
		for (let i = 0; i < intervals.length; i++) {
			expect(intervals[i]).toBeLessThan(500 * (i + 1));
		}
		expect(intervals.at(-1) ?? 0).toBeLessThan(1_000);
	});

	it("embed fails fast when the worker never responds (bounded RPC timeout)", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory, { embedTimeoutMs: 60, cooldownMs: 5_000 });

		await expect(handle.embed("stuck")).rejects.toThrow(/timed out/);
		const before = worker.posted.length;
		await expect(handle.embed("again")).rejects.toThrow(/cooldown|timed out/);
		expect(worker.posted.length).toBe(before);
	});

	it("checkAvailable fails fast on timeout and marks the provider unavailable", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory, { initTimeoutMs: 60, cooldownMs: 5_000 });

		const status = await handle.checkAvailable();
		expect(status.available).toBe(false);
		expect(status.error).toMatch(/timed out/);
	});

	it("a worker crash rejects pending RPCs and marks the provider unavailable", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		const p = handle.embed("doomed");
		await flush();
		worker.emitError(new Error("wasm segfault"));
		await expect(p).rejects.toThrow(/crashed/);
		expect(handle.getStatus().initialized).toBe(false);
		expect(handle.getLastError()).toMatch(/segfault/);
	});

	it("a non-zero worker exit rejects pending RPCs", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		const p = handle.embed("doomed");
		await flush();
		worker.emitExit(137);
		await expect(p).rejects.toThrow(/exited/);
	});

	it("serializes concurrent embeds so ONNX never runs the shared session concurrently", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		const a = handle.embed("a");
		const b = handle.embed("b");
		await flush();
		let requests = worker.posted.filter((m) => m.type === "embed");
		expect(requests).toHaveLength(1);
		const firstId = requests[0]?.type === "embed" ? requests[0].id : -1;

		worker.emit({ type: "embed_result", id: firstId, vector: vec(0.01) });
		await flush();
		requests = worker.posted.filter((m) => m.type === "embed");
		expect(requests).toHaveLength(2);
		const secondId = requests[1]?.type === "embed" ? requests[1].id : -1;
		expect(secondId).not.toBe(firstId);

		worker.emit({ type: "embed_result", id: secondId, vector: vec(0.02) });
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra[0]).toBeCloseTo(0.01, 5);
		expect(rb[0]).toBeCloseTo(0.02, 5);
	});

	it("does not post queued embeds after an earlier inference times out", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory, { embedTimeoutMs: 40, cooldownMs: 5_000 });

		const first = handle.embed("stuck");
		const queued = handle.embed("queued");
		const outcomes = Promise.allSettled([first, queued]);
		await flush();
		expect(worker.posted.filter((m) => m.type === "embed")).toHaveLength(1);

		const [firstResult, queuedResult] = await outcomes;
		expect(firstResult.status).toBe("rejected");
		expect(String(firstResult.status === "rejected" ? firstResult.reason : "")).toMatch(/timed out/);
		expect(queuedResult.status).toBe("rejected");
		expect(String(queuedResult.status === "rejected" ? queuedResult.reason : "")).toMatch(/timed out|disabled/);
		expect(worker.posted.filter((m) => m.type === "embed")).toHaveLength(1);
	});

	it("stop() posts shutdown, terminates the worker, and rejects further embeds", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory);

		await handle.stop();
		expect(worker.posted.some((m) => m.type === "shutdown")).toBe(true);
		expect(worker.terminated).toBe(true);
		await expect(handle.embed("after")).rejects.toThrow(/shut down/);
	});

	it("keeps a timed-out inference worker disabled after the cooldown window", async () => {
		const { worker, factory } = fakePair();
		const handle = await makeHandle(worker, factory, { embedTimeoutMs: 40, cooldownMs: 80 });

		await expect(handle.embed("first")).rejects.toThrow(/timed out/);
		const posted = worker.posted.length;
		await Bun.sleep(120);
		await expect(handle.embed("retry")).rejects.toThrow(/timed out|disabled/);
		expect(worker.posted).toHaveLength(posted);
		expect(worker.terminated).toBe(true);
	});
	it("uses pre-resolved asset paths instead of the native asset registry (#922)", async () => {
		const { worker, factory } = fakePair();
		const fakeWorkerPath = "/tmp/test-embedding-worker-resolved.mjs";
		const fakeWasmDir = "/tmp/test-wasm-dir";
		const fakeTransformersPath = "/tmp/test-transformers-runtime.mjs";

		const handle = await createEmbeddingWorkerHandle({
			workerFactory: factory,
			expectedDimensions: DIM,
			embeddingWorkerPath: fakeWorkerPath,
			wasmAssetDir: fakeWasmDir,
			transformersRuntimeAssetPath: fakeTransformersPath,
		});
		worker.emit({ type: "ready" });
		handles.push(handle);
		const p = handle.embed("test");
		await flush();
		expect(worker.posted.some((m) => m.type === "embed" && m.text === "test")).toBe(true);
		worker.emit({ type: "embed_result", id: lastEmbedId(worker), vector: vec() });
		await expect(p).resolves.toHaveLength(DIM);
		let capturedPath = "";
		const trackingFactory: EmbeddingWorkerFactory = (path: string) => {
			capturedPath = path;
			return worker;
		};
		await createEmbeddingWorkerHandle({
			workerFactory: trackingFactory,
			expectedDimensions: DIM,
			embeddingWorkerPath: fakeWorkerPath,
		});
		expect(capturedPath).toBe(fakeWorkerPath);
	});

	it("passes pre-resolved wasmDir and transformersRuntimePath into workerData init (#922)", async () => {
		const initCaptures: EmbeddingWorkerInit[] = [];
		const trackingFactory: EmbeddingWorkerFactory = (_path: string, init: EmbeddingWorkerInit): EmbeddingWorkerLike => {
			initCaptures.push(init);
			const w = new FakeWorker();
			return w;
		};
		const fakeWasmDir = "/tmp/test-wasm-dir-922";
		const fakeTransformersPath = "/tmp/test-transformers-922.mjs";
		const handle = await createEmbeddingWorkerHandle({
			workerFactory: trackingFactory,
			expectedDimensions: DIM,
			wasmAssetDir: fakeWasmDir,
			transformersRuntimeAssetPath: fakeTransformersPath,
		});
		handles.push(handle);

		expect(initCaptures.length).toBe(1);
		expect(initCaptures[0].wasmDir).toBe(fakeWasmDir);
		expect(initCaptures[0].transformersRuntimePath).toBe(fakeTransformersPath);
	});
});
