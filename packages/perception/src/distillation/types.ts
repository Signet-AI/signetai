/**
 * Types for the Distillation Layer.
 *
 * Cognitive Profile, Expertise Graph, Agent Card, and Working Style
 * types used across the distillation modules.
 */

// ---------------------------------------------------------------------------
// Cognitive Profile
// ---------------------------------------------------------------------------

export interface CognitiveProfile {
	problemSolving: {
		approach: "systematic" | "exploratory" | "collaborative" | "intuitive";
		debuggingStyle: string;
		researchDepth: "surface" | "moderate" | "deep";
		prefersTryFirst: boolean;
	};
	communication: {
		verbosity: "terse" | "moderate" | "detailed";
		formality: "casual" | "professional" | "technical";
		preferredFormats: string[];
		documentationHabits: string;
	};
	workPatterns: {
		peakHours: number[];
		averageSessionMinutes: number;
		contextSwitchFrequency: "low" | "moderate" | "high";
		breakFrequency: "regular" | "irregular" | "rare";
	};
	toolPreferences: {
		editor: string;
		terminal: string;
		prefersCLI: boolean;
		automationLevel: "manual" | "scripts" | "heavy-automation";
	};
	expertise: {
		primaryDomains: string[];
		languages: string[];
		frameworks: string[];
		weakAreas: string[];
	};
	decisionMaking: {
		speed: "quick" | "deliberate" | "analysis-paralysis";
		revisitsDecisions: boolean;
		riskTolerance: "conservative" | "moderate" | "bold";
	};
	lastUpdated: string;
	observationDays: number;
	confidenceScore: number;
}

// ---------------------------------------------------------------------------
// Working Style
// ---------------------------------------------------------------------------

export interface WorkingStyle {
	peakHours: number[];
	averageSessionMinutes: number;
	contextSwitchFrequency: "low" | "moderate" | "high";
	breakFrequency: "regular" | "irregular" | "rare";
	mostUsedApps: Array<{ app: string; percentage: number }>;
	terminalUsagePercent: number;
	totalCapturedHours: number;
}

// ---------------------------------------------------------------------------
// Expertise Graph
// ---------------------------------------------------------------------------

export type EntityType =
	| "skill"
	| "tool"
	| "language"
	| "framework"
	| "project"
	| "person"
	| "domain";

export interface ExpertiseNode {
	id: string;
	name: string;
	entityType: EntityType;
	mentions: number;
	firstSeen: string;
	lastSeen: string;
}

export interface ExpertiseEdge {
	sourceId: string;
	targetId: string;
	weight: number;
	coOccurrences: number;
}

export interface ExpertiseGraph {
	nodes: ExpertiseNode[];
	edges: ExpertiseEdge[];
	generatedAt: string;
}

export interface ExpertiseDepth {
	domain: string;
	memoryCount: number;
	uniqueSkills: number;
	relatedEntities: string[];
	depth: "surface" | "moderate" | "deep" | "expert";
}

// ---------------------------------------------------------------------------
// Agent Card (A2A-compatible)
// ---------------------------------------------------------------------------

export interface AgentCardSkill {
	id: string;
	name: string;
	description: string;
	evidenceCount: number;
}

export interface AgentCard {
	name: string;
	description: string;
	version: string;
	generatedAt: string;

	skills: AgentCardSkill[];

	communicationStyle: {
		verbosity: string;
		format: string;
		tone: string;
	};

	context: {
		timezone: string;
		peakHours: number[];
		tools: {
			editor: string;
			terminal: string;
			prefersCLI: boolean;
		};
	};

	expertise: {
		primaryDomains: string[];
		languages: string[];
		frameworks: string[];
	};

	identity?: {
		did?: string;
		signature?: string;
	};
}

// ---------------------------------------------------------------------------
// Distillation State
// ---------------------------------------------------------------------------

export interface DistillationState {
	lastRun?: string;
	lastProfileUpdate?: string;
	lastGraphUpdate?: string;
	lastCardGeneration?: string;
}
