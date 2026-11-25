import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

class PlatformHelperError extends Error {
	constructor(
		cause: Error,
		readonly code: unknown,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super("Signet platform helper failed", { cause });
	}
}
export function boundedHelper(command: string, args: readonly string[], input?: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			[...args],
			{
				timeout: 1000,
				maxBuffer: 4096,
				encoding: "utf8",
				windowsHide: true,
				env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			},
			(error, stdout, stderr) =>
				error ? reject(new PlatformHelperError(error, error.code, stdout, stderr)) : resolve(stdout),
		);
		child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
	});
}
const cache = new Map<number, { value: string | null; until: number }>();
export async function processStart(pid: number): Promise<string | null> {
	const cached = cache.get(pid);
	if (pid === process.pid && cached && cached.until > Date.now()) return cached.value;
	let value: string | null = null;
	try {
		if (process.platform === "linux") {
			const text = await readFile(`/proc/${pid}/stat`, "utf8");
			const start = text
				.slice(text.lastIndexOf(")") + 1)
				.trim()
				.split(/\s+/)[19];
			if (start) value = `linux:${start}`;
		} else if (process.platform === "darwin") {
			const start = (await boundedHelper("ps", ["-o", "lstart=", "-p", String(pid)])).trim();
			if (start) value = `darwin:${start}`;
		} else if (process.platform === "win32") {
			const start = (
				await boundedHelper("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -ne $p){$p.StartTime.ToUniversalTime().Ticks}`,
				])
			).trim();
			if (/^\d+$/.test(start)) value = `win32:${start}`;
		} else throw new Error("Unsupported Signet lock platform");
	} catch (error) {
		if (pid === process.pid) throw error;
		if (
			process.platform === "linux" &&
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ESRCH")
		)
			return null;
		if (
			process.platform === "darwin" &&
			error instanceof PlatformHelperError &&
			error.code === 1 &&
			!error.stdout.trim() &&
			!error.stderr.trim()
		)
			return null;
		throw error;
	}
	if (pid === process.pid) cache.set(pid, { value, until: Infinity });
	return value;
}
export interface ProcessOwner {
	readonly pid: number;
	readonly token: string;
	readonly startTime: string;
	readonly createdAt: number;
}
export function parseOwner(value: unknown): ProcessOwner | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("pid" in value) ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		!("token" in value) ||
		typeof value.token !== "string" ||
		!("startTime" in value) ||
		typeof value.startTime !== "string" ||
		!("createdAt" in value) ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt)
	)
		return null;
	return { pid: value.pid, token: value.token, startTime: value.startTime, createdAt: value.createdAt };
}
export async function processOwner(token = randomUUID()): Promise<ProcessOwner> {
	const startTime = await processStart(process.pid);
	if (!startTime) throw new Error("Cannot resolve process creation time");
	return { pid: process.pid, token, startTime, createdAt: Date.now() };
}
export async function ownerAlive(owner: ProcessOwner | null): Promise<boolean> {
	return (
		owner !== null &&
		owner.createdAt <= Date.now() + 1000 &&
		Date.now() - owner.createdAt < 120_000 &&
		(await processStart(owner.pid)) === owner.startTime
	);
}
