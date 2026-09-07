import { afterAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

const npmRoot = join(process.cwd(), "fake-npm-global");
const platformName = process.platform === "win32" ? "windows" : process.platform;
const extensionSuffix = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
const architecture = process.arch === "x64" ? "x64" : process.arch;
const expectedExtension = join(npmRoot, `sqlite-vec-${platformName}-${architecture}`, `vec0.${extensionSuffix}`);
const execCalls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
const realChildProcess = await import("node:child_process");
const realFs = await import("node:fs");
const execFileSync = mock((command: string, args: readonly string[], options: Record<string, unknown>) => {
	execCalls.push({ command, args, options });
	return `${npmRoot}\r\n`;
});

mock.module("node:child_process", () => ({ ...realChildProcess, execFileSync }));
mock.module("node:fs", () => ({
	...realFs,
	existsSync: mock((candidate: string) => candidate === expectedExtension),
	readdirSync: mock(() => []),
}));

const originalSignetVecPath = process.env.SIGNET_VEC_PATH;
delete process.env.SIGNET_VEC_PATH;
const { findSqliteVecExtension } = await import("./database");

afterAll(() => {
	if (originalSignetVecPath === undefined) delete process.env.SIGNET_VEC_PATH;
	else process.env.SIGNET_VEC_PATH = originalSignetVecPath;
});

describe("sqlite-vec npm global lookup", () => {
	test("hides the Windows npm launcher and caches the lookup", () => {
		expect(findSqliteVecExtension()).toBe(expectedExtension);
		expect(findSqliteVecExtension()).toBe(expectedExtension);

		expect(execFileSync).toHaveBeenCalledTimes(1);
		expect(execCalls[0]).toMatchObject({
			command: process.platform === "win32" ? "npm.cmd" : "npm",
			args: ["root", "-g"],
			options: {
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
			},
		});
	});
});
