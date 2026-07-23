/**
 * Process-isolated host for the native embedding worker.
 *
 * Worker threads keep inference off the daemon event loop, but native runtime
 * mappings and allocator arenas still belong to the daemon process. The edge
 * profile launches this small host as a child process, then runs the existing
 * embedding worker inside it. Killing the host after the idle window lets the
 * operating system reclaim the model and ONNX runtime RSS completely.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { EmbeddingWorkerInit, MainToWorkerMessage, WorkerToMainMessage } from "./embedding-worker-protocol";

const encodedInit = process.env.SIGNET_EMBEDDING_PROCESS_INIT;
if (!encodedInit) throw new Error("SIGNET_EMBEDDING_PROCESS_INIT is required");
Reflect.deleteProperty(process.env, "SIGNET_EMBEDDING_PROCESS_INIT");

const init = JSON.parse(Buffer.from(encodedInit, "base64url").toString("utf8")) as EmbeddingWorkerInit;
const currentDir = dirname(fileURLToPath(import.meta.url));
const bundledWorker = join(currentDir, "embedding-worker.js");
const workerPath = existsSync(bundledWorker) ? bundledWorker : join(currentDir, "embedding-worker.ts");
const worker = new Worker(workerPath, { workerData: init });

worker.on("message", (message: WorkerToMainMessage) => {
	process.send?.(message);
});
worker.on("error", (error) => {
	process.send?.({ type: "error", error: error.message, stack: error.stack } satisfies WorkerToMainMessage);
});
worker.on("exit", (code) => {
	process.exit(code);
});

process.on("message", (message: MainToWorkerMessage) => {
	if (message.type === "shutdown") {
		void worker.terminate().finally(() => process.exit(0));
		return;
	}
	worker.postMessage(message);
});
