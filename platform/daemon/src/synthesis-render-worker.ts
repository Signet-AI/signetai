import { parentPort } from "node:worker_threads";
import { initDbAccessorLite } from "./db-accessor";
import { renderMemoryProjection } from "./memory-lineage";
import {
	type ReadyResponse,
	type RenderError,
	type RenderResult,
	type WorkerRequest,
	type WorkerResponse,
	isInitRequest,
	isRenderRequest,
} from "./synthesis-worker-protocol";

function postMessage(message: WorkerResponse): void {
	port.postMessage(message);
}

if (parentPort === null) {
	throw new Error("synthesis-render-worker must run as a worker thread — parentPort is null");
}

const port = parentPort;

// Serialize renders: only one renderMemoryProjection in flight at a time.
const renderQueue: Array<{ agentId: string; requestId: string }> = [];
let rendering = false;

async function drainRenderQueue(): Promise<void> {
	if (rendering) return;
	rendering = true;
	try {
		let req = renderQueue.shift();
		while (req !== undefined) {
			try {
				const result = await renderMemoryProjection(req.agentId);
				postMessage({
					type: "result",
					requestId: req.requestId,
					content: result.content,
					fileCount: result.fileCount,
					indexBlock: result.indexBlock,
				} satisfies RenderResult);
			} catch (err) {
				postMessage({
					type: "error",
					requestId: req.requestId,
					error: err instanceof Error ? err.message : String(err),
				} satisfies RenderError);
			}
			req = renderQueue.shift();
		}
	} finally {
		rendering = false;
	}
}

port.on("message", (msg: unknown) => {
	const request: WorkerRequest | null = isInitRequest(msg) ? msg : isRenderRequest(msg) ? msg : null;

	if (request === null) return;

	if (request.type === "init") {
		initDbAccessorLite(request.dbPath, request.vecExtensionPath);
		postMessage({ type: "ready" } satisfies ReadyResponse);
		return;
	}

	renderQueue.push({ agentId: request.agentId, requestId: request.requestId });
	void drainRenderQueue();
});

port.on("error", (err) => {
	console.error("[synthesis-render-worker] parentPort error:", err);
});

process.on("uncaughtException", (err) => {
	console.error("[synthesis-render-worker] uncaughtException:", err);
});
