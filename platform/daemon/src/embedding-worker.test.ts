import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { EmbeddingWorkerInit, WorkerToMainMessage } from "./embedding-worker-protocol";

const FAKE_RUNTIME = `
export const env = { backends: { onnx: {} } };
export const AutoTokenizer = {
	from_pretrained: async () => (texts, opts) => ({
		rows: texts.map((query, index) => query + "|" + opts.text_pair[index]),
		padding: opts.padding,
	}),
};
export const AutoModelForSequenceClassification = {
	from_pretrained: async () => async (inputs) => {
		const padded = Math.max(...inputs.rows.map((row) => row.length));
		const data = new Float32Array(inputs.rows.length * 2);
		inputs.rows.forEach((row, index) => {
			data[index * 2] = -1;
			data[index * 2 + 1] = row.length + (inputs.padding ? padded : row.length) / 1000;
		});
		return { logits: { data, dims: [inputs.rows.length, 2] } };
	},
};
export const pipeline = async () => {
	throw new Error("embedding pipeline is not used by the rerank task");
};
`;

let dir = "";
let worker: Worker | null = null;
let nextId = 1;

function rerank(query: string, documents: readonly string[]): Promise<number[]> {
	const active = worker;
	if (!active) throw new Error("worker not started");
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const onMessage = (msg: WorkerToMainMessage) => {
			if (msg.type === "rerank_result" && msg.id === id) {
				active.off("message", onMessage);
				resolve([...msg.scores]);
			} else if (msg.type === "rerank_error" && msg.id === id) {
				active.off("message", onMessage);
				reject(new Error(msg.error));
			}
		};
		active.on("message", onMessage);
		active.postMessage({ type: "rerank", id, query, documents });
	});
}

describe("embedding worker cross-encoder", () => {
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-rerank-worker-"));
		const runtimePath = join(dir, "fake-transformers.mjs");
		writeFileSync(runtimePath, FAKE_RUNTIME);
		const init: EmbeddingWorkerInit = {
			cacheDir: join(dir, "cache"),
			wasmDir: null,
			transformersRuntimePath: runtimePath,
			modelId: "fake/cross-encoder",
			expectedDimensions: 0,
			task: "rerank",
		};
		const started = new Worker(new URL("./embedding-worker.ts", import.meta.url), { workerData: init });
		await new Promise<void>((resolve, reject) => {
			const onMessage = (msg: WorkerToMainMessage) => {
				if (msg.type !== "ready") return;
				started.off("message", onMessage);
				resolve();
			};
			started.on("message", onMessage);
			started.once("error", reject);
		});
		worker = started;
	});

	afterAll(async () => {
		await worker?.terminate();
		rmSync(dir, { recursive: true, force: true });
	});

	test("scores each document independently of the other candidates", async () => {
		const short = "short note";
		const long = "a much longer memory about the deployment checklist and its rollback steps";
		const alone = [...(await rerank("query", [short])), ...(await rerank("query", [long]))];
		const together = await rerank("query", [short, long]);

		expect(together).toEqual(alone);
		expect(alone[0]).toBeCloseTo(`query|${short}`.length * 1.001, 3);
	});

	test("returns no scores for no documents", async () => {
		expect(await rerank("query", [])).toEqual([]);
	});
});
