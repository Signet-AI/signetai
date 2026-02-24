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
	MerkleRootRecord,
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

// Web3 Identity — Crypto, DID, Merkle
export {
	generateSigningKeypair,
	loadSigningKeypair,
	hasSigningKeypair,
	clearCachedKeypair,
	buildSignablePayload,
	buildSignablePayloadV2,
	getPublicKeyBytes,
	getPublicKeyBase64,
	signContent,
	verifySignature,
	signBytes,
	verifyBytes,
	getMasterKey,
	reEncryptKeypair,
	setPassphraseProvider,
	getKeypairKdfVersion,
	resolveAgentsDir,
} from "./crypto";

export {
	publicKeyToDid,
	didToPublicKey,
	generateDidDocument,
	isValidDid,
	formatDidShort,
	DID_KEY_PREFIX,
} from "./did";
export type { DidDocument, VerificationMethod } from "./did";

export {
	computeMerkleRoot,
	buildMerkleTree,
	generateProof,
	verifyProof,
	hashContent,
	hashPair,
	hexToBytes,
	bytesToHex,
} from "./merkle";
export type { MerkleTree, MerkleProof, MerkleProofStep } from "./merkle";

export {
	initializeAgentDid,
	getConfiguredDid,
	hasConfiguredDid,
	isAutoSignEnabled,
	invalidateAutoSignCache,
} from "./did-setup";
export type { DidSetupResult } from "./did-setup";

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

// Decision Memory (Phase 2 — Task 2.4)
export {
	storeDecision,
	queryDecisions,
	recordOutcome,
	getPendingReviews,
	getDecisionById,
	getDecisionsByMemoryId,
} from "./decisions";
export type {
	Decision,
	DecisionRow,
	DecisionQueryOptions,
	DecisionWithContent,
} from "./decisions";

// Contradiction Detection (Phase 2 — Task 2.6)
export {
	DEFAULT_LLM_CONFIG,
	detectContradiction,
	resolveContradiction,
	getPendingContradictions,
	getAllContradictions,
	storeContradiction,
	checkAndStoreContradictions,
} from "./contradictions";
export type {
	ContradictionResolution,
	ContradictionRecord,
	ContradictionCandidate,
	DetectionResult,
	LlmConfig,
} from "./contradictions";

// Temporal Memory (Phase 2)
export {
	calculateStrength,
	updateStrengthOnAccess,
	recalculateAllStrengths,
} from "./temporal";
export type {
	MemoryStrengthInput,
	TemporalDb,
} from "./temporal";

// Session Continuity Scoring (Phase 2 Task 2.3)
export {
	computeContinuityScore,
	recordSessionMetrics,
	getSessionTrend,
} from "./session-metrics";
export type {
	SessionMetricsInput,
	SessionMetricsRecord,
	SessionTrend,
} from "./session-metrics";

// Knowledge Health Dashboard (Phase 3 Task 3.6)
export { getKnowledgeHealth } from "./knowledge-health";
export type {
	KnowledgeHealthReport,
	HealthScoreBreakdown,
	TypeBreakdown,
	SourceBreakdown,
	TopicSummary,
} from "./knowledge-health";

// On-Chain Identity (Phase 4A — ERC-8004)
export {
	CHAIN_CONFIGS,
	DEFAULT_CHAIN,
	createWallet,
	loadWallet,
	getWalletAddress,
	exportWalletKey,
	getWalletBalance,
	checkWalletFunds,
	keccak256Hash,
	SIGNET_IDENTITY_ABI,
	getContract,
	getReadOnlyContract,
	registerIdentity,
	anchorMemoryOnChain,
	getIdentityByDID,
	getLocalIdentity,
	getLatestAnchor,
	buildMemoryMerkleTree,
	getMemoryRoot,
	generateMemoryProof,
	verifyMemoryProof,
} from "./chain/index";
export type {
	ChainConfig,
	OnchainIdentity,
	MemoryAnchor,
	WalletConfig,
	OnchainAgentIdentity,
	ChainDb,
	MemoryLeaf,
	ChainMerkleTree,
	ChainMerkleProof,
} from "./chain/index";

// Session Keys (Phase 4B)
export {
	createSessionKey,
	loadSessionKey,
	revokeSessionKey,
	getActiveSessionKeys,
	getSessionKeyById,
	validateSessionKeyPermission,
} from "./chain/index";
export type {
	SessionKey,
	SessionPermissions,
	TransactionData,
} from "./chain/index";

// x402 Payments (Phase 4B)
export {
	createPaymentHeader,
	verifyPaymentHeader,
	processPayment,
	getPaymentHistory,
	getDailySpend,
	getDailyTransactionCount,
} from "./chain/index";
export type {
	PaymentHeader,
	PaymentRecord,
	PaymentHistoryOptions,
} from "./chain/index";

// Federation (Phase 5)
export {
	// Types & constants
	TRUST_LEVELS,
	MESSAGE_TYPES,
	// Protocol
	createMessage as createFederationMessage,
	verifyMessage as verifyFederationMessage,
	parseMessage as parseFederationMessage,
	serializeMessage as serializeFederationMessage,
	buildMessageSignable,
	// Handshake
	generateChallenge,
	initiateHandshake,
	respondToHandshake,
	completeHandshake,
	signCounterChallenge,
	verifyCounterChallengeResponse,
	// Peer Manager
	addPeer,
	getPeerById,
	getPeerByDid,
	getPeers,
	getTrustedPeers,
	updatePeerTrust,
	blockPeer as blockFederationPeer,
	removePeer,
	updatePeerLastSeen,
	updatePeerLastSync,
	incrementMemoriesShared,
	incrementMemoriesReceived,
	updatePeerEndpoint,
	// Sync
	requestSync,
	handleSyncRequest,
	processSyncResponse,
	getSharedMemories,
	getReceivedMemories,
	// Publisher
	createPublishRule,
	getPublishRules,
	getPublishRuleById,
	updatePublishRule,
	deletePublishRule,
	getPublishableMemories,
	autoPublish,
	// Server
	createFederationServer,
	// Client
	connectToPeer,
	createReconnectingClient,
} from "./federation/index";
export type {
	TrustLevel,
	FederationPeer,
	MessageType,
	PeerMessage,
	HandshakePayload,
	HandshakeAckPayload,
	HandshakeCompletePayload,
	SyncRequest,
	SyncMemory,
	SyncResponse,
	MemoryPushPayload,
	MemoryAckPayload,
	ErrorPayload,
	SharedMemory,
	ReceivedMemory,
	PublishRule,
	FederationConfig,
	FederationDb,
	PeerConnection,
	FederationServer,
	FederationClientConnection,
	ReconnectingClient,
} from "./federation/index";

// Portable Export/Import Bundles (Phase 4B)
export {
	exportBundle,
	importBundle,
	exportSelective,
} from "./export/index";
export type {
	ExportBundle as SignetExportBundle,
	ExportBundleData,
	ExportBundleMetadata,
	ExportDb as BundleExportDb,
	ExportOptions as BundleExportOptions,
	ImportOptions as BundleImportOptions,
	ImportResult as BundleImportResult,
	MergeStrategy,
} from "./export/index";

// Document Ingestion
export { ingestPath } from "./ingest/index";
