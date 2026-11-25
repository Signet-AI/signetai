import type { AudienceSubject, ReadScope } from "./read-scope";
import { getDbAccessor } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";

export interface ClassificationActor extends AudienceSubject {
	readonly compliance: boolean;
	readonly credential: string;
}
export interface ClassificationTarget {
	readonly kind: "memory" | "session" | "source" | "agent";
	readonly id: string;
	readonly agentId: string;
}
export interface ClassificationPrincipal {
	readonly kind: "user" | "group";
	readonly id: string;
}
export type ClassificationRequest =
	| { readonly op: "fail"; readonly jobId: string; readonly error: string }
	| { readonly op: "readable"; readonly subject: AudienceSubject }
	| { readonly op: "list" | "get"; readonly actor: ClassificationActor; readonly id?: string }
	| {
			readonly op: "create";
			readonly actor: ClassificationActor;
			readonly name: string;
			readonly color: string | null;
			readonly description: string | null;
			readonly audience: readonly ClassificationPrincipal[];
			readonly appliers: readonly ClassificationPrincipal[];
	  }
	| {
			readonly op: "update";
			readonly actor: ClassificationActor;
			readonly id: string;
			readonly name?: string;
			readonly color?: string | null;
			readonly description?: string | null;
			readonly archived?: boolean;
	  }
	| {
			readonly op: "audience" | "appliers";
			readonly actor: ClassificationActor;
			readonly id: string;
			readonly principals: readonly ClassificationPrincipal[];
	  }
	| {
			readonly op: "preview";
			readonly actor: ClassificationActor;
			readonly id: string;
			readonly target: ClassificationTarget;
			readonly scope: ReadScope;
	  }
	| {
			readonly op: "enqueue";
			readonly actor: ClassificationActor;
			readonly id: string;
			readonly target: ClassificationTarget;
			readonly remove: boolean;
	  }
	| { readonly op: "execute"; readonly jobId: string }
	| {
			readonly op: "items";
			readonly actor: ClassificationActor;
			readonly id: string;
			readonly cursor: string | null;
			readonly scope: ReadScope;
	  }
	| { readonly op: "rebuild"; readonly agentId?: string }
	| { readonly op: "recover" };
export async function classificationRequest<Result>(request: ClassificationRequest): Promise<Result> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	return owner.submit<Result>(
		{ kind: "classification", request },
		{
			operation: `classification.${request.op}`,
			lane: "maintenance",
			workloadClass: "maintenance",
			deadlineMs: 15 * 60_000,
			estimatedWorkUnits: 10000,
		},
	).result;
}
export function rebuildCompartments(agentId?: string): Promise<{ updated: number }> {
	return classificationRequest({ op: "rebuild", ...(agentId === undefined ? {} : { agentId }) });
}
export async function classify(
	target: ClassificationTarget,
	classificationId: string,
	actor: ClassificationActor,
	remove = false,
): Promise<{ jobId: string }> {
	const job = await classificationRequest<{ jobId: string }>({
		op: "enqueue",
		id: classificationId,
		actor,
		target,
		remove,
	});
	await executeClassificationJob(job.jobId);
	return job;
}
export function unclassify(
	target: ClassificationTarget,
	classificationId: string,
	actor: ClassificationActor,
): Promise<{ jobId: string }> {
	return classify(target, classificationId, actor, true);
}

export async function executeClassificationJob(
	jobId: string,
	request: (request: ClassificationRequest) => Promise<unknown> = classificationRequest,
): Promise<void> {
	try {
		await request({ op: "execute", jobId });
	} catch (error) {
		await request({ op: "fail", jobId, error: error instanceof Error ? error.message : "classification_failed" });
		throw error;
	}
}
