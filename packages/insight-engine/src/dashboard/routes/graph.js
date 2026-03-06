'use strict';
/**
 * src/dashboard/routes/graph.js
 *
 * Express router for /api/graph/*
 * Serves entity + relation data for D3 force-directed graph.
 */

const router   = require('express').Router();
const { getDb } = require('../../../shared/db');

// ─── GET /overview ────────────────────────────────────────────────────────────
router.get('/overview', (req, res) => {
  try {
    const db = getDb();

    const entityCount   = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE 1=1`).get().c;
    const relationCount = db.prepare(`SELECT COUNT(*) as c FROM relations`).get().c;
    const memoryCount   = db.prepare(`SELECT COUNT(*) as c FROM memories WHERE 1=1`).get().c;

    const topTypes = db.prepare(`
      SELECT entity_type, COUNT(*) as cnt
      FROM entities WHERE 1=1
      GROUP BY entity_type ORDER BY cnt DESC LIMIT 10
    `).all();

    const topEntities = db.prepare(`
      SELECT name, entity_type, mentions
      FROM entities WHERE 1=1
      ORDER BY mentions DESC LIMIT 5
    `).all();

    res.json({
      entity_count:   entityCount,
      relation_count: relationCount,
      memory_count:   memoryCount,
      top_types:      topTypes,
      top_entities:   topEntities,
    });
  } catch (err) {
    // If tables don't exist yet, return empty stats
    res.json({
      entity_count: 0, relation_count: 0, memory_count: 0,
      top_types: [], top_entities: [],
    });
  }
});

// ─── GET /entities ────────────────────────────────────────────────────────────
router.get('/entities', (req, res) => {
  try {
    const db          = getDb();
    const limit       = Math.min(parseInt(req.query.limit) || 200, 500);
    const typeFilter  = req.query.type    || null;
    const minMentions = parseInt(req.query.minMentions) || 1;

    let where = 'WHERE e.mentions >= ?';
    const params = [minMentions];

    if (typeFilter) {
      where += ' AND e.entity_type = ?';
      params.push(typeFilter);
    }

    const total = db.prepare(`SELECT COUNT(*) as c FROM entities e ${where}`).get(...params).c;

    const entities = db.prepare(`
      SELECT e.id, e.name, e.entity_type, e.mentions as mentions,
             (SELECT COUNT(*) FROM relations r
              WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id) as relation_count
      FROM entities e
      ${where}
      ORDER BY e.mentions DESC
      LIMIT ?
    `).all(...params, limit);

    res.json({ entities, total });
  } catch (err) {
    res.json({ entities: [], total: 0, error: err.message });
  }
});

// ─── GET /entities/:id ────────────────────────────────────────────────────────
router.get('/entities/:id', (req, res) => {
  try {
    const db     = getDb();
    const entity = db.prepare(
      `SELECT * FROM entities WHERE id = ? `
    ).get(req.params.id);

    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    const relations = db.prepare(`
      SELECT r.id, r.source_entity_id, r.target_entity_id, r.relation_type,
             r.strength, r.confidence, r.mentions,
             se.name as source_name, te.name as target_name
      FROM relations r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      ORDER BY r.mentions DESC
      LIMIT 50
    `).all(req.params.id, req.params.id);

    const memories = db.prepare(`
      SELECT m.id, m.content, m.importance, m.created_at
      FROM memories m
      JOIN memory_entities me ON me.memory_id = m.id
      WHERE me.entity_id = ? AND m.is_deleted = 0
      ORDER BY m.importance DESC
      LIMIT 10
    `).all(req.params.id);

    res.json({ entity, relations, memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /relations ───────────────────────────────────────────────────────────
router.get('/relations', (req, res) => {
  try {
    const db       = getDb();
    const limit    = Math.min(parseInt(req.query.limit) || 500, 1000);
    const entityId = req.query.entityId || null;

    let where  = 'WHERE r.strength > 0.3';
    const params = [];

    if (entityId) {
      where += ' AND (r.source_entity_id = ? OR r.target_entity_id = ?)';
      params.push(entityId, entityId);
    }

    const relations = db.prepare(`
      SELECT r.id, r.source_entity_id, r.target_entity_id, r.relation_type,
             r.strength, r.confidence, r.mentions,
             se.name as source_name, te.name as target_name
      FROM relations r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      ${where}
      ORDER BY r.mentions DESC
      LIMIT ?
    `).all(...params, limit);

    res.json({ relations, total: relations.length });
  } catch (err) {
    res.json({ relations: [], total: 0, error: err.message });
  }
});

module.exports = router;
