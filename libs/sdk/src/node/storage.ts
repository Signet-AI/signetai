import { attempt } from "@signet/core/attempt";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { constants } from "node:fs";
import {
	chmod,
	mkdir,
	open,
	readdir,
	rename as renameNative,
	rm as rmNative,
	stat,
	lstat,
	realpath,
	type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { UnsafeAclError, windowsAcl, invalidatePrivate, rememberDirectoryMutation } from "./windows-acl.js";
import { parseOwner, ownerAlive, processOwner, processStart, type ProcessOwner } from "./process-owner.js";
import { sleep } from "../transport.js";

async function syncDirectory(path: string): Promise<void> {
	if (process.platform !== "win32") {
		const handle = await open(path, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
}
export async function privateRename(from: string, to: string, durable = true): Promise<void> {
	await rejectDirectoryLinks(dirname(from));
	await rejectDirectoryLinks(dirname(to));
	invalidatePrivate(from);
	invalidatePrivate(to);
	await renameNative(from, to);
	if (durable) {
		await syncDirectory(dirname(from));
		if (dirname(to) !== dirname(from)) await syncDirectory(dirname(to));
	}
	await rememberDirectoryMutation(dirname(from));
	if (dirname(to) !== dirname(from)) await rememberDirectoryMutation(dirname(to));
}
export async function privateRemove(
	path: string,
	options: Parameters<typeof rmNative>[1] = {},
	durable = true,
): Promise<void> {
	await rejectDirectoryLinks(dirname(path));
	invalidatePrivate(path);
	await rmNative(path, options);
	if (durable) await syncDirectory(dirname(path));
	await rememberDirectoryMutation(dirname(path));
}
const rename = privateRename;
const rm = privateRemove;

export interface StorageOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
}
export function configDirectory(options: StorageOptions = {}): string {
	const env = options.env ?? process.env;
	if (process.platform === "win32") {
		if (!env.APPDATA) throw new Error("APPDATA is required for Signet credential storage");
		return join(env.APPDATA, "signet");
	}
	return join(env.HOME ?? homedir(), ".config", "signet");
}
export function originHash(origin: string): string {
	return createHash("sha256")
		.update(new URL(resolveSignetDaemonUrl({ env: {}, configUrl: origin })).origin)
		.digest("hex");
}
export function identifier(value: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value))
		throw new TypeError("Invalid connector identifier");
	return value;
}
export function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function protect(path: string, directory: boolean): Promise<void> {
	if (process.platform !== "win32") {
		await chmod(path, directory ? 0o700 : 0o600);
		return;
	}
	await windowsAcl(path, directory, true);
}
async function rejectDirectoryLinks(path: string): Promise<void> {
	let current = resolve(path);
	for (;;) {
		try {
			if (process.platform === "win32") {
				if ((await lstat(current)).isSymbolicLink())
					throw new PrivateFileError("Private state directories cannot be links");
			} else {
				if ((await realpath(current)) !== current)
					throw new PrivateFileError("Private state directories cannot contain links");
				return;
			}
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
export async function privateDirectory(path: string): Promise<void> {
	await rejectDirectoryLinks(path);
	if (process.platform === "win32") {
		const missing: string[] = [];
		let parent = path;
		while (true) {
			try {
				await stat(parent);
				break;
			} catch (error) {
				if (!isMissing(error)) throw error;
				missing.push(parent);
				const next = dirname(parent);
				if (next === parent) throw error;
				parent = next;
			}
		}
		for (const item of missing.reverse()) {
			await mkdir(item, { recursive: true, mode: 0o700 });
			await protect(item, true);
			await rememberDirectoryMutation(dirname(item));
		}
	} else await mkdir(path, { recursive: true, mode: 0o700 });
	await rejectDirectoryLinks(path);
	await protect(path, true);
}
export async function readPrivate(path: string, maxBytes = 1024 * 1024, allowSymlink = false): Promise<string | null> {
	let handle: FileHandle;
	try {
		if (!allowSymlink) await rejectDirectoryLinks(dirname(path));
		if (!allowSymlink && (await lstat(path)).isSymbolicLink())
			throw new PrivateFileError("Invalid credential file type");
		handle = await open(
			path,
			constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (allowSymlink ? 0 : (constants.O_NOFOLLOW ?? 0)),
		);
	} catch (error) {
		if (isMissing(error)) return null;
		if (error instanceof Error && "code" in error && error.code === "ELOOP")
			throw new PrivateFileError("Invalid credential file type", { cause: error });
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!allowSymlink) {
			const current = await lstat(path);
			if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
				throw new PrivateFileChangedError("Private state changed while opening");
		}
		if (!info.isFile() || info.size > maxBytes) throw new PrivateFileError("Invalid credential file size or type");
		if (
			process.platform !== "win32" &&
			((info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()))
		)
			throw new PrivateFileError(`Unsafe permissions on credential file: ${path}; require mode 0600 and current owner`);
		if (process.platform === "win32") {
			try {
				await windowsAcl(path, false, false, allowSymlink);
			} catch (error) {
				if (error instanceof UnsafeAclError)
					throw new PrivateFileError("Unsafe permissions on credential file", { cause: error });
				throw error;
			}
			if (!allowSymlink && (await lstat(path)).isSymbolicLink())
				throw new PrivateFileError("Invalid credential file type");
			const current = await stat(path);
			if (current.dev !== info.dev || current.ino !== info.ino || current.ctimeMs !== info.ctimeMs)
				throw new PrivateFileChangedError("Credential changed while verifying permissions");
		}
		return await handle.readFile("utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	} finally {
		await handle.close();
	}
}
export async function atomicPrivateWrite(path: string, value: string, durable = true): Promise<void> {
	await privateDirectory(dirname(path));
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await rememberDirectoryMutation(dirname(path));
		await protect(temporary, false);
		await handle.writeFile(value, "utf8");
		if (durable) await handle.sync();
		await handle.close();
		await rename(temporary, path, durable);
		await rememberDirectoryMutation(dirname(path));
	} finally {
		await handle.close();
		await rm(temporary, { force: true }, false);
	}
}

export class PrivateFileError extends Error {}
class PrivateFileChangedError extends Error {}
interface LockParticipant extends ProcessOwner {
	readonly choosing: boolean;
	readonly ticket: number;
}
async function lockText(path: string, retries = 3): Promise<string | null> {
	try {
		return await readPrivate(path, 4096);
	} catch (error) {
		if (error instanceof PrivateFileChangedError && retries > 0) return lockText(path, retries - 1);
		if (!(error instanceof PrivateFileError)) throw error;
		await rm(path, { force: true, recursive: true });
		return null;
	}
}
async function conservativeLegacyOwner(value: unknown): Promise<ProcessOwner | null> {
	if (
		typeof value !== "object" ||
		value === null ||
		"startTime" in value ||
		!("pid" in value) ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		!("createdAt" in value) ||
		typeof value.createdAt !== "number" ||
		value.createdAt > Date.now() + 1000 ||
		Date.now() - value.createdAt >= 120_000
	)
		return null;
	const startTime = await processStart(value.pid);
	return startTime === null ? null : parseOwner({ ...value, startTime });
}
async function lockParticipants(directory: string, signal: AbortSignal): Promise<LockParticipant[]> {
	const result: LockParticipant[] = [];
	for (const name of await readdir(directory)) {
		signal.throwIfAborted();
		if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
		const path = join(directory, name);
		const text = await lockText(path);
		if (text === null) continue;
		const value: unknown = attempt(() => JSON.parse(text));
		const owner = parseOwner(value) ?? (await conservativeLegacyOwner(value));
		if (
			!owner ||
			`${owner.token}.json` !== name ||
			typeof value !== "object" ||
			value === null ||
			!("choosing" in value) ||
			typeof value.choosing !== "boolean" ||
			!("ticket" in value) ||
			typeof value.ticket !== "number" ||
			!Number.isSafeInteger(value.ticket) ||
			value.ticket < 0 ||
			value.ticket >= Number.MAX_SAFE_INTEGER ||
			!(await ownerAlive(owner))
		) {
			await rm(path, { force: true });
			continue;
		}
		result.push({ ...owner, choosing: value.choosing, ticket: value.ticket });
	}
	if (result.length > 256) throw new Error("Signet lock participant admission limit reached");
	return result;
}
export async function withFileLock<T>(
	path: string,
	run: () => Promise<T>,
	signal = AbortSignal.timeout(10_000),
): Promise<T> {
	signal.throwIfAborted();
	await privateDirectory(dirname(path));
	const directory = `${path}.tickets`;
	await privateDirectory(directory);
	const owner = await processOwner();
	const participantPath = join(directory, `${owner.token}.json`);
	try {
		signal.throwIfAborted();
		await atomicPrivateWrite(participantPath, JSON.stringify({ ...owner, choosing: true, ticket: 0 }), false);
		const ticket = Math.max(0, ...(await lockParticipants(directory, signal)).map((other) => other.ticket)) + 1;
		if (!Number.isSafeInteger(ticket) || ticket >= Number.MAX_SAFE_INTEGER)
			throw new Error("Signet lock ticket limit reached");
		await atomicPrivateWrite(participantPath, JSON.stringify({ ...owner, choosing: false, ticket }), false);
		for (;;) {
			signal.throwIfAborted();
			const participants = await lockParticipants(directory, signal);
			if (!participants.some((other) => other.token === owner.token && other.ticket === ticket && !other.choosing))
				throw new Error("Signet lock generation expired");
			const blocked = participants.some(
				(other) =>
					other.token !== owner.token &&
					(other.choosing || other.ticket < ticket || (other.ticket === ticket && other.token < owner.token)),
			);
			if (!blocked) {
				signal.throwIfAborted();
				return await run();
			}
			await sleep(15 + Math.random() * 20, signal);
		}
	} finally {
		await rm(participantPath, { force: true }, false);
	}
}
