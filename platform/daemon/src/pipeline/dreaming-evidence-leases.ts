import { prepareTypedStatement, type DbAccessor, type ReadDb, type WriteDb } from "../db-accessor";
import { ownerChanges, ownerRunStatement, ownerTransaction } from "../db-owner-maintenance";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { dreamingPassPartitionInDb } from "../classification-owner";

const LIVE_LEASE = `julianday(l.expires_at) > julianday('now')
	AND EXISTS (SELECT 1 FROM dreaming_passes p JOIN dreaming_classification_epoch e ON e.id = 1
	WHERE p.id = l.pass_id AND p.status = 'running' AND p.compartment_id IS l.compartment_id
	AND p.classification_epoch = e.epoch)`;
const LEASE_SQL = `INSERT INTO dreaming_evidence_leases AS l
	(agent_id, compartment_id, source_kind, source_id, pass_id, leased_at, expires_at)
	VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now', ?))
	ON CONFLICT(agent_id, COALESCE(compartment_id, 0), source_kind, source_id) DO UPDATE SET
	pass_id = excluded.pass_id, leased_at = excluded.leased_at, expires_at = excluded.expires_at
	WHERE l.pass_id = excluded.pass_id OR NOT (${LIVE_LEASE})`;

export interface DreamingEvidenceLeaseInput {
	readonly agentId: string;
	readonly passId: string;
	readonly sourceRefs: readonly string[];
	readonly ttlMs: number;
	readonly compartmentId?: number | null;
}

function references(params: DreamingEvidenceLeaseInput): Array<{ ref: string; kind: string; id: string }> {
	if (!params.agentId.trim() || !params.passId.trim()) throw new Error("agent_required");
	if (!Number.isFinite(params.ttlMs) || params.ttlMs <= 0 || params.ttlMs > 3_600_000)
		throw new Error("invalid_lease_ttl");
	if (params.sourceRefs.length > 100) throw new Error("evidence_lease_limit");
	return [...new Set(params.sourceRefs)].map((ref) => {
		const separator = ref.indexOf(":");
		const kind = ref.slice(0, separator);
		const id = ref.slice(separator + 1);
		if (separator < 1 || !id || !["memory", "artifact", "transcript", "summary"].includes(kind))
			throw new Error("invalid_source_ref");
		return { ref, kind, id };
	});
}

export function evidenceLeasedByOtherPasses(
	db: ReadDb,
	agentId: string,
	passId: string | undefined,
	compartmentId?: number | null,
): string[] {
	const partition = passId === undefined ? null : dreamingPassPartitionInDb(db, passId, agentId);
	const label = compartmentId === undefined ? (partition?.compartmentId ?? null) : compartmentId;
	if (partition && partition.compartmentId !== label) throw new Error("compartment_mismatch");
	return prepareTypedStatement<{ kind: string; id: string }>(
		db,
		`SELECT l.source_kind AS kind, l.source_id AS id FROM dreaming_evidence_leases l
		 WHERE l.agent_id = ? AND l.compartment_id IS ? AND l.pass_id != ? AND ${LIVE_LEASE}`,
	)
		.all(agentId, label, passId ?? "")
		.map((row) => `${row.kind}:${row.id}`);
}

export function evidenceLeasedByOtherPassesInScopes(
	db: ReadDb,
	passId: string,
	scopes: readonly string[],
): ReadonlySet<string> {
	return new Set(
		scopes.flatMap((scope) => evidenceLeasedByOtherPasses(db, scope, passId).map((ref) => `${scope}\u0000${ref}`)),
	);
}

export function releaseDreamingEvidenceLeasesInTx(db: WriteDb, passId: string): void {
	db.prepare(`DELETE FROM dreaming_evidence_leases WHERE pass_id = ? OR NOT EXISTS (
		SELECT 1 FROM dreaming_passes p JOIN dreaming_classification_epoch e ON e.id = 1
		WHERE p.id = dreaming_evidence_leases.pass_id AND p.status = 'running' AND p.classification_epoch = e.epoch
	) OR julianday(expires_at) <= julianday('now')`).run(passId);
}

export function leaseDreamingEvidenceInTx(db: WriteDb, params: DreamingEvidenceLeaseInput): ReadonlySet<string> {
	const refs = references(params);
	const partition = dreamingPassPartitionInDb(db, params.passId, params.agentId);
	if (params.compartmentId !== undefined && partition.compartmentId !== params.compartmentId)
		throw new Error("compartment_mismatch");
	const granted = new Set<string>();
	const statement = db.prepare(LEASE_SQL);
	const ttl = `+${Math.ceil(params.ttlMs / 1000)} seconds`;
	for (const { ref, kind, id } of refs) {
		if (statement.run(params.agentId, partition.compartmentId, kind, id, params.passId, ttl).changes > 0)
			granted.add(ref);
	}
	return granted;
}

export async function leaseDreamingEvidence(
	accessor: DbAccessor,
	params: DreamingEvidenceLeaseInput,
): Promise<ReadonlySet<string>> {
	const refs = references(params);
	if (refs.length === 0) return new Set();
	const ttl = `+${Math.ceil(params.ttlMs / 1000)} seconds`;
	const sql =
		params.compartmentId === undefined
			? LEASE_SQL.replace("VALUES (?, ?,", "VALUES (?, (SELECT compartment_id FROM dreaming_passes WHERE id = ?),")
			: LEASE_SQL;
	const results = await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.evidence.lease",
		refs.map(({ kind, id }) =>
			ownerRunStatement(sql, [
				params.agentId,
				params.compartmentId === undefined ? params.passId : params.compartmentId,
				kind,
				id,
				params.passId,
				ttl,
			]),
		),
		{ deadlineMs: 30_000, estimatedWorkUnits: refs.length },
	);
	return new Set(refs.flatMap(({ ref }, index) => (ownerChanges(results[index]) > 0 ? [ref] : [])));
}
