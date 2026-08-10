/**
 * Signet Hooks System
 *
 * Lifecycle hooks for harness integration:
 * - onSessionStart: provide context/memories to inject
 * - onPreCompaction: provide summary instructions, receive summary
 * - onUserPromptSubmit: inject relevant memories per prompt
 * - onSessionEnd: retain and complete the transcript for Dreaming
 * - onRemember: explicit memory save
 * - onRecall: explicit memory query
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentRosterReadPolicy,
	type PROMPT_CONTEXT_VERSION,
	createPromptContext,
	identityModeManagesFiles,
	identityModeReadsFiles,
	loadIdentityMode,
	resolveDefaultBasePath,
	resolveStartupIdentityFiles,
	scanMemoryContent,
} from "@signet/core";
import { ensureAgentRegistered, getAgentScope, resolveAgentId } from "./agent-id";
import { applyTokenBudget, selectWithEstimatedTokenBudget } from "./context-budget";
import {
	clearContinuity,
	consumeState,
	initContinuity,
	recordPrompt,
	setStructuralSnapshot,
	shouldCheckpoint,
} from "./continuity-state";
import { listAgentPresence } from "./cross-agent";
import { getDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import {
	DEFAULT_SESSION_START_MAX_INJECT_TOKENS,
	type HooksConfig,
	getDefaultHooksConfig,
	loadHooksConfig as loadHooksConfigFromDisk,
	resolveHooksConfigForHarness,
	resolveUserPromptMinScore,
} from "./hooks-config";
import {
	loadIdentity,
	readAgentsMd,
	readContextIdentitySections,
	readIdentityFile,
	readMemoryMd,
	resolveIdentityFiles,
} from "./identity-context";
import { propagateMemoryStatus } from "./knowledge-graph";
import { logger } from "./logger";
import { buildAgentScopeClause } from "./memory-access-scope";
import * as memoryCandidates from "./memory-candidates";
import { type ScoredMemory, buildActiveConstraintsSection } from "./memory-candidates";
import { effectiveScore, inferType, isDuplicate } from "./memory-classification";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { isMemoryContentContextEligible } from "./memory-content-safety";
import { type RecallResponse, type RecallResult, hybridRecall } from "./memory-search";
import { recordMemorySearchTelemetry } from "./memory-search-telemetry";
import {
	type SynthesisRequest,
	type SynthesisResponse,
	getSynthesisWorker,
	handleSynthesisRequest,
	setSynthesisWorker,
	writeMemoryMd,
} from "./memory-synthesis";
import { recordFeedbackTelemetry } from "./pipeline/aspect-feedback";
import {
	invalidateTraversalCache,
	resolveFocalEntities,
	setTraversalStatus,
	traverseKnowledgeGraph,
} from "./pipeline/graph-traversal";
import { estimateTokens } from "./pipeline/tokenizer";
import { getDefaultPluginHost } from "./plugins/index";
import type { PluginPromptTargetV1 } from "./plugins/types";
import {
	type PromptEntityContextMemory,
	buildEntityContextInject,
	buildEntityPromptContext,
} from "./prompt-entity-context";
import { buildRecallQueryShape, queryAnchorsMissingFromRecall, stripUntrustedMetadata } from "./prompt-text";
import { recordRecallAttempt, recordRecallOutcome } from "./recall-telemetry";
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
import { deriveSessionEndFallbackId, recoverMissingSessionEndOnClearStart } from "./session-end-recovery";
import {
	clearSessionEndTelemetry,
	hasSessionEndTelemetry,
	hashSessionKey,
	markSessionEndTelemetry,
	normalizeSessionBoundaryReason,
	pruneSessionEndTelemetry,
} from "./session-end-state";
import {
	type SessionMemoryCandidate,
	parseFeedback,
	recordAgentFeedback,
	recordSessionCandidates,
	trackFtsHits,
} from "./session-memories";
import { advanceRecallContextEpoch, claimRecallItems } from "./session-recall-dedupe";
import {
	buildSignetSystemPrompt,
	formatLastSeenShort,
	formatMemoryDate,
	harnessSupportsNamedCrossAgentTools,
	sanitizePeerPromptField,
	serializeTraversalPath,
} from "./session-start-format";
import {
	clearRawSessionStartDedupeKey,
	clearSessionStartDedupe,
	hasSessionStartDedupe,
	markSessionStartDedupe,
	pruneSessionStartDedupe,
	resetSessionStartDedupe,
	sessionStartRecallKey,
} from "./session-start-state";
import { getExpiryWarning } from "./session-tracker";
import {
	ensureCanonicalTranscriptHistory,
	findStaleLiveSessions,
	getSessionTranscriptContent,
	markSessionTranscriptCompleted,
	upsertSessionTranscript,
} from "./session-transcripts";
import { type StructuralCandidateSource, type StructuralFeatures, getStructuralFeatures } from "./structural-features";
import { assembleInheritedContextBlock, resolveParentSession } from "./subagent-context";
import { awaitPressureClear, isSystemPressureHigh } from "./system-pressure";
import { getActiveTelemetry } from "./telemetry";
import { searchTemporalFallback } from "./temporal-fallback";
import { writeTranscriptAudit } from "./transcript-audit";
import * as transcriptCapture from "./transcript-capture";
import {
	enqueueTranscriptCaptureJob,
	getTranscriptCaptureStatus,
	runTranscriptCaptureOnce,
} from "./transcript-capture-worker";
import {
	normalizeCodexTranscript,
	normalizeJsonConversationTranscript,
	normalizeSessionTranscript as normalizeSessionTranscriptBase,
} from "./transcript-normalization";
import { getUpdateSummary } from "./update-system";

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

function getMemoryDbPath(): string {
	return join(getAgentsDir(), "memory", "memories.db");
}

const deferredSessionEndWork = new Set<Promise<void>>();
let deferredSessionEndWorkTail: Promise<void> = Promise.resolve();
let staleSessionSweepInFlight: Promise<{ closed: number; skipped: number; totalMatching: number }> | null = null;
const STALE_SESSION_SWEEP_DEFAULT_LIMIT = 10;
const STALE_SESSION_SWEEP_MAX_LIMIT = 50;
const STALE_SESSION_SWEEP_MAX_DOWNSTREAM_BACKLOG = 20;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export async function flushDeferredSessionEndWorkForTests(): Promise<void> {
	await Promise.allSettled([...deferredSessionEndWork]);
}

function scheduleDeferredSessionEndWork(params: {
	readonly sessionKey: string | undefined;
	readonly agentId: string;
	readonly memoryCfg: ResolvedMemoryConfig;
}): void {
	const dbAccessor = loadDbAccessor();
	if (!dbAccessor) return;
	const basePath = getAgentsDir();
	const work = deferredSessionEndWorkTail.then(async () => {
		await yieldToEventLoop();
		try {
			await runTranscriptCaptureOnce(dbAccessor, basePath);
		} catch (error) {
			logger.warn("hooks", "Deferred transcript capture job failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey: params.sessionKey,
			});
		}
		await deferSessionEndWork(params);
	});
	deferredSessionEndWorkTail = work.catch(() => undefined);
	deferredSessionEndWork.add(work);
	void work.then(
		() => deferredSessionEndWork.delete(work),
		() => deferredSessionEndWork.delete(work),
	);
}

function loadDbAccessor() {
	try {
		return getDbAccessor();
	} catch {
		return null;
	}
}

const IDENTITY_HEADER_BY_FILE: Record<string, string> = {
	"AGENTS.md": "Agent Instructions",
	"SOUL.md": "Soul",
	"IDENTITY.md": "Identity",
	"USER.md": "About Your User",
	"MEMORY.md": "Working Memory",
};

const IDENTITY_BUDGET_BY_FILE: Record<string, number> = {
	"AGENTS.md": 12_000,
	"SOUL.md": 4_000,
	"IDENTITY.md": 2_000,
	"USER.md": 6_000,
	"MEMORY.md": 10_000,
};

function identityHeaderFor(path: string, role?: string): string {
	const filename = path.split(/[\\/]/).pop() ?? path;
	return IDENTITY_HEADER_BY_FILE[filename] ?? role ?? filename.replace(/\.md$/i, "");
}

function identityBudgetFor(path: string): number {
	const filename = path.split(/[\\/]/).pop() ?? path;
	return IDENTITY_BUDGET_BY_FILE[filename] ?? 4_000;
}

// ============================================================================
// Types
// ============================================================================

export type { HooksConfig };

export interface SessionStartRequest {
	harness: string;
	project?: string;
	agentId?: string;
	/** Re-establish the runtime claim without rebuilding startup context. */
	claimOnly?: boolean;
	source?: string;
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
	contextHash?: string;
	contextVersion?: typeof PROMPT_CONTEXT_VERSION;
	warnings?: string[];
}

export interface PreCompactionRequest {
	harness: string;
	sessionContext?: string;
	messageCount?: number;
	sessionKey?: string;
	agentId?: string;
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
	contextHash?: string;
	contextVersion?: typeof PROMPT_CONTEXT_VERSION;
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
	/** Immutable capture time supplied by an importing harness. */
	capturedAt?: string;
	reason?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface SessionEndResponse {
	memoriesSaved: number;
	queued?: boolean;
	jobId?: string;
	transcriptCaptureJobId?: string;
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
	agentId?: string;
	idempotencyKey?: string;
	runtimePath?: "plugin" | "legacy";
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

export { resetSessionStartDedupe };
export { effectiveScore, inferType, isDuplicate };

export { applyTokenBudget, selectWithBudget, selectWithTokenBudget } from "./context-budget";

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

/** Build a brief "since your last session" summary */
function getSessionGapSummary(): string | undefined {
	if (!existsSync(getMemoryDbPath())) return undefined;

	try {
		return getDbAccessor().withReadDb((db) => {
			// The completion marker covers explicit ends and daemon recovery/TTL
			// boundaries; all are settled session activity for this brief.
			const lastSession = db.prepare("SELECT MAX(completed_at) as last_end FROM session_transcripts").get() as
				| { last_end: string | null }
				| undefined;

			if (!lastSession?.last_end) return undefined;

			const lastEnd = lastSession.last_end;

			// Count new memories since last session
			const memCount = db
				.prepare("SELECT COUNT(*) as cnt FROM memories WHERE created_at > ? AND is_deleted = 0")
				.get(lastEnd) as { cnt: number };

			// Count sessions since last session
			const sessionCount = db
				.prepare("SELECT COUNT(*) as cnt FROM session_transcripts WHERE completed_at > ?")
				.get(lastEnd) as { cnt: number };

			return `[since last session: ${memCount.cnt} new memories, ${sessionCount.cnt} sessions captured]`;
		});
	} catch {
		return undefined;
	}
}

async function fetchTraversalCandidates(memoryIds: ReadonlyArray<string>, agentId: string): Promise<ScoredMemory[]> {
	return memoryCandidates.fetchTraversalCandidates(getMemoryDbPath(), memoryIds, agentId);
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
	readPolicy: AgentRosterReadPolicy = "isolated",
	policyGroup: string | null = null,
): ScoredMemory[] {
	return memoryCandidates.getAllScoredCandidates(getMemoryDbPath(), project, limit, agentId, readPolicy, policyGroup);
}

function getPredictedContextMemories(
	project: string | undefined,
	limit: number,
	charBudget: number,
	excludeIds: ReadonlySet<string>,
	agentId: string,
	readPolicy: AgentRosterReadPolicy = "isolated",
	policyGroup: string | null = null,
): ScoredMemory[] {
	return memoryCandidates.getPredictedContextMemories(
		getMemoryDbPath(),
		project,
		limit,
		charBudget,
		excludeIds,
		agentId,
		readPolicy,
		policyGroup,
	);
}

// ============================================================================
// Config Loading
// ============================================================================

function loadHooksConfig(): HooksConfig {
	return loadHooksConfigFromDisk(getAgentsDir());
}

function loadHooksConfigForHarness(harness: string) {
	return resolveHooksConfigForHarness(loadHooksConfig(), harness);
}

// ============================================================================
// Memory Queries
// ============================================================================

function getRecentMemories(
	limit: number,
	recencyBias = 0.7,
	agentScope?: { agentId: string; readPolicy: AgentRosterReadPolicy; policyGroup: string | null },
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
			const scope = agentScope
				? buildAgentScopeClause(agentScope.agentId, agentScope.readPolicy, agentScope.policyGroup)
				: { sql: " AND m.visibility != 'archived'", args: [] };
			const query = `
        SELECT
          m.id, m.content, m.type, m.importance, m.created_at,
          (julianday('now') - julianday(m.created_at)) as age_days
        FROM memories m
        WHERE m.is_deleted = 0${scope.sql}
        ORDER BY
          (m.importance * ${1 - recencyBias}) +
          (1.0 / (1.0 + (julianday('now') - julianday(m.created_at)))) * ${recencyBias}
          DESC
        LIMIT ?
      `;

			const rows = db.prepare(query).all(...scope.args, limit) as Array<{
				id: string;
				content: string;
				type: string;
				importance: number;
				created_at: string;
			}>;
			return rows.filter((row) =>
				isMemoryContentContextEligible(db, {
					agentId: agentScope?.agentId ?? "default",
					sourceKind: "memory",
					sourceId: row.id,
					content: row.content,
				}),
			);
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
	return memoryCandidates.getMemoriesSince(getMemoryDbPath(), sinceMs, limit);
}

// ============================================================================
// Hook Handlers
// ============================================================================

export async function handleSessionStart(req: SessionStartRequest): Promise<SessionStartResponse> {
	const start = Date.now();
	const agentId = resolveAgentId(req);
	ensureAgentRegistered(agentId);
	const resolvedHooksConfig = loadHooksConfigForHarness(req.harness);
	const config = resolvedHooksConfig.sessionStart || {};
	const memoryCfg = loadMemoryConfig(getAgentsDir());
	const identityMode = loadIdentityMode(getAgentsDir());
	const managesIdentity = identityModeManagesFiles(identityMode);
	const includeIdentity = identityModeReadsFiles(identityMode) && config.includeIdentity !== false;

	logger.info("hooks", "Session start hook", {
		harness: req.harness,
		project: req.project,
	});

	if (isClearSessionStart(req)) {
		const sessionKey = req.sessionKey?.trim();
		const recoveredSessionEnd = recoverMissingSessionEndOnClearStart(req, agentId, new Date().toISOString());
		clearSessionStartDedupe(req);
		// A reset also opens a new session lifetime — any prior session.end
		// marker must not suppress a termination event for the new one (#1212).
		clearSessionEndTelemetry({
			agentId,
			harness: req.harness,
			sessionKey: req.sessionKey ?? undefined,
		});
		if (sessionKey) {
			clearRawSessionStartDedupeKey(sessionKey);
			clearContinuity(sessionKey);
			advanceRecallContextEpoch({
				sessionKey: sessionStartRecallKey(req),
				agentId,
				reason: "session-clear",
				sourceRef: sessionKey,
			});
		}
		logger.info("hooks", "Session start clear/reset handled", {
			harness: req.harness,
			project: req.project,
			sessionKey,
			recoveredSessionEnd,
		});
	}

	// Dedup guard: if we already sent a full inject for this session, return
	// a minimal stub. Identity files / MEMORY.md are already in the context.
	// Must fire BEFORE initContinuity to avoid resetting accumulated state.
	pruneSessionStartDedupe();
	if (hasSessionStartDedupe(req)) {
		const sessionHash = hashSessionKey(req.sessionKey);
		if (sessionHash) getActiveTelemetry()?.reopenSession(sessionHash);
		logger.info("hooks", "Session start dedup — returning minimal stub", {
			harness: req.harness,
			sessionKey: req.sessionKey,
		});
		const warnings = req.sessionKey
			? [getExpiryWarning(req.sessionKey, agentId)].filter((w): w is string => w !== null)
			: undefined;
		return attachPromptContext({
			identity: { name: "Agent" },
			memories: [],
			inject: "[memory active | /remember | /recall]",
			warnings: warnings?.length ? warnings : undefined,
		});
	}

	// Anonymous usage telemetry: a real session start (dedup stubs and
	// clear/reset paths above don't count as new sessions). A real start
	// also opens a new session lifetime, so any prior session.end marker
	// for this key must not suppress a later termination event (#1212).
	pruneSessionEndTelemetry();
	clearSessionEndTelemetry({
		agentId,
		harness: req.harness,
		sessionKey: req.sessionKey,
	});
	getActiveTelemetry()?.record("session.start", {
		harness: req.harness,
		sessionHash: hashSessionKey(req.sessionKey),
	});

	// Initialize continuity state for checkpoint accumulation (first call only)
	if (req.sessionKey) {
		initContinuity(req.sessionKey, req.harness, req.project);
	}

	const agentsDir = getAgentsDir();
	const identityFiles = resolveIdentityFiles(agentId, agentsDir);
	const identity = includeIdentity ? loadIdentity(agentsDir, identityFiles) : { name: "Agent" };

	const profileIdentitySections = includeIdentity
		? readContextIdentitySections(agentsDir, resolvedHooksConfig.identity, identityFiles)
		: null;
	const profileHasExplicitIdentityFiles =
		includeIdentity &&
		resolvedHooksConfig.identity?.include !== false &&
		resolvedHooksConfig.identity?.files !== undefined;

	// Read AGENTS.md first so harness instructions precede synthesized memory.
	const agentsMdContent =
		includeIdentity && profileIdentitySections === null ? readAgentsMd(agentsDir, 12000, identityFiles) : undefined;
	const startupIdentitySections =
		includeIdentity && profileIdentitySections === null
			? resolveStartupIdentityFiles(agentsDir)
					.filter((entry) => entry.path !== "AGENTS.md" && entry.path !== "MEMORY.md")
					.map((entry) => ({
						header: identityHeaderFor(entry.path, entry.role),
						content: readIdentityFile(
							agentsDir,
							entry.path,
							entry.budget ?? identityBudgetFor(entry.path),
							identityFiles,
						),
					}))
					.filter((section): section is { header: string; content: string } => Boolean(section.content))
			: [];

	// Read MEMORY.md with 10k char budget unless a context profile supplies the identity/context file list.
	const memoryMdCandidate =
		profileIdentitySections?.find((section) => section.path === "MEMORY.md")?.content ??
		(!profileHasExplicitIdentityFiles && config.includeRecentContext !== false
			? readMemoryMd(agentsDir, 10000, identityFiles)
			: undefined);
	const memoryMdContent =
		memoryMdCandidate && scanMemoryContent(memoryMdCandidate).contextEligible ? memoryMdCandidate : undefined;
	const safeProfileIdentitySections = profileIdentitySections?.filter(
		(section) => section.path !== "MEMORY.md" || scanMemoryContent(section.content).contextEligible,
	);

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
	const candidatePoolLimit = Math.max(recallLimit, config.candidatePoolLimit ?? 100);
	const _candidatesStart = Date.now();
	const allCandidates = getAllScoredCandidates(
		req.project,
		candidatePoolLimit,
		traversalAgentId,
		agentScope.readPolicy,
		agentScope.policyGroup,
	);
	const candidatesMs = Date.now() - _candidatesStart;
	const candidateById = new Map(allCandidates.map((candidate) => [candidate.id, candidate]));
	const candidateSourceById = new Map<string, SessionMemoryCandidate["source"]>(
		allCandidates.map((candidate) => [candidate.id, "effective" as const]),
	);
	const structuralCandidateSourceById = new Map<string, StructuralCandidateSource>(
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

	let traversalMs = 0;
	if (traversalEnabled) {
		const _traversalStart = Date.now();
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
				const traversalResult = await getDbAccessor().withReadDbAsync((db) =>
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
						structuralCandidateSourceById.set(memoryId, "ka_traversal");
					}
				}

				const traversalRows = await fetchTraversalCandidates([...traversalResult.memoryIds], traversalAgentId);
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
		traversalMs = Date.now() - _traversalStart;
	}

	const mergedCandidates = allCandidates.slice(0, candidatePoolLimit);

	// ---------------------------------------------------------------
	// Baseline ranking
	// ---------------------------------------------------------------
	const dbAcc = loadDbAccessor();
	const candidateIdsForFeatures = mergedCandidates.map((c) => c.id);
	const structuralById = dbAcc
		? getStructuralFeatures(dbAcc, candidateIdsForFeatures, agentId, structuralCandidateSourceById)
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
	let memories = selectWithEstimatedTokenBudget(sortedCandidates.slice(0, recallLimit), tokenBudget);

	// Predicted context from recent session analysis is additive on top of main
	// recall: it surfaces topics the user is likely to need next regardless of how
	// much of the token budget main recall consumed. Capping it by memories.length
	// would starve it to zero whenever recall fills to recallLimit (default 50),
	// silently dropping the predicted-context feature entirely.
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

	const sessionStartRecallSessionKey = sessionStartRecallKey(req);
	if (sessionStartRecallSessionKey && memories.length > 0) {
		memories = claimRecallItems({
			sessionKey: sessionStartRecallSessionKey,
			agentId,
			surface: "api.hooks.session-start",
			mode: "automatic",
			items: memories,
		}).items;
	}

	const exploredId: string | null = null;

	// Do NOT bump access_count/last_accessed for session-start injected memories.
	// Those columns drive rehearsal boost and retention decay, which must reflect
	// genuine recall operations (CLI, MCP, or harness prompt-submit recall via
	// hybridRecall), not the ~50-60 memories injected into the system prompt at
	// session start. Bumping them here permanently inflates the boost for the
	// injection set and resets last_accessed so the half-life never decays it.
	// Injected rows are still recorded for the predictive scorer below via
	// session_memories, so no telemetry is lost. See #971.

	// Record all candidates + which were injected for predictive scorer
	const injectedSet = new Set(memories.map((m) => m.id));
	const allCandidateIdsForRecording = [
		...mergedCandidates.map((c) => c.id),
		...predictedMemories.filter((m) => !mergedCandidates.some((c) => c.id === m.id)).map((m) => m.id),
	];
	// Re-fetch structural features for any predicted memories not in the first batch
	const fullStructuralById =
		allCandidateIdsForRecording.length > candidateIdsForFeatures.length && dbAcc
			? getStructuralFeatures(dbAcc, allCandidateIdsForRecording, agentId, structuralCandidateSourceById)
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

	injectParts.push(buildSignetSystemPrompt({ includeIdentityStewardship: managesIdentity }));
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
	}

	if (safeProfileIdentitySections !== null && safeProfileIdentitySections !== undefined) {
		for (const section of safeProfileIdentitySections) {
			injectParts.push(`\n## ${section.header}\n`);
			injectParts.push(section.content);
		}
		if (memoryMdContent && !safeProfileIdentitySections.some((section) => section.path === "MEMORY.md")) {
			injectParts.push("\n## Working Memory\n");
			injectParts.push(memoryMdContent);
		}
	} else {
		if (startupIdentitySections.length > 0) {
			for (const section of startupIdentitySections) {
				injectParts.push(`\n## ${section.header}\n`);
				injectParts.push(section.content);
			}
		} else if (!agentsMdContent && managesIdentity && (identity.name !== "Agent" || identity.description)) {
			injectParts.push(`You are ${identity.name}${identity.description ? `, ${identity.description}` : ""}.`);
		}

		if (memoryMdContent) {
			injectParts.push("\n## Working Memory\n");
			injectParts.push(memoryMdContent);
		}
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
	const maxTokens = tokenBudget;
	// Pre-reserve space for deterministic continuity sections so they are never
	// truncated. The sections are character-budgeted upstream, so the cheap
	// char-based estimate is sufficient — exact BPE encodes of these large
	// sections block the event loop on every session start (#1114).
	const reservedTokens =
		estimateTokens(recoverySection) + estimateTokens(constraintsSection) + estimateTokens(inheritedSection);
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
		injectTokens: estimateTokens(inject),
		injectChars: inject.length,
		durationMs: duration,
		phaseMs: {
			candidates: candidatesMs,
			traversal: traversalMs,
			inject: duration - candidatesMs - traversalMs,
		},
	});

	// Mark this session as having received the full inject
	markSessionStartDedupe(req);

	return attachPromptContext({
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
			const w = [getExpiryWarning(req.sessionKey, resolveAgentId(req))].filter((v): v is string => v !== null);
			return w.length > 0 ? w : undefined;
		})(),
	});
}

export function handlePreCompaction(req: PreCompactionRequest): PreCompactionResponse {
	const config = loadHooksConfig().preCompaction || {};

	logger.info("hooks", "Pre-compaction hook", {
		harness: req.harness,
		messageCount: req.messageCount,
	});

	const guidelines = config.summaryGuidelines || (getDefaultHooksConfig().preCompaction?.summaryGuidelines ?? "");

	let summaryPrompt = `Pre-compaction memory flush. Store durable memories now.

${guidelines}

`;

	if (config.includeRecentMemories !== false) {
		const agentId = resolveAgentId(req);
		const agentScope = getAgentScope(agentId);
		const configuredLimit =
			typeof config.memoryLimit === "number" && Number.isFinite(config.memoryLimit) ? config.memoryLimit : 5;
		const memoryLimit = Math.max(0, Math.min(50, Math.trunc(configuredLimit)));
		const recentMemories = getRecentMemories(memoryLimit, 0.9, { agentId, ...agentScope });
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
					recentRemembers: [],
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

export { queryAnchorsMissingFromRecall };

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
	const contextualResult = attachPromptContext(result);
	const inject = contextualResult.inject;
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

	return contextualResult;
}

function attachPromptContext<T extends { readonly inject: string }>(
	result: T,
): T & {
	readonly contextHash?: string;
	readonly contextVersion?: typeof PROMPT_CONTEXT_VERSION;
} {
	const context = createPromptContext(result.inject);
	if (!context) return { ...result, inject: "" };
	return {
		...result,
		inject: context.serialized,
		contextHash: context.hash,
		contextVersion: context.version,
	};
}

function entityMemoryToRecallResult(memory: PromptEntityContextMemory): RecallResult {
	return {
		id: memory.id,
		content: memory.content,
		content_length: memory.content.length,
		truncated: false,
		score: memory.score,
		source: memory.sourceKind ?? "entity_context",
		...(memory.sourceId ? { source_id: memory.sourceId } : {}),
		...(memory.sourcePath ? { source_path: memory.sourcePath } : {}),
		type: "fact",
		tags: null,
		pinned: false,
		importance: memory.importance,
		who: "signet",
		project: null,
		created_at: new Date(0).toISOString(),
	};
}

function recordUserPromptRecallTelemetry(input: {
	readonly cfg: {
		readonly pipelineV2: {
			readonly telemetry: { readonly memorySearchQaEnabled: boolean; readonly retentionDays: number };
		};
	};
	readonly agentId: string;
	readonly sessionKey: string | undefined;
	readonly project: string | undefined;
	readonly userMessage: string;
	readonly memories: readonly PromptEntityContextMemory[];
	readonly startedAt: number;
	readonly engine: string;
}): void {
	if (!input.cfg.pipelineV2.telemetry.memorySearchQaEnabled) return;
	const response: RecallResponse = {
		results: input.memories.map(entityMemoryToRecallResult),
		query: input.userMessage,
		method: "hybrid",
		meta: {
			totalReturned: input.memories.length,
			hasSupplementary: false,
			noHits: input.memories.length === 0,
			timings: {
				totalMs: Date.now() - input.startedAt,
				stages: [{ name: input.engine, durationMs: Date.now() - input.startedAt }],
			},
		},
	};
	recordMemorySearchTelemetry(getDbAccessor(), {
		route: "POST /api/hooks/user-prompt-submit",
		agentId: input.agentId,
		sessionKey: input.sessionKey ?? null,
		project: input.project ?? null,
		params: { query: input.userMessage, sessionKey: input.sessionKey, project: input.project },
		response,
		retentionDays: input.cfg.pipelineV2.telemetry.retentionDays,
	});
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
	const submitCfg = loadHooksConfigForHarness(req.harness).userPromptSubmit ?? {};
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
						recentRemembers: [],
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
				await transcriptCapture.writeCanonicalTranscriptFromSnapshot({
					basePath: getAgentsDir(),
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
				const liveTranscript = transcriptCapture.formatLivePromptTranscript(userMessage, req.lastAssistantMessage);
				const prev = getSessionTranscriptContent(req.sessionKey, agentId);
				deps.upsertSessionTranscript(
					req.sessionKey,
					transcriptCapture.appendLivePromptTranscript(prev, liveTranscript),
					req.harness,
					req.project ?? null,
					agentId,
				);
				await transcriptCapture.appendCanonicalLiveTranscriptTurns({
					basePath: getAgentsDir(),
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

	// Per-prompt context must not contain a wall-clock value. Harnesses may
	// replay the same response for title, primary, retry, and tool-loop calls;
	// dynamic metadata would invalidate their prompt cache and its hash.
	const metadataHeader = "";
	const expiryWarning = req.sessionKey ? deps.getExpiryWarning(req.sessionKey, agentId) : null;
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

	let promptRecallAttempted = false;
	let promptRecallOutcomeRecorded = false;
	recordRecallAttempt("prompt_injection");
	promptRecallAttempted = true;
	try {
		const cfg = deps.loadMemoryConfig(getAgentsDir());
		const injectBudget = submitCfg.maxInjectChars ?? cfg.pipelineV2.guardrails.contextBudgetChars;
		const entityContext = await buildEntityPromptContext({
			userMessage,
			agentId,
			minScore: resolveUserPromptMinScore(submitCfg.minScore),
			injectBudget,
			memoryDbPath: getMemoryDbPath(),
			fetchEmbedding: deps.fetchEmbedding,
			embedding: cfg.embedding,
			sessionHash: hashSessionKey(req.sessionKey) ?? undefined,
		});
		if (entityContext.lines.length === 0) {
			recordUserPromptRecallTelemetry({
				cfg,
				agentId,
				sessionKey: req.sessionKey,
				project: req.project,
				userMessage,
				memories: [],
				startedAt: start,
				engine: entityContext.engine,
			});
			recordRecallOutcome({
				surface: "prompt_injection",
				resultCount: 0,
				delivery: "not_delivered",
			});
			promptRecallOutcomeRecorded = true;
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
		const memoryIds = entityContext.memories.map((memory) => memory.id);
		deps.trackFtsHits(req.sessionKey, memoryIds, agentId);
		recordUserPromptRecallTelemetry({
			cfg,
			agentId,
			sessionKey: req.sessionKey,
			project: req.project,
			userMessage,
			memories: entityContext.memories,
			startedAt: start,
			engine: "entity-context",
		});
		const pluginContext = buildPluginPromptContributionSection("user-prompt-submit", deps.logger);
		const inject = buildEntityContextInject(metadataHeader, entityContext.lines, pluginContext);
		recordRecallOutcome({
			surface: "prompt_injection",
			resultCount: entityContext.memoryCount,
			delivery: "injected",
		});
		promptRecallOutcomeRecorded = true;
		return finalizeUserPromptSubmitSuccess(
			req,
			userMessage,
			start,
			{
				inject,
				memoryCount: entityContext.memoryCount,
				queryTerms: keywordTerms.join(" ") || undefined,
				engine: "entity-context",
				warnings,
			},
			deps.logger,
		);
	} catch (e) {
		if (promptRecallAttempted && !promptRecallOutcomeRecorded) {
			recordRecallOutcome({ surface: "prompt_injection", error: true, delivery: "not_delivered" });
		}
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

function isClearSessionStart(req: SessionStartRequest): boolean {
	return req.source?.trim().toLowerCase() === "clear";
}

export async function handleSessionEnd(req: SessionEndRequest): Promise<SessionEndResponse> {
	const sessionKey = req.sessionKey || req.sessionId;
	const agentId = resolveAgentId({ agentId: req.agentId, sessionKey: req.sessionKey || req.sessionId });
	ensureAgentRegistered(agentId);
	const endedAt = req.capturedAt ?? new Date().toISOString();
	const boundaryReason = normalizeSessionBoundaryReason(req.reason);

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

	if (boundaryReason === "clear") {
		// Caller intends to discard session context — skip checkpoint, just clean up
		clearSessionStartDedupe(req);
		clearRawSessionStartDedupeKey(sessionKey);
		advanceRecallContextEpoch({
			sessionKey: sessionStartRecallKey(req),
			agentId,
			reason: "session-clear",
			sourceRef: sessionKey ?? null,
		});
		clearContinuity(sessionKey);
		// Real session termination: the caller explicitly discards the
		// session. Emit session.end once per session lifetime (#1212) so the
		// counter stays comparable with the dedup'd session.start.
		if (!hasSessionEndTelemetry({ agentId, harness: req.harness, sessionKey })) {
			getActiveTelemetry()?.record("session.end", {
				harness: req.harness,
				reason: "clear",
				sessionHash: hashSessionKey(sessionKey),
			});
			markSessionEndTelemetry({ agentId, harness: req.harness, sessionKey });
		}
		return { memoriesSaved: 0 };
	}

	// Capture final session-end checkpoint before clearing state.
	// Uses totalPromptCount so this reflects the full session, not just
	// the interval since the last periodic/pre-compaction consume.
	const snap = consumeState(sessionKey);

	// Anonymous usage telemetry for session-end hook calls. Harnesses call
	// this hook per turn (Stop/session.idle) to persist messages, so this
	// is a "turns persisted" volume counter — not a session boundary.
	// Real session termination is emitted separately as session.end on
	// explicit lifecycle reasons or TTL eviction (#1212/#1231).
	if (boundaryReason !== null) {
		// Explicit lifecycle signals are real session boundaries, unlike the
		// per-turn Stop/session.idle calls that also use this hook (#1231).
		if (!hasSessionEndTelemetry({ agentId, harness: req.harness, sessionKey })) {
			getActiveTelemetry()?.record("session.end", {
				harness: req.harness,
				reason: boundaryReason,
				sessionHash: hashSessionKey(sessionKey),
			});
			markSessionEndTelemetry({ agentId, harness: req.harness, sessionKey });
		}
	} else {
		getActiveTelemetry()?.record("session.turn", {
			harness: req.harness,
			promptCount: snap?.totalPromptCount ?? null,
			sessionHash: hashSessionKey(sessionKey),
		});
	}
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
					recentRemembers: [],
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

	// Retain the complete transcript first. Dreaming reads this row directly;
	// no derived summary job is inserted or required for completion.
	const retainedTranscript = transcript;
	const sessionId = deriveSessionEndFallbackId(
		req.sessionId?.trim() || sessionKey,
		req.transcriptPath,
		retainedTranscript,
	);
	let transcriptRetained = false;
	if (retainedTranscript && sessionKey) {
		try {
			transcriptRetained = upsertSessionTranscript(
				sessionKey,
				retainedTranscript,
				req.harness,
				req.cwd ?? null,
				agentId,
				endedAt,
			);
		} catch (e) {
			logger.warn("hooks", "Live transcript retention failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	if (transcriptRetained && sessionKey) {
		const completed = markSessionTranscriptCompleted(sessionKey, agentId, endedAt);
		if (!completed) {
			logger.warn("hooks", "Session-end transcript completion marker was not written", {
				sessionKey,
				agentId,
			});
		}
	}

	let transcriptCaptureJobId: string | null = null;
	if (retainedTranscript.trim().length > 0 || rawTranscript.trim().length > 0) {
		try {
			transcriptCaptureJobId = enqueueTranscriptCaptureJob(getDbAccessor(), {
				agentId,
				harness: req.harness,
				sessionKey: sessionKey ?? null,
				sessionId,
				project: req.cwd ?? null,
				transcript: retainedTranscript,
				rawTranscript,
				transcriptPath: req.transcriptPath ?? null,
				capturedAt: endedAt,
				endedAt,
				summaryStatus: "not_requested",
			});
		} catch (error) {
			logger.warn("hooks", "Transcript capture enqueue failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey,
			});
		}
	}

	scheduleDeferredSessionEndWork({
		sessionKey,
		agentId,
		memoryCfg,
	});

	return {
		memoriesSaved: 0,
		queued: Boolean(transcriptCaptureJobId),
		...(transcriptCaptureJobId ? { transcriptCaptureJobId } : {}),
	};
}

/**
 * Daemon-side fallback for harnesses that never signal session-end (#1172).
 * Desktop chats that are closed or abandoned without an explicit
 * on_session_end stay in live retention forever (completed: false semantics),
 * so the dreaming content runbook defers their transcripts indefinitely.
 * Sweep the stale sessions and fire the deferred session-end with the stored
 * transcript snapshot, so the direct content pass can consume it instead of
 * deferring indefinitely.
 */
type StaleSessionSweepResult = { closed: number; skipped: number; totalMatching: number };

async function waitForCurrentDeferredSessionEndWork(): Promise<void> {
	await yieldToEventLoop();
	const pending = [...deferredSessionEndWork];
	if (pending.length === 0) return;
	await Promise.allSettled(pending);
}

function shouldDeferStaleSessionSweep(): boolean {
	if (deferredSessionEndWork.size > 0) {
		logger.debug("hooks", "Stale session-end sweep deferred while session-end work is pending", {
			deferredWork: deferredSessionEndWork.size,
		});
		return true;
	}
	const dbAccessor = loadDbAccessor();
	if (!dbAccessor) return true;
	try {
		const capture = getTranscriptCaptureStatus(dbAccessor);
		const downstreamBacklog = capture.pending + capture.processing;
		if (downstreamBacklog < STALE_SESSION_SWEEP_MAX_DOWNSTREAM_BACKLOG) return false;
		logger.debug("hooks", "Stale session-end sweep deferred while downstream work is backlogged", {
			capturePending: capture.pending,
			captureProcessing: capture.processing,
			backlogLimit: STALE_SESSION_SWEEP_MAX_DOWNSTREAM_BACKLOG,
		});
		return true;
	} catch (error) {
		logger.warn("hooks", "Stale session-end sweep backlog check failed closed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
}

async function runStaleSessionSweep(options: {
	staleOlderThanMs: number;
	limit?: number;
}): Promise<StaleSessionSweepResult> {
	if (shouldDeferStaleSessionSweep()) return { closed: 0, skipped: 0, totalMatching: 0 };

	const requestedLimit = options.limit ?? STALE_SESSION_SWEEP_DEFAULT_LIMIT;
	const limit = Number.isFinite(requestedLimit)
		? Math.max(0, Math.min(STALE_SESSION_SWEEP_MAX_LIMIT, Math.trunc(requestedLimit)))
		: STALE_SESSION_SWEEP_DEFAULT_LIMIT;
	const stale = findStaleLiveSessions(options.staleOlderThanMs, limit);
	let closed = 0;
	const skipped = 0;
	for (const session of stale) {
		if (isSystemPressureHigh()) await awaitPressureClear();
		await yieldToEventLoop();
		// findStaleLiveSessions only returns rows without a completion marker.
		// Marking the row is the atomic dedup boundary for this sweep.

		try {
			await handleSessionEnd({
				harness: session.harness ?? "hermes-agent",
				sessionKey: session.sessionKey,
				agentId: session.agentId,
				cwd: session.project ?? undefined,
				transcript: "",
				reason: "stale-session-sweep",
			});
			closed++;
			await waitForCurrentDeferredSessionEndWork();
		} catch (error) {
			logger.warn("hooks", "Stale session-end sweep failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey: session.sessionKey,
			});
		}
	}
	if (closed > 0 || skipped > 0) {
		logger.info("hooks", "Stale session-end sweep", {
			closed,
			skipped,
			totalMatching: stale.length,
		});
	}
	return { closed, skipped, totalMatching: stale.length };
}

export async function sweepStaleSessions(options: {
	staleOlderThanMs: number;
	limit?: number;
}): Promise<StaleSessionSweepResult> {
	if (staleSessionSweepInFlight) return staleSessionSweepInFlight;
	const work = runStaleSessionSweep(options);
	staleSessionSweepInFlight = work;
	try {
		return await work;
	} finally {
		if (staleSessionSweepInFlight === work) staleSessionSweepInFlight = null;
	}
}

async function deferSessionEndWork(params: {
	sessionKey: string | undefined;
	agentId: string;
	memoryCfg: ResolvedMemoryConfig;
}): Promise<void> {
	const { sessionKey, agentId, memoryCfg } = params;

	const pipelineActive = memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode;
	if (sessionKey && pipelineActive && memoryCfg.pipelineV2.graph.enabled && memoryCfg.pipelineV2.feedback.enabled) {
		try {
			const feedbackPropagatedAttributes = propagateMemoryStatus(getDbAccessor(), agentId);
			if (feedbackPropagatedAttributes > 0) {
				invalidateTraversalCache();
			}
			recordFeedbackTelemetry({ feedbackPropagatedAttributes });
			logger.debug("hooks", "Deferred status propagation completed", {
				sessionKey,
				feedbackPropagatedAttributes,
			});
		} catch (err) {
			logger.warn("hooks", "Deferred status propagation failed", {
				error: err instanceof Error ? err.message : String(err),
				sessionKey,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Mid-session checkpoint extraction (long-lived sessions)
// ---------------------------------------------------------------------------

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
	// is at least as long as what is already stored. Upserting a shorter
	// payload would discard valid canonical content before the final completion
	// marker is written.
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

	// Mid-session evidence remains live and is intentionally not delivered to Dreaming.
	// The completed session transcript is the single canonical delivery path.

	// Flush accumulated continuity data into a checkpoint, then re-init the
	// tracking window so subsequent turns continue accumulating. Unlike
	// session-end, we do NOT release the session claim.
	//
	// Note: consumeState/initContinuity are session-key-scoped (not agentId-
	// scoped) — matching the same design in handleSessionEnd. In the OpenClaw
	// multi-agent model each agent run always has a unique session key, so
	// session-key scoping is sufficient in practice. agentId remains used for
	// transcript retention and per-agent scope enforcement.
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
					recentRemembers: [],
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

	return { skipped: true };
}

export function normalizeSessionTranscript(harness: string, raw: string): string {
	return normalizeSessionTranscriptBase(harness, raw, ({ harness: warningHarness, rawChars }) => {
		logger.warn("hooks", "JSON-line transcript produced no conversation turns", {
			harness: warningHarness,
			rawChars,
		});
	});
}

export { normalizeCodexTranscript, normalizeJsonConversationTranscript };

// ============================================================================
// Memory Synthesis
// ============================================================================

export { getSynthesisWorker, handleSynthesisRequest, setSynthesisWorker, writeMemoryMd };
export type { SynthesisRequest, SynthesisResponse };
