#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectNativePlatform, nativePlatforms } from "./native-platforms.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const binaryName = process.platform === "win32" ? "signet.exe" : "signet";
const binaryPath = join(packageDir, "native", binaryName);
const connectorAssetsPath = join(packageDir, "runtime", "connectors");

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

function hasConnectorAssets() {
	try {
		return (
			existsSync(connectorAssetsPath) &&
			existsSync(join(connectorAssetsPath, ".signet-connectors-version")) &&
			readFileSync(join(connectorAssetsPath, ".signet-connectors-version"), "utf8").trim().length > 0
		);
	} catch {
		return false;
	}
}

function connectorAssetsRequired() {
	try {
		const manifest = JSON.parse(readFileSync(join(packageDir, "native-manifest.json"), "utf8"));
		return (
			typeof manifest === "object" &&
			manifest !== null &&
			"components" in manifest &&
			typeof manifest.components === "object" &&
			manifest.components !== null &&
			"connectors" in manifest.components
		);
	} catch {
		return false;
	}
}

function warnIfInstallAssetsMissing(resolvedBinaryPath) {
	const missing = [];
	if (resolvedBinaryPath !== binaryPath) missing.push("native/");
	if (connectorAssetsRequired() && !hasConnectorAssets()) missing.push("runtime/connectors/");
	if (missing.length === 0) return;

	console.error(`Signet install assets are incomplete: missing ${missing.join(" and ")}.`);
	if (resolvedBinaryPath !== binaryPath) {
		console.error("The platform native package is installed, but Signet's postinstall did not finish linking the wrapper assets.");
	} else {
		console.error("Signet's postinstall did not finish installing all required wrapper assets.");
	}
	console.error("If Bun blocked the lifecycle script, run `bun pm -g untrusted`, trust Signet's postinstall, then reinstall with `bun add -g signetai`.");
	console.error("If the postinstall failed, reinstall with npm or use the official installer from https://signetai.sh/install.sh.");
}

export function launchSignet() {
	const resolvedBinaryPath = resolveBinaryPath();
	if (!resolvedBinaryPath) {
		console.error("Signet native binary is missing.");
		console.error("Reinstall Signet: npm install -g signetai or bun add -g signetai");
		console.error("The npm package should install the matching native optional dependency for your platform.");
		process.exit(1);
	}

	warnIfInstallAssetsMissing(resolvedBinaryPath);

	// Point the binary at the wrapper's installed runtime tree so the
	// connector's `getPluginSourceDir()` `SIGNET_DIR/runtime/connectors/...`
	// fallback can find per-harness plugin assets that the native binary
	// doesn't carry inline. The env is only set when the wrapper actually
	// has a runtime tree to share; the binary's own bootstrap can derive
	// its own path otherwise.
	const env = {
		...process.env,
		SIGNET_WRAPPER_DIR: packageDir,
		// The wrapper is the explicit package-manager distribution boundary.
		// Preserve an operator override for source, container, or CI launches.
		SIGNET_TELEMETRY_INSTALL_CHANNEL: process.env.SIGNET_TELEMETRY_INSTALL_CHANNEL ?? "package-manager",
	};
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
