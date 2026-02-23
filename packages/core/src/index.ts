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
} from "./types";
export type {
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
	PipelineExtractionConfig,
	PipelineWorkerConfig,
	PipelineGraphConfig,
	PipelineRerankerConfig,
	PipelineAutonomousConfig,
	PipelineRepairConfig,
	PipelineDocumentsConfig,
	ExtractedFact,
	ExtractedEntity,
	ExtractionResult,
	DecisionProposal,
	DecisionResult,
} from "./types";
export { parseManifest, generateManifest } from "./manifest";
export { parseSoul, generateSoul } from "./soul";
export { parseMemory, generateMemory } from "./memory";
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

// Migration runner
export { runMigrations, MIGRATIONS } from "./migrations/index";
export type { MigrationDb, Migration } from "./migrations/index";

// Identity file management
export {
	IDENTITY_FILES,
	REQUIRED_IDENTITY_KEYS,
	OPTIONAL_IDENTITY_KEYS,
	detectExistingSetup,
	loadIdentityFiles,
	loadIdentityFilesSync,
	hasValidIdentity,
	getMissingIdentityFiles,
	summarizeIdentity,
} from "./identity";
export type {
	IdentityFileSpec,
	IdentityFile,
	IdentityMap,
	SetupDetection,
} from "./identity";

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
	stripSignetBlock,
	hasSignetBlock,
	extractSignetBlock,
	SIGNET_BLOCK_START,
	SIGNET_BLOCK_END,
} from "./markdown";

// YAML utilities
export { parseSimpleYaml, formatYaml } from "./yaml";

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
	type PackageManagerFamily,
	type PackageManagerResolution,
	type PackageManagerCommand,
} from "./package-manager";

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
