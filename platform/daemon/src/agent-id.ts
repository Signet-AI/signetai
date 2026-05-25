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
	const explicit = body.agentId?.trim();
	if (explicit) return explicit;
	const parts = (body.sessionKey ?? "").split(":");
	if (parts[0] === "agent" && parts[1]?.trim()) return parts[1].trim();
	return "default";
}

export function resolveDaemonAgentId(env: NodeJS.ProcessEnv = process.env): string {
	const agentId = env.SIGNET_AGENT_ID?.trim();
	return resolveAgentId({ agentId });
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

export function ensureAgentRegistered(agentId: string, readPolicy = "shared"): void {
	const id = agentId.trim() || "default";
	const now = new Date().toISOString();
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES (?, ?, ?, NULL, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
			).run(id, id, readPolicy, now, now);
		});
	} catch (err) {
		console.warn(
			`[agent-id] Failed to register agent "${id}" (non-fatal):`,
			err instanceof Error ? err.message : String(err),
		);
	}
}
