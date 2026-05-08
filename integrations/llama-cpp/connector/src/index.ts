/**
 * @signet/connector-llama-cpp
 *
 * Signet connector for llama.cpp. Unlike other connectors that patch
 * config files for an existing chat tool, this connector ships a complete
 * runtime chat client that bridges llama-server's OpenAI-compatible API
 * with Signet's daemon for tool calling and session lifecycle hooks.
 *
 * Install writes:
 *   - ~/.config/signet-llama-cpp/config.json — runtime config
 *   - System prompt from workspace identity files
 *   - Skills symlinks
 *
 * The runtime (`signet-llama-chat`) is a standalone CLI that:
 *   1. Connects to a running llama-server (OpenAI-compatible)
 *   2. Fetches Signet tool schemas from the daemon MCP endpoint
 *   3. Runs an interactive chat loop with tool-call routing
 *   4. Calls Signet session hooks for memory lifecycle
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
import { expandHome, hasValidIdentity, resolveSignetDaemonUrl } from "@signet/core";

interface LlamaCppRuntimeConfig {
	readonly signetDaemonUrl: string;
	readonly llamaServerUrl: string;
	readonly model?: string;
	readonly contextLength: number;
	readonly gpuLayers: number;
	readonly systemPrompt?: string;
}

const DEFAULT_CONFIG: Omit<LlamaCppRuntimeConfig, "systemPrompt"> = {
	signetDaemonUrl: "http://localhost:3850",
	llamaServerUrl: "http://localhost:8080",
	contextLength: 8192,
	gpuLayers: 99,
};

function buildSystemPrompt(basePath: string): string {
	const parts: string[] = [];
	const identityFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"] as const;

	for (const name of identityFiles) {
		const filePath = join(basePath, name);
		if (!existsSync(filePath)) continue;
		try {
			const content = readFileSync(filePath, "utf-8").trim();
			if (!content) continue;
			parts.push(content);
		} catch {}
	}

	if (parts.length === 0) return "";

	return [
		"You are an AI assistant with access to persistent memory through Signet tools.",
		"You can save memories, search your past conversations, manage knowledge, and recall information across sessions.",
		"Use these tools proactively to remember important details and provide personalized help.",
		"",
		"## Identity",
		"",
		...parts,
	].join("\n");
}

export class LlamaCppConnector extends BaseConnector {
	readonly name = "llama.cpp";
	readonly harnessId = "llama-cpp";

	private getConfigDir(): string {
		return join(homedir(), ".config", "signet-llama-cpp");
	}

	getConfigPath(): string {
		return join(this.getConfigDir(), "config.json");
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));

		if (!hasValidIdentity(expandedBasePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${expandedBasePath}`,
				filesWritten,
			};
		}

		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const configDir = this.getConfigDir();
		mkdirSync(configDir, { recursive: true });

		const daemonUrl = resolveSignetDaemonUrl();
		const systemPrompt = buildSystemPrompt(expandedBasePath);
		const config: LlamaCppRuntimeConfig = {
			...DEFAULT_CONFIG,
			signetDaemonUrl: daemonUrl,
			systemPrompt,
		};

		const configPath = this.getConfigPath();
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
		filesWritten.push(configPath);
		configsPatched.push(configPath);

		const skillsSource = join(expandedBasePath, "skills");
		const skillsDest = join(configDir, "skills");
		if (existsSync(skillsSource)) {
			this.symlinkSkills(skillsSource, skillsDest);
		}

		return {
			success: true,
			message: "llama.cpp integration installed — runtime config + system prompt + skills",
			filesWritten,
			configsPatched,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];
		const configDir = this.getConfigDir();

		const configPath = this.getConfigPath();
		if (existsSync(configPath)) {
			rmSync(configPath);
			filesRemoved.push(configPath);
		}

		const skillsDir = join(configDir, "skills");
		if (existsSync(skillsDir)) {
			rmSync(skillsDir, { recursive: true, force: true });
			filesRemoved.push(skillsDir);
		}

		if (existsSync(configDir) && readdirSync(configDir).length === 0) {
			rmSync(configDir, { recursive: true, force: true });
			filesRemoved.push(configDir);
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		return existsSync(this.getConfigPath());
	}

	static isHarnessInstalled(): boolean {
		return existsSync(join(homedir(), ".config", "signet-llama-cpp", "config.json"));
	}
}

export const llamaCppConnector = new LlamaCppConnector();
export default LlamaCppConnector;
