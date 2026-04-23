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
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { normalizeAndHashContent } from "../content-normalization";
import type { DbAccessor, WriteDb } from "../db-accessor";
import { countChanges } from "../db-helpers";
import { inferType, isDuplicate } from "../hooks";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { IMMUTABLE_ARTIFACT_ERROR_PREFIX, writeSummaryArtifact } from "../memory-lineage";
import { isNoiseSession } from "../session-noise";
import { upsertSessionTranscript } from "../session-transcripts";
import { upsertThreadHead } from "../thread-heads";
import { addDreamingTokens } from "./dreaming";
import { RateLimitExceededError } from "./provider";
import { type SignificanceConfig, assessSignificance } from "./significance-gate";
import { countTokens } from "./tokenizer";

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
	readonly session_id: string | null;
	readonly harness: string;
	readonly project: string | null;
	readonly agent_id: string;
	readonly transcript: string;
	readonly trigger: string;
	readonly captured_at: string | null;
	readonly started_at: string | null;
	readonly ended_at: string | null;
	readonly attempts: number;
	readonly max_attempts: number;
	readonly created_at: string;
}

type SummaryFactJob = Pick<SummaryJobRow, "harness" | "project" | "session_key" | "agent_id"> & {
	readonly session_id?: string | null;
	readonly id?: string | null;
};

interface LlmSummaryResult {
	readonly summary: string;
	readonly facts: ReadonlyArray<{
		readonly content: string;
		readonly importance?: number;
		readonly tags?: string;
		readonly type?: string;
	}>;
	readonly leaves?: ReadonlyArray<string>;
}

export const SUMMARY_WORKER_UPDATED_BY = "summary-worker";
const COMMAND_STAGE_RUNNING_RESULT = "command-stage-running";
const COMMAND_STAGE_COMPLETED_RESULT = "command-stage-complete";
type CommandStageStatus = "none" | "running" | "complete";

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

function hasActiveContentHash(db: WriteDb, contentHash: string, agentId: string): boolean {
	const row = db
		.prepare(
			`SELECT id FROM memories
			 WHERE content_hash = ?
			   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?
			   AND scope IS NULL
			   AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(contentHash, agentId);
	return typeof row === "object" && row !== null;
}

function isContentHashUniqueError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.message.includes("idx_memories_content_hash_unique") || err.message.includes("memories.content_hash");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
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
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nFree-form session note...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Cover what was worked on, key decisions, unresolved threads, and anything likely to matter later
- Prefer concrete names, files, systems, or people when they matter
- Write in past tense, third person

Facts:
- Each fact must be self-contained and understandable without this conversation
- Include the specific subject (package name, file path, tool, component) in every fact
- Keep only durable knowledge, preferences, rules, or decisions
- Types: fact, preference, decision, learning, rule, issue
- Importance: 0.3 (routine) to 0.5 (significant)
- Max 15 facts

Conversation:
${transcript}`;
}

function buildChunkPrompt(chunk: string, index: number, total: number, date: string): string {
	return `You are reviewing chunk ${index + 1} of ${total} from one cleaned coding-session transcript on ${date}. Tool calls, tool outputs, and thinking have already been removed.

Use judgment. Focus on what mattered in this segment.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "Free-form summary of this segment...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary:
- Summarize what was discussed or worked on in this segment
- Capture decisions, important context, and unresolved threads
- Write in past tense, third person

Facts:
- Each fact must be self-contained and understandable without this conversation
- Include the specific subject (package name, file path, tool, component) in every fact
- Keep only durable knowledge worth carrying forward
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

	return `You are combining ${summaries.length} segment summaries from one cleaned coding-session transcript on ${date}. Produce one coherent session note and one deduplicated durable fact list.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nFree-form session note...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Merge overlapping content from segments without repeating yourself
- Keep the note coherent, concrete, and useful for future continuity
- Write in past tense, third person

Facts:
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

function passesSignificanceGate(
	accessor: DbAccessor,
	job: SummaryJobRow,
	memoryCfg: ReturnType<typeof loadMemoryConfig>,
): boolean {
	const significanceCfg: SignificanceConfig = memoryCfg.pipelineV2.significance ?? {
		enabled: true,
		minTurns: 5,
		minEntityOverlap: 1,
		noveltyThreshold: 0.15,
	};
	if (!significanceCfg.enabled) return true;

	const assessment = accessor.withReadDb((db) => assessSignificance(job.transcript, db, job.agent_id, significanceCfg));

	if (assessment.significant) return true;

	logger.info("summary-worker", "Session below significance threshold — skipping extraction", {
		sessionKey: job.session_key,
		project: job.project,
		scores: assessment.scores,
		reason: assessment.reason,
	});
	return false;
}

export function shouldRunSignificanceGateForJob(commandMode: boolean, commandStageStatus: CommandStageStatus): boolean {
	return !commandMode || commandStageStatus === "none";
}

function substituteCommandTokens(input: string, replacements: Record<string, string>): string {
	let output = input;
	for (const [token, value] of Object.entries(replacements)) {
		output = output.split(token).join(value);
	}
	return output;
}

export async function runSummaryCommandProvider(
	job: SummaryJobRow,
	cfg: ReturnType<typeof loadMemoryConfig>,
): Promise<void> {
	const command = cfg.pipelineV2.extraction.command;
	if (!command) {
		throw new Error("pipelineV2.extraction.command is required when extraction.provider is 'command'");
	}

	const tempDir = mkdtempSync(join(tmpdir(), "signet-summary-command-"));
	const transcriptPath = join(tempDir, "transcript.txt");
	writeFileSync(transcriptPath, job.transcript, "utf-8");

	const tokenReplacements: Record<string, string> = {
		$TRANSCRIPT: transcriptPath,
		$TRANSCRIPT_PATH: transcriptPath,
		$SESSION_KEY: job.session_key ?? "",
		$PROJECT: job.project ?? "",
		$AGENT_ID: job.agent_id,
		$SIGNET_PATH: AGENTS_DIR,
	};
	const locationReplacements: Record<string, string> = {
		$AGENT_ID: job.agent_id,
		$SIGNET_PATH: AGENTS_DIR,
	};
	const bin = substituteCommandTokens(command.bin, locationReplacements).trim();
	if (bin.length === 0) {
		throw new Error("pipelineV2.extraction.command.bin resolved to an empty value");
	}
	const args = command.args.map((arg) => substituteCommandTokens(arg, tokenReplacements));
	const timeoutMs = Math.max(5000, Math.min(300000, cfg.pipelineV2.extraction.timeout));
	const cwd = command.cwd ? substituteCommandTokens(command.cwd, locationReplacements).trim() : undefined;
	const envFromConfig: Record<string, string> = {};
	if (command.env) {
		for (const [key, value] of Object.entries(command.env)) {
			envFromConfig[key] = substituteCommandTokens(value, tokenReplacements);
		}
	}

	try {
		await new Promise<void>((resolve, reject) => {
			const child = nodeSpawn(bin, args, {
				cwd: cwd && cwd.length > 0 ? cwd : undefined,
				env: {
					...process.env,
					...envFromConfig,
					SIGNET_PATH: AGENTS_DIR,
				},
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			});

			let settled = false;
			let timedOut = false;
			let killTimer: ReturnType<typeof setTimeout> | null = null;
			const clearKillTimer = (): void => {
				if (killTimer) {
					clearTimeout(killTimer);
					killTimer = null;
				}
			};
			const timeoutError = new Error(`summary command timed out after ${timeoutMs}ms`);
			const timeout = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// Child is already gone.
					}
				}, 2000);
			}, timeoutMs);

			child.on("error", (err) => {
				clearKillTimer();
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (timedOut) {
					reject(timeoutError);
					return;
				}
				reject(err);
			});

			child.on("close", (code) => {
				clearKillTimer();
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (timedOut) {
					reject(timeoutError);
					return;
				}
				const exitCode = code ?? 1;
				if (exitCode !== 0) {
					reject(new Error(`summary command exited with code ${exitCode}`));
					return;
				}
				resolve();
			});
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export function getCommandStageStatus(accessor: DbAccessor, jobId: string): CommandStageStatus {
	return accessor.withReadDb((db) => {
		const row = db.prepare("SELECT result FROM summary_jobs WHERE id = ?").get(jobId) as
			| { result: string | null }
			| undefined;
		if (row?.result === COMMAND_STAGE_COMPLETED_RESULT) {
			return "complete";
		}
		if (row?.result === COMMAND_STAGE_RUNNING_RESULT) {
			return "running";
		}
		return "none";
	});
}

export function hasCommandStageCompleted(accessor: DbAccessor, jobId: string): boolean {
	return getCommandStageStatus(accessor, jobId) === "complete";
}

export function markCommandStageRunning(accessor: DbAccessor, jobId: string): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE summary_jobs
			 SET result = ?
			 WHERE id = ? AND status = 'processing' AND (result IS NULL OR result = '')`,
		).run(COMMAND_STAGE_RUNNING_RESULT, jobId);
	});
}

export function clearCommandStageRunning(accessor: DbAccessor, jobId: string): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE summary_jobs
			 SET result = NULL
			 WHERE id = ? AND status = 'processing' AND result = ?`,
		).run(jobId, COMMAND_STAGE_RUNNING_RESULT);
	});
}

export function markCommandStageCompleted(accessor: DbAccessor, jobId: string): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE summary_jobs
			 SET result = ?
			 WHERE id = ? AND status = 'processing' AND (result = ? OR result IS NULL OR result = '')`,
		).run(COMMAND_STAGE_COMPLETED_RESULT, jobId, COMMAND_STAGE_RUNNING_RESULT);
	});
}

async function processJob(
	accessor: DbAccessor,
	provider: LlmProvider | null,
	job: SummaryJobRow,
	memoryCfg: ReturnType<typeof loadMemoryConfig>,
): Promise<void> {
	const commandMode = memoryCfg.pipelineV2.extraction.provider === "command";
	const commandStageStatus: CommandStageStatus = commandMode ? getCommandStageStatus(accessor, job.id) : "none";

	if (
		shouldRunSignificanceGateForJob(commandMode, commandStageStatus) &&
		!passesSignificanceGate(accessor, job, memoryCfg)
	) {
		return;
	}

	if (commandMode) {
		if (commandStageStatus === "none") {
			markCommandStageRunning(accessor, job.id);
			try {
				await runSummaryCommandProvider(job, memoryCfg);
			} catch (error) {
				clearCommandStageRunning(accessor, job.id);
				throw error;
			}
			markCommandStageCompleted(accessor, job.id);
		} else if (commandStageStatus === "complete") {
			logger.info("summary-worker", "Command extraction already completed for this job attempt chain; skipping rerun", {
				jobId: job.id,
				attempt: job.attempts,
				sessionKey: job.session_key,
				project: job.project,
			});
		} else {
			logger.warn(
				"summary-worker",
				"Command stage checkpoint indicates in-flight prior attempt; skipping rerun to avoid duplicate side effects",
				{
					jobId: job.id,
					attempt: job.attempts,
					sessionKey: job.session_key,
					project: job.project,
				},
			);
		}
	}

	if (!provider) {
		if (!commandMode) throw new Error("summary worker requires a sessionSynthesis inference provider");
		if (job.session_key) {
			upsertSessionTranscript(job.session_key, job.transcript, job.harness, job.project, job.agent_id);
		}
		return;
	}

	const today = resolveSummaryHeadingDate(job);
	const genOpts = {
		timeoutMs: memoryCfg.pipelineV2.synthesis.timeout,
		maxTokens: memoryCfg.pipelineV2.synthesis.maxTokens,
	};
	const result =
		job.transcript.length > CHUNK_TARGET_CHARS
			? await processChunked(provider, job.transcript, today, genOpts)
			: await processSingle(provider, job.transcript, today, genOpts);

	if (!result) throw new Error("Failed to parse LLM summary response");

	if (
		!commandMode &&
		job.trigger === "session_end" &&
		!isNoiseSession({
			project: job.project,
			sessionKey: job.session_key,
			sessionId: job.session_id ?? job.id,
			harness: job.harness,
		})
	) {
		const summaryWrite = await writeSummaryArtifact({
			agentId: job.agent_id,
			sessionId: job.session_id ?? job.session_key ?? job.id,
			sessionKey: job.session_key,
			project: job.project,
			harness: job.harness,
			capturedAt: job.captured_at ?? job.created_at,
			startedAt: job.started_at,
			endedAt: job.ended_at,
			summary: result.summary,
			provider,
		});
		logger.info("summary-worker", "Wrote session summary artifact", {
			path: summaryWrite.summaryPath,
			sessionKey: job.session_key,
			project: job.project,
			summaryChars: result.summary.length,
		});
	}

	if (commandMode) {
		logger.info("summary-worker", "Command extraction mode: skipping summary markdown + fact insertion", {
			sessionKey: job.session_key,
			project: job.project,
		});
	} else {
		const saved = insertSummaryFacts(accessor, job, result.facts);
		logger.info("summary-worker", "Inserted session facts", {
			total: result.facts.length,
			saved,
			deduplicated: result.facts.length - saved,
			factsPreview: result.facts.slice(0, 10).map((fact) => fact.content),
		});
	}

	try {
		writeSummaryToDAG(accessor, job, result, job.agent_id);
	} catch (e) {
		logger.warn("summary-worker", "Failed to write session summary to DAG (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	try {
		const tokens = countTokens(job.transcript);
		addDreamingTokens(accessor, job.agent_id, tokens);
	} catch (e) {
		logger.warn("summary-worker", "Failed to accumulate dreaming tokens (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	try {
		await scoreContinuity(accessor, provider, job, result.summary, memoryCfg);
	} catch (e) {
		logger.warn("summary-worker", "Continuity scoring failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	try {
		if (memoryCfg.pipelineV2.predictor?.enabled && job.session_key) {
			const { runSessionComparison, saveComparison, updateSuccessRate, shouldTriggerTraining, detectDrift } =
				await import("../predictor-comparison");
			const comparison = runSessionComparison(job.session_key, job.agent_id, accessor);
			if (comparison !== null) {
				saveComparison(comparison, job.agent_id, accessor);
				if (comparison.hasPredictorScores) {
					updateSuccessRate(job.agent_id, comparison.predictorWon, comparison.scorerConfidence);
				}
				const driftResult = detectDrift(job.agent_id, accessor, memoryCfg.pipelineV2.predictor.driftResetWindow ?? 20);
				if (driftResult.drifting) {
					logger.warn("predictor", "Drift detected — resetting predictor state", {
						recentWinRate: driftResult.recentWinRate,
						windowSize: driftResult.windowSize,
						agentId: job.agent_id,
					});
					const { updatePredictorState: resetState } = await import("../predictor-state");
					resetState(job.agent_id, { alpha: 1.0, successRate: 0.5 });
				}
				if (shouldTriggerTraining(job.agent_id, memoryCfg.pipelineV2.predictor, accessor)) {
					try {
						const { getPredictorClient } = await import("../daemon");
						const predictorClient = getPredictorClient();
						if (predictorClient) {
							await predictorClient.trainFromDb({ db_path: join(AGENTS_DIR, "memory", "memories.db") });
							const { updatePredictorState } = await import("../predictor-state");
							updatePredictorState(job.agent_id, { lastTrainingAt: new Date().toISOString() });
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

	if (job.session_key) {
		try {
			if (memoryCfg.pipelineV2.predictorPipeline.trainingTelemetry) {
				const { collectTrainingPairs, saveTrainingPairs } = await import("../predictor-training-pairs");
				const pairs = collectTrainingPairs(accessor, job.session_key, job.agent_id);
				if (pairs.length > 0) saveTrainingPairs(accessor, job.agent_id, job.session_key, pairs);
			}
		} catch (e) {
			logger.warn("summary-worker", "Training pair collection failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
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
			facts: allFacts,
			leaves: chunkSummaries,
		};
	}

	// Reduce: combine chunk summaries into unified result
	const combinePrompt = buildCombinePrompt(chunkSummaries, allFacts, date);
	const combineRaw = await provider.generate(combinePrompt, opts);
	const combined = parseLlmResponse(combineRaw);

	if (combined) return { ...combined, leaves: chunkSummaries };

	// Combine failed — join all summaries as degraded fallback
	logger.warn("summary-worker", "Combine step failed, joining chunks as fallback", {
		chunks: chunkSummaries.length,
		facts: allFacts.length,
	});
	return { summary: chunkSummaries.join("\n\n---\n\n"), facts: allFacts, leaves: chunkSummaries };
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
 * Write per-memory relevance scores back to session_memories.
 * Maps LLM's 8-char ID prefixes to full memory IDs.
 */
function writePerMemoryRelevance(
	accessor: DbAccessor,
	sessionKey: string,
	agentId: string,
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
				 WHERE session_key = ? AND agent_id = ? AND memory_id = ?`,
			);

			for (const entry of perMemory) {
				const fullId = prefixMap.get(entry.id);
				if (!fullId) continue;
				const score = Math.max(0, Math.min(1, entry.relevance));
				stmt.run(score, sessionKey, agentId, fullId);
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
	const injectedMemories = loadInjectedMemories(accessor, job.session_key, job.agent_id);

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
		writePerMemoryRelevance(accessor, job.session_key, job.agent_id, result.per_memory, injectedMemories);
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

export function insertSummaryFacts(
	accessor: DbAccessor,
	job: SummaryFactJob,
	facts: ReadonlyArray<LlmSummaryResult["facts"][number]>,
): number {
	if (
		isNoiseSession({
			project: job.project,
			sessionKey: job.session_key,
			sessionId: job.session_id ?? job.id ?? null,
			harness: job.harness,
		})
	) {
		return 0;
	}
	const now = new Date().toISOString();
	const agentId = typeof job.agent_id === "string" && job.agent_id.length > 0 ? job.agent_id : "default";

	return accessor.withWriteTx((db) => {
		let count = 0;
		const stmt = db.prepare(
			// content_hash is required for the embedding tracker to pick up
			// summary facts — the tracker skips rows with NULL content_hash.
			// Without it, facts are invisible to vector search until a manual
			// backfill is run, and the backfill itself cycles for duplicate content.
			`INSERT INTO memories
			 (id, content, content_hash, type, importance, source_id, source_type, who, tags,
			  project, agent_id, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const item of facts) {
			if (!item.content || typeof item.content !== "string") continue;

			const importance = Math.min(item.importance ?? 0.3, 0.5);
			const { contentHash } = normalizeAndHashContent(item.content);

			if (hasActiveContentHash(db, contentHash, agentId)) continue;
			if (isDuplicate(db as unknown as Database, item.content, agentId)) continue;

			const id = crypto.randomUUID();
			const type = item.type || inferType(item.content);

			try {
				stmt.run(
					id,
					item.content,
					contentHash,
					type,
					importance,
					job.session_key || null,
					"session_end",
					job.harness,
					item.tags || null,
					job.project || null,
					agentId,
					now,
					now,
					SUMMARY_WORKER_UPDATED_BY,
				);
			} catch (err) {
				if (isContentHashUniqueError(err)) continue;
				throw err;
			}
			count++;
		}
		return count;
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
			updated += countChanges(update.run(status, COMMAND_STAGE_RUNNING_RESULT, row.id));
		}

		return { selected: rows.length, updated };
	});
}

export function startSummaryWorker(accessor: DbAccessor): SummaryWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let recoverTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	let cachedProvider: LlmProvider | null = null;

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
				let row: SummaryJobRow | undefined;
				try {
					row = db
						.prepare(
							`SELECT id, session_key, session_id, harness, project, transcript,
							        agent_id, trigger, captured_at, started_at, ended_at,
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

			if (!cachedProvider) {
				cachedProvider = getInferenceProvider("sessionSynthesis");
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
			const terminal = isTerminalSummaryJobError(e instanceof Error ? e : String(e));
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

						const status = resolveFailedSummaryJobStatus(terminal, row.attempts, row.max_attempts);

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

			scheduleTick(terminal ? 500 : POLL_INTERVAL_MS * 3);
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
		readonly sessionId?: string;
		readonly project?: string;
		readonly agentId: string;
		readonly trigger?: string;
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
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			).run(
				id,
				params.sessionKey || null,
				params.sessionId || params.sessionKey || id,
				params.harness,
				params.project || null,
				params.agentId,
				params.transcript,
				params.trigger || "session_end",
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
		transcriptChars: params.transcript.length,
	});

	return id;
}
