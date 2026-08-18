import { describe, expect, it } from "bun:test";
import { offerOllamaInstallFlow, resolveCommandPath } from "./setup-providers.js";

describe("macOS Homebrew command resolution (issue #1475)", () => {
	const pathResolver = (paths: string[]) =>
		resolveCommandPath("brew", {
			currentPlatform: "darwin",
			lookup: () => undefined,
			probe: (path) => paths.includes(path),
		});

	it("uses Apple Silicon Homebrew after PATH lookup fails", () => {
		expect(pathResolver(["/opt/homebrew/bin/brew"])).toBe("/opt/homebrew/bin/brew");
	});

	it("falls back to Intel Homebrew when Apple Silicon is absent", () => {
		expect(pathResolver(["/usr/local/bin/brew"])).toBe("/usr/local/bin/brew");
	});

	it("gracefully fails when both Homebrew prefixes are absent", () => {
		expect(pathResolver([])).toBeUndefined();
	});

	it("does not probe macOS prefixes on non-macOS", () => {
		let probes = 0;
		expect(
			resolveCommandPath("brew", {
				currentPlatform: "linux",
				lookup: () => undefined,
				probe: () => {
					probes++;
					return true;
				},
			}),
		).toBeUndefined();
		expect(probes).toBe(0);
	});

	it("passes the resolved absolute Homebrew path to the installer", async () => {
		const calls: Array<[string, string[]]> = [];
		const installed = await offerOllamaInstallFlow({
			currentPlatform: "darwin",
			confirmInstall: async () => true,
			resolvePath: () => "/opt/homebrew/bin/brew",
			runCommand: async (command, args) => {
				calls.push([command, args]);
				return { code: 1, stdout: "", stderr: "expected test failure" };
			},
		});
		expect(installed).toBe(false);
		expect(calls).toEqual([["/opt/homebrew/bin/brew", ["install", "ollama"]]]);
	});
});
