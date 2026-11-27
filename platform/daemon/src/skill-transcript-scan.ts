import { readFileSync, statSync } from "node:fs";
import { parseTranscriptSkills, resolveDefaultBasePath } from "@signet/core";
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
		recordSkillsFromContent({ ...args, content: readFileSync(args.transcriptPath, "utf-8") });
	} catch (err) {
		logger.warn("skills", "Transcript skill scan failed (non-fatal)", {
			path: args.transcriptPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function recordSkillsFromContent(args: SkillScanScope & { readonly content: string }): void {
	const { records, skipped } = parseTranscriptSkills(args.content);
	const origin = args.origin ?? "scan";

	let skippedSessionMismatch = 0;
	for (const rec of records) {
		if (args.expectedSessionId && rec.sessionId !== args.expectedSessionId) {
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
			sessionId: rec.sessionId || args.expectedSessionId,
			toolUseId: rec.toolUseId,
			cwd: rec.cwd,
			args: rec.args,
			origin,
			createdAt: rec.createdAtMs > 0 ? new Date(rec.createdAtMs).toISOString() : undefined,
		});
	}

	logger.debug("skills", "Transcript skill scan complete", {
		records: records.length - skippedSessionMismatch,
		skipped,
		skippedSessionMismatch,
	});
}

export function scheduleSessionSkillScan(input: {
	readonly transcriptPath: string | undefined;
	readonly sessionKey: string | undefined;
	readonly harness: string;
	readonly agentId: string;
}): void {
	const { transcriptPath, sessionKey } = input;
	const scope = { harness: input.harness, agentId: input.agentId, origin: "scan", expectedSessionId: sessionKey };
	if (transcriptPath) {
		setImmediate(() => recordSkillsFromTranscript({ ...scope, transcriptPath }));
		return;
	}
	if (!sessionKey) return;
	readTranscriptUploadContent(getDbAccessor(), {
		basePath: resolveDefaultBasePath(),
		agentId: input.agentId,
		sessionKey: normalizeSessionKey(sessionKey),
		maxBytes: MAX_TRANSCRIPT_SCAN_BYTES,
	})
		.then((content) => {
			if (content) recordSkillsFromContent({ ...scope, content });
		})
		.catch((err: unknown) =>
			logger.warn("skills", "Uploaded transcript skill scan failed (non-fatal)", {
				sessionKey,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
}
