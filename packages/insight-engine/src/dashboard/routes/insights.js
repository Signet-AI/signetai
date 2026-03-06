'use strict';
/**
 * src/dashboard/routes/insights.js
 *
 * Express router for /api/insights/*
 * Full CRUD + synthesis trigger + stats.
 */

const router  = require('express').Router();
const { getDb } = require('../../../shared/db');

// ─── GET / — list insights (paginated) ────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db     = getDb();
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const entity = req.query.entity || null;

    let whereClause = 'WHERE i.is_deleted = 0';
    const params = [];

    if (entity) {
      whereClause += ' AND (i.cluster_label LIKE ? OR i.themes LIKE ?)';
      params.push(`%${entity}%`, `%${entity}%`);
    }

    const total = db.prepare(
      `SELECT COUNT(*) as c FROM insights i ${whereClause}`
    ).get(...params).c;

    const rows = db.prepare(`
      SELECT i.id, i.cluster_label, i.insight, i.themes, i.connections,
             i.importance, i.created_at, i.applied_to_synthesis,
             i.source_memory_ids, i.source_entity_ids,
             (SELECT COUNT(*) FROM insight_sources s WHERE s.insight_id = i.id) as source_count
      FROM insights i
      ${whereClause}
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const insights = rows.map(r => ({
      ...r,
      themes:           tryParse(r.themes,           []),
      connections:      tryParse(r.connections,      []),
      source_memory_ids: tryParse(r.source_memory_ids, []),
      source_entity_ids: tryParse(r.source_entity_ids, []),
    }));

    res.json({ insights, total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /stats ────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    const total = db.prepare(
      `SELECT COUNT(*) as c FROM insights WHERE is_deleted = 0`
    ).get().c;

    const lastRun = db.prepare(
      `SELECT created_at FROM insights WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 1`
    ).get();

    const memoriesProcessed = db.prepare(
      `SELECT COUNT(*) as c FROM memories WHERE insight_processed_at IS NOT NULL AND is_deleted = 0`
    ).get().c;

    const topClusters = db.prepare(
      `SELECT cluster_label, COUNT(*) as cnt
       FROM insights WHERE is_deleted = 0 AND cluster_label IS NOT NULL
       GROUP BY cluster_label ORDER BY cnt DESC LIMIT 5`
    ).all();

    res.json({
      total,
      last_run: lastRun ? lastRun.created_at : null,
      memories_processed: memoriesProcessed,
      top_clusters: topClusters,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /entity/:entityId ────────────────────────────────────────────────────
router.get('/entity/:entityId', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare(`
      SELECT i.id, i.cluster_label, i.insight, i.themes, i.connections,
             i.importance, i.created_at,
             (SELECT COUNT(*) FROM insight_sources s WHERE s.insight_id = i.id) as source_count
      FROM insights i
      WHERE i.cluster_entity_id = ? AND i.is_deleted = 0
      ORDER BY i.created_at DESC
    `).all(req.params.entityId);

    const insights = rows.map(r => ({
      ...r,
      themes:      tryParse(r.themes,      []),
      connections: tryParse(r.connections, []),
    }));

    res.json({ insights, total: insights.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /memory/:memoryId ────────────────────────────────────────────────────
router.get('/memory/:memoryId', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.prepare(`
      SELECT i.id, i.cluster_label, i.insight, i.themes, i.importance, i.created_at
      FROM insights i
      JOIN insight_sources s ON s.insight_id = i.id
      WHERE s.memory_id = ? AND i.is_deleted = 0
      ORDER BY i.created_at DESC
    `).all(req.params.memoryId);

    const insights = rows.map(r => ({
      ...r,
      themes: tryParse(r.themes, []),
    }));

    res.json({ insights, total: insights.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db  = getDb();
    const row = db.prepare(
      `SELECT * FROM insights WHERE id = ? AND is_deleted = 0`
    ).get(req.params.id);

    if (!row) return res.status(404).json({ error: 'Not found' });

    // Fetch source memories
    const sources = db.prepare(`
      SELECT m.id, m.content, m.type, m.category, m.importance, m.created_at, m.tags
      FROM insight_sources s
      JOIN memories m ON m.id = s.memory_id
      WHERE s.insight_id = ? AND m.is_deleted = 0
      ORDER BY m.importance DESC
      LIMIT 20
    `).all(req.params.id);

    const insight = {
      ...row,
      themes:           tryParse(row.themes,           []),
      connections:      tryParse(row.connections,      []),
      source_memory_ids: tryParse(row.source_memory_ids, []),
      source_entity_ids: tryParse(row.source_entity_ids, []),
      source_memories:  sources.map(m => ({ ...m, tags: tryParse(m.tags, []) })),
    };

    res.json(insight);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /run — trigger manual synthesis ─────────────────────────────────────
router.post('/run', (req, res) => {
  res.json({ started: true, message: 'Synthesis running in background' });

  // Fire-and-forget
  setImmediate(async () => {
    try {
      const { config } = require('../../../shared/config');
      const runner = require('../../insight-synthesizer/runner');
      if (typeof runner.runInsightSynthesis === 'function') {
        await runner.runInsightSynthesis(config);
      }
    } catch (err) {
      console.error('[insights/run] synthesis error:', err.message);
    }
  });
});

// ─── POST /:id/pin — toggle applied_to_synthesis ──────────────────────────────
router.post('/:id/pin', (req, res) => {
  try {
    const db  = getDb();
    const row = db.prepare(`SELECT id, applied_to_synthesis FROM insights WHERE id = ? AND is_deleted = 0`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const next = row.applied_to_synthesis ? 0 : 1;
    db.prepare(`UPDATE insights SET applied_to_synthesis = ? WHERE id = ?`).run(next, req.params.id);

    res.json({ id: req.params.id, applied_to_synthesis: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /:id — soft delete ────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const info = db.prepare(`UPDATE insights SET is_deleted = 1 WHERE id = ? AND is_deleted = 0`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function tryParse(val, fallback) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return fallback;
}

module.exports = router;
