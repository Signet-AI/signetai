/**
 * @signet/connector-opencode
 *
 * Signet connector for OpenCode - installs hooks and generates config
 * during 'signet install'.
 *
 * This connector:
 *   - Writes a bundled signet.mjs plugin to ~/.config/opencode/plugins/
 *     (OpenCode auto-discovers plugins from that directory)
 *   - Generates ~/.config/opencode/AGENTS.md from identity files
 *   - Migrates away from the legacy memory.mjs approach on install/uninstall
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
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
} from "@signet/connector-base";
import { hasValidIdentity } from "@signet/core";
import { PLUGIN_BUNDLE } from "./plugin-bundle.js";

// ============================================================================
// Types
// ============================================================================

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
 * Run during 'signet install' to write the plugin bundle and AGENTS.md.
 */
export class OpenCodeConnector extends BaseConnector {
	readonly name = "OpenCode";
	readonly harnessId = "opencode";

	private getOpenCodePath(): string {
		return join(homedir(), ".config", "opencode");
	}

	getConfigPath(): string {
		const opencodePath = this.getOpenCodePath();
		for (const candidate of this.getConfigCandidates(opencodePath)) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		return join(opencodePath, "opencode.json");
	}

	private getPluginsPath(opencodePath: string): string {
		return join(opencodePath, "plugins");
	}

	private getPluginFilePath(opencodePath: string): string {
		return join(this.getPluginsPath(opencodePath), "signet.mjs");
	}

	/**
	 * Install OpenCode integration
	 *
	 * Writes:
	 *   - ~/.config/opencode/plugins/signet.mjs  — bundled plugin
	 *   - ~/.config/opencode/AGENTS.md            — agent instructions
	 *
	 * Also migrates away from the legacy memory.mjs approach.
	 */
	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];

		if (!hasValidIdentity(basePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${basePath}`,
				filesWritten: [],
			};
		}

		const opencodePath = this.getOpenCodePath();
		const pluginsPath = this.getPluginsPath(opencodePath);

		if (!existsSync(opencodePath)) {
			mkdirSync(opencodePath, { recursive: true });
		}

		if (!existsSync(pluginsPath)) {
			mkdirSync(pluginsPath, { recursive: true });
		}

		// Migrate away from legacy memory.mjs before writing new plugin
		this.migrateFromLegacy(opencodePath);

		// Write bundled plugin (OpenCode auto-discovers plugins/ directory)
		const pluginFilePath = this.getPluginFilePath(opencodePath);
		writeFileSync(pluginFilePath, PLUGIN_BUNDLE);
		filesWritten.push(pluginFilePath);

		// Generate AGENTS.md from identity files
		const agentsMdPath = await this.generateAgentsMd(basePath);
		if (agentsMdPath) {
			filesWritten.push(agentsMdPath);
		}

		// Register Signet MCP server in OpenCode config
		this.registerMcpServer(opencodePath);

		// Symlink skills directory
		const skillsSource = join(basePath, "skills");
		const skillsDest = join(opencodePath, "skills");
		if (existsSync(skillsSource)) {
			this.symlinkSkills(skillsSource, skillsDest);
		}

		return {
			success: true,
			message: "OpenCode integration installed successfully",
			filesWritten,
		};
	}

	/**
	 * Remove Signet integration from OpenCode
	 */
	async uninstall(): Promise<UninstallResult> {
		const opencodePath = this.getOpenCodePath();
		const filesRemoved: string[] = [];

		const pluginFilePath = this.getPluginFilePath(opencodePath);
		if (existsSync(pluginFilePath)) {
			rmSync(pluginFilePath);
			filesRemoved.push(pluginFilePath);
		}

		const agentsMdPath = join(opencodePath, "AGENTS.md");
		if (existsSync(agentsMdPath)) {
			rmSync(agentsMdPath);
			filesRemoved.push(agentsMdPath);
		}

		this.migrateFromLegacy(opencodePath);
		this.removeMcpServer(opencodePath);

		return { filesRemoved };
	}

	/**
	 * Check if Signet integration is already set up for OpenCode
	 */
	isInstalled(): boolean {
		return existsSync(this.getPluginFilePath(this.getOpenCodePath()));
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

	// ============================================================================
	// Migration
	// ============================================================================

	/**
	 * Remove legacy memory.mjs installation artifacts
	 *
	 * Deletes the old memory.mjs from the OpenCode root directory and scrubs
	 * any file:// URL or path referencing it from all known config candidates.
	 */
	private migrateFromLegacy(opencodePath: string): void {
		const legacyPluginPath = join(opencodePath, "memory.mjs");

		if (existsSync(legacyPluginPath)) {
			rmSync(legacyPluginPath);
		}

		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;

			let config: JsonObject;
			try {
				config = parseJsonOrJsonc(readFileSync(configPath, "utf-8"));
			} catch {
				continue;
			}

			const changed = this.removeMemoryMjsEntries(config);
			if (changed) {
				writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
			}
		}
	}

	/**
	 * Scrub any plugin entry that references memory.mjs from the config object.
	 * Returns true if the config was modified.
	 */
	private removeMemoryMjsEntries(config: JsonObject): boolean {
		const isLegacyEntry = (entry: string): boolean => {
			const t = entry.trim();
			if (t === "./memory.mjs" || t === "memory.mjs") return true;
			if (t.endsWith("/memory.mjs")) return true;
			return false;
		};

		let changed = false;

		for (const key of ["plugin", "plugins"] as const) {
			if (!(key in config)) continue;

			const current = toStringArray(config[key]);
			const filtered = current.filter((e) => !isLegacyEntry(e));

			if (filtered.length !== current.length) {
				config[key] = filtered;
				changed = true;
			}
		}

		return changed;
	}

	// ============================================================================
	// Internal helpers
	// ============================================================================

	/**
	 * Register Signet MCP server in OpenCode config file
	 */
	private registerMcpServer(opencodePath: string): void {
		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;

			let config: JsonObject;
			try {
				config = parseJsonOrJsonc(readFileSync(configPath, "utf-8"));
			} catch {
				continue;
			}

			const existingMcp = isJsonObject(config.mcp)
				? (config.mcp as JsonObject)
				: {};
			config.mcp = {
				...existingMcp,
				signet: {
					type: "local",
					command: ["signet-mcp"],
					enabled: true,
				},
			};
			writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
			return; // Only update first found config
		}
	}

	/**
	 * Remove Signet MCP server from OpenCode config file
	 */
	private removeMcpServer(opencodePath: string): void {
		for (const configPath of this.getConfigCandidates(opencodePath)) {
			if (!existsSync(configPath)) continue;

			let config: JsonObject;
			try {
				config = parseJsonOrJsonc(readFileSync(configPath, "utf-8"));
			} catch {
				continue;
			}

			if (isJsonObject(config.mcp)) {
				const mcp = config.mcp as JsonObject;
				delete mcp.signet;
				if (Object.keys(mcp).length === 0) {
					delete config.mcp;
				}
				writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
			}
		}
	}

	private getConfigCandidates(opencodePath: string): string[] {
		return [
			join(opencodePath, "opencode.json"),
			join(opencodePath, "opencode.jsonc"),
			join(opencodePath, "config.json"),
		];
	}

	/**
	 * Generate AGENTS.md for OpenCode from identity files
	 */
	private async generateAgentsMd(basePath: string): Promise<string | null> {
		const sourcePath = join(basePath, "AGENTS.md");

		if (!existsSync(sourcePath)) {
			return null;
		}

		const raw = readFileSync(sourcePath, "utf-8");
		const userContent = this.stripSignetBlock(raw);
		const header = this.generateHeader(sourcePath);

		const destPath = join(this.getOpenCodePath(), "AGENTS.md");
		writeFileSync(destPath, header + this.buildSignetBlock() + userContent);

		return destPath;
	}
}

// ============================================================================
// Exports
// ============================================================================

export const opencodeConnector = new OpenCodeConnector();
export default OpenCodeConnector;
