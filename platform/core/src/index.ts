/**
 * @signet/core
 * Core library for Signet - portable AI agent identity
 */

export type { AgentRosterReadPolicy, NormalizedAgentRosterEntry } from "./agents";
// Multi-agent support
export {
	buildAgentMemoryConfig,
	discoverAgents,
	getAgentIdentityFiles,
	normalizeAgentRosterEntry,
	resolveAgentSkills,
	scaffoldAgent,
} from "./agents";
export type {
	ConnectorConfig,
	ConnectorProvider,
	ConnectorResource,
	ConnectorRow,
	ConnectorRuntime,
	ConnectorStatus,
	DocumentRow,
	DocumentSourceType,
	DocumentStatus,
	SyncCursor,
	SyncError,
	SyncResult,
} from "./connector-types";
// Connector runtime types
export {
	CONNECTOR_PROVIDERS,
	CONNECTOR_STATUSES,
	DOCUMENT_SOURCE_TYPES,
	DOCUMENT_STATUSES,
} from "./connector-types";
export * from "./constants";
export type { SignetDaemonUrlOptions } from "./daemon-url";
export { resolveSignetDaemonUrl } from "./daemon-url";
export { Database, findSqliteVecExtension, loadSqliteVec } from "./database";
export type {
	ExportData,
	ExportImportResult,
	ExportManifest,
	ExportOptions,
	ImportConflictStrategy,
	ImportOptions,
} from "./export";
// Portable export/import
export {
	collectExportData,
	importEntities,
	importMemories,
	importRelations,
	serializeExportData,
} from "./export";
export {
	createMemoriesFts,
	memoriesFtsNeedsTokenizerRepair,
	readMemoriesFtsSql,
	recreateMemoriesFts,
} from "./fts-schema";
export {
	isSignetGitProtectedPath,
	isSignetGitTrackedPath,
	mergeSignetGitignoreEntries,
	SIGNET_GIT_ALLOWED_DIRECTORIES,
	SIGNET_GIT_ALLOWED_FILE_EXTENSIONS,
	SIGNET_GIT_PROTECTED_PATHS,
	SIGNET_GIT_TRACKED_PATHS,
} from "./gitignore";
export type {
	GraphiqIndexedProject,
	GraphiqPluginState,
	UpdateGraphiqActiveProjectInput,
} from "./graphiq";
export {
	disableGraphiqState,
	emptyGraphiqState,
	enableGraphiqState,
	getGraphiqProjectDbPath,
	getGraphiqStatePath,
	readGraphiqState,
	SIGNET_GRAPHIQ_STATE_FILE,
	setGraphiqActiveProject,
	updateGraphiqActiveProject,
	writeGraphiqState,
} from "./graphiq";
export { loadConfiguredHarnesses, parseHarnessList } from "./harness-config";
export type {
	IdentityContextFileEntry,
	IdentityFile,
	IdentityFileContext,
	IdentityFileSpec,
	IdentityMap,
	IdentityMode,
	IdentityPresetName,
	IdentityPresetSpec,
	IdentitySessionKind,
	IdentitySpecialFileEntry,
	SetupDetection,
} from "./identity";
// Identity file management
export {
	detectExistingSetup,
	getMissingIdentityFiles,
	hasValidIdentity,
	hermesAgentCandidateDirs,
	IDENTITY_FILES,
	IDENTITY_MODES,
	IDENTITY_PRESETS,
	identityModeManagesFiles,
	identityModeReadsFiles,
	loadIdentityFiles,
	loadIdentityFilesSync,
	loadIdentityMode,
	OPTIONAL_IDENTITY_KEYS,
	REQUIRED_IDENTITY_KEYS,
	readStaticIdentity,
	resolveAgentBasePath,
	resolveHermesHomePath,
	resolveHermesRepoPath,
	resolveHermesRepoPluginPath,
	resolveIdentityModeFromConfig,
	resolvePromptSubmitTimeoutMs,
	resolveSessionStartTimeoutMs,
	resolveSpecialIdentityFiles,
	resolveStartupIdentityFiles,
	STATIC_IDENTITY_OFFLINE_STATUS,
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	summarizeIdentity,
} from "./identity";
export type {
	ChunkOptions,
	ChunkResult,
	HierarchicalChunk,
	ImportResult,
} from "./import";
// Memory import
export {
	chunkContent,
	chunkMarkdownHierarchically,
	importMemoryLogs,
} from "./import";
// Document ingestion
export { ingestPath } from "./ingest/index";
export type { ModelCatalogProvider, PipelineModelPreset } from "./llm-model-catalog";
export {
	MODEL_DEFAULTS,
	modelDefaultForProvider,
	modelPresetsForProvider,
	PIPELINE_MODEL_CATALOG,
} from "./llm-model-catalog";
export { generateManifest, parseManifest } from "./manifest";
// Markdown utilities
export {
	buildArchitectureDoc,
	buildSignetBlock,
	extractSignetBlock,
	hasSignetBlock,
	SIGNET_BLOCK_END,
	SIGNET_BLOCK_START,
	stripSignetBlock,
} from "./markdown";
export { generateMemory, type ParsedMemory, parseMemory } from "./memory";
export type { MigrationSource } from "./migrate";
export { migrate } from "./migrate";
export type {
	MigrationResult,
	SchemaInfo,
	SchemaType,
} from "./migration";
export {
	detectSchema,
	ensureMigrationsTableSchema,
	ensureUnifiedSchema,
	UNIFIED_SCHEMA,
} from "./migration";
export type { Migration, MigrationDb } from "./migrations/index";
// Migration runner
export { hasPendingMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations/index";
export type { NetworkMode } from "./network";
export {
	NETWORK_MODES,
	networkModeFromBindHost,
	normalizeNetworkMode,
	readNetworkMode,
	resolveNetworkBinding,
} from "./network";
export {
	clearConfiguredOhMyPiAgentDir,
	getOhMyPiConfigPath,
	listOhMyPiAgentDirCandidates,
	readConfiguredOhMyPiAgentDir,
	resolveOhMyPiAgentDir,
	resolveOhMyPiExtensionsDir,
	writeConfiguredOhMyPiAgentDir,
} from "./oh-my-pi";
// Package manager resolution utilities
export {
	detectAvailablePackageManagers,
	getGlobalInstallCommand,
	getSkillsRunnerCommand,
	type PackageManagerCommand,
	type PackageManagerFamily,
	type PackageManagerResolution,
	parsePackageManagerUserAgent,
	resolveGlobalPackagePath,
	resolvePrimaryPackageManager,
} from "./package-manager";
export {
	clearConfiguredPiAgentDir,
	getPiConfigPath,
	listPiAgentDirCandidates,
	readConfiguredPiAgentDir,
	resolvePiAgentDir,
	resolvePiExtensionsDir,
	writeConfiguredPiAgentDir,
} from "./pi";
export type { PipelineConfigData, PipelinePauseState } from "./pipeline-pause";
export {
	findPipelineConfigFile,
	PIPELINE_CONFIG_FILES,
	readPipelineConfigData,
	readPipelinePauseState,
	setPipelinePaused,
} from "./pipeline-pause";
export type { PipelineProviderChoice, SynthesisProviderChoice } from "./pipeline-providers";
export {
	DEFAULT_PIPELINE_TIMEOUT_MS,
	defaultPipelineModel,
	isPipelineProvider,
	isSynthesisProvider,
	OPENCODE_PIPELINE_AGENT,
	OPENCODE_PIPELINE_SYSTEM_PROMPT,
	PIPELINE_PROVIDER_CHOICES,
	SYNTHESIS_PROVIDER_CHOICES,
} from "./pipeline-providers";
export {
	SIGNET_GRAPHIQ_PLUGIN_ID,
	SIGNET_PLUGIN_REGISTRY_DIR,
	SIGNET_PLUGIN_REGISTRY_FILE,
	SIGNET_PLUGIN_REGISTRY_VERSION,
	SIGNET_SECRETS_PLUGIN_ID,
} from "./plugins";
export type {
	AggregateRecallMeta,
	AggregateRecallUsage,
	AggregateRecallUsageStage,
	RecallMeta,
	RecallPartitionableRow,
	RecallPayload,
	RecallRequestOptions,
	RecallRow,
	RecallScoreFilterRow,
	RecallTemporalMeta,
	RecallTimeOptions,
	RememberRequestOptions,
	TemporalFacet,
} from "./recall";
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
	AcpxModelSelection,
	AgentRoutingConfig,
	RouteCandidateTrace,
	RouteClassification,
	RouteDecision,
	RouteRequest,
	RouterError,
	RouterResult,
	RouteTrace,
	RoutingAccountConfig,
	RoutingAccountKind,
	RoutingAgentId,
	RoutingConfig,
	RoutingCostTier,
	RoutingExecutorKind,
	RoutingModelConfig,
	RoutingOperationKind,
	RoutingPolicyConfig,
	RoutingPolicyId,
	RoutingPolicyMode,
	RoutingPrivacyTier,
	RoutingReasoningDepth,
	RoutingRuntimeSnapshot,
	RoutingRuntimeState,
	RoutingTargetConfig,
	RoutingTargetKind,
	RoutingTargetRef,
	RoutingTaskClassConfig,
	RoutingValidationIssue,
	RoutingWorkloadBinding,
} from "./routing";
export {
	allTargetRefs,
	compileLegacyRoutingConfig,
	isLocalInferenceEndpoint,
	makeRoutingTargetRef,
	parseRoutingConfig,
	parseRoutingTargetRef,
	ROUTING_ACCOUNT_KINDS,
	ROUTING_COST_TIERS,
	ROUTING_EXECUTOR_KINDS,
	ROUTING_OPERATION_KINDS,
	ROUTING_POLICY_MODES,
	ROUTING_PRIVACY_TIERS,
	ROUTING_REASONING_DEPTHS,
	ROUTING_TARGET_KINDS,
	resolveAcpxModelSelection,
	resolveRoutingDecision,
	validateRoutingReferences,
} from "./routing";
export {
	buildFtsMatchQuery,
	cosineSimilarity,
	type HybridSearchOptions,
	hybridSearch,
	keywordSearch,
	type SearchOptions,
	type SearchResult,
	search,
	type VectorSearchOptions,
	vectorSearch,
} from "./search";
export { Signet } from "./signet";
export {
	detectSignetInstallations,
	inactivePackageManagerInstallations,
	packageManagerRemovalCommand,
	type SignetInstallation,
	type SignetInstallationReport,
	type SignetInstallMethod,
	type SignetUpdateTarget,
} from "./signet-installation";
export type {
	AppTrayEntry,
	AppTrayState,
	AutoCardManifest,
	AutoCardResource,
	AutoCardToolAction,
	BrowserEventType,
	ContextSnapshot,
	EventBusSubscription,
	McpProbeResult,
	SignetAppEvents,
	SignetAppManifest,
	SignetAppSize,
	SignetOSEvent,
} from "./signet-os-types";
// Signet OS types
export { DEFAULT_APP_SIZE } from "./signet-os-types";
export type { ParsedSkillInvocation } from "./skill-transcript";
// Skill transcript parsing (pure — no fs)
export { parseTranscriptSkills } from "./skill-transcript";
export type {
	SkillMeta,
	SkillRegistry,
	SkillSource,
	SkillsConfig,
	SkillsResult,
} from "./skills";
// Skills unification
export {
	loadClawdhubLock,
	symlinkClaudeSkills,
	unifySkills,
	writeRegistry,
} from "./skills";
export { generateSoul, parseSoul } from "./soul";
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
export {
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	SOURCE_CHUNK_SOURCE_TYPE,
} from "./source-substrate";
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
	getAgentsDir,
	getSourcesConfigPath,
	loadSourcesConfig,
	MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
	MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL,
	MAX_GITHUB_MAX_ITEMS_PER_REPO,
	markSourceIndexed,
	parseDiscordSettings,
	parseGitHubSettings,
	removeSource,
	saveSourcesConfig,
} from "./sources-config";
// Symlink utilities
export {
	type SymlinkOptions,
	type SymlinkResult,
	symlinkDir,
	symlinkSkills,
} from "./symlinks";
export type {
	Agent,
	AgentConfig,
	AgentDefinition,
	AgentManifest,
	AttributeKind,
	AttributeStatus,
	Conversation,
	DecisionAction,
	DecisionProposal,
	DecisionResult,
	DependencyType,
	DreamingConfig,
	Embedding,
	Entity,
	EntityAspect,
	EntityAttribute,
	EntityDependency,
	EntityType,
	EpistemicAssertion,
	EpistemicAssertionPredicate,
	EpistemicAssertionStatus,
	ExtractedEntity,
	ExtractedFact,
	ExtractionResult,
	ExtractionStatus,
	HistoryEvent,
	JobStatus,
	LlmGenerateResult,
	LlmProvider,
	LlmUsage,
	Memory,
	MemoryEntityMention,
	MemoryHistory,
	MemoryJob,
	MemoryType,
	ModelRegistryEntry,
	OntologyProposal,
	OntologyProposalOperation,
	OntologyProposalStatus,
	PipelineAutonomousConfig,
	PipelineClaudeCodeConfig,
	PipelineContinuityConfig,
	PipelineDocumentsConfig,
	PipelineEmbeddingTrackerConfig,
	PipelineEscalationConfig,
	PipelineExtractionConfig,
	PipelineFlag,
	PipelineGraphConfig,
	PipelineGuardrailsConfig,
	PipelineHintsConfig,
	PipelineModelRegistryConfig,
	PipelineProceduralConfig,
	PipelineReflectionsConfig,
	PipelineRepairConfig,
	PipelineRerankerConfig,
	PipelineSignificanceConfig,
	PipelineStructuralConfig,
	PipelineSynthesisConfig,
	PipelineTelemetryConfig,
	PipelineTraversalConfig,
	PipelineV2Config,
	PipelineWorkerConfig,
	ProviderRateLimitConfig,
	ReadPolicy,
	Relation,
	TaskHarness,
	TaskMeta,
	TaskStatus,
} from "./types";
export {
	ATTRIBUTE_KINDS,
	ATTRIBUTE_STATUSES,
	DECISION_ACTIONS,
	DEFAULT_PROVIDER_RATE_LIMIT,
	DEPENDENCY_DESCRIPTIONS,
	DEPENDENCY_TYPES,
	ENTITY_TYPES,
	EPISTEMIC_ASSERTION_PREDICATES,
	EPISTEMIC_ASSERTION_STATUSES,
	EXTRACTION_STATUSES,
	HISTORY_EVENTS,
	JOB_STATUSES,
	MEMORY_TYPES,
	ONTOLOGY_PROPOSAL_OPERATIONS,
	ONTOLOGY_PROPOSAL_STATUSES,
	PIPELINE_FLAGS,
	TASK_HARNESSES,
	TASK_STATUSES,
} from "./types";
export {
	clearConfiguredWorkspacePath,
	getWorkspaceConfigPath,
	normalizeWorkspacePath,
	type ResolveWorkspacePathOptions,
	readConfiguredWorkspacePath,
	resolveWorkspacePath,
	WORKSPACE_ENV_KEYS,
	type WorkspaceResolution,
	type WorkspaceSource,
	writeConfiguredWorkspacePath,
} from "./workspace";
export type {
	WorkspaceSourceRepoStatus,
	WorkspaceSourceRepoSyncOptions,
	WorkspaceSourceRepoSyncResult,
} from "./workspace-source-repo";
export {
	resolveWorkspaceSourceRepoPath,
	SIGNET_SOURCE_CHECKOUT_DIRNAME,
	SIGNET_SOURCE_REMOTE_URL,
	syncWorkspaceSourceRepo,
	syncWorkspaceSourceRepoAsync,
} from "./workspace-source-repo";
// YAML utilities
export { formatYaml, parseSimpleYaml, parseYamlDocument, stringifyYamlDocument } from "./yaml";
