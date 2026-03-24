/**
 * Identity file management for Signet
 *
 * Handles loading and recognizing the standard identity files
 * (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, HEARTBEAT.md, MEMORY.md, TOOLS.md)
 * that form the cross-harness identity standard.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Returns the base path for agent-specific files.
 * The 'default' agent maps to the workspace root; all others map to
 * `{workspaceDir}/agents/{agentName}`.
 */
export function resolveAgentBasePath(
	agentName: string,
	workspaceDir: string,
): string {
	if (agentName === "default") return workspaceDir;
	return join(workspaceDir, "agents", agentName);
}

/**
 * Specification for an identity file
 */
export interface IdentityFileSpec {
	/** Relative path from the base directory */
	path: string;
	/** Human-readable description */
	description: string;
	/** Whether this file is optional */
	optional?: boolean;
}

/**
 * Loaded identity file content
 */
export interface IdentityFile {
	/** Relative path (e.g., 'AGENTS.md') */
	path: string;
	/** File contents */
	content: string;
	/** Last modification time */
	mtime: Date;
	/** File size in bytes */
	size: number;
}

/**
 * Map of identity file key to loaded content
 */
export interface IdentityMap {
	agents?: IdentityFile;
	soul?: IdentityFile;
	identity?: IdentityFile;
	user?: IdentityFile;
	heartbeat?: IdentityFile;
	memory?: IdentityFile;
	tools?: IdentityFile;
	bootstrap?: IdentityFile;
}

/**
 * Standard identity files that form the cross-harness identity standard.
 * These are recognized by Signet and multiple harnesses.
 */
export const IDENTITY_FILES: Record<string, IdentityFileSpec> = {
	agents: {
		path: "AGENTS.md",
		description: "Operational rules and behavioral settings",
		optional: false,
	},
	soul: {
		path: "SOUL.md",
		description: "Persona, character, and security settings",
		optional: false,
	},
	identity: {
		path: "IDENTITY.md",
		description: "Agent name, creature type, and vibe",
		optional: false,
	},
	user: {
		path: "USER.md",
		description: "User profile and preferences",
		optional: false,
	},
	heartbeat: {
		path: "HEARTBEAT.md",
		description: "Current working state, focus, and blockers",
		optional: true,
	},
	memory: {
		path: "MEMORY.md",
		description: "Memory index and summary",
		optional: true,
	},
	tools: {
		path: "TOOLS.md",
		description: "Tool preferences and notes",
		optional: true,
	},
	bootstrap: {
		path: "BOOTSTRAP.md",
		description: "Setup ritual (typically deleted after first run)",
		optional: true,
	},
};

/**
 * Required identity files (non-optional)
 */
export const REQUIRED_IDENTITY_KEYS = Object.entries(IDENTITY_FILES)
	.filter(([, spec]) => !spec.optional)
	.map(([key]) => key);

/**
 * Optional identity files
 */
export const OPTIONAL_IDENTITY_KEYS = Object.entries(IDENTITY_FILES)
	.filter(([, spec]) => spec.optional)
	.map(([key]) => key);

/**
 * Detection result for existing setup
 */
export interface SetupDetection {
	/** Base path checked */
	basePath: string;
	/** Whether the base directory exists */
	agentsDir: boolean;
	/** Whether agent.yaml exists */
	agentYaml: boolean;
	/** Whether AGENTS.md exists */
	agentsMd: boolean;
	/** Whether config.yaml exists */
	configYaml: boolean;
	/** Whether memories.db exists */
	memoryDb: boolean;
	/** Found identity files */
	identityFiles: string[];
	/** Whether memory directory exists with logs */
	hasMemoryDir: boolean;
	/** Number of memory log files */
	memoryLogCount: number;
	/** Whether .clawdhub/lock.json exists (OpenClaw skills registry) */
	hasClawdhub: boolean;
	/** Whether ~/.claude/skills/ exists */
	hasClaudeSkills: boolean;
	/** Detected installed harnesses */
	harnesses: {
		claudeCode: boolean;
		openclaw: boolean;
		opencode: boolean;
		codex: boolean;
	};
}

/**
 * Detect existing identity setup at a given path
 */
export function detectExistingSetup(basePath: string): SetupDetection {
	const identityFileNames = Object.values(IDENTITY_FILES).map(
		(spec) => spec.path,
	);

	// Check for identity files
	const foundFiles: string[] = [];
	for (const fileName of identityFileNames) {
		if (existsSync(join(basePath, fileName))) {
			foundFiles.push(fileName);
		}
	}

	// Check memory directory
	const memoryDir = join(basePath, "memory");
	let memoryLogCount = 0;
	if (existsSync(memoryDir)) {
		try {
			const { readdirSync } = require("node:fs");
			const files = readdirSync(memoryDir);
			memoryLogCount = files.filter(
				(f: string) => f.endsWith(".md") && !f.startsWith("TEMPLATE"),
			).length;
		} catch {
			// Ignore errors
		}
	}

	// Detect harnesses
	const home = homedir();

	return {
		basePath,
		agentsDir: existsSync(basePath),
		agentYaml: existsSync(join(basePath, "agent.yaml")),
		agentsMd: existsSync(join(basePath, "AGENTS.md")),
		configYaml: existsSync(join(basePath, "config.yaml")),
		memoryDb: existsSync(join(basePath, "memory", "memories.db")),
		identityFiles: foundFiles,
		hasMemoryDir: existsSync(memoryDir),
		memoryLogCount,
		hasClawdhub: existsSync(join(basePath, ".clawdhub", "lock.json")),
		hasClaudeSkills: existsSync(join(home, ".claude", "skills")),
		harnesses: {
			claudeCode: existsSync(join(home, ".claude", "settings.json")),
			openclaw:
				existsSync(join(home, ".openclaw", "openclaw.json")) ||
				existsSync(join(home, ".clawdbot", "clawdbot.json")),
			opencode: existsSync(join(home, ".config", "opencode", "config.json")),
			codex:
				existsSync(join(home, ".codex", "config.toml")) ||
				existsSync(join(home, ".config", "signet", "bin", "codex")),
		},
	};
}

/**
 * Load all identity files from a directory
 */
export async function loadIdentityFiles(
	basePath: string,
): Promise<IdentityMap> {
	const result: IdentityMap = {};

	for (const [key, spec] of Object.entries(IDENTITY_FILES)) {
		const filePath = join(basePath, spec.path);

		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				const stats = statSync(filePath);

				result[key as keyof IdentityMap] = {
					path: spec.path,
					content,
					mtime: stats.mtime,
					size: stats.size,
				};
			} catch (err) {
				if (!spec.optional) {
					console.warn(`Failed to read identity file: ${spec.path}`, err);
				}
			}
		} else if (!spec.optional) {
			console.warn(`Missing required identity file: ${spec.path}`);
		}
	}

	return result;
}

/**
 * Load identity files synchronously
 */
export function loadIdentityFilesSync(basePath: string): IdentityMap {
	const result: IdentityMap = {};

	for (const [key, spec] of Object.entries(IDENTITY_FILES)) {
		const filePath = join(basePath, spec.path);

		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				const stats = statSync(filePath);

				result[key as keyof IdentityMap] = {
					path: spec.path,
					content,
					mtime: stats.mtime,
					size: stats.size,
				};
			} catch (err) {
				if (!spec.optional) {
					console.warn(`Failed to read identity file: ${spec.path}`, err);
				}
			}
		} else if (!spec.optional) {
			console.warn(`Missing required identity file: ${spec.path}`);
		}
	}

	return result;
}

/**
 * Check if a directory has the minimum required identity files
 */
export function hasValidIdentity(basePath: string): boolean {
	for (const key of REQUIRED_IDENTITY_KEYS) {
		const spec = IDENTITY_FILES[key];
		if (!existsSync(join(basePath, spec.path))) {
			return false;
		}
	}
	return true;
}

/**
 * Get list of missing required identity files
 */
export function getMissingIdentityFiles(basePath: string): string[] {
	const missing: string[] = [];

	for (const key of REQUIRED_IDENTITY_KEYS) {
		const spec = IDENTITY_FILES[key];
		if (!existsSync(join(basePath, spec.path))) {
			missing.push(spec.path);
		}
	}

	return missing;
}

/**
 * Character budgets for static identity fallback, matching daemon inject budgets.
 */
const STATIC_BUDGETS: ReadonlyArray<{ file: string; header: string; budget: number }> = [
	{ file: "AGENTS.md", header: "Agent Instructions", budget: 12_000 },
	{ file: "SOUL.md", header: "Soul", budget: 4_000 },
	{ file: "IDENTITY.md", header: "Identity", budget: 2_000 },
	{ file: "USER.md", header: "About Your User", budget: 6_000 },
	{ file: "MEMORY.md", header: "Working Memory", budget: 10_000 },
];

/**
 * Read identity files directly from disk and compose a degraded inject string.
 * Used as fallback when the daemon is unreachable during session-start.
 *
 * Returns null if no identity files exist.
 */
export function readStaticIdentity(agentsDir: string): string | null {
	if (!existsSync(agentsDir)) return null;

	const parts: string[] = [];

	for (const { file, header, budget } of STATIC_BUDGETS) {
		const path = join(agentsDir, file);
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8").trim();
			if (!raw) continue;
			const content = raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`;
			parts.push(`## ${header}\n\n${content}`);
		} catch {
			// skip unreadable files
		}
	}

	if (parts.length === 0) return null;

	return `[signet: daemon offline — running with static identity]\n\n${parts.join("\n\n")}`;
}

/**
 * Generate a summary of the identity for display
 */
export function summarizeIdentity(identity: IdentityMap): string {
	const parts: string[] = [];

	if (identity.identity?.content) {
		// Try to extract name from IDENTITY.md
		const nameMatch = identity.identity.content.match(/^#\s*(.+)$/m);
		if (nameMatch) {
			parts.push(`Name: ${nameMatch[1]}`);
		}
	}

	const fileCount = Object.keys(identity).length;
	parts.push(`Files: ${fileCount} identity files loaded`);

	const totalSize = Object.values(identity).reduce(
		(sum, file) => sum + (file?.size || 0),
		0,
	);
	parts.push(`Size: ${totalSize} bytes`);

	return parts.join("\n");
}
