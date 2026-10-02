import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, fstatSync } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readlink, rename, rmdir, stat, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { parse, resolve, sep } from "node:path";

type DarwinPointer = unknown;
type WindowsHandle = bigint;

type WindowsFfi = {
	readonly dlopen: (path: string, symbols: Record<string, unknown>) => Pick<WindowsApi, "symbols">;
	readonly ptr: (value: ArrayBufferView) => number;
};

type WindowsApi = {
	readonly symbols: {
		readonly CloseHandle: (handle: WindowsHandle) => number;
		readonly CreateFileW: (
			path: number,
			desiredAccess: number,
			shareMode: number,
			securityAttributes: number,
			creationDisposition: number,
			flagsAndAttributes: number,
			templateFile: WindowsHandle,
		) => WindowsHandle;
		readonly FlushFileBuffers: (handle: WindowsHandle) => number;
		readonly GetFileInformationByHandleEx: (
			handle: WindowsHandle,
			fileInformationClass: number,
			fileInformation: number,
			bufferSize: number,
		) => number;
		readonly GetFinalPathNameByHandleW: (
			handle: WindowsHandle,
			filePath: number,
			filePathSize: number,
			flags: number,
		) => number;
		readonly GetLastError: () => number;
		readonly SetFileTime: (
			handle: WindowsHandle,
			creationTime: number,
			lastAccessTime: number,
			lastWriteTime: number,
		) => number;
	};
	readonly ptr: (value: ArrayBufferView) => number;
};

type WindowsHandleInfo = {
	readonly handle: WindowsHandle;
	readonly directory: boolean;
	readonly nativeAncestors?: WindowsHandle[];
	readonly ownedDirectories?: FileHandle[];
};

type WindowsIdentity = {
	readonly dev: number;
	readonly ino: number;
	readonly fileIdLow: bigint;
	readonly nativeIdentity: string;
	readonly attributes: number;
	readonly reparseTag: number;
};

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
let windowsApi: WindowsApi | null | undefined;
const windowsHandles = new WeakMap<FileHandle, WindowsHandleInfo>();

const WINDOWS_INVALID_HANDLE = 0xffffffffffffffffn;
const WINDOWS_FILE_SHARE_READ = 0x00000001;
const WINDOWS_FILE_SHARE_WRITE = 0x00000002;
const WINDOWS_OPEN_EXISTING = 3;
const WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const WINDOWS_FILE_ATTRIBUTE_TAG_INFO = 9;
const WINDOWS_FILE_ID_INFO = 18;

function loadWindowsApi(): WindowsApi | null {
	if (process.platform !== "win32") return null;
	if (windowsApi !== undefined) return windowsApi;
	try {
		const ffiModule = "bun:ffi";
		const ffi = require(ffiModule) as WindowsFfi;
		const library = ffi.dlopen("kernel32.dll", {
			CloseHandle: { args: ["u64"], returns: "i32" },
			CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
			FlushFileBuffers: { args: ["u64"], returns: "i32" },
			GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
			GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
			GetLastError: { args: [], returns: "u32" },
			SetFileTime: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
		});
		windowsApi = { symbols: library.symbols, ptr: ffi.ptr } as WindowsApi;
		return windowsApi;
	} catch {
		windowsApi = null;
		return null;
	}
}

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
const DARWIN_O_SYMLINK = 0x00200000;

export class UnsupportedDescriptorFilesystemError extends Error {
	readonly code = "unsupported_descriptor_filesystem";

	constructor(message = "descriptor-rooted filesystem is unavailable on this platform or filesystem") {
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
	readonly nativeIdentity?: string;
	readonly nlink: number;
	readonly uid: number;
	readonly gid: number;
	readonly target?: string;
	readonly targetIsDirectory?: boolean;
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

function windowsError(operation: string, api = loadWindowsApi()): NodeJS.ErrnoException {
	if (!api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
	const errno = api.symbols.GetLastError();
	const code =
		errno === 2 || errno === 3
			? "ENOENT"
			: errno === 5
				? "EACCES"
				: errno === 6
					? "EBADF"
					: errno === 17
						? "EXDEV"
						: errno === 32
							? "EBUSY"
							: errno === 80 || errno === 183
								? "EEXIST"
								: errno === 145
									? "ENOTEMPTY"
									: errno === 267
										? "ENOTDIR"
										: errno === 4390
											? "EINVAL"
											: errno === 1920
												? "ELOOP"
												: "EIO";
	return Object.assign(new Error(`${operation} failed: ${code} (Windows error ${errno})`), { code, errno });
}

function windowsUtf16(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf16le");
}

function windowsInfo(handle: WindowsHandle): WindowsIdentity {
	const api = loadWindowsApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
	const identity = new Uint8Array(24);
	if (!api.symbols.GetFileInformationByHandleEx(handle, WINDOWS_FILE_ID_INFO, api.ptr(identity), identity.byteLength))
		throw windowsError("GetFileInformationByHandleEx(FileIdInfo)", api);
	const view = new DataView(identity.buffer, identity.byteOffset, identity.byteLength);
	const volume = view.getBigUint64(0, true);
	const fileIdLow = view.getBigUint64(8, true);
	const fileIdHigh = view.getBigUint64(16, true);
	const attributes = new Uint8Array(8);
	if (
		!api.symbols.GetFileInformationByHandleEx(
			handle,
			WINDOWS_FILE_ATTRIBUTE_TAG_INFO,
			api.ptr(attributes),
			attributes.byteLength,
		)
	)
		throw windowsError("GetFileInformationByHandleEx(FileAttributeTagInfo)", api);
	const attributeView = new DataView(attributes.buffer, attributes.byteOffset, attributes.byteLength);
	return {
		dev: Number(volume & 0xffffffffn),
		ino: Number(fileIdLow),
		fileIdLow,
		nativeIdentity: `windows:${volume.toString(16)}:${fileIdHigh.toString(16).padStart(16, "0")}${fileIdLow.toString(16).padStart(16, "0")}`,
		attributes: attributeView.getUint32(0, true),
		reparseTag: attributeView.getUint32(4, true),
	};
}

function openWindowsRaw(path: string, _directory: boolean, desiredAccess = 0x00000080): WindowsHandle {
	const api = loadWindowsApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
	const handle = api.symbols.CreateFileW(
		api.ptr(windowsUtf16(path)),
		desiredAccess,
		WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE,
		0,
		WINDOWS_OPEN_EXISTING,
		WINDOWS_FILE_FLAG_BACKUP_SEMANTICS | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
		0n,
	);
	if (handle === WINDOWS_INVALID_HANDLE) throw windowsError("CreateFileW");
	return handle;
}

function closeWindowsRaw(handle: WindowsHandle): void {
	const api = loadWindowsApi();
	if (api) api.symbols.CloseHandle(handle);
}

function sameWindowsIdentity(handle: WindowsHandle, stats: BigIntStats): boolean {
	const identity = windowsInfo(handle);
	return BigInt(identity.dev) === (stats.dev & 0xffffffffn) && identity.fileIdLow === stats.ino;
}

function windowsIdentityOf(handle: FileHandle): string | undefined {
	const native = windowsHandles.get(handle);
	return native ? windowsInfo(native.handle).nativeIdentity : undefined;
}

async function openWindowsNodeHandle(
	path: string,
	flags: number,
	mode: number | undefined,
	raw: WindowsHandle,
	nativeAncestors: WindowsHandle[] = [],
): Promise<FileHandle> {
	const handle = await open(path, flags, mode);
	try {
		if (!sameWindowsIdentity(raw, await handle.stat({ bigint: true })))
			throw new UnsafeDescriptorPathError("descriptor path changed while opening");
		windowsHandles.set(handle, {
			handle: raw,
			directory: Boolean(windowsInfo(raw).attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY),
			nativeAncestors,
		});
		return handle;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

function windowsPath(handle: FileHandle): string {
	const native = windowsHandles.get(handle);
	const api = loadWindowsApi();
	if (!native || !api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor handle is unavailable");
	const buffer = new Uint16Array(32768);
	const length = api.symbols.GetFinalPathNameByHandleW(native.handle, api.ptr(buffer), buffer.length, 0);
	if (!length) throw windowsError("GetFinalPathNameByHandleW", api);
	if (length >= buffer.length) throw new Error("Windows descriptor path exceeds the supported length");
	return Buffer.from(buffer.buffer, buffer.byteOffset, length * 2).toString("utf16le");
}

function windowsChildPath(parent: FileHandle, name: string): string {
	const path = windowsPath(parent);
	return path.endsWith("\\") ? `${path}${name}` : `${path}\\${name}`;
}

function verifyWindowsChild(parent: FileHandle, name: string, handle: WindowsHandle): void {
	const parentInfo = windowsHandles.get(parent);
	if (!parentInfo) throw new UnsupportedDescriptorFilesystemError("Windows descriptor handle is unavailable");
	const parentPath = windowsPath(parent).replace(/[\\/]+$/g, "");
	const expected = `${parentPath}\\${name}`.toLocaleLowerCase("en-US");
	const actual = windowsPathForRaw(handle)
		.replace(/[\\/]+$/g, "")
		.toLocaleLowerCase("en-US");
	if (actual !== expected) throw new UnsafeDescriptorPathError("descriptor path changed while opening");
}

async function duplicateWindowsDirectory(handle: FileHandle): Promise<FileHandle> {
	const path = windowsPath(handle);
	const raw = openWindowsRaw(path, true);
	const pinned: WindowsHandle[] = [];
	try {
		const original = windowsHandles.get(handle);
		if (!original || !sameWindowsIdentity(raw, await handle.stat({ bigint: true })))
			throw new UnsafeDescriptorPathError("descriptor root changed while opening");
		for (const ancestor of original.nativeAncestors ?? []) {
			const clone = openWindowsRaw(windowsPathForRaw(ancestor), false);
			pinned.push(clone);
			const clonedInfo = windowsInfo(clone);
			const originalInfo = windowsInfo(ancestor);
			if (clonedInfo.nativeIdentity !== originalInfo.nativeIdentity) {
				throw new UnsafeDescriptorPathError("descriptor root ancestor changed while opening");
			}
		}
		for (const ancestor of original.ownedDirectories ?? []) {
			const clone = openWindowsRaw(windowsPath(ancestor), true);
			pinned.push(clone);
			if (!sameWindowsIdentity(clone, await ancestor.stat({ bigint: true }))) {
				throw new UnsafeDescriptorPathError("descriptor root ancestor changed while opening");
			}
		}
		return await openWindowsNodeHandle(path, fsConstants.O_RDONLY, undefined, raw, pinned);
	} catch (error) {
		closeWindowsRaw(raw);
		for (const ancestor of pinned.reverse()) closeWindowsRaw(ancestor);
		throw error;
	}
}

async function openWindowsRoot(path: string): Promise<FileHandle> {
	const raw = openWindowsRaw(path, true);
	const ancestors: WindowsHandle[] = [];
	try {
		const info = windowsInfo(raw);
		if (info.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT)
			throw new UnsafeDescriptorPathError("descriptor root cannot be a symlink or reparse point");
		if (!(info.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY))
			throw Object.assign(new Error("descriptor root is not a directory"), { code: "ENOTDIR" });
		const canonicalPath = windowsPathForRaw(raw);
		const rootPrefix = windowsVolumeRoot(canonicalPath);
		let parentPath = rootPrefix;
		const components = canonicalPath.slice(rootPrefix.length).split("\\").filter(Boolean);
		for (const component of components.slice(0, -1)) {
			parentPath = parentPath.endsWith("\\") ? `${parentPath}${component}` : `${parentPath}\\${component}`;
			const ancestor = openWindowsRaw(parentPath, false);
			ancestors.push(ancestor);
			const ancestorInfo = windowsInfo(ancestor);
			if (
				!(ancestorInfo.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) ||
				ancestorInfo.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT
			) {
				throw new UnsafeDescriptorPathError("descriptor root traverses a reparse point");
			}
		}
		const root = await openWindowsNodeHandle(canonicalPath, fsConstants.O_RDONLY, undefined, raw, ancestors);
		return root;
	} catch (error) {
		closeWindowsRaw(raw);
		for (const ancestor of ancestors.reverse()) closeWindowsRaw(ancestor);
		throw error;
	}
}

function windowsVolumeRoot(path: string): string {
	const root = parse(path).root;
	if (!root.startsWith("\\\\?\\UNC\\")) {
		if (!root.startsWith("\\\\?\\") || !root.endsWith("\\"))
			throw new UnsupportedDescriptorFilesystemError("Windows descriptor path has an unsupported volume name");
		return root;
	}
	const components = path.slice(root.length).split("\\").filter(Boolean);
	if (components.length < 2) throw new UnsupportedDescriptorFilesystemError("Windows UNC descriptor path has no share");
	return `${root}${components[0]}\\${components[1]}\\`;
}

function windowsPathForRaw(handle: WindowsHandle): string {
	const api = loadWindowsApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
	const buffer = new Uint16Array(32768);
	const length = api.symbols.GetFinalPathNameByHandleW(handle, api.ptr(buffer), buffer.length, 0);
	if (!length) throw windowsError("GetFinalPathNameByHandleW", api);
	if (length >= buffer.length) throw new Error("Windows descriptor path exceeds the supported length");
	return Buffer.from(buffer.buffer, buffer.byteOffset, length * 2).toString("utf16le");
}

async function closeDescriptorHandle(handle: FileHandle | undefined): Promise<void> {
	if (!handle) return;
	const native = windowsHandles.get(handle);
	windowsHandles.delete(handle);
	try {
		await handle.close();
	} finally {
		if (native) {
			closeWindowsRaw(native.handle);
			for (const ancestor of [...(native.ownedDirectories ?? [])].reverse()) await closeDescriptorHandle(ancestor);
			for (const ancestor of [...(native.nativeAncestors ?? [])].reverse()) closeWindowsRaw(ancestor);
		}
	}
}

async function syncDescriptorHandle(handle: FileHandle): Promise<void> {
	const native = windowsHandles.get(handle);
	if (native?.directory) {
		const api = loadWindowsApi();
		if (!api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
		const writable = openWindowsRaw(windowsPath(handle), true, 0x40000000);
		try {
			if (windowsInfo(writable).nativeIdentity !== windowsInfo(native.handle).nativeIdentity)
				throw new UnsafeDescriptorPathError("descriptor directory changed before syncing");
			if (!api.symbols.FlushFileBuffers(writable)) throw windowsError("FlushFileBuffers", api);
		} finally {
			closeWindowsRaw(writable);
		}
		return;
	}
	await handle.sync();
}

async function chmodDescriptorHandle(handle: FileHandle, mode: number): Promise<void> {
	if (windowsHandles.get(handle)?.directory) return;
	await handle.chmod(mode);
}

async function utimesDescriptorHandle(handle: FileHandle, atime: number, mtime: number): Promise<void> {
	const native = windowsHandles.get(handle);
	if (native?.directory) {
		const api = loadWindowsApi();
		if (!api) throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
		const writable = openWindowsRaw(windowsPath(handle), true, 0x00000100);
		try {
			if (windowsInfo(writable).nativeIdentity !== windowsInfo(native.handle).nativeIdentity)
				throw new UnsafeDescriptorPathError("descriptor directory changed before updating its timestamp");
			const filetime = new Uint8Array(8);
			const time = (value: number) => BigInt(Math.round(value * 10_000_000)) + 116444736000000000n;
			const writeTime = time(mtime);
			new DataView(filetime.buffer).setBigUint64(0, writeTime, true);
			if (!api.symbols.SetFileTime(writable, 0, 0, api.ptr(filetime))) throw windowsError("SetFileTime", api);
		} finally {
			closeWindowsRaw(writable);
		}
		return;
	}
	await handle.utimes(atime, mtime);
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
	const normalized = process.platform === "win32" ? path.replace(/[\\/]/g, sep) : path.replaceAll("\\", sep);
	if (normalized.startsWith(sep)) throw new UnsafeDescriptorPathError("descriptor path escapes root");
	const raw = normalized.split(sep).filter(Boolean);
	if (raw.some((part) => part === "." || part === ".."))
		throw new UnsafeDescriptorPathError("descriptor path escapes root");
	if (
		process.platform === "win32" &&
		raw.some(
			(part) =>
				part.includes(":") || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
		)
	)
		throw new UnsafeDescriptorPathError("descriptor path escapes root");
	if (!raw.length) throw new UnsafeDescriptorPathError("descriptor path is empty or invalid");
	return raw;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
	try {
		await closeDescriptorHandle(handle);
	} catch {}
}

async function requirePreservedMode(handle: FileHandle, mode: number): Promise<void> {
	if (process.platform === "win32") return;
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

async function openChild(
	parent: FileHandle,
	name: string,
	flags: number,
	mode = 0,
	directory = false,
): Promise<FileHandle> {
	if (process.platform === "win32") {
		const path = windowsChildPath(parent, name);
		if (flags & fsConstants.O_CREAT) {
			const file = await open(path, flags, mode);
			try {
				const raw = openWindowsRaw(path, directory);
				try {
					verifyWindowsChild(parent, name, raw);
					const info = windowsInfo(raw);
					if (info.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT)
						throw new UnsafeDescriptorPathError("descriptor path contains a symlink or non-directory component");
					if (directory !== Boolean(info.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY))
						throw Object.assign(
							new Error(directory ? "descriptor path is not a directory" : "descriptor path is a directory"),
							{
								code: directory ? "ENOTDIR" : "EISDIR",
							},
						);
					if (!sameWindowsIdentity(raw, await file.stat({ bigint: true })))
						throw new UnsafeDescriptorPathError("descriptor path changed while opening");
					const parentInfo = windowsHandles.get(parent);
					if (!parentInfo) throw new UnsupportedDescriptorFilesystemError("Windows descriptor handle is unavailable");
					windowsHandles.set(file, { handle: raw, directory });
					return file;
				} catch (error) {
					closeWindowsRaw(raw);
					throw error;
				}
			} catch (error) {
				await file.close().catch(() => {});
				throw error;
			}
		}
		const raw = openWindowsRaw(path, directory);
		try {
			verifyWindowsChild(parent, name, raw);
			const info = windowsInfo(raw);
			if (info.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT)
				throw new UnsafeDescriptorPathError("descriptor path contains a symlink or non-directory component");
			if (directory !== Boolean(info.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY))
				throw Object.assign(
					new Error(directory ? "descriptor path is not a directory" : "descriptor path is a directory"),
					{
						code: directory ? "ENOTDIR" : "EISDIR",
					},
				);
			const parentInfo = windowsHandles.get(parent);
			if (!parentInfo) throw new UnsupportedDescriptorFilesystemError("Windows descriptor handle is unavailable");
			return await openWindowsNodeHandle(path, flags, mode, raw);
		} catch (error) {
			closeWindowsRaw(raw);
			throw error;
		}
	}
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
	if (process.platform === "win32") return mkdir(windowsChildPath(parent, name), { mode });
	if (process.platform === "linux") return mkdir(descriptorPath(parent.fd, name), { mode });
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.mkdirat(parent.fd, cstring(name), mode) < 0) throw darwinError("mkdirat", api);
}

async function linkChild(parent: FileHandle, source: string, target: string): Promise<void> {
	if (process.platform === "win32") return link(windowsChildPath(parent, source), windowsChildPath(parent, target));
	if (process.platform === "linux") return link(descriptorPath(parent.fd, source), descriptorPath(parent.fd, target));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.linkat(parent.fd, cstring(source), parent.fd, cstring(target), 0) < 0)
		throw darwinError("linkat", api);
}

async function renameChild(parent: FileHandle, source: string, target: string): Promise<void> {
	if (process.platform === "win32") return rename(windowsChildPath(parent, source), windowsChildPath(parent, target));
	if (process.platform === "linux") return rename(descriptorPath(parent.fd, source), descriptorPath(parent.fd, target));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.renameat(parent.fd, cstring(source), parent.fd, cstring(target)) < 0)
		throw darwinError("renameat", api);
}

async function unlinkChild(parent: FileHandle, name: string, directory = false): Promise<void> {
	if (process.platform === "win32") {
		const path = windowsChildPath(parent, name);
		if (directory) await rmdir(path);
		else await unlink(path);
		return;
	}
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

async function symlinkChild(
	parent: FileHandle,
	target: string,
	name: string,
	targetIsDirectory?: boolean,
): Promise<void> {
	if (process.platform === "win32") {
		const parentPath = windowsPath(parent);
		let isDirectory = targetIsDirectory ?? false;
		if (targetIsDirectory === undefined) {
			try {
				isDirectory = (await stat(resolve(parentPath, target))).isDirectory();
			} catch {}
		}
		return symlink(target, windowsChildPath(parent, name), isDirectory ? "dir" : "file");
	}
	if (process.platform === "linux") return symlink(target, descriptorPath(parent.fd, name));
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	if (api.symbols.symlinkat(cstring(target), parent.fd, cstring(name)) < 0) throw darwinError("symlinkat", api);
}

async function readlinkChild(parent: FileHandle, name: string): Promise<string> {
	if (process.platform === "win32") {
		const path = windowsChildPath(parent, name);
		const raw = openWindowsRaw(path, false);
		try {
			verifyWindowsChild(parent, name, raw);
			const info = windowsInfo(raw);
			if (!(info.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) || info.reparseTag !== 0xa000000c)
				throw new UnsafeDescriptorPathError("descriptor entry is not a symbolic link");
			return await readlink(path);
		} finally {
			closeWindowsRaw(raw);
		}
	}
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

async function statSymlinkChild(parent: FileHandle, name: string): Promise<{ stats: Stats; nativeIdentity?: string }> {
	if (process.platform === "win32") {
		const path = windowsChildPath(parent, name);
		const raw = openWindowsRaw(path, false);
		try {
			verifyWindowsChild(parent, name, raw);
			const info = windowsInfo(raw);
			if (!(info.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) || info.reparseTag !== 0xa000000c)
				throw new UnsafeDescriptorPathError("descriptor entry is not a symbolic link");
			const stats = await lstat(path, { bigint: true });
			if (!sameWindowsIdentity(raw, stats))
				throw new UnsafeDescriptorPathError("descriptor path changed while inspecting");
			return { stats: await lstat(path), nativeIdentity: info.nativeIdentity };
		} finally {
			closeWindowsRaw(raw);
		}
	}
	const api = loadDarwinApi();
	if (!api) throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	const fd = api.symbols.openat(parent.fd, cstring(name), DARWIN_O_SYMLINK, 0);
	if (fd < 0) throw darwinError("openat", api);
	try {
		return { stats: fstatSync(fd, { bigint: false }) };
	} finally {
		api.symbols.close(fd);
	}
}

function windowsSymlinkIsDirectory(parent: FileHandle, name: string): boolean {
	const raw = openWindowsRaw(windowsChildPath(parent, name), false);
	try {
		verifyWindowsChild(parent, name, raw);
		const info = windowsInfo(raw);
		if (!(info.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) || info.reparseTag !== 0xa000000c)
			throw new UnsafeDescriptorPathError("descriptor entry is not a symbolic link");
		return Boolean(info.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY);
	} finally {
		closeWindowsRaw(raw);
	}
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
	if (process.platform === "win32") {
		const result: string[] = [];
		const entries = await opendir(windowsPath(directory));
		for await (const entry of entries) result.push(entry.name);
		return result.sort();
	}
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
	readonly targetIsDirectory?: boolean;
	readonly nativeIdentity?: string;
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
	return (
		left.type === right.type &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nativeIdentity === right.nativeIdentity
	);
}

async function inspectChild(parent: FileHandle, name: string): Promise<EntryInspection> {
	try {
		const directory = await openChild(parent, name, DIRECTORY_FLAGS, 0, true);
		const stat = await directory.stat();
		return {
			type: "directory",
			handle: directory,
			nativeIdentity: windowsIdentityOf(directory),
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
			nativeIdentity: windowsIdentityOf(file),
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
	const symlinkStat =
		process.platform === "darwin" || process.platform === "win32"
			? await statSymlinkChild(parent, name)
			: { stats: await lstat(descriptorPath(parent.fd, name)) };
	const stat = symlinkStat.stats;
	return {
		type: "symlink",
		target,
		...(symlinkStat.nativeIdentity === undefined ? {} : { nativeIdentity: symlinkStat.nativeIdentity }),
		...(process.platform === "win32" ? { targetIsDirectory: windowsSymlinkIsDirectory(parent, name) } : {}),
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
	let current =
		process.platform === "win32"
			? await duplicateWindowsDirectory(root)
			: await open(descriptorPath(root.fd), fsConstants.O_RDONLY);
	const ownedDirectories: FileHandle[] = [];
	try {
		for (const component of pathParts) {
			let next: FileHandle;
			let created = false;
			try {
				next = await openChild(current, component, DIRECTORY_FLAGS, 0, true);
			} catch (error) {
				if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				try {
					await mkdirChild(current, component, 0o700);
					created = true;
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				next = await openChild(current, component, DIRECTORY_FLAGS, 0, true);
			}
			try {
				if (created) await requirePreservedMode(next, 0o700);
			} catch (error) {
				await closeDescriptorHandle(next);
				throw error;
			}
			if (process.platform === "win32") ownedDirectories.push(current);
			else await closeQuietly(current);
			current = next;
		}
		if (process.platform === "win32" && ownedDirectories.length) {
			const native = windowsHandles.get(current);
			if (!native) throw new UnsupportedDescriptorFilesystemError("Windows descriptor handle is unavailable");
			windowsHandles.set(current, { ...native, ownedDirectories });
		}
		return current;
	} catch (error) {
		await closeQuietly(current);
		for (const ancestor of ownedDirectories.reverse()) await closeQuietly(ancestor);
		throw normalizeError(error);
	}
}

async function removeTree(
	parent: FileHandle,
	name: string,
	recursive: boolean,
	beforeMutation?: () => Promise<void>,
	expectedEntry?: Pick<DescriptorEntry, "type" | "dev" | "ino" | "nativeIdentity">,
): Promise<void> {
	const entry = await inspectChild(parent, name);
	if (
		expectedEntry &&
		(entry.type !== expectedEntry.type ||
			entry.dev !== expectedEntry.dev ||
			entry.ino !== expectedEntry.ino ||
			(expectedEntry.nativeIdentity !== undefined && entry.nativeIdentity !== expectedEntry.nativeIdentity))
	) {
		await closeDescriptorHandle(entry.handle);
		throw new UnsafeDescriptorPathError("descriptor removal target changed");
	}
	if (entry.type === "directory" && recursive) {
		const directory = entry.handle;
		if (!directory) throw new Error("directory descriptor missing");
		try {
			for (const child of await listDirectory(directory)) await removeTree(directory, child, true);
		} finally {
			await closeDescriptorHandle(directory);
		}
	} else {
		await closeDescriptorHandle(entry.handle);
	}
	await beforeMutation?.();
	const current = await inspectChild(parent, name);
	await closeDescriptorHandle(current.handle);
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
		return `${windowsIdentityOf(this.root) ?? `${stat.dev}:${stat.ino}`}:${stat.mode}`;
	}

	async listNames(): Promise<string[]> {
		this.requireOpen();
		return await listDirectory(this.root);
	}

	async inspectEntry(path: string): Promise<DescriptorEntry> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			const entry = await inspectChild(parent, name);
			try {
				return {
					path,
					type: entry.type,
					mode: entry.mode,
					mtimeMs: entry.mtimeMs,
					size: entry.size,
					dev: entry.dev,
					ino: entry.ino,
					...(entry.nativeIdentity === undefined ? {} : { nativeIdentity: entry.nativeIdentity }),
					nlink: entry.nlink,
					uid: entry.uid,
					gid: entry.gid,
					...(entry.target === undefined ? {} : { target: entry.target }),
					...(entry.targetIsDirectory === undefined ? {} : { targetIsDirectory: entry.targetIsDirectory }),
				};
			} finally {
				await closeDescriptorHandle(entry.handle);
			}
		} finally {
			await closeDescriptorHandle(parent);
		}
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
					...(entry.nativeIdentity === undefined ? {} : { nativeIdentity: entry.nativeIdentity }),
					nlink: entry.nlink,
					uid: entry.uid,
					gid: entry.gid,
					...(entry.target === undefined ? {} : { target: entry.target }),
					...(entry.targetIsDirectory === undefined ? {} : { targetIsDirectory: entry.targetIsDirectory }),
				});
				if (entry.type === "directory" && entry.handle) {
					try {
						await walk(entry.handle, path);
					} finally {
						await closeDescriptorHandle(entry.handle);
					}
				} else await closeDescriptorHandle(entry.handle);
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
				await closeDescriptorHandle(file);
			}
		} finally {
			await closeDescriptorHandle(parent);
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
				await closeDescriptorHandle(file);
			}
		} finally {
			await closeDescriptorHandle(parent);
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
			await closeDescriptorHandle(parent);
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
			const directory = await openChild(parent, name, DIRECTORY_FLAGS, 0, true);
			try {
				await requirePreservedMode(directory, mode);
				await syncDescriptorHandle(directory);
			} finally {
				await closeDescriptorHandle(directory);
			}
			await syncDescriptorHandle(parent);
		} finally {
			await closeDescriptorHandle(parent);
		}
	}

	async createDirectory(path: string, mode = 0o700, mtimeMs?: number): Promise<void> {
		this.requireOpen();
		const directory = await openDirectoryPath(this.root, parts(path), true);
		try {
			await chmodDescriptorHandle(directory, mode);
			await requirePreservedMode(directory, mode);
			if (mtimeMs !== undefined) await utimesDescriptorHandle(directory, mtimeMs / 1000, mtimeMs / 1000);
			await syncDescriptorHandle(directory);
		} finally {
			await closeDescriptorHandle(directory);
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
				await chmodDescriptorHandle(file, options.mode ?? 0o600);
				await requirePreservedMode(file, options.mode ?? 0o600);
				if (options.mtimeMs !== undefined)
					await utimesDescriptorHandle(file, options.mtimeMs / 1000, options.mtimeMs / 1000);
				await syncDescriptorHandle(file);
			} finally {
				await closeDescriptorHandle(file);
			}
			if (replace) await renameChild(parent, temporary, name);
			else {
				await linkChild(parent, temporary, name);
				await unlinkChild(parent, temporary);
			}
			published = true;
			await syncDescriptorHandle(parent);
		} catch (error) {
			if (!published) await unlinkChild(parent, temporary).catch(() => {});
			throw normalizeError(error);
		} finally {
			await closeDescriptorHandle(parent);
		}
	}

	async createSymlink(path: string, target: string, targetIsDirectory?: boolean): Promise<void> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, true);
		try {
			await symlinkChild(parent, target, name, targetIsDirectory);
			await syncDescriptorHandle(parent);
		} finally {
			await closeDescriptorHandle(parent);
		}
	}

	async remove(
		path: string,
		options: {
			readonly recursive?: boolean;
			readonly beforeMutation?: () => Promise<void>;
			readonly expectedEntry?: Pick<DescriptorEntry, "type" | "dev" | "ino" | "nativeIdentity">;
		} = {},
	): Promise<void> {
		this.requireOpen();
		const pathParts = parts(path);
		const name = pathParts.pop();
		if (!name) throw new UnsafeDescriptorPathError("descriptor path is empty");
		const parent = await openDirectoryPath(this.root, pathParts, false);
		try {
			await removeTree(parent, name, options.recursive ?? false, options.beforeMutation, options.expectedEntry);
			await syncDescriptorHandle(parent);
		} finally {
			await closeDescriptorHandle(parent);
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
					await chmodDescriptorHandle(destinationFile, options.mode ?? stat.mode & 0o7777);
					await requirePreservedMode(destinationFile, options.mode ?? stat.mode & 0o7777);
					const mtimeMs = options.mtimeMs ?? stat.mtimeMs;
					await utimesDescriptorHandle(destinationFile, mtimeMs / 1000, mtimeMs / 1000);
					await syncDescriptorHandle(destinationFile);
				} finally {
					await closeDescriptorHandle(destinationFile);
				}
				await options.beforePublish?.();
				await linkChild(destinationParent, temporary, destinationName);
				published = true;
				await options.afterPublish?.();
				await unlinkChild(destinationParent, temporary);
				await syncDescriptorHandle(destinationParent);
			} finally {
				await closeDescriptorHandle(sourceFile);
			}
		} catch (error) {
			if (!published && temporaryCreated) await unlinkChild(destinationParent, temporary).catch(() => {});
			throw normalizeError(error);
		} finally {
			await closeDescriptorHandle(destinationParent);
			await closeDescriptorHandle(sourceParent);
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
			await this.createSymlink(entry.path, entry.target ?? "", entry.targetIsDirectory);
		for (const entry of [...inventory].reverse().filter((item) => item.type === "directory")) {
			const pathParts = parts(entry.path);
			const name = pathParts.pop();
			if (!name) continue;
			const parent = await openDirectoryPath(this.root, pathParts, false);
			try {
				const directory = await openChild(parent, name, DIRECTORY_FLAGS, 0, true);
				try {
					await chmodDescriptorHandle(directory, entry.mode);
					await utimesDescriptorHandle(directory, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
					await syncDescriptorHandle(directory);
				} finally {
					await closeDescriptorHandle(directory);
				}
			} finally {
				await closeDescriptorHandle(parent);
			}
		}
		await syncDescriptorHandle(this.root);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await closeDescriptorHandle(this.root);
	}
}

export async function openDescriptorRoot(path: string): Promise<DescriptorRoot> {
	if (process.platform === "win32") {
		if (!loadWindowsApi())
			throw new UnsupportedDescriptorFilesystemError("Windows descriptor filesystem is unavailable");
		try {
			return new DescriptorRoot(await openWindowsRoot(resolve(path)));
		} catch (error) {
			throw normalizeError(error);
		}
	}
	if (!DESCRIPTOR_ROOT) throw new UnsupportedDescriptorFilesystemError();
	if (process.platform === "darwin" && !loadDarwinApi())
		throw new UnsupportedDescriptorFilesystemError("macOS descriptor filesystem is unavailable");
	try {
		return new DescriptorRoot(await open(resolve(path), DIRECTORY_FLAGS));
	} catch (error) {
		throw normalizeError(error);
	}
}
