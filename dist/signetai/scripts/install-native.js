#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectNativePlatform, nativePlatforms } from "../bin/native-platforms.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const CONNECTOR_COMPONENT = "connectors";

function isWorkspacePackage() {
	const workspaceRoot = dirname(dirname(packageDir));
	if (basename(dirname(packageDir)) !== "dist") return false;
	try {
		const rootPackageJson = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
		const workspaces = rootPackageJson.workspaces;
		return Array.isArray(workspaces) && workspaces.includes("dist/*");
	} catch {
		return false;
	}
}

function placeBinary(source, destination) {
	try {
		linkSync(source, destination);
	} catch (err) {
		if (err?.code === "EEXIST") {
			unlinkSync(destination);
			try {
				linkSync(source, destination);
			} catch {
				copyFileSync(source, destination);
			}
			return;
		}

		if (err?.code === "EXDEV" || err?.code === "EPERM") {
			copyFileSync(source, destination);
			return;
		}

		throw err;
	}
}

async function main() {
	if (process.env.SIGNET_SKIP_NATIVE_POSTINSTALL === "1" || isWorkspacePackage()) {
		console.log("Skipping Signet native binary linking in workspace install.");
		return;
	}

	const platform = detectNativePlatform();
	const nativePackage = nativePlatforms[platform];
	let source;
	try {
		source = join(dirname(require.resolve(`${nativePackage.packageName}/package.json`)), "bin", nativePackage.binaryName);
	} catch {
		console.error(`Signet native package ${nativePackage.packageName} was not installed.`);
		console.error("The signet wrapper will try to resolve the optional native package at runtime.");
		// Fall through — connector assets are independent of the binary
		// link, so users who only have the wrapper package can still
		// benefit from a populated runtime tree.
		await installConnectorAssets();
		return;
	}

	if (!existsSync(source)) {
		console.error(`Signet native binary is missing from ${nativePackage.packageName}: ${source}`);
		await installConnectorAssets();
		return;
	}

	const installDir = join(packageDir, "native");
	mkdirSync(installDir, { recursive: true });
	const destination = join(installDir, process.platform === "win32" ? "signet.exe" : "signet");
	try {
		placeBinary(source, destination);
		if (process.platform !== "win32") {
			await chmod(destination, 0o755);
		}
		console.log(`Linked Signet native binary for ${platform}`);
	} catch (err) {
		rmSync(destination, { force: true });
		throw err;
	}

	// Connector plugin assets. The native binary has the connector JS
	// compiled in, but each connector's on-disk plugin payload (e.g. the
	// Hermes Python memory provider) ships separately. The wrapper pulls
	// the verified tarball at install time so the runtime can find
	// `$SIGNET_DIR/runtime/connectors/<harness>/...` without a first-run
	// network fetch.
	await installConnectorAssets();
}

function loadManifest() {
	const manifestPath = join(packageDir, "native-manifest.json");
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return null;
	}
}

async function downloadTo(url, destPath) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} fetching ${url}`);
	}
	const arrayBuffer = await response.arrayBuffer();
	writeFileSync(destPath, Buffer.from(arrayBuffer));
}

function verifySha256(path, expected) {
	const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (actual.toLowerCase() !== expected.toLowerCase()) {
		rmSync(path, { force: true });
		throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}`);
	}
}

function nativePackageVersion() {
	try {
		return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
	} catch {
		return "0.0.0";
	}
}

function releaseBaseUrl() {
	// Allow full-URL override (e.g. for mirrors or local file:// testing)
	// before falling back to the GitHub release URL.
	const overrideBase = process.env.SIGNET_DOWNLOAD_BASE?.trim();
	if (overrideBase) return overrideBase.replace(/\/$/, "");
	const repo = process.env.SIGNET_RELEASE_REPO?.trim() || "Signet-AI/signetai";
	const tag = process.env.SIGNET_RELEASE_TAG?.trim() || `v${nativePackageVersion()}`;
	return `https://github.com/${repo}/releases/download/${tag}`;
}

async function installConnectorAssets() {
	const manifest = loadManifest();
	const component = manifest?.components?.[CONNECTOR_COMPONENT];
	if (!component) {
		// No connector assets in this release (e.g. early versions, or the
		// wrapper is running from a workspace without a synced manifest).
		// Skip silently — connectors without runtime assets keep working.
		return;
	}

	const targetDir = join(packageDir, "runtime", "connectors");
	const targetMarker = join(targetDir, ".signet-connectors-version");
	if (
		existsSync(targetMarker) &&
		readFileSync(targetMarker, "utf8").trim() === manifest.version
	) {
		// Already extracted for this version. Skip to keep postinstall fast
		// and to avoid clobbering user-tweaked assets.
		return;
	}

	const tempPath = join(packageDir, `signet-connectors-${manifest.version}.tar.gz.tmp`);
	const url = component.url.startsWith("http")
		? component.url
		: `${releaseBaseUrl()}/${component.url}`;

	try {
		await downloadTo(url, tempPath);
		verifySha256(tempPath, component.sha256);
		const stat = readFileSync(tempPath);
		if (stat.length !== component.size) {
			rmSync(tempPath, { force: true });
			throw new Error(`Tarball size mismatch: expected ${component.size}, got ${stat.length}`);
		}

		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		// Tarball layout is `./runtime/connectors/<harness>/...`. Extract
		// at `<packageDir>/` so the tarball's own `runtime/` prefix
		// lands naturally at `<packageDir>/runtime/connectors/...`.
		mkdirSync(packageDir, { recursive: true });

		const result = spawnSync("tar", ["xzf", tempPath, "-C", packageDir], { stdio: "inherit" });
		if (result.status !== 0) {
			throw new Error(`tar extraction failed with status ${result.status ?? "unknown"}`);
		}
		writeFileSync(targetMarker, `${manifest.version}\n`);
		console.log(`Installed connector assets to ${targetDir}`);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

main().catch((err) => {
	console.error(`Signet native install failed: ${err.message}`);
	process.exit(1);
});
