/**
 * Session summary worker: the "librarian".
 *
 * Polls summary_jobs for pending transcripts, calls the configured
 * LLM to produce a cohesive session summary and stores it as immutable
 * episodic lineage for continuity, temporal recall, and Dreaming.
 *
 * Runs fully async — session-end hooks queue jobs and return
 * immediately, so users never wait for LLM inference.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { resolveDefaultBasePath } from "@signet/core";
import type { DbAccessor, WriteDb } from "../db-accessor";
import { countChanges } from "../db-helpers";
import { getInferenceProviderOrNull } from "../llm";
import { logger } from "../logger";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "../memory-config";
import {
	IMMUTABLE_ARTIFACT_ERROR_PREFIX,
	ensureCanonicalManifest,
	updateManifest,
	writeSummaryArtifact,
} from "../memory-lineage";
import { recordPathFeedback } from "../path-feedback";
import { isNoiseSession } from "../session-noise";
import { upsertSessionTranscript } from "../session-transcripts";
import { isSystemPressureHigh } from "../system-pressure";
import { upsertThreadHead } from "../thread-heads";
import { isDurableBoundary, normalizeBoundaryReason } from "./boundary-reason";
import { RateLimitExceededError } from "./provider";
import { type SignificanceConfig, assessSignificance } from "./significance-gate";
import { countTokens } from "./tokenizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryWorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

export interface SummaryWorkerOptions {
	/** Must perform a live route check. Omitted means synthesis is unavailable. */
	readonly isSynthesisAvailable?: () => Promise<boolean>;
}

export function canProcessSummaryJobs(synthesisAvailable: boolean, paused = false): boolean {
	return !paused && synthesisAvailable;
}

const RECOVER_BATCH = 100;
const RECOVER_LIMIT_MAX = 1000;

interface SummaryRecoveryBatch {
	readonly selected: number;
	readonly updated: number;
}

export interface SummaryJobRow {
	readonly id: string;
	readonly session_key: string | null;
	readonly session_id: string | null;
	readonly harness: string;
	readonly project: string | null;
	readonly agent_id: string;
	readonly transcript: string;
	readonly trigger: string;
	readonly boundary_reason: string | null;
	readonly captured_at: string | null;
	readonly started_at: string | null;
	readonly ended_at: string | null;
	readonly attempts: number;
	readonly max_attempts: number;
	readonly created_at: string;
}

interface LlmSummaryResult {
	readonly summary: string;
	readonly leaves?: ReadonlyArray<string>;
}

export const SUMMARY_WORKER_UPDATED_BY = "summary-worker";

export function resolveSummaryHeadingDate(job: Pick<SummaryJobRow, "ended_at" | "captured_at" | "created_at">): string {
	const basis = job.ended_at ?? job.captured_at ?? job.created_at;
	return basis.slice(0, 10);
}

export function isTerminalSummaryJobError(input: string | Error): boolean {
	const message = typeof input === "string" ? input : input.message;
	return message.startsWith(IMMUTABLE_ARTIFACT_ERROR_PREFIX) || input instanceof RateLimitExceededError;
}

export function resolveFailedSummaryJobStatus(
	terminal: boolean,
	attempts: number,
	maxAttempts: number,
): "dead" | "pending" {
	return terminal || attempts >= maxAttempts ? "dead" : "pending";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = resolveDefaultBasePath();
const POLL_INTERVAL_MS = 5_000;

// Cached schema probe: true when summary_jobs has the new-schema columns
// (session_id, agent_id, trigger, etc.).  Resolved lazily on the first
// enqueueSummaryJob call so the DB is guaranteed to be open.
let hasNewSchemaColumns: boolean | null = null;

function probeNewSchemaColumns(accessor: DbAccessor): boolean {
	if (hasNewSchemaColumns !== null) return hasNewSchemaColumns;
	try {
		hasNewSchemaColumns = accessor.withReadDb((db) => {
			const cols = db.prepare("PRAGMA table_info(summary_jobs)").all() as ReadonlyArray<Record<string, unknown>>;
			return cols.some((col) => col.name === "session_id");
		});
	} catch {
		hasNewSchemaColumns = false;
	}
	return hasNewSchemaColumns;
}

/** @internal Test-only: reset the cached schema probe so the next call re-checks. */
export function _resetSummarySchemaCache(): void {
	hasNewSchemaColumns = null;
}
// Timeout is now configured per-provider via resolveProvider() and config.

// Transcripts longer than this are split into chunks, each summarized
// independently, then combined into a unified summary. 20k chars is
// roughly 5k tokens — safe for even small context windows.
const CHUNK_TARGET_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(transcript: string, date: string): string {
	return `You are reviewing a cleaned transcript from one coding session. The transcript already contains only the human/agent conversation turns, with tool calls, tool outputs, and thinking removed.

Use judgment. Focus on what actually mattered.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nFree-form session note..."
}

Summary:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Cover what was worked on, key decisions, unresolved threads, and anything likely to matter later
- Prefer concrete names, files, systems, or people when they matter
- Write in past tense, third person

Conversation:
${transcript}`;
}

function buildChunkPrompt(chunk: string, index: number, total: number, date: string): string {
	return `You are reviewing chunk ${index + 1} of ${total} from one cleaned coding-session transcript on ${date}. Tool calls, tool outputs, and thinking have already been removed.

Use judgment. Focus on what mattered in this segment.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "Free-form summary of this segment..."
}

Summary:
- Summarize what was discussed or worked on in this segment
- Capture decisions, important context, and unresolved threads
- Write in past tense, third person

Conversation segment:
${chunk}`;
}

function buildCombinePrompt(summaries: readonly string[], date: string): string {
	return `You are combining ${summaries.length} segment summaries from one cleaned coding-session transcript on ${date}. Produce one coherent session note.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nFree-form session note..."
}

Summary:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Merge overlapping content from segments without repeating yourself
- Keep the note coherent, concrete, and useful for future continuity
- Write in past tense, third person

Segment summaries:
${summaries.map((s, i) => `--- Segment ${i + 1} ---\n${s}`).join("\n\n")}`;
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
		return { summary: parsed.summary };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

function passesSignificanceGate(accessor: DbAccessor, job: SummaryJobRow, memoryCfg: ResolvedMemoryConfig): boolean {
	const significanceCfg: SignificanceConfig = memoryCfg.pipelineV2.significance ?? {
		enabled: true,
		minTurns: 5,
		minEntityOverlap: 1,
		noveltyThreshold: 0.15,
	};
	if (!significanceCfg.enabled) return true;

	const assessment = accessor.withReadDb((db) => assessSignificance(job.transcript, db, job.agent_id, significanceCfg));

	if (assessment.significant) return true;

	logger.info("summary-worker", "Session below significance threshold — skipping summary", {
		sessionKey: job.session_key,
		project: job.project,
		scores: assessment.scores,
		reason: assessment.reason,
	});
	return false;
}

/**
 * Write the session summary artifact, tolerating an immutable-artifact
 * conflict when a prior attempt already committed it (the daemon crashed
 * between core commit and the final 'completed' status update). Core work
 * already succeeded in that case, so the job should still complete instead
 * of being classified terminal -> dead. Any other error propagates.
 */
export async function persistSessionSummaryArtifact(
	job: SummaryJobRow,
	summary: string,
	provider: LlmProvider | null,
): Promise<void> {
	try {
		const summaryWrite = await writeSummaryArtifact({
			agentId: job.agent_id,
			sessionId: job.session_id ?? job.session_key ?? job.id,
			sessionKey: job.session_key,
			project: job.project,
			harness: job.harness,
			capturedAt: job.captured_at ?? job.created_at,
			startedAt: job.started_at,
			endedAt: job.ended_at,
			summary,
			provider,
		});
		logger.info("summary-worker", "Wrote session summary artifact", {
			path: summaryWrite.summaryPath,
			sessionKey: job.session_key,
			project: job.project,
			summaryChars: summary.length,
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message.startsWith(IMMUTABLE_ARTIFACT_ERROR_PREFIX)) {
			logger.info("summary-worker", "Summary artifact already committed by prior attempt; completing job", {
				sessionKey: job.session_key,
				project: job.project,
				attempt: job.attempts,
			});
		} else {
			throw e;
		}
	}
}

export function tracksSessionSummaryArtifact(job: SummaryJobRow): boolean {
	return (
		job.trigger === "session_end" &&
		isDurableBoundary(job.boundary_reason) &&
		!isNoiseSession({
			project: job.project,
			sessionKey: job.session_key,
			sessionId: job.session_id ?? job.id,
			harness: job.harness,
		})
	);
}

async function updateSummaryArtifactStatus(
	job: SummaryJobRow,
	status: "failed" | "skipped",
	errorMessage?: string,
): Promise<void> {
	if (!tracksSessionSummaryArtifact(job)) return;
	try {
		const manifest = ensureCanonicalManifest({
			agentId: job.agent_id,
			sessionId: job.session_id ?? job.session_key ?? job.id,
			sessionKey: job.session_key,
			project: job.project,
			harness: job.harness,
			capturedAt: job.captured_at ?? job.created_at,
			startedAt: job.started_at,
			endedAt: job.ended_at,
		});
		await updateManifest(manifest.path, (frontmatter) => ({
			...frontmatter,
			summary_path: frontmatter.summary_path ?? null,
			summary_status: frontmatter.summary_path ? "completed" : status,
			...(status === "failed" && errorMessage ? { summary_error: errorMessage.slice(0, 500) } : {}),
		}));
	} catch (error) {
		logger.warn("summary-worker", `Failed to mark summary artifact ${status}`, {
			error: error instanceof Error ? error.message : String(error),
			jobId: job.id,
			sessionKey: job.session_key,
			project: job.project,
		});
	}
}

async function markSummaryArtifactSkipped(job: SummaryJobRow): Promise<void> {
	await updateSummaryArtifactStatus(job, "skipped");
}

async function markSummaryArtifactFailed(job: SummaryJobRow, errorMessage: string): Promise<void> {
	await updateSummaryArtifactStatus(job, "failed", errorMessage);
}

async function processJob(
	accessor: DbAccessor,
	provider: LlmProvider | null,
	job: SummaryJobRow,
	memoryCfg: ResolvedMemoryConfig,
	signal?: AbortSignal,
): Promise<void> {
	if (!provider) {
		throw new Error("summary worker requires a sessionSynthesis inference provider");
	}

	if (!passesSignificanceGate(accessor, job, memoryCfg)) {
		await markSummaryArtifactSkipped(job);
		return;
	}

	const today = resolveSummaryHeadingDate(job);
	const genOpts = {
		timeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
		maxTokens: memoryCfg.pipelineV2.synthesis.maxTokens,
		signal,
		refresh: true,
	};
	const result =
		job.transcript.length > CHUNK_TARGET_CHARS
			? await processChunked(provider, job.transcript, today, genOpts)
			: await processSingle(provider, job.transcript, today, genOpts);

	if (!result) throw new Error("Failed to parse LLM summary response");

	// Dreaming owns all semantic writes (#913 hard cutover). Summary facts are
	// never written to the memories table; Dreaming derives semantic state from
	// episodic evidence. The LLM summary is still computed for DAG continuity.
	const boundaryReason = normalizeBoundaryReason(job.boundary_reason);
	const durable = isDurableBoundary(boundaryReason);

	if (
		durable &&
		job.trigger === "session_end" &&
		!isNoiseSession({
			project: job.project,
			sessionKey: job.session_key,
			sessionId: job.session_id ?? job.id,
			harness: job.harness,
		})
	) {
		await persistSessionSummaryArtifact(job, result.summary, provider);
	}

	try {
		writeSummaryToDAG(accessor, job, result, job.agent_id);
	} catch (e) {
		logger.warn("summary-worker", "Failed to write session summary to DAG (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	try {
		await scoreContinuity(accessor, provider, job, result.summary, memoryCfg, signal);
	} catch (e) {
		logger.warn("summary-worker", "Continuity scoring failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	try {
		const { getSynthesisWorker } = await import("./index");
		void getSynthesisWorker()
			?.triggerNow({ force: true, source: "session-summary", agentId: job.agent_id })
			.then((triggerResult) => {
				if (!triggerResult.skipped) return;
				logger.info("summary-worker", "Skipped MEMORY.md synthesis after session summary", {
					reason: triggerResult.reason,
				});
			})
			.catch((error) => {
				logger.warn("summary-worker", "Failed to trigger MEMORY.md synthesis after session summary", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	} catch (e) {
		logger.warn("summary-worker", "Could not load synthesis worker for post-summary trigger", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	if (job.session_key) {
		upsertSessionTranscript(job.session_key, job.transcript, job.harness, job.project, job.agent_id);
	}
}

// ---------------------------------------------------------------------------
// Single vs chunked summarization
// ---------------------------------------------------------------------------

interface GenerateOpts {
	readonly timeoutMs: number;
	readonly maxTokens: number;
	readonly signal?: AbortSignal;
}

async function processSingle(
	provider: LlmProvider,
	transcript: string,
	date: string,
	opts: GenerateOpts,
): Promise<LlmSummaryResult | null> {
	const raw = await provider.generate(buildPrompt(transcript, date), opts);
	const parsed = parseLlmResponse(raw);
	return parsed ? { ...parsed, leaves: [parsed.summary] } : null;
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

	for (let i = 0; i < chunks.length; i++) {
		const prompt = buildChunkPrompt(chunks[i], i, chunks.length, date);
		const raw = await provider.generate(prompt, opts);
		const partial = parseLlmResponse(raw);

		if (partial) {
			chunkSummaries.push(partial.summary);
		} else {
			logger.warn("summary-worker", "Chunk summarization failed, skipping", {
				chunk: i + 1,
				total: chunks.length,
				responsePreview: raw.length > 0 ? raw.slice(0, 120) : "(empty)",
			});
		}
	}

	if (chunkSummaries.length === 0) return null;

	// Single chunk — prepend standard header directly instead of
	// re-processing through an LLM call
	if (chunkSummaries.length === 1) {
		return {
			summary: `# ${date} Session Notes\n\n${chunkSummaries[0]}`,
			leaves: chunkSummaries,
		};
	}

	// Reduce: combine chunk summaries into unified result
	const combinePrompt = buildCombinePrompt(chunkSummaries, date);
	const combineRaw = await provider.generate(combinePrompt, opts);
	const combined = parseLlmResponse(combineRaw);

	if (combined) return { ...combined, leaves: chunkSummaries };

	// Combine failed — join all summaries as degraded fallback
	logger.warn("summary-worker", "Combine step failed, joining chunks as fallback", {
		chunks: chunkSummaries.length,
	});
	return { summary: chunkSummaries.join("\n\n---\n\n"), leaves: chunkSummaries };
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
	agentId: string,
): ReadonlyArray<InjectedMemoryPreview> {
	if (!sessionKey) return [];

	try {
		return accessor.withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT sm.memory_id, m.content, sm.source, sm.effective_score
					 FROM session_memories sm
					 JOIN memories m ON m.id = sm.memory_id
					 WHERE sm.session_key = ? AND sm.agent_id = ? AND sm.was_injected = 1
					 ORDER BY sm.rank ASC LIMIT 50`,
				)
				.all(sessionKey, agentId) as Array<{
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
 * Write observed per-memory verdicts back to session_memories and path feedback.
 * Maps LLM's 8-char ID prefixes to full memory IDs.
 */
function verdictScore(verdict: "USED" | "IGNORED" | "CONTRADICTED" | undefined, relevance: number): number {
	if (verdict === "USED") return 1;
	if (verdict === "IGNORED") return 0;
	if (verdict === "CONTRADICTED") return -1;
	return Math.max(0, Math.min(1, relevance));
}

function writePerMemoryVerdicts(
	accessor: DbAccessor,
	sessionKey: string,
	agentId: string,
	perMemory: ReadonlyArray<{
		readonly id: string;
		readonly relevance: number;
		readonly verdict?: "USED" | "IGNORED" | "CONTRADICTED";
	}>,
	injectedMemories: ReadonlyArray<InjectedMemoryPreview>,
): void {
	if (perMemory.length === 0) return;

	// Build prefix → full ID lookup
	const prefixMap = new Map<string, string>();
	for (const mem of injectedMemories) {
		prefixMap.set(mem.memoryId.slice(0, 8), mem.memoryId);
	}

	const ratings: Record<string, number> = {};
	const preferences: Record<string, string> = {};
	const relevanceScores: Record<string, number> = {};
	for (const entry of perMemory) {
		const fullId = prefixMap.get(entry.id);
		if (!fullId) continue;
		ratings[fullId] = verdictScore(entry.verdict, entry.relevance);
		preferences[fullId] = entry.verdict ?? "IGNORED";
		relevanceScores[fullId] = ratings[fullId];
	}
	if (Object.keys(ratings).length === 0) return;

	try {
		recordPathFeedback(accessor, { sessionKey, agentId, ratings });
	} catch (e) {
		logger.warn("summary-worker", "Failed to write path feedback verdicts", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	try {
		accessor.withWriteTx((db) => {
			const stmt = db.prepare(
				`UPDATE session_memories
				 SET relevance_score = ?,
				     agent_preference = ?
				 WHERE session_key = ? AND agent_id = ? AND memory_id = ?`,
			);
			for (const [memoryId, score] of Object.entries(relevanceScores)) {
				stmt.run(score, preferences[memoryId] ?? "IGNORED", sessionKey, agentId, memoryId);
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
- Did a memory materially shape an answer, get ignored, or conflict with the transcript?

Pre-loaded memories (${injectedMemories.length} total):
${memorySection}

Return ONLY a JSON object (no markdown fences):
{
  "score": 0.0-1.0,
  "confidence": 0.0-1.0,
  "memories_used": <number of pre-loaded memories with verdict USED>,
  "novel_context_count": <number of times user had to re-explain something>,
  "reasoning": "Brief explanation of the score",
  "per_memory": [{"id": "<8-char prefix>", "relevance": 0.0-1.0, "verdict": "USED|IGNORED|CONTRADICTED"}]
}

Verdicts:
- USED: the memory materially shaped an answer or decision in the transcript.
- IGNORED: the memory was injected but did not matter.
- CONTRADICTED: the transcript shows the memory is wrong or stale.
Use the 8-char ID prefix shown in brackets. Include one per_memory item for every injected memory.

Score guide: 1.0 = memories perfectly covered all needed context, 0.0 = memories were useless and everything was re-explained.
Confidence: how certain you are in your scoring (1.0 = very confident, 0.0 = basically guessing).
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
		readonly verdict?: "USED" | "IGNORED" | "CONTRADICTED";
	}>;
}

export async function scoreContinuity(
	accessor: DbAccessor,
	provider: LlmProvider,
	job: SummaryJobRow,
	summary: string,
	memoryCfg: ResolvedMemoryConfig,
	signal?: AbortSignal,
): Promise<void> {
	// Load injected memories for this session (empty array for old sessions)
	const injectedMemories = loadInjectedMemories(accessor, job.session_key, job.agent_id);

	const prompt = buildContinuityPrompt(job.transcript, summary.slice(0, 2000), injectedMemories);

	const raw = await provider.generate(prompt, {
		timeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
		maxTokens: memoryCfg.pipelineV2.synthesis.maxTokens,
		signal,
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
		.filter((e: unknown): e is { id: string; relevance: number; verdict?: string } => {
			if (typeof e !== "object" || e === null) return false;
			const row = e as Record<string, unknown>;
			return typeof row.id === "string" && typeof row.relevance === "number";
		})
		.map((e) => {
			const verdict: "USED" | "IGNORED" | "CONTRADICTED" | undefined =
				e.verdict === "USED" || e.verdict === "IGNORED" || e.verdict === "CONTRADICTED" ? e.verdict : undefined;
			return { id: e.id, relevance: e.relevance, verdict };
		});

	const result: ContinuityResult = {
		score: Math.max(0, Math.min(1, parsed.score)),
		confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
		memories_used: typeof parsed.memories_used === "number" ? parsed.memories_used : 0,
		novel_context_count: typeof parsed.novel_context_count === "number" ? parsed.novel_context_count : 0,
		reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
		per_memory: perMemory,
	};

	// Write observed usage verdicts back to session_memories + path feedback.
	if (job.session_key && result.per_memory.length > 0) {
		writePerMemoryVerdicts(accessor, job.session_key, job.agent_id, result.per_memory, injectedMemories);
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		try {
			db.prepare(
				`INSERT INTO session_scores
				 (id, session_key, project, harness, agent_id, score, memories_recalled,
				  memories_used, novel_context_count, reasoning,
				  confidence, continuity_reasoning, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				job.session_key || "unknown",
				job.project || null,
				job.harness,
				job.agent_id,
				result.score,
				injectedMemories.length,
				result.memories_used,
				result.novel_context_count,
				result.reasoning,
				result.confidence,
				result.reasoning, // full reasoning for audit trail
				now,
			);
		} catch {
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
				result.reasoning,
				now,
			);
		}
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
// DAG write helper
// ---------------------------------------------------------------------------

function writeSummaryToDAG(accessor: DbAccessor, job: SummaryJobRow, result: LlmSummaryResult, agentId: string): void {
	if (
		isNoiseSession({
			project: job.project,
			sessionKey: job.session_key,
			sessionId: job.session_id ?? job.id,
			harness: job.harness,
		})
	) {
		return;
	}
	accessor.withWriteTx((db) => {
		// Check if table exists (migration may not have run)
		const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get();
		if (!row) return;

		const now = new Date().toISOString();
		const tokenCount = countTokens(result.summary);
		const sourceType = job.trigger === "checkpoint_extract" ? "checkpoint" : "summary";

		// Upsert: check for existing row first since ON CONFLICT doesn't
		// work with the partial unique index (WHERE session_key IS NOT NULL).
		const existing =
			sourceType === "summary" && job.session_key
				? (db
						.prepare(
							`SELECT id FROM session_summaries
				 WHERE session_key = ? AND depth = 0
				   AND agent_id = ?
				   AND COALESCE(source_type, 'summary') = 'summary'`,
						)
						.get(job.session_key, agentId) as { id: string } | undefined)
				: undefined;

		let effectiveId: string;

		if (existing) {
			effectiveId = existing.id;
			db.prepare(
				`UPDATE session_summaries
				 SET content = ?, token_count = ?, latest_at = ?,
				     source_type = ?, source_ref = ?, meta_json = ?
				 WHERE id = ?`,
			).run(
				result.summary,
				tokenCount,
				now,
				sourceType,
				job.session_key ?? null,
				JSON.stringify({ source: "summary-worker", trigger: job.trigger }),
				existing.id,
			);
		} else {
			effectiveId = crypto.randomUUID();
			db.prepare(
				`INSERT INTO session_summaries (
					id, project, depth, kind, content, token_count,
					earliest_at, latest_at, session_key, harness,
					agent_id, source_type, source_ref, meta_json, created_at
				) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				sourceType,
				job.session_key ?? null,
				JSON.stringify({ source: "summary-worker", trigger: job.trigger }),
				now,
			);
		}

		upsertThreadHead(db as unknown as Database, {
			agentId,
			nodeId: effectiveId,
			content: result.summary,
			latestAt: now,
			project: job.project ?? null,
			sessionKey: job.session_key ?? null,
			sourceType,
			sourceRef: job.session_key ?? null,
			harness: job.harness,
		});

		if (job.session_key && result.leaves && result.leaves.length > 0) {
			db.prepare(
				`DELETE FROM session_summary_children
				 WHERE parent_id = ?
				   AND child_id IN (
				     SELECT id FROM session_summaries
				     WHERE source_type = 'chunk' AND source_ref = ?
				   )`,
			).run(effectiveId, job.session_key);

			const chunkStmt = db.prepare(
				`INSERT OR REPLACE INTO session_summaries (
					id, project, depth, kind, content, token_count,
					earliest_at, latest_at, session_key, harness,
					agent_id, source_type, source_ref, meta_json, created_at
				) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, NULL, ?, ?, 'chunk', ?, ?, ?)`,
			);
			const childStmt = db.prepare(
				`INSERT OR REPLACE INTO session_summary_children (parent_id, child_id, ordinal)
				 VALUES (?, ?, ?)`,
			);

			for (let i = 0; i < result.leaves.length; i++) {
				const leaf = result.leaves[i];
				const chunkId = job.session_key ? `${agentId}:${job.session_key}:chunk:${i + 1}` : crypto.randomUUID();
				chunkStmt.run(
					chunkId,
					job.project,
					leaf,
					countTokens(leaf),
					job.created_at,
					now,
					job.harness,
					agentId,
					job.session_key,
					JSON.stringify({ ordinal: i + 1, total: result.leaves.length }),
					now,
				);
				childStmt.run(effectiveId, chunkId, i);
			}
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

/** Resolve from synthesis config — distinct from the Dreaming inference workload. */
export function recoverSummaryJobs(accessor: DbAccessor, limit: number = RECOVER_BATCH): SummaryRecoveryBatch {
	const deadRows: SummaryJobRow[] = [];
	const result = accessor.withWriteTx((db) => {
		const take = Number.isFinite(limit) ? Math.max(1, Math.min(RECOVER_LIMIT_MAX, Math.trunc(limit))) : RECOVER_BATCH;
		const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'summary_jobs'").get() as
			| { name: string }
			| undefined;
		if (!table) {
			return { selected: 0, updated: 0 };
		}

		const rows = db
			.prepare(
				`SELECT id, session_key, session_id, harness, project, transcript,
				        agent_id, trigger, boundary_reason, captured_at, started_at, ended_at,
				        attempts, max_attempts, created_at
				 FROM summary_jobs
				 WHERE status IN ('processing', 'leased')
				 ORDER BY created_at ASC
				 LIMIT ?`,
			)
			.all(take) as SummaryJobRow[];

		if (rows.length === 0) {
			return { selected: 0, updated: 0 };
		}

		const update = db.prepare(
			`UPDATE summary_jobs
			 SET status = ?,
			     result = CASE
			       WHEN result = ? THEN NULL
			       ELSE result
			     END
			 WHERE id = ? AND status IN ('processing', 'leased')`,
		);

		let updated = 0;
		for (const row of rows) {
			const status = row.attempts >= row.max_attempts ? "dead" : "pending";
			updated += countChanges(update.run(status, null, row.id));
			if (status === "dead") deadRows.push(row);
		}

		return { selected: rows.length, updated };
	});
	for (const row of deadRows) {
		void markSummaryArtifactFailed(row, "summary job recovered as dead after daemon restart");
	}
	return result;
}

export async function leaseSummaryJobWhenAvailable(
	accessor: DbAccessor,
	isWorkloadAvailable: () => Promise<boolean>,
): Promise<SummaryJobRow | null> {
	if (!(await isWorkloadAvailable())) return null;

	const job = accessor.withWriteTx((db) => {
		let row: SummaryJobRow | undefined;
		try {
			row = db
				.prepare(
					`SELECT id, session_key, session_id, harness, project, transcript,
					        agent_id, trigger, boundary_reason, captured_at, started_at, ended_at,
					        attempts, max_attempts, created_at
					 FROM summary_jobs
					 WHERE status = 'pending' AND attempts < max_attempts
					 ORDER BY created_at ASC
					 LIMIT 1`,
				)
				.get() as SummaryJobRow | undefined;
		} catch {
			row = db
				.prepare(
					`SELECT id, session_key, session_key AS session_id, harness, project, transcript,
					        'default' AS agent_id, 'session_end' AS trigger,
					        NULL AS boundary_reason,
					        created_at AS captured_at, NULL AS started_at, completed_at AS ended_at,
					        attempts, max_attempts, created_at
					 FROM summary_jobs
					 WHERE status = 'pending' AND attempts < max_attempts
					 ORDER BY created_at ASC
					 LIMIT 1`,
				)
				.get() as SummaryJobRow | undefined;
		}

		if (!row) return null;

		const updated = countChanges(
			db
				.prepare(
					`UPDATE summary_jobs
					 SET status = 'processing', attempts = attempts + 1
					 WHERE id = ? AND status = 'pending' AND attempts = ?`,
				)
				.run(row.id, row.attempts),
		);
		return updated === 1 ? { ...row, attempts: row.attempts + 1 } : null;
	});

	if (!job) return null;

	try {
		if (await isWorkloadAvailable()) return job;
	} catch (error) {
		restoreUnprocessedSummaryLease(accessor, job);
		throw error;
	}

	restoreUnprocessedSummaryLease(accessor, job);
	return null;
}

function restoreUnprocessedSummaryLease(accessor: DbAccessor, job: SummaryJobRow): void {
	const restored = accessor.withWriteTx((db) =>
		countChanges(
			db
				.prepare(
					`UPDATE summary_jobs
					 SET status = 'pending', attempts = attempts - 1
					 WHERE id = ? AND status = 'processing' AND attempts = ?`,
				)
				.run(job.id, job.attempts),
		),
	);
	if (restored !== 1) {
		throw new Error(`Failed to restore unprocessed summary lease for job ${job.id}`);
	}
}

export function startSummaryRecovery(accessor: DbAccessor): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	function schedule(delay: number): void {
		if (stopped) return;
		timer = setTimeout(() => {
			try {
				const batch = recoverSummaryJobs(accessor);
				if (batch.updated > 0) {
					logger.info("summary-worker", `Crash recovery: reset ${batch.updated} stuck job(s) to pending/dead`);
				}
				if (batch.selected >= RECOVER_BATCH) schedule(0);
			} catch (e) {
				logger.warn("summary-worker", "Crash recovery failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}, delay);
	}

	schedule(0);
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}

export function startSummaryWorker(accessor: DbAccessor, options: SummaryWorkerOptions = {}): SummaryWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let activeTick: Promise<void> | null = null;
	let activeAbort: AbortController | null = null;
	const stopRecovery = startSummaryRecovery(accessor);

	let cachedProvider: LlmProvider | null = null;

	async function tick(): Promise<void> {
		if (stopped) return;
		if (isSystemPressureHigh()) {
			scheduleTick(POLL_INTERVAL_MS);
			return;
		}

		// Re-check config each tick — respect runtime config changes
		const cfg = loadMemoryConfig(AGENTS_DIR);
		if (!cfg.pipelineV2.enabled || cfg.pipelineV2.shadowMode) {
			scheduleTick(POLL_INTERVAL_MS);
			return;
		}

		let jobId: string | null = null;
		let leasedJob: SummaryJobRow | null = null;

		try {
			const isSynthesisAvailable = options.isSynthesisAvailable ?? (async () => false);
			const isWorkloadAvailable = async (): Promise<boolean> => {
				const latest = loadMemoryConfig(AGENTS_DIR);
				return canProcessSummaryJobs(await isSynthesisAvailable(), latest.pipelineV2.paused);
			};
			const job = await leaseSummaryJobWhenAvailable(accessor, isWorkloadAvailable);

			if (!job) {
				scheduleTick(POLL_INTERVAL_MS);
				return;
			}

			jobId = job.id;
			leasedJob = job;
			activeAbort = new AbortController();
			const memoryCfg = loadMemoryConfig(AGENTS_DIR);
			let synthesisAvailable = false;
			try {
				synthesisAvailable = await isSynthesisAvailable();
			} catch (error) {
				restoreUnprocessedSummaryLease(accessor, job);
				throw error;
			}
			if (!synthesisAvailable) {
				restoreUnprocessedSummaryLease(accessor, job);
				scheduleTick(POLL_INTERVAL_MS);
				return;
			}

			logger.info("summary-worker", "Processing session summary", {
				jobId: job.id,
				harness: job.harness,
				attempt: job.attempts,
				sessionKey: job.session_key,
				project: job.project,
			});

			if (synthesisAvailable && !cachedProvider) {
				cachedProvider = getInferenceProviderOrNull("sessionSynthesis");
			}
			if (synthesisAvailable && !cachedProvider) {
				// The router says session_synthesis is configured, but the
				// module-level resolver is not wired up yet (init-order window
				// during cold boot or pipeline restart). This is a transient
				// workload-unavailable condition, not a job failure — restore
				// the lease and retry on the next tick instead of burning an
				// attempt (#1155, same init-order class as #1143).
				restoreUnprocessedSummaryLease(accessor, job);
				scheduleTick(POLL_INTERVAL_MS);
				return;
			}
			await processJob(accessor, synthesisAvailable ? cachedProvider : null, job, memoryCfg, activeAbort.signal);

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
			const terminal = isTerminalSummaryJobError(e instanceof Error ? e : String(e));
			const errorMessage = e instanceof Error ? e.message : String(e);
			if (leasedJob && stopped && /aborted|cancelled|canceled/i.test(errorMessage)) {
				restoreUnprocessedSummaryLease(accessor, leasedJob);
				return;
			}
			logger.error("summary-worker", "Job failed", e instanceof Error ? e : undefined, { error: errorMessage });

			// Try to mark the job as failed/pending for retry.
			let deadJobRow: SummaryJobRow | null = null;
			try {
				if (jobId) {
					accessor.withWriteTx((db) => {
						const row = db.prepare("SELECT * FROM summary_jobs WHERE id = ?").get(jobId) as SummaryJobRow | undefined;

						if (!row) return;

						const status = resolveFailedSummaryJobStatus(terminal, row.attempts, row.max_attempts);

						db.prepare(
							`UPDATE summary_jobs
							 SET status = ?, error = ?
							 WHERE id = ? AND status = 'processing'`,
						).run(status, errorMessage, jobId);

						if (status === "dead") {
							deadJobRow = row;
						}
					});
					if (deadJobRow) {
						await markSummaryArtifactFailed(deadJobRow, errorMessage);
					}
				}
			} catch {
				// DB or artifact error during error handling — just log and move on.
			}

			scheduleTick(terminal ? 500 : POLL_INTERVAL_MS * 3);
		} finally {
			activeAbort = null;
		}
	}

	function scheduleTick(delay: number): void {
		if (stopped) return;
		timer = setTimeout(() => {
			activeTick = tick()
				.catch((err) => {
					logger.error("summary-worker", "Unhandled tick error", err instanceof Error ? err : undefined, {
						error: err instanceof Error ? err.message : String(err),
					});
				})
				.finally(() => {
					activeTick = null;
				});
		}, delay);
	}

	// Start polling
	scheduleTick(POLL_INTERVAL_MS);

	return {
		async stop() {
			stopped = true;
			activeAbort?.abort();
			if (timer) clearTimeout(timer);
			stopRecovery();
			if (activeTick) await activeTick;
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
		readonly sessionId?: string;
		readonly project?: string;
		readonly agentId: string;
		readonly trigger?: string;
		readonly boundaryReason?: string;
		readonly capturedAt?: string;
		readonly startedAt?: string;
		readonly endedAt?: string;
	},
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		if (probeNewSchemaColumns(accessor)) {
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, boundary_reason, captured_at, started_at, ended_at, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			).run(
				id,
				params.sessionKey || null,
				params.sessionId || params.sessionKey || id,
				params.harness,
				params.project || null,
				params.agentId,
				params.transcript,
				params.trigger || "session_end",
				params.boundaryReason || null,
				params.capturedAt || now,
				params.startedAt || null,
				params.endedAt || null,
				now,
			);
		} else {
			// Legacy schema: databases that have not yet run the migration
			// adding session_id/agent_id/trigger/etc columns.  The derived
			// sessionId is dropped, so processJob falls back to session_key —
			// the per-session-end uniqueness guarantee (distinct sessionId →
			// distinct token → distinct artifact path) is bypassed.  Recurring
			// sessions on an old schema may still hit immutable-artifact
			// conflicts, which are classified as terminal by
			// isTerminalSummaryJobError.
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, harness, project, transcript, status, created_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
			).run(id, params.sessionKey || null, params.harness, params.project || null, params.transcript, now);
		}
	});

	logger.info("summary-worker", "Enqueued session summary job", {
		jobId: id,
		harness: params.harness,
		sessionKey: params.sessionKey,
		project: params.project,
		boundaryReason: params.boundaryReason || null,
		transcriptChars: params.transcript.length,
	});

	return id;
}
