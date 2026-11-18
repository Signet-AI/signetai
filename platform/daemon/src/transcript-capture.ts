import { stripInternalMemoryContext } from "@signet/core";
import { captureTranscriptOwned } from "./session-transcript-lifecycle";
import { ensureCanonicalTranscriptHistory } from "./session-transcripts";
import { type CanonicalTranscriptRecord, canonicalSessionText, inferTranscriptSourceFormat } from "./transcript-jsonl";

export async function writeCanonicalTranscriptFromSnapshot(params: {
	readonly basePath: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId?: string | null;
	readonly project?: string | null;
	readonly rawTranscript: string;
	readonly transcript: string;
	readonly capturedAt?: string;
	readonly transcriptPath?: string;
	readonly preserveExistingSession?: boolean;
}): Promise<string | null> {
	const capturedAt = params.capturedAt ?? new Date().toISOString();
	if (!params.transcriptPath) await ensureCanonicalTranscriptHistory(params.basePath, params.agentId);
	const records = await captureTranscriptOwned<readonly CanonicalTranscriptRecord[] | null>({
		kind: "snapshot",
		input: {
			basePath: params.basePath,
			agentId: params.agentId,
			harness: params.harness,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			project: params.project ?? null,
			capturedAt,
			sourceFormat: params.rawTranscript ? inferTranscriptSourceFormat(params.rawTranscript) : "normalized",
			sourcePath: params.transcriptPath,
			preserveExistingSession: params.preserveExistingSession,
			transcript: stripInternalMemoryContext(params.transcript),
		},
	});
	if (!records) return null;
	return records.some((record) => record.source_format === "live") ? canonicalSessionText(records) : params.transcript;
}

export async function appendCanonicalLiveTranscriptTurns(params: {
	readonly basePath: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string;
	readonly project?: string | null;
	readonly userMessage: string;
	readonly lastAssistantMessage?: string;
}): Promise<boolean> {
	const capturedAt = new Date().toISOString();
	await ensureCanonicalTranscriptHistory(params.basePath, params.agentId);
	return captureTranscriptOwned<boolean>({
		kind: "turns",
		input: {
			basePath: params.basePath,
			agentId: params.agentId,
			harness: params.harness,
			sessionKey: params.sessionKey,
			project: params.project ?? null,
			capturedAt,
			sourceFormat: "live",
			turns: [
				...(params.lastAssistantMessage
					? [{ role: "assistant" as const, content: stripInternalMemoryContext(params.lastAssistantMessage) }]
					: []),
				{ role: "user" as const, content: stripInternalMemoryContext(params.userMessage) },
			],
		},
	});
}

export async function appendCanonicalLiveAssistantTurn(params: {
	readonly basePath: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string;
	readonly project?: string | null;
	readonly message: string;
}): Promise<boolean> {
	const capturedAt = new Date().toISOString();
	await ensureCanonicalTranscriptHistory(params.basePath, params.agentId);
	return captureTranscriptOwned<boolean>({
		kind: "turns",
		input: {
			basePath: params.basePath,
			agentId: params.agentId,
			harness: params.harness,
			sessionKey: params.sessionKey,
			project: params.project ?? null,
			capturedAt,
			sourceFormat: "live",
			turns: [{ role: "assistant", content: stripInternalMemoryContext(params.message) }],
		},
	});
}

export function formatLiveAssistantTranscript(message: string): string {
	const clean = stripInternalMemoryContext(message).trim();
	return clean ? `Assistant: ${clean}` : "";
}

export function formatLivePromptTranscript(userMessage: string, lastAssistantMessage?: string): string {
	const cleanUserMessage = stripInternalMemoryContext(userMessage);
	const cleanAssistantMessage = lastAssistantMessage ? stripInternalMemoryContext(lastAssistantMessage) : "";
	return [cleanAssistantMessage ? `Assistant: ${cleanAssistantMessage}` : "", `User: ${cleanUserMessage}`]
		.filter((turn) => turn.trim().length > 0)
		.join("\n");
}
