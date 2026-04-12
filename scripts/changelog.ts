#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type BumpLevel, computeBumpLevel } from "./bump-level";

const CHANGELOG_PATH = "CHANGELOG.md";
const PACKAGE_JSON_PATH = "packages/signetai/package.json";
const BUMP_LEVEL_PATH = ".bump-level";
const CHANGELOG_HEADER = "# Changelog\n\nAll notable changes to Signet are documented here.";
const HIGHLIGHT_DATE_LIMIT = 7;
const RELEASE_LEDGER_HEADING = "## Release Ledger";
const RECENT_HIGHLIGHTS_HEADING = "## Recent Highlights";
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SECTION_ORDER = ["feat", "fix", "perf", "refactor", "docs"] as const;
const RELEASE_SECTION_RE =
	/^## \[(?<version>[^\]]+)\] - (?<date>\d{4}-\d{2}-\d{2})\n\n(?<body>[\s\S]*?)(?=^## \[|(?![\s\S]))/gm;

const INCLUDE_TYPES: Record<(typeof SECTION_ORDER)[number], string> = {
	feat: "Features",
	fix: "Bug Fixes",
	perf: "Performance",
	refactor: "Refactoring",
	docs: "Docs",
};

const SUMMARY_LABELS: Record<(typeof SECTION_ORDER)[number], readonly [string, string]> = {
	feat: ["feature", "features"],
	fix: ["bug fix", "bug fixes"],
	perf: ["performance improvement", "performance improvements"],
	refactor: ["refactor", "refactors"],
	docs: ["docs update", "docs updates"],
};

export interface ParsedCommit {
	type: string;
	scope: string | null;
	subject: string;
}

export interface CliOptions {
	readonly bumpOnly: boolean;
	readonly rebuild: boolean;
	readonly date?: string;
	readonly version?: string;
}

export interface ReleaseEntryContext {
	readonly currentTag?: string;
	readonly previousTag?: string | null;
}

export interface ReleaseRecord {
	readonly currentTag: string;
	readonly date: string;
	readonly groups: ReadonlyMap<string, readonly string[]>;
	readonly previousTag: string | null;
	readonly version: string;
}

export interface RenderedReleaseSection {
	readonly body: string;
	readonly date: string;
	readonly version: string;
}

function execGit(command: string): string {
	return execSync(command, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

export function getPreviousTag(): string | null {
	try {
		return execGit("git describe --tags --abbrev=0").trim();
	} catch {
		return null;
	}
}

export function getCommitLog(range: string | null): string[] {
	const ref = range ?? "HEAD";
	const output = execGit(`git log ${ref} --format=%s`);
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function getCommitLogForTags(previousTag: string | null, currentTag: string): string[] {
	return getCommitLog(previousTag ? `${previousTag}..${currentTag}` : currentTag);
}

export function parseCommit(line: string): ParsedCommit | null {
	const match = line.match(/^(\w+)(?:\(([^)]*)\))?: (.+)$/);
	if (match === null) return null;

	const type = match[1];
	const scope = match[2] ?? null;
	const subject = match[3];
	if (type === undefined || subject === undefined) return null;
	return { type, scope, subject };
}

export function readVersion(): string {
	const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	if (typeof parsed.version !== "string") {
		throw new Error(`Missing version in ${PACKAGE_JSON_PATH}`);
	}
	return parsed.version;
}

export function formatEntry(commit: ParsedCommit): string {
	const prefix = commit.scope ? `**${commit.scope}**: ` : "";
	return `- ${prefix}${commit.subject}`;
}

export function buildSection(title: string, entries: readonly string[]): string {
	return `### ${title}\n\n${entries.join("\n")}`;
}

export function buildGroups(lines: readonly string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const line of lines) {
		if (line.startsWith("chore: release")) continue;
		const commit = parseCommit(line);
		if (commit === null) continue;
		if (!Object.prototype.hasOwnProperty.call(INCLUDE_TYPES, commit.type)) continue;

		const entry = formatEntry(commit);
		const existing = groups.get(commit.type);
		if (existing) {
			existing.push(entry);
			continue;
		}
		groups.set(commit.type, [entry]);
	}
	return groups;
}

export function countEntries(groups: ReadonlyMap<string, readonly string[]>): number {
	return [...groups.values()].reduce((sum, entries) => sum + entries.length, 0);
}

export function computeAndWriteBumpLevel(lines: readonly string[]): BumpLevel {
	const allSubjects = lines.filter((line) => !line.startsWith("chore: release"));
	const bumpLevel = computeBumpLevel(allSubjects);
	writeFileSync(BUMP_LEVEL_PATH, bumpLevel);
	return bumpLevel;
}

export function pluralize(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function humanJoin(parts: readonly string[]): string {
	if (parts.length === 0) return "";
	if (parts.length === 1) return parts[0] ?? "";
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function buildReleaseSummary(groups: ReadonlyMap<string, readonly string[]>): string {
	const parts = SECTION_ORDER.flatMap((type) => {
		const count = groups.get(type)?.length ?? 0;
		if (count === 0) return [];
		const [singular, plural] = SUMMARY_LABELS[type];
		return [pluralize(count, singular, plural)];
	});

	if (parts.length === 0) {
		return "Release summary: internal maintenance release with no conventional commit entries captured.";
	}

	return `Release summary: ${humanJoin(parts)}.`;
}

export function buildTagRangeLine(
	previousTag: string | null | undefined,
	currentTag: string | undefined,
): string | null {
	if (!previousTag || !currentTag) return null;
	return `Tag range: \`${previousTag}..${currentTag}\`.`;
}

export function buildEmptyReleaseNote(): string {
	return "No notable changes were captured from conventional commit subjects for this release.";
}

export function buildNewEntry(
	version: string,
	date: string,
	groups: ReadonlyMap<string, readonly string[]>,
	ctx: ReleaseEntryContext = {},
): string {
	const metaLines = [buildReleaseSummary(groups)];
	const rangeLine = buildTagRangeLine(ctx.previousTag, ctx.currentTag);
	if (rangeLine) metaLines.push(rangeLine);

	const parts = [`## [${version}] - ${date}`, metaLines.join("\n")];
	if (countEntries(groups) === 0) {
		parts.push(buildEmptyReleaseNote());
		return `${parts.join("\n\n")}\n`;
	}

	const sections = SECTION_ORDER.flatMap((type) => {
		const entries = groups.get(type);
		const title = INCLUDE_TYPES[type];
		if (!entries || entries.length === 0 || title === undefined) return [];
		return [buildSection(title, entries)];
	});

	parts.push(sections.join("\n\n"));
	return `${parts.join("\n\n")}\n`;
}

export function parseRenderedReleaseSections(content: string): RenderedReleaseSection[] {
	const sections: RenderedReleaseSection[] = [];
	for (const match of content.matchAll(RELEASE_SECTION_RE)) {
		const version = match.groups?.version;
		const date = match.groups?.date;
		const body = match.groups?.body;
		if (!version || !date || body === undefined) continue;
		sections.push({ body: body.trim(), date, version });
	}
	return sections;
}

export function extractRenderedSectionStrings(content: string): string[] {
	return parseRenderedReleaseSections(content).map(
		(section) => `## [${section.version}] - ${section.date}\n\n${section.body}`,
	);
}

export function stripHighlightNoise(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("- ")) return null;
	return trimmed
		.slice(2)
		.replace(/^\*\*([^*]+)\*\*: /, "")
		.replace(/ \(#\d+\)$/g, "")
		.replace(/`/g, "")
		.trim();
}

export function buildHighlightBullets(sections: readonly RenderedReleaseSection[]): string[] {
	const byDate = new Map<string, Map<string, string[]>>();

	for (const section of sections) {
		const dateMap = byDate.get(section.date) ?? new Map<string, string[]>();
		let currentHeading: string | null = null;
		for (const line of section.body.split("\n")) {
			if (line.startsWith("### ")) {
				currentHeading = line.slice(4).trim();
				continue;
			}
			const cleaned = stripHighlightNoise(line);
			if (!cleaned || !currentHeading) continue;
			const existing = dateMap.get(currentHeading) ?? [];
			if (!existing.includes(cleaned)) {
				existing.push(cleaned);
			}
			dateMap.set(currentHeading, existing);
		}
		if (!byDate.has(section.date)) byDate.set(section.date, dateMap);
	}

	const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : -1)).slice(0, HIGHLIGHT_DATE_LIMIT);
	const bullets: string[] = [];
	for (const date of dates) {
		const dateMap = byDate.get(date);
		if (!dateMap) continue;

		const dateLines = Object.values(INCLUDE_TYPES).flatMap((heading) => {
			const entries = dateMap.get(heading);
			if (!entries || entries.length === 0) return [];
			const label = heading === "Bug Fixes" ? "Bug fixes" : heading;
			return [`- ${label}: ${entries.join("; ")}.`];
		});
		if (dateLines.length === 0) continue;

		bullets.push(`### ${date}`, ...dateLines, "");
	}
	return bullets;
}

export function buildRecentHighlights(sections: readonly string[]): string {
	const parsed = parseRenderedReleaseSections(sections.join("\n\n"));
	const bullets = buildHighlightBullets(parsed);
	const intro =
		"Surface summary of the most recent release dates. See the release ledger below for exact version-by-version history.";
	if (bullets.length === 0) {
		return `${RECENT_HIGHLIGHTS_HEADING}\n\n${intro}\n\n- No recent highlights available.`;
	}
	return `${RECENT_HIGHLIGHTS_HEADING}\n\n${intro}\n\n${bullets.join("\n")}`.trimEnd();
}

export function buildDocumentFromSections(sections: readonly string[]): string {
	const highlights = buildRecentHighlights(sections);
	const ledger = `${RELEASE_LEDGER_HEADING}\n\n${sections.join("\n\n")}`;
	return `${CHANGELOG_HEADER}\n\n${highlights}\n\n${ledger}\n`;
}

export function prependChangelogEntry(newEntry: string): void {
	const existing = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, "utf8") : "";
	const sections = extractRenderedSectionStrings(existing);
	writeFileSync(CHANGELOG_PATH, buildDocumentFromSections([newEntry.trim(), ...sections]));
}

export function listVersionTags(): string[] {
	const output = execGit("git tag --sort=v:refname");
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => TAG_PATTERN.test(line));
}

export function getTagDate(tag: string): string {
	return execGit(`git log -1 --format=%ad --date=short ${tag}`).trim();
}

export function buildReleaseRecord(previousTag: string | null, currentTag: string): ReleaseRecord {
	const version = currentTag.slice(1);
	const date = getTagDate(currentTag);
	const groups = buildGroups(getCommitLogForTags(previousTag, currentTag));
	return { currentTag, date, groups, previousTag, version };
}

export function buildFullChangelog(tags: readonly string[]): string {
	const sections: string[] = [];
	let previousTag: string | null = null;
	for (const currentTag of tags) {
		const record = buildReleaseRecord(previousTag, currentTag);
		sections.push(
			buildNewEntry(record.version, record.date, record.groups, {
				currentTag: record.currentTag,
				previousTag: record.previousTag,
			}).trim(),
		);
		previousTag = currentTag;
	}
	return buildDocumentFromSections(sections.reverse());
}

export function writeFullChangelog(): number {
	const tags = listVersionTags();
	writeFileSync(CHANGELOG_PATH, buildFullChangelog(tags));
	return tags.length;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	let bumpOnly = false;
	let rebuild = false;
	let date: string | undefined;
	let version: string | undefined;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--bump-only") {
			bumpOnly = true;
			continue;
		}
		if (arg === "--rebuild") {
			rebuild = true;
			continue;
		}
		if (arg === "--version") {
			const next = argv[i + 1];
			if (!next) throw new Error("Missing value for --version");
			version = next;
			i += 1;
			continue;
		}
		if (arg === "--date") {
			const next = argv[i + 1];
			if (!next) throw new Error("Missing value for --date");
			date = next;
			i += 1;
		}
	}

	if (bumpOnly && rebuild) {
		throw new Error("--bump-only and --rebuild cannot be used together");
	}

	return { bumpOnly, rebuild, date, version };
}

export function resolveDate(explicitDate?: string): string {
	return explicitDate ?? new Date().toISOString().slice(0, 10);
}

export function resolveVersion(explicitVersion?: string): string {
	return explicitVersion ?? readVersion();
}

export function runChangelog(opts: CliOptions): { readonly bumpLevel: BumpLevel; readonly wroteEntry: boolean } {
	if (opts.rebuild) {
		const count = writeFullChangelog();
		console.log(`Rebuilt ${CHANGELOG_PATH} from ${count} tags.`);
		return { bumpLevel: "patch", wroteEntry: true };
	}

	const previousTag = getPreviousTag();
	const lines = getCommitLog(previousTag ? `${previousTag}..HEAD` : "HEAD");
	const bumpLevel = computeAndWriteBumpLevel(lines);
	console.log(`Bump level: ${bumpLevel}`);
	if (opts.bumpOnly) {
		return { bumpLevel, wroteEntry: false };
	}

	const groups = buildGroups(lines);
	const version = resolveVersion(opts.version);
	const date = resolveDate(opts.date);
	const newEntry = buildNewEntry(version, date, groups, {
		currentTag: `v${version}`,
		previousTag,
	});
	prependChangelogEntry(newEntry);
	console.log(`Prepended v${version} section to ${CHANGELOG_PATH}.`);
	return { bumpLevel, wroteEntry: true };
}

if (import.meta.main) {
	runChangelog(parseCliArgs(process.argv.slice(2)));
}
