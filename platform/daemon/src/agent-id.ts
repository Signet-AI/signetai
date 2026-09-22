import type { AgentRosterReadPolicy } from "@signet/core";
import { registerDbAccessorCloseParticipant } from "./db-accessor-lifecycle";
import { getDbAccessorPath } from "./db-accessor";
import { getDbOwner } from "./db-owner-runtime";
import { ownerReadOne, ownerRun } from "./db-owner-sql";

export interface AgentScope {
	readonly readPolicy: AgentRosterReadPolicy;
	readonly policyGroup: string | null;
}
export function defaultAgentId(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.SIGNET_AGENT_ID?.trim();
	return configured && configured.length > 0 ? configured : "default";
}
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

interface AgentScopeCacheEntry {
	readonly scope: AgentScope;
	readonly expiresAt: number;
}

const AGENT_SCOPE_CACHE_TTL_MS = 30_000;
const agentScopeCache = new Map<string, AgentScopeCacheEntry>();
const agentScopeReads = new Map<string, Promise<AgentScope>>();
let agentScopeGeneration = 0;

const isolatedScope: AgentScope = { readPolicy: "isolated", policyGroup: null };

function normalizedAgentId(agentId: string): string {
	return agentId.trim() || "default";
}
export function invalidateAgentScopeCache(agentId?: string): void {
	agentScopeGeneration += 1;
	if (agentId === undefined) {
		agentScopeCache.clear();
		return;
	}
	agentScopeCache.delete(normalizedAgentId(agentId));
}

registerDbAccessorCloseParticipant({
	name: "agent-scope-cache",
	order: 200,
	close: () => invalidateAgentScopeCache(),
});
export async function getAgentScope(agentId: string): Promise<AgentScope> {
	const id = normalizedAgentId(agentId);
	while (true) {
		const generation = agentScopeGeneration;
		const cached = agentScopeCache.get(id);
		if (cached !== undefined && cached.expiresAt > Date.now()) return cached.scope;

		let read = agentScopeReads.get(id);
		if (read === undefined) {
			read = Promise.resolve()
				.then(async () => {
					const owner = await getDbOwner(getDbAccessorPath());
					const row = await ownerReadOne<{ readonly read_policy: unknown; readonly policy_group: unknown }>(
						owner,
						"SELECT read_policy, policy_group FROM agents WHERE id = ?",
						[id],
						{
							operation: "agent-scope.read",
							lane: "read",
							deadlineMs: 5_000,
							estimatedWorkUnits: 1,
						},
					);
					if (!row) return isolatedScope;
					return {
						readPolicy: parseReadPolicy(row.read_policy),
						policyGroup: parseScopeValue(row.policy_group),
					};
				})
				.catch(() => isolatedScope)
				.then((scope) => {
					if (generation === agentScopeGeneration) {
						agentScopeCache.set(id, { scope, expiresAt: Date.now() + AGENT_SCOPE_CACHE_TTL_MS });
					}
					return scope;
				});
			agentScopeReads.set(id, read);
		}

		let scope: AgentScope;
		try {
			scope = await read;
		} finally {
			if (agentScopeReads.get(id) === read) agentScopeReads.delete(id);
		}
		if (generation === agentScopeGeneration) return scope;
		if (agentScopeReads.get(id) === read) agentScopeReads.delete(id);
	}
}

export async function ensureAgentRegistered(
	agentId: string,
	readPolicy: AgentRosterReadPolicy = "shared",
): Promise<void> {
	const id = normalizedAgentId(agentId);
	const now = new Date().toISOString();
	try {
		const owner = await getDbOwner(getDbAccessorPath());
		await ownerRun(
			owner,
			`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
			 VALUES (?, ?, ?, NULL, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
			[id, id, readPolicy, now, now],
			{
				operation: "agent-scope.register",
				lane: "write",
				deadlineMs: 5_000,
				estimatedWorkUnits: 1,
			},
		);
		invalidateAgentScopeCache(id);
	} catch (err) {
		console.warn(
			`[agent-id] Failed to register agent "${id}" (non-fatal):`,
			err instanceof Error ? err.message : String(err),
		);
	}
}
