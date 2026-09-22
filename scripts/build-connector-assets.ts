#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "dist", "native");
const version =
	process.env.SIGNET_VERSION?.trim() || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const stagingRoot = join(nativeDir, "connectors-staging");
const tarballName = `signet-connectors-${version}.tar.gz`;
const tarballPath = join(nativeDir, tarballName);
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

const ASSET_FILE_SUFFIXES = [".py", ".yaml", ".yml", ".md", ".txt", ".json"];

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
	const targetDir = join(stagingRoot, "runtime", "connectors", entry.harness, entry.assetDir);
	mkdirSync(targetDir, { recursive: true });
	for (const file of entry.files) {
		copyFileSync(join(root, "integrations", entry.harness, "connector", entry.assetDir, file), join(targetDir, file));
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
		if (existsSync(tarballPath)) rmSync(tarballPath);
		return;
	}

	for (const entry of entries) {
		console.log(`staged ${entry.files.length} file(s) for ${entry.harness}/${entry.assetDir}`);
	}

	tarGz(stagingRoot, tarballPath);

	const bytes = statSync(tarballPath).size;
	const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
	console.log(`wrote ${tarballPath} (${bytes} bytes, sha256=${sha256.slice(0, 16)}…)`);
}

main();
