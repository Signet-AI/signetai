import { attemptAsync } from "@signet/core";
import { operatorActor, operatorRequest } from "./operator-jobs";
import { invalidateAgentScopeCache } from "./agent-id";
import { IdentityError } from "./auth/organization-store";
import type { Principal } from "./auth/principal";
import type { OperatorActor } from "./operator-job-contract";
import { deleteSessionTranscript } from "./session-transcript-lifecycle";
import { logger } from "./logger";
import { reconcileAgentSources } from "./auth/agent-access";
const active = new Set<string>();
export async function startAgentPurge(p: Principal, agentId: string, headerAgent?: string) {
	const reconciled = reconcileAgentSources([agentId, headerAgent]);
	if (!reconciled.ok) throw new IdentityError(reconciled.error.status, reconciled.error.reason);
	const actor = operatorActor(p);
	if (active.size >= 2) throw new IdentityError(429, "capacity");
	const { jobId } = await operatorRequest<{ jobId: string }>({
		op: "agent-purge",
		stage: "create",
		actor,
		agentId,
		runtimeId: "",
	});
	active.add(jobId);
	void run(actor, jobId, agentId).finally(() => active.delete(jobId));
	return { jobId };
}
async function run(actor: OperatorActor, jobId: string, agentId: string) {
	const deadline = Date.now() + 60_000;
	const completed = await attemptAsync(async () => {
		for (;;) {
			if (Date.now() >= deadline) throw new Error("deadline_exceeded");
			const next = await operatorRequest<{ more: boolean; sessionKey?: string; agentId: string }>({
				op: "agent-purge",
				stage: "next",
				actor,
				jobId,
				runtimeId: "",
			});
			if (next.more) continue;
			if (!next.sessionKey) break;
			let complete = false;
			for (let continuation = 0; continuation < 64 && Date.now() < deadline; continuation++) {
				const removed = await deleteSessionTranscript(
					{ agentId, sessionKey: next.sessionKey, hard: true, changedBy: `user:${actor.userId}` },
					AbortSignal.timeout(Math.max(1, deadline - Date.now())),
				);
				if (removed.status === "complete") {
					complete = true;
					break;
				}
				if (removed.status !== "pending") break;
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
			}
			if (!complete) throw new Error("transcript_purge_incomplete");
		}
		await operatorRequest({ op: "agent-purge", stage: "finish", actor, jobId, runtimeId: "" });
		invalidateAgentScopeCache(agentId);
		return true;
	});
	if (!completed) {
		const settled = await attemptAsync(() =>
			operatorRequest({ op: "agent-purge", stage: "fail", actor, jobId, runtimeId: "" }),
		);
		if (!settled) logger.error("daemon", "Agent purge settlement failed", undefined, { jobId });
	}
}
