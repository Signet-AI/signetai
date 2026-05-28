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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { cosineSimilarity, getAgentIdentityFiles, parseSimpleYaml } from "@signet/core";
import { ensureAgentRegistered, getAgentScope, resolveAgentId } from "./agent-id";
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
import { type ReadDb, getDbAccessor, hasDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { propagateMemoryStatus } from "./knowledge-graph";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import { writeMemoryHead } from "./memory-head";
import {
	NOISE_PURGE_REASON,
	appendSynthesisIndexBlock as appendRenderedIndexBlock,
	ensureCanonicalManifest,
	indexCanonicalTranscriptJsonl,
	purgeCanonicalNoiseSessionsOnce,
	renderMemoryProjection,
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
import { countTokens, truncateToTokens } from "./pipeline/tokenizer";
import { getDefaultPluginHost } from "./plugins/index";
import type { PluginPromptTargetV1 } from "./plugins/types";
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
import {
	type SessionMemoryCandidate,
	parseFeedback,
	recordAgentFeedback,
	recordSessionCandidates,
	trackFtsHits,
} from "./session-memories";
import { isNoiseSession } from "./session-noise";
import { claimRecallItems } from "./session-recall-dedupe";
import { getExpiryWarning } from "./session-tracker";
import {
	ensureCanonicalTranscriptHistory,
	getSessionTranscriptContent,
	upsertSessionTranscript,
} from "./session-transcripts";
import { type StructuralFeatures, getStructuralFeatures } from "./structural-features";
import { assembleInheritedContextBlock, resolveParentSession } from "./subagent-context";
import { isObject, isRenderError, isRenderResult } from "./synthesis-worker-protocol";
import { searchTemporalFallback } from "./temporal-fallback";
import { writeTranscriptAudit } from "./transcript-audit";
import {
	appendCanonicalTranscriptTurns,
	canonicalTranscriptRelativePath,
	inferTranscriptSourceFormat,
	writeCanonicalTranscriptSnapshot,
} from "./transcript-jsonl";
import { getUpdateSummary } from "./update-system";

// ---------------------------------------------------------------------------
// Synthesis render worker (node:worker_threads)
// ---------------------------------------------------------------------------

let synthesisWorker: Worker | null = null;

export function setSynthesisWorker(worker: Worker | null): void {
	synthesisWorker = worker;
}

export function getSynthesisWorker(): Worker | null {
	return synthesisWorker;
}

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getMemoryDbPath(): string {
	return join(getAgentsDir(), "memory", "memories.db");
}

const deferredSessionEndWork = new Set<Promise<void>>();

export async function flushDeferredSessionEndWorkForTests(): Promise<void> {
	await Promise.allSettled([...deferredSessionEndWork]);
}

async function writeCanonicalTranscriptFromSnapshot(params: {
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId?: string | null;
	readonly project?: string | null;
	readonly rawTranscript: string;
	readonly transcript: string;
	readonly capturedAt?: string;
	readonly transcriptPath?: string;
}): Promise<void> {
	await ensureCanonicalTranscriptHistory(getAgentsDir(), params.agentId);
	await writeCanonicalTranscriptSnapshot({
		basePath: getAgentsDir(),
		agentId: params.agentId,
		harness: params.harness,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		project: params.project ?? null,
		capturedAt: params.capturedAt,
		sourceFormat: params.rawTranscript ? inferTranscriptSourceFormat(params.rawTranscript) : "normalized",
		sourcePath: params.transcriptPath,
		transcript: params.transcript,
	});
}

async function appendCanonicalLiveTranscriptTurns(params: {
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string;
	readonly project?: string | null;
	readonly userMessage: string;
	readonly lastAssistantMessage?: string;
}): Promise<void> {
	await ensureCanonicalTranscriptHistory(getAgentsDir(), params.agentId);
	await appendCanonicalTranscriptTurns({
		basePath: getAgentsDir(),
		agentId: params.agentId,
		harness: params.harness,
		sessionKey: params.sessionKey,
		project: params.project ?? null,
		sourceFormat: "live",
		turns: [
			...(params.lastAssistantMessage ? [{ role: "assistant" as const, content: params.lastAssistantMessage }] : []),
			{ role: "user" as const, content: params.userMessage },
		],
	});
}

// ---------------------------------------------------------------------------
// Hook dedup state (in-memory, fail-open on restart)
// ---------------------------------------------------------------------------

/** Tracks which sessions have already received a full session-start inject. */
const sessionStartSeen = new Map<string, number>();
const SESSION_START_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionStartDedupeKey(req: {
	readonly harness?: string;
	readonly agentId?: string;
	readonly project?: string;
	readonly cwd?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
}): string | null {
	const sessionKey = req.sessionKey || req.sessionId;
	if (!sessionKey) return null;
	return [
		resolveAgentId({ agentId: req.agentId, sessionKey }),
		req.harness ?? "",
		req.project ?? req.cwd ?? "",
		sessionKey,
	].join("\0");
}

function pruneSessionStartSeen(now = Date.now()): void {
	for (const [sessionKey, seenAt] of sessionStartSeen.entries()) {
		if (now - seenAt > SESSION_START_SEEN_TTL_MS) sessionStartSeen.delete(sessionKey);
	}
}

export function resetSessionStartDedupe(req: {
	readonly harness?: string;
	readonly agentId?: string;
	readonly project?: string;
	readonly cwd?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
}): void {
	const key = sessionStartDedupeKey(req);
	if (key) sessionStartSeen.delete(key);
}

const DEFAULT_SESSION_START_MAX_INJECT_TOKENS = 12_000;
const PREDICTED_CONTEXT_TERM_LIMIT = 6;
const PREDICTED_CONTEXT_STOPWORDS: ReadonlySet<string> = new Set([
	"able",
	"about",
	"after",
	"again",
	"also",
	"back",
	"been",
	"before",
	"being",
	"check",
	"code",
	"could",
	"from",
	"have",
	"into",
	"issue",
	"just",
	"like",
	"more",
	"need",
	"only",
	"path",
	"should",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"time",
	"user",
	"want",
	"were",
	"what",
	"when",
	"where",
	"which",
	"with",
	"work",
	"would",
	"your",
]);

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

function harnessSupportsNamedCrossAgentTools(harness: string): boolean {
	return harness.trim().toLowerCase() === "codex";
}

function isPiHarness(harness: string): boolean {
	return harness.trim().toLowerCase() === "pi";
}

function sanitizePeerPromptField(value: string | undefined): string {
	if (!value) return "";
	return value
		.replace(/[\r\n`*#[\]<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSignetSystemPrompt(): string {
	return `[signet active]
You have persistent memory managed by Signet.

Memory Check Loop:
- when to use: before commands, file edits, architectural choices, bug fixes, continuation work, user-preference-sensitive answers, or anything that may depend on prior decisions
- procedure: check injected context first, then run 1-3 targeted recalls with mcp__signet__memory_search; shape recall queries as natural questions with an entity, event, and timeframe when possible; expand session lineage with mcp__signet__lcm_expand or known entities with mcp__signet__knowledge_expand and mcp__signet__knowledge_expand_session when needed
- pitfalls: avoid bag-of-keywords queries; do not treat a missing automatic memory match as proof no prior context exists; do not trust memory blindly when repo, files, or live system state can verify it; do not spam broad recalls for trivial self-contained prompts; treat graph expansion as supporting context, not proof
- verification: before acting, know what context you found, what remains unknown, and whether it is safe to proceed

Memory tools:
- mcp__signet__memory_search: search stored memories by keyword or meaning
- mcp__signet__lcm_expand: expand a session summary into its full lineage and linked memories
- mcp__signet__knowledge_expand: expand a known entity into its aspects, attributes, and dependencies
- mcp__signet__knowledge_expand_session: find sessions linked to a known entity
- mcp__signet__memory_store: save something to memory explicitly

Cross-session history:
- linked summary and transcript artifacts in your Signet workspace are inspectable across sessions
- use transcript and summary artifacts when you need deeper history than MEMORY.md or recall snippets provide

Identity files in your Signet workspace:
- AGENTS.md: how you operate (maintain this)
- SOUL.md: personality and values (maintain this)
- IDENTITY.md: who you are (maintain this)
- USER.md: who the user is (maintain this)
- MEMORY.md: auto-generated working memory summary (system-managed)

Secrets:
- mcp__signet__secret_list
- mcp__signet__secret_exec
Secrets are injected into subprocesses as environment variables and are not exposed as raw values.
`;
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
		maxInjectTokens?: number;
		/**
		 * @deprecated Renamed to `maxInjectTokens`. If set without `maxInjectTokens`,
		 * the value is auto-migrated using `Math.round(maxInjectChars / 4)` (~4 chars/token
		 * for ASCII; code or Unicode content may be 1–2 chars/token, so migrate explicitly.
		 */
		maxInjectChars?: number;
	};
	userPromptSubmit?: {
		/** Set to false to disable per-prompt entity-context injection entirely. Default: true. */
		enabled?: boolean;
		recallLimit?: number;
		maxInjectChars?: number;
		/** Minimum scoped attribute relevance required before injecting entity context. */
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
	/** Harness-native agent/sub-agent identifier. Not used for Signet data scoping. */
	harnessAgentId?: string;
	parentSessionKey?: string;
	parentKey?: string;
	parentId?: string;
	parentID?: string;
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
	keywordQuery?: string;
	project?: string;
	limit?: number;
	aggregate?: boolean;
	aggregateBudget?: "small" | "medium" | "large";
	aggregate_budget?: "small" | "medium" | "large";
	saveAggregate?: boolean;
	save_aggregate?: boolean;
	type?: string;
	tags?: string;
	who?: string;
	since?: string;
	until?: string;
	time?: {
		start?: string;
		end?: string;
		facets?: readonly string[];
		mode?: "auto" | "timeline" | "filter";
	};
	expand?: boolean;
	sessionKey?: string;
	agentId?: string;
	includeRecalled?: boolean;
	runtimePath?: "plugin" | "legacy";
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

function selectWithBudgetSkippingOversized<T extends { content: string }>(
	rows: ReadonlyArray<T>,
	charBudget: number,
): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.content.length > charBudget) continue;
		selected.push(row);
		used += row.content.length;
	}
	return selected;
}

/** Truncate rows to fit a token budget using BPE token counts. */
export function selectWithTokenBudget<T extends { content: string }>(rows: ReadonlyArray<T>, tokenBudget: number): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		const cost = countTokens(row.content);
		if (used + cost > tokenBudget) break;
		selected.push(row);
		used += cost;
	}
	return selected;
}

const TRUNCATED_MARKER = "\n[context truncated]";
const TRUNCATED_MARKER_TOKENS = countTokens(TRUNCATED_MARKER);

/**
 * Truncate `inject` to fit within `mainBudget` tokens.
 * Returns an empty string when budget is zero (reserved sections exhausted it).
 * Appends a truncation marker when budget permits; omits it when the budget is
 * too small to fit the marker itself (avoids overflow in that range).
 */
export function applyTokenBudget(inject: string, mainBudget: number): string {
	if (mainBudget <= 0) return "";
	if (countTokens(inject) <= mainBudget) return inject;
	// Budget too tight to fit content + marker — truncate without marker
	if (mainBudget <= TRUNCATED_MARKER_TOKENS) return truncateToTokens(inject, mainBudget);
	return truncateToTokens(inject, mainBudget - TRUNCATED_MARKER_TOKENS) + TRUNCATED_MARKER;
}

function buildPluginPromptContributionSection(target: PluginPromptTargetV1, log: typeof logger): string {
	try {
		const contributions = getDefaultPluginHost().promptContributions({ target });
		if (contributions.length === 0) return "";
		const parts = ["## Plugin Context", ""];
		for (const contribution of contributions) {
			parts.push(
				`<signet-plugin-context plugin="${contribution.pluginId}" id="${contribution.id}" target="${contribution.target}">`,
			);
			parts.push(contribution.content.trim());
			parts.push("</signet-plugin-context>");
			parts.push("");
		}
		return parts.join("\n").trimEnd();
	} catch (err) {
		log.warn("hooks", "Plugin prompt contribution lookup failed", {
			target,
			error: err instanceof Error ? err.message : String(err),
		});
		return "";
	}
}

type PromptEntityMatch = {
	readonly entityId: string;
	readonly entityName: string;
	readonly entityType: string;
	readonly description: string | null;
	readonly matchedText: string;
	readonly matchSource: "name" | "alias";
	readonly mentions: number;
};

type PromptEntityCandidate = PromptEntityMatch & {
	readonly normalizedPhrase: string;
	readonly spanStart: number;
	readonly spanEnd: number;
	readonly score: number;
};

type PromptEntityContextLine = {
	readonly entityName: string;
	readonly aspectName: string;
	readonly groupKey: string | null;
	readonly claimKey: string | null;
	readonly kind: "attribute" | "constraint";
	readonly content: string;
	readonly confidence: number;
	readonly importance: number;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly memoryId: string | null;
	readonly version: number;
};

type PromptEntityContextResult = {
	readonly lines: readonly string[];
	readonly memoryCount: number;
	readonly engine: "entity-context" | "low-signal" | "no-entity" | "no-aspect-hit";
};

const LOW_SIGNAL_PROMPTS = new Set([
	"cool",
	"got it",
	"go ahead",
	"great",
	"k",
	"kk",
	"nice",
	"ok",
	"okay",
	"okay cool",
	"sounds good",
	"sure",
	"thanks",
	"thank you",
	"yes",
	"yes please",
	"yep",
]);

const ENTITY_CONTEXT_MAX_ENTITIES = 2;
const ENTITY_CONTEXT_MAX_ASPECTS_PER_ENTITY = 3;
const ENTITY_CONTEXT_MAX_LINES = 8;
const MIN_PROMPT_ENTITY_MATCH_CHARS = 3;

function normalizePromptEntityText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/\b([a-z0-9]+)'s\b/g, "$1")
		.replace(/\b([a-z0-9]+)s'\b/g, "$1s")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function promptEntityTerms(value: string): string[] {
	const normalized = normalizePromptEntityText(value);
	return normalized.length > 0 ? normalized.split(" ") : [];
}

const PROMPT_BARE_POSSESSIVE_DENY_TERMS = new Set([
	"agent",
	"artifact",
	"concept",
	"connector",
	"document",
	"event",
	"memory",
	"policy",
	"preference",
	"product",
	"project",
	"skill",
	"source",
	"system",
	"task",
	"tool",
	"workflow",
]);

function promptEntityTermMatches(promptTerm: string, phraseTerm: string): boolean {
	return (
		promptTerm === phraseTerm ||
		(phraseTerm.length >= 4 && !PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(phraseTerm) && promptTerm === `${phraseTerm}s`)
	);
}

function promptPhraseSpan(prompt: string, phrase: string): { readonly start: number; readonly end: number } | null {
	const promptTerms = promptEntityTerms(prompt);
	const phraseTerms = promptEntityTerms(phrase);
	if (phraseTerms.join(" ").length < MIN_PROMPT_ENTITY_MATCH_CHARS) return null;
	if (phraseTerms.length === 0 || phraseTerms.length > promptTerms.length) return null;
	for (let start = 0; start <= promptTerms.length - phraseTerms.length; start += 1) {
		if (phraseTerms.every((term, offset) => promptEntityTermMatches(promptTerms[start + offset] ?? "", term))) {
			return { start, end: start + phraseTerms.length };
		}
	}
	return null;
}

function spansOverlap(
	a: { readonly start: number; readonly end: number },
	b: { readonly start: number; readonly end: number },
): boolean {
	return a.start < b.end && b.start < a.end;
}

function isLowSignalPrompt(userMessage: string): boolean {
	const normalized = normalizePromptEntityText(stripUntrustedMetadata(userMessage));
	if (normalized.length === 0) return true;
	if (LOW_SIGNAL_PROMPTS.has(normalized)) return true;
	const terms = extractSubstantiveWords(normalized);
	return terms.length === 0;
}

function entityContextTablesAvailable(db: ReadDb): boolean {
	const rows = db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name IN ('entities', 'entity_aspects', 'entity_attributes', 'entity_aliases')`,
		)
		.all() as Array<{ name: string }>;
	const names = new Set(rows.map((row) => row.name));
	return (
		names.has("entities") &&
		names.has("entity_aspects") &&
		names.has("entity_attributes") &&
		names.has("entity_aliases")
	);
}

const PROMPT_ENTITY_CONTEXT_ALLOWED_TYPES = new Set(["person", "project"]);
const PROMPT_ROLE_ENTITY_DENY_TERMS = new Set(["assistant", "human", "user"]);
const PROMPT_GENERIC_CONTEXT_QUERY_TERMS = new Set([
	"context",
	"contexts",
	"current",
	"prompt",
	"relevant",
	"view",
	"views",
]);

function isPromptEntityContextTypeAllowed(entityType: string): boolean {
	return PROMPT_ENTITY_CONTEXT_ALLOWED_TYPES.has(entityType.toLowerCase());
}

function isPromptGenericEntityPhrase(phraseTerms: readonly string[]): boolean {
	if (phraseTerms.length !== 1) return false;
	const term = phraseTerms[0] ?? "";
	if (PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(term)) return true;
	return term.endsWith("s") && PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(term.slice(0, -1));
}

function isPromptRoleEntity(row: {
	readonly entity_name: string;
	readonly matched_text: string;
	readonly pinned: number;
}): boolean {
	if (Math.min(Math.max(0, row.pinned), 1) > 0) return false;
	const entityTerms = promptEntityTerms(row.entity_name);
	const matchedTerms = promptEntityTerms(row.matched_text);
	if (entityTerms.length !== 1 || matchedTerms.length !== 1) return false;
	return (
		PROMPT_ROLE_ENTITY_DENY_TERMS.has(entityTerms[0] ?? "") && PROMPT_ROLE_ENTITY_DENY_TERMS.has(matchedTerms[0] ?? "")
	);
}

function isPromptBroadUncategorizedAttribute(row: {
	readonly aspect_name: string;
	readonly group_key: string | null;
	readonly claim_key: string | null;
}): boolean {
	return (
		normalizePromptEntityText(row.group_key ?? "general") === "general" &&
		normalizePromptEntityText(row.claim_key ?? "uncategorized") === "uncategorized"
	);
}

function isPromptGenericContextQuery(promptTerms: ReadonlyArray<string>): boolean {
	return promptTerms.length > 0 && promptTerms.every((term) => PROMPT_GENERIC_CONTEXT_QUERY_TERMS.has(term));
}

function scorePromptEntityCandidate(row: {
	readonly match_source: "name" | "alias";
	readonly matched_text: string;
	readonly mentions: number;
	readonly pinned: number;
}): number {
	const phrase = normalizePromptEntityText(row.matched_text);
	const phraseTerms = promptEntityTerms(row.matched_text);
	return (
		phraseTerms.length * 8 +
		phrase.length * 0.35 +
		Math.log1p(Math.max(0, row.mentions)) +
		Math.min(Math.max(0, row.pinned), 1) * 8 +
		(row.match_source === "alias" ? -0.25 : 0)
	);
}

function resolvePromptEntityMatches(db: ReadDb, agentId: string, userMessage: string): PromptEntityMatch[] {
	if (!entityContextTablesAvailable(db)) return [];
	const rows = db
		.prepare(
			`SELECT
			   e.id AS entity_id,
			   e.name AS entity_name,
			   COALESCE(e.entity_type, 'unknown') AS entity_type,
			   e.description AS description,
			   COALESCE(e.canonical_name, LOWER(e.name)) AS matched_text,
			   'name' AS match_source,
			   COALESCE(e.mentions, 0) AS mentions,
			   COALESCE(e.pinned, 0) AS pinned
			 FROM entities e
			 WHERE e.agent_id = ?
			   AND COALESCE(e.status, 'active') = 'active'
			 UNION ALL
			 SELECT
			   e.id AS entity_id,
			   e.name AS entity_name,
			   COALESCE(e.entity_type, 'unknown') AS entity_type,
			   e.description AS description,
			   a.alias AS matched_text,
			   'alias' AS match_source,
			   COALESCE(e.mentions, 0) AS mentions,
			   COALESCE(e.pinned, 0) AS pinned
			 FROM entity_aliases a
			 JOIN entities e ON e.id = a.entity_id AND e.agent_id = a.agent_id
			 WHERE a.agent_id = ?
			   AND a.status = 'active'
			   AND COALESCE(e.status, 'active') = 'active'`,
		)
		.all(agentId, agentId) as Array<{
		entity_id: string;
		entity_name: string;
		entity_type: string;
		description: string | null;
		matched_text: string;
		match_source: "name" | "alias";
		mentions: number;
		pinned: number;
	}>;

	const candidatesByPhrase = new Map<string, PromptEntityCandidate[]>();
	for (const row of rows) {
		if (!isPromptEntityContextTypeAllowed(row.entity_type)) continue;
		if (isPromptRoleEntity(row)) continue;
		if (isPromptGenericEntityPhrase(promptEntityTerms(row.matched_text))) continue;
		const span = promptPhraseSpan(userMessage, row.matched_text);
		if (!span) continue;
		const normalizedPhrase = normalizePromptEntityText(row.matched_text);
		const candidate: PromptEntityCandidate = {
			entityId: row.entity_id,
			entityName: row.entity_name,
			entityType: row.entity_type,
			description: row.description,
			matchedText: row.matched_text,
			matchSource: row.match_source,
			mentions: row.mentions,
			normalizedPhrase,
			spanStart: span.start,
			spanEnd: span.end,
			score: scorePromptEntityCandidate(row),
		};
		candidatesByPhrase.set(normalizedPhrase, [...(candidatesByPhrase.get(normalizedPhrase) ?? []), candidate]);
	}

	const phraseWinners = [...candidatesByPhrase.values()]
		.map(
			(candidates) =>
				[...candidates].sort(
					(a, b) =>
						b.score - a.score ||
						b.mentions - a.mentions ||
						b.normalizedPhrase.length - a.normalizedPhrase.length ||
						a.entityName.localeCompare(b.entityName),
				)[0],
		)
		.filter((candidate): candidate is PromptEntityCandidate => !!candidate);
	const topScore = phraseWinners.reduce((max, candidate) => Math.max(max, candidate.score), 0);
	const minimumScore = Math.max(12, topScore * 0.45);
	const ranked = phraseWinners
		.filter((candidate) => candidate.score >= minimumScore)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.spanEnd - b.spanStart - (a.spanEnd - a.spanStart) ||
				b.mentions - a.mentions ||
				a.entityName.localeCompare(b.entityName),
		);
	const seen = new Set<string>();
	const selectedSpans: Array<{ readonly start: number; readonly end: number }> = [];
	const result: PromptEntityMatch[] = [];
	for (const row of ranked) {
		if (seen.has(row.entityId)) continue;
		if (selectedSpans.some((span) => spansOverlap(span, { start: row.spanStart, end: row.spanEnd }))) continue;
		seen.add(row.entityId);
		selectedSpans.push({ start: row.spanStart, end: row.spanEnd });
		result.push({
			entityId: row.entityId,
			entityName: row.entityName,
			entityType: row.entityType,
			description: row.description,
			matchedText: row.matchedText,
			matchSource: row.matchSource,
			mentions: row.mentions,
		});
		if (result.length >= ENTITY_CONTEXT_MAX_ENTITIES) break;
	}
	return result;
}

type PromptAttributeCandidate = PromptEntityContextLine & {
	readonly attributeId: string;
	readonly aspectId: string;
	readonly memoryId: string | null;
	readonly score: number;
};

function queryWithoutPromptEntities(userMessage: string, entities: ReadonlyArray<PromptEntityMatch>): string {
	const entityTerms = new Set(
		entities.flatMap((entity) => extractSubstantiveWords(`${entity.entityName} ${entity.matchedText}`)),
	);
	return extractSubstantiveWords(userMessage)
		.filter((term) => ![...entityTerms].some((entityTerm) => promptEntityTermMatches(term, entityTerm)))
		.join(" ");
}

function scoreAttributeLexically(
	row: { readonly content: string; readonly confidence: number; readonly importance: number },
	promptTerms: ReadonlyArray<string>,
): number {
	if (promptTerms.length === 0) return 0;
	if (countPromptTermOverlap(row.content, promptTerms) === 0) return 0;
	return Math.min(1, 0.72 + Math.min(row.importance, 1) * 0.18 + Math.min(row.confidence, 1) * 0.1);
}

function loadAttributeSemanticScores(
	db: ReadDb,
	agentId: string,
	rows: ReadonlyArray<{ readonly attributeId: string; readonly memoryId: string | null }>,
	queryVector: Float32Array | null,
): Map<string, number> {
	if (!queryVector) return new Map();
	const memoryIds = [...new Set(rows.map((row) => row.memoryId).filter((id): id is string => !!id))];
	if (memoryIds.length === 0) return new Map();
	const placeholders = memoryIds.map(() => "?").join(", ");
	const embeddings = db
		.prepare(
			`SELECT source_id, vector
			 FROM embeddings
			 WHERE source_type = 'memory'
			   AND source_id IN (${placeholders})
			   AND agent_id = ?
			   AND dimensions = ?
			   AND vector IS NOT NULL`,
		)
		.all(...memoryIds, agentId, queryVector.length) as Array<{ source_id: string; vector: Buffer }>;
	const scoreByMemoryId = new Map<string, number>();
	for (const embedding of embeddings) {
		const vector = new Float32Array(
			embedding.vector.buffer,
			embedding.vector.byteOffset,
			embedding.vector.byteLength / 4,
		);
		scoreByMemoryId.set(
			embedding.source_id,
			Math.max(scoreByMemoryId.get(embedding.source_id) ?? 0, cosineSimilarity(queryVector, vector)),
		);
	}
	return new Map(
		rows
			.map((row) => [row.attributeId, row.memoryId ? (scoreByMemoryId.get(row.memoryId) ?? 0) : 0] as const)
			.filter(([, score]) => score > 0),
	);
}

function loadEntityContextLines(
	db: ReadDb,
	entity: PromptEntityMatch,
	agentId: string,
	semanticQuery: string,
	minScore: number,
	queryVector: Float32Array | null,
): PromptEntityContextLine[] {
	const promptTerms = extractSubstantiveWords(semanticQuery);
	if (promptTerms.length === 0) return [];
	const candidateRows = db
		.prepare(
			`SELECT
			   ea.id AS attribute_id,
			   asp.id AS aspect_id,
			   asp.name AS aspect_name,
			   ea.kind,
			   ea.content,
			   ea.group_key,
			   ea.claim_key,
			   ea.confidence,
			   ea.importance,
			   ea.source_kind,
			   ea.source_id,
			   ea.source_path,
			   ea.memory_id,
			   COALESCE(ea.version, 1) AS version
			 FROM entity_aspects asp
			 JOIN entity_attributes ea ON ea.aspect_id = asp.id
			 WHERE asp.entity_id = ?
			   AND asp.agent_id = ?
			   AND COALESCE(asp.status, 'active') = 'active'
			   AND ea.agent_id = ?
			   AND ea.status = 'active'
			   AND ea.superseded_by IS NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM entity_attributes newer
			     WHERE newer.aspect_id = ea.aspect_id
			       AND newer.agent_id = ea.agent_id
			       AND newer.kind = ea.kind
			       AND COALESCE(newer.group_key, 'general') = COALESCE(ea.group_key, 'general')
			       AND newer.claim_key = ea.claim_key
			       AND newer.status = 'active'
			       AND newer.superseded_by IS NULL
			       AND COALESCE(newer.version, 1) > COALESCE(ea.version, 1)
			   )
			 ORDER BY ea.importance DESC, ea.updated_at DESC
			 LIMIT 48`,
		)
		.all(entity.entityId, agentId, agentId) as Array<{
		attribute_id: string;
		aspect_id: string;
		aspect_name: string;
		kind: "attribute" | "constraint";
		content: string;
		group_key: string | null;
		claim_key: string | null;
		confidence: number;
		importance: number;
		source_kind: string | null;
		source_id: string | null;
		source_path: string | null;
		memory_id: string | null;
		version: number;
	}>;
	const semanticScores = loadAttributeSemanticScores(
		db,
		agentId,
		candidateRows
			.filter((row) => !isPromptBroadUncategorizedAttribute(row))
			.map((row) => ({ attributeId: row.attribute_id, memoryId: row.memory_id })),
		queryVector,
	);
	const genericContextQuery = isPromptGenericContextQuery(promptTerms);
	const candidates: PromptAttributeCandidate[] = candidateRows
		.filter((row) => !isPromptBroadUncategorizedAttribute(row))
		.map((row) => {
			const lexicalScore = scoreAttributeLexically(row, promptTerms);
			const semanticScore = semanticScores.get(row.attribute_id) ?? 0;
			return {
				attributeId: row.attribute_id,
				aspectId: row.aspect_id,
				entityName: entity.entityName,
				aspectName: row.aspect_name,
				groupKey: row.group_key,
				claimKey: row.claim_key,
				kind: row.kind,
				content: row.content,
				confidence: row.confidence,
				importance: row.importance,
				sourceKind: row.source_kind,
				sourceId: row.source_id,
				sourcePath: row.source_path,
				memoryId: row.memory_id,
				version: row.version,
				score: genericContextQuery && lexicalScore === 0 ? 0 : Math.max(semanticScore, lexicalScore),
			};
		})
		.filter((row) => row.score >= minScore)
		.sort((a, b) => b.score - a.score || b.importance - a.importance);
	const selectedAspectIds = new Set<string>();
	const selectedAttributeIds = new Set<string>();
	for (const candidate of candidates) {
		selectedAspectIds.add(candidate.aspectId);
		selectedAttributeIds.add(candidate.attributeId);
		if (selectedAspectIds.size >= ENTITY_CONTEXT_MAX_ASPECTS_PER_ENTITY) break;
	}
	if (selectedAspectIds.size === 0) return [];
	const placeholders = [...selectedAspectIds].map(() => "?").join(", ");
	const attributePlaceholders = [...selectedAttributeIds].map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT
			   asp.name AS aspect_name,
			   ea.kind,
			   ea.content,
			   ea.group_key,
			   ea.claim_key,
			   ea.confidence,
			   ea.importance,
			   ea.source_kind,
			   ea.source_id,
			   ea.source_path,
			   ea.memory_id,
			   COALESCE(ea.version, 1) AS version
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 WHERE ea.aspect_id IN (${placeholders})
			   AND ea.id IN (${attributePlaceholders})
			   AND ea.agent_id = ?
			   AND ea.status = 'active'
			   AND ea.superseded_by IS NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM entity_attributes newer
			     WHERE newer.aspect_id = ea.aspect_id
			       AND newer.agent_id = ea.agent_id
			       AND newer.kind = ea.kind
			       AND COALESCE(newer.group_key, 'general') = COALESCE(ea.group_key, 'general')
			       AND newer.claim_key = ea.claim_key
			       AND newer.status = 'active'
			       AND newer.superseded_by IS NULL
			       AND COALESCE(newer.version, 1) > COALESCE(ea.version, 1)
			   )
			 ORDER BY
			   CASE ea.kind WHEN 'constraint' THEN 0 ELSE 1 END,
			   ea.importance DESC,
			   ea.updated_at DESC
			 LIMIT ?`,
		)
		.all(...selectedAspectIds, ...selectedAttributeIds, agentId, ENTITY_CONTEXT_MAX_LINES) as Array<{
		aspect_name: string;
		kind: "attribute" | "constraint";
		content: string;
		group_key: string | null;
		claim_key: string | null;
		confidence: number;
		importance: number;
		source_kind: string | null;
		source_id: string | null;
		source_path: string | null;
		memory_id: string | null;
		version: number;
	}>;
	return rows
		.filter((row) => !isPromptBroadUncategorizedAttribute(row))
		.map((row) => ({
			entityName: entity.entityName,
			aspectName: row.aspect_name,
			groupKey: row.group_key,
			claimKey: row.claim_key,
			kind: row.kind,
			content: row.content,
			confidence: row.confidence,
			importance: row.importance,
			sourceKind: row.source_kind,
			sourceId: row.source_id,
			sourcePath: row.source_path,
			memoryId: row.memory_id,
			version: row.version,
		}));
}

function formatEntityContextLine(line: PromptEntityContextLine): string {
	const path = [line.entityName, line.aspectName, line.groupKey ?? "general", line.claimKey ?? "uncategorized"].join(
		" / ",
	);
	const source =
		line.sourceKind && line.sourceId
			? `${line.sourceKind}:${line.sourceId}`
			: line.memoryId
				? `memory:${line.memoryId}`
				: line.sourcePath
					? line.sourcePath
					: `v${line.version}`;
	return `- [${line.kind}] ${path}: ${line.content} (${source})`;
}

async function buildEntityPromptContext(
	userMessage: string,
	agentId: string,
	minScore: number,
	injectBudget: number,
	embedFn: typeof fetchEmbedding,
	embeddingCfg: Parameters<typeof fetchEmbedding>[1],
): Promise<PromptEntityContextResult> {
	if (isLowSignalPrompt(userMessage)) return { lines: [], memoryCount: 0, engine: "low-signal" };
	if (!existsSync(getMemoryDbPath())) return { lines: [], memoryCount: 0, engine: "no-entity" };
	if (!hasDbAccessor()) return { lines: [], memoryCount: 0, engine: "no-entity" };
	const matches = getDbAccessor().withReadDb((db) => resolvePromptEntityMatches(db, agentId, userMessage));
	if (matches.length === 0) return { lines: [], memoryCount: 0, engine: "no-entity" };

	const vectorsByEntity = new Map<
		string,
		{ readonly semanticQuery: string; readonly queryVector: Float32Array | null }
	>();
	const sharedSemanticQuery = queryWithoutPromptEntities(userMessage, matches);
	for (const entity of matches) {
		const semanticQuery = sharedSemanticQuery;
		if (!semanticQuery) continue;
		let queryVector: Float32Array | null = null;
		try {
			const vector = await embedFn(semanticQuery, embeddingCfg);
			if (vector) queryVector = new Float32Array(vector);
		} catch (error) {
			logger.warn("hooks", "Entity attribute semantic scoring failed; using lexical attribute scoring", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		vectorsByEntity.set(entity.entityId, { semanticQuery, queryVector });
	}
	if (vectorsByEntity.size === 0) return { lines: [], memoryCount: 0, engine: "no-aspect-hit" };
	return getDbAccessor().withReadDb((db) => {
		const lines = matches.flatMap((entity) =>
			loadEntityContextLines(
				db,
				entity,
				agentId,
				vectorsByEntity.get(entity.entityId)?.semanticQuery ?? "",
				minScore,
				vectorsByEntity.get(entity.entityId)?.queryVector ?? null,
			),
		);
		if (lines.length === 0) return { lines: [], memoryCount: 0, engine: "no-aspect-hit" };
		const selected = selectWithBudgetSkippingOversized(
			lines.map((line) => ({ content: formatEntityContextLine(line) })),
			injectBudget,
		).slice(0, ENTITY_CONTEXT_MAX_LINES);
		return {
			lines: selected.map((line) => line.content),
			memoryCount: selected.length,
			engine: selected.length > 0 ? "entity-context" : "no-aspect-hit",
		};
	});
}

function buildEntityContextInject(metadataHeader: string, lines: ReadonlyArray<string>, pluginContext = ""): string {
	const parts = [metadataHeader.trimEnd(), "", "## Relevant Entity Context", ""];
	if (pluginContext.trim().length > 0) {
		parts.push(pluginContext.trimEnd());
		parts.push("");
	}
	parts.push(...lines);
	return `${parts.join("\n").trimEnd()}\n`;
}

/** Build a brief "since your last session" summary for temporal awareness */
function getSessionGapSummary(): string | undefined {
	if (!existsSync(getMemoryDbPath())) return undefined;

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
export function isDuplicate(db: Database, content: string, agentId: string): boolean {
	const words = content
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length >= 3);
	if (words.length === 0) return false;

	try {
		const ftsQuery = words.slice(0, 10).join(" OR ");
		const rows = db
			.prepare(
				`SELECT m.content
				 FROM memories_fts
				 JOIN memories m ON memories_fts.rowid = m.rowid
				 WHERE memories_fts MATCH ?
				   AND m.is_deleted = 0
				   AND m.agent_id = ?
				 LIMIT 10`,
			)
			.all(ftsQuery, agentId) as Array<{ content: string }>;

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

type IdentityFileMap = Record<string, string>;

function readIdentityPath(filePath: string | undefined, charBudget: number): string | undefined {
	if (!filePath || !existsSync(filePath)) return undefined;

	try {
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return undefined;
		if (content.length <= charBudget) return content;
		return `${content.slice(0, charBudget)}\n[truncated]`;
	} catch {
		return undefined;
	}
}

function readIdentityFile(fileName: string, charBudget: number, identityFiles?: IdentityFileMap): string | undefined {
	return readIdentityPath(identityFiles?.[fileName] ?? join(getAgentsDir(), fileName), charBudget);
}

function readMemoryMd(charBudget: number, identityFiles?: IdentityFileMap): string | undefined {
	return readIdentityFile("MEMORY.md", charBudget, identityFiles);
}

function readAgentsMd(charBudget: number, identityFiles?: IdentityFileMap): string | undefined {
	return readIdentityFile("AGENTS.md", charBudget, identityFiles);
}

function resolveIdentityFiles(agentId: string): IdentityFileMap {
	if (!agentId || agentId === "default") return {};
	return getAgentIdentityFiles(agentId, getAgentsDir());
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
	if (memoryIds.length === 0 || !existsSync(getMemoryDbPath())) return [];

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
	if (!existsSync(getMemoryDbPath())) return [];

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
	if (!existsSync(getMemoryDbPath())) return [];
	if (!project || project.trim().length === 0) return [];

	try {
		// Get recent session summaries for this project only. Global predictive
		// FTS is too broad for session-start latency on large memory stores.
		const summaryRows = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT transcript FROM summary_jobs
					 WHERE project = ? AND status = 'completed' AND agent_id = ?
					 ORDER BY created_at DESC LIMIT 5`,
				)
				.all(project, agentId) as Array<{ transcript: string }>;
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
				.filter((w) => w.length >= 4 && !PREDICTED_CONTEXT_STOPWORDS.has(w));
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
			.slice(0, PREDICTED_CONTEXT_TERM_LIMIT)
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
						   AND m.project = ?
						   ${scope.sql}
						 ORDER BY bm25(memories_fts)
						 LIMIT ?`,
					)
					.all(ftsQuery, project, ...scope.args, limit * 2) as Array<{
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
	if (ids.length === 0 || !existsSync(getMemoryDbPath())) return;

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
	const configPath = join(getAgentsDir(), "agent.yaml");
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
			maxInjectTokens: DEFAULT_SESSION_START_MAX_INJECT_TOKENS,
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

function parseIdentityMarkdown(content: string): { name: string; description?: string } {
	const nameMatch = content.match(/name:\s*(.+)/i);
	const youAreMatch = content.match(/(?:^|\n)\s*(?:#+\s*)?you are\s+([^\n.]+)\.?/i);
	const descMatch = content.match(/creature:\s*(.+)/i) || content.match(/role:\s*(.+)/i);

	return {
		name: (nameMatch?.[1] ?? youAreMatch?.[1] ?? "Agent").trim(),
		description: descMatch?.[1]?.trim(),
	};
}

function loadIdentity(identityFiles?: IdentityFileMap): { name: string; description?: string } {
	const identityMd = identityFiles?.["IDENTITY.md"];
	if (identityMd && existsSync(identityMd)) {
		try {
			return parseIdentityMarkdown(readFileSync(identityMd, "utf-8"));
		} catch {}
	}

	const agentYaml = join(getAgentsDir(), "agent.yaml");
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

	const rootIdentityMd = join(getAgentsDir(), "IDENTITY.md");
	if (existsSync(rootIdentityMd)) {
		try {
			return parseIdentityMarkdown(readFileSync(rootIdentityMd, "utf-8"));
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
	if (!existsSync(getMemoryDbPath())) return [];

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
	if (!existsSync(getMemoryDbPath())) return [];

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
	const agentId = resolveAgentId(req);
	ensureAgentRegistered(agentId);
	const config = loadHooksConfig().sessionStart || {};
	const includeIdentity = config.includeIdentity !== false;

	logger.info("hooks", "Session start hook", {
		harness: req.harness,
		project: req.project,
	});

	// Dedup guard: if we already sent a full inject for this session, return
	// a minimal stub. Identity files / MEMORY.md are already in the context.
	// Must fire BEFORE initContinuity to avoid resetting accumulated state.
	pruneSessionStartSeen();
	const dedupeKey = sessionStartDedupeKey(req);
	if (dedupeKey && sessionStartSeen.has(dedupeKey)) {
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

	const identityFiles = resolveIdentityFiles(agentId);
	const identity = includeIdentity ? loadIdentity(identityFiles) : { name: "Agent" };

	// Read AGENTS.md first so harness instructions precede synthesized memory
	const agentsMdContent = includeIdentity ? readAgentsMd(12000, identityFiles) : undefined;

	// Read MEMORY.md with 10k char budget
	const memoryMdContent = readMemoryMd(10000, identityFiles);

	const memoryCfg = loadMemoryConfig(getAgentsDir());
	const traversalCfg = memoryCfg.pipelineV2.traversal;
	const traversalEnabled = memoryCfg.pipelineV2.graph.enabled && traversalCfg?.enabled === true;
	const traversalAgentId = agentId;
	const agentScope = getAgentScope(traversalAgentId);
	let inheritedSection = "";
	if (req.sessionKey && existsSync(getMemoryDbPath())) {
		try {
			const subagentCfg = memoryCfg.pipelineV2.subagents ?? { inheritContext: true, tailChars: 3000 };
			const block = getDbAccessor().withReadDb((db) => {
				const parent = resolveParentSession(db, {
					harness: req.harness,
					project: req.project,
					sessionKey: req.sessionKey,
					agentId: traversalAgentId,
					harnessAgentId: req.harnessAgentId,
					parentSessionKey: req.parentSessionKey,
					parentKey: req.parentKey,
					parentId: req.parentId,
					parentID: req.parentID,
				});
				return parent ? assembleInheritedContextBlock(db, parent, subagentCfg) : null;
			});
			inheritedSection = block ?? "";
		} catch (error) {
			logger.warn("hooks", "Sub-agent inherited context lookup failed (non-fatal)", {
				error: error instanceof Error ? error.message : String(error),
				harness: req.harness,
				sessionKey: req.sessionKey,
			});
		}
	}
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
	const candidateSourceById = new Map<string, SessionMemoryCandidate["source"]>(
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
	// Baseline ranking
	// ---------------------------------------------------------------
	const dbAcc = loadDbAccessor();
	const candidateIdsForFeatures = mergedCandidates.map((c) => c.id);
	const structuralById = dbAcc
		? getStructuralFeatures(dbAcc, candidateIdsForFeatures, agentId, candidateSourceById)
		: new Map<string, StructuralFeatures>();
	const sortedCandidates = [...mergedCandidates].sort((a, b) => {
		if (req.project) {
			const aMatch = a.project === req.project ? 1 : 0;
			const bMatch = b.project === req.project ? 1 : 0;
			if (aMatch !== bMatch) return bMatch - aMatch;
		}
		return b.effScore - a.effScore;
	});
	const rankedById = new Map(
		mergedCandidates.map((candidate) => [
			candidate.id,
			{ predictorScore: null as number | null, predictorRank: null as number | null, fusedScore: candidate.effScore },
		]),
	);

	// Apply budget to select what we actually inject (on re-ranked order)
	if (config.maxInjectChars !== undefined && config.maxInjectTokens === undefined) {
		logger.warn(
			"hooks",
			"hooks.sessionStart.maxInjectChars is deprecated — migrating to maxInjectTokens automatically. Rename it in agent.yaml to silence this warning.",
			{ maxInjectChars: config.maxInjectChars, derivedTokens: Math.round(config.maxInjectChars / 4) },
		);
	}
	const rawTokenBudget =
		config.maxInjectTokens ??
		(config.maxInjectChars ? Math.round(config.maxInjectChars / 4) : DEFAULT_SESSION_START_MAX_INJECT_TOKENS);
	if (rawTokenBudget <= 0) {
		logger.warn("hooks", "maxInjectTokens must be positive — clamping to 1", {
			configured: rawTokenBudget,
		});
	}
	const tokenBudget = Math.max(1, rawTokenBudget);
	let memories = selectWithTokenBudget(sortedCandidates, tokenBudget);

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

	if (req.sessionKey && memories.length > 0) {
		memories = claimRecallItems({
			sessionKey: req.sessionKey,
			agentId,
			surface: "api.hooks.session-start",
			mode: "automatic",
			items: memories,
		}).items;
	}

	const exploredId: string | null = null;

	// Update access tracking for served memories
	const servedIds = memories.map((m) => m.id);
	updateAccessTracking(servedIds);

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

	injectParts.push(buildSignetSystemPrompt());
	const systemPluginContext = buildPluginPromptContributionSection("system", logger);
	if (systemPluginContext) {
		injectParts.push(systemPluginContext);
	}
	injectParts.push("[memory active | /remember | /recall]");

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
	const soulContent = includeIdentity ? readIdentityFile("SOUL.md", 4000, identityFiles) : undefined;
	const identityContent = includeIdentity ? readIdentityFile("IDENTITY.md", 2000, identityFiles) : undefined;
	const userContent = includeIdentity ? readIdentityFile("USER.md", 6000, identityFiles) : undefined;

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

	const sessionPluginContext = buildPluginPromptContributionSection("session-start", logger);
	if (sessionPluginContext) {
		injectParts.push(sessionPluginContext);
	}

	// Surface available secrets so agents know what's available
	try {
		const secretNames = await listSecrets();
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
	const maxTokens = config.maxInjectTokens ?? (config.maxInjectChars ? Math.round(config.maxInjectChars / 4) : 20000);
	// Pre-reserve space for deterministic continuity sections so they are never truncated.
	const reservedTokens = countTokens(recoverySection) + countTokens(constraintsSection) + countTokens(inheritedSection);
	const mainBudget = Math.max(0, maxTokens - reservedTokens);
	let inject = injectParts.join("\n");
	if (mainBudget === 0) {
		logger.warn("hooks", "Session-start reserved sections exhaust token budget — main inject cleared", {
			maxTokens,
			reservedTokens,
		});
	}
	inject = applyTokenBudget(inject, mainBudget);
	if (constraintsSection) {
		inject += constraintsSection;
	}
	if (inheritedSection) {
		inject += inheritedSection;
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
		injectTokens: countTokens(inject),
		injectChars: inject.length,
		durationMs: duration,
	});

	// Mark this session as having received the full inject
	if (dedupeKey) {
		sessionStartSeen.set(dedupeKey, Date.now());
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
			const cfg = loadMemoryConfig(getAgentsDir()).pipelineV2.continuity;
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

function countPromptTermOverlap(text: string, promptTerms: ReadonlyArray<string>): number {
	if (promptTerms.length === 0) return 0;
	const hay = new Set(extractSubstantiveWords(text));
	let overlap = 0;
	for (const term of promptTerms) {
		if (hay.has(term)) overlap++;
	}
	return overlap;
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
	log: typeof logger,
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

	log.info("hooks", "User prompt submit", {
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

type UserPromptSubmitDeps = {
	readonly logger: typeof logger;
	readonly loadMemoryConfig: typeof loadMemoryConfig;
	readonly resolveAgentId: typeof resolveAgentId;
	readonly getAgentScope: typeof getAgentScope;
	readonly parseFeedback: typeof parseFeedback;
	readonly recordAgentFeedback: typeof recordAgentFeedback;
	readonly recordPrompt: typeof recordPrompt;
	readonly shouldCheckpoint: typeof shouldCheckpoint;
	readonly consumeState: typeof consumeState;
	readonly queueCheckpointWrite: typeof queueCheckpointWrite;
	readonly formatPeriodicDigest: typeof formatPeriodicDigest;
	readonly upsertSessionTranscript: typeof upsertSessionTranscript;
	readonly getExpiryWarning: typeof getExpiryWarning;
	readonly hybridRecall: typeof hybridRecall;
	readonly fetchEmbedding: typeof fetchEmbedding;
	readonly searchTemporalFallback: typeof searchTemporalFallback;
	readonly trackFtsHits: typeof trackFtsHits;
};

const DEFAULT_USER_PROMPT_SUBMIT_DEPS: UserPromptSubmitDeps = {
	logger,
	loadMemoryConfig,
	resolveAgentId,
	getAgentScope,
	parseFeedback,
	recordAgentFeedback,
	recordPrompt,
	shouldCheckpoint,
	consumeState,
	queueCheckpointWrite,
	formatPeriodicDigest,
	upsertSessionTranscript,
	getExpiryWarning,
	hybridRecall,
	fetchEmbedding,
	searchTemporalFallback,
	trackFtsHits,
};

export async function handleUserPromptSubmit(
	req: UserPromptSubmitRequest,
	overrides?: Partial<UserPromptSubmitDeps>,
): Promise<UserPromptSubmitResponse> {
	const deps = { ...DEFAULT_USER_PROMPT_SUBMIT_DEPS, ...overrides };
	const start = Date.now();
	const submitCfg = loadHooksConfig().userPromptSubmit ?? {};
	const userMessage = resolveRecallUserMessage(req);
	const agentId = deps.resolveAgentId(req);
	const { keywordTerms } = buildRecallQueryShape(userMessage);

	// -- Parse and accumulate incoming agent feedback (from previous prompt) --
	const memoryCfg = deps.loadMemoryConfig(getAgentsDir());
	const feedbackEnabled = memoryCfg.pipelineV2.feedback.enabled;
	if (feedbackEnabled && req.memory_feedback !== undefined && req.sessionKey) {
		try {
			const parsed = deps.parseFeedback(req.memory_feedback);
			if (parsed) {
				deps.recordAgentFeedback(req.sessionKey, parsed, deps.resolveAgentId(req));
			} else {
				deps.logger.warn("hooks", "Invalid memory_feedback format, skipping", {
					sessionKey: req.sessionKey,
				});
			}
		} catch (e) {
			// Fail-open: never break the hook for feedback errors
			deps.logger.warn("hooks", "Failed to process memory_feedback", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Always record the prompt for continuity tracking, even if no FTS query
	const snippet = userMessage.slice(0, 200).trim();
	deps.recordPrompt(
		req.sessionKey,
		keywordTerms.length > 0 ? keywordTerms.join(" ") : undefined,
		snippet.length > 0 ? snippet : undefined,
	);
	{
		const cfg = deps.loadMemoryConfig(getAgentsDir()).pipelineV2.continuity;
		if (deps.shouldCheckpoint(req.sessionKey, cfg)) {
			const snap = deps.consumeState(req.sessionKey);
			if (snap) {
				deps.queueCheckpointWrite(
					{
						sessionKey: snap.sessionKey,
						harness: snap.harness,
						project: snap.project,
						projectNormalized: snap.projectNormalized,
						trigger: "periodic",
						digest: deps.formatPeriodicDigest(snap),
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
		let rawTranscript = "";
		let transcript = "";
		if (req.transcriptPath && existsSync(req.transcriptPath)) {
			try {
				rawTranscript = readFileSync(req.transcriptPath, "utf-8");
				transcript = normalizeSessionTranscript(req.harness, rawTranscript);
			} catch {
				deps.logger.warn("hooks", "Could not read prompt transcript", {
					path: req.transcriptPath,
				});
			}
		} else if (req.transcript) {
			rawTranscript = req.transcript;
			transcript = normalizeSessionTranscript(req.harness, rawTranscript);
		}

		if (transcript) {
			try {
				const prev = getSessionTranscriptContent(req.sessionKey, agentId);
				if (!prev || transcript.length >= prev.length) {
					deps.upsertSessionTranscript(req.sessionKey, transcript, req.harness, req.project ?? null, agentId);
				}
				await writeCanonicalTranscriptFromSnapshot({
					agentId,
					harness: req.harness,
					sessionKey: req.sessionKey,
					project: req.project ?? null,
					rawTranscript,
					transcript,
					transcriptPath: req.transcriptPath,
				});
			} catch (error) {
				deps.logger.warn("hooks", "Prompt transcript write failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else if (userMessage.trim().length > 0) {
			try {
				await appendCanonicalLiveTranscriptTurns({
					agentId,
					harness: req.harness,
					sessionKey: req.sessionKey,
					project: req.project ?? null,
					userMessage,
					lastAssistantMessage: req.lastAssistantMessage,
				});
			} catch (error) {
				deps.logger.warn("hooks", "Prompt JSONL transcript append failed", {
					error: error instanceof Error ? error.message : String(error),
					sessionKey: req.sessionKey,
				});
			}
		}

		if (rawTranscript) {
			try {
				writeTranscriptAudit({
					basePath: getAgentsDir(),
					agentId,
					sessionId: req.sessionKey,
					sessionKey: req.sessionKey,
					rawTranscript,
				});
			} catch (error) {
				deps.logger.warn("hooks", "Prompt transcript audit write failed", {
					error: error instanceof Error ? error.message : String(error),
					sessionKey: req.sessionKey,
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
	const expiryWarning = req.sessionKey ? deps.getExpiryWarning(req.sessionKey) : null;
	const warnings = expiryWarning ? [expiryWarning] : undefined;

	if (submitCfg.enabled === false) {
		return finalizeUserPromptSubmitSuccess(
			req,
			userMessage,
			start,
			{
				inject: "",
				memoryCount: 0,
				warnings,
			},
			deps.logger,
			"disabled",
		);
	}

	try {
		const cfg = deps.loadMemoryConfig(getAgentsDir());
		const injectBudget = submitCfg.maxInjectChars ?? cfg.pipelineV2.guardrails.contextBudgetChars;
		const entityContext = await buildEntityPromptContext(
			userMessage,
			agentId,
			resolveUserPromptMinScore(submitCfg.minScore),
			injectBudget,
			deps.fetchEmbedding,
			cfg.embedding,
		);
		if (entityContext.lines.length === 0) {
			return finalizeUserPromptSubmitSuccess(
				req,
				userMessage,
				start,
				{
					inject: "",
					memoryCount: 0,
					queryTerms: keywordTerms.join(" ") || undefined,
					engine: entityContext.engine,
					warnings,
				},
				deps.logger,
			);
		}
		const pluginContext = buildPluginPromptContributionSection("user-prompt-submit", deps.logger);
		return finalizeUserPromptSubmitSuccess(
			req,
			userMessage,
			start,
			{
				inject: buildEntityContextInject(metadataHeader, entityContext.lines, pluginContext),
				memoryCount: entityContext.memoryCount,
				queryTerms: keywordTerms.join(" ") || undefined,
				engine: "entity-context",
				warnings,
			},
			deps.logger,
		);
	} catch (e) {
		deps.logger.error("hooks", "User prompt submit failed", e as Error);
		return {
			inject: "",
			memoryCount: 0,
			warnings,
		};
	}
}

// ============================================================================
// Session End
// ============================================================================

// Session keys can be shared across distinct harness runs (for example
// recurring heartbeat sessions), so artifact lineage needs a more specific
// fallback identifier when the harness does not supply sessionId.
export function deriveSessionEndFallbackId(
	sessionKey: string | undefined,
	transcriptPath: string | undefined,
	transcript: string,
): string {
	const scopedKey = sessionKey?.trim() || "anonymous";
	const path = transcriptPath?.trim();
	const body = transcript.trim();
	if (path) {
		// Include a content digest so rotating log files that reuse the same
		// path across distinct sessions produce different IDs.
		// Note: sessions with identical path AND identical content will
		// intentionally deduplicate — writeImmutableArtifact returns the
		// existing artifact path when the content hash matches, so this is
		// a graceful no-op rather than an error.
		if (body.length > 0) {
			const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
			return `session-end:path:${path}:${digest}`;
		}
		// Intentionally non-idempotent: without transcript content there is no
		// stable material to hash, so each call produces a unique ID.  This
		// prevents two empty-body session-end calls from colliding but means
		// retries will create distinct artifacts rather than deduplicating.
		return `session-end:path:${path}:${randomUUID()}`;
	}
	if (body.length > 0) {
		const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
		return `session-end:${scopedKey}:${digest}`;
	}
	// See comment above: non-idempotent for the same reason.
	return `session-end:${scopedKey}:${randomUUID()}`;
}

export async function handleSessionEnd(req: SessionEndRequest): Promise<SessionEndResponse> {
	const sessionKey = req.sessionKey || req.sessionId;
	const agentId = resolveAgentId({ agentId: req.agentId, sessionKey: req.sessionKey || req.sessionId });
	ensureAgentRegistered(agentId);
	const endedAt = new Date().toISOString();

	// Keep session-start dedup across normal Stop/session-end hooks. Codex can
	// emit Stop between turns and then emit SessionStart again when an idle
	// conversation is resumed with the same session key; clearing here would
	// re-inject the full identity/memory block mid-conversation.

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
		const dedupeKey = sessionStartDedupeKey(req);
		if (dedupeKey) sessionStartSeen.delete(dedupeKey);
		if (sessionKey) sessionStartSeen.delete(sessionKey);
		clearContinuity(sessionKey);
		return { memoriesSaved: 0 };
	}

	// Capture final session-end checkpoint before clearing state.
	// Uses totalPromptCount so this reflects the full session, not just
	// the interval since the last periodic/pre-compaction consume.
	const snap = consumeState(sessionKey);
	if (snap && snap.totalPromptCount > 0) {
		try {
			const cfg = loadMemoryConfig(getAgentsDir()).pipelineV2.continuity;
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

	const memoryCfg = loadMemoryConfig(getAgentsDir());

	// Read transcript: prefer file path, fall back to inline body
	let rawTranscript = "";
	let transcript = "";
	if (req.transcriptPath && existsSync(req.transcriptPath)) {
		try {
			rawTranscript = readFileSync(req.transcriptPath, "utf-8");
			transcript = normalizeSessionTranscript(req.harness, rawTranscript);
		} catch {
			logger.warn("hooks", "Could not read transcript", {
				path: req.transcriptPath,
			});
		}
	} else if (req.transcript) {
		rawTranscript = req.transcript;
		transcript = normalizeSessionTranscript(req.harness, rawTranscript);
	}

	let storedTranscript = "";
	if (sessionKey) {
		try {
			storedTranscript = getSessionTranscriptContent(sessionKey, agentId) ?? "";
		} catch (error) {
			logger.warn("hooks", "Failed to read stored transcript for fallback", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey,
			});
		}
	}
	if (storedTranscript.length > 0 && (transcript.length === 0 || storedTranscript.length > transcript.length)) {
		logger.info("hooks", "Session end using stored transcript snapshot", {
			sessionKey,
			liveChars: storedTranscript.length,
			finalChars: transcript.length,
		});
		transcript = storedTranscript;
	}

	// Keep retention/indexing lossless. The summary worker receives a
	// capped copy below, but transcript artifacts and live transcript
	// storage must preserve the full canonical transcript.
	const retainedTranscript = transcript;

	// Derive a session-end artifact identity from the stable harness identity
	// plus transcript path/content. Some harnesses reuse the same sessionId
	// when a conversation is resumed; raw reuse would make immutable summary
	// artifacts collide with an earlier close of the same conversation.
	// `sessionKey` remains the continuity/grouping key, while this sessionId is
	// the immutable artifact identity for this particular session-end snapshot.
	// When the transcript is empty, deriveSessionEndFallbackId returns a random
	// UUID; empty sessions skip summaries and transcript artifacts below, and
	// very short transcript artifacts intentionally prefer uniqueness over
	// mutating a prior immutable artifact.
	const sessionId = deriveSessionEndFallbackId(
		req.sessionId?.trim() || sessionKey,
		req.transcriptPath,
		retainedTranscript,
	);

	// Lossless retention: keep the live transcript snapshot available to
	// subsequent hook calls before returning. The heavier canonical JSONL
	// rewrite/indexing work is deferred below so the session-end response
	// is not held open by large transcript rewrites.
	if (retainedTranscript && sessionKey) {
		try {
			upsertSessionTranscript(sessionKey, retainedTranscript, req.harness, req.cwd ?? null, agentId);
		} catch (e) {
			logger.warn("hooks", "Live transcript retention failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Safety cap against degenerate inputs (corrupt files, etc).
	// The summary worker handles long transcripts via chunked
	// map-reduce summarization, so this is a last-resort guard for
	// extraction only — not for transcript retention.
	const MAX_TRANSCRIPT_CHARS = 100_000;
	let summaryTranscript = retainedTranscript;
	let truncated = false;
	if (summaryTranscript.length > MAX_TRANSCRIPT_CHARS) {
		logger.warn("hooks", "Transcript exceeds safety cap, truncating summary input", {
			original: summaryTranscript.length,
			cap: MAX_TRANSCRIPT_CHARS,
		});
		summaryTranscript = `${summaryTranscript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[truncated]`;
		truncated = true;
	}

	const pipelineEnabled = memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode;
	const hasSummaryLength = summaryTranscript.length >= 500;
	let jobId: string | undefined;

	// Queue for async processing by the summary worker instead of
	// blocking on LLM inference. The worker produces both a dated
	// markdown summary and atomic fact rows.
	const noiseSession = isNoiseSession({
		project: req.cwd ?? null,
		sessionKey: sessionKey ?? null,
		sessionId,
		harness: req.harness,
	});

	if (!pipelineEnabled) {
		logger.info("hooks", "Session end extraction skipped — pipeline disabled");
	} else if (noiseSession) {
		logger.debug("hooks", "Session end summary skipped for noise session", {
			harness: req.harness,
			project: req.cwd,
			sessionKey,
			sessionId,
		});
	} else if (hasSummaryLength) {
		jobId = enqueueSummaryJob(getDbAccessor(), {
			harness: req.harness,
			transcript: summaryTranscript,
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
			feedbackTelemetry: getFeedbackTelemetry(),
		});
		logger.info("hooks", "Session end transcript queued", {
			harness: req.harness,
			project: req.cwd,
			sessionKey,
			transcriptPath: req.transcriptPath,
			transcriptChars: summaryTranscript.length,
			truncated,
			preview: summaryTranscript.slice(0, 500),
		});
	}

	setImmediate(() => {
		const work = deferSessionEndWork({
			transcript: retainedTranscript,
			rawTranscript,
			sessionKey,
			sessionId,
			agentId,
			harness: req.harness,
			cwd: req.cwd ?? null,
			endedAt,
			transcriptPath: req.transcriptPath,
			memoryCfg,
		}).catch((error) => {
			logger.warn("hooks", "Deferred session-end work failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey,
			});
		});
		deferredSessionEndWork.add(work);
		void work.finally(() => {
			deferredSessionEndWork.delete(work);
		});
	});

	return { memoriesSaved: 0, queued: Boolean(jobId), jobId };
}

async function deferSessionEndWork(params: {
	transcript: string;
	rawTranscript: string;
	sessionKey: string | undefined;
	sessionId: string;
	agentId: string;
	harness: string;
	cwd: string | null;
	endedAt: string;
	transcriptPath: string | undefined;
	memoryCfg: ReturnType<typeof loadMemoryConfig>;
}): Promise<void> {
	const {
		transcript,
		rawTranscript,
		sessionKey,
		sessionId,
		agentId,
		harness,
		cwd,
		endedAt,
		transcriptPath,
		memoryCfg,
	} = params;

	if (rawTranscript) {
		try {
			writeTranscriptAudit({
				basePath: getAgentsDir(),
				agentId,
				sessionId,
				sessionKey: sessionKey ?? null,
				rawTranscript,
				capturedAt: endedAt,
			});
		} catch (error) {
			logger.warn("hooks", "Deferred transcript audit write failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey,
			});
		}
	}

	if (transcript.trim().length > 0) {
		try {
			if (!isNoiseSession({ project: cwd, sessionKey: sessionKey ?? null, sessionId, harness })) {
				await writeCanonicalTranscriptFromSnapshot({
					agentId,
					harness,
					sessionKey: sessionKey ?? null,
					sessionId,
					project: cwd,
					rawTranscript,
					transcript,
					capturedAt: endedAt,
					transcriptPath,
				});
				const manifest = ensureCanonicalManifest({
					agentId,
					sessionId,
					sessionKey: sessionKey ?? null,
					project: cwd,
					harness,
					capturedAt: endedAt,
					startedAt: null,
					endedAt,
				});
				indexCanonicalTranscriptJsonl({
					agentId,
					sessionId,
					sessionKey: sessionKey ?? null,
					project: cwd,
					harness,
					capturedAt: endedAt,
					startedAt: null,
					endedAt,
					transcript,
					manifestPath: manifest.path.replace(`${getAgentsDir()}/`, "").replace(/\\/g, "/"),
				});
				logger.debug("hooks", "Session transcript JSONL snapshot written", {
					harness,
					project: cwd,
					sessionKey,
					path: canonicalTranscriptRelativePath(harness),
				});
			}
		} catch (e) {
			logger.warn("hooks", "Deferred transcript indexing failed", {
				error: e instanceof Error ? e.message : String(e),
				sessionKey,
				transcriptPath,
			});
		}
	}

	const pipelineActive = memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode;
	if (sessionKey && pipelineActive && memoryCfg.pipelineV2.graph.enabled && memoryCfg.pipelineV2.feedback.enabled) {
		let feedbackDecayedAspects = 0;
		let feedbackPropagatedAttributes = 0;
		try {
			const feedback = applyFtsOverlapFeedback(getDbAccessor(), sessionKey, agentId, {
				delta: memoryCfg.pipelineV2.feedback.ftsWeightDelta,
				maxWeight: memoryCfg.pipelineV2.feedback.maxAspectWeight,
				minWeight: memoryCfg.pipelineV2.feedback.minAspectWeight,
			});

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
			logger.debug("hooks", "Deferred aspect feedback completed", {
				sessionKey,
				feedbackAspectsUpdated: feedback.aspectsUpdated,
				feedbackFtsConfirmations: feedback.totalFtsConfirmations,
				feedbackDecayedAspects,
				feedbackPropagatedAttributes,
			});
		} catch (err) {
			logger.warn("hooks", "Deferred aspect feedback failed", {
				error: err instanceof Error ? err.message : String(err),
				sessionKey,
			});
		}
	}
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
	ensureAgentRegistered(agentId);

	// Respect the pipeline master switch
	const memoryCfg = loadMemoryConfig(getAgentsDir());
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
			const cfg = loadMemoryConfig(getAgentsDir()).pipelineV2.continuity;
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
		// Intentionally sessionKey: checkpoint extracts reuse the same
		// session identity so all checkpoint artifacts share a single
		// canonical manifest.  findExistingManifest looks up by session_id,
		// which matches because session_id is persisted as sessionKey.
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

export async function handleSynthesisRequest(
	req: SynthesisRequest,
	opts?: { maxTokens?: number; sinceTimestamp?: number; agentId?: string; writeToDisk?: boolean },
): Promise<SynthesisResponse> {
	logger.info("hooks", "Synthesis request", { trigger: req.trigger });

	const _sinceTimestamp = opts?.sinceTimestamp ?? 0;
	const _maxTokens = opts?.maxTokens ?? 8000;
	void _sinceTimestamp;
	void _maxTokens;

	const agentId = opts?.agentId ?? "default";
	if (hasDbAccessor()) {
		purgeCanonicalNoiseSessionsOnce(agentId, NOISE_PURGE_REASON);
	}

	const worker = getSynthesisWorker();
	if (worker === null) {
		logger.warn("hooks", "Synthesis render worker not available, falling back to synchronous render");
		const rendered = await renderMemoryProjection(agentId);
		if (opts?.writeToDisk === true) {
			writeMemoryMd(rendered.content, { agentId });
		}
		return {
			harness: "daemon",
			model: "projection",
			prompt: rendered.content,
			fileCount: rendered.fileCount,
			indexBlock: rendered.indexBlock,
		};
	}

	const requestId = randomUUID();
	const w: Worker = worker;
	return new Promise<SynthesisResponse>((resolve, reject) => {
		let settled = false;

		function cleanup(): void {
			clearTimeout(timer);
			w.off("message", handler);
			w.off("error", onError);
			w.off("exit", onExit);
		}

		async function fallbackToSync(message: string, error?: Error): Promise<void> {
			if (settled) return;
			settled = true;
			cleanup();
			setSynthesisWorker(null);
			w.terminate().catch((err) => {
				logger.debug("hooks", "Synthesis render worker terminate failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			logger.warn("hooks", "Synthesis render worker failed, falling back to synchronous render", error ?? { message });
			try {
				const rendered = await renderMemoryProjection(agentId);
				if (opts?.writeToDisk === true) {
					writeMemoryMd(rendered.content, { agentId });
				}
				resolve({
					harness: "daemon",
					model: "projection",
					prompt: rendered.content,
					fileCount: rendered.fileCount,
					indexBlock: rendered.indexBlock,
				});
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		}

		function onError(err: Error): void {
			logger.error("hooks", "Synthesis render worker failed", err);
			void fallbackToSync("Synthesis render worker failed", err);
		}

		function onExit(code: number): void {
			if (settled) return;
			const err = new Error(`Synthesis render worker exited before responding (code=${code})`);
			logger.error("hooks", err.message, err);
			void fallbackToSync(err.message, err);
		}

		const timer = setTimeout(() => {
			const err = new Error("Synthesis render worker timed out");
			logger.warn("hooks", err.message);
			void fallbackToSync(err.message, err);
		}, 30_000);

		function handler(msg: unknown): void {
			if (!isObject(msg)) return;
			if (msg.requestId !== requestId) return;
			if (settled) return;
			if (isRenderResult(msg)) {
				settled = true;
				cleanup();
				if (opts?.writeToDisk === true) {
					writeMemoryMd(msg.content, { agentId });
				}
				resolve({
					harness: "daemon",
					model: "projection",
					prompt: msg.content,
					fileCount: msg.fileCount,
					indexBlock: msg.indexBlock,
				});
			} else if (isRenderError(msg)) {
				const err = new Error(`Synthesis render worker error: ${msg.error}`);
				logger.error("hooks", err.message, err);
				void fallbackToSync(err.message, err);
			}
		}

		w.on("message", handler);
		w.once("error", onError);
		w.once("exit", onExit);
		w.postMessage({ type: "render", agentId, requestId });
	});
}
