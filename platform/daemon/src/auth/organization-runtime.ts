import type { Principal } from "./principal";
import { auditStatement, ensureSetupToken, organizationWrite, readOrganization, statement } from "./organization-store";
import { logger } from "../logger";
import type { DbOwnerStatement } from "../db-owner-protocol";

const queue: DbOwnerStatement[] = [];
let dropped = 0;
let totalDropped = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
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
export async function flushReadAudit(): Promise<void> {
	if (flushing) return flushing;
	flushing = (async () => {
		while (queue.length) {
			const batch = queue.slice(0, 500);
			await organizationWrite(batch);
			queue.splice(0, batch.length);
		}
		if (dropped) {
			const n = dropped;
			await organizationWrite([auditStatement(null, "audit.dropped", null, null, { count: n })]);
			dropped -= n;
		}
	})();
	try {
		await flushing;
	} finally {
		flushing = null;
	}
}
export async function pruneAudit(): Promise<void> {
	const org = await readOrganization();
	const cutoff = new Date(Date.now() - org.audit_retention_days * 86400_000).toISOString();
	await organizationWrite([
		statement(
			"DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE at < ? AND (action != 'session.refreshed' OR NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = audit_events.target_id AND s.revoked_at IS NULL AND s.refresh_expires_at > CURRENT_TIMESTAMP)) ORDER BY at LIMIT 1000)",
			[cutoff],
		),
	]);
}
export async function startOrganizationRuntime(baseUrl: string): Promise<void> {
	const org = await readOrganization();
	if (!org.claimed_at) {
		const token = await ensureSetupToken();
		if (token) console.log(`[organization] Setup URL: ${baseUrl}/auth/setup\n[organization] Setup token: ${token}`);
	}
	await organizationWrite([
		statement(
			"UPDATE org_jobs SET status = 'failed',error = 'Daemon restarted before job completion',finished_at = ? WHERE status IN ('pending','running')",
			[new Date().toISOString()],
		),
	]);
	if (timer) return;
	timer = setInterval(() => {
		void flushReadAudit().catch((error: unknown) =>
			logger.error("auth", "Audit flush failed", error instanceof Error ? error : undefined),
		);
	}, 2000);
	timer.unref();
	pruneTimer = setInterval(() => {
		void pruneAudit().catch((error: unknown) =>
			logger.error("auth", "Audit pruning failed", error instanceof Error ? error : undefined),
		);
	}, 60_000);
	pruneTimer.unref();
}
export async function stopOrganizationRuntime(): Promise<void> {
	if (timer) clearInterval(timer);
	if (pruneTimer) clearInterval(pruneTimer);
	timer = null;
	pruneTimer = null;
	await flushReadAudit();
}
