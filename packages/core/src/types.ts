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
	"allowUpdateDelete",
	"graphEnabled",
	"autonomousEnabled",
	"mutationsFrozen",
	"autonomousFrozen",
] as const;

export type PipelineFlag = (typeof PIPELINE_FLAGS)[number];

export interface PipelineV2Config {
	readonly enabled: boolean;
	readonly shadowMode: boolean;
	readonly allowUpdateDelete: boolean;
	readonly graphEnabled: boolean;
	readonly autonomousEnabled: boolean;
	readonly mutationsFrozen: boolean;
	readonly autonomousFrozen: boolean;
	readonly extractionProvider: "ollama" | "claude-code";
	readonly extractionModel: string;
	readonly extractionTimeout: number;
	readonly workerPollMs: number;
	readonly workerMaxRetries: number;
	readonly leaseTimeoutMs: number;
	readonly minFactConfidenceForWrite: number;
	readonly graphBoostWeight: number;
	readonly graphBoostTimeoutMs: number;
	readonly rerankerEnabled: boolean;
	readonly rerankerModel: string;
	readonly rerankerTopN: number;
	readonly rerankerTimeoutMs: number;
	readonly maintenanceIntervalMs: number;
	readonly maintenanceMode: "observe" | "execute";
	readonly repairReembedCooldownMs: number;
	readonly repairReembedHourlyBudget: number;
	readonly repairRequeueCooldownMs: number;
	readonly repairRequeueHourlyBudget: number;
	// Document ingest worker
	readonly documentWorkerIntervalMs: number;
	readonly documentChunkSize: number;
	readonly documentChunkOverlap: number;
	readonly documentMaxContentBytes: number;
}

// -- Status/union constants --

export const MEMORY_TYPES = [
	"fact",
	"preference",
	"decision",
	"daily-log",
	"episodic",
	"procedural",
	"semantic",
	"system",
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

// -- Core interfaces --

export interface Memory {
	id: string;
	type: MemoryType;
	category?: string;
	content: string;
	confidence: number;
	sourceId?: string;
	sourceType?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	updatedBy: string;
	vectorClock: Record<string, number>;
	version: number;
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
