import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

const helperPath = fileURLToPath(new URL("./test-temp-dir.ts", import.meta.url));
const leaked: string[] = [];
afterAll(() => {
	for (const dir of leaked) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

function childScript(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-test-tempdir-child-"));
	leaked.push(root);
	const scriptPath = join(root, "child.ts");
	writeFileSync(
		scriptPath,
		`import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from ${JSON.stringify(helperPath)};
const dir = createTestTempDir("signet-test-tempdir-int-");
const secondDir = createTestTempDir("signet-test-tempdir-int-");
writeFileSync(join(dir, "marker.txt"), "x");
writeFileSync(join(secondDir, "marker.txt"), "x");
console.log("DIR:" + dir);
console.log("DIR2:" + secondDir);
`,
	);
	return scriptPath;
}

// The exit/SIGTERM handler in test-temp-dir removes the dir when the
// process is interrupted — this is the core of the leak fix. Simulate an
// interrupted child process and assert the dir is gone.
describe("test-temp-dir exit cleanup (interrupt simulation)", () => {
	it("removes the temp dir on SIGTERM", async () => {
		const scriptPath = childScript();
		// Append keep-alive + the marker we assert on.
		const fullScript = `${await Bun.file(scriptPath).text()}
setInterval(() => {}, 1000);`;
		writeFileSync(scriptPath, fullScript);

		const proc = Bun.spawn({
			cmd: ["bun", "run", scriptPath],
			stdout: "pipe",
			stderr: "pipe",
			cwd: process.cwd(),
		});
		const output = await new Promise<string>((resolve, reject) => {
			const reader = proc.stdout?.getReader();
			let out = "";
			const tick = async (): Promise<void> => {
				if (!reader) return resolve(out);
				const { value, done } = await reader.read();
				if (done) return resolve(out);
				out += new TextDecoder().decode(value);
				if (out.includes("DIR:")) resolve(out);
				else void tick();
			};
			void tick().catch(reject);
			setTimeout(() => reject(new Error("timeout waiting for child")), 15000);
		});
		const match = output.match(/DIR:(\S+)/);
		const secondMatch = output.match(/DIR2:(\S+)/);
		expect(match).not.toBeNull();
		expect(secondMatch).not.toBeNull();
		const dir = match?.[1] ?? "";
		const secondDir = secondMatch?.[1] ?? "";
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(secondDir)).toBe(true);

		proc.kill("SIGTERM");
		await proc.exited;

		// Give the exit handler a beat to run.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(secondDir)).toBe(false);
	});

	it("still removes the dir on clean exit via the exit handler", async () => {
		const scriptPath = childScript();
		const fullScript = `${await Bun.file(scriptPath).text()}
process.exit(0);`;
		writeFileSync(scriptPath, fullScript);

		const proc = Bun.spawn({
			cmd: ["bun", "run", scriptPath],
			stdout: "pipe",
			stderr: "pipe",
			cwd: process.cwd(),
		});
		const output = await new Promise<string>((resolve, reject) => {
			const reader = proc.stdout?.getReader();
			let out = "";
			const tick = async (): Promise<void> => {
				if (!reader) return resolve(out);
				const { value, done } = await reader.read();
				if (done) return resolve(out);
				out += new TextDecoder().decode(value);
				if (out.includes("DIR:")) resolve(out);
				else void tick();
			};
			void tick().catch(reject);
			setTimeout(() => reject(new Error("timeout waiting for child")), 15000);
		});
		const match = output.match(/DIR:(\S+)/);
		const secondMatch = output.match(/DIR2:(\S+)/);
		expect(match).not.toBeNull();
		expect(secondMatch).not.toBeNull();
		const dir = match?.[1] ?? "";
		const secondDir = secondMatch?.[1] ?? "";
		await proc.exited;
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(secondDir)).toBe(false);
	});
});

// Ensure the parent process's own registered dirs are cleaned even though
// this suite runs in-process (keeps the suite hermetic).
describe("test-temp-dir hermeticity", () => {
	it("deregisters on explicit cleanup so exit handler does not double-remove", () => {
		const dir = createTestTempDir("signet-test-tempdir-herm-");
		cleanupTestTempDir(dir);
		expect(existsSync(dir)).toBe(false);
	});
});
