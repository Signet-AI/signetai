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

	it("does not retain the synthesis worker while the pipeline is paused", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("let synthWorker: Worker | null = null;\n\tif (!memoryCfg.pipelineV2.paused) {");
		expect(source).toContain("new Worker(workerPath);");
	});

	it("keeps background imports and source indexing dormant while paused", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("if (loadMemoryConfig(AGENTS_DIR).pipelineV2.paused) return 0;");
		expect(source).toContain("nativeMemoryBridgeStartTimer = setTimeout(() => {");
		expect(source).toContain("clearTimeout(nativeMemoryBridgeStartTimer);");
		expect(source).not.toContain("ingestedMemoryFiles");
		expect(source).toContain('if (!startupCfg.pipelineV2.paused && startupCfg.embedding.provider !== "none")');
		expect(source).toContain(
			"if (!loadMemoryConfig(AGENTS_DIR).pipelineV2.paused)\n\t\t\t\tvacuumConversionHandle",
		);
		expect(source).toContain("const liveMemoryCfg = loadMemoryConfig(AGENTS_DIR);");
		expect(source).toContain("await startPipelineRuntime(liveMemoryCfg, telemetryCollector);");
		expect(source).toContain(
			"if (loadMemoryConfig(AGENTS_DIR).pipelineV2.paused) return;\n\t\ttry {\n\t\t\tawait cleanupSourceDeletionTombstones",
		);
		expect(source).toContain("const deferredMemoryCfg = loadMemoryConfig(AGENTS_DIR);");
		expect(source).toContain("resolveEmbeddingBridgeOptions(deferredMemoryCfg.embedding, fetchEmbedding)");
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
