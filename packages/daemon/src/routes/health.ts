import type { Hono } from "hono";
import { getDbAccessor } from "../db-accessor";
import { getAllFeatureFlags } from "../feature-flags";
import { getPipelineWorkerStatus } from "../pipeline";
import { getResourceSnapshot } from "../resource-monitor";
import { AGENTS_DIR, CURRENT_VERSION, PORT, shuttingDown } from "./state.js";
import { getUpdateState } from "../update-system";

export function mountHealthRoutes(app: Hono): void {
	app.get("/health", (c) => {
		const us = getUpdateState();
		let dbOk = false;
		try {
			getDbAccessor().withReadDb((db) => {
				db.prepare("SELECT 1").get();
				dbOk = true;
			});
		} catch {}
		const workers = getPipelineWorkerStatus();
		const extraction = workers.extraction;
		const stalled =
			extraction.running &&
			extraction.stats !== undefined &&
			extraction.stats.pending > 0 &&
			Date.now() - extraction.stats.lastProgressAt > 60_000;

		return c.json({
			status: shuttingDown ? "shutting_down" : "healthy",
			uptime: process.uptime(),
			pid: process.pid,
			version: CURRENT_VERSION,
			port: PORT,
			agentsDir: AGENTS_DIR,
			db: dbOk,
			shuttingDown,
			updateAvailable: us.lastCheck?.updateAvailable ?? false,
			pendingRestart: us.pendingRestartVersion !== null,
			pipeline: {
				extractionRunning: extraction.running,
				extractionStalled: stalled,
				extractionPending: extraction.stats?.pending ?? 0,
				extractionBackoffMs: extraction.stats?.backoffMs ?? 0,
			},
			resources: getResourceSnapshot(),
		});
	});

	app.get("/api/features", (c) => {
		return c.json(getAllFeatureFlags());
	});
}
