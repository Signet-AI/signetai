/**
 * Worker-thread BPE counter for the Dreaming episodic backlog.
 *
 * The backlog is used by the scheduler and status surfaces, so replacing the
 * exact cl100k count with a character estimate changes product behavior. Keep
 * the expensive encodes in this worker instead of the daemon event loop.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { countTokens } from "./tokenizer";

interface CountRequest {
	readonly type: "count";
	readonly requestId: number;
	readonly entries: readonly { readonly key: string; readonly text: string }[];
}

interface CountResponse {
	readonly type: "counted";
	readonly requestId: number;
	readonly counts: readonly { readonly key: string; readonly count: number }[];
}

const port = parentPort;
if (isMainThread || port === null) {
	throw new Error("dreaming-token-worker.ts must run in a worker thread");
}

port.on("message", (message: CountRequest) => {
	if (message.type !== "count") return;
	const response: CountResponse = {
		type: "counted",
		requestId: message.requestId,
		counts: message.entries.map((entry) => ({ key: entry.key, count: countTokens(entry.text) })),
	};
	port.postMessage(response);
});
