import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";

// #1163: a runaway session once wrote two 302MB audit files (the raw + the
// latest, same content twice), ballooning the transcripts dir and choking
// the daemon's log reader. Cap what is audited and archive by rename so the
// full content is never written twice.
const MAX_AUDIT_TRANSCRIPT_CHARS = 8 * 1024 * 1024;

export function capTranscriptAuditContent(raw: string): string {
	if (raw.length <= MAX_AUDIT_TRANSCRIPT_CHARS) return raw;
	const omitted = raw.length - MAX_AUDIT_TRANSCRIPT_CHARS;
	return `${raw.slice(0, MAX_AUDIT_TRANSCRIPT_CHARS)}\n... [audit transcript truncated at ${MAX_AUDIT_TRANSCRIPT_CHARS} chars; ${omitted} chars omitted] ...\n`;
}

function getTranscriptAuditDir(basePath: string): string {
	return join(basePath, ".daemon", "logs", "transcripts");
}

function fsTimestamp(iso: string): string {
	return Array.from(iso, (char) => (/^[A-Za-z0-9._-]$/.test(char) ? char : "-")).join("");
}

function isSafeAuditName(value: string): boolean {
	return value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value);
}

function buildAuditPath(dir: string, fileName: string): string {
	if (!isSafeAuditName(fileName)) {
		throw new Error("invalid transcript audit file name");
	}
	return join(dir, fileName);
}

function resolveAuditToken(agentId: string, sessionId: string, sessionKey: string | null, raw: string): string {
	const scoped = sessionId.trim() || sessionKey?.trim() || createHash("sha256").update(raw, "utf8").digest("hex");
	return createHash("sha256").update(`${agentId}:${scoped}`, "utf8").digest("hex").slice(0, 16);
}

export interface TranscriptAuditWrite {
	readonly latestPath: string;
	readonly finalPath?: string;
}

export function writeTranscriptAudit(params: {
	readonly basePath?: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly rawTranscript: string;
	readonly capturedAt?: string;
}): TranscriptAuditWrite | null {
	if (params.rawTranscript.trim().length === 0) return null;

	const dir = getTranscriptAuditDir(params.basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath());
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const token = resolveAuditToken(params.agentId, params.sessionId, params.sessionKey, params.rawTranscript);
	const content = capTranscriptAuditContent(params.rawTranscript);
	const latestPath = buildAuditPath(dir, `${token}--latest.log`);
	writeFileSync(latestPath, content, "utf8");

	if (!params.capturedAt) {
		return { latestPath };
	}

	const finalPath = buildAuditPath(dir, `${fsTimestamp(params.capturedAt)}--${token}--raw-transcript.log`);
	// Archive the latest by renaming it — the content is never written twice;
	// the next capture recreates the rolling latest file.
	try {
		renameSync(latestPath, finalPath);
	} catch {
		// The archive matters more than avoiding the copy; fall back to a
		// direct write of the (already capped) content.
		writeFileSync(finalPath, content, "utf8");
	}
	return { latestPath, finalPath };
}
