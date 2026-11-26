import { constants } from "node:fs";
import { lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
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

export function transcriptUploadSessionDirectory(basePath: string, agentId: string, sessionKey: string): string {
	return join(transcriptUploadAgentDirectory(basePath, agentId), hashSegment(sessionKey));
}

export function transcriptUploadFilePath(
	basePath: string,
	agentId: string,
	sessionKey: string,
	generation: number,
): string {
	return join(transcriptUploadSessionDirectory(basePath, agentId, sessionKey), `${generation}.jsonl`);
}

export async function readTranscriptUploadRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (bytesRead === 0) throw new Error("Transcript upload file is shorter than its committed range");
		filled += bytesRead;
	}
	return buffer;
}

export async function readTranscriptUploadPrefix(basePath: string, path: string, sizeBytes: number): Promise<Buffer> {
	const handle = await openContainedTranscriptFile(transcriptUploadsRoot(basePath), path, constants.O_RDONLY);
	try {
		return await readTranscriptUploadRange(handle, 0, sizeBytes);
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
