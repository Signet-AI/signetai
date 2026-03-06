'use strict';
/**
 * signet-insight-engine — main entry point
 * 
 * Starts three companion services alongside the Signet daemon:
 *   1. InsightSynthesizer  — periodic knowledge synthesis from entity graph
 *   2. InboxWatcher        — file drop → memory ingestion pipeline
 *   3. Dashboard / API     — Express server on port 3851
 */

const { config } = require('./shared/config');
const logger = require('./shared/logger');
const { getDb } = require('./shared/db');

async function main() {
  logger.info('main', '🧠 signet-insight-engine starting', { version: '0.1.0', port: config.insights.port });

  // Verify DB connection
  try {
    const db = getDb(config.dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM memories WHERE is_deleted=0').get();
    logger.info('main', `✓ Connected to memories.db`, { memories: count.c });
  } catch (err) {
    logger.error('main', 'Failed to connect to memories.db', { error: err.message });
    process.exit(1);
  }

  // Start dashboard + API server
  const { startDashboard } = require('./src/dashboard/server');
  await startDashboard(config);

  // Start InsightSynthesizer scheduler
  if (config.insights.enabled) {
    const { startInsightSynthesizer } = require('./src/insight-synthesizer/index');
    startInsightSynthesizer(config);
  } else {
    logger.info('main', 'InsightSynthesizer disabled (insights.enabled=false)');
  }

  // Start File Inbox Watcher
  if (config.inbox.enabled) {
    const { startInboxWatcher } = require('./src/inbox-watcher/index');
    startInboxWatcher(config);
  } else {
    logger.info('main', 'InboxWatcher disabled (inbox.enabled=false — set inbox.enabled=true in insights-config.yaml to activate)');
  }

  logger.info('main', `✅ signet-insight-engine running`);
  logger.info('main', `   Dashboard:  http://${config.dashboard.host}:${config.insights.port}`);
  logger.info('main', `   API:        http://${config.dashboard.host}:${config.insights.port}/api/insights`);
  logger.info('main', `   Inbox:      ${config.inbox.enabled ? config.inbox.watchPath : 'disabled'}`);
}

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('main', '👋 Shutting down (SIGINT)'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('main', '👋 Shutting down (SIGTERM)'); process.exit(0); });

main().catch(err => {
  logger.error('main', 'Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
