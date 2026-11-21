import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	type EmbeddingWorkerInit,
	type EmbeddingWorkerStatus,
	RELEASE_SIGNAL_FAILED,
	type WorkerToMainMessage,
} from "./worker-protocol";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function failingRuntime(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-embedding-worker-"));
	dirs.push(dir);
	const path = join(dir, "runtime.mjs");
	writeFileSync(
		path,
		`export const env = { backends: { onnx: {} } };
export const AutoTokenizer = { from_pretrained: async () => { throw new Error("model load failed"); } };
export const AutoModelForSequenceClassification = { from_pretrained: async () => { throw new Error("model load failed"); } };
export const pipeline = async () => { throw new Error("model load failed"); };
`,
	);
	return path;
}

describe("embedding worker status", () => {
	for (const runtime of [
		{ task: "embed", runtime: "onnxruntime" },
		{ task: "rerank", runtime: "onnxruntime" },
		{ task: "rerank", device: "cuda" },
	] as const) {
		it(`rejects an unloadable configured ONNX package for ${JSON.stringify(runtime)}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "signet-embedding-runtime-"));
			dirs.push(dir);
			const init: EmbeddingWorkerInit = {
				cacheDir: dir,
				wasmDir: null,
				transformersRuntimePath: null,
				onnxRuntimePath: join(dir, "configured-onnx"),
				remoteHostOverride: "http://127.0.0.1:1/",
				modelId: "test/model",
				expectedDimensions: 4,
				...runtime,
			};
			const worker = new Worker(join(import.meta.dir, "embedding-worker.ts"), { workerData: init });
			try {
				const result = await new Promise<Extract<WorkerToMainMessage, { type: "check_result" }>>((resolve, reject) => {
					worker.on("error", reject);
					worker.on("message", (msg: WorkerToMainMessage) => {
						if (msg.type === "ready") worker.postMessage({ type: "checkAvailable", id: 1 });
						if (msg.type === "check_result") resolve(msg);
					});
				});
				expect(result.available).toBe(false);
				expect(result.error).toMatch(/onnxRuntimePath is set, but this worker build cannot load it/);
			} finally {
				await worker.terminate();
			}
		});
	}

	it("publishes a settled status after a failed initialization so callers can retry or fall back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-cache-"));
		dirs.push(dir);
		const init: EmbeddingWorkerInit = {
			cacheDir: dir,
			wasmDir: null,
			transformersRuntimePath: failingRuntime(),
			modelId: "test/model",
			expectedDimensions: 4,
			task: "rerank",
		};
		const worker = new Worker(join(import.meta.dir, "embedding-worker.ts"), { workerData: init });
		const statuses: EmbeddingWorkerStatus[] = [];
		const checked = new Promise<void>((resolve) => {
			worker.on("message", (msg: WorkerToMainMessage) => {
				if (msg.type === "ready") worker.postMessage({ type: "checkAvailable", id: 1 });
				if (msg.type === "status") statuses.push(msg.status);
				if (msg.type === "check_result") resolve();
			});
		});
		await checked;
		await worker.terminate();

		const last = statuses.at(-1);
		expect(last?.error).toBe("model load failed");
		expect(last?.initialized).toBe(false);
		expect(last?.initializing).toBe(false);
	});

	function recordingRuntime(
		dir: string,
		options: { loadDelayMs: number; score: number; disposeFails?: boolean },
	): string {
		const path = join(dir, "runtime.mjs");
		writeFileSync(
			path,
			`import { appendFileSync } from "node:fs";
const record = (event) => appendFileSync(${JSON.stringify(join(dir, "events.log"))}, event + "\\n");
export const env = { backends: { onnx: {} } };
export const AutoTokenizer = { from_pretrained: async () => () => ({}) };
export const AutoModelForSequenceClassification = {
	from_pretrained: async () => {
		await new Promise((resolve) => setTimeout(resolve, ${options.loadDelayMs}));
		record("loaded");
		const model = async () => ({ logits: { data: [${options.score}], dims: [1, 1] } });
		model.dispose = async () => {
			if (${options.disposeFails === true}) throw new Error("dispose failed");
			record("disposed");
		};
		return model;
	},
};
export const pipeline = async () => { throw new Error("unused"); };
`,
		);
		return path;
	}

	function events(dir: string): string[] {
		const path = join(dir, "events.log");
		return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
	}

	it("disposes a cross-encoder whose warmup fails, so the loaded session is not left without an owner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-warmup-"));
		dirs.push(dir);
		const init: EmbeddingWorkerInit = {
			cacheDir: dir,
			wasmDir: null,
			transformersRuntimePath: recordingRuntime(dir, { loadDelayMs: 0, score: Number.NaN }),
			modelId: "test/model",
			expectedDimensions: 4,
			task: "rerank",
		};
		const worker = new Worker(join(import.meta.dir, "embedding-worker.ts"), { workerData: init });
		try {
			const result = await new Promise<Extract<WorkerToMainMessage, { type: "check_result" }>>((resolve, reject) => {
				worker.on("error", reject);
				worker.on("message", (msg: WorkerToMainMessage) => {
					if (msg.type === "ready") worker.postMessage({ type: "checkAvailable", id: 1 });
					if (msg.type === "check_result") resolve(msg);
				});
			});
			expect(result.available).toBe(false);
			expect(result.error).toBe("Cross-encoder warmup returned no score");
			expect(events(dir)).toEqual(["loaded", "disposed"]);
		} finally {
			await worker.terminate();
		}
	});

	it("acknowledges release only after an in-flight load has settled and its session is disposed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-release-"));
		dirs.push(dir);
		const releaseSignal = new SharedArrayBuffer(4);
		const init: EmbeddingWorkerInit = {
			cacheDir: dir,
			wasmDir: null,
			transformersRuntimePath: recordingRuntime(dir, { loadDelayMs: 150, score: 0.5 }),
			modelId: "test/model",
			expectedDimensions: 4,
			task: "rerank",
			releaseSignal,
		};
		const worker = new Worker(join(import.meta.dir, "embedding-worker.ts"), { workerData: init });
		try {
			const afterRelease = await new Promise<Extract<WorkerToMainMessage, { type: "rerank_error" }>>(
				(resolve, reject) => {
					worker.on("error", reject);
					worker.on("message", (msg: WorkerToMainMessage) => {
						if (msg.type === "ready") {
							worker.postMessage({ type: "checkAvailable", id: 1 });
							worker.postMessage({ type: "shutdown" });
						}
						if (msg.type === "released") {
							expect(events(dir)).toEqual(["loaded", "disposed"]);
							expect(Atomics.load(new Int32Array(releaseSignal), 0)).toBe(1);
							worker.postMessage({ type: "rerank", id: 2, query: "q", documents: ["d"] });
						}
						if (msg.type === "rerank_error") resolve(msg);
					});
				},
			);
			expect(afterRelease.error).toBe("Embedding worker is shutting down");
			expect(events(dir)).toEqual(["loaded", "disposed"]);
		} finally {
			await worker.terminate();
		}
	});

	it("reports a failed disposal instead of acknowledging a confirmed release", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-embedding-release-failed-"));
		dirs.push(dir);
		const releaseSignal = new SharedArrayBuffer(4);
		const init: EmbeddingWorkerInit = {
			cacheDir: dir,
			wasmDir: null,
			transformersRuntimePath: recordingRuntime(dir, { loadDelayMs: 0, score: 0.5, disposeFails: true }),
			modelId: "test/model",
			expectedDimensions: 4,
			task: "rerank",
			releaseSignal,
		};
		const worker = new Worker(join(import.meta.dir, "embedding-worker.ts"), { workerData: init });
		try {
			const released = await new Promise<Extract<WorkerToMainMessage, { type: "released" }>>((resolve, reject) => {
				worker.on("error", reject);
				worker.on("message", (msg: WorkerToMainMessage) => {
					if (msg.type === "ready") worker.postMessage({ type: "checkAvailable", id: 1 });
					if (msg.type === "check_result") worker.postMessage({ type: "shutdown" });
					if (msg.type === "released") resolve(msg);
				});
			});
			expect(released.error).toBe("dispose failed");
			expect(Atomics.load(new Int32Array(releaseSignal), 0)).toBe(RELEASE_SIGNAL_FAILED);
		} finally {
			await worker.terminate();
		}
	});
});
