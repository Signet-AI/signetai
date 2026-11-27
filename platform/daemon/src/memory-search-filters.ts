import {
	type AgentReach,
	type AgentRosterReadPolicy,
	type ReadScope,
	readScopeSql,
	requireReadScope,
} from "@signet/core";
import { escapeLike } from "./sql-utils";

export interface MemorySearchFilterFields {
	readonly scope?: string | null;
	readonly type?: string;
	readonly tags?: string;
	readonly who?: string;
	readonly pinned?: boolean;
	readonly importance_min?: number;
	readonly since?: string;
	readonly until?: string;
	readonly project?: string;
	readonly agentId?: string;
	readonly readPolicy?: AgentRosterReadPolicy;
	readonly policyGroup?: string | null;
	readonly aggregate?: boolean;
	readonly excludeAggregateRecallMemories?: boolean;
}

export interface MemorySearchFilterInput extends MemorySearchFilterFields {
	readonly readScope: ReadScope;
}

export interface MemorySearchFilterClause {
	readonly sql: string;
	readonly args: readonly unknown[];
}

export function buildMemorySearchFilterClause(params: MemorySearchFilterInput): MemorySearchFilterClause {
	const readScope = memorySearchReadScope(params);
	const parts: string[] = [];
	const args: unknown[] = [];
	if (params.scope === null || params.scope === undefined) {
		parts.push("m.scope IS NULL");
	} else {
		parts.push("m.scope = ?");
		args.push(params.scope);
	}

	if (params.type) {
		parts.push("m.type = ?");
		args.push(params.type);
	}
	if (params.tags) {
		for (const tag of params.tags
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean)) {
			parts.push("m.tags LIKE ? ESCAPE '\\'");
			args.push(`%${escapeLike(tag)}%`);
		}
	}
	if (params.who) {
		parts.push("m.who = ?");
		args.push(params.who);
	}
	if (params.pinned) parts.push("m.pinned = 1");
	if (typeof params.importance_min === "number") {
		parts.push("m.importance >= ?");
		args.push(params.importance_min);
	}
	if (params.aggregate === true || params.excludeAggregateRecallMemories === true) {
		parts.push("COALESCE(m.source_type, '') != 'aggregate-recall'");
	}
	if (params.since) {
		parts.push("m.created_at >= ?");
		args.push(params.since);
	}
	if (params.until) {
		parts.push("m.created_at <= ?");
		args.push(params.until);
	}
	if (params.project) {
		parts.push("m.project = ?");
		args.push(params.project);
	}

	const base: MemorySearchFilterClause = {
		sql: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
		args,
	};
	const scope = readScopeSql("m", readScope);
	return { sql: base.sql + scope.sql, args: [...base.args, ...scope.args] };
}

export function localAgentReach(
	agentId: string,
	readPolicy: AgentRosterReadPolicy | undefined,
	policyGroup: string | null | undefined,
): AgentReach {
	if (readPolicy === "shared") return { kind: "shared", agentId };
	if (readPolicy === "group" && policyGroup) return { kind: "group", agentId, group: policyGroup };
	return { kind: "own", agentId };
}

export function recallAgentId(params: Pick<MemorySearchFilterInput, "agentId" | "readScope">): string {
	const scope = requireReadScope(params.readScope);
	if (typeof params.agentId === "string" && params.agentId.length > 0) return params.agentId;
	if (params.agentId === undefined && scope.reach.kind !== "all") return scope.reach.agentId;
	throw new Error("acting agent required for recall");
}

export function memorySearchReadScope(params: Pick<MemorySearchFilterInput, "readScope">): ReadScope {
	if (typeof params !== "object" || params === null) throw new Error("read scope required");
	return requireReadScope(params.readScope);
}

export function hasMemoryMetadataFilters(params: MemorySearchFilterFields): boolean {
	return hasMemoryOnlyFilters(params) || hasDateBounds(params);
}
export function hasMemoryOnlyFilters(params: MemorySearchFilterFields): boolean {
	const hasTags =
		params.tags
			?.split(",")
			.map((tag) => tag.trim())
			.some(Boolean) === true;
	return (
		params.type !== undefined ||
		hasTags ||
		params.who !== undefined ||
		params.pinned === true ||
		typeof params.importance_min === "number" ||
		params.scope !== undefined
	);
}

export function hasDateBounds(params: MemorySearchFilterFields): boolean {
	return params.since !== undefined || params.until !== undefined;
}
export function dateBoundsSql(column: string, params: MemorySearchFilterFields): { sql: string; args: string[] } {
	const parts: string[] = [];
	const args: string[] = [];
	if (params.since) {
		parts.push(`AND ${column} >= ?`);
		args.push(params.since);
	}
	if (params.until) {
		parts.push(`AND ${column} <= ?`);
		args.push(params.until);
	}
	return { sql: parts.join(" "), args };
}

export function hasRestrictedMemoryContentFilters(params: MemorySearchFilterFields): boolean {
	return hasMemoryMetadataFilters(params) || Boolean(params.project);
}

export function memoryOriginEligibilitySql(
	attributeAlias: string,
	filter: MemorySearchFilterClause,
	allowUnlinked: boolean,
): string {
	const linked = `EXISTS (
		SELECT 1 FROM memories m
		WHERE m.id = ${attributeAlias}.memory_id
		  ${currentMemorySql("m")}
		  ${filter.sql}
	)`;
	return allowUnlinked
		? `(${attributeAlias}.memory_id IS NULL OR ${linked})`
		: `(${attributeAlias}.memory_id IS NOT NULL AND ${linked})`;
}

export function currentMemorySql(alias = "m"): string {
	return ` AND ${alias}.is_deleted = 0 AND ${alias}.superseded_by IS NULL AND ${alias}.stale_at IS NULL`;
}
