/**
 * Detect existing Signet workspaces and installed harnesses.
 *
 * Workspace identity files are shared core data. Harness installation paths are
 * integration policy, so their detection stays at the CLI boundary.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasOhMyPiSetup } from "@signet/connector-oh-my-pi";
import { hasPiSetup } from "@signet/connector-pi";
import { IDENTITY_FILES, resolveHermesRepoPath, resolveKimiHomePath } from "@signet/core";

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
		forge: boolean;
		codex: boolean;
		kimi: boolean;
		ohMyPi: boolean;
		pi: boolean;
		hermesAgent: boolean;
		gemini: boolean;
	};
}

function isBinaryOnPath(bin: string): boolean {
	const separator = process.platform === "win32" ? ";" : ":";
	return (process.env.PATH ?? "")
		.split(separator)
		.some((directory) => directory.length > 0 && existsSync(join(directory, bin)));
}

/**
 * Detect existing identity setup at a given path.
 *
 * This is a CLI/setup concern: the core package owns identity data and
 * primitives, while this boundary composes integration-specific detectors.
 */
export function detectExistingSetup(basePath: string): SetupDetection {
	const identityFileNames = Object.values(IDENTITY_FILES).map((spec) => spec.path);

	const foundFiles: string[] = [];
	for (const fileName of identityFileNames) {
		if (existsSync(join(basePath, fileName))) {
			foundFiles.push(fileName);
		}
	}

	const memoryDir = join(basePath, "memory");
	let memoryLogCount = 0;
	if (existsSync(memoryDir)) {
		try {
			const files = readdirSync(memoryDir);
			memoryLogCount = files.filter(
				(fileName: string) => fileName.endsWith(".md") && !fileName.startsWith("TEMPLATE"),
			).length;
		} catch {
			// Ignore errors.
		}
	}

	const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
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
			forge:
				existsSync(join(home, ".forge", ".mcp.json")) ||
				existsSync(join(home, "forge", ".mcp.json")) ||
				existsSync(join(home, ".forge", ".forge.toml")) ||
				existsSync(join(home, "forge", ".forge.toml")),
			codex:
				existsSync(join(home, ".codex", "config.toml")) || existsSync(join(home, ".config", "signet", "bin", "codex")),
			kimi:
				existsSync(join(resolveKimiHomePath(), "config.toml")) ||
				existsSync(join(home, ".kimi-code", "config.toml")) ||
				isBinaryOnPath("kimi"),
			ohMyPi: hasOhMyPiSetup(),
			pi: hasPiSetup(),
			hermesAgent: resolveHermesRepoPath() !== null,
			gemini: existsSync(join(home, ".gemini", "settings.json")),
		},
	};
}
