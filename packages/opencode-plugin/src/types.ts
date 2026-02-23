/**
 * Standalone types for the Signet OpenCode plugin.
 *
 * No @signet/* dependencies — this package must be independently
 * distributable.
 */

export const DAEMON_URL_DEFAULT = "http://localhost:3850";
export const RUNTIME_PATH = "plugin" as const;
export const HARNESS = "opencode" as const;
export const READ_TIMEOUT = 5000;
export const WRITE_TIMEOUT = 10000;

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

export interface RecallResult {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly importance: number;
	readonly score: number;
	readonly created_at: string;
}
