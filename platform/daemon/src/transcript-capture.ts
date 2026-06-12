import { ensureCanonicalTranscriptHistory } from "./session-transcripts";
import {
	appendCanonicalTranscriptTurns,
	inferTranscriptSourceFormat,
	writeCanonicalTranscriptSnapshot,
} from "./transcript-jsonl";

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
}): Promise<void> {
	await ensureCanonicalTranscriptHistory(params.basePath, params.agentId);
	await writeCanonicalTranscriptSnapshot({
		basePath: params.basePath,
		agentId: params.agentId,
		harness: params.harness,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		project: params.project ?? null,
		capturedAt: params.capturedAt,
		sourceFormat: params.rawTranscript ? inferTranscriptSourceFormat(params.rawTranscript) : "normalized",
		sourcePath: params.transcriptPath,
		transcript: params.transcript,
	});
}

export async function appendCanonicalLiveTranscriptTurns(params: {
	readonly basePath: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string;
	readonly project?: string | null;
	readonly userMessage: string;
	readonly lastAssistantMessage?: string;
}): Promise<void> {
	await ensureCanonicalTranscriptHistory(params.basePath, params.agentId);
	await appendCanonicalTranscriptTurns({
		basePath: params.basePath,
		agentId: params.agentId,
		harness: params.harness,
		sessionKey: params.sessionKey,
		project: params.project ?? null,
		sourceFormat: "live",
		turns: [
			...(params.lastAssistantMessage ? [{ role: "assistant" as const, content: params.lastAssistantMessage }] : []),
			{ role: "user" as const, content: params.userMessage },
		],
	});
}

export function formatLivePromptTranscript(userMessage: string, lastAssistantMessage?: string): string {
	return [lastAssistantMessage ? `Assistant: ${lastAssistantMessage}` : "", `User: ${userMessage}`]
		.filter((turn) => turn.trim().length > 0)
		.join("\n");
}

export function appendLivePromptTranscript(previous: string | undefined, liveTranscript: string): string {
	const current = liveTranscript.trim();
	if (!previous || previous.trim().length === 0) return current;

	const stored = previous.trimEnd();
	if (stored.endsWith(current)) return stored;
	return `${stored}\n${current}`;
}
