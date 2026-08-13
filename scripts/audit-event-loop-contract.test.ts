import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runAudit, type AllowlistEntry } from "./audit-event-loop-contract";

test("event-loop audit rejects a new synchronous hot-path call", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		mkdirSync(join(root, "routes"));
		writeFileSync(
			join(root, "routes", "new-route.ts"),
			"getDbAccessor().withReadDb((db) => db.prepare('SELECT 1').all());\n",
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.message).toContain("routes/new-route.ts:1");
		expect(result.violations[0]?.message).toContain("withReadDb");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("event-loop audit accepts a classified bootstrap exception", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		writeFileSync(join(root, "bootstrap.ts"), "existsSync('/tmp/signet-bootstrap');\n");
		const allowlist: AllowlistEntry[] = [
			{
				path: "bootstrap.ts",
				api: "existsSync",
				category: "pre-readiness-bootstrap",
				reason: "Checks the workspace directory before the daemon serves requests.",
			},
		];
		const result = runAudit({ sourceRoot: root, allowlist });
		expect(result.violations).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
