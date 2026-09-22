import { readFile } from "node:fs/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { get_encoding, init } from "tiktoken/init";

interface CountRequest {
	readonly type: "count";
	readonly requestId: number;
	readonly entries: readonly { readonly key: string; readonly text: string }[];
	readonly stopAt?: number;
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

const data = workerData as { readonly tokenizerWasmPath?: unknown };
if (typeof data.tokenizerWasmPath !== "string" || data.tokenizerWasmPath.length === 0) {
	throw new Error("dreaming-token-worker.ts requires a tokenizer WASM path");
}
const tokenizerWasmPath = data.tokenizerWasmPath;
await init(async (imports) => WebAssembly.instantiate(await readFile(tokenizerWasmPath), imports));
const tokenizer = get_encoding("cl100k_base");

port.on("message", (message: CountRequest) => {
	if (message.type !== "count") return;
	const counts: Array<{ readonly key: string; readonly count: number }> = [];
	let total = 0;
	for (const entry of message.entries) {
		const count = tokenizer.encode(entry.text).length;
		counts.push({ key: entry.key, count });
		total += count;
		if (message.stopAt !== undefined && total >= message.stopAt) break;
	}
	const response: CountResponse = {
		type: "counted",
		requestId: message.requestId,
		counts,
	};
	port.postMessage(response);
});
