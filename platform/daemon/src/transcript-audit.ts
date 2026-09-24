import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";

const MAX_AUDIT_TRANSCRIPT_CHARS = 8 * 1024 * 1024;
const MAX_AUDIT_PREVIEW_BYTES = 64 * 1024;
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function capTranscriptAuditContent(raw: string): string {
	if (raw.length <= MAX_AUDIT_TRANSCRIPT_CHARS) return raw;
	const omitted = raw.length - MAX_AUDIT_TRANSCRIPT_CHARS;
	return `${raw.slice(0, MAX_AUDIT_TRANSCRIPT_CHARS)}\n... [audit transcript truncated at ${MAX_AUDIT_TRANSCRIPT_CHARS} chars; ${omitted} chars omitted] ...\n`;
}

function getTranscriptAuditDir(basePath: string): string {
	return join(basePath, ".daemon", "logs", "transcripts");
}

function isSafeAuditName(value: string): boolean {
	return value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value);
}

function fsTimestamp(iso: string): string {
	return Array.from(iso, (char) => (/^[A-Za-z0-9._-]$/.test(char) ? char : "-")).join("");
}

function buildAuditPath(dir: string, fileName: string): string {
	if (!isSafeAuditName(fileName)) throw new Error("invalid transcript audit file name");
	return join(dir, fileName);
}

function resolveAuditToken(agentId: string, sessionId: string, sessionKey: string | null, raw: string): string {
	const scoped = sessionId.trim() || sessionKey?.trim() || createHash("sha256").update(raw, "utf8").digest("hex");
	return createHash("sha256").update(`${agentId}:${scoped}`, "utf8").digest("hex").slice(0, 16);
}

function boundedPreview(value: string | undefined): string | null {
	if (!value) return null;
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= MAX_AUDIT_PREVIEW_BYTES) return value;
	return `${bytes.subarray(0, MAX_AUDIT_PREVIEW_BYTES).toString("utf8")}\n... [audit preview omitted] ...\n`;
}

function auditToken(agentId: string, sourceIdentity: string, sourceSha256: string | null): string {
	return createHash("sha256")
		.update(`${agentId}\0${sourceIdentity}\0${sourceSha256 ?? ""}`, "utf8")
		.digest("hex")
		.slice(0, 24);
}

export interface TranscriptAuditWrite {
	readonly latestPath: string;
	readonly finalPath?: string;
}

type LegacyTranscriptAuditWrite = {
	readonly basePath?: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly rawTranscript: string;
	readonly capturedAt?: string;
};

type SourceBackedTranscriptAuditWrite = {
	readonly basePath?: string;
	readonly agentId: string;
	readonly sourceIdentity: string;
	readonly sourcePath: string | null;
	readonly sourceSha256: string | null;
	readonly sourceSizeBytes: number | null;
	readonly sourceFormat: string | null;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly preview?: string;
	readonly capturedAt?: string;
};

export function writeTranscriptAudit(params: LegacyTranscriptAuditWrite): Promise<TranscriptAuditWrite | null>;
export function writeTranscriptAudit(params: SourceBackedTranscriptAuditWrite): Promise<TranscriptAuditWrite>;
export async function writeTranscriptAudit(
	params: LegacyTranscriptAuditWrite | SourceBackedTranscriptAuditWrite,
): Promise<TranscriptAuditWrite | null> {
	if ("rawTranscript" in params) {
		if (params.rawTranscript.trim().length === 0) return null;
		const basePath = params.basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath();
		const dir = getTranscriptAuditDir(basePath);
		await mkdir(dir, { recursive: true });
		const token = resolveAuditToken(params.agentId, params.sessionId, params.sessionKey, params.rawTranscript);
		const content = capTranscriptAuditContent(params.rawTranscript);
		const latestPath = buildAuditPath(dir, `${token}--latest.log`);
		await writeFile(latestPath, content, "utf8");
		if (!params.capturedAt) return { latestPath };
		const finalPath = buildAuditPath(dir, `${fsTimestamp(params.capturedAt)}--${token}--raw-transcript.log`);
		try {
			await rename(latestPath, finalPath);
		} catch {
			await writeFile(finalPath, content, "utf8");
		}
		return { latestPath, finalPath };
	}
	const basePath = params.basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath();
	const dir = getTranscriptAuditDir(basePath);
	await mkdir(dir, { recursive: true });
	const fileName = `${auditToken(params.agentId, params.sourceIdentity, params.sourceSha256)}.json`;
	if (!isSafeAuditName(fileName)) throw new Error("invalid transcript audit file name");
	const latestPath = join(dir, fileName);
	const tempPath = `${latestPath}.${process.pid}.${randomUUID()}.tmp`;
	const record = {
		schema: "signet.transcript-audit.v2",
		agent_id: params.agentId,
		source_identity: params.sourceIdentity,
		source_path: params.sourcePath,
		source_sha256: params.sourceSha256,
		source_size_bytes: params.sourceSizeBytes,
		source_format: params.sourceFormat,
		session_id: params.sessionId,
		session_key: params.sessionKey,
		captured_at: params.capturedAt ?? null,
		preview: boundedPreview(params.preview),
	};
	try {
		await writeFile(tempPath, `${JSON.stringify(record)}\n`, "utf8");
		await rename(tempPath, latestPath);
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
	return { latestPath };
}

export async function pruneTranscriptAudit(basePath?: string): Promise<{ removedFiles: number; removedBytes: number }> {
	const dir = getTranscriptAuditDir(basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath());
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".json") && isSafeAuditName(name));
	} catch {
		return { removedFiles: 0, removedBytes: 0 };
	}
	const now = Date.now();
	const entries = await Promise.all(
		names.map(async (name) => {
			try {
				const info = await stat(join(dir, name));
				return { path: join(dir, name), size: info.size, mtimeMs: info.mtimeMs };
			} catch {
				return null;
			}
		}),
	);
	const files = entries
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
	let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	let removedFiles = 0;
	let removedBytes = 0;
	for (const file of files) {
		if (now - file.mtimeMs <= MAX_AUDIT_AGE_MS && totalBytes <= MAX_AUDIT_BYTES) continue;
		try {
			await unlink(file.path);
			totalBytes -= file.size;
			removedFiles++;
			removedBytes += file.size;
		} catch {}
	}
	return { removedFiles, removedBytes };
}
