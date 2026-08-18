import { describe, expect, it } from "bun:test";
import { resolveMacOSCommandPath } from "./setup-providers.js";

describe("macOS Homebrew command resolution (issue #1475)", () => {
	it("probes both standard Homebrew prefixes when PATH lookup fails", () => {
		const probed: string[] = [];

		const resolved = resolveMacOSCommandPath("brew", (path) => {
			probed.push(path);
			return path === "/usr/local/bin/brew";
		});

		expect(resolved).toBe("/usr/local/bin/brew");
		expect(probed).toEqual(["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
	});

	it("does not apply macOS fallback paths to unrelated commands", () => {
		expect(resolveMacOSCommandPath("ollama", () => true)).toBeUndefined();
	});
});
