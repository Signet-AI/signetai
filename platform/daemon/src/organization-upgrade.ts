import { setTimeout as wait } from "node:timers/promises";
import { logger } from "./logger";
import type { Principal } from "./auth/principal";
import { requireAdmin } from "./auth/organization-operations";
import { operatorActor, operatorRequest } from "./operator-jobs";
import {
	upgradePlanSchema,
	type UpgradeCommand,
	type UpgradeView,
	type UpgradeInventoryView,
} from "./organization-upgrade-contract";
import { z } from "zod";

export async function organizationUpgrade(p: Principal, command: UpgradeCommand) {
	requireAdmin(p);
	return operatorRequest<UpgradeView | UpgradeInventoryView>({
		op: "organization-upgrade",
		actor: operatorActor(p),
		command,
	});
}
export async function previewOrganizationUpgrade(p: Principal, input: unknown) {
	return organizationUpgrade(p, { action: "preview", plan: upgradePlanSchema.parse(input) });
}
export async function reviseOrganizationUpgrade(p: Principal, jobId: string, input: unknown) {
	const data = z
		.object({ revision: z.string().min(1).max(100), plan: upgradePlanSchema })
		.strict()
		.parse(input);
	return organizationUpgrade(p, { action: "revise", jobId, ...data });
}
export async function controlOrganizationUpgrade(
	p: Principal,
	jobId: string,
	action: "confirm" | "cancel" | "resume",
	input: unknown,
) {
	const data = z
		.object({ revision: z.string().min(1).max(100) })
		.strict()
		.parse(input);
	const result = await organizationUpgrade(p, { action, jobId, ...data });
	if (action === "confirm" || action === "resume") dispatchUpgrade();
	return result;
}

let running: Promise<void> | null = null;
let controller: AbortController | null = null;
let paused = false;
let requested = false;
function dispatchUpgrade(): void {
	requested = true;
	if (paused || running) return;
	const abort = new AbortController();
	controller = abort;
	running = runUpgrades(abort.signal)
		.catch(() => {
			if (!abort.signal.aborted)
				logger.error("daemon", "Organization upgrade continuation is unavailable; durable progress is retained");
		})
		.finally(() => {
			running = null;
			if (controller === abort) controller = null;
			if (requested && !paused) dispatchUpgrade();
		});
}
async function runUpgrades(signal: AbortSignal): Promise<void> {
	while (!signal.aborted) {
		requested = false;
		const pending = await operatorRequest<readonly { id: string }[]>({
			op: "organization-upgrade",
			actor: null,
			command: { action: "recover" },
		});
		const job = pending[0];
		if (!job || signal.aborted) return;
		let status = "running";
		while (status === "running" && !signal.aborted) {
			const result = await operatorRequest<UpgradeView>({
				op: "organization-upgrade",
				actor: null,
				command: { action: "next", jobId: job.id },
			});
			status = result.status;
			if (status === "running") await wait(25, undefined, { signal });
		}
	}
}
export function startOrganizationUpgradeRuntime(): void {
	paused = false;
	dispatchUpgrade();
}
export function pauseOrganizationUpgradeRuntime(): void {
	paused = true;
	controller?.abort();
}
export async function stopOrganizationUpgradeRuntime(): Promise<void> {
	pauseOrganizationUpgradeRuntime();
	await running;
}
