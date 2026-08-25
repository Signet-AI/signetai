/**
 * Regression coverage for production worker wiring.
 *
 * These calls live in daemon.ts rather than an injectable factory, so this
 * probe checks the exact startup source that the running daemon executes.
 */
import { describe, expect, it } from "bun:test";

const daemonSourceUrl = new URL("./daemon.ts", import.meta.url);

describe("daemon production DB owner wiring", () => {
	it("passes the registered maintenance owner to pipeline and Dreaming startup", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain(
			"dbOwnerMaintenanceHandle = createDbOwnerMaintenance({ dbPath: MEMORY_DB, owner: dbOwnerClient });",
		);
		expect(source).toContain("registerDbOwnerMaintenance(dbOwnerMaintenanceHandle);");
		expect(source).toContain("deferredRuntimeScheduler.scheduleMaintenance(async (): Promise<void> => {");
		expect(source).toContain("completeFtsStartupRecovery({");
		expect(source).toContain("			telemetry,\n			dbOwnerMaintenanceHandle ?? undefined,\n		);");
		expect(source).toContain("ownerMaintenance: dbOwnerMaintenanceHandle ?? undefined,");
	});

	it("shares the generic read lane with recall and leaves unused lanes unstarted", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("registerMemoryRoutes(app, { getRecallOwner: () => dbOwnerClient ?? undefined });");
		expect(source).toContain("await dbOwnerClient.initialize(AGENTS_DIR);");
		expect(source).not.toContain("await dbOwnerClient.start();");
		expect(source).not.toContain("recallDbOwner");
	});

	it("keeps post-ready integrity maintenance incremental and checkpointed", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("runIncrementalDatabaseIntegrityCheck");
		expect(source).toContain('checkpointKey: "database.quick-check"');
		expect(source).toContain("INCREMENTAL_INTEGRITY_TABLES_PER_RUN");
		expect(source).not.toContain("runDeferredIntegrityCheck");
	});

	it("keeps a paused startup source partial instead of reporting success", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("const syncResult = nativeMemoryBridge?.getLastSyncResult?.();");
		expect(source).toContain("pauseSourceIndexJob(sourceId, jobId, {");
		expect(source).toContain("scanned: paused.scanned,");
		expect(source).toContain("indexed: paused.indexed,");
		expect(source).toContain('outcome: syncResult?.status === "paused" && paused ? "partial" : "success",');
		expect(source).toContain('updateFreshness: syncResult?.status === "paused" && paused ? false : undefined,');
	});
});
