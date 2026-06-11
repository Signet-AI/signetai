import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";

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
	const latestPath = buildAuditPath(dir, `${token}--latest.log`);
	writeFileSync(latestPath, params.rawTranscript, "utf8");

	if (!params.capturedAt) {
		return { latestPath };
	}

	const finalPath = buildAuditPath(dir, `${fsTimestamp(params.capturedAt)}--${token}--raw-transcript.log`);
	writeFileSync(finalPath, params.rawTranscript, "utf8");
	return { latestPath, finalPath };
}
