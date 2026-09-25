import type { AgentRosterReadPolicy } from "@signet/core";
import { buildAgentScopeClause } from "./memory-access-scope";
import { escapeLike } from "./sql-utils";

export interface MemorySearchFilterInput {
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

export interface MemorySearchFilterClause {
	readonly sql: string;
	readonly args: readonly unknown[];
}

export function buildMemorySearchFilterClause(params: MemorySearchFilterInput): MemorySearchFilterClause {
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
	if (!params.agentId) return base;

	const scope = buildAgentScopeClause(params.agentId, params.readPolicy ?? "isolated", params.policyGroup ?? null);
	return { sql: base.sql + scope.sql, args: [...base.args, ...scope.args] };
}

export function hasMemoryMetadataFilters(params: MemorySearchFilterInput): boolean {
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
		params.since !== undefined ||
		params.until !== undefined ||
		params.scope !== undefined
	);
}

export function hasRestrictedMemoryContentFilters(params: MemorySearchFilterInput): boolean {
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
