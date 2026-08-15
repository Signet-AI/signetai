import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import ts from "typescript";
import {
	findStaleBaselineSites,
	loadBaseline,
	occurrenceKeys,
	runAudit,
	renderReport,
} from "./audit-event-loop-contract";

test("the deterministic ledger retains the exact 1046-site inventory", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	expect(baseline).toHaveLength(1046);
	expect(baseline.filter((site) => site.api === "withWriteTx")).toHaveLength(220);
	expect(baseline.filter((site) => site.api === "withReadDb")).toHaveLength(342);
});

test("the ledger reports legacy DB markers and rejects new call sites", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-event-loop-ledger-"));
	try {
		writeFileSync(
			join(root, "legacy.ts"),
			[
				"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site",
				"getDbAccessor().withReadDb((db) => db);",
				"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site",
				"getDbAccessor().withWriteTx((db) => db);",
			].join("\n"),
		);
		writeFileSync(
			join(root, "new-call.ts"),
			"// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site\ngetDbAccessor().withReadDb((db) => db);\n",
		);
		const result = runAudit({
			sourceRoot: root,
			baselineSites: [
				{
					path: "legacy.ts",
					line: 2,
					api: "withReadDb",
					source: "getDbAccessor().withReadDb((db) => db);",
					category: "hot-path",
				},
				{
					path: "legacy.ts",
					line: 4,
					api: "withWriteTx",
					source: "getDbAccessor().withWriteTx((db) => db);",
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
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.path).toBe("legacy.ts");
		expect(occurrenceKeys(result.sites)).not.toEqual(occurrenceKeys(baseline));
		expect(findStaleBaselineSites(result.sites, baseline)).toHaveLength(1);
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
		expect(result.violations).toHaveLength(1);
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
	const report = renderReport(baseline, { total: 562, withWriteTx: 220, withReadDb: 342 });
	expect(report).toContain("Exact ledger inventory: 1,046 sites");
	expect(report).toContain("220 synchronous writes and 342 synchronous reads");
	expect(report).toContain("type boundary");
	expect(report).not.toContain("1047");
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
