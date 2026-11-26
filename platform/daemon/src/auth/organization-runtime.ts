import { setupTokenPath } from "./setup-token-file";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { dbOwnerQuery, dbOwnerTransaction } from "../db-owner-runtime";
import { logger } from "../logger";
import { auditStatement, ensureSetupToken, organizationWrite, readOrganization, statement } from "./organization-store";
import type { Principal } from "./principal";

const queue: DbOwnerStatement[] = [];
const controllers = new Set<AbortController>();
let dropped = 0;
let totalDropped = 0;
let lastError: string | null = null;
let paused = false;
let timer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
let pruning: Promise<void> | null = null;
let stopping: Promise<void> | null = null;
export function auditRuntimeStatus() {
	return { dropped: totalDropped, queued: queue.length, lastError };
}
function recordAuditFailure(error: unknown): void {
	lastError = error instanceof Error ? error.message : String(error);
	logger.error("auth", "Audit maintenance failed", error instanceof Error ? error : undefined);
}
async function withAuditDeadline(
	timeoutMs: number,
	work: (signal: AbortSignal, deadlineAt: number) => Promise<void>,
): Promise<void> {
	const controller = new AbortController();
	controllers.add(controller);
	const timeout = setTimeout(() => controller.abort(new Error("Audit operation deadline exceeded")), timeoutMs);
	timeout.unref();
	try {
		await work(controller.signal, Date.now() + timeoutMs);
	} finally {
		clearTimeout(timeout);
		controllers.delete(controller);
	}
}
export function auditDroppedCount(): number {
	return totalDropped;
}
export function bufferReadAudit(p: Principal, route: string, agentId: string | undefined, count: number | null): void {
	if (queue.length >= 10_000) {
		dropped++;
		totalDropped++;
		return;
	}
	queue.push(auditStatement(p, "content.read", "route", route, { agentId: agentId ?? null, count }));
}
export async function flushReadAudit(timeoutMs = 5000): Promise<void> {
	if (flushing) return flushing;
	flushing = withAuditDeadline(timeoutMs, async (signal, deadlineAt) => {
		let remaining = queue.length;
		while (remaining > 0) {
			signal.throwIfAborted();
			const batch = queue.slice(0, Math.min(128, remaining));
			await dbOwnerTransaction(batch, {
				operation: "organization.audit.flush",
				lane: "write",
				deadlineMs: Math.max(1, deadlineAt - Date.now()),
				signal,
			});
			queue.splice(0, batch.length);
			remaining -= batch.length;
		}
		if (dropped) {
			const n = dropped;
			await dbOwnerTransaction([auditStatement(null, "audit.dropped", null, null, { count: n })], {
				operation: "organization.audit.dropped",
				lane: "write",
				deadlineMs: Math.max(1, deadlineAt - Date.now()),
				signal,
			});
			dropped -= n;
		}
	});
	try {
		await flushing;
		lastError = null;
	} finally {
		flushing = null;
	}
}
export async function pruneAudit(): Promise<void> {
	if (pruning) return pruning;
	pruning = withAuditDeadline(5000, async (signal, deadlineAt) => {
		const org = await dbOwnerQuery<{ audit_retention_days: number }>(
			statement("SELECT audit_retention_days FROM organization WHERE id = 1", [], "get"),
			{
				operation: "organization.audit.retention",
				lane: "read",
				deadlineMs: Math.max(1, deadlineAt - Date.now()),
				signal,
			},
		);
		const cutoff = new Date(Date.now() - org.audit_retention_days * 86400_000).toISOString();
		await dbOwnerTransaction(
			[
				statement(
					"DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE at < ? AND (action != 'session.refreshed' OR NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = audit_events.target_id AND s.revoked_at IS NULL AND s.refresh_expires_at > CURRENT_TIMESTAMP)) ORDER BY at LIMIT 1000)",
					[cutoff],
				),
				statement(
					"DELETE FROM device_authorizations WHERE id IN (SELECT id FROM device_authorizations WHERE expires_at<=? LIMIT 1000)",
					[new Date().toISOString()],
				),
			],
			{
				operation: "organization.audit.prune",
				lane: "write",
				deadlineMs: Math.max(1, deadlineAt - Date.now()),
				signal,
			},
		);
	});
	try {
		await pruning;
	} finally {
		pruning = null;
	}
}
export async function startOrganizationRuntime(baseUrl: string, agentsDir: string): Promise<void> {
	const org = await readOrganization();
	if (!org.claimed_at) {
		const token = await ensureSetupToken(agentsDir);
		if (token) {
			console.log(
				`[organization] Setup URL: ${baseUrl}/auth/setup\n[organization] Read the one-time token on the instance host from ${setupTokenPath(agentsDir)}`,
			);
			if (process.stdout.isTTY) console.log(`[organization] Setup token: ${token}`);
		}
	}
	await organizationWrite([
		statement(
			"UPDATE org_jobs SET status = 'failed',error = 'Daemon restarted before job completion',finished_at = ? WHERE status IN ('pending','running') AND kind IN ('offboard','bulk_revoke')",
			[new Date().toISOString()],
		),
	]);
	if (timer) return;
	paused = false;
	stopping = null;
	timer = setInterval(() => {
		void flushReadAudit().catch((error: unknown) => {
			if (!paused) recordAuditFailure(error);
		});
	}, 2000);
	timer.unref();
	pruneTimer = setInterval(() => {
		void pruneAudit().catch((error: unknown) => {
			if (!paused) recordAuditFailure(error);
		});
	}, 60_000);
	pruneTimer.unref();
}
export function pauseOrganizationRuntime(): void {
	paused = true;
	if (timer) clearInterval(timer);
	if (pruneTimer) clearInterval(pruneTimer);
	timer = null;
	pruneTimer = null;
	for (const controller of controllers) controller.abort(new Error("Audit maintenance stopping"));
}
export function stopOrganizationRuntime(): Promise<void> {
	if (stopping) return stopping;
	pauseOrganizationRuntime();
	stopping = (async () => {
		await Promise.allSettled([flushing, pruning]);
		try {
			await flushReadAudit(2000);
		} catch (error) {
			recordAuditFailure(error);
			throw error;
		}
	})();
	return stopping;
}
