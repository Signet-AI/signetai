'use strict';
/**
 * storage.js — InsightSynthesizer: DB Write Operations
 *
 * Responsibility: Persist a synthesized insight into the SQLite DB.
 * This is the ONLY place we write to the database from the insight pipeline.
 *
 * Tables written:
 *   - insights         → one row per generated insight
 *   - insight_sources  → one junction row per (insight, memory) pair
 *   - memories         → UPDATE insight_processed_at only (NO content changes)
 *
 * All three writes are wrapped in a single SQLite transaction so they either
 * all succeed or all roll back together. This prevents orphaned partial records.
 *
 * SAFETY CONTRACT:
 *   - NEVER modifies `memories.content`, `memories.embedding`, or any other
 *     existing column on the memories row.
 *   - NEVER modifies the `entities`, `relations`, or `memory_entity_mentions` tables.
 *   - Only touches the `insight_processed_at` column added by migration 002.
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');

/**
 * storeInsight — main export
 *
 * Persists an insight + its source links + memory processed-at timestamps,
 * all within a single SQLite transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   entityId: string,
 *   entityName: string,
 *   memories: Array<{id: string, content: string}>
 * }} cluster - The cluster that was synthesized
 * @param {{
 *   insight: string,
 *   connections: Array<{from_id: string, to_id: string, relationship: string}>,
 *   themes: Array<string>,
 *   importance: number
 * }} insightData - Validated output from synthesizer.js
 * @returns {{ id: string, insight: string, clusterLabel: string }}
 * @throws {Error} if any DB operation fails (caller is expected to catch)
 */
function storeInsight(db, cluster, insightData) {
  const id  = uuidv4();
  const now = new Date().toISOString();

  // ─── Prepared statements ────────────────────────────────────────────────────
  const insertInsight = db.prepare(`
    INSERT INTO insights (
      id,
      cluster_entity_id,
      cluster_label,
      source_memory_ids,
      source_entity_ids,
      insight,
      connections,
      themes,
      importance,
      model_used,
      synthesis_version,
      created_at,
      applied_to_synthesis,
      is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0)
  `);

  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO insight_sources (insight_id, memory_id) VALUES (?, ?)
  `);

  const markProcessed = db.prepare(`
    UPDATE memories SET insight_processed_at = ? WHERE id = ?
  `);

  // ─── Execute inside a transaction ──────────────────────────────────────────
  // better-sqlite3's transaction() creates a function that runs all operations
  // atomically. If any step throws, the whole transaction rolls back.
  const doStore = db.transaction(() => {
    // 1. Insert the insight row
    insertInsight.run(
      id,
      cluster.entityId,
      cluster.entityName,
      JSON.stringify(cluster.memories.map(m => m.id)),   // source_memory_ids
      JSON.stringify([cluster.entityId]),                  // source_entity_ids
      insightData.insight,
      JSON.stringify(insightData.connections || []),
      JSON.stringify(insightData.themes      || []),
      typeof insightData.importance === 'number' ? insightData.importance : 0.7,
      'claude-haiku',
      now
    );

    // 2. Insert junction rows (insight_sources)
    for (const memory of cluster.memories) {
      insertSource.run(id, memory.id);
    }

    // 3. Mark each source memory as processed
    //    We ONLY update the insight_processed_at column — nothing else.
    for (const memory of cluster.memories) {
      markProcessed.run(now, memory.id);
    }
  });

  doStore(); // runs atomically

  logger.info('storage', `Stored insight ${id.slice(0, 8)}… for "${cluster.entityName}"`, {
    memoriesTagged: cluster.memories.length,
    importance:     insightData.importance,
  });

  return {
    id,
    insight:      insightData.insight,
    clusterLabel: cluster.entityName,
  };
}

module.exports = { storeInsight };
