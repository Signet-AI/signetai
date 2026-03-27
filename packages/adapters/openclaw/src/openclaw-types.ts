/**
 * Type stubs for OpenClaw Plugin API.
 *
 * OpenClaw is a peer dependency. These stubs mirror the upstream
 * plugin-sdk types so we get compile-time safety without a hard
 * dependency on the full SDK.
 *
 * Intersection with Record<string, unknown> on event/context types
 * preserves access to undocumented extra fields that older OpenClaw
 * versions pass (backwards compatibility).
 *
 * Upstream source: openclaw/src/plugins/types.ts
 */

// ============================================================================
// Hook event types (from PluginHookHandlerMap)
// ============================================================================

/** Context shared across all agent-scoped hooks. */
export type PluginHookAgentContext = {
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
	readonly workspaceDir?: string;
	readonly messageProvider?: string;
	readonly trigger?: string;
	readonly channelId?: string;
} & Record<string, unknown>;

export type PluginHookBeforePromptBuildEvent = {
	readonly prompt: string;
	readonly messages: unknown[];
} & Record<string, unknown>;

export type PluginHookBeforePromptBuildResult = {
	systemPrompt?: string;
	prependContext?: string;
	prependSystemContext?: string;
	appendSystemContext?: string;
};

export type PluginHookBeforeAgentStartEvent = {
	readonly prompt: string;
	readonly messages?: unknown[];
} & Record<string, unknown>;

export type PluginHookAgentEndEvent = {
	readonly messages: unknown[];
	readonly success: boolean;
	readonly error?: string;
	readonly durationMs?: number;
} & Record<string, unknown>;

export type PluginHookBeforeCompactionEvent = {
	readonly messageCount: number;
	readonly compactingCount?: number;
	readonly tokenCount?: number;
	readonly messages?: unknown[];
	readonly sessionFile?: string;
} & Record<string, unknown>;

export type PluginHookAfterCompactionEvent = {
	readonly messageCount: number;
	readonly tokenCount?: number;
	readonly compactedCount: number;
	readonly sessionFile?: string;
} & Record<string, unknown>;

// ============================================================================
// Plugin API
// ============================================================================

export interface OpenClawPluginApi {
	readonly pluginConfig?: Record<string, unknown>;
	readonly config?: unknown;
	readonly logger: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string): void;
	};
	registerTool(
		definition: OpenClawToolDefinition,
		metadata?: {
			name?: string;
			names?: string[];
			optional?: boolean;
		},
	): void;
	registerCli(fn: (ctx: { program: unknown }) => void, opts?: { commands?: readonly string[] }): void;
	registerService(service: {
		id: string;
		start(): void | Promise<void>;
		stop(): void | Promise<void>;
	}): void;

	// Typed overloads for known hooks
	on(
		event: "before_prompt_build",
		handler: (
			event: PluginHookBeforePromptBuildEvent,
			ctx: PluginHookAgentContext,
		) => Promise<PluginHookBeforePromptBuildResult | undefined> | PluginHookBeforePromptBuildResult | undefined,
		opts?: { priority?: number },
	): void;
	on(
		event: "before_agent_start",
		handler: (
			event: PluginHookBeforeAgentStartEvent,
			ctx: PluginHookAgentContext,
		) => Promise<PluginHookBeforePromptBuildResult | undefined> | PluginHookBeforePromptBuildResult | undefined,
		opts?: { priority?: number },
	): void;
	on(
		event: "agent_end",
		handler: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> | void,
		opts?: { priority?: number },
	): void;
	on(
		event: "before_compaction",
		handler: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void,
		opts?: { priority?: number },
	): void;
	on(
		event: "after_compaction",
		handler: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void,
		opts?: { priority?: number },
	): void;
	// Fallback for unknown/newer hooks + legacy event names
	on(
		event: string,
		handler: (event: Record<string, unknown>, ctx: unknown) => unknown | Promise<unknown>,
		opts?: { priority?: number },
	): void;

	resolvePath?(p: string): string;
}

export interface OpenClawToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	execute(toolCallId: string, params: unknown): Promise<OpenClawToolResult>;
}

export interface OpenClawToolResult {
	readonly content: ReadonlyArray<{
		readonly type: string;
		readonly text: string;
	}>;
	readonly details?: Record<string, unknown>;
}
