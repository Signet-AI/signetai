import { getDbAccessor } from "./db-accessor.js";
import { countChanges } from "./db-helpers.js";
import { logger } from "./logger.js";

export type SkillInvocationSource = "agent" | "scheduler" | "api";

export interface SkillInvocationRecord {
	readonly skillName: string;
	readonly agentId: string;
	readonly source: SkillInvocationSource;
	readonly latencyMs: number;
	readonly success: boolean;
	readonly errorText?: string;
	// Harness-emitted rows (source='agent'). Deduped on (harness, sessionId, toolUseId).
	readonly harness?: string;
	readonly sessionId?: string;
	readonly toolUseId?: string;
	readonly cwd?: string;
	readonly origin?: string;
	readonly args?: string;
	// Override created_at (ISO) — backfill from historical transcripts.
	readonly createdAt?: string;
}

function optionalText(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function normalizeSkillName(value: string): string {
	return value.trim().toLowerCase();
}

function clampLatency(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.round(value);
}

export function recordSkillInvocation(record: SkillInvocationRecord): void {
	const skill = normalizeSkillName(record.skillName);
	if (skill.length === 0) return;
	if (record.agentId.trim().length === 0) return;

	const now = optionalText(record.createdAt) ?? new Date().toISOString();
	const id = crypto.randomUUID();
	const latency = clampLatency(record.latencyMs);

	try {
		getDbAccessor().withWriteTx((db) => {
			// OR IGNORE lets the partial-unique idx_skill_inv_dedupe drop a repeated
			// harness event (same harness/session/tool_use_id). Internal rows have
			// null ids, never match the partial index, and always insert.
			db.prepare(
				`INSERT OR IGNORE INTO skill_invocations
					 (id, skill_name, agent_id, source, latency_ms, success, error_text, created_at,
					  harness, session_id, tool_use_id, cwd, origin, args)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				skill,
				record.agentId,
				record.source,
				latency,
				record.success ? 1 : 0,
				record.errorText ?? null,
				now,
				optionalText(record.harness),
				optionalText(record.sessionId),
				optionalText(record.toolUseId),
				optionalText(record.cwd),
				optionalText(record.origin),
				optionalText(record.args),
			);

			// Only bump use_count when a row was actually inserted. The dedupe index
			// drops repeated harness events (e.g. a transcript re-scanned at both
			// PreCompact and SessionEnd), and a dropped insert must not inflate the count.
			const changed = countChanges(db.prepare("SELECT changes() AS changes").get());
			if (changed > 0) {
				db.prepare(
					`UPDATE skill_meta
					 SET use_count = COALESCE(use_count, 0) + 1,
					     last_used_at = ?,
					     updated_at = ?
					 WHERE agent_id = ?
					   AND entity_id IN (
						   SELECT id FROM entities
						   WHERE agent_id = ? AND lower(name) = ?
					   )`,
				).run(now, now, record.agentId, record.agentId, skill);
			}
		});
	} catch (err) {
		logger.warn("skills", "Failed to record skill invocation", err instanceof Error ? err : undefined);
	}
}
