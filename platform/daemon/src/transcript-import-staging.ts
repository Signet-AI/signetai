import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	mkdirContainedTranscriptDirectory,
	openContainedTranscriptFile,
	removeContainedTranscriptPath,
	renameContainedTranscriptPath,
	UnsafeManagedTranscriptPathError,
} from "./transcript-import-safe-fs";

export { UnsafeManagedTranscriptPathError } from "./transcript-import-safe-fs";

export interface StagedTranscriptFile {
	readonly managedPath: string;
	readonly sizeBytes: number;
	readonly contentHash: string;
}

/** Resolve a ledger path only inside imports/transcripts under the workspace. */
export function resolveManagedTranscriptPath(root: string, managedPath: string): string {
	const rootResolved = resolve(root);
	const candidate = resolve(rootResolved, managedPath);
	const relativePath = relative(rootResolved, candidate);
	const managedPrefix = `${join("imports", "transcripts")}${sep}`;
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		relativePath.includes(`..${sep}`) ||
		relativePath.includes(`${sep}..`) ||
		!relativePath.startsWith(managedPrefix)
	)
		throw new UnsafeManagedTranscriptPathError("managed staged path escapes workspace");
	return candidate;
}

export async function removeStagedTranscriptFile(root: string, managedPath: string): Promise<void> {
	const candidate = resolveManagedTranscriptPath(root, managedPath);
	try {
		await removeContainedTranscriptPath(root, candidate, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Stream raw bytes into a managed path, then fsync and atomically publish it. */
export async function stageTranscriptStream(
	root: string,
	sourceId: string,
	body: AsyncIterable<Uint8Array>,
): Promise<StagedTranscriptFile> {
	if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) throw new Error("invalid source id");
	const managedRelativePath = join("imports", "transcripts", sourceId, "source.jsonl");
	const destination = resolveManagedTranscriptPath(root, managedRelativePath);
	await mkdirContainedTranscriptDirectory(root, dirname(destination));
	const partial = `${destination}.partial`;
	const hash = createHash("sha256");
	let sizeBytes = 0;
	let handle: FileHandle | undefined;
	try {
		handle = await openContainedTranscriptFile(
			root,
			partial,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
			0o600,
		);
		for await (const chunk of body) {
			if (!(chunk instanceof Uint8Array)) throw new Error("stream chunk must be bytes");
			sizeBytes += chunk.byteLength;
			hash.update(chunk);
			await handle.write(chunk);
		}
		await handle.sync();
		await handle.close();
		handle = undefined;
		const verification = await openContainedTranscriptFile(root, partial, fsConstants.O_RDONLY);
		try {
			const actual = await verification.stat();
			if (actual.size !== sizeBytes) throw new Error("staged size verification failed");
		} finally {
			await verification.close();
		}
		await renameContainedTranscriptPath(root, partial, destination);
		return { managedPath: managedRelativePath, sizeBytes, contentHash: hash.digest("hex") };
	} catch (error) {
		if (handle !== undefined) {
			try {
				await handle.close();
			} catch {
				// Preserve the original staging failure.
			}
		}
		try {
			await removeStagedTranscriptFile(root, `${managedRelativePath}.partial`);
		} catch {
			// Never follow an invalid cleanup path after a failed upload.
		}
		throw error;
	}
}
