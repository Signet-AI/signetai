'use strict';
/**
 * src/inbox-watcher/processor.js
 *
 * Main dispatch function for the File Inbox Watcher.
 * Receives a file path, checks deduplication, routes to the right handler,
 * stores the result via `signet remember`, and records the ingestion job.
 *
 * Export: processFile(filePath, config)
 */

const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { spawnSync }  = require('child_process');

const logger      = require('../../shared/logger');
const { getDb }   = require('../../shared/db');

// Handler extension → type map
const EXT_MAP = {
  // Plain text
  '.txt':  'text',
  '.md':   'text',
  '.json': 'text',
  '.csv':  'text',
  '.log':  'text',
  '.xml':  'text',
  '.yaml': 'text',
  '.yml':  'text',
  // Documents
  '.pdf':  'pdf',
  // Images
  '.png':  'image',
  '.jpg':  'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif':  'image',
  // Audio
  '.mp3':  'audio',
  '.wav':  'audio',
  '.m4a':  'audio',
  '.flac': 'audio',
  '.ogg':  'audio',
  '.aac':  'audio',
  // Video
  '.mp4':  'video',
  '.mov':  'video',
  '.webm': 'video',
  '.avi':  'video',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Store text as a Signet memory via `signet remember` CLI.
 * Uses spawnSync so we avoid shell-injection and get clean stdout/stderr.
 *
 * @param {string}   text   - Content to remember
 * @param {string[]} tags   - Optional tags
 * @returns {string}        - stdout from signet
 */
function rememberText(text, tags = []) {
  const content = text.substring(0, 4000); // guard against oversized input

  const args = ['remember', content];
  if (tags.length > 0) {
    args.push('--tags', tags.join(','));
  }

  const result = spawnSync('signet', args, {
    timeout: 30000,
    encoding: 'utf8',
    env: { ...process.env },
  });

  if (result.error) {
    throw new Error(`signet remember spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`signet remember exited ${result.status}: ${stderr}`);
  }

  return (result.stdout || '').trim();
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

/**
 * Process a newly-detected inbox file end-to-end.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {object} config   - Full app config
 */
async function processFile(filePath, config) {
  const ext      = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const db       = getDb(config.dbPath);

  // ── 1. Resolve file type ──────────────────────────────────────────────────
  const fileType = EXT_MAP[ext];

  if (!fileType) {
    logger.warn('processor', `Unsupported extension, skipping: ${fileName}`, { ext });
    return;
  }

  // ── 2. Guard: feature flags ───────────────────────────────────────────────
  if (fileType === 'audio' && !(config.inbox.audio?.enabled ?? true)) {
    logger.info('processor', `Audio ingestion disabled, skipping: ${fileName}`);
    return;
  }
  if (fileType === 'video' && !(config.inbox.video?.enabled ?? false)) {
    logger.info('processor', `Video ingestion disabled, skipping: ${fileName}`);
    return;
  }
  if (fileType === 'image' && !(config.inbox.image?.enabled ?? true)) {
    logger.info('processor', `Image ingestion disabled, skipping: ${fileName}`);
    return;
  }

  // ── 3. Guard: file size ───────────────────────────────────────────────────
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    logger.error('processor', `Cannot stat file, skipping: ${fileName}`, { err: err.message });
    return;
  }

  const maxBytes = (config.inbox.maxFileSizeMb || 50) * 1024 * 1024;
  if (stat.size > maxBytes) {
    logger.warn('processor', `File too large, skipping: ${fileName}`, {
      sizeMb: (stat.size / 1024 / 1024).toFixed(1),
      limitMb: config.inbox.maxFileSizeMb || 50,
    });
    return;
  }

  // ── 4. Deduplication via file hash ────────────────────────────────────────
  let hash;
  try {
    hash = fileHash(filePath);
  } catch (err) {
    logger.error('processor', `Cannot hash file, skipping: ${fileName}`, { err: err.message });
    return;
  }

  const existing = db
    .prepare('SELECT id, status FROM ingestion_jobs WHERE file_hash = ? LIMIT 1')
    .get(hash);

  if (existing) {
    logger.info('processor', `Already ingested (${existing.status}), skipping: ${fileName}`, {
      jobId: existing.id,
    });
    return;
  }

  // ── 5. Insert ingestion_job row (status=pending) ──────────────────────────
  const jobId = uuidv4();
  const startedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO ingestion_jobs
      (id, source_path, source_type, file_hash, status, started_at)
    VALUES
      (?, ?, ?, ?, 'pending', ?)
  `).run(jobId, filePath, fileType, hash, startedAt);

  logger.info('processor', `Processing [${fileType}] ${fileName}`, { jobId });

  // ── 6. Route to handler ───────────────────────────────────────────────────
  let handlerResult;
  try {
    db.prepare(`UPDATE ingestion_jobs SET status='processing' WHERE id=?`).run(jobId);

    switch (fileType) {
      case 'text': {
        const { handleText } = require('./handlers/text');
        handlerResult = await handleText(filePath, config);
        break;
      }
      case 'pdf': {
        const { handlePdf } = require('./handlers/pdf');
        handlerResult = await handlePdf(filePath, config);
        break;
      }
      case 'image': {
        const { handleImage } = require('./handlers/image');
        handlerResult = await handleImage(filePath, config);
        break;
      }
      case 'audio': {
        const { handleAudio } = require('./handlers/audio');
        handlerResult = await handleAudio(filePath, config);
        break;
      }
      case 'video': {
        // Video is handled by the audio handler (extracts audio first)
        const { handleVideo } = require('./handlers/audio');
        handlerResult = await handleVideo(filePath, config);
        break;
      }
      default:
        throw new Error(`No handler registered for type: ${fileType}`);
    }
  } catch (handlerErr) {
    // Handler failed — record the error and bail
    logger.error('processor', `Handler error for ${fileName}`, { err: handlerErr.message });
    db.prepare(`
      UPDATE ingestion_jobs
      SET status='error', error=?, completed_at=?
      WHERE id=?
    `).run(handlerErr.message, new Date().toISOString(), jobId);
    return;
  }

  const { text, tags = [] } = handlerResult;

  if (!text || text.trim().length === 0) {
    const msg = 'Handler returned empty text';
    logger.warn('processor', `${msg} for ${fileName}`);
    db.prepare(`
      UPDATE ingestion_jobs
      SET status='error', error=?, completed_at=?
      WHERE id=?
    `).run(msg, new Date().toISOString(), jobId);
    return;
  }

  // ── 7. Store in Signet memory ─────────────────────────────────────────────
  let memoriesCreated = 0;
  try {
    rememberText(text, tags);
    memoriesCreated = 1; // signet remember creates 1 memory (it handles chunking internally)
    logger.info('processor', `Memory stored for ${fileName}`, { tags });
  } catch (rememberErr) {
    logger.error('processor', `signet remember failed for ${fileName}`, { err: rememberErr.message });
    db.prepare(`
      UPDATE ingestion_jobs
      SET status='error', error=?, completed_at=?
      WHERE id=?
    `).run(rememberErr.message, new Date().toISOString(), jobId);
    return;
  }

  // ── 8. Mark job complete ──────────────────────────────────────────────────
  db.prepare(`
    UPDATE ingestion_jobs
    SET status='completed', memories_created=?, chunks_total=1, chunks_processed=1, completed_at=?
    WHERE id=?
  `).run(memoriesCreated, new Date().toISOString(), jobId);

  logger.info('processor', `✓ Ingested ${fileName}`, { jobId, type: fileType, memories: memoriesCreated });

  // ── 9. Post-process behavior (mark / move / delete) ───────────────────────
  const behavior = config.inbox.processedBehavior || 'mark';

  try {
    if (behavior === 'delete') {
      fs.unlinkSync(filePath);
      logger.info('processor', `Deleted processed file: ${fileName}`);
    } else if (behavior === 'move' && config.inbox.processedMoveDir) {
      const destDir = config.inbox.processedMoveDir.replace(/^~/, require('os').homedir());
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, fileName);
      fs.renameSync(filePath, dest);
      logger.info('processor', `Moved processed file to: ${dest}`);
    }
    // 'mark' = default, do nothing (job row in DB is the mark)
  } catch (cleanupErr) {
    // Non-fatal — ingestion succeeded, just log the cleanup failure
    logger.warn('processor', `Post-process cleanup failed for ${fileName}`, {
      err: cleanupErr.message,
    });
  }
}

module.exports = { processFile };
