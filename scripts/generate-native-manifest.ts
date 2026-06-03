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

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "dist", "native");
const version = process.env.SIGNET_VERSION ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

if (!existsSync(nativeDir)) {
	throw new Error(`Native artifact directory does not exist: ${nativeDir}`);
}

function platformFromName(name: string): string | null {
	if (name === "native-manifest.json" || name.endsWith(".sha256")) {
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

if (assets.length === 0) {
	throw new Error(`No native Signet binaries found in ${nativeDir}`);
}

const manifest = {
	schemaVersion: 1,
	version,
	assets,
};

const out = join(nativeDir, "native-manifest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}`);
