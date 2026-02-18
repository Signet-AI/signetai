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

export interface Memory {
	id: string;
	type: "fact" | "preference" | "decision" | "daily-log";
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
