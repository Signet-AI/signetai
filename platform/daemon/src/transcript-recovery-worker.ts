import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { deriveSessionToken } from "./memory-lineage";
import { deriveSessionEndFallbackId } from "./session-end-recovery";
import { getStoredSessionTranscriptInfo, upsertSessionTranscript } from "./session-transcripts";
import { enqueueTranscriptCaptureJob } from "./transcript-capture-worker";
import { canonicalTranscriptRelativePath } from "./transcript-jsonl";
import { normalizeSessionTranscript } from "./transcript-normalization";

export const TRANSCRIPT_RECOVERY_INTERVAL_MS = 5 * 60_000;
export const TRANSCRIPT_RECOVERY_SETTLE_MS = 60_000;
export const TRANSCRIPT_RECOVERY_MAX_BYTES = 50 * 1024 * 1024;
export const TRANSCRIPT_RECOVERY_MAX_FILES_PER_SCAN = 50;
export const TRANSCRIPT_RECOVERY_MAX_DISCOVERED_FILES = 50_000;

interface RecoveryCandidate {
	readonly harness: "claude-code" | "codex";
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
}

interface TranscriptMetadata {
	readonly sessionKey: string;
	readonly project: string | null;
	readonly capturedAt: string;
}

export interface TranscriptRecoveryRoots {
	readonly claudeCode: string;
	readonly codex: string;
}

export interface TranscriptRecoveryScanOptions {
	readonly roots?: Partial<TranscriptRecoveryRoots>;
	readonly nowMs?: number;
	readonly settleMs?: number;
	readonly maxBytes?: number;
	readonly maxFiles?: number;
	readonly maxDiscoveredFiles?: number;
}

export interface TranscriptRecoveryScanResult {
	readonly discovered: number;
	readonly examined: number;
	readonly enqueued: number;
	readonly deduplicated: number;
	readonly skippedRecent: number;
	readonly skippedOversized: number;
	readonly skippedUnchanged: number;
	readonly skippedInvalid: number;
}

export interface TranscriptRecoveryWorkerHandle {
	stop(): Promise<void>;
	nudge(): void;
	readonly running: boolean;
}

function defaultRoots(): TranscriptRecoveryRoots {
	const home = homedir();
	return {
		claudeCode: join(home, ".claude", "projects"),
		codex: join(home, ".codex", "sessions"),
	};
}

async function discoverFiles(
	root: string,
	harness: RecoveryCandidate["harness"],
	maxFiles: number,
	output: RecoveryCandidate[],
): Promise<void> {
	const pending = [root];
	while (pending.length > 0 && output.length < maxFiles) {
		const directory = pending.pop();
		if (!directory) break;
		let entries: Array<{
			readonly name: string;
			isDirectory(): boolean;
			isFile(): boolean;
		}>;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (output.length >= maxFiles) return;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			if (harness === "codex" && !entry.name.startsWith("rollout-")) continue;
			try {
				const metadata = await stat(path);
				output.push({ harness, path, size: metadata.size, mtimeMs: metadata.mtimeMs });
			} catch {
				// A harness may rotate a file between directory enumeration and stat.
			}
		}
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmptyString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

function readMetadata(candidate: RecoveryCandidate, raw: string): TranscriptMetadata | null {
	for (const line of raw.split(/\r?\n/, 100)) {
		if (!line.trim()) continue;
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = record(JSON.parse(line));
		} catch {
			continue;
		}
		if (!parsed) continue;
		const payload = record(parsed.payload);
		const sessionKey =
			candidate.harness === "codex"
				? nonEmptyString(payload?.session_id, payload?.id, parsed.session_id, parsed.sessionId)
				: nonEmptyString(parsed.sessionId, parsed.session_id, payload?.session_id, payload?.id);
		if (!sessionKey) continue;
		const project = nonEmptyString(payload?.cwd, parsed.cwd);
		return { sessionKey, project, capturedAt: new Date(candidate.mtimeMs).toISOString() };
	}

	const fallback = basename(candidate.path, ".jsonl").match(
		candidate.harness === "codex" ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i : /^(.+)$/,
	)?.[1];
	if (!fallback) return null;
	return {
		sessionKey: fallback,
		project: null,
		capturedAt: new Date(candidate.mtimeMs).toISOString(),
	};
}

function unchanged(db: ReadDb, agentId: string, candidate: RecoveryCandidate): boolean {
	const row = db
		.prepare(
			`SELECT size_bytes, mtime_ms
			 FROM transcript_recovery_files
			 WHERE agent_id = ? AND source_path = ?`,
		)
		.get(agentId, candidate.path) as { size_bytes?: unknown; mtime_ms?: unknown } | undefined;
	return row?.size_bytes === candidate.size && row.mtime_ms === Math.trunc(candidate.mtimeMs);
}

function snapshotAlreadyCaptured(
	db: ReadDb,
	agentId: string,
	candidate: RecoveryCandidate,
	sessionId: string,
	transcript: string,
): boolean {
	const job = db
		.prepare(
			`SELECT id
			 FROM transcript_capture_jobs
			 WHERE agent_id = ? AND session_id = ? AND transcript = ?
			   AND status <> 'dead'
			 LIMIT 1`,
		)
		.get(agentId, sessionId, transcript);
	if (job) return true;

	const sessionToken = deriveSessionToken(agentId, sessionId);
	const sourcePath = `${canonicalTranscriptRelativePath(candidate.harness)}#${sessionToken}`;
	return Boolean(
		db
			.prepare(
				`SELECT 1
				 FROM memory_artifacts
				 WHERE agent_id = ? AND source_path = ? AND deleted_at IS NULL
				 LIMIT 1`,
			)
			.get(agentId, sourcePath),
	);
}

function markScanned(
	db: WriteDb,
	agentId: string,
	candidate: RecoveryCandidate,
	contentSha256: string,
	sessionId: string,
	scannedAt: string,
): void {
	db.prepare(
		`INSERT INTO transcript_recovery_files (
			agent_id, source_path, harness, size_bytes, mtime_ms, content_sha256, session_id, last_scanned_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id, source_path) DO UPDATE SET
			harness = excluded.harness,
			size_bytes = excluded.size_bytes,
			mtime_ms = excluded.mtime_ms,
			content_sha256 = excluded.content_sha256,
			session_id = excluded.session_id,
			last_scanned_at = excluded.last_scanned_at`,
	).run(
		agentId,
		candidate.path,
		candidate.harness,
		candidate.size,
		Math.trunc(candidate.mtimeMs),
		contentSha256,
		sessionId,
		scannedAt,
	);
}

export async function runTranscriptRecoveryScan(
	dbAccessor: DbAccessor,
	basePath: string,
	agentId: string,
	options: TranscriptRecoveryScanOptions = {},
): Promise<TranscriptRecoveryScanResult> {
	void basePath;
	const roots = { ...defaultRoots(), ...options.roots };
	const nowMs = options.nowMs ?? Date.now();
	const settleMs = options.settleMs ?? TRANSCRIPT_RECOVERY_SETTLE_MS;
	const maxBytes = options.maxBytes ?? TRANSCRIPT_RECOVERY_MAX_BYTES;
	const maxFiles = options.maxFiles ?? TRANSCRIPT_RECOVERY_MAX_FILES_PER_SCAN;
	const maxDiscoveredFiles = options.maxDiscoveredFiles ?? TRANSCRIPT_RECOVERY_MAX_DISCOVERED_FILES;
	const candidates: RecoveryCandidate[] = [];
	const claudeDiscoveryLimit = Math.max(1, Math.floor(maxDiscoveredFiles / 2));
	await discoverFiles(roots.claudeCode, "claude-code", claudeDiscoveryLimit, candidates);
	await discoverFiles(roots.codex, "codex", maxDiscoveredFiles, candidates);
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));

	let examined = 0;
	let enqueued = 0;
	let deduplicated = 0;
	let skippedRecent = 0;
	let skippedOversized = 0;
	let skippedUnchanged = 0;
	let skippedInvalid = 0;

	for (const candidate of candidates) {
		if (nowMs - candidate.mtimeMs < settleMs) {
			skippedRecent++;
			continue;
		}
		if (candidate.size > maxBytes) {
			skippedOversized++;
			continue;
		}
		if (dbAccessor.withReadDb((db) => unchanged(db, agentId, candidate))) {
			skippedUnchanged++;
			continue;
		}
		if (examined >= maxFiles) break;
		examined++;

		let raw: string;
		try {
			raw = await readFile(candidate.path, "utf8");
		} catch (error) {
			logger.debug("transcripts", "Transcript recovery read failed", {
				path: candidate.path,
				error: error instanceof Error ? error.message : String(error),
			});
			skippedInvalid++;
			continue;
		}
		const metadata = readMetadata(candidate, raw);
		const transcript = normalizeSessionTranscript(candidate.harness, raw);
		if (!metadata || (transcript.trim().length === 0 && raw.trim().length === 0)) {
			const contentSha256 = createHash("sha256").update(raw).digest("hex");
			const skippedSessionId = `recovery-skip:${createHash("sha256")
				.update(candidate.path)
				.update("\0")
				.update(contentSha256)
				.digest("hex")
				.slice(0, 24)}`;
			dbAccessor.withWriteTx((db) =>
				markScanned(db, agentId, candidate, contentSha256, skippedSessionId, new Date(nowMs).toISOString()),
			);
			skippedInvalid++;
			continue;
		}
		const sessionId = deriveSessionEndFallbackId(metadata.sessionKey, candidate.path, transcript);
		const contentSha256 = createHash("sha256").update(raw).digest("hex");
		const alreadyCaptured = dbAccessor.withReadDb((db) =>
			snapshotAlreadyCaptured(db, agentId, candidate, sessionId, transcript),
		);
		if (alreadyCaptured) {
			dbAccessor.withWriteTx((db) =>
				markScanned(db, agentId, candidate, contentSha256, sessionId, new Date(nowMs).toISOString()),
			);
			deduplicated++;
			continue;
		}

		const existingTranscript = getStoredSessionTranscriptInfo(metadata.sessionKey, agentId);
		// A completed canonical row is authoritative. Recovery files are legacy
		// snapshots and may be older or partial; allowing one to reset the row
		// would clobber lossless content and regress the Dreaming watermark.
		if (existingTranscript?.completedAt) {
			dbAccessor.withWriteTx((db) =>
				markScanned(db, agentId, candidate, contentSha256, sessionId, new Date(nowMs).toISOString()),
			);
			deduplicated++;
			continue;
		}

		try {
			const retained = upsertSessionTranscript(
				metadata.sessionKey,
				transcript,
				candidate.harness,
				metadata.project,
				agentId,
				metadata.capturedAt,
				dbAccessor,
				{ completedAt: metadata.capturedAt, preserveExistingContent: true },
			);
			if (!retained)
				logger.warn("transcripts", "Recovered transcript retention or completion failed", {
					sessionKey: metadata.sessionKey,
				});
		} catch (error) {
			logger.warn("transcripts", "Recovered transcript retention failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey: metadata.sessionKey,
			});
		}
		const jobId = enqueueTranscriptCaptureJob(dbAccessor, {
			agentId,
			harness: candidate.harness,
			sessionKey: metadata.sessionKey,
			sessionId,
			project: metadata.project,
			transcript,
			rawTranscript: raw,
			transcriptPath: candidate.path,
			capturedAt: metadata.capturedAt,
			endedAt: metadata.capturedAt,
			summaryStatus: "not_requested",
		});
		if (!jobId) {
			skippedInvalid++;
			continue;
		}
		dbAccessor.withWriteTx((db) =>
			markScanned(db, agentId, candidate, contentSha256, sessionId, new Date(nowMs).toISOString()),
		);
		enqueued++;
	}

	return {
		discovered: candidates.length,
		examined,
		enqueued,
		deduplicated,
		skippedRecent,
		skippedOversized,
		skippedUnchanged,
		skippedInvalid,
	};
}

export function startTranscriptRecoveryWorker(
	dbAccessor: DbAccessor,
	basePath: string,
	agentId: string,
	options: TranscriptRecoveryScanOptions & { readonly intervalMs?: number } = {},
): TranscriptRecoveryWorkerHandle {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let activeScan: Promise<void> | null = null;

	const schedule = (delayMs: number): void => {
		if (stopped || timer) return;
		timer = setTimeout(() => {
			timer = null;
			void scan();
		}, delayMs);
	};
	const scan = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		activeScan = (async () => {
			try {
				const result = await runTranscriptRecoveryScan(dbAccessor, basePath, agentId, options);
				if (result.enqueued > 0 || result.deduplicated > 0) {
					logger.info("transcripts", "Transcript recovery scan complete", { ...result });
				}
			} catch (error) {
				logger.warn("transcripts", "Transcript recovery scan failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
		try {
			await activeScan;
		} finally {
			activeScan = null;
			running = false;
			schedule(options.intervalMs ?? TRANSCRIPT_RECOVERY_INTERVAL_MS);
		}
	};

	queueMicrotask(() => void scan());
	return {
		async stop(): Promise<void> {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			await activeScan;
		},
		nudge(): void {
			if (timer) clearTimeout(timer);
			timer = null;
			queueMicrotask(() => void scan());
		},
		get running(): boolean {
			return !stopped;
		},
	};
}
