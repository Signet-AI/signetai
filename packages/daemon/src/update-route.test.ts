/**
 * Bug 7: /api/update/run accepts targetVersion in body to skip redundant check.
 * Bug 1: CLI passes timeout + targetVersion to the route.
 *
 * These are structural tests that verify the code shape is correct.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DAEMON_SRC = readFileSync(
	join(__dirname, "daemon.ts"),
	"utf-8",
);

// Read CLI source relative to monorepo
const CLI_SRC = readFileSync(
	join(__dirname, "../../cli/src/cli.ts"),
	"utf-8",
);

describe("Bug 7: /api/update/run accepts targetVersion in body", () => {
	it("reads targetVersion from request body", () => {
		// Find the route handler
		const routeMatch = DAEMON_SRC.match(
			/app\.post\("\/api\/update\/run"[\s\S]*?\n\}\);/,
		);
		expect(routeMatch).not.toBeNull();

		const routeBody = routeMatch![0];

		// Should parse targetVersion from body
		expect(routeBody).toContain("targetVersion");
		expect(routeBody).toContain("c.req.json");
	});

	it("skips checkForUpdatesImpl when targetVersion is provided", () => {
		const routeMatch = DAEMON_SRC.match(
			/app\.post\("\/api\/update\/run"[\s\S]*?\n\}\);/,
		);
		const routeBody = routeMatch![0];

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
		const updateRunMatch = CLI_SRC.match(
			/fetchFromDaemon[\s\S]*?\/api\/update\/run[\s\S]*?\);/,
		);
		expect(updateRunMatch).not.toBeNull();

		const callSite = updateRunMatch![0];
		expect(callSite).toContain("120_000");
		expect(callSite).toContain("method: \"POST\"");
	});

	it("CLI sends targetVersion in request body", () => {
		const updateRunMatch = CLI_SRC.match(
			/fetchFromDaemon[\s\S]*?\/api\/update\/run[\s\S]*?\);/,
		);
		const callSite = updateRunMatch![0];

		expect(callSite).toContain("targetVersion");
		expect(callSite).toContain("JSON.stringify");
		expect(callSite).toContain("Content-Type");
	});
});
