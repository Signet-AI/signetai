import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const MEMORY_DB = join(homedir(), '.agents', 'memory', 'memories.db');

interface FilterParams {
  type: string;
  tags: string;
  who: string;
  pinned: boolean;
  importance_min: number | null;
  since: string;
}

function buildWhere(p: FilterParams): { clause: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];

  if (p.type) {
    parts.push('m.type = ?');
    args.push(p.type);
  }
  if (p.tags) {
    // comma-separated tags — match any
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

// Same helper but for pure-filter path (no join alias)
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

export const GET: RequestHandler = async ({ url }) => {
  const query = url.searchParams.get('q') ?? '';
  const distinct = url.searchParams.get('distinct');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : null;

  // Shortcut: return distinct values for a column
  if (distinct === 'who') {
    try {
      const db = new Database(MEMORY_DB, { readonly: true });
      const rows = db
        .prepare("SELECT DISTINCT who FROM memories WHERE who IS NOT NULL ORDER BY who")
        .all() as { who: string }[];
      db.close();
      return json({ values: rows.map(r => r.who) });
    } catch (e) {
      return json({ values: [] });
    }
  }

  const filterParams: FilterParams = {
    type: url.searchParams.get('type') ?? '',
    tags: url.searchParams.get('tags') ?? '',
    who: url.searchParams.get('who') ?? '',
    pinned: url.searchParams.get('pinned') === '1' || url.searchParams.get('pinned') === 'true',
    importance_min: url.searchParams.has('importance_min')
      ? parseFloat(url.searchParams.get('importance_min')!)
      : null,
    since: url.searchParams.get('since') ?? '',
  };

  const hasFilters = Object.values(filterParams).some(v =>
    v !== '' && v !== false && v !== null
  );

  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    let results: any[] = [];

    if (query.trim()) {
      // FTS path — query + optional filters
      const { clause, args } = buildWhere(filterParams);
      try {
        results = db.prepare(`
          SELECT m.id, m.content, m.created_at, m.who, m.importance, m.tags,
                 m.type, m.pinned, bm25(memories_fts) as score
          FROM memories_fts
          JOIN memories m ON memories_fts.rowid = m.rowid
          WHERE memories_fts MATCH ?${clause}
          ORDER BY score
          LIMIT ${limit ?? 20}
        `).all(query, ...args) as any[];
      } catch {
        // FTS not available — fall back to LIKE + raw filters
        const { clause: rc, args: rargs } = buildWhereRaw(filterParams);
        results = db.prepare(`
          SELECT id, content, created_at, who, importance, tags, type, pinned
          FROM memories
          WHERE (content LIKE ? OR tags LIKE ?)${rc}
          ORDER BY created_at DESC
          LIMIT ${limit ?? 20}
        `).all(`%${query}%`, `%${query}%`, ...rargs) as any[];
      }
    } else if (hasFilters) {
      // Pure filter path — no query text
      const { clause, args } = buildWhereRaw(filterParams);
      results = db.prepare(`
        SELECT id, content, created_at, who, importance, tags, type, pinned,
               CASE WHEN pinned = 1 THEN 1.0
                    ELSE importance * MAX(0.1, POWER(0.95,
                      CAST(JulianDay('now') - JulianDay(created_at) AS INTEGER)))
               END AS score
        FROM memories
        WHERE 1=1${clause}
        ORDER BY score DESC
        LIMIT ${limit ?? 50}
      `).all(...args) as any[];
    } else {
      // No query and no filters — return empty (caller uses initial load instead)
      db.close();
      return json({ results: [] });
    }

    db.close();
    return json({ results });
  } catch (e) {
    console.error('Error searching memories:', e);
    return json({ results: [], error: 'Search failed' });
  }
};
