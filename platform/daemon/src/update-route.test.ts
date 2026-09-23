/**
 * Bug 7: /api/update/run accepts targetVersion in body to skip redundant check.
 * Bug 1: CLI passes timeout + targetVersion to the route.
 *
 * These are structural tests that verify the code shape is correct.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DAEMON_SRC = readFileSync(join(__dirname, "routes/misc-routes.ts"), "utf-8");

// Read the update command source, where the daemon call now lives.
const CLI_SRC = readFileSync(join(__dirname, "../../../surfaces/cli/src/commands/update.ts"), "utf-8");

function mustMatch(src: string, pattern: RegExp): string {
	const match = src.match(pattern);
	expect(match).not.toBeNull();
	if (!match) {
		throw new Error(`expected source to match ${pattern}`);
	}
	return match[0];
}

describe("Bug 7: /api/update/run accepts targetVersion in body", () => {
	it("reads targetVersion from request body", () => {
		const routeBody = mustMatch(DAEMON_SRC, /app\.post\("\/api\/update\/run"[\s\S]*?\}\);/);

		// Should parse targetVersion from body
		expect(routeBody).toContain("targetVersion");
		expect(routeBody).toContain("c.req.json");
	});

	it("skips checkForUpdatesImpl when targetVersion is provided", () => {
		const routeBody = mustMatch(DAEMON_SRC, /app\.post\("\/api\/update\/run"[\s\S]*?\}\);/);

		// The check should be conditional on !targetVersion
		expect(routeBody).toContain("if (!targetVersion)");
		// checkForUpdatesImpl should appear inside the conditional, not before it
		const conditionalIdx = routeBody.indexOf("if (!targetVersion)");
		const checkIdx = routeBody.indexOf("checkForUpdatesImpl()");
		expect(checkIdx).toBeGreaterThan(conditionalIdx);
	});
});

describe("update channel config route", () => {
	it("accepts and validates channel updates", () => {
		const routeBody = mustMatch(DAEMON_SRC, /app\.post\("\/api\/update\/config"[\s\S]*?\}\);/);
		expect(routeBody).toContain("channelRaw");
		expect(routeBody).toContain("parseUpdateChannel(channelRaw)");
		expect(routeBody).toContain("channel must be stable or nightly");
		expect(routeBody).toContain("setUpdateConfig({ autoInstall, checkInterval, channel");
	});
});

describe("Bug 1: CLI gives update/run enough time for desktop refresh", () => {
	it("fetchFromDaemon for /api/update/run uses the shared install timeout", () => {
		// Find the update install section — look for the POST to update/run
		const callSite = mustMatch(CLI_SRC, /fetchFromDaemon[\s\S]*?\/api\/update\/run[\s\S]*?\);/);
		expect(CLI_SRC).toContain("const UPDATE_INSTALL_TIMEOUT_MS = 15 * 60_000");
		expect(callSite).toContain("UPDATE_INSTALL_TIMEOUT_MS");
		expect(callSite).toContain('method: "POST"');
	});

	it("CLI sends targetVersion in request body", () => {
		const callSite = mustMatch(CLI_SRC, /fetchFromDaemon[\s\S]*?\/api\/update\/run[\s\S]*?\);/);

		expect(callSite).toContain("targetVersion");
		expect(callSite).toContain("JSON.stringify");
		expect(callSite).toContain("Content-Type");
	});

	it("CLI reports skipped desktop refresh reasons", () => {
		expect(CLI_SRC).toContain('data.desktopUpdate?.status === "skipped"');
		expect(CLI_SRC).toContain("Desktop: ${data.desktopUpdate.message}");
	});

	it("CLI exposes stable/nightly update channel management", () => {
		expect(CLI_SRC).toContain('.command("channel [channel]")');
		expect(CLI_SRC).toContain("stable = default tested releases");
		expect(CLI_SRC).toContain("Nightly tracks @next builds");
	});
});
