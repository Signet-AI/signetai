import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";

export interface DashboardIdentity {
	name: string;
	creature: string;
	vibe: string;
}

interface AgentConfig {
	name?: string;
	description?: string;
}

function isAgentConfig(value: unknown): value is AgentConfig {
	return typeof value === "object" && value !== null;
}

function readIdentityValue(content: string, key: string): string {
	const match = content.match(new RegExp(`^\\s*-?\\s*${key}:\\s*(.+)$`, "im"));
	return match?.[1]?.trim() ?? "";
}

export function loadDashboardIdentity(
	agentsDir: string,
	onWarn?: (message: string, err: unknown) => void,
): DashboardIdentity {
	const identity: DashboardIdentity = { name: "", creature: "", vibe: "" };
	const agentYaml = join(agentsDir, "agent.yaml");
	if (existsSync(agentYaml)) {
		try {
			const config = parseSimpleYaml(readFileSync(agentYaml, "utf-8"));
			const agent = config.agent;
			if (isAgentConfig(agent)) {
				identity.name = typeof agent.name === "string" ? agent.name.trim() : "";
				identity.creature = typeof agent.description === "string" ? agent.description.trim() : "";
			}
		} catch (err) {
			onWarn?.("Failed to parse agent.yaml for dashboard identity", err);
		}
	}

	const identityMd = join(agentsDir, "IDENTITY.md");
	if (existsSync(identityMd)) {
		try {
			const content = readFileSync(identityMd, "utf-8");
			identity.name ||= readIdentityValue(content, "name");
			identity.creature ||= readIdentityValue(content, "creature") || readIdentityValue(content, "role");
			identity.vibe ||= readIdentityValue(content, "vibe");
		} catch (err) {
			onWarn?.("Failed to parse IDENTITY.md for dashboard identity", err);
		}
	}

	return {
		name: identity.name || "Unknown",
		creature: identity.creature,
		vibe: identity.vibe,
	};
}
