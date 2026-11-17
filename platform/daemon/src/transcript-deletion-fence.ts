import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveDefaultBasePath, resolveWorkspaceLayout } from "@signet/core";
import { normalizeSessionKey } from "./session-key";

export function transcriptDeletionFencePath(input: {
	readonly basePath?: string;
	readonly agentId: string;
	readonly sessionKey: string;
}): string {
	const key = createHash("sha256")
		.update(JSON.stringify([input.agentId, normalizeSessionKey(input.sessionKey)]))
		.digest("hex");
	return join(resolveWorkspaceLayout(input.basePath ?? resolveDefaultBasePath()).transcripts, ".deleted", key);
}

export async function isTranscriptFileDeleted(input: {
	readonly basePath?: string;
	readonly agentId: string;
	readonly sessionKey: string | null;
	readonly sessionId?: string | null;
}): Promise<boolean> {
	for (const key of new Set([input.sessionKey, input.sessionId])) {
		if (!key) continue;
		try {
			await stat(transcriptDeletionFencePath({ ...input, sessionKey: key }));
			return true;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	return false;
}
