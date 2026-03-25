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

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { countChanges } from "../db-helpers";
import { inferType, isDuplicate } from "../hooks";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { getSecret } from "../secrets";
import {
	createAnthropicProvider,
	createClaudeCodeProvider,
	createOllamaProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	resolveDefaultOllamaFallbackMaxContextTokens,
} from "./provider";
import { type SignificanceConfig, assessSignificance } from "./significance-gate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryWorkerHandle {
	stop(): void;
	readonly running: boolean;
}

const RECOVER_BATCH = 100;
const RECOVER_LIMIT_MAX = 1000;

interface SummaryRecoveryBatch {
	readonly selected: number;
	readonly updated: number;
}

interface SummaryJobRow {
	readonly id: string;
	readonly session_key: string | null;
	readonly harness: string;
	readonly project: string | null;
	readonly transcript: string;
	readonly attempts: number;
	readonly max_attempts: number;
	readonly created_at: string;
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

export const SUMMARY_WORKER_UPDATED_BY = "summary-worker";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const MEMORY_DIR = join(AGENTS_DIR, "memory");

const POLL_INTERVAL_MS = 5_000;
// Timeout is now configured per-provider via resolveProvider() and config.

// Transcripts longer than this are split into chunks, each summarized
// independently, then combined into a unified summary. 20k chars is
// roughly 5k tokens — safe for even small context windows.
const CHUNK_TARGET_CHARS = 20_000;

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

function buildChunkPrompt(chunk: string, index: number, total: number, date: string): string {
	return `You are a session librarian. This is chunk ${index + 1} of ${total} from a long coding session on ${date}. Summarize this segment and extract key facts.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "Prose summary of this segment (100-300 words)...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary guidelines:
- Summarize what was discussed/worked on in this segment
- Be concise but capture key decisions and context
- Write in past tense, third person

Fact extraction guidelines:
- Each fact must be self-contained and understandable without this conversation
- Include the specific subject (package name, file path, tool, component) in every fact
- Only durable, reusable knowledge (skip ephemeral details)
- Types: fact, preference, decision, learning, rule, issue
- Importance: 0.3 (routine) to 0.5 (significant)
- Max 10 facts per chunk

Conversation segment:
${chunk}`;
}

function buildCombinePrompt(
	summaries: readonly string[],
	allFacts: ReadonlyArray<LlmSummaryResult["facts"][number]>,
	date: string,
): string {
	const factsPreview = allFacts
		.slice(0, 30)
		.map((f) => `- ${f.content}`)
		.join("\n");

	return `You are a session librarian. Below are summaries of ${summaries.length} consecutive segments from one coding session on ${date}, plus extracted facts. Produce a unified session summary and deduplicated fact list.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nProse summary...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary guidelines:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Merge overlapping content from segments — don't repeat
- Include: what was worked on, key decisions, open threads
- Be concise but complete (200-500 words)
- Write in past tense, third person

Fact guidelines:
- Deduplicate facts that say the same thing in different words
- Keep the most specific version of each fact
- Max 15 facts total
- Importance: 0.3 (routine) to 0.5 (significant)

Segment summaries:
${summaries.map((s, i) => `--- Segment ${i + 1} ---\n${s}`).join("\n\n")}

Extracted facts from all segments:
${factsPreview}`;
}

// Split transcript into chunks on turn boundaries (User:/Assistant: lines).
// Avoids splitting mid-turn so each chunk is a coherent conversation segment.
// Hard cap at 3x target prevents a single giant turn from blowing context.
function chunkTranscript(transcript: string, target: number): string[] {
	const hardCap = target * 3;
	const lines = transcript.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let chars = 0;

	for (const line of lines) {
		// Oversized single line — flush current, then split the line itself
		if (line.length + 1 >= hardCap) {
			if (current.length > 0) {
				chunks.push(current.join("\n"));
				current = [];
				chars = 0;
			}
			for (let i = 0; i < line.length; i += hardCap) {
				chunks.push(line.slice(i, i + hardCap));
			}
			continue;
		}

		const isNewTurn = /^(User|Assistant):\s/.test(line);
		if (current.length > 0 && ((isNewTurn && chars >= target) || chars >= hardCap)) {
			chunks.push(current.join("\n"));
			current = [];
			chars = 0;
		}
		current.push(line);
		chars += line.length + 1;
	}

	if (current.length > 0) {
		chunks.push(current.join("\n"));
	}

	return chunks;
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
					typeof f === "object" && f !== null && typeof (f as Record<string, unknown>).content === "string",
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
	memoryCfg: ReturnType<typeof loadMemoryConfig>,
): Promise<void> {
	// --- Significance gate ---
	const significanceCfg: SignificanceConfig = memoryCfg.pipelineV2.significance ?? {
		enabled: true,
		minTurns: 5,
		minEntityOverlap: 1,
		noveltyThreshold: 0.15,
	};

	if (significanceCfg.enabled) {
		const assessment = accessor.withReadDb((db) => assessSignificance(job.transcript, db, "default", significanceCfg));

		if (!assessment.significant) {
			logger.info("summary-worker", "Session below significance threshold — skipping extraction", {
				sessionKey: job.session_key,
				project: job.project,
				scores: assessment.scores,
				reason: assessment.reason,
			});
			// Job row and transcript are preserved (lossless retention).
			// processJob caller marks it completed.
			return;
		}
	}

	const today = new Date().toISOString().slice(0, 10);
	const genOpts = {
		timeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
		maxTokens: memoryCfg.pipelineV2.synthesis.maxTokens,
	};

	const result =
		job.transcript.length > CHUNK_TARGET_CHARS
			? await processChunked(provider, job.transcript, today, genOpts)
			: await processSingle(provider, job.transcript, today, genOpts);

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
	});

	const saved = insertSummaryFacts(accessor, job, result.facts);

	logger.info("summary-worker", "Inserted session facts", {
		total: result.facts.length,
		saved,
		deduplicated: result.facts.length - saved,
		factsPreview: result.facts.slice(0, 10).map((fact) => fact.content),
	});

	// Lossless retention: preserve raw transcript alongside extracted facts
	try {
		accessor.withWriteTx((db) => {
			db.prepare(`
				INSERT OR IGNORE INTO session_transcripts
					(session_key, content, harness, project, agent_id, created_at)
				VALUES (?, ?, ?, ?, 'default', ?)
			`).run(job.session_key, job.transcript, job.harness, job.project, today);
		});
	} catch {
		// Non-fatal — table may not exist if migration hasn't run
	}

	// Agent ID is hardcoded because summary_jobs and session_scores tables
	// lack an agent_id column (pre-existing schema limitation). In a
	// multi-agent deployment, all predictor comparisons route to the
	// "default" bucket. Adding agent_id to these tables requires a schema
	// migration and is tracked as future work.
	const agentId = "default";

	// Write to session_summaries DAG (depth 0 = session level)
	try {
		writeSummaryToDAG(accessor, job, result, agentId);
	} catch (e) {
		logger.warn("summary-worker", "Failed to write session summary to DAG (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	// --- Session continuity scoring ---
	try {
		await scoreContinuity(accessor, provider, job, result.summary, memoryCfg);
	} catch (e) {
		logger.warn("summary-worker", "Continuity scoring failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	// --- Predictor comparison (Sprint 3) ---
	// Runs after continuity scoring has written per-memory relevance scores
	// and session_scores. Uses dynamic imports to avoid circular deps.
	// memoryCfg already loaded at function entry (significance gate).
	try {
		if (memoryCfg.pipelineV2.predictor?.enabled && job.session_key) {
			const { runSessionComparison, saveComparison, updateSuccessRate, shouldTriggerTraining, detectDrift } =
				await import("../predictor-comparison");
			const comparison = runSessionComparison(job.session_key, agentId, accessor);

			if (comparison !== null) {
				saveComparison(comparison, agentId, accessor);
				// Only update EMA when the predictor actually produced scores —
				// otherwise predictorWon is deterministically false and the EMA
				// accrues phantom losses during cold start or sidecar downtime.
				if (comparison.hasPredictorScores) {
					updateSuccessRate(agentId, comparison.predictorWon, comparison.scorerConfidence);
				}

				// Drift detection
				const driftResult = detectDrift(agentId, accessor, memoryCfg.pipelineV2.predictor.driftResetWindow ?? 20);
				if (driftResult.drifting) {
					logger.warn("predictor", "Drift detected — resetting predictor state", {
						recentWinRate: driftResult.recentWinRate,
						windowSize: driftResult.windowSize,
						agentId,
					});

					// Reset alpha to 1.0 (full baseline weight) and EMA to neutral
					const { updatePredictorState: resetState } = await import("../predictor-state");
					resetState(agentId, {
						alpha: 1.0,
						successRate: 0.5,
					});

					// Trigger retraining (non-fatal if it fails)
					try {
						const { getPredictorClient } = await import("../daemon");
						const predictorClient = getPredictorClient();
						if (predictorClient) {
							const dbPath = join(AGENTS_DIR, "memory", "memories.db");
							await predictorClient.trainFromDb({ db_path: dbPath });
							logger.info("predictor", "Drift-triggered retraining complete");
						}
					} catch (trainErr) {
						logger.warn("predictor", "Drift-triggered retraining failed", {
							error: trainErr instanceof Error ? trainErr.message : String(trainErr),
						});
					}
				}

				// Check training trigger
				if (shouldTriggerTraining(agentId, memoryCfg.pipelineV2.predictor, accessor)) {
					try {
						const { getPredictorClient } = await import("../daemon");
						const predictorClient = getPredictorClient();
						if (predictorClient) {
							const dbPath = join(AGENTS_DIR, "memory", "memories.db");
							await predictorClient.trainFromDb({ db_path: dbPath });

							const { updatePredictorState } = await import("../predictor-state");
							updatePredictorState(agentId, { lastTrainingAt: new Date().toISOString() });

							logger.info("predictor", "Training triggered after session comparison");
						}
					} catch (trainErr) {
						logger.warn("predictor", "Training trigger failed (non-fatal)", {
							error: trainErr instanceof Error ? trainErr.message : String(trainErr),
						});
					}
				}
			}
		}
	} catch (err) {
		logger.warn("predictor", "Session comparison failed (non-fatal)", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// --- Training pair collection for predictor federated learning ---
	if (job.session_key) {
		try {
			if (memoryCfg.pipelineV2.predictorPipeline.trainingTelemetry) {
				const { collectTrainingPairs, saveTrainingPairs } = await import("../predictor-training-pairs");
				const pairs = collectTrainingPairs(accessor, job.session_key, agentId);
				if (pairs.length > 0) {
					saveTrainingPairs(accessor, agentId, job.session_key, pairs);
				}
			}
		} catch (e) {
			logger.warn("summary-worker", "Training pair collection failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Single vs chunked summarization
// ---------------------------------------------------------------------------

interface GenerateOpts {
	readonly timeoutMs: number;
	readonly maxTokens: number;
}

async function processSingle(
	provider: LlmProvider,
	transcript: string,
	date: string,
	opts: GenerateOpts,
): Promise<LlmSummaryResult | null> {
	const raw = await provider.generate(buildPrompt(transcript, date), opts);
	return parseLlmResponse(raw);
}

async function processChunked(
	provider: LlmProvider,
	transcript: string,
	date: string,
	opts: GenerateOpts,
): Promise<LlmSummaryResult | null> {
	const chunks = chunkTranscript(transcript, CHUNK_TARGET_CHARS);

	logger.info("summary-worker", "Long transcript — chunked summarization", {
		transcriptChars: transcript.length,
		chunks: chunks.length,
		chunkSizes: chunks.map((c) => c.length),
	});

	// Map: summarize each chunk sequentially to avoid RAM spikes
	const chunkSummaries: string[] = [];
	const allFacts: LlmSummaryResult["facts"][number][] = [];

	for (let i = 0; i < chunks.length; i++) {
		const prompt = buildChunkPrompt(chunks[i], i, chunks.length, date);
		const raw = await provider.generate(prompt, opts);
		const partial = parseLlmResponse(raw);

		if (partial) {
			chunkSummaries.push(partial.summary);
			allFacts.push(...partial.facts);
		} else {
			logger.warn("summary-worker", "Chunk summarization failed, skipping", {
				chunk: i + 1,
				total: chunks.length,
			});
		}
	}

	if (chunkSummaries.length === 0) return null;

	// Single chunk — prepend standard header directly instead of
	// re-processing through an LLM call
	if (chunkSummaries.length === 1) {
		return {
			summary: `# ${date} Session Notes\n\n${chunkSummaries[0]}`,
			facts: allFacts,
		};
	}

	// Reduce: combine chunk summaries into unified result
	const combinePrompt = buildCombinePrompt(chunkSummaries, allFacts, date);
	const combineRaw = await provider.generate(combinePrompt, opts);
	const combined = parseLlmResponse(combineRaw);

	if (combined) return combined;

	// Combine failed — join all summaries as degraded fallback
	logger.warn("summary-worker", "Combine step failed, joining chunks as fallback", {
		chunks: chunkSummaries.length,
		facts: allFacts.length,
	});
	return { summary: chunkSummaries.join("\n\n---\n\n"), facts: allFacts };
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

function loadInjectedMemories(accessor: DbAccessor, sessionKey: string | null): ReadonlyArray<InjectedMemoryPreview> {
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
			error: e instanceof Error ? e.message : String(e),
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
			const preview = m.content.length > 120 ? `${m.content.slice(0, 120)}...` : m.content;
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
	memoryCfg: ReturnType<typeof loadMemoryConfig>,
): Promise<void> {
	// Load injected memories for this session (empty array for old sessions)
	const injectedMemories = loadInjectedMemories(accessor, job.session_key);

	const prompt = buildContinuityPrompt(job.transcript, summary.slice(0, 2000), injectedMemories);

	const raw = await provider.generate(prompt, {
		timeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
		maxTokens: memoryCfg.pipelineV2.synthesis.maxTokens,
	});

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
		confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
		memories_used: typeof parsed.memories_used === "number" ? parsed.memories_used : 0,
		novel_context_count: typeof parsed.novel_context_count === "number" ? parsed.novel_context_count : 0,
		reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
		per_memory: perMemory,
	};

	// Write per-memory relevance scores back to session_memories
	if (job.session_key && result.per_memory.length > 0) {
		writePerMemoryRelevance(accessor, job.session_key, result.per_memory, injectedMemories);
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

export function insertSummaryFacts(
	accessor: DbAccessor,
	job: Pick<SummaryJobRow, "harness" | "project" | "session_key">,
	facts: ReadonlyArray<LlmSummaryResult["facts"][number]>,
): number {
	const now = new Date().toISOString();

	return accessor.withWriteTx((db) => {
		let count = 0;
		const stmt = db.prepare(
			`INSERT INTO memories
			 (id, content, type, importance, source_id, source_type, who, tags,
			  project, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const item of facts) {
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
				job.session_key || null,
				"session_end",
				job.harness,
				item.tags || null,
				job.project || null,
				now,
				now,
				SUMMARY_WORKER_UPDATED_BY,
			);
			count++;
		}
		return count;
	});
}

// ---------------------------------------------------------------------------
// DAG write helper
// ---------------------------------------------------------------------------

function writeSummaryToDAG(accessor: DbAccessor, job: SummaryJobRow, result: LlmSummaryResult, agentId: string): void {
	accessor.withWriteTx((db) => {
		// Check if table exists (migration may not have run)
		const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get();
		if (!row) return;

		const now = new Date().toISOString();
		const tokenCount = Math.ceil(result.summary.length / 4);

		// Upsert: check for existing row first since ON CONFLICT doesn't
		// work with the partial unique index (WHERE session_key IS NOT NULL).
		const existing = job.session_key
			? (db
					.prepare(
						`SELECT id FROM session_summaries
				 WHERE session_key = ? AND depth = 0`,
					)
					.get(job.session_key) as { id: string } | undefined)
			: undefined;

		let effectiveId: string;

		if (existing) {
			effectiveId = existing.id;
			db.prepare(
				`UPDATE session_summaries
				 SET content = ?, token_count = ?, latest_at = ?
				 WHERE id = ?`,
			).run(result.summary, tokenCount, now, existing.id);
		} else {
			effectiveId = crypto.randomUUID();
			db.prepare(
				`INSERT INTO session_summaries (
					id, project, depth, kind, content, token_count,
					earliest_at, latest_at, session_key, harness,
					agent_id, created_at
				) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				effectiveId,
				job.project,
				result.summary,
				tokenCount,
				job.created_at,
				now,
				job.session_key,
				job.harness,
				agentId,
				now,
			);
		}

		// Link extracted memories to this summary.
		// Match by source_id containing the session key.
		if (job.session_key) {
			const recentMemories = db
				.prepare(
					`SELECT id FROM memories
					 WHERE source_id = ?
					   AND is_deleted = 0
					 ORDER BY created_at DESC
					 LIMIT 50`,
				)
				.all(job.session_key) as Array<{ id: string }>;

			const linkStmt = db.prepare(
				`INSERT OR IGNORE INTO session_summary_memories (summary_id, memory_id)
				 VALUES (?, ?)`,
			);
			for (const mem of recentMemories) {
				linkStmt.run(effectiveId, mem.id);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

/** Resolve from synthesis config — distinct from extraction so users can
 *  decouple the summary provider/model/timeout from the extraction pipeline. */
export function recoverSummaryJobs(accessor: DbAccessor, limit: number = RECOVER_BATCH): SummaryRecoveryBatch {
	return accessor.withWriteTx((db) => {
		const take = Number.isFinite(limit) ? Math.max(1, Math.min(RECOVER_LIMIT_MAX, Math.trunc(limit))) : RECOVER_BATCH;
		const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'summary_jobs'").get() as
			| { name: string }
			| undefined;
		if (!table) {
			return { selected: 0, updated: 0 };
		}

		const rows = db
			.prepare(
				`SELECT id, attempts, max_attempts
				 FROM summary_jobs
				 WHERE status IN ('processing', 'leased')
				 ORDER BY created_at ASC
				 LIMIT ?`,
			)
			.all(take) as Array<{
			id: string;
			attempts: number;
			max_attempts: number;
		}>;

		if (rows.length === 0) {
			return { selected: 0, updated: 0 };
		}

		const update = db.prepare(
			`UPDATE summary_jobs
			 SET status = ?
			 WHERE id = ? AND status IN ('processing', 'leased')`,
		);

		let updated = 0;
		for (const row of rows) {
			const status = row.attempts >= row.max_attempts ? "dead" : "pending";
			updated += countChanges(update.run(status, row.id));
		}

		return { selected: rows.length, updated };
	});
}

async function resolveProvider(cfg: ReturnType<typeof loadMemoryConfig>): Promise<LlmProvider> {
	const p = cfg.pipelineV2.synthesis.provider;
	const model = cfg.pipelineV2.synthesis.model;
	const timeout = cfg.pipelineV2.synthesis.timeout;
	const endpoint = cfg.pipelineV2.synthesis.endpoint;
	const ollamaFallbackMaxContextTokens = resolveDefaultOllamaFallbackMaxContextTokens();
	switch (p) {
		case "none":
			throw new Error("Summary worker requires an LLM provider but synthesis.provider is 'none'");
		case "anthropic": {
			let apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				try {
					apiKey = (await getSecret("ANTHROPIC_API_KEY")) ?? undefined;
				} catch {
					// secrets store unavailable
				}
			}
			if (!apiKey) {
				logger.error(
					"summary-worker",
					"ANTHROPIC_API_KEY not found for summary worker — falling back to ollama. Set via env or `signet secrets set ANTHROPIC_API_KEY`",
				);
				return createOllamaProvider({
					defaultTimeoutMs: timeout,
					maxContextTokens: ollamaFallbackMaxContextTokens,
				});
			}
			return createAnthropicProvider({ model: model || "haiku", apiKey, defaultTimeoutMs: timeout });
		}
		case "openrouter": {
			let apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey) {
				try {
					apiKey = (await getSecret("OPENROUTER_API_KEY")) ?? undefined;
				} catch {
					// secrets store unavailable
				}
			}
			if (!apiKey) {
				logger.error(
					"summary-worker",
					"OPENROUTER_API_KEY not found for summary worker — falling back to ollama. Set via env or `signet secrets set OPENROUTER_API_KEY`",
				);
				return createOllamaProvider({
					defaultTimeoutMs: timeout,
					maxContextTokens: ollamaFallbackMaxContextTokens,
				});
			}
			return createOpenRouterProvider({
				model: model || "openai/gpt-4o-mini",
				apiKey,
				baseUrl: endpoint ?? "https://openrouter.ai/api/v1",
				referer: process.env.OPENROUTER_HTTP_REFERER,
				title: process.env.OPENROUTER_TITLE,
				defaultTimeoutMs: timeout,
			});
		}
		case "claude-code":
			return createClaudeCodeProvider({ model: model || "haiku", defaultTimeoutMs: timeout });
		case "opencode":
			return createOpenCodeProvider({
				model: model || "anthropic/claude-haiku-4-5-20251001",
				baseUrl: endpoint ?? "http://127.0.0.1:4096",
				ollamaFallbackBaseUrl: "http://127.0.0.1:11434",
				ollamaFallbackMaxContextTokens,
				defaultTimeoutMs: timeout,
			});
		default:
			// Intentionally omit maxContextTokens here. When Ollama is explicitly
			// configured (not fallback), users control context via model config.
			return createOllamaProvider({
				...(typeof model === "string" && model.trim().length > 0 ? { model } : {}),
				...(endpoint ? { baseUrl: endpoint } : {}),
				defaultTimeoutMs: timeout,
			});
	}
}

export function startSummaryWorker(accessor: DbAccessor): SummaryWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let recoverTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	// Cache the LLM provider to avoid per-job getSecret calls.
	// Re-resolve when config changes or after a TTL expires (so a
	// newly added API key gets picked up without a restart).
	let cachedProvider: LlmProvider | null = null;
	let cachedProviderKey = "";
	let cachedProviderAt = 0;
	const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	async function tick(): Promise<void> {
		if (stopped) return;

		// Re-check config each tick — respect runtime config changes
		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (!cfg.pipelineV2.enabled || cfg.pipelineV2.shadowMode) {
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
						        attempts, max_attempts, created_at
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

			// Cache provider across jobs — re-resolve on config change, env
			// key rotation, or TTL expiry. Env-var key changes invalidate
			// immediately; secrets-store-only rotations rely on the 5-min TTL.
			const envKey = process.env.ANTHROPIC_API_KEY ?? "";
			const keyFingerprint = envKey ? new Bun.CryptoHasher("sha256").update(envKey).digest("hex").slice(0, 8) : "";
			const providerKey = `${cfg.pipelineV2.synthesis.provider}:${cfg.pipelineV2.synthesis.model}:${cfg.pipelineV2.synthesis.timeout}:${keyFingerprint}`;
			const cacheExpired = Date.now() - cachedProviderAt > PROVIDER_CACHE_TTL_MS;
			if (!cachedProvider || providerKey !== cachedProviderKey || cacheExpired) {
				cachedProvider = await resolveProvider(cfg);
				cachedProviderKey = providerKey;
				cachedProviderAt = Date.now();
			}
			await processJob(accessor, cachedProvider, job, cfg);

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
			const errorMessage = e instanceof Error ? e.message : String(e);
			logger.error("summary-worker", "Job failed", e instanceof Error ? e : undefined, { error: errorMessage });

			// Try to mark the job as failed/pending for retry
			try {
				if (jobId) {
					accessor.withWriteTx((db) => {
						const row = db.prepare("SELECT attempts, max_attempts FROM summary_jobs WHERE id = ?").get(jobId) as
							| { attempts: number; max_attempts: number }
							| undefined;

						if (!row) return;

						const status = row.attempts >= row.max_attempts ? "dead" : "pending";

						db.prepare(
							`UPDATE summary_jobs
							 SET status = ?, error = ?
							 WHERE id = ? AND status = 'processing'`,
						).run(status, errorMessage, jobId);
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
				logger.error("summary-worker", "Unhandled tick error", err instanceof Error ? err : undefined, {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, delay);
	}

	function scheduleRecovery(delay: number): void {
		if (stopped) return;
		recoverTimer = setTimeout(() => {
			try {
				const batch = recoverSummaryJobs(accessor);
				if (batch.updated > 0) {
					logger.info("summary-worker", `Crash recovery: reset ${batch.updated} stuck job(s) to pending/dead`);
				}
				if (batch.selected >= RECOVER_BATCH) {
					scheduleRecovery(0);
				}
			} catch (e) {
				logger.warn("summary-worker", "Crash recovery failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}, delay);
	}

	// Crash recovery runs in small async batches so daemon startup and HTTP
	// readiness are not blocked by large summary_jobs tables.
	scheduleRecovery(0);

	// Start polling
	scheduleTick(POLL_INTERVAL_MS);

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			if (recoverTimer) clearTimeout(recoverTimer);
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
		).run(id, params.sessionKey || null, params.harness, params.project || null, params.transcript, now);
	});

	logger.info("summary-worker", "Enqueued session summary job", {
		jobId: id,
		harness: params.harness,
		sessionKey: params.sessionKey,
		project: params.project,
		transcriptChars: params.transcript.length,
	});

	return id;
}
