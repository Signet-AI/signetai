import { describe, expect, it } from "bun:test";
import { offerOllamaInstallFlow, resolveCommandPath } from "./setup-providers.js";

// resolvePath hook that runs the REAL resolver with injectable platform /
// PATH-failure / probe, so installer-boundary tests exercise the production
// wiring (PATH fail -> darwin prefix probe -> absolute path to runCommand)
// rather than a direct stub. Returns undefined when it should model "not found".
function realResolverWith(currentPlatform: NodeJS.Platform, present: string[]) {
	return (command: string): string | undefined =>
		resolveCommandPath(command, {
			currentPlatform,
			lookup: () => undefined, // force PATH lookup to fail so the fallback triggers
			probe: (path) => present.includes(path),
		});
}

describe("macOS Homebrew command resolution (issue #1475)", () => {
	it("uses Apple Silicon Homebrew after PATH lookup fails", () => {
		expect(realResolverWith("darwin", ["/opt/homebrew/bin/brew"])("brew")).toBe("/opt/homebrew/bin/brew");
	});

	it("falls back to Intel Homebrew when Apple Silicon is absent", () => {
		expect(realResolverWith("darwin", ["/usr/local/bin/brew"])("brew")).toBe("/usr/local/bin/brew");
	});

	it("gracefully fails when both Homebrew prefixes are absent", () => {
		expect(realResolverWith("darwin", [])("brew")).toBeUndefined();
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

	it("passes the resolved Apple Silicon Homebrew path to the installer (real resolver)", async () => {
		const calls: Array<[string, string[]]> = [];
		const installed = await offerOllamaInstallFlow({
			currentPlatform: "darwin",
			confirmInstall: async () => true,
			resolvePath: realResolverWith("darwin", ["/opt/homebrew/bin/brew"]),
			runCommand: async (command, args) => {
				calls.push([command, args]);
				return { code: 1, stdout: "", stderr: "expected test failure" };
			},
		});
		expect(installed).toBe(false);
		expect(calls).toEqual([["/opt/homebrew/bin/brew", ["install", "ollama"]]]);
	});

	it("passes the resolved Intel Homebrew path to the installer (real resolver)", async () => {
		const calls: Array<[string, string[]]> = [];
		const installed = await offerOllamaInstallFlow({
			currentPlatform: "darwin",
			confirmInstall: async () => true,
			resolvePath: realResolverWith("darwin", ["/usr/local/bin/brew"]),
			runCommand: async (command, args) => {
				calls.push([command, args]);
				return { code: 1, stdout: "", stderr: "expected test failure" };
			},
		});
		expect(installed).toBe(false);
		expect(calls).toEqual([["/usr/local/bin/brew", ["install", "ollama"]]]);
	});

	it("does not invoke the installer when both Homebrew prefixes are absent (real resolver)", async () => {
		const calls: Array<[string, string[]]> = [];
		const installed = await offerOllamaInstallFlow({
			currentPlatform: "darwin",
			confirmInstall: async () => true,
			resolvePath: realResolverWith("darwin", []),
			runCommand: async (command, args) => {
				calls.push([command, args]);
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		expect(installed).toBe(false);
		expect(calls).toEqual([]); // no brew install attempted
	});

	it("performs no Homebrew probe or install on non-macOS (real platform gate)", async () => {
		const calls: Array<[string, string[]]> = [];
		// Linux path: offerOllamaInstallFlow uses its own shell install, but the
		// darwin prefix resolver must never be consulted and no brew path is used.
		const installed = await offerOllamaInstallFlow({
			currentPlatform: "linux",
			confirmInstall: async () => true,
			resolvePath: (command) => {
				throw new Error(`should not resolve ${command} on linux`);
			},
			runCommand: async () => {
				calls.push(["sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]]);
				return { code: 1, stdout: "", stderr: "expected test failure" };
			},
		});
		expect(installed).toBe(false);
		// The linux flow spawns `sh -c curl...`, never a brew path, and never calls resolvePath
		expect(calls).toEqual([["sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]]]);
	});
});
