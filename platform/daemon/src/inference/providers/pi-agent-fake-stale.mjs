import { parentPort } from "node:worker_threads";

let pendingId;
parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "cancel") {
		if (message.id === 1) {
			setTimeout(() => parentPort.postMessage({ type: "aborted", id: 1 }), 100);
			return;
		}
		pendingId = message.id;
		parentPort.postMessage({ type: "aborted", id: 1 });
		parentPort.postMessage({ type: "event", event: { type: "agent_start" } });
	}
	if (message.type === "configure") {
		parentPort.postMessage({ type: "configured" });
		if (pendingId !== undefined) parentPort.postMessage({ type: "aborted", id: pendingId });
	}
});
