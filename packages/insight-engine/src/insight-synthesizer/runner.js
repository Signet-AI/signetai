'use strict';
/**
 * runner.js — InsightSynthesizer: Orchestration Runner
 *
 * Responsibility: Orchestrate one complete synthesis run:
 *   1. Open the DB
 *   2. Call buildClusters() to identify the best memory groups
 *   3. For each cluster:
 *        a. Call synthesizeCluster() to get an insight from Claude Haiku
 *        b. Call storeInsight() to persist it
 *        c. Log the result
 *   4. Return a summary: { clustersProcessed, insightsGenerated, errors }
 *
 * Error isolation: each cluster is wrapped in its own try/catch so a single
 * failure (network blip, parse error, DB contention) does NOT abort the whole
 * run. The error is counted and logged, and processing continues.
 *
 * This function is synchronous-friendly (spawnSync inside synthesizeCluster)
 * but returns a Promise to allow future async expansion and to match the
 * Express handler pattern in the dashboard.
 */

const { getDb }          = require('../../shared/db');
const { buildClusters }  = require('./clusterer');
const { synthesizeCluster } = require('./synthesizer');
const { storeInsight }   = require('./storage');
const logger             = require('../../shared/logger');

/**
 * runInsightSynthesis — main export
 *
 * Runs one complete insight synthesis pass. Called by:
 *   - The node-cron scheduler in index.js (periodic runs)
 *   - The Express route handler at POST /api/insights/run (manual trigger)
 *
 * @param {object} config - Full app config (see shared/config.js)
 * @returns {Promise<{
 *   clustersProcessed: number,
 *   insightsGenerated: number,
 *   errors: number,
 *   results: Array<{clusterLabel: string, insightId: string, preview: string} | {clusterLabel: string, error: string}>
 * }>}
 */
async function runInsightSynthesis(config) {
  const startTime = Date.now();
  logger.info('runner', '▶ Starting insight synthesis run');

  // ─── Open DB ───────────────────────────────────────────────────────────────
  let db;
  try {
    db = getDb(config.dbPath);
  } catch (err) {
    logger.error('runner', 'Cannot open DB — aborting run', { error: err.message });
    return { clustersProcessed: 0, insightsGenerated: 0, errors: 1, results: [] };
  }

  // ─── Build clusters ────────────────────────────────────────────────────────
  let clusters;
  try {
    clusters = buildClusters(db, config);
  } catch (err) {
    logger.error('runner', 'buildClusters threw unexpectedly — aborting run', {
      error: err.message,
      stack: err.stack,
    });
    return { clustersProcessed: 0, insightsGenerated: 0, errors: 1, results: [] };
  }

  if (!clusters || clusters.length === 0) {
    logger.info('runner', 'No clusters to process — run complete (nothing to do)');
    return { clustersProcessed: 0, insightsGenerated: 0, errors: 0, results: [] };
  }

  logger.info('runner', `Processing ${clusters.length} cluster(s)`);

  // ─── Process each cluster independently ────────────────────────────────────
  let insightsGenerated = 0;
  let errors            = 0;
  const results         = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    logger.info('runner', `[${i + 1}/${clusters.length}] Cluster: "${cluster.entityName}" (${cluster.memories.length} memories, priority=${cluster.priority})`);

    try {
      // Step A: Ask Claude Haiku to generate an insight via claude CLI (OAuth keychain auth)
      const insightData = synthesizeCluster(cluster, config);

      if (!insightData) {
        // synthesizeCluster already logged the reason; just count it
        logger.warn('runner', `No insight returned for "${cluster.entityName}" — skipping`);
        errors++;
        results.push({ clusterLabel: cluster.entityName, error: 'synthesizeCluster returned null' });
        continue;
      }

      // Step B: Persist the insight + mark memories processed
      const stored = storeInsight(db, cluster, insightData);

      // Step C: Log a preview for observability
      const preview = insightData.insight.slice(0, 80) + (insightData.insight.length > 80 ? '…' : '');
      logger.info('runner', `✓ Insight stored for "${cluster.entityName}"`, {
        insightId:  stored.id,
        importance: insightData.importance,
        themes:     insightData.themes,
        preview,
      });

      insightsGenerated++;
      results.push({
        clusterLabel: cluster.entityName,
        insightId:    stored.id,
        preview,
      });
    } catch (err) {
      // Catch errors from either synthesizeCluster or storeInsight so the rest
      // of the clusters can still be processed.
      logger.error('runner', `Error processing cluster "${cluster.entityName}"`, {
        error: err.message,
        stack: err.stack,
      });
      errors++;
      results.push({ clusterLabel: cluster.entityName, error: err.message });
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  const durationMs = Date.now() - startTime;
  logger.info('runner', `■ Synthesis run complete`, {
    clustersProcessed: clusters.length,
    insightsGenerated,
    errors,
    durationMs,
  });

  return {
    clustersProcessed: clusters.length,
    insightsGenerated,
    errors,
    results,
  };
}

module.exports = { runInsightSynthesis };
