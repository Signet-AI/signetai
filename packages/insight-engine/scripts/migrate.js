#!/usr/bin/env node
'use strict';
/**
 * scripts/migrate.js
 * Run all pending DB migrations against Signet's memories.db.
 * Safe to run multiple times — all migrations are idempotent.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../shared/db');
const logger = require('../shared/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function runMigrations() {
  const db = getDb();
  logger.info('migrate', 'Running signet-insight-engine migrations...');

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    
    logger.info('migrate', `Applying: ${file}`);
    
    // Split on semicolons to run each statement separately
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        db.exec(stmt + ';');
      } catch (err) {
        // Gracefully handle "duplicate column" errors from ALTER TABLE
        if (err.message.includes('duplicate column name')) {
          logger.info('migrate', `Column already exists — skipping: ${stmt.substring(0, 60)}...`);
        } else if (err.message.includes('already exists')) {
          logger.info('migrate', `Object already exists — skipping: ${stmt.substring(0, 60)}...`);
        } else {
          logger.error('migrate', `Migration failed: ${file}`, { error: err.message, stmt });
          process.exit(1);
        }
      }
    }

    logger.info('migrate', `✓ ${file}`);
  }

  logger.info('migrate', 'All migrations complete.');
}

runMigrations();
