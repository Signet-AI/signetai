import { type ReadScope, readScopeSql } from "@signet/core";

type ScopeColumns = NonNullable<Parameters<typeof readScopeSql>[2]>;

export function withoutVisibilityReach(scope: ReadScope): ReadScope {
	const reach = scope.reach;
	return reach.kind === "shared" || reach.kind === "group"
		? { ...scope, reach: { kind: "own", agentId: reach.agentId } }
		: scope;
}

export function evidenceScopeSql(
	alias: string,
	scope: ReadScope,
	cols: ScopeColumns = {},
): { sql: string; args: unknown[] } {
	return readScopeSql(alias, withoutVisibilityReach(scope), { ...cols, visibility: null });
}

export function derivedScopeSql(
	alias: string,
	scope: ReadScope,
	cols: ScopeColumns = {},
): { sql: string; args: unknown[] } {
	if (scope.projects !== null) return { sql: " AND 0", args: [] };
	return evidenceScopeSql(alias, scope, cols);
}
