import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STALE_LOCK_AGE_MS = 5 * 60_000;

type SingleInstanceLock = {
	readonly fd: number;
	readonly path: string;
};

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

function readPid(path: string): number | null {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? "", 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isStale(path: string): boolean {
	const pid = readPid(path);
	if (pid !== null) return !isAlive(pid);

	try {
		return Date.now() - statSync(path).mtimeMs > STALE_LOCK_AGE_MS;
	} catch {
		return false;
	}
}

function reclaim(path: string): boolean {
	const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(path, stalePath);
	} catch {
		return false;
	}

	try {
		unlinkSync(stalePath);
	} catch {
		return false;
	}
	return true;
}

export function acquireSingleInstanceLock(path: string): SingleInstanceLock | null {
	mkdirSync(dirname(path), { recursive: true });

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
				return { fd, path };
			} catch {
				closeSync(fd);
				unlinkSync(path);
				return null;
			}
		} catch (error) {
			if (errorCode(error) !== "EEXIST" || !isStale(path) || !reclaim(path)) return null;
		}
	}

	return null;
}

export function releaseSingleInstanceLock(lock: SingleInstanceLock): void {
	try {
		closeSync(lock.fd);
	} catch {
		// The descriptor may already be closed during process shutdown.
	}
	try {
		unlinkSync(lock.path);
	} catch {
		// The lock may have been reclaimed after an unclean process exit.
	}
}
