import { withWritePrincipal } from "@signet/core";
import { getDbAccessorPath, hasDbAccessor } from "../db-accessor";
import { registerDbAccessorCloseParticipant } from "../db-accessor-lifecycle";
import { DbOwnerAdmissionError, type DbOwnerClient } from "../db-owner-client";
import type { AuthObservation } from "../db-owner-protocol";
import { getDbOwner } from "../db-owner-runtime";
import { withoutRequestOwnerProfile } from "../db-request-profile";
import { logger } from "../logger";

const pending = new Map<string, AuthObservation>();
const observedAt = new Map<string, { at: string; previousAt: string | null | undefined }>();
let owner: DbOwnerClient | undefined;
let binding: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;
let stopped = false;

function identity(client: DbOwnerClient): string | null {
	if (!hasDbAccessor()) return null;
	const health = client.health();
	return health.state === "ready" ? JSON.stringify([getDbAccessorPath(), health.pid, health.generation]) : null;
}
function schedule(): void {
	if (stopped || timer || active || pending.size === 0) return;
	timer = setTimeout(() => {
		timer = undefined;
		void flushAuthObservations();
	}, 1000);
	timer.unref();
}
export async function recordAuthObservation(
	kind: AuthObservation["kind"],
	id: string,
	at: string,
	previousAt?: string | null,
): Promise<void> {
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
		observedAt.clear();
		binding = scope;
		owner = client;
		stopped = false;
	}
	if (stopped) throw new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "Authentication observations are closing");
	const key = `${kind}:${id}`;
	const observed = observedAt.get(key);
	if (
		!pending.has(key) &&
		observed &&
		observed.previousAt === previousAt &&
		Date.parse(at) - Date.parse(observed.at) < 60_000
	)
		return;
	if (!pending.has(key) && pending.size >= 2048)
		throw new DbOwnerAdmissionError("DB_OWNER_QUEUE_FULL", "Authentication observation capacity reached");
	const previous = pending.get(key);
	if (!previous || previous.at < at) {
		pending.set(key, { kind, id, at });
		observedAt.delete(key);
		if (observedAt.size >= 2048) {
			const oldest = observedAt.keys().next().value;
			if (oldest !== undefined) observedAt.delete(oldest);
		}
		observedAt.set(key, { at, previousAt });
	}
	schedule();
}
async function flushCurrent(deadlineMs: number): Promise<void> {
	const client = owner;
	const scope = binding;
	if (!client || !scope) {
		pending.clear();
		return;
	}
	const batch = [...pending.entries()].slice(0, 128);
	if (batch.length === 0) return;
	try {
		if (identity(client) !== scope) {
			pending.clear();
			return;
		}
		const applied = await withWritePrincipal(
			undefined,
			() =>
				client.submit<number>(
					{ kind: "auth_observations", observations: batch.map(([, value]) => value) },
					{
						lane: "maintenance",
						operation: "auth.observations.flush",
						deadlineMs,
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
		if (binding === scope)
			for (const [key, value] of batch) {
				if (pending.get(key) === value) pending.delete(key);
				if (observedAt.get(key)?.at === value.at) observedAt.delete(key);
			}
		logger.warn("auth", "Authentication observations were not persisted", {
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}
export function flushAuthObservations(deadlineMs = 5000): Promise<void> {
	if (active) return active;
	if (timer) {
		clearTimeout(timer);
		timer = undefined;
	}
	active = withoutRequestOwnerProfile(() => flushCurrent(deadlineMs)).finally(() => {
		active = undefined;
		schedule();
	});
	return active;
}

export async function stopAuthObservations(): Promise<void> {
	stopped = true;
	if (timer) clearTimeout(timer);
	timer = undefined;
	const deadline = Date.now() + 5000;
	await active;
	while (pending.size > 0 && Date.now() < deadline) {
		await flushAuthObservations(Math.max(1, deadline - Date.now()));
	}
	if (pending.size > 0) {
		logger.warn("auth", "Authentication observations exceeded shutdown deadline", { count: pending.size });
		pending.clear();
	}
	owner = undefined;
}

registerDbAccessorCloseParticipant({
	name: "auth-observations",
	order: 10,
	close: stopAuthObservations,
});
