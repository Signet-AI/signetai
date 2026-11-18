import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", sessionId: "fake", threadId: 1 });
parentPort.on("message", (message) => {
	if (message.type === "cancel") setTimeout(() => process.exit(3), 150);
});
