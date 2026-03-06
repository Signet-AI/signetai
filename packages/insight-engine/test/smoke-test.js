#!/usr/bin/env node
'use strict';
/**
 * test/smoke-test.js
 * 
 * Basic smoke tests to verify the companion service is correctly wired.
 * Runs WITHOUT starting the full service — just checks DB, config, and imports.
 */

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\n🧪 signet-insight-engine smoke tests\n');

// ── Config ──────────────────────────────────────────────────────────
console.log('Config:');
test('config loads without error', () => {
  const { config } = require('../shared/config');
  assert.ok(config, 'config is defined');
  assert.ok(config.insights, 'insights section present');
  assert.ok(config.inbox, 'inbox section present');
  assert.ok(config.dashboard, 'dashboard section present');
  assert.ok(config.dbPath, 'dbPath defined');
});

test('config has valid defaults', () => {
  const { config } = require('../shared/config');
  assert.strictEqual(typeof config.insights.maxClustersPerRun, 'number');
  assert.strictEqual(typeof config.insights.minMemoriesPerCluster, 'number');
  assert.ok(config.insights.maxClustersPerRun >= 1);
  assert.ok(config.insights.minMemoriesPerCluster >= 2);
});

// ── DB ──────────────────────────────────────────────────────────────
console.log('\nDatabase:');
test('can connect to memories.db', () => {
  const { getDb, DEFAULT_DB_PATH } = require('../shared/db');
  const db = getDb();
  assert.ok(db, 'db connection established');
});

test('memories table is accessible', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM memories WHERE is_deleted=0').get();
  assert.ok(row.c >= 0, `memories count: ${row.c}`);
  console.log(`     (${row.c.toLocaleString()} active memories)`);
});

test('entities table is accessible', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM entities').get();
  assert.ok(row.c >= 0);
  console.log(`     (${row.c.toLocaleString()} entities)`);
});

test('relations table is accessible', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM relations').get();
  assert.ok(row.c >= 0);
  console.log(`     (${row.c.toLocaleString()} relations)`);
});

test('insights table exists (migration applied)', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM insights').get();
    console.log(`     (${row.c} insights so far)`);
  } catch (err) {
    throw new Error('insights table not found — run: npm run migrate');
  }
});

test('insight_sources table exists (migration applied)', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  try {
    db.prepare('SELECT COUNT(*) as c FROM insight_sources').get();
  } catch (err) {
    throw new Error('insight_sources table not found — run: npm run migrate');
  }
});

test('insight_processed_at column exists on memories', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  try {
    db.prepare('SELECT insight_processed_at FROM memories LIMIT 1').get();
  } catch (err) {
    throw new Error('insight_processed_at column not found — run: npm run migrate');
  }
});

test('ingestion_jobs table accessible', () => {
  const { getDb } = require('../shared/db');
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM ingestion_jobs').get();
  assert.ok(row.c >= 0);
});

// ── Module Imports ───────────────────────────────────────────────────
console.log('\nModule imports:');
test('insight-synthesizer/index.js exports startInsightSynthesizer', () => {
  const mod = require('../src/insight-synthesizer/index');
  assert.strictEqual(typeof mod.startInsightSynthesizer, 'function');
});

test('insight-synthesizer/clusterer.js exports buildClusters', () => {
  const mod = require('../src/insight-synthesizer/clusterer');
  assert.strictEqual(typeof mod.buildClusters, 'function');
});

test('insight-synthesizer/synthesizer.js exports synthesizeCluster', () => {
  const mod = require('../src/insight-synthesizer/synthesizer');
  assert.strictEqual(typeof mod.synthesizeCluster, 'function');
});

test('insight-synthesizer/storage.js exports storeInsight', () => {
  const mod = require('../src/insight-synthesizer/storage');
  assert.strictEqual(typeof mod.storeInsight, 'function');
});

test('insight-synthesizer/runner.js exports runInsightSynthesis', () => {
  const mod = require('../src/insight-synthesizer/runner');
  assert.strictEqual(typeof mod.runInsightSynthesis, 'function');
});

test('inbox-watcher/index.js exports startInboxWatcher', () => {
  const mod = require('../src/inbox-watcher/index');
  assert.strictEqual(typeof mod.startInboxWatcher, 'function');
});

test('inbox-watcher/processor.js exports processFile', () => {
  const mod = require('../src/inbox-watcher/processor');
  assert.strictEqual(typeof mod.processFile, 'function');
});

test('dashboard/server.js exports startDashboard', () => {
  const mod = require('../src/dashboard/server');
  assert.strictEqual(typeof mod.startDashboard, 'function');
});

// ── Clustering Logic ─────────────────────────────────────────────────
console.log('\nInsight clustering:');
test('buildClusters returns array', () => {
  const { buildClusters } = require('../src/insight-synthesizer/clusterer');
  const { getDb } = require('../shared/db');
  const { config } = require('../shared/config');
  const db = getDb(config.dbPath);
  
  const clusters = buildClusters(db, config);
  assert.ok(Array.isArray(clusters), 'returns array');
  console.log(`     (${clusters.length} clusters found with >= ${config.insights.minMemoriesPerCluster} unprocessed memories)`);
});

test('clusters have required shape', () => {
  const { buildClusters } = require('../src/insight-synthesizer/clusterer');
  const { getDb } = require('../shared/db');
  const { config } = require('../shared/config');
  const db = getDb(config.dbPath);
  
  const clusters = buildClusters(db, config);
  if (clusters.length > 0) {
    const c = clusters[0];
    assert.ok(c.entityId, 'cluster has entityId');
    assert.ok(c.entityName, 'cluster has entityName');
    assert.ok(Array.isArray(c.memories), 'cluster has memories array');
    assert.ok(c.memories.length >= config.insights.minMemoriesPerCluster, 'cluster meets min size');
    console.log(`     (top cluster: "${c.entityName}" with ${c.memories.length} memories)`);
  }
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n⚠️  Some tests failed. Fix issues before running the service.');
  console.log('   Most likely cause: npm run migrate has not been run yet.');
  process.exit(1);
} else {
  console.log('\n✅ All smoke tests passed. Ready to run: npm start');
}
