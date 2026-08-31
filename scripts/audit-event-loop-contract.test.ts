import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import ts from "typescript";
import {
	evaluateCountRatchet,
	findStaleBaselineSites,
	loadBaseline,
	loadCountBaseline,
	occurrenceKeys,
	runAudit,
	renderReport,
	type LegacyDbCountBaseline,
} from "./audit-event-loop-contract";

test("the deterministic ledger retains the exact current source inventory", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	expect(baseline).toHaveLength(870);
	expect(baseline.filter((site) => site.api === "withWriteTx")).toHaveLength(65);
	expect(baseline.filter((site) => site.api === "withReadDb")).toHaveLength(99);
	expect(baseline.filter((site) => site.api === "withWriteTxAsync")).toHaveLength(40);
	expect(baseline.filter((site) => site.api === "withWriteDbAsync")).toHaveLength(0);
	expect(baseline.filter((site) => site.api === "withReadDbAsync")).toHaveLength(141);
});

test("the event-loop ledger exactly equals the current source inventory", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	const result = runAudit({ sourceRoot: resolve("platform/daemon/src"), baselineSites: baseline });
	expect(result.sites).toEqual(baseline);
});

test("classifies database callbacks by execution home rather than async API spelling", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-execution-home-"));
	try {
		const call = (path: string): string => `getDbAccessor().withReadDbAsync((db) => db, { siteToken: "${path}:1" });\n`;
		writeFileSync(join(root, "parent.ts"), call("parent.ts"));
		writeFileSync(join(root, "db-owner-worker.ts"), call("db-owner-worker.ts"));
		const first = runAudit({ sourceRoot: root });
		expect(first.executionHome).toEqual({ total: 2, onParent: 1, offParent: 1 });
		expect(first.executionHomeSites.map((site) => [site.path, site.executionHome])).toEqual([
			["db-owner-worker.ts", "off-parent"],
			["parent.ts", "on-parent"],
		]);
		expect(first.violations.filter((violation) => violation.kind === "new-parent-execution-site")).toHaveLength(1);
		writeFileSync(join(root, "new-parent.ts"), call("new-parent.ts"));
		const second = runAudit({
			sourceRoot: root,
			baselineSites: first.sites.filter((site) => site.path !== "new-parent.ts"),
		});
		expect(second.violations.filter((violation) => violation.kind === "new-parent-execution-site")).toEqual([
			expect.objectContaining({ path: "new-parent.ts", api: "withReadDbAsync" }),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the ledger reports legacy DB markers and rejects new call sites", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-ledger-"));
	try {
		writeFileSync(
			join(root, "legacy.ts"),
			[
				"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site",
				'getDbAccessor().withReadDb((db) => db, "legacy.ts:2");',
				"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site",
				'getDbAccessor().withWriteTx((db) => db, "legacy.ts:4");',
			].join("\n"),
		);
		writeFileSync(
			join(root, "new-call.ts"),
			'// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site\ngetDbAccessor().withReadDb((db) => db, "new-call.ts:2");\n',
		);
		const result = runAudit({
			sourceRoot: root,
			baselineSites: [
				{
					path: "legacy.ts",
					line: 2,
					api: "withReadDb",
					source: 'getDbAccessor().withReadDb((db) => db, "legacy.ts:2");',
					category: "hot-path",
				},
				{
					path: "legacy.ts",
					line: 4,
					api: "withWriteTx",
					source: 'getDbAccessor().withWriteTx((db) => db, "legacy.ts:4");',
					category: "hot-path",
				},
			],
		});
		expect(result.legacyDbAccess).toEqual({ total: 3, withWriteTx: 1, withReadDb: 2 });
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.path).toBe("new-call.ts");
		expect(result.violations[0]?.message).toContain("cannot authorize new callers");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the ledger rejects a replacement call at the same path and API", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-ledger-"));
	try {
		const replacement = 'getDbAccessor().withReadDb((db) => db.prepare("SELECT 1"));';
		writeFileSync(join(root, "legacy.ts"), `${replacement}\n`);
		const baseline = [
			{
				path: "legacy.ts",
				line: 1,
				api: "withReadDb" as const,
				source: "getDbAccessor().withReadDb((db) => db);",
				category: "hot-path" as const,
			},
		];
		const result = runAudit({ sourceRoot: root, baselineSites: baseline });
		const kinds = result.violations.map((violation) => violation.kind);
		// The replacement call is both beyond the ledger and unmarked.
		expect(kinds).toContain("new-legacy-db-access");
		expect(kinds).toContain("unmarked-legacy-db-access");
		expect(result.violations[0]?.path).toBe("legacy.ts");
		expect(occurrenceKeys(result.sites)).not.toEqual(occurrenceKeys(baseline));
		expect(findStaleBaselineSites(result.sites, baseline)).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a marked legacy DB call without a site token fails the attribution coverage rule", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-legacy-site-token-"));
	try {
		writeFileSync(
			join(root, "missing-token.ts"),
			"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site\ngetDbAccessor().withReadDb((db) => db);\n",
		);
		const result = runAudit({ sourceRoot: root });
		const violation = result.violations.find((item) => item.kind === "missing-legacy-db-site-token");
		expect(violation?.path).toBe("missing-token.ts");
		expect(violation?.message).toContain('"missing-token.ts:2"');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a tokenless async-named DB call fails the attribution coverage rule", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-async-site-token-"));
	try {
		writeFileSync(join(root, "missing-token.ts"), "getDbAccessor().withReadDbAsync((db) => db);\n");
		const result = runAudit({ sourceRoot: root });
		const violation = result.violations.find((item) => item.kind === "missing-async-db-site-token");
		expect(violation?.path).toBe("missing-token.ts");
		expect(violation?.api).toBe("withReadDbAsync");
		expect(violation?.message).toContain('"missing-token.ts:1"');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the scanner detects literal bracket access to legacy DB APIs", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-ledger-"));
	try {
		writeFileSync(join(root, "bracket.ts"), 'getDbAccessor()["withReadDb"]((db) => db);\n');
		const result = runAudit({ sourceRoot: root });
		expect(result.sites).toHaveLength(1);
		expect(result.sites[0]?.api).toBe("withReadDb");
		// Bracket access without a marker is both beyond the ledger and unmarked.
		expect(result.violations).toHaveLength(2);
		expect(result.violations.map((violation) => violation.kind)).toContain("new-legacy-db-access");
		expect(result.violations.map((violation) => violation.kind)).toContain("unmarked-legacy-db-access");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CI boundary rejects a production import of the sync compatibility module", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-boundary-"));
	try {
		mkdirSync(join(root, "routes"));
		writeFileSync(
			join(root, "routes", "new-route.ts"),
			[
				'import { getSyncDbAccessor } from "../db-accessor-sync";',
				'const sync = require("../db-accessor-sync");',
				'void import("../db-accessor-sync");',
				'export { getSyncDbAccessor } from "../db-accessor-sync";',
				'export * from "../db-accessor-sync";',
				"getSyncDbAccessor();",
			].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(5);
		expect(result.violations[0]?.path).toBe("routes/new-route.ts");
		expect(result.violations.some((violation) => violation.message.includes("requires ../db-accessor-sync"))).toBe(
			true,
		);
		expect(result.violations.some((violation) => violation.message.includes("re-exports ../db-accessor-sync"))).toBe(
			true,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CI boundary resolves computed compatibility requires", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-boundary-"));
	try {
		writeFileSync(
			join(root, "computed-require.ts"),
			['const moduleName = "../db-accessor-sync";', "const sync = require(moduleName);"].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.message).toContain("requires ../db-accessor-sync");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CI boundary resolves computed compatibility requires with source extensions", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-boundary-"));
	try {
		writeFileSync(
			join(root, "computed-ts-require.ts"),
			['const moduleName = "../db-accessor-sync.ts";', "const sync = require(moduleName);"].join("\n"),
		);
		writeFileSync(
			join(root, "computed-js-require.ts"),
			['const moduleName = "../db-accessor-sync.js";', "const sync = require(moduleName);"].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(2);
		const messages = result.violations.map((violation) => violation.message);
		expect(messages).toContainEqual(expect.stringContaining("requires ../db-accessor-sync.ts"));
		expect(messages).toContainEqual(expect.stringContaining("requires ../db-accessor-sync.js"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CI boundary resolves interpolated compatibility requires and rejects dynamic templates", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-boundary-"));
	try {
		writeFileSync(
			join(root, "interpolated-require.ts"),
			[
				'const moduleName = "../db-accessor";',
				`const sync = require(\`\${moduleName}-\${'sync'}\`);`,
				`const async = require(\`../db-accessor-\${'async'}\`);`,
				`const dynamic = require(\`../db-accessor-\${runtimeName}\`);`,
			].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(2);
		expect(result.violations[0]?.message).toContain("requires ../db-accessor-sync");
		expect(result.violations[1]?.message).toContain("dynamic template module specifiers are rejected");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CI boundary resolves interpolated compatibility imports", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-boundary-"));
	try {
		writeFileSync(
			join(root, "interpolated-import.ts"),
			['const moduleName = "../db-accessor";', `void import(\`\${moduleName}-\${'sync'}\`);`].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.message).toContain("dynamically imports ../db-accessor-sync");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the Obsidian embedding sync calls remain enumerated in the legacy ledger", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	const result = runAudit({ sourceRoot: resolve("platform/daemon/src"), baselineSites: baseline });
	const baselineSites = baseline.filter((site) => site.path === "obsidian-source-embeddings.ts");
	const liveSites = result.sites.filter((site) => site.path === "obsidian-source-embeddings.ts");
	expect(baselineSites).toHaveLength(7);
	expect(liveSites).toHaveLength(baselineSites.length);
	expect(occurrenceKeys(liveSites)).toEqual(occurrenceKeys(baselineSites));
	expect(result.violations.filter((violation) => violation.path === "obsidian-source-embeddings.ts")).toEqual([]);
});

test("bootstrap, CLI, and worker fixtures can use the explicit compatibility module", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-boundary-"));
	try {
		for (const directory of ["bootstrap", "cli", "workers"]) {
			mkdirSync(join(root, directory));
			writeFileSync(
				join(root, directory, "entry.ts"),
				'import { getSyncDbAccessor } from "../db-accessor-sync";\ngetSyncDbAccessor();\n',
			);
		}
		expect(
			runAudit({
				sourceRoot: root,
				allowedSyncCompatImporters: ["bootstrap/entry.ts", "cli/entry.ts", "workers/entry.ts"],
			}).violations,
		).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the production TypeScript project cannot import the compatibility module", () => {
	const productionSourceRoot = resolve("platform/daemon/src");
	const compatibilityModule = resolve("platform/daemon/legacy-sync/db-accessor-sync.ts");
	expect(relative(productionSourceRoot, compatibilityModule).startsWith("..")).toBe(true);
	expect(readFileSync(compatibilityModule, "utf8")).toContain("outside");
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-type-boundary-"));
	try {
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "legacy-sync"));
		writeFileSync(
			join(root, "src", "new-production-code.ts"),
			[
				'import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";',
				"const accessor = getSyncDbAccessor();",
				'const method = "withReadDb";',
				"const read = accessor[method];",
				"read((db) => db);",
			].join(String.fromCharCode(10)),
		);
		writeFileSync(
			join(root, "legacy-sync", "db-accessor-sync.ts"),
			[
				"export interface SyncDbAccessor {",
				"  withReadDb(callback: (db: unknown) => unknown): unknown;",
				"}",
				"export declare function getSyncDbAccessor(): SyncDbAccessor;",
			].join(String.fromCharCode(10)),
		);
		const program = ts.createProgram([join(root, "src", "new-production-code.ts")], {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			rootDir: join(root, "src"),
			noEmit: true,
			strict: true,
			skipLibCheck: true,
		});
		const diagnostics = ts.getPreEmitDiagnostics(program);
		expect(diagnostics.some((diagnostic) => diagnostic.code === 6059)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the generated report describes the type boundary and transitional counts", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	const report = renderReport(baseline, { total: 164, withWriteTx: 65, withReadDb: 99 });
	expect(report).toContain("Exact ledger inventory: 870 sites");
	expect(report).toContain("65 synchronous writes, 99 synchronous reads, and 182 async-named DB sites");
	expect(report).toContain("Async-named ON-PARENT DB sites: 180");
	expect(report).toContain("Async-named OFF-PARENT DB sites: 2");
	expect(report).not.toContain("async-named parent DB sites");
	expect(report).toContain(
		"The async-named DB counts above separate the 180 ON-PARENT callbacks from the 2 OFF-PARENT callbacks.",
	);
	expect(report).toContain("Database accessor sites classified: 346");
	expect(report).toContain("ON-PARENT callback execution: 344");
	expect(report).toContain("OFF-PARENT callback execution: 2");
	expect(report).toContain("- `db:recall.embedding.config.read` (withReadDbAsync)");
	expect(report).toContain("- `db:recall.vector.search.read` (withReadDbAsync)");
	expect(report).not.toMatch(/`daemon\.ts:\d+` \(withReadDbAsync\)/);
	expect(report).toContain("type boundary");
	expect(report).not.toContain("Exact ledger inventory: 997 sites");
});

const countBaseline = (total: number, withReadDb: number, withWriteTx: number): LegacyDbCountBaseline => ({
	version: 1,
	generatedFrom: "test",
	markedCallsites: { total, withReadDb, withWriteTx },
});

test("the count ratchet fails when the marker count grows past the baseline", () => {
	const outcome = evaluateCountRatchet({ total: 241, withReadDb: 139, withWriteTx: 102 }, countBaseline(240, 139, 101));
	expect(outcome.status).toBe("increase");
	expect(outcome.message).toContain("240 -> 241");
	expect(outcome.message).toContain("only goes down");
});

test("the count ratchet passes with guidance when the marker count decreases", () => {
	const outcome = evaluateCountRatchet({ total: 238, withReadDb: 138, withWriteTx: 100 }, countBaseline(240, 139, 101));
	expect(outcome.status).toBe("decrease");
	expect(outcome.message).toContain("240 -> 238");
	expect(outcome.message).toContain("legacy-sync-db-baseline");
});

test("the count ratchet passes when the marker count holds the baseline", () => {
	const outcome = evaluateCountRatchet({ total: 240, withReadDb: 140, withWriteTx: 100 }, countBaseline(240, 139, 101));
	expect(outcome.status).toBe("pass");
});

test("the committed count baseline matches the live marker count", () => {
	const baseline = loadCountBaseline(resolve("scripts/legacy-sync-db-baseline.json"));
	const result = runAudit({ sourceRoot: resolve("platform/daemon/src") });
	expect(result.violations.filter((violation) => violation.kind === "unmarked-legacy-db-access")).toEqual([]);
	expect(evaluateCountRatchet(result.legacyDbAccess, baseline).status).toBe("pass");
});

test("an unmarked synchronous DB call is a violation even with no baseline", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-legacy-ratchet-"));
	try {
		writeFileSync(
			join(root, "unmarked.ts"),
			"getDbAccessor().withReadDb((db) => db);\nconst far = getDbAccessor().withWriteTx((db) => db);\n",
		);
		const result = runAudit({ sourceRoot: root });
		const unmarked = result.violations.filter((violation) => violation.kind === "unmarked-legacy-db-access");
		expect(unmarked).toHaveLength(1);
		expect(unmarked[0]?.path).toBe("unmarked.ts");
		expect(unmarked[0]?.message).toContain("1(withReadDb), 2(withWriteTx)");
		expect(unmarked[0]?.message).toContain("without a LEGACY_SYNC_DB_ACCESS marker");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a marker above the call line keeps the site marked, a distant marker does not", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-legacy-ratchet-marker-"));
	try {
		writeFileSync(
			join(root, "placement.ts"),
			[
				"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site",
				'getDbAccessor().withReadDb((db) => db, "placement.ts:2");',
				"const unrelated = 1;",
				"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site",
				"const gap = 2;",
				"getDbAccessor().withWriteTx((db) => db);",
			].join("\n"),
		);
		const result = runAudit({ sourceRoot: root });
		const unmarkedViolations = result.violations.filter((violation) => violation.kind === "unmarked-legacy-db-access");
		expect(unmarkedViolations).toHaveLength(1);
		expect(unmarkedViolations[0]?.message).toContain("6(withWriteTx)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Keep the production/public type distinction visible in source review. The
// daemon typecheck is the executable proof that DbAccessor has no sync keys.
const productionAccessorType = readFileSync(resolve("platform/daemon/src/db-accessor.ts"), "utf8");
const syncAccessorType = readFileSync(resolve("platform/daemon/legacy-sync/db-accessor-sync.ts"), "utf8");
expect(productionAccessorType).toContain("export interface DbAccessor extends AsyncDbAccessor {}");
expect(productionAccessorType).not.toContain("export interface SyncDbAccessorCompat");
expect(syncAccessorType).toContain("export interface SyncDbAccessor");
expect(syncAccessorType).toContain("checkpointWal(): void");
expect(syncAccessorType).toContain("incrementalVacuum(): number");
expect(syncAccessorType).toContain("vacuumConversion(): boolean");
