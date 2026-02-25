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
	parseBooleanFlag,
	parseUpdateInterval,
	MIN_UPDATE_INTERVAL_SECONDS,
	MAX_UPDATE_INTERVAL_SECONDS,
	categorizeUpdateError,
} from "./update-system";

const UPDATE_SYSTEM_SRC = readFileSync(
	join(__dirname, "update-system.ts"),
	"utf-8",
);
const SERVICE_SRC = readFileSync(join(__dirname, "service.ts"), "utf-8");

describe("Bug 5: pendingRestartVersion always set on success", () => {
	it("sets pendingRestartVersion unconditionally (no targetVersion guard)", () => {
		// The old code: `if (targetVersion) { pendingRestartVersion = targetVersion; }`
		// The fix: `pendingRestartVersion = targetVersion ?? "unknown";`
		const hasOldGuard = /if\s*\(\s*targetVersion\s*\)\s*\{?\s*\n?\s*pendingRestartVersion\s*=/.test(
			UPDATE_SYSTEM_SRC,
		);
		expect(hasOldGuard).toBe(false);

		// Verify the new unconditional assignment exists
		const hasUnconditionalSet =
			UPDATE_SYSTEM_SRC.includes('pendingRestartVersion = targetVersion ?? "unknown"');
		expect(hasUnconditionalSet).toBe(true);
	});
});

describe("Bug 3: auto-restart after successful install", () => {
	it("calls process.exit(0) in runAutoUpdateCycle after success", () => {
		// Extract the runAutoUpdateCycle function body
		const cycleMatch = UPDATE_SYSTEM_SRC.match(
			/async function runAutoUpdateCycle[\s\S]*?^}/m,
		);
		expect(cycleMatch).not.toBeNull();

		const cycleBody = cycleMatch![0];

		// Must contain process.exit(0) for auto-restart
		expect(cycleBody).toContain("process.exit(0)");
		// Must stop the timer before exiting
		expect(cycleBody).toContain("stopUpdateTimer()");
		// Exit should come after successful install check
		expect(cycleBody.indexOf("installResult.success")).toBeLessThan(
			cycleBody.indexOf("process.exit(0)"),
		);
	});
});

describe("Bug 4: log level for disabled auto-updates", () => {
	it("uses logger.info (not debug) when auto-updates disabled", () => {
		// Find the startUpdateTimer function
		const timerMatch = UPDATE_SYSTEM_SRC.match(
			/export function startUpdateTimer[\s\S]*?^}/m,
		);
		expect(timerMatch).not.toBeNull();

		const timerBody = timerMatch![0];

		// Should use info level, not debug
		expect(timerBody).not.toContain('logger.debug("system", "Auto-update disabled"');
		expect(timerBody).toContain("logger.info");
		expect(timerBody).toContain("signet update enable");
	});
});

describe("Bug 6: systemd unit uses dynamic runtime path", () => {
	it("does not hardcode /usr/bin/bun in systemd unit", () => {
		// The function generateSystemdUnit should NOT have a hardcoded path
		const hasHardcoded = SERVICE_SRC.includes(
			'runtime === "bun" ? "/usr/bin/bun" : "/usr/bin/node"',
		);
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
		const fnMatch = SERVICE_SRC.match(
			/function resolveRuntimePath[\s\S]*?^}/m,
		);
		expect(fnMatch).not.toBeNull();

		const fnBody = fnMatch![0];
		expect(fnBody).toContain("process.execPath");
		expect(fnBody).toContain("which bun");
		expect(fnBody).toContain("which node");
	});

	it("uses Restart=always instead of Restart=on-failure", () => {
		const unitMatch = SERVICE_SRC.match(
			/function generateSystemdUnit[\s\S]*?^}/m,
		);
		expect(unitMatch).not.toBeNull();

		const unitBody = unitMatch![0];
		expect(unitBody).toContain("Restart=always");
		expect(unitBody).not.toContain("Restart=on-failure");
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
		expect(parseUpdateInterval(MIN_UPDATE_INTERVAL_SECONDS)).toBe(
			MIN_UPDATE_INTERVAL_SECONDS,
		);
		expect(parseUpdateInterval(MAX_UPDATE_INTERVAL_SECONDS)).toBe(
			MAX_UPDATE_INTERVAL_SECONDS,
		);
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
