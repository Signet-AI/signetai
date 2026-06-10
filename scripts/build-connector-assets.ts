#!/usr/bin/env bun

/**
 * Stage runtime plugin assets shipped by Signet connectors into a single
 * tarball that the native-bundle install path unpacks next to the Signet
 * binary. Connectors that only write config (no on-disk plugin files) are
 * skipped — they have nothing to stage.
 *
 * The tarball layout mirrors what the connectors' `getPluginSourceDir`
 * fallbacks already look for under `$SIGNET_DIR/runtime/connectors/<harness>/`.
 * For example, the Hermes connector's Python plugin ends up at:
 *
 *   runtime/connectors/hermes-agent/hermes-plugin/__init__.py
 *   runtime/connectors/hermes-agent/hermes-plugin/client.py
 *   runtime/connectors/hermes-agent/hermes-plugin/plugin.yaml
 *   runtime/connectors/hermes-agent/hermes-plugin/README.md
 *
 * This restores the asset-shipping side of v0.135.0's bundle.yml, which
 * #816 dropped when collapsing the runtime into a single `--compile`'d
 * binary. Connector JS is still compiled in; only files the harness's
 * own runtime loads (e.g. Python for Hermes) need to be external.
 *
 * Output: <root>/dist/native/signet-connectors-<version>.tar.gz
 */

import {
	createHash,
} from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "dist", "native");
const version =
	process.env.SIGNET_VERSION?.trim() ||
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const stagingRoot = join(nativeDir, "connectors-staging");
const tarballName = `signet-connectors-${version}.tar.gz`;
const tarballPath = join(nativeDir, tarballName);

// Asset directories the build will copy through. These are the on-disk
// payloads a connector relies on at install time and the harness loads
// at runtime. Anything else under `integrations/<harness>/connector/` is
// source/test/build artifacts that must not be shipped.
const SKIP_NAMES = new Set([
	"dist",
	"node_modules",
	"src",
	"scripts",
	"test",
	"index.test.ts",
	"tsconfig.json",
	"package.json",
	".gitignore",
]);

const ASSET_FILE_SUFFIXES = [
	".py",
	".yaml",
	".yml",
	".md",
	".txt",
	".json",
];

interface AssetEntry {
	readonly harness: string;
	readonly assetDir: string;
	readonly files: readonly string[];
}

function listConnectors(): string[] {
	const integrationsDir = join(root, "integrations");
	if (!existsSync(integrationsDir)) {
		throw new Error(`Integrations directory missing: ${integrationsDir}`);
	}
	const harnesses: string[] = [];
	for (const name of readdirSync(integrationsDir)) {
		const connectorDir = join(integrationsDir, name, "connector");
		if (existsSync(join(connectorDir, "package.json"))) {
			harnesses.push(name);
		}
	}
	return harnesses;
}

function collectAssetEntries(harness: string): AssetEntry[] {
	const connectorDir = join(root, "integrations", harness, "connector");
	const entries: AssetEntry[] = [];

	for (const name of readdirSync(connectorDir)) {
		if (SKIP_NAMES.has(name)) continue;
		const full = join(connectorDir, name);
		const stat = statSync(full);
		if (!stat.isDirectory()) continue;

		// Only pick up directories that contain at least one file matching
		// a known asset suffix. This keeps generated dirs (e.g. dist/) from
		// sneaking through, and rejects empty placeholder directories.
		const files: string[] = [];
		for (const inner of readdirSync(full)) {
			const innerFull = join(full, inner);
			if (!statSync(innerFull).isFile()) continue;
			if (!ASSET_FILE_SUFFIXES.some((suffix) => inner.endsWith(suffix))) continue;
			files.push(inner);
		}
		if (files.length === 0) continue;

		entries.push({ harness, assetDir: name, files });
	}

	return entries;
}

function stageAsset(entry: AssetEntry, stagingRoot: string): void {
	const targetDir = join(
		stagingRoot,
		"runtime",
		"connectors",
		entry.harness,
		entry.assetDir,
	);
	mkdirSync(targetDir, { recursive: true });
	for (const file of entry.files) {
		copyFileSync(
			join(root, "integrations", entry.harness, "connector", entry.assetDir, file),
			join(targetDir, file),
		);
	}
}

function tarGz(stagingSource: string, tarballPath: string): void {
	const result = spawnSync("tar", ["czf", tarballPath, "-C", stagingSource, "."], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`tar exited with status ${result.status ?? "unknown"}`);
	}
}

function main(): void {
	if (!existsSync(nativeDir)) {
		mkdirSync(nativeDir, { recursive: true });
	}

	// Clean and re-stage. Cached tarballs are removed so re-runs always
	// reflect the current tree.
	if (existsSync(stagingRoot)) {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
	mkdirSync(stagingRoot, { recursive: true });

	const entries: AssetEntry[] = [];
	for (const harness of listConnectors()) {
		for (const entry of collectAssetEntries(harness)) {
			stageAsset(entry, stagingRoot);
			entries.push(entry);
		}
	}

	if (entries.length === 0) {
		console.log("No connector runtime assets to stage; skipping tarball.");
		// Remove any stale tarball from a prior release that may have shipped
		// these assets so the manifest and install flow stay consistent.
		if (existsSync(tarballPath)) rmSync(tarballPath);
		return;
	}

	for (const entry of entries) {
		console.log(
			`staged ${entry.files.length} file(s) for ${entry.harness}/${entry.assetDir}`,
		);
	}

	tarGz(stagingRoot, tarballPath);

	const bytes = statSync(tarballPath).size;
	const sha256 = createHash("sha256")
		.update(readFileSync(tarballPath))
		.digest("hex");
	console.log(
		`wrote ${tarballPath} (${bytes} bytes, sha256=${sha256.slice(0, 16)}…)`,
	);
}

main();
