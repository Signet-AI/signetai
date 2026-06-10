#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface NativeAsset {
	readonly name: string;
	readonly platform: string;
	readonly sha256: string;
	readonly size: number;
}

interface ComponentEntry {
	readonly url: string;
	readonly sha256: string;
	readonly size: number;
}

type ComponentsMap = {
	readonly connectors?: ComponentEntry;
};

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "dist", "native");
const version = process.env.SIGNET_VERSION ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

if (!existsSync(nativeDir)) {
	throw new Error(`Native artifact directory does not exist: ${nativeDir}`);
}

function platformFromName(name: string): string | null {
	if (
		name === "native-manifest.json" ||
		name.endsWith(".sha256") ||
		// Connector-asset tarball is a component, not a binary. Skip it
		// from the `assets` listing so the install-time platform lookup
		// doesn't accidentally match `connectors-<version>.tar.gz`.
		name.startsWith("signet-connectors-")
	) {
		return null;
	}

	const match = name.match(/^signet-(.+?)(?:\.exe)?$/);
	return match?.[1] ?? null;
}

const assets: NativeAsset[] = readdirSync(nativeDir)
	.flatMap((name) => {
		const platform = platformFromName(name);
		if (!platform) return [];
		const path = join(nativeDir, name);
		const stat = statSync(path);
		if (!stat.isFile()) return [];
		return [
			{
				name,
				platform,
				sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
				size: stat.size,
			},
		];
	})
	.sort((a, b) => a.platform.localeCompare(b.platform));

function loadConnectorComponent(): ComponentEntry | null {
	const tarballName = `signet-connectors-${version}.tar.gz`;
	const tarballPath = join(nativeDir, tarballName);
	if (!existsSync(tarballPath)) return null;
	const stat = statSync(tarballPath);
	if (!stat.isFile() || stat.size === 0) return null;
	const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
	return {
		// The wrapper resolves the manifest URL relative to the GitHub release
		// page that hosts the binary. Keep the path consistent with how the
		// release workflow uploads the tarball.
		url: `signet-connectors-${version}.tar.gz`,
		sha256,
		size: stat.size,
	};
}

if (assets.length === 0 && !loadConnectorComponent()) {
	throw new Error(`No native Signet binaries or connector components found in ${nativeDir}`);
}

const connectors = loadConnectorComponent();
const components: ComponentsMap = connectors ? { connectors: connectors } : {};

const manifest = {
	schemaVersion: 1 as const,
	version,
	assets,
	components,
};

const out = join(nativeDir, "native-manifest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}`);
