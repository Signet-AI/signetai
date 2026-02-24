/**
 * Core types for Signet
 */

export interface AgentManifest {
	version: number;
	schema: string;

	// Identity
	agent: {
		name: string;
		description?: string;
		created: string;
		updated: string;
	};

	// Owner (optional)
	owner?: {
		address?: string;
		localId?: string;
		ens?: string;
		name?: string;
	};

	// Harnesses this agent works with
	harnesses?: string[];

	// Embedding configuration
	embedding?: {
		provider: "ollama" | "openai";
		model: string;
		dimensions: number;
		base_url?: string;
		api_key?: string;
	};

	// Search configuration
	search?: {
		alpha: number; // Vector weight (0-1)
		top_k: number; // Candidates per source
		min_score: number; // Minimum threshold
	};

	// Memory configuration
	memory?: {
		database: string;
		vectors?: string;
		session_budget?: number;
		decay_rate?: number;
		pipelineV2?: Partial<PipelineV2Config>;
	};

	// Decentralized Identity (optional, auto-generated)
	did?: string;

	// Signing configuration
	signing?: {
		/** Whether to auto-sign new memories */
		autoSign: boolean;
		/** Key storage path (default: ~/.agents/.keys/signing.enc) */
		keyPath?: string;
	};

	// Trust & verification (optional)
	trust?: {
		verification: "none" | "erc8128" | "gpg" | "did" | "registry";
		registry?: string;
	};

	// Legacy fields
	auth?: {
		method: "none" | "erc8128" | "gpg" | "did";
		chainId?: number;
		// Phase J: deployment mode auth
		mode?: "local" | "team" | "hybrid";
		rateLimits?: Record<string, { windowMs?: number; max?: number }>;
	};
	capabilities?: string[];
	harnessCompatibility?: string[];
}

export interface Agent {
	manifest: AgentManifest;
	soul: string;
	memory: string;
	dbPath: string;
}

export interface AgentConfig {
	basePath?: string;
	dbPath?: string;
	autoSync?: boolean;
	embeddings?: {
		provider: "openai" | "ollama" | "local";
		model?: string;
		dimensions?: number;
	};
}

// -- Pipeline v2 feature flags --

export const PIPELINE_FLAGS = [
	"enabled",
	"shadowMode",
	"mutationsFrozen",
	"graph.enabled",
	"reranker.enabled",
	"autonomous.enabled",
	"autonomous.frozen",
	"autonomous.allowUpdateDelete",
] as const;

export type PipelineFlag = (typeof PIPELINE_FLAGS)[number];

// -- Pipeline v2 sub-config interfaces --

export interface PipelineExtractionConfig {
	readonly provider: "ollama" | "claude-code";
	readonly model: string;
	readonly timeout: number;
	readonly minConfidence: number;
}

export interface PipelineWorkerConfig {
	readonly pollMs: number;
	readonly maxRetries: number;
	readonly leaseTimeoutMs: number;
}

export interface PipelineGraphConfig {
	readonly enabled: boolean;
	readonly boostWeight: number;
	readonly boostTimeoutMs: number;
}

export interface PipelineRerankerConfig {
	readonly enabled: boolean;
	readonly model: string;
	readonly topN: number;
	readonly timeoutMs: number;
}

export interface PipelineAutonomousConfig {
	readonly enabled: boolean;
	readonly frozen: boolean;
	readonly allowUpdateDelete: boolean;
	readonly maintenanceIntervalMs: number;
	readonly maintenanceMode: "observe" | "execute";
}

export interface PipelineRepairConfig {
	readonly reembedCooldownMs: number;
	readonly reembedHourlyBudget: number;
	readonly requeueCooldownMs: number;
	readonly requeueHourlyBudget: number;
}

export interface PipelineDocumentsConfig {
	readonly workerIntervalMs: number;
	readonly chunkSize: number;
	readonly chunkOverlap: number;
	readonly maxContentBytes: number;
}

export interface PipelineGuardrailsConfig {
	readonly maxContentChars: number;
	readonly chunkTargetChars: number;
	readonly recallTruncateChars: number;
}

export interface PipelineV2Config {
	// Master switches (flat)
	readonly enabled: boolean;
	readonly shadowMode: boolean;
	readonly mutationsFrozen: boolean;
	readonly semanticContradictionEnabled: boolean;

	// Grouped sub-objects
	readonly extraction: PipelineExtractionConfig;
	readonly worker: PipelineWorkerConfig;
	readonly graph: PipelineGraphConfig;
	readonly reranker: PipelineRerankerConfig;
	readonly autonomous: PipelineAutonomousConfig;
	readonly repair: PipelineRepairConfig;
	readonly documents: PipelineDocumentsConfig;
	readonly guardrails: PipelineGuardrailsConfig;
}

// -- Status/union constants --

export const MEMORY_TYPES = [
	"fact",
	"preference",
	"decision",
	"rationale",
	"daily-log",
	"episodic",
	"procedural",
	"semantic",
	"system",
	"pattern",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const EXTRACTION_STATUSES = [
	"none",
	"pending",
	"completed",
	"failed",
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const JOB_STATUSES = [
	"pending",
	"leased",
	"completed",
	"failed",
	"dead",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const HISTORY_EVENTS = [
	"created",
	"updated",
	"deleted",
	"recovered",
	"merged",
	"none",
	"split",
] as const;
export type HistoryEvent = (typeof HISTORY_EVENTS)[number];

export const DECISION_ACTIONS = ["add", "update", "delete", "none"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

// -- Scheduled tasks --

export const TASK_HARNESSES = ["claude-code", "opencode"] as const;
export type TaskHarness = (typeof TASK_HARNESSES)[number];

export const TASK_RUN_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export interface ScheduledTask {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly cronExpression: string;
	readonly harness: TaskHarness;
	readonly workingDirectory: string | null;
	readonly enabled: boolean;
	readonly lastRunAt: string | null;
	readonly nextRunAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TaskRun {
	readonly id: string;
	readonly taskId: string;
	readonly status: TaskRunStatus;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly exitCode: number | null;
	readonly stdout: string | null;
	readonly stderr: string | null;
	readonly error: string | null;
}

// -- Core interfaces --

export interface Memory {
	id: string;
	type: MemoryType;
	category?: string;
	content: string;
	confidence: number;
	sourceId?: string;
	sourceType?: string;
	/** Tags — stored as comma-separated string in DB, parsed to array in rowToMemory */
	tags: string[];
	createdAt: string;
	updatedAt: string;
	updatedBy: string;
	/** @deprecated Legacy v1 field — always empty object ({}) in current schema */
	vectorClock: Record<string, number>;
	/** @deprecated Legacy v1 field — always 1 in current schema */
	version: number;
	/** @deprecated Legacy v1 field — always false in current schema */
	manualOverride: boolean;
	// v2 fields (optional for backward compatibility)
	contentHash?: string;
	normalizedContent?: string;
	isDeleted?: boolean;
	deletedAt?: string;
	pinned?: boolean;
	importance?: number;
	extractionStatus?: ExtractionStatus;
	embeddingModel?: string;
	extractionModel?: string;
	updateCount?: number;
	accessCount?: number;
	lastAccessed?: string;
	who?: string;
	// Web3 identity fields (optional, added in migration 012)
	signature?: string;
	signerDid?: string;
	// Temporal memory fields (optional, added in migration 013)
	strength?: number;
	lastRehearsed?: string;
	rehearsalCount?: number;
}

export interface Conversation {
	id: string;
	sessionId: string;
	harness: string;
	startedAt: string;
	endedAt?: string;
	summary?: string;
	topics: string[];
	decisions: string[];
	createdAt: string;
	updatedAt: string;
	updatedBy: string;
	vectorClock: Record<string, number>;
	version: number;
	manualOverride: boolean;
}

export interface Embedding {
	id: string;
	contentHash: string;
	vector: Float32Array;
	dimensions: number;
	sourceType: string;
	sourceId: string;
	chunkText: string;
	createdAt: string;
}

export interface MemoryHistory {
	id: string;
	memoryId: string;
	event: HistoryEvent;
	oldContent?: string;
	newContent?: string;
	changedBy: string;
	reason?: string;
	metadata?: string; // JSON
	createdAt: string;
	actorType?: string;
	sessionId?: string;
	requestId?: string;
}

export interface MemoryJob {
	id: string;
	memoryId: string;
	jobType: string;
	status: JobStatus;
	payload?: string; // JSON
	result?: string; // JSON
	attempts: number;
	maxAttempts: number;
	leasedAt?: string;
	completedAt?: string;
	failedAt?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Entity {
	id: string;
	name: string;
	canonicalName?: string;
	entityType: string;
	description?: string;
	mentions?: number;
	createdAt: string;
	updatedAt: string;
}

export interface Relation {
	id: string;
	sourceEntityId: string;
	targetEntityId: string;
	relationType: string;
	strength: number;
	mentions?: number;
	confidence?: number;
	metadata?: string;
	createdAt: string;
	updatedAt?: string;
}

export interface MemoryEntityMention {
	memoryId: string;
	entityId: string;
	mentionText?: string;
	confidence?: number;
	createdAt?: string;
}

// -- Merkle / Provenance types --

export interface MerkleRootRecord {
	id: number;
	rootHash: string;
	memoryCount: number;
	leafHashes?: string;
	computedAt: string;
	signerDid?: string;
	signature?: string;
	anchorChain?: string;
	anchorTx?: string;
	anchorBlock?: number;
	anchorTimestamp?: string;
	createdAt: string;
}

// -- Extraction pipeline contracts --

export interface ExtractedFact {
	readonly content: string;
	readonly type: MemoryType;
	readonly confidence: number;
}

export interface ExtractedEntity {
	readonly source: string;
	readonly relationship: string;
	readonly target: string;
	readonly confidence: number;
}

export interface ExtractionResult {
	readonly facts: readonly ExtractedFact[];
	readonly entities: readonly ExtractedEntity[];
	readonly warnings: readonly string[];
}

export interface DecisionProposal {
	readonly action: DecisionAction;
	readonly targetMemoryId?: string;
	readonly confidence: number;
	readonly reason: string;
}

export interface DecisionResult {
	readonly proposals: readonly DecisionProposal[];
	readonly warnings: readonly string[];
}
