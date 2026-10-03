import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchSmokeProcess } from "./smoke-process";

test.skipIf(process.platform === "win32")(
	"cleanup kills a stubborn descendant after its parent exits",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "smoke-process-"));
		const marker = join(root, "child.pid");
		const child = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
		const parent = `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'inherit'}); setTimeout(() => process.exit(0), 200);`;
		const running = launchSmokeProcess(process.execPath, ["-e", parent], root, { PATH: process.env.PATH ?? "" });
		try {
			const deadline = Date.now() + 5000;
			while (!existsSync(marker) && Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 20));
			expect(existsSync(marker)).toBe(true);
			const pid = Number(readFileSync(marker, "utf8"));
			while (running.child.exitCode === null && Date.now() < deadline)
				await new Promise((accept) => setTimeout(accept, 20));
			expect(running.child.exitCode).toBe(0);
			expect(() => process.kill(pid, 0)).not.toThrow();
			await running.stop();
			expect(await running.done).toBe(0);
			const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
				.stdout.toString()
				.trim();
			expect(status === "" || status.startsWith("Z")).toBe(true);
		} finally {
			await running.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	15000,
);
