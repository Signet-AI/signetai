#!/usr/bin/env node
/**
 * Signet postinstall script
 * Shows installation info and checks for Bun
 */

import { execSync } from 'node:child_process';

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function hasBun() {
  try {
    execSync('bun --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

console.log();
console.log('━'.repeat(50));
console.log();
console.log(`  ${CYAN}${BOLD}◈ Signet${RESET} installed!`);
console.log(`  ${DIM}Portable AI agent identity${RESET}`);
console.log();

if (!hasBun()) {
  console.log(`  ${YELLOW}⚠ Bun not found${RESET} (required for daemon)`);
  console.log(`  ${DIM}Install: curl -fsSL https://bun.sh/install | bash${RESET}`);
  console.log();
}

console.log(`  ${GREEN}Get started:${RESET}`);
console.log(`    ${CYAN}signet${RESET}        Interactive setup`);
console.log(`    ${CYAN}signet sync${RESET}   Fix missing files`);
console.log(`    ${CYAN}signet status${RESET} Check daemon`);
console.log();
console.log('━'.repeat(50));
console.log();
