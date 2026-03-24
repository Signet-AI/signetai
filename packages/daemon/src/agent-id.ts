/**
 * Agent ID resolution helpers.
 */

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
