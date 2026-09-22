import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, ReadPolicy } from "./types";

export type AgentRosterReadPolicy = "isolated" | "shared" | "group";

export interface ResolvedAgentMemoryPolicy {
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
	readonly effectiveScope: "agent" | "global" | "group";
}

export function resolveAgentMemoryPolicy(readPolicy: unknown, policyGroup: unknown): ResolvedAgentMemoryPolicy {
	if (readPolicy !== "isolated" && readPolicy !== "shared" && readPolicy !== "group") {
		throw new Error("memory must be one of: isolated, shared, group");
	}
	if (readPolicy === "group") {
		if (typeof policyGroup !== "string" || policyGroup.length === 0)
			throw new Error("group is required when memory is group");
		return { readPolicy, policyGroup, effectiveScope: "group" };
	}
	if (policyGroup !== undefined && policyGroup !== null) throw new Error("group is only valid when memory is group");
	return { readPolicy, policyGroup: null, effectiveScope: readPolicy === "shared" ? "global" : "agent" };
}

export interface NormalizedAgentRosterEntry {
	readonly name: string;
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
}
const IDENTITY_FILES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"TOOLS.md",
	"HEARTBEAT.md",
	"MEMORY.md",
	"BOOTSTRAP.md",
];
export function discoverAgents(agentsDir: string): AgentDefinition[] {
	const root = join(agentsDir, "agents");
	if (!existsSync(root)) return [];

	return readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => ({ name: d.name }));
}
export function scaffoldAgent(name: string, agentsDir: string): void {
	const dir = join(agentsDir, "agents", name);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const soul = join(dir, "SOUL.md");
	if (!existsSync(soul)) writeFileSync(soul, `# Soul\n\nAdd ${name}'s personality here.\n`);

	const identity = join(dir, "IDENTITY.md");
	if (!existsSync(identity)) writeFileSync(identity, `# Identity\n\nname: ${name}\n`);
}
export function getAgentIdentityFiles(name: string, agentsDir: string): Record<string, string> {
	const result: Record<string, string> = {};
	const agentDir = join(agentsDir, "agents", name);

	for (const file of IDENTITY_FILES) {
		const specific = join(agentDir, file);
		const fallback = join(agentsDir, file);
		if (existsSync(specific)) result[file] = specific;
		else if (existsSync(fallback)) result[file] = fallback;
	}

	return result;
}

function normalizeReadPolicy(
	readPolicy: unknown,
	policyGroup: unknown,
): {
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
} {
	if (readPolicy === "shared") return { readPolicy: "shared", policyGroup: null };
	if (readPolicy === "isolated") return { readPolicy: "isolated", policyGroup: null };
	if (
		typeof readPolicy === "object" &&
		readPolicy !== null &&
		(readPolicy as { type?: unknown }).type === "group" &&
		typeof (readPolicy as { group?: unknown }).group === "string"
	) {
		return {
			readPolicy: "group",
			policyGroup: (readPolicy as { group: string }).group,
		};
	}
	if (readPolicy === "group" && typeof policyGroup === "string") {
		return { readPolicy: "group", policyGroup };
	}
	return { readPolicy: "isolated", policyGroup: null };
}

export function normalizeAgentRosterEntry(entry: unknown): NormalizedAgentRosterEntry | null {
	if (typeof entry !== "object" || entry === null) return null;
	const record = entry as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name.length === 0) return null;
	const memory =
		typeof record.memory === "object" && record.memory !== null ? (record.memory as Record<string, unknown>) : null;
	const { readPolicy, policyGroup } = normalizeReadPolicy(
		memory?.read_policy ?? record.read_policy,
		memory?.policy_group ?? record.policy_group,
	);
	return { name: record.name, readPolicy, policyGroup };
}

export function buildAgentMemoryConfig(
	readPolicy: AgentRosterReadPolicy,
	policyGroup: string | null,
): { readonly read_policy: ReadPolicy } {
	if (readPolicy === "shared") return { read_policy: "shared" };
	if (readPolicy === "group" && typeof policyGroup === "string" && policyGroup.length > 0) {
		return { read_policy: { type: "group", group: policyGroup } };
	}
	return { read_policy: "isolated" };
}
export function resolveAgentSkills(agentDef: AgentDefinition, allSkills: readonly string[]): string[] {
	if (agentDef.skills == null) return [...allSkills];
	if (agentDef.skills.length === 0) return [];
	const allowed = new Set(agentDef.skills);
	return allSkills.filter((s) => allowed.has(s));
}
