import { readFileSync, statSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { resolveWorkspaceSourceRepoPath } from "@signet/core";

// Canonical artifact filename patterns (keep in sync with daemon.ts)
const ARTIFACT_FILENAME_RE = /--(?:summary|transcript|compaction|manifest)\.md$/;
const MEMORY_BACKUP_FILENAME_RE = /^MEMORY\.(?:backup|bak|pre)-.+\.md$/;
const SIGNET_IGNORE_FILENAME = ".sigignore";

const DEFAULT_SIGNIGNORE_CONTENT = `# Signet watcher ignore — edit freely, changes take effect without restart.

# Harness runtimes
agents/*/.fly-*-home/
`;

interface SigignorePattern {
	readonly negated: boolean;
	readonly anchored: boolean;
	readonly hasSlash: boolean;
	readonly regex: RegExp;
}

interface SigignoreCache {
	stamp: string;
	patterns: readonly SigignorePattern[];
}

function normalizePath(path: string): string {
	return normalize(path);
}

function resolveForComparison(path: string): string {
	return normalizePath(isAbsolute(path) ? path : resolve(path));
}

function relativePathWithin(root: string, target: string): string | null {
	const rel = normalizePath(relative(root, target));
	if (rel === "" || rel === ".") return "";
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

function normalizeRelativePath(path: string): string {
	return path
		.split(/[\\/]+/)
		.filter(Boolean)
		.join("/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "/" && pattern[index + 1] === "*" && pattern[index + 2] === "*" && pattern[index + 3] === "/") {
			source += "(?:/.*)?/";
			index += 3;
			continue;
		}
		if (char === "*") {
			if (pattern[index + 1] === "*" && pattern[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`^${source}$`);
}

function parseSigignoreLine(rawLine: string): SigignorePattern | null {
	let line = rawLine.trim();
	if (line === "" || line.startsWith("#")) return null;
	if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);

	const negated = line.startsWith("!");
	if (negated) line = line.slice(1).trim();
	if (line === "") return null;

	line = line.replace(/\\/g, "/").replace(/^\.\//, "");
	const anchored = line.startsWith("/");
	while (line.startsWith("/")) line = line.slice(1);
	while (line.endsWith("/")) line = line.slice(0, -1);
	if (line === "") return null;

	return {
		negated,
		anchored,
		hasSlash: line.includes("/"),
		regex: globToRegExp(line),
	};
}

function parseSigignore(content: string): readonly SigignorePattern[] {
	return content
		.split(/\r?\n/)
		.map(parseSigignoreLine)
		.filter((pattern): pattern is SigignorePattern => pattern !== null);
}

function patternMatches(pattern: SigignorePattern, relativePath: string): boolean {
	const segments = relativePath.split("/").filter(Boolean);
	if (segments.length === 0) return false;
	if (!pattern.hasSlash) {
		return pattern.anchored
			? pattern.regex.test(segments[0] ?? "")
			: segments.some((segment) => pattern.regex.test(segment));
	}

	for (let end = 1; end <= segments.length; end += 1) {
		if (pattern.regex.test(segments.slice(0, end).join("/"))) return true;
	}
	return false;
}

function isIgnoredBySigignore(patterns: readonly SigignorePattern[], relativePath: string): boolean {
	let ignored = false;
	for (const pattern of patterns) {
		if (patternMatches(pattern, relativePath)) ignored = !pattern.negated;
	}
	return ignored;
}

function ensureDefaultSigignore(sigignorePath: string): void {
	try {
		if (!existsSync(sigignorePath)) {
			writeFileSync(sigignorePath, DEFAULT_SIGNIGNORE_CONTENT, "utf-8");
		}
	} catch {
		// Best-effort; watcher still works without a .sigignore file.
	}
}

function createSigignoreMatcher(agentsDir: string): (normalizedPath: string) => boolean {
	const workspaceRoot = resolveForComparison(agentsDir);
	const sigignorePath = resolveForComparison(join(agentsDir, SIGNET_IGNORE_FILENAME));
	let cache: SigignoreCache = { stamp: "", patterns: [] };

	function loadPatterns(): readonly SigignorePattern[] {
		try {
			const stat = statSync(sigignorePath);
			const stamp = `${stat.mtimeMs}:${stat.size}`;
			if (cache.stamp === stamp) return cache.patterns;
			cache = { stamp, patterns: parseSigignore(readFileSync(sigignorePath, "utf-8")) };
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") cache = { stamp: "unreadable", patterns: [] };
			else if (cache.stamp !== "missing") cache = { stamp: "missing", patterns: [] };
		}
		return cache.patterns;
	}

	return (normalizedPath: string): boolean => {
		if (normalizedPath === sigignorePath) return false;
		const relativeToWorkspace = relativePathWithin(workspaceRoot, normalizedPath);
		if (relativeToWorkspace === null || relativeToWorkspace === "") return false;
		const relativePath = normalizeRelativePath(relativeToWorkspace);
		if (relativePath === SIGNET_IGNORE_FILENAME) return false;
		return isIgnoredBySigignore(loadPatterns(), relativePath);
	};
}

export function createAgentsWatcherIgnoreMatcher(agentsDir: string): (path: string) => boolean {
	const agentRoot = resolveForComparison(join(agentsDir, "agents"));
	const memoriesDb = resolveForComparison(join(agentsDir, "memory", "memories.db"));
	const memoriesDbWal = resolveForComparison(join(agentsDir, "memory", "memories.db-wal"));
	const memoriesDbShm = resolveForComparison(join(agentsDir, "memory", "memories.db-shm"));
	const memoriesDbJournal = resolveForComparison(join(agentsDir, "memory", "memories.db-journal"));
	const sourceRepoRoot = resolveForComparison(resolveWorkspaceSourceRepoPath(agentsDir));
	const memoryDir = resolveForComparison(join(agentsDir, "memory"));
	const isIgnoredByWorkspaceConfig = createSigignoreMatcher(agentsDir);
	ensureDefaultSigignore(resolveForComparison(join(agentsDir, SIGNET_IGNORE_FILENAME)));
	const ignoredPaths = new Set([memoriesDb, memoriesDbWal, memoriesDbShm, memoriesDbJournal]);

	return (path: string): boolean => {
		const normalizedPath = resolveForComparison(path);
		if (relativePathWithin(sourceRepoRoot, normalizedPath) !== null) {
			return true;
		}

		// Ignore canonical artifact and backup files inside memory/
		const relMemory = relativePathWithin(memoryDir, normalizedPath);
		if (relMemory !== null && relMemory !== "") {
			const fname = basename(normalizedPath);
			if (ARTIFACT_FILENAME_RE.test(fname) || MEMORY_BACKUP_FILENAME_RE.test(fname)) {
				return true;
			}
		}

		const relativeToAgentsRoot = relativePathWithin(agentRoot, normalizedPath);
		const agentSegments = relativeToAgentsRoot === null ? [] : relativeToAgentsRoot.split(/[\\/]+/).filter(Boolean);
		const isGeneratedWorkspacePath =
			agentSegments.length === 3 && agentSegments[1] === "workspace" && agentSegments[2] === "AGENTS.md";
		return isGeneratedWorkspacePath || ignoredPaths.has(normalizedPath) || isIgnoredByWorkspaceConfig(normalizedPath);
	};
}
