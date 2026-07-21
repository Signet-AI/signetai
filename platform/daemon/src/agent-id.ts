/**
 * Agent ID resolution helpers.
 */

import type { AgentRosterReadPolicy } from "@signet/core";
import { getDbAccessor } from "./db-accessor";

export interface AgentScope {
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
}

/**
 * Resolve default daemon agent ID from environment.
 */
export function defaultAgentId(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.SIGNET_AGENT_ID?.trim();
	return configured && configured.length > 0 ? configured : "default";
}

/**
 * Resolve the agent ID from a request body.
 * Falls back to parsing OpenClaw's "agent:{id}:{rest}" session key format.
 * Final fallback: configured daemon agent or "default".
 */
export function resolveAgentId(
	body: { agentId?: string; sessionKey?: string },
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicit = body.agentId?.trim();
	if (explicit) return explicit;
	const parts = (body.sessionKey ?? "").split(":");
	if (parts[0] === "agent" && parts[1]?.trim()) return parts[1].trim();
	return defaultAgentId(env);
}

export function resolveDaemonAgentId(env: NodeJS.ProcessEnv = process.env): string {
	return defaultAgentId(env);
}

function parseScopeValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

function parseReadPolicy(value: unknown): AgentRosterReadPolicy {
	const policy = parseScopeValue(value);
	if (policy === "shared" || policy === "group" || policy === "isolated") return policy;
	return "isolated";
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

			const readPolicy = parseReadPolicy("read_policy" in row ? row.read_policy : undefined);
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

export function ensureAgentRegistered(agentId: string, readPolicy: AgentRosterReadPolicy = "shared"): void {
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
