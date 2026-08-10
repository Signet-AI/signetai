import { getActiveTelemetry } from "./telemetry";

export const PIPELINE_OPERATION_CLASSES = [
	"indexing",
	"memory_capture",
	"recall",
	"dreaming",
	"extraction",
	"other",
] as const;

export type PipelineOperationClass = (typeof PIPELINE_OPERATION_CLASSES)[number];

export const PIPELINE_OPERATION_OUTCOMES = ["completed", "partial", "skipped", "failed", "cancelled"] as const;
export type PipelineOperationOutcome = (typeof PIPELINE_OPERATION_OUTCOMES)[number];

export const PIPELINE_CAUSE_FAMILIES = [
	"context_limit",
	"invalid_input",
	"auth",
	"quota",
	"rate_limit",
	"provider_unavailable",
	"timeout",
	"parse_failure",
	"cancellation",
	"internal_error",
] as const;

export type PipelineCauseFamily = (typeof PIPELINE_CAUSE_FAMILIES)[number];

function pipelineErrorDetails(error: unknown, depth = 0): { readonly status?: number; readonly text: string } {
	if (depth > 2) return { text: String(error) };
	if (typeof error !== "object" || error === null) return { text: String(error) };
	const record = error as Record<string, unknown>;
	const nested = record.cause === undefined ? undefined : pipelineErrorDetails(record.cause, depth + 1);
	return {
		...(typeof record.status === "number"
			? { status: record.status }
			: nested?.status !== undefined
				? { status: nested.status }
				: {}),
		text: [
			typeof record.message === "string" ? record.message : "",
			typeof record.code === "string" ? record.code : "",
			nested?.text ?? "",
		]
			.filter(Boolean)
			.join(" "),
	};
}

export function bucketDurationMs(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
	if (durationMs < 100) return "0-99ms";
	if (durationMs < 1_000) return "100-999ms";
	if (durationMs < 10_000) return "1-9s";
	if (durationMs < 60_000) return "10-59s";
	if (durationMs < 300_000) return "1-4m";
	return "5m+";
}

export function bucketQueueAgeMs(queueAgeMs: number): string {
	if (!Number.isFinite(queueAgeMs) || queueAgeMs < 0) return "unknown";
	if (queueAgeMs < 1_000) return "0-999ms";
	if (queueAgeMs < 10_000) return "1-9s";
	if (queueAgeMs < 60_000) return "10-59s";
	if (queueAgeMs < 300_000) return "1-4m";
	return "5m+";
}

export function normalizePipelineCause(error: unknown): PipelineCauseFamily {
	const details = pipelineErrorDetails(error);
	const status = details.status;
	const text = details.text.toLowerCase();

	if (status === 401 || status === 403 || /\b(?:unauthori[sz]ed|forbidden|api key|credential|permission)/i.test(text)) {
		return "auth";
	}
	if (status === 402 || /\b(?:quota|billing|credit balance|insufficient funds)\b|insufficient[_ ]quota/i.test(text)) {
		return "quota";
	}
	if (status === 429 || /\b(?:rate.?limit|too many requests|throttl)/i.test(text)) return "rate_limit";
	if (status === 408 || status === 504) return "timeout";
	if (
		status === 413 ||
		(status === 400 && /\b(?:context|prompt|input|token).{0,30}\b(?:limit|length|max|exceed|long|large)/i.test(text)) ||
		/\b(?:context(?: window| length)?|prompt|input|token).{0,30}\b(?:limit|length|max|exceed|long|large)/i.test(text) ||
		/\b(?:maximum context|context length exceeded|too many tokens|input too long|payload too large)\b/i.test(text)
	) {
		return "context_limit";
	}
	if (/\b(?:abort(?:ed)?|cancel(?:led|ed)?|shutdown)\b/i.test(text)) return "cancellation";
	if (/\b(?:timeout|timed out|deadline|etimedout)\b/i.test(text)) return "timeout";
	if (/\b(?:parse|parsing|json|malformed|invalid response|unexpected token)\b/i.test(text)) return "parse_failure";
	if (/\b(?:econnrefused|enotfound|econnreset|unreachable|unavailable|connection reset|provider down)\b/i.test(text)) {
		return "provider_unavailable";
	}
	if (status !== undefined && status >= 500) return "provider_unavailable";
	if (status !== undefined && status >= 400 && status < 500) return "invalid_input";
	return "internal_error";
}

export function pipelineCauseFromHttpFailure(status: number, responseText = ""): PipelineCauseFamily {
	return normalizePipelineCause({ status, message: responseText });
}

export interface PipelineOperationSummary {
	readonly operationClass: PipelineOperationClass;
	readonly outcome: PipelineOperationOutcome;
	readonly accepted: number;
	readonly skipped: number;
	readonly retried: number;
	readonly failed: number;
	readonly durationMs: number;
	readonly queueAgeMs: number;
	readonly causeFamily?: PipelineCauseFamily;
}

/** Emit one bounded operation summary. Never include ids, paths, content, or provider messages. */
export function recordPipelineOperation(summary: PipelineOperationSummary): void {
	const durationMs =
		Number.isFinite(summary.durationMs) && summary.durationMs >= 0 ? Math.round(summary.durationMs) : 0;
	const queueAgeMs =
		Number.isFinite(summary.queueAgeMs) && summary.queueAgeMs >= 0 ? Math.round(summary.queueAgeMs) : 0;
	getActiveTelemetry()?.record("pipeline.operation", {
		operationClass: summary.operationClass,
		outcome: summary.outcome,
		accepted: Math.max(0, Math.trunc(summary.accepted)),
		skipped: Math.max(0, Math.trunc(summary.skipped)),
		retried: Math.max(0, Math.trunc(summary.retried)),
		failed: Math.max(0, Math.trunc(summary.failed)),
		durationMs,
		durationBucket: bucketDurationMs(durationMs),
		queueAgeMs,
		queueAgeBucket: bucketQueueAgeMs(queueAgeMs),
		...(summary.causeFamily ? { causeFamily: summary.causeFamily } : {}),
	});
}
