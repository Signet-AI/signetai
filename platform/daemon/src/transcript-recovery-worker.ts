import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { deriveSessionToken } from "./memory-lineage";
import { deriveSessionEndFallbackId } from "./session-end-recovery";
import { getStoredSessionTranscriptInfoAsync, upsertSessionTranscriptAsync } from "./session-transcripts";
import { enqueueTranscriptCaptureJob } from "./transcript-capture-worker";
import { canonicalTranscriptRelativePath } from "./transcript-jsonl";
import { normalizeSessionTranscript } from "./transcript-normalization";

export const TRANSCRIPT_RECOVERY_INTERVAL_MS = 5 * 60_000;
export const TRANSCRIPT_RECOVERY_SETTLE_MS = 60_000;
export const TRANSCRIPT_RECOVERY_MAX_BYTES = 50 * 1024 * 1024;
export const TRANSCRIPT_RECOVERY_MAX_FILES_PER_SCAN = 50;
export const TRANSCRIPT_RECOVERY_MAX_DISCOVERED_FILES = 50_000;
export const TRANSCRIPT_RECOVERY_MAX_RETRY_DELAY_MS = 30 * 60_000;
export const TRANSCRIPT_RECOVERY_STOP_GRACE_MS = 5_000;

interface RecoveryCandidate {
	readonly harness: "claude-code" | "codex";
	readonly rootPath: string;
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
	readonly signal?: AbortSignal;
	/** Production scans run in a killable child; in-process is reserved for direct tests/helpers. */
	readonly execution?: "child" | "in-process";
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

export function parseTranscriptRecoveryResult(output: string): TranscriptRecoveryScanResult | null {
	for (const line of output.split("\n")) {
		try {
			const event = JSON.parse(line) as { type?: string; result?: TranscriptRecoveryScanResult };
			if (event.type === "result" && event.result !== undefined) return event.result;
		} catch {
			// Logger output is not part of the child protocol.
		}
	}
	return null;
}

function parseTranscriptRecoveryChildPid(output: string): number | null {
	for (const line of output.split("\n")) {
		try {
			const event = JSON.parse(line) as { type?: string; pid?: unknown };
			if (event.type === "started" && typeof event.pid === "number" && Number.isInteger(event.pid)) return event.pid;
		} catch {
			// Logger output is not part of the child protocol.
		}
	}
	return null;
}

export interface TranscriptRecoveryWorkerHandle {
	stop(): Promise<void>;
	nudge(): void;
	readonly running: boolean;
	/** Active child PID, exposed for lifecycle tests and diagnostics. */
	readonly childPid: number | null;
}

type TranscriptRecoveryWorkerOptions = TranscriptRecoveryScanOptions & {
	readonly intervalMs?: number;
	/** Test-only child entrypoint used to exercise the stdio/close protocol deterministically. */
	readonly childPath?: string;
	/** Test-only supervisor entrypoint; production uses the bundled supervisor. */
	readonly supervisorPath?: string;
};

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
	signal?: AbortSignal,
): Promise<boolean> {
	const pending = [root];
	while (pending.length > 0) {
		if (signal?.aborted) return false;
		if (output.length >= maxFiles) return false;
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
			if (signal?.aborted) return false;
			if (output.length >= maxFiles) return false;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			if (harness === "codex" && !entry.name.startsWith("rollout-")) continue;
			try {
				const metadata = await stat(path);
				output.push({ harness, rootPath: root, path, size: metadata.size, mtimeMs: metadata.mtimeMs });
			} catch {
				// A harness may rotate a file between directory enumeration and stat.
			}
		}
	}
	return !signal?.aborted;
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

const RECOVERY_FINGERPRINT_BATCH_SIZE = 400;

interface RecoveryFingerprint {
	readonly sizeBytes: number;
	readonly mtimeMs: number;
	readonly hasDeadCaptureJob: boolean;
}

async function loadRecoveryFingerprints(
	dbAccessor: DbAccessor,
	agentId: string,
	candidates: readonly RecoveryCandidate[],
	signal?: AbortSignal,
): Promise<Map<string, RecoveryFingerprint>> {
	const fingerprints = new Map<string, RecoveryFingerprint>();
	for (let offset = 0; offset < candidates.length; offset += RECOVERY_FINGERPRINT_BATCH_SIZE) {
		throwIfAborted(signal);
		const paths = candidates.slice(offset, offset + RECOVERY_FINGERPRINT_BATCH_SIZE).map((candidate) => candidate.path);
		const placeholders = paths.map(() => "?").join(", ");
		const rows = await dbAccessor.withReadDbAsync(
			(db) =>
				db
					.prepare(
						`SELECT f.source_path, f.size_bytes, f.mtime_ms,
								EXISTS(
									SELECT 1 FROM transcript_capture_jobs AS j
									 WHERE j.agent_id = f.agent_id AND j.session_id = f.session_id AND j.status = 'dead'
								) AS has_dead_capture_job
						 FROM transcript_recovery_files AS f
						 WHERE f.agent_id = ? AND f.source_path IN (${placeholders})`,
					)
					.all(agentId, ...paths) as Array<{
					source_path?: unknown;
					size_bytes?: unknown;
					mtime_ms?: unknown;
					has_dead_capture_job?: unknown;
				}>,
			{
				siteToken: "transcript-recovery-worker.ts:221",
				operation: "transcript-recovery.load-fingerprints",
				signal,
			},
		);
		for (const row of rows) {
			if (typeof row.source_path !== "string" || typeof row.size_bytes !== "number" || typeof row.mtime_ms !== "number")
				continue;
			fingerprints.set(row.source_path, {
				sizeBytes: row.size_bytes,
				mtimeMs: row.mtime_ms,
				hasDeadCaptureJob: row.has_dead_capture_job === 1 || row.has_dead_capture_job === true,
			});
		}
	}
	return fingerprints;
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

function frontierKey(candidate: RecoveryCandidate): string {
	return `${candidate.harness}\\0${candidate.rootPath}`;
}

async function loadFrontiers(
	dbAccessor: DbAccessor,
	agentId: string,
	signal?: AbortSignal,
): Promise<Map<string, string | null>> {
	return dbAccessor.withReadDbAsync(
		(db) => {
			const rows = db
				.prepare("SELECT harness, root_path, cursor_path FROM transcript_recovery_frontiers WHERE agent_id = ?")
				.all(agentId) as Array<{ harness: string; root_path: string; cursor_path?: string | null }>;
			return new Map(rows.map((row) => [`${row.harness}\\0${row.root_path}`, row.cursor_path ?? null]));
		},
		{ siteToken: "transcript-recovery-worker.ts:330", operation: "transcript-recovery.load-frontiers", signal },
	);
}

async function saveFrontier(
	dbAccessor: DbAccessor,
	agentId: string,
	candidate: RecoveryCandidate,
	cursorPath: string | null,
	signal?: AbortSignal,
): Promise<void> {
	await dbAccessor.withWriteTxAsync(
		(db) => {
			db.prepare(
				`INSERT INTO transcript_recovery_frontiers (agent_id, harness, root_path, cursor_path, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id, harness, root_path) DO UPDATE SET
					cursor_path = excluded.cursor_path,
					updated_at = excluded.updated_at`,
			).run(agentId, candidate.harness, candidate.rootPath, cursorPath, new Date().toISOString());
		},
		{ siteToken: "transcript-recovery-worker.ts:348", operation: "transcript-recovery.save-frontier", signal },
	);
}

async function clearFrontiers(
	dbAccessor: DbAccessor,
	agentId: string,
	roots: TranscriptRecoveryRoots,
	signal?: AbortSignal,
): Promise<void> {
	await dbAccessor.withWriteTxAsync(
		(db) => {
			db.prepare("DELETE FROM transcript_recovery_frontiers WHERE agent_id = ? AND root_path IN (?, ?)").run(
				agentId,
				roots.claudeCode,
				roots.codex,
			);
		},
		{ siteToken: "transcript-recovery-worker.ts:368", operation: "transcript-recovery.clear-frontiers", signal },
	);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Transcript recovery aborted");
}

function isFatalDbOwnerError(error: unknown): boolean {
	const code = error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
	return typeof code === "string" && code.startsWith("DB_OWNER_");
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
	const claudeDiscoveryComplete = await discoverFiles(
		roots.claudeCode,
		"claude-code",
		claudeDiscoveryLimit,
		candidates,
		options.signal,
	);
	const codexDiscoveryComplete = await discoverFiles(
		roots.codex,
		"codex",
		maxDiscoveredFiles,
		candidates,
		options.signal,
	);
	const discoveryComplete = claudeDiscoveryComplete && codexDiscoveryComplete;
	candidates.sort((a, b) => a.path.localeCompare(b.path));
	const frontiers = await loadFrontiers(dbAccessor, agentId, options.signal);
	const fingerprints = await loadRecoveryFingerprints(dbAccessor, agentId, candidates, options.signal);
	const resumableCandidates = candidates.filter((candidate) => {
		const cursor = frontiers.get(frontierKey(candidate));
		if (cursor === undefined || cursor === null || candidate.path > cursor) return true;
		const fingerprint = fingerprints.get(candidate.path);
		return (
			fingerprint === undefined ||
			fingerprint.hasDeadCaptureJob ||
			fingerprint.sizeBytes !== candidate.size ||
			fingerprint.mtimeMs !== Math.trunc(candidate.mtimeMs)
		);
	});

	let examined = 0;
	let enqueued = 0;
	let deduplicated = 0;
	let skippedRecent = 0;
	let skippedOversized = 0;
	let skippedUnchanged = 0;
	let skippedInvalid = 0;

	for (const candidate of resumableCandidates) {
		throwIfAborted(options.signal);
		if (nowMs - candidate.mtimeMs < settleMs) {
			skippedRecent++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}
		if (candidate.size > maxBytes) {
			skippedOversized++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}
		const fingerprint = fingerprints.get(candidate.path);
		if (
			fingerprint !== undefined &&
			!fingerprint.hasDeadCaptureJob &&
			fingerprint.sizeBytes === candidate.size &&
			fingerprint.mtimeMs === Math.trunc(candidate.mtimeMs)
		) {
			skippedUnchanged++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}
		if (examined >= maxFiles) break;
		examined++;

		let raw: string;
		try {
			raw = await readFile(candidate.path, { encoding: "utf8", signal: options.signal });
		} catch (error) {
			throwIfAborted(options.signal);
			logger.debug("transcripts", "Transcript recovery read failed", {
				path: candidate.path,
				error: error instanceof Error ? error.message : String(error),
			});
			skippedInvalid++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
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
			await dbAccessor.withWriteTxAsync(
				(db) => markScanned(db, agentId, candidate, contentSha256, skippedSessionId, new Date(nowMs).toISOString()),
				{
					siteToken: "transcript-recovery-worker.ts:491",
					operation: "transcript-recovery.mark-scanned",
					signal: options.signal,
				},
			);
			skippedInvalid++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}
		const sessionId = deriveSessionEndFallbackId(metadata.sessionKey, candidate.path, transcript);
		const contentSha256 = createHash("sha256").update(raw).digest("hex");
		const alreadyCaptured = await dbAccessor.withReadDbAsync(
			(db) => snapshotAlreadyCaptured(db, agentId, candidate, sessionId, transcript),
			{
				siteToken: "transcript-recovery-worker.ts:505",
				operation: "transcript-recovery.snapshot-check",
				signal: options.signal,
			},
		);
		if (alreadyCaptured) {
			await dbAccessor.withWriteTxAsync(
				(db) => markScanned(db, agentId, candidate, contentSha256, sessionId, new Date(nowMs).toISOString()),
				{
					siteToken: "transcript-recovery-worker.ts:514",
					operation: "transcript-recovery.mark-scanned",
					signal: options.signal,
				},
			);
			deduplicated++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}

		const existingTranscript = await getStoredSessionTranscriptInfoAsync(
			metadata.sessionKey,
			agentId,
			dbAccessor,
			options.signal,
		);
		// A completed canonical row is authoritative. Recovery files are legacy
		// snapshots and may be older or partial. A later settled snapshot is
		// allowed through only when it strictly extends the retained content;
		// otherwise it would clobber lossless content and regress the Dreaming
		// watermark.
		const completedSnapshotExtendsCanonical =
			existingTranscript?.completedAt !== null &&
			existingTranscript?.completedAt !== undefined &&
			transcript.length > existingTranscript.content.length &&
			transcript.includes(existingTranscript.content);
		if (existingTranscript?.completedAt && !completedSnapshotExtendsCanonical && !fingerprint?.hasDeadCaptureJob) {
			await dbAccessor.withWriteTxAsync(
				(db) => markScanned(db, agentId, candidate, contentSha256, sessionId, new Date(nowMs).toISOString()),
				{
					siteToken: "transcript-recovery-worker.ts:544",
					operation: "transcript-recovery.mark-scanned",
					signal: options.signal,
				},
			);
			deduplicated++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}

		try {
			const retained = await upsertSessionTranscriptAsync(
				metadata.sessionKey,
				transcript,
				candidate.harness,
				metadata.project,
				agentId,
				metadata.capturedAt,
				dbAccessor,
				{ completedAt: metadata.capturedAt, preserveExistingContent: true, signal: options.signal },
			);
			if (!retained)
				logger.warn("transcripts", "Recovered transcript retention or completion failed", {
					sessionKey: metadata.sessionKey,
				});
		} catch (error) {
			throwIfAborted(options.signal);
			if (isFatalDbOwnerError(error)) throw error;
			logger.warn("transcripts", "Recovered transcript retention failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey: metadata.sessionKey,
			});
		}
		const jobId = await enqueueTranscriptCaptureJob(
			dbAccessor,
			{
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
			},
			options.signal,
		);
		if (!jobId) {
			skippedInvalid++;
			await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
			continue;
		}
		await dbAccessor.withWriteTxAsync(
			(db) => markScanned(db, agentId, candidate, contentSha256, sessionId, new Date(nowMs).toISOString()),
			{
				siteToken: "transcript-recovery-worker.ts:602",
				operation: "transcript-recovery.mark-scanned",
				signal: options.signal,
			},
		);
		await saveFrontier(dbAccessor, agentId, candidate, candidate.path, options.signal);
		enqueued++;
	}
	if (!options.signal?.aborted && discoveryComplete && examined < maxFiles) {
		await clearFrontiers(dbAccessor, agentId, roots, options.signal);
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
	options: TranscriptRecoveryWorkerOptions = {},
): TranscriptRecoveryWorkerHandle {
	let stopped = false;
	let running = false;
	let completed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let activeScan: Promise<void> | null = null;
	let activeChild: ChildProcess | null = null;
	let activeTargetPid: number | null = null;
	const cancellation = new AbortController();
	const execution = options.execution ?? "child";
	let retryDelayMs = options.intervalMs ?? TRANSCRIPT_RECOVERY_INTERVAL_MS;

	const scheduleRetry = (): void => {
		if (stopped || completed || timer) return;
		timer = setTimeout(() => {
			timer = null;
			void scan();
		}, retryDelayMs);
		retryDelayMs = Math.min(retryDelayMs * 2, TRANSCRIPT_RECOVERY_MAX_RETRY_DELAY_MS);
	};

	const signalActiveProcesses = (signal: NodeJS.Signals): void => {
		if (activeTargetPid !== null) {
			try {
				if (process.platform !== "win32") process.kill(-activeTargetPid, signal);
			} catch {
				// The target may have exited between the check and kill.
			}
			try {
				process.kill(activeTargetPid, signal);
			} catch {
				// The target may have exited between the group and direct kills.
			}
		}
		if (activeChild !== null) {
			try {
				activeChild.kill(signal);
			} catch {
				// The supervisor may have exited between the check and kill.
			}
		}
	};

	const runChild = async (): Promise<TranscriptRecoveryScanResult> => {
		const childName = fileURLToPath(import.meta.url).endsWith(".ts")
			? "transcript-recovery-child.ts"
			: "transcript-recovery-child.js";
		const supervisorName = fileURLToPath(import.meta.url).endsWith(".ts")
			? "transcript-recovery-supervisor.ts"
			: "transcript-recovery-supervisor.js";
		const childPath = options.childPath ?? join(dirname(fileURLToPath(import.meta.url)), childName);
		const supervisorPath = options.supervisorPath ?? join(dirname(fileURLToPath(import.meta.url)), supervisorName);
		const {
			intervalMs: _intervalMs,
			signal: _signal,
			execution: _execution,
			childPath: _childPath,
			supervisorPath: _supervisorPath,
			...scanOptions
		} = options;
		const child = spawn(process.execPath, [supervisorPath], {
			env: {
				...process.env,
				SIGNET_TRANSCRIPT_RECOVERY_CHILD_PATH: childPath,
				SIGNET_TRANSCRIPT_RECOVERY_INPUT: JSON.stringify({ basePath, agentId, options: scanOptions }),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		activeChild = child;
		return await new Promise<TranscriptRecoveryScanResult>((resolve, reject) => {
			let output = "";
			let settled = false;
			const settle = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				callback();
			};
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				// Buffer the complete protocol until the stdio streams close. The
				// child may write its result and exit in the same turn; resolving from
				// `data` or rejecting from `exit` races the final stdout delivery.
				output += chunk;
				activeTargetPid = parseTranscriptRecoveryChildPid(output) ?? activeTargetPid;
			});
			child.on("error", (error) => settle(() => reject(error)));
			child.on("close", (code, signal) => {
				const result = parseTranscriptRecoveryResult(output);
				if (code === 0 && signal === null) {
					settle(() =>
						resolve(
							result ?? {
								discovered: 0,
								examined: 0,
								enqueued: 0,
								deduplicated: 0,
								skippedRecent: 0,
								skippedOversized: 0,
								skippedUnchanged: 0,
								skippedInvalid: 0,
							},
						),
					);
					return;
				}
				const detail = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
				settle(() => reject(new Error(`Transcript recovery child exited with ${detail}`)));
			});
		});
	};

	const scan = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		activeScan = (async () => {
			try {
				const result =
					execution === "in-process"
						? await runTranscriptRecoveryScan(dbAccessor, basePath, agentId, {
								...options,
								signal: cancellation.signal,
							})
						: await runChild();
				if (result.enqueued > 0 || result.deduplicated > 0) {
					logger.info("transcripts", "Transcript recovery scan complete", { ...result });
				}
				completed = true;
			} catch (error) {
				if (cancellation.signal.aborted || stopped) return;
				logger.warn("transcripts", "Transcript recovery scan failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
		try {
			await activeScan;
		} finally {
			activeScan = null;
			activeChild = null;
			activeTargetPid = null;
			running = false;
			if (!completed) scheduleRetry();
		}
	};

	queueMicrotask(() => void scan());
	return {
		async stop(): Promise<void> {
			stopped = true;
			cancellation.abort();
			if (timer) clearTimeout(timer);
			timer = null;
			const scanToStop = activeScan;
			if (scanToStop === null) return;
			activeChild?.stdin?.end();
			signalActiveProcesses("SIGTERM");
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const stoppedGracefully = await Promise.race([
				scanToStop.then(
					() => true,
					() => true,
				),
				new Promise<boolean>((resolve) => {
					graceTimer = setTimeout(() => resolve(false), TRANSCRIPT_RECOVERY_STOP_GRACE_MS);
				}),
			]);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			if (!stoppedGracefully) {
				signalActiveProcesses("SIGKILL");
				await scanToStop;
			}
		},
		nudge(): void {
			completed = false;
			retryDelayMs = options.intervalMs ?? TRANSCRIPT_RECOVERY_INTERVAL_MS;
			if (timer) clearTimeout(timer);
			timer = null;
			queueMicrotask(() => void scan());
		},
		get running(): boolean {
			return !stopped;
		},
		get childPid(): number | null {
			return activeTargetPid ?? activeChild?.pid ?? null;
		},
	};
}
