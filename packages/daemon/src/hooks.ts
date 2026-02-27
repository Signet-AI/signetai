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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { logger } from "./logger";
import { getDbAccessor } from "./db-accessor";
import { enqueueSummaryJob } from "./pipeline/summary-worker";
import { getUpdateSummary } from "./update-system";
import { loadMemoryConfig } from "./memory-config";
import { recordSessionCandidates, trackFtsHits } from "./session-memories";
import { listSecrets } from "./secrets";

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");

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

export interface MemorySynthesisConfig {
	harness: string;
	model: string;
	schedule: "daily" | "weekly" | "on-demand";
	max_tokens?: number;
}

export interface SynthesisRequest {
	trigger: "scheduled" | "manual";
}

export interface SynthesisResponse {
	harness: string;
	model: string;
	prompt: string;
	memories: Array<{
		id: string;
		content: string;
		type: string;
		importance: number;
		created_at: string;
	}>;
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
	userPrompt: string;
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

interface MemoryConfig {
	synthesis?: {
		harness?: string;
		model?: string;
		schedule?: "daily" | "weekly" | "on-demand";
		max_tokens?: number;
	};
}

function isAgentConfig(value: unknown): value is AgentConfig {
	return typeof value === "object" && value !== null;
}

function isMemoryConfig(value: unknown): value is MemoryConfig {
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
			injectParts.push(`- ${mem.content}${tagStr}`);
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
	let inject = injectParts.join("\n");
	if (inject.length > maxInject) {
		inject = inject.slice(0, maxInject) + "\n[context truncated]";
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

	return {
		summaryPrompt,
		guidelines,
	};
}

// ============================================================================
// User Prompt Submit
// ============================================================================

export function handleUserPromptSubmit(
	req: UserPromptSubmitRequest,
): UserPromptSubmitResponse {
	const start = Date.now();

	// Extract meaningful words from prompt
	const words = req.userPrompt
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length >= 3)
		.slice(0, 10);

	if (words.length === 0 || !existsSync(MEMORY_DB)) {
		return { inject: "", memoryCount: 0 };
	}

	try {
		const ftsQuery = words.join(" OR ");

		const rows = getDbAccessor().withReadDb((db) => {
			type MemRow = {
				id: string;
				content: string;
				type: string;
				importance: number;
				tags: string | null;
				pinned: number;
				project: string | null;
				created_at: string;
			};

			try {
				const baseQuery = req.project
					? `SELECT m.id, m.content, m.type, m.importance, m.tags,
					   m.pinned, m.project, m.created_at
					   FROM memories m
					   JOIN memories_fts f ON m.rowid = f.rowid
					   WHERE memories_fts MATCH ?
					   AND m.is_deleted = 0
					   AND m.project = ?
					   LIMIT 30`
					: `SELECT m.id, m.content, m.type, m.importance, m.tags,
					   m.pinned, m.project, m.created_at
					   FROM memories m
					   JOIN memories_fts f ON m.rowid = f.rowid
					   WHERE memories_fts MATCH ?
					   AND m.is_deleted = 0
					   LIMIT 30`;

				return req.project
					? (db.prepare(baseQuery).all(ftsQuery, req.project) as MemRow[])
					: (db.prepare(baseQuery).all(ftsQuery) as MemRow[]);
			} catch {
				// FTS table might not exist
				return [] as MemRow[];
			}
		});

		// Score and filter
		const scored = rows
			.map((r) => ({
				...r,
				effScore: effectiveScore(r.importance, r.created_at, r.pinned === 1),
			}))
			.filter((r) => r.effScore > 0.3 || r.pinned === 1)
			.sort((a, b) => b.effScore - a.effScore);

		// Apply 500 char budget
		const selected = selectWithBudget(scored, 500);

		if (selected.length === 0) {
			return { inject: "", memoryCount: 0 };
		}

		// Update access tracking
		const ids = scored
			.slice(0, selected.length)
			.map((s) => (s as ScoredMemory).id);
		updateAccessTracking(ids);

		// Track FTS hits for predictive scorer data collection
		const allMatchedIds = scored.map((s) => s.id);
		trackFtsHits(req.sessionKey, allMatchedIds);

		const queryTerms = words.join(" ");
		const lines = selected.map((s) => `- ${s.content}`);
		const inject = `[signet:recall | query="${queryTerms}" | results=${selected.length} | engine=fts+decay]\n${lines.join("\n")}`;

		const duration = Date.now() - start;
		logger.info("hooks", "User prompt submit", {
			harness: req.harness,
			project: req.project,
			sessionKey: req.sessionKey,
			memoryCount: selected.length,
			prompt: req.userPrompt,
			injectChars: inject.length,
			inject,
			durationMs: duration,
		});

		return {
			inject,
			memoryCount: selected.length,
			queryTerms,
			engine: "fts+decay",
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
	if (req.reason === "clear") {
		return { memoriesSaved: 0 };
	}

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
			transcript = readFileSync(req.transcriptPath, "utf-8");
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
		sessionKey: req.sessionKey || req.sessionId,
		project: req.cwd,
	});

	logger.info("hooks", "Session end queued for summary", { jobId });
	logger.info("hooks", "Session end transcript queued", {
		harness: req.harness,
		project: req.cwd,
		sessionKey: req.sessionKey || req.sessionId,
		transcriptPath: req.transcriptPath,
		transcriptChars: transcript.length,
		queuedChars: truncated.length,
		transcript: truncated,
	});

	return { memoriesSaved: 0, queued: true, jobId };
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
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			);

			return id;
		});

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

function loadSynthesisConfig(): MemorySynthesisConfig {
	const configPath = join(AGENTS_DIR, "agent.yaml");

	const defaults: MemorySynthesisConfig = {
		harness: "openclaw",
		model: "sonnet",
		schedule: "daily",
		max_tokens: 4000,
	};

	if (!existsSync(configPath)) {
		return defaults;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const config = parseSimpleYaml(content);
		const memory = config.memory;
		const synthesis = isMemoryConfig(memory) ? memory.synthesis : undefined;

		return {
			harness: synthesis?.harness || defaults.harness,
			model: synthesis?.model || defaults.model,
			schedule: synthesis?.schedule || defaults.schedule,
			max_tokens: synthesis?.max_tokens || defaults.max_tokens,
		};
	} catch {
		return defaults;
	}
}

export function handleSynthesisRequest(
	req: SynthesisRequest,
): SynthesisResponse {
	const config = loadSynthesisConfig();

	logger.info("hooks", "Synthesis request", { trigger: req.trigger });

	const memories = getRecentMemories(100, 0.5);

	const prompt = `You are regenerating MEMORY.md - a synthesized summary of the agent's memory system.

Review the following memories and create a coherent, organized summary that captures:
- Current active projects and their status
- Key decisions and their rationale
- Important people, preferences, and relationships
- Technical notes and learnings
- Open threads and todos

Format the output as clean markdown with clear sections. Be concise but complete.
Maximum length: ${config.max_tokens} tokens.

## Memories to Synthesize

${memories.map((m) => `- [${m.type}] ${m.content}`).join("\n")}
`;

	return {
		harness: config.harness,
		model: config.model,
		prompt,
		memories,
	};
}

export function getSynthesisConfig(): MemorySynthesisConfig {
	return loadSynthesisConfig();
}
