import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "abort") {
		parentPort.postMessage({ type: "aborted", id: 7 });
		setTimeout(() => parentPort.postMessage({ type: "aborted" }), 250);
	}
});
