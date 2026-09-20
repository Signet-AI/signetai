import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./single-instance-lock";

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
	if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
}

describe("single-instance daemon lock", () => {
	it("prevents concurrent starts from both holding the lock", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-single-instance-"));
		const path = join(dir, "daemon.lock");
		const ready = join(dir, "ready");
		const modulePath = join(import.meta.dir, "single-instance-lock.ts");
		const script = [
			`import { acquireSingleInstanceLock } from ${JSON.stringify(modulePath)};`,
			`const lock = acquireSingleInstanceLock(${JSON.stringify(path)});`,
			"if (lock === null) process.exit(2);",
			`await Bun.write(${JSON.stringify(ready)}, "ready");`,
			"setInterval(() => {}, 1000);",
		].join("\n");
		const child = spawn(process.execPath, ["-e", script], {
			stdio: "ignore",
		});

		try {
			await waitForFile(ready);
			expect(acquireSingleInstanceLock(path)).toBeNull();
			child.kill("SIGKILL");
			await waitForExit(child);
			expect(existsSync(path)).toBe(true);
			const recovered = acquireSingleInstanceLock(path);
			expect(recovered).not.toBeNull();
			if (recovered !== null) releaseSingleInstanceLock(recovered);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats persisted PID metadata as diagnostic after taking the kernel lock", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-single-instance-metadata-"));
		const path = join(dir, "daemon.lock");
		const old = new Date(Date.now() - 10 * 60_000);
		writeFileSync(path, `${process.pid}\n${old.getTime()}\nsignet-kernel-lock-v1\n`);
		utimesSync(path, old, old);

		try {
			const lock = acquireSingleInstanceLock(path);
			expect(lock).not.toBeNull();
			if (lock !== null) releaseSingleInstanceLock(lock);
			expect(existsSync(path)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not trust legacy container PID 1 metadata", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-single-instance-legacy-pid1-"));
		const path = join(dir, "daemon.lock");
		writeFileSync(path, "1\n0\n");

		try {
			const lock = acquireSingleInstanceLock(path);
			expect(lock).not.toBeNull();
			if (lock !== null) releaseSingleInstanceLock(lock);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the lock inode after release", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-single-instance-release-"));
		const path = join(dir, "daemon.lock");

		try {
			const lock = acquireSingleInstanceLock(path);
			expect(lock).not.toBeNull();
			if (lock !== null) releaseSingleInstanceLock(lock);
			expect(existsSync(path)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
