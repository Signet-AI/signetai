#!/usr/bin/env bun

import { readFileSync, existsSync } from "node:fs";

const CHANGELOG_PATH = "CHANGELOG.md";

function extractSection(version: string): string {
	if (!existsSync(CHANGELOG_PATH)) return "";

	const content = readFileSync(CHANGELOG_PATH, "utf-8");
	const versionHeader = `## [${version}]`;
	const startIdx = content.indexOf(versionHeader);
	if (startIdx < 0) return "";
	const afterHeader = content.indexOf("\n", startIdx);
	if (afterHeader < 0) return content.slice(startIdx);

	const nextSection = content.indexOf("\n## ", afterHeader);
	const section = nextSection >= 0 ? content.slice(startIdx, nextSection) : content.slice(startIdx);

	return section.trim();
}

const version = process.argv[2];
if (!version) {
	console.error("Usage: bun scripts/extract-changelog-section.ts <version>");
	process.exit(1);
}

const section = extractSection(version);
if (section) {
	console.log(section);
} else {
	console.log(`No changelog section found for v${version}`);
}
