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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";
import { ensureAgentRegistered, getAgentScope, resolveAgentId } from "./agent-id";
import { applyTokenBudget, selectWithTokenBudget } from "./context-budget";
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
import { getDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import {
	DEFAULT_SESSION_START_MAX_INJECT_TOKENS,
	type HooksConfig,
	getDefaultHooksConfig,
	loadHooksConfig as loadHooksConfigFromDisk,
	resolveUserPromptMinScore,
} from "./hooks-config";
import { loadIdentity, readAgentsMd, readIdentityFile, readMemoryMd, resolveIdentityFiles } from "./identity-context";
import { propagateMemoryStatus } from "./knowledge-graph";
import { logger } from "./logger";
import { buildAgentScopeClause } from "./memory-access-scope";
import * as memoryCandidates from "./memory-candidates";
import { type ScoredMemory, buildActiveConstraintsSection } from "./memory-candidates";
import { effectiveScore, inferType, isDuplicate } from "./memory-classification";
import { loadMemoryConfig } from "./memory-config";
import { ensureCanonicalManifest, indexCanonicalTranscriptJsonl } from "./memory-lineage";
import { hybridRecall } from "./memory-search";
import {
	type SynthesisRequest,
	type SynthesisResponse,
	getSynthesisWorker,
	handleSynthesisRequest,
	setSynthesisWorker,
	writeMemoryMd,
} from "./memory-synthesis";
import {
	applyFtsOverlapFeedback,
	decayAspectWeights,
	getFeedbackTelemetry,
	recordFeedbackTelemetry,
	shouldRunSessionDecay,
} from "./pipeline/aspect-feedback";
import {
	invalidateTraversalCache,
	resolveFocalEntities,
	setTraversalStatus,
	traverseKnowledgeGraph,
} from "./pipeline/graph-traversal";
import { enqueueSummaryJob } from "./pipeline/summary-worker";
import { countTokens } from "./pipeline/tokenizer";
import { getDefaultPluginHost } from "./plugins/index";
import type { PluginPromptTargetV1 } from "./plugins/types";
import { buildEntityContextInject, buildEntityPromptContext } from "./prompt-entity-context";
import { buildRecallQueryShape, queryAnchorsMissingFromRecall, stripUntrustedMetadata } from "./prompt-text";
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
	type SessionMemoryCandidate,
	parseFeedback,
	recordAgentFeedback,
	recordSessionCandidates,
	trackFtsHits,
} from "./session-memories";
import { isNoiseSession } from "./session-noise";
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
	getSessionTranscriptContent,
	upsertSessionTranscript,
} from "./session-transcripts";
import { type StructuralFeatures, getStructuralFeatures } from "./structural-features";
import { assembleInheritedContextBlock, resolveParentSession } from "./subagent-context";
import { searchTemporalFallback } from "./temporal-fallback";
import { writeTranscriptAudit } from "./transcript-audit";
import * as transcriptCapture from "./transcript-capture";
import { canonicalTranscriptRelativePath } from "./transcript-jsonl";
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

export async function flushDeferredSessionEndWorkForTests(): Promise<void> {
	await Promise.allSettled([...deferredSessionEndWork]);
}

function loadDbAccessor() {
	try {
		return getDbAccessor();
	} catch {
		return null;
	}
}

// ============================================================================
// Types
// ============================================================================

export type { HooksConfig };

export interface SessionStartRequest {
	harness: string;
	project?: string;
	agentId?: string;
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
	agentId?: string;
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

function fetchTraversalCandidates(memoryIds: ReadonlyArray<string>, agentId: string): ScoredMemory[] {
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
	readPolicy = "isolated",
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
	readPolicy = "isolated",
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

function updateAccessTracking(ids: string[]): void {
	memoryCandidates.updateAccessTracking(getMemoryDbPath(), ids);
}

// ============================================================================
// Config Loading
// ============================================================================

function loadHooksConfig(): HooksConfig {
	return loadHooksConfigFromDisk(getAgentsDir());
}

// ============================================================================
// Memory Queries
// ============================================================================

function getRecentMemories(
	limit: number,
	recencyBias = 0.7,
	agentScope?: { agentId: string; readPolicy: string; policyGroup: string | null },
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

			return db.prepare(query).all(...scope.args, limit) as Array<{
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
	return memoryCandidates.getMemoriesSince(getMemoryDbPath(), sinceMs, limit);
}

// ============================================================================
// Hook Handlers
// ============================================================================

export async function handleSessionStart(req: SessionStartRequest): Promise<SessionStartResponse> {
	const start = Date.now();
	const agentId = resolveAgentId(req);
	ensureAgentRegistered(agentId);
	const config = loadHooksConfig().sessionStart || {};
	const memoryCfg = loadMemoryConfig(getAgentsDir());
	const includeIdentity = config.includeIdentity !== false;

	logger.info("hooks", "Session start hook", {
		harness: req.harness,
		project: req.project,
	});

	if (isClearSessionStart(req)) {
		const sessionKey = req.sessionKey?.trim();
		const recoveredJobId = recoverMissingSessionEndOnClearStart(req, agentId, memoryCfg, new Date().toISOString());
		clearSessionStartDedupe(req);
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
			recoveredSummaryJob: recoveredJobId,
		});
	}

	// Dedup guard: if we already sent a full inject for this session, return
	// a minimal stub. Identity files / MEMORY.md are already in the context.
	// Must fire BEFORE initContinuity to avoid resetting accumulated state.
	pruneSessionStartDedupe();
	if (hasSessionStartDedupe(req)) {
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

	const agentsDir = getAgentsDir();
	const identityFiles = resolveIdentityFiles(agentId, agentsDir);
	const identity = includeIdentity ? loadIdentity(agentsDir, identityFiles) : { name: "Agent" };

	// Read AGENTS.md first so harness instructions precede synthesized memory
	const agentsMdContent = includeIdentity ? readAgentsMd(agentsDir, 12000, identityFiles) : undefined;

	// Read MEMORY.md with 10k char budget
	const memoryMdContent = readMemoryMd(agentsDir, 10000, identityFiles);

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
	const _candidatesStart = Date.now();
	const allCandidates = getAllScoredCandidates(
		req.project,
		recallLimit,
		traversalAgentId,
		agentScope.readPolicy,
		agentScope.policyGroup,
	);
	const candidatesMs = Date.now() - _candidatesStart;
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
		traversalMs = Date.now() - _traversalStart;
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
	const soulContent = includeIdentity ? readIdentityFile(agentsDir, "SOUL.md", 4000, identityFiles) : undefined;
	const identityContent = includeIdentity ? readIdentityFile(agentsDir, "IDENTITY.md", 2000, identityFiles) : undefined;
	const userContent = includeIdentity ? readIdentityFile(agentsDir, "USER.md", 6000, identityFiles) : undefined;

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
		phaseMs: {
			candidates: candidatesMs,
			traversal: traversalMs,
			inject: duration - candidatesMs - traversalMs,
		},
	});

	// Mark this session as having received the full inject
	markSessionStartDedupe(req);

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

	const guidelines = config.summaryGuidelines || (getDefaultHooksConfig().preCompaction?.summaryGuidelines ?? "");

	let summaryPrompt = `Pre-compaction memory flush. Store durable memories now.

${guidelines}

`;

	if (config.includeRecentMemories !== false) {
		const agentId = resolveAgentId(req);
		const agentScope = getAgentScope(agentId);
		const recentMemories = getRecentMemories(config.memoryLimit || 5, 0.9, { agentId, ...agentScope });
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
		const entityContext = await buildEntityPromptContext({
			userMessage,
			agentId,
			minScore: resolveUserPromptMinScore(submitCfg.minScore),
			injectBudget,
			memoryDbPath: getMemoryDbPath(),
			fetchEmbedding: deps.fetchEmbedding,
			embedding: cfg.embedding,
		});
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

function isClearSessionStart(req: SessionStartRequest): boolean {
	return req.source?.trim().toLowerCase() === "clear";
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
		clearSessionStartDedupe(req);
		clearRawSessionStartDedupeKey(sessionKey);
		advanceRecallContextEpoch({
			sessionKey: sessionStartRecallKey(req),
			agentId,
			reason: "session-clear",
			sourceRef: sessionKey ?? null,
		});
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

	const pipelineEnabled = memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode || memoryCfg.dreaming.enabled;
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
				await transcriptCapture.writeCanonicalTranscriptFromSnapshot({
					basePath: getAgentsDir(),
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
	if (!memoryCfg.pipelineV2.enabled && !memoryCfg.pipelineV2.shadowMode && !memoryCfg.dreaming.enabled) {
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
	return normalizeSessionTranscriptBase(harness, raw, ({ harness: warningHarness, rawChars }) => {
		logger.warn("hooks", "JSON-line transcript produced no conversation turns", {
			harness: warningHarness,
			rawChars,
		});
	});
}

export { normalizeCodexTranscript, normalizeJsonConversationTranscript };

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

export { getSynthesisWorker, handleSynthesisRequest, setSynthesisWorker, writeMemoryMd };
export type { SynthesisRequest, SynthesisResponse };
