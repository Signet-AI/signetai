/**
 * Session summary DAG condensation: session -> arc -> epoch.
 *
 * After each session summary is written, check whether enough
 * uncondensed summaries have accumulated to trigger a higher-level
 * condensation. Arcs condense sessions; epochs condense arcs.
 */

import type { DbAccessor } from "../db-accessor";
import { logger } from "../logger";
import type { LlmProvider } from "./provider";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CondensationConfig {
	readonly arcThreshold: number;
	readonly epochThreshold: number;
}

const DEFAULT_CONFIG: CondensationConfig = {
	arcThreshold: 8,
	epochThreshold: 4,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SummaryRow {
	readonly id: string;
	readonly content: string;
	readonly project: string | null;
	readonly earliest_at: string;
	readonly latest_at: string;
}

// ---------------------------------------------------------------------------
// LLM timeout for condensation calls
// ---------------------------------------------------------------------------

const CONDENSATION_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(accessor: DbAccessor): boolean {
	return accessor.withReadDb((db) => {
		const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get();
		return row !== undefined;
	});
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function checkAndCondense(
	accessor: DbAccessor,
	provider: LlmProvider,
	project: string,
	agentId: string,
	config?: Partial<CondensationConfig>,
): Promise<void> {
	if (!tableExists(accessor)) return;

	const cfg: CondensationConfig = { ...DEFAULT_CONFIG, ...config };

	// Check uncondensed session summaries for this project
	const uncondensedSessions = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, content, project, earliest_at, latest_at
				 FROM session_summaries
				 WHERE project = ? AND agent_id = ? AND kind = 'session' AND depth = 0
				   AND COALESCE(source_type, 'summary') IN ('summary', 'compaction')
				   AND id NOT IN (SELECT child_id FROM session_summary_children)
				 ORDER BY created_at ASC`,
			)
			.all(project, agentId) as SummaryRow[];
	});

	if (uncondensedSessions.length >= cfg.arcThreshold) {
		const batch = uncondensedSessions.slice(0, cfg.arcThreshold);
		await condenseToArc(accessor, provider, batch, agentId);
	}

	// Epoch check is independent: arcs accumulate across many ticks,
	// so we always query — not just when arc condensation just fired.
	const uncondensedArcs = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, content, project, earliest_at, latest_at
				 FROM session_summaries
				 WHERE project = ? AND agent_id = ? AND kind = 'arc' AND depth = 1
				   AND COALESCE(source_type, 'condensation') = 'condensation'
				   AND id NOT IN (SELECT child_id FROM session_summary_children)
				 ORDER BY created_at ASC`,
			)
			.all(project, agentId) as SummaryRow[];
	});

	if (uncondensedArcs.length >= cfg.epochThreshold) {
		const arcBatch = uncondensedArcs.slice(0, cfg.epochThreshold);
		await condenseToEpoch(accessor, provider, arcBatch, agentId);
	}
}

// ---------------------------------------------------------------------------
// Arc condensation
// ---------------------------------------------------------------------------

async function condenseToArc(
	accessor: DbAccessor,
	provider: LlmProvider,
	sessions: readonly SummaryRow[],
	agentId: string,
): Promise<string | null> {
	if (sessions.length === 0) return null;

	const summaryTexts = sessions.map((s, i) => `--- Session ${i + 1} ---\n${s.content}`);

	const prompt = `Condense these ${sessions.length} session summaries into an arc summary. Preserve decisions and outcomes. Drop transient errors and command-level detail.

Return ONLY the condensed summary as plain markdown (no JSON, no fences).

${summaryTexts.join("\n\n")}`;

	const condensed = await provider.generate(prompt, {
		timeoutMs: CONDENSATION_TIMEOUT_MS,
	});

	const arcId = crypto.randomUUID();
	const now = new Date().toISOString();
	const tokenCount = Math.ceil(condensed.length / 4);

	const earliestAt = sessions.reduce((min, s) => (s.earliest_at < min ? s.earliest_at : min), sessions[0].earliest_at);
	const latestAt = sessions.reduce((max, s) => (s.latest_at > max ? s.latest_at : max), sessions[0].latest_at);

	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 1, 'arc', ?, ?, ?, ?, NULL, NULL, ?, 'condensation', NULL, ?, ?)`,
		).run(
			arcId,
			sessions[0].project,
			condensed,
			tokenCount,
			earliestAt,
			latestAt,
			agentId,
			JSON.stringify({ source: "summary-condensation", childCount: sessions.length }),
			now,
		);

		const childStmt = db.prepare(
			`INSERT OR IGNORE INTO session_summary_children (parent_id, child_id, ordinal)
			 VALUES (?, ?, ?)`,
		);

		for (let i = 0; i < sessions.length; i++) {
			childStmt.run(arcId, sessions[i].id, i);
		}
	});

	logger.info("summary-condensation", "Condensed sessions into arc", {
		arcId,
		sessionCount: sessions.length,
		project: sessions[0].project,
		contentLength: condensed.length,
	});

	return arcId;
}

// ---------------------------------------------------------------------------
// Epoch condensation
// ---------------------------------------------------------------------------

async function condenseToEpoch(
	accessor: DbAccessor,
	provider: LlmProvider,
	arcs: readonly SummaryRow[],
	agentId: string,
): Promise<string | null> {
	if (arcs.length === 0) return null;

	const arcTexts = arcs.map((a, i) => `--- Arc ${i + 1} ---\n${a.content}`);

	const prompt = `Condense these ${arcs.length} arc summaries into an epoch summary. Preserve only architectural facts, major direction changes, and constraints that still apply.

Return ONLY the condensed summary as plain markdown (no JSON, no fences).

${arcTexts.join("\n\n")}`;

	const condensed = await provider.generate(prompt, {
		timeoutMs: CONDENSATION_TIMEOUT_MS,
	});

	const epochId = crypto.randomUUID();
	const now = new Date().toISOString();
	const tokenCount = Math.ceil(condensed.length / 4);

	const earliestAt = arcs.reduce((min, a) => (a.earliest_at < min ? a.earliest_at : min), arcs[0].earliest_at);
	const latestAt = arcs.reduce((max, a) => (a.latest_at > max ? a.latest_at : max), arcs[0].latest_at);

	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 2, 'epoch', ?, ?, ?, ?, NULL, NULL, ?, 'condensation', NULL, ?, ?)`,
		).run(
			epochId,
			arcs[0].project,
			condensed,
			tokenCount,
			earliestAt,
			latestAt,
			agentId,
			JSON.stringify({ source: "summary-condensation", childCount: arcs.length }),
			now,
		);

		const childStmt = db.prepare(
			`INSERT OR IGNORE INTO session_summary_children (parent_id, child_id, ordinal)
			 VALUES (?, ?, ?)`,
		);

		for (let i = 0; i < arcs.length; i++) {
			childStmt.run(epochId, arcs[i].id, i);
		}
	});

	logger.info("summary-condensation", "Condensed arcs into epoch", {
		epochId,
		arcCount: arcs.length,
		project: arcs[0].project,
		contentLength: condensed.length,
	});

	return epochId;
}
