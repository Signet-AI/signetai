import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getAgentIdentityFiles, parseSimpleYaml } from "@signet/core";
import type { ContextIdentityConfig, ContextIdentityFileConfig } from "./hooks-config";
import { countTokens, truncateToTokens } from "./pipeline/tokenizer";

export type IdentityFileMap = Record<string, string>;

const TRUNCATED_MARKER = "\n[truncated]";

export interface IdentityContextSection {
	path: string;
	header: string;
	content: string;
}

const IDENTITY_HEADER_BY_FILE: Record<string, string> = {
	"AGENTS.md": "Agent Instructions",
	"SOUL.md": "Soul",
	"IDENTITY.md": "Identity",
	"USER.md": "About Your User",
	"MEMORY.md": "Working Memory",
};

function identityHeaderFor(path: string, entry?: Pick<ContextIdentityFileConfig, "header" | "role">): string {
	if (entry?.header) return entry.header;
	const filename = path.split(/[\\/]/).pop() ?? path;
	return IDENTITY_HEADER_BY_FILE[filename] ?? entry?.role ?? filename.replace(/\.md$/i, "");
}

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

function readIdentityPathWithBudget(
	filePath: string | undefined,
	budget: Pick<ContextIdentityFileConfig, "maxTokens" | "maxChars" | "budget">,
): string | undefined {
	if (!filePath || !existsSync(filePath)) return undefined;

	try {
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return undefined;

		if (budget.maxTokens !== undefined) {
			if (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0) return undefined;
			const maxTokens = Math.floor(budget.maxTokens);
			if (countTokens(content) <= maxTokens) return content;
			// Reserve room for the marker so the final string stays within budget.
			// If the budget is too small to also flag truncation, cap without the marker
			// rather than exceed the declared budget.
			const markerTokens = countTokens(TRUNCATED_MARKER);
			if (markerTokens >= maxTokens) return truncateToTokens(content, maxTokens);
			return `${truncateToTokens(content, maxTokens - markerTokens)}${TRUNCATED_MARKER}`;
		}

		const charBudget = budget.maxChars ?? budget.budget;
		if (charBudget !== undefined) {
			if (!Number.isFinite(charBudget) || charBudget <= 0) return undefined;
			const maxChars = Math.floor(charBudget);
			if (content.length <= maxChars) return content;
			const markerChars = TRUNCATED_MARKER.length;
			if (markerChars >= maxChars) return content.slice(0, maxChars);
			return `${content.slice(0, maxChars - markerChars)}${TRUNCATED_MARKER}`;
		}

		return content;
	} catch {
		return undefined;
	}
}

function identityPathFor(agentsDir: string, path: string, identityFiles?: IdentityFileMap): string {
	return identityFiles?.[path] ?? join(agentsDir, path);
}

function isSafeResolvedIdentityPath(agentsDir: string, filePath: string): boolean {
	try {
		const base = realpathSync(agentsDir);
		const target = realpathSync(filePath);
		if (!target.toLowerCase().endsWith(".md")) return false;
		const rel = relative(base, target);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
		const deniedDirs = new Set([".daemon", ".secrets", "memory"]);
		return rel.split(/[\\/]/).every((part) => {
			const normalized = part.toLowerCase();
			return !normalized.startsWith(".") && !deniedDirs.has(normalized);
		});
	} catch {
		return false;
	}
}

export function readContextIdentitySections(
	agentsDir: string,
	identity: ContextIdentityConfig | undefined,
	identityFiles?: IdentityFileMap,
): IdentityContextSection[] | null {
	if (identity?.include === false) return [];
	if (!identity?.files) return null;

	const sections: IdentityContextSection[] = [];
	for (const entry of identity.files) {
		if (entry.enabled === false) continue;
		const filePath = identityPathFor(agentsDir, entry.path, identityFiles);
		if (!isSafeResolvedIdentityPath(agentsDir, filePath)) continue;
		const content = readIdentityPathWithBudget(filePath, entry);
		if (!content) continue;
		sections.push({ path: entry.path, header: identityHeaderFor(entry.path, entry), content });
	}
	return sections;
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

export function loadIdentity(
	agentsDir: string,
	identityFiles?: IdentityFileMap,
): { name: string; description?: string } {
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
