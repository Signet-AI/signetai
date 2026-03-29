import type { DependencyType } from "@signet/core";
import type { WriteDb } from "./db-accessor";

export const RELATED_TO_REASON_ERROR =
	"related_to dependencies require a non-empty reason";

type DependencyEvent = "created" | "updated" | "deleted" | "backfill";

interface DependencyHistoryInput {
	readonly dependencyId: string;
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	readonly agentId: string;
	readonly dependencyType: DependencyType;
	readonly event: DependencyEvent;
	readonly changedBy: string;
	readonly reason: string;
	readonly previousReason?: string | null;
	readonly metadata?: string | null;
	readonly createdAt: string;
}

function squashReason(raw: string): string {
	return raw.trim().replace(/\s+/g, " ").slice(0, 300);
}

export function normalizeDependencyReason(
	dependencyType: DependencyType,
	reason?: string | null,
): string | null {
	if (typeof reason !== "string") {
		if (dependencyType === "related_to") return null;
		return null;
	}

	const text = squashReason(reason);
	if (text.length === 0) {
		if (dependencyType === "related_to") return null;
		return null;
	}

	return text;
}

export function requireDependencyReason(
	dependencyType: DependencyType,
	reason?: string | null,
): string | null {
	const text = normalizeDependencyReason(dependencyType, reason);
	if (dependencyType === "related_to" && text === null) {
		throw new Error(RELATED_TO_REASON_ERROR);
	}
	return text;
}

export function writeDependencyHistory(
	db: WriteDb,
	input: DependencyHistoryInput,
): void {
	db.prepare(
		`INSERT INTO entity_dependency_history
		 (id, dependency_id, source_entity_id, target_entity_id, agent_id,
		  dependency_type, event, changed_by, reason, previous_reason,
		  metadata, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		crypto.randomUUID(),
		input.dependencyId,
		input.sourceEntityId,
		input.targetEntityId,
		input.agentId,
		input.dependencyType,
		input.event,
		input.changedBy,
		input.reason,
		input.previousReason ?? null,
		input.metadata ?? null,
		input.createdAt,
	);
}
