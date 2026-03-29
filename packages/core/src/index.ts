/**
 * @signet/core
 * Core library for Signet - portable AI agent identity
 */

export { Signet } from "./signet";
export { Database, findSqliteVecExtension, loadSqliteVec } from "./database";
export {
	Agent,
	AgentManifest,
	AgentConfig,
	MEMORY_TYPES,
	EXTRACTION_STATUSES,
	JOB_STATUSES,
	HISTORY_EVENTS,
	DECISION_ACTIONS,
	PIPELINE_FLAGS,
	ENTITY_TYPES,
	ATTRIBUTE_KINDS,
	ATTRIBUTE_STATUSES,
	DEPENDENCY_TYPES,
	TASK_STATUSES,
} from "./types";
export type {
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
	PipelineAutonomousConfig,
	PipelineRepairConfig,
	PipelineDocumentsConfig,
	PipelineGuardrailsConfig,
	PipelineTelemetryConfig,
	PipelineEmbeddingTrackerConfig,
	PipelineContinuityConfig,
	PipelineSynthesisConfig,
	PipelineProceduralConfig,
	PredictorConfig,
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
	EntityAspect,
	EntityAttribute,
	EntityDependency,
	TaskMeta,
	PipelineStructuralConfig,
	PipelineSignificanceConfig,
	PipelineModelRegistryConfig,
	PipelineHintsConfig,
	ModelRegistryEntry,
} from "./types";
export {
	DEFAULT_PIPELINE_TIMEOUT_MS,
	PIPELINE_PROVIDER_CHOICES,
	defaultPipelineModel,
	isPipelineProvider,
} from "./pipeline-providers";
export type { PipelineProviderChoice } from "./pipeline-providers";
export { parseManifest, generateManifest } from "./manifest";
export { parseSoul, generateSoul } from "./soul";
export { parseMemory, generateMemory } from "./memory";
export {
	NETWORK_MODES,
	normalizeNetworkMode,
	networkModeFromBindHost,
	readNetworkMode,
	resolveNetworkBinding,
} from "./network";
export type { NetworkMode } from "./network";
export {
	search,
	vectorSearch,
	keywordSearch,
	hybridSearch,
	cosineSimilarity,
	type SearchOptions,
	type SearchResult,
	type VectorSearchOptions,
	type HybridSearchOptions,
} from "./search";
export { migrate, MigrationSource } from "./migrate";
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
	SIGNET_GIT_PROTECTED_PATHS,
	mergeSignetGitignoreEntries,
} from "./gitignore";

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
	REQUIRED_IDENTITY_KEYS,
	OPTIONAL_IDENTITY_KEYS,
	detectExistingSetup,
	findSignetForgeBinary,
	isCompatibleForgeBinary,
	isSignetForgeBinary,
	loadIdentityFiles,
	loadIdentityFilesSync,
	hasValidIdentity,
	getMissingIdentityFiles,
	summarizeIdentity,
	readStaticIdentity,
	resolveSessionStartTimeoutMs,
	STATIC_IDENTITY_OFFLINE_STATUS,
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	resolveSignetForgeManagedPath,
	resolveAgentBasePath,
} from "./identity";
export type {
	IdentityFileSpec,
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

// Multi-agent support
export {
	discoverAgents,
	scaffoldAgent,
	getAgentIdentityFiles,
	resolveAgentSkills,
} from "./agents";

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
export { parseSimpleYaml, formatYaml } from "./yaml";
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
