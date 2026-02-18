// @ts-nocheck
import type { PageServerLoad } from './$types';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const AGENTS_DIR = join(homedir(), '.agents');
const MEMORY_DB = join(AGENTS_DIR, 'memory', 'memories.db');

interface Identity {
  name: string;
  creature: string;
  vibe: string;
}

interface ConfigFile {
  name: string;
  content: string;
  size: number;
}

interface Memory {
  id: string;
  content: string;
  created_at: string;
  who: string;
  importance: number;
  tags: string;
  source_type: string;
}

interface MemoryStats {
  total: number;
  withEmbeddings: number;
  critical: number;
}

interface Harness {
  name: string;
  path: string;
  exists: boolean;
}

function parseIdentity(content: string): Identity {
  const lines = content.split('\n');
  const identity: Identity = { name: '', creature: '', vibe: '' };
  for (const line of lines) {
    if (line.startsWith('- name:'))
      identity.name = line.replace('- name:', '').trim();
    if (line.startsWith('- creature:'))
      identity.creature = line.replace('- creature:', '').trim();
    if (line.startsWith('- vibe:'))
      identity.vibe = line.replace('- vibe:', '').trim();
  }
  return identity;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadIdentity(): Promise<Identity> {
  try {
    const content = await readFile(
      join(AGENTS_DIR, 'IDENTITY.md'), 'utf-8'
    );
    return parseIdentity(content);
  } catch {
    return { name: 'Unknown', creature: '', vibe: '' };
  }
}

async function loadConfigFiles(): Promise<ConfigFile[]> {
  const files: ConfigFile[] = [];
  try {
    const dirFiles = await readdir(AGENTS_DIR);
    const configFiles = dirFiles.filter(
      f => f.endsWith('.md') || f.endsWith('.yaml')
    );
    for (const fileName of configFiles) {
      const filePath = join(AGENTS_DIR, fileName);
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        const content = await readFile(filePath, 'utf-8');
        files.push({ name: fileName, content, size: fileStat.size });
      }
    }
  } catch (e) {
    console.error('Error reading config files:', e);
  }

  const priority = [
    'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'config.yaml'
  ];
  files.sort((a, b) => {
    const aIdx = priority.indexOf(a.name);
    const bIdx = priority.indexOf(b.name);
    if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  return files;
}

async function loadMemories(): Promise<{
  memories: Memory[];
  stats: MemoryStats;
}> {
  let memories: Memory[] = [];
  const stats: MemoryStats = { total: 0, withEmbeddings: 0, critical: 0 };

  try {
    const db = new Database(MEMORY_DB, { readonly: true });

    const totalResult = db.prepare(
      'SELECT COUNT(*) as count FROM memories'
    ).get() as { count: number };
    stats.total = totalResult?.count ?? 0;

    try {
      const embResult = db.prepare(
        'SELECT COUNT(*) as count FROM embeddings'
      ).get() as { count: number };
      stats.withEmbeddings = embResult?.count ?? 0;
    } catch {
      // embeddings table might not exist
    }

    const critResult = db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE importance >= 0.9"
    ).get() as { count: number };
    stats.critical = critResult?.count ?? 0;

    memories = db.prepare(`
      SELECT id, content, created_at, who, importance, tags, source_type
      FROM memories ORDER BY created_at DESC LIMIT 100
    `).all() as Memory[];

    db.close();
  } catch (e) {
    console.error('Error reading memory database:', e);
  }

  return { memories, stats };
}

async function loadHarnesses(): Promise<Harness[]> {
  const configs = [
    { name: 'Claude Code', path: join(homedir(), '.claude', 'CLAUDE.md') },
    {
      name: 'OpenCode',
      path: join(homedir(), '.config', 'opencode', 'AGENTS.md'),
    },
    {
      name: 'OpenClaw (Source)',
      path: join(AGENTS_DIR, 'AGENTS.md'),
    },
  ];

  const harnesses: Harness[] = [];
  for (const config of configs) {
    let exists = false;
    try {
      await stat(config.path);
      exists = true;
    } catch {
      // not found
    }
    harnesses.push({
      name: config.name,
      path: config.path,
      exists,
    });
  }
  return harnesses;
}

export const load = async () => {
  const [identity, configFiles, memoryData, harnesses] = await Promise.all([
    loadIdentity(),
    loadConfigFiles(),
    loadMemories(),
    loadHarnesses(),
  ]);

  return {
    identity,
    configFiles,
    memories: memoryData.memories,
    memoryStats: memoryData.stats,
    harnesses,
  };
};
;null as any as PageServerLoad;