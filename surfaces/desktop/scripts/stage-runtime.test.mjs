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
import { assertNativeDaemon, nativeDaemonPath, removeStaging, replaceResources } from "./stage-runtime.mjs";

describe("stage-runtime resource replacement", () => {
	it("resolves only the native platform/architecture daemon artifact", () => {
		expect(nativeDaemonPath("linux", "x64")).toContain("rust-daemon/linux-x64/signet-daemon");
		expect(nativeDaemonPath("win32", "arm64")).toContain("rust-daemon/win32-arm64/signet-daemon.exe");
	});

	it("fails closed when the native daemon artifact is missing", () => {
		expect(() => assertNativeDaemon(join(tmpdir(), "signet-missing-native-daemon"))).toThrow(
			"Rust daemon artifact not found",
		);
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
