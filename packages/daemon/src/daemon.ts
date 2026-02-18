#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for memory, API, and dashboard hosting
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { watch } from 'chokidar';
import { logger, LogEntry } from './logger';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { 
  writeFileSync, 
  readFileSync, 
  existsSync, 
  mkdirSync, 
  unlinkSync,
  readdirSync,
  statSync,
  appendFileSync,
  rmSync,
} from 'fs';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { fileURLToPath } from 'url';
import {
  putSecret,
  getSecret,
  hasSecret,
  listSecrets,
  deleteSecret,
  execWithSecrets,
} from './secrets.js';
import { parseSimpleYaml, buildSignetBlock, stripSignetBlock, vectorSearch, keywordSearch } from '@signet/core';

// Paths
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), '.agents');
const DAEMON_DIR = join(AGENTS_DIR, '.daemon');
const SKILLS_DIR = join(AGENTS_DIR, 'skills');
const PID_FILE = join(DAEMON_DIR, 'pid');
const LOG_DIR = join(DAEMON_DIR, 'logs');
const MEMORY_DB = join(AGENTS_DIR, 'memory', 'memories.db');
const MEMORY_SCRIPT = join(AGENTS_DIR, 'memory', 'scripts', 'memory.py');
const SCRIPTS_DIR = join(AGENTS_DIR, 'scripts');
const VENV_PYTHON = join(AGENTS_DIR, '.venv', 'bin', 'python');

// Get Python command - prefer venv, fallback to system
function getPythonCmd(): string {
  if (existsSync(VENV_PYTHON)) {
    return VENV_PYTHON;
  }
  return 'python3';
}

// Config
const PORT = parseInt(process.env.SIGNET_PORT || '3850', 10);
const HOST = process.env.SIGNET_HOST || 'localhost';

// ============================================================================
// Memory helpers - config, embedding, type inference
// ============================================================================

interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model: string;
  dimensions: number;
  base_url: string;
  api_key?: string;
}

interface EmbeddingStatus {
  provider: 'ollama' | 'openai';
  model: string;
  available: boolean;
  dimensions?: number;
  base_url: string;
  error?: string;
  checkedAt: string;
}

interface MemorySearchConfig {
  alpha: number;
  top_k: number;
  min_score: number;
}

interface ResolvedMemoryConfig {
  embedding: EmbeddingConfig;
  search: MemorySearchConfig;
}

function loadMemoryConfig(): ResolvedMemoryConfig {
  const defaults: ResolvedMemoryConfig = {
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 768,
      base_url: 'http://localhost:11434',
    },
    search: { alpha: 0.7, top_k: 20, min_score: 0.3 },
  };

  // Prefer AGENT.yaml (newer format), fall back to config.yaml
  const paths = [
    join(AGENTS_DIR, 'AGENT.yaml'),
    join(AGENTS_DIR, 'config.yaml'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const yaml = parseSimpleYaml(readFileSync(p, 'utf-8'));

      // AGENT.yaml: memory.embeddings.*
      // config.yaml: embeddings.*
      const emb: Record<string, any> =
        (yaml.memory as any)?.embeddings ??
        (yaml.embeddings as any) ??
        {};
      const srch: Record<string, any> = (yaml.search as any) ?? {};

      if (emb.provider) {
        defaults.embedding.provider = emb.provider as 'ollama' | 'openai';
        defaults.embedding.model = emb.model ?? defaults.embedding.model;
        defaults.embedding.dimensions = parseInt(emb.dimensions ?? '768', 10);
        defaults.embedding.base_url =
          emb.base_url ?? defaults.embedding.base_url;
        defaults.embedding.api_key = emb.api_key;
      }
      if (srch.alpha !== undefined) {
        defaults.search.alpha = parseFloat(srch.alpha);
        defaults.search.top_k = parseInt(srch.top_k ?? '20', 10);
        defaults.search.min_score = parseFloat(srch.min_score ?? '0.3');
      }
      break; // first valid config wins
    } catch {
      // ignore parse errors, try next file
    }
  }

  return defaults;
}

async function fetchEmbedding(
  text: string,
  cfg: EmbeddingConfig
): Promise<number[] | null> {
  try {
    if (cfg.provider === 'ollama') {
      const res = await fetch(`${cfg.base_url.replace(/\/$/, '')}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt: text }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { embedding: number[] };
      return data.embedding ?? null;
    } else {
      // OpenAI-compatible
      const apiKey =
        cfg.api_key ?? process.env.OPENAI_API_KEY ?? '';
      const res = await fetch(`${cfg.base_url.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, input: text }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return data.data?.[0]?.embedding ?? null;
    }
  } catch {
    return null;
  }
}

function vectorToBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

// Status cache for embedding provider
let cachedEmbeddingStatus: EmbeddingStatus | null = null;
let statusCacheTime = 0;
const STATUS_CACHE_TTL = 30000; // 30 seconds

async function checkEmbeddingProvider(cfg: EmbeddingConfig): Promise<EmbeddingStatus> {
  const now = Date.now();

  // Return cached status if fresh
  if (cachedEmbeddingStatus && (now - statusCacheTime) < STATUS_CACHE_TTL) {
    return cachedEmbeddingStatus;
  }

  const status: EmbeddingStatus = {
    provider: cfg.provider,
    model: cfg.model,
    base_url: cfg.base_url,
    available: false,
    checkedAt: new Date().toISOString(),
  };

  try {
    if (cfg.provider === 'ollama') {
      // Check Ollama API availability
      const res = await fetch(`${cfg.base_url.replace(/\/$/, '')}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        status.error = `Ollama returned ${res.status}`;
      } else {
        const data = await res.json() as { models?: { name: string }[] };
        const models = data.models ?? [];
        const modelExists = models.some(m => m.name.startsWith(cfg.model));

        if (!modelExists) {
          status.error = `Model '${cfg.model}' not found. Available: ${models.map(m => m.name).join(', ') || 'none'}`;
        } else {
          status.available = true;
          status.dimensions = cfg.dimensions;
        }
      }
    } else {
      // OpenAI: test with a minimal embedding request
      const testResult = await fetchEmbedding('test', cfg);
      if (testResult) {
        status.available = true;
        status.dimensions = testResult.length;
      } else {
        status.error = 'Failed to generate test embedding';
      }
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : 'Unknown error';
  }

  cachedEmbeddingStatus = status;
  statusCacheTime = now;
  return status;
}

// Mirror the type inference from memory.py
const TYPE_HINTS: Array<[string, string]> = [
  ['prefer', 'preference'],
  ['likes', 'preference'],
  ['want', 'preference'],
  ['decided', 'decision'],
  ['agreed', 'decision'],
  ['will use', 'decision'],
  ['learned', 'learning'],
  ['discovered', 'learning'],
  ['til ', 'learning'],
  ['bug', 'issue'],
  ['issue', 'issue'],
  ['broken', 'issue'],
  ['never', 'rule'],
  ['always', 'rule'],
  ['must', 'rule'],
];

function inferType(content: string): string {
  const lower = content.toLowerCase();
  for (const [hint, type] of TYPE_HINTS) {
    if (lower.includes(hint)) return type;
  }
  return 'fact';
}

interface ParsedMemory {
  content: string;
  tags: string | null;
  pinned: boolean;
  importance: number;
}

function parsePrefixes(raw: string): ParsedMemory {
  let content = raw.trim();
  let pinned = false;
  let importance = 0.8;
  let tags: string | null = null;

  if (content.toLowerCase().startsWith('critical:')) {
    content = content.slice(9).trim();
    pinned = true;
    importance = 1.0;
  }

  const tagMatch = content.match(/^\[([^\]]+)\]:\s*(.+)$/s);
  if (tagMatch) {
    tags = tagMatch[1]
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean)
      .join(',');
    content = tagMatch[2].trim();
  }

  return { content, tags, pinned, importance };
}

// Resolve dashboard static files location
function getDashboardPath(): string | null {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // Check various locations for the built dashboard
  const candidates = [
    // When running from workspace
    join(__dirname, '..', '..', 'cli', 'dashboard', 'build'),
    // When installed as package
    join(__dirname, '..', '..', '..', 'cli', 'dashboard', 'build'),
    // Bundled with daemon
    join(__dirname, '..', 'dashboard'),
    join(__dirname, 'dashboard'),
  ];
  
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  
  return null;
}

// Create the Hono app
const app = new Hono();

// Middleware
app.use('*', cors());

// Request logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  logger.api.request(c.req.method, c.req.path, c.res.status, duration);
});

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    uptime: process.uptime(),
    pid: process.pid,
    version: '0.1.0',
    port: PORT,
    agentsDir: AGENTS_DIR,
  });
});

// ============================================================================
// Logs API
// ============================================================================

// Get recent logs
app.get('/api/logs', (c) => {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const level = c.req.query('level') as 'debug' | 'info' | 'warn' | 'error' | undefined;
  const category = c.req.query('category') as any;
  const since = c.req.query('since') ? new Date(c.req.query('since')!) : undefined;
  
  const logs = logger.getRecent({ limit, level, category, since });
  return c.json({ logs, count: logs.length });
});

// Stream logs via Server-Sent Events
app.get('/api/logs/stream', (c) => {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      const onLog = (entry: LogEntry) => {
        const data = `data: ${JSON.stringify(entry)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };
      
      logger.on('log', onLog);
      
      // Send initial connection message
      controller.enqueue(encoder.encode(`data: {"type":"connected"}\n\n`));
      
      // Cleanup on close
      c.req.raw.signal.addEventListener('abort', () => {
        logger.off('log', onLog);
      });
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// ============================================================================
// Config API
// ============================================================================

app.get('/api/config', async (c) => {
  try {
    const files: Array<{ name: string; content: string; size: number }> = [];
    const dirFiles = readdirSync(AGENTS_DIR);
    const configFiles = dirFiles.filter(
      f => f.endsWith('.md') || f.endsWith('.yaml')
    );
    
    for (const fileName of configFiles) {
      const filePath = join(AGENTS_DIR, fileName);
      const fileStat = statSync(filePath);
      if (fileStat.isFile()) {
        const content = readFileSync(filePath, 'utf-8');
        files.push({ name: fileName, content, size: fileStat.size });
      }
    }

    // Sort by priority
    const priority = ['agent.yaml', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];
    files.sort((a, b) => {
      const aIdx = priority.indexOf(a.name);
      const bIdx = priority.indexOf(b.name);
      if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });

    return c.json({ files });
  } catch (e) {
    logger.error('api', 'Error loading config files', e as Error);
    return c.json({ files: [], error: 'Failed to load config files' });
  }
});

app.post('/api/config', async (c) => {
  try {
    const { file, content } = await c.req.json();

    if (!file || typeof content !== 'string') {
      return c.json({ error: 'Invalid request' }, 400);
    }

    if (file.includes('/') || file.includes('..')) {
      return c.json({ error: 'Invalid file name' }, 400);
    }

    if (!file.endsWith('.md') && !file.endsWith('.yaml')) {
      return c.json({ error: 'Invalid file type' }, 400);
    }

    writeFileSync(join(AGENTS_DIR, file), content, 'utf-8');
    logger.info('api', 'Config file updated', { file });
    return c.json({ success: true });
  } catch (e) {
    logger.error('api', 'Error saving config file', e as Error);
    return c.json({ error: 'Failed to save file' }, 500);
  }
});

// ============================================================================
// Identity API
// ============================================================================

app.get('/api/identity', (c) => {
  try {
    const content = readFileSync(join(AGENTS_DIR, 'IDENTITY.md'), 'utf-8');
    const lines = content.split('\n');
    const identity: { name: string; creature: string; vibe: string } = {
      name: '',
      creature: '',
      vibe: '',
    };
    
    for (const line of lines) {
      if (line.startsWith('- name:'))
        identity.name = line.replace('- name:', '').trim();
      if (line.startsWith('- creature:'))
        identity.creature = line.replace('- creature:', '').trim();
      if (line.startsWith('- vibe:'))
        identity.vibe = line.replace('- vibe:', '').trim();
    }
    
    return c.json(identity);
  } catch {
    return c.json({ name: 'Unknown', creature: '', vibe: '' });
  }
});

// ============================================================================
// Memories API
// ============================================================================

app.get('/api/memories', (c) => {
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const memories = db.prepare(`
      SELECT id, content, created_at, who, importance, tags, source_type, pinned, type
      FROM memories 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    // Stats
    const totalResult = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    let embeddingsCount = 0;
    try {
      const embResult = db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
      embeddingsCount = embResult?.count ?? 0;
    } catch {
      // embeddings table might not exist
    }
    const critResult = db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE importance >= 0.9"
    ).get() as { count: number };

    db.close();

    return c.json({
      memories,
      stats: {
        total: totalResult?.count ?? 0,
        withEmbeddings: embeddingsCount,
        critical: critResult?.count ?? 0,
      },
    });
  } catch (e) {
    logger.error('memory', 'Error loading memories', e as Error);
    return c.json({ memories: [], stats: { total: 0, withEmbeddings: 0, critical: 0 }, error: 'Failed to load memories' });
  }
});

// ============================================================================
// Memory Search API
// ============================================================================

interface FilterParams {
  type: string;
  tags: string;
  who: string;
  pinned: boolean;
  importance_min: number | null;
  since: string;
}

function buildWhereRaw(p: FilterParams): { clause: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];

  if (p.type) {
    parts.push('type = ?');
    args.push(p.type);
  }
  if (p.tags) {
    const tagList = p.tags.split(',').map(t => t.trim()).filter(Boolean);
    for (const tag of tagList) {
      parts.push("tags LIKE ?");
      args.push(`%${tag}%`);
    }
  }
  if (p.who) {
    parts.push('who = ?');
    args.push(p.who);
  }
  if (p.pinned) {
    parts.push('pinned = 1');
  }
  if (p.importance_min !== null) {
    parts.push('importance >= ?');
    args.push(p.importance_min);
  }
  if (p.since) {
    parts.push('created_at >= ?');
    args.push(p.since);
  }

  const clause = parts.length ? ' AND ' + parts.join(' AND ') : '';
  return { clause, args };
}

function buildWhere(p: FilterParams): { clause: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];

  if (p.type) {
    parts.push('m.type = ?');
    args.push(p.type);
  }
  if (p.tags) {
    const tagList = p.tags.split(',').map(t => t.trim()).filter(Boolean);
    for (const tag of tagList) {
      parts.push("m.tags LIKE ?");
      args.push(`%${tag}%`);
    }
  }
  if (p.who) {
    parts.push('m.who = ?');
    args.push(p.who);
  }
  if (p.pinned) {
    parts.push('m.pinned = 1');
  }
  if (p.importance_min !== null) {
    parts.push('m.importance >= ?');
    args.push(p.importance_min);
  }
  if (p.since) {
    parts.push('m.created_at >= ?');
    args.push(p.since);
  }

  const clause = parts.length ? ' AND ' + parts.join(' AND ') : '';
  return { clause, args };
}

app.get('/memory/search', (c) => {
  const query = c.req.query('q') ?? '';
  const distinct = c.req.query('distinct');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : null;

  // Shortcut: return distinct values for a column
  if (distinct === 'who') {
    try {
      const db = new Database(MEMORY_DB, { readonly: true });
      const rows = db
        .prepare("SELECT DISTINCT who FROM memories WHERE who IS NOT NULL ORDER BY who")
        .all() as { who: string }[];
      db.close();
      return c.json({ values: rows.map(r => r.who) });
    } catch {
      return c.json({ values: [] });
    }
  }

  const filterParams: FilterParams = {
    type: c.req.query('type') ?? '',
    tags: c.req.query('tags') ?? '',
    who: c.req.query('who') ?? '',
    pinned: c.req.query('pinned') === '1' || c.req.query('pinned') === 'true',
    importance_min: c.req.query('importance_min')
      ? parseFloat(c.req.query('importance_min')!)
      : null,
    since: c.req.query('since') ?? '',
  };

  const hasFilters = Object.values(filterParams).some(v =>
    v !== '' && v !== false && v !== null
  );

  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    let results: unknown[] = [];

    if (query.trim()) {
      // FTS path
      const { clause, args } = buildWhere(filterParams);
      try {
        results = (db.prepare(`
          SELECT m.id, m.content, m.created_at, m.who, m.importance, m.tags,
                 m.type, m.pinned, bm25(memories_fts) as score
          FROM memories_fts
          JOIN memories m ON memories_fts.rowid = m.rowid
          WHERE memories_fts MATCH ?${clause}
          ORDER BY score
          LIMIT ${limit ?? 20}
        `) as any).all(query, ...args);
      } catch {
        // FTS not available — fall back to LIKE
        const { clause: rc, args: rargs } = buildWhereRaw(filterParams);
        results = (db.prepare(`
          SELECT id, content, created_at, who, importance, tags, type, pinned
          FROM memories
          WHERE (content LIKE ? OR tags LIKE ?)${rc}
          ORDER BY created_at DESC
          LIMIT ${limit ?? 20}
        `) as any).all(`%${query}%`, `%${query}%`, ...rargs);
      }
    } else if (hasFilters) {
      // Pure filter path
      const { clause, args } = buildWhereRaw(filterParams);
      results = (db.prepare(`
        SELECT id, content, created_at, who, importance, tags, type, pinned,
               CASE WHEN pinned = 1 THEN 1.0
                    ELSE importance * MAX(0.1, POWER(0.95,
                      CAST(JulianDay('now') - JulianDay(created_at) AS INTEGER)))
               END AS score
        FROM memories
        WHERE 1=1${clause}
        ORDER BY score DESC
        LIMIT ${limit ?? 50}
      `) as any).all(...args);
    }

    db.close();
    return c.json({ results });
  } catch (e) {
    logger.error('memory', 'Error searching memories', e as Error);
    return c.json({ results: [], error: 'Search failed' });
  }
});

// ============================================================================
// Native Memory API - /api/memory/remember & /api/memory/recall
// ============================================================================

app.post('/api/memory/remember', async (c) => {
  let body: {
    content?: string;
    who?: string;
    project?: string;
    importance?: number;
    tags?: string;
    pinned?: boolean;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const raw = body.content?.trim();
  if (!raw) return c.json({ error: 'content is required' }, 400);

  const who = body.who ?? 'daemon';
  const project = body.project ?? null;

  // Parse prefixes (critical:, [tags]:) then infer type
  const parsed = parsePrefixes(raw);

  // Body-level overrides for importance/tags/pinned
  const importance = body.importance ?? parsed.importance;
  const pinned = (body.pinned ?? parsed.pinned) ? 1 : 0;
  const tags = body.tags ?? parsed.tags;
  const memType = inferType(parsed.content);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    const db = new Database(MEMORY_DB);
    db.prepare(`
      INSERT INTO memories
        (id, content, who, why, project, importance, type, tags, pinned,
         created_at, updated_at, updated_by, source_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      parsed.content,
      who,
      pinned ? 'explicit-critical' : 'explicit',
      project,
      importance,
      memType,
      tags,
      pinned,
      now,
      now,
      who,
      'manual',
    );

    // Keep FTS in sync (content= tables need manual population on INSERT)
    try {
      db.prepare(
        `INSERT INTO memories_fts(rowid, content)
         SELECT rowid, content FROM memories WHERE id = ?`
      ).run(id);
    } catch {
      // FTS trigger may already exist; ignore
    }

    db.close();
  } catch (e) {
    logger.error('memory', 'Failed to save memory', e as Error);
    return c.json({ error: 'Failed to save memory' }, 500);
  }

  // Generate embedding asynchronously — save memory first so failures are
  // non-fatal (memory is still usable via keyword search)
  let embedded = false;
  try {
    const cfg = loadMemoryConfig();
    const vec = await fetchEmbedding(parsed.content, cfg.embedding);
    if (vec) {
      const hash = createHash('sha256').update(parsed.content).digest('hex');
      const blob = vectorToBlob(vec);
      const embId = crypto.randomUUID();

      const db = new Database(MEMORY_DB);
      // Remove stale embedding for this memory (upsert behaviour)
      db.prepare(
        `DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?`
      ).run(id);
      db.prepare(`
        INSERT INTO embeddings
          (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
        VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
      `).run(embId, hash, blob, vec.length, id, parsed.content, now);
      db.close();
      embedded = true;
    }
  } catch (e) {
    logger.warn('memory', 'Embedding failed (memory saved without vector)', {
      id,
      error: String(e),
    });
  }

  logger.info('memory', 'Memory saved', { id, type: memType, pinned: !!pinned, embedded });

  return c.json({
    id,
    type: memType,
    tags,
    pinned: !!pinned,
    importance,
    content: parsed.content,
    embedded,
  });
});

// Alias matching the legacy spec path
app.post('/api/memory/save', async (c) => {
  // Re-use the same handler by forwarding to the internal fetch
  const body = await c.req.json().catch(() => ({}));
  return fetch(`http://${HOST}:${PORT}/api/memory/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

// Alias for Claude Code skill compatibility
app.post('/api/hook/remember', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return fetch(`http://${HOST}:${PORT}/api/memory/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

app.post('/api/memory/recall', async (c) => {
  let body: {
    query?: string;
    limit?: number;
    type?: string;
    tags?: string;
    who?: string;
    since?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const query = body.query?.trim() ?? '';
  if (!query) return c.json({ error: 'query is required' }, 400);

  const cfg = loadMemoryConfig();
  const limit = body.limit ?? 10;
  const alpha = cfg.search.alpha;
  const minScore = cfg.search.min_score;

  // Build optional filter clause
  const filterParts: string[] = [];
  const filterArgs: unknown[] = [];
  if (body.type) { filterParts.push('m.type = ?'); filterArgs.push(body.type); }
  if (body.tags) {
    for (const t of body.tags.split(',').map(s => s.trim()).filter(Boolean)) {
      filterParts.push('m.tags LIKE ?');
      filterArgs.push(`%${t}%`);
    }
  }
  if (body.who) { filterParts.push('m.who = ?'); filterArgs.push(body.who); }
  if (body.since) { filterParts.push('m.created_at >= ?'); filterArgs.push(body.since); }
  const filterClause = filterParts.length
    ? ' AND ' + filterParts.join(' AND ')
    : '';

  // --- BM25 keyword search via FTS5 ---
  const bm25Map = new Map<string, number>();
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    // bm25() in FTS5 returns negative values (lower = better match),
    // so we negate and normalise to [0,1] via a simple 1/(1+|score|) approach
    const ftsRows = (db.prepare(`
      SELECT m.id, bm25(memories_fts) AS raw_score
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?${filterClause}
      ORDER BY raw_score
      LIMIT ?
    `) as any).all(query, ...filterArgs, cfg.search.top_k) as Array<{ id: string; raw_score: number }>;

    for (const row of ftsRows) {
      // Normalise: bm25 is negative; convert to 0-1
      const normalised = 1 / (1 + Math.abs(row.raw_score));
      bm25Map.set(row.id, normalised);
    }
    db.close();
  } catch {
    // FTS unavailable (e.g. no matches) — continue with vector only
  }

  // --- Vector search via sqlite-vec ---
  const vectorMap = new Map<string, number>();
  try {
    const queryVec = await fetchEmbedding(query, cfg.embedding);
    if (queryVec) {
      const qf32 = new Float32Array(queryVec);
      const db = new Database(MEMORY_DB, { readonly: true });
      // Use core's vectorSearch which queries vec_embeddings virtual table
      const vecResults = vectorSearch(db as any, qf32, {
        limit: cfg.search.top_k,
        type: body.type as "fact" | "preference" | "decision" | undefined,
      });
      db.close();

      for (const r of vecResults) {
        vectorMap.set(r.id, r.score);
      }
    }
  } catch (e) {
    logger.warn('memory', 'Vector search failed, using keyword only', { error: String(e) });
  }

  // --- Merge scores ---
  const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
  const scored: Array<{ id: string; score: number; source: string }> = [];

  for (const id of allIds) {
    const bm25 = bm25Map.get(id) ?? 0;
    const vec  = vectorMap.get(id) ?? 0;
    let score: number;
    let source: string;

    if (bm25 > 0 && vec > 0) {
      score  = alpha * vec + (1 - alpha) * bm25;
      source = 'hybrid';
    } else if (vec > 0) {
      score  = vec;
      source = 'vector';
    } else {
      score  = bm25;
      source = 'keyword';
    }

    if (score >= minScore) scored.push({ id, score, source });
  }

  scored.sort((a, b) => b.score - a.score);
  const topIds = scored.slice(0, limit).map(s => s.id);

  if (topIds.length === 0) {
    return c.json({ results: [], query, method: 'hybrid' });
  }

  // --- Fetch full memory rows ---
  try {
    const db = new Database(MEMORY_DB);  // Writable for access tracking
    const placeholders = topIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id, content, type, tags, pinned, importance, who, project, created_at
      FROM memories
      WHERE id IN (${placeholders})
    `).all(...topIds) as Array<{
      id: string;
      content: string;
      type: string;
      tags: string | null;
      pinned: number;
      importance: number;
      who: string;
      project: string | null;
      created_at: string;
    }>;

    // Update access tracking (don't fail if this fails)
    try {
      db.prepare(`
        UPDATE memories
        SET last_accessed = datetime('now'), access_count = access_count + 1
        WHERE id IN (${placeholders})
      `).run(...topIds);
    } catch (e) {
      // Log but don't fail
      logger.warn('memory', 'Failed to update access tracking', e as Error);
    }

    db.close();

    const rowMap = new Map(rows.map(r => [r.id, r]));
    const results = scored
      .slice(0, limit)
      .filter(s => rowMap.has(s.id))
      .map(s => {
        const r = rowMap.get(s.id)!;
        return {
          content: r.content,
          score: Math.round(s.score * 100) / 100,
          source: s.source,
          type: r.type,
          tags: r.tags,
          pinned: !!r.pinned,
          importance: r.importance,
          who: r.who,
          project: r.project,
          created_at: r.created_at,
        };
      });

    return c.json({ results, query, method: vectorMap.size > 0 ? 'hybrid' : 'keyword' });
  } catch (e) {
    logger.error('memory', 'Failed to fetch recall results', e as Error);
    return c.json({ error: 'Recall failed', results: [] }, 500);
  }
});

// Alias: GET /api/memory/search?q=... (spec-compatible)
app.get('/api/memory/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const type = c.req.query('type');
  const tags = c.req.query('tags');
  const who = c.req.query('who');

  return fetch(`http://${HOST}:${PORT}/api/memory/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, limit, type, tags, who }),
  });
});

// ============================================================================
// Memory Similar API (Vector Search)
// ============================================================================

app.get('/memory/similar', async (c) => {
  const id = c.req.query('id');
  if (!id) {
    return c.json({ error: 'id is required', results: [] }, 400);
  }

  const k = parseInt(c.req.query('k') ?? '10', 10);
  const type = c.req.query('type');

  try {
    const db = new Database(MEMORY_DB, { readonly: true });

    // Get the embedding for the given memory ID
    const embeddingRow = db.prepare(`
      SELECT vector
      FROM embeddings
      WHERE source_type = 'memory' AND source_id = ?
      LIMIT 1
    `).get(id) as { vector: Buffer } | undefined;

    if (!embeddingRow) {
      db.close();
      return c.json({ error: 'No embedding found for this memory', results: [] }, 404);
    }

    // Convert BLOB to Float32Array for vector search
    const queryVector = new Float32Array(
      embeddingRow.vector.buffer.slice(
        embeddingRow.vector.byteOffset,
        embeddingRow.vector.byteOffset + embeddingRow.vector.byteLength,
      ),
    );

    // Use core's vectorSearch to find similar memories
    const searchResults = vectorSearch(db as any, queryVector, {
      limit: k + 1, // +1 because the query memory itself will be in results
      type: type as 'fact' | 'preference' | 'decision' | undefined,
    });
    db.close();

    // Filter out the query memory itself and fetch full memory details
    const filteredResults = searchResults.filter(r => r.id !== id).slice(0, k);

    if (filteredResults.length === 0) {
      return c.json({ results: [] });
    }

    // Fetch full memory details for the results
    const db2 = new Database(MEMORY_DB, { readonly: true });
    const ids = filteredResults.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db2.prepare(`
      SELECT id, content, type, tags, confidence, created_at
      FROM memories
      WHERE id IN (${placeholders})
    `).all(...ids) as Array<{
      id: string;
      content: string;
      type: string;
      tags: string | null;
      confidence: number;
      created_at: string;
    }>;
    db2.close();

    const rowMap = new Map(rows.map(r => [r.id, r]));
    const results = filteredResults
      .filter(r => rowMap.has(r.id))
      .map(r => {
        const row = rowMap.get(r.id)!;
        return {
          id: r.id,
          content: row.content,
          type: row.type,
          tags: row.tags ? JSON.parse(row.tags) : [],
          score: Math.round(r.score * 100) / 100,
          confidence: row.confidence,
          created_at: row.created_at,
        };
      });

    return c.json({ results });
  } catch (e) {
    logger.error('memory', 'Similarity search failed', e as Error);
    return c.json({ error: 'Similarity search failed', results: [] }, 500);
  }
});

// ============================================================================
// Embeddings API
// ============================================================================

app.get('/api/embeddings', async (c) => {
  const withVectors = c.req.query('vectors') === 'true';
  const scriptPath = join(AGENTS_DIR, 'memory', 'scripts', 'export_embeddings.py');
  
  return new Promise<Response>((resolve) => {
    const args = withVectors ? ['--with-vectors'] : [];
    const proc = spawn(getPythonCmd(), [scriptPath, ...args], { timeout: 60000 });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve(c.json(result));
        } catch {
          resolve(c.json({ error: 'Failed to parse response', embeddings: [] }));
        }
      } else {
        resolve(c.json({ 
          error: stderr || `Script exited with code ${code}`, 
          embeddings: [] 
        }));
      }
    });
    
    proc.on('error', (err) => {
      resolve(c.json({ error: err.message, embeddings: [] }));
    });
  });
});

app.get('/api/embeddings/status', async (c) => {
  const config = loadMemoryConfig();
  const status = await checkEmbeddingProvider(config.embedding);
  return c.json(status);
});

// ============================================================================
// Skills API
// ============================================================================

interface SkillMeta {
  description: string;
  version?: string;
  author?: string;
  license?: string;
  user_invocable?: boolean;
  arg_hint?: string;
}

function parseSkillFrontmatter(content: string): SkillMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { description: '' };

  const fm = match[1];
  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };

  return {
    description: get('description'),
    version: get('version') || undefined,
    author: get('author') || undefined,
    license: get('license') || undefined,
    user_invocable: /^user_invocable:\s*true$/m.test(fm),
    arg_hint: get('arg_hint') || undefined,
  };
}

function listInstalledSkills() {
  if (!existsSync(SKILLS_DIR)) return [];

  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => {
      const skillMdPath = join(SKILLS_DIR, d.name, 'SKILL.md');
      if (!existsSync(skillMdPath)) return [];
      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        const meta = parseSkillFrontmatter(content);
        return [{ name: d.name, ...meta, path: join(SKILLS_DIR, d.name) }];
      } catch {
        return [];
      }
    });
}

// GET /api/skills - list installed skills
app.get('/api/skills', (c) => {
  try {
    const skills = listInstalledSkills();
    return c.json({ skills, count: skills.length });
  } catch (e) {
    logger.error('skills', 'Error listing skills', e as Error);
    return c.json({ skills: [], count: 0, error: 'Failed to list skills' });
  }
});

// GET /api/skills/search?q=query - search skills.sh registry (MUST be before :name route)
app.get('/api/skills/search', async (c) => {
  const query = c.req.query('q');
  if (!query) {
    return c.json({ results: [], error: 'Query parameter q is required' }, 400);
  }

  logger.info('skills', 'Searching skills', { query });

  // Strip ANSI escape codes
  const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

  return new Promise<Response>((resolve) => {
    const proc = spawn('npx', ['skills', 'search', query], {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        // Parse text output - format:
        // owner/repo@skill  N installs
        // └ https://skills.sh/...
        const clean = stripAnsi(stdout);
        const lines = clean.split('\n');
        const installed = listInstalledSkills().map(s => s.name);
        const results: Array<{ name: string; description: string; installed: boolean }> = [];
        
        for (const line of lines) {
          // Match: "owner/repo@skill  N installs" or "owner/repo@skill N installs"
          const match = line.match(/^([\w\-./]+@[\w\-]+)\s+(\d+(?:\.\d+)?[KMB]?\s*installs?)/i);
          if (match) {
            const fullName = match[1]; // e.g. "browser-use/browser-use@browser-use"
            const installs = match[2]; // e.g. "32.6K installs"
            // Extract skill name (after @)
            const parts = fullName.split('@');
            const skillName = parts[parts.length - 1];
            // Use the full package as description since we don't have a real description
            results.push({
              name: skillName,
              description: `${fullName} (${installs})`,
              installed: installed.includes(skillName),
            });
          }
        }
        resolve(c.json({ results }));
      } else {
        logger.error('skills', 'Search failed', undefined, { stderr });
        resolve(c.json({ results: [], error: stripAnsi(stderr) || 'Search failed' }, 500));
      }
    });

    proc.on('error', (err: Error) => {
      resolve(c.json({ results: [], error: err.message }, 500));
    });
  });
});

// GET /api/skills/:name - get skill details and SKILL.md content
app.get('/api/skills/:name', (c) => {
  const name = c.req.param('name');
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400);
  }

  const skillMdPath = join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    return c.json({ error: `Skill '${name}' not found` }, 404);
  }

  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const meta = parseSkillFrontmatter(content);
    return c.json({ name, ...meta, path: join(SKILLS_DIR, name), content });
  } catch (e) {
    logger.error('skills', 'Error reading skill', e as Error);
    return c.json({ error: 'Failed to read skill' }, 500);
  }
});

// POST /api/skills/install - install a skill
app.post('/api/skills/install', async (c) => {
  let body: { name?: string; source?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { name, source } = body;
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  // Sanitize: allow alphanumeric, dash, underscore, slash (for owner/repo)
  if (!/^[\w\-./]+$/.test(name)) {
    return c.json({ error: 'Invalid skill name' }, 400);
  }

  const pkg = source || name;
  logger.info('skills', 'Installing skill', { name, pkg });

  return new Promise<Response>((resolve) => {
    const proc = spawn('npx', ['skills', 'add', pkg, '--global', '--yes'], {
      env: { ...process.env },
      timeout: 60000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        logger.info('skills', 'Skill installed', { name });
        resolve(c.json({ success: true, name, output: stdout }));
      } else {
        const errMsg = stderr || stdout || `Install exited with code ${code}`;
        logger.error('skills', 'Skill install failed', undefined, { stderr });
        resolve(c.json({ success: false, error: errMsg }, 500));
      }
    });

    proc.on('error', (err: Error) => {
      resolve(c.json({ success: false, error: err.message }, 500));
    });
  });
});

// DELETE /api/skills/:name - uninstall a skill
app.delete('/api/skills/:name', (c) => {
  const name = c.req.param('name');
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400);
  }

  const skillDir = join(SKILLS_DIR, name);
  if (!existsSync(skillDir)) {
    return c.json({ error: `Skill '${name}' not found` }, 404);
  }

  try {
    rmSync(skillDir, { recursive: true, force: true });
    logger.info('skills', 'Skill removed', { name });
    return c.json({ success: true, name, message: `Removed ${name}` });
  } catch (e) {
    logger.error('skills', 'Error removing skill', e as Error);
    return c.json({ success: false, error: 'Failed to remove skill' }, 500);
  }
});

// ============================================================================
// Harnesses API
// ============================================================================

app.get('/api/harnesses', async (c) => {
  const configs = [
    { name: 'Claude Code', path: join(homedir(), '.claude', 'CLAUDE.md') },
    { name: 'OpenCode', path: join(homedir(), '.config', 'opencode', 'AGENTS.md') },
    { name: 'OpenClaw (Source)', path: join(AGENTS_DIR, 'AGENTS.md') },
  ];

  const harnesses = configs.map(config => ({
    name: config.name,
    path: config.path,
    exists: existsSync(config.path),
  }));

  return c.json({ harnesses });
});

app.post('/api/harnesses/regenerate', async (c) => {
  return new Promise<Response>((resolve) => {
    const script = join(SCRIPTS_DIR, 'generate-harness-configs.py');
    
    if (!existsSync(script)) {
      resolve(c.json({ success: false, error: 'Regeneration script not found' }, 404));
      return;
    }
    
    const proc = spawn(getPythonCmd(), [script], {
      timeout: 10000,
      cwd: AGENTS_DIR
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info('harness', 'Harness configs regenerated');
        resolve(c.json({ success: true, message: 'Configs regenerated successfully', output: stdout }));
      } else {
        resolve(c.json({ success: false, error: stderr || `Script exited with code ${code}` }, 500));
      }
    });
    
    proc.on('error', (err) => {
      resolve(c.json({ success: false, error: err.message }, 500));
    });
  });
});

// ============================================================================
// Secrets API
// ============================================================================

// Store a secret
app.post('/api/secrets/:name', async (c) => {
  const { name } = c.req.param();
  try {
    const body = await c.req.json() as { value?: string };
    if (typeof body.value !== 'string' || body.value.length === 0) {
      return c.json({ error: 'value is required' }, 400);
    }
    await putSecret(name, body.value);
    logger.info('secrets', 'Secret stored', { name });
    return c.json({ success: true, name });
  } catch (e) {
    const err = e as Error;
    logger.error('secrets', 'Failed to store secret', err, { name });
    return c.json({ error: err.message }, 400);
  }
});

// List secret names (never values)
app.get('/api/secrets', (c) => {
  try {
    const names = listSecrets();
    return c.json({ secrets: names });
  } catch (e) {
    logger.error('secrets', 'Failed to list secrets', e as Error);
    return c.json({ error: 'Failed to list secrets' }, 500);
  }
});

// Delete a secret
app.delete('/api/secrets/:name', (c) => {
  const { name } = c.req.param();
  try {
    const deleted = deleteSecret(name);
    if (!deleted) return c.json({ error: `Secret '${name}' not found` }, 404);
    logger.info('secrets', 'Secret deleted', { name });
    return c.json({ success: true, name });
  } catch (e) {
    logger.error('secrets', 'Failed to delete secret', e as Error, { name });
    return c.json({ error: (e as Error).message }, 500);
  }
});

// Execute a command with secrets injected into the subprocess environment.
// The agent provides references (env var → secret name), never values.
app.post('/api/secrets/:name/exec', async (c) => {
  const { name } = c.req.param();
  try {
    const body = await c.req.json() as {
      command?: string;
      secrets?: Record<string, string>;
    };

    if (!body.command) {
      return c.json({ error: 'command is required' }, 400);
    }

    // By default inject the named secret under its own env var name.
    // Callers can pass a full secrets map to inject multiple secrets.
    const secretRefs: Record<string, string> = body.secrets ?? { [name]: name };

    const result = await execWithSecrets(body.command, secretRefs);
    logger.info('secrets', 'exec_with_secrets completed', {
      name,
      code: result.code,
    });
    return c.json(result);
  } catch (e) {
    const err = e as Error;
    logger.error('secrets', 'exec_with_secrets failed', err, { name });
    return c.json({ error: err.message }, 500);
  }
});

// ============================================================================
// ============================================================================
// Hooks API
// ============================================================================

import {
  handleSessionStart,
  handlePreCompaction,
  handleSynthesisRequest,
  getSynthesisConfig,
  SessionStartRequest,
  PreCompactionRequest,
  SynthesisRequest,
} from './hooks.js';

// Session start hook - provides context/memories for injection
app.post('/api/hooks/session-start', async (c) => {
  try {
    const body = await c.req.json() as SessionStartRequest;
    
    if (!body.harness) {
      return c.json({ error: 'harness is required' }, 400);
    }
    
    const result = handleSessionStart(body);
    return c.json(result);
  } catch (e) {
    logger.error('hooks', 'Session start hook failed', e as Error);
    return c.json({ error: 'Hook execution failed' }, 500);
  }
});

// Pre-compaction hook - provides summary instructions
app.post('/api/hooks/pre-compaction', async (c) => {
  try {
    const body = await c.req.json() as PreCompactionRequest;
    
    if (!body.harness) {
      return c.json({ error: 'harness is required' }, 400);
    }
    
    const result = handlePreCompaction(body);
    return c.json(result);
  } catch (e) {
    logger.error('hooks', 'Pre-compaction hook failed', e as Error);
    return c.json({ error: 'Hook execution failed' }, 500);
  }
});

// Save compaction summary (convenience endpoint)
app.post('/api/hooks/compaction-complete', async (c) => {
  try {
    const body = await c.req.json() as {
      harness: string;
      summary: string;
      sessionKey?: string;
    };
    
    if (!body.harness || !body.summary) {
      return c.json({ error: 'harness and summary are required' }, 400);
    }
    
    // Save the summary as a memory
    if (!existsSync(MEMORY_DB)) {
      return c.json({ error: 'Memory database not found' }, 500);
    }
    
    const db = new Database(MEMORY_DB);
    const now = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO memories (content, type, importance, source, who, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      body.summary,
      'session_summary',
      0.8,  // Session summaries are important
      body.harness,
      'system',
      JSON.stringify(['session', 'summary', body.harness]),
      now,
      now
    );
    
    db.close();
    
    logger.info('hooks', 'Compaction summary saved', { 
      harness: body.harness, 
      memoryId: result.lastInsertRowid 
    });
    
    return c.json({ 
      success: true, 
      memoryId: result.lastInsertRowid 
    });
  } catch (e) {
    logger.error('hooks', 'Compaction complete failed', e as Error);
    return c.json({ error: 'Failed to save summary' }, 500);
  }
});

// Get synthesis config
app.get('/api/hooks/synthesis/config', (c) => {
  const config = getSynthesisConfig();
  return c.json(config);
});

// Request MEMORY.md synthesis
app.post('/api/hooks/synthesis', async (c) => {
  try {
    const body = await c.req.json() as SynthesisRequest;
    const result = handleSynthesisRequest(body);
    return c.json(result);
  } catch (e) {
    logger.error('hooks', 'Synthesis request failed', e as Error);
    return c.json({ error: 'Synthesis request failed' }, 500);
  }
});

// Save synthesized MEMORY.md
app.post('/api/hooks/synthesis/complete', async (c) => {
  try {
    const body = await c.req.json() as { content: string };
    
    if (!body.content) {
      return c.json({ error: 'content is required' }, 400);
    }
    
    const memoryMdPath = join(AGENTS_DIR, 'MEMORY.md');
    
    // Backup existing
    if (existsSync(memoryMdPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = join(AGENTS_DIR, 'memory', `MEMORY.backup-${timestamp}.md`);
      mkdirSync(join(AGENTS_DIR, 'memory'), { recursive: true });
      writeFileSync(backupPath, readFileSync(memoryMdPath, 'utf-8'));
    }
    
    // Write new MEMORY.md with timestamp header
    const header = `<!-- generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} -->\n\n`;
    writeFileSync(memoryMdPath, header + body.content);
    
    logger.info('hooks', 'MEMORY.md synthesized');
    
    return c.json({ success: true });
  } catch (e) {
    logger.error('hooks', 'Synthesis complete failed', e as Error);
    return c.json({ error: 'Failed to save MEMORY.md' }, 500);
  }
});

// ============================================================================
// Git Sync API
// ============================================================================

// Get git status
app.get('/api/git/status', async (c) => {
  const status = await getGitStatus();
  return c.json(status);
});

// Pull changes from remote
app.post('/api/git/pull', async (c) => {
  const result = await gitPull();
  return c.json(result);
});

// Push changes to remote
app.post('/api/git/push', async (c) => {
  const result = await gitPush();
  return c.json(result);
});

// Full sync (pull + push)
app.post('/api/git/sync', async (c) => {
  const result = await gitSync();
  return c.json(result);
});

// Get/set git config
app.get('/api/git/config', (c) => {
  return c.json(gitConfig);
});

app.post('/api/git/config', async (c) => {
  const body = await c.req.json() as Partial<GitConfig>;
  
  // Update in-memory config
  if (body.autoSync !== undefined) gitConfig.autoSync = body.autoSync;
  if (body.syncInterval !== undefined) gitConfig.syncInterval = body.syncInterval;
  if (body.remote) gitConfig.remote = body.remote;
  if (body.branch) gitConfig.branch = body.branch;
  
  // Restart sync timer if needed
  if (body.autoSync !== undefined || body.syncInterval !== undefined) {
    stopGitSyncTimer();
    if (gitConfig.autoSync) {
      startGitSyncTimer();
    }
  }
  
  return c.json({ success: true, config: gitConfig });
});

// ============================================================================
// Update System
// ============================================================================

const CURRENT_VERSION = '0.1.0';
const GITHUB_REPO = 'Signet-AI/signetai';
const NPM_PACKAGE = 'signetai';

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  checkError?: string;
}

let lastUpdateCheck: UpdateInfo | null = null;
let lastUpdateCheckTime: Date | null = null;

// Check for updates via GitHub releases
async function checkForUpdates(): Promise<UpdateInfo> {
  const result: UpdateInfo = {
    currentVersion: CURRENT_VERSION,
    latestVersion: null,
    updateAvailable: false,
  };

  try {
    // Check GitHub releases
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'signet-daemon',
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (res.ok) {
      const data = await res.json() as {
        tag_name: string;
        html_url: string;
        body: string;
        published_at: string;
      };
      
      // Parse version (remove 'v' prefix if present)
      const latestVersion = data.tag_name.replace(/^v/, '');
      result.latestVersion = latestVersion;
      result.releaseUrl = data.html_url;
      result.releaseNotes = data.body?.slice(0, 500);
      result.publishedAt = data.published_at;
      
      // Compare versions (simple string comparison for now)
      result.updateAvailable = latestVersion > CURRENT_VERSION;
    } else {
      // Try npm as fallback
      const npmRes = await fetch(
        `https://registry.npmjs.org/${NPM_PACKAGE}/latest`,
        { signal: AbortSignal.timeout(10000) }
      );
      
      if (npmRes.ok) {
        const npmData = await npmRes.json() as { version: string };
        result.latestVersion = npmData.version;
        result.updateAvailable = npmData.version > CURRENT_VERSION;
      }
    }
  } catch (e) {
    result.checkError = (e as Error).message;
    logger.warn('system', 'Update check failed', { error: result.checkError });
  }

  lastUpdateCheck = result;
  lastUpdateCheckTime = new Date();
  
  if (result.updateAvailable) {
    logger.info('system', `Update available: v${result.latestVersion}`);
  }

  return result;
}

// Run update (via npm/bun)
async function runUpdate(): Promise<{ success: boolean; message: string; output?: string }> {
  return new Promise((resolve) => {
    // Try bun first, fall back to npm
    const packageManager = existsSync('/usr/bin/bun') ? 'bun' : 'npm';
    const args = packageManager === 'bun' 
      ? ['add', '-g', NPM_PACKAGE]
      : ['install', '-g', NPM_PACKAGE];
    
    const proc = spawn(packageManager, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info('system', 'Update installed successfully');
        resolve({
          success: true,
          message: 'Update installed. Restart daemon to apply.',
          output: stdout,
        });
      } else {
        logger.warn('system', 'Update failed', { stderr });
        resolve({
          success: false,
          message: `Update failed: ${stderr || 'Unknown error'}`,
          output: stdout + stderr,
        });
      }
    });
    
    proc.on('error', (e) => {
      resolve({
        success: false,
        message: `Update failed: ${e.message}`,
      });
    });
  });
}

// API: Check for updates
app.get('/api/update/check', async (c) => {
  const force = c.req.query('force') === 'true';
  
  // Return cached result if recent (< 1 hour) and not forced
  if (!force && lastUpdateCheck && lastUpdateCheckTime) {
    const age = Date.now() - lastUpdateCheckTime.getTime();
    if (age < 3600000) { // 1 hour
      return c.json({
        ...lastUpdateCheck,
        cached: true,
        checkedAt: lastUpdateCheckTime.toISOString(),
      });
    }
  }
  
  const result = await checkForUpdates();
  return c.json({
    ...result,
    cached: false,
    checkedAt: lastUpdateCheckTime?.toISOString(),
  });
});

// API: Run update
app.post('/api/update/run', async (c) => {
  const result = await runUpdate();
  return c.json(result);
});

// ============================================================================
// Daemon Info
// ============================================================================

app.get('/api/status', (c) => {
  const config = loadMemoryConfig();

  return c.json({
    status: 'running',
    version: CURRENT_VERSION,
    pid: process.pid,
    uptime: process.uptime(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    port: PORT,
    host: HOST,
    agentsDir: AGENTS_DIR,
    memoryDb: existsSync(MEMORY_DB),
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      // Don't block on status check for /api/status - use cached if available
      ...(cachedEmbeddingStatus && (Date.now() - statusCacheTime) < STATUS_CACHE_TTL
        ? { available: cachedEmbeddingStatus.available }
        : {}),
    },
  });
});

// ============================================================================
// Static Dashboard
// ============================================================================

const dashboardPath = getDashboardPath();

function setupStaticServing() {
  if (dashboardPath) {
    logger.info('daemon', 'Serving dashboard', { path: dashboardPath });
    
    // Skip static serving for API routes (let them 404 properly if not matched)
    app.use('/*', async (c, next) => {
      const path = c.req.path;
      if (path.startsWith('/api/') || path === '/health' || path === '/sse') {
        return next();
      }
      return serveStatic({ 
        root: dashboardPath,
        rewriteRequestPath: (p) => {
          // SPA fallback: if no extension, serve index.html
          if (!p.includes('.') || p === '/') {
            return '/index.html';
          }
          return p;
        }
      })(c, next);
    });
  } else {
    logger.warn('daemon', 'Dashboard not found - API-only mode');
    app.get('/', (c) => {
      return c.html(`
        <!DOCTYPE html>
        <html>
        <head><title>Signet Daemon</title></head>
        <body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>◈ Signet Daemon</h1>
          <p>The daemon is running, but the dashboard is not installed.</p>
          <p>API endpoints:</p>
          <ul>
            <li><a href="/health">/health</a> - Health check</li>
            <li><a href="/api/status">/api/status</a> - Daemon status</li>
            <li><a href="/api/config">/api/config</a> - Config files</li>
            <li><a href="/api/memories">/api/memories</a> - Memories</li>
            <li><a href="/api/harnesses">/api/harnesses</a> - Harnesses</li>
            <li><a href="/api/skills">/api/skills</a> - Skills</li>
          </ul>
        </body>
        </html>
      `);
    });
  }
}

setupStaticServing();

// ============================================================================
// File Watcher
// ============================================================================

let watcher: ReturnType<typeof watch> | null = null;

// ============================================================================
// Git Sync System
// ============================================================================

interface GitConfig {
  enabled: boolean;
  autoCommit: boolean;
  autoSync: boolean;
  syncInterval: number; // seconds
  remote: string;
  branch: string;
}

function loadGitConfig(): GitConfig {
  const defaults: GitConfig = {
    enabled: true,
    autoCommit: true,
    autoSync: true, // enabled by default - credentials auto-detected from gh, ssh, or credential helper
    syncInterval: 300, // 5 minutes
    remote: 'origin',
    branch: 'main',
  };

  const paths = [
    join(AGENTS_DIR, 'agent.yaml'),
    join(AGENTS_DIR, 'AGENT.yaml'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const yaml = parseSimpleYaml(readFileSync(p, 'utf-8'));
      const git = yaml.git as Record<string, any> | undefined;
      if (git) {
        if (git.enabled !== undefined) defaults.enabled = git.enabled === 'true' || git.enabled === true;
        if (git.autoCommit !== undefined) defaults.autoCommit = git.autoCommit === 'true' || git.autoCommit === true;
        if (git.autoSync !== undefined) defaults.autoSync = git.autoSync === 'true' || git.autoSync === true;
        if (git.syncInterval !== undefined) defaults.syncInterval = parseInt(git.syncInterval, 10);
        if (git.remote) defaults.remote = git.remote;
        if (git.branch) defaults.branch = git.branch;
      }
      break;
    } catch {
      // ignore parse errors
    }
  }

  return defaults;
}

let gitConfig = loadGitConfig();
let gitSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastGitSync: Date | null = null;
let gitSyncInProgress = false;

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

// Git credential resolution result
interface GitCredentials {
  method: 'token' | 'gh' | 'credential-helper' | 'ssh' | 'none';
  authUrl?: string;  // For HTTPS with embedded auth
  usePlainGit?: boolean;  // For SSH - just run git without URL modification
}

// Run a command and return stdout/stderr
async function runCommand(cmd: string, args: string[], options?: { input?: string }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    if (options?.input) {
      proc.stdin?.write(options.input);
      proc.stdin?.end();
    }

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    proc.on('error', () => {
      resolve({ stdout: '', stderr: '', code: 1 });
    });
  });
}

// Get remote URL for a given remote
async function getRemoteUrl(dir: string, remote: string): Promise<string | null> {
  const result = await runCommand('git', ['remote', 'get-url', remote]);
  return result.code === 0 ? result.stdout.trim() : null;
}

// Build authenticated URL from token
function buildAuthUrlFromToken(baseUrl: string, token: string): string {
  // Convert SSH to HTTPS if needed
  let url = baseUrl;
  if (url.startsWith('git@github.com:')) {
    url = url.replace('git@github.com:', 'https://github.com/');
  }

  // Embed token in HTTPS URL
  if (url.startsWith('https://github.com/')) {
    return url.replace('https://github.com/', `https://${token}@github.com/`);
  } else if (url.startsWith('https://') && url.includes('github.com')) {
    return url.replace(/https:\/\/([^@]+@)?github\.com/, `https://${token}@github.com`);
  }
  return url;
}

// Build authenticated URL from username/password
function buildAuthUrlFromCreds(baseUrl: string, creds: { username: string; password: string }): string {
  let url = baseUrl;
  if (url.startsWith('git@github.com:')) {
    url = url.replace('git@github.com:', 'https://github.com/');
  }
  // Remove existing auth if any
  url = url.replace(/https:\/\/[^@]+@/, 'https://');
  return url.replace('https://', `https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@`);
}

// Get credentials from git credential helper
async function getCredentialHelperToken(url: string): Promise<{ username: string; password: string } | null> {
  try {
    // Parse URL to get host
    const urlObj = new URL(url);
    const input = `protocol=${urlObj.protocol.replace(':', '')}\nhost=${urlObj.host}\n\n`;
    const result = await runCommand('git', ['credential', 'fill'], { input });

    if (result.code !== 0) return null;

    // Parse output: "protocol=https\nhost=github.com\nusername=...\npassword=..."
    const lines = result.stdout.split('\n');
    const username = lines.find(l => l.startsWith('username='))?.slice(9);
    const password = lines.find(l => l.startsWith('password='))?.slice(9);

    return username && password ? { username, password } : null;
  } catch {
    return null;
  }
}

// Get token from gh CLI
async function getGhCliToken(): Promise<string | null> {
  try {
    const result = await runCommand('gh', ['auth', 'token']);
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

// Check if any git credentials are available (for status checks)
async function hasAnyGitCredentials(): Promise<boolean> {
  // Check stored token
  if (await hasSecret('GITHUB_TOKEN')) return true;

  // Check gh CLI
  if (await getGhCliToken()) return true;

  // Check if remote uses SSH
  if (isGitRepo(AGENTS_DIR)) {
    const remoteUrl = await getRemoteUrl(AGENTS_DIR, gitConfig.remote);
    if (remoteUrl?.startsWith('git@')) return true;

    // Check credential helper for HTTPS
    if (remoteUrl?.startsWith('https://')) {
      const creds = await getCredentialHelperToken(remoteUrl);
      if (creds) return true;
    }
  }

  return false;
}

// Resolve git credentials using multiple methods
async function resolveGitCredentials(dir: string, remote: string): Promise<GitCredentials> {
  const remoteUrl = await getRemoteUrl(dir, remote);
  if (!remoteUrl) {
    return { method: 'none' };
  }

  // 1. Try stored GITHUB_TOKEN first (highest priority)
  try {
    const token = await getSecret('GITHUB_TOKEN');
    if (token) {
      logger.debug('git', 'Using stored GITHUB_TOKEN for authentication');
      return { method: 'token', authUrl: buildAuthUrlFromToken(remoteUrl, token) };
    }
  } catch { /* ignore */ }

  // 2. Try gh CLI auth token
  try {
    const ghToken = await getGhCliToken();
    if (ghToken) {
      logger.debug('git', 'Using gh CLI token for authentication');
      return { method: 'gh', authUrl: buildAuthUrlFromToken(remoteUrl, ghToken) };
    }
  } catch { /* ignore */ }

  // 3. Check for SSH remote (works without modification)
  if (remoteUrl.startsWith('git@')) {
    logger.debug('git', 'Using SSH for authentication');
    return { method: 'ssh', usePlainGit: true };
  }

  // 4. Try credential helper for HTTPS
  if (remoteUrl.startsWith('https://')) {
    try {
      const creds = await getCredentialHelperToken(remoteUrl);
      if (creds) {
        logger.debug('git', 'Using git credential helper for authentication');
        return { method: 'credential-helper', authUrl: buildAuthUrlFromCreds(remoteUrl, creds) };
      }
    } catch { /* ignore */ }
  }

  return { method: 'none' };
}

// Run a git command with optional authenticated remote
function runGitCommand(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.on('error', (e) => {
      resolve({ code: 1, stdout: '', stderr: e.message });
    });
  });
}

// Pull changes from remote
async function gitPull(): Promise<{ success: boolean; message: string; changes?: number }> {
  if (!isGitRepo(AGENTS_DIR)) {
    return { success: false, message: 'Not a git repository' };
  }

  const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);

  let fetchResult: { code: number; stdout: string; stderr: string };

  if (creds.usePlainGit) {
    // SSH: use plain git pull
    fetchResult = await runGitCommand(['fetch', gitConfig.remote, gitConfig.branch], AGENTS_DIR);
  } else if (creds.authUrl) {
    // HTTPS with auth: use authenticated URL
    fetchResult = await runGitCommand(['fetch', creds.authUrl, gitConfig.branch], AGENTS_DIR);
  } else {
    return {
      success: false,
      message: 'No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.',
    };
  }
  
  if (fetchResult.code !== 0) {
    logger.warn('git', `Fetch failed: ${fetchResult.stderr}`);
    return { success: false, message: `Fetch failed: ${fetchResult.stderr}` };
  }

  // Check for incoming changes
  const diffResult = await runGitCommand(
    ['rev-list', '--count', `HEAD..${gitConfig.remote}/${gitConfig.branch}`],
    AGENTS_DIR
  );
  
  const incomingChanges = parseInt(diffResult.stdout.trim(), 10) || 0;
  
  if (incomingChanges === 0) {
    return { success: true, message: 'Already up to date', changes: 0 };
  }

  // Stash local changes if any
  const statusResult = await runGitCommand(['status', '--porcelain'], AGENTS_DIR);
  const hasLocalChanges = statusResult.stdout.trim().length > 0;
  
  if (hasLocalChanges) {
    await runGitCommand(['stash', 'push', '-m', 'signet-auto-stash'], AGENTS_DIR);
  }

  // Pull (merge)
  const pullResult = await runGitCommand(
    ['merge', `${gitConfig.remote}/${gitConfig.branch}`, '--ff-only'],
    AGENTS_DIR
  );
  
  // Restore stashed changes if any
  if (hasLocalChanges) {
    await runGitCommand(['stash', 'pop'], AGENTS_DIR);
  }

  if (pullResult.code !== 0) {
    logger.warn('git', `Pull failed: ${pullResult.stderr}`);
    return { success: false, message: `Pull failed: ${pullResult.stderr}` };
  }

  logger.git.sync('pull', incomingChanges);
  return { success: true, message: `Pulled ${incomingChanges} commits`, changes: incomingChanges };
}

// Push changes to remote
async function gitPush(): Promise<{ success: boolean; message: string; changes?: number }> {
  if (!isGitRepo(AGENTS_DIR)) {
    return { success: false, message: 'Not a git repository' };
  }

  const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);

  // Check for outgoing changes
  const diffResult = await runGitCommand(
    ['rev-list', '--count', `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
    AGENTS_DIR
  );

  const outgoingChanges = parseInt(diffResult.stdout.trim(), 10) || 0;

  if (outgoingChanges === 0) {
    return { success: true, message: 'Nothing to push', changes: 0 };
  }

  let pushResult: { code: number; stdout: string; stderr: string };

  if (creds.usePlainGit) {
    // SSH: use plain git push
    pushResult = await runGitCommand(['push', gitConfig.remote, `HEAD:${gitConfig.branch}`], AGENTS_DIR);
  } else if (creds.authUrl) {
    // HTTPS with auth: use authenticated URL
    pushResult = await runGitCommand(['push', creds.authUrl, `HEAD:${gitConfig.branch}`], AGENTS_DIR);
  } else {
    return {
      success: false,
      message: 'No git credentials found. Run `gh auth login` or set GITHUB_TOKEN secret.',
    };
  }

  if (pushResult.code !== 0) {
    logger.warn('git', `Push failed: ${pushResult.stderr}`);
    return { success: false, message: `Push failed: ${pushResult.stderr}` };
  }

  logger.git.sync('push', outgoingChanges);
  return { success: true, message: `Pushed ${outgoingChanges} commits`, changes: outgoingChanges };
}

// Full sync: pull then push
async function gitSync(): Promise<{ success: boolean; message: string; pulled?: number; pushed?: number }> {
  if (gitSyncInProgress) {
    return { success: false, message: 'Sync already in progress' };
  }

  gitSyncInProgress = true;
  
  try {
    // Pull first
    const pullResult = await gitPull();
    if (!pullResult.success) {
      return { success: false, message: pullResult.message };
    }

    // Then push
    const pushResult = await gitPush();
    if (!pushResult.success) {
      return { success: false, message: pushResult.message, pulled: pullResult.changes };
    }

    lastGitSync = new Date();
    return {
      success: true,
      message: 'Sync complete',
      pulled: pullResult.changes,
      pushed: pushResult.changes,
    };
  } finally {
    gitSyncInProgress = false;
  }
}

// Start periodic git sync
function startGitSyncTimer() {
  if (gitSyncTimer) {
    clearInterval(gitSyncTimer);
  }

  if (!gitConfig.autoSync || gitConfig.syncInterval <= 0) {
    logger.debug('git', 'Auto-sync disabled');
    return;
  }

  const intervalMs = gitConfig.syncInterval * 1000;
  logger.info('git', `Auto-sync enabled: every ${gitConfig.syncInterval}s`);

  gitSyncTimer = setInterval(async () => {
    // Check if any credentials are available (gh, ssh, credential helper, or stored token)
    const hasCreds = await hasAnyGitCredentials();
    if (!hasCreds) {
      // Silently skip if no credentials configured
      return;
    }

    logger.debug('git', 'Running periodic sync...');
    const result = await gitSync();
    if (!result.success) {
      logger.warn('git', `Periodic sync failed: ${result.message}`);
    }
  }, intervalMs);
}

function stopGitSyncTimer() {
  if (gitSyncTimer) {
    clearInterval(gitSyncTimer);
    gitSyncTimer = null;
  }
}

// Get git status info
async function getGitStatus(): Promise<{
  isRepo: boolean;
  branch?: string;
  remote?: string;
  hasCredentials: boolean;
  authMethod?: string;
  autoSync: boolean;
  lastSync?: string;
  uncommittedChanges?: number;
  unpushedCommits?: number;
  unpulledCommits?: number;
}> {
  const status: any = {
    isRepo: isGitRepo(AGENTS_DIR),
    hasCredentials: false,
    autoSync: gitConfig.autoSync,
  };

  if (!status.isRepo) return status;

  // Check credentials and auth method
  const creds = await resolveGitCredentials(AGENTS_DIR, gitConfig.remote);
  status.hasCredentials = creds.method !== 'none';
  status.authMethod = creds.method;

  // Get current branch
  const branchResult = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], AGENTS_DIR);
  if (branchResult.code === 0) {
    status.branch = branchResult.stdout.trim();
  }

  // Get remote
  status.remote = gitConfig.remote;

  // Last sync time
  if (lastGitSync) {
    status.lastSync = lastGitSync.toISOString();
  }

  // Uncommitted changes
  const statusResult = await runGitCommand(['status', '--porcelain'], AGENTS_DIR);
  if (statusResult.code === 0) {
    status.uncommittedChanges = statusResult.stdout.trim().split('\n').filter(l => l.trim()).length;
  }

  // Unpushed commits (only if we have credentials)
  if (status.hasCredentials) {
    const unpushedResult = await runGitCommand(
      ['rev-list', '--count', `${gitConfig.remote}/${gitConfig.branch}..HEAD`],
      AGENTS_DIR
    );
    if (unpushedResult.code === 0) {
      status.unpushedCommits = parseInt(unpushedResult.stdout.trim(), 10) || 0;
    }
  }

  return status;
}

let commitPending = false;
let commitTimer: ReturnType<typeof setTimeout> | null = null;
const COMMIT_DEBOUNCE_MS = 5000; // Wait 5 seconds after last change before committing

async function gitAutoCommit(dir: string, changedFiles: string[]): Promise<void> {
  if (!isGitRepo(dir)) return;
  
  const fileList = changedFiles.map(f => f.replace(dir + '/', '')).join(', ');
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const message = `${timestamp}_auto_${fileList.slice(0, 50)}`;
  
  return new Promise((resolve) => {
    // git add -A
    const add = spawn('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    add.on('close', (addCode) => {
      if (addCode !== 0) {
        logger.warn('git', 'Git add failed');
        resolve();
        return;
      }
      // Check for changes
      const status = spawn('git', ['status', '--porcelain'], { cwd: dir, stdio: 'pipe' });
      let statusOutput = '';
      status.stdout?.on('data', (d) => { statusOutput += d.toString(); });
      status.on('close', (statusCode) => {
        if (statusCode !== 0 || !statusOutput.trim()) {
          resolve();
          return;
        }
        // Commit
        const commit = spawn('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
        commit.on('close', (commitCode) => {
          if (commitCode === 0) {
            logger.git.commit(message, changedFiles.length);
          }
          resolve();
        });
        commit.on('error', () => resolve());
      });
      status.on('error', () => resolve());
    });
    add.on('error', () => resolve());
  });
}

let pendingChanges: string[] = [];

function scheduleAutoCommit(changedPath: string) {
  pendingChanges.push(changedPath);
  
  if (commitTimer) {
    clearTimeout(commitTimer);
  }
  
  commitTimer = setTimeout(async () => {
    if (commitPending) return;
    commitPending = true;
    
    const changes = [...pendingChanges];
    pendingChanges = [];
    
    await gitAutoCommit(AGENTS_DIR, changes);
    commitPending = false;
  }, COMMIT_DEBOUNCE_MS);
}

// Auto-sync AGENTS.md to harness configs
async function syncHarnessConfigs() {
  const agentsMdPath = join(AGENTS_DIR, 'AGENTS.md');
  if (!existsSync(agentsMdPath)) return;

  const rawContent = readFileSync(agentsMdPath, 'utf-8');
  const content = stripSignetBlock(rawContent);
  const withBlock = buildSignetBlock() + content;
  
  // Build header with cross-references to other documents
  const buildHeader = (targetName: string) => {
    const files = [
      { name: 'SOUL.md', desc: 'Personality & tone' },
      { name: 'IDENTITY.md', desc: 'Agent identity' },
      { name: 'USER.md', desc: 'User profile & preferences' },
      { name: 'MEMORY.md', desc: 'Working memory context' },
      { name: 'agent.yaml', desc: 'Configuration & settings' },
    ];
    
    const existingFiles = files.filter(f => existsSync(join(AGENTS_DIR, f.name)));
    const fileList = existingFiles.map(f => `#   - ~/.agents/${f.name} (${f.desc})`).join('\n');
    
    return `# ${targetName}
# ============================================================================
# AUTO-GENERATED from ~/.agents/AGENTS.md by Signet
# Generated: ${new Date().toISOString()}
# 
# DO NOT EDIT THIS FILE - changes will be overwritten
# Edit the source file instead: ~/.agents/AGENTS.md
#
# Signet Agent Home: ~/.agents/
# Dashboard: http://localhost:3850
# CLI: signet --help
#
# Related documents:
${fileList}
#
# Memory commands: /remember <content> | /recall <query>
# ============================================================================

`;
  };
  
  // Sync to Claude Code (~/.claude/CLAUDE.md)
  const claudeDir = join(homedir(), '.claude');
  if (existsSync(claudeDir)) {
    try {
      writeFileSync(join(claudeDir, 'CLAUDE.md'), buildHeader('CLAUDE.md') + withBlock);
      logger.sync.harness('claude-code', '~/.claude/CLAUDE.md');
    } catch (e) {
      logger.sync.failed('claude-code', e as Error);
    }
  }
  
  // Sync to OpenCode (~/.config/opencode/AGENTS.md)
  const opencodeDir = join(homedir(), '.config', 'opencode');
  if (existsSync(opencodeDir)) {
    try {
      writeFileSync(join(opencodeDir, 'AGENTS.md'), buildHeader('AGENTS.md') + withBlock);
      logger.sync.harness('opencode', '~/.config/opencode/AGENTS.md');
    } catch (e) {
      logger.sync.failed('opencode', e as Error);
    }
  }
}

let syncPending = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

function scheduleSyncHarnessConfigs() {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  
  syncTimer = setTimeout(async () => {
    if (syncPending) return;
    syncPending = true;
    await syncHarnessConfigs();
    syncPending = false;
  }, SYNC_DEBOUNCE_MS);
}

function startFileWatcher() {
  watcher = watch([
    join(AGENTS_DIR, 'agent.yaml'),
    join(AGENTS_DIR, 'AGENTS.md'),
    join(AGENTS_DIR, 'SOUL.md'),
    join(AGENTS_DIR, 'MEMORY.md'),
    join(AGENTS_DIR, 'IDENTITY.md'),
    join(AGENTS_DIR, 'USER.md'),
    join(AGENTS_DIR, 'memory'),  // Watch entire memory directory for new/changed .md files
  ], {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', (path) => {
    logger.info('watcher', 'File changed', { path });
    scheduleAutoCommit(path);

    // If AGENTS.md changed, sync to harness configs
    if (path.endsWith('AGENTS.md')) {
      scheduleSyncHarnessConfigs();
    }

    // Ingest memory markdown files (excluding MEMORY.md index)
    if (path.includes('/memory/') && path.endsWith('.md') && !path.endsWith('MEMORY.md')) {
      ingestMemoryMarkdown(path).catch(e =>
        logger.error('watcher', 'Ingestion failed', undefined, { path, error: String(e) })
      );
    }
  });

  watcher.on('add', (path) => {
    logger.info('watcher', 'File added', { path });
    scheduleAutoCommit(path);

    // Ingest new memory markdown files
    if (path.includes('/memory/') && path.endsWith('.md') && !path.endsWith('MEMORY.md')) {
      ingestMemoryMarkdown(path).catch(e =>
        logger.error('watcher', 'Ingestion failed', undefined, { path, error: String(e) })
      );
    }
  });
  
  // Watch Claude Code project memories
  startClaudeMemoryWatcher();
}

// Track synced memories to avoid duplicates
const syncedClaudeMemories = new Set<string>();

function startClaudeMemoryWatcher() {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return;
  
  // Sync existing files first
  syncExistingClaudeMemories(claudeProjectsDir);
  
  const claudeWatcher = watch(
    join(claudeProjectsDir, '**', 'memory', 'MEMORY.md'),
    { persistent: true, ignoreInitial: true }
  );
  
  claudeWatcher.on('change', async (filePath) => {
    logger.info('watcher', 'Claude memory changed', { path: filePath });
    await syncClaudeMemoryFile(filePath);
  });
  
  claudeWatcher.on('add', async (filePath) => {
    logger.info('watcher', 'Claude memory added', { path: filePath });
    await syncClaudeMemoryFile(filePath);
  });
}

async function syncExistingClaudeMemories(claudeProjectsDir: string) {
  try {
    const projects = readdirSync(claudeProjectsDir);
    let totalSynced = 0;
    
    for (const project of projects) {
      const memoryFile = join(claudeProjectsDir, project, 'memory', 'MEMORY.md');
      if (existsSync(memoryFile)) {
        const count = await syncClaudeMemoryFile(memoryFile);
        totalSynced += count;
      }
    }
    
    if (totalSynced > 0) {
      logger.info('watcher', 'Synced existing Claude memories', { count: totalSynced });
    }
  } catch (e) {
    logger.error('watcher', 'Failed to sync existing Claude memories', undefined, { error: String(e) });
  }
}

async function syncClaudeMemoryFile(filePath: string): Promise<number> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) return 0;

    // Extract project path from file path
    // e.g., ~/.claude/projects/-home-user-myproject/memory/MEMORY.md
    const match = filePath.match(/projects\/([^/]+)\/memory/);
    const projectId = match ? match[1] : 'unknown';

    // Compute hash for deduplication
    const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const existingHash = ingestedMemoryFiles.get(filePath);
    if (existingHash === contentHash) {
      logger.debug('watcher', 'Claude memory file unchanged, skipping', { path: filePath });
      return 0;
    }
    ingestedMemoryFiles.set(filePath, contentHash);

    // Use hierarchical chunking to preserve section structure
    const chunks = chunkMarkdownHierarchically(content, 512);
    let inserted = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Extract section name from header for tagging
      const sectionMatch = chunk.header.match(/^#+\s+(.+)$/);
      const sectionName = sectionMatch ? sectionMatch[1].toLowerCase() : '';

      // Dedupe by content hash within this project
      const chunkKey = `claude:${projectId}:${createHash('sha256').update(chunk.text).digest('hex').slice(0, 16)}`;
      if (syncedClaudeMemories.has(chunkKey)) continue;
      syncedClaudeMemories.add(chunkKey);

      try {
        const response = await fetch(`http://${HOST}:${PORT}/api/memory/remember`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: chunk.text,
            who: 'claude-code',
            importance: chunk.level === 'section' ? 0.65 : 0.55,
            tags: [
              'claude-code',
              'claude-project-memory',
              sectionName,
              `project:${projectId}`,
              chunk.level === 'section' ? 'hierarchical-section' : 'hierarchical-paragraph'
            ].filter(Boolean).join(','),
          }),
        });

        if (response.ok) {
          inserted++;
          logger.info('watcher', 'Synced Claude memory chunk', {
            content: chunk.text.slice(0, 50),
            section: sectionName || '(no section)',
            level: chunk.level
          });
        }
      } catch (e) {
        const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
        logger.error('watcher', 'Failed to sync Claude memory chunk', undefined, {
          path: filePath,
          chunkIndex: i,
          ...errDetails
        });
      }
    }

    if (inserted > 0) {
      logger.info('watcher', 'Synced Claude memory file', {
        path: filePath,
        projectId,
        chunks: inserted,
        sections: chunks.filter(c => c.level === 'section').length
      });
    }
    return inserted;
  } catch (e) {
    const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
    logger.error('watcher', 'Failed to read Claude memory file', undefined, { path: filePath, ...errDetails });
    return 0;
  }
}

// ============================================================================
// OpenClaw Memory Markdown Ingestion
// ============================================================================

// Track ingested files to avoid re-processing (path -> content hash)
const ingestedMemoryFiles = new Map<string, string>();

/**
 * Estimate token count for a given text.
 * Uses a simple heuristic: ~4 characters per token on average.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split markdown content into hierarchical chunks that preserve section structure.
 * Each chunk includes its section header for context.
 */
function chunkMarkdownHierarchically(
  content: string,
  maxTokens: number = 512,
): { text: string; tokenCount: number; header: string; level: 'section' | 'paragraph' }[] {
  const results: { text: string; tokenCount: number; header: string; level: 'section' | 'paragraph' }[] = [];
  const lines = content.split('\n');

  let currentHeader = '';
  let currentContent: string[] = [];

  // Regex for markdown headers (h1-h3)
  const headerPattern = /^(#{1,3})\s+(.+)$/;

  const flushSection = () => {
    if (currentContent.length === 0) return;

    const sectionText = currentContent.join('\n').trim();
    if (!sectionText) return;

    const sectionTokens = estimateTokens(sectionText);

    if (sectionTokens <= maxTokens) {
      // Section fits in one chunk - include header for context
      const textWithHeader = currentHeader
        ? `${currentHeader}\n\n${sectionText}`
        : sectionText;
      results.push({
        text: textWithHeader,
        tokenCount: estimateTokens(textWithHeader),
        header: currentHeader,
        level: 'section',
      });
    } else {
      // Split section into paragraph chunks with header context
      const paragraphs = sectionText.split(/\n\n+/);
      let chunkParas: string[] = [];
      let chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;

      for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);

        // If single paragraph exceeds max, it needs to stand alone
        if (paraTokens > maxTokens) {
          // Flush current chunk first
          if (chunkParas.length > 0) {
            const text = currentHeader
              ? `${currentHeader}\n\n${chunkParas.join('\n\n')}`
              : chunkParas.join('\n\n');
            results.push({
              text,
              tokenCount: chunkTokens,
              header: currentHeader,
              level: 'paragraph',
            });
            chunkParas = [];
            chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
          }

          // Add large paragraph as its own chunk (with header context)
          const text = currentHeader
            ? `${currentHeader}\n\n${para}`
            : para;
          results.push({
            text,
            tokenCount: estimateTokens(text),
            header: currentHeader,
            level: 'paragraph',
          });
          continue;
        }

        if (chunkTokens + paraTokens + 2 > maxTokens && chunkParas.length > 0) {
          // Flush current chunk
          const text = currentHeader
            ? `${currentHeader}\n\n${chunkParas.join('\n\n')}`
            : chunkParas.join('\n\n');
          results.push({
            text,
            tokenCount: chunkTokens,
            header: currentHeader,
            level: 'paragraph',
          });
          chunkParas = [];
          chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
        }

        chunkParas.push(para);
        chunkTokens += paraTokens + 2; // +2 for paragraph break
      }

      // Final chunk for this section
      if (chunkParas.length > 0) {
        const text = currentHeader
          ? `${currentHeader}\n\n${chunkParas.join('\n\n')}`
          : chunkParas.join('\n\n');
        results.push({
          text,
          tokenCount: chunkTokens,
          header: currentHeader,
          level: 'paragraph',
        });
      }
    }

    currentContent = [];
  };

  for (const line of lines) {
    const match = line.match(headerPattern);
    if (match) {
      flushSection();
      currentHeader = line; // Keep full header with # marks
    } else {
      currentContent.push(line);
    }
  }

  flushSection(); // Final section

  // Handle content with no headers at all
  if (results.length === 0 && content.trim()) {
    const text = content.trim();
    results.push({
      text,
      tokenCount: estimateTokens(text),
      header: '',
      level: 'section',
    });
  }

  return results;
}

/**
 * Ingest a single OpenClaw memory markdown file into the database.
 * Uses hierarchical chunking to preserve section structure.
 *
 * @param filePath - Path to the memory markdown file
 * @returns Number of chunks inserted
 */
async function ingestMemoryMarkdown(filePath: string): Promise<number> {
  // Skip MEMORY.md (index file, not content)
  if (filePath.endsWith('MEMORY.md')) return 0;

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    logger.error('watcher', 'Failed to read memory file', undefined, { path: filePath, error: String(e) });
    return 0;
  }

  if (!content.trim()) return 0;

  // Compute hash for deduplication
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  if (ingestedMemoryFiles.get(filePath) === hash) {
    logger.debug('watcher', 'Memory file unchanged, skipping', { path: filePath });
    return 0;
  }
  ingestedMemoryFiles.set(filePath, hash);

  // Extract metadata from filename
  const filename = basename(filePath, '.md');
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : null;

  // Use hierarchical chunking
  const chunks = chunkMarkdownHierarchically(content, 512);
  let inserted = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const response = await fetch(`http://${HOST}:${PORT}/api/memory/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: chunk.text,
          who: 'openclaw-memory',
          importance: chunk.level === 'section' ? 0.65 : 0.55, // Slightly higher for sections
          tags: [
            'openclaw',
            'memory-log',
            date || 'named',
            filename,
            chunk.level === 'section' ? 'hierarchical-section' : 'hierarchical-paragraph'
          ].filter(Boolean).join(','),
        }),
      });

      if (response.ok) {
        inserted++;
      } else {
        logger.warn('watcher', 'Failed to ingest memory chunk', {
          path: filePath,
          chunkIndex: i,
          status: response.status,
        });
      }
    } catch (e) {
      const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
      logger.error('watcher', 'Failed to ingest memory chunk', undefined, {
        path: filePath,
        chunkIndex: i,
        ...errDetails
      });
    }
  }

  if (inserted > 0) {
    logger.info('watcher', 'Ingested memory file', {
      path: filePath,
      chunks: inserted,
      sections: chunks.filter(c => c.level === 'section').length,
      filename,
    });
  }
  return inserted;
}

/**
 * Import all existing memory markdown files on daemon startup.
 * Scans ~/.agents/memory/ for .md files and ingests them.
 *
 * @returns Total number of chunks inserted
 */
async function importExistingMemoryFiles(): Promise<number> {
  const memoryDir = join(AGENTS_DIR, 'memory');
  if (!existsSync(memoryDir)) {
    logger.debug('daemon', 'Memory directory does not exist, skipping initial import');
    return 0;
  }

  let files: string[];
  try {
    files = readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch (e) {
    const errDetails = e instanceof Error ? { message: e.message } : { error: String(e) };
    logger.error('daemon', 'Failed to read memory directory', undefined, errDetails);
    return 0;
  }

  let totalChunks = 0;
  for (const file of files) {
    const count = await ingestMemoryMarkdown(join(memoryDir, file));
    totalChunks += count;
  }

  if (totalChunks > 0) {
    logger.info('daemon', 'Imported existing memory files', {
      files: files.length,
      chunks: totalChunks,
    });
  }
  return totalChunks;
}

// ============================================================================
// Shutdown Handling
// ============================================================================

function cleanup() {
  logger.info('daemon', 'Shutting down');
  
  // Stop git sync timer
  stopGitSyncTimer();
  
  if (watcher) {
    watcher.close();
  }
  
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      // Ignore
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('daemon', 'Uncaught exception', err);
  cleanup();
  process.exit(1);
});

// ============================================================================
// Main
// ============================================================================

// Initialize memory database schema
function initMemorySchema() {
  const memoryDir = dirname(MEMORY_DB);
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
  
  const db = new Database(MEMORY_DB);
  
  // Create memories table with all expected columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      who TEXT DEFAULT 'user',
      why TEXT,
      project TEXT,
      importance REAL DEFAULT 0.5,
      type TEXT DEFAULT 'explicit',
      tags TEXT,
      pinned INTEGER DEFAULT 0,
      source_type TEXT DEFAULT 'manual',
      source_id TEXT,
      category TEXT,
      updated_by TEXT DEFAULT 'user',
      vector_clock TEXT DEFAULT '{}',
      version INTEGER DEFAULT 1,
      manual_override INTEGER DEFAULT 0,
      confidence REAL DEFAULT 1.0,
      access_count INTEGER DEFAULT 0,
      last_accessed TEXT
    )
  `);
  
  // Create other required tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT,
      topics TEXT,
      decisions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL DEFAULT 'daemon',
      vector_clock TEXT NOT NULL DEFAULT '{}',
      version INTEGER DEFAULT 1,
      manual_override INTEGER DEFAULT 0
    )
  `);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  
  // Add missing columns to existing memories table (for upgrades)
  const columns = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  const columnNames = new Set(columns.map(c => c.name));
  
  const requiredColumns: [string, string][] = [
    ['who', 'TEXT DEFAULT "user"'],
    ['why', 'TEXT'],
    ['project', 'TEXT'],
    ['importance', 'REAL DEFAULT 0.5'],
    ['type', 'TEXT DEFAULT "explicit"'],
    ['tags', 'TEXT'],
    ['pinned', 'INTEGER DEFAULT 0'],
    ['source_type', 'TEXT DEFAULT "manual"'],
    ['source_id', 'TEXT'],
    ['category', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['updated_by', 'TEXT DEFAULT "user"'],
    ['vector_clock', 'TEXT DEFAULT "{}"'],
    ['version', 'INTEGER DEFAULT 1'],
    ['manual_override', 'INTEGER DEFAULT 0'],
    ['confidence', 'REAL DEFAULT 1.0'],
    ['access_count', 'INTEGER DEFAULT 0'],
    ['last_accessed', 'TEXT'],
  ];
  
  for (const [col, def] of requiredColumns) {
    if (!columnNames.has(col)) {
      try {
        db.exec(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
      } catch {
        // Column might already exist
      }
    }
  }
  
  db.close();
  logger.info('daemon', 'Memory schema initialized');
}

async function main() {
  logger.info('daemon', 'Signet Daemon starting');
  logger.info('daemon', 'Agents directory', { path: AGENTS_DIR });
  logger.info('daemon', 'Port configured', { port: PORT });
  
  // Ensure daemon directory exists
  mkdirSync(DAEMON_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  
  // Initialize memory database schema
  initMemorySchema();

  // Write PID file
  writeFileSync(PID_FILE, process.pid.toString());
  logger.info('daemon', 'Process ID', { pid: process.pid });

  // Start file watcher
  startFileWatcher();
  logger.info('watcher', 'File watcher started');

  // Start git sync timer (if enabled and has token)
  startGitSyncTimer();

  // Start HTTP server
  serve({
    fetch: app.fetch,
    port: PORT,
    hostname: HOST,
  }, (info) => {
    logger.info('daemon', 'Server listening', { address: info.address, port: info.port });
    logger.info('daemon', 'Daemon ready');

    // Import existing memory markdown files (OpenClaw memory logs)
    // Do this after server starts so the HTTP API is available for ingestion
    importExistingMemoryFiles().catch(e => {
      const errDetails = e instanceof Error ? { message: e.message, stack: e.stack } : { error: String(e) };
      logger.error('daemon', 'Failed to import existing memory files', undefined, errDetails);
    });
  });
}

main().catch((err) => {
  logger.error('daemon', 'Fatal error', err);
  process.exit(1);
});
