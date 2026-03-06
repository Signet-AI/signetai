'use strict';
/**
 * index.js — InsightSynthesizer: Entry Point & Scheduler
 *
 * Responsibility: Wire together the node-cron scheduler with the
 * runInsightSynthesis() orchestrator. Also exposes the Express route handler
 * for the manual-trigger endpoint at POST /api/insights/run so the dashboard
 * can fire a synthesis pass on demand.
 *
 * Exports:
 *   - startInsightSynthesizer(config)  → called by the main index.js on startup
 *   - insightRunHandler(req, res)      → Express middleware for the API route
 *
 * Schedule format (node-cron):
 *   config.insights.scheduleExpression, e.g. "0 * /6 * * *" (every 6 hours — note the space avoids closing this jsdoc block)
 *   See https://github.com/node-cron/node-cron#cron-syntax
 */

const cron               = require('node-cron');
const { runInsightSynthesis } = require('./runner');
const logger             = require('../../shared/logger');

// Track whether a run is already in progress to prevent overlapping executions
// when the cron tick fires while a previous run is still working.
let _runInProgress = false;

/**
 * Guard wrapper — runs `runInsightSynthesis` but skips if a run is already
 * in progress. Logs start/end including elapsed time.
 *
 * @param {object} config
 * @param {string} [triggeredBy='cron'] - 'cron' or 'api' (for log context)
 * @returns {Promise<object>} Summary from runInsightSynthesis, or a skipped sentinel
 */
async function _guardedRun(config, triggeredBy = 'cron') {
  if (_runInProgress) {
    logger.warn('insight-synthesizer', `Run skipped — previous run still in progress`, { triggeredBy });
    return { skipped: true, reason: 'run_in_progress' };
  }

  _runInProgress = true;
  const t0 = Date.now();
  logger.info('insight-synthesizer', `◈ Insight synthesis triggered`, { triggeredBy });

  try {
    const result = await runInsightSynthesis(config);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info('insight-synthesizer', `◈ Synthesis run finished in ${elapsed}s`, {
      triggeredBy,
      clustersProcessed: result.clustersProcessed,
      insightsGenerated: result.insightsGenerated,
      errors:            result.errors,
    });
    return result;
  } catch (err) {
    // runInsightSynthesis shouldn't throw (it catches internally), but just in case
    logger.error('insight-synthesizer', 'Unexpected error in synthesis run', {
      error: err.message,
      stack: err.stack,
    });
    return { clustersProcessed: 0, insightsGenerated: 0, errors: 1, results: [] };
  } finally {
    _runInProgress = false;
  }
}

/**
 * startInsightSynthesizer — main export
 *
 * Registers a node-cron job that fires on `config.insights.scheduleExpression`.
 * Also triggers one immediate run 30 seconds after startup (so you get fresh
 * insights soon after launching, without waiting for the first cron tick).
 *
 * @param {object} config - Full app config from shared/config.js
 */
function startInsightSynthesizer(config) {
  const schedule = (config.insights && config.insights.scheduleExpression)
    || '0 */6 * * *';  // fallback: every 6 hours

  logger.info('insight-synthesizer', `Starting InsightSynthesizer`, { schedule });

  // Validate the cron expression before registering — bad expressions throw
  if (!cron.validate(schedule)) {
    logger.error('insight-synthesizer', `Invalid cron expression: "${schedule}" — InsightSynthesizer will NOT start`);
    return;
  }

  // ─── Register the periodic cron job ────────────────────────────────────────
  const task = cron.schedule(schedule, async () => {
    await _guardedRun(config, 'cron');
  }, {
    scheduled: true,
    timezone:  'UTC',
  });

  logger.info('insight-synthesizer', `Cron job registered (schedule="${schedule}", timezone=UTC)`);

  // ─── Warm-start: run once shortly after launch ─────────────────────────────
  // 30-second delay gives the rest of the app time to fully initialise (DB
  // migrations, dashboard server, etc.) before we hit the DB with queries.
  setTimeout(async () => {
    logger.info('insight-synthesizer', 'Warm-start: running initial synthesis pass (30s post-launch)');
    await _guardedRun(config, 'warm-start');
  }, 30_000);

  // Return a handle so callers can stop the scheduler if needed (e.g. in tests)
  return {
    stop: () => {
      task.stop();
      logger.info('insight-synthesizer', 'Cron job stopped');
    },
  };
}

/**
 * insightRunHandler — Express route handler for POST /api/insights/run
 *
 * Allows the dashboard (or any HTTP client) to manually trigger a synthesis run
 * without waiting for the next cron tick. Returns the run summary as JSON.
 *
 * Expected to be wired up in src/dashboard/server.js like:
 *   app.post('/api/insights/run', insightRunHandler(config));
 *
 * @param {object} config - Full app config
 * @returns {Function} Express middleware: (req, res) => Promise<void>
 */
function insightRunHandler(config) {
  return async (req, res) => {
    logger.info('insight-synthesizer', 'Manual trigger via POST /api/insights/run');
    try {
      const result = await _guardedRun(config, 'api');
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error('insight-synthesizer', 'insightRunHandler error', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

module.exports = { startInsightSynthesizer, insightRunHandler };
