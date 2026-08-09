import type { RecallSurface } from "@signet/core";
import { getActiveTelemetry } from "./telemetry";

export type RecallResultState = "empty" | "non_empty" | "truncated" | "error";
export type RecallDeliveryState = "returned" | "injected" | "consumed" | "not_delivered";

const RECALL_SURFACES: ReadonlySet<string> = new Set<RecallSurface>([
	"explicit_api",
	"tool_call",
	"prompt_injection",
	"dashboard",
	"other",
]);

/** Resolve untrusted request metadata to the bounded telemetry vocabulary. */
export function normalizeRecallSurface(value: unknown, fallback: RecallSurface = "other"): RecallSurface {
	return typeof value === "string" && RECALL_SURFACES.has(value) ? (value as RecallSurface) : fallback;
}

export function recallResultState(resultCount: number, truncated = false): Exclude<RecallResultState, "error"> {
	if (resultCount <= 0) return "empty";
	return truncated ? "truncated" : "non_empty";
}

/** Keep funnel truncation comparisons aligned with the recall engine cap. */
export function effectiveRecallLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 10;
	return Math.min(50, Math.max(1, Math.trunc(value)));
}

function boundedResultCount(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.trunc(value))) : 0;
}

/** Record a retrieval attempt without accepting query or caller-identifying data. */
export function recordRecallAttempt(surface: RecallSurface): void {
	getActiveTelemetry()?.record("recall.attempted", { surface });
}

/**
 * Record the result and delivery boundary for one supported recall surface.
 * The event deliberately contains only bounded enums and a result count.
 */
export function recordRecallOutcome(input: {
	readonly surface: RecallSurface;
	readonly resultCount?: number;
	readonly truncated?: boolean;
	readonly delivery: RecallDeliveryState;
	readonly error?: boolean;
}): void {
	const resultCount = boundedResultCount(input.resultCount ?? 0);
	const resultState: RecallResultState = input.error
		? "error"
		: recallResultState(resultCount, input.truncated === true);
	const deliveryState = input.error ? "not_delivered" : input.delivery;
	getActiveTelemetry()?.record("recall.outcome", {
		surface: input.surface,
		resultState,
		deliveryState,
		results: resultCount,
	});
}
