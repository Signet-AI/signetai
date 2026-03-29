/**
 * Signet Hooks System
 *
 * Lifecycle hooks for harness integration:
 * - onSessionStart: provide context/memories to inject
 * - onPreCompaction: provide summary instructions, receive summary
 * - onUserPromptSubmit: inject relevant memories per prompt
 * - onSessionEnd: extract memories from transcript via LLM
 * - onRemember: explicit memory save
 * - onRecall: explicit memory query
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { getAgentScope, resolveAgentId } from "./agent-id";
import { extractAnchorTerms } from "./anchor-terms";
import {
	clearContinuity,
	consumeState,
	initContinuity,
	recordPrompt,
	recordRemember,
	setStructuralSnapshot,
	shouldCheckpoint,
} from "./continuity-state";
import { listAgentPresence } from "./cross-agent";
import { getPredictorClient, recordPredictorLatency } from "./daemon";
import { getDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { propagateMemoryStatus } from "./knowledge-graph";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import { writeMemoryHead } from "./memory-head";
import {
	appendSynthesisIndexBlock as appendRenderedIndexBlock,
	renderMemoryProjection,
	writeTranscriptArtifact,
} from "./memory-lineage";
import { buildAgentScopeClause, hybridRecall } from "./memory-search";
import {
	applyFtsOverlapFeedback,
	decayAspectWeights,
	getFeedbackTelemetry,
	recordFeedbackTelemetry,
	shouldRunSessionDecay,
} from "./pipeline/aspect-feedback";
import {
	type TraversalPath,
	invalidateTraversalCache,
	resolveFocalEntities,
	setTraversalStatus,
	traverseKnowledgeGraph,
} from "./pipeline/graph-traversal";
import { enqueueSummaryJob } from "./pipeline/summary-worker";
import {
	type CandidateInput,
	type CandidateSource,
	type RankedCandidate,
	type ScoringResult,
	buildPredictorStatusLine,
	evaluateColdStartExit,
	maybeExplore,
	runPredictorScoring,
} from "./predictor-scoring";
import { getPredictorState, updatePredictorState } from "./predictor-state";
import { listSecrets } from "./secrets";
import {
	flushPendingCheckpoints,
	formatPeriodicDigest,
	formatPreCompactionDigest,
	formatRecoveryDigest,
	formatSessionEndDigest,
	getLatestCheckpoint,
	getLatestCheckpointBySession,
	queueCheckpointWrite,
	writeCheckpoint,
} from "./session-checkpoints";
import { parseFeedback, recordAgentFeedback, recordSessionCandidates, trackFtsHits } from "./session-memories";
import { getExpiryWarning } from "./session-tracker";
import { getSessionTranscriptContent, searchTranscriptFallback, upsertSessionTranscript } from "./session-transcripts";
import { type StructuralFeatures, buildCandidateFeatures, getStructuralFeatures } from "./structural-features";
import { searchTemporalFallback } from "./temporal-fallback";
import { getUpdateSummary } from "./update-system";

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");

// ---------------------------------------------------------------------------
// Hook dedup state (in-memory, fail-open on restart)
// ---------------------------------------------------------------------------

/** Tracks which sessions have already received a full session-start inject. */
const sessionStartSeen = new Map<string, number>();

/** Sliding window of recently-injected memory IDs per session (prompt-submit). */
const PROMPT_DEDUP_WINDOW = 5;
const promptDedupRecent = new Map<string, Array<Set<string>>>();

/** Reset prompt-submit dedup for a session (call after compaction). */
export function resetPromptDedup(sessionKey: string): void {
	promptDedupRecent.delete(sessionKey);
}

function loadDbAccessor() {
	try {
		return getDbAccessor();
	} catch {
		return null;
	}
}

function formatMemoryDate(isoDate: string): string {
	const d = new Date(isoDate);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatLastSeenShort(isoDate: string): string {
	const seenAt = Date.parse(isoDate);
	if (!Number.isFinite(seenAt)) return "unknown";
	const deltaMs = Date.now() - seenAt;
	if (deltaMs < 60_000) return "just now";
	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatTranscriptSessionLabel(sessionKey: string): string {
	if (sessionKey.length <= 18) return sessionKey;
	return `${sessionKey.slice(0, 8)}…${sessionKey.slice(-6)}`;
}

function harnessSupportsNamedCrossAgentTools(harness: string): boolean {
	return harness.trim().toLowerCase() === "codex";
}

function sanitizePeerPromptField(value: string | undefined): string {
	if (!value) return "";
	return value
		.replace(/[\r\n`*#[\]<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function toUnique(values: ReadonlyArray<string>): string[] {
	return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function serializeTraversalPath(path: TraversalPath): string {
	return JSON.stringify({
		entity_ids: toUnique(path.entityIds),
		aspect_ids: toUnique(path.aspectIds),
		dependency_ids: toUnique(path.dependencyIds),
	});
}

// ============================================================================
// Types
// ============================================================================

export interface HooksConfig {
	sessionStart?: {
		recallLimit?: number;
		candidatePoolLimit?: number;
		includeIdentity?: boolean;
		includeRecentContext?: boolean;
		recencyBias?: number;
		query?: string;
		maxInjectChars?: number;
	};
	userPromptSubmit?: {
		/** Set to false to disable per-prompt memory injection entirely. Default: true. */
		enabled?: boolean;
		recallLimit?: number;
		maxInjectChars?: number;
		/** Minimum top recall score required before injecting memories. */
		minScore?: number;
	};
	preCompaction?: {
		summaryGuidelines?: string;
		includeRecentMemories?: boolean;
		memoryLimit?: number;
		/** Cap the generated summary at this many characters. */
		maxSummaryChars?: number;
	};
}

export interface SynthesisRequest {
	trigger: "scheduled" | "manual";
}

export interface SynthesisResponse {
	harness: string;
	model: string;
	prompt: string;
	/** Number of source items included in the prompt. */
	fileCount: number;
	indexBlock?: string;
}

export interface SessionStartRequest {
	harness: string;
	project?: string;
	agentId?: string;
	context?: string;
	sessionKey?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface SessionStartResponse {
	identity: {
		name: string;
		description?: string;
	};
	memories: Array<{
		id: string;
		content: string;
		type: string;
		importance: number;
		created_at: string;
	}>;
	recentContext?: string;
	inject: string;
	warnings?: string[];
}

export interface PreCompactionRequest {
	harness: string;
	sessionContext?: string;
	messageCount?: number;
	sessionKey?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface PreCompactionResponse {
	summaryPrompt: string;
	guidelines: string;
}

export interface UserPromptSubmitRequest {
	harness: string;
	project?: string;
	agentId?: string;
	/** Pre-cleaned user message (preferred — used as-is after metadata strip). */
	userMessage?: string;
	/** Raw user prompt (legacy — metadata stripped before use). */
	userPrompt?: string;
	lastAssistantMessage?: string;
	sessionKey?: string;
	transcriptPath?: string;
	transcript?: string;
	runtimePath?: "plugin" | "legacy";
	memory_feedback?: unknown;
}

export interface UserPromptSubmitResponse {
	inject: string;
	memoryCount: number;
	queryTerms?: string;
	engine?: string;
	warnings?: string[];
}

export interface SessionEndRequest {
	harness: string;
	transcriptPath?: string;
	transcript?: string;
	sessionId?: string;
	sessionKey?: string;
	agentId?: string;
	cwd?: string;
	reason?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface SessionEndResponse {
	memoriesSaved: number;
	queued?: boolean;
	jobId?: string;
}

export interface CheckpointExtractRequest {
	harness: string;
	sessionKey: string;
	agentId?: string;
	project?: string;
	transcript?: string;
	transcriptPath?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface CheckpointExtractResponse {
	queued?: boolean;
	jobId?: string;
	skipped?: boolean;
}

export interface RememberRequest {
	harness: string;
	who?: string;
	project?: string;
	content: string;
	sessionKey?: string;
	idempotencyKey?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface RememberResponse {
	saved: boolean;
	id: string;
}

export interface RecallRequest {
	harness: string;
	query: string;
	project?: string;
	limit?: number;
	sessionKey?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface RecallResponse {
	results: Array<{
		id: string;
		content: string;
		type: string;
		importance: number;
		tags: string | null;
		created_at: string;
	}>;
	count: number;
}

// ============================================================================
// Shared Helpers
// ============================================================================

const TYPE_HINTS: ReadonlyArray<readonly [string, string]> = [
	["prefer", "preference"],
	["likes", "preference"],
	["want", "preference"],
	["decided", "decision"],
	["agreed", "decision"],
	["will use", "decision"],
	["learned", "learning"],
	["discovered", "learning"],
	["til ", "learning"],
	["bug", "issue"],
	["issue", "issue"],
	["broken", "issue"],
	["never", "rule"],
	["always", "rule"],
	["must", "rule"],
] as const;

export function inferType(content: string): string {
	const lower = content.toLowerCase();
	for (const [hint, type] of TYPE_HINTS) {
		if (lower.includes(hint)) return type;
	}
	return "fact";
}

/** Decay-weighted score: pinned items always score 1.0 */
export function effectiveScore(importance: number, createdAt: string, pinned: boolean): number {
	if (pinned) return 1.0;
	const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
	return importance * 0.95 ** ageDays;
}

export function appendSynthesisIndexBlock(content: string, indexBlock: string): string {
	return appendRenderedIndexBlock(content, indexBlock);
}

function buildTranscriptFallbackResponse(
	metadataHeader: string,
	queryTerms: string,
	charBudget: number,
	hits: ReadonlyArray<{
		readonly sessionKey: string;
		readonly updatedAt: string;
		readonly excerpt: string;
	}>,
	warnings?: string[],
): UserPromptSubmitResponse {
	const rows = hits.map((hit) => ({
		content: `- ${hit.excerpt} (${formatMemoryDate(hit.updatedAt)}, session ${formatTranscriptSessionLabel(hit.sessionKey)})`,
	}));
	const lines = selectWithBudget(rows, charBudget).map((row) => row.content);
	const inject = `${metadataHeader}\n[signet:recall | query="${queryTerms}" | results=${lines.length} | engine=transcript-fallback]\n${lines.join("\n")}`;
	return {
		inject,
		memoryCount: lines.length,
		queryTerms,
		engine: "transcript-fallback",
		warnings,
	};
}

function buildTemporalFallbackResponse(
	metadataHeader: string,
	queryTerms: string,
	charBudget: number,
	hits: ReadonlyArray<{
		readonly id: string;
		readonly latestAt: string;
		readonly threadLabel: string;
		readonly excerpt: string;
	}>,
	warnings?: string[],
): UserPromptSubmitResponse {
	const rows = hits.map((hit) => ({
		content: `- [node ${hit.id}] ${hit.excerpt} (${formatMemoryDate(hit.latestAt)}, ${hit.threadLabel})`,
	}));
	const lines = selectWithBudget(rows, charBudget).map((row) => row.content);
	const inject = `${metadataHeader}\n[signet:recall | query="${queryTerms}" | results=${lines.length} | engine=temporal-fallback]\n${lines.join("\n")}`;
	return {
		inject,
		memoryCount: lines.length,
		queryTerms,
		engine: "temporal-fallback",
		warnings,
	};
}

/** Truncate rows to fit a character budget, preserving the input type */
export function selectWithBudget<T extends { content: string }>(rows: ReadonlyArray<T>, charBudget: number): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.content.length > charBudget) break;
		selected.push(row);
		used += row.content.length;
	}
	return selected;
}

/** Build a brief "since your last session" summary for temporal awareness */
function getSessionGapSummary(): string | undefined {
	if (!existsSync(MEMORY_DB)) return undefined;

	try {
		return getDbAccessor().withReadDb((db) => {
			// Find last completed session end time
			const lastSession = db
				.prepare("SELECT MAX(completed_at) as last_end FROM summary_jobs WHERE status = 'completed'")
				.get() as { last_end: string | null } | undefined;

			if (!lastSession?.last_end) return undefined;

			const lastEnd = lastSession.last_end;
			const lastEndMs = new Date(lastEnd).getTime();
			const gapMs = Date.now() - lastEndMs;

			// Format time gap
			let gapStr: string;
			const gapMins = Math.floor(gapMs / 60000);
			const gapHours = Math.floor(gapMs / 3600000);
			const gapDays = Math.floor(gapMs / 86400000);

			if (gapDays > 7) gapStr = "7+ days ago";
			else if (gapDays >= 1) gapStr = `${gapDays}d ago`;
			else if (gapHours >= 1) gapStr = `${gapHours}h ago`;
			else gapStr = `${Math.max(1, gapMins)}m ago`;

			// Count new memories since last session
			const memCount = db
				.prepare("SELECT COUNT(*) as cnt FROM memories WHERE created_at > ? AND is_deleted = 0")
				.get(lastEnd) as { cnt: number };

			// Count sessions since last session
			const sessionCount = db
				.prepare("SELECT COUNT(*) as cnt FROM summary_jobs WHERE completed_at > ? AND status = 'completed'")
				.get(lastEnd) as { cnt: number };

			return `[since last session: ${memCount.cnt} new memories, ${sessionCount.cnt} sessions captured, last active ${gapStr}]`;
		});
	} catch {
		return undefined;
	}
}

/** Check if content overlaps 70%+ with existing memories via FTS */
export function isDuplicate(db: Database, content: string): boolean {
	const words = content
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length >= 3);
	if (words.length === 0) return false;

	try {
		const ftsQuery = words.slice(0, 10).join(" OR ");
		const rows = db
			.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 10")
			.all(ftsQuery) as Array<{ content: string }>;

		const inputWords = new Set(words);
		for (const row of rows) {
			const rowWords = new Set(
				row.content
					.toLowerCase()
					.split(/\W+/)
					.filter((w) => w.length >= 3),
			);
			let overlap = 0;
			for (const w of inputWords) {
				if (rowWords.has(w)) overlap++;
			}
			if (overlap / inputWords.size >= 0.7) return true;
		}
	} catch {
		// FTS table might not exist yet
	}
	return false;
}

function readIdentityFile(fileName: string, charBudget: number): string | undefined {
	const filePath = join(AGENTS_DIR, fileName);
	if (!existsSync(filePath)) return undefined;

	try {
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return undefined;
		if (content.length <= charBudget) return content;
		return `${content.slice(0, charBudget)}\n[truncated]`;
	} catch {
		return undefined;
	}
}

function readMemoryMd(charBudget: number): string | undefined {
	return readIdentityFile("MEMORY.md", charBudget);
}

function readAgentsMd(charBudget: number): string | undefined {
	const agentsMd = join(AGENTS_DIR, "AGENTS.md");
	if (!existsSync(agentsMd)) return undefined;

	try {
		const content = readFileSync(agentsMd, "utf-8").trim();
		if (!content) return undefined;
		if (content.length <= charBudget) return content;
		return `${content.slice(0, charBudget)}\n[truncated]`;
	} catch {
		return undefined;
	}
}

export interface ScoredMemory {
	id: string;
	content: string;
	type: string;
	importance: number;
	tags: string | null;
	pinned: number;
	project: string | null;
	created_at: string;
	access_count: number;
	effScore: number;
}

function clampScore01(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

function fetchTraversalCandidates(memoryIds: ReadonlyArray<string>, agentId: string): ScoredMemory[] {
	if (memoryIds.length === 0 || !existsSync(MEMORY_DB)) return [];

	try {
		const placeholders = memoryIds.map(() => "?").join(", ");
		return getDbAccessor()
			.withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT
							 m.id,
							 m.content,
							 m.type,
							 m.importance,
							 m.tags,
							 m.pinned,
							 m.project,
							 m.created_at,
							 COALESCE(m.access_count, 0) AS access_count,
							 COALESCE(MAX(ea.importance), m.importance, 0.5) AS effScore
						 FROM memories m
						 LEFT JOIN entity_attributes ea
						   ON ea.memory_id = m.id
						  AND ea.agent_id = ?
						  AND ea.status = 'active'
						 WHERE m.id IN (${placeholders})
						   AND m.is_deleted = 0
						 GROUP BY
							 m.id,
							 m.content,
							 m.type,
							 m.importance,
							 m.tags,
							 m.pinned,
							 m.project,
							 m.created_at,
							 m.access_count`,
						)
						.all(agentId, ...memoryIds) as ScoredMemory[],
			)
			.map((row) => ({
				...row,
				effScore: clampScore01(row.effScore),
			}));
	} catch {
		return [];
	}
}

function buildActiveConstraintsSection(
	constraints: ReadonlyArray<{
		readonly entityName: string;
		readonly content: string;
		readonly importance: number;
	}>,
	charBudget: number,
): string {
	if (constraints.length === 0) return "";

	const header = "\n## Active Constraints\n\nConstraints for entities in scope. These always apply.\n";
	const fullLines = constraints.map((item) => `- [${item.entityName}] ${item.content}\n`);
	const fullSection = `${header}${fullLines.join("")}`.trimEnd();
	if (charBudget <= 0 || fullSection.length <= charBudget) return fullSection;

	const fixedOverhead = constraints.reduce((acc, item) => acc + `- [${item.entityName}] \n`.length, header.length);
	const availableForContent = Math.max(0, charBudget - fixedOverhead);
	const perConstraintBudget = Math.max(24, Math.floor(availableForContent / constraints.length));
	const compressedLines = constraints.map((item) => {
		const content =
			item.content.length <= perConstraintBudget
				? item.content
				: `${item.content.slice(0, Math.max(1, perConstraintBudget - 3))}...`;
		return `- [${item.entityName}] ${content}\n`;
	});
	const compressedSection = `${header}${compressedLines.join("")}`.trimEnd();

	logger.warn("hooks", "Constraint section exceeded budget; preserving all constraints", {
		constraintBudgetChars: charBudget,
		constraintCount: constraints.length,
		fullChars: fullSection.length,
		injectChars: compressedSection.length,
	});

	// Hard invariant: constraints for in-scope entities always surface.
	// We allow this section to exceed its soft budget rather than dropping rows.
	return compressedSection;
}

/**
 * Return all memories that pass the 0.2 effective score threshold,
 * sorted by project match + score. No budget applied — caller
 * handles truncation via selectWithBudget().
 */
export function getAllScoredCandidates(
	project: string | undefined,
	limit: number,
	agentId = "default",
	readPolicy = "isolated",
	policyGroup: string | null = null,
): ScoredMemory[] {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		const scope = buildAgentScopeClause(agentId, readPolicy, policyGroup);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.id, m.content, m.type, m.importance, m.tags, m.pinned, m.project, m.created_at,
						        COALESCE(access_count, 0) AS access_count
					 FROM memories m
					 WHERE m.is_deleted = 0${scope.sql}
					 ORDER BY created_at DESC LIMIT ?`,
					)
					.all(...scope.args, limit * 3) as Array<{
					id: string;
					content: string;
					type: string;
					importance: number;
					tags: string | null;
					pinned: number;
					project: string | null;
					created_at: string;
					access_count: number;
				}>,
		);

		const scored: ScoredMemory[] = rows
			.map((r) => ({
				...r,
				effScore: effectiveScore(r.importance, r.created_at, r.pinned === 1),
			}))
			.filter((r) => r.effScore > 0.2 || r.pinned === 1);

		// Sort: project matches first, then by score
		scored.sort((a, b) => {
			if (project) {
				const aMatch = a.project === project ? 1 : 0;
				const bMatch = b.project === project ? 1 : 0;
				if (aMatch !== bMatch) return bMatch - aMatch;
			}
			return b.effScore - a.effScore;
		});

		return scored;
	} catch (e) {
		logger.error("hooks", "Failed to get scored candidates", e as Error);
		return [];
	}
}

/**
 * Get predicted context memories by analyzing recent session summaries
 * and using recurring topics as additional search terms. Supplements
 * the regular project-filtered memories with context the user is
 * likely to need based on recent sessions.
 */
function getPredictedContextMemories(
	project: string | undefined,
	limit: number,
	charBudget: number,
	excludeIds: ReadonlySet<string>,
	agentId: string,
	readPolicy = "isolated",
	policyGroup: string | null = null,
): ScoredMemory[] {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		// Get recent session summaries for this project
		const summaryRows = getDbAccessor().withReadDb((db) => {
			if (project) {
				return db
					.prepare(
						`SELECT transcript FROM summary_jobs
						 WHERE project = ? AND status = 'completed' AND agent_id = ?
						 ORDER BY created_at DESC LIMIT 5`,
					)
					.all(project, agentId) as Array<{ transcript: string }>;
			}
			return db
				.prepare(
					`SELECT transcript FROM summary_jobs
					 WHERE status = 'completed' AND agent_id = ?
					 ORDER BY created_at DESC LIMIT 5`,
				)
				.all(agentId) as Array<{ transcript: string }>;
		});

		if (summaryRows.length === 0) return [];

		// Extract recurring terms from recent sessions
		const termFreq = new Map<string, number>();
		for (const row of summaryRows) {
			const text = row.transcript.slice(0, 3000);
			const words = text
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, " ")
				.split(/\s+/)
				.filter((w) => w.length >= 4);
			const seen = new Set<string>();
			for (const w of words) {
				if (seen.has(w)) continue;
				seen.add(w);
				termFreq.set(w, (termFreq.get(w) ?? 0) + 1);
			}
		}

		// Take terms that appear in 2+ sessions (recurring topics)
		const recurring = [...termFreq.entries()]
			.filter(([_, count]) => count >= 2)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([term]) => term);

		if (recurring.length === 0) return [];

		// Use recurring terms as FTS query
		const ftsQuery = recurring.join(" OR ");
		const scope = buildAgentScopeClause(agentId, readPolicy, policyGroup);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.id, m.content, m.type, m.importance, m.tags,
						        m.pinned, m.project, m.created_at,
						        COALESCE(m.access_count, 0) AS access_count
						 FROM memories_fts
						 JOIN memories m ON memories_fts.rowid = m.rowid
						 WHERE memories_fts MATCH ?
						   AND m.is_deleted = 0
						   ${scope.sql}
						 ORDER BY bm25(memories_fts)
						 LIMIT ?`,
					)
					.all(ftsQuery, ...scope.args, limit * 2) as Array<{
					id: string;
					content: string;
					type: string;
					importance: number;
					tags: string | null;
					pinned: number;
					project: string | null;
					created_at: string;
					access_count: number;
				}>,
		);

		const selected: ScoredMemory[] = [];
		let used = 0;
		for (const r of rows) {
			if (excludeIds.has(r.id)) continue;
			if (selected.length >= limit) break;
			if (used + r.content.length > charBudget) break;
			selected.push({
				...r,
				effScore: effectiveScore(r.importance, r.created_at, r.pinned === 1),
			});
			used += r.content.length;
		}

		return selected;
	} catch (e) {
		logger.warn("hooks", "Predicted context failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
		return [];
	}
}

function updateAccessTracking(ids: string[]): void {
	if (ids.length === 0 || !existsSync(MEMORY_DB)) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			const stmt = db.prepare(
				`UPDATE memories SET access_count = access_count + 1,
				 last_accessed = ? WHERE id = ?`,
			);

			for (const id of ids) {
				stmt.run(now, id);
			}
		});
	} catch (e) {
		logger.error("hooks", "Failed to update access tracking", e as Error);
	}
}

// ============================================================================
// Config Loading
// ============================================================================

// Derived from HooksConfig — update when adding new config sections.
const KNOWN_HOOKS_KEYS: ReadonlySet<keyof HooksConfig> = new Set<keyof HooksConfig>([
	"sessionStart",
	"userPromptSubmit",
	"preCompaction",
]);

function loadHooksConfig(): HooksConfig {
	const configPath = join(AGENTS_DIR, "agent.yaml");
	if (!existsSync(configPath)) {
		return getDefaultConfig();
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = parseSimpleYaml(content);
		const hooks = parsed.hooks;
		if (!hooks || typeof hooks !== "object") {
			return getDefaultConfig();
		}
		// Warn on unrecognized keys so users catch typos early
		const record = hooks as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!KNOWN_HOOKS_KEYS.has(key as keyof HooksConfig)) {
				logger.warn("hooks", `Unknown hooks config key: ${key} — check agent.yaml`);
			}
		}
		const cfg: HooksConfig = {
			sessionStart:
				typeof record.sessionStart === "object" && record.sessionStart !== null
					? (record.sessionStart as HooksConfig["sessionStart"])
					: undefined,
			userPromptSubmit:
				typeof record.userPromptSubmit === "object" && record.userPromptSubmit !== null
					? (record.userPromptSubmit as HooksConfig["userPromptSubmit"])
					: undefined,
			preCompaction:
				typeof record.preCompaction === "object" && record.preCompaction !== null
					? (record.preCompaction as HooksConfig["preCompaction"])
					: undefined,
		};
		return cfg;
	} catch (e) {
		logger.warn("hooks", "Failed to load hooks config, using defaults");
		return getDefaultConfig();
	}
}

function getDefaultConfig(): HooksConfig {
	return {
		sessionStart: {
			recallLimit: 50,
			candidatePoolLimit: 100,
			includeIdentity: true,
			includeRecentContext: true,
			recencyBias: 0.7,
		},
		userPromptSubmit: {
			enabled: true,
			recallLimit: 10,
			maxInjectChars: 500,
			minScore: 0.8,
		},
		preCompaction: {
			summaryGuidelines: `Summarize this session focusing on:
- Key decisions made
- Important information learned
- User preferences discovered
- Open threads or todos
- Any errors or issues encountered

Keep the summary concise but complete. Use first person from the agent's perspective.`,
			includeRecentMemories: true,
			memoryLimit: 5,
		},
	};
}

function resolveUserPromptMinScore(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.8;
	return Math.max(0, Math.min(1, value));
}

// ============================================================================
// Type Guards for Parsed YAML
// ============================================================================

interface AgentConfig {
	name?: string;
	description?: string;
}

function isAgentConfig(value: unknown): value is AgentConfig {
	return typeof value === "object" && value !== null;
}

// ============================================================================
// Identity Loading
// ============================================================================

function loadIdentity(): { name: string; description?: string } {
	const agentYaml = join(AGENTS_DIR, "agent.yaml");
	if (existsSync(agentYaml)) {
		try {
			const content = readFileSync(agentYaml, "utf-8");
			const config = parseSimpleYaml(content);
			const agent = config.agent;
			if (isAgentConfig(agent) && agent.name) {
				return {
					name: agent.name,
					description: agent.description,
				};
			}
		} catch {}
	}

	const identityMd = join(AGENTS_DIR, "IDENTITY.md");
	if (existsSync(identityMd)) {
		try {
			const content = readFileSync(identityMd, "utf-8");
			const nameMatch = content.match(/name:\s*(.+)/i);
			const descMatch = content.match(/creature:\s*(.+)/i) || content.match(/role:\s*(.+)/i);
			return {
				name: nameMatch?.[1]?.trim() || "Agent",
				description: descMatch?.[1]?.trim(),
			};
		} catch {}
	}

	return { name: "Agent" };
}

// ============================================================================
// Memory Queries
// ============================================================================

function getRecentMemories(
	limit: number,
	recencyBias = 0.7,
): Array<{
	id: string;
	content: string;
	type: string;
	importance: number;
	created_at: string;
}> {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		const rows = getDbAccessor().withReadDb((db) => {
			const query = `
        SELECT
          id, content, type, importance, created_at,
          (julianday('now') - julianday(created_at)) as age_days
        FROM memories
        WHERE is_deleted = 0
        ORDER BY
          (importance * ${1 - recencyBias}) +
          (1.0 / (1.0 + (julianday('now') - julianday(created_at)))) * ${recencyBias}
          DESC
        LIMIT ?
      `;

			return db.prepare(query).all(limit) as Array<{
				id: string;
				content: string;
				type: string;
				importance: number;
				created_at: string;
			}>;
		});

		return rows.map((r) => ({
			id: r.id,
			content: r.content,
			type: r.type || "general",
			importance: r.importance || 0.5,
			created_at: r.created_at,
		}));
	} catch (e) {
		logger.error("hooks", "Failed to query memories", e as Error);
		return [];
	}
}

/**
 * Get memories created after a given timestamp, ordered by recency.
 */
function getMemoriesSince(
	sinceMs: number,
	limit: number,
): Array<{
	id: string;
	content: string;
	type: string;
	importance: number;
	created_at: string;
}> {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		const sinceIso = new Date(sinceMs).toISOString();
		const rows = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(`
				SELECT id, content, type, importance, created_at
				FROM memories
				WHERE is_deleted = 0 AND created_at > ?
				ORDER BY created_at DESC
				LIMIT ?
			`)
				.all(sinceIso, limit) as Array<{
				id: string;
				content: string;
				type: string;
				importance: number;
				created_at: string;
			}>;
		});

		return rows.map((r) => ({
			id: r.id,
			content: r.content,
			type: r.type || "general",
			importance: r.importance || 0.5,
			created_at: r.created_at,
		}));
	} catch (e) {
		logger.error("hooks", "Failed to query memories since timestamp", e as Error);
		return [];
	}
}

// ============================================================================
// Hook Handlers
// ============================================================================

export async function handleSessionStart(req: SessionStartRequest): Promise<SessionStartResponse> {
	const start = Date.now();
	const config = loadHooksConfig().sessionStart || {};
	const includeIdentity = config.includeIdentity !== false;

	logger.info("hooks", "Session start hook", {
		harness: req.harness,
		project: req.project,
	});

	// Dedup guard: if we already sent a full inject for this session, return
	// a minimal stub. Identity files / MEMORY.md are already in the context.
	// Must fire BEFORE initContinuity to avoid resetting accumulated state.
	if (req.sessionKey && sessionStartSeen.has(req.sessionKey)) {
		logger.info("hooks", "Session start dedup — returning minimal stub", {
			harness: req.harness,
			sessionKey: req.sessionKey,
		});
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const now = new Date().toLocaleString("en-US", {
			timeZone: tz,
			dateStyle: "full",
			timeStyle: "short",
		});
		const warnings = req.sessionKey
			? [getExpiryWarning(req.sessionKey)].filter((w): w is string => w !== null)
			: undefined;
		return {
			identity: { name: "Agent" },
			memories: [],
			inject: `[memory active | /remember | /recall]\n# Current Date & Time\n${now} (${tz})`,
			warnings: warnings?.length ? warnings : undefined,
		};
	}

	// Initialize continuity state for checkpoint accumulation (first call only)
	if (req.sessionKey) {
		initContinuity(req.sessionKey, req.harness, req.project);
	}

	const identity = includeIdentity ? loadIdentity() : { name: "Agent" };

	// Read AGENTS.md first so harness instructions precede synthesized memory
	const agentsMdContent = includeIdentity ? readAgentsMd(12000) : undefined;

	// Read MEMORY.md with 10k char budget
	const memoryMdContent = readMemoryMd(10000);

	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	const traversalCfg = memoryCfg.pipelineV2.traversal;
	const traversalEnabled = memoryCfg.pipelineV2.graph.enabled && traversalCfg?.enabled === true;
	const traversalAgentId = resolveAgentId(req);
	const agentScope = getAgentScope(traversalAgentId);
	const traversalRuntimeCfg = {
		maxAspectsPerEntity: traversalCfg?.maxAspectsPerEntity ?? 10,
		maxAttributesPerAspect: traversalCfg?.maxAttributesPerAspect ?? 20,
		maxDependencyHops: traversalCfg?.maxDependencyHops ?? 10,
		minDependencyStrength: traversalCfg?.minDependencyStrength ?? 0.3,
		maxBranching: traversalCfg?.maxBranching ?? 4,
		maxTraversalPaths: traversalCfg?.maxTraversalPaths ?? 50,
		minConfidence: traversalCfg?.minConfidence ?? 0.5,
		timeoutMs: traversalCfg?.timeoutMs ?? 500,
		boostWeight: traversalCfg?.boostWeight ?? 0.2,
		constraintBudgetChars: traversalCfg?.constraintBudgetChars ?? 1000,
	};

	// Candidate pool fusion: traversal U effective (capped before budget truncation)
	const recallLimit = Math.max(1, config.recallLimit ?? 50);
	const candidatePoolLimit = Math.max(1, config.candidatePoolLimit ?? 100);
	const allCandidates = getAllScoredCandidates(
		req.project,
		recallLimit,
		traversalAgentId,
		agentScope.readPolicy,
		agentScope.policyGroup,
	);
	const candidateById = new Map(allCandidates.map((candidate) => [candidate.id, candidate]));
	const candidateSourceById = new Map<string, CandidateSource>(
		allCandidates.map((candidate) => [candidate.id, "effective" as const]),
	);

	let traversalFocalSource: "project" | "checkpoint" | "query" | "session_key" | null = null;
	let traversalEntities = 0;
	let traversalEntityNames: ReadonlyArray<string> = [];
	let traversalTraversedEntities = 0;
	let traversalMemories = 0;
	let traversalConstraints = 0;
	let traversalTimedOut = false;
	let traversalActiveAspectIds: ReadonlyArray<string> = [];
	const traversalPathById = new Map<string, string>();
	let constraintsForInject: ReadonlyArray<{
		readonly entityName: string;
		readonly content: string;
		readonly importance: number;
	}> = [];

	if (traversalEnabled) {
		try {
			const focal = getDbAccessor().withReadDb((db) =>
				resolveFocalEntities(db, traversalAgentId, {
					project: req.project,
					sessionKey: req.sessionKey,
				}),
			);
			traversalFocalSource = focal.source;
			traversalEntities = focal.entityIds.length;
			traversalEntityNames = focal.entityNames;

			if (focal.entityIds.length > 0) {
				const traversalResult = getDbAccessor().withReadDb((db) =>
					traverseKnowledgeGraph(focal.entityIds, db, traversalAgentId, traversalRuntimeCfg),
				);
				traversalTimedOut = traversalResult.timedOut;
				traversalTraversedEntities = traversalResult.entityCount;
				traversalMemories = traversalResult.memoryIds.size;
				constraintsForInject = traversalResult.constraints;
				traversalConstraints = traversalResult.constraints.length;
				traversalActiveAspectIds = traversalResult.activeAspectIds;
				for (const [memoryId, path] of traversalResult.memoryPaths) {
					traversalPathById.set(memoryId, serializeTraversalPath(path));
				}

				for (const memoryId of traversalResult.memoryIds) {
					if (!candidateById.has(memoryId)) {
						candidateSourceById.set(memoryId, "ka_traversal");
					}
				}

				const traversalRows = fetchTraversalCandidates([...traversalResult.memoryIds], traversalAgentId);
				for (const row of traversalRows) {
					const existing = candidateById.get(row.id);
					if (existing) {
						existing.effScore = Math.max(existing.effScore, row.effScore);
						continue;
					}
					allCandidates.push(row);
					candidateById.set(row.id, row);
					candidateSourceById.set(row.id, "ka_traversal");
				}

				allCandidates.sort((a, b) => {
					if (req.project) {
						const aMatch = a.project === req.project ? 1 : 0;
						const bMatch = b.project === req.project ? 1 : 0;
						if (aMatch !== bMatch) return bMatch - aMatch;
					}
					return b.effScore - a.effScore;
				});
			}

			setTraversalStatus({
				phase: "session_start",
				at: new Date().toISOString(),
				source: traversalFocalSource,
				focalEntityNames: traversalEntityNames,
				focalEntities: traversalEntities,
				traversedEntities: traversalTraversedEntities,
				memoryCount: traversalMemories,
				constraintCount: traversalConstraints,
				timedOut: traversalTimedOut,
			});

			if (req.sessionKey) {
				setStructuralSnapshot(req.sessionKey, {
					focalEntityIds: focal.entityIds,
					focalEntityNames: traversalEntityNames,
					activeAspectIds: traversalActiveAspectIds,
					surfacedConstraintCount: traversalConstraints,
					traversalMemoryCount: traversalMemories,
				});
			}
		} catch {
			// Traversal is best-effort; fall back silently
		}
	}

	const mergedCandidates = allCandidates.slice(0, candidatePoolLimit);

	// ---------------------------------------------------------------
	// Predictor scoring integration (Sprint 2)
	// ---------------------------------------------------------------
	const predictorClient = getPredictorClient();
	const predictorConfig = memoryCfg.pipelineV2.predictor;
	const agentId = traversalAgentId;
	const predictorState = getPredictorState(agentId);
	const dbAcc = loadDbAccessor();

	// Build CandidateInput array from merged candidates
	const candidateInputs: ReadonlyArray<CandidateInput> = mergedCandidates.map((c) => ({
		id: c.id,
		effScore: c.effScore,
		source: candidateSourceById.get(c.id) ?? ("effective" as const),
	}));

	// Get structural features for candidate feature vectors
	const candidateIdsForFeatures = mergedCandidates.map((c) => c.id);
	const structuralById = dbAcc
		? getStructuralFeatures(dbAcc, candidateIdsForFeatures, agentId, candidateSourceById)
		: new Map<string, StructuralFeatures>();

	// Build candidate feature vectors using the canonical 17-element FeatureVector shape
	// (same contract as buildCandidateFeatures / structural-features.ts).
	// The inline 10-element version was wrong — the Rust sidecar expects 17D.
	const featureNow = new Date();
	const sessionGapDays = (() => {
		try {
			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT MAX(created_at) AS last_end
						 FROM session_checkpoints
						 WHERE trigger = 'session_end'`,
						)
						.get() as { last_end: string | null } | undefined,
			);
			return row?.last_end ? Math.max(0, (Date.now() - new Date(row.last_end).getTime()) / 86_400_000) : 0;
		} catch {
			return 0;
		}
	})();
	const candidateFeatures: ReadonlyArray<ReadonlyArray<number>> | null =
		predictorConfig?.enabled && dbAcc
			? buildCandidateFeatures(
					dbAcc,
					mergedCandidates.map((c) => ({
						id: c.id,
						importance: c.importance,
						createdAt: c.created_at,
						accessCount: c.access_count,
						lastAccessed: null,
						pinned: c.pinned === 1,
						isSuperseded: false,
						source: candidateSourceById.get(c.id),
					})),
					agentId,
					{
						projectSlot: 0,
						timeOfDay: featureNow.getHours() + featureNow.getMinutes() / 60,
						dayOfWeek: featureNow.getDay(),
						monthOfYear: featureNow.getMonth(),
						sessionGapDays,
					},
				)
			: null;

	// Run predictor scoring (async — calls sidecar if available)
	const predictorScoreStart = Date.now();
	const scoringResult: ScoringResult = dbAcc
		? await runPredictorScoring({
				candidates: candidateInputs,
				accessor: dbAcc,
				agentId,
				predictorClient,
				config: predictorConfig,
				state: predictorState,
				candidateFeatures,
				nativeEmbeddingDimensions: memoryCfg.embedding.dimensions,
				project: req.project,
			})
		: {
				candidates: candidateInputs.map((candidate, index) => ({
					id: candidate.id,
					baselineRank: index + 1,
					baselineScore: candidate.effScore,
					predictorRank: null,
					predictorScore: null,
					fusedScore: candidate.effScore,
					source: candidate.source,
					embedding: null,
				})),
				predictorUsed: false,
				alpha: 1,
				exploredId: null,
				predictorStatus: null,
			};
	const predictorScoreMs = Date.now() - predictorScoreStart;
	recordPredictorLatency("predictor_score", predictorScoreMs);

	// Build ranked-candidate lookup for fused scores
	const rankedById = new Map<string, RankedCandidate>(scoringResult.candidates.map((rc) => [rc.id, rc]));

	// Re-sort merged candidates by fused score from predictor pipeline
	const sortedCandidates = [...mergedCandidates].sort((a, b) => {
		const aFused = rankedById.get(a.id)?.fusedScore ?? 0;
		const bFused = rankedById.get(b.id)?.fusedScore ?? 0;
		return bFused - aFused;
	});

	// Apply budget to select what we actually inject (on re-ranked order)
	const memories = selectWithBudget(sortedCandidates, 2000);

	// Get predicted context from recent session analysis (~30% of budget)
	const existingIds = new Set(memories.map((m) => m.id));
	const predictedMemories = getPredictedContextMemories(
		req.project,
		10,
		600,
		existingIds,
		agentId,
		agentScope.readPolicy,
		agentScope.policyGroup,
	);
	if (predictedMemories.length > 0) {
		memories.push(...predictedMemories);
	}

	// Exploration: if predictor was used and cold start exited, try exploration
	let exploredId: string | null = null;
	if (scoringResult.predictorUsed && predictorState.coldStartExited) {
		const injectedIds = new Set(memories.map((m) => m.id));
		const exploration = maybeExplore(scoringResult.candidates, injectedIds, predictorConfig?.explorationRate ?? 0.05);
		exploredId = exploration.exploredId;
		if (exploredId !== null) {
			// Remove the displaced memory from the array to maintain budget
			if (exploration.displacedId !== null) {
				const displacedIdx = memories.findIndex((m) => m.id === exploration.displacedId);
				if (displacedIdx !== -1) {
					memories.splice(displacedIdx, 1);
				}
			}
			// Find the explored memory in our candidate pool and add it
			const exploredCandidate = mergedCandidates.find((c) => c.id === exploredId);
			if (exploredCandidate && !memories.some((m) => m.id === exploredId)) {
				memories.push(exploredCandidate);
			}
		}
	}

	// Update access tracking for served memories
	const servedIds = memories.map((m) => m.id);
	updateAccessTracking(servedIds);

	// Cold start evaluation — reuse status from scoring pipeline (no second RPC)
	let predictorStatusLine = "";
	if (predictorConfig?.enabled) {
		const predictorStatus = scoringResult.predictorStatus;
		if (predictorStatus !== null) {
			const exited = evaluateColdStartExit(predictorStatus, predictorConfig.minTrainingSessions, predictorState, dbAcc);
			if (exited && !predictorState.coldStartExited) {
				updatePredictorState(agentId, { coldStartExited: true });
			}
			// Increment sessionsAfterColdStart if cold start exited
			if (exited || predictorState.coldStartExited) {
				updatePredictorState(agentId, {
					sessionsAfterColdStart: predictorState.sessionsAfterColdStart + 1,
				});
			}
			// Build status line using the cached status
			predictorStatusLine = buildPredictorStatusLine(
				predictorStatus,
				getPredictorState(agentId), // re-read after possible update
				predictorConfig,
				dbAcc,
			);
		} else {
			predictorStatusLine = buildPredictorStatusLine(null, predictorState, predictorConfig, null);
		}
	}

	// Record all candidates + which were injected for predictive scorer
	const injectedSet = new Set(memories.map((m) => m.id));
	const allCandidateIdsForRecording = [
		...mergedCandidates.map((c) => c.id),
		...predictedMemories.filter((m) => !mergedCandidates.some((c) => c.id === m.id)).map((m) => m.id),
	];
	// Re-fetch structural features for any predicted memories not in the first batch
	const fullStructuralById =
		allCandidateIdsForRecording.length > candidateIdsForFeatures.length && dbAcc
			? getStructuralFeatures(dbAcc, allCandidateIdsForRecording, agentId, candidateSourceById)
			: structuralById;

	const candidatesForRecording = [
		...mergedCandidates.map((c) => {
			const ranked = rankedById.get(c.id);
			const sf = fullStructuralById.get(c.id);
			const source =
				exploredId === c.id ? ("exploration" as const) : (candidateSourceById.get(c.id) ?? ("effective" as const));
			return {
				id: c.id,
				effScore: c.effScore,
				source,
				predictorScore: ranked?.predictorScore ?? null,
				predictorRank: ranked?.predictorRank ?? null,
				finalScore: ranked?.fusedScore ?? c.effScore,
				entitySlot: sf?.entitySlot ?? 0,
				aspectSlot: sf?.aspectSlot ?? 0,
				isConstraint: sf?.isConstraint ?? 0,
				structuralDensity: sf?.structuralDensity ?? 0,
				pathJson: traversalPathById.get(c.id) ?? null,
			};
		}),
		...predictedMemories
			.filter((m) => !mergedCandidates.some((c) => c.id === m.id))
			.map((m) => {
				const sf = fullStructuralById.get(m.id);
				return {
					id: m.id,
					effScore: m.effScore,
					source: "effective" as const,
					predictorScore: null,
					predictorRank: null,
					finalScore: m.effScore,
					entitySlot: sf?.entitySlot ?? 0,
					aspectSlot: sf?.aspectSlot ?? 0,
					isConstraint: sf?.isConstraint ?? 0,
					structuralDensity: sf?.structuralDensity ?? 0,
					pathJson: traversalPathById.get(m.id) ?? null,
				};
			}),
	];
	recordSessionCandidates(req.sessionKey, candidatesForRecording, injectedSet, agentId);

	// Format inject text
	const injectParts: string[] = [];
	let recoverySection = "";

	injectParts.push("[memory active | /remember | /recall]");
	if (predictorStatusLine) {
		injectParts.push(predictorStatusLine);
	}

	// Inject session gap summary for temporal awareness
	const gapSummary = getSessionGapSummary();
	if (gapSummary) {
		injectParts.push(gapSummary);
	}

	// Inject local date/time and timezone
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const now = new Date().toLocaleString("en-US", {
		timeZone: tz,
		dateStyle: "full",
		timeStyle: "short",
	});
	injectParts.push(`\n# Current Date & Time\n${now} (${tz})\n`);

	if (req.project) {
		const peerSessions = listAgentPresence({
			agentId: resolveAgentId(req),
			sessionKey: req.sessionKey,
			project: req.project,
			includeSelf: false,
			limit: 6,
		});
		if (peerSessions.length > 0) {
			injectParts.push("\n## Active Peer Sessions\n");
			injectParts.push("Other Signet agent sessions are active right now:");
			for (const peer of peerSessions) {
				const safeAgentId = sanitizePeerPromptField(peer.agentId) || "unknown-agent";
				const safeHarness = sanitizePeerPromptField(peer.harness) || "unknown-harness";
				const safeSessionKey = sanitizePeerPromptField(peer.sessionKey);
				const safeProject = sanitizePeerPromptField(peer.project);
				const sessionLabel = safeSessionKey ? ` session=${safeSessionKey}` : "";
				const projectLabel = safeProject ? ` project=${safeProject}` : "";
				injectParts.push(
					`- ${safeAgentId} (${safeHarness})${projectLabel}${sessionLabel} [seen ${formatLastSeenShort(peer.lastSeenAt)}]`,
				);
			}
			if (harnessSupportsNamedCrossAgentTools(req.harness)) {
				injectParts.push("Use `agent_message_send` to ask for help and `agent_message_inbox` to read replies.");
			}
		}
	}

	if (agentsMdContent) {
		injectParts.push("\n## Agent Instructions\n");
		injectParts.push(agentsMdContent);
	} else if (identity.name !== "Agent" || identity.description) {
		injectParts.push(`You are ${identity.name}${identity.description ? `, ${identity.description}` : ""}.`);
	}

	// Inject additional identity files
	const soulContent = includeIdentity ? readIdentityFile("SOUL.md", 4000) : undefined;
	const identityContent = includeIdentity ? readIdentityFile("IDENTITY.md", 2000) : undefined;
	const userContent = includeIdentity ? readIdentityFile("USER.md", 6000) : undefined;

	if (soulContent) {
		injectParts.push("\n## Soul\n");
		injectParts.push(soulContent);
	}
	if (identityContent) {
		injectParts.push("\n## Identity\n");
		injectParts.push(identityContent);
	}
	if (userContent) {
		injectParts.push("\n## About Your User\n");
		injectParts.push(userContent);
	}

	if (memoryMdContent) {
		injectParts.push("\n## Working Memory\n");
		injectParts.push(memoryMdContent);
	}

	if (memories.length > 0) {
		injectParts.push(
			`\n## Relevant Memories (auto-loaded | scored by importance x recency | ${memories.length} results)\n`,
		);
		for (const mem of memories) {
			const tagStr = mem.tags ? ` [${mem.tags}]` : "";
			const dateStr = formatMemoryDate(mem.created_at);
			injectParts.push(`- ${mem.content}${tagStr} (${dateStr})`);
		}
	}

	const constraintsSection = buildActiveConstraintsSection(
		constraintsForInject,
		traversalRuntimeCfg.constraintBudgetChars,
	);

	// Inject session recovery context from recent checkpoints
	const continuityCfg = memoryCfg.pipelineV2.continuity;
	if (continuityCfg.enabled) {
		try {
			const dbAcc = getDbAccessor();
			const withinMs = 4 * 60 * 60 * 1000; // 4 hours

			// Priority 1: session key lineage (same or previous session)
			let checkpoint = req.sessionKey ? getLatestCheckpointBySession(dbAcc, req.sessionKey) : undefined;

			// Priority 2: normalized project path
			if (!checkpoint) {
				let projNorm: string | undefined;
				if (req.project) {
					try {
						projNorm = realpathSync(req.project);
					} catch {
						projNorm = req.project;
					}
				}
				checkpoint = getLatestCheckpoint(dbAcc, projNorm, withinMs);
			}

			if (checkpoint) {
				const recoveryText = formatRecoveryDigest(checkpoint, continuityCfg.recoveryBudgetChars);
				// Store separately — appended after budget truncation to guarantee space
				recoverySection = `\n## Session Recovery Context\n${recoveryText}`;
			}
		} catch (err) {
			logger.warn("hooks", "Recovery context injection failed (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const updateStatus = getUpdateSummary();
	if (updateStatus) {
		injectParts.push("\n## Signet Status\n");
		injectParts.push(updateStatus);
	}

	// Surface available secrets so agents know what's available
	try {
		const secretNames = listSecrets();
		if (secretNames.length > 0) {
			injectParts.push("\n## Available Secrets\n");
			injectParts.push("Use the `secret_exec` MCP tool to run commands with these secrets injected as env vars.\n");
			for (const name of secretNames) {
				injectParts.push(`- ${name}`);
			}
		}
	} catch {
		// Secrets store may not exist yet — non-fatal
	}

	const duration = Date.now() - start;
	const maxInject = config.maxInjectChars ?? 24000;
	// Pre-reserve space for constraints + recovery so they are never truncated
	const reservedChars = recoverySection.length + constraintsSection.length;
	const mainBudget = Math.max(0, maxInject - reservedChars);
	let inject = injectParts.join("\n");
	if (inject.length > mainBudget) {
		inject = `${inject.slice(0, mainBudget)}\n[context truncated]`;
	}
	if (constraintsSection) {
		inject += constraintsSection;
	}
	if (recoverySection) {
		inject += recoverySection;
	}
	logger.info("hooks", "Session start completed", {
		harness: req.harness,
		project: req.project,
		sessionKey: req.sessionKey,
		runtimePath: req.runtimePath,
		memoryCount: memories.length,
		traversalEntities,
		traversalMemories,
		traversalConstraints,
		traversalTimedOut,
		injectChars: inject.length,
		inject,
		durationMs: duration,
	});

	// Mark this session as having received the full inject
	if (req.sessionKey) {
		sessionStartSeen.set(req.sessionKey, Date.now());
	}

	return {
		identity,
		memories: memories.map((m) => ({
			id: m.id,
			content: m.content,
			type: m.type,
			importance: m.importance,
			created_at: m.created_at,
		})),
		recentContext: memoryMdContent,
		inject,
		warnings: (() => {
			if (!req.sessionKey) return undefined;
			const w = [getExpiryWarning(req.sessionKey)].filter((v): v is string => v !== null);
			return w.length > 0 ? w : undefined;
		})(),
	};
}

export function handlePreCompaction(req: PreCompactionRequest): PreCompactionResponse {
	const config = loadHooksConfig().preCompaction || {};

	logger.info("hooks", "Pre-compaction hook", {
		harness: req.harness,
		messageCount: req.messageCount,
	});

	const guidelines = config.summaryGuidelines || (getDefaultConfig().preCompaction?.summaryGuidelines ?? "");

	let summaryPrompt = `Pre-compaction memory flush. Store durable memories now.

${guidelines}

`;

	if (config.includeRecentMemories !== false) {
		const recentMemories = getRecentMemories(config.memoryLimit || 5, 0.9);
		if (recentMemories.length > 0) {
			summaryPrompt += "\nRecent memories for reference:\n";
			for (const mem of recentMemories) {
				summaryPrompt += `- ${mem.content}\n`;
			}
		}
	}

	logger.info("hooks", "Pre-compaction prompt generated", {
		harness: req.harness,
		sessionKey: req.sessionKey,
		messageCount: req.messageCount,
		summaryPromptChars: summaryPrompt.length,
		summaryPrompt,
	});

	// Write pre-compaction checkpoint from accumulated continuity state.
	// Direct write (not queued) since this is a one-shot critical capture.
	// Wrapped in try/catch so a DB failure doesn't prevent the summary
	// prompt from being returned to the harness.
	const snap = consumeState(req.sessionKey);
	if (snap) {
		try {
			const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
			const digest = formatPreCompactionDigest(snap, req.sessionContext);
			writeCheckpoint(
				getDbAccessor(),
				{
					sessionKey: snap.sessionKey,
					harness: snap.harness,
					project: snap.project,
					projectNormalized: snap.projectNormalized,
					trigger: "pre_compaction",
					digest,
					promptCount: snap.promptCount,
					memoryQueries: snap.pendingQueries,
					recentRemembers: snap.pendingRemembers,
					focalEntityIds: snap.structuralSnapshot?.focalEntityIds,
					focalEntityNames: snap.structuralSnapshot?.focalEntityNames,
					activeAspectIds: snap.structuralSnapshot?.activeAspectIds,
					surfacedConstraintCount: snap.structuralSnapshot?.surfacedConstraintCount,
					traversalMemoryCount: snap.structuralSnapshot?.traversalMemoryCount,
				},
				cfg.maxCheckpointsPerSession,
			);
		} catch (err) {
			logger.warn("hooks", "Pre-compaction checkpoint write failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		summaryPrompt,
		guidelines,
	};
}

// ============================================================================
// User Prompt Submit
// ============================================================================

const UNTRUSTED_METADATA_HEADER =
	/conversation info \(untrusted metadata\)\s*:|sender \(untrusted[^)]*\)\s*:|chat history since last reply\s*:|<<<EXTERNAL_UNTRUSTED_CONTENT|END_EXTERNAL_UNTRUSTED_CONTENT|untrusted context\s*:/i;

function findJsonObjectEnd(text: string, startIndex: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = startIndex; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			depth++;
			continue;
		}

		if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function stripUntrustedMetadata(text: string): string {
	let remaining = text;

	while (true) {
		const match = UNTRUSTED_METADATA_HEADER.exec(remaining);
		if (!match || match.index === undefined) break;

		const blockStart = match.index;
		let blockEnd = blockStart + match[0].length;

		while (blockEnd < remaining.length && /\s/.test(remaining[blockEnd])) {
			blockEnd++;
		}

		if (remaining[blockEnd] === "{") {
			const jsonEnd = findJsonObjectEnd(remaining, blockEnd);
			if (jsonEnd > blockEnd) {
				blockEnd = jsonEnd + 1;
			}
		}

		const before = remaining.slice(0, blockStart).trimEnd();
		const after = remaining.slice(blockEnd).trimStart();
		remaining = [before, after].filter((part) => part.length > 0).join("\n\n");
	}

	return remaining.trim();
}

const RECALL_STOPWORDS = new Set([
	"a",
	"about",
	"actually",
	"after",
	"all",
	"also",
	"am",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"been",
	"before",
	"but",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"doing",
	"done",
	"for",
	"from",
	"get",
	"go",
	"had",
	"has",
	"have",
	"hey",
	"hi",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"just",
	"kind",
	"like",
	"make",
	"me",
	"more",
	"my",
	"need",
	"now",
	"of",
	"ok",
	"okay",
	"on",
	"or",
	"our",
	"out",
	"please",
	"pretty",
	"really",
	"right",
	"say",
	"should",
	"so",
	"some",
	"something",
	"still",
	"sure",
	"thanks",
	"thank",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"too",
	"uh",
	"um",
	"use",
	"very",
	"want",
	"was",
	"we",
	"well",
	"were",
	"what",
	"when",
	"which",
	"who",
	"why",
	"will",
	"with",
	"would",
	"yeah",
	"yes",
	"you",
	"your",
]);

interface RecallQueryShape {
	readonly keywordTerms: string[];
	readonly vectorQuery: string;
}

function extractSubstantiveWords(text: string): string[] {
	const cleaned = stripUntrustedMetadata(text).replace(/<@!?\d+>/g, ""); // strip Discord mention tags

	// Preserve hyphenated identifiers (e.g., "KA-6", "pre-compaction")
	const hyphenated = (cleaned.match(/[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*/g) || []).map((t) =>
		t.toLowerCase(),
	);

	// Standard word extraction
	const words = cleaned
		.toLowerCase()
		.split(/\W+/)
		.filter((word) => word.length >= 3 && !RECALL_STOPWORDS.has(word) && !/^\d+$/.test(word));

	// Deduplicate: hyphenated first (more specific), then words
	const seen = new Set<string>();
	const result: string[] = [];
	for (const term of [...hyphenated, ...words]) {
		if (!seen.has(term)) {
			seen.add(term);
			result.push(term);
		}
	}
	return result;
}

export function queryAnchorsMissingFromRecall(query: string, results: ReadonlyArray<{ content: string }>): boolean {
	const anchors = extractAnchorTerms(stripUntrustedMetadata(query));
	if (anchors.length === 0) return false;
	if (results.length === 0) return false;
	const anchorSet = new Set(anchors);
	for (const row of results.slice(0, 8)) {
		const rowAnchors = extractAnchorTerms(row.content);
		for (const rowAnchor of rowAnchors) {
			if (anchorSet.has(rowAnchor)) {
				return false;
			}
		}
	}
	return true;
}

function buildRecallQueryShape(userPrompt: string): RecallQueryShape {
	// Pass cleaned raw text for both keyword and vector queries.
	// FTS5 with implicit AND + BM25 IDF handles term weighting naturally —
	// manual stopword stripping destroyed phrase semantics and let
	// individual OR'd terms match unrelated content.
	const vectorQuery = stripUntrustedMetadata(userPrompt).trim().slice(0, 200);

	// extractSubstantiveWords still used for display/telemetry only
	const keywordTerms = extractSubstantiveWords(userPrompt);

	return { keywordTerms, vectorQuery };
}

function resolveRecallUserMessage(req: UserPromptSubmitRequest): string {
	if (typeof req.userMessage === "string") {
		const cleaned = stripUntrustedMetadata(req.userMessage).trim();
		if (cleaned.length > 0) {
			return cleaned;
		}
	}

	const raw = typeof req.userPrompt === "string" ? req.userPrompt : "";
	return stripUntrustedMetadata(raw).trim();
}

function finalizeUserPromptSubmitSuccess(
	req: UserPromptSubmitRequest,
	userMessage: string,
	start: number,
	result: UserPromptSubmitResponse,
	engineOverride?: string,
): UserPromptSubmitResponse {
	const inject = typeof result.inject === "string" ? result.inject : "";
	const rawMemoryCount = typeof result.memoryCount === "number" ? result.memoryCount : 0;
	const memoryCount = Number.isFinite(rawMemoryCount) && rawMemoryCount >= 0 ? rawMemoryCount : 0;
	const engine =
		typeof engineOverride === "string" && engineOverride.trim().length > 0
			? engineOverride
			: typeof result.engine === "string" && result.engine.trim().length > 0
				? result.engine
				: "none";
	const duration = Date.now() - start;

	logger.info("hooks", "User prompt submit", {
		harness: req.harness,
		project: req.project,
		sessionKey: req.sessionKey,
		memoryCount,
		prompt: userMessage,
		injectChars: inject.length,
		inject,
		engine,
		durationMs: duration,
	});

	return result;
}

export async function handleUserPromptSubmit(req: UserPromptSubmitRequest): Promise<UserPromptSubmitResponse> {
	const start = Date.now();
	const submitCfg = loadHooksConfig().userPromptSubmit ?? {};
	const userMessage = resolveRecallUserMessage(req);
	const agentId = resolveAgentId(req);
	const agentScope = getAgentScope(agentId);
	const { keywordTerms, vectorQuery } = buildRecallQueryShape(userMessage);

	// -- Parse and accumulate incoming agent feedback (from previous prompt) --
	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	const feedbackEnabled = memoryCfg.pipelineV2.predictorPipeline.agentFeedback;
	if (feedbackEnabled && req.memory_feedback !== undefined && req.sessionKey) {
		try {
			const parsed = parseFeedback(req.memory_feedback);
			if (parsed) {
				recordAgentFeedback(req.sessionKey, parsed, resolveAgentId(req));
			} else {
				logger.warn("hooks", "Invalid memory_feedback format, skipping", {
					sessionKey: req.sessionKey,
				});
			}
		} catch (e) {
			// Fail-open: never break the hook for feedback errors
			logger.warn("hooks", "Failed to process memory_feedback", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Always record the prompt for continuity tracking, even if no FTS query
	const snippet = userMessage.slice(0, 200).trim();
	recordPrompt(
		req.sessionKey,
		keywordTerms.length > 0 ? keywordTerms.join(" ") : undefined,
		snippet.length > 0 ? snippet : undefined,
	);
	{
		const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
		if (shouldCheckpoint(req.sessionKey, cfg)) {
			const snap = consumeState(req.sessionKey);
			if (snap) {
				queueCheckpointWrite(
					{
						sessionKey: snap.sessionKey,
						harness: snap.harness,
						project: snap.project,
						projectNormalized: snap.projectNormalized,
						trigger: "periodic",
						digest: formatPeriodicDigest(snap),
						promptCount: snap.promptCount,
						memoryQueries: snap.pendingQueries,
						recentRemembers: snap.pendingRemembers,
						focalEntityIds: snap.structuralSnapshot?.focalEntityIds,
						focalEntityNames: snap.structuralSnapshot?.focalEntityNames,
						activeAspectIds: snap.structuralSnapshot?.activeAspectIds,
						surfacedConstraintCount: snap.structuralSnapshot?.surfacedConstraintCount,
						traversalMemoryCount: snap.structuralSnapshot?.traversalMemoryCount,
					},
					cfg.maxCheckpointsPerSession,
				);
			}
		}
	}

	if (req.sessionKey) {
		let transcript = "";
		if (req.transcriptPath && existsSync(req.transcriptPath)) {
			try {
				const raw = readFileSync(req.transcriptPath, "utf-8");
				transcript = normalizeSessionTranscript(req.harness, raw);
			} catch {
				logger.warn("hooks", "Could not read prompt transcript", {
					path: req.transcriptPath,
				});
			}
		} else if (req.transcript) {
			transcript = normalizeSessionTranscript(req.harness, req.transcript);
		}

		if (transcript) {
			try {
				upsertSessionTranscript(req.sessionKey, transcript, req.harness, req.project ?? null, agentId);
			} catch (error) {
				logger.warn("hooks", "Prompt transcript write failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	// Build lightweight metadata header (injected on every prompt)
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const now = new Date().toLocaleString("en-US", {
		timeZone: tz,
		dateStyle: "full",
		timeStyle: "short",
	});
	const metadataHeader = `# Current Date & Time\n${now} (${tz})\n`;
	const expiryWarning = req.sessionKey ? getExpiryWarning(req.sessionKey) : null;
	const warnings = expiryWarning ? [expiryWarning] : undefined;

	if (submitCfg.enabled === false) {
		return finalizeUserPromptSubmitSuccess(
			req,
			userMessage,
			start,
			{
				inject: metadataHeader,
				memoryCount: 0,
				warnings,
			},
			"disabled",
		);
	}

	if (keywordTerms.length < 1 || vectorQuery.length === 0 || !existsSync(MEMORY_DB)) {
		return finalizeUserPromptSubmitSuccess(
			req,
			userMessage,
			start,
			{
				inject: metadataHeader,
				memoryCount: 0,
				warnings,
			},
			"no-query",
		);
	}

	try {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const recallLimit = submitCfg.recallLimit ?? 10;
		const injectBudget = submitCfg.maxInjectChars ?? cfg.pipelineV2.guardrails.contextBudgetChars;
		const minScore = resolveUserPromptMinScore(submitCfg.minScore);
		const queryTerms = vectorQuery.slice(0, 80);
		const recall = await hybridRecall(
			{
				query: vectorQuery,
				keywordQuery: vectorQuery,
				limit: recallLimit,
				importance_min: 0.3,
				agentId,
				readPolicy: agentScope.readPolicy,
				policyGroup: agentScope.policyGroup,
				project: req.project,
			},
			cfg,
			fetchEmbedding,
		);

		const topRaw = recall.results[0]?.score;
		const topScore = typeof topRaw === "number" ? clampScore01(topRaw) : undefined;
		const noStructured = recall.results.length === 0 || typeof topScore !== "number" || topScore < 0.4;
		// Anchor checks must be driven by the current user turn text, not any
		// expanded/derived recall query shape.
		const anchorsMissed = queryAnchorsMissingFromRecall(userMessage, recall.results);
		if (noStructured || anchorsMissed) {
			const temporalHits = searchTemporalFallback({
				query: vectorQuery,
				agentId,
				sessionKey: req.sessionKey,
				project: req.project,
				limit: 4,
			});
			if (temporalHits.length > 0) {
				return finalizeUserPromptSubmitSuccess(
					req,
					userMessage,
					start,
					buildTemporalFallbackResponse(metadataHeader, queryTerms, injectBudget, temporalHits, warnings),
				);
			}
			const transcriptHits = searchTranscriptFallback({
				query: vectorQuery,
				agentId,
				sessionKey: req.sessionKey,
				project: req.project,
				limit: 3,
			});
			if (transcriptHits.length > 0) {
				return finalizeUserPromptSubmitSuccess(
					req,
					userMessage,
					start,
					buildTranscriptFallbackResponse(metadataHeader, queryTerms, injectBudget, transcriptHits, warnings),
				);
			}
			if (noStructured) {
				return finalizeUserPromptSubmitSuccess(
					req,
					userMessage,
					start,
					{
						inject: metadataHeader,
						memoryCount: 0,
						warnings,
					},
					"no-structured",
				);
			}
		}
		if (typeof topScore !== "number" || topScore < minScore) {
			return finalizeUserPromptSubmitSuccess(
				req,
				userMessage,
				start,
				{
					inject: metadataHeader,
					memoryCount: 0,
					warnings,
				},
				"low-confidence",
			);
		}

		const mapped = recall.results.map((result) => ({
			...result,
			pinned: result.pinned ? 1 : 0,
		}));
		const budgetFiltered = selectWithBudget(mapped, injectBudget);
		const budgetSelected = budgetFiltered.slice(0, 5);
		// omitted reflects only budget truncation, not the 5-item display cap,
		// so the hint correctly directs users to raise contextBudgetChars.
		const omitted = recall.results.length - budgetFiltered.length;

		// Track FTS hits for predictive scorer data collection (full results, pre-dedup)
		const allMatchedIds = recall.results.map((result) => result.id);
		trackFtsHits(req.sessionKey, allMatchedIds, resolveAgentId(req));

		// Filter out memories already injected within the sliding window
		let selected = budgetSelected;
		if (req.sessionKey) {
			const recentTurns = promptDedupRecent.get(req.sessionKey);
			if (recentTurns && recentTurns.length > 0) {
				const recentIds = new Set<string>();
				for (const turnSet of recentTurns) {
					for (const id of turnSet) recentIds.add(id);
				}
				selected = budgetSelected.filter((s) => !recentIds.has(s.id));
			}
		}

		if (selected.length === 0) {
			return finalizeUserPromptSubmitSuccess(
				req,
				userMessage,
				start,
				{
					inject: metadataHeader,
					memoryCount: 0,
					warnings,
				},
				"dedup-empty",
			);
		}

		const lines = selected.map((s) => {
			const dateStr = formatMemoryDate(s.created_at);
			return `- ${s.content} (${dateStr})`;
		});
		if (omitted > 0) {
			lines.push(`(+${omitted} more not shown — raise memory.guardrails.contextBudgetChars to include)`);
		}
		let inject = `${metadataHeader}\n[signet:recall | query="${queryTerms}" | results=${selected.length} | engine=hybrid]\n${lines.join("\n")}`;

		// Append agent feedback request if enabled and there are injected memories
		const selectedIds = selected.map((s) => s.id);
		if (feedbackEnabled && selectedIds.length > 0) {
			inject += `\n<memory-feedback>\nRate injected memories using the mcp__signet__memory_feedback tool. Pass session_key "${req.sessionKey}" and a ratings map of memory ID to score (-1 to 1). 0=unused, 1=directly helpful, -1=harmful.\nIDs: ${selectedIds.join(", ")}\n</memory-feedback>`;
		}

		// Record injected IDs into sliding window for dedup
		if (req.sessionKey && selectedIds.length > 0) {
			let recentTurns = promptDedupRecent.get(req.sessionKey);
			if (!recentTurns) {
				recentTurns = [];
				promptDedupRecent.set(req.sessionKey, recentTurns);
			}
			recentTurns.unshift(new Set(selectedIds));
			if (recentTurns.length > PROMPT_DEDUP_WINDOW) {
				recentTurns.pop();
			}
		}

		return finalizeUserPromptSubmitSuccess(req, userMessage, start, {
			inject,
			memoryCount: selected.length,
			queryTerms,
			engine: "hybrid",
			warnings,
		});
	} catch (e) {
		logger.error("hooks", "User prompt submit failed", e as Error);
		return { inject: "", memoryCount: 0, warnings };
	}
}

// ============================================================================
// Session End
// ============================================================================

export function handleSessionEnd(req: SessionEndRequest): SessionEndResponse {
	const sessionKey = req.sessionKey || req.sessionId;
	const agentId = resolveAgentId({ agentId: req.agentId, sessionKey: req.sessionKey || req.sessionId });
	const sessionId = req.sessionId ?? sessionKey ?? `session-end:${new Date().toISOString()}`;
	const endedAt = new Date().toISOString();

	// Clear hook dedup state for this session
	if (sessionKey) {
		sessionStartSeen.delete(sessionKey);
		promptDedupRecent.delete(sessionKey);
	}

	// Flush pending periodic checkpoints
	try {
		flushPendingCheckpoints();
	} catch (err) {
		logger.warn("hooks", "Checkpoint flush on session-end failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	if (req.reason === "clear") {
		// Caller intends to discard session context — skip checkpoint, just clean up
		clearContinuity(sessionKey);
		return { memoriesSaved: 0 };
	}

	// Capture final session-end checkpoint before clearing state.
	// Uses totalPromptCount so this reflects the full session, not just
	// the interval since the last periodic/pre-compaction consume.
	const snap = consumeState(sessionKey);
	if (snap && snap.totalPromptCount > 0) {
		try {
			const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
			writeCheckpoint(
				getDbAccessor(),
				{
					sessionKey: snap.sessionKey,
					harness: snap.harness,
					project: snap.project,
					projectNormalized: snap.projectNormalized,
					trigger: "session_end",
					digest: formatSessionEndDigest(snap),
					promptCount: snap.totalPromptCount,
					memoryQueries: snap.pendingQueries,
					recentRemembers: snap.pendingRemembers,
					focalEntityIds: snap.structuralSnapshot?.focalEntityIds,
					focalEntityNames: snap.structuralSnapshot?.focalEntityNames,
					activeAspectIds: snap.structuralSnapshot?.activeAspectIds,
					surfacedConstraintCount: snap.structuralSnapshot?.surfacedConstraintCount,
					traversalMemoryCount: snap.structuralSnapshot?.traversalMemoryCount,
				},
				cfg.maxCheckpointsPerSession,
			);
		} catch (err) {
			logger.warn("hooks", "Session-end checkpoint write failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	clearContinuity(sessionKey);

	// Respect the pipeline master switch
	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	if (!memoryCfg.pipelineV2.enabled && !memoryCfg.pipelineV2.shadowMode) {
		logger.info("hooks", "Session end skipped — pipeline disabled");
		return { memoriesSaved: 0 };
	}

	// Read transcript: prefer file path, fall back to inline body
	let transcript = "";
	if (req.transcriptPath && existsSync(req.transcriptPath)) {
		try {
			const rawTranscript = readFileSync(req.transcriptPath, "utf-8");
			transcript = normalizeSessionTranscript(req.harness, rawTranscript);
		} catch {
			logger.warn("hooks", "Could not read transcript", {
				path: req.transcriptPath,
			});
		}
	} else if (req.transcript) {
		transcript = normalizeSessionTranscript(req.harness, req.transcript);
	}

	// Lossless retention: write transcript immediately regardless of length
	// or whether the summary worker succeeds later.
	if (transcript && sessionKey) {
		try {
			upsertSessionTranscript(sessionKey, transcript, req.harness, req.cwd ?? null, agentId);
		} catch (e) {
			logger.warn("hooks", "Transcript write failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	if (transcript.trim().length > 0) {
		try {
			writeTranscriptArtifact({
				agentId,
				sessionId,
				sessionKey: sessionKey ?? null,
				project: req.cwd ?? null,
				harness: req.harness,
				capturedAt: endedAt,
				startedAt: null,
				endedAt,
				transcript,
			});
		} catch (e) {
			logger.warn("hooks", "Transcript artifact write failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
				sessionKey,
			});
		}
	}

	let feedbackAspectsUpdated = 0;
	let feedbackFtsConfirmations = 0;
	let feedbackDecayedAspects = 0;
	let feedbackPropagatedAttributes = 0;
	if (sessionKey && memoryCfg.pipelineV2.graph.enabled && memoryCfg.pipelineV2.feedback.enabled) {
		try {
			const feedback = applyFtsOverlapFeedback(getDbAccessor(), sessionKey, agentId, {
				delta: memoryCfg.pipelineV2.feedback.ftsWeightDelta,
				maxWeight: memoryCfg.pipelineV2.feedback.maxAspectWeight,
				minWeight: memoryCfg.pipelineV2.feedback.minAspectWeight,
			});
			feedbackAspectsUpdated = feedback.aspectsUpdated;
			feedbackFtsConfirmations = feedback.totalFtsConfirmations;

			if (
				memoryCfg.pipelineV2.feedback.decayEnabled &&
				shouldRunSessionDecay(agentId, memoryCfg.pipelineV2.feedback.decayIntervalSessions)
			) {
				feedbackDecayedAspects = decayAspectWeights(getDbAccessor(), agentId, {
					decayRate: memoryCfg.pipelineV2.feedback.decayRate,
					minWeight: memoryCfg.pipelineV2.feedback.minAspectWeight,
					staleDays: memoryCfg.pipelineV2.feedback.staleDays,
				});
			}

			feedbackPropagatedAttributes = propagateMemoryStatus(getDbAccessor(), agentId);
			if (feedbackDecayedAspects > 0 || feedbackPropagatedAttributes > 0) {
				invalidateTraversalCache();
			}
			recordFeedbackTelemetry({
				feedbackDecayedAspects,
				feedbackPropagatedAttributes,
			});
		} catch (err) {
			logger.warn("hooks", "Aspect feedback failed", {
				error: err instanceof Error ? err.message : String(err),
				sessionKey,
			});
		}
	}

	if (transcript.length < 500) {
		return { memoriesSaved: 0 };
	}

	// Safety cap against degenerate inputs (corrupt files, etc).
	// The summary worker handles long transcripts via chunked
	// map-reduce summarization, so this is a last-resort guard.
	const MAX_TRANSCRIPT_CHARS = 100_000;
	let truncated = false;
	if (transcript.length > MAX_TRANSCRIPT_CHARS) {
		logger.warn("hooks", "Transcript exceeds safety cap, truncating", {
			original: transcript.length,
			cap: MAX_TRANSCRIPT_CHARS,
		});
		transcript = `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[truncated]`;
		truncated = true;
	}

	// Queue for async processing by the summary worker instead of
	// blocking on LLM inference. The worker produces both a dated
	// markdown summary and atomic fact rows.
	const jobId = enqueueSummaryJob(getDbAccessor(), {
		harness: req.harness,
		transcript,
		sessionKey,
		sessionId,
		project: req.cwd,
		agentId,
		trigger: "session_end",
		capturedAt: endedAt,
		endedAt,
	});

	logger.info("hooks", "Session end queued for summary", {
		jobId,
		feedbackAspectsUpdated,
		feedbackFtsConfirmations,
		feedbackDecayedAspects,
		feedbackPropagatedAttributes,
		feedbackTelemetry: getFeedbackTelemetry(),
	});
	logger.info("hooks", "Session end transcript queued", {
		harness: req.harness,
		project: req.cwd,
		sessionKey,
		transcriptPath: req.transcriptPath,
		transcriptChars: transcript.length,
		truncated,
		preview: transcript.slice(0, 500),
	});

	return { memoriesSaved: 0, queued: true, jobId };
}

// ---------------------------------------------------------------------------
// Mid-session checkpoint extraction (long-lived sessions)
// ---------------------------------------------------------------------------

/**
 * Read (or upsert) the extract cursor for delta tracking.
 * Returns the last_offset for the given session/agent pair.
 */
/** Read the extract cursor for a session, returning last_offset (0 if none). */
function readExtractCursor(sessionKey: string, agentId: string): number {
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare("SELECT last_offset FROM session_extract_cursors WHERE session_key = ? AND agent_id = ?")
				.get(sessionKey, agentId) as { last_offset: number } | undefined;
			return row?.last_offset ?? 0;
		});
	} catch {
		return 0;
	}
}

/**
 * Advance the extract cursor to `offset` for this session.
 * Called AFTER the summary job is enqueued so a crash between enqueue and
 * cursor advance causes a redundant re-extraction (acceptable) rather than
 * permanently skipping a delta window (data loss).
 */
function advanceExtractCursor(sessionKey: string, agentId: string, offset: number): void {
	const now = new Date().toISOString();
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_extract_cursors (session_key, agent_id, last_offset, last_extract_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_key, agent_id) DO UPDATE SET
				   last_offset = excluded.last_offset,
				   last_extract_at = excluded.last_extract_at`,
			).run(sessionKey, agentId, offset, now);
		});
	} catch (e) {
		logger.warn("hooks", "advanceExtractCursor failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

/**
 * Mid-session checkpoint extraction. Simplified version of handleSessionEnd
 * for long-lived sessions that never call session-end.
 *
 * Key differences from handleSessionEnd:
 * - Does NOT release the session claim (session continues after this call)
 * - Calls consumeState() to flush accumulated continuity data, then
 *   initContinuity() to restart the tracking window for the next interval
 * - Only extracts the delta since the last extraction (cursor via
 *   readExtractCursor / advanceExtractCursor; cursor is advanced AFTER
 *   enqueueSummaryJob succeeds to preserve crash-safety)
 * - Skips if delta is < 500 bytes (not worth extracting)
 * - Writes a checkpoint with trigger 'mid_session_extract'
 */
export function handleCheckpointExtract(req: CheckpointExtractRequest): CheckpointExtractResponse {
	const agentId = resolveAgentId({ agentId: req.agentId, sessionKey: req.sessionKey });

	// Respect the pipeline master switch
	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	if (!memoryCfg.pipelineV2.enabled && !memoryCfg.pipelineV2.shadowMode) {
		logger.info("hooks", "Checkpoint extract skipped — pipeline disabled");
		return { skipped: true };
	}

	// Read transcript: prefer inline body, then file path, then stored transcript.
	// transcriptPath is trusted the same way as in handleSessionEnd and
	// handleUserPromptSubmit — OpenClaw session files are written by the same
	// user process as the daemon and may be anywhere (project dirs, /tmp,
	// containers). Protection at the network level is the global auth middleware.
	let transcript = "";
	let fromStore = false;
	if (req.transcript) {
		transcript = normalizeSessionTranscript(req.harness, req.transcript);
	} else if (req.transcriptPath && existsSync(req.transcriptPath)) {
		try {
			const raw = readFileSync(req.transcriptPath, "utf-8");
			transcript = normalizeSessionTranscript(req.harness, raw);
		} catch {
			logger.warn("hooks", "Could not read checkpoint transcript", {
				path: req.transcriptPath,
			});
		}
	}

	// Fall back to stored transcript if nothing was provided inline
	if (!transcript) {
		transcript = getSessionTranscriptContent(req.sessionKey, agentId) ?? "";
		fromStore = true;
	}

	if (!transcript) {
		logger.info("hooks", "Checkpoint extract skipped — no transcript available", {
			sessionKey: req.sessionKey,
		});
		return { skipped: true };
	}

	// Upsert transcript for lossless retention, but only when new content is
	// provided (not merely re-reading the stored transcript) and only when it
	// is at least as long as what is already stored.  Upserting a shorter
	// payload would move the extraction cursor past valid content and cause
	// future checkpoints to permanently skip that range.
	if (!fromStore) {
		const prev = getSessionTranscriptContent(req.sessionKey, agentId);
		if (!prev || transcript.length >= prev.length) {
			try {
				upsertSessionTranscript(req.sessionKey, transcript, req.harness, req.project ?? null, agentId);
			} catch (e) {
				logger.warn("hooks", "Checkpoint transcript upsert failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}

	// Read current cursor; skip if delta is too small.
	// Cursor is stored as UTF-8 byte offset so it matches the Rust daemon's
	// byte-based cursor on a shared database. Slice transcript by bytes to
	// keep the unit consistent across daemons.
	const cursor = readExtractCursor(req.sessionKey, agentId);
	const transcriptBuf = Buffer.from(transcript, "utf8");
	const deltaBuf = transcriptBuf.subarray(cursor);
	if (deltaBuf.byteLength < 500) {
		logger.info("hooks", "Checkpoint extract skipped — delta too small", {
			sessionKey: req.sessionKey,
			deltaBytes: deltaBuf.byteLength,
			cursor,
		});
		return { skipped: true };
	}
	// Convert delta buffer to string; safety cap against degenerate inputs
	const delta = deltaBuf.toString("utf8");
	const MAX_DELTA_CHARS = 100_000;
	const capped = delta.length > MAX_DELTA_CHARS ? `${delta.slice(0, MAX_DELTA_CHARS)}\n[truncated]` : delta;

	// Flush accumulated continuity data into a checkpoint, then re-init the
	// tracking window so subsequent turns continue accumulating. Unlike
	// session-end, we do NOT release the session claim.
	//
	// Note: consumeState/initContinuity are session-key-scoped (not agentId-
	// scoped) — matching the same design in handleSessionEnd. In the OpenClaw
	// multi-agent model each agent run always has a unique session key, so
	// session-key scoping is sufficient in practice. agentId is used for
	// cursor and transcript dedup in session_extract_cursors /
	// session_transcripts, where it matters for correct per-agent scoping.
	try {
		const snap = consumeState(req.sessionKey);
		if (snap && snap.totalPromptCount > 0) {
			const cfg = loadMemoryConfig(AGENTS_DIR).pipelineV2.continuity;
			writeCheckpoint(
				getDbAccessor(),
				{
					sessionKey: snap.sessionKey,
					harness: snap.harness,
					project: snap.project,
					projectNormalized: snap.projectNormalized,
					trigger: "mid_session_extract",
					digest: formatPeriodicDigest(snap),
					promptCount: snap.totalPromptCount,
					memoryQueries: snap.pendingQueries,
					recentRemembers: snap.pendingRemembers,
					focalEntityIds: snap.structuralSnapshot?.focalEntityIds,
					focalEntityNames: snap.structuralSnapshot?.focalEntityNames,
					activeAspectIds: snap.structuralSnapshot?.activeAspectIds,
					surfacedConstraintCount: snap.structuralSnapshot?.surfacedConstraintCount,
					traversalMemoryCount: snap.structuralSnapshot?.traversalMemoryCount,
				},
				cfg.maxCheckpointsPerSession,
			);
		}
	} catch (err) {
		logger.warn("hooks", "Checkpoint extract checkpoint write failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	try {
		initContinuity(req.sessionKey, req.harness, req.project);
	} catch {
		// Non-fatal — continuity will re-init on the next prompt
	}

	// Enqueue summary job for the delta only.
	// Cursor is advanced AFTER the enqueue so a crash between the two steps
	// causes a redundant re-extraction next time rather than silently
	// skipping a delta window.
	const jobId = enqueueSummaryJob(getDbAccessor(), {
		harness: req.harness,
		transcript: capped,
		sessionKey: req.sessionKey,
		sessionId: req.sessionKey,
		project: req.project,
		agentId,
		trigger: "checkpoint_extract",
		capturedAt: new Date().toISOString(),
	});
	// Advance cursor using UTF-8 byte length so the stored offset is
	// byte-compatible with the Rust daemon on a shared database.
	advanceExtractCursor(req.sessionKey, agentId, Buffer.byteLength(transcript, "utf8"));

	logger.info("hooks", "Checkpoint extract queued", {
		jobId,
		sessionKey: req.sessionKey,
		deltaChars: capped.length,
		cursor,
		newCursor: Buffer.byteLength(transcript, "utf8"),
	});

	return { queued: true, jobId };
}

export function normalizeSessionTranscript(harness: string, raw: string): string {
	if (harness.trim().toLowerCase() === "codex") {
		return normalizeCodexTranscript(raw);
	}

	const result = normalizeJsonConversationTranscript(raw);
	// null = not a JSON-line transcript, safe to return raw
	if (result === null) return raw;
	// Empty string from a non-trivial transcript means all lines were
	// non-conversational — warn so operators can add support for this schema
	if (result === "" && raw.length > 500) {
		logger.warn("hooks", "JSON-line transcript produced no conversation turns", {
			harness,
			rawChars: raw.length,
		});
	}
	return result;
}

// Returns null when input is not JSON-line format (below 60% threshold).
// Returns string (possibly empty) when input IS JSON-line — empty means
// all lines were non-conversational (tool calls, metadata, etc.).
export function normalizeJsonConversationTranscript(raw: string): string | null {
	const rawLines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (rawLines.length === 0) return "";

	const parsedLines: Array<Record<string, unknown> | null> = [];
	let parsedCount = 0;
	for (const line of rawLines) {
		try {
			const parsed = JSON.parse(line);
			if (isRecord(parsed)) {
				parsedLines.push(parsed);
				parsedCount++;
				continue;
			}
		} catch {
			// Ignore parse errors; we only treat this as JSON if most lines parse.
		}
		parsedLines.push(null);
	}

	// Not a JSON-line transcript — caller should fall back to raw
	if (parsedCount < Math.ceil(rawLines.length * 0.6)) {
		return null;
	}

	const conversationLines: string[] = [];
	for (const record of parsedLines) {
		if (!record) continue;
		const normalized = normalizeJsonConversationRecord(record);
		if (normalized) {
			conversationLines.push(normalized);
		}
	}

	return conversationLines.join("\n");
}

function normalizeJsonConversationRecord(record: Record<string, unknown>): string {
	if (record.type === "item.completed") {
		if (isRecord(record.item) && record.item.type === "agent_message") {
			const itemRecord = record.item;
			const text = extractString(itemRecord, ["text", "message", "content"]);
			if (text) return `Assistant: ${text}`;
		}
	}

	if (record.type === "event_msg") {
		if (isRecord(record.payload) && record.payload.type === "user_message") {
			const payloadRecord = record.payload;
			const text = extractString(payloadRecord, ["message", "text", "content"]);
			if (text) return `User: ${text}`;
		}
	}

	if (isRecord(record.message)) {
		const msg = record.message;
		const role = extractString(msg, ["role", "speaker"]);
		const text = extractMessageText(msg);
		if (role && text) {
			const lower = role.toLowerCase();
			if (lower === "user") return `User: ${text}`;
			if (lower === "assistant") return `Assistant: ${text}`;
		}
	}

	const role = extractString(record, ["role", "speaker"]);
	if (role) {
		const lowerRole = role.toLowerCase();
		const text = extractMessageText(record);
		if (lowerRole === "user" && text) return `User: ${text}`;
		if (lowerRole === "assistant" && text) return `Assistant: ${text}`;
	}

	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractString(record: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") {
			const trimmed = value.trim().replace(/[\r\n]+/g, " ");
			if (trimmed.length > 0) return trimmed;
		}
	}
	return "";
}

function extractMessageText(record: Record<string, unknown>): string {
	const direct = extractString(record, ["content", "text", "message"]);
	if (direct) return direct;

	const content = record.content;
	if (!Array.isArray(content)) return "";

	const parts = content.flatMap((item) => {
		if (!isRecord(item) || item.type !== "text") return [];
		const text = extractString(item, ["text", "content"]);
		return text ? [text] : [];
	});

	return parts.join(" ");
}

export function normalizeCodexTranscript(raw: string): string {
	const lines: string[] = [];

	for (const row of raw.split(/\r?\n/)) {
		const trimmed = row.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed !== "object" || parsed === null) continue;
		const event = parsed as Record<string, unknown>;

		if (event.type === "session_meta") {
			// Non-conversational metadata — omit to avoid leaking local
			// paths (cwd) into downstream summaries
			continue;
		}

		if (event.type === "event_msg") {
			const payload = event.payload;
			if (typeof payload === "object" && payload !== null) {
				const msg = payload as Record<string, unknown>;
				// Only capture user messages here; assistant turns come from
				// item.completed which is authoritative and avoids duplicating
				// content that Codex emits in both streaming and completion events.
				if (msg.type === "user_message" && typeof msg.message === "string") {
					lines.push(`User: ${msg.message.trim().replace(/[\r\n]+/g, " ")}`);
				}
			}
			continue;
		}

		if (event.type === "item.completed") {
			const item = event.item;
			if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>;
				if (record.type === "agent_message" && typeof record.text === "string") {
					lines.push(`Assistant: ${record.text.trim().replace(/[\r\n]+/g, " ")}`);
				}
			}
		}

		// response_item events (tool calls/outputs) are intentionally omitted
	}

	return lines.join("\n");
}

// ============================================================================
// Remember
// ============================================================================

export function handleRemember(req: RememberRequest): RememberResponse {
	let content = req.content.trim();
	let pinned = 0;
	let importance = 0.8;

	// Check for critical: prefix
	if (content.toLowerCase().startsWith("critical:")) {
		content = content.slice(9).trim();
		pinned = 1;
		importance = 1.0;
	}

	// Extract [tags] if present
	let tags: string | null = null;
	const tagMatch = content.match(/^\[([^\]]+)\]:\s*/);
	if (tagMatch) {
		tags = tagMatch[1];
		content = content.slice(tagMatch[0].length);
	}

	const type = inferType(content);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	try {
		const resultId = getDbAccessor().withWriteTx((db) => {
			// Idempotency check inside write tx to eliminate races
			if (req.idempotencyKey) {
				try {
					const existing = db.prepare("SELECT id FROM memories WHERE idempotency_key = ?").get(req.idempotencyKey) as
						| { id: string }
						| undefined;

					if (existing) {
						logger.info("hooks", "Idempotency hit, returning existing", {
							id: existing.id,
							key: req.idempotencyKey,
						});
						return existing.id;
					}
				} catch {
					// Column might not exist yet (pre-migration 006)
				}
			}

			db.prepare(
				`INSERT INTO memories
				 (id, content, type, importance, source_type, who, tags,
				  pinned, project, idempotency_key, runtime_path,
				  created_at, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				content,
				type,
				importance,
				"explicit",
				req.who || req.harness,
				tags,
				pinned,
				req.project || null,
				req.idempotencyKey || null,
				req.runtimePath || null,
				now,
				now,
				req.who || req.harness || "hooks",
			);

			return id;
		});

		// Track for continuity checkpointing
		recordRemember(req.sessionKey, content);

		logger.info("hooks", "Memory saved", {
			id: resultId,
			type,
			pinned: pinned === 1,
			runtimePath: req.runtimePath,
		});

		return { saved: true, id: resultId };
	} catch (e) {
		logger.error("hooks", "Remember failed", e as Error);
		return { saved: false, id: "" };
	}
}

// ============================================================================
// Recall
// ============================================================================

export function handleRecall(req: RecallRequest): RecallResponse {
	const limit = req.limit || 10;

	if (!existsSync(MEMORY_DB)) {
		return { results: [], count: 0 };
	}

	type RecallRow = {
		id: string;
		content: string;
		type: string;
		importance: number;
		tags: string | null;
		created_at: string;
	};

	try {
		const rows = getDbAccessor().withReadDb((db) => {
			let found: RecallRow[] = [];

			// Try FTS search first
			try {
				const words = req.query
					.toLowerCase()
					.split(/\W+/)
					.filter((w) => w.length >= 3)
					.slice(0, 10);

				if (words.length > 0) {
					const ftsQuery = words.join(" OR ");
					const baseQuery = req.project
						? `SELECT m.id, m.content, m.type, m.importance, m.tags, m.created_at
						   FROM memories m
						   JOIN memories_fts f ON m.rowid = f.rowid
						   WHERE memories_fts MATCH ?
						   AND m.is_deleted = 0
						   AND m.project = ?
						   LIMIT ?`
						: `SELECT m.id, m.content, m.type, m.importance, m.tags, m.created_at
						   FROM memories m
						   JOIN memories_fts f ON m.rowid = f.rowid
						   WHERE memories_fts MATCH ?
						   AND m.is_deleted = 0
						   LIMIT ?`;

					found = req.project
						? (db.prepare(baseQuery).all(ftsQuery, req.project, limit) as RecallRow[])
						: (db.prepare(baseQuery).all(ftsQuery, limit) as RecallRow[]);
				}
			} catch {
				// FTS not available, fall through to LIKE
			}

			// Fallback to LIKE search
			if (found.length === 0) {
				const likePattern = `%${req.query}%`;
				const baseQuery = req.project
					? `SELECT id, content, type, importance, tags, created_at
					   FROM memories
					   WHERE content LIKE ? AND is_deleted = 0 AND project = ?
					   ORDER BY importance DESC
					   LIMIT ?`
					: `SELECT id, content, type, importance, tags, created_at
					   FROM memories
					   WHERE content LIKE ? AND is_deleted = 0
					   ORDER BY importance DESC
					   LIMIT ?`;

				found = req.project
					? (db.prepare(baseQuery).all(likePattern, req.project, limit) as RecallRow[])
					: (db.prepare(baseQuery).all(likePattern, limit) as RecallRow[]);
			}

			return found;
		});

		// Update access tracking
		const ids = rows.map((r) => r.id);
		updateAccessTracking(ids);

		return { results: rows, count: rows.length };
	} catch (e) {
		logger.error("hooks", "Recall failed", e as Error);
		return { results: [], count: 0 };
	}
}

// ============================================================================
// Memory Synthesis
// ============================================================================

/**
 * Write MEMORY.md with backup of previous version.
 * Shared by the synthesis-complete endpoint and the synthesis worker.
 */
export function writeMemoryMd(
	content: string,
	opts?: {
		readonly agentId?: string;
		readonly owner?: string;
	},
): { ok: true } | { ok: false; error: string; code?: "busy" | "invalid" } {
	const result = writeMemoryHead(content, opts);
	if (result.ok) return { ok: true };
	logger.error("hooks", result.error, undefined, {
		agentId: opts?.agentId ?? "default",
		owner: opts?.owner,
	});
	return { ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) };
}

export function handleSynthesisRequest(
	req: SynthesisRequest,
	opts?: { maxTokens?: number; sinceTimestamp?: number; agentId?: string },
): SynthesisResponse {
	logger.info("hooks", "Synthesis request", { trigger: req.trigger });

	const _sinceTimestamp = opts?.sinceTimestamp ?? 0;
	const _maxTokens = opts?.maxTokens ?? 8000;
	void _sinceTimestamp;
	void _maxTokens;

	const rendered = renderMemoryProjection(opts?.agentId ?? "default");
	return {
		harness: "daemon",
		model: "projection",
		prompt: rendered.content,
		fileCount: rendered.fileCount,
		indexBlock: rendered.indexBlock,
	};
}
