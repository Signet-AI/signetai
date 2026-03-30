/**
 * Prospective indexing worker — generates hypothetical future queries
 * ("hints") for each memory at write time. Hints are indexed in FTS5
 * so search matches memories by anticipated cue, bridging the semantic
 * gap between stored facts and natural language queries.
 *
 * Inspired by Kumiho (arXiv:2603.17244).
 */

import type { LlmProvider, PipelineHintsConfig } from "@signet/core";
import type { DbAccessor, WriteDb } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HintsWorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface HintJobRow {
	readonly id: string;
	readonly memory_id: string;
	readonly payload: string;
	readonly attempts: number;
	readonly max_attempts: number;
}

interface HintPayload {
	readonly memoryId: string;
	readonly content: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(content: string, max: number): string {
	return [
		`Given this fact stored in a personal memory system:`,
		`"${content}"`,
		``,
		`Generate ${max} diverse questions or cues a user might use in the future when this fact would be helpful. Include:`,
		`- Direct questions ("Where does X live?")`,
		`- Temporal questions ("When did X happen?")`,
		`- Relational questions ("Who is X's partner?")`,
		`- Indirect/conversational cues ("Tell me about X's move")`,
		``,
		`Return ONLY the questions, one per line. No numbering, no bullets.`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Hint generation
// ---------------------------------------------------------------------------

/** Check if a line looks like a question or conversational cue (not CoT noise). */
function isHintLine(line: string): boolean {
	if (line.endsWith("?")) return true;
	// Conversational cues: "Tell me about...", "Describe...", etc.
	if (
		/^(tell|describe|explain|show|what|who|where|when|why|how|which|does|did|is|are|can|could|has|have|will|would)/i.test(
			line,
		)
	)
		return true;
	return false;
}

export async function generateHints(
	provider: LlmProvider,
	content: string,
	cfg: PipelineHintsConfig,
): Promise<readonly string[]> {
	const prompt = buildPrompt(content, cfg.max);
	// Use higher token budget to accommodate thinking model overhead
	const raw = await provider.generate(prompt, {
		timeoutMs: cfg.timeout,
		maxTokens: Math.max(cfg.maxTokens, 1024),
	});
	// Strip <think>...</think> blocks (qwen3, deepseek, etc.)
	const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	const lines = stripped
		.split("\n")
		.map((l) =>
			l
				.replace(/^\d+[.)]\s*/, "")
				.replace(/^[-*]\s*/, "")
				.trim(),
		)
		.filter((l) => l.length > 10 && l.length < 300 && isHintLine(l));
	logger.debug("pipeline", "Hints generated", {
		rawLen: raw.length,
		parsed: lines.length,
	});
	return lines;
}

// ---------------------------------------------------------------------------
// Job leasing (same pattern as structural-classify)
// ---------------------------------------------------------------------------

function leaseJob(db: WriteDb, maxAttempts: number): HintJobRow | null {
	const now = new Date().toISOString();
	const epoch = Math.floor(Date.now() / 1000);

	const row = db
		.prepare(
			`SELECT id, memory_id, payload, attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = 'prospective_index'
			   AND status = 'pending'
			   AND attempts < ?
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(maxAttempts, epoch) as HintJobRow | undefined;

	if (!row) return null;

	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'leased', leased_at = ?, attempts = attempts + 1, updated_at = ?
		 WHERE id = ?`,
	).run(now, now, row.id);

	return { ...row, attempts: row.attempts + 1 };
}

function completeJob(db: WriteDb, jobId: string): void {
	const now = new Date().toISOString();
	db.prepare(`UPDATE memory_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(
		now,
		now,
		jobId,
	);
}

function failJob(db: WriteDb, jobId: string, error: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
		     failed_at = ?, updated_at = ?,
		     payload = json_set(COALESCE(payload, '{}'), '$.lastError', ?)
		 WHERE id = ?`,
	).run(now, now, error, jobId);
}

// ---------------------------------------------------------------------------
// Persist hints
// ---------------------------------------------------------------------------

function writeHints(db: WriteDb, memoryId: string, agentId: string, hints: readonly string[]): number {
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	const now = new Date().toISOString();
	let inserted = 0;
	for (const hint of hints) {
		const id = crypto.randomUUID();
		stmt.run(id, memoryId, agentId, hint, now);
		inserted++;
	}
	return inserted;
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export function startHintsWorker(deps: {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
}): HintsWorkerHandle {
	const { accessor, provider, pipelineCfg } = deps;
	const cfg = pipelineCfg.hints;
	if (!cfg || !cfg.enabled) {
		return { stop: async () => {}, running: false };
	}

	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function tick(): Promise<void> {
		if (!running) return;

		let job: HintJobRow | null = null;
		try {
			job = accessor.withWriteTx((db) => leaseJob(db, 3));
			if (!job) {
				schedule();
				return;
			}
			const j = job;

			let payload: HintPayload;
			try {
				payload = JSON.parse(j.payload) as HintPayload;
			} catch {
				accessor.withWriteTx((db) => failJob(db, j.id, "invalid payload"));
				schedule();
				return;
			}

			// Generate hints outside of any db lock
			const hints = await generateHints(provider, payload.content, cfg);

			if (hints.length > 0) {
				accessor.withWriteTx((db) => {
					writeHints(db, payload.memoryId, "default", hints);
					completeJob(db, j.id);
				});
				logger.info("pipeline", "Prospective hints generated", {
					memoryId: payload.memoryId,
					hints: hints.length,
				});
			} else {
				accessor.withWriteTx((db) => completeJob(db, j.id));
				logger.debug("pipeline", "No hints generated (empty LLM response)", {
					memoryId: payload.memoryId,
				});
			}
		} catch (e) {
			if (job) {
				const j = job;
				const msg = e instanceof Error ? e.message : String(e);
				accessor.withWriteTx((db) => failJob(db, j.id, msg));
				logger.warn("pipeline", "Hints worker job failed", {
					jobId: j.id,
					memoryId: j.memory_id,
					error: msg,
					attempt: j.attempts,
				});
			}
			logger.warn("pipeline", "Hints worker tick failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		}

		schedule();
	}

	function schedule(): void {
		if (!running) return;
		timer = setTimeout(tick, cfg.poll);
	}

	// Start
	schedule();

	return {
		async stop() {
			running = false;
			if (timer) clearTimeout(timer);
		},
		get running() {
			return running;
		},
	};
}

// ---------------------------------------------------------------------------
// Job enqueueing (called from extraction worker after memory write)
// ---------------------------------------------------------------------------

export function enqueueHintsJob(db: WriteDb, memoryId: string, content: string): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const payload = JSON.stringify({ memoryId, content } satisfies HintPayload);
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
		 VALUES (?, ?, 'prospective_index', 'pending', ?, 0, 3, ?, ?)`,
	).run(id, memoryId, payload, now, now);
}
