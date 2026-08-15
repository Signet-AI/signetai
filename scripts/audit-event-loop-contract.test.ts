import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { loadBaseline, runAudit, renderReport } from "./audit-event-loop-contract";

test("the deterministic ledger retains the exact 1060-site inventory", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	expect(baseline).toHaveLength(1060);
	expect(baseline.filter((site) => site.api === "withWriteTx")).toHaveLength(230);
	expect(baseline.filter((site) => site.api === "withReadDb")).toHaveLength(346);
});

test("the ledger reports legacy DB markers without scanning new call sites", () => {
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
		writeFileSync(join(root, "new-call.ts"), "getDbAccessor().withReadDb((db) => db);\n");
		const result = runAudit({ sourceRoot: root });
		expect(result.legacyDbAccess).toEqual({ total: 2, withWriteTx: 1, withReadDb: 1 });
		expect(result.violations).toEqual([]);
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
			'import { getSyncDbAccessor } from "../db-accessor-sync";\ngetSyncDbAccessor();\n',
		);
		const result = runAudit({ sourceRoot: root });
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]?.path).toBe("routes/new-route.ts");
		expect(result.violations[0]?.message).toContain("only bootstrap, CLI, and isolated worker modules");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
		expect(runAudit({ sourceRoot: root }).violations).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the generated report describes the type boundary and transitional counts", () => {
	const baseline = loadBaseline(resolve("scripts/event-loop-contract-baseline.json"));
	const report = renderReport(baseline, { total: 576, withWriteTx: 230, withReadDb: 346 });
	expect(report).toContain("Exact ledger inventory: 1060 sites");
	expect(report).toContain("230 synchronous writes and 346 synchronous reads");
	expect(report).toContain("type boundary");
	expect(report).not.toContain("1061");
});

// Keep the production/public type distinction visible in source review. The
// daemon typecheck is the executable proof that DbAccessor has no sync keys.
const productionAccessorType = readFileSync(resolve("platform/daemon/src/db-accessor.ts"), "utf8");
const syncAccessorType = readFileSync(resolve("platform/daemon/src/db-accessor-sync.ts"), "utf8");
expect(productionAccessorType).toContain("export interface DbAccessor extends AsyncDbAccessor {}");
expect(productionAccessorType).not.toContain("export interface SyncDbAccessorCompat");
expect(syncAccessorType).toContain("export interface SyncDbAccessor");
