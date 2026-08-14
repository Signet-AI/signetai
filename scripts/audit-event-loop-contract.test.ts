import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
	occurrenceKeys,
	parseAllowlist,
	runAudit,
	type AllowlistEntry,
	type AuditSite,
} from "./audit-event-loop-contract";

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

test("event-loop audit counts a second same-line call beyond the baseline", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		const source = "getDbAccessor().withReadDb((db) => db); getDbAccessor().withReadDb((db) => db);\n";
		writeFileSync(join(root, "same-line.ts"), source);
		const result = runAudit({
			sourceRoot: root,
			baselineSites: [
				{
					path: "same-line.ts",
					line: 1,
					api: "withReadDb",
					source: source.trim(),
					category: "hot-path",
				},
			],
		});
		expect(result.sites).toHaveLength(2);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.line).toBe(1);
		expect(result.violations[0]?.api).toBe("withReadDb");
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
		writeFileSync(
			join(root, "db-accessor.ts"),
			"function initDbAccessor() { return existsSync('/tmp/signet-bootstrap'); }\n",
		);
		const allowlist: AllowlistEntry[] = [
			{
				path: "db-accessor.ts",
				line: 1,
				api: "existsSync",
				category: "pre-readiness-bootstrap",
				source: "function initDbAccessor() { return existsSync('/tmp/signet-bootstrap'); }",
				reason: "Checks the workspace directory before the daemon serves requests.",
			},
		];
		const result = runAudit({ sourceRoot: root, allowlist });
		expect(result.violations).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("event-loop audit rejects a hot-path call mislabeled as an isolated exception", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		mkdirSync(join(root, "routes"));
		const source = "getDbAccessor().withReadDb((db) => db);\n";
		writeFileSync(join(root, "routes", "new-route.ts"), source);
		const allowlist: AllowlistEntry[] = [
			{
				path: "routes/new-route.ts",
				line: 1,
				api: "withReadDb",
				category: "isolated-worker",
				source: "getDbAccessor().withReadDb((db) => db);",
				reason: "The route does not serve requests in the isolated worker.",
			},
		];
		expect(() => runAudit({ sourceRoot: root, allowlist })).toThrow("Allowlist classification mismatch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("event-loop audit baseline is an exact, pinned, deterministic production inventory", () => {
	const productionSourceRoot = resolve(import.meta.dir, "..", "platform/daemon/src");
	const baseline = JSON.parse(readFileSync(resolve(import.meta.dir, "event-loop-contract-baseline.json"), "utf8")) as {
		version: 1;
		generatedFrom: string;
		sites: AuditSite[];
	};
	const allowlist = parseAllowlist(readFileSync(resolve(import.meta.dir, "event-loop-contract-allowlist.txt"), "utf8"));
	const first = runAudit({ sourceRoot: productionSourceRoot, baselineSites: baseline.sites, allowlist });
	const second = runAudit({ sourceRoot: productionSourceRoot, baselineSites: baseline.sites, allowlist });

	// No new or missed sites: every live production call site is covered by the baseline.
	expect(first.violations).toEqual([]);
	// No stale baseline entries: the committed baseline is an exact occurrence inventory, not a superset.
	// This is the regression that lets a legacy over-count (1057 with two comment-only false positives)
	// silently pass CI while the live scan reports fewer sites.
	expect(occurrenceKeys(baseline.sites)).toEqual(occurrenceKeys(first.sites));
	// The truthful pinned count (1057 legacy - 2 comment-only false positives + 1 same-line call = 1056).
	expect(first.sites).toHaveLength(1056);
	// Deterministic ordering and content: repeated runs of the full scan are byte-identical.
	expect(JSON.stringify(second.sites)).toBe(JSON.stringify(first.sites));
});
