import type { ErrorCode, ErrorStage } from "./analytics";
import { getActiveTelemetry } from "./telemetry";

export type PipelineErrorStage = Extract<ErrorStage, "extraction" | "decision" | "embedding">;

export type PipelineErrorCode = Extract<
	ErrorCode,
	| "EXTRACTION_TIMEOUT"
	| "EXTRACTION_PARSE_FAIL"
	| "DECISION_TIMEOUT"
	| "DECISION_INVALID"
	| "EMBEDDING_PROVIDER_DOWN"
	| "EMBEDDING_TIMEOUT"
>;

/** Record a stage/code pair without exposing provider messages or stack data. */
export function recordPipelineError(stage: PipelineErrorStage, code: PipelineErrorCode): void {
	getActiveTelemetry()?.record("pipeline.error", { stage, code });
}

export function isPipelineTimeout(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\b(?:abort(?:ed)?|deadline|timeout|timed out)\b/i.test(message);
}
