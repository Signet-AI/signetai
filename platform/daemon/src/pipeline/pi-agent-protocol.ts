import type { Model, Api, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionStats, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface PiAgentTool
	extends Pick<ToolDefinition, "name" | "label" | "description" | "parameters" | "exposure"> {
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>>;
}

export interface PiAgentRetryPolicy {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxAgentDelayMs: number;
}

export interface PiAgentWorkerInput {
	readonly model: Model<Api>;
	readonly apiKey: string;
	readonly systemPrompt: string;
	readonly tools: ReadonlyArray<Pick<ToolDefinition, "name" | "label" | "description" | "parameters" | "exposure">>;
	readonly retry?: PiAgentRetryPolicy;
}

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type TurnEndEvent = Extract<AgentSessionEvent, { type: "turn_end" }>;
type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;
type WithoutPartial<T> = T extends unknown ? Omit<T, "partial"> : never;

export type PiAgentEvent =
	| Exclude<AgentSessionEvent, { type: "message_update" | "turn_end" | "agent_end" }>
	| (Omit<MessageUpdateEvent, "message" | "assistantMessageEvent"> & {
			readonly assistantMessageEvent: WithoutPartial<MessageUpdateEvent["assistantMessageEvent"]>;
	  })
	| Omit<TurnEndEvent, "message" | "toolResults">
	| Omit<AgentEndEvent, "messages">;

export function toPiAgentEvent(event: AgentSessionEvent): PiAgentEvent {
	if (event.type === "turn_end") {
		const { message: _message, toolResults: _toolResults, ...rest } = event;
		return rest;
	}
	if (event.type === "agent_end") {
		const { messages: _messages, ...rest } = event;
		return rest;
	}
	if (event.type !== "message_update") return event;
	const { message: _message, assistantMessageEvent, ...rest } = event;
	if (!("partial" in assistantMessageEvent)) return { ...rest, assistantMessageEvent };
	const { partial: _partial, ...delta } = assistantMessageEvent;
	return { ...rest, assistantMessageEvent: delta };
}

export type PiAgentWorkerRequest =
	| { readonly type: "prompt"; readonly text: string }
	| { readonly type: "abort" }
	| { readonly type: "cancel" }
	| { readonly type: "configure"; readonly model: Model<Api>; readonly apiKey: string }
	| {
			readonly type: "tool-result";
			readonly id: number;
			readonly result?: Awaited<ReturnType<ToolDefinition["execute"]>>;
			readonly error?: string;
	  };

export type PiAgentWorkerResponse =
	| { readonly type: "ready"; readonly sessionId: string; readonly threadId: number }
	| { readonly type: "event"; readonly event: PiAgentEvent }
	| {
			readonly type: "tool";
			readonly id: number;
			readonly name: string;
			readonly toolCallId: string;
			readonly params: unknown;
	  }
	| {
			readonly type: "complete";
			readonly stats: SessionStats;
			readonly usages: readonly Usage[];
			readonly failure?: string;
	  }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "aborted" }
	| { readonly type: "configured" };

export const PI_CHAT_MAX_PERSISTENT_SESSIONS = 3;
export const PI_AGENT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
