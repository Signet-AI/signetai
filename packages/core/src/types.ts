/**
 * Core types for Signet
 */

export interface AgentManifest {
  version: string;
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
  auth?: {
    method: 'none' | 'erc8128' | 'gpg' | 'did';
    chainId?: number;
  };
  capabilities?: string[];
  harnessCompatibility?: string[];
  trust?: {
    verification: 'none' | 'erc8128' | 'gpg' | 'did' | 'registry';
    registry?: string;
  };
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
    provider: 'openai' | 'ollama' | 'local';
    model?: string;
    dimensions?: number;
  };
}

export interface Memory {
  id: string;
  type: 'fact' | 'preference' | 'decision';
  category?: string;
  content: string;
  confidence: number;
  sourceId?: string;
  sourceType?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  vectorClock: Record<string, number>;
  version: number;
  manualOverride: boolean;
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
