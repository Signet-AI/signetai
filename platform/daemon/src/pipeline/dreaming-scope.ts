import { prepareTypedStatement, type ReadDb, type WriteDb } from "../db-accessor";
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
export type SemanticCitationKind =
	| "attribute"
	| "memory"
	| "dependency"
	| "entity"
	| "aspect"
	| "assertion"
	| "proposal"
	| "contradiction"
	| "temporal_edge";
export type CitationEvidenceKind = "memory" | "artifact" | "transcript" | "summary" | "attribute";
export interface SemanticEvidenceCitation {
	readonly kind: CitationEvidenceKind;
	readonly id: string;
}

export function dreamingEvidenceRecordInDb(
	db: ReadDb,
	agentId: string,
	evidence: SemanticEvidenceCitation,
): { readonly compartment_id: number | null; readonly author_user_id: string | null } | undefined {
	const tables = {
		memory: "memories",
		artifact: "memory_artifacts",
		transcript: "session_transcripts",
		summary: "session_summaries",
		attribute: "entity_attributes",
	} as const;
	const author =
		evidence.kind === "transcript"
			? "speaker_user_id"
			: evidence.kind === "memory" || evidence.kind === "artifact" || evidence.kind === "summary"
				? "author_user_id"
				: evidence.kind === "attribute"
					? "(SELECT author_user_id FROM memories WHERE memories.id = entity_attributes.memory_id AND memories.agent_id = entity_attributes.agent_id AND memories.compartment_id IS entity_attributes.compartment_id)"
					: "NULL";
	return prepareTypedStatement<{ compartment_id: number | null; author_user_id: string | null }>(
		db,
		`SELECT compartment_id, ${author} AS author_user_id FROM ${tables[evidence.kind]} WHERE ${evidence.kind === "transcript" ? "session_key" : evidence.kind === "artifact" ? "source_path" : "id"} = ? AND agent_id = ?`,
	).get(evidence.id, agentId);
}

export function evidenceCitationInDb(
	db: ReadDb,
	partition: DreamingPartition,
	evidence: SemanticEvidenceCitation,
): { readonly authorUserId: string | null } {
	const row = dreamingEvidenceRecordInDb(db, partition.agentId, evidence);
	if (!row) throw new Error(`Derived memory provenance source is not in the authorized agent scope: ${evidence.id}`);
	const scope = dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
	if (row.compartment_id !== null && scope.compartments !== "all" && !scope.compartments.includes(row.compartment_id))
		throw new Error("compartment_mismatch");
	return { authorUserId: row.author_user_id };
}

export function recordSemanticCitationsInTx(
	db: WriteDb,
	input: {
		readonly kind: SemanticCitationKind;
		readonly id: string;
		readonly partition: DreamingPartition;
		readonly evidence: readonly SemanticEvidenceCitation[];
	},
): void {
	for (const evidence of input.evidence) evidenceCitationInDb(db, input.partition, evidence);
	for (const evidence of input.evidence)
		db.prepare(
			"INSERT INTO evidence_citations (derived_kind, derived_id, agent_id, evidence_kind, evidence_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (derived_kind, derived_id, evidence_kind, evidence_id) DO NOTHING",
		).run(input.kind, input.id, input.partition.agentId, evidence.kind, evidence.id);
}

export function assertDreamingAttentionSubjectInDb(
	db: ReadDb,
	partition: DreamingPartition,
	subject: string | null,
): void {
	const separator = subject?.indexOf(":") ?? -1;
	const kind = subject?.slice(0, separator) ?? "";
	const sourceId = subject?.slice(separator + 1) ?? "";
	const definitions: Readonly<Record<string, readonly [string, string]>> = {
		entity: ["entities", "id"],
		aspect: ["entity_aspects", "id"],
		attribute: ["entity_attributes", "id"],
		claim: ["entity_attributes", "id"],
		link: ["entity_dependencies", "id"],
		memory: ["memories", "id"],
		artifact: ["memory_artifacts", "source_path"],
		transcript: ["session_transcripts", "session_key"],
		summary: ["session_summaries", "id"],
	};
	const definition = Object.hasOwn(definitions, kind) ? definitions[kind] : undefined;
	if (separator > 0 && definition) {
		const [table, key] = definition;
		const source = prepareTypedStatement<{ compartment_id: number | null }>(
			db,
			`SELECT compartment_id FROM ${table} WHERE ${key} = ? AND agent_id = ?`,
		).get(sourceId, partition.agentId);
		const readable = dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
		if (
			source?.compartment_id != null &&
			readable.compartments !== "all" &&
			!readable.compartments.includes(source.compartment_id)
		)
			throw new Error("compartment_mismatch");
	}
	for (const row of prepareTypedStatement<{ id: string }>(
		db,
		"SELECT id FROM dreaming_attention WHERE agent_id = ? AND kind = 'hygiene' AND subject_ref = ?",
	).all(partition.agentId, subject))
		assertDreamingMutationLabelInDb(db, "dreaming_attention", row.id, partition);
}
