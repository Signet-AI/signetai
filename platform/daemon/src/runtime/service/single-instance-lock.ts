import { createHash } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, ptr } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const KERNEL_LOCK_METADATA = "signet-kernel-lock-v1";
const LOCK_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

type NativePointer = ReturnType<typeof ptr>;

type PosixApi = {
	readonly symbols: {
		readonly flock: (fd: number, operation: number) => number;
	};
};

type WindowsApi = {
	readonly symbols: {
		readonly CreateMutexA: (attributes: number, initialOwner: boolean, name: NativePointer) => NativePointer;
		readonly WaitForSingleObject: (handle: NativePointer, milliseconds: number) => number;
		readonly ReleaseMutex: (handle: NativePointer) => number;
		readonly CloseHandle: (handle: NativePointer) => number;
	};
};

type NativeLock =
	| { readonly kind: "posix"; readonly api: PosixApi; readonly directoryFd: number }
	| { readonly kind: "windows"; readonly api: WindowsApi; readonly handles: readonly NativePointer[] };

type SingleInstanceLock = {
	readonly fd: number;
	readonly path: string;
	readonly native: NativeLock;
	released: boolean;
};

let posixApi: PosixApi | null | undefined;
let windowsApi: WindowsApi | null | undefined;

function errorCode(error: unknown): string | null {
	if (!(error instanceof Error) || !("code" in error)) return null;
	return typeof error.code === "string" ? error.code : null;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function loadPosixApi(): PosixApi | null {
	if (posixApi !== undefined) return posixApi;

	const libraries = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const library of libraries) {
		try {
			posixApi = dlopen(library, {
				flock: { args: ["i32", "i32"], returns: "i32" },
			}) as unknown as PosixApi;
			return posixApi;
		} catch {}
	}

	posixApi = null;
	return posixApi;
}

function loadWindowsApi(): WindowsApi | null {
	if (process.platform !== "win32") return null;
	if (windowsApi !== undefined) return windowsApi;

	try {
		windowsApi = dlopen("kernel32.dll", {
			CreateMutexA: { args: ["ptr", "bool", "ptr"], returns: "ptr" },
			WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
			ReleaseMutex: { args: ["ptr"], returns: "i32" },
			CloseHandle: { args: ["ptr"], returns: "i32" },
		}) as unknown as WindowsApi;
	} catch {
		windowsApi = null;
	}
	return windowsApi;
}

function mutexName(key: string): NativePointer {
	const name = `Global\\SignetDaemon-${createHash("sha256").update(key).digest("hex")}`;
	return ptr(Buffer.from(`${name}\0`));
}

function closeWindowsHandles(api: WindowsApi, handles: readonly NativePointer[], release: boolean): void {
	for (const handle of [...handles].reverse()) {
		if (release) {
			try {
				api.symbols.ReleaseMutex(handle);
			} catch {}
		}
		try {
			api.symbols.CloseHandle(handle);
		} catch {}
	}
}

function windowsMutexKeys(path: string, fd: number): readonly string[] {
	const directory = realpathSync(dirname(path)).toLowerCase();
	const identity = fstatSync(fd, { bigint: true });
	return [`directory:${directory}`, `file:${identity.dev}:${identity.ino}`];
}

function acquireWindowsLock(path: string, fd: number): NativeLock | null {
	const api = loadWindowsApi();
	if (api === null) return null;

	const handles: NativePointer[] = [];
	try {
		for (const key of windowsMutexKeys(path, fd)) {
			const handle = api.symbols.CreateMutexA(0, false, mutexName(key));
			if (handle === 0) {
				closeWindowsHandles(api, handles, true);
				return null;
			}
			const result = api.symbols.WaitForSingleObject(handle, 0);
			if (result !== WAIT_OBJECT_0 && result !== WAIT_ABANDONED) {
				closeWindowsHandles(api, [...handles, handle], true);
				return null;
			}
			handles.push(handle);
		}
		return { kind: "windows", api, handles };
	} catch {
		closeWindowsHandles(api, handles, true);
		return null;
	}
}

function closeDirectoryLock(api: PosixApi, directoryFd: number): void {
	try {
		api.symbols.flock(directoryFd, LOCK_UN);
	} catch {}
	try {
		closeSync(directoryFd);
	} catch {}
}

function acquireNativeLock(fd: number, path: string): NativeLock | null {
	if (process.platform === "win32") return acquireWindowsLock(path, fd);

	const api = loadPosixApi();
	if (api === null) return null;
	let directoryFd: number | null = null;
	try {
		const directory = realpathSync(dirname(path));
		directoryFd = openSync(join(directory, "."), DIRECTORY_OPEN_FLAGS);
		if (api.symbols.flock(directoryFd, LOCK_EX | LOCK_NB) !== 0) {
			closeDirectoryLock(api, directoryFd);
			return null;
		}
		if (api.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			closeDirectoryLock(api, directoryFd);
			return null;
		}
		return { kind: "posix", api, directoryFd };
	} catch {
		if (directoryFd !== null) closeDirectoryLock(api, directoryFd);
		return null;
	}
}

function releaseNativeLock(lock: NativeLock, fd: number): void {
	try {
		if (lock.kind === "posix") {
			try {
				lock.api.symbols.flock(fd, LOCK_UN);
			} catch {}
			closeDirectoryLock(lock.api, lock.directoryFd);
			return;
		}
		closeWindowsHandles(lock.api, lock.handles, true);
	} catch {}
}

function hasLiveLegacyOwner(fd: number): boolean {
	try {
		const fields = readFileSync(fd, "utf8").trim().split(/\s+/);
		if (fields[2] === KERNEL_LOCK_METADATA) return false;
		const pid = Number.parseInt(fields[0] ?? "", 10);
		if (!Number.isInteger(pid) || pid <= 0 || pid === 1 || pid === process.pid) return false;
		return isAlive(pid);
	} catch {
		return false;
	}
}

function writeMetadata(fd: number): void {
	const metadata = Buffer.from(`${process.pid}\n${Date.now()}\n${KERNEL_LOCK_METADATA}\n`);
	ftruncateSync(fd, 0);
	writeSync(fd, metadata, 0, metadata.byteLength, 0);
}

export function acquireSingleInstanceLock(path: string): SingleInstanceLock | null {
	mkdirSync(dirname(path), { recursive: true });

	let fd: number;
	try {
		fd = openSync(path, LOCK_OPEN_FLAGS, 0o600);
	} catch {
		return null;
	}

	const native = acquireNativeLock(fd, path);
	if (native === null || hasLiveLegacyOwner(fd)) {
		if (native !== null) releaseNativeLock(native, fd);
		try {
			closeSync(fd);
		} catch {}
		return null;
	}

	try {
		writeMetadata(fd);
		return { fd, path, native, released: false };
	} catch {
		releaseNativeLock(native, fd);
		try {
			closeSync(fd);
		} catch {}
		return null;
	}
}

export function releaseSingleInstanceLock(lock: SingleInstanceLock): void {
	if (lock.released) return;
	lock.released = true;
	releaseNativeLock(lock.native, lock.fd);
	try {
		closeSync(lock.fd);
	} catch {}
}
