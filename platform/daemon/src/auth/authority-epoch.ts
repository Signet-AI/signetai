import type { DbOwnerStatement } from "../db-owner-protocol";

export const AUTHORITY_TABLES = [
	"users",
	"groups",
	"group_members",
	"organization",
	"api_keys",
	"auth_sessions",
	"devices",
	"agents",
	"device_authorizations",
	"classification_assignments",
	"classification_audience",
	"org_jobs",
] as const;
const authorityTables = new Set<string>(AUTHORITY_TABLES);

export function cacheableAuthorityStatement(statement: DbOwnerStatement): boolean {
	if (!/^\s*(?:SELECT|WITH RECURSIVE ancestry\b)/i.test(statement.sql)) return false;
	const tables = [...statement.sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)/gi)].map((hit) =>
		(hit[1] ?? "").toLowerCase(),
	);
	return tables.length > 0 && tables.every((table) => authorityTables.has(table) || table === "ancestry");
}
