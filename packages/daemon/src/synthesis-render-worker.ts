import { parentPort } from "node:worker_threads";
import { initDbAccessorLite } from "./db-accessor";
import { renderMemoryProjection } from "./memory-lineage";
import {
	isInitRequest,
	isRenderRequest,
	type ReadyResponse,
	type RenderError,
	type RenderResult,
	type WorkerRequest,
	type WorkerResponse,
} from "./synthesis-worker-protocol";

function postMessage(message: WorkerResponse): void {
	port.postMessage(message);
}

if (parentPort === null) {
	throw new Error(
		"synthesis-render-worker must run as a worker thread — parentPort is null",
	);
}

const port = parentPort;

port.on("message", (msg: unknown) => {
	const request: WorkerRequest | null = isInitRequest(msg)
		? msg
		: isRenderRequest(msg)
			? msg
			: null;

	if (request === null) return;

	if (request.type === "init") {
		initDbAccessorLite(request.dbPath, request.vecExtensionPath);
		postMessage({ type: "ready" } satisfies ReadyResponse);
		return;
	}

	try {
		const result = renderMemoryProjection(request.agentId);
		postMessage({
			type: "result",
			requestId: request.requestId,
			content: result.content,
			fileCount: result.fileCount,
			indexBlock: result.indexBlock,
		} satisfies RenderResult);
	} catch (err) {
		postMessage({
			type: "error",
			requestId: request.requestId,
			error: err instanceof Error ? err.message : String(err),
		} satisfies RenderError);
	}
});

port.on("error", (err) => {
	console.error("[synthesis-render-worker] parentPort error:", err);
});

process.on("uncaughtException", (err) => {
	console.error("[synthesis-render-worker] uncaughtException:", err);
});
