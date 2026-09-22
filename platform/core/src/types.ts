export const ACCOUNTING_PROVENANCES = [
	"provider_reported",
	"locally_estimated",
	"configured_rate",
	"local_zero_cost",
	"unavailable",
] as const;

export type AccountingProvenance = (typeof ACCOUNTING_PROVENANCES)[number];
export type AccountingSummaryProvenance = AccountingProvenance | "mixed";
export type InferenceLocality = "local" | "remote" | "unknown";
export interface LlmTelemetryAttribution {
	readonly executor: string;
	readonly provider?: string;
	readonly model?: string;
	readonly locality: InferenceLocality;
}
export function summarizeAccountingProvenance(
	values: readonly (AccountingProvenance | null | undefined)[],
): AccountingSummaryProvenance {
	const present = new Set<AccountingProvenance>(
		values.filter((value): value is AccountingProvenance => value !== null && value !== undefined),
	);
	if (present.size === 0) return "unavailable";
	if (present.size === 1) return present.values().next().value ?? "unavailable";
	return "mixed";
}

export interface LlmCacheRequestAccounting {
	readonly requests: number;
	readonly hits: number;
	readonly misses: number;
	readonly unknown: number;
	readonly writes: number;
}

export interface LlmUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheReadTokens: number | null;
	readonly cacheCreationTokens: number | null;
	readonly totalTokens: number | null;
	readonly totalCost: number | null;
	readonly totalDurationMs: number | null;
	readonly accountingProvenance?: AccountingProvenance;
	readonly cacheRequests?: LlmCacheRequestAccounting | null;
}

export interface LlmGenerateResult {
	readonly text: string;
	readonly usage: LlmUsage | null;
}

export interface LlmGenerateOptions {
	readonly timeoutMs?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignal;
	readonly sessionId?: string;
	readonly responseFormat?: "json";
	readonly think?: boolean;
}

export interface LlmProvider {
	readonly name: string;
	readonly accountingProvenance?: AccountingProvenance;
	readonly telemetryAttribution?: LlmTelemetryAttribution;
	generate(prompt: string, opts?: LlmGenerateOptions): Promise<string>;
	generateWithUsage?(prompt: string, opts?: LlmGenerateOptions): Promise<LlmGenerateResult>;
	available(): Promise<boolean>;
}
export type ReadPolicy = "isolated" | "shared" | { readonly type: "group"; readonly group: string };
export interface AgentDefinition {
	readonly name: string;
	readonly model?: string;
	readonly harnesses?: readonly string[];
	readonly skills?: readonly string[];
	readonly personality?: string;
	readonly memory?: {
		readonly read_policy?: ReadPolicy;
	};
}

export interface AgentManifest {
	version: number;
	schema: string;
	agent: {
		name: string;
		description?: string;
		created: string;
		updated: string;
	};
	owner?: {
		address?: string;
		localId?: string;
		ens?: string;
		name?: string;
	};
	agents?: {
		readonly roster: readonly AgentDefinition[];
	};
	harnesses?: string[];
	embedding?: {
		provider: "native" | "llama-cpp" | "ollama" | "openai" | "local";
		model: string;
		dimensions: number;
		base_url?: string;
		api_key?: string;
	};
	search?: {
		alpha: number;
		top_k: number;
		min_score: number;
	};
	memory?: {
		database: string;
		vectors?: string;
		session_budget?: number;
		decay_rate?: number;
		pipelineV2?: Partial<PipelineV2Config>;
		dreaming?: Partial<DreamingConfig>;
	};
	trust?: {
		verification: "none" | "erc8128" | "gpg" | "did" | "registry";
		registry?: string;
	};
	services?: {
		openclaw?: {
			restart_command?: string;
		};
	};
	home?: {
		spotlightEntity?: string;
	};
	auth?: {
		method: "none" | "erc8128" | "gpg" | "did";
		chainId?: number;
		mode?: "local" | "team" | "hybrid";
		defaultTokenTtlSeconds?: number;
		sessionTokenTtlSeconds?: number;
		login?: {
			password?: {
				username?: string;
				passwordHash?: string | null;
			};
			sso?: { enabled?: boolean };
			saml?: { enabled?: boolean };
		};
		rateLimits?: Record<string, { windowMs?: number; max?: number }>;
	};
	capabilities?:
		| string[]
		| {
				memory?: {
					enabled?: boolean;
					autoInject?: boolean;
					memoryHead?: boolean;
				};
				secrets?: {
					enabled?: boolean;
				};
				identity?: {
					mode?: "managed" | "off";
				};
		  };
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
		provider: "native" | "llama-cpp" | "ollama" | "openai" | "local";
		model?: string;
		dimensions?: number;
	};
}

export const PIPELINE_FLAGS = [
	"enabled",
	"paused",
	"shadowMode",
	"mutationsFrozen",
	"graph.enabled",
	"traversal.enabled",
	"reranker.enabled",
	"autonomous.enabled",
	"autonomous.frozen",
	"autonomous.allowUpdateDelete",
	"telemetryEnabled",
] as const;

export type PipelineFlag = (typeof PIPELINE_FLAGS)[number];

export interface PipelineCommandConfig {
	readonly bin: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}
export interface ProviderRateLimitConfig {
	readonly maxCallsPerHour?: number;
	readonly burstSize?: number;
	readonly waitTimeoutMs?: number;
}

export const DEFAULT_PROVIDER_RATE_LIMIT: Required<ProviderRateLimitConfig> = {
	maxCallsPerHour: 200,
	burstSize: 20,
	waitTimeoutMs: 5000,
};

export interface PipelineExtractionConfig {
	readonly strength: "low" | "medium" | "high";
	readonly timeout: number;
	readonly minConfidence: number;
	readonly structuredOutput?: boolean;
	readonly rateLimit?: ProviderRateLimitConfig;
}

export interface PipelineWorkerConfig {
	readonly maxRetries: number;
	readonly leaseTimeoutMs: number;
	readonly maxLlmConcurrency: number;
}

export interface PipelineClaudeCodeConfig {
	readonly allowApiKeyEnv: boolean;
	readonly maxBudgetUsd?: number;
	readonly cooldownMs: number;
}

export interface PipelineGraphConfig {
	readonly enabled: boolean;
	readonly boostWeight: number;
	readonly boostTimeoutMs: number;
}

export interface PipelineTraversalConfig {
	readonly enabled: boolean;
	readonly primary: boolean;
	readonly maxAspectsPerEntity: number;
	readonly maxAttributesPerAspect: number;
	readonly maxWriteAspectsPerEntity: number;
	readonly maxWriteAttributesPerAspect: number;
	readonly maxDependencyHops: number;
	readonly minDependencyStrength: number;
	readonly maxBranching: number;
	readonly maxTraversalPaths: number;
	readonly minConfidence: number;
	readonly timeoutMs: number;
	readonly boostWeight: number;
	readonly constraintBudgetChars: number;
}

export interface PipelineRerankerConfig {
	readonly enabled: boolean;
	readonly model: string;
	readonly useExtractionModel: boolean;
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
	readonly dedupCooldownMs: number;
	readonly dedupHourlyBudget: number;
	readonly dedupSemanticThreshold: number;
	readonly dedupBatchSize: number;
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
	readonly contextBudgetChars?: number;
}

export const TELEMETRY_DEPLOYMENT_ROLES = [
	"personal",
	"service",
	"automation",
	"development",
	"ci",
	"unknown",
] as const;

export type TelemetryDeploymentRole = (typeof TELEMETRY_DEPLOYMENT_ROLES)[number];

export const TELEMETRY_INSTALL_CHANNELS = ["desktop", "package-manager", "source", "container", "unknown"] as const;

export type TelemetryInstallChannel = (typeof TELEMETRY_INSTALL_CHANNELS)[number];

export interface PipelineTelemetryConfig {
	readonly posthogHost: string;
	readonly posthogApiKey: string;
	readonly flushIntervalMs: number;
	readonly flushBatchSize: number;
	readonly retentionDays: number;
	readonly memorySearchQaEnabled: boolean;
	readonly deploymentRole?: TelemetryDeploymentRole;
	readonly installChannel?: TelemetryInstallChannel;
}

export interface PipelineContinuityConfig {
	readonly enabled: boolean;
	readonly promptInterval: number;
	readonly timeIntervalMs: number;
	readonly maxCheckpointsPerSession: number;
	readonly retentionDays: number;
	readonly recoveryBudgetChars: number;
}

export interface PipelineSubagentsConfig {
	readonly inheritContext: boolean;
	readonly tailChars: number;
}

export interface PipelineV2Config {
	readonly enabled: boolean;
	readonly paused: boolean;
	readonly shadowMode: boolean;
	readonly mutationsFrozen: boolean;
	readonly semanticContradictionEnabled: boolean;
	readonly semanticContradictionTimeoutMs: number;
	readonly telemetryEnabled: boolean;
	readonly extraction: PipelineExtractionConfig;
	readonly worker: PipelineWorkerConfig;
	readonly claudeCode: PipelineClaudeCodeConfig;
	readonly graph: PipelineGraphConfig;
	readonly traversal?: PipelineTraversalConfig;
	readonly reranker: PipelineRerankerConfig;
	readonly autonomous: PipelineAutonomousConfig;
	readonly repair: PipelineRepairConfig;
	readonly documents: PipelineDocumentsConfig;
	readonly guardrails: PipelineGuardrailsConfig;
	readonly telemetry: PipelineTelemetryConfig;
	readonly continuity: PipelineContinuityConfig;
	readonly subagents?: PipelineSubagentsConfig;
	readonly embeddingTracker: PipelineEmbeddingTrackerConfig;
	readonly procedural: PipelineProceduralConfig;
	readonly feedback: PipelineFeedbackConfig;
	readonly significance?: PipelineSignificanceConfig;
	readonly modelRegistry: PipelineModelRegistryConfig;
	readonly hints?: PipelineHintsConfig;
	readonly reflections: PipelineReflectionsConfig;
}

export interface ModelRegistryEntry {
	readonly id: string;
	readonly provider: string;
	readonly label: string;
	readonly tier: "high" | "mid" | "low";
	readonly deprecated: boolean;
}

export interface PipelineModelRegistryConfig {
	readonly enabled: boolean;
	readonly refreshIntervalMs: number;
}

export interface PipelineEmbeddingTrackerConfig {
	readonly enabled: boolean;
	readonly pollMs: number;
	readonly batchSize: number;
}

export interface PipelineProceduralConfig {
	readonly enabled: boolean;
	readonly decayRate: number;
	readonly minImportance: number;
	readonly importanceOnInstall: number;
	readonly reconcileIntervalMs: number;
}

export interface PipelineFeedbackConfig {
	readonly enabled: boolean;
	readonly ftsWeightDelta: number;
	readonly maxAspectWeight: number;
	readonly minAspectWeight: number;
	readonly decayEnabled: boolean;
	readonly decayRate: number;
	readonly staleDays: number;
	readonly decayIntervalSessions: number;
}

export interface PipelineSignificanceConfig {
	readonly enabled: boolean;
	readonly minTurns: number;
	readonly minEntityOverlap: number;
	readonly noveltyThreshold: number;
}

export interface PipelineHintsConfig {
	readonly enabled: boolean;
	readonly max: number;
	readonly timeout: number;
	readonly maxTokens: number;
	readonly poll: number;
}

export interface PipelineReflectionsConfig {
	readonly enabled: boolean;
	readonly model: string;
	readonly timeout: number;
	readonly maxTokens: number;
	readonly schedule: string;
	readonly timezone: string;
	readonly count: number;
	readonly timeWindowHours: number;
	readonly maxMemories: number;
	readonly maxSummaries: number;
}

export interface DreamingSurprisalConfig {
	readonly enabled: boolean;
	readonly sampleSize: number;
	readonly maxCandidates: number;
	readonly minObservations: number;
	readonly neighborCount: number;
	readonly treeLeafSize: number;
	readonly minScore: number;
}

export interface DreamingConfig {
	readonly enabled: boolean;
	readonly tokenThreshold: number;
	readonly maxInterval: number;
	readonly timeout: number;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly backfillOnFirstRun: boolean;
	readonly surprisal?: DreamingSurprisalConfig;
}

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
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const EXTRACTION_STATUSES = ["none", "pending", "completed", "failed"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const JOB_STATUSES = ["pending", "leased", "completed", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const HISTORY_EVENTS = ["created", "updated", "deleted", "recovered", "merged", "none", "split"] as const;
export type HistoryEvent = (typeof HISTORY_EVENTS)[number];

export const DECISION_ACTIONS = ["add", "update", "delete", "none"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface Memory {
	id: string;
	type: MemoryType;
	category?: string;
	content: string;
	confidence: number;
	sourceId?: string;
	sourceType?: string;
	sourcePath?: string;
	runtimePath?: string;
	idempotencyKey?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	updatedBy: string;
	vectorClock: Record<string, number>;
	version: number;
	manualOverride: boolean;
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
	metadata?: string;
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
	payload?: string;
	result?: string;
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
	agentId: string;
	description?: string;
	mentions?: number;
	pinned?: boolean;
	pinnedAt?: string | null;
	status?: OntologyRowStatus;
	archivedAt?: string | null;
	archivedBy?: string | null;
	archiveReason?: string | null;
	proposalId?: string | null;
	proposalEvidence?: readonly unknown[];
	createdAt: string;
	updatedAt: string;
}

export interface EntityAlias {
	readonly id: string;
	readonly entityId: string;
	readonly agentId: string;
	readonly alias: string;
	readonly canonicalAlias: string;
	readonly confidence: number;
	readonly source: string | null;
	readonly status: OntologyRowStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
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

export interface ExtractedFact {
	readonly content: string;
	readonly type: MemoryType;
	readonly confidence: number;
}

export interface ExtractedEntity {
	readonly source: string;
	readonly sourceType?: string;
	readonly relationship: string;
	readonly target: string;
	readonly targetType?: string;
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

export const ENTITY_TYPES = [
	"person",
	"project",
	"system",
	"tool",
	"concept",
	"skill",
	"task",
	"source",
	"artifact",
	"agent",
	"policy",
	"action",
	"workflow",
	"event",
	"object_type",
	"interface",
	"observation",
	"claim_slot",
	"claim_value",
	"unknown",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ATTRIBUTE_KINDS = ["attribute", "constraint", "claim"] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

export const ATTRIBUTE_STATUSES = ["active", "superseded", "deleted"] as const;
export type AttributeStatus = (typeof ATTRIBUTE_STATUSES)[number];
export const ONTOLOGY_ROW_STATUSES = ["active", "archived"] as const;
export type OntologyRowStatus = (typeof ONTOLOGY_ROW_STATUSES)[number];

export const DEPENDENCY_TYPES = [
	"uses",
	"requires",
	"owned_by",
	"owns",
	"blocks",
	"informs",
	"maintains",
	"implements",
	"built",
	"depends_on",
	"related_to",
	"learned_from",
	"teaches",
	"knows",
	"assumes",
	"supports_claim",
	"authored_by",
	"links_to",
	"contains",
	"contains_note",
	"contradicts",
	"supersedes",
	"part_of",
	"produced_artifact",
	"precedes",
	"follows",
	"triggers",
	"may_execute",
	"requires_approval_from",
	"impacts",
	"produces",
	"consumes",
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const DEPENDENCY_DESCRIPTIONS: Record<DependencyType, string> = {
	uses: "actively calls or consumes at runtime",
	requires: "cannot function without (hard prerequisite)",
	owned_by: "is maintained or governed by",
	owns: "maintains or governs",
	blocks: "prevents progress of",
	informs: "sends data or signals to",
	maintains: "keeps operational or up to date",
	implements: "provides the concrete behavior for",
	built: "was created or constructed by",
	depends_on: "needs but does not directly call (soft dependency)",
	related_to: "associated loosely, no directional dependency",
	learned_from: "acquired knowledge from",
	teaches: "transfers knowledge to",
	knows: "is aware of or references",
	assumes: "presupposes as true without verifying",
	supports_claim: "provides evidence for a claim",
	authored_by: "was written or created by",
	links_to: "references or hyperlinks to",
	contains: "has as a nested child or member",
	contains_note: "includes a note or document",
	contradicts: "conflicts with or negates",
	supersedes: "replaces or obsoletes",
	part_of: "is a component or subset of",
	produced_artifact: "created a durable file, build, or output artifact",
	precedes: "must happen before (temporal)",
	follows: "happens after (temporal)",
	triggers: "causes to start or execute",
	may_execute: "is allowed or able to run",
	requires_approval_from: "needs approval from before proceeding",
	impacts: "change here affects (blast radius)",
	produces: "generates as output",
	consumes: "takes as input",
};

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ONTOLOGY_PROPOSAL_STATUSES = ["pending", "applied", "rejected", "failed"] as const;
export type OntologyProposalStatus = (typeof ONTOLOGY_PROPOSAL_STATUSES)[number];

export const EPISTEMIC_ASSERTION_PREDICATES = [
	"claims",
	"believes",
	"observed",
	"decided",
	"prefers",
	"denies",
	"questions",
] as const;
export type EpistemicAssertionPredicate = (typeof EPISTEMIC_ASSERTION_PREDICATES)[number];

export const EPISTEMIC_ASSERTION_STATUSES = ["active", "archived", "superseded"] as const;
export type EpistemicAssertionStatus = (typeof EPISTEMIC_ASSERTION_STATUSES)[number];

export const ONTOLOGY_CONTRADICTION_STATUSES = ["active", "resolved"] as const;
export type OntologyContradictionStatus = (typeof ONTOLOGY_CONTRADICTION_STATUSES)[number];

export const ONTOLOGY_PROPOSAL_OPERATIONS = [
	"create_entity",
	"add_claim_value",
	"set_claim_value",
	"rename_entity",
	"archive_entity",
	"create_aspect",
	"rename_aspect",
	"archive_aspect",
	"archive_claim_value",
	"restore_claim_version",
	"create_link",
	"update_link",
	"archive_link",
	"merge_entities",
	"merge_aspects",
	"supersede_claim_value",
	"create_policy",
	"create_action_type",
	"create_interface",
	"attach_interface",
] as const;
export type OntologyProposalOperation = (typeof ONTOLOGY_PROPOSAL_OPERATIONS)[number];

export interface OntologyProposal {
	readonly id: string;
	readonly agentId: string;
	readonly operation: string;
	readonly status: OntologyProposalStatus;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly confidence: number;
	readonly rationale: string;
	readonly evidence: readonly unknown[];
	readonly risk: string | null;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly createdBy: string;
	readonly appliedBy: string | null;
	readonly rejectedBy: string | null;
	readonly result: Readonly<Record<string, unknown>> | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly appliedAt: string | null;
	readonly rejectedAt: string | null;
}

export interface EntityAspect {
	readonly id: string;
	readonly entityId: string;
	readonly agentId: string;
	readonly name: string;
	readonly canonicalName: string;
	readonly weight: number;
	readonly status?: OntologyRowStatus;
	readonly archivedAt?: string | null;
	readonly archivedBy?: string | null;
	readonly archiveReason?: string | null;
	readonly proposalId?: string | null;
	readonly proposalEvidence?: readonly unknown[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface EntityAttribute {
	readonly id: string;
	readonly aspectId: string;
	readonly agentId: string;
	readonly memoryId: string | null;
	readonly kind: AttributeKind;
	readonly content: string;
	readonly normalizedContent: string;
	readonly groupKey: string | null;
	readonly claimKey: string | null;
	readonly confidence: number;
	readonly importance: number;
	readonly status: AttributeStatus;
	readonly supersededBy: string | null;
	readonly version?: number;
	readonly versionRootId?: string | null;
	readonly previousAttributeId?: string | null;
	readonly archivedAt?: string | null;
	readonly archivedBy?: string | null;
	readonly archiveReason?: string | null;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly proposalId: string | null;
	readonly proposalEvidence: readonly unknown[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface EntityDependency {
	readonly id: string;
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	readonly agentId: string;
	readonly aspectId: string | null;
	readonly dependencyType: DependencyType;
	readonly strength: number;
	readonly confidence: number;
	readonly reason: string | null;
	readonly status?: OntologyRowStatus;
	readonly archivedAt?: string | null;
	readonly archivedBy?: string | null;
	readonly archiveReason?: string | null;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly proposalId: string | null;
	readonly proposalEvidence: readonly unknown[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface EpistemicAssertion {
	readonly id: string;
	readonly agentId: string;
	readonly observerId: string;
	readonly subjectEntityId: string;
	readonly subjectEntityName: string | null;
	readonly claimAttributeId: string | null;
	readonly predicate: EpistemicAssertionPredicate;
	readonly content: string;
	readonly normalizedContent: string;
	readonly speaker: string | null;
	readonly assertedAt: string;
	readonly confidence: number;
	readonly evidence: readonly unknown[];
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly status: EpistemicAssertionStatus;
	readonly supersedesAssertionId: string | null;
	readonly archivedAt: string | null;
	readonly archivedBy: string | null;
	readonly archiveReason: string | null;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface OntologyContradiction {
	readonly id: string;
	readonly agentId: string;
	readonly entityId: string | null;
	readonly entityName: string;
	readonly aspectId: string | null;
	readonly aspectName: string;
	readonly groupKey: string;
	readonly claimKey: string;
	readonly leftAttributeId: string | null;
	readonly rightAttributeId: string | null;
	readonly leftContent: string;
	readonly rightContent: string;
	readonly leftConfidence: number;
	readonly rightConfidence: number;
	readonly leftScope: string | null;
	readonly rightScope: string | null;
	readonly leftVisibility: string | null;
	readonly rightVisibility: string | null;
	readonly leftSourceKind: string | null;
	readonly leftSourceId: string | null;
	readonly leftSourcePath: string | null;
	readonly leftSourceRoot: string | null;
	readonly rightSourceKind: string | null;
	readonly rightSourceId: string | null;
	readonly rightSourcePath: string | null;
	readonly rightSourceRoot: string | null;
	readonly leftEvidence: readonly unknown[];
	readonly rightEvidence: readonly unknown[];
	readonly detector: "lexical" | "semantic" | "manual";
	readonly reason: string;
	readonly confidence: number;
	readonly status: OntologyContradictionStatus;
	readonly detectedAt: string;
	readonly resolvedAt: string | null;
	readonly resolutionReason: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TaskMeta {
	readonly entityId: string;
	readonly agentId: string;
	readonly status: TaskStatus;
	readonly expiresAt: string | null;
	readonly retentionUntil: string | null;
	readonly completedAt: string | null;
	readonly updatedAt: string;
}
