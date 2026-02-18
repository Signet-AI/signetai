/**
 * Signet Hooks System
 * 
 * Lifecycle hooks for harness integration:
 * - onSessionStart: provide context/memories to inject
 * - onPreCompaction: provide summary instructions, receive summary
 */

import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { Database } from 'bun:sqlite';
import { logger } from './logger';
import { parseSimpleYaml } from '@signet/core';

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), '.agents');
const MEMORY_DB = join(AGENTS_DIR, 'memory', 'memories.db');

// ============================================================================
// Types
// ============================================================================

export interface HooksConfig {
  sessionStart?: {
    recallLimit?: number;
    includeIdentity?: boolean;
    includeRecentContext?: boolean;
    recencyBias?: number;
    query?: string;
  };
  preCompaction?: {
    summaryGuidelines?: string;
    includeRecentMemories?: boolean;
    memoryLimit?: number;
  };
}

export interface MemorySynthesisConfig {
  harness: string;      // which harness runs synthesis
  model: string;        // model to use
  schedule: 'daily' | 'weekly' | 'on-demand';
  max_tokens?: number;
}

export interface SynthesisRequest {
  trigger: 'scheduled' | 'manual';
}

export interface SynthesisResponse {
  harness: string;
  model: string;
  prompt: string;
  memories: Array<{
    id: number;
    content: string;
    type: string;
    importance: number;
    created_at: string;
  }>;
}

export interface SessionStartRequest {
  harness: string;
  agentId?: string;
  context?: string;
  sessionKey?: string;
}

export interface SessionStartResponse {
  identity: {
    name: string;
    description?: string;
  };
  memories: Array<{
    id: number;
    content: string;
    type: string;
    importance: number;
    created_at: string;
  }>;
  recentContext?: string;
  inject: string;  // formatted text ready to inject into system prompt
}

export interface PreCompactionRequest {
  harness: string;
  sessionContext?: string;
  messageCount?: number;
  sessionKey?: string;
}

export interface PreCompactionResponse {
  summaryPrompt: string;
  guidelines: string;
}

// ============================================================================
// Config Loading
// ============================================================================

function loadHooksConfig(): HooksConfig {
  const configPath = join(AGENTS_DIR, 'agent.yaml');
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = parseSimpleYaml(content);
    return config.hooks || getDefaultConfig();
  } catch (e) {
    logger.warn('hooks', 'Failed to load hooks config, using defaults');
    return getDefaultConfig();
  }
}

function getDefaultConfig(): HooksConfig {
  return {
    sessionStart: {
      recallLimit: 10,
      includeIdentity: true,
      includeRecentContext: true,
      recencyBias: 0.7,
    },
    preCompaction: {
      summaryGuidelines: `Summarize this session focusing on:
- Key decisions made
- Important information learned
- User preferences discovered
- Open threads or todos
- Any errors or issues encountered

Keep the summary concise but complete. Use first person from the agent's perspective.`,
      includeRecentMemories: true,
      memoryLimit: 5,
    },
  };
}

// ============================================================================
// Type Guards for Parsed YAML
// ============================================================================

interface AgentConfig {
  name?: string;
  description?: string;
}

interface MemoryConfig {
  synthesis?: {
    harness?: string;
    model?: string;
    schedule?: 'daily' | 'weekly' | 'on-demand';
    max_tokens?: number;
  };
}

function isAgentConfig(value: unknown): value is AgentConfig {
  return typeof value === 'object' && value !== null;
}

function isMemoryConfig(value: unknown): value is MemoryConfig {
  return typeof value === 'object' && value !== null;
}

// ============================================================================
// Identity Loading
// ============================================================================

function loadIdentity(): { name: string; description?: string } {
  // Try agent.yaml first
  const agentYaml = join(AGENTS_DIR, 'agent.yaml');
  if (existsSync(agentYaml)) {
    try {
      const content = readFileSync(agentYaml, 'utf-8');
      const config = parseSimpleYaml(content);
      const agent = config.agent;
      if (isAgentConfig(agent) && agent.name) {
        return {
          name: agent.name,
          description: agent.description,
        };
      }
    } catch {}
  }
  
  // Fall back to IDENTITY.md
  const identityMd = join(AGENTS_DIR, 'IDENTITY.md');
  if (existsSync(identityMd)) {
    try {
      const content = readFileSync(identityMd, 'utf-8');
      const nameMatch = content.match(/name:\s*(.+)/i);
      const descMatch = content.match(/creature:\s*(.+)/i) || content.match(/role:\s*(.+)/i);
      return {
        name: nameMatch?.[1]?.trim() || 'Agent',
        description: descMatch?.[1]?.trim(),
      };
    } catch {}
  }
  
  return { name: 'Agent' };
}

// ============================================================================
// Memory Queries
// ============================================================================

function getRecentMemories(limit: number, recencyBias: number = 0.7): Array<{
  id: number;
  content: string;
  type: string;
  importance: number;
  created_at: string;
}> {
  if (!existsSync(MEMORY_DB)) return [];
  
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    
    // Score = importance * (1 - recencyBias) + recency * recencyBias
    // Recency is normalized to 0-1 based on age
    const query = `
      SELECT 
        id, content, type, importance, created_at,
        (julianday('now') - julianday(created_at)) as age_days
      FROM memories
      ORDER BY 
        (importance * ${1 - recencyBias}) + 
        (1.0 / (1.0 + (julianday('now') - julianday(created_at)))) * ${recencyBias}
        DESC
      LIMIT ?
    `;
    
    const rows = db.prepare(query).all(limit) as any[];
    db.close();
    
    return rows.map(r => ({
      id: r.id,
      content: r.content,
      type: r.type || 'general',
      importance: r.importance || 0.5,
      created_at: r.created_at,
    }));
  } catch (e) {
    logger.error('hooks', 'Failed to query memories', e as Error);
    return [];
  }
}

function getRecentContext(): string | undefined {
  const memoryMd = join(AGENTS_DIR, 'MEMORY.md');
  if (!existsSync(memoryMd)) return undefined;
  
  try {
    const content = readFileSync(memoryMd, 'utf-8');
    // Return first ~2000 chars as context summary
    return content.slice(0, 2000);
  } catch {
    return undefined;
  }
}

// ============================================================================
// Hook Handlers
// ============================================================================

export function handleSessionStart(req: SessionStartRequest): SessionStartResponse {
  const config = loadHooksConfig().sessionStart || {};
  const limit = config.recallLimit || 10;
  const recencyBias = config.recencyBias || 0.7;
  
  logger.info('hooks', 'Session start hook', { harness: req.harness });
  
  const identity = config.includeIdentity !== false ? loadIdentity() : { name: 'Agent' };
  const memories = getRecentMemories(limit, recencyBias);
  const recentContext = config.includeRecentContext !== false ? getRecentContext() : undefined;
  
  // Format inject text
  const injectParts: string[] = [];
  
  if (identity.name !== 'Agent' || identity.description) {
    injectParts.push(`You are ${identity.name}${identity.description ? `, ${identity.description}` : ''}.`);
  }
  
  if (memories.length > 0) {
    injectParts.push('\n## Relevant Memories\n');
    for (const mem of memories) {
      const date = new Date(mem.created_at).toLocaleDateString();
      injectParts.push(`- [${date}] ${mem.content}`);
    }
  }
  
  if (recentContext) {
    injectParts.push('\n## Recent Context\n');
    injectParts.push(recentContext);
  }
  
  return {
    identity,
    memories,
    recentContext,
    inject: injectParts.join('\n'),
  };
}

export function handlePreCompaction(req: PreCompactionRequest): PreCompactionResponse {
  const config = loadHooksConfig().preCompaction || {};
  
  logger.info('hooks', 'Pre-compaction hook', { 
    harness: req.harness, 
    messageCount: req.messageCount 
  });
  
  const guidelines = config.summaryGuidelines || getDefaultConfig().preCompaction!.summaryGuidelines!;
  
  // Build the summary prompt
  let summaryPrompt = `Pre-compaction memory flush. Store durable memories now.

${guidelines}

`;

  // Optionally include recent memories for context
  if (config.includeRecentMemories !== false) {
    const recentMemories = getRecentMemories(config.memoryLimit || 5, 0.9);
    if (recentMemories.length > 0) {
      summaryPrompt += '\nRecent memories for reference:\n';
      for (const mem of recentMemories) {
        summaryPrompt += `- ${mem.content}\n`;
      }
    }
  }
  
  return {
    summaryPrompt,
    guidelines,
  };
}

// ============================================================================
// Memory Synthesis
// ============================================================================

function loadSynthesisConfig(): MemorySynthesisConfig {
  const configPath = join(AGENTS_DIR, 'agent.yaml');
  
  const defaults: MemorySynthesisConfig = {
    harness: 'openclaw',
    model: 'sonnet',
    schedule: 'daily',
    max_tokens: 4000,
  };
  
  if (!existsSync(configPath)) {
    return defaults;
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = parseSimpleYaml(content);
    const memory = config.memory;
    const synthesis = isMemoryConfig(memory) ? memory.synthesis : undefined;

    return {
      harness: synthesis?.harness || defaults.harness,
      model: synthesis?.model || defaults.model,
      schedule: synthesis?.schedule || defaults.schedule,
      max_tokens: synthesis?.max_tokens || defaults.max_tokens,
    };
  } catch {
    return defaults;
  }
}

export function handleSynthesisRequest(req: SynthesisRequest): SynthesisResponse {
  const config = loadSynthesisConfig();
  
  logger.info('hooks', 'Synthesis request', { trigger: req.trigger });
  
  // Get all memories for synthesis, ordered by importance and recency
  const memories = getRecentMemories(100, 0.5);
  
  // Build the synthesis prompt
  const prompt = `You are regenerating MEMORY.md - a synthesized summary of the agent's memory system.

Review the following memories and create a coherent, organized summary that captures:
- Current active projects and their status
- Key decisions and their rationale  
- Important people, preferences, and relationships
- Technical notes and learnings
- Open threads and todos

Format the output as clean markdown with clear sections. Be concise but complete.
Maximum length: ${config.max_tokens} tokens.

## Memories to Synthesize

${memories.map(m => `- [${m.type}] ${m.content}`).join('\n')}
`;

  return {
    harness: config.harness,
    model: config.model,
    prompt,
    memories,
  };
}

export function getSynthesisConfig(): MemorySynthesisConfig {
  return loadSynthesisConfig();
}
