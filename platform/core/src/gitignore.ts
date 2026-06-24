import { SIGNET_SOURCE_CHECKOUT_DIRNAME } from "./workspace-source-repo";

export const SIGNET_GIT_ALLOWED_FILE_EXTENSIONS = [".md", ".json", ".jsonl", ".html", ".yaml", ".yml"] as const;

export const SIGNET_GIT_ALLOWED_DIRECTORIES = ["skills", "tools", "dreaming"] as const;

export const SIGNET_GIT_PROTECTED_PATHS = [
	".daemon",
	".shadow",
	"node_modules",
	":(glob)**/node_modules/**",
	`${SIGNET_SOURCE_CHECKOUT_DIRNAME}`,
	"memory/backups",
	"memory/memories.db",
	":(glob)memory/memories.db*",
	":(glob)memory/**/*.db",
	":(glob)memory/**/*.db-*",
	":(glob)memory/**/*.db-journal",
	":(glob)memory/**/*.db-shm",
	":(glob)memory/**/*.db-wal",
	":(glob)memory/**/*.sqlite",
	":(glob)memory/**/*.sqlite3",
	":(glob)**/*.db",
	":(glob)**/*.db-*",
	":(glob)**/*.db-journal",
	":(glob)**/*.db-shm",
	":(glob)**/*.db-wal",
	":(glob)**/*.sqlite",
	":(glob)**/*.sqlite3",
] as const;

export const SIGNET_GIT_TRACKED_PATHS = [
	"*.md",
	":(glob)**/*.md",
	"*.json",
	":(glob)**/*.json",
	"*.jsonl",
	":(glob)**/*.jsonl",
	"*.html",
	":(glob)**/*.html",
	"*.yaml",
	":(glob)**/*.yaml",
	"*.yml",
	":(glob)**/*.yml",
	...SIGNET_GIT_ALLOWED_DIRECTORIES,
] as const;

export function isSignetGitTrackedPath(path: string): boolean {
	const normalized = normalizeGitPath(path);
	if (!normalized || isSignetGitProtectedPath(normalized)) return false;
	if (normalized === ".gitignore") return true;
	if (SIGNET_GIT_ALLOWED_DIRECTORIES.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) {
		return true;
	}
	return SIGNET_GIT_ALLOWED_FILE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export function isSignetGitProtectedPath(path: string): boolean {
	const normalized = normalizeGitPath(path);
	const lower = normalized.toLowerCase();
	const basename = lower.split("/").at(-1) ?? lower;
	return (
		lower === ".daemon" ||
		lower.startsWith(".daemon/") ||
		lower === ".shadow" ||
		lower.startsWith(".shadow/") ||
		lower === "node_modules" ||
		lower.startsWith("node_modules/") ||
		lower.includes("/node_modules/") ||
		lower === SIGNET_SOURCE_CHECKOUT_DIRNAME ||
		lower.startsWith(`${SIGNET_SOURCE_CHECKOUT_DIRNAME}/`) ||
		lower === "memory/memories.db" ||
		lower.startsWith("memory/memories.db") ||
		lower.startsWith("memory/backups/") ||
		basename.endsWith(".db") ||
		basename.includes(".db-") ||
		basename.endsWith(".db-journal") ||
		basename.endsWith(".db-shm") ||
		basename.endsWith(".db-wal") ||
		basename.endsWith(".sqlite") ||
		basename.endsWith(".sqlite3")
	);
}

function normalizeGitPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+/g, "/");
}

const SIGNET_GITIGNORE_BLOCK_START = "# BEGIN Signet lightweight workspace";
const SIGNET_GITIGNORE_BLOCK_END = "# END Signet lightweight workspace";

const SIGNET_GITIGNORE_PROTECTED_PATTERNS = [
	".daemon/",
	".shadow/",
	"node_modules/",
	`${SIGNET_SOURCE_CHECKOUT_DIRNAME}/`,
	"memory/memories.db*",
	"memory/**/*.db",
	"memory/**/*.db-*",
	"memory/**/*.db-journal",
	"memory/**/*.db-shm",
	"memory/**/*.db-wal",
	"memory/**/*.sqlite",
	"memory/**/*.sqlite3",
	"memory/backups/",
	"*.db",
	"*.db-*",
	"*.db-journal",
	"*.db-shm",
	"*.db-wal",
	"*.sqlite",
	"*.sqlite3",
] as const;

function buildSignetGitignoreBlock(): string {
	const lines = [
		SIGNET_GITIGNORE_BLOCK_START,
		"# Keep the workspace repo small: back up text identity, transcript, and skill/tool sources only.",
		"*",
		"!*/",
		"!.gitignore",
		"!*.md",
		"!**/*.md",
		"!*.json",
		"!**/*.json",
		"!*.jsonl",
		"!**/*.jsonl",
		"!*.html",
		"!**/*.html",
		"!*.yaml",
		"!**/*.yaml",
		"!*.yml",
		"!**/*.yml",
		...SIGNET_GIT_ALLOWED_DIRECTORIES.flatMap((dir) => [`!${dir}/`, `!${dir}/**`]),
		"",
		"# Hard-deny generated/runtime state even if an older rule unignored memory/.",
		...SIGNET_GITIGNORE_PROTECTED_PATTERNS,
		SIGNET_GITIGNORE_BLOCK_END,
	];
	return `${lines.join("\n")}\n`;
}

export function mergeSignetGitignoreEntries(existingContent: string): string {
	const normalized = existingContent.replaceAll("\r\n", "\n");
	const block = buildSignetGitignoreBlock();
	const blockRe = new RegExp(
		`${escapeRegExp(SIGNET_GITIGNORE_BLOCK_START)}[\\s\\S]*?${escapeRegExp(SIGNET_GITIGNORE_BLOCK_END)}\\n?`,
	);

	const withoutOldBlock = normalized.replace(blockRe, "").trimEnd();
	return withoutOldBlock.length > 0 ? `${withoutOldBlock}\n\n${block}` : block;
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
