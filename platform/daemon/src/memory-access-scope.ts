import type { AgentRosterReadPolicy } from "@signet/core";
import { localAllReadScope, readScopeSql } from "./read-scope";

export function buildAgentScopeClause(
	agentId: string,
	readPolicy: AgentRosterReadPolicy,
	policyGroup: string | null,
): { sql: string; args: unknown[] } {
	return readScopeSql(
		"m",
		localAllReadScope(
			readPolicy === "shared"
				? { kind: "shared", agentId }
				: readPolicy === "group" && policyGroup
					? { kind: "group", agentId, group: policyGroup }
					: { kind: "own", agentId },
		),
	);
}
