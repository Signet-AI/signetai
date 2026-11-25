import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "cancel" && message.id > 1) {
		parentPort.postMessage({ type: "aborted", id: message.id });
	}
	if (message.type === "prompt") {
		parentPort.postMessage({ type: "complete", stats: {}, usages: [] });
	}
});
