import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { getDbOwner } from "./db-owner-runtime";
import { DB_OWNER_MAX_TRANSACTION_STATEMENTS } from "./db-owner-protocol";
import { ownerBatch } from "./db-owner-sql";
import { logger } from "./logger";

function getMemoryDbPath(): string {
	const agentsDir = resolveDefaultBasePath();
	return join(agentsDir, "memory", "memories.db");
}

export interface SessionMemoryCandidate {
	readonly id: string;
	readonly effScore: number;
	readonly source: "effective" | "fts_only" | "ka_traversal" | "ka_traversal_pinned" | "exploration";
	readonly finalScore?: number;
	readonly entitySlot?: number;
	readonly aspectSlot?: number;
	readonly isConstraint?: number;
	readonly structuralDensity?: number;
	readonly pathJson?: string | null;
}
export async function recordSessionCandidates(
	sessionKey: string | undefined,
	candidates: ReadonlyArray<SessionMemoryCandidate>,
	injectedIds: ReadonlySet<string>,
	agentId = "default",
): Promise<void> {
	if (!sessionKey || candidates.length === 0 || !existsSync(getMemoryDbPath())) return;

	try {
		const owner = await getDbOwner();
		const now = new Date().toISOString();
		const CHUNK_SIZE = 50;
		const ROW = "(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)";
		const BASE_SQL = `INSERT OR IGNORE INTO session_memories
			 (id, session_key, agent_id, memory_id, source, effective_score,
			  final_score, rank, was_injected,
			  fts_hit_count, created_at,
			  entity_slot, aspect_slot, is_constraint, structural_density,
			  path_json)
			 VALUES `;
		const statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
		let rank = 0;

		for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
			const chunk = candidates.slice(i, i + CHUNK_SIZE);
			const values: unknown[] = [];
			for (const c of chunk) {
				const wasInjected = injectedIds.has(c.id) ? 1 : 0;
				const finalScore = c.finalScore ?? c.effScore;
				values.push(
					crypto.randomUUID(),
					sessionKey,
					agentId,
					c.id,
					c.source,
					c.effScore,
					finalScore,
					rank++,
					wasInjected,
					now,
					c.entitySlot ?? null,
					c.aspectSlot ?? null,
					c.isConstraint ?? 0,
					c.structuralDensity ?? null,
					c.pathJson ?? null,
				);
			}
			statements.push({
				sql: BASE_SQL + Array.from({ length: chunk.length }, () => ROW).join(","),
				params: values,
			});
		}

		for (let i = 0; i < statements.length; i += DB_OWNER_MAX_TRANSACTION_STATEMENTS) {
			await ownerBatch(owner, statements.slice(i, i + DB_OWNER_MAX_TRANSACTION_STATEMENTS), {
				operation: "session-start.session-memories.record-candidates",
				lane: "write",
				workloadClass: "foreground",
				deadlineMs: 5_000,
				estimatedWorkUnits: Math.max(1, Math.min(1_200, candidates.length)),
			});
		}

		logger.debug("session-memories", "Recorded session candidates", {
			sessionKey,
			total: candidates.length,
			injected: injectedIds.size,
		});
	} catch (e) {
		logger.warn("session-memories", "Failed to record candidates", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}
export function trackFtsHits(
	sessionKey: string | undefined,
	matchedIds: ReadonlyArray<string>,
	agentId = "default",
): void {
	if (!sessionKey || matchedIds.length === 0 || !existsSync(getMemoryDbPath())) return;

	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			const now = new Date().toISOString();
			const CHUNK_SIZE = 50;
			const ROW = "(?, ?, ?, ?, 'fts_only', 0, 0, 0, 0, 1, ?)";
			const BASE_SQL = `INSERT INTO session_memories
				 (id, session_key, agent_id, memory_id, source, effective_score,
				  final_score, rank, was_injected, fts_hit_count, created_at)
				 VALUES `;
			const CONFLICT_CLAUSE = `
				 ON CONFLICT(session_key, agent_id, memory_id) DO UPDATE SET
				  fts_hit_count = fts_hit_count + 1`;
			const fullChunkStmt =
				matchedIds.length >= CHUNK_SIZE
					? db.prepare(BASE_SQL + Array.from({ length: CHUNK_SIZE }, () => ROW).join(",") + CONFLICT_CLAUSE)
					: null;

			for (let i = 0; i < matchedIds.length; i += CHUNK_SIZE) {
				const chunk = matchedIds.slice(i, i + CHUNK_SIZE);

				let stmt: NonNullable<typeof fullChunkStmt>;
				if (chunk.length === CHUNK_SIZE) {
					if (!fullChunkStmt) throw new Error("full session-memory statement was not prepared");
					stmt = fullChunkStmt;
				} else {
					stmt = db.prepare(BASE_SQL + Array.from({ length: chunk.length }, () => ROW).join(",") + CONFLICT_CLAUSE);
				}

				const values: unknown[] = [];
				for (const id of chunk) {
					values.push(crypto.randomUUID(), sessionKey, agentId, id, now);
				}

				stmt.run(...values);
			}
		}, "session-memories.ts:109");
	} catch (e) {
		logger.warn("session-memories", "Failed to track FTS hits", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}
export function parseFeedback(raw: unknown): Record<string, number> | null {
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const result: Record<string, number> = {};
	let count = 0;
	for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof key !== "string" || key.length === 0) continue;
		if (typeof val !== "number" || !Number.isFinite(val)) continue;
		result[key] = Math.max(-1, Math.min(1, val));
		count++;
	}
	return count > 0 ? result : null;
}
export function recordAgentFeedbackInner(
	db: WriteDb,
	sessionKey: string,
	feedback: Readonly<Record<string, number>>,
	agentId = "default",
): void {
	const stmt = db.prepare(`
		UPDATE session_memories
		SET agent_relevance_score = CASE
				WHEN agent_relevance_score IS NULL THEN ?
				ELSE (agent_relevance_score * agent_feedback_count + ?) / (agent_feedback_count + 1)
			END,
			agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
		WHERE session_key = ? AND agent_id = ? AND memory_id = ?
	`);

	for (const [memoryId, score] of Object.entries(feedback)) {
		stmt.run(score, score, sessionKey, agentId, memoryId);
	}
}
export function recordAgentFeedback(
	sessionKey: string | undefined,
	feedback: Readonly<Record<string, number>>,
	agentId = "default",
): void {
	if (!sessionKey || Object.keys(feedback).length === 0 || !existsSync(getMemoryDbPath())) return;

	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			recordAgentFeedbackInner(db, sessionKey, feedback, agentId);
		}, "session-memories.ts:193");

		logger.debug("session-memories", "Recorded agent feedback", {
			sessionKey,
			memoryCount: Object.keys(feedback).length,
		});
	} catch (e) {
		logger.warn("session-memories", "Failed to record agent feedback", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}
