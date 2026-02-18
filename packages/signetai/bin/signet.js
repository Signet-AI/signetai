#!/usr/bin/env node
/**
 * Signet CLI Entry Point
 *
 * Routes to the appropriate runtime based on command:
 * - Most commands: Node.js (cli.js)
 * - Daemon start: Bun (daemon.js) - required for bun:sqlite
 */

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");

const args = process.argv.slice(2);
const command = args[0];
const subCommand = args[1];

// Commands that actually start the daemon process (require Bun for bun:sqlite)
// Note: 'daemon status', 'daemon stop', 'daemon logs' just query HTTP - no bun needed
const needsBun =
	command === "start" || // alias for daemon start
	(command === "daemon" &&
		(subCommand === "start" || subCommand === "restart"));
const isDaemonCommand = needsBun;

// Check if Bun is available
function hasBun() {
	try {
		const result = spawnSync("bun", ["--version"], { stdio: "pipe" });
		return result.status === 0;
	} catch {
		return false;
	}
}

// Run with appropriate runtime
if (isDaemonCommand && !hasBun()) {
	console.error("Error: Bun is required to run the Signet daemon.");
	console.error("Install Bun: curl -fsSL https://bun.sh/install | bash");
	process.exit(1);
}

// Use the CLI for everything - it handles daemon spawning internally
const cliPath = join(distDir, "cli.js");

if (!existsSync(cliPath)) {
	console.error("Error: CLI not found. Package may be corrupted.");
	console.error("Try reinstalling: npm install -g signetai");
	process.exit(1);
}

// Import and run CLI
import(cliPath).catch((err) => {
	console.error("Failed to start Signet:", err.message);
	process.exit(1);
});
