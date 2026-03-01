/**
 * Daemon hook request/response types.
 *
 * Mirrors the shapes from packages/daemon/src/hooks.ts so the harness
 * can call daemon endpoints without importing daemon internals.
 */

// ============================================================================
// Session Start
// ============================================================================

export interface SessionStartRequest {
	readonly harness: string;
	readonly project?: string;
	readonly agentId?: string;
	readonly context?: string;
	readonly sessionKey?: string;
	readonly runtimePath?: "plugin" | "legacy";
}

export interface SessionStartResponse {
	readonly identity: {
		readonly name: string;
		readonly description?: string;
	};
	readonly memories: ReadonlyArray<{
		readonly id: string;
		readonly content: string;
		readonly type: string;
		readonly importance: number;
		readonly created_at: string;
	}>;
	readonly recentContext?: string;
	readonly inject: string;
}

// ============================================================================
// User Prompt Submit
// ============================================================================

export interface UserPromptSubmitRequest {
	readonly harness: string;
	readonly project?: string;
	readonly userPrompt: string;
	readonly sessionKey?: string;
	readonly runtimePath?: "plugin" | "legacy";
}

export interface UserPromptSubmitResponse {
	readonly inject: string;
	readonly memoryCount: number;
	readonly queryTerms?: string;
	readonly engine?: string;
}

// ============================================================================
// Session End
// ============================================================================

export interface SessionEndRequest {
	readonly harness: string;
	readonly transcriptPath?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly cwd?: string;
	readonly reason?: string;
	readonly runtimePath?: "plugin" | "legacy";
}

export interface SessionEndResponse {
	readonly memoriesSaved: number;
	readonly queued?: boolean;
	readonly jobId?: string;
}

// ============================================================================
// Remember
// ============================================================================

export interface RememberRequest {
	readonly harness: string;
	readonly who?: string;
	readonly project?: string;
	readonly content: string;
	readonly sessionKey?: string;
	readonly idempotencyKey?: string;
	readonly runtimePath?: "plugin" | "legacy";
}

export interface RememberResponse {
	readonly saved: boolean;
	readonly id: string;
}

// ============================================================================
// Recall
// ============================================================================

export interface RecallRequest {
	readonly harness: string;
	readonly query: string;
	readonly project?: string;
	readonly limit?: number;
	readonly sessionKey?: string;
	readonly runtimePath?: "plugin" | "legacy";
}

export interface RecallResponse {
	readonly results: ReadonlyArray<{
		readonly id: string;
		readonly content: string;
		readonly type: string;
		readonly importance: number;
		readonly tags: string | null;
		readonly created_at: string;
	}>;
	readonly count: number;
}

// ============================================================================
// Pre-Compaction
// ============================================================================

export interface PreCompactionRequest {
	readonly harness: string;
	readonly sessionContext?: string;
	readonly messageCount?: number;
	readonly sessionKey?: string;
	readonly runtimePath?: "plugin" | "legacy";
}

export interface PreCompactionResponse {
	readonly summaryPrompt: string;
	readonly guidelines: string;
}

// ============================================================================
// Daemon Status
// ============================================================================

export interface DaemonStatus {
	readonly status: string;
	readonly version?: string;
	readonly uptime?: number;
	readonly pipeline?: {
		readonly mode?: string;
		readonly workers?: Record<string, unknown>;
	};
}

// ============================================================================
// Log Stream
// ============================================================================

export interface LogEntry {
	readonly timestamp: string;
	readonly level: "info" | "warn" | "error" | "debug";
	readonly category: string;
	readonly message: string;
	readonly data?: Record<string, unknown>;
}

// ============================================================================
// Telemetry
// ============================================================================

export interface TelemetryEvent {
	readonly event: string;
	readonly timestamp: string;
	readonly properties?: {
		readonly provider?: string;
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cacheReadTokens?: number;
		readonly cacheCreationTokens?: number;
		readonly totalCost?: number;
		readonly durationMs?: number;
		readonly success?: boolean;
		readonly errorCode?: string;
	};
}
