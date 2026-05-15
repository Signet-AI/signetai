#!/usr/bin/env node
/**
 * Generate manifest.json for a platform's bundle artifacts.
 *
 * Usage: node generate-manifest.ts <version> <platform> <artifact_dir>
 *
 * Reads all .tar.gz files and their .sha256 files from artifact_dir,
 * produces a JSON manifest mapping component names to download URLs and checksums.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PLATFORM_SUFFIXES = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

const [version, platform, artifactDir, releaseTag] = process.argv.slice(2);

if (!version || !platform || !artifactDir) {
	console.error("Usage: generate-manifest.ts <version> <platform> <artifact_dir> [release_tag]");
	process.exit(1);
}

const RELEASE_REPO = "Signet-AI/signetai";
const tag = releaseTag || `bundle-${version}`;
const BASE_URL = `https://github.com/${RELEASE_REPO}/releases/download/${tag}`;

interface Component {
	url: string;
	sha256: string;
	size: number;
}

function parseComponentFromFilename(filename: string): string | null {
	if (!filename.endsWith(".tar.gz")) return null;
	let base = filename.replace(/\.tar\.gz$/, "");
	if (!base.startsWith("signet-")) return null;
	base = base.replace(/^signet-/, "");
	for (const suffix of PLATFORM_SUFFIXES) {
		if (base.endsWith(`-${suffix}`)) {
			base = base.slice(0, -suffix.length - 1);
			break;
		}
	}
	return base;
}

function main() {
	const components: Record<string, Component> = {};

	const files = readdirSync(artifactDir).filter((f) => f.endsWith(".tar.gz"));

	for (const file of files) {
		const component = parseComponentFromFilename(file);
		if (!component) continue;

		if (components[component]) {
			console.error(`Duplicate component key "${component}" from ${file} (already seen)`);
			process.exit(1);
		}

		const shaFile = join(artifactDir, `${file}.sha256`);
		if (!existsSync(shaFile)) {
			console.error(`Missing checksum: ${file}.sha256 — cannot publish unsigned artifact`);
			process.exit(1);
		}
		const content = readFileSync(shaFile, "utf8").trim();
		const sha256 = content.split(/\s+/)[0];
		if (!sha256 || sha256.length < 32) {
			console.error(`Invalid checksum in ${shaFile}: "${content}"`);
			process.exit(1);
		}

		components[component] = {
			url: `${BASE_URL}/${file}`,
			sha256,
			size: statSync(join(artifactDir, file)).size,
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
