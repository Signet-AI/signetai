import { parentPort } from "node:worker_threads";
import { buildExportTranscriptRecord, redactCredentials } from "@signet/core";
import type { ExportWorkerInput } from "./projection-worker-client";
const port = parentPort;
if (!port) throw new Error("Export requires a worker thread");
port.on("message", (data: ExportWorkerInput) => {
	const content = redactCredentials(Buffer.concat(data.parts).toString("utf8"));
	if (data.format === "authored") {
		port.postMessage(JSON.stringify({ ...data.record, content }) + "\n");
		return;
	}
	const record = buildExportTranscriptRecord({ ...data.record, content });
	const messages = data.messagesOnly
		? record.messages.filter((message) => message.role === "user" || message.role === "assistant")
		: record.messages;
	port.postMessage(
		JSON.stringify({
			...record,
			authorUserId: data.record.speaker_user_id,
			speakerUserId: data.record.speaker_user_id,
			messages,
			message_count: messages.length,
		}),
	);
});
