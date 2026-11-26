import { constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { attemptAsync } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import {
	dbOwnerCommitTranscriptUpload,
	dbOwnerDrainTranscriptUploadPurges,
	dbOwnerReadTranscriptUploadScope,
	getDbOwner,
	getDbOwnerForAccessor,
} from "./db-owner-runtime";
import { logger } from "./logger";
import { type TranscriptUploadCommitResult, transcriptUploadConflict } from "./session-transcripts";
import { sha256 } from "./transcript-capture-jobs";
import { withTranscriptImportOperationLock } from "./transcript-import-operation-lock";
import { openContainedTranscriptFile, removeContainedTranscriptPath } from "./transcript-import-safe-fs";
import { readTranscriptUploadRange, transcriptUploadFilePath, transcriptUploadsRoot } from "./transcript-upload-paths";

export const MAX_TRANSCRIPT_UPLOAD_BYTES = 1024 * 1024;
const TAIL_HASH_BYTES = 64 * 1024;

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
	readonly body: Uint8Array;
	readonly capturedAt: string;
	readonly signal?: AbortSignal;
}

export type TranscriptUploadResult =
	| TranscriptUploadCommitResult
	| { readonly status: "invalid"; readonly reason: "empty" | "newline" | "checksum" };

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
	if (input.body[input.body.byteLength - 1] !== 0x0a) return { status: "invalid", reason: "newline" };
	if (sha256(input.body) !== input.checksum.toLowerCase()) return { status: "invalid", reason: "checksum" };
	return null;
}

export async function uploadTranscriptRange(
	accessor: DbAccessor,
	input: TranscriptUploadRequest,
): Promise<TranscriptUploadResult> {
	const invalid = validate(input);
	if (invalid) return invalid;
	return await withTranscriptImportOperationLock(`upload\0${input.agentId}\0${input.sessionKey}`, async () => {
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
		const path = transcriptUploadFilePath(input.basePath, input.agentId, input.sessionKey, input.generation);
		if (input.offset === 0) await mkdir(dirname(path), { recursive: true });
		const handle = await openContainedTranscriptFile(root, path, constants.O_RDWR | constants.O_CREAT, 0o600);
		const end = input.offset + input.body.byteLength;
		let mtimeMs: number;
		let tailSha256: string;
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
			const tailStart = Math.max(0, end - TAIL_HASH_BYTES);
			tailSha256 =
				tailStart >= input.offset
					? sha256(input.body.subarray(tailStart - input.offset))
					: sha256(
							Buffer.concat([await readTranscriptUploadRange(handle, tailStart, input.offset - tailStart), input.body]),
						);
		} finally {
			await handle.close();
		}
		if (input.offset === 0) await syncDirectory(root, dirname(path));
		const result = await dbOwnerCommitTranscriptUpload(
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
				capturedAt: input.capturedAt,
			},
			options,
		);
		if (result.status !== "committed") await discardUncommittedRange(root, path, input.offset);
		return result;
	});
}

async function discardUncommittedRange(root: string, path: string, offset: number): Promise<void> {
	if (offset === 0) {
		await removeContainedTranscriptPath(root, path, { force: true });
		return;
	}
	const handle = await attemptAsync(() => openContainedTranscriptFile(root, path, constants.O_RDWR));
	if (!handle) return;
	try {
		await handle.truncate(offset);
	} finally {
		await handle.close();
	}
}

export type TranscriptUploadPurgeResult =
	| { readonly status: "removed" | "pending" }
	| { readonly status: "failed"; readonly error: string };

interface PurgeDrain {
	readonly done: Promise<TranscriptUploadPurgeResult>;
	readonly abort: AbortController;
}

const purgeDrains = new Map<string, PurgeDrain>();
const purgeRequests = new Set<string>();

export async function drainTranscriptUploadPurges(
	basePath: string,
	waitMs?: number,
): Promise<TranscriptUploadPurgeResult> {
	let drain = purgeDrains.get(basePath);
	if (drain) purgeRequests.add(basePath);
	else {
		const abort = new AbortController();
		drain = { abort, done: runTranscriptUploadPurges(basePath, abort.signal) };
		purgeDrains.set(basePath, drain);
	}
	if (waitMs === undefined) return await drain.done;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const waited = new Promise<TranscriptUploadPurgeResult>((resolve) => {
		timer = setTimeout(() => resolve({ status: "pending" }), waitMs);
	});
	try {
		return await Promise.race([drain.done, waited]);
	} finally {
		clearTimeout(timer);
	}
}

export async function stopTranscriptUploadPurges(): Promise<void> {
	const drains = [...purgeDrains.values()];
	for (const drain of drains) drain.abort.abort();
	await Promise.all(drains.map((drain) => drain.done));
}

async function runTranscriptUploadPurges(basePath: string, signal: AbortSignal): Promise<TranscriptUploadPurgeResult> {
	try {
		const owner = await getDbOwner();
		for (;;) {
			purgeRequests.delete(basePath);
			const { pending, progressed } = await dbOwnerDrainTranscriptUploadPurges(
				owner,
				{ basePath },
				{ operation: "transcript-upload.purge", signal },
			);
			if (purgeRequests.has(basePath)) continue;
			if (pending === 0) return { status: "removed" };
			if (!progressed) {
				logger.warn("transcripts", "Transcript upload purge stopped without progress", { pending });
				return { status: "pending" };
			}
		}
	} catch (error) {
		if (signal.aborted) return { status: "pending" };
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("transcripts", "Transcript upload purge failed", { error: message });
		return { status: "failed", error: message };
	} finally {
		purgeDrains.delete(basePath);
		purgeRequests.delete(basePath);
	}
}
