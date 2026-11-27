import { constants } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { attemptAsync, readFileRange, resolveWorkspaceLayout } from "@signet/core";
import { sha256 } from "./transcript-capture-jobs";
import {
	iterateContainedTranscriptDirectory,
	openContainedTranscriptFile,
	removeContainedTranscriptPath,
} from "./transcript-import-safe-fs";

export const TRANSCRIPT_UPLOAD_CLEANUP_ENTRIES = 256;

function hashSegment(value: string): string {
	return sha256(value).slice(0, 32);
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function transcriptUploadsRoot(basePath: string): string {
	return resolveWorkspaceLayout(basePath).transcripts;
}

export function transcriptUploadAgentRelativePath(agentId: string): string {
	return join("uploads", hashSegment(agentId));
}

export function isTranscriptUploadPath(basePath: string, path: string): boolean {
	const rel = relative(join(transcriptUploadsRoot(basePath), "uploads"), resolve(path));
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function transcriptUploadAgentDirectory(basePath: string, agentId: string): string {
	return join(transcriptUploadsRoot(basePath), transcriptUploadAgentRelativePath(agentId));
}

const EPOCH_DIRECTORY = /^e(0|[1-9][0-9]*)$/;

export function transcriptUploadEpochDirectory(basePath: string, agentId: string, epoch: number): string {
	return join(transcriptUploadAgentDirectory(basePath, agentId), `e${epoch}`);
}

export function transcriptUploadSessionDirectory(
	basePath: string,
	agentId: string,
	epoch: number,
	sessionKey: string,
): string {
	return join(transcriptUploadEpochDirectory(basePath, agentId, epoch), hashSegment(sessionKey));
}

export function transcriptUploadFilePath(
	basePath: string,
	agentId: string,
	epoch: number,
	sessionKey: string,
	generation: number,
): string {
	return join(transcriptUploadSessionDirectory(basePath, agentId, epoch, sessionKey), `${generation}.jsonl`);
}

export function isTranscriptUploadSessionDirectory(
	basePath: string,
	agentId: string,
	sessionKey: string,
	path: string,
): boolean {
	const epochDirectory = dirname(path);
	return (
		basename(path) === hashSegment(sessionKey) &&
		EPOCH_DIRECTORY.test(basename(epochDirectory)) &&
		dirname(epochDirectory) === resolve(transcriptUploadAgentDirectory(basePath, agentId))
	);
}

export async function readTranscriptUploadPrefix(basePath: string, path: string, sizeBytes: number): Promise<Buffer> {
	const handle = await openContainedTranscriptFile(transcriptUploadsRoot(basePath), path, constants.O_RDONLY);
	try {
		const bytes = await readFileRange(handle, 0, sizeBytes);
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} finally {
		await handle.close();
	}
}

export async function removeTranscriptUploadTree(
	basePath: string,
	directory: string,
	budget: { remaining: number },
): Promise<boolean> {
	if (!isTranscriptUploadPath(basePath, directory)) throw new Error("Transcript upload cleanup target escapes uploads");
	return await removeTree(transcriptUploadsRoot(basePath), directory, budget);
}

export async function removeStaleTranscriptUploadEpochs(
	basePath: string,
	agentRelativePath: string,
	currentEpoch: number,
	budget: { remaining: number },
): Promise<boolean> {
	const root = transcriptUploadsRoot(basePath);
	const agentDirectory = join(root, agentRelativePath);
	if (!isTranscriptUploadPath(basePath, agentDirectory))
		throw new Error("Transcript upload cleanup target escapes uploads");
	const stale: string[] = [];
	let current = false;
	try {
		for await (const name of iterateContainedTranscriptDirectory(root, agentDirectory)) {
			const match = EPOCH_DIRECTORY.exec(name);
			if (match && Number(match[1]) < currentEpoch) stale.push(name);
			else current = true;
		}
	} catch (error) {
		if (missing(error)) return true;
		throw error;
	}
	for (const name of stale) if (!(await removeTree(root, join(agentDirectory, name), budget))) return false;
	if (!current) await attemptAsync(() => removeContainedTranscriptPath(root, agentDirectory, { directory: true }));
	return true;
}

async function removeTree(root: string, directory: string, budget: { remaining: number }): Promise<boolean> {
	const names: string[] = [];
	try {
		for await (const name of iterateContainedTranscriptDirectory(root, directory)) {
			if (names.length >= budget.remaining) break;
			names.push(name);
		}
	} catch (error) {
		if (missing(error)) return true;
		throw error;
	}
	for (const name of names) {
		if (budget.remaining <= 0) return false;
		const child = join(directory, name);
		const stat = await lstat(child).catch((error: unknown) => {
			if (missing(error)) return null;
			throw error;
		});
		if (stat?.isDirectory()) {
			if (!(await removeTree(root, child, budget))) return false;
			continue;
		}
		if (stat) await removeContainedTranscriptPath(root, child, { force: true });
		budget.remaining -= 1;
	}
	if (budget.remaining <= 0) return false;
	await removeContainedTranscriptPath(root, directory, { directory: true, force: true });
	budget.remaining -= 1;
	return true;
}
