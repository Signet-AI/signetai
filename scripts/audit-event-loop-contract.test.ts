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

test("event-loop audit detects an unlisted accessSync call", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		writeFileSync(join(root, "hot-path.ts"), "accessSync('/tmp/signet-access');\n");
		const result = runAudit({ sourceRoot: root });
		expect(result.sites).toHaveLength(1);
		expect(result.sites[0]?.api).toBe("accessSync");
		expect(result.sites[0]?.category).toBe("hot-path");
		expect(result.violations).toHaveLength(1);
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

test("event-loop audit rejects a request-path call allowlisted in a mixed bootstrap file", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		const source = [
			"function initDbAccessor() { return existsSync('/tmp/signet-bootstrap'); }",
			"export function requestPath() { return readFileSync('/tmp/signet-request', 'utf8'); }",
			"",
		].join("\n");
		writeFileSync(join(root, "db-accessor.ts"), source);
		expect(() =>
			runAudit({
				sourceRoot: root,
				baselineSites: [
					{
						path: "db-accessor.ts",
						line: 1,
						api: "existsSync",
						source: source.split("\n")[0] ?? "",
						category: "pre-readiness-bootstrap",
					},
				],
				allowlist: [
					{
						path: "db-accessor.ts",
						line: 2,
						api: "readFileSync",
						category: "pre-readiness-bootstrap",
						source: source.split("\n")[1] ?? "",
						reason: "This request path is incorrectly treated as startup-only.",
					},
				],
			}),
		).toThrow("Allowlist classification mismatch");
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

test("event-loop audit rejects a helper shared by bootstrap and request paths", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		const source = [
			"function initDbAccessor() { return shared(); }",
			"export function requestPath() { return shared(); }",
			"function shared() { return readFileSync('/tmp/signet-shared', 'utf8'); }",
			"",
		].join("\n");
		writeFileSync(join(root, "db-accessor.ts"), source);
		const result = runAudit({ sourceRoot: root });
		expect(result.sites).toHaveLength(1);
		expect(result.sites[0]?.category).toBe("hot-path");
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.message).toContain("hot-path");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("event-loop audit does not let a baseline category authorize a hot-path call", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		const source = [
			"function initDbAccessor() { return existsSync('/tmp/signet-bootstrap'); }",
			"export function requestPath() { return existsSync('/tmp/signet-request'); }",
			"",
		].join("\n");
		writeFileSync(join(root, "db-accessor.ts"), source);
		const result = runAudit({
			sourceRoot: root,
			baselineSites: [
				{
					path: "db-accessor.ts",
					line: 2,
					api: "existsSync",
					source: source.split("\n")[1] ?? "",
					category: "pre-readiness-bootstrap",
				},
			],
		});
		expect(result.sites[1]?.category).toBe("hot-path");
		expect(result.violations).toHaveLength(2);
		expect(result.violations[1]?.line).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("event-loop audit detects destructured DbAccessor sync methods", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-audit-"));
	try {
		writeFileSync(join(root, "destructured.ts"), "const { withReadDb } = getDbAccessor();\nwithReadDb((db) => db);\n");
		const result = runAudit({ sourceRoot: root });
		expect(result.sites).toHaveLength(1);
		expect(result.sites[0]?.api).toBe("withReadDb");
		expect(result.violations).toHaveLength(1);
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
	// The occurrence-accurate baseline was 1056 before the accessSync coverage and current-main inventory changes.
	expect(first.sites).toHaveLength(1061);
	// Deterministic ordering and content: repeated runs of the full scan are byte-identical.
	expect(JSON.stringify(second.sites)).toBe(JSON.stringify(first.sites));
});
