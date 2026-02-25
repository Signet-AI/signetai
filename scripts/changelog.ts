#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeBumpLevel } from "./bump-level";

const CHANGELOG_PATH = "CHANGELOG.md";
const PACKAGE_JSON_PATH = "packages/signetai/package.json";
const CHANGELOG_HEADER =
	"# Changelog\n\nAll notable changes to Signet are documented here.\n";

const INCLUDE_TYPES: Record<string, string> = {
	feat: "Features",
	fix: "Bug Fixes",
	perf: "Performance",
	refactor: "Refactoring",
	docs: "Docs",
};

interface ParsedCommit {
	type: string;
	scope: string | null;
	subject: string;
}

function getPreviousTag(): string | null {
	try {
		return execSync("git describe --tags --abbrev=0", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function getCommitLog(since: string | null): string[] {
	const range = since ? `${since}..HEAD` : "HEAD";
	const output = execSync(`git log ${range} --format=%s`, {
		encoding: "utf8",
	});
	return output
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function parseCommit(line: string): ParsedCommit | null {
	const match = line.match(/^(\w+)(?:\(([^)]*)\))?: (.+)$/);
	if (match === null) return null;

	const type = match[1];
	const scope = match[2] ?? null;
	const subject = match[3];

	if (type === undefined || subject === undefined) return null;

	return { type, scope, subject };
}

function readVersion(): string {
	const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	if (typeof parsed.version !== "string") {
		throw new Error(`Missing version in ${PACKAGE_JSON_PATH}`);
	}
	return parsed.version;
}

function formatEntry(commit: ParsedCommit): string {
	const prefix = commit.scope ? `**${commit.scope}**: ` : "";
	return `- ${prefix}${commit.subject}`;
}

function buildSection(title: string, entries: string[]): string {
	return `### ${title}\n\n${entries.join("\n")}\n`;
}

function buildNewEntry(
	version: string,
	date: string,
	groups: Map<string, string[]>,
): string {
	const sectionOrder = ["feat", "fix", "perf", "refactor", "docs"];
	const sections: string[] = [];

	for (const type of sectionOrder) {
		const entries = groups.get(type);
		const title = INCLUDE_TYPES[type];
		if (entries && entries.length > 0 && title !== undefined) {
			sections.push(buildSection(title, entries));
		}
	}

	return `## [${version}] - ${date}\n\n${sections.join("\n")}\n`;
}

function main(): void {
	const previousTag = getPreviousTag();
	const lines = getCommitLog(previousTag);
	const version = readVersion();
	const date = new Date().toISOString().slice(0, 10);

	const groups = new Map<string, string[]>();

	for (const line of lines) {
		if (line.startsWith("chore: release")) continue;

		const commit = parseCommit(line);
		if (commit === null) continue;
		if (!(commit.type in INCLUDE_TYPES)) continue;

		const entry = formatEntry(commit);
		const existing = groups.get(commit.type);
		if (existing !== undefined) {
			existing.push(entry);
		} else {
			groups.set(commit.type, [entry]);
		}
	}

	// Compute and write bump level for CI
	const allSubjects = lines.filter((l) => !l.startsWith("chore: release"));
	const bumpLevel = computeBumpLevel(allSubjects);
	writeFileSync(".bump-level", bumpLevel);
	console.log(`Bump level: ${bumpLevel}`);

	const totalEntries = [...groups.values()].reduce(
		(sum, arr) => sum + arr.length,
		0,
	);

	if (totalEntries === 0) {
		console.log("No notable commits found. CHANGELOG.md not modified.");
		return;
	}

	const newEntry = buildNewEntry(version, date, groups);

	const existing = existsSync(CHANGELOG_PATH)
		? readFileSync(CHANGELOG_PATH, "utf8")
		: "";

	const body = existing.startsWith("# Changelog")
		? existing.slice(CHANGELOG_HEADER.length)
		: existing;

	writeFileSync(CHANGELOG_PATH, `${CHANGELOG_HEADER}\n${newEntry}${body}`);

	console.log(`Prepended v${version} section to ${CHANGELOG_PATH}.`);
}

main();
