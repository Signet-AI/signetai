import { attempt } from "@signet/core/attempt";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { sleep } from "../transport.js";

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
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new TypeError("Invalid connector identifier");
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
	const script =
		"[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; if($v.directory){$acl=[System.Security.AccessControl.DirectorySecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=[System.Security.AccessControl.FileSecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')}; $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $v.path -AclObject $acl -ErrorAction Stop";
	await new Promise<void>((resolve, reject) => {
		const child = execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 5000, windowsHide: true },
			(error) => (error ? reject(error) : resolve()),
		);
		child.stdin?.end(JSON.stringify({ path, directory }));
	});
}
export async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await protect(path, true);
}
export async function readPrivate(path: string, maxBytes = 1024 * 1024): Promise<string | null> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid credential file size or type");
		if (
			process.platform !== "win32" &&
			((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
		)
			throw new Error(`Unsafe permissions on credential file: ${path}; require mode 0600 and current owner`);
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}
export async function atomicPrivateWrite(path: string, value: string): Promise<void> {
	await privateDirectory(dirname(path));
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await protect(temporary, false);
		await handle.writeFile(value, "utf8");
		await handle.sync();
		await handle.close();
		await rename(temporary, path);
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		await handle.close();
		await rm(temporary, { force: true });
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}
function lockRecord(text: string): { pid: number; token: string } | null {
	const value: unknown = attempt(() => JSON.parse(text));
	if (
		typeof value === "object" &&
		value !== null &&
		"pid" in value &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		"token" in value &&
		typeof value.token === "string"
	)
		return { pid: value.pid, token: value.token };
	return null;
}

interface LockParticipant {
	readonly pid: number;
	readonly token: string;
	readonly choosing: boolean;
	readonly ticket: number;
}

async function lockParticipants(directory: string, signal: AbortSignal): Promise<LockParticipant[]> {
	const names = await readdir(directory);
	if (names.length > 256) throw new Error("Signet lock participant admission limit reached");
	const result: LockParticipant[] = [];
	for (const name of names) {
		signal.throwIfAborted();
		if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
		const path = join(directory, name);
		const text = await readPrivate(path, 4096);
		if (text === null) continue;
		const owner = lockRecord(text);
		const value: unknown = JSON.parse(text);
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
			value.ticket >= Number.MAX_SAFE_INTEGER
		)
			throw new Error("Corrupt Signet lock participant");
		try {
			const info = await stat(path);
			if (Date.now() - info.mtimeMs > 1000 && !pidAlive(owner.pid)) {
				await rm(path, { force: true });
				continue;
			}
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		result.push({ ...owner, choosing: value.choosing, ticket: value.ticket });
	}
	return result;
}

async function legacyLockReleased(path: string): Promise<boolean> {
	const text = await readPrivate(path, 4096);
	if (text === null) return true;
	const owner = lockRecord(text);
	const info = await stat(path);
	if (Date.now() - info.mtimeMs <= (owner ? 1000 : 30_000) || (owner && pidAlive(owner.pid))) return false;
	await rm(path, { force: true });
	return true;
}

export async function withFileLock<T>(
	path: string,
	run: () => Promise<T>,
	signal = AbortSignal.timeout(10_000),
): Promise<T> {
	await privateDirectory(dirname(path));
	const directory = `${path}.tickets`;
	await privateDirectory(directory);
	const token = randomUUID();
	const participantPath = join(directory, `${token}.json`);
	let acquired = false;
	try {
		signal.throwIfAborted();
		const owner = { pid: process.pid, token, createdAt: Date.now() };
		await atomicPrivateWrite(participantPath, JSON.stringify({ ...owner, choosing: true, ticket: 0 }));
		const ticket = Math.max(0, ...(await lockParticipants(directory, signal)).map((value) => value.ticket)) + 1;
		await atomicPrivateWrite(participantPath, JSON.stringify({ ...owner, choosing: false, ticket }));
		for (;;) {
			signal.throwIfAborted();
			const participants = await lockParticipants(directory, signal);
			const blocked = participants.some(
				(other) =>
					other.token !== token &&
					(other.choosing || other.ticket < ticket || (other.ticket === ticket && other.token < token)),
			);
			if (!blocked && (await legacyLockReleased(`${path}.reap`)) && (await legacyLockReleased(path))) {
				const handle = await open(path, "wx", 0o600);
				acquired = true;
				try {
					await handle.writeFile(JSON.stringify(owner));
				} finally {
					await handle.close();
				}
				signal.throwIfAborted();
				return await run();
			}
			await sleep(15 + Math.random() * 20, signal);
		}
	} finally {
		try {
			if (acquired) await rm(path, { force: true });
		} finally {
			await rm(participantPath, { force: true });
		}
	}
}
