// @ts-nocheck
import type { PageServerLoad } from './$types';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const MEMORY_DB = join(homedir(), '.agents', 'memory', 'memories.db');

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

export const load = async () => {
  let memories: Memory[] = [];
  let stats: MemoryStats = { total: 0, withEmbeddings: 0, critical: 0 };
  
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    
    // Get stats
    const totalResult = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    stats.total = totalResult?.count ?? 0;
    
    try {
      const embeddingsResult = db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
      stats.withEmbeddings = embeddingsResult?.count ?? 0;
    } catch {
      // embeddings table might not exist
    }
    
    const criticalResult = db.prepare("SELECT COUNT(*) as count FROM memories WHERE importance >= 0.9").get() as { count: number };
    stats.critical = criticalResult?.count ?? 0;
    
    // Get all memories
    const memoriesResult = db.prepare(`
      SELECT id, content, created_at, who, importance, tags, source_type
      FROM memories
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as Memory[];
    memories = memoriesResult ?? [];
    
    db.close();
  } catch (e) {
    console.error('Error reading memory database:', e);
  }
  
  return { memories, stats };
};
;null as any as PageServerLoad;