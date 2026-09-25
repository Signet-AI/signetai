import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { relative, resolve, sep } from "node:path";

type DarwinPointer = unknown;

type DarwinFfi = {
	readonly dlopen: (path: string, symbols: Record<string, unknown>) => DarwinApi;
	readonly ptr: (value: ArrayBufferView) => DarwinPointer;
	readonly read: {
		i32: (pointer: DarwinPointer, offset: number) => number;
		u16: (pointer: DarwinPointer, offset: number) => number;
		u8: (pointer: DarwinPointer, offset: number) => number;
	};
	readonly toArrayBuffer: (pointer: DarwinPointer, offset: number, length: number) => ArrayBuffer;
};

let darwinFfi: DarwinFfi | null | undefined;

function loadDarwinFfi(): DarwinFfi | null {
	if (process.platform !== "darwin") return null;
	if (darwinFfi !== undefined) return darwinFfi;
	try {
		const ffiModule = "bun:ffi";
		darwinFfi = require(ffiModule) as DarwinFfi;
	} catch {
		darwinFfi = null;
	}
	return darwinFfi;
}

const DESCRIPTOR_ROOT =
	process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : undefined;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
const FILE_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DARWIN_DIRECTORY_BUFFER_BYTES = 64 * 1024;
const DARWIN_DIRENT_HEADER_BYTES = 8;
const DARWIN_AT_REMOVEDIR = 0x80;

export class UnsupportedDescriptorFilesystemError extends Error {
	readonly code = "unsupported_descriptor_filesystem";

	constructor(message = "descriptor-rooted filesystem requires Linux or macOS") {
		super(message);
		this.name = "UnsupportedDescriptorFilesystemError";
	}
}

export class UnsafeDescriptorPathError extends Error {
	readonly code = "unsafe_descriptor_path";

	constructor(message: string) {
		super(message);
		this.name = "UnsafeDescriptorPathError";
	}
}

export type DescriptorEntry = {
	readonly path: string;
	readonly type: "directory" | "file" | "symlink";
	readonly mode: number;
	readonly mtimeMs: number;
	readonly size: number;
	readonly dev: number;
	readonly ino: number;
	readonly nlink: number;
	readonly uid: number;
	readonly gid: number;
	readonly target?: string;
};

export type DescriptorWriteOptions = {
	readonly mode?: number;
	readonly mtimeMs?: number;
	readonly beforeMutation?: () => Promise<void>;
};

export type DescriptorCopyOptions = DescriptorWriteOptions & {
	readonly temporaryName?: string;
	readonly beforePublish?: () => Promise<void>;
	readonly afterPublish?: () => Promise<void>;
};

type DarwinApi = {
	readonly symbols: {
		readonly __error: () => DarwinPointer;
		readonly close: (fd: number) => number;
		readonly getdirentries: (fd: number, buffer: DarwinPointer, length: number, base: DarwinPointer) => number;
		readonly linkat: (
			oldfd: number,
			oldpath: DarwinPointer,
			newfd: number,
			newpath: DarwinPointer,
			flags: number,
		) => number;
		readonly mkdirat: (fd: number, path: DarwinPointer, mode: number) => number;
		readonly openat: (fd: number, path: DarwinPointer, flags: number, mode: number) => number;
		readonly readlinkat: (fd: number, path: DarwinPointer, buffer: DarwinPointer, length: number) => number;
		readonly renameat: (oldfd: number, oldpath: DarwinPointer, newfd: number, newpath: DarwinPointer) => number;
		readonly symlinkat: (target: DarwinPointer, fd: number, path: DarwinPointer) => number;
		readonly unlinkat: (fd: number, path: DarwinPointer, flags: number) => number;
	};
};

let darwinApi: DarwinApi | null | undefined;

function cstring(value: string): DarwinPointer {
	const ffi = loadDarwinFfi();
	if (!ffi) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	return ffi.ptr(Buffer.from(`${value}\0`));
}

function loadDarwinApi(): DarwinApi | null {
	const ffi = loadDarwinFfi();
	if (!ffi) return null;
	if (darwinApi !== undefined) return darwinApi;
	try {
		darwinApi = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
			__error: { args: [], returns: "ptr" },
			close: { args: ["i32"], returns: "i32" },
			getdirentries: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
			linkat: { args: ["i32", "cstring", "i32", "cstring", "i32"], returns: "i32" },
			mkdirat: { args: ["i32", "cstring", "i32"], returns: "i32" },
			openat: { args: ["i32", "cstring", "i32", "i32"], returns: "i32" },
			readlinkat: { args: ["i32", "cstring", "ptr", "usize"], returns: "i64" },
			renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
			symlinkat: { args: ["cstring", "i32", "cstring"], returns: "i32" },
			unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
		}) as unknown as DarwinApi;
	} catch {
		darwinApi = null;
	}
	return darwinApi;
}

function darwinError(operation: string, api: DarwinApi): NodeJS.ErrnoException {
	const ffi = loadDarwinFfi();
	if (!ffi) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	const errno = ffi.read.i32(api.symbols.__error(), 0);
	const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0] ?? "EIO";
	return Object.assign(new Error(`${operation} failed: ${code}`), { code, errno });
}

function descriptorPath(fd: number, name?: string): string {
	if (!DESCRIPTOR_ROOT) throw new UnsupportedDescriptorFilesystemError();
	return name === undefined ? `${DESCRIPTOR_ROOT}/${fd}` : `${DESCRIPTOR_ROOT}/${fd}/${name}`;
}

function normalizeError(error: unknown): unknown {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ELOOP" || code === "ENOTDIR")
		return new UnsafeDescriptorPathError("descriptor path contains a symlink or non-directory component");
	return error;
}

function parts(path: string): string[] {
	if (!path || path.includes("\0")) throw new UnsafeDescriptorPathError("descriptor path is empty or invalid");
	const normalized = path.replaceAll("\\", sep);
	if (normalized.startsWith(sep)) throw new UnsafeDescriptorPathError("descriptor path escapes root");
	const raw = normalized.split(sep).filter(Boolean);
	if (raw.some((part) => part === "." || part === ".."))
		throw new UnsafeDescriptorPathError("descriptor path escapes root");
	const resolved = resolve("/", normalized);
	const rel = relative("/", resolved);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`))
		throw new UnsafeDescriptorPathError("descriptor path escapes root");
	return rel.split(sep).filter(Boolean);
}

async function closeQuietly(handle: FileHandle): Promise<void> {
	try {
		await handle.close();
	} catch {}
}

async function requirePreservedMode(handle: FileHandle, mode: number): Promise<void> {
	if (((await handle.stat()).mode & 0o7777) !== mode)
		throw new UnsupportedDescriptorFilesystemError("descriptor mode not preserved by destination filesystem");
}

async function duplicateDarwinDescriptor(fd: number, flags: number): Promise<FileHandle> {
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	try {
		return await open(descriptorPath(fd), flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR));
	} finally {
		api.symbols.close(fd);
	}
}

async function openChild(parent: FileHandle, name: string, flags: number, mode = 0): Promise<FileHandle> {
	try {
		if (process.platform === "linux") return await open(descriptorPath(parent.fd, name), flags, mode);
		const api = loadDarwinApi();
		if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
		const fd = api.symbols.openat(parent.fd, cstring(name), flags, mode);
		if (fd < 0) throw darwinError("openat", api);
		return await duplicateDarwinDescriptor(fd, flags);
	} catch (error) {
		throw normalizeError(error);
	}
}

async function mkdirChild(parent: FileHandle, name: string, mode: number): Promise<void> {
	if (process.platform === "linux") return mkdir(descriptorPath(parent.fd, name), { mode });
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.mkdirat(parent.fd, cstring(name), mode) < 0) throw darwinError("mkdirat", api);
}

async function linkChild(parent: FileHandle, source: string, target: string): Promise<void> {
	if (process.platform === "linux") return link(descriptorPath(parent.fd, source), descriptorPath(parent.fd, target));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.linkat(parent.fd, cstring(source), parent.fd, cstring(target), 0) < 0)
		throw darwinError("linkat", api);
}

async function renameChild(parent: FileHandle, source: string, target: string): Promise<void> {
	if (process.platform === "linux") return rename(descriptorPath(parent.fd, source), descriptorPath(parent.fd, target));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.renameat(parent.fd, cstring(source), parent.fd, cstring(target)) < 0)
		throw darwinError("renameat", api);
}

async function unlinkChild(parent: FileHandle, name: string, directory = false): Promise<void> {
	if (process.platform === "linux") {
		if (directory) await rmdir(descriptorPath(parent.fd, name));
		else await unlink(descriptorPath(parent.fd, name));
		return;
	}
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.unlinkat(parent.fd, cstring(name), directory ? DARWIN_AT_REMOVEDIR : 0) < 0)
		throw darwinError("unlinkat", api);
}

async function symlinkChild(parent: FileHandle, target: string, name: string): Promise<void> {
	if (process.platform === "linux") return symlink(target, descriptorPath(parent.fd, name));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.symlinkat(cstring(target), parent.fd, cstring(name)) < 0) throw darwinError("symlinkat", api);
}

async function readlinkChild(parent: FileHandle, name: string): Promise<string> {
	if (process.platform === "linux") return readlink(descriptorPath(parent.fd, name));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	const buffer = new Uint8Array(64 * 1024);
	const ffi = loadDarwinFfi();
	if (!ffi) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	const length = api.symbols.readlinkat(parent.fd, cstring(name), ffi.ptr(buffer), buffer.byteLength);
	if (length < 0) throw darwinError("readlinkat", api);
	return new TextDecoder().decode(buffer.subarray(0, Number(length)));
}

function* readDarwinDirectory(fd: number, api: DarwinApi): Generator<string> {
	const ffi = loadDarwinFfi();
	if (!ffi) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	const buffer = new Uint8Array(DARWIN_DIRECTORY_BUFFER_BYTES);
	const base = new BigInt64Array(1);
	const bufferPointer = ffi.ptr(buffer);
	const basePointer = ffi.ptr(base);
	const decoder = new TextDecoder();
	for (;;) {
		const bytes = api.symbols.getdirentries(fd, bufferPointer, buffer.byteLength, basePointer);
		if (bytes < 0) throw darwinError("getdirentries", api);
		if (bytes === 0) return;
		for (let offset = 0; offset < bytes; ) {
			if (offset + DARWIN_DIRENT_HEADER_BYTES > bytes) throw new Error("invalid macOS directory entry");
			const recordLength = ffi.read.u16(bufferPointer, offset + 4);
			const nameLength = ffi.read.u8(bufferPointer, offset + 7);
			if (
				recordLength < DARWIN_DIRENT_HEADER_BYTES ||
				offset + recordLength > bytes ||
				nameLength > recordLength - DARWIN_DIRENT_HEADER_BYTES
			)
				throw new Error("invalid macOS directory entry");
			if (nameLength > 0) {
				const name = decoder.decode(
					new Uint8Array(ffi.toArrayBuffer(bufferPointer, offset + DARWIN_DIRENT_HEADER_BYTES, nameLength)),
				);
				if (name !== "." && name !== "..") yield name;
			}
			offset += recordLength;
		}
	}
}

async function listDirectory(directory: FileHandle): Promise<string[]> {
	if (process.platform === "darwin") {
		const api = loadDarwinApi();
		if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
		return [...readDarwinDirectory(directory.fd, api)].sort();
	}
	const result: string[] = [];
	const entries = await opendir(descriptorPath(directory.fd));
	for await (const entry of entries) result.push(entry.name);
	return result.sort();
}

type EntryInspection = {
	readonly type: DescriptorEntry["type"];
	readonly handle?: FileHandle;
	readonly target?: string;
	readonly mode: number;
	readonly mtimeMs: number;
	readonly size: number;
	readonly dev: number;
	readonly ino: number;
	readonly nlink: number;
	readonly uid: number;
	readonly gid: number;
};

function sameEntry(left: EntryInspection, right: EntryInspection): boolean {
	return left.type === right.type && left.dev === right.dev && left.ino === right.ino;
}

async function inspectChild(parent: FileHandle, name: string): Promise<EntryInspection> {
	try {
		const directory = await openChild(parent, name, DIRECTORY_FLAGS);
		const stat = await directory.stat();
		return {
			type: "directory",
			handle: directory,
			mode: stat.mode & 0o7777,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			uid: stat.uid,
			gid: stat.gid,
		};
	} catch (directoryError) {
		const directoryCode = (directoryError as NodeJS.ErrnoException).code;
		if (
			directoryCode !== "ENOTDIR" &&
			directoryCode !== "EINVAL" &&
			directoryCode !== "ELOOP" &&
			!(directoryError instanceof UnsafeDescriptorPathError)
		)
			throw directoryError;
	}
	try {
		const file = await openChild(parent, name, FILE_FLAGS);
		const stat = await file.stat();
		if (!stat.isFile()) {
			await closeQuietly(file);
			throw new UnsafeDescriptorPathError("descriptor path contains a special file");
		}
		return {
			type: "file",
			handle: file,
			mode: stat.mode & 0o7777,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			uid: stat.uid,
			gid: stat.gid,
		};
	} catch (fileError) {
		const code = (fileError as NodeJS.ErrnoException).code;
		if (code !== "ELOOP" && !(fileError instanceof UnsafeDescriptorPathError)) throw fileError;
		if (fileError instanceof UnsafeDescriptorPathError && !String(fileError.message).includes("symlink"))
			throw fileError;
	}
	const target = await readlinkChild(parent, name);
	const stat = await lstat(descriptorPath(parent.fd, name));
	return {
		type: "symlink",
		target,
		mode: stat.mode & 0o7777,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		uid: stat.uid,
		gid: stat.gid,
	};
}

async function openDirectoryPath(root: FileHandle, pathParts: readonly string[], create: boolean): Promise<FileHandle> {
	let current = await open(descriptorPath(root.fd), fsConstants.O_RDONLY);
	try {
		for (const component of pathParts) {
			let next: FileHandle;
			let created = false;
			try {
				next = await openChild(current, component, DIRECTORY_FLAGS);
			} catch (error) {
				if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				try {
					await mkdirChild(current, component, 0o700);
					created = true;
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				next = await openChild(current, component, DIRECTORY_FLAGS);
			}
			try {
				if (created) await requirePreservedMode(next, 0o700);
			} catch (error) {
				await next.close();
				throw error;
			}
			await closeQuietly(current);
			current = next;
		}
		return current;
	} catch (error) {
		await closeQuietly(current);
		throw normalizeError(error);
	}
}

async function removeTree(
	parent: FileHandle,
	name: string,
	recursive: boolean,
	beforeMutation?: () => Promise<void>,
): Promise<void> {
	const entry = await inspectChild(parent, name);
	if (entry.type === "directory" && recursive) {
		const directory = entry.handle;
		if (!directory) throw new Error("directory descriptor missing");
		try {
			for (const child of await listDirectory(directory)) await removeTree(directory, child, true);
		} finally {
			await directory.close();
		}
	} else {
		await entry.handle?.close();
	}
	await beforeMutation?.();
	const current = await inspectChild(parent, name);
	await current.handle?.close();
	if (!sameEntry(entry, current)) throw new UnsafeDescriptorPathError("descriptor removal target changed");
	await unlinkChild(parent, name, entry.type === "directory");
}

export class DescriptorRoot {
	private readonly root: FileHandle;
	private closed = false;

	constructor(root: FileHandle) {
		this.root = root;
	}

	private requireOpen(): void {
		if (this.closed) throw new Error("descriptor root is closed");
	}

	async openDirectory(path: string, create = false): Promise<DescriptorRoot> {
		this.requireOpen();
		return new DescriptorRoot(await openDirectoryPath(this.root, parts(path), create));
	}

	async identity(): Promise<string> {
		this.requireOpen();
		const stat = await this.root.stat();
		return `${stat.dev}:${stat.ino}:${stat.mode}`;
	}

	async inventory(): Promise<DescriptorEntry[]> {
		this.requireOpen();
		const result: DescriptorEntry[] = [];
		const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
			for (const name of await listDirectory(directory)) {
				const entry = await inspectChild(directory, name);
				const path = prefix ? `${prefix}/${name}` : name;
				result.push({
					path,
					type: entry.type,
					mode: entry.mode,
					mtimeMs: entry.mtimeMs,
					size: entry.size,
					dev: entry.dev,
					ino: entry.ino,
					nlink: entry.nlink,
					uid: entry.uid,
					gid: entry.gid,
					...(entry.target === undefined ? {} : { target: entry.target }),
				});
				if (entry.type === "directory" && entry.handle) {
					try {
						await walk(entry.handle, path);
					} finally {
						await entry.handle.close();
					}
				} else await entry.handle?.close();
			}
		};
		await walk(this.root, "");
		return result;
	}

	async readFile(path: string): Promise<Uint8Array> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			const file = await openChild(parent, name, FILE_FLAGS);
			try {
				const stat = await file.stat();
				if (!stat.isFile()) throw new UnsafeDescriptorPathError("descriptor path is not a regular file");
				return new Uint8Array(await file.readFile());
			} finally {
				await file.close();
			}
		} finally {
			await parent.close();
		}
	}

	async hashFile(path: string): Promise<string> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			const file = await openChild(parent, name, FILE_FLAGS);
			try {
				const stat = await file.stat();
				if (!stat.isFile()) throw new UnsafeDescriptorPathError("descriptor path is not a regular file");
				const hash = createHash("sha256");
				const buffer = Buffer.allocUnsafe(1024 * 1024);
				let position = 0;
				for (;;) {
					const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
					if (bytesRead === 0) break;
					hash.update(buffer.subarray(0, bytesRead));
					position += bytesRead;
				}
				return hash.digest("hex");
			} finally {
				await file.close();
			}
		} finally {
			await parent.close();
		}
	}

	async readSymlink(path: string): Promise<string> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			return await readlinkChild(parent, name);
		} finally {
			await parent.close();
		}
	}

	async createDirectoryExclusive(path: string, mode = 0o700): Promise<void> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			await mkdirChild(parent, name, mode);
			const directory = await openChild(parent, name, DIRECTORY_FLAGS);
			try {
				await requirePreservedMode(directory, mode);
				await directory.sync();
			} finally {
				await directory.close();
			}
			await parent.sync();
		} finally {
			await parent.close();
		}
	}

	async createDirectory(path: string, mode = 0o700, mtimeMs?: number): Promise<void> {
		this.requireOpen();
		const directory = await openDirectoryPath(this.root, parts(path), true);
		try {
			await directory.chmod(mode);
			await requirePreservedMode(directory, mode);
			if (mtimeMs !== undefined) await directory.utimes(mtimeMs / 1000, mtimeMs / 1000);
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	async writeFileAtomic(path: string, bytes: Uint8Array, options: DescriptorWriteOptions = {}): Promise<void> {
		return this.writeFilePublished(path, bytes, options, false);
	}

	async replaceFileAtomic(path: string, bytes: Uint8Array, options: DescriptorWriteOptions = {}): Promise<void> {
		return this.writeFilePublished(path, bytes, options, true);
	}

	private async writeFilePublished(
		path: string,
		bytes: Uint8Array,
		options: DescriptorWriteOptions,
		replace: boolean,
	): Promise<void> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, true);
		const temporary = `.${name}.${process.pid}.${randomUUID()}.tmp`;
		let published = false;
		try {
			await options.beforeMutation?.();
			const file = await openChild(
				parent,
				temporary,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
				options.mode ?? 0o600,
			);
			try {
				await file.writeFile(bytes);
				await file.chmod(options.mode ?? 0o600);
				await requirePreservedMode(file, options.mode ?? 0o600);
				if (options.mtimeMs !== undefined) await file.utimes(options.mtimeMs / 1000, options.mtimeMs / 1000);
				await file.sync();
			} finally {
				await file.close();
			}
			if (replace) await renameChild(parent, temporary, name);
			else {
				await linkChild(parent, temporary, name);
				await unlinkChild(parent, temporary);
			}
			published = true;
			await parent.sync();
		} catch (error) {
			if (!published) await unlinkChild(parent, temporary).catch(() => {});
			throw normalizeError(error);
		} finally {
			await parent.close();
		}
	}

	async createSymlink(path: string, target: string): Promise<void> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, true);
		try {
			await symlinkChild(parent, target, name);
			await parent.sync();
		} finally {
			await parent.close();
		}
	}

	async remove(
		path: string,
		options: { readonly recursive?: boolean; readonly beforeMutation?: () => Promise<void> } = {},
	): Promise<void> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			await removeTree(parent, name, options.recursive ?? false, options.beforeMutation);
			await parent.sync();
		} finally {
			await parent.close();
		}
	}

	async copyFileFrom(
		source: DescriptorRoot,
		sourcePath: string,
		options: DescriptorCopyOptions = {},
		destinationPath = sourcePath,
	): Promise<void> {
		this.requireOpen();
		source.requireOpen();
		const sourceParts = parts(sourcePath);
		const sourceName = sourceParts.pop();
		if (!sourceName) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const destinationParts = parts(destinationPath);
		const destinationName = destinationParts.pop();
		if (!destinationName) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const requestedTemporary = options.temporaryName === undefined ? undefined : parts(options.temporaryName);
		if (
			requestedTemporary &&
			(requestedTemporary.length !== 1 ||
				requestedTemporary[0] !== options.temporaryName ||
				requestedTemporary[0] === destinationName)
		)
			throw new UnsafeDescriptorPathError("descriptor temporary name must be a distinct path component");
		const temporary = requestedTemporary?.[0] ?? `.${destinationName}.${process.pid}.${randomUUID()}.tmp`;
		const sourceParent = await openDirectoryPath(source.root, sourceParts, false);
		const destinationParent = await openDirectoryPath(this.root, destinationParts, true);
		let temporaryCreated = false;
		let published = false;
		try {
			const sourceFile = await openChild(sourceParent, sourceName, FILE_FLAGS);
			try {
				const stat = await sourceFile.stat();
				if (!stat.isFile()) throw new UnsafeDescriptorPathError("descriptor path is not a regular file");
				await options.beforeMutation?.();
				const destinationFile = await openChild(
					destinationParent,
					temporary,
					fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
					options.mode ?? stat.mode & 0o7777,
				);
				temporaryCreated = true;
				try {
					const buffer = Buffer.allocUnsafe(1024 * 1024);
					let position = 0;
					for (;;) {
						const { bytesRead } = await sourceFile.read(buffer, 0, buffer.byteLength, position);
						if (bytesRead === 0) break;
						let written = 0;
						while (written < bytesRead) {
							const result = await destinationFile.write(buffer, written, bytesRead - written, position + written);
							if (result.bytesWritten === 0) throw new Error("descriptor write made no progress");
							written += result.bytesWritten;
						}
						position += bytesRead;
					}
					await destinationFile.chmod(options.mode ?? stat.mode & 0o7777);
					await requirePreservedMode(destinationFile, options.mode ?? stat.mode & 0o7777);
					const mtimeMs = options.mtimeMs ?? stat.mtimeMs;
					await destinationFile.utimes(mtimeMs / 1000, mtimeMs / 1000);
					await destinationFile.sync();
				} finally {
					await destinationFile.close();
				}
				await options.beforePublish?.();
				await linkChild(destinationParent, temporary, destinationName);
				published = true;
				await options.afterPublish?.();
				await unlinkChild(destinationParent, temporary);
				await destinationParent.sync();
			} finally {
				await sourceFile.close();
			}
		} catch (error) {
			if (!published && temporaryCreated) await unlinkChild(destinationParent, temporary).catch(() => {});
			throw normalizeError(error);
		} finally {
			await destinationParent.close();
			await sourceParent.close();
		}
	}

	async copyTreeFrom(source: DescriptorRoot): Promise<void> {
		this.requireOpen();
		const inventory = await source.inventory();
		for (const entry of inventory.filter((item) => item.type === "directory"))
			await this.createDirectory(entry.path, entry.mode);
		for (const entry of inventory.filter((item) => item.type === "file"))
			await this.copyFileFrom(source, entry.path, { mode: entry.mode, mtimeMs: entry.mtimeMs });
		for (const entry of inventory.filter((item) => item.type === "symlink"))
			await this.createSymlink(entry.path, entry.target ?? "");
		for (const entry of [...inventory].reverse().filter((item) => item.type === "directory")) {
			const pathParts = parts(entry.path);
			const name = pathParts.pop();
			if (!name) continue;
			const parent = await openDirectoryPath(this.root, pathParts, false);
			try {
				const directory = await openChild(parent, name, DIRECTORY_FLAGS);
				try {
					await directory.chmod(entry.mode);
					await directory.utimes(entry.mtimeMs / 1000, entry.mtimeMs / 1000);
					await directory.sync();
				} finally {
					await directory.close();
				}
			} finally {
				await parent.close();
			}
		}
		await this.root.sync();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.root.close();
	}
}

export async function openDescriptorRoot(path: string): Promise<DescriptorRoot> {
	if (!DESCRIPTOR_ROOT) throw new UnsupportedDescriptorFilesystemError();
	if (process.platform === "darwin" && !loadDarwinApi())
		throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	try {
		return new DescriptorRoot(await open(resolve(path), DIRECTORY_FLAGS));
	} catch (error) {
		throw normalizeError(error);
	}
}
