import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import { execFileHidden, spawnHidden, withWindowsHide } from "./child-process";

describe("shared child-process launcher", () => {
	test("defaults process options to a hidden Windows console", () => {
		expect(withWindowsHide({}).windowsHide).toBe(true);
		expect(withWindowsHide({ windowsHide: false }).windowsHide).toBe(false);
	});

	test("preserves execFile's promisified stdout/stderr result", async () => {
		const result = await promisify(execFileHidden)(process.execPath, ["--eval", 'process.stdout.write("ok")'], {
			encoding: "utf8",
		});

		expect(result.stdout).toBe("ok");
		expect(result.stderr).toBe("");
	});

	test("rejects shell-enabled spawn options at the shared boundary", () => {
		expect(() => spawnHidden(process.execPath, { shell: true })).toThrow("does not allow shell execution");
		expect(() => spawnHidden(process.execPath, { shell: "powershell.exe" })).toThrow("does not allow shell execution");
	});
});
