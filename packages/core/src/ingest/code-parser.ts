/**
 * Code Repository Parser for the ingestion engine.
 *
 * Parses a git repository directory to extract:
 * - README.md content (project overview, setup instructions)
 * - package.json / pyproject.toml / Cargo.toml (dependencies, scripts)
 * - Config files (.env.example, docker-compose.yml, etc.)
 * - Git log (recent commit messages for architecture decisions, bug patterns)
 * - Function/class extraction for major languages
 * - Language detection from file extensions
 *
 * Produces a ParsedDocument with sections for architecture, dependencies,
 * patterns, and recent development activity.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename, extname, relative } from "path";
import { execFileSync } from "child_process";
import type { ParsedDocument, ParsedSection } from "./types";
import { findGit } from "./git-utils";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Max characters to read from any single file */
const MAX_FILE_CHARS = 50_000;

/** Max commits to parse from git log */
const DEFAULT_GIT_LOG_DEPTH = 100;

/** Files to always look for at the repo root */
const IMPORTANT_FILES = [
	"README.md",
	"readme.md",
	"README",
	"readme.rst",
	"ARCHITECTURE.md",
	"CONTRIBUTING.md",
	"CHANGELOG.md",
	"LICENSE",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"build.gradle",
	"pom.xml",
	"Gemfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"Dockerfile",
	".env.example",
	".env.sample",
	"Makefile",
	"tsconfig.json",
	"webpack.config.js",
	"vite.config.ts",
	"vite.config.js",
];

/** Directories to skip when scanning */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".nuxt",
	"__pycache__",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"venv",
	".venv",
	"env",
	"vendor",
	"coverage",
	".cache",
	".turbo",
]);

/** Language detection by file extension */
const LANG_MAP: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".py": "Python",
	".rs": "Rust",
	".go": "Go",
	".java": "Java",
	".kt": "Kotlin",
	".scala": "Scala",
	".rb": "Ruby",
	".php": "PHP",
	".swift": "Swift",
	".c": "C",
	".cpp": "C++",
	".h": "C",
	".hpp": "C++",
	".cs": "C#",
	".sh": "Shell",
	".bash": "Shell",
	".zsh": "Shell",
	".sql": "SQL",
	".r": "R",
	".lua": "Lua",
	".ex": "Elixir",
	".exs": "Elixir",
	".erl": "Erlang",
	".hs": "Haskell",
	".ml": "OCaml",
	".vue": "Vue",
	".svelte": "Svelte",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a git repository directory into a ParsedDocument.
 *
 * @param repoPath - Path to the repository root (must have .git/)
 * @param options - Optional configuration
 */
export function parseCodeRepository(
	repoPath: string,
	options?: {
		/** Include git log analysis (default: true) */
		readonly includeGitLog?: boolean;
		/** Max commits to parse (default: 100) */
		readonly gitLogDepth?: number;
		/** Only include specific file patterns */
		readonly includePatterns?: string[];
	},
): ParsedDocument {
	const sections: ParsedSection[] = [];
	let totalChars = 0;

	const repoName = basename(repoPath);
	const includeGitLog = options?.includeGitLog !== false;
	const gitLogDepth = options?.gitLogDepth ?? DEFAULT_GIT_LOG_DEPTH;

	// 1. Detect languages
	const languages = detectLanguages(repoPath);
	if (languages.length > 0) {
		const langSection = buildLanguageSection(languages);
		sections.push(langSection);
		totalChars += langSection.content.length;
	}

	// 2. Parse important root files (README, package.json, etc.)
	const rootSections = parseImportantFiles(repoPath);
	for (const section of rootSections) {
		sections.push(section);
		totalChars += section.content.length;
	}

	// 3. Parse git log
	if (includeGitLog && existsSync(join(repoPath, ".git"))) {
		const gitSections = parseGitLog(repoPath, gitLogDepth);
		for (const section of gitSections) {
			sections.push(section);
			totalChars += section.content.length;
		}
	}

	// 4. Extract functions/classes from source files
	const codeSections = extractCodeStructure(repoPath, languages);
	for (const section of codeSections) {
		sections.push(section);
		totalChars += section.content.length;
	}

	return {
		format: "git_repo",
		title: `Repository: ${repoName}`,
		sections,
		metadata: {
			sourceType: "code_repo",
			repoName,
			languages: languages.map((l) => l.language),
			fileCount: languages.reduce((sum, l) => sum + l.fileCount, 0),
		},
		totalChars,
	};
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

interface LanguageStats {
	readonly language: string;
	readonly fileCount: number;
	readonly extensions: string[];
}

function detectLanguages(repoPath: string): LanguageStats[] {
	const extCounts = new Map<string, number>();
	countExtensions(repoPath, extCounts, 0);

	// Group by language
	const langMap = new Map<string, { count: number; exts: Set<string> }>();
	for (const [ext, count] of extCounts) {
		const lang = LANG_MAP[ext];
		if (!lang) continue;
		const entry = langMap.get(lang) ?? { count: 0, exts: new Set() };
		entry.count += count;
		entry.exts.add(ext);
		langMap.set(lang, entry);
	}

	return [...langMap.entries()]
		.map(([language, { count, exts }]) => ({
			language,
			fileCount: count,
			extensions: [...exts],
		}))
		.sort((a, b) => b.fileCount - a.fileCount);
}

function countExtensions(
	dirPath: string,
	counts: Map<string, number>,
	depth: number,
): void {
	if (depth > 6) return; // Don't recurse too deep

	let entries: string[];
	try {
		entries = readdirSync(dirPath);
	} catch {
		return;
	}

	for (const name of entries) {
		if (name.startsWith(".")) continue;
		if (SKIP_DIRS.has(name)) continue;

		const fullPath = join(dirPath, name);

		try {
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				countExtensions(fullPath, counts, depth + 1);
			} else if (stat.isFile()) {
				const ext = extname(name).toLowerCase();
				if (ext && LANG_MAP[ext]) {
					counts.set(ext, (counts.get(ext) ?? 0) + 1);
				}
			}
		} catch {
			// Skip inaccessible entries
		}
	}
}

function buildLanguageSection(languages: LanguageStats[]): ParsedSection {
	const lines = ["Languages detected in repository:\n"];
	for (const lang of languages) {
		lines.push(`- ${lang.language}: ${lang.fileCount} files (${lang.extensions.join(", ")})`);
	}
	return {
		heading: "Languages & Tech Stack",
		depth: 1,
		content: lines.join("\n"),
		contentType: "text",
	};
}

// ---------------------------------------------------------------------------
// Parse important root files
// ---------------------------------------------------------------------------

function parseImportantFiles(repoPath: string): ParsedSection[] {
	const sections: ParsedSection[] = [];

	for (const fileName of IMPORTANT_FILES) {
		const filePath = join(repoPath, fileName);
		if (!existsSync(filePath)) continue;

		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) continue;
			if (stat.size > MAX_FILE_CHARS) continue;

			const content = readFileSync(filePath, "utf-8").slice(0, MAX_FILE_CHARS);
			const lowerName = fileName.toLowerCase();

			if (lowerName.endsWith(".json")) {
				const section = parseJsonConfig(fileName, content);
				if (section) sections.push(section);
			} else if (lowerName === "dockerfile" || lowerName === "docker-compose.yml" || lowerName === "docker-compose.yaml") {
				sections.push({
					heading: `Infrastructure: ${fileName}`,
					depth: 2,
					content: content.trim(),
					contentType: "code",
					language: lowerName === "dockerfile" ? "dockerfile" : "yaml",
				});
			} else if (lowerName.endsWith(".toml")) {
				const section = parseTomlConfig(fileName, content);
				if (section) sections.push(section);
			} else if (lowerName.startsWith(".env")) {
				sections.push({
					heading: `Configuration: ${fileName}`,
					depth: 2,
					content: content.trim(),
					contentType: "code",
					language: "env",
				});
			} else if (lowerName === "makefile") {
				sections.push({
					heading: `Build: ${fileName}`,
					depth: 2,
					content: content.trim(),
					contentType: "code",
					language: "makefile",
				});
			} else {
				// README, ARCHITECTURE, CONTRIBUTING, CHANGELOG, etc.
				sections.push({
					heading: fileName,
					depth: 1,
					content: content.trim(),
					contentType: "text",
				});
			}
		} catch {
			// Skip unreadable files
		}
	}

	return sections;
}

function parseJsonConfig(fileName: string, content: string): ParsedSection | null {
	try {
		const parsed = JSON.parse(content);

		if (fileName.toLowerCase() === "package.json") {
			return parsePackageJson(parsed);
		}

		if (fileName.toLowerCase() === "tsconfig.json") {
			return {
				heading: "Configuration: tsconfig.json",
				depth: 2,
				content: `TypeScript Configuration:\n${JSON.stringify(parsed, null, 2)}`,
				contentType: "code",
				language: "json",
			};
		}

		// Generic JSON config
		return {
			heading: `Configuration: ${fileName}`,
			depth: 2,
			content: JSON.stringify(parsed, null, 2).slice(0, MAX_FILE_CHARS),
			contentType: "code",
			language: "json",
		};
	} catch {
		return null;
	}
}

function parsePackageJson(pkg: Record<string, unknown>): ParsedSection {
	const lines: string[] = [];

	if (pkg.name) lines.push(`Package: ${pkg.name}`);
	if (pkg.version) lines.push(`Version: ${pkg.version}`);
	if (pkg.description) lines.push(`Description: ${pkg.description}`);
	if (pkg.license) lines.push(`License: ${pkg.license}`);

	// Dependencies
	const deps = pkg.dependencies as Record<string, string> | undefined;
	const devDeps = pkg.devDependencies as Record<string, string> | undefined;

	if (deps && Object.keys(deps).length > 0) {
		lines.push(`\nDependencies (${Object.keys(deps).length}):`);
		for (const [name, version] of Object.entries(deps)) {
			lines.push(`  - ${name}: ${version}`);
		}
	}

	if (devDeps && Object.keys(devDeps).length > 0) {
		lines.push(`\nDev Dependencies (${Object.keys(devDeps).length}):`);
		for (const [name, version] of Object.entries(devDeps)) {
			lines.push(`  - ${name}: ${version}`);
		}
	}

	// Scripts
	const scripts = pkg.scripts as Record<string, string> | undefined;
	if (scripts && Object.keys(scripts).length > 0) {
		lines.push(`\nScripts:`);
		for (const [name, cmd] of Object.entries(scripts)) {
			lines.push(`  - ${name}: ${cmd}`);
		}
	}

	// Engines
	if (pkg.engines) {
		lines.push(`\nEngines: ${JSON.stringify(pkg.engines)}`);
	}

	return {
		heading: "Dependencies: package.json",
		depth: 2,
		content: lines.join("\n"),
		contentType: "text",
	};
}

function parseTomlConfig(fileName: string, content: string): ParsedSection | null {
	return {
		heading: `Configuration: ${fileName}`,
		depth: 2,
		content: content.trim(),
		contentType: "code",
		language: "toml",
	};
}

// ---------------------------------------------------------------------------
// Git log parsing
// ---------------------------------------------------------------------------

function parseGitLog(repoPath: string, maxCommits: number): ParsedSection[] {
	const sections: ParsedSection[] = [];

	try {
		// Find git executable
		const gitPath = findGit();
		if (!gitPath) return sections;

		// Get recent commit log with a useful format
		const logOutput = execFileSync(gitPath, [
			"log",
			`--max-count=${maxCommits}`,
			"--pretty=format:%H|%an|%ad|%s",
			"--date=short",
		], {
			cwd: repoPath,
			encoding: "utf-8",
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
		});

		if (logOutput.trim()) {
			const commits = logOutput.trim().split("\n");
			const filteredCommits = commits.filter((line) => {
				const parts = line.split("|");
				const subject = parts[3] || "";
				// Filter out trivial commits
				return !isTrivialCommit(subject);
			});

			if (filteredCommits.length > 0) {
				const commitLines = filteredCommits.map((line) => {
					const [hash, author, date, ...subjectParts] = line.split("|");
					const subject = subjectParts.join("|");
					return `[${date}] ${author}: ${subject}`;
				});

				sections.push({
					heading: "Git History: Recent Commits",
					depth: 2,
					content: `Recent significant commits (${filteredCommits.length} of ${commits.length} total):\n\n${commitLines.join("\n")}`,
					contentType: "text",
				});
			}
		}

		// Get contributor summary
		const shortlogOutput = execFileSync(gitPath, [
			"shortlog",
			"-sn",
			"--no-merges",
			"HEAD",
		], {
			cwd: repoPath,
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		});

		if (shortlogOutput.trim()) {
			sections.push({
				heading: "Contributors",
				depth: 2,
				content: `Contributors by commit count:\n\n${shortlogOutput.trim()}`,
				contentType: "text",
			});
		}

		// Get recent branch names (architecture signals)
		const branchOutput = execFileSync(gitPath, [
			"branch",
			"-a",
			"--sort=-committerdate",
			"--format=%(refname:short) (%(committerdate:short))",
		], {
			cwd: repoPath,
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		});

		if (branchOutput.trim()) {
			const branches = branchOutput.trim().split("\n").slice(0, 20);
			sections.push({
				heading: "Active Branches",
				depth: 2,
				content: `Recent branches:\n\n${branches.join("\n")}`,
				contentType: "text",
			});
		}
	} catch {
		// Git operations can fail for many reasons — not fatal
	}

	return sections;
}

function isTrivialCommit(subject: string): boolean {
	const lower = subject.toLowerCase().trim();
	return (
		lower === "fix typo" ||
		lower === "fix typos" ||
		lower.startsWith("merge branch") ||
		lower.startsWith("merge pull request") ||
		lower === "update readme" ||
		lower === "update readme.md" ||
		lower === "initial commit" ||
		lower.startsWith("bump version") ||
		lower.startsWith("chore: bump") ||
		lower === "wip" ||
		lower === "." ||
		lower === "temp" ||
		lower === "tmp" ||
		lower.length < 5
	);
}

// ---------------------------------------------------------------------------
// Code structure extraction (functions/classes)
// ---------------------------------------------------------------------------

function extractCodeStructure(
	repoPath: string,
	languages: LanguageStats[],
): ParsedSection[] {
	const sections: ParsedSection[] = [];

	// Only extract from top languages (limit work)
	const topLangs = languages.slice(0, 3);
	const relevantExts = new Set<string>();
	for (const lang of topLangs) {
		for (const ext of lang.extensions) {
			relevantExts.add(ext);
		}
	}

	if (relevantExts.size === 0) return sections;

	// Scan for source files and extract exports/definitions
	const definitions = scanDefinitions(repoPath, relevantExts, 0);

	if (definitions.length > 0) {
		const grouped = groupDefinitionsByFile(definitions, repoPath);
		const content = grouped
			.map(({ file, defs }) => {
				return `${file}:\n${defs.map((d) => `  - ${d.kind} ${d.name}`).join("\n")}`;
			})
			.join("\n\n");

		sections.push({
			heading: "Code Structure: Exported Functions & Classes",
			depth: 2,
			content: `Key exports and definitions:\n\n${content}`,
			contentType: "text",
		});
	}

	return sections;
}

interface CodeDefinition {
	readonly filePath: string;
	readonly kind: "function" | "class" | "interface" | "type" | "const" | "def" | "module";
	readonly name: string;
	readonly line: number;
}

function scanDefinitions(
	dirPath: string,
	extensions: Set<string>,
	depth: number,
): CodeDefinition[] {
	if (depth > 5) return [];

	const definitions: CodeDefinition[] = [];
	let entries: string[];

	try {
		entries = readdirSync(dirPath);
	} catch {
		return definitions;
	}

	for (const name of entries) {
		if (name.startsWith(".")) continue;
		if (SKIP_DIRS.has(name)) continue;

		const fullPath = join(dirPath, name);

		try {
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				definitions.push(...scanDefinitions(fullPath, extensions, depth + 1));
			} else if (stat.isFile()) {
				const ext = extname(name).toLowerCase();
				if (!extensions.has(ext)) continue;
				if (stat.size > MAX_FILE_CHARS) continue;

				const content = readFileSync(fullPath, "utf-8");
				const fileDefs = extractDefinitions(fullPath, content, ext);
				definitions.push(...fileDefs);
			}
		} catch {
			// Skip unreadable files
		}
	}

	return definitions;
}

function extractDefinitions(
	filePath: string,
	content: string,
	ext: string,
): CodeDefinition[] {
	const defs: CodeDefinition[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		switch (ext) {
			case ".ts":
			case ".tsx":
			case ".js":
			case ".jsx":
			case ".mjs":
			case ".cjs":
				// export function name(
				// export class Name
				// export interface Name
				// export type Name
				// export const name =
				// export default function
				{
					const exportFunc = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
					if (exportFunc) {
						defs.push({ filePath, kind: "function", name: exportFunc[1], line: i + 1 });
						continue;
					}

					const exportClass = line.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
					if (exportClass) {
						defs.push({ filePath, kind: "class", name: exportClass[1], line: i + 1 });
						continue;
					}

					const exportInterface = line.match(/^export\s+interface\s+(\w+)/);
					if (exportInterface) {
						defs.push({ filePath, kind: "interface", name: exportInterface[1], line: i + 1 });
						continue;
					}

					const exportType = line.match(/^export\s+type\s+(\w+)/);
					if (exportType) {
						defs.push({ filePath, kind: "type", name: exportType[1], line: i + 1 });
						continue;
					}

					const exportConst = line.match(/^export\s+const\s+(\w+)/);
					if (exportConst) {
						defs.push({ filePath, kind: "const", name: exportConst[1], line: i + 1 });
						continue;
					}
				}
				break;

			case ".py":
				// def function_name(
				// class ClassName:
				// async def function_name(
				{
					const pyDef = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
					if (pyDef && !pyDef[1].startsWith("_")) {
						defs.push({ filePath, kind: "def", name: pyDef[1], line: i + 1 });
						continue;
					}

					const pyClass = line.match(/^class\s+(\w+)/);
					if (pyClass) {
						defs.push({ filePath, kind: "class", name: pyClass[1], line: i + 1 });
						continue;
					}
				}
				break;

			case ".rs":
				// pub fn name(
				// pub struct Name
				// pub enum Name
				// pub trait Name
				{
					const rsFn = line.match(/^pub\s+(?:async\s+)?fn\s+(\w+)/);
					if (rsFn) {
						defs.push({ filePath, kind: "function", name: rsFn[1], line: i + 1 });
						continue;
					}

					const rsStruct = line.match(/^pub\s+struct\s+(\w+)/);
					if (rsStruct) {
						defs.push({ filePath, kind: "class", name: rsStruct[1], line: i + 1 });
						continue;
					}
				}
				break;

			case ".go":
				// func Name(
				// func (r *Receiver) Name(
				// type Name struct {
				{
					const goFunc = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
					if (goFunc && goFunc[1][0] === goFunc[1][0].toUpperCase()) {
						defs.push({ filePath, kind: "function", name: goFunc[1], line: i + 1 });
						continue;
					}

					const goType = line.match(/^type\s+(\w+)\s+struct/);
					if (goType) {
						defs.push({ filePath, kind: "class", name: goType[1], line: i + 1 });
						continue;
					}
				}
				break;

			case ".java":
			case ".kt":
			case ".scala":
				// public class Name
				// public interface Name
				// fun name(  (Kotlin)
				{
					const javaClass = line.match(/(?:public|protected)\s+(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/);
					if (javaClass) {
						defs.push({ filePath, kind: "class", name: javaClass[1], line: i + 1 });
						continue;
					}
				}
				break;

			case ".rb":
				// class Name
				// module Name
				// def name
				{
					const rbClass = line.match(/^\s*class\s+(\w+)/);
					if (rbClass) {
						defs.push({ filePath, kind: "class", name: rbClass[1], line: i + 1 });
						continue;
					}

					const rbModule = line.match(/^\s*module\s+(\w+)/);
					if (rbModule) {
						defs.push({ filePath, kind: "module", name: rbModule[1], line: i + 1 });
						continue;
					}

					const rbDef = line.match(/^\s*def\s+(\w+)/);
					if (rbDef && !rbDef[1].startsWith("_")) {
						defs.push({ filePath, kind: "def", name: rbDef[1], line: i + 1 });
						continue;
					}
				}
				break;
		}
	}

	return defs;
}

function groupDefinitionsByFile(
	definitions: CodeDefinition[],
	repoPath: string,
): Array<{ file: string; defs: CodeDefinition[] }> {
	const grouped = new Map<string, CodeDefinition[]>();

	for (const def of definitions) {
		const relPath = relative(repoPath, def.filePath);
		const list = grouped.get(relPath) ?? [];
		list.push(def);
		grouped.set(relPath, list);
	}

	return [...grouped.entries()]
		.map(([file, defs]) => ({ file, defs }))
		.sort((a, b) => a.file.localeCompare(b.file));
}
