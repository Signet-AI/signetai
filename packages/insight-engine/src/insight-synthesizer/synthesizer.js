'use strict';
/**
 * synthesizer.js — InsightSynthesizer: Claude Haiku Synthesis
 *
 * Uses the `claude` CLI in print mode (-p) via spawnSync.
 *
 * Auth: The claude CLI uses the macOS keychain OAuth session baked in by
 * Claude Code — zero config, works out of the box on any Mac that has
 * Claude Code installed and authenticated. We deliberately strip
 * ANTHROPIC_API_KEY from the subprocess env so the CLI falls back to its
 * keychain OAuth rather than trying (and failing) to use the OAuth token
 * as a raw API key.
 *
 * Returns null on any failure — never throws.
 */

const { spawnSync } = require('child_process');
const logger = require('../../shared/logger');

// ─── Subprocess env ────────────────────────────────────────────────────────────
// Build a clean env: inherit everything EXCEPT ANTHROPIC_API_KEY.
// If that key is present (it's the Claude.ai OAuth token, sk-ant-oat01-...),
// the claude binary mistakenly tries to use it as an API key and fails.
// Without it, the binary falls through to macOS keychain OAuth auth — which works.
function makeClaudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// ─── Prompt builders ───────────────────────────────────────────────────────────

/**
 * Format a single memory for inclusion in the Claude prompt.
 *
 * @param {{id: string, content: string, type: string, importance: number}} memory
 * @returns {string}
 */
function formatMemory(memory) {
  const idShort    = (memory.id || '').slice(0, 8);
  const type       = memory.type || 'memory';
  const importance = typeof memory.importance === 'number'
    ? memory.importance.toFixed(2)
    : '0.70';
  const content = (memory.content || '').trim();
  return `[${idShort}] (${type}, importance=${importance}) ${content}`;
}

/**
 * Build the full synthesis prompt for Claude Haiku.
 *
 * @param {object} cluster - Cluster object from clusterer.js
 * @returns {string} Full prompt text
 */
function buildPrompt(cluster) {
  const memoriesFormatted = cluster.memories.map(formatMemory).join('\n');

  return `You are analyzing a memory cluster for the entity "${cluster.entityName}".

MEMORIES (${cluster.memories.length} total):
${memoriesFormatted}

---
TASK: Generate ONE non-obvious cross-cutting insight.

Rules:
- NOT a summary. A NEW observation that isn't obvious from any single memory.
- Find 2-3 explicit connections between specific memory pairs.
- Assign 2-4 theme tags.
- Rate importance 0.0-1.0.

Output JSON ONLY (no markdown, no explanation):
{
  "insight": "one concrete, specific observation — something that connects the dots",
  "connections": [
    {"from_id": "memory-id-1", "to_id": "memory-id-2", "relationship": "description of how they connect"}
  ],
  "themes": ["theme1", "theme2"],
  "importance": 0.75
}`;
}

// ─── Response parsing ──────────────────────────────────────────────────────────

/**
 * Parse and validate the raw stdout from the Claude CLI.
 *
 * Handles markdown fences and leading explanation text defensively.
 *
 * @param {string} raw
 * @returns {{insight: string, connections: Array, themes: Array, importance: number} | null}
 */
function parseClaudeResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the JSON object — first '{' to last '}'
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    logger.warn('synthesizer', 'No JSON object found in Claude response', {
      preview: text.slice(0, 200),
    });
    return null;
  }
  text = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn('synthesizer', 'JSON.parse failed on Claude response', {
      error:   err.message,
      preview: text.slice(0, 200),
    });
    return null;
  }

  if (!parsed.insight || typeof parsed.insight !== 'string' || !parsed.insight.trim()) {
    logger.warn('synthesizer', 'Claude response missing or empty "insight" field');
    return null;
  }
  if (!Array.isArray(parsed.connections)) {
    parsed.connections = [];
  }
  if (!Array.isArray(parsed.themes)) {
    parsed.themes = [];
  }

  const rawImportance = parseFloat(parsed.importance);
  parsed.importance = isNaN(rawImportance)
    ? 0.7
    : Math.min(1.0, Math.max(0.0, rawImportance));

  return {
    insight:     parsed.insight.trim(),
    connections: parsed.connections,
    themes:      parsed.themes,
    importance:  parsed.importance,
  };
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * synthesizeCluster — generate an insight from a memory cluster via claude CLI.
 *
 * Uses `claude -p <prompt>` via spawnSync with OAuth keychain auth (see top of
 * file for the env-stripping trick that makes this work in subprocesses).
 *
 * Never throws. Returns null on any error.
 *
 * @param {object} cluster - Cluster from buildClusters()
 * @param {object} config  - Full app config (unused currently, reserved for model override)
 * @returns {{insight: string, connections: Array, themes: Array, importance: number} | null}
 */
function synthesizeCluster(cluster, config) {
  logger.info('synthesizer', `Synthesizing cluster for "${cluster.entityName}"`, {
    memoryCount: cluster.memories.length,
    entityType:  cluster.entityType,
  });

  let prompt;
  try {
    prompt = buildPrompt(cluster);
  } catch (err) {
    logger.error('synthesizer', 'Failed to build prompt', { error: err.message });
    return null;
  }

  let result;
  try {
    result = spawnSync(
      'claude',
      ['-p', prompt, '--output-format', 'text'],
      {
        encoding:  'utf8',
        timeout:   60000,
        maxBuffer: 1024 * 1024 * 4,
        env:       makeClaudeEnv(),  // OAuth keychain auth — no raw API key
      }
    );
  } catch (err) {
    logger.error('synthesizer', 'spawnSync threw calling claude CLI', {
      error: err.message,
    });
    return null;
  }

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      logger.error('synthesizer', 'claude CLI not found in PATH — is Claude Code installed?');
    } else if (result.signal === 'SIGTERM') {
      logger.error('synthesizer', 'claude CLI timed out after 60s', { entity: cluster.entityName });
    } else {
      logger.error('synthesizer', 'claude CLI error', { error: result.error.message });
    }
    return null;
  }

  if (result.status !== 0) {
    logger.warn('synthesizer', 'claude CLI exited non-zero', {
      status: result.status,
      stderr: (result.stderr || '').slice(0, 300),
    });
    // fall through — sometimes stderr has warnings but stdout is valid
  }

  const stdout = result.stdout || '';
  if (!stdout.trim()) {
    logger.warn('synthesizer', 'claude CLI produced empty stdout', {
      entity: cluster.entityName,
      stderr: (result.stderr || '').slice(0, 200),
    });
    return null;
  }

  const insightData = parseClaudeResponse(stdout);
  if (!insightData) {
    logger.warn('synthesizer', `Failed to parse Claude response for "${cluster.entityName}"`, {
      rawPreview: stdout.slice(0, 300),
    });
    return null;
  }

  logger.info('synthesizer', `✓ Insight generated for "${cluster.entityName}"`, {
    importance:  insightData.importance,
    themes:      insightData.themes,
    connections: insightData.connections.length,
    preview:     insightData.insight.slice(0, 80),
  });

  return insightData;
}

module.exports = { synthesizeCluster };
