import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type !== "cancel") return;
	if (message.id === 1) {
		setTimeout(() => parentPort.postMessage({ type: "aborted", id: 1 }), 100);
		return;
	}
	setTimeout(() => parentPort.postMessage({ type: "aborted", id: 1 }), 100);
	setTimeout(() => parentPort.postMessage({ type: "aborted", id: message.id }), 400);
});
