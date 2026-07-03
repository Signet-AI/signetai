import { readFileSync, statSync } from "node:fs";
import { parseTranscriptSkills } from "@signet/core";
import { logger } from "./logger.js";
import { recordSkillInvocation } from "./skill-invocations";

export const MAX_TRANSCRIPT_SCAN_BYTES = 50 * 1024 * 1024;

export function recordSkillsFromTranscript(args: {
	readonly transcriptPath: string;
	readonly harness: string;
	readonly agentId: string;
	readonly origin?: string; // default "scan"
	readonly expectedSessionId?: string;
}): void {
	if (args.transcriptPath.trim().length === 0) return;

	let content: string;
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
		content = readFileSync(args.transcriptPath, "utf-8");
	} catch (err) {
		logger.debug("skills", "Transcript read failed (non-fatal)", {
			path: args.transcriptPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	// Fire-and-forget telemetry: this must never throw (callers invoke it from
	// setImmediate, where an uncaught throw would crash the daemon). Guard the
	// parse + record loop so the whole function is throw-proof at the contract.
	try {
		const { records, skipped } = parseTranscriptSkills(content);
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
			path: args.transcriptPath,
			records: records.length - skippedSessionMismatch,
			skipped,
			skippedSessionMismatch,
		});
	} catch (err) {
		logger.warn("skills", "Transcript skill scan failed (non-fatal)", err instanceof Error ? err : undefined);
	}
}
