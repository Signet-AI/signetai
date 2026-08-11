import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
			child.kill("SIGTERM");
			await waitForExit(child);
			const recovered = acquireSingleInstanceLock(path);
			expect(recovered).not.toBeNull();
			if (recovered !== null) releaseSingleInstanceLock(recovered);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
