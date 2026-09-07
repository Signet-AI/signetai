import type { ReadDb, WriteDb } from "./db-accessor";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LEASE_MS = HOUR_MS;
const MAX_ERROR_LENGTH = 500;
export const GLOBAL_REPAIR_SCOPE = "global";

export interface RepairAdmissionRequest {
	readonly action: string;
	readonly scope?: string;
	readonly cooldownMs: number;
	readonly hourlyBudget: number;
	readonly actor: string;
	readonly actorType: string;
	readonly requestId?: string;
	readonly now?: number;
	readonly leaseMs?: number;
}

export interface RepairAdmissionLease {
	readonly action: string;
	readonly scope: string;
	readonly id: string;
}

export interface RepairAdmissionResult {
	readonly allowed: boolean;
	readonly lease?: RepairAdmissionLease;
	readonly reason?: string;
	readonly retryAfterMs?: number;
}

export interface RepairAdmissionCompletion {
	readonly success: boolean;
	readonly affected: number;
	readonly actor: string;
	readonly requestId?: string;
	readonly error?: string;
	readonly now?: number;
}

interface AdmissionRow {
	readonly action: string;
	readonly scope: string;
	readonly window_started_at: string;
	readonly hourly_count: number;
	readonly lease_id: string | null;
	readonly lease_expires_at: string | null;
	readonly last_completed_at: string | null;
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

function parseTime(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAction(action: string): string {
	const value = action.trim();
	if (value.length === 0) throw new Error("repair admission action must not be empty");
	return value;
}

export function normalizeRepairScope(scope?: string): string {
	const value = scope?.trim();
	return value && value.length > 0 ? value : GLOBAL_REPAIR_SCOPE;
}

export function repairScopeKey(input: { readonly agentId?: string; readonly project?: string } = {}): string {
	const agent = input.agentId?.trim();
	const project = input.project?.trim();
	const parts: string[] = [];
	if (agent) parts.push(`agent=${encodeURIComponent(agent)}`);
	if (project) parts.push(`project=${encodeURIComponent(project)}`);
	return parts.length > 0 ? parts.join(";") : GLOBAL_REPAIR_SCOPE;
}

function readAdmission(db: ReadDb, action: string, scope: string): AdmissionRow | null {
	return (
		(db
			.prepare(
				`SELECT action, scope, window_started_at, hourly_count,
						lease_id, lease_expires_at, last_completed_at
				 FROM repair_admission WHERE action = ? AND scope = ?`,
			)
			.get(action, scope) as AdmissionRow | undefined) ?? null
	);
}

function boundedCooldown(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function boundedBudget(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function boundedLease(value: number | undefined, cooldownMs: number): number {
	if (value === undefined || !Number.isFinite(value)) return Math.max(DEFAULT_LEASE_MS, cooldownMs);
	return Math.max(1, Math.floor(value), cooldownMs);
}

function boundedError(error: string | undefined): string | null {
	if (!error) return null;
	return error.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Atomically reserve one repair action/scope lease and one hourly budget slot.
 * The row is intentionally durable: a new daemon process sees an active lease
 * or recent completion instead of replaying work after a restart.
 */
export function acquireRepairAdmissionInTx(db: WriteDb, request: RepairAdmissionRequest): RepairAdmissionResult {
	const action = normalizeAction(request.action);
	const scope = normalizeRepairScope(request.scope);
	const now = request.now ?? Date.now();
	const cooldownMs = boundedCooldown(request.cooldownMs);
	const hourlyBudget = boundedBudget(request.hourlyBudget);
	if (hourlyBudget === 0) {
		return { allowed: false, reason: `repair hourly budget exhausted (0 runs/hr)`, retryAfterMs: HOUR_MS };
	}

	const current = readAdmission(db, action, scope);
	const nowIso = iso(now);
	const activeLeaseUntil = current ? parseTime(current.lease_expires_at) : null;
	if (current !== null && current.lease_id !== null && activeLeaseUntil === null) {
		return {
			allowed: false,
			reason: `repair admission has an invalid active lease for ${action} (${scope})`,
			retryAfterMs: HOUR_MS,
		};
	}
	if (activeLeaseUntil !== null && activeLeaseUntil > now) {
		return {
			allowed: false,
			reason: `repair admission already in progress for ${action} (${scope})`,
			retryAfterMs: activeLeaseUntil - now,
		};
	}

	const completedAt = current ? parseTime(current.last_completed_at) : null;
	if (completedAt !== null && now - completedAt < cooldownMs) {
		const retryAfterMs = cooldownMs - (now - completedAt);
		return {
			allowed: false,
			reason: `repair cooldown active for ${action} (${scope}), ${retryAfterMs}ms remaining`,
			retryAfterMs,
		};
	}

	const windowStart = current ? parseTime(current.window_started_at) : null;
	const inWindow = windowStart !== null && windowStart <= now && now - windowStart < HOUR_MS;
	const hourlyCount = inWindow ? (current?.hourly_count ?? 0) : 0;
	if (hourlyCount >= hourlyBudget) {
		const retryAfterMs = inWindow && windowStart !== null ? HOUR_MS - (now - windowStart) : HOUR_MS;
		return {
			allowed: false,
			reason: `repair hourly budget exhausted for ${action} (${scope}, ${hourlyBudget} runs/hr)`,
			retryAfterMs,
		};
	}

	const lease: RepairAdmissionLease = {
		action,
		scope,
		id: crypto.randomUUID(),
	};
	const nextWindowStart = inWindow && current ? current.window_started_at : nowIso;
	db.prepare(
		`INSERT INTO repair_admission
				(action, scope, window_started_at, hourly_count, lease_id,
				 lease_expires_at, lease_actor, lease_actor_type, lease_request_id,
				 last_completed_at, last_affected, last_completed_actor,
				 last_completed_request_id, last_error, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, ?)
			 ON CONFLICT(action, scope) DO UPDATE SET
				window_started_at = excluded.window_started_at,
				hourly_count = excluded.hourly_count,
				lease_id = excluded.lease_id,
				lease_expires_at = excluded.lease_expires_at,
				lease_actor = excluded.lease_actor,
				lease_actor_type = excluded.lease_actor_type,
				lease_request_id = excluded.lease_request_id,
				last_error = NULL,
				updated_at = excluded.updated_at`,
	).run(
		action,
		scope,
		nextWindowStart,
		hourlyCount + 1,
		lease.id,
		iso(now + boundedLease(request.leaseMs, cooldownMs)),
		request.actor,
		request.actorType,
		request.requestId ?? null,
		nowIso,
	);
	return { allowed: true, lease };
}

/**
 * Complete a lease and retain a bounded record of its latest outcome. A false
 * result means the lease expired or was replaced; callers must not report the
 * operation as safely admitted in that case.
 */
export function finishRepairAdmissionInTx(
	db: WriteDb,
	lease: RepairAdmissionLease,
	completion: RepairAdmissionCompletion,
): boolean {
	const now = completion.now ?? Date.now();
	const current = readAdmission(db, lease.action, lease.scope);
	if (current?.lease_id !== lease.id) return false;
	const changed = db
		.prepare(
			`UPDATE repair_admission
					 SET lease_id = NULL, lease_expires_at = NULL,
						 lease_actor = NULL, lease_actor_type = NULL, lease_request_id = NULL,
						 last_completed_at = ?, last_affected = ?,
						 last_completed_actor = ?, last_completed_request_id = ?,
						 last_error = ?, updated_at = ?
					 WHERE action = ? AND scope = ? AND lease_id = ?`,
		)
		.run(
			iso(now),
			Math.max(0, Math.floor(completion.affected)),
			completion.actor,
			completion.requestId ?? null,
			completion.success ? null : (boundedError(completion.error) ?? "repair failed"),
			iso(now),
			lease.action,
			lease.scope,
			lease.id,
		);
	return changed.changes > 0;
}
