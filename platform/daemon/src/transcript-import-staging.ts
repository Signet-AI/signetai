import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface StagedTranscriptFile {
	readonly managedPath: string;
	readonly sizeBytes: number;
	readonly contentHash: string;
}

export class UnsafeManagedTranscriptPathError extends Error {
	readonly code = "unsafe_managed_transcript_path";

	constructor(message: string) {
		super(message);
		this.name = "UNSAFE_MANAGED_TRANSCRIPT_PATH";
	}
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

/** Reject symlink components before any operation can follow them. */
export async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
	const rootResolved = resolve(root);
	const candidateResolved = resolve(candidate);
	const relativePath = relative(rootResolved, candidateResolved);
	if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`) || relativePath.includes(`${sep}..`))
		throw new UnsafeManagedTranscriptPathError("managed path escapes workspace");

	let current = rootResolved;
	for (const component of relativePath ? relativePath.split(sep) : []) {
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new UnsafeManagedTranscriptPathError("managed path contains a symlink");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		current = join(current, component);
	}
	try {
		const info = await lstat(current);
		if (info.isSymbolicLink()) throw new UnsafeManagedTranscriptPathError("managed path contains a symlink");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function resolveSafeManagedTranscriptPath(root: string, managedPath: string): Promise<string> {
	const candidate = resolveManagedTranscriptPath(root, managedPath);
	await assertNoSymlinkComponents(root, candidate);
	return candidate;
}

export async function removeStagedTranscriptFile(root: string, managedPath: string): Promise<void> {
	const candidate = await resolveSafeManagedTranscriptPath(root, managedPath);
	await rm(candidate, { force: true });
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
	await assertNoSymlinkComponents(root, destination);
	await mkdir(dirname(destination), { recursive: true });
	await assertNoSymlinkComponents(root, destination);
	const partial = `${destination}.partial`;
	const hash = createHash("sha256");
	let sizeBytes = 0;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		await assertNoSymlinkComponents(root, partial);
		handle = await open(
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
		await assertNoSymlinkComponents(root, partial);
		const actual = await stat(partial);
		if (actual.size !== sizeBytes) throw new Error("staged size verification failed");
		await assertNoSymlinkComponents(root, destination);
		await rename(partial, destination);
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
