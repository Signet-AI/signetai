/**
 * Standalone types for the Signet OpenCode plugin.
 *
 * Keep runtime behavior routed through shared @signet/core helpers where
 * possible so OpenCode stays aligned with CLI, MCP, and harness surfaces.
 */

export const DAEMON_URL_DEFAULT = "http://localhost:3850";
export const RUNTIME_PATH = "plugin" as const;
export const HARNESS = "opencode" as const;
export const READ_TIMEOUT = 5000;
export const WRITE_TIMEOUT = 10000;
export const SESSION_START_TIMEOUT_ENV = "SIGNET_SESSION_START_TIMEOUT";
export const FETCH_TIMEOUT_ENV = "SIGNET_FETCH_TIMEOUT";
export const PROMPT_SUBMIT_TIMEOUT_ENV = "SIGNET_PROMPT_SUBMIT_TIMEOUT";

export interface PluginConfig {
	enabled?: boolean;
	daemonUrl?: string;
}

export interface MemoryRecord {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly importance: number;
	readonly tags: string | null;
	readonly pinned: number;
	readonly who: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}
