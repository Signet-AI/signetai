/**
 * Minimal type stubs for OpenClaw Plugin API.
 *
 * OpenClaw is a peer dependency — these stubs let us build without
 * having the full SDK installed in the monorepo.
 */

export interface OpenClawPluginApi {
	readonly pluginConfig: unknown;
	readonly logger: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string): void;
	};
	registerTool(
		definition: OpenClawToolDefinition,
		metadata: { name: string },
	): void;
	registerCli(
		fn: (ctx: { program: unknown }) => void,
		opts: { commands: readonly string[] },
	): void;
	registerService(service: {
		id: string;
		start(): void;
		stop(): void;
	}): void;
	on(
		event: string,
		handler: (
			event: Record<string, unknown>,
			ctx: unknown,
		) => Promise<unknown>,
	): void;
	resolvePath?(p: string): string;
}

export interface OpenClawToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	execute(
		toolCallId: string,
		params: unknown,
	): Promise<OpenClawToolResult>;
}

export interface OpenClawToolResult {
	readonly content: ReadonlyArray<{
		readonly type: string;
		readonly text: string;
	}>;
	readonly details?: Record<string, unknown>;
}
