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

test("event-loop audit detects multiline synchronous calls and ignores literals/comments", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		writeFileSync(
			join(root, "hot-path.ts"),
			[
				'const text = "readFileSync( .withReadDb( .withWriteTx(";',
				"/* readFileSync( .withReadDb( .withWriteTx( */",
				"getDbAccessor()",
				"\t.withReadDb((db) => db);",
				"accessor",
				"\t.withWriteTx((db) => db);",
				"readFileSync",
				'	(path, "utf8");',
			].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.sites.map(({ api, line }) => ({ api, line }))).toEqual([
			{ api: "withReadDb", line: 4 },
			{ api: "withWriteTx", line: 6 },
			{ api: "readFileSync", line: 7 },
		]);
		expect(result.violations).toHaveLength(3);
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
