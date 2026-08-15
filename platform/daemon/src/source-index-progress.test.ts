import { describe, expect, test } from "bun:test";
import {
	beginSourceIndexJob,
	clearSourceIndexProgressForTests,
	completeSourceIndexJob,
	getSourceIndexJob,
	markSourceIndexJobRunning,
	updateSourceIndexJobProgress,
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
});
