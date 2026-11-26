import { DbWriteQueueFullError } from "./db-accessor";
import { DbOwnerError } from "./db-owner-client";
import { WorkspaceMigrationRetryableError } from "./workspace-writer-barrier";
export function isRetryableWritePressure(error: unknown): boolean {
	if (error instanceof DbWriteQueueFullError || error instanceof WorkspaceMigrationRetryableError) return true;
	if (error instanceof DbOwnerError && error.code === "TRANSCRIPT_CAPTURE_BACKLOG_FULL") return true;
	return (
		error instanceof Error &&
		(error.name === "DbOwnerAdmissionError" ||
			error.name === "TranscriptCaptureBacklogFullError" ||
			error.name === "TranscriptCapturePendingError" ||
			error.name === "TranscriptLockTimeoutError")
	);
}

export const WRITE_PRESSURE_RETRY_AFTER_SECONDS = 1;
