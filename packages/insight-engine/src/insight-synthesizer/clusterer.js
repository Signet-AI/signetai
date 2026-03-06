'use strict';
/**
 * clusterer.js — InsightSynthesizer: Memory Cluster Builder
 *
 * Responsibility: Given the live Signet SQLite DB and config, identify the most
 * "insight-worthy" groups of memories to synthesize.
 *
 * Strategy:
 *   1. Pull the top N entities by mention count (minimum threshold: 5 mentions).
 *   2. For each entity, fetch associated memories that haven't been synthesized
 *      recently (or ever).
 *   3. Filter out clusters too small to be interesting (< minMemoriesPerCluster).
 *   4. Score each cluster by `entity.mentions * unprocessed_count` — entities with
 *      many references AND many unprocessed memories float to the top.
 *   5. Return the top maxClustersPerRun clusters sorted by priority DESC.
 */

const logger = require('../../shared/logger');

/**
 * buildClusters — main export
 *
 * @param {import('better-sqlite3').Database} db - Open SQLite DB connection
 * @param {object} config - Full app config (see shared/config.js)
 * @returns {Array<{
 *   entityId: string,
 *   entityName: string,
 *   entityType: string,
 *   memories: Array<{id, content, type, importance, created_at, tags}>,
 *   priority: number
 * }>}  Clusters sorted by priority DESC, capped at maxClustersPerRun
 */
function buildClusters(db, config) {
  const {
    minMemoriesPerCluster = 3,
    maxMemoriesPerBatch   = 10,
    maxClustersPerRun     = 5,
    topEntityCount        = 30,
    reprocessAfterDays    = 7,
  } = config.insights || {};

  logger.info('clusterer', 'Building clusters', {
    topEntityCount,
    minMemoriesPerCluster,
    maxMemoriesPerBatch,
    maxClustersPerRun,
    reprocessAfterDays,
  });

  // ─── Step 1: Fetch top entities by mention count ───────────────────────────
  // We only care about entities that are referenced frequently enough to be
  // meaningful for cross-cutting insight generation.
  let topEntities;
  try {
    topEntities = db.prepare(`
      SELECT e.id, e.name, e.entity_type, e.mentions
      FROM entities e
      WHERE e.mentions >= 5
      ORDER BY e.mentions DESC
      LIMIT ?
    `).all(topEntityCount);
  } catch (err) {
    logger.error('clusterer', 'Failed to query top entities', { error: err.message });
    return [];
  }

  if (!topEntities || topEntities.length === 0) {
    logger.info('clusterer', 'No entities with ≥5 mentions found — nothing to cluster');
    return [];
  }

  logger.debug('clusterer', `Found ${topEntities.length} candidate entities`);

  // ─── Step 2: For each entity, fetch its unprocessed (or stale) memories ───
  // We JOIN through memory_entity_mentions to find memories that mention this
  // entity. We skip memories that were synthesized within reprocessAfterDays.
  const fetchMemoriesStmt = db.prepare(`
    SELECT m.id, m.content, m.type, m.category, m.importance, m.created_at, m.tags
    FROM memories m
    JOIN memory_entity_mentions mem ON mem.memory_id = m.id
    WHERE mem.entity_id = ?
      AND m.is_deleted = 0
      AND (
        m.insight_processed_at IS NULL
        OR m.insight_processed_at < datetime('now', '-' || ? || ' days')
      )
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT ?
  `);

  const clusters = [];

  for (const entity of topEntities) {
    let memories;
    try {
      memories = fetchMemoriesStmt.all(entity.id, reprocessAfterDays, maxMemoriesPerBatch);
    } catch (err) {
      logger.warn('clusterer', `Failed to fetch memories for entity "${entity.name}"`, {
        entityId: entity.id,
        error: err.message,
      });
      continue;
    }

    // Skip if too few memories to generate a meaningful insight
    if (!memories || memories.length < minMemoriesPerCluster) {
      logger.debug('clusterer', `Skipping entity "${entity.name}" — only ${memories?.length ?? 0} unprocessed memories (need ≥${minMemoriesPerCluster})`);
      continue;
    }

    // ─── Step 3: Score cluster priority ────────────────────────────────────
    // Higher score = entity is referenced a lot AND has many unprocessed memories.
    // This surfaces the most "active" topics in the memory graph.
    const unprocessedCount = memories.length;
    const priority = entity.mentions * unprocessedCount;

    clusters.push({
      entityId:   entity.id,
      entityName: entity.name,
      entityType: entity.entity_type || 'unknown',
      memories:   memories.map(m => ({
        id:         m.id,
        content:    m.content,
        type:       m.type,
        importance: m.importance,
        created_at: m.created_at,
        tags:       m.tags,
      })),
      priority,
    });
  }

  // ─── Step 4: Sort by priority, take top N ──────────────────────────────────
  clusters.sort((a, b) => b.priority - a.priority);
  const selected = clusters.slice(0, maxClustersPerRun);

  logger.info('clusterer', `Built ${selected.length} clusters (${clusters.length} candidates)`, {
    clusters: selected.map(c => ({
      entity:       c.entityName,
      memoryCount:  c.memories.length,
      priority:     c.priority,
    })),
  });

  return selected;
}

module.exports = { buildClusters };
