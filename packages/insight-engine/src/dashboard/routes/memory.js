'use strict';
/**
 * src/dashboard/routes/memory.js
 *
 * Express router for /api/memory/*
 * Phase 2: Source Citations wrapper — hybrid search with citation IDs.
 */

const router   = require('express').Router();
const { getDb } = require('../../../shared/db');

// ─── GET /search ──────────────────────────────────────────────────────────────
router.get('/search', (req, res) => {
  try {
    const q     = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    if (!q) return res.json({ results: [], citations: [], query: q, count: 0 });

    const db = getDb();
    let results;

    // Try FTS5 first, fall back to LIKE
    try {
      results = db.prepare(`
        SELECT m.id, m.content, m.type, m.category, m.importance,
               m.created_at, m.tags, m.insight_processed_at
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.is_deleted = 0
        ORDER BY rank, m.importance DESC
        LIMIT ?
      `).all(q, limit);
    } catch {
      results = db.prepare(`
        SELECT id, content, type, category, importance,
               created_at, tags, insight_processed_at
        FROM memories
        WHERE content LIKE ? AND is_deleted = 0
        ORDER BY importance DESC
        LIMIT ?
      `).all(`%${q}%`, limit);
    }

    // Add citation IDs — first 4 chars of UUID (unique enough for display)
    const withCitations = results.map(r => ({
      ...r,
      citation: `M:${r.id.replace(/-/g, '').substring(0, 4).toUpperCase()}`,
      tags:     tryParseJson(r.tags, []),
    }));

    res.json({
      results:   withCitations,
      citations: withCitations.map(r => r.citation),
      query:     q,
      count:     withCitations.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:id — single memory + its insights ──────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db  = getDb();
    const mem = db.prepare(
      `SELECT id, content, type, category, importance, created_at, tags,
              insight_processed_at
       FROM memories WHERE id = ? AND is_deleted = 0`
    ).get(req.params.id);

    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    const insights = db.prepare(`
      SELECT i.id, i.cluster_label, i.insight, i.themes, i.importance, i.created_at
      FROM insights i
      JOIN insight_sources s ON s.insight_id = i.id
      WHERE s.memory_id = ? AND i.is_deleted = 0
      ORDER BY i.created_at DESC
    `).all(req.params.id);

    const memory = {
      ...mem,
      citation:  `M:${mem.id.replace(/-/g, '').substring(0, 4).toUpperCase()}`,
      tags:      tryParseJson(mem.tags, []),
      insights:  insights.map(i => ({ ...i, themes: tryParseJson(i.themes, []) })),
    };

    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function tryParseJson(val, fallback) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return fallback;
}

module.exports = router;
