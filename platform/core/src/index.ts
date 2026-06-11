/**
 * @signet/core
 * Core library for Signet - portable AI agent identity
 */

export { Signet } from "./signet";
export { Database, findSqliteVecExtension, loadSqliteVec } from "./database";
export {
	MEMORY_TYPES,
	EXTRACTION_STATUSES,
	JOB_STATUSES,
	HISTORY_EVENTS,
	DECISION_ACTIONS,
	PIPELINE_FLAGS,
	ENTITY_TYPES,
	ATTRIBUTE_KINDS,
	ATTRIBUTE_STATUSES,
	DEPENDENCY_DESCRIPTIONS,
	DEPENDENCY_TYPES,
	TASK_STATUSES,
	ONTOLOGY_PROPOSAL_STATUSES,
	ONTOLOGY_PROPOSAL_OPERATIONS,
	EPISTEMIC_ASSERTION_PREDICATES,
	EPISTEMIC_ASSERTION_STATUSES,
	TASK_HARNESSES,
	DEFAULT_PROVIDER_RATE_LIMIT,
} from "./types";
export type {
	Agent,
	AgentManifest,
	AgentConfig,
	LlmProvider,
	LlmUsage,
	LlmGenerateResult,
	ReadPolicy,
	AgentDefinition,
	Memory,
	MemoryType,
	Conversation,
	Embedding,
	MemoryHistory,
	MemoryJob,
	Entity,
	Relation,
	MemoryEntityMention,
	ExtractionStatus,
	JobStatus,
	HistoryEvent,
	DecisionAction,
	PipelineFlag,
	PipelineV2Config,
	PipelineEscalationConfig,
	PipelineExtractionConfig,
	PipelineWorkerConfig,
	PipelineGraphConfig,
	PipelineTraversalConfig,
	PipelineRerankerConfig,
	PipelineReflectionsConfig,
	PipelineAutonomousConfig,
	PipelineRepairConfig,
	PipelineDocumentsConfig,
	PipelineGuardrailsConfig,
	PipelineTelemetryConfig,
	PipelineEmbeddingTrackerConfig,
	PipelineContinuityConfig,
	PipelineSynthesisConfig,
	ProviderRateLimitConfig,
	PipelineProceduralConfig,
	ExtractedFact,
	ExtractedEntity,
	ExtractionResult,
	DecisionProposal,
	DecisionResult,
	EntityType,
	AttributeKind,
	AttributeStatus,
	DependencyType,
	TaskStatus,
	OntologyProposalStatus,
	OntologyProposalOperation,
	OntologyProposal,
	EpistemicAssertionPredicate,
	EpistemicAssertionStatus,
	EpistemicAssertion,
	TaskHarness,
	EntityAspect,
	EntityAttribute,
	EntityDependency,
	TaskMeta,
	PipelineStructuralConfig,
	PipelineSignificanceConfig,
	PipelineModelRegistryConfig,
	PipelineHintsConfig,
	DreamingConfig,
	ModelRegistryEntry,
} from "./types";
export {
	DEFAULT_PIPELINE_TIMEOUT_MS,
	OPENCODE_PIPELINE_AGENT,
	OPENCODE_PIPELINE_SYSTEM_PROMPT,
	PIPELINE_PROVIDER_CHOICES,
	SYNTHESIS_PROVIDER_CHOICES,
	defaultPipelineModel,
	isPipelineProvider,
	isSynthesisProvider,
} from "./pipeline-providers";
export type { PipelineProviderChoice, SynthesisProviderChoice } from "./pipeline-providers";
export {
	MODEL_DEFAULTS,
	PIPELINE_MODEL_CATALOG,
	modelDefaultForProvider,
	modelPresetsForProvider,
} from "./llm-model-catalog";
export type { ModelCatalogProvider, PipelineModelPreset } from "./llm-model-catalog";
export { parseManifest, generateManifest } from "./manifest";
export { parseSoul, generateSoul } from "./soul";
export { parseMemory, generateMemory, type ParsedMemory } from "./memory";
export {
	NETWORK_MODES,
	normalizeNetworkMode,
	networkModeFromBindHost,
	readNetworkMode,
	resolveNetworkBinding,
} from "./network";
export type { NetworkMode } from "./network";
export { loadConfiguredHarnesses, parseHarnessList } from "./harness-config";
export { resolveSignetDaemonUrl } from "./daemon-url";
export type { SignetDaemonUrlOptions } from "./daemon-url";
export {
	search,
	vectorSearch,
	keywordSearch,
	hybridSearch,
	cosineSimilarity,
	buildFtsMatchQuery,
	type SearchOptions,
	type SearchResult,
	type VectorSearchOptions,
	type HybridSearchOptions,
} from "./search";
export {
	applyRecallScoreThreshold,
	buildRecallRequestBody,
	buildRememberRequestBody,
	emptyHookRecallResponse,
	formatRecallText,
	normalizeStructuredMemoryPayload,
	parseRecallMeta,
	parseRecallPayload,
	partitionRecallRows,
	withHookRecallCompat,
} from "./recall";
export type {
	AggregateRecallUsage,
	AggregateRecallUsageStage,
	RecallMeta,
	RecallPartitionableRow,
	RecallPayload,
	RecallRequestOptions,
	RecallRow,
	RecallScoreFilterRow,
	RememberRequestOptions,
} from "./recall";
export {
	createMemoriesFts,
	memoriesFtsNeedsTokenizerRepair,
	readMemoriesFtsSql,
	recreateMemoriesFts,
} from "./fts-schema";
export { migrate } from "./migrate";
export type { MigrationSource } from "./migrate";
export {
	detectSchema,
	ensureUnifiedSchema,
	ensureMigrationsTableSchema,
	UNIFIED_SCHEMA,
} from "./migration";
export type {
	SchemaType,
	SchemaInfo,
	MigrationResult,
} from "./migration";
export * from "./constants";

export {
	SIGNET_GRAPHIQ_PLUGIN_ID,
	SIGNET_PLUGIN_REGISTRY_DIR,
	SIGNET_PLUGIN_REGISTRY_FILE,
	SIGNET_PLUGIN_REGISTRY_VERSION,
	SIGNET_SECRETS_PLUGIN_ID,
} from "./plugins";
export {
	SIGNET_GRAPHIQ_STATE_FILE,
	disableGraphiqState,
	emptyGraphiqState,
	enableGraphiqState,
	getGraphiqProjectDbPath,
	getGraphiqStatePath,
	readGraphiqState,
	setGraphiqActiveProject,
	updateGraphiqActiveProject,
	writeGraphiqState,
} from "./graphiq";
export type {
	GraphiqIndexedProject,
	GraphiqPluginState,
	UpdateGraphiqActiveProjectInput,
} from "./graphiq";
export {
	SIGNET_GIT_PROTECTED_PATHS,
	mergeSignetGitignoreEntries,
} from "./gitignore";
export {
	SIGNET_SOURCE_CHECKOUT_DIRNAME,
	SIGNET_SOURCE_REMOTE_URL,
	resolveWorkspaceSourceRepoPath,
	syncWorkspaceSourceRepoAsync,
	syncWorkspaceSourceRepo,
} from "./workspace-source-repo";
export type {
	WorkspaceSourceRepoStatus,
	WorkspaceSourceRepoSyncOptions,
	WorkspaceSourceRepoSyncResult,
} from "./workspace-source-repo";
export {
	addDiscordSource,
	addGitHubSource,
	addObsidianSource,
	DEFAULT_DISCORD_DESKTOP_CACHE_PATH,
	DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
	DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	DEFAULT_GITHUB_DOC_PATHS,
	DEFAULT_GITHUB_MAX_ITEMS_PER_REPO,
	DEFAULT_GITHUB_RESOURCE_TYPES,
	DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN,
	DEFAULT_OBSIDIAN_EXCLUDE_GLOBS,
	MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
	MAX_GITHUB_MAX_ITEMS_PER_REPO,
	getAgentsDir,
	getSourcesConfigPath,
	loadSourcesConfig,
	markSourceIndexed,
	parseDiscordSettings,
	parseGitHubSettings,
	removeSource,
	saveSourcesConfig,
} from "./sources-config";
export type {
	AddDiscordSourceInput,
	AddGitHubSourceInput,
	AddObsidianSourceInput,
	AddSourceResult,
	DiscordSourceSettings,
	DiscordSourceSyncMode,
	GitHubSourceResourceType,
	GitHubSourceSettings,
	GitHubSourceState,
	RemoveSourceResult,
	SignetSourceEntry,
	SignetSourceKind,
	SignetSourceMode,
	SignetSourceProviderSettings,
	SignetSourcesConfig,
} from "./sources-config";
export {
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	SOURCE_CHUNK_SOURCE_TYPE,
} from "./source-substrate";
export type {
	SourceArtifactRecord,
	SourceCheckpointRecord,
	SourceContainerRecord,
	SourceFailureState,
	SourceProviderKind,
	SourceRecordKind,
	SourceRelationRecord,
	SourceSyncResult,
	SourceSyncStatus,
} from "./source-substrate";

// Portable export/import
export {
	collectExportData,
	serializeExportData,
	importMemories,
	importEntities,
	importRelations,
} from "./export";
export type {
	ExportOptions,
	ExportManifest,
	ExportData,
	ImportOptions,
	ExportImportResult,
	ImportConflictStrategy,
} from "./export";

// Migration runner
export { runMigrations, hasPendingMigrations, MIGRATIONS, LATEST_SCHEMA_VERSION } from "./migrations/index";
export type { MigrationDb, Migration } from "./migrations/index";

// Identity file management
export {
	IDENTITY_FILES,
	IDENTITY_PRESETS,
	REQUIRED_IDENTITY_KEYS,
	OPTIONAL_IDENTITY_KEYS,
	detectExistingSetup,
	loadIdentityFiles,
	loadIdentityFilesSync,
	hasValidIdentity,
	getMissingIdentityFiles,
	summarizeIdentity,
	readStaticIdentity,
	resolveSpecialIdentityFiles,
	resolveStartupIdentityFiles,
	resolveSessionStartTimeoutMs,
	resolvePromptSubmitTimeoutMs,
	STATIC_IDENTITY_OFFLINE_STATUS,
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	resolveAgentBasePath,
	resolveHermesHomePath,
	resolveHermesRepoPath,
	resolveHermesRepoPluginPath,
	hermesAgentCandidateDirs,
} from "./identity";
export type {
	IdentityFileSpec,
	IdentityPresetName,
	IdentityFileContext,
	IdentitySessionKind,
	IdentityContextFileEntry,
	IdentitySpecialFileEntry,
	IdentityPresetSpec,
	IdentityFile,
	IdentityMap,
	SetupDetection,
} from "./identity";

export {
	clearConfiguredOhMyPiAgentDir,
	getOhMyPiConfigPath,
	listOhMyPiAgentDirCandidates,
	readConfiguredOhMyPiAgentDir,
	resolveOhMyPiAgentDir,
	resolveOhMyPiExtensionsDir,
	writeConfiguredOhMyPiAgentDir,
} from "./oh-my-pi";

export {
	clearConfiguredPiAgentDir,
	getPiConfigPath,
	listPiAgentDirCandidates,
	readConfiguredPiAgentDir,
	resolvePiAgentDir,
	resolvePiExtensionsDir,
	writeConfiguredPiAgentDir,
} from "./pi";

// Multi-agent support
export {
	discoverAgents,
	scaffoldAgent,
	getAgentIdentityFiles,
	resolveAgentSkills,
	buildAgentMemoryConfig,
	normalizeAgentRosterEntry,
} from "./agents";
export type { AgentRosterReadPolicy, NormalizedAgentRosterEntry } from "./agents";

// Skills unification
export {
	loadClawdhubLock,
	symlinkClaudeSkills,
	writeRegistry,
	unifySkills,
} from "./skills";
export type {
	SkillMeta,
	SkillSource,
	SkillRegistry,
	SkillsConfig,
	SkillsResult,
} from "./skills";

// Memory import
export {
	importMemoryLogs,
	chunkContent,
	chunkMarkdownHierarchically,
} from "./import";
export type {
	ImportResult,
	ChunkResult,
	ChunkOptions,
	HierarchicalChunk,
} from "./import";

// Markdown utilities
export {
	buildSignetBlock,
	buildArchitectureDoc,
	stripSignetBlock,
	hasSignetBlock,
	extractSignetBlock,
	SIGNET_BLOCK_START,
	SIGNET_BLOCK_END,
} from "./markdown";

// YAML utilities
export { parseSimpleYaml, formatYaml, parseYamlDocument, stringifyYamlDocument } from "./yaml";
export {
	ROUTING_ACCOUNT_KINDS,
	ROUTING_TARGET_KINDS,
	ROUTING_EXECUTOR_KINDS,
	ROUTING_POLICY_MODES,
	ROUTING_PRIVACY_TIERS,
	ROUTING_REASONING_DEPTHS,
	ROUTING_COST_TIERS,
	ROUTING_OPERATION_KINDS,
	makeRoutingTargetRef,
	parseRoutingTargetRef,
	isLocalInferenceEndpoint,
	compileLegacyRoutingConfig,
	parseRoutingConfig,
	allTargetRefs,
	resolveRoutingDecision,
} from "./routing";
export type {
	RoutingAccountKind,
	RoutingTargetKind,
	RoutingExecutorKind,
	RoutingPolicyMode,
	RoutingPrivacyTier,
	RoutingReasoningDepth,
	RoutingCostTier,
	RoutingOperationKind,
	RoutingTargetRef,
	RoutingPolicyId,
	RoutingAgentId,
	RouterError,
	RouterResult,
	RoutingAccountConfig,
	RoutingModelConfig,
	RoutingTargetConfig,
	RoutingPolicyConfig,
	RoutingTaskClassConfig,
	AgentRoutingConfig,
	RoutingWorkloadBinding,
	RoutingConfig,
	RoutingRuntimeState,
	RoutingRuntimeSnapshot,
	RouteRequest,
	RouteClassification,
	RouteCandidateTrace,
	RouteTrace,
	RouteDecision,
} from "./routing";
export {
	PIPELINE_CONFIG_FILES,
	findPipelineConfigFile,
	readPipelineConfigData,
	readPipelinePauseState,
	setPipelinePaused,
} from "./pipeline-pause";
export type { PipelineConfigData, PipelinePauseState } from "./pipeline-pause";

// Symlink utilities
export {
	symlinkSkills,
	symlinkDir,
	type SymlinkOptions,
	type SymlinkResult,
} from "./symlinks";

// Package manager resolution utilities
export {
	parsePackageManagerUserAgent,
	detectAvailablePackageManagers,
	resolvePrimaryPackageManager,
	getSkillsRunnerCommand,
	getGlobalInstallCommand,
	resolveGlobalPackagePath,
	type PackageManagerFamily,
	type PackageManagerResolution,
	type PackageManagerCommand,
} from "./package-manager";

// Document ingestion
export { ingestPath } from "./ingest/index";

// Connector runtime types
export {
	CONNECTOR_PROVIDERS,
	CONNECTOR_STATUSES,
	DOCUMENT_STATUSES,
	DOCUMENT_SOURCE_TYPES,
} from "./connector-types";
export type {
	ConnectorProvider,
	ConnectorStatus,
	DocumentStatus,
	DocumentSourceType,
	ConnectorConfig,
	SyncCursor,
	SyncResult,
	SyncError,
	ConnectorResource,
	ConnectorRuntime,
	DocumentRow,
	ConnectorRow,
} from "./connector-types";

// Signet OS types
export { DEFAULT_APP_SIZE } from "./signet-os-types";
export type {
	SignetAppManifest,
	SignetAppEvents,
	SignetAppSize,
	AutoCardToolAction,
	AutoCardResource,
	AutoCardManifest,
	McpProbeResult,
	AppTrayState,
	AppTrayEntry,
	SignetOSEvent,
	BrowserEventType,
	EventBusSubscription,
	ContextSnapshot,
} from "./signet-os-types";
