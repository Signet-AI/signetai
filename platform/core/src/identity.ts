/**
 * Identity file management for Signet
 *
 * Handles loading and recognizing the standard identity files
 * (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, HEARTBEAT.md, MEMORY.md, TOOLS.md)
 * that form the cross-harness identity standard.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listOhMyPiAgentDirCandidates, resolveOhMyPiAgentDir } from "./oh-my-pi";
import { listPiAgentDirCandidates, resolvePiAgentDir } from "./pi";
import { parseSimpleYaml } from "./yaml";

const OH_MY_PI_MANAGED_EXTENSION_FILENAME = "signet-oh-my-pi.js";
const OH_MY_PI_LEGACY_MANAGED_EXTENSION_FILENAME = "signet-oh-my-pi.mjs";
const OH_MY_PI_MANAGED_MARKER = "SIGNET_MANAGED_OH_MY_PI_EXTENSION";
const PI_MANAGED_EXTENSION_FILENAME = "signet-pi.js";
const PI_LEGACY_MANAGED_EXTENSION_FILENAME = "signet-pi.mjs";
const PI_MANAGED_MARKER = "SIGNET_MANAGED_PI_EXTENSION";

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
export type IdentityPresetName = "minimal" | "hermes" | "openclaw" | "custom";

export type IdentityMode = "managed" | "passthrough" | "off";

export const IDENTITY_MODES = ["managed", "passthrough", "off"] as const;

export type IdentityFileContext = "startup" | "session";

export type IdentitySessionKind = "dreaming" | "heartbeat" | "bootstrap";

export interface IdentityFileSpec {
	/** Relative path from the base directory */
	path: string;
	/** Human-readable description */
	description: string;
	/** Whether this file is optional */
	optional?: boolean;
	/** Whether this file is loaded during normal startup or only in a special session */
	context?: IdentityFileContext;
	/** Special session kind when context is "session" */
	session?: IdentitySessionKind;
}

export interface IdentityContextFileEntry {
	path: string;
	role?: string;
	budget?: number;
	enabled?: boolean;
}

export interface IdentitySpecialFileEntry extends IdentityContextFileEntry {
	kind: IdentitySessionKind;
}

export interface IdentityPresetSpec {
	name: IdentityPresetName;
	description: string;
	startup: IdentityContextFileEntry[];
	special: IdentitySpecialFileEntry[];
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
		description: "Heartbeat prompt used only for heartbeat/background check sessions",
		optional: true,
		context: "session",
		session: "heartbeat",
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
		context: "session",
		session: "bootstrap",
	},
	dreaming: {
		path: "DREAMING.md",
		description: "Dreaming/reflection prompt used only for dreaming sessions",
		optional: true,
		context: "session",
		session: "dreaming",
	},
};

export const IDENTITY_PRESETS: Record<IdentityPresetName, IdentityPresetSpec> = {
	minimal: {
		name: "minimal",
		description: "AGENTS.md only for normal startup, plus DREAMING.md for dreaming sessions.",
		startup: [{ path: "AGENTS.md", role: "operating_instructions", budget: 12_000 }],
		special: [{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 }],
	},
	hermes: {
		name: "hermes",
		description: "Hermes-style SOUL.md primary identity with project-context discovery handled by Hermes.",
		startup: [
			{ path: "SOUL.md", role: "primary_identity", budget: 4_000 },
			{ path: "AGENTS.md", role: "project_context", budget: 12_000 },
		],
		special: [{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 }],
	},
	openclaw: {
		name: "openclaw",
		description: "OpenClaw-style rich identity stack for character-forward agents.",
		startup: [
			{ path: "AGENTS.md", role: "operating_instructions", budget: 12_000 },
			{ path: "SOUL.md", role: "persona", budget: 4_000 },
			{ path: "IDENTITY.md", role: "agent_identity", budget: 2_000 },
			{ path: "USER.md", role: "user_profile", budget: 6_000 },
			{ path: "MEMORY.md", role: "working_memory", budget: 10_000 },
		],
		special: [
			{ path: "HEARTBEAT.md", kind: "heartbeat", role: "heartbeat_prompt", budget: 4_000 },
			{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 },
			{ path: "BOOTSTRAP.md", kind: "bootstrap", role: "bootstrap_prompt", budget: 4_000 },
		],
	},
	custom: {
		name: "custom",
		description: "User-selected startup files and explicit order.",
		startup: [{ path: "AGENTS.md", role: "operating_instructions", budget: 12_000 }],
		special: [{ path: "DREAMING.md", kind: "dreaming", role: "dreaming_prompt", budget: 4_000 }],
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
		pi: boolean;
		hermesAgent: boolean;
		gemini: boolean;
	};
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

function isSignetManagedPiInstall(): boolean {
	for (const agentDir of listPiAgentDirCandidates()) {
		const extensionsDir = join(agentDir, "extensions");
		for (const filename of [PI_MANAGED_EXTENSION_FILENAME, PI_LEGACY_MANAGED_EXTENSION_FILENAME]) {
			const extensionPath = join(extensionsDir, filename);
			if (!existsSync(extensionPath)) continue;
			try {
				const content = readFileSync(extensionPath, "utf8");
				if (content.includes(PI_MANAGED_MARKER)) return true;
			} catch {
				// ignore unreadable candidate and continue checking others
			}
		}
	}
	return false;
}

function userHome(): string {
	return process.env.HOME?.trim() || homedir();
}

export function resolveHermesHomePath(): string {
	const hermesHome = process.env.HERMES_HOME?.trim();
	return hermesHome || join(userHome(), ".hermes");
}

/**
 * Canonical list of common Hermes Agent repo install paths.
 *
 * Exported so `connector-hermes-agent` can import it instead of duplicating
 * the list, eliminating parity drift between install and detection logic.
 */
export function hermesAgentCandidateDirs(): readonly string[] {
	const home = userHome();
	const hermesHome = resolveHermesHomePath();
	return [
		hermesHome,
		join(hermesHome, "hermes-agent"),
		join(home, "hermes-agent"),
		join(home, ".local", "share", "hermes-agent"),
		join(home, "src", "hermes-agent"),
		"/opt/hermes-agent",
	] as const;
}

/**
 * Resolve the Hermes Agent repo directory.
 *
 * This detects a Hermes install before the Signet plugin has been copied in.
 * It checks for the repo's `plugins/memory` tree rather than the Signet plugin
 * file, so setup can offer and install the Hermes connector on first run.
 * Resolution order: HERMES_REPO, HERMES_HOME, ~/.hermes, legacy/common paths,
 * then the hermes executable location.
 */
export function resolveHermesRepoPath(): string | null {
	const hermesRepo = process.env.HERMES_REPO?.trim();
	if (hermesRepo && existsSync(join(hermesRepo, "plugins", "memory"))) {
		return hermesRepo;
	}

	for (const base of hermesAgentCandidateDirs()) {
		if (existsSync(join(base, "plugins", "memory"))) return base;
	}

	try {
		const hermesPath = execFileSync("which", ["hermes"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim();
		if (hermesPath) {
			const repoDir = dirname(realpathSync(hermesPath));
			if (existsSync(join(repoDir, "plugins", "memory"))) return repoDir;
		}
	} catch {
		// hermes not in PATH
	}

	return null;
}

/**
 * Resolve the path to the Signet plugin file inside the Hermes Agent repo.
 *
 * Checks (in order): `HERMES_REPO` env var, common install paths, then
 * falls back to resolving the `hermes` CLI via `which(1)` + `realpathSync`.
 *
 * Returns the full path to `plugins/memory/signet/__init__.py` when found,
 * or `null` if Hermes is not installed or the Signet plugin is absent.
 *
 * Exported so connector-hermes-agent can import this instead of duplicating
 * the same logic, keeping the two detection paths in sync.
 */
export function resolveHermesRepoPluginPath(): string | null {
	const pluginFile = join("plugins", "memory", "signet", "__init__.py");

	const hermesRepo = resolveHermesRepoPath();
	if (hermesRepo !== null) {
		const candidate = join(hermesRepo, pluginFile);
		if (existsSync(candidate)) return candidate;
	}

	return null;
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
			ohMyPi: isSignetManagedOhMyPiInstall() || existsSync(resolveOhMyPiAgentDir()),
			pi: isSignetManagedPiInstall() || existsSync(resolvePiAgentDir()),
			hermesAgent: resolveHermesRepoPath() !== null,
			gemini: existsSync(join(home, ".gemini", "settings.json")),
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
 * Check if a directory has the minimum required identity files.
 * Returns false when identity mode is off or passthrough — those modes
 * intentionally omit identity files.
 */
export function hasValidIdentity(basePath: string): boolean {
	const mode = loadIdentityMode(basePath);
	if (mode !== "managed") return true; // identity files not required
	for (const key of REQUIRED_IDENTITY_KEYS) {
		const spec = IDENTITY_FILES[key];
		if (!existsSync(join(basePath, spec.path))) {
			return false;
		}
	}
	return true;
}

/**
 * Get list of missing required identity files.
 * Returns an empty list when identity mode is off or passthrough.
 */
export function getMissingIdentityFiles(basePath: string): string[] {
	const mode = loadIdentityMode(basePath);
	if (mode !== "managed") return [];

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

const STATIC_HEADER_BY_FILE: Record<string, string> = {
	"AGENTS.md": "Agent Instructions",
	"SOUL.md": "Soul",
	"IDENTITY.md": "Identity",
	"USER.md": "About Your User",
	"MEMORY.md": "Working Memory",
};

function isSafeRelativeIdentityPath(path: string): boolean {
	const trimmed = path.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("/") || trimmed.startsWith("~")) return false;
	return !trimmed.split(/[\\/]/).includes("..");
}

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isIdentityMode(value: unknown): value is IdentityMode {
	return typeof value === "string" && (IDENTITY_MODES as readonly string[]).includes(value);
}

export function resolveIdentityModeFromConfig(config: unknown): IdentityMode {
	const root = readRecord(config);
	const capabilities = readRecord(root.capabilities);
	const capabilityIdentity = readRecord(capabilities.identity);
	if (isIdentityMode(capabilityIdentity.mode)) return capabilityIdentity.mode;

	const identity = readRecord(root.identity);
	if (isIdentityMode(identity.mode)) return identity.mode;
	if (identity.enabled === false) return "off";

	// Existing installs predate capability modules and should keep the current
	// rich identity behavior unless they explicitly opt out.
	return "managed";
}

export function loadIdentityMode(agentsDir: string): IdentityMode {
	const agentYaml = join(agentsDir, "agent.yaml");
	if (!existsSync(agentYaml)) return "managed";
	try {
		return resolveIdentityModeFromConfig(parseSimpleYaml(readFileSync(agentYaml, "utf-8")));
	} catch {
		return "managed";
	}
}

export function identityModeManagesFiles(mode: IdentityMode): boolean {
	return mode === "managed";
}

export function identityModeReadsFiles(mode: IdentityMode): boolean {
	return mode !== "off";
}

function readIdentityEntry(value: unknown): IdentityContextFileEntry | null {
	if (typeof value === "string") {
		return isSafeRelativeIdentityPath(value) ? { path: value } : null;
	}
	const record = readRecord(value);
	const path = typeof record.path === "string" ? record.path.trim() : "";
	if (!isSafeRelativeIdentityPath(path)) return null;
	if (record.enabled === false) return null;
	const role = typeof record.role === "string" ? record.role : undefined;
	const rawBudget =
		typeof record.budget === "number" ? record.budget : Number.parseInt(String(record.budget ?? ""), 10);
	const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : undefined;
	return { path, role, budget };
}

function readIdentityEntryList(value: unknown): IdentityContextFileEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map(readIdentityEntry).filter((entry): entry is IdentityContextFileEntry => entry !== null);
}

function readSpecialIdentityEntry(value: unknown): IdentitySpecialFileEntry | null {
	const record = readRecord(value);
	const kind = typeof record.kind === "string" ? record.kind : "";
	if (kind !== "dreaming" && kind !== "heartbeat" && kind !== "bootstrap") return null;
	const entry = readIdentityEntry(value);
	if (!entry) return null;
	return { ...entry, kind };
}

function readSpecialIdentityEntryList(value: unknown): IdentitySpecialFileEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map(readSpecialIdentityEntry).filter((entry): entry is IdentitySpecialFileEntry => entry !== null);
}

function identityHeaderFor(path: string, role?: string): string {
	const filename = path.split(/[\\/]/).pop() ?? path;
	return STATIC_HEADER_BY_FILE[filename] ?? role ?? filename.replace(/\.md$/i, "");
}

export function resolveStartupIdentityFiles(agentsDir: string): IdentityContextFileEntry[] {
	const agentYaml = join(agentsDir, "agent.yaml");
	if (!existsSync(agentYaml)) return STATIC_BUDGETS.map(({ file, budget }) => ({ path: file, budget }));
	try {
		const config = parseSimpleYaml(readFileSync(agentYaml, "utf-8"));
		if (!identityModeReadsFiles(resolveIdentityModeFromConfig(config))) return [];
		const identity = readRecord(config.identity);
		const startup = readRecord(identity.startup);
		const configured = readIdentityEntryList(startup.load);
		if (configured.length > 0) return configured;
		const presetName = typeof identity.preset === "string" ? identity.preset : "";
		const preset = IDENTITY_PRESETS[presetName as IdentityPresetName];
		if (preset) return preset.startup;
	} catch {
		// Fall back to legacy static identity order.
	}
	return STATIC_BUDGETS.map(({ file, budget }) => ({ path: file, budget }));
}

export function resolveSpecialIdentityFiles(agentsDir: string, kind: IdentitySessionKind): IdentitySpecialFileEntry[] {
	const agentYaml = join(agentsDir, "agent.yaml");
	if (!existsSync(agentYaml)) {
		return IDENTITY_PRESETS.minimal.special.filter((entry) => entry.kind === kind);
	}
	try {
		const config = parseSimpleYaml(readFileSync(agentYaml, "utf-8"));
		if (!identityModeReadsFiles(resolveIdentityModeFromConfig(config))) return [];
		const identity = readRecord(config.identity);
		const configured = readSpecialIdentityEntryList(identity.special).filter((entry) => entry.kind === kind);
		if (configured.length > 0) return configured;
		const presetName = typeof identity.preset === "string" ? identity.preset : "";
		const preset = IDENTITY_PRESETS[presetName as IdentityPresetName];
		if (preset) return preset.special.filter((entry) => entry.kind === kind);
	} catch {
		// Fall back to the minimal special-session prompt set.
	}
	return IDENTITY_PRESETS.minimal.special.filter((entry) => entry.kind === kind);
}

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

export function resolvePromptSubmitTimeoutMs(raw?: string): number {
	if (!raw) return 5_000;
	const ms = Number.parseInt(raw, 10);
	if (!Number.isFinite(ms) || ms < 1_000) return 5_000;
	if (ms > 120_000) return 120_000;
	return ms;
}

/**
 * Read identity files directly from disk and compose a degraded inject string.
 * Used as fallback when the daemon is unreachable during session-start.
 *
 * Returns null if no identity files exist.
 */
export function readStaticIdentity(agentsDir: string, status = STATIC_IDENTITY_OFFLINE_STATUS): string | null {
	if (!existsSync(agentsDir)) return null;
	if (!identityModeReadsFiles(loadIdentityMode(agentsDir))) return null;

	const parts: string[] = [];

	for (const entry of resolveStartupIdentityFiles(agentsDir)) {
		const path = join(agentsDir, entry.path);
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8").trim();
			if (!raw) continue;
			const budget = entry.budget ?? STATIC_BUDGETS.find((candidate) => candidate.file === entry.path)?.budget ?? 4_000;
			const content = raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`;
			parts.push(`## ${identityHeaderFor(entry.path, entry.role)}\n\n${content}`);
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
