#!/usr/bin/env node
/**
 * Signet postinstall script (CommonJS for npm compatibility)
 * Shows installation info and checks for Bun
 */

const { execFileSync } = require("node:child_process");

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function hasBun() {
	try {
		execFileSync("bun", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function getVersion() {
	try {
		const pkg = require("../package.json");
		return pkg.version || null;
	} catch {
		return null;
	}
}

const version = getVersion();
const versionLabel = version ? ` v${version}` : "";

console.log();
console.log("━".repeat(50));
console.log();
console.log(`  ${CYAN}${BOLD}◈ Signet${RESET}${versionLabel} installed!`);
console.log(`  ${DIM}Portable AI agent identity${RESET}`);
console.log();

if (!hasBun()) {
	console.log(`  ${YELLOW}⚠ Bun not found${RESET}`);
	console.log(`  ${DIM}CLI commands work fine with Node.js:${RESET}`);
	console.log(`  ${DIM}  signet, signet status, signet recall, etc.${RESET}`);
	console.log();
	console.log(`  ${DIM}Bun is required for the daemon (signet start):${RESET}`);
	console.log(`  ${DIM}  curl -fsSL https://bun.sh/install | bash${RESET}`);
	console.log();
}

console.log(`  ${GREEN}What's new:${RESET}`);
console.log(`  ${DIM}- Knowledge graph: memories build structured understanding${RESET}`);
console.log(`  ${DIM}- Session continuity: seamless context across compactions${RESET}`);
console.log(`  ${DIM}- Constellation: entity overlay in the dashboard${RESET}`);
console.log(`  ${DIM}- Predictive scorer: opt-in ML-based memory ranking${RESET}`);
console.log();
console.log(`  ${GREEN}Get started:${RESET}`);
console.log(`    ${CYAN}signet${RESET}        Interactive setup`);
console.log(`    ${CYAN}signet sync${RESET}   Fix missing files`);
console.log(`    ${CYAN}signet status${RESET} Check daemon`);
console.log(`    ${CYAN}signet dashboard${RESET}  Explore your agent`);
console.log();
console.log("━".repeat(50));
console.log();
