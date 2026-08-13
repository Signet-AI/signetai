import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
	app: { isPackaged: false },
}));

const { resolveBunPath } = await import("./paths.js");

describe("desktop Bun runtime resolution", () => {
	test("uses a known absolute Windows Bun path when the bundled runtime is absent", () => {
		const path = resolveBunPath({
			bundled: "C:\\Signet\\resources\\runtime\\bun.exe",
			platform: "win32",
			home: "C:\\Users\\Nicholai",
			environment: { USERPROFILE: "C:\\Users\\Nicholai" },
			exists: () => false,
		});

		expect(path).toBe("C:\\Users\\Nicholai\\.bun\\bin\\bun.exe");
		expect(path).not.toBe("bun.exe");
	});

	test("prefers the configured Windows Bun install when it exists", () => {
		const bunInstall = "D:\\Tools\\bun";
		const path = resolveBunPath({
			bundled: "C:\\Signet\\resources\\runtime\\bun.exe",
			platform: "win32",
			home: "C:\\Users\\Nicholai",
			environment: { USERPROFILE: "C:\\Users\\Nicholai", BUN_INSTALL: bunInstall },
			exists: (candidate) => candidate === "D:\\Tools\\bun\\bin\\bun.exe",
		});

		expect(path).toBe("D:\\Tools\\bun\\bin\\bun.exe");
	});
});
