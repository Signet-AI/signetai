/**
 * Signet Connector for Claude Code
 *
 * Integrates Signet's memory system with Claude Code's lifecycle hooks.
 *
 * Usage:
 * ```typescript
 * import { ClaudeCodeConnector } from '@signet/connector-claude-code';
 *
 * const connector = new ClaudeCodeConnector();
 * await connector.install('~/.agents');
 * ```
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Re-export types needed from @signet/core
// Note: These are inline until @signet/core exports proper .d.ts files
export interface IdentityFile {
	path: string;
	content: string;
}

export interface IdentityMap {
	manifest?: IdentityFile;
	soul?: IdentityFile;
	memory?: IdentityFile;
	config?: IdentityFile;
}

/**
 * Synchronously load identity files from a base path
 * Simplified inline implementation
 */
function loadIdentityFilesSync(basePath: string): IdentityMap | null {
	const { existsSync, readFileSync } = require("node:fs");
	const { join } = require("node:path");

	const identity: IdentityMap = {};
	const files = [
		{ key: "manifest", file: "agent.yaml" },
		{ key: "soul", file: "soul.md" },
		{ key: "memory", file: "memory.md" },
		{ key: "config", file: "config.yaml" },
	];

	let hasAny = false;
	for (const { key, file } of files) {
		const filePath = join(basePath, file);
		if (existsSync(filePath)) {
			identity[key as keyof IdentityMap] = {
				path: filePath,
				content: readFileSync(filePath, "utf-8"),
			};
			hasAny = true;
		}
	}

	return hasAny ? identity : null;
}

// ============================================================================
// Types
// ============================================================================

export interface ConnectorConfig {
	daemonUrl?: string;
	memoryScript?: string;
	hooks?: {
		sessionStart?: boolean;
		userPromptSubmit?: boolean;
		sessionEnd?: boolean;
	};
}

export interface SessionContext {
	projectPath?: string;
	sessionId?: string;
	harness?: string;
}

export interface SessionStartResult {
	identity: {
		name: string;
		description?: string;
	};
	memories: Array<{
		id: number;
		content: string;
		type: string;
		importance: number;
		created_at: string;
	}>;
	recentContext?: string;
	inject: string;
}

export interface SessionEndResult {
	success: boolean;
	memoriesExtracted: number;
}

// ============================================================================
// Claude Code Connector
// ============================================================================

/**
 * Connector for Claude Code (Anthropic's CLI)
 *
 * Implements the Signet connector interface for Claude Code, handling:
 * - Hook installation into ~/.claude/settings.json
 * - CLAUDE.md generation from identity files
 * - Skills directory symlink management
 * - Lifecycle callbacks for session management
 */
export class ClaudeCodeConnector {
	readonly name = "claude-code";
	readonly displayName = "Claude Code";

	private config: ConnectorConfig;
	private daemonUrl: string;

	constructor(config: ConnectorConfig = {}) {
		this.config = config;
		this.daemonUrl = config.daemonUrl || "http://localhost:3850";
	}

	/**
	 * Install the connector into Claude Code
	 *
	 * This method:
	 * - Configures hooks in ~/.claude/settings.json
	 * - Generates ~/.claude/CLAUDE.md from identity files
	 * - Symlinks skills directory to ~/.claude/skills/
	 *
	 * Safe to run multiple times (idempotent).
	 */
	async install(basePath: string): Promise<void> {
		const expandedBasePath = this.expandPath(basePath);
		const memoryScript =
			this.config.memoryScript ||
			join(expandedBasePath, "memory", "scripts", "memory.py");

		// Configure hooks in settings.json
		await this.configureHooks(expandedBasePath, memoryScript);

		// Generate CLAUDE.md from identity files
		await this.generateClaudeMd(expandedBasePath);

		// Symlink skills directory
		this.symlinkSkills(expandedBasePath);
	}

	/**
	 * Uninstall the connector from Claude Code
	 *
	 * Removes hooks from settings.json but preserves other settings.
	 */
	async uninstall(): Promise<void> {
		const settingsPath = join(homedir(), ".claude", "settings.json");

		if (!existsSync(settingsPath)) return;

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			// Remove signet hooks
			if (settings.hooks) {
				settings.hooks.SessionStart = undefined;
				settings.hooks.UserPromptSubmit = undefined;
				settings.hooks.SessionEnd = undefined;

				// Remove empty hooks object
				if (Object.keys(settings.hooks).length === 0) {
					settings.hooks = undefined;
				}
			}

			writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
		} catch {
			// If parsing fails, leave settings as-is
		}
	}

	/**
	 * Called when a session starts
	 *
	 * Loads context from the daemon including identity and relevant memories.
	 */
	async onSessionStart(
		ctx: SessionContext,
	): Promise<SessionStartResult | null> {
		try {
			const res = await fetch(`${this.daemonUrl}/api/hooks/session-start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "claude-code",
					projectPath: ctx.projectPath,
					sessionId: ctx.sessionId,
				}),
				signal: AbortSignal.timeout(5000),
			});

			if (!res.ok) {
				console.warn("[signet] Session start hook failed:", res.status);
				return null;
			}

			return (await res.json()) as SessionStartResult;
		} catch (e) {
			console.warn("[signet] Session start hook error:", e);
			return null;
		}
	}

	/**
	 * Called when a session ends
	 *
	 * Extracts memories from the conversation and saves them.
	 */
	async onSessionEnd(ctx: SessionContext): Promise<SessionEndResult> {
		try {
			const res = await fetch(`${this.daemonUrl}/api/hooks/session-end`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: "claude-code",
					sessionId: ctx.sessionId,
				}),
				signal: AbortSignal.timeout(10000),
			});

			if (!res.ok) {
				console.warn("[signet] Session end hook failed:", res.status);
				return { success: false, memoriesExtracted: 0 };
			}

			const data = (await res.json()) as { memoriesExtracted?: number };
			return {
				success: true,
				memoriesExtracted: data.memoriesExtracted || 0,
			};
		} catch (e) {
			console.warn("[signet] Session end hook error:", e);
			return { success: false, memoriesExtracted: 0 };
		}
	}

	/**
	 * Check if the connector is installed
	 */
	isInstalled(): boolean {
		const settingsPath = join(homedir(), ".claude", "settings.json");

		if (!existsSync(settingsPath)) return false;

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			// Check if Signet hooks are present
			return (
				settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command?.includes(
					"memory.py",
				) || false
			);
		} catch {
			return false;
		}
	}

	// ============================================================================
	// Private Methods
	// ============================================================================

	/**
	 * Configure hooks in ~/.claude/settings.json
	 */
	private async configureHooks(
		basePath: string,
		memoryScript: string,
	): Promise<void> {
		const settingsPath = join(homedir(), ".claude", "settings.json");
		const claudeDir = join(homedir(), ".claude");

		// Ensure ~/.claude directory exists
		mkdirSync(claudeDir, { recursive: true });

		// Load existing settings or create new
		let settings: Record<string, unknown> = {};
		if (existsSync(settingsPath)) {
			try {
				settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				// If parsing fails, start fresh
				settings = {};
			}
		}

		// Determine which hooks to enable
		const hooksConfig = this.config.hooks || {
			sessionStart: true,
			userPromptSubmit: true,
			sessionEnd: true,
		};

		// Build hooks configuration
		const hooks: Record<string, unknown[]> = {};

		if (hooksConfig.sessionStart !== false) {
			hooks.SessionStart = [
				{
					hooks: [
						{
							type: "command",
							command: `${memoryScript} load --mode session-start --project "$(pwd)"`,
							timeout: 3000,
						},
					],
				},
			];
		}

		if (hooksConfig.userPromptSubmit !== false) {
			hooks.UserPromptSubmit = [
				{
					hooks: [
						{
							type: "command",
							command: `${memoryScript} load --mode prompt --project "$(pwd)"`,
							timeout: 2000,
						},
					],
				},
			];
		}

		if (hooksConfig.sessionEnd !== false) {
			hooks.SessionEnd = [
				{
					hooks: [
						{
							type: "command",
							command: `${memoryScript} save --mode auto`,
							timeout: 10000,
						},
					],
				},
			];
		}

		// Merge with existing hooks (Signet hooks take precedence for our events)
		settings.hooks = {
			...(settings.hooks as Record<string, unknown>),
			...hooks,
		};

		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	}

	/**
	 * Generate ~/.claude/CLAUDE.md from identity files
	 */
	private async generateClaudeMd(basePath: string): Promise<void> {
		const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
		const agentsMdPath = join(basePath, "AGENTS.md");

		// Try to read AGENTS.md first
		if (existsSync(agentsMdPath)) {
			const content = readFileSync(agentsMdPath, "utf-8");
			const header = this.generateHeader(agentsMdPath);
			writeFileSync(claudeMdPath, header + content);
			return;
		}

		// Fall back to generating from identity files
		const identity = loadIdentityFilesSync(basePath);
		if (identity) {
			const content = this.generateFromIdentity(identity, basePath);
			const header = this.generateHeader(join(basePath, "agent.yaml"));
			writeFileSync(claudeMdPath, header + content);
		}
	}

	/**
	 * Generate the auto-generated header
	 */
	private generateHeader(sourcePath: string): string {
		return `# Auto-generated from ${sourcePath}
# Source: ${sourcePath}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ~/.agents/ instead

`;
	}

	/**
	 * Generate CLAUDE.md content from identity files
	 */
	private generateFromIdentity(
		identity: IdentityMap,
		basePath: string,
	): string {
		const parts: string[] = [];

		// Add soul content
		if (identity.soul?.content) {
			parts.push(identity.soul.content);
		}

		// Add memory content
		if (identity.memory?.content) {
			parts.push("\n# Memory\n\n");
			parts.push(identity.memory.content);
		}

		// Add config summary if available
		if (identity.config?.content) {
			parts.push("\n# Configuration\n\n");
			parts.push("```yaml");
			parts.push(identity.config.content);
			parts.push("```\n");
		}

		return parts.join("");
	}

	/**
	 * Symlink skills directory
	 */
	private symlinkSkills(basePath: string): void {
		const sourceSkillsDir = join(basePath, "skills");
		const targetSkillsDir = join(homedir(), ".claude", "skills");

		if (!existsSync(sourceSkillsDir)) return;

		// Ensure target parent exists
		mkdirSync(join(homedir(), ".claude"), { recursive: true });

		// Create target directory
		mkdirSync(targetSkillsDir, { recursive: true });

		const skills = readdirSync(sourceSkillsDir);
		for (const skill of skills) {
			const src = join(sourceSkillsDir, skill);
			const dest = join(targetSkillsDir, skill);

			// Skip if not a directory
			try {
				if (!statSync(src).isDirectory()) continue;
			} catch {
				continue;
			}

			// Handle existing destination
			try {
				const destStat = lstatSync(dest);
				if (destStat.isSymbolicLink()) {
					// Remove existing symlink to recreate
					unlinkSync(dest);
				} else {
					// It's a real directory - skip to avoid data loss
					continue;
				}
			} catch {
				// dest doesn't exist, that's fine
			}

			try {
				symlinkSync(src, dest);
			} catch {
				// Symlinks might fail on some systems
			}
		}
	}

	/**
	 * Expand ~ to home directory
	 */
	private expandPath(path: string): string {
		if (path.startsWith("~")) {
			return join(homedir(), path.slice(1));
		}
		return path;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Claude Code connector instance
 */
export function createConnector(config?: ConnectorConfig): ClaudeCodeConnector {
	return new ClaudeCodeConnector(config);
}

// ============================================================================
// Default Export
// ============================================================================

export default ClaudeCodeConnector;
