#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binaryName = process.platform === "win32" ? "signet.exe" : "signet";
const binaryPath = join(packageDir, "native", binaryName);

export function launchSignet(options = {}) {
	if (!existsSync(binaryPath)) {
		console.error("Signet native binary is missing.");
		console.error("Reinstall with: npm install -g signetai or bun add -g signetai");
		process.exit(1);
	}

	const args = process.argv.slice(2);
	const forwardedArgs = options.forceMcp === true && args[0] !== "mcp" ? ["mcp", ...args] : args;
	const child = spawn(binaryPath, forwardedArgs, {
		stdio: "inherit",
		env: process.env,
		windowsHide: true,
	});

	child.on("error", (err) => {
		console.error(`Failed to start Signet native binary: ${err.message}`);
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
}
