'use strict';
/**
 * src/inbox-watcher/index.js
 *
 * Starts the File Inbox Watcher service.
 * Monitors a directory for new files and routes them through the processing pipeline.
 *
 * Export: startInboxWatcher(config)
 */

const chokidar = require('chokidar');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const logger   = require('../../shared/logger');
const { processFile } = require('./processor');

/**
 * Start the inbox watcher.
 * @param {object} config  - Full app config (from shared/config.js)
 */
async function startInboxWatcher(config) {
  const rawPath   = config.inbox.watchPath || path.join(os.homedir(), 'inbox');
  const watchPath = rawPath.replace(/^~/, os.homedir());

  // Ensure the watch directory exists
  fs.mkdirSync(watchPath, { recursive: true });

  const audioEnabled = config.inbox.audio?.enabled ?? true;
  const imageEnabled = config.inbox.image?.enabled ?? true;
  const videoEnabled = config.inbox.video?.enabled ?? false;

  logger.info('inbox-watcher', `Watching: ${watchPath}`);
  logger.info(
    'inbox-watcher',
    `Supported: text, PDF, images` +
      (audioEnabled ? ', audio' : '') +
      (videoEnabled ? ', video' : ''),
  );

  const watcher = chokidar.watch(watchPath, {
    // Ignore dot-files and OS metadata artefacts
    ignored: /(^|[/\\])\../,
    persistent: true,
    usePolling: true,
    interval: config.inbox.pollIntervalMs || 5000,
    // Wait for the file write to stabilise before triggering 'add'
    awaitWriteFinish: {
      stabilityThreshold: 2000, // ms of no-change before firing
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => {
    logger.info('inbox-watcher', `New file detected: ${path.basename(filePath)}`);
    // Fire-and-forget — processor handles its own errors
    processFile(filePath, config).catch((err) => {
      logger.error('inbox-watcher', `Unhandled error processing ${path.basename(filePath)}`, {
        err: err.message,
      });
    });
  });

  watcher.on('error', (err) => {
    logger.error('inbox-watcher', 'Watcher error', { err: err.message });
  });

  watcher.on('ready', () => {
    logger.info('inbox-watcher', `Initial scan complete — watching for new files`);
  });

  return watcher; // allow caller to close if needed
}

module.exports = { startInboxWatcher };
