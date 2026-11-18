import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "cancel") {
		parentPort.postMessage({ type: "aborted", id: 999 });
		parentPort.postMessage({ type: "aborted" });
		setTimeout(() => parentPort.postMessage({ type: "aborted", id: message.id }), 300);
	}
});
