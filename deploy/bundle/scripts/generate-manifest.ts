#!/usr/bin/env node
/**
 * Generate manifest.json for a platform's bundle artifacts.
 *
 * Usage: node generate-manifest.ts <version> <platform> <artifact_dir>
 *
 * Reads all .tar.gz files and their .sha256 files from artifact_dir,
 * produces a JSON manifest mapping component names to download URLs and checksums.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [version, platform, artifactDir] = process.argv.slice(2);

if (!version || !platform || !artifactDir) {
	console.error("Usage: generate-manifest.ts <version> <platform> <artifact_dir>");
	process.exit(1);
}

const RELEASE_REPO = "Signet-AI/signetai";
const TAG = "bundle-latest";
const BASE_URL = `https://github.com/${RELEASE_REPO}/releases/download/${TAG}`;

interface Component {
	url: string;
	sha256: string;
	size: number;
}

function parseComponentFromFilename(filename: string): string | null {
	if (!filename.endsWith(".tar.gz")) return null;
	const base = filename.replace(/\.tar\.gz$/, "");
	if (base.startsWith("signet-")) {
		return base.replace(/^signet-/, "");
	}
	return null;
}

function main() {
	const components: Record<string, Component> = {};

	const files = readdirSync(artifactDir).filter((f) => f.endsWith(".tar.gz"));

	for (const file of files) {
		const component = parseComponentFromFilename(file);
		if (!component) continue;

		const shaFile = join(artifactDir, `${file}.sha256`);
		let sha256 = "";
		if (existsSync(shaFile)) {
			const content = readFileSync(shaFile, "utf8").trim();
			sha256 = content.split(/\s+/)[0];
		}

		components[component] = {
			url: `${BASE_URL}/${file}`,
			sha256,
			size: 0,
		};
	}

	const manifest = {
		version,
		generated: new Date().toISOString(),
		platform,
		components,
	};

	console.log(JSON.stringify(manifest, null, 2));
}

main();
