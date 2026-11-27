import type { WriteAuthor } from "./auth/audit-owner";
import type { Principal } from "./auth/principal";
import { IdentityError } from "./auth/organization-store";
import { z } from "zod";
import { attemptAsync, type CompartmentWriteScope } from "@signet/core";
import { logger } from "./logger";
import { DbOwnerError, type DbOwnerClient } from "./db-owner-client";
import type { AudienceSubject, ReadScope } from "./read-scope";
import { getDbAccessor } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";

export interface ClassificationActor extends AudienceSubject {
	readonly legacy?: true;
	readonly compliance: boolean;
	readonly boundAgentId: string | null;
	readonly allowedProjects: readonly string[] | null;
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
export function importActor(principal: Principal | undefined): ClassificationActor | undefined {
	return principal
		? {
				userId: principal.userId,
				groupIds: principal.groupIds,
				local: principal.kind === "local",
				...(principal.kind === "legacy" ? { legacy: true as const } : {}),
				compliance: principal.compliance && principal.permissions.has("classify"),
				boundAgentId: principal.boundAgentId,
				allowedProjects: principal.allowedProjects,
				credential:
					principal.kind === "legacy" && principal.credential.kind === "api_key"
						? `token:api-key:${principal.credential.id}`
						: `${principal.credential.kind}:${principal.credential.id}`,
			}
		: undefined;
}
export interface ImportJobCreation {
	readonly author: WriteAuthor;
	readonly jobId: string;
	readonly agentId: string;
	readonly schemaId?: string;
	readonly duplicateMode?: "skip" | "replace" | "reimport";
	readonly files?: readonly { readonly id: string; readonly name: string }[];
	readonly classificationId?: string;
	readonly actor?: ClassificationActor;
}
export type ImportClassificationRequest =
	| {
			readonly op: "import-identity";
			readonly agentId: string;
			readonly author: WriteAuthor;
			readonly actor?: ClassificationActor;
			readonly classificationId?: string;
			readonly jobId?: string;
			readonly ownSourceIds: readonly string[];
	  }
	| { readonly op: "import-create"; readonly input: ImportJobCreation }
	| {
			readonly op: "import-bind";
			readonly scope: {
				readonly agentId: string;
				readonly jobId: string;
				readonly fileId: string;
				readonly generation: number;
			};
			readonly sourceId: string;
			readonly duplicateSourceId?: string;
	  }
	| {
			readonly op: "import-document";
			readonly input: {
				readonly author: WriteAuthor;
				readonly jobId: string;
				readonly agentId: string;
				readonly sourceId: string;
				readonly duplicateSourceId?: string;
				readonly classificationId?: string;
				readonly actor?: ClassificationActor;
			};
	  };
export async function importClassificationRequest<T>(request: ImportClassificationRequest): Promise<T> {
	try {
		return await classificationRequest<T>(request);
	} catch (error) {
		if (
			error instanceof Error &&
			["permission", "not_owner", "agent_binding_conflict", "project_not_permitted", "classified_destination"].includes(
				error.message,
			)
		)
			throw new IdentityError(403, error.message);
		if (
			error instanceof Error &&
			["import_classification_conflict", "archived_classification", "stale_import_binding"].includes(error.message)
		)
			throw new IdentityError(409, error.message);
		throw error;
	}
}
export type ClassificationRequest =
	| ImportClassificationRequest
	| { readonly op: "admit-write"; readonly scopes: readonly CompartmentWriteScope[] }
	| { readonly op: "record-error"; readonly jobId: string; readonly error: string }
	| { readonly op: "readable" | "visibility"; readonly subject: AudienceSubject }
	| {
			readonly op: "list" | "get";
			readonly actor: ClassificationActor;
			readonly id?: string;
			readonly includePrincipals?: boolean;
	  }
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
	| {
			readonly op: "rebuild";
			readonly agentId?: string;
			readonly cursor?: { table: number; rowid: number; updated: number };
	  }
	| { readonly op: "recover"; readonly cursor?: string };
export async function classificationRequest<Result>(
	request: ClassificationRequest,
	suppliedOwner?: DbOwnerClient,
): Promise<Result> {
	const owner = suppliedOwner ?? (await getDbOwnerForAccessor(getDbAccessor()));
	const readonly = request.op === "readable" || request.op === "visibility" || request.op === "admit-write";
	const importing =
		request.op === "import-identity" ||
		request.op === "import-create" ||
		request.op === "import-bind" ||
		request.op === "import-document";
	return owner.submit<Result>(
		{ kind: "classification", request },
		{
			operation: `classification.${request.op}`,
			lane: readonly ? "read" : importing ? "write" : "maintenance",
			workloadClass: readonly || importing ? "foreground" : "maintenance",
			deadlineMs: readonly ? 5000 : importing ? 15_000 : 15 * 60_000,
			estimatedWorkUnits: readonly ? 1 : importing ? 100 : 10000,
		},
	).result;
}
export async function rebuildCompartments(agentId?: string): Promise<{ updated: number }> {
	let cursor: { table: number; rowid: number; updated: number } | undefined;
	for (;;) {
		const result = await classificationRequest<{ updated: number; cursor: typeof cursor | null }>({
			op: "rebuild",
			...(agentId === undefined ? {} : { agentId }),
			...(cursor === undefined ? {} : { cursor }),
		});
		if (result.cursor === null) return { updated: result.updated };
		cursor = result.cursor;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
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
	let retries = 0;
	let pendingPolls = 0;
	for (;;) {
		let value: unknown;
		try {
			value = await request({ op: "execute", jobId });
			retries = 0;
		} catch (error) {
			if (
				error instanceof DbOwnerError &&
				(error.code === "DB_OWNER_DIED" ||
					error.code === "DB_OWNER_DEADLINE" ||
					error.code === "DB_OWNER_QUEUE_FULL") &&
				retries < 5
			) {
				await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** retries));
				retries++;
				continue;
			}
			const failure = error instanceof Error ? error : new Error(String(error));
			const recorded = errorResult.parse(await request({ op: "record-error", jobId, error: failure.message }));
			if (recorded.status === "running" && recorded.failures < 5) {
				logger.warn("startup-recovery", "Classification batch failed; retrying its durable cursor", {
					jobId,
					failures: recorded.failures,
					error: failure.message,
				});
				await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** Math.min(recorded.failures - 1, 4)));
				continue;
			}
			logger.error("startup-recovery", `Classification job ${jobId} execution failed (${recorded.status})`, failure);
			throw error;
		}
		const result = jobResult.parse(value);
		if (result.status === "complete") return;
		if (result.status === "pending") {
			pendingPolls++;
			if (pendingPolls >= 60) {
				await request({ op: "record-error", jobId, error: "classification_pending_timeout" });
				throw new Error("classification_pending_timeout");
			}
		} else pendingPolls = 0;
		await new Promise<void>((resolve) =>
			setTimeout(resolve, result.status === "pending" ? Math.min(100 * 2 ** Math.min(pendingPolls - 1, 6), 5000) : 0),
		);
	}
}
const errorResult = z.object({
	status: z.enum(["pending", "running", "complete", "failed"]),
	failures: z.number().int().nonnegative(),
});
const jobResult = z.object({ status: z.enum(["pending", "running", "complete"]) });
const recoveryResult = z.object({ jobs: z.array(z.string()), nextCursor: z.string().nullable() });
export async function resumeClassificationJobs(
	request: (request: ClassificationRequest) => Promise<unknown> = classificationRequest,
): Promise<void> {
	let cursor: string | undefined;
	for (;;) {
		const result = recoveryResult.parse(await request({ op: "recover", ...(cursor === undefined ? {} : { cursor }) }));
		for (let start = 0; start < result.jobs.length; start += 4) {
			const settled = await Promise.allSettled(
				result.jobs.slice(start, start + 4).map((id) => executeClassificationJob(id, request)),
			);
			for (const outcome of settled)
				if (outcome.status === "rejected")
					logger.error(
						"startup-recovery",
						"Classification recovery job failed; continuing the recovery page",
						outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
					);
		}
		if (result.nextCursor === null) return;
		cursor = result.nextCursor;
	}
}

export async function startClassificationRecovery(owner: DbOwnerClient): Promise<void> {
	await attemptAsync(async () => {
		try {
			await resumeClassificationJobs((request) => classificationRequest(request, owner));
		} catch (error) {
			logger.error(
				"startup-recovery",
				"Classification recovery stopped",
				error instanceof Error ? error : new Error(String(error)),
			);
			throw error;
		}
	});
}
