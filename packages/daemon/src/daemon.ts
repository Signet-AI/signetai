#!/usr/bin/env node
/**
 * Signet Daemon
 * Background service for file watching and sync
 */

import { watch } from 'chokidar';
import { Signet } from '@signet/core';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const BASE_PATH = Signet.getDefaultPath();
const PID_FILE = join(BASE_PATH, '.daemon', 'pid');

async function main() {
  console.log('🔄 Signet Daemon starting...');
  console.log(`   Watching: ${BASE_PATH}`);

  // Write PID file
  const pidDir = join(BASE_PATH, '.daemon');
  if (!existsSync(pidDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(pidDir, { recursive: true });
  }
  writeFileSync(PID_FILE, process.pid.toString());

  // Initialize Signet
  const signet = new Signet();
  
  if (!Signet.detect()) {
    console.log('   No agent found. Waiting for initialization...');
  } else {
    await signet.load();
    console.log('   Agent loaded.');
  }

  // Watch for changes
  const watcher = watch([
    join(BASE_PATH, 'agent.yaml'),
    join(BASE_PATH, 'soul.md'),
    join(BASE_PATH, 'memory.md'),
    join(BASE_PATH, 'memory', '*.md'),
  ], {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', async (path) => {
    console.log(`   Changed: ${path}`);
    // TODO: Sync changes to database
    // TODO: Regenerate other files if needed
    // TODO: Push to sync service (if configured)
  });

  watcher.on('add', async (path) => {
    console.log(`   Added: ${path}`);
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Signet Daemon stopping...');
    watcher.close();
    if (existsSync(PID_FILE)) {
      const { unlinkSync } = require('fs');
      unlinkSync(PID_FILE);
    }
    process.exit(0);
  });

  console.log('   Daemon running. Press Ctrl+C to stop.');
}

main().catch(console.error);
