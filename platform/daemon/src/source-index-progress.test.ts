import { describe, expect, test } from "bun:test";
import {
	beginSourceIndexJob,
	clearSourceIndexProgressForTests,
	completeSourceIndexJob,
	getSourceIndexJob,
	markSourceIndexJobRunning,
} from "./source-index-progress";

describe("source index progress", () => {
	test("does not reopen completed jobs when a duplicate delayed runner fires", () => {
		clearSourceIndexProgressForTests();
		const job = beginSourceIndexJob("source-1");
		expect(markSourceIndexJobRunning("source-1", job.id)?.status).toBe("running");
		completeSourceIndexJob("source-1", job.id, 3);

		expect(markSourceIndexJobRunning("source-1", job.id)).toBeUndefined();
		expect(getSourceIndexJob("source-1")?.status).toBe("complete");
	});
});
