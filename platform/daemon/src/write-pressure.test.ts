import { describe, expect, it } from "bun:test";
import { DbWriteQueueFullError } from "./db-accessor";
import { DbOwnerAdmissionError, DbOwnerDeadlineError } from "./db-owner-client";
import { TranscriptCaptureBacklogFullError } from "./transcript-capture-worker";
import { WorkspaceMigrationRetryableError } from "./workspace-writer-barrier";
import { isRetryableWritePressure } from "./write-pressure";

describe("isRetryableWritePressure", () => {
	it("treats write-queue, owner-admission, and migration-drain errors as retryable", () => {
		expect(isRetryableWritePressure(new DbWriteQueueFullError())).toBe(true);
		expect(isRetryableWritePressure(new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "full"))).toBe(true);
		expect(isRetryableWritePressure(new WorkspaceMigrationRetryableError("db-owner", "g1"))).toBe(true);
		expect(isRetryableWritePressure(new TranscriptCaptureBacklogFullError(64))).toBe(true);
	});

	it("leaves other failures alone so they still surface as errors", () => {
		expect(isRetryableWritePressure(new DbOwnerDeadlineError("job-1"))).toBe(false);
		expect(isRetryableWritePressure(new Error("UNIQUE constraint failed: agents.id"))).toBe(false);
		expect(isRetryableWritePressure("queue full")).toBe(false);
	});
});

describe("transcript lock timeout", () => {
	it("is retryable write pressure", async () => {
		const { TranscriptLockTimeoutError } = await import("./transcript-jsonl");
		expect(isRetryableWritePressure(new TranscriptLockTimeoutError())).toBe(true);
	});
});
