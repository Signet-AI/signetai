import { constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { attemptAsync, readFileRange } from "@signet/core";
import { transcriptUploadEnd, transcriptUploadTailStart } from "@signet/core/transcript-upload";
import type { DbAccessor } from "./db-accessor";
import {
	dbOwnerCommitTranscriptUpload,
	dbOwnerDrainTranscriptUploadPurges,
	dbOwnerEndTranscriptUpload,
	dbOwnerReadTranscriptUploadScope,
	getDbOwner,
	getDbOwnerForAccessor,
} from "./db-owner-runtime";
import { logger } from "./logger";
import {
	type TranscriptUploadAccess,
	type TranscriptUploadCommitResult,
	type TranscriptUploadEndCommit,
	type TranscriptUploadEndCommitResult,
	transcriptUploadConflict,
	transcriptUploadScopeConflict,
} from "./session-transcripts";
import { sha256 } from "./transcript-capture-jobs";
import { withTranscriptImportOperationLock } from "./transcript-import-operation-lock";
import { openContainedTranscriptFile, removeContainedTranscriptPath } from "./transcript-import-safe-fs";
import { type TranscriptUploadAdmission, withTranscriptUploadAgentLock } from "./transcript-upload-agent-lock";
import { readTranscriptUploadPrefix, transcriptUploadFilePath, transcriptUploadsRoot } from "./transcript-upload-paths";

const PURGE_RUN_DEADLINE_MS = 30_000;
const PURGE_CONTINUE_DELAY_MS = 1_000;
const PURGE_RETRY_LIMIT = 5;

export interface TranscriptUploadRequest {
	readonly basePath: string;
	readonly agentId: string;
	readonly sessionKey: string;
	readonly sessionId: string;
	readonly harness: string;
	readonly project: string | null;
	readonly projectScoped: boolean;
	readonly generation: number;
	readonly offset: number;
	readonly checksum: string;
	readonly admission: TranscriptUploadAdmission;
	readonly body: Uint8Array;
	readonly capturedAt: string;
	readonly signal?: AbortSignal;
}

export type TranscriptUploadResult =
	| TranscriptUploadCommitResult
	| { readonly status: "invalid"; readonly reason: "empty" | "checksum" };

export type TranscriptUploadEnd = TranscriptUploadEndCommit;

export interface TranscriptUploadRead {
	readonly basePath: string;
	readonly agentId: string;
	readonly sessionKey: string;
	readonly maxBytes: number;
	readonly access?: TranscriptUploadAccess;
}

async function syncDirectory(root: string, path: string): Promise<void> {
	const directory = await openContainedTranscriptFile(root, path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function validate(input: TranscriptUploadRequest): TranscriptUploadResult | null {
	if (input.body.byteLength === 0) return { status: "invalid", reason: "empty" };
	if (sha256(input.body) !== input.checksum.toLowerCase()) return { status: "invalid", reason: "checksum" };
	return null;
}

export async function uploadTranscriptRange(
	accessor: DbAccessor,
	input: TranscriptUploadRequest,
): Promise<TranscriptUploadResult> {
	const invalid = validate(input);
	if (invalid) return invalid;
	if (input.admission.agentId !== input.agentId)
		throw new Error("Transcript upload admission belongs to another agent");
	return await withTranscriptImportOperationLock(`upload\0${input.agentId}\0${input.sessionKey}`, () =>
		withTranscriptUploadAgentLock(input.agentId, "shared", () =>
			input.admission.purgedSince()
				? Promise.resolve({ status: "purge_pending" })
				: writeAndCommitRange(accessor, input),
		),
	);
}

export async function endTranscriptUpload(
	accessor: DbAccessor,
	input: TranscriptUploadEnd,
): Promise<TranscriptUploadEndCommitResult> {
	return await dbOwnerEndTranscriptUpload(await getDbOwnerForAccessor(accessor), input, {
		operation: "transcript-upload.end",
	});
}

async function readUploadScope(accessor: DbAccessor, agentId: string, sessionKey: string, operation: string) {
	return await dbOwnerReadTranscriptUploadScope(
		await getDbOwnerForAccessor(accessor),
		{ agentId, sessionKey },
		{ operation },
	);
}

export async function hasTranscriptUpload(accessor: DbAccessor, agentId: string, sessionKey: string): Promise<boolean> {
	return (await readUploadScope(accessor, agentId, sessionKey, "transcript-upload.state")).state !== null;
}

export async function readTranscriptUploadContent(
	accessor: DbAccessor,
	input: TranscriptUploadRead,
): Promise<string | null> {
	return await withTranscriptUploadAgentLock(input.agentId, "shared", () => readCommittedLines(accessor, input));
}

async function readCommittedLines(accessor: DbAccessor, input: TranscriptUploadRead): Promise<string | null> {
	const scope = await readUploadScope(accessor, input.agentId, input.sessionKey, "transcript-upload.read");
	const state = scope.state;
	if (!state) return null;
	const conflict = input.access ? transcriptUploadScopeConflict(scope, input.access) : null;
	if (conflict) {
		logger.warn("hooks", "Transcript upload read denied outside the upload scope", {
			sessionKey: input.sessionKey,
			status: conflict.status,
		});
		return null;
	}
	if (state.committedOffset > input.maxBytes) {
		logger.warn("hooks", "Transcript upload read skipped for oversized upload", {
			sessionKey: input.sessionKey,
			size: state.committedOffset,
			maxSize: input.maxBytes,
		});
		return null;
	}
	const path = transcriptUploadFilePath(
		input.basePath,
		input.agentId,
		scope.purgeEpoch,
		input.sessionKey,
		state.generation,
	);
	const bytes = await readTranscriptUploadPrefix(input.basePath, path, state.committedOffset);
	const end = transcriptUploadEnd(bytes);
	return end === 0 ? null : bytes.subarray(0, end).toString("utf8");
}

async function writeAndCommitRange(
	accessor: DbAccessor,
	input: TranscriptUploadRequest,
): Promise<TranscriptUploadResult> {
	const owner = await getDbOwnerForAccessor(accessor);
	const options = { operation: "transcript-upload", signal: input.signal };
	const scope = await dbOwnerReadTranscriptUploadScope(
		owner,
		{ agentId: input.agentId, sessionKey: input.sessionKey },
		options,
	);
	const conflict = transcriptUploadConflict(scope, input);
	if (conflict) return conflict;
	const root = transcriptUploadsRoot(input.basePath);
	const path = transcriptUploadFilePath(
		input.basePath,
		input.agentId,
		scope.purgeEpoch,
		input.sessionKey,
		input.generation,
	);
	const end = input.offset + input.body.byteLength;
	let mtimeMs: number;
	let tailSha256: string;
	try {
		if (input.offset === 0) await mkdir(dirname(path), { recursive: true });
		const handle = await openContainedTranscriptFile(
			root,
			path,
			input.offset === 0 ? constants.O_RDWR | constants.O_CREAT : constants.O_RDWR,
			0o600,
		);
		try {
			const size = (await handle.stat()).size;
			if (size < input.offset) throw new Error("Transcript upload file is shorter than its committed offset");
			if (size > input.offset) await handle.truncate(input.offset);
			let written = 0;
			while (written < input.body.byteLength) {
				const { bytesWritten } = await handle.write(
					input.body,
					written,
					input.body.byteLength - written,
					input.offset + written,
				);
				written += bytesWritten;
			}
			await handle.datasync();
			mtimeMs = (await handle.stat()).mtimeMs;
			const tailStart = transcriptUploadTailStart(end);
			tailSha256 =
				tailStart >= input.offset
					? sha256(input.body.subarray(tailStart - input.offset))
					: sha256(Buffer.concat([await readFileRange(handle, tailStart, input.offset - tailStart), input.body]));
		} finally {
			await handle.close();
		}
		if (input.offset === 0) await syncDirectory(root, dirname(path));
	} catch (error) {
		await attemptAsync(() => discardUncommittedRange(root, path, input.offset));
		throw error;
	}
	let result: TranscriptUploadCommitResult;
	try {
		result = await dbOwnerCommitTranscriptUpload(
			owner,
			{
				agentId: input.agentId,
				sessionKey: input.sessionKey,
				sessionId: input.sessionId,
				harness: input.harness,
				project: input.project,
				projectScoped: input.projectScoped,
				purgeEpoch: scope.purgeEpoch,
				generation: input.generation,
				expectedOffset: input.offset,
				tailSha256,
				source: { path, sizeBytes: end, mtimeMs },
				endsRecord: input.body[input.body.byteLength - 1] === 0x0a,
				capturedAt: input.capturedAt,
			},
			options,
		);
	} catch (error) {
		if (await rangeAbsent(owner, input, scope.purgeEpoch, end)) {
			await attemptAsync(() => discardUncommittedRange(root, path, input.offset));
		}
		throw error;
	}
	if (result.status !== "committed") await discardUncommittedRange(root, path, input.offset);
	return result;
}

async function rangeAbsent(
	owner: Awaited<ReturnType<typeof getDbOwnerForAccessor>>,
	input: TranscriptUploadRequest,
	purgeEpoch: number,
	end: number,
): Promise<boolean> {
	const scope = await attemptAsync(() =>
		dbOwnerReadTranscriptUploadScope(
			owner,
			{ agentId: input.agentId, sessionKey: input.sessionKey },
			{ operation: "transcript-upload" },
		),
	);
	if (!scope) return false;
	const state = scope.state;
	return !(scope.purgeEpoch === purgeEpoch && state?.generation === input.generation && state.committedOffset >= end);
}

async function discardUncommittedRange(root: string, path: string, offset: number): Promise<void> {
	if (offset === 0) {
		await removeContainedTranscriptPath(root, path, { force: true });
		return;
	}
	const handle = await attemptAsync(() => openContainedTranscriptFile(root, path, constants.O_RDWR));
	if (!handle) return;
	try {
		if ((await handle.stat()).size > offset) await handle.truncate(offset);
	} finally {
		await handle.close();
	}
}

export type TranscriptUploadPurgeResult =
	| { readonly status: "removed" | "pending" }
	| { readonly status: "failed"; readonly error: string };

export interface TranscriptUploadPurgeOptions {
	readonly waitMs?: number;
	readonly deadlineMs?: number;
}

interface PurgeState {
	done: Promise<TranscriptUploadPurgeResult> | null;
	abort: AbortController | null;
	requested: boolean;
	failures: number;
	timer: ReturnType<typeof setTimeout> | null;
}

const purges = new Map<string, PurgeState>();

function purgeState(basePath: string): PurgeState {
	let state = purges.get(basePath);
	if (!state) {
		state = { done: null, abort: null, requested: false, failures: 0, timer: null };
		purges.set(basePath, state);
	}
	return state;
}

export async function drainTranscriptUploadPurges(
	basePath: string,
	options: TranscriptUploadPurgeOptions = {},
): Promise<TranscriptUploadPurgeResult> {
	const state = purgeState(basePath);
	state.failures = 0;
	const done = startPurgeRun(basePath, state, options.deadlineMs ?? PURGE_RUN_DEADLINE_MS);
	const waitMs = options.waitMs;
	if (waitMs === undefined) return await done;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const waited = new Promise<TranscriptUploadPurgeResult>((resolve) => {
		timer = setTimeout(() => resolve({ status: "pending" }), waitMs);
	});
	try {
		return await Promise.race([done, waited]);
	} finally {
		clearTimeout(timer);
	}
}

function clearPurgeTimer(state: PurgeState): void {
	clearTimeout(state.timer ?? undefined);
	state.timer = null;
}

function startPurgeRun(basePath: string, state: PurgeState, deadlineMs: number): Promise<TranscriptUploadPurgeResult> {
	clearPurgeTimer(state);
	state.requested = true;
	if (state.done) return state.done;
	const abort = new AbortController();
	state.abort = abort;
	state.done = runTranscriptUploadPurges(basePath, state, abort.signal, deadlineMs);
	return state.done;
}

export async function stopTranscriptUploadPurges(): Promise<void> {
	const running: Promise<TranscriptUploadPurgeResult>[] = [];
	for (const state of purges.values()) {
		clearPurgeTimer(state);
		state.abort?.abort();
		if (state.done) running.push(state.done);
	}
	await Promise.all(running);
	purges.clear();
}

async function runTranscriptUploadPurges(
	basePath: string,
	state: PurgeState,
	signal: AbortSignal,
	deadlineMs: number,
): Promise<TranscriptUploadPurgeResult> {
	const deadline = Date.now() + deadlineMs;
	let delayMs: number | null = null;
	try {
		const owner = await getDbOwner();
		for (;;) {
			state.requested = false;
			const { pending, progressed } = await dbOwnerDrainTranscriptUploadPurges(
				owner,
				{ basePath },
				{ operation: "transcript-upload.purge", signal },
			);
			const more = state.requested || (pending > 0 && progressed);
			if (more && Date.now() >= deadline) {
				delayMs = PURGE_CONTINUE_DELAY_MS;
				return { status: "pending" };
			}
			if (state.requested) continue;
			if (pending === 0) return { status: "removed" };
			if (!progressed) {
				logger.warn("transcripts", "Transcript upload purge stopped without progress", { pending });
				return { status: "pending" };
			}
		}
	} catch (error) {
		if (signal.aborted) return { status: "pending" };
		state.failures += 1;
		if (state.failures <= PURGE_RETRY_LIMIT) delayMs = PURGE_CONTINUE_DELAY_MS * 2 ** (state.failures - 1);
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("transcripts", "Transcript upload purge failed", { error: message, failures: state.failures });
		return { status: "failed", error: message };
	} finally {
		state.done = null;
		state.abort = null;
		if (delayMs !== null && !signal.aborted) {
			state.timer = setTimeout(() => {
				state.timer = null;
				void startPurgeRun(basePath, state, PURGE_RUN_DEADLINE_MS);
			}, delayMs);
			state.timer.unref?.();
		}
	}
}
