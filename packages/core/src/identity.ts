/**
 * Identity file management for Signet
 *
 * Handles loading and recognizing the standard identity files
 * (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, HEARTBEAT.md, MEMORY.md, TOOLS.md)
 * that form the cross-harness identity standard.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listOhMyPiAgentDirCandidates } from "./oh-my-pi";

const FORGE_BINARY_NAME = "forge";
const SIGNET_FORGE_PRIMARY_MARKER = "Signet's native AI terminal";
const SIGNET_FORGE_FALLBACK_MARKERS = [
	"Signet daemon URL",
	"SIGNET_TOKEN",
	"signet-token",
	"signet-dark",
	"Starting Signet daemon",
	"Signet provides memory, identity, and extraction for Forge",
];
const COMPATIBLE_FORGE_MARKER_GROUPS = [
	[SIGNET_FORGE_PRIMARY_MARKER, "Forge — First Run", "Forge — Provider auth needed", "Forge TUI starting — model:"],
	[
		"FORGE_SIGNET_TOKEN",
		"SIGNET_AUTH_TOKEN",
		"SIGNET_TOKEN",
		"Signet daemon URL",
		"Signet provides memory, identity, and extraction for Forge",
	],
	[
		"signet-dark",
		"Dashboard (Ctrl+D)",
		"/forge-usage",
		"Switch theme (signet-dark, signet-light, midnight, amber)",
		"Open main dashboard in browser",
	],
] as const;
const OH_MY_PI_MANAGED_EXTENSION_FILENAME = "signet-oh-my-pi.js";
const OH_MY_PI_LEGACY_MANAGED_EXTENSION_FILENAME = "signet-oh-my-pi.mjs";
const OH_MY_PI_MANAGED_MARKER = "SIGNET_MANAGED_OH_MY_PI_EXTENSION";

/**
 * Returns the base path for agent-specific files.
 * The 'default' agent maps to the workspace root; all others map to
 * `{workspaceDir}/agents/{agentName}`.
 */
export function resolveAgentBasePath(agentName: string, workspaceDir: string): string {
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
		ohMyPi: boolean;
		forge: boolean;
	};
}

function forgeBinaryFilename(binaryName = FORGE_BINARY_NAME): string {
	return process.platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export function resolveSignetForgeManagedPath(home = homedir()): string {
	return join(home, ".config", "signet", "bin", forgeBinaryFilename());
}

function signetForgeCandidatePaths(home: string): string[] {
	const binary = forgeBinaryFilename();
	return [
		resolveSignetForgeManagedPath(home),
		join(home, ".cargo", "bin", binary),
		join(home, ".local", "bin", binary),
		"/usr/local/bin/forge",
		"/opt/homebrew/bin/forge",
	];
}

function workspaceForgeCandidatePaths(agentsDir?: string): string[] {
	if (!agentsDir) return [];
	const binary = forgeBinaryFilename();
	return [
		join(agentsDir, binary),
		join(agentsDir, "target", "release", binary),
		join(agentsDir, "target", "debug", binary),
		join(agentsDir, "packages", "forge", "target", "release", binary),
		join(agentsDir, "packages", "forge", "target", "debug", binary),
	];
}

interface SignetForgeInstallRecord {
	readonly managed?: boolean;
	readonly binaryPath?: string;
}

function signetManagedInstallDir(home = homedir()): string {
	return join(home, ".config", "signet", "bin");
}

function isSignetManagedOhMyPiInstall(): boolean {
	for (const agentDir of listOhMyPiAgentDirCandidates()) {
		const extensionsDir = join(agentDir, "extensions");
		for (const filename of [OH_MY_PI_MANAGED_EXTENSION_FILENAME, OH_MY_PI_LEGACY_MANAGED_EXTENSION_FILENAME]) {
			const extensionPath = join(extensionsDir, filename);
			if (!existsSync(extensionPath)) continue;
			try {
				const content = readFileSync(extensionPath, "utf8");
				if (content.includes(OH_MY_PI_MANAGED_MARKER)) return true;
			} catch {
				// ignore unreadable candidate and continue checking others
			}
		}
	}
	return false;
}

function readSignetForgeInstallRecord(home = homedir()): SignetForgeInstallRecord | null {
	const recordPath = join(signetManagedInstallDir(home), ".forge-install.json");
	if (!existsSync(recordPath)) return null;
	try {
		return JSON.parse(readFileSync(recordPath, "utf8")) as SignetForgeInstallRecord;
	} catch {
		return null;
	}
}

function isExecutableFile(filePath: string): boolean {
	try {
		const stats = statSync(filePath);
		if (!stats.isFile()) return false;
		if (process.platform === "win32") return true;
		return (stats.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

export function isSignetForgeBinary(binaryPath: string): boolean {
	if (!existsSync(binaryPath)) return false;
	if (!isExecutableFile(binaryPath)) return false;
	try {
		const binary = readFileSync(binaryPath);
		if (binary.includes(Buffer.from(SIGNET_FORGE_PRIMARY_MARKER))) return true;
		let matches = 0;
		for (const marker of SIGNET_FORGE_FALLBACK_MARKERS) {
			if (binary.includes(Buffer.from(marker))) matches += 1;
			if (matches >= 2) return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function isCompatibleForgeBinary(binaryPath: string): boolean {
	if (!existsSync(binaryPath)) return false;
	if (!isExecutableFile(binaryPath)) return false;
	try {
		const binary = readFileSync(binaryPath);
		if (binary.includes(Buffer.from(SIGNET_FORGE_PRIMARY_MARKER))) return true;
		return COMPATIBLE_FORGE_MARKER_GROUPS.every((group) =>
			group.some((marker) => binary.includes(Buffer.from(marker))),
		);
	} catch {
		return false;
	}
}

export function findSignetForgeBinary(_agentsDir?: string, home = homedir()): string | null {
	const candidates = [...workspaceForgeCandidatePaths(_agentsDir), ...signetForgeCandidatePaths(home)];
	const record = readSignetForgeInstallRecord(home);
	if (record?.binaryPath) {
		candidates.unshift(record.binaryPath);
	}
	for (const candidate of [...new Set(candidates)]) {
		if (isCompatibleForgeBinary(candidate)) return candidate;
	}
	try {
		const lookup = process.platform === "win32" ? "where" : "which";
		const output = execFileSync(lookup, [FORGE_BINARY_NAME], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		for (const candidate of output) {
			if (isCompatibleForgeBinary(candidate)) return candidate;
		}
	} catch {
		return null;
	}
	return null;
}

function isForgeInstalled(agentsDir: string, home: string): boolean {
	return findSignetForgeBinary(agentsDir, home) !== null;
}

/**
 * Detect existing identity setup at a given path
 */
export function detectExistingSetup(basePath: string): SetupDetection {
	const identityFileNames = Object.values(IDENTITY_FILES).map((spec) => spec.path);

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
			memoryLogCount = files.filter((f: string) => f.endsWith(".md") && !f.startsWith("TEMPLATE")).length;
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
				existsSync(join(home, ".openclaw", "openclaw.json")) || existsSync(join(home, ".clawdbot", "clawdbot.json")),
			opencode: existsSync(join(home, ".config", "opencode", "config.json")),
			codex:
				existsSync(join(home, ".codex", "config.toml")) || existsSync(join(home, ".config", "signet", "bin", "codex")),
			ohMyPi: isSignetManagedOhMyPiInstall(),
			forge: isForgeInstalled(basePath, home),
		},
	};
}

/**
 * Load all identity files from a directory
 */
export async function loadIdentityFiles(basePath: string): Promise<IdentityMap> {
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

export const STATIC_IDENTITY_OFFLINE_STATUS = "[signet: daemon offline — running with static identity]";
export const STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS =
	"[signet: daemon session-start timed out — running with static identity]";

export function resolveSessionStartTimeoutMs(raw?: string): number {
	if (!raw) return 15_000;
	const ms = Number.parseInt(raw, 10);
	if (!Number.isFinite(ms) || ms < 1_000) return 15_000;
	if (ms > 120_000) return 120_000;
	return ms;
}

/**
 * Read identity files directly from disk and compose a degraded inject string.
 * Used as fallback when the daemon is unreachable during session-start.
 *
 * Returns null if no identity files exist.
 */
export function readStaticIdentity(
	agentsDir: string,
	status = STATIC_IDENTITY_OFFLINE_STATUS,
): string | null {
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

	return `${status}\n\n${parts.join("\n\n")}`;
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

	const totalSize = Object.values(identity).reduce((sum, file) => sum + (file?.size || 0), 0);
	parts.push(`Size: ${totalSize} bytes`);

	return parts.join("\n");
}
