/**
 * @signet/core
 * Core library for Signet - portable AI agent identity
 */

export { Signet } from './signet';
export { Database } from './database';
export { Agent, AgentManifest, AgentConfig } from './types';
export { parseManifest, generateManifest } from './manifest';
export { parseSoul, generateSoul } from './soul';
export { parseMemory, generateMemory } from './memory';
export { search, SearchOptions, SearchResult } from './search';
export { migrate, MigrationSource } from './migrate';
export * from './constants';
