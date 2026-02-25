/**
 * Session summary worker: the "librarian".
 *
 * Polls summary_jobs for pending transcripts, calls the configured
 * LLM to produce a cohesive session summary + atomic facts, writes
 * the summary as a dated markdown file, and inserts facts into the
 * memories table.
 *
 * Runs fully async — session-end hooks queue jobs and return
 * immediately, so users never wait for LLM inference.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { DbAccessor } from "../db-accessor";
import type { LlmProvider } from "./provider";
import { getLlmProvider } from "../llm";
import { isDuplicate, inferType } from "../hooks";
import { loadMemoryConfig } from "../memory-config";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryWorkerHandle {
	stop(): void;
	readonly running: boolean;
}

interface SummaryJobRow {
	readonly id: string;
	readonly session_key: string | null;
	readonly harness: string;
	readonly project: string | null;
	readonly transcript: string;
	readonly attempts: number;
	readonly max_attempts: number;
}

interface LlmSummaryResult {
	readonly summary: string;
	readonly facts: ReadonlyArray<{
		readonly content: string;
		readonly importance?: number;
		readonly tags?: string;
		readonly type?: string;
	}>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const MEMORY_DIR = join(AGENTS_DIR, "memory");

const POLL_INTERVAL_MS = 5_000;
const LLM_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(transcript: string, date: string): string {
	return `You are a session librarian. Summarize this coding session as a dated markdown note and extract key durable facts.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nProse summary...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary guidelines:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Include: what was worked on, key decisions, open threads
- Be concise but complete (200-500 words)
- Write in past tense, third person

Fact extraction guidelines:
- Each fact must be self-contained and understandable without this conversation
- Include the specific subject (package name, file path, tool, component) in every fact
- BAD: "switched to a reactive pattern" → GOOD: "The EmbeddingCanvas2D component switched from polling to a reactive requestRedraw pattern for GPU efficiency"
- Only durable, reusable knowledge (skip ephemeral details)
- Types: fact, preference, decision, learning, rule, issue
- Importance: 0.3 (routine) to 0.5 (significant)
- Max 15 facts

Conversation:
${transcript}`;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
}

function deriveSlug(summary: string, project: string | null): string {
	// Try to extract first ## heading
	const headingMatch = summary.match(/^##\s+(.+)$/m);
	if (headingMatch) return slugify(headingMatch[1]);

	// Fallback to project name
	if (project) {
		const parts = project.split("/");
		return slugify(parts[parts.length - 1]);
	}

	return "session";
}

function uniqueFilename(dir: string, base: string, ext: string): string {
	const first = join(dir, `${base}${ext}`);
	if (!existsSync(first)) return first;

	for (let i = 2; i <= 20; i++) {
		const path = join(dir, `${base}-${i}${ext}`);
		if (!existsSync(path)) return path;
	}

	// Fallback with timestamp
	return join(dir, `${base}-${Date.now()}${ext}`);
}

// ---------------------------------------------------------------------------
// Parse LLM response
// ---------------------------------------------------------------------------

function parseLlmResponse(raw: string): LlmSummaryResult | null {
	let jsonStr = raw.trim();

	// Strip markdown fences
	const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1].trim();
	}

	// Strip <think> blocks (qwen3 CoT)
	jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

	try {
		const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
		if (typeof parsed.summary !== "string") return null;
		if (!Array.isArray(parsed.facts)) return null;

		return {
			summary: parsed.summary,
			facts: parsed.facts.filter(
				(f: unknown): f is LlmSummaryResult["facts"][number] =>
					typeof f === "object" &&
					f !== null &&
					typeof (f as Record<string, unknown>).content === "string",
			),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

async function processJob(
	accessor: DbAccessor,
	provider: LlmProvider,
	job: SummaryJobRow,
): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);

	const prompt = buildPrompt(job.transcript, today);

	const raw = await provider.generate(prompt, {
		timeoutMs: LLM_TIMEOUT_MS,
	});

	const result = parseLlmResponse(raw);
	if (!result) {
		throw new Error("Failed to parse LLM summary response");
	}

	// Write markdown file
	mkdirSync(MEMORY_DIR, { recursive: true });
	const slug = deriveSlug(result.summary, job.project);
	const filename = uniqueFilename(MEMORY_DIR, `${today}-${slug}`, ".md");
	writeFileSync(filename, result.summary, "utf-8");

	logger.info("summary-worker", "Wrote session summary", {
		path: filename,
		sessionKey: job.session_key,
		project: job.project,
		summaryChars: result.summary.length,
		summary: result.summary,
	});

	// Insert atomic facts (same logic as old handleSessionEnd)
	const now = new Date().toISOString();
	const saved = accessor.withWriteTx((db) => {
		let count = 0;
		const stmt = db.prepare(
			`INSERT INTO memories
			 (id, content, type, importance, source_type, who, tags,
			  project, session_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const item of result.facts) {
			if (!item.content || typeof item.content !== "string") continue;

			const importance = Math.min(item.importance ?? 0.3, 0.5);

			if (isDuplicate(db as unknown as Database, item.content)) continue;

			const id = crypto.randomUUID();
			const type = item.type || inferType(item.content);

			stmt.run(
				id,
				item.content,
				type,
				importance,
				"session_end",
				job.harness,
				item.tags || null,
				job.project || null,
				job.session_key || null,
				now,
				now,
			);
			count++;
		}
		return count;
	});

	logger.info("summary-worker", "Inserted session facts", {
		total: result.facts.length,
		saved,
		deduplicated: result.facts.length - saved,
		factsPreview: result.facts
			.slice(0, 10)
			.map((fact) => fact.content),
	});

	// --- Session continuity scoring ---
	try {
		await scoreContinuity(accessor, provider, job, result.summary);
	} catch (e) {
		logger.warn("summary-worker", "Continuity scoring failed (non-fatal)", {
			error: (e as Error).message,
		});
	}
}

// ---------------------------------------------------------------------------
// Continuity scoring
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Injected memory loading for continuity scoring
// ---------------------------------------------------------------------------

interface InjectedMemoryPreview {
	readonly memoryId: string;
	readonly content: string;
	readonly source: string;
	readonly effectiveScore: number;
}

function loadInjectedMemories(
	accessor: DbAccessor,
	sessionKey: string | null,
): ReadonlyArray<InjectedMemoryPreview> {
	if (!sessionKey) return [];

	try {
		return accessor.withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT sm.memory_id, m.content, sm.source, sm.effective_score
					 FROM session_memories sm
					 JOIN memories m ON m.id = sm.memory_id
					 WHERE sm.session_key = ? AND sm.was_injected = 1
					 ORDER BY sm.rank ASC LIMIT 50`,
				)
				.all(sessionKey) as Array<{
				memory_id: string;
				content: string;
				source: string;
				effective_score: number | null;
			}>;

			return rows.map((r) => ({
				memoryId: r.memory_id,
				content: r.content,
				source: r.source,
				effectiveScore: r.effective_score ?? 0,
			}));
		});
	} catch {
		return [];
	}
}

/**
 * Write per-memory relevance scores back to session_memories.
 * Maps LLM's 8-char ID prefixes to full memory IDs.
 */
function writePerMemoryRelevance(
	accessor: DbAccessor,
	sessionKey: string,
	perMemory: ReadonlyArray<{ readonly id: string; readonly relevance: number }>,
	injectedMemories: ReadonlyArray<InjectedMemoryPreview>,
): void {
	if (perMemory.length === 0) return;

	// Build prefix → full ID lookup
	const prefixMap = new Map<string, string>();
	for (const mem of injectedMemories) {
		prefixMap.set(mem.memoryId.slice(0, 8), mem.memoryId);
	}

	try {
		accessor.withWriteTx((db) => {
			const stmt = db.prepare(
				`UPDATE session_memories SET relevance_score = ?
				 WHERE session_key = ? AND memory_id = ?`,
			);

			for (const entry of perMemory) {
				const fullId = prefixMap.get(entry.id);
				if (!fullId) continue;
				const score = Math.max(0, Math.min(1, entry.relevance));
				stmt.run(score, sessionKey, fullId);
			}
		});
	} catch (e) {
		logger.warn("summary-worker", "Failed to write per-memory relevance", {
			error: (e as Error).message,
		});
	}
}

// ---------------------------------------------------------------------------
// Continuity scoring
// ---------------------------------------------------------------------------

function buildContinuityPrompt(
	transcript: string,
	summaryPreview: string,
	injectedMemories: ReadonlyArray<InjectedMemoryPreview>,
): string {
	let memorySection: string;
	if (injectedMemories.length === 0) {
		memorySection = "(no memories were injected for this session)";
	} else {
		const previews = injectedMemories.map((m) => {
			const preview = m.content.length > 120
				? `${m.content.slice(0, 120)}...`
				: m.content;
			return `- [${m.memoryId.slice(0, 8)}] (score=${m.effectiveScore.toFixed(2)}) ${preview}`;
		});
		memorySection = previews.join("\n");
	}

	return `Evaluate how well pre-loaded memories served this coding session.

Consider:
- Were the memories relevant to what was discussed?
- Did the user have to re-explain things that memory should have known?
- Were there gaps where prior context would have helped?

Pre-loaded memories (${injectedMemories.length} total):
${memorySection}

Return ONLY a JSON object (no markdown fences):
{
  "score": 0.0-1.0,
  "confidence": 0.0-1.0,
  "memories_used": <number of pre-loaded memories that were actually relevant>,
  "novel_context_count": <number of times user had to re-explain something>,
  "reasoning": "Brief explanation of the score",
  "per_memory": [{"id": "<8-char prefix>", "relevance": 0.0-1.0}]
}

Score guide: 1.0 = memories perfectly covered all needed context, 0.0 = memories were useless and everything was re-explained.
Confidence: how certain you are in your scoring (1.0 = very confident, 0.0 = basically guessing).
per_memory: rate each injected memory's relevance to the session. Use the 8-char ID prefix shown in brackets above.

Session summary:
${summaryPreview}

Session transcript (last 4000 chars):
${transcript.slice(-4000)}`;
}

interface ContinuityResult {
	readonly score: number;
	readonly confidence: number;
	readonly memories_used: number;
	readonly novel_context_count: number;
	readonly reasoning: string;
	readonly per_memory: ReadonlyArray<{
		readonly id: string;
		readonly relevance: number;
	}>;
}

async function scoreContinuity(
	accessor: DbAccessor,
	provider: LlmProvider,
	job: SummaryJobRow,
	summary: string,
): Promise<void> {
	// Load injected memories for this session (empty array for old sessions)
	const injectedMemories = loadInjectedMemories(accessor, job.session_key);

	const prompt = buildContinuityPrompt(
		job.transcript,
		summary.slice(0, 2000),
		injectedMemories,
	);

	const raw = await provider.generate(prompt, { timeoutMs: LLM_TIMEOUT_MS });

	let jsonStr = raw.trim();
	const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) jsonStr = fenceMatch[1].trim();
	jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonStr) as Record<string, unknown>;
	} catch {
		return; // Invalid JSON from LLM, skip scoring
	}
	if (typeof parsed.score !== "number") return;

	const perMemoryRaw = Array.isArray(parsed.per_memory) ? parsed.per_memory : [];
	const perMemory = perMemoryRaw
		.filter(
			(e: unknown): e is { id: string; relevance: number } =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as Record<string, unknown>).id === "string" &&
				typeof (e as Record<string, unknown>).relevance === "number",
		)
		.map((e) => ({ id: e.id, relevance: e.relevance }));

	const result: ContinuityResult = {
		score: Math.max(0, Math.min(1, parsed.score)),
		confidence: typeof parsed.confidence === "number"
			? Math.max(0, Math.min(1, parsed.confidence))
			: 0,
		memories_used: typeof parsed.memories_used === "number" ? parsed.memories_used : 0,
		novel_context_count: typeof parsed.novel_context_count === "number" ? parsed.novel_context_count : 0,
		reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
		per_memory: perMemory,
	};

	// Write per-memory relevance scores back to session_memories
	if (job.session_key && result.per_memory.length > 0) {
		writePerMemoryRelevance(
			accessor,
			job.session_key,
			result.per_memory,
			injectedMemories,
		);
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_scores
			 (id, session_key, project, harness, score, memories_recalled,
			  memories_used, novel_context_count, reasoning,
			  confidence, continuity_reasoning, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			job.session_key || "unknown",
			job.project || null,
			job.harness,
			result.score,
			injectedMemories.length,
			result.memories_used,
			result.novel_context_count,
			result.reasoning,
			result.confidence,
			result.reasoning, // full reasoning for audit trail
			now,
		);
	});

	logger.info("summary-worker", "Session continuity scored", {
		score: result.score,
		confidence: result.confidence,
		memoriesRecalled: injectedMemories.length,
		memoriesUsed: result.memories_used,
		novelContext: result.novel_context_count,
		perMemoryScores: result.per_memory.length,
		sessionKey: job.session_key,
		project: job.project,
	});
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export function startSummaryWorker(
	accessor: DbAccessor,
): SummaryWorkerHandle {
	const provider = getLlmProvider();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	async function tick(): Promise<void> {
		if (stopped) return;

		// Re-check config each tick — respect runtime config changes
		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (!cfg.pipelineV2.enabled && !cfg.pipelineV2.shadowMode) {
			scheduleTick(POLL_INTERVAL_MS);
			return;
		}

		let jobId: string | null = null;

		try {
			// Lease a pending job
			const job = accessor.withWriteTx((db) => {
				const row = db
					.prepare(
						`SELECT id, session_key, harness, project, transcript,
						        attempts, max_attempts
						 FROM summary_jobs
						 WHERE status = 'pending' AND attempts < max_attempts
						 ORDER BY created_at ASC
						 LIMIT 1`,
					)
					.get() as SummaryJobRow | undefined;

				if (!row) return null;

				db.prepare(
					`UPDATE summary_jobs
					 SET status = 'processing', attempts = attempts + 1
					 WHERE id = ?`,
				).run(row.id);

				return { ...row, attempts: row.attempts + 1 };
			});

			if (!job) {
				scheduleTick(POLL_INTERVAL_MS);
				return;
			}

			jobId = job.id;

			logger.info("summary-worker", "Processing session summary", {
				jobId: job.id,
				harness: job.harness,
				attempt: job.attempts,
				sessionKey: job.session_key,
				project: job.project,
			});

			await processJob(accessor, provider, job);

			// Mark complete
			accessor.withWriteTx((db) => {
				db.prepare(
					`UPDATE summary_jobs
					 SET status = 'completed',
					     completed_at = ?,
					     result = 'ok'
					 WHERE id = ?`,
				).run(new Date().toISOString(), job.id);
			});

			// Check for more jobs immediately
			scheduleTick(500);
		} catch (e) {
			const err = e as Error;
			logger.error("summary-worker", "Job failed", err);

			// Try to mark the job as failed/pending for retry
			try {
				if (jobId) {
					accessor.withWriteTx((db) => {
						const row = db
							.prepare(
								"SELECT attempts, max_attempts FROM summary_jobs WHERE id = ?",
							)
							.get(jobId) as
							| { attempts: number; max_attempts: number }
							| undefined;

						if (!row) return;

						const status =
							row.attempts >= row.max_attempts ? "dead" : "pending";

						db.prepare(
							`UPDATE summary_jobs
							 SET status = ?, error = ?
							 WHERE id = ? AND status = 'processing'`,
						).run(status, err.message, jobId);
					});
				}
			} catch {
				// DB error during error handling — just log and move on
			}

			// Back off after failure
			scheduleTick(POLL_INTERVAL_MS * 3);
		}
	}

	function scheduleTick(delay: number): void {
		if (stopped) return;
		timer = setTimeout(() => {
			tick().catch((err) => {
				logger.error("summary-worker", "Unhandled tick error", err as Error);
			});
		}, delay);
	}

	// Start polling
	scheduleTick(POLL_INTERVAL_MS);

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
		get running() {
			return !stopped;
		},
	};
}

// ---------------------------------------------------------------------------
// Job enqueue helper (called from hooks.ts)
// ---------------------------------------------------------------------------

export function enqueueSummaryJob(
	accessor: DbAccessor,
	params: {
		readonly harness: string;
		readonly transcript: string;
		readonly sessionKey?: string;
		readonly project?: string;
	},
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
		).run(
			id,
			params.sessionKey || null,
			params.harness,
			params.project || null,
			params.transcript,
			now,
		);
	});

	logger.info("summary-worker", "Enqueued session summary job", {
		jobId: id,
		harness: params.harness,
		sessionKey: params.sessionKey,
		project: params.project,
		transcriptChars: params.transcript.length,
		transcript: params.transcript,
	});

	return id;
}
