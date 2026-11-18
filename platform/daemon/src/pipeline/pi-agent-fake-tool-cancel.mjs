import { parentPort } from "node:worker_threads";

let sent = false;
parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "cancel" && !sent) {
		sent = true;
		parentPort.postMessage({ type: "tool", id: 1, name: "slow_tool", toolCallId: "call-1", params: {} });
		parentPort.postMessage({ type: "aborted", id: message.id });
	}
});
