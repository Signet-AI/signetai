import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentIdentityFiles, parseSimpleYaml } from "@signet/core";

export type IdentityFileMap = Record<string, string>;

function readIdentityPath(filePath: string | undefined, charBudget: number): string | undefined {
	if (!filePath || !existsSync(filePath)) return undefined;

	try {
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return undefined;
		if (content.length <= charBudget) return content;
		return `${content.slice(0, charBudget)}\n[truncated]`;
	} catch {
		return undefined;
	}
}

export function readIdentityFile(
	agentsDir: string,
	fileName: string,
	charBudget: number,
	identityFiles?: IdentityFileMap,
): string | undefined {
	return readIdentityPath(identityFiles?.[fileName] ?? join(agentsDir, fileName), charBudget);
}

export function readMemoryMd(
	agentsDir: string,
	charBudget: number,
	identityFiles?: IdentityFileMap,
): string | undefined {
	return readIdentityFile(agentsDir, "MEMORY.md", charBudget, identityFiles);
}

export function readAgentsMd(
	agentsDir: string,
	charBudget: number,
	identityFiles?: IdentityFileMap,
): string | undefined {
	return readIdentityFile(agentsDir, "AGENTS.md", charBudget, identityFiles);
}

export function resolveIdentityFiles(agentId: string, agentsDir: string): IdentityFileMap {
	if (!agentId || agentId === "default") return {};
	return getAgentIdentityFiles(agentId, agentsDir);
}

interface AgentConfig {
	name?: string;
	description?: string;
}

function isAgentConfig(value: unknown): value is AgentConfig {
	return typeof value === "object" && value !== null;
}

export function parseIdentityMarkdown(content: string): { name: string; description?: string } {
	const nameMatch = content.match(/name:\s*(.+)/i);
	const youAreMatch = content.match(/(?:^|\n)\s*(?:#+\s*)?you are\s+([^\n.]+)\.?/i);
	const descMatch = content.match(/creature:\s*(.+)/i) || content.match(/role:\s*(.+)/i);

	return {
		name: (nameMatch?.[1] ?? youAreMatch?.[1] ?? "Agent").trim(),
		description: descMatch?.[1]?.trim(),
	};
}

export function loadIdentity(agentsDir: string, identityFiles?: IdentityFileMap): { name: string; description?: string } {
	const identityMd = identityFiles?.["IDENTITY.md"];
	if (identityMd && existsSync(identityMd)) {
		try {
			return parseIdentityMarkdown(readFileSync(identityMd, "utf-8"));
		} catch {}
	}

	const agentYaml = join(agentsDir, "agent.yaml");
	if (existsSync(agentYaml)) {
		try {
			const content = readFileSync(agentYaml, "utf-8");
			const config = parseSimpleYaml(content);
			const agent = config.agent;
			if (isAgentConfig(agent) && agent.name) {
				return {
					name: agent.name,
					description: agent.description,
				};
			}
		} catch {}
	}

	const rootIdentityMd = join(agentsDir, "IDENTITY.md");
	if (existsSync(rootIdentityMd)) {
		try {
			return parseIdentityMarkdown(readFileSync(rootIdentityMd, "utf-8"));
		} catch {}
	}

	return { name: "Agent" };
}
