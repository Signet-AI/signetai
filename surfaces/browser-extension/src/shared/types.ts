/** Shared types for the Signet browser extension */

export interface Memory {
	readonly id: string;
	readonly content: string;
	readonly created_at: string;
	readonly who: string;
	readonly importance: number;
	readonly tags?: string | readonly string[] | null;
	readonly source_type?: string;
	readonly type?: string;
	readonly pinned?: boolean;
	readonly score?: number;
	readonly source?: "hybrid" | "vector" | "keyword";
}

export interface MemoryStats {
	readonly total: number;
	readonly withEmbeddings: number;
	readonly critical: number;
}

export interface DaemonStatus {
	readonly status: string;
	readonly version: string;
	readonly pid: number;
	readonly uptime: number;
	readonly startedAt: string;
	readonly port: number;
	readonly host: string;
	readonly agentsDir: string;
	readonly memoryDb: boolean;
}

export interface HealthResponse {
	readonly status: string;
	readonly version?: string;
	readonly uptime?: number;
}

export interface PipelineStatus {
	readonly status: string;
	readonly queue?: number;
	readonly processing?: number;
	readonly deadLetter?: number;
}

export interface Identity {
	readonly name: string;
	readonly creature: string;
	readonly vibe: string;
}

export interface RecallResult {
	readonly memories: readonly Memory[];
	readonly query: string;
	readonly count: number;
}

export interface RememberRequest {
	readonly content: string;
	readonly tags?: string;
	readonly importance?: number;
	readonly type?: string;
	readonly who?: string;
	readonly source_type?: string;
}

export type ThemeMode = "auto" | "dark" | "light";

export interface ExtensionConfig {
	readonly daemonUrl: string;
	readonly authToken: string;
	readonly theme: ThemeMode;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
	daemonUrl: "http://127.0.0.1:3850",
	authToken: "",
	theme: "auto",
} as const;
