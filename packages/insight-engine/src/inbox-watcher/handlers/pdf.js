'use strict';
/**
 * src/inbox-watcher/handlers/pdf.js
 *
 * Handles PDF files.
 *
 * Strategy (in order):
 *   1. Try the Signet document ingestion HTTP endpoint if the daemon is running
 *   2. Fall back to `pdftotext` CLI (poppler-utils)
 *   3. If both fail, throw with a helpful message
 *
 * Export: handlePdf(filePath, config) → Promise<{ text, tags }>
 */

const path       = require('path');
const { spawnSync } = require('child_process');

const MAX_CHARS  = 8000;
const DAEMON_URL = 'http://localhost:3850/api/documents/ingest';

/**
 * @param {string} filePath - Absolute path to the PDF
 * @param {object} _config  - App config
 * @returns {Promise<{text: string, tags: string[]}>}
 */
async function handlePdf(filePath, _config) {
  // ── Attempt 1: Signet daemon document ingestion API ───────────────────────
  try {
    const text = await tryDaemonIngest(filePath);
    if (text && text.trim().length > 0) {
      return {
        text: text.substring(0, MAX_CHARS).trim(),
        tags: ['inbox', 'pdf', 'document'],
      };
    }
  } catch {
    // Daemon not available or endpoint not implemented — fall through
  }

  // ── Attempt 2: pdftotext CLI ──────────────────────────────────────────────
  try {
    const text = tryPdfToText(filePath);
    if (text && text.trim().length > 0) {
      return {
        text: text.substring(0, MAX_CHARS).trim(),
        tags: ['inbox', 'pdf', 'document'],
      };
    }
  } catch (err) {
    throw new Error(
      `PDF extraction failed. Ensure poppler-utils is installed (\`brew install poppler\`). Details: ${err.message}`,
    );
  }

  throw new Error('PDF extraction produced no text. The file may be image-only or encrypted.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * POST the file path to Signet's document ingestion endpoint.
 * Returns the extracted text, or throws if the endpoint is unavailable.
 */
async function tryDaemonIngest(filePath) {
  // Node's built-in fetch (available from Node 18+)
  const body = JSON.stringify({ filePath, returnText: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(DAEMON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.text || data.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract text from a PDF using the `pdftotext` CLI tool (poppler-utils).
 * Outputs to stdout via the `-` filename argument.
 */
function tryPdfToText(filePath) {
  const result = spawnSync('pdftotext', [filePath, '-'], {
    timeout: 30000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
  });

  if (result.error) {
    throw new Error(`pdftotext not found: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`pdftotext exited ${result.status}: ${stderr}`);
  }

  return result.stdout || '';
}

module.exports = { handlePdf };
