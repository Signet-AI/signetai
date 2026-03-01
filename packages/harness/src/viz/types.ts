/**
 * Pipeline event types for the observability visualization layer.
 */

export type VisualizationMode = "inline" | "hidden" | "split";

/** Normalized pipeline event — converted from daemon log entries or extension hook calls */
export type PipelineEvent =
	| HookEvent
	| ExtractionEvent
	| DecisionEvent
	| MemoryWriteEvent
	| LlmCallEvent
	| SessionClaimEvent
	| InjectionCandidatesEvent
	| PipelineWorkerEvent;

export interface HookEvent {
	readonly kind: "hook";
	readonly name: string;
	readonly durationMs: number;
	readonly memoryCount: number;
	readonly injectChars: number;
	readonly sessionKey?: string;
	readonly timestamp: number;
}

export interface ExtractionEvent {
	readonly kind: "extraction";
	readonly facts: number;
	readonly entities: number;
	readonly durationMs: number;
	readonly jobId?: string;
	readonly timestamp: number;
}

export interface DecisionEvent {
	readonly kind: "decision";
	readonly action: "add" | "update" | "skip" | "delete";
	readonly confidence: number;
	readonly content: string;
	readonly memoryId?: string;
	readonly timestamp: number;
}

export interface MemoryWriteEvent {
	readonly kind: "memory_write";
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly timestamp: number;
}

export interface LlmCallEvent {
	readonly kind: "llm_call";
	readonly provider: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costUsd: number;
	readonly durationMs: number;
	readonly timestamp: number;
}

export interface SessionClaimEvent {
	readonly kind: "session_claim";
	readonly sessionKey: string;
	readonly runtimePath: string;
	readonly harness: string;
	readonly timestamp: number;
}

export interface InjectionCandidatesEvent {
	readonly kind: "injection_candidates";
	readonly total: number;
	readonly injected: number;
	readonly sessionKey?: string;
	readonly timestamp: number;
}

export interface PipelineWorkerEvent {
	readonly kind: "pipeline_worker";
	readonly worker: string;
	readonly status: string;
	readonly timestamp: number;
}
