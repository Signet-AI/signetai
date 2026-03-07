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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { logger } from "./logger";
import { getDbAccessor } from "./db-accessor";
import { fetchEmbedding } from "./embedding-fetch";
import { hybridRecall } from "./memory-search";
import { enqueueSummaryJob } from "./pipeline/summary-worker";
import { getUpdateSummary } from "./update-system";
import { loadMemoryConfig } from "./memory-config";
import { recordSessionCandidates, trackFtsHits } from "./session-memories";
import { listSecrets } from "./secrets";
import {
	initContinuity,
	recordPrompt,
	recordRemember,
	shouldCheckpoint,
	consumeState,
	clearContinuity,
} from "./continuity-state";
import {
	getLatestCheckpoint,
	getLatestCheckpointBySession,
	formatPeriodicDigest,
	formatPreCompactionDigest,
	formatSessionEndDigest,
	writeCheckpoint,
	queueCheckpointWrite,
	flushPendingCheckpoints,
} from "./session-checkpoints";

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");

function formatMemoryDate(isoDate: string): string {
	const d = new Date(isoDate);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ============================================================================
// Types
// ============================================================================

export interface HooksConfig {
	sessionStart?: {
		recallLimit?: number;
		includeIdentity?: boolean;
		includeRecentContext?: boolean;
		recencyBias?: number;
		query?: string;
		maxInjectChars?: number;
	};
	preCompaction?: {
		summaryGuidelines?: string;
		includeRecentMemories?: boolean;
		memoryLimit?: number;
	};
}

export interface SynthesisRequest {
	trigger: "scheduled" | "manual";
}

export interface SynthesisResponse {
	harness: string;
	model: string;
	prompt: string;
	/** Number of session summary files included in the prompt. */
	fileCount: number;
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
	userMessage?: string;
	userPrompt?: string;
	rawPrompt?: string;
	lastAssistantMessage?: string;
	sessionKey?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface UserPromptSubmitResponse {
	inject: string;
	memoryCount: number;
	queryTerms?: string;
	engine?: string;
}

export interface SessionEndRequest {
	harness: string;
	transcriptPath?: string;
	sessionId?: string;
	sessionKey?: string;
	cwd?: string;
	reason?: string;
	runtimePath?: "plugin" | "legacy";
}

export interface SessionEndResponse {
	memoriesSaved: number;
	queued?: boolean;
	jobId?: string;
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
export function effectiveScore(
	importance: number,
	createdAt: string,
	pinned: boolean,
): number {
	if (pinned) return 1.0;
	const ageDays =
		(Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
	return importance * 0.95 ** ageDays;
}

/** Truncate rows to fit a character budget, preserving the input type */
export function selectWithBudget<T extends { content: string }>(
	rows: ReadonlyArray<T>,
	charBudget: number,
): T[] {
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
				.prepare(
					"SELECT MAX(completed_at) as last_end FROM summary_jobs WHERE status = 'completed'",
				)
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
				.prepare(
					"SELECT COUNT(*) as cnt FROM memories WHERE created_at > ? AND is_deleted = 0",
				)
				.get(lastEnd) as { cnt: number };

			// Count sessions since last session
			const sessionCount = db
				.prepare(
					"SELECT COUNT(*) as cnt FROM summary_jobs WHERE completed_at > ? AND status = 'completed'",
				)
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
			.prepare(
				"SELECT content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 10",
			)
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

function readIdentityFile(
	fileName: string,
	charBudget: number,
): string | undefined {
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
	effScore: number;
}

/**
 * Return all memories that pass the 0.2 effective score threshold,
 * sorted by project match + score. No budget applied — caller
 * handles truncation via selectWithBudget().
 */
export function getAllScoredCandidates(
	project: string | undefined,
	limit: number,
): ScoredMemory[] {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, content, type, importance, tags, pinned, project, created_at
					 FROM memories WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?`,
					)
					.all(limit * 3) as Array<{
					id: string;
					content: string;
					type: string;
					importance: number;
					tags: string | null;
					pinned: number;
					project: string | null;
					created_at: string;
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

/** Backwards-compatible wrapper: scored candidates + budget selection */
function getProjectMemories(
	project: string | undefined,
	limit: number,
	charBudget: number,
): ScoredMemory[] {
	const candidates = getAllScoredCandidates(project, limit);
	return selectWithBudget(candidates.slice(0, limit), charBudget);
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
): ScoredMemory[] {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		// Get recent session summaries for this project
		const summaryRows = getDbAccessor().withReadDb((db) => {
			if (project) {
				return db
					.prepare(
						`SELECT transcript FROM summary_jobs
						 WHERE project = ? AND status = 'completed'
						 ORDER BY created_at DESC LIMIT 5`,
					)
					.all(project) as Array<{ transcript: string }>;
			}
			return db
				.prepare(
					`SELECT transcript FROM summary_jobs
					 WHERE status = 'completed'
					 ORDER BY created_at DESC LIMIT 5`,
				)
				.all() as Array<{ transcript: string }>;
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
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.id, m.content, m.type, m.importance, m.tags,
						        m.pinned, m.project, m.created_at
						 FROM memories_fts
						 JOIN memories m ON memories_fts.rowid = m.rowid
						 WHERE memories_fts MATCH ?
						   AND m.is_deleted = 0
						 ORDER BY bm25(memories_fts)
						 LIMIT ?`,
					)
					.all(ftsQuery, limit * 2) as Array<{
					id: string;
					content: string;
					type: string;
					importance: number;
					tags: string | null;
					pinned: number;
					project: string | null;
					created_at: string;
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

function loadHooksConfig(): HooksConfig {
	const configPath = join(AGENTS_DIR, "agent.yaml");
	if (!existsSync(configPath)) {
		return getDefaultConfig();
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const config = parseSimpleYaml(content);
		return config.hooks || getDefaultConfig();
	} catch (e) {
		logger.warn("hooks", "Failed to load hooks config, using defaults");
		return getDefaultConfig();
	}
}

function getDefaultConfig(): HooksConfig {
	return {
		sessionStart: {
			recallLimit: 10,
			includeIdentity: true,
			includeRecentContext: true,
			recencyBias: 0.7,
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
			const descMatch =
				content.match(/creature:\s*(.+)/i) || content.match(/role:\s*(.+)/i);
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
			return db.prepare(`
				SELECT id, content, type, importance, created_at
				FROM memories
				WHERE is_deleted = 0 AND created_at > ?
				ORDER BY created_at DESC
				LIMIT ?
			`).all(sinceIso, limit) as Array<{
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

export function handleSessionStart(
	req: SessionStartRequest,
): SessionStartResponse {
	const start = Date.now();
	const config = loadHooksConfig().sessionStart || {};
	const includeIdentity = config.includeIdentity !== false;

	logger.info("hooks", "Session start hook", {
		harness: req.harness,
		project: req.project,
	});

	// Initialize continuity state for checkpoint accumulation
	if (req.sessionKey) {
		initContinuity(req.sessionKey, req.harness, req.project);
	}

	const identity = includeIdentity ? loadIdentity() : { name: "Agent" };

	// Read AGENTS.md first so harness instructions precede synthesized memory
	const agentsMdContent = includeIdentity ? readAgentsMd(12000) : undefined;

	// Read MEMORY.md with 10k char budget
	const memoryMdContent = readMemoryMd(10000);

	// Get all scored candidates (no budget yet — need full pool for recording)
	const recallLimit = config.recallLimit ?? 30;
	const allCandidates = getAllScoredCandidates(req.project, recallLimit);

	// Apply budget to select what we actually inject
	const memories = selectWithBudget(allCandidates.slice(0, recallLimit), 2000);

	// Get predicted context from recent session analysis (~30% of budget)
	const existingIds = new Set(memories.map((m) => m.id));
	const predictedMemories = getPredictedContextMemories(
		req.project,
		10,
		600,
		existingIds,
	);
	if (predictedMemories.length > 0) {
		memories.push(...predictedMemories);
	}

	// Update access tracking for served memories
	const servedIds = memories.map((m) => m.id);
	updateAccessTracking(servedIds);

	// Record all candidates + which were injected for predictive scorer
	const injectedSet = new Set(memories.map((m) => m.id));
	const candidatesForRecording = [
		...allCandidates.map((c) => ({
			id: c.id,
			effScore: c.effScore,
			source: "effective" as const,
		})),
		...predictedMemories
			.filter((m) => !allCandidates.some((c) => c.id === m.id))
			.map((m) => ({
				id: m.id,
				effScore: m.effScore,
				source: "effective" as const,
			})),
	];
	recordSessionCandidates(req.sessionKey, candidatesForRecording, injectedSet);

	// Format inject text
	const injectParts: string[] = [];
	let recoverySection = "";

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

	if (agentsMdContent) {
		injectParts.push("\n## Agent Instructions\n");
		injectParts.push(agentsMdContent);
	} else if (identity.name !== "Agent" || identity.description) {
		injectParts.push(
			`You are ${identity.name}${identity.description ? `, ${identity.description}` : ""}.`,
		);
	}

	// Inject additional identity files
	const soulContent = includeIdentity
		? readIdentityFile("SOUL.md", 4000)
		: undefined;
	const identityContent = includeIdentity
		? readIdentityFile("IDENTITY.md", 2000)
		: undefined;
	const userContent = includeIdentity
		? readIdentityFile("USER.md", 6000)
		: undefined;

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

	// Inject session recovery context from recent checkpoints
	const memoryCfg = loadMemoryConfig(AGENTS_DIR);
	const continuityCfg = memoryCfg.pipelineV2.continuity;
	if (continuityCfg.enabled) {
		try {
			const dbAcc = getDbAccessor();
			const withinMs = 4 * 60 * 60 * 1000; // 4 hours

			// Priority 1: session key lineage (same or previous session)
			let checkpoint = req.sessionKey
				? getLatestCheckpointBySession(dbAcc, req.sessionKey)
				: undefined;

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
				let recoveryText = checkpoint.digest;
				if (recoveryText.length > continuityCfg.recoveryBudgetChars) {
					recoveryText =
						recoveryText.slice(0, continuityCfg.recoveryBudgetChars) +
						"\n[truncated]";
				}
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
			injectParts.push(
				"Use the `secret_exec` MCP tool to run commands with these secrets injected as env vars.\n",
			);
			for (const name of secretNames) {
				injectParts.push(`- ${name}`);
			}
		}
	} catch {
		// Secrets store may not exist yet — non-fatal
	}

	const duration = Date.now() - start;
	const maxInject = config.maxInjectChars ?? 24000;
	// Pre-reserve space for recovery context so it's never truncated
	const reservedChars = recoverySection.length;
	const mainBudget = maxInject - reservedChars;
	let inject = injectParts.join("\n");
	if (inject.length > mainBudget) {
		inject = inject.slice(0, mainBudget) + "\n[context truncated]";
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
		injectChars: inject.length,
		inject,
		durationMs: duration,
	});

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
	};
}

export function handlePreCompaction(
	req: PreCompactionRequest,
): PreCompactionResponse {
	const config = loadHooksConfig().preCompaction || {};

	logger.info("hooks", "Pre-compaction hook", {
		harness: req.harness,
		messageCount: req.messageCount,
	});

	const guidelines =
		config.summaryGuidelines ||
		(getDefaultConfig().preCompaction?.summaryGuidelines ?? "");

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
			writeCheckpoint(getDbAccessor(), {
				sessionKey: snap.sessionKey,
				harness: snap.harness,
				project: snap.project,
				projectNormalized: snap.projectNormalized,
				trigger: "pre_compaction",
				digest,
				promptCount: snap.promptCount,
				memoryQueries: snap.pendingQueries,
				recentRemembers: snap.pendingRemembers,
			}, cfg.maxCheckpointsPerSession);
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
	/conversation info \(untrusted metadata\)\s*:/i;

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
	return stripUntrustedMetadata(text)
		.toLowerCase()
		.split(/\W+/)
		.filter(
			(word) =>
				word.length >= 3 &&
				!RECALL_STOPWORDS.has(word) &&
				!/^\d+$/.test(word),
		);
}

function buildRecallQueryShape(
	userPrompt: string,
	lastAssistantMessage?: string,
): RecallQueryShape {
	const userTerms = extractSubstantiveWords(userPrompt);
	const assistantTerms = lastAssistantMessage
		? extractSubstantiveWords(lastAssistantMessage)
		: [];
	const keywordTerms = [...new Set([...userTerms, ...assistantTerms])].slice(0, 12);
	const vectorQuery = stripUntrustedMetadata(userPrompt).trim().slice(0, 200);
	return { keywordTerms, vectorQuery };
}

function resolveRecallUserMessage(req: UserPromptSubmitRequest): string {
	if (typeof req.userMessage === "string") {
		const cleaned = req.userMessage.trim();
		if (cleaned.length > 0) {
			return cleaned;
		}
	}

	const raw = typeof req.userPrompt === "string" ? req.userPrompt : "";
	return stripUntrustedMetadata(raw).trim();
}

export async function handleUserPromptSubmit(
	req: UserPromptSubmitRequest,
): Promise<UserPromptSubmitResponse> {
	const start = Date.now();
	const userMessage = resolveRecallUserMessage(req);
	const { keywordTerms, vectorQuery } = buildRecallQueryShape(
		userMessage,
		req.lastAssistantMessage,
	);

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
					},
					cfg.maxCheckpointsPerSession,
				);
			}
		}
	}

	if (
		keywordTerms.length < 2 ||
		vectorQuery.length === 0 ||
		!existsSync(MEMORY_DB)
	) {
		return { inject: "", memoryCount: 0 };
	}

	try {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const recall = await hybridRecall(
			{
				query: vectorQuery,
				keywordQuery: keywordTerms.join(" OR "),
				limit: 10,
				importance_min: 0.3,
			},
			cfg,
			fetchEmbedding,
		);

		if (
			recall.results.length === 0 ||
			typeof recall.results[0]?.score !== "number" ||
			recall.results[0].score < 0.4
		) {
			return { inject: "", memoryCount: 0 };
		}

		const selected = selectWithBudget(
			recall.results.map((result) => ({
				...result,
				pinned: result.pinned ? 1 : 0,
			})),
			500,
		).slice(0, 5);

		if (selected.length === 0) {
			return { inject: "", memoryCount: 0 };
		}

		// Track FTS hits for predictive scorer data collection
		const allMatchedIds = recall.results.map((result) => result.id);
		trackFtsHits(req.sessionKey, allMatchedIds);

		const queryTerms = keywordTerms.join(" ");
		const lines = selected.map((s) => {
			const dateStr = formatMemoryDate(s.created_at);
			return `- ${s.content} (${dateStr})`;
		});
		const inject = `[signet:recall | query="${queryTerms}" | results=${selected.length} | engine=hybrid]\n${lines.join("\n")}`;

		const duration = Date.now() - start;
		logger.info("hooks", "User prompt submit", {
			harness: req.harness,
			project: req.project,
			sessionKey: req.sessionKey,
			memoryCount: selected.length,
			prompt: userMessage,
			injectChars: inject.length,
			inject,
			durationMs: duration,
		});

		return {
			inject,
			memoryCount: selected.length,
			queryTerms,
			engine: "hybrid",
		};
	} catch (e) {
		logger.error("hooks", "User prompt submit failed", e as Error);
		return { inject: "", memoryCount: 0 };
	}
}

// ============================================================================
// Session End
// ============================================================================

export function handleSessionEnd(
	req: SessionEndRequest,
): SessionEndResponse {
	const sessionKey = req.sessionKey || req.sessionId;

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
			writeCheckpoint(getDbAccessor(), {
				sessionKey: snap.sessionKey,
				harness: snap.harness,
				project: snap.project,
				projectNormalized: snap.projectNormalized,
				trigger: "session_end",
				digest: formatSessionEndDigest(snap),
				promptCount: snap.totalPromptCount,
				memoryQueries: snap.pendingQueries,
				recentRemembers: snap.pendingRemembers,
			}, cfg.maxCheckpointsPerSession);
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

	// Read transcript if available
	let transcript = "";
	if (req.transcriptPath && existsSync(req.transcriptPath)) {
		try {
			const rawTranscript = readFileSync(req.transcriptPath, "utf-8");
			transcript =
				req.harness === "codex"
					? normalizeCodexTranscript(rawTranscript)
					: rawTranscript;
		} catch {
			logger.warn("hooks", "Could not read transcript", {
				path: req.transcriptPath,
			});
		}
	}

	if (transcript.length < 500) {
		return { memoriesSaved: 0 };
	}

	// Truncate long transcripts for the LLM
	const maxChars = 12000;
	const truncated =
		transcript.length > maxChars
			? `${transcript.slice(0, maxChars)}\n[truncated]`
			: transcript;

	// Queue for async processing by the summary worker instead of
	// blocking on LLM inference. The worker produces both a dated
	// markdown summary and atomic fact rows.
	const jobId = enqueueSummaryJob(getDbAccessor(), {
		harness: req.harness,
		transcript: truncated,
		sessionKey,
		project: req.cwd,
	});

	logger.info("hooks", "Session end queued for summary", { jobId });
	logger.info("hooks", "Session end transcript queued", {
		harness: req.harness,
		project: req.cwd,
		sessionKey,
		transcriptPath: req.transcriptPath,
		transcriptChars: transcript.length,
		queuedChars: truncated.length,
		transcript: truncated,
	});

	return { memoriesSaved: 0, queued: true, jobId };
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
			const payload = event.payload;
			if (typeof payload === "object" && payload !== null) {
				const meta = payload as Record<string, unknown>;
				const cwd = typeof meta.cwd === "string" ? meta.cwd : "";
				const model = typeof meta.model === "string"
					? meta.model
					: typeof meta.model_provider === "string"
						? meta.model_provider
						: "";
				if (cwd || model) {
					lines.push(`Session: cwd=${cwd || "unknown"}, model=${model || "unknown"}`);
				}
			}
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
					lines.push(`User: ${msg.message.trim()}`);
				}
			}
			continue;
		}

		if (event.type === "item.completed") {
			const item = event.item;
			if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>;
				if (record.type === "agent_message" && typeof record.text === "string") {
					lines.push(`Assistant: ${record.text.trim()}`);
				}
			}
			continue;
		}

		if (event.type === "response_item") {
			const payload = event.payload;
			if (typeof payload === "object" && payload !== null) {
				const item = payload as Record<string, unknown>;
				if (item.type === "function_call") {
					const name = typeof item.name === "string" ? item.name : "tool";
					const args = typeof item.arguments === "string" ? item.arguments : "";
					lines.push(`Tool call (${name}): ${args}`);
				}
				if (item.type === "function_call_output" && typeof item.output === "string") {
					lines.push(`Tool output: ${item.output.trim().slice(0, 1000)}`);
				}
			}
		}
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
					const existing = db
						.prepare(
							"SELECT id FROM memories WHERE idempotency_key = ?",
						)
						.get(req.idempotencyKey) as { id: string } | undefined;

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
						? (db
								.prepare(baseQuery)
								.all(ftsQuery, req.project, limit) as RecallRow[])
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
					? (db
							.prepare(baseQuery)
							.all(likePattern, req.project, limit) as RecallRow[])
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
export function writeMemoryMd(content: string): { ok: true } | { ok: false; error: string } {
	// Last-resort guard: refuse to overwrite MEMORY.md with JSON blobs
	const trimmed = content.trim();
	if (!trimmed) {
		logger.error("hooks", "Refusing to write empty content to MEMORY.md");
		return { ok: false, error: "Refusing to write empty content to MEMORY.md" };
	}
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			JSON.parse(trimmed);
			// Parsed successfully — it's JSON, not markdown
			logger.error("hooks", "Refusing to write JSON to MEMORY.md",
				undefined, { preview: trimmed.slice(0, 200) });
			return { ok: false, error: "Refusing to write JSON to MEMORY.md" };
		} catch {
			// Not valid JSON — markdown that starts with [ or { is fine
		}
	}

	const memoryMdPath = join(AGENTS_DIR, "MEMORY.md");
	if (existsSync(memoryMdPath)) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const backupPath = join(AGENTS_DIR, "memory", `MEMORY.backup-${timestamp}.md`);
		mkdirSync(join(AGENTS_DIR, "memory"), { recursive: true });
		writeFileSync(backupPath, readFileSync(memoryMdPath, "utf-8"));
	}
	const header = `<!-- generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} -->\n\n`;
	writeFileSync(memoryMdPath, header + content);
	return { ok: true };
}

/**
 * Build a synthesis prompt. When sinceTimestamp is provided, only memories
 * created after that time are included (incremental merge). Otherwise
 * falls back to the top 100 by importance/recency (full regeneration).
 */
export function handleSynthesisRequest(
	req: SynthesisRequest,
	opts?: { maxTokens?: number; sinceTimestamp?: number },
): SynthesisResponse {
	const maxTokens = opts?.maxTokens ?? 8000;
	const charBudget = maxTokens * 4; // rough char-to-token estimate

	logger.info("hooks", "Synthesis request", { trigger: req.trigger });

	// Read existing MEMORY.md for merge-based synthesis
	const memoryMdPath = join(AGENTS_DIR, "MEMORY.md");
	let existingContent = "";
	if (existsSync(memoryMdPath)) {
		try {
			const raw = readFileSync(memoryMdPath, "utf-8")
				.replace(/^<!-- generated .* -->\n\n?/, "")
				.trim();
			// Cap existing content to avoid blowing up the prompt
			if (raw.length > charBudget) {
				logger.warn("hooks", "Truncating large MEMORY.md for synthesis", {
					originalChars: raw.length,
					budgetChars: charBudget,
				});
				existingContent = raw.slice(0, charBudget);
			} else {
				existingContent = raw;
			}
		} catch {
			// ignore read errors
		}
	}

	// Read session summary files from memory directory
	const memoryDir = join(AGENTS_DIR, "memory");
	const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
	let sessionFiles: string[] = [];

	if (existsSync(memoryDir)) {
		try {
			sessionFiles = readdirSync(memoryDir)
				.filter((f) => f.endsWith(".md") && DATE_PREFIX.test(f))
				.sort()
				.reverse(); // newest first
		} catch {
			// ignore read errors
		}
	}

	// Collect file contents up to char budget, skipping files older than sinceTimestamp
	const sinceMs = opts?.sinceTimestamp ?? 0;
	const sessionBlocks: string[] = [];
	let cumChars = 0;
	for (const file of sessionFiles) {
		if (cumChars >= charBudget) break;
		try {
			const filePath = join(memoryDir, file);
			if (sinceMs > 0 && statSync(filePath).mtimeMs < sinceMs) continue;
			const content = readFileSync(filePath, "utf-8").trim();
			if (content.length === 0) continue;
			sessionBlocks.push(content);
			cumChars += content.length;
		} catch {
			// skip unreadable files
		}
	}

	const sessionsBlock = sessionBlocks.join("\n\n---\n\n");

	const prompt = existingContent
		? `You are updating MEMORY.md — a working memory summary for an AI agent.

## Current MEMORY.md

${existingContent}

## Session Summaries

${sessionsBlock}

Instructions:
- Preserve existing sections and structure
- Update entries that have new information from session summaries
- Add new projects, decisions, context, or technical notes that appeared
- Remove only items that are clearly superseded or obsolete
- Keep the document well-organized with clear sections
- This is a working document, not a changelog — keep it current-state focused
- Be concise (target under ${maxTokens} tokens)
- Do not include a generated timestamp — that is added automatically
- Output the full updated MEMORY.md content`
		: `You are generating MEMORY.md — a working memory summary for an AI agent.

## Session Summaries

${sessionsBlock}

Instructions:
- Create a coherent, organized summary capturing:
  - Current active projects and their status
  - Key decisions and their rationale
  - Important people, preferences, and relationships
  - Technical notes and learnings
  - Open threads and todos
- Format as clean markdown with clear sections
- Be concise but complete (target under ${maxTokens} tokens)
- Do not include a generated timestamp — that is added automatically`;

	return {
		harness: "daemon",
		model: "synthesis",
		prompt,
		fileCount: sessionBlocks.length,
	};
}
