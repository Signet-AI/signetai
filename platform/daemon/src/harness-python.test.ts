import { describe, expect, test } from "bun:test";
import { resolveHarnessPythonCommand } from "./harness-python";

function resolver(...available: string[]): (name: string) => string | null {
	return (name) => (available.includes(name) ? `/mock/${name}` : null);
}

describe("resolveHarnessPythonCommand", () => {
	test("uses the launchd-resolved Python 3 executable on macOS", () => {
		expect(resolveHarnessPythonCommand("darwin", resolver(), "/opt/homebrew/bin/python3")).toEqual({
			executable: "/opt/homebrew/bin/python3",
			args: [],
		});
	});

	test("prefers python.exe on Windows", () => {
		expect(resolveHarnessPythonCommand("win32", resolver("python", "py"))).toEqual({
			executable: "/mock/python",
			args: [],
		});
	});

	test("uses the Windows py launcher with an explicit Python 3 selector", () => {
		expect(resolveHarnessPythonCommand("win32", resolver("py"))).toEqual({
			executable: "/mock/py",
			args: ["-3"],
		});
	});

	test("prefers python3 on Unix and falls back to python", () => {
		expect(resolveHarnessPythonCommand("linux", resolver("python3", "python"))).toEqual({
			executable: "/mock/python3",
			args: [],
		});
		expect(resolveHarnessPythonCommand("linux", resolver("python"))).toEqual({
			executable: "/mock/python",
			args: [],
		});
	});

	test("reports when no Python executable is available", () => {
		expect(resolveHarnessPythonCommand("win32", resolver())).toBeNull();
	});
});
