/**
 * @signet/connector-opencode
 *
 * Signet connector for OpenCode - installs hooks and generates config
 * during 'signet install'.
 *
 * This connector:
 *   - Generates ~/.config/opencode/memory.mjs plugin with /remember and /recall tools
 *   - Generates ~/.config/opencode/AGENTS.md from identity files
 *   - Loads context on session start
 *
 * Limitations:
 *   - OpenCode does not yet support SessionEnd hooks
 *   - Session summaries must be saved explicitly via /remember
 *   - The Signet daemon can provide auto-save if running
 *
 * @example
 * ```typescript
 * import { OpenCodeConnector } from '@signet/connector-opencode'
 *
 * const connector = new OpenCodeConnector()
 * await connector.install('/home/user/.agents')
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type IdentityMap,
	hasValidIdentity,
	loadIdentityFilesSync,
} from "@signet/core";
import { generateMemoryPlugin } from "./templates/memory.mjs.js";

export interface InstallResult {
	success: boolean;
	message: string;
	filesWritten: string[];
}

export interface SessionStartContext {
	directory: string;
	identity?: IdentityMap;
}

/**
 * OpenCode connector for Signet
 *
 * Implements the connector pattern for setting up OpenCode integration.
 * Run during 'signet install' to generate OpenCode-specific config files.
 */
export class OpenCodeConnector {
	readonly name = "opencode";
	readonly description = "OpenCode AI assistant";

	/**
	 * Get the OpenCode config directory path
	 */
	private getOpenCodePath(): string {
		return join(homedir(), ".config", "opencode");
	}

	/**
	 * Install OpenCode integration
	 *
	 * Generates:
	 *   - ~/.config/opencode/memory.mjs - Plugin with /remember and /recall
	 *   - ~/.config/opencode/AGENTS.md - Agent instructions from identity
	 *
	 * @param basePath - Path to Signet identity files (usually ~/.agents)
	 * @param memoryScript - Path to memory.py script
	 */
	async install(
		basePath: string,
		memoryScript?: string,
	): Promise<InstallResult> {
		const filesWritten: string[] = [];

		// Validate basePath has valid identity
		if (!hasValidIdentity(basePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${basePath}`,
				filesWritten: [],
			};
		}

		// Determine memory script path
		const scriptPath =
			memoryScript || join(basePath, "memory", "scripts", "memory.py");

		// Ensure OpenCode config directory exists
		const opencodePath = this.getOpenCodePath();
		if (!existsSync(opencodePath)) {
			mkdirSync(opencodePath, { recursive: true });
		}

		// Generate memory.mjs plugin
		const pluginContent = generateMemoryPlugin({ memoryScript: scriptPath });
		const pluginPath = join(opencodePath, "memory.mjs");
		writeFileSync(pluginPath, pluginContent);
		filesWritten.push(pluginPath);

		// Generate AGENTS.md from identity files
		const agentsMdPath = await this.generateAgentsMd(basePath);
		if (agentsMdPath) {
			filesWritten.push(agentsMdPath);
		}

		return {
			success: true,
			message: "OpenCode integration installed successfully",
			filesWritten,
		};
	}

	/**
	 * Called when an OpenCode session starts
	 *
	 * Loads identity files and returns context for injection.
	 * This is a helper for runtime use; the actual injection is
	 * handled by the memory.mjs plugin.
	 */
	onSessionStart(ctx: SessionStartContext): string | null {
		const identity = loadIdentityFilesSync(
			ctx.directory || process.env.HOME || "~/.agents",
		);

		if (!identity.agents?.content) {
			return null;
		}

		// Build context string from identity files
		const parts: string[] = [];

		if (identity.identity?.content) {
			parts.push(identity.identity.content);
		}

		if (identity.user?.content) {
			parts.push(`\n---\n${identity.user.content}`);
		}

		if (identity.memory?.content) {
			parts.push(`\n---\n${identity.memory.content}`);
		}

		return parts.join("\n") || null;
	}

	/**
	 * Generate AGENTS.md for OpenCode
	 *
	 * Copies the identity AGENTS.md to OpenCode config with a header
	 * indicating it's auto-generated.
	 */
	async generateAgentsMd(basePath: string): Promise<string | null> {
		const sourcePath = join(basePath, "AGENTS.md");

		if (!existsSync(sourcePath)) {
			return null;
		}

		const content = readFileSync(sourcePath, "utf-8");
		const header = `# Auto-generated from ~/.agents/AGENTS.md
# Source: ${sourcePath}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit ~/.agents/AGENTS.md instead

`;

		const opencodePath = this.getOpenCodePath();
		const destPath = join(opencodePath, "AGENTS.md");
		writeFileSync(destPath, header + content);

		return destPath;
	}

	/**
	 * Generate memory.mjs plugin file
	 *
	 * Creates the OpenCode plugin that provides /remember and /recall tools.
	 */
	async generateMemoryPlugin(
		basePath: string,
		memoryScript?: string,
	): Promise<string> {
		const scriptPath =
			memoryScript || join(basePath, "memory", "scripts", "memory.py");
		const pluginContent = generateMemoryPlugin({ memoryScript: scriptPath });

		const opencodePath = this.getOpenCodePath();
		if (!existsSync(opencodePath)) {
			mkdirSync(opencodePath, { recursive: true });
		}

		const pluginPath = join(opencodePath, "memory.mjs");
		writeFileSync(pluginPath, pluginContent);

		return pluginPath;
	}

	/**
	 * Check if OpenCode is installed on the system
	 */
	static isInstalled(): boolean {
		const configPath = join(homedir(), ".config", "opencode", "config.json");
		return existsSync(configPath);
	}

	/**
	 * Check if Signet integration is already set up for OpenCode
	 */
	isSetUp(): boolean {
		const pluginPath = join(this.getOpenCodePath(), "memory.mjs");
		return existsSync(pluginPath);
	}

	/**
	 * Remove Signet integration from OpenCode
	 *
	 * Deletes the generated files. Does not remove the entire OpenCode config.
	 */
	async uninstall(): Promise<string[]> {
		const opencodePath = this.getOpenCodePath();
		const removed: string[] = [];

		const pluginPath = join(opencodePath, "memory.mjs");
		if (existsSync(pluginPath)) {
			const { rmSync } = await import("node:fs");
			rmSync(pluginPath);
			removed.push(pluginPath);
		}

		const agentsMdPath = join(opencodePath, "AGENTS.md");
		if (existsSync(agentsMdPath)) {
			const { rmSync } = await import("node:fs");
			rmSync(agentsMdPath);
			removed.push(agentsMdPath);
		}

		return removed;
	}
}

// Export singleton instance for convenience
export const opencodeConnector = new OpenCodeConnector();

// Re-export template generator for advanced use
export { generateMemoryPlugin } from "./templates/memory.mjs.js";

// Default export
export default OpenCodeConnector;
