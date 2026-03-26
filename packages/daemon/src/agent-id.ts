/**
 * Agent ID resolution helpers.
 */

import { getDbAccessor } from "./db-accessor";

export interface AgentScope {
	readonly readPolicy: string;
	readonly policyGroup: string | null;
}

/**
 * Resolve the agent ID from a request body.
 * Falls back to parsing OpenClaw's "agent:{id}:{rest}" session key format.
 * Final fallback: "default".
 */
export function resolveAgentId(body: { agentId?: string; sessionKey?: string }): string {
	if (body.agentId) return body.agentId;
	const parts = (body.sessionKey ?? "").split(":");
	if (parts[0] === "agent" && parts[1]?.trim()) return parts[1].trim();
	return "default";
}

function parseScopeValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

export function getAgentScope(agentId: string): AgentScope {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db.prepare("SELECT read_policy, policy_group FROM agents WHERE id = ?").get(agentId);
			if (!row || typeof row !== "object") {
				return {
					readPolicy: "isolated",
					policyGroup: null,
				};
			}

			const readPolicy = parseScopeValue("read_policy" in row ? row.read_policy : undefined) ?? "isolated";
			const policyGroup = parseScopeValue("policy_group" in row ? row.policy_group : undefined);
			return { readPolicy, policyGroup };
		});
	} catch {
		return {
			readPolicy: "isolated",
			policyGroup: null,
		};
	}
}
