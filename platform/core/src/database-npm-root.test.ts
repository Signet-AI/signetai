import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const npmRoot = join(process.cwd(), "fake-npm-global");
const platformName = process.platform === "win32" ? "windows" : process.platform;
const extensionSuffix = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
const architecture = process.arch === "x64" ? "x64" : process.arch;
const expectedExtension = join(npmRoot, `sqlite-vec-${platformName}-${architecture}`, `vec0.${extensionSuffix}`);

test("hides the Windows npm launcher and caches the lookup without mocking other test files", () => {
	const probe = `
import { mock } from "bun:test";
const realChildProcess = await import("node:child_process");
const realFs = await import("node:fs");
const calls = [];
mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFileSync: (command, args, options) => {
    calls.push({ command, args, options });
    return ${JSON.stringify(`${npmRoot}\r\n`)};
  },
}));
mock.module("node:fs", () => ({
  ...realFs,
  existsSync: (candidate) => candidate === ${JSON.stringify(expectedExtension)},
  readdirSync: () => [],
}));
const { findSqliteVecExtension } = await import(${JSON.stringify(new URL("./database.ts", import.meta.url).href)});
console.log("PROBE_RESULT:" + JSON.stringify({
  first: findSqliteVecExtension(),
  second: findSqliteVecExtension(),
  calls,
}));
`;
	const result = spawnSync(process.execPath, ["-e", probe], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, SIGNET_VEC_PATH: "" },
		timeout: 5000,
	});
	expect(result.status, result.stderr).toBe(0);
	const line = result.stdout.split("\n").find((value) => value.startsWith("PROBE_RESULT:"));
	expect(line, result.stdout).toBeDefined();
	const observed = JSON.parse(line?.slice("PROBE_RESULT:".length) ?? "null") as {
		first: string;
		second: string;
		calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>;
	};
	expect(observed.first).toBe(expectedExtension);
	expect(observed.second).toBe(expectedExtension);
	expect(observed.calls).toHaveLength(1);
	expect(observed.calls[0]).toMatchObject({
		command: process.platform === "win32" ? "npm.cmd" : "npm",
		args: ["root", "-g"],
		options: { encoding: "utf8", timeout: 3000, windowsHide: true },
	});
});
