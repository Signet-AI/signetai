import { type ReadScope, readScopeSql } from "../read-scope";

export function dreamingReadPredicate(alias: string, scope?: ReadScope): { sql: string; args: (string | number)[] } {
	if (scope === undefined) return { sql: "", args: [] };
	if (scope.projects !== null) return { sql: " AND 0", args: [] };
	const predicate = readScopeSql(
		alias,
		{
			...scope,
			reach: scope.reach.kind === "shared" ? { kind: "own", agentId: scope.reach.agentId } : scope.reach,
		},
		{ visibility: null, memory: null, session: null, source: null },
	);
	return {
		sql: predicate.sql,
		args: predicate.args.map((value) => {
			if (typeof value === "string" || typeof value === "number") return value;
			throw new Error("Invalid Dreaming read scope parameter");
		}),
	};
}
