import { randomUUID } from "node:crypto";
import { prepareTypedStatement, type WriteDb } from "../db-accessor";
import { type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
import { dreamingPassPartitionInDb, dreamingReadScopeInDb } from "../classification-owner";

export function enrichDreamingSpeakersInTx(
	db: WriteDb,
	passId: string,
	sources: readonly EpisodicSourceRecord[],
	agentId?: string,
): EpisodicSourceRecord[] {
	const partition = dreamingPassPartitionInDb(db, passId, agentId);
	const readScope = dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
	const organization = prepareTypedStatement<{ claimed_at: string | null }>(
		db,
		"SELECT claimed_at FROM organization WHERE id = 1",
	).get();
	return sources.map((input) => {
		const source = readEpisodicSource(db, { agentId: partition.agentId, from: `${input.kind}:${input.id}`, readScope });
		if (!source) throw new Error("Evidence source not found");
		if (source.sourceEntryId !== null || source.sourceKind.startsWith("source_"))
			return { ...source, speaker: { kind: "external" } };
		if (!source.speakerUserId) {
			if (organization?.claimed_at) throw new Error("speaker_required");
			return { ...source, speaker: { kind: "local_anonymous" } };
		}
		const user = prepareTypedStatement<{ id: string; username: string; display_name: string }>(
			db,
			"SELECT id, username, display_name FROM users WHERE id = ?",
		).get(source.speakerUserId);
		if (!user) throw new Error("speaker_required");
		const existing = prepareTypedStatement<{ id: string; name: string; compartment_id: number | null; status: string }>(
			db,
			"SELECT id, name, compartment_id, status FROM entities WHERE agent_id = ? AND person_user_id = ?",
		).get(partition.agentId, user.id);
		if (existing && (existing.compartment_id !== partition.compartmentId || existing.status !== "active"))
			throw new Error("compartment_mismatch");
		let person = existing;
		if (!person) {
			const duplicate = prepareTypedStatement<{ id: string }>(
				db,
				"SELECT id FROM users WHERE display_name = ? AND id != ? LIMIT 1",
			).get(user.display_name, user.id);
			let name = duplicate ? `${user.display_name} (${user.username})` : user.display_name;
			const collision = prepareTypedStatement<{ id: string }>(
				db,
				"SELECT id FROM entities WHERE agent_id = ? AND name = ? LIMIT 1",
			).get(partition.agentId, name);
			if (collision) name = `${name} (${user.id})`;
			const id = `ent_${randomUUID().replaceAll("-", "")}`;
			const evidence = JSON.stringify([
				{ source_ref: `${source.kind}:${source.id}`, source_kind: source.kind, source_id: source.id },
			]);
			db.prepare(`INSERT INTO entities
				(id, name, canonical_name, entity_type, agent_id, person_user_id, compartment_id, proposal_evidence, dreaming_pass_id, created_at, updated_at)
				VALUES (?, ?, ?, 'person', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(
				id,
				name,
				name.toLowerCase(),
				partition.agentId,
				user.id,
				partition.compartmentId,
				evidence,
				passId,
			);
			person = { id, name, compartment_id: partition.compartmentId, status: "active" };
		}
		db.prepare(`INSERT OR IGNORE INTO evidence_citations
			(derived_kind, derived_id, agent_id, evidence_kind, evidence_id)
			VALUES ('entity', ?, ?, ?, ?)`).run(person.id, partition.agentId, source.kind, source.id);
		if (existing) {
			const citation = JSON.stringify({
				source_ref: `${source.kind}:${source.id}`,
				source_kind: source.kind,
				source_id: source.id,
			});
			db.prepare(`UPDATE entities SET proposal_evidence = json_insert(proposal_evidence, '$[#]', json(?)) WHERE id = ?
				AND NOT EXISTS (SELECT 1 FROM json_each(proposal_evidence) WHERE json_extract(value, '$.source_ref') = ?)`).run(
				citation,
				person.id,
				`${source.kind}:${source.id}`,
			);
		}
		return {
			...source,
			speaker: {
				kind: "person",
				userId: user.id,
				displayName: user.display_name,
				personEntityId: person.id,
				personEntityName: person.name,
			},
		};
	});
}
