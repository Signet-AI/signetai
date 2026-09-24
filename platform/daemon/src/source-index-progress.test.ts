import { describe, expect, test } from "bun:test";
import {
	beginSourceIndexJob,
	clearSourceIndexProgressForTests,
	completeSourceIndexJob,
	getSourceIndexJob,
	markSourceIndexJobRunning,
	pauseSourceIndexJob,
	trackSourceIndexRun,
	updateSourceIndexJobProgress,
	waitForSourceIndexRuns,
} from "./source-index-progress";

describe("source index progress", () => {
	test("preserves degraded embedding status in job progress", () => {
		clearSourceIndexProgressForTests();
		const job = beginSourceIndexJob("source-2");
		updateSourceIndexJobProgress("source-2", job.id, {
			scanned: 1,
			total: 1,
			indexed: 1,
			currentPath: "/vault/Pending.md",
			statusMessage: "embeddings pending - provider down",
		});

		expect(getSourceIndexJob("source-2")?.statusMessage).toBe("embeddings pending - provider down");
	});

	test("clears degraded embedding status after provider recovery", () => {
		clearSourceIndexProgressForTests();
		const job = beginSourceIndexJob("source-recovery");
		const progress = {
			scanned: 1,
			total: 1,
			indexed: 0,
			currentPath: "/vault/Recovering.md",
		};
		updateSourceIndexJobProgress("source-recovery", job.id, {
			...progress,
			statusMessage: "embeddings pending - provider down",
		});
		expect(getSourceIndexJob("source-recovery")?.statusMessage).toBe("embeddings pending - provider down");

		updateSourceIndexJobProgress("source-recovery", job.id, progress);

		expect(getSourceIndexJob("source-recovery")?.statusMessage).toBeUndefined();
	});

	test("does not reopen completed jobs when a duplicate delayed runner fires", () => {
		clearSourceIndexProgressForTests();
		const job = beginSourceIndexJob("source-1");
		expect(markSourceIndexJobRunning("source-1", job.id)?.status).toBe("running");
		completeSourceIndexJob("source-1", job.id, 3);

		expect(markSourceIndexJobRunning("source-1", job.id)).toBeUndefined();
		expect(getSourceIndexJob("source-1")?.status).toBe("complete");
	});

	test("persists counts when a provider pauses before any progress event", () => {
		clearSourceIndexProgressForTests();
		const job = beginSourceIndexJob("source-paused");
		pauseSourceIndexJob("source-paused", job.id, {
			pauseReason: "provider_unavailable",
			resumeFrontier: "/vault/permanent/First.md",
			scanned: 2,
			indexed: 1,
		});

		expect(getSourceIndexJob("source-paused")).toMatchObject({
			status: "paused",
			partial: true,
			scanned: 2,
			indexed: 1,
			pauseReason: "provider_unavailable",
			resumeFrontier: "/vault/permanent/First.md",
		});
	});

	test("drains route runs before bridge close and startup runs after", async () => {
		clearSourceIndexProgressForTests();
		let resolveRouteRun = () => {};
		let resolveStartupRun = () => {};
		const routeRun = new Promise<void>((resolve) => {
			resolveRouteRun = resolve;
		});
		const startupRun = new Promise<void>((resolve) => {
			resolveStartupRun = resolve;
		});
		trackSourceIndexRun({ sourceId: "route-source", jobId: "route-job", kind: "route", run: routeRun });
		trackSourceIndexRun({ sourceId: "startup-source", jobId: "startup-job", kind: "startup", run: startupRun });
		let allRunsFinished = false;
		const waitForAll = waitForSourceIndexRuns().then(() => {
			allRunsFinished = true;
		});

		resolveRouteRun();
		await waitForSourceIndexRuns("route");

		expect(allRunsFinished).toBe(false);
		resolveStartupRun();
		await waitForAll;
		expect(allRunsFinished).toBe(true);
	});
});
