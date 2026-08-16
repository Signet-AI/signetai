/**
 * Dreaming live-view event contract (#1601).
 *
 * Type-only module shared by the daemon's live event transport and the CLI's
 * read-only attach viewer. These are observation events: none of them may be
 * used to steer, cancel, retry, or otherwise modify a Dreaming pass. The
 * persisted `dreaming_passes` / `dreaming_tool_calls` records remain the
 * durable audit source; the live stream is ephemeral.
 */

/** Pass states the live view can report. */
export type DreamingLiveState =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out";

/** Identity and scope metadata for one live-attached pass. */
export interface DreamingLivePassMetadata {
	readonly passId: string;
	readonly agentId: string;
	readonly mode: string;
	readonly startedAt: string;
	/** Model label (provider:model) of the routed target, when observed. */
	readonly modelLabel?: string;
	/** System/developer instructions the bounded session was given. */
	readonly instructions?: string;
}

/** Initial and gap-recovery snapshot of a pass's observable state. */
export interface DreamingLiveSnapshot {
	readonly pass: DreamingLivePassMetadata;
	readonly state: DreamingLiveState;
	readonly elapsedMs: number;
	/** Tool calls already recorded in the durable audit trail. */
	readonly toolCalls: number;
	/** Present once the pass has reached a terminal state. */
	readonly summary?: string;
	readonly error?: string;
}

/**
 * Normalized producer-side live events. `seq` is deliberately absent here:
 * the daemon's live bus stamps a monotonic seq on each wire frame.
 */
export type DreamingLiveEvent =
	| { readonly type: "prompt"; readonly passId: string; readonly prompt: string }
	| {
			readonly type: "system_instructions";
			readonly passId: string;
			readonly instructions: string;
			readonly modelLabel?: string;
	  }
	| { readonly type: "assistant_delta"; readonly passId: string; readonly text: string }
	| {
			readonly type: "assistant_turn";
			readonly passId: string;
			readonly text: string;
			/** Full reasoning text for the turn, when the model produced it. */
			readonly reasoning?: string;
	  }
	| { readonly type: "reasoning_delta"; readonly passId: string; readonly text: string }
	| { readonly type: "tool_start"; readonly passId: string; readonly tool: string; readonly args?: unknown }
	| {
			readonly type: "tool_update";
			readonly passId: string;
			readonly tool: string;
			readonly partial?: unknown;
	  }
	| {
			readonly type: "tool_end";
			readonly passId: string;
			readonly tool: string;
			readonly isError: boolean;
			readonly result?: unknown;
	  }
	| {
			readonly type: "state_transition";
			readonly passId: string;
			readonly state: DreamingLiveState;
			readonly message?: string;
	  };

/**
 * Context sentinel the Pi session boundary emits so the worker's sink
 * receives instruction/model metadata without session introspection.
 */
export interface DreamingLiveContextSentinel {
	readonly type: "signet_context";
	readonly instructions: string;
	readonly modelLabel?: string;
}

/**
 * Transport-side events the SSE stream emits in addition to normalized
 * events: stream lifecycle plus the bounded replay bookkeeping.
 */
export type DreamingLiveTransportEvent =
	| {
			readonly type: "connected";
			readonly passId: string;
			readonly cursor: number;
			readonly snapshot: DreamingLiveSnapshot;
	  }
	| {
			readonly type: "gap";
			readonly passId: string;
			/** Cursor the client requested replay from. */
			readonly cursor: number;
			/** Oldest seq still held in the bounded replay buffer. */
			readonly oldest: number;
			/** Fresh snapshot so the client can resync. */
			readonly snapshot: DreamingLiveSnapshot;
	  }
	| {
			readonly type: "complete";
			readonly passId: string;
			readonly state: DreamingLiveState;
			readonly summary?: string;
			readonly error?: string;
	  };

/** Sink signature used across the Pi boundary, the router, and the worker. */
export type DreamingLiveEventSink = (
	event: DreamingLiveEvent | DreamingLiveContextSentinel,
) => void;

/** Sink signature at the router boundary, where events are not yet typed. */
export type DreamingRawEventSink = (event: unknown) => void;
