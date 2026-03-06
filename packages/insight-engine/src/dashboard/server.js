'use strict';
/**
 * src/dashboard/server.js
 *
 * Starts the Express HTTP server on config.dashboard.port.
 * Serves the REST API + single-page dashboard.
 */

const express = require('express');
const path = require('path');

async function startDashboard(config) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Mount API routes
  app.use('/api/insights', require('./routes/insights'));
  app.use('/api/graph',    require('./routes/graph'));
  app.use('/api/inbox',    require('./routes/inbox'));
  app.use('/api/memory',   require('./routes/memory'));

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  });

  const { port, host } = config.dashboard;

  await new Promise((resolve, reject) => {
    const server = app.listen(port, host, resolve);
    server.on('error', reject);
  });

  const logger = require('../../shared/logger');
  logger.info('dashboard', `✓ Dashboard running at http://${host}:${port}`);

  return app;
}

module.exports = { startDashboard };
