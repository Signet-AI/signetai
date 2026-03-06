'use strict';
/**
 * src/dashboard/routes/inbox.js
 *
 * Express router for /api/inbox/*
 * Ingestion job history, status, manual trigger.
 */

const router   = require('express').Router();
const { getDb } = require('../../../shared/db');
const path     = require('path');

// ─── GET /status ──────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    const { config } = require('../../../shared/config');
    const db = getDb();

    let totalIngested = 0, errorCount = 0, lastActivityAt = null;
    try {
      const totRow = db.prepare(
        `SELECT COUNT(*) as c FROM ingestion_jobs WHERE status = 'completed'`
      ).get();
      totalIngested = totRow ? totRow.c : 0;

      const errRow = db.prepare(
        `SELECT COUNT(*) as c FROM ingestion_jobs WHERE status = 'error'`
      ).get();
      errorCount = errRow ? errRow.c : 0;

      const lastRow = db.prepare(
        `SELECT started_at FROM ingestion_jobs ORDER BY started_at DESC LIMIT 1`
      ).get();
      lastActivityAt = lastRow ? lastRow.started_at : null;
    } catch { /* table may not exist yet */ }

    res.json({
      enabled:        config.inbox ? config.inbox.enabled : false,
      watchPath:      config.inbox ? config.inbox.watchPath : null,
      totalIngested,
      lastActivityAt,
      errorCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /supported-types ─────────────────────────────────────────────────────
router.get('/supported-types', (_req, res) => {
  res.json({
    types: [
      { ext: '.txt',  label: 'Plain Text',  category: 'text'  },
      { ext: '.md',   label: 'Markdown',    category: 'text'  },
      { ext: '.pdf',  label: 'PDF',         category: 'text'  },
      { ext: '.docx', label: 'Word Doc',    category: 'text'  },
      { ext: '.html', label: 'HTML',        category: 'text'  },
      { ext: '.csv',  label: 'CSV',         category: 'text'  },
      { ext: '.json', label: 'JSON',        category: 'text'  },
      { ext: '.png',  label: 'PNG Image',   category: 'image' },
      { ext: '.jpg',  label: 'JPEG Image',  category: 'image' },
      { ext: '.jpeg', label: 'JPEG Image',  category: 'image' },
      { ext: '.webp', label: 'WebP Image',  category: 'image' },
      { ext: '.gif',  label: 'GIF Image',   category: 'image' },
      { ext: '.mp3',  label: 'MP3 Audio',   category: 'audio' },
      { ext: '.wav',  label: 'WAV Audio',   category: 'audio' },
      { ext: '.m4a',  label: 'M4A Audio',   category: 'audio' },
      { ext: '.ogg',  label: 'OGG Audio',   category: 'audio' },
      { ext: '.mp4',  label: 'MP4 Video',   category: 'video' },
      { ext: '.mov',  label: 'MOV Video',   category: 'video' },
    ],
  });
});

// ─── GET /jobs ────────────────────────────────────────────────────────────────
router.get('/jobs', (req, res) => {
  try {
    const db     = getDb();
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const status = req.query.status || null;

    let where  = '';
    const params = [];

    if (status) {
      where = 'WHERE status = ?';
      params.push(status);
    }

    let jobs = [];
    try {
      jobs = db.prepare(`
        SELECT id, source_path, source_type, status, memories_created,
               started_at, completed_at, error
        FROM ingestion_jobs
        ${where}
        ORDER BY started_at DESC
        LIMIT ?
      `).all(...params, limit);
    } catch { /* table may not exist yet */ }

    res.json({ jobs, total: jobs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /ingest — manual file ingest ────────────────────────────────────────
router.post('/ingest', (req, res) => {
  const { filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });

  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` });
  }

  res.json({ queued: true, filePath, message: 'File queued for ingestion' });

  setImmediate(async () => {
    try {
      const { config } = require('../../../shared/config');
      const watcher = require('../../inbox-watcher/index');
      if (typeof watcher.ingestFile === 'function') {
        await watcher.ingestFile(filePath, config);
      }
    } catch (err) {
      console.error('[inbox/ingest] error:', err.message);
    }
  });
});

module.exports = router;
