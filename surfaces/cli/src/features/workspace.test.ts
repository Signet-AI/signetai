import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWorkspacePath } from "./workspace.js";

function makeEnv(root: string): NodeJS.ProcessEnv {
	const env = {
		...process.env,
		XDG_CONFIG_HOME: root,
		SIGNET_PATH: undefined,
	};
	return env;
}

describe("setWorkspacePath", () => {
	it("migrates files and persists the new default workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-set-"));
		const src = join(root, "src");
		const dst = join(root, "dst");
		mkdirSync(join(src, "memory"), { recursive: true });
		writeFileSync(join(src, "agent.yaml"), "version: 1\n");
		writeFileSync(join(src, "AGENTS.md"), "# Agent\n");
		writeFileSync(join(src, "memory", "memories.db"), "sqlite");

		const result = await setWorkspacePath(dst, {
			currentPath: src,
			patchOpenClaw: false,
			env: makeEnv(root),
		});

		expect(result.nextPath).toBe(dst);
		expect(result.migrated).toBe(true);
		expect(existsSync(join(dst, "agent.yaml"))).toBe(true);
		expect(existsSync(join(dst, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(dst, "memory", "memories.db"))).toBe(true);
		const cfgRaw = readFileSync(result.configPath, "utf-8");
		expect(cfgRaw.includes(dst)).toBe(true);
	});

	it("is idempotent when run again for the same workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-idempotent-"));
		const dst = join(root, "workspace");
		mkdirSync(join(dst, "memory"), { recursive: true });
		writeFileSync(join(dst, "agent.yaml"), "version: 1\n");
		writeFileSync(join(dst, "AGENTS.md"), "# Agent\n");
		writeFileSync(join(dst, "memory", "memories.db"), "sqlite");

		const first = await setWorkspacePath(dst, {
			currentPath: dst,
			patchOpenClaw: false,
			env: makeEnv(root),
		});
		expect(first.changed).toBe(false);

		const second = await setWorkspacePath(dst, {
			currentPath: dst,
			patchOpenClaw: false,
			env: makeEnv(root),
		});
		expect(second.changed).toBe(false);
		expect(second.migrated).toBe(false);
		expect(second.copiedFiles).toBe(0);
		expect(second.overwrittenFiles).toBe(0);
	});

	it("fails when destination has conflicting files without --force", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-conflict-"));
		const src = join(root, "src");
		const dst = join(root, "dst");
		mkdirSync(src, { recursive: true });
		mkdirSync(dst, { recursive: true });
		writeFileSync(join(src, "AGENTS.md"), "# One\n");
		writeFileSync(join(dst, "AGENTS.md"), "# Two\n");

		await expect(
			setWorkspacePath(dst, {
				currentPath: src,
				patchOpenClaw: false,
				env: makeEnv(root),
			}),
		).rejects.toThrow("workspace migration has conflicts");
	});

	it("skips daemon pid and log files during migration", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-daemon-skip-"));
		const src = join(root, "src");
		const dst = join(root, "dst");
		mkdirSync(join(src, ".daemon", "logs"), { recursive: true });
		writeFileSync(join(src, ".daemon", "pid"), "12345\n");
		writeFileSync(join(src, ".daemon", "auth-secret"), "secret");
		writeFileSync(join(src, ".daemon", "logs", "runtime.log"), "log data");

		await setWorkspacePath(dst, {
			currentPath: src,
			patchOpenClaw: false,
			env: makeEnv(root),
		});

		expect(existsSync(join(dst, ".daemon", "auth-secret"))).toBe(true);
		expect(existsSync(join(dst, ".daemon", "pid"))).toBe(false);
		expect(existsSync(join(dst, ".daemon", "logs", "runtime.log"))).toBe(false);
	});

	it("copies the v2 database and skips v2 runtime pid and log files", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-v2-"));
		const src = join(root, "src");
		const dst = join(root, "dst");
		mkdirSync(join(src, "data"), { recursive: true });
		mkdirSync(join(src, "runtime", "logs"), { recursive: true });
		writeFileSync(join(src, "workspace-layout.json"), `${JSON.stringify({ version: 2 })}\n`);
		writeFileSync(join(src, "AGENTS.md"), "# Agent\n");
		writeFileSync(join(src, "data", "signet.db"), "sqlite");
		writeFileSync(join(src, "runtime", "pid"), "12345\n");
		writeFileSync(join(src, "runtime", "auth-secret"), "secret");
		writeFileSync(join(src, "runtime", "logs", "runtime.log"), "log data");

		const result = await setWorkspacePath(dst, {
			currentPath: src,
			patchOpenClaw: false,
			env: makeEnv(root),
		});

		expect(result.migrated).toBe(true);
		expect(readFileSync(join(dst, "data", "signet.db"), "utf-8")).toBe("sqlite");
		expect(existsSync(join(dst, "workspace-layout.json"))).toBe(true);
		expect(existsSync(join(dst, "runtime", "auth-secret"))).toBe(true);
		expect(existsSync(join(dst, "runtime", "pid"))).toBe(false);
		expect(existsSync(join(dst, "runtime", "logs", "runtime.log"))).toBe(false);
		expect(existsSync(join(dst, "memory"))).toBe(false);
	});

	it("skips symbolic links during migration", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-symlink-skip-"));
		const src = join(root, "src");
		const dst = join(root, "dst");
		const target = join(root, "target.txt");
		mkdirSync(src, { recursive: true });
		writeFileSync(target, "external");
		symlinkSync(target, join(src, "link.txt"));
		writeFileSync(join(src, "AGENTS.md"), "# Agent\n");

		await setWorkspacePath(dst, {
			currentPath: src,
			patchOpenClaw: false,
			env: makeEnv(root),
		});

		expect(existsSync(join(dst, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(dst, "link.txt"))).toBe(false);
	});
});
