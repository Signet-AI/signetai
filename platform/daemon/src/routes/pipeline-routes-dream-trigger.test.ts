import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DbOwnerDeadlineError } from "../db-owner-client";
import { logger } from "../logger";
import { registerGlobalMiddleware } from "../middleware";
import { setDreamingWorker } from "../pipeline";
import type { DreamingWorkerHandle } from "../pipeline/dreaming-worker";

const previousSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-dream-trigger-route-"));
process.env.SIGNET_PATH = agentsDir;
const { registerPipelineRoutes } = await import("./pipeline-routes");

afterEach(() => setDreamingWorker(null));
afterAll(() => {
	rmSync(agentsDir, { recursive: true, force: true });
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
});

test("a trigger the DB owner cannot serve returns a logged 503", async () => {
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const error = new DbOwnerDeadlineError("db-owner-1-9", "dreaming.scopes was queued behind maintenance.slow");
		setDreamingWorker({
			inferenceReady: async () => true,
			triggerAsync: async () => {
				throw error;
			},
		} as unknown as DreamingWorkerHandle);
		const app = new Hono();
		registerGlobalMiddleware(app);
		registerPipelineRoutes(app);
		const response = await app.request("/api/dream/trigger", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "incremental" }),
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: error.message, code: "DB_OWNER_DEADLINE" });
		expect(warn).toHaveBeenCalledWith(
			"api",
			"Request failed because the DB owner could not serve it",
			expect.objectContaining({ path: "/api/dream/trigger", code: "DB_OWNER_DEADLINE" }),
		);
	} finally {
		warn.mockRestore();
	}
});
