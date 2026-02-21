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

import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
} from "@signet/connector-base";
import {
	type IdentityMap,
	hasValidIdentity,
	loadIdentityFilesSync,
} from "@signet/core";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateMemoryPlugin } from "./templates/memory.mjs.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionStartContext {
	directory: string;
	identity?: IdentityMap;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];

	const strings: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			strings.push(item);
		}
	}

	return strings;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function stripJsonComments(source: string): string {
	let result = "";
	let inString = false;
	let quote = '"';
	let escaped = false;
	let inSingleLineComment = false;
	let inMultiLineComment = false;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (inSingleLineComment) {
			if (ch === "\n") {
				inSingleLineComment = false;
				result += ch;
			}
			continue;
		}

		if (inMultiLineComment) {
			if (ch === "*" && next === "/") {
				inMultiLineComment = false;
				i++;
			}
			continue;
		}

		if (inString) {
			result += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				inString = false;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			result += ch;
			continue;
		}

		if (ch === "/" && next === "/") {
			inSingleLineComment = true;
			i++;
			continue;
		}

		if (ch === "/" && next === "*") {
			inMultiLineComment = true;
			i++;
			continue;
		}

		result += ch;
	}

	return result;
}

function stripTrailingCommas(source: string): string {
	let result = "";
	let inString = false;
	let quote = '"';
	let escaped = false;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];

		if (inString) {
			result += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				inString = false;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			result += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;
			while (j < source.length && /\s/.test(source[j])) {
				j++;
			}
			if (source[j] === "}" || source[j] === "]") {
				continue;
			}
		}

		result += ch;
	}

	return result;
}

function parseJsonOrJsonc(raw: string): JsonObject {
	const content = raw.replace(/^\uFEFF/, "");

	try {
		const parsed: unknown = JSON.parse(content);
		if (isJsonObject(parsed)) {
			return parsed;
		}
	} catch {
		// Fall through to JSONC-compatible parse.
	}

	const withoutComments = stripJsonComments(content);
	const withoutTrailingCommas = stripTrailingCommas(withoutComments);
	const parsed: unknown = JSON.parse(withoutTrailingCommas);

	if (!isJsonObject(parsed)) {
		throw new Error("OpenCode config must be a top-level object");
	}

	return parsed;
}

// ============================================================================
// OpenCode Connector
// ============================================================================

/**
 * OpenCode connector for Signet
 *
 * Implements the connector pattern for setting up OpenCode integration.
 * Run during 'signet install' to generate OpenCode-specific config files.
 */
export class OpenCodeConnector extends BaseConnector {
	readonly name = "OpenCode";
	readonly harnessId = "opencode";

	/**
	 * Get the path to OpenCode's config directory
	 */
	private getOpenCodePath(): string {
		return join(homedir(), ".config", "opencode");
	}

	/**
	 * Get the path to OpenCode's config file
	 */
	getConfigPath(): string {
		for (const candidate of this.getConfigCandidates()) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}

		return this.getConfigCandidates()[0];
	}

	/**
	 * Install OpenCode integration
	 *
	 * Generates:
	 *   - ~/.config/opencode/memory.mjs - Plugin with /remember and /recall
	 *   - ~/.config/opencode/opencode.json - Plugin registration (or compatible config file)
	 *   - ~/.config/opencode/AGENTS.md - Agent instructions from identity
	 *
	 * @param basePath - Path to Signet identity files (usually ~/.agents)
	 */
	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];

		// Validate basePath has valid identity
		if (!hasValidIdentity(basePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${basePath}`,
				filesWritten: [],
			};
		}

		// Ensure OpenCode config directory exists
		const opencodePath = this.getOpenCodePath();
		if (!existsSync(opencodePath)) {
			mkdirSync(opencodePath, { recursive: true });
		}

		// Generate memory.mjs plugin
		const pluginContent = generateMemoryPlugin({});
		const pluginPath = join(opencodePath, "memory.mjs");
		writeFileSync(pluginPath, pluginContent);
		filesWritten.push(pluginPath);

		// Ensure OpenCode loads the local memory plugin
		const configUpdate = this.configureMemoryPluginRegistration(pluginPath);
		if (configUpdate.wroteConfig) {
			filesWritten.push(configUpdate.path);
		}

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
	 * Remove Signet integration from OpenCode
	 *
	 * Deletes the generated files. Does not remove the entire OpenCode config.
	 */
	async uninstall(): Promise<UninstallResult> {
		const opencodePath = this.getOpenCodePath();
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		const pluginPath = join(opencodePath, "memory.mjs");
		configsPatched.push(...this.removeMemoryPluginRegistration(pluginPath));

		if (existsSync(pluginPath)) {
			rmSync(pluginPath);
			filesRemoved.push(pluginPath);
		}

		const agentsMdPath = join(opencodePath, "AGENTS.md");
		if (existsSync(agentsMdPath)) {
			rmSync(agentsMdPath);
			filesRemoved.push(agentsMdPath);
		}

		if (configsPatched.length > 0) {
			return { filesRemoved, configsPatched };
		}

		return { filesRemoved };
	}

	/**
	 * Check if Signet integration is already set up for OpenCode
	 */
	isInstalled(): boolean {
		const pluginPath = join(this.getOpenCodePath(), "memory.mjs");
		if (!existsSync(pluginPath)) {
			return false;
		}

		return this.hasMemoryPluginRegistration(pluginPath);
	}

	// ============================================================================
	// OpenCode-Specific Methods
	// ============================================================================

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
	 * and injected Signet system block, ensuring the agent always knows
	 * how to use Signet even when the source file pre-dated installation.
	 */
	private async generateAgentsMd(basePath: string): Promise<string | null> {
		const sourcePath = join(basePath, "AGENTS.md");

		if (!existsSync(sourcePath)) {
			return null;
		}

		const raw = readFileSync(sourcePath, "utf-8");
		// Use base class method to strip existing block
		const userContent = this.stripSignetBlock(raw);
		// Use base class method to generate header
		const header = this.generateHeader(sourcePath);

		const opencodePath = this.getOpenCodePath();
		const destPath = join(opencodePath, "AGENTS.md");
		// Use base class method to build Signet block
		writeFileSync(destPath, header + this.buildSignetBlock() + userContent);

		return destPath;
	}

	/**
	 * Generate memory.mjs plugin file
	 *
	 * Creates the OpenCode plugin that provides /remember and /recall tools.
	 */
	async generateMemoryPlugin(_basePath: string): Promise<string> {
		const pluginContent = generateMemoryPlugin({});

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
	static isHarnessInstalled(): boolean {
		const opencodePath = join(homedir(), ".config", "opencode");
		const candidates = [
			join(opencodePath, "opencode.json"),
			join(opencodePath, "opencode.jsonc"),
			join(opencodePath, "config.json"),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return true;
			}
		}

		return false;
	}

	private getConfigCandidates(): string[] {
		const opencodePath = this.getOpenCodePath();
		return [
			join(opencodePath, "opencode.json"),
			join(opencodePath, "opencode.jsonc"),
			join(opencodePath, "config.json"),
		];
	}

	private readOpenCodeConfig(configPath: string): JsonObject {
		if (!existsSync(configPath)) {
			return {};
		}

		try {
			return parseJsonOrJsonc(readFileSync(configPath, "utf-8"));
		} catch {
			return {};
		}
	}

	private writeOpenCodeConfig(configPath: string, config: JsonObject): void {
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	}

	private hasPluginMatch(entry: string, pluginPath: string): boolean {
		const pluginSpec = pathToFileURL(pluginPath).toString();
		const trimmed = entry.trim();

		if (trimmed === pluginSpec) return true;
		if (trimmed === pluginPath) return true;
		if (trimmed === "./memory.mjs" || trimmed === "memory.mjs") return true;
		if (trimmed.endsWith("/memory.mjs")) return true;

		return false;
	}

	private readPluginEntries(config: JsonObject): string[] {
		if ("plugin" in config) {
			return toStringArray(config.plugin);
		}
		if ("plugins" in config) {
			return toStringArray(config.plugins);
		}
		return [];
	}

	private upsertMemoryPlugin(config: JsonObject, pluginPath: string): boolean {
		const pluginSpec = pathToFileURL(pluginPath).toString();
		const pluginEntries = this.readPluginEntries(config);

		for (const entry of pluginEntries) {
			if (this.hasPluginMatch(entry, pluginPath)) {
				return false;
			}
		}

		const nextPlugins = [pluginSpec, ...pluginEntries];
		const currentPlugin = toStringArray(config.plugin);
		const currentPlugins = toStringArray(config.plugins);

		let changed = false;

		if ("plugin" in config || !("plugins" in config)) {
			if (!arraysEqual(currentPlugin, nextPlugins)) {
				config.plugin = nextPlugins;
				changed = true;
			}
		}

		if ("plugins" in config) {
			if (!arraysEqual(currentPlugins, nextPlugins)) {
				config.plugins = nextPlugins;
				changed = true;
			}
		}

		if (!("plugin" in config) && !("plugins" in config)) {
			config.plugin = nextPlugins;
			changed = true;
		}

		return changed;
	}

	private removeMemoryPlugin(config: JsonObject, pluginPath: string): boolean {
		const currentPlugin = toStringArray(config.plugin);
		const currentPlugins = toStringArray(config.plugins);

		const filteredPlugin = currentPlugin.filter(
			(entry) => !this.hasPluginMatch(entry, pluginPath),
		);
		const filteredPlugins = currentPlugins.filter(
			(entry) => !this.hasPluginMatch(entry, pluginPath),
		);

		let changed = false;

		if (!arraysEqual(currentPlugin, filteredPlugin)) {
			config.plugin = filteredPlugin;
			changed = true;
		}

		if (!arraysEqual(currentPlugins, filteredPlugins)) {
			config.plugins = filteredPlugins;
			changed = true;
		}

		return changed;
	}

	private configureMemoryPluginRegistration(pluginPath: string): {
		path: string;
		wroteConfig: boolean;
	} {
		const configPath = this.getConfigPath();
		const existed = existsSync(configPath);
		const config = this.readOpenCodeConfig(configPath);
		const changed = this.upsertMemoryPlugin(config, pluginPath);

		const wroteConfig = !existed || changed;
		if (wroteConfig) {
			this.writeOpenCodeConfig(configPath, config);
		}

		return { path: configPath, wroteConfig };
	}

	private removeMemoryPluginRegistration(pluginPath: string): string[] {
		const patched: string[] = [];

		for (const configPath of this.getConfigCandidates()) {
			if (!existsSync(configPath)) {
				continue;
			}

			const config = this.readOpenCodeConfig(configPath);
			const changed = this.removeMemoryPlugin(config, pluginPath);

			if (changed) {
				this.writeOpenCodeConfig(configPath, config);
				patched.push(configPath);
			}
		}

		return patched;
	}

	private hasMemoryPluginRegistration(pluginPath: string): boolean {
		for (const configPath of this.getConfigCandidates()) {
			if (!existsSync(configPath)) {
				continue;
			}

			const config = this.readOpenCodeConfig(configPath);
			const pluginEntries = this.readPluginEntries(config);

			for (const entry of pluginEntries) {
				if (this.hasPluginMatch(entry, pluginPath)) {
					return true;
				}
			}
		}

		return false;
	}
}

// ============================================================================
// Exports
// ============================================================================

// Export singleton instance for convenience
export const opencodeConnector = new OpenCodeConnector();

// Re-export template generator for advanced use
export { generateMemoryPlugin } from "./templates/memory.mjs.js";

// Default export
export default OpenCodeConnector;
