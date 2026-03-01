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
	BaseConnector,
	type InstallResult,
	type UninstallResult,
} from "@signet/connector-base";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type IdentityMap, loadIdentityFilesSync } from "@signet/core";

// ============================================================================
// Types
// ============================================================================

export interface ConnectorConfig {
	daemonUrl?: string;
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
export class ClaudeCodeConnector extends BaseConnector {
	readonly name = "Claude Code";
	readonly harnessId = "claude-code";

	private config: ConnectorConfig;
	private daemonUrl: string;

	constructor(config: ConnectorConfig = {}) {
		super();
		this.config = config;
		this.daemonUrl = config.daemonUrl || "http://localhost:3850";
	}

	/**
	 * Install the connector into Claude Code
	 */
	async install(basePath: string): Promise<InstallResult> {
		const expandedBasePath = this.expandPath(basePath);
		const filesWritten: string[] = [];

		// Configure hooks in settings.json
		await this.configureHooks(expandedBasePath);
		const settingsPath = this.getConfigPath();
		filesWritten.push(settingsPath);

		// Generate CLAUDE.md from identity files
		const claudeMdPath = await this.generateClaudeMd(expandedBasePath);
		if (claudeMdPath) {
			filesWritten.push(claudeMdPath);
		}

		// Symlink skills directory using base class method
		const sourceSkillsDir = join(expandedBasePath, "skills");
		const targetSkillsDir = join(homedir(), ".claude", "skills");
		this.symlinkSkills(sourceSkillsDir, targetSkillsDir);

		return {
			success: true,
			message: "Claude Code integration installed successfully",
			filesWritten,
		};
	}

	/**
	 * Uninstall the connector from Claude Code
	 */
	async uninstall(): Promise<UninstallResult> {
		const settingsPath = this.getConfigPath();
		const filesRemoved: string[] = [];

		if (!existsSync(settingsPath)) {
			return { filesRemoved };
		}

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			// Remove signet hooks
			if (settings.hooks) {
				settings.hooks.SessionStart = undefined;
				settings.hooks.UserPromptSubmit = undefined;
				settings.hooks.PreCompaction = undefined;
				settings.hooks.SessionEnd = undefined;

				// Remove empty hooks object
				if (Object.keys(settings.hooks).length === 0) {
					settings.hooks = undefined;
				}
			}

			writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			filesRemoved.push(settingsPath);
		} catch {
			// If parsing fails, leave settings as-is
		}

		// Remove MCP server from ~/.claude.json
		this.removeMcpServer();

		return { filesRemoved };
	}

	/**
	 * Check if the connector is installed
	 */
	isInstalled(): boolean {
		const settingsPath = this.getConfigPath();

		if (!existsSync(settingsPath)) return false;

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			// Check if Signet hooks are present
			return (
				settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command?.includes(
					"signet hook",
				) || false
			);
		} catch {
			return false;
		}
	}

	/**
	 * Get the path to Claude Code's settings.json
	 */
	getConfigPath(): string {
		return join(homedir(), ".claude", "settings.json");
	}

	// ============================================================================
	// Session Lifecycle Methods
	// ============================================================================

	/**
	 * Called when a session starts
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

	// ============================================================================
	// Private Methods
	// ============================================================================

	/**
	 * Configure hooks in ~/.claude/settings.json
	 */
	private async configureHooks(_basePath: string): Promise<void> {
		const settingsPath = this.getConfigPath();
		const claudeDir = join(homedir(), ".claude");

		mkdirSync(claudeDir, { recursive: true });

		let settings: Record<string, unknown> = {};
		if (existsSync(settingsPath)) {
			try {
				settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			} catch {
				settings = {};
			}
		}

		const hooksConfig = this.config.hooks || {
			sessionStart: true,
			userPromptSubmit: true,
			sessionEnd: true,
		};

		const hooks: Record<string, unknown[]> = {};

		if (hooksConfig.sessionStart !== false) {
			hooks.SessionStart = [
				{
					hooks: [
						{
							type: "command",
							command:
								'signet hook session-start -H claude-code --project "$(pwd)"',
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
							command:
								'signet hook user-prompt-submit -H claude-code --project "$(pwd)"',
							timeout: 2000,
						},
					],
				},
			];
		}

		hooks.PreCompaction = [
			{
				hooks: [
					{
						type: "command",
						command:
							'signet hook pre-compaction -H claude-code --project "$(pwd)"',
						timeout: 3000,
					},
				],
			},
		];

		if (hooksConfig.sessionEnd !== false) {
			hooks.SessionEnd = [
				{
					hooks: [
						{
							type: "command",
							command: "signet hook session-end -H claude-code",
							timeout: 15000,
						},
					],
				},
			];
		}

		settings.hooks = {
			...(settings.hooks as Record<string, unknown>),
			...hooks,
		};

		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

		// Register Signet MCP server in ~/.claude.json (user scope)
		this.registerMcpServer();
	}

	/**
	 * Generate ~/.claude/CLAUDE.md from identity files
	 */
	private async generateClaudeMd(basePath: string): Promise<string | null> {
		const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
		const agentsMdPath = join(basePath, "AGENTS.md");

		// Ensure ~/.claude directory exists
		mkdirSync(join(homedir(), ".claude"), { recursive: true });

		// Try to read AGENTS.md first
		if (existsSync(agentsMdPath)) {
			const raw = readFileSync(agentsMdPath, "utf-8");
			// Use base class method to strip existing block
			const userContent = this.stripSignetBlock(raw);
			const header = this.generateHeader(agentsMdPath);

			// Compose additional identity files
			const extras = this.composeIdentityExtras(basePath);

			// Use base class method to build block
			writeFileSync(
				claudeMdPath,
				header + this.buildSignetBlock() + userContent + extras,
			);
			return claudeMdPath;
		}

		// Fall back to generating from identity files
		const identity = loadIdentityFilesSync(basePath);
		if (identity) {
			const content = this.generateFromIdentity(identity, basePath);
			const header = this.generateHeader(join(basePath, "agent.yaml"));
			writeFileSync(claudeMdPath, header + this.buildSignetBlock() + content);
			return claudeMdPath;
		}

		return null;
	}

	/**
	 * Generate CLAUDE.md content from identity files
	 */
	private generateFromIdentity(
		identity: IdentityMap,
		_basePath: string,
	): string {
		const parts: string[] = [];

		// Add soul content
		if (identity.soul?.content) {
			parts.push(identity.soul.content);
		}

		// Add identity content if available
		if (identity.identity?.content) {
			parts.push("\n# Identity\n\n");
			parts.push(identity.identity.content);
		}

		// Add user profile
		if (identity.user?.content) {
			parts.push("\n# About Your User\n\n");
			parts.push(identity.user.content);
		}

		// Add memory content
		if (identity.memory?.content) {
			parts.push("\n# Memory\n\n");
			parts.push(identity.memory.content);
		}

		return parts.join("");
	}

	/**
	 * Register Signet MCP server in ~/.claude.json (user scope)
	 *
	 * Claude Code reads MCP servers from the top-level `mcpServers` key
	 * in ~/.claude.json, NOT from ~/.claude/settings.json.
	 */
	private registerMcpServer(): void {
		const claudeJsonPath = join(homedir(), ".claude.json");

		let config: Record<string, unknown> = {};
		if (existsSync(claudeJsonPath)) {
			try {
				config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
			} catch {
				return; // Don't corrupt an unparseable config
			}
		}

		const existingMcp =
			(config.mcpServers as Record<string, unknown> | undefined) ?? {};
		config.mcpServers = {
			...existingMcp,
			signet: {
				type: "stdio",
				command: "signet-mcp",
				args: [] as string[],
				env: {},
			},
		};

		writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
	}

	/**
	 * Remove Signet MCP server from ~/.claude.json
	 */
	private removeMcpServer(): void {
		const claudeJsonPath = join(homedir(), ".claude.json");

		if (!existsSync(claudeJsonPath)) return;

		let config: Record<string, unknown>;
		try {
			config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
		} catch {
			return;
		}

		if (
			config.mcpServers &&
			typeof config.mcpServers === "object" &&
			!Array.isArray(config.mcpServers)
		) {
			const mcp = config.mcpServers as Record<string, unknown>;
			delete mcp.signet;
			if (Object.keys(mcp).length === 0) {
				delete config.mcpServers;
			}
			writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
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

// Default export
export default ClaudeCodeConnector;
