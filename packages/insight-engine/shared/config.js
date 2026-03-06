'use strict';
/**
 * shared/config.js
 * 
 * Reads ~/.agents/agent.yaml for Signet config (model preferences, etc.)
 * and signet-insight-engine's own config from ~/.agents/insights-config.yaml (if present).
 * Falls back to safe defaults for everything.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const AGENTS_DIR = path.join(os.homedir(), '.agents');
const AGENT_YAML = path.join(AGENTS_DIR, 'agent.yaml');
const INSIGHTS_CONFIG_YAML = path.join(AGENTS_DIR, 'insights-config.yaml');

const DEFAULTS = {
  // InsightSynthesizer
  insights: {
    enabled: true,
    scheduleExpression: '0 */6 * * *',       // every 6 hours
    minMemoriesPerCluster: 3,
    maxMemoriesPerBatch: 10,
    maxClustersPerRun: 5,
    model: 'haiku',                            // same as extraction — cheap + fast
    topEntityCount: 30,
    reprocessAfterDays: 7,
    applyToSynthesis: true,
    port: 3851,                                // companion service HTTP port
  },

  // File Inbox Watcher
  inbox: {
    enabled: false,                            // opt-in
    watchPath: path.join(os.homedir(), 'inbox'),
    pollIntervalMs: 5000,
    audio: {
      enabled: true,
      transcriber: 'whisper',                  // whisper | openai-whisper-api
      model: 'base',
    },
    image: {
      enabled: true,
      model: 'haiku',
    },
    video: {
      enabled: false,                          // disabled by default (large files)
      extractAudioFirst: true,
    },
    maxFileSizeMb: 50,
    processedBehavior: 'mark',                 // mark | delete | move
    processedMoveDir: null,
  },

  // Dashboard
  dashboard: {
    enabled: true,
    port: 3851,
    host: '127.0.0.1',
  },

  // Signet db path
  dbPath: path.join(AGENTS_DIR, 'memory', 'memories.db'),
};

function loadConfig() {
  let agentYaml = {};
  let insightsYaml = {};

  try {
    if (fs.existsSync(AGENT_YAML)) {
      agentYaml = yaml.load(fs.readFileSync(AGENT_YAML, 'utf8')) || {};
    }
  } catch (e) {
    console.warn('[config] Could not read agent.yaml:', e.message);
  }

  try {
    if (fs.existsSync(INSIGHTS_CONFIG_YAML)) {
      insightsYaml = yaml.load(fs.readFileSync(INSIGHTS_CONFIG_YAML, 'utf8')) || {};
    }
  } catch (e) {
    console.warn('[config] Could not read insights-config.yaml:', e.message);
  }

  // Deep merge: defaults < agent.yaml (insights/inbox sections) < insights-config.yaml
  const merged = deepMerge(
    DEFAULTS,
    {
      insights: agentYaml.insights || {},
      inbox: agentYaml.inbox || {},
      dbPath: agentYaml.memory?.database
        ? path.join(AGENTS_DIR, agentYaml.memory.database)
        : DEFAULTS.dbPath,
    },
    insightsYaml
  );

  return merged;
}

function deepMerge(...objects) {
  const result = {};
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = deepMerge(result[k] || {}, v);
      } else {
        result[k] = v;
      }
    }
  }
  return result;
}

const config = loadConfig();

module.exports = { config, AGENTS_DIR };
