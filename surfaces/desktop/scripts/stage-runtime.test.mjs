import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBunRuntime, stageRuntime } from "./stage-runtime.mjs";

describe("stage-runtime Bun validation", () => {
	it("rejects an architecture-mismatched staged runtime", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const runtimePath = join(directory, "bun");
		try {
			writeFileSync(runtimePath, "fake bun runtime\n");
			chmodSync(runtimePath, 0o755);

			expect(() => assertBunRuntime(runtimePath, "arm64", "linux", () => ({ platform: "linux", arch: "x64" }))).toThrow(
				"Bun runtime architecture mismatch: expected arm64, got x64",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects a foreign target before resolving a host runtime", () => {
		const previousPlatform = process.env.ELECTRON_BUILDER_PLATFORM;
		const previousArch = process.env.ELECTRON_BUILDER_ARCH;
		const foreignPlatform = process.platform === "win32" ? "linux" : "win32";
		process.env.ELECTRON_BUILDER_PLATFORM = foreignPlatform;
		process.env.ELECTRON_BUILDER_ARCH = process.arch;
		try {
			expect(() => stageRuntime()).toThrow("Desktop runtime staging requires a native");
		} finally {
			if (previousPlatform === undefined) delete process.env.ELECTRON_BUILDER_PLATFORM;
			else process.env.ELECTRON_BUILDER_PLATFORM = previousPlatform;
			if (previousArch === undefined) delete process.env.ELECTRON_BUILDER_ARCH;
			else process.env.ELECTRON_BUILDER_ARCH = previousArch;
		}
	});

	it("rejects a foreign target architecture before resolving a host runtime", () => {
		const previousPlatform = process.env.ELECTRON_BUILDER_PLATFORM;
		const previousArch = process.env.ELECTRON_BUILDER_ARCH;
		const foreignArch = process.arch === "x64" ? "arm64" : "x64";
		process.env.ELECTRON_BUILDER_PLATFORM = process.platform;
		process.env.ELECTRON_BUILDER_ARCH = foreignArch;
		try {
			expect(() => stageRuntime()).toThrow("Desktop runtime staging requires a native");
		} finally {
			if (previousPlatform === undefined) delete process.env.ELECTRON_BUILDER_PLATFORM;
			else process.env.ELECTRON_BUILDER_PLATFORM = previousPlatform;
			if (previousArch === undefined) delete process.env.ELECTRON_BUILDER_ARCH;
			else process.env.ELECTRON_BUILDER_ARCH = previousArch;
		}
	});
});
