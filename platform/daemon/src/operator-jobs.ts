import { attemptAsync } from "@signet/core";
import { logger } from "./logger";
import { randomUUID } from "node:crypto";
import { readRuntimeConfigFile } from "./runtime-config-file";
import { getDbAccessor, resolveSqliteAgentsDir } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";
import { DbOwnerError } from "./db-owner-client";
import { IdentityError } from "./auth/organization-store";
import type { Principal } from "./auth/principal";
import {
	principalAccess,
	canActAs,
	resolveWriteAgent,
	resolveReadAgent,
	reconcileAgentSources,
} from "./auth/agent-access";
import { audienceSubjectFromPrincipal, resolveReadScope } from "./read-scope";
import { loadMemoryConfigFromText, type EmbeddingConfig } from "./memory-config";
import { fetchEmbedding } from "./embedding-fetch";
import type { UnembeddedRow } from "./embedding-coverage";

import { operatorInputSchema, type OperatorActor, type OperatorRequest } from "./operator-job-contract";
const runtimeId = randomUUID();
const active = new Set<string>();
export async function operatorRequest<T>(request: OperatorRequest): Promise<T> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	if (!owner) throw new IdentityError(503, "db_owner_unavailable");
	try {
		return await owner.submit<T>(
			{ kind: "operator_job", request: { ...request, runtimeId } },
			{
				operation: `operator.${request.op}`,
				lane: "maintenance",
				workloadClass: "maintenance",
				deadlineMs: 5000,
				estimatedWorkUnits: 1000,
			},
		).result;
	} catch (error) {
		if (error instanceof DbOwnerError && error.message.startsWith("operator:")) {
			const reason = error.message.slice("operator:".length);
			throw new IdentityError(
				reason === "not_found"
					? 404
					: reason === "capacity"
						? 429
						: ["purge_requires_archive", "purge_limit", "protected_agent", "purge_blocked", "org_policy"].includes(
									reason,
								)
							? 409
							: 403,
				reason,
				reason === "not_found"
					? "not found"
					: reason === "permission"
						? "Requires the admin role with permission for this operation and scope"
						: reason,
			);
		}
		throw error;
	}
}
export function operatorActor(p: Principal): OperatorActor {
	if (!p.userId || (p.credential.kind !== "session" && p.credential.kind !== "api_key"))
		throw new IdentityError(403, "permission");
	return {
		userId: p.userId,
		credentialKind: p.credential.kind,
		credentialId: p.credential.id,
		permissions: [...p.permissions],
		boundAgentId: p.boundAgentId,
		allowedProjects: p.allowedProjects,
	};
}
export async function startOperatorJob(p: Principal, raw: unknown, headerAgent?: string) {
	const parsed = operatorInputSchema.parse(raw);
	const reconciled = reconcileAgentSources([parsed.agentId, headerAgent]);
	if (!reconciled.ok) throw new IdentityError(reconciled.error.status, reconciled.error.reason);
	const input = { ...parsed, agentId: reconciled.value };
	if (!p.permissions.has(input.action === "embed.audit" ? "diagnostics" : "admin"))
		throw new IdentityError(
			403,
			"permission",
			input.action === "embed.audit" ? "Requires diagnostics permission" : "Requires the admin role",
		);
	const actor = operatorActor(p);
	const settings = principalAccess(p);
	if (!settings) throw new IdentityError(403, "permission");
	const selected =
		input.action === "embed.audit" ? resolveReadAgent(p, input.agentId) : resolveWriteAgent(p, input.agentId, settings);
	if (!selected.ok) throw new IdentityError(selected.error.status, selected.error.reason, selected.error.error);
	const agent = principalAccess(p)?.agents.find((a) => a.id === selected.value);
	if (!agent || !canActAs(p, agent)) throw new IdentityError(403, "agent_not_permitted");
	const scope = await resolveReadScope(
		{ reach: { kind: "own", agentId: selected.value }, projects: p.allowedProjects },
		audienceSubjectFromPrincipal(p),
	);
	const { file: configPath, text } = await readRuntimeConfigFile(resolveSqliteAgentsDir());
	const cfg = loadMemoryConfigFromText(resolveSqliteAgentsDir(), text, configPath);
	if (active.size >= 2 && input.action === "embed.backfill" && !input.options.dryRun)
		throw new IdentityError(429, "capacity");
	const result = await operatorRequest<{ jobId: string; rows: readonly UnembeddedRow[] }>({
		op: "create",
		actor,
		input: { ...input, agentId: selected.value },
		scope,
		pipeline: cfg.pipelineV2,
		embedding: cfg.embedding,
		runtimeId,
	});
	if (result.rows.length) {
		active.add(result.jobId);
		void runBackfill(actor, result.jobId, result.rows, cfg.embedding).finally(() => active.delete(result.jobId));
	}
	return { jobId: result.jobId };
}
async function runBackfill(
	actor: OperatorActor,
	jobId: string,
	rows: readonly UnembeddedRow[],
	embedding: EmbeddingConfig,
): Promise<void> {
	const signal = AbortSignal.timeout(60_000);
	const completed = await attemptAsync(async () => {
		for (const memory of rows) {
			signal.throwIfAborted();
			await operatorRequest({ op: "admit", actor, jobId, runtimeId, memory });
			const vector = await fetchEmbedding(memory.content, embedding, { signal, timeoutMs: 10_000 });
			if (!vector?.length || vector.length > 8192 || vector.some((n) => !Number.isFinite(n)))
				throw new Error("provider_failed");
			await operatorRequest({ op: "commit", actor, jobId, runtimeId, memory, vector, embedding });
		}
		return true;
	});
	const reason = completed ? null : signal.aborted ? "deadline_exceeded" : "backfill_failed";
	const settled = await attemptAsync(() => operatorRequest({ op: "finish", actor, jobId, runtimeId, error: reason }));
	if (!settled) logger.error("daemon", "Organization operator job settlement failed", undefined, { jobId });
}
