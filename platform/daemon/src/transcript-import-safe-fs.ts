import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const DESCRIPTOR_ROOT =
	process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : undefined;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export class UnsafeManagedTranscriptPathError extends Error {
	readonly code = "unsafe_managed_transcript_path";

	constructor(message: string) {
		super(message);
		this.name = "UNSAFE_MANAGED_TRANSCRIPT_PATH";
	}
}

function descriptorPath(fd: number, child?: string): string {
	if (DESCRIPTOR_ROOT === undefined)
		throw new UnsafeManagedTranscriptPathError("descriptor-relative transcript filesystem is unavailable");
	return child === undefined ? `${DESCRIPTOR_ROOT}/${fd}` : `${DESCRIPTOR_ROOT}/${fd}/${child}`;
}

function requireDescriptorFilesystem(): void {
	if (DESCRIPTOR_ROOT === undefined)
		throw new UnsafeManagedTranscriptPathError("descriptor-relative transcript filesystem is unavailable");
}

function normalizePathError(error: unknown): unknown {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ELOOP" || code === "ENOTDIR")
		return new UnsafeManagedTranscriptPathError("managed path contains a symlink or non-directory component");
	return error;
}

function containedParts(root: string, candidate: string, allowRoot = false): string[] {
	const rootResolved = resolve(root);
	const candidateResolved = resolve(candidate);
	const relativePath = relative(rootResolved, candidateResolved);
	if (
		(!allowRoot && !relativePath) ||
		relativePath.startsWith("..") ||
		relativePath.includes(`..${sep}`) ||
		relativePath.includes(`${sep}..`) ||
		(relativePath.length > 0 && relativePath.startsWith(sep))
	)
		throw new UnsafeManagedTranscriptPathError("managed path escapes workspace");
	return relativePath ? relativePath.split(sep).filter(Boolean) : [];
}

async function closeQuietly(handle: FileHandle): Promise<void> {
	try {
		await handle.close();
	} catch {
		// Preserve the operation's original result or error.
	}
}

async function assertFinalComponentIsNotSymlink(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new UnsafeManagedTranscriptPathError("managed path contains a symlink");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Open every parent directory from a held descriptor. POSIX descriptor paths
 * keep the checked parent stable while the caller performs its operation.
 */
async function openContainedDirectory(root: string, parts: readonly string[], create = false): Promise<FileHandle> {
	requireDescriptorFilesystem();
	let current: FileHandle;
	try {
		current = await open(resolve(root), DIRECTORY_FLAGS);
	} catch (error) {
		throw normalizePathError(error);
	}
	try {
		for (const component of parts) {
			const child = descriptorPath(current.fd, component);
			let next: FileHandle;
			try {
				next = await open(child, DIRECTORY_FLAGS);
			} catch (error) {
				if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				try {
					await mkdir(child, { mode: 0o700 });
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				next = await open(child, DIRECTORY_FLAGS);
			}
			await closeQuietly(current);
			current = next;
		}
		return current;
	} catch (error) {
		await closeQuietly(current);
		throw normalizePathError(error);
	}
}

/** Open a file through a checked, descriptor-relative parent directory. */
export async function openContainedTranscriptFile(
	root: string,
	candidate: string,
	flags: number,
	mode?: number,
	beforeOpen?: () => Promise<void>,
): Promise<FileHandle> {
	const parts = containedParts(root, candidate);
	const name = parts.pop();
	if (name === undefined) throw new UnsafeManagedTranscriptPathError("managed file path is empty");
	const parent = await openContainedDirectory(root, parts);
	try {
		await beforeOpen?.();
		return await open(descriptorPath(parent.fd, name), flags | NOFOLLOW, mode);
	} catch (error) {
		throw normalizePathError(error);
	} finally {
		await closeQuietly(parent);
	}
}

/** Create a directory tree without traversing a symlinked component. */
export async function mkdirContainedTranscriptDirectory(root: string, candidate: string): Promise<void> {
	const parts = containedParts(root, candidate, true);
	const directory = await openContainedDirectory(root, parts, true);
	await closeQuietly(directory);
}

/** Create one final directory atomically under its held parent. */
export async function createContainedTranscriptDirectory(root: string, candidate: string): Promise<boolean> {
	const parts = containedParts(root, candidate);
	const name = parts.pop();
	if (name === undefined) throw new UnsafeManagedTranscriptPathError("managed directory path is empty");
	const parent = await openContainedDirectory(root, parts, true);
	try {
		try {
			await mkdir(descriptorPath(parent.fd, name), { mode: 0o700 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw normalizePathError(error);
		}
	} finally {
		await closeQuietly(parent);
	}
}

/** Remove a final entry while holding its checked parent directory. */
export async function removeContainedTranscriptPath(
	root: string,
	candidate: string,
	options: { readonly force?: boolean; readonly recursive?: boolean } = {},
): Promise<void> {
	const parts = containedParts(root, candidate);
	const name = parts.pop();
	if (name === undefined) throw new UnsafeManagedTranscriptPathError("managed path is empty");
	const parent = await openContainedDirectory(root, parts);
	try {
		const target = descriptorPath(parent.fd, name);
		await assertFinalComponentIsNotSymlink(target);
		await rm(target, options);
	} catch (error) {
		throw normalizePathError(error);
	} finally {
		await closeQuietly(parent);
	}
}

/** Atomically rename entries whose parent directories are held by descriptor. */
export async function renameContainedTranscriptPath(root: string, from: string, to: string): Promise<void> {
	const fromParts = containedParts(root, from);
	const fromName = fromParts.pop();
	const toParts = containedParts(root, to);
	const toName = toParts.pop();
	if (fromName === undefined || toName === undefined)
		throw new UnsafeManagedTranscriptPathError("managed rename path is empty");
	const fromParent = await openContainedDirectory(root, fromParts);
	try {
		const toParent = await openContainedDirectory(root, toParts);
		try {
			await assertFinalComponentIsNotSymlink(descriptorPath(fromParent.fd, fromName));
			await assertFinalComponentIsNotSymlink(descriptorPath(toParent.fd, toName));
			await rename(descriptorPath(fromParent.fd, fromName), descriptorPath(toParent.fd, toName));
		} catch (error) {
			throw normalizePathError(error);
		} finally {
			await closeQuietly(toParent);
		}
	} finally {
		await closeQuietly(fromParent);
	}
}

/** Read directory entries through a held directory descriptor. */
export async function readdirContainedTranscriptDirectory(root: string, candidate: string): Promise<string[]> {
	const parts = containedParts(root, candidate, true);
	const directory = await openContainedDirectory(root, parts);
	try {
		return await readdir(descriptorPath(directory.fd));
	} catch (error) {
		throw normalizePathError(error);
	} finally {
		await closeQuietly(directory);
	}
}

/** Flush a contained directory after an atomic rename. */
export async function syncContainedTranscriptDirectory(root: string, candidate: string): Promise<void> {
	const parts = containedParts(root, candidate, true);
	const directory = await openContainedDirectory(root, parts);
	try {
		await directory.sync();
	} finally {
		await closeQuietly(directory);
	}
}
