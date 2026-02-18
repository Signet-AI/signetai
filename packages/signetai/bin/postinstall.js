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

function hasBun() {
  try {
    execSync('bun --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

console.log(`
${CYAN}◈ Signet${RESET} installed successfully!

${DIM}Portable AI agent identity - own your agent, bring it anywhere.${RESET}
`);

if (!hasBun()) {
  console.log(`${YELLOW}⚠ Bun not found${RESET}
  The Signet daemon requires Bun for optimal performance.
  Install: ${CYAN}curl -fsSL https://bun.sh/install | bash${RESET}
`);
}

console.log(`${GREEN}Get started:${RESET}
  ${CYAN}signet${RESET}           Interactive setup wizard
  ${CYAN}signet status${RESET}    Check daemon status
  ${CYAN}signet dashboard${RESET} Open web dashboard

${DIM}Docs: https://signetai.sh/docs${RESET}
`);
