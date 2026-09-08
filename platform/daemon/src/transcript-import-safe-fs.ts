import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi";

const DESCRIPTOR_ROOT =
	process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : undefined;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DARWIN_DIRECTORY_BUFFER_BYTES = 64 * 1024;
const DARWIN_DIRENT_HEADER_BYTES = 8;

type DarwinFileSystem = {
	readonly symbols: {
		readonly __error: () => ReturnType<typeof ptr>;
		readonly close: (fd: number) => number;
		readonly getdirentries: (
			fd: number,
			buffer: ReturnType<typeof ptr>,
			length: number,
			base: ReturnType<typeof ptr>,
		) => number;
		readonly openat: (dirfd: number, path: ReturnType<typeof ptr>, flags: number, mode: number) => number;
		readonly unlinkat: (dirfd: number, path: ReturnType<typeof ptr>, flags: number) => number;
	};
};

let darwinFileSystem: DarwinFileSystem | null | undefined;

function loadDarwinFileSystem(): DarwinFileSystem | null {
	if (process.platform !== "darwin") return null;
	if (darwinFileSystem !== undefined) return darwinFileSystem;
	try {
		darwinFileSystem = dlopen("/usr/lib/libSystem.B.dylib", {
			__error: { args: [], returns: "ptr" },
			close: { args: ["i32"], returns: "i32" },
			getdirentries: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
			openat: { args: ["i32", "cstring", "i32", "i32"], returns: "i32" },
			unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
		}) as unknown as DarwinFileSystem;
	} catch {
		darwinFileSystem = null;
	}
	return darwinFileSystem;
}

function darwinError(operation: string, api: DarwinFileSystem): NodeJS.ErrnoException {
	const errno = read.i32(api.symbols.__error(), 0);
	const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0] ?? "EIO";
	return Object.assign(new Error(`${operation} failed: ${code}`), { code, errno });
}

function openAt(dirfd: number, path: string, flags: number, mode = 0): number {
	const api = loadDarwinFileSystem();
	if (!api) throw new Error("Darwin descriptor filesystem unavailable");
	const fd = api.symbols.openat(dirfd, ptr(Buffer.from(`${path}\0`)), flags, mode);
	if (fd < 0) throw darwinError("openat", api);
	return fd;
}

async function duplicateDarwinDescriptor(fd: number, flags: number): Promise<FileHandle> {
	const api = loadDarwinFileSystem();
	if (!api) throw new Error("Darwin descriptor filesystem unavailable");
	try {
		return await open(descriptorPath(fd), flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR));
	} finally {
		api.symbols.close(fd);
	}
}

async function openContainedChild(parent: FileHandle, name: string, flags: number, mode?: number): Promise<FileHandle> {
	if (process.platform !== "darwin") return open(descriptorPath(parent.fd, name), flags, mode);
	return duplicateDarwinDescriptor(openAt(parent.fd, name, flags, mode), flags);
}

function* readDarwinDirectory(fd: number, api: DarwinFileSystem): Generator<string> {
	const buffer = new Uint8Array(DARWIN_DIRECTORY_BUFFER_BYTES);
	const base = new BigInt64Array(1);
	const bufferPointer = ptr(buffer);
	const basePointer = ptr(base);
	const decoder = new TextDecoder();
	for (;;) {
		const bytes = api.symbols.getdirentries(fd, bufferPointer, buffer.byteLength, basePointer);
		if (bytes < 0) throw darwinError("getdirentries", api);
		if (bytes === 0) return;
		for (let offset = 0; offset < bytes; ) {
			if (offset + DARWIN_DIRENT_HEADER_BYTES > bytes) throw new Error("invalid macOS directory entry");
			const recordLength = read.u16(bufferPointer, offset + 4);
			const nameLength = read.u8(bufferPointer, offset + 7);
			if (
				recordLength < DARWIN_DIRENT_HEADER_BYTES ||
				offset + recordLength > bytes ||
				nameLength > recordLength - DARWIN_DIRENT_HEADER_BYTES
			)
				throw new Error("invalid macOS directory entry");
			if (nameLength > 0) {
				const name = decoder.decode(
					new Uint8Array(toArrayBuffer(bufferPointer, offset + DARWIN_DIRENT_HEADER_BYTES, nameLength)),
				);
				if (name !== "." && name !== "..") yield name;
			}
			offset += recordLength;
		}
	}
}

export class UnsafeManagedTranscriptPathError extends Error {
	readonly code = "unsafe_managed_transcript_path";

	constructor(message: string) {
		super(message);
		this.name = "UNSAFE_MANAGED_TRANSCRIPT_PATH";
	}
}

function descriptorPath(fd: number, child?: string): string {
	if (DESCRIPTOR_ROOT === undefined) throw new Error("Legacy transcript migration requires Linux or macOS");
	return child === undefined ? `${DESCRIPTOR_ROOT}/${fd}` : `${DESCRIPTOR_ROOT}/${fd}/${child}`;
}

function requireDescriptorFilesystem(): void {
	if (DESCRIPTOR_ROOT === undefined) throw new Error("Legacy transcript migration requires Linux or macOS");
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

/** Open every parent directory from a held descriptor. */
async function openContainedDirectory(root: string, parts: readonly string[]): Promise<FileHandle> {
	requireDescriptorFilesystem();
	let current: FileHandle;
	try {
		current = await open(resolve(root), DIRECTORY_FLAGS);
	} catch (error) {
		throw normalizePathError(error);
	}
	try {
		for (const component of parts) {
			const next = await openContainedChild(current, component, DIRECTORY_FLAGS);
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
		return await openContainedChild(parent, name, flags | NOFOLLOW, mode);
	} catch (error) {
		throw normalizePathError(error);
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
		if (process.platform === "darwin") {
			const api = loadDarwinFileSystem();
			if (!api) throw new Error("Darwin descriptor filesystem unavailable");
			const flags = options.recursive ? 0x800 : 0;
			if (api.symbols.unlinkat(parent.fd, ptr(Buffer.from(`${name}\0`)), flags) < 0) {
				const error = darwinError("unlinkat", api);
				if (!(options.force && error.code === "ENOENT")) throw error;
			}
		} else {
			const target = descriptorPath(parent.fd, name);
			await assertFinalComponentIsNotSymlink(target);
			await rm(target, options);
		}
	} catch (error) {
		throw normalizePathError(error);
	} finally {
		await closeQuietly(parent);
	}
}

/** Migration inventory holds the directory while iterating a bounded native buffer. */
export async function* iterateContainedTranscriptDirectory(root: string, candidate: string): AsyncGenerator<string> {
	const directory = await openContainedDirectory(root, containedParts(root, candidate, true));
	try {
		if (process.platform === "darwin") {
			const api = loadDarwinFileSystem();
			if (!api) throw new Error("Darwin descriptor filesystem unavailable");
			yield* readDarwinDirectory(directory.fd, api);
		} else {
			const entries = await opendir(descriptorPath(directory.fd));
			for await (const entry of entries) yield entry.name;
		}
	} finally {
		await closeQuietly(directory);
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
