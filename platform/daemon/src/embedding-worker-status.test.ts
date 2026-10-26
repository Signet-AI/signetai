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
