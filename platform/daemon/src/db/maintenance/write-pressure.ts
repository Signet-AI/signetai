import { DbWriteQueueFullError } from "../owner/accessor";
import { WorkspaceMigrationRetryableError } from "./workspace-writer-barrier";
export function isRetryableWritePressure(error: unknown): boolean {
	if (error instanceof DbWriteQueueFullError || error instanceof WorkspaceMigrationRetryableError) return true;
	return (
		error instanceof Error &&
		(error.name === "DbOwnerAdmissionError" ||
			error.name === "TranscriptCaptureBacklogFullError" ||
			error.name === "TranscriptCapturePendingError" ||
			error.name === "TranscriptLockTimeoutError")
	);
}

export const WRITE_PRESSURE_RETRY_AFTER_SECONDS = 1;
