import { deterministicImportedSourceId, loadSourcesConfig } from "@signet/core";
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
}) {
	const sources = loadSourcesConfig(input.workspaceRoot).sources;
	const sameContent = sources.filter(
		(source) =>
			source.kind === "import" &&
			source.providerSettings?.agentId === input.agentId &&
			source.providerSettings?.contentHash === input.contentHash,
	);
	const classificationKey = await importClassificationRequest<string>({
		op: "import-identity",
		agentId: input.agentId,
		author: input.author,
		actor: input.actor,
		classificationId: input.classificationId,
		jobId: input.jobId,
		ownSourceIds:
			input.author.userId === null
				? []
				: sameContent
						.filter((source) => source.writeIdentity?.authorUserId === input.author.userId)
						.map((source) => source.id),
	});
	const duplicate = sameContent.find((source) => source.providerSettings?.classificationKey === classificationKey);
	return {
		classificationKey,
		duplicate,
		sourceId:
			duplicate?.id ??
			deterministicImportedSourceId(input.contentHash, JSON.stringify([input.agentId, classificationKey])),
	};
}
