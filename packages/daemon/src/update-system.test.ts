/**
 * Tests for update-system bug fixes.
 *
 * These tests exercise the exported pure/config functions directly.
 * Network-dependent functions (checkForUpdates, runUpdate) are tested
 * via structural assertions on the source code.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_UPDATE_INTERVAL_SECONDS,
	MIN_UPDATE_INTERVAL_SECONDS,
	categorizeUpdateError,
	normalizeTargetVersion,
	parseBooleanFlag,
	parseInstalledPackageVersion,
	parseUpdateInterval,
	verifyInstalledVersion,
} from "./update-system";

const UPDATE_SYSTEM_SRC = readFileSync(join(__dirname, "update-system.ts"), "utf-8");
const SERVICE_SRC = readFileSync(join(__dirname, "service.ts"), "utf-8");

function mustMatch(src: string, pattern: RegExp): string {
	const match = src.match(pattern);
	expect(match).not.toBeNull();
	if (!match) {
		throw new Error(`expected source to match ${pattern}`);
	}
	return match[0];
}

describe("Bug 5: pendingRestartVersion is set only after successful verification", () => {
	it("does not gate pendingRestartVersion on targetVersion", () => {
		const hasOldGuard = /if\s*\(\s*targetVersion\s*\)\s*\{?\s*\n?\s*pendingRestartVersion\s*=/.test(UPDATE_SYSTEM_SRC);
		expect(hasOldGuard).toBe(false);
	});

	it("sets pendingRestartVersion from verified installed version", () => {
		expect(UPDATE_SYSTEM_SRC).toContain("pendingRestartVersion = verification.installedVersion");
	});
});

describe("Issue 322: verify installed version after update install", () => {
	it("pins install command to targetVersion when provided", () => {
		expect(UPDATE_SYSTEM_SRC).toContain("const installPackage = normalizedTargetVersion");
		expect(UPDATE_SYSTEM_SRC).toContain("? `${NPM_PACKAGE}@${normalizedTargetVersion}`");
	});

	it("verifies installed package version after exit code 0", () => {
		expect(UPDATE_SYSTEM_SRC).toContain("verifyInstalledVersion(");
		expect(UPDATE_SYSTEM_SRC).toContain("Install exited cleanly but version is");
		expect(UPDATE_SYSTEM_SRC).toContain("resolveGlobalPackagePath");
	});
});

describe("verifyInstalledVersion", () => {
	const noopResolver = (_family: "bun" | "npm" | "pnpm" | "yarn", _packageName: string) => undefined;

	it("fails when global package path cannot be resolved", () => {
		const result = verifyInstalledVersion("bun", "signetai", "0.78.1", {
			resolveGlobalPackagePath: noopResolver,
			existsSync: () => true,
			readFileSync: (_path, _encoding) => '{"version":"0.78.1"}',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("could not locate global package path");
		}
	});

	it("fails when package.json is missing", () => {
		const result = verifyInstalledVersion("bun", "signetai", "0.78.1", {
			resolveGlobalPackagePath: (_family, _packageName) => "/tmp/signetai",
			existsSync: () => false,
			readFileSync: (_path, _encoding) => '{"version":"0.78.1"}',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("package manifest missing");
		}
	});

	it("fails when installed version does not match expected target", () => {
		const result = verifyInstalledVersion("bun", "signetai", "0.78.1", {
			resolveGlobalPackagePath: (_family, _packageName) => "/tmp/signetai",
			existsSync: () => true,
			readFileSync: (_path, _encoding) => '{"version":"0.78.0"}',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("version is 0.78.0, expected 0.78.1");
		}
	});

	it("fails when installed package.json version is not exact semver", () => {
		const result = verifyInstalledVersion("bun", "signetai", null, {
			resolveGlobalPackagePath: (_family, _packageName) => "/tmp/signetai",
			existsSync: () => true,
			readFileSync: (_path, _encoding) => '{"version":"latest"}',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("installed package.json has no valid version");
		}
	});

	it("fails gracefully when manifest read throws", () => {
		const result = verifyInstalledVersion("bun", "signetai", null, {
			resolveGlobalPackagePath: (_family, _packageName) => "/tmp/signetai",
			existsSync: () => true,
			readFileSync: (_path, _encoding) => {
				throw new Error("EACCES: permission denied");
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("failed to verify installed version");
			expect(result.message).toContain("EACCES");
		}
	});

	it("succeeds and returns installed version when verification passes", () => {
		const result = verifyInstalledVersion("bun", "signetai", "0.78.1", {
			resolveGlobalPackagePath: (_family, _packageName) => "/tmp/signetai",
			existsSync: () => true,
			readFileSync: (_path, _encoding) => '{"version":"0.78.1"}',
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.installedVersion).toBe("0.78.1");
		}
	});
});

describe("Bug 3: auto-restart after successful install", () => {
	it("calls process.exit(0) in runAutoUpdateCycle after success", () => {
		// Extract the runAutoUpdateCycle function body
		const cycleBody = mustMatch(UPDATE_SYSTEM_SRC, /async function runAutoUpdateCycle[\s\S]*?^}/m);

		// Must contain process.exit(0) for auto-restart
		expect(cycleBody).toContain("process.exit(0)");
		// Must stop the timer before exiting
		expect(cycleBody).toContain("stopUpdateTimer()");
		// Exit should come after successful install check
		expect(cycleBody.indexOf("installResult.success")).toBeLessThan(cycleBody.indexOf("process.exit(0)"));
	});
});

describe("Bug 4: log level for disabled auto-updates", () => {
	it("uses logger.info (not debug) when auto-updates disabled", () => {
		// Find the startUpdateTimer function
		const timerBody = mustMatch(UPDATE_SYSTEM_SRC, /export function startUpdateTimer[\s\S]*?^}/m);

		// Should use info level, not debug
		expect(timerBody).not.toContain('logger.debug("system", "Auto-update disabled"');
		expect(timerBody).toContain("logger.info");
		expect(timerBody).toContain("signet update enable");
	});
});

describe("Bug 6: systemd unit uses dynamic runtime path", () => {
	it("does not hardcode /usr/bin/bun in systemd unit", () => {
		// The function generateSystemdUnit should NOT have a hardcoded path
		const hasHardcoded = SERVICE_SRC.includes('runtime === "bun" ? "/usr/bin/bun" : "/usr/bin/node"');
		expect(hasHardcoded).toBe(false);
	});

	it("does not hardcode /opt/homebrew/bin/bun in launchd plist", () => {
		const hasHardcoded = SERVICE_SRC.includes("/opt/homebrew/bin/bun");
		expect(hasHardcoded).toBe(false);
	});

	it("uses resolveRuntimePath() for both service types", () => {
		expect(SERVICE_SRC).toContain("function resolveRuntimePath()");
		// systemd
		expect(SERVICE_SRC).toMatch(/const runtimePath = resolveRuntimePath\(\)/);
		// launchd
		expect(SERVICE_SRC).toContain("${resolveRuntimePath()}");
	});

	it("resolveRuntimePath tries process.execPath first", () => {
		const fnBody = mustMatch(SERVICE_SRC, /function resolveRuntimePath[\s\S]*?^}/m);
		expect(fnBody).toContain("process.execPath");
		expect(fnBody).toContain('const locator = platform() === "win32" ? "where" : "which"');
		expect(fnBody).toContain("${locator} bun");
		expect(fnBody).toContain("${locator} node");
	});

	it("uses Restart=always instead of Restart=on-failure", () => {
		const unitBody = mustMatch(SERVICE_SRC, /function generateSystemdUnit[\s\S]*?^}/m);
		expect(unitBody).toContain("Restart=always");
		expect(unitBody).not.toContain("Restart=on-failure");
	});
});

describe("version parsing helpers", () => {
	it("normalizeTargetVersion strips leading v and validates format", () => {
		expect(normalizeTargetVersion("1.2.3")).toBe("1.2.3");
		expect(normalizeTargetVersion("v1.2.3")).toBe("1.2.3");
		expect(normalizeTargetVersion("V2.0.0-rc.1+build.7")).toBe("2.0.0-rc.1+build.7");
		expect(normalizeTargetVersion("latest")).toBeNull();
		expect(normalizeTargetVersion("1.2.x")).toBeNull();
		expect(normalizeTargetVersion("")).toBeNull();
		expect(normalizeTargetVersion("   ")).toBeNull();
		expect(normalizeTargetVersion("--1.2.3")).toBeNull();
		expect(normalizeTargetVersion("1.2.3 bad")).toBeNull();
	});

	it("parseInstalledPackageVersion extracts version from package.json", () => {
		expect(parseInstalledPackageVersion('{"name":"signetai","version":"0.78.1"}')).toBe("0.78.1");
		expect(parseInstalledPackageVersion('{"name":"signetai","version":"   "}')).toBeNull();
		expect(parseInstalledPackageVersion('{"name":"signetai","version":"latest"}')).toBeNull();
		expect(parseInstalledPackageVersion('{"name":"signetai","version":"1.2.x"}')).toBeNull();
		expect(parseInstalledPackageVersion('{"name":"signetai"}')).toBeNull();
		expect(parseInstalledPackageVersion("not-json")).toBeNull();
	});
});

describe("config helpers", () => {
	it("parseBooleanFlag handles all cases", () => {
		expect(parseBooleanFlag(true)).toBe(true);
		expect(parseBooleanFlag(false)).toBe(false);
		expect(parseBooleanFlag("true")).toBe(true);
		expect(parseBooleanFlag("false")).toBe(false);
		expect(parseBooleanFlag("maybe")).toBeNull();
		expect(parseBooleanFlag(42)).toBeNull();
	});

	it("parseUpdateInterval enforces bounds", () => {
		expect(parseUpdateInterval(MIN_UPDATE_INTERVAL_SECONDS)).toBe(MIN_UPDATE_INTERVAL_SECONDS);
		expect(parseUpdateInterval(MAX_UPDATE_INTERVAL_SECONDS)).toBe(MAX_UPDATE_INTERVAL_SECONDS);
		expect(parseUpdateInterval(100)).toBeNull(); // Below min
		expect(parseUpdateInterval(999999999)).toBeNull(); // Above max
		expect(parseUpdateInterval("not a number")).toBeNull();
	});

	it("categorizeUpdateError classifies known patterns", () => {
		expect(categorizeUpdateError("403 Forbidden")).toContain("rate limit");
		expect(categorizeUpdateError("ENOTFOUND")).toContain("internet");
		expect(categorizeUpdateError("EACCES")).toContain("Permission");
		expect(categorizeUpdateError("timeout")).toContain("timed out");
		expect(categorizeUpdateError("something else")).toBe("something else");
	});
});
