import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { ownerChanges, ownerRunStatement, ownerTransaction } from "../db-owner-maintenance";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
const LIVE_LEASE = `julianday(l.expires_at) > julianday('now')
	AND EXISTS (SELECT 1 FROM dreaming_passes p WHERE p.id = l.pass_id AND p.status = 'running')`;

function leaseTableExists(db: ReadDb): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_evidence_leases'").get() != null
	);
}

export function evidenceLeasedByOtherPasses(db: ReadDb, agentId: string, passId: string | undefined): string[] {
	if (!leaseTableExists(db)) return [];
	const rows = db
		.prepare(
			`SELECT l.source_kind AS kind, l.source_id AS id FROM dreaming_evidence_leases l
			 WHERE l.agent_id = ? AND l.pass_id != ? AND ${LIVE_LEASE}`,
		)
		.all(agentId, passId ?? "") as Array<{ kind: string; id: string }>;
	return rows.map((row) => `${row.kind}:${row.id}`);
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
	if (!leaseTableExists(db)) return;
	db.prepare(
		`DELETE FROM dreaming_evidence_leases
		 WHERE pass_id = ? OR pass_id NOT IN (SELECT id FROM dreaming_passes WHERE status = 'running')`,
	).run(passId);
}
export async function leaseDreamingEvidence(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly passId: string;
		readonly sourceRefs: readonly string[];
		readonly ttlMs: number;
	},
): Promise<ReadonlySet<string>> {
	const refs = [...new Set(params.sourceRefs)].flatMap((ref) => {
		const separator = ref.indexOf(":");
		return separator > 0 ? [{ ref, kind: ref.slice(0, separator), id: ref.slice(separator + 1) }] : [];
	});
	if (refs.length === 0) return new Set();
	const ttl = `+${Math.max(1, Math.ceil(params.ttlMs / 1000))} seconds`;
	const results = await ownerTransaction(
		await getDbOwnerForAccessor(accessor),
		"dreaming.evidence.lease",
		refs.map(({ kind, id }) =>
			ownerRunStatement(
				`INSERT INTO dreaming_evidence_leases AS l (agent_id, source_kind, source_id, pass_id, leased_at, expires_at)
				 VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now', ?))
				 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET
				   pass_id = excluded.pass_id, leased_at = excluded.leased_at, expires_at = excluded.expires_at
				 WHERE l.pass_id = excluded.pass_id OR NOT (${LIVE_LEASE})`,
				[params.agentId, kind, id, params.passId, ttl],
			),
		),
		{ deadlineMs: 30_000, estimatedWorkUnits: refs.length },
	);
	return new Set(refs.flatMap(({ ref }, index) => (ownerChanges(results[index]) > 0 ? [ref] : [])));
}
