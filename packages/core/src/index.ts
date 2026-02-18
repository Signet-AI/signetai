/**
 * @signet/core
 * Core library for Signet - portable AI agent identity
 */

export { Signet } from "./signet";
export { Database } from "./database";
export { Agent, AgentManifest, AgentConfig } from "./types";
export { parseManifest, generateManifest } from "./manifest";
export { parseSoul, generateSoul } from "./soul";
export { parseMemory, generateMemory } from "./memory";
export { search, SearchOptions, SearchResult } from "./search";
export { migrate, MigrationSource } from "./migrate";
export {
	detectSchema,
	ensureUnifiedSchema,
	UNIFIED_SCHEMA,
} from "./migration";
export type {
	SchemaType,
	SchemaInfo,
	MigrationResult,
} from "./migration";
export * from "./constants";

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
} from "./import";
export type {
	ImportResult,
	ChunkResult,
	ChunkOptions,
} from "./import";
