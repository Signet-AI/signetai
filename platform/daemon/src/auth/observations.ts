import { withWritePrincipal } from "@signet/core";
import { getDbAccessorPath, hasDbAccessor } from "../db-accessor";
import { DbOwnerAdmissionError, type DbOwnerClient } from "../db-owner-client";
import type { AuthObservation } from "../db-owner-protocol";
import { getDbOwner } from "../db-owner-runtime";
import { withoutRequestOwnerProfile } from "../db-request-profile";
import { logger } from "../logger";

const pending = new Map<string, AuthObservation>();
let owner: DbOwnerClient | undefined;
let binding: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;

function identity(client: DbOwnerClient): string | null {
	if (!hasDbAccessor()) return null;
	const health = client.health();
	return health.state === "ready" ? JSON.stringify([getDbAccessorPath(), health.pid, health.generation]) : null;
}
function schedule(): void {
	if (timer || active || pending.size === 0) return;
	timer = setTimeout(() => {
		timer = undefined;
		void flushAuthObservations();
	}, 1000);
	timer.unref();
}
export async function recordAuthObservation(kind: AuthObservation["kind"], id: string, at: string): Promise<void> {
	const client = await getDbOwner();
	const scope = identity(client);
	if (scope === null)
		throw new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "Authentication observations require a ready owner");
	if (binding !== scope) {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		pending.clear();
		binding = scope;
		owner = client;
	}
	const key = `${kind}:${id}`;
	if (!pending.has(key) && pending.size >= 2048)
		throw new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "Authentication observation capacity reached");
	const previous = pending.get(key);
	if (!previous || previous.at < at) pending.set(key, { kind, id, at });
	schedule();
}
async function flushCurrent(): Promise<void> {
	const client = owner;
	const scope = binding;
	if (!client || !scope || identity(client) !== scope) {
		pending.clear();
		return;
	}
	const batch = [...pending.entries()].slice(0, 128);
	if (batch.length === 0) return;
	try {
		const applied = await withWritePrincipal(
			undefined,
			() =>
				client.submit<number>(
					{ kind: "auth_observations", observations: batch.map(([, value]) => value) },
					{
						lane: "maintenance",
						operation: "auth.observations.flush",
						deadlineMs: 5000,
						estimatedWorkUnits: batch.length,
					},
				).result,
		);
		if (binding === scope)
			for (const [key, value] of batch.slice(0, applied)) {
				const latest = pending.get(key);
				pending.delete(key);
				if (latest && latest !== value) pending.set(key, latest);
			}
	} catch (error) {
		if (binding === scope) for (const [key, value] of batch) if (pending.get(key) === value) pending.delete(key);
		logger.warn("auth", "Authentication observations were not persisted", {
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}
export function flushAuthObservations(): Promise<void> {
	if (active) return active;
	if (timer) {
		clearTimeout(timer);
		timer = undefined;
	}
	active = withoutRequestOwnerProfile(flushCurrent).finally(() => {
		active = undefined;
		schedule();
	});
	return active;
}
