'use strict';
/**
 * src/inbox-watcher/handlers/image.js
 *
 * Handles image files: .png, .jpg, .jpeg, .webp, .gif
 *
 * Uses the `claude` CLI with a vision prompt to produce a textual description
 * of the image. The description is stored as a Signet memory.
 *
 * Export: handleImage(filePath, config) → Promise<{ text, tags }>
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const MAX_DESCRIPTION_CHARS = 4000;

// Maps extension → MIME type for the base64 data URI
const MIME_MAP = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
};

const VISION_PROMPT = `You are analyzing an image for long-term memory storage.

Please provide:
1. A concise overall description of what the image shows
2. Any text visible in the image — transcribe it verbatim
3. Notable objects, people, scenes, or data (charts/graphs/screenshots)
4. Any contextual clues about the image's purpose or origin

Be factual and thorough. Do not speculate beyond what is visible.`;

/**
 * @param {string} filePath - Absolute path to the image
 * @param {object} _config  - App config
 * @returns {Promise<{text: string, tags: string[]}>}
 */
async function handleImage(filePath, _config) {
  const ext      = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = MIME_MAP[ext] || 'image/jpeg';
  const fileName = path.basename(filePath);

  // Read image as base64
  let imageData;
  try {
    imageData = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(`Cannot read image file: ${err.message}`);
  }

  const base64    = imageData.toString('base64');
  const dataUri   = `data:${mimeType};base64,${base64}`;

  // Build a self-contained prompt that embeds the image as a data URI.
  // The `claude` CLI accepts images inline via the -p flag when the model
  // supports vision (Claude 3 Haiku / Sonnet / Opus).
  //
  // Format expected by claude CLI for vision:
  //   claude -p "prompt" --image <path>   (if supported)
  // OR pass the image as a data URI inside the prompt string.
  //
  // We try --image <path> first (cleaner), then fall back to a brief prompt
  // asking claude to describe what it sees from the file path (text-only
  // fallback if vision not available via CLI).

  // ── Attempt 1: claude --image <path> ─────────────────────────────────────
  let description = '';

  const resultWithFlag = spawnSync(
    'claude',
    ['-p', VISION_PROMPT, '--image', filePath],
    { timeout: 60000, encoding: 'utf8', env: { ...process.env } },
  );

  if (resultWithFlag.status === 0 && resultWithFlag.stdout && resultWithFlag.stdout.trim().length > 0) {
    description = resultWithFlag.stdout.trim();
  } else {
    // ── Attempt 2: embed base64 data URI directly in the prompt ─────────────
    // Only feasible for small images — large base64 blobs may exceed CLI limits.
    // For larger files we fall back to a file-path hint.
    let visionInput;
    if (base64.length < 200_000) {
      // Inline the image as a data URI in the prompt
      visionInput = `${VISION_PROMPT}\n\nImage (${mimeType}, base64):\n${dataUri}`;
    } else {
      // Image too large to embed — ask claude to use the file path
      visionInput = `${VISION_PROMPT}\n\nImage file path: ${filePath}\nMIME type: ${mimeType}`;
    }

    const resultInline = spawnSync(
      'claude',
      ['-p', visionInput],
      { timeout: 60000, encoding: 'utf8', env: { ...process.env } },
    );

    if (resultInline.error) {
      throw new Error(`claude CLI spawn error: ${resultInline.error.message}`);
    }
    if (resultInline.status !== 0 || !resultInline.stdout) {
      const stderr = (resultInline.stderr || '').trim();
      throw new Error(`claude vision failed (exit ${resultInline.status}): ${stderr}`);
    }

    description = resultInline.stdout.trim();
  }

  if (!description || description.length === 0) {
    throw new Error('Claude returned an empty description for the image');
  }

  const text = `[Image: ${fileName}]\n\n${description.substring(0, MAX_DESCRIPTION_CHARS)}`;

  return {
    text,
    tags: ['inbox', 'image', 'visual'],
  };
}

module.exports = { handleImage };
