import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBunRuntime, removeStaging, replaceResources, stageRuntime } from "./stage-runtime.mjs";

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

	it("restores the existing resources when the final swap fails", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const target = join(directory, "resources");
		const staged = join(directory, "staged");
		mkdirSync(target);
		mkdirSync(staged);
		writeFileSync(join(target, "marker"), "old\n");
		writeFileSync(join(staged, "marker"), "new\n");
		let renameCalls = 0;
		const failFinalSwap = (source, destination) => {
			renameCalls += 1;
			if (renameCalls === 2) throw new Error("injected final swap failure");
			renameSync(source, destination);
		};

		try {
			expect(() => replaceResources(target, staged, failFinalSwap)).toThrow("injected final swap failure");
			expect(readFileSync(join(target, "marker"), "utf8")).toBe("old\n");
			expect(readFileSync(join(staged, "marker"), "utf8")).toBe("new\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves resources created during a failed swap", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const target = join(directory, "resources");
		const staged = join(directory, "staged");
		mkdirSync(target);
		mkdirSync(staged);
		writeFileSync(join(target, "marker"), "old\n");
		writeFileSync(join(staged, "marker"), "new\n");
		let renameCalls = 0;
		const concurrentFinalSwap = (source, destination) => {
			renameCalls += 1;
			if (renameCalls === 2) {
				mkdirSync(destination);
				writeFileSync(join(destination, "marker"), "concurrent\n");
				throw new Error("injected final swap failure");
			}
			renameSync(source, destination);
		};

		try {
			expect(() => replaceResources(target, staged, concurrentFinalSwap)).toThrow(
				"Unable to restore previous desktop resources",
			);
			expect(readFileSync(join(target, "marker"), "utf8")).toBe("concurrent\n");
			const backups = readdirSync(directory).filter((entry) => entry.startsWith(".resources-backup-"));
			expect(backups).toHaveLength(1);
			expect(readFileSync(join(directory, backups[0], "resources", "marker"), "utf8")).toBe("old\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects a concurrent resource replacement", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const lock = join(directory, ".resources.lock");
		mkdirSync(lock);

		try {
			expect(() => replaceResources(join(directory, "resources"), join(directory, "staged"))).toThrow(
				"Desktop resources are already being replaced",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reclaims a resource lock from a dead owner", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const lock = join(directory, ".resources.lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), `${Number.MAX_SAFE_INTEGER}\n`);

		try {
			expect(() => replaceResources(join(directory, "resources"), join(directory, "staged"))).toThrow("ENOENT");
			expect(existsSync(lock)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reclaims an abandoned ownerless lock after its grace period", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const lock = join(directory, ".resources.lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), "");
		const stale = new Date(Date.now() - 61_000);
		utimesSync(lock, stale, stale);

		try {
			expect(() => replaceResources(join(directory, "resources"), join(directory, "staged"))).toThrow("ENOENT");
			expect(existsSync(lock)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps the backup when rollback also fails", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const target = join(directory, "resources");
		const staged = join(directory, "staged");
		mkdirSync(target);
		mkdirSync(staged);
		writeFileSync(join(target, "marker"), "old\n");
		writeFileSync(join(staged, "marker"), "new\n");
		let renameCalls = 0;
		const failRollback = (source, destination) => {
			renameCalls += 1;
			if (renameCalls >= 2) throw new Error("injected rename failure");
			renameSync(source, destination);
		};

		try {
			expect(() => replaceResources(target, staged, failRollback)).toThrow(
				"Unable to restore previous desktop resources",
			);
			const backups = readdirSync(directory).filter((entry) => entry.startsWith(".resources-backup-"));
			expect(backups).toHaveLength(1);
			expect(readFileSync(join(directory, backups[0], "resources", "marker"), "utf8")).toBe("old\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reports backup cleanup failures without hiding the installed resources", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const target = join(directory, "resources");
		const staged = join(directory, "staged");
		mkdirSync(target);
		mkdirSync(staged);
		writeFileSync(join(target, "marker"), "old\n");
		writeFileSync(join(staged, "marker"), "new\n");
		const failCleanup = () => {
			throw new Error("injected backup cleanup failure");
		};

		try {
			expect(() => replaceResources(target, staged, renameSync, failCleanup)).toThrow(
				"Unable to remove desktop resource backup",
			);
			expect(readFileSync(join(target, "marker"), "utf8")).toBe("new\n");
			const backups = readdirSync(directory).filter((entry) => entry.startsWith(".resources-backup-"));
			expect(backups).toHaveLength(1);
			expect(readFileSync(join(directory, backups[0], "resources", "marker"), "utf8")).toBe("old\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reports temporary cleanup failures without hiding the staged tree", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-stage-runtime-"));
		const failCleanup = () => {
			throw new Error("injected staging cleanup failure");
		};

		try {
			expect(() => removeStaging(directory, failCleanup)).toThrow("Unable to remove temporary desktop resources");
			expect(existsSync(directory)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
