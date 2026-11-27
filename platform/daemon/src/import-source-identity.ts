import { loadSourcesConfig } from "@signet/core";
import type { WriteAuthor } from "./auth/audit-owner";
import { importClassificationRequest, type ClassificationActor } from "./classifications";

export async function resolveImportSourceIdentity(input: {
	readonly agentId: string;
	readonly contentHash: string;
	readonly author: WriteAuthor;
	readonly actor?: ClassificationActor;
	readonly classificationId?: string;
	readonly jobId?: string;
	readonly workspaceRoot?: string;
	readonly newGeneration?: boolean;
}) {
	const sources = loadSourcesConfig(input.workspaceRoot).sources;
	const legacySources = sources
		.filter(
			(source) =>
				source.kind === "import" &&
				source.providerSettings?.contentRegistry !== true &&
				source.providerSettings?.contentHash === input.contentHash &&
				(source.providerSettings?.agentId === input.agentId ||
					(input.author.userId === null && source.providerSettings?.agentId === undefined)),
		)
		.map((source) => ({
			id: source.id,
			authorUserId: source.writeIdentity?.authorUserId ?? null,
			authorCredential: source.writeIdentity?.authorCredential ?? "system",
			createdAt: source.createdAt,
		}));
	const identity = await importClassificationRequest<{
		classificationKey: string;
		sourceId: string;
		duplicateSourceId: string | null;
	}>({
		op: "import-identity",
		agentId: input.agentId,
		author: input.author,
		actor: input.actor,
		classificationId: input.classificationId,
		jobId: input.jobId,
		contentHash: input.contentHash,
		newGeneration: input.newGeneration,
		legacySources,
	});
	return {
		classificationKey: identity.classificationKey,
		duplicate: sources.find((source) => source.id === identity.duplicateSourceId),
		sourceId: identity.sourceId,
	};
}
