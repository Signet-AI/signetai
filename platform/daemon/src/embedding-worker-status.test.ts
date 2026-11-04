import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { EmbeddingWorkerInit, EmbeddingWorkerStatus, WorkerToMainMessage } from "./embedding-worker-protocol";

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
});
