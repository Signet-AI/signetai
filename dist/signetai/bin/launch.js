#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectNativePlatform, nativePlatforms } from "./native-platforms.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const binaryName = process.platform === "win32" ? "signet.exe" : "signet";
const binaryPath = join(packageDir, "native", binaryName);

function resolveNativePackageBinaryPath() {
	const platform = detectNativePlatform();
	const nativePackage = nativePlatforms[platform];
	const packageJsonPath = require.resolve(`${nativePackage.packageName}/package.json`);
	return join(dirname(packageJsonPath), "bin", nativePackage.binaryName);
}

function resolveBinaryPath() {
	if (existsSync(binaryPath)) return binaryPath;

	try {
		const packageBinaryPath = resolveNativePackageBinaryPath();
		if (existsSync(packageBinaryPath)) return packageBinaryPath;
	} catch {
		// Fall through to the user-facing install error below.
	}

	return null;
}

export function launchSignet() {
	const resolvedBinaryPath = resolveBinaryPath();
	if (!resolvedBinaryPath) {
		console.error("Signet native binary is missing.");
		console.error("Reinstall Signet: npm install -g signetai or bun add -g signetai");
		console.error("The npm package should install the matching native optional dependency for your platform.");
		process.exit(1);
	}

	// Point the binary at the wrapper's installed runtime tree so the
	// connector's `getPluginSourceDir()` `SIGNET_DIR/runtime/connectors/...`
	// fallback can find per-harness plugin assets that the native binary
	// doesn't carry inline. The env is only set when the wrapper actually
	// has a runtime tree to share; the binary's own bootstrap can derive
	// its own path otherwise.
	const env = { ...process.env };
	if (!env.SIGNET_DIR && existsSync(join(packageDir, "runtime", "connectors"))) {
		env.SIGNET_DIR = packageDir;
	}

	const args = process.argv.slice(2);
	const child = spawn(resolvedBinaryPath, args, {
		stdio: "inherit",
		env,
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
