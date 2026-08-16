/**
 * Dreaming live event normalizer (#1601).
 *
 * Maps raw Pi session events (and the context sentinel) into the shared
 * normalized event contract with bounded payloads. Pure and structural: no Pi
 * types are imported here — the boundary types are `unknown` at every seam.
 * Unknown shapes normalize to null (dropped), never throw.
 */
import type {
	DreamingLiveContextSentinel,
	DreamingLiveEvent,
} from "@signet/core";

/** Maximum serialized size of any single raw payload (verbose-view bound). */
export const DREAMING_LIVE_MAX_PAYLOAD_CHARS = 128_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventString(value: unknown, maxLength = DREAMING_LIVE_MAX_PAYLOAD_CHARS): string | undefined {
	return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function boundedPayload(value: unknown): unknown {
	if (value === undefined || value === null) return value;
	try {
		const serialized = JSON.stringify(value);
		if (serialized.length <= DREAMING_LIVE_MAX_PAYLOAD_CHARS) return value;
	} catch {
		// Unserializable payloads (cycles, functions) fall through.
	}
	return {
		__truncated: true,
		preview: String(value).slice(0, DREAMING_LIVE_MAX_PAYLOAD_CHARS),
	};
}

/** Concatenate text/thinking content of an assistant message, bounded. */
function concatContent(
	content: unknown,
	pick: (part: Record<string, unknown>) => string | undefined,
): string | undefined {
	if (!Array.isArray(content)) return undefined;
	let out = "";
	for (const part of content) {
		if (!isRecord(part)) continue;
		const piece = pick(part);
		if (typeof piece === "string" && piece) out += `${out ? "\n" : ""}${piece}`;
	}
	return out ? out.slice(0, DREAMING_LIVE_MAX_PAYLOAD_CHARS) : undefined;
}

function textOf(message: Record<string, unknown>): string | undefined {
	return concatContent(message["content"], (part) =>
		part["type"] === "text" ? eventString(part["text"]) : undefined,
	);
}

function thinkingOf(message: Record<string, unknown>): string | undefined {
	return concatContent(message["content"], (part) =>
		part["type"] === "thinking" ? eventString(part["thinking"]) : undefined,
	);
}

function sentinelOf(value: unknown): DreamingLiveContextSentinel | null {
	if (!isRecord(value) || value["type"] !== "signet_context") return null;
	const instructions = eventString(value["instructions"]);
	if (instructions === undefined) return null;
	const modelLabel = eventString(value["modelLabel"]);
	return {
		type: "signet_context",
		instructions,
		...(modelLabel !== undefined ? { modelLabel } : {}),
	};
}

function normalizedSentinel(
	sentinel: DreamingLiveContextSentinel,
	passId: string,
): DreamingLiveEvent {
	return {
		type: "system_instructions",
		passId,
		instructions: sentinel.instructions,
		...(sentinel.modelLabel !== undefined ? { modelLabel: sentinel.modelLabel } : {}),
	};
}

/**
 * Normalize one raw sink event for a given pass. Returns null for shapes the
 * live view does not model (control-plane events, tool deltas, unknowns).
 */
export function normalizeDreamingLiveEvent(
	event: unknown,
	passId: string,
): DreamingLiveEvent | null {
	const sentinel = sentinelOf(event);
	if (sentinel) return normalizedSentinel(sentinel, passId);
	if (!isRecord(event)) return null;
	const type = event["type"];
	switch (typeof type === "string" ? type : "") {
		case "message_update": {
			const ameValue = event["assistantMessageEvent"];
			if (!isRecord(ameValue)) return null;
			const ame = ameValue;
			const ameType = typeof ame["type"] === "string" ? ame["type"] : "";
			if (ameType === "text_delta") {
				const text = eventString(ame["text"]);
				if (text === undefined) return null;
				return { type: "assistant_delta", passId, text };
			}
			if (ameType === "thinking_delta") {
				const text = eventString(ame["thinking"]);
				if (text === undefined) return null;
				return { type: "reasoning_delta", passId, text };
			}
			return null;
		}
		case "message_end": {
			const message = event["message"];
			if (!isRecord(message) || message["role"] !== "assistant") return null;
			const text = textOf(message);
			if (text === undefined) return null;
			const reasoning = thinkingOf(message);
			const out: DreamingLiveEvent = { type: "assistant_turn", passId, text };
			if (reasoning !== undefined) (out as { reasoning?: string }).reasoning = reasoning;
			return out;
		}
		case "tool_execution_start": {
			const tool = eventString(event["toolName"]);
			if (tool === undefined) return null;
			const args = boundedPayload(event["args"]);
			const out: DreamingLiveEvent = { type: "tool_start", passId, tool };
			if (args !== undefined) (out as { args?: unknown }).args = args;
			return out;
		}
		case "tool_execution_update": {
			const tool = eventString(event["toolName"]);
			if (tool === undefined) return null;
			const partial = boundedPayload(event["partialResult"]);
			const out: DreamingLiveEvent = { type: "tool_update", passId, tool };
			if (partial !== undefined) (out as { partial?: unknown }).partial = partial;
			return out;
		}
		case "tool_execution_end": {
			const tool = eventString(event["toolName"]);
			if (tool === undefined) return null;
			const result = boundedPayload(event["result"]);
			return {
				type: "tool_end",
				passId,
				tool,
				isError: event["isError"] === true,
				result,
			};
		}
		default:
			// agent_start/agent_end, turn_*, message_start, toolcall deltas,
			// user events: no live-view counterpart. Lifecycle transitions are
			// emitted by the worker from its own settlement knowledge.
			return null;
	}
}
