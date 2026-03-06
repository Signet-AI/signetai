'use strict';
/**
 * src/inbox-watcher/handlers/text.js
 *
 * Handles plain-text file types: .txt, .md, .json, .csv, .log, .xml, .yaml, .yml
 *
 * Export: handleText(filePath, config) → Promise<{ text, tags }>
 */

const fs   = require('fs');
const path = require('path');

const MAX_CHARS = 8000;

/**
 * @param {string} filePath - Absolute path to the file
 * @param {object} _config  - App config (unused for text, kept for API consistency)
 * @returns {Promise<{text: string, tags: string[]}>}
 */
async function handleText(filePath, _config) {
  const ext = path.extname(filePath).toLowerCase(); // e.g. '.json'
  const extLabel = ext.replace('.', '');            // e.g. 'json'

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read file: ${err.message}`);
  }

  let text = raw;

  // For JSON: normalise to pretty-printed form; fall back to raw on parse error
  if (ext === '.json') {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // Raw JSON is fine — probably already readable
      text = raw;
    }
  }

  // Trim to max characters to avoid oversized memories
  if (text.length > MAX_CHARS) {
    text = text.substring(0, MAX_CHARS) + `\n\n[… truncated at ${MAX_CHARS} chars]`;
  }

  text = text.trim();

  if (text.length === 0) {
    throw new Error('File is empty');
  }

  const tags = ['inbox', 'file', extLabel];

  return { text, tags };
}

module.exports = { handleText };
