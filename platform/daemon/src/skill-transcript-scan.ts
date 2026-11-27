import { readFileSync, statSync } from "node:fs";
import { parseTranscriptSkills } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger.js";
import { normalizeSessionKey } from "./session-end-state";
import { recordSkillInvocation } from "./skill-invocations";
import { readTranscriptUploadContent } from "./transcript-upload";

export const MAX_TRANSCRIPT_SCAN_BYTES = 50 * 1024 * 1024;

interface SkillScanScope {
	readonly harness: string;
	readonly agentId: string;
	readonly origin?: string;
	readonly expectedSessionId?: string;
}

export function recordSkillsFromTranscript(args: SkillScanScope & { readonly transcriptPath: string }): void {
	if (args.transcriptPath.trim().length === 0) return;
	try {
		const stat = statSync(args.transcriptPath);
		if (!stat.isFile()) {
			logger.debug("skills", "Transcript scan skipped for non-file path", { path: args.transcriptPath });
			return;
		}
		if (stat.size > MAX_TRANSCRIPT_SCAN_BYTES) {
			logger.warn("skills", "Transcript scan skipped for oversized file", {
				path: args.transcriptPath,
				size: stat.size,
				maxSize: MAX_TRANSCRIPT_SCAN_BYTES,
			});
			return;
		}
		recordSkillsFromContent({
			...args,
			path: args.transcriptPath,
			content: readFileSync(args.transcriptPath, "utf-8"),
		});
	} catch (err) {
		const failure = { path: args.transcriptPath, error: err instanceof Error ? err.message : String(err) };
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			logger.debug("skills", "Transcript scan skipped for missing file", failure);
		} else {
			logger.warn("skills", "Transcript skill scan failed (non-fatal)", failure);
		}
	}
}

function recordSkillsFromContent(args: SkillScanScope & { readonly content: string; readonly path?: string }): void {
	const { records, skipped } = parseTranscriptSkills(args.content);
	const origin = args.origin ?? "scan";
	const expectedSessionId = args.expectedSessionId ? normalizeSessionKey(args.expectedSessionId) : undefined;

	let skippedSessionMismatch = 0;
	for (const rec of records) {
		if (expectedSessionId && rec.sessionId !== expectedSessionId) {
			skippedSessionMismatch++;
			continue;
		}
		recordSkillInvocation({
			skillName: rec.skillName,
			agentId: args.agentId,
			source: "agent",
			latencyMs: rec.latencyMs,
			success: rec.success,
			harness: args.harness,
			sessionId: rec.sessionId || expectedSessionId,
			toolUseId: rec.toolUseId,
			cwd: rec.cwd,
			args: rec.args,
			origin,
			createdAt: rec.createdAtMs > 0 ? new Date(rec.createdAtMs).toISOString() : undefined,
		});
	}

	logger.debug("skills", "Transcript skill scan complete", {
		path: args.path,
		records: records.length - skippedSessionMismatch,
		skipped,
		skippedSessionMismatch,
	});
}

export function scheduleSessionSkillScan(input: {
	readonly basePath: string;
	readonly transcriptPath: string | undefined;
	readonly sessionKey: string | undefined;
	readonly harness: string;
	readonly agentId: string;
}): void {
	const { transcriptPath, sessionKey } = input;
	const scope = {
		harness: input.harness,
		agentId: input.agentId,
		origin: "scan",
		expectedSessionId: sessionKey,
	};
	if (transcriptPath) {
		setImmediate(() => recordSkillsFromTranscript({ ...scope, transcriptPath }));
		return;
	}
	if (!sessionKey) return;
	readTranscriptUploadContent(getDbAccessor(), {
		basePath: input.basePath,
		agentId: input.agentId,
		sessionKey: normalizeSessionKey(sessionKey),
		maxBytes: MAX_TRANSCRIPT_SCAN_BYTES,
	})
		.then((upload) => {
			if (upload) recordSkillsFromContent({ ...scope, content: upload.content });
		})
		.catch((err: unknown) =>
			logger.warn("skills", "Uploaded transcript skill scan failed (non-fatal)", {
				sessionKey,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
}
