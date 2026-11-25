import type { ReadDb } from "../db-accessor";
import { organizationClaimedInDb, structuralPersonIdentityInDb } from "../auth/organization-store";
import { type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
import { dreamingPassPartitionInDb, dreamingReadScopeInDb } from "../classification-owner";

export function enrichDreamingSpeakersInTx(
	db: ReadDb,
	passId: string,
	sources: readonly EpisodicSourceRecord[],
	agentId?: string,
): EpisodicSourceRecord[] {
	const partition = dreamingPassPartitionInDb(db, passId, agentId);
	const readScope = dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
	const claimed = organizationClaimedInDb(db);
	return sources.map((input) => {
		const source = readEpisodicSource(db, { agentId: partition.agentId, from: `${input.kind}:${input.id}`, readScope });
		if (!source) throw new Error("Evidence source not found");
		if (source.sourceEntryId !== null || source.sourceKind.startsWith("source_"))
			return { ...source, speaker: { kind: "external" } };
		if (!source.speakerUserId) {
			if (claimed) throw new Error("speaker_required");
			return { ...source, speaker: { kind: "local_anonymous" } };
		}
		const user = structuralPersonIdentityInDb(db, partition.agentId, source.speakerUserId);
		if (!user) throw new Error("speaker_required");
		if (!user.person_id || !user.person_name) throw new Error("person_identity_missing");
		return {
			...source,
			speaker: {
				kind: "person",
				userId: user.id,
				displayName: user.display_name,
				personEntityId: user.person_id,
				personEntityName: user.person_name,
			},
		};
	});
}
