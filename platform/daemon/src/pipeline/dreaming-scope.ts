import { prepareTypedStatement, type ReadDb } from "../db-accessor";
import type { ReadScope } from "../read-scope";

export interface DreamingPartition {
	readonly agentId: string;
	readonly compartmentId: number | null;
}

export type DreamingMutationTable =
	| "entities"
	| "entity_aspects"
	| "entity_attributes"
	| "entity_dependencies"
	| "memories"
	| "epistemic_assertions"
	| "ontology_contradictions"
	| "ontology_proposals"
	| "dreaming_attention"
	| "memory_head_entries"
	| "temporal_edges";

export function dreamingReadScopeInDb(db: ReadDb, agentId: string, compartmentId: number | null): ReadScope {
	if (!agentId.trim()) throw new Error("agent_required");
	if (compartmentId !== null && (!Number.isSafeInteger(compartmentId) || compartmentId < 1))
		throw new Error("compartment_mismatch");
	const compartments =
		compartmentId === null
			? []
			: prepareTypedStatement<{ id: number }>(
					db,
					`
		SELECT c.id FROM compartments c
		WHERE EXISTS (SELECT 1 FROM compartment_members own WHERE own.compartment_id = c.id)
		AND NOT EXISTS (
			SELECT 1 FROM compartment_members member WHERE member.compartment_id = c.id
			AND NOT EXISTS (SELECT 1 FROM compartment_members allowed
				WHERE allowed.compartment_id = ? AND allowed.classification_id = member.classification_id)
		) ORDER BY c.id
	`,
				)
					.all(compartmentId)
					.map((row) => row.id);
	if (compartmentId !== null && !compartments.includes(compartmentId)) throw new Error("compartment_mismatch");
	return { reach: { kind: "own", agentId }, compartments, projects: null };
}

export function assertDreamingAgentInDb(db: ReadDb, agentId: string): void {
	const excluded = prepareTypedStatement<{ id: string }>(
		db,
		`
		SELECT a.id FROM agents a WHERE a.id = ? AND (
			a.archived_at IS NOT NULL OR (a.kind = 'organization' AND EXISTS (
				SELECT 1 FROM organization o WHERE o.id = 1 AND o.claimed_at IS NOT NULL AND o.agent_model = 'personal'
			))
		) LIMIT 1
	`,
	).get(agentId);
	if (excluded) throw new Error("org_policy");
}

export function dreamingPassPartitionInDb(db: ReadDb, passId: string, agentId?: string): DreamingPartition {
	const pass = prepareTypedStatement<{
		agent_id: string;
		compartment_id: number | null;
		scope_key: string | null;
		classification_epoch: number;
	}>(
		db,
		`SELECT agent_id, compartment_id, scope_key, classification_epoch FROM dreaming_passes WHERE id = ? AND status = 'running'`,
	).get(passId);
	if (!pass) throw new Error("Dreaming pass is not running");
	const target = agentId ?? pass.agent_id;
	const scopes = (pass.scope_key || pass.agent_id).split(",");
	if (!scopes.includes(target)) throw new Error("agent_not_permitted");
	assertDreamingAgentInDb(db, target);
	const epoch = prepareTypedStatement<{ epoch: number }>(
		db,
		"SELECT epoch FROM dreaming_classification_epoch WHERE id = 1",
	).get();
	if (!epoch || epoch.epoch !== pass.classification_epoch) throw new Error("compartment_mismatch");
	if (
		db
			.prepare(
				"SELECT 1 FROM org_jobs WHERE kind IN ('classify','unclassify') AND status IN ('pending','running') LIMIT 1",
			)
			.get()
	)
		throw new Error("compartment_mismatch");
	return { agentId: target, compartmentId: pass.compartment_id };
}

export function assertDreamingMutationLabelInDb(
	db: ReadDb,
	table: DreamingMutationTable,
	id: string,
	partition: DreamingPartition,
): void {
	const row = prepareTypedStatement<{ id: string }>(
		db,
		`SELECT id FROM ${table} WHERE id = ? AND agent_id = ? AND compartment_id IS ?`,
	).get(id, partition.agentId, partition.compartmentId);
	if (!row) throw new Error("compartment_mismatch");
}
