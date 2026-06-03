#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectNativePlatform, nativePlatforms } from "./native-platforms.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binaryName = process.platform === "win32" ? "signet.exe" : "signet";
const binaryPath = join(packageDir, "native", binaryName);

function resolveBundledBinaryPath() {
	const platform = detectNativePlatform();
	const nativePackage = nativePlatforms[platform];
	return join(packageDir, "native", platform, nativePackage.binaryName);
}

function resolveBinaryPath() {
	if (existsSync(binaryPath)) return binaryPath;

	try {
		const bundledBinaryPath = resolveBundledBinaryPath();
		if (existsSync(bundledBinaryPath)) return bundledBinaryPath;
	} catch {
		// Fall through to the user-facing install error below.
	}

	return null;
}

export function launchSignet(options = {}) {
	const resolvedBinaryPath = resolveBinaryPath();
	if (!resolvedBinaryPath) {
		console.error("Signet native binary is missing.");
		console.error("Reinstall Signet: npm install -g signetai or bun add -g signetai");
		console.error("The npm package should include native/<platform>/signet for your platform.");
		process.exit(1);
	}

	const args = process.argv.slice(2);
	const forwardedArgs = options.forceMcp === true && args[0] !== "mcp" ? ["mcp", ...args] : args;
	const child = spawn(resolvedBinaryPath, forwardedArgs, {
		stdio: "inherit",
		env: process.env,
		windowsHide: true,
	});

	child.on("error", (err) => {
		console.error(`Failed to start Signet native binary at ${resolvedBinaryPath}: ${err.message}`);
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
