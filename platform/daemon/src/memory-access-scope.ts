export function buildAgentScopeClause(
	agentId: string,
	readPolicy: string,
	policyGroup: string | null,
): { sql: string; args: unknown[] } {
	if (readPolicy === "shared") {
		return {
			sql: " AND (m.visibility = 'global' OR m.agent_id = ?) AND m.visibility != 'archived'",
			args: [agentId],
		};
	}
	if (readPolicy === "group" && policyGroup) {
		return {
			sql: " AND ((m.visibility = 'global' AND m.agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR m.agent_id = ?) AND m.visibility != 'archived'",
			args: [policyGroup, agentId],
		};
	}
	return {
		sql: " AND m.agent_id = ? AND m.visibility != 'archived'",
		args: [agentId],
	};
}
