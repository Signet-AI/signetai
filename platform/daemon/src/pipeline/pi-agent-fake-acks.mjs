import { parentPort } from "node:worker_threads";

let cancelId;
parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "cancel") {
		cancelId = message.id;
		parentPort.postMessage({ type: "aborted", id: 999 });
		parentPort.postMessage({ type: "aborted" });
		parentPort.postMessage({ type: "event", event: { type: "agent_start" } });
	}
	if (message.type === "configure") {
		parentPort.postMessage({ type: "configured" });
		if (cancelId !== undefined) parentPort.postMessage({ type: "aborted", id: cancelId });
	}
});
