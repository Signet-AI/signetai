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
const CLI_SRC = readFileSync(join(__dirname, "../../cli/src/commands/update.ts"), "utf-8");

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

describe("Bug 1: CLI passes 120s timeout to update/run", () => {
	it("fetchFromDaemon for /api/update/run has 120s timeout", () => {
		// Find the update install section — look for the POST to update/run
		const callSite = mustMatch(CLI_SRC, /fetchFromDaemon[\s\S]*?\/api\/update\/run[\s\S]*?\);/);
		expect(callSite).toContain("120_000");
		expect(callSite).toContain('method: "POST"');
	});

	it("CLI sends targetVersion in request body", () => {
		const callSite = mustMatch(CLI_SRC, /fetchFromDaemon[\s\S]*?\/api\/update\/run[\s\S]*?\);/);

		expect(callSite).toContain("targetVersion");
		expect(callSite).toContain("JSON.stringify");
		expect(callSite).toContain("Content-Type");
	});
});
