import type { ERROR_CODES, ErrorCode, ErrorStage } from "./analytics";
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

type PipelineErrorCodeForStage<Stage extends PipelineErrorStage> = {
	[Code in PipelineErrorCode]: (typeof ERROR_CODES)[Code] extends Stage ? Code : never;
}[PipelineErrorCode];

export type PipelineErrorPair = {
	[Stage in PipelineErrorStage]: [stage: Stage, code: PipelineErrorCodeForStage<Stage>];
}[PipelineErrorStage];

/** Record a stage/code pair without exposing provider messages or stack data. */
export function recordPipelineError(...pair: PipelineErrorPair): void {
	const [stage, code] = pair;
	getActiveTelemetry()?.record("pipeline.error", { stage, code });
}

// Compile-time regression check: a code from another stage must not be accepted.
type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type PipelineErrorParameters = Parameters<typeof recordPipelineError>;
type MismatchedPipelineErrorPairIsRejected = Assert<
	IsAssignable<["embedding", "DECISION_TIMEOUT"], PipelineErrorParameters> extends false ? true : false
>;

export function isPipelineTimeout(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\b(?:abort(?:ed)?|deadline|timeout|timed out)\b/i.test(message);
}
