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

/** Truncate rows to fit a character budget */
export function selectWithBudget(
	rows: ReadonlyArray<{ content: string }>,
	charBudget: number,
): Array<{ content: string }> {
	const selected: Array<{ content: string }> = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.content.length > charBudget) break;
		selected.push(row);
		used += row.content.length;
	}
	return selected;
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

function readMemoryMd(charBudget: number): string | undefined {
	const memoryMd = join(AGENTS_DIR, "MEMORY.md");
	if (!existsSync(memoryMd)) return undefined;

	try {
		const content = readFileSync(memoryMd, "utf-8");
		if (content.length <= charBudget) return content;
		return `${content.slice(0, charBudget)}\n[truncated]`;
	} catch {
		return undefined;
	}
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

interface ScoredMemory {
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

function getProjectMemories(
	project: string | undefined,
	limit: number,
	charBudget: number,
): ScoredMemory[] {
	if (!existsSync(MEMORY_DB)) return [];

	try {
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, content, type, importance, tags, pinned, project, created_at
					 FROM memories ORDER BY created_at DESC LIMIT ?`,
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

		// Apply budget
		const selected: ScoredMemory[] = [];
		let used = 0;
		for (const row of scored) {
			if (selected.length >= limit) break;
			if (used + row.content.length > charBudget) break;
			selected.push(row);
			used += row.content.length;
		}
		return selected;
	} catch (e) {
		logger.error("hooks", "Failed to get project memories", e as Error);
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

	// Get project memories with scoring
	const memories = getProjectMemories(req.project, 30, 2000);

	// Update access tracking for served memories
	const servedIds = memories.map((m) => m.id);
	updateAccessTracking(servedIds);

	// Format inject text
	const injectParts: string[] = [];

	injectParts.push("[memory active | /remember | /recall]");

	if (agentsMdContent) {
		injectParts.push("\n## Agent Instructions\n");
		injectParts.push(agentsMdContent);
	} else if (identity.name !== "Agent" || identity.description) {
		injectParts.push(
			`You are ${identity.name}${identity.description ? `, ${identity.description}` : ""}.`,
		);
	}

	if (memoryMdContent) {
		injectParts.push("\n## Working Memory\n");
		injectParts.push(memoryMdContent);
	}

	if (memories.length > 0) {
		injectParts.push("\n## Relevant Memories\n");
		for (const mem of memories) {
			const tagStr = mem.tags ? ` [${mem.tags}]` : "";
			injectParts.push(`- ${mem.content}${tagStr}`);
		}
	}

	const duration = Date.now() - start;
	logger.info("hooks", "Session start completed", {
		memoryCount: memories.length,
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
		inject: injectParts.join("\n"),
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
					   AND m.project = ?
					   LIMIT 30`
					: `SELECT m.id, m.content, m.type, m.importance, m.tags,
					   m.pinned, m.project, m.created_at
					   FROM memories m
					   JOIN memories_fts f ON m.rowid = f.rowid
					   WHERE memories_fts MATCH ?
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

		const lines = selected.map((s) => `- ${s.content}`);
		const inject = `[relevant memories]\n${lines.join("\n")}`;

		const duration = Date.now() - start;
		logger.info("hooks", "User prompt submit", {
			memoryCount: selected.length,
			durationMs: duration,
		});

		return { inject, memoryCount: selected.length };
	} catch (e) {
		logger.error("hooks", "User prompt submit failed", e as Error);
		return { inject: "", memoryCount: 0 };
	}
}

// ============================================================================
// Session End
// ============================================================================

export async function handleSessionEnd(
	req: SessionEndRequest,
): Promise<SessionEndResponse> {
	if (req.reason === "clear") {
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

	const prompt = `Extract key facts, decisions, preferences, and learnings from this conversation as a JSON array.

Each item: {"content": "...", "importance": 0.3-0.5, "tags": "tag1,tag2", "type": "fact|preference|decision|learning|rule|issue"}

Only extract durable, reusable knowledge. Skip ephemeral details.
Return ONLY the JSON array, no other text.

Conversation:
${truncated}`;

	try {
		const proc = Bun.spawn(["ollama", "run", "qwen3:4b", prompt], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const timeoutMs = 45000;
		const output = await Promise.race([
			new Response(proc.stdout).text(),
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error("Ollama timeout")), timeoutMs),
			),
		]);

		await proc.exited;

		if (proc.exitCode !== 0) {
			logger.warn("hooks", "Ollama returned non-zero exit code");
			return { memoriesSaved: 0 };
		}

		// Parse JSON from output (handle markdown fences)
		let jsonStr = output.trim();
		const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) {
			jsonStr = fenceMatch[1].trim();
		}

		let extracted: Array<{
			content: string;
			importance?: number;
			tags?: string;
			type?: string;
		}>;

		try {
			extracted = JSON.parse(jsonStr);
		} catch {
			logger.warn("hooks", "Failed to parse LLM output as JSON");
			return { memoriesSaved: 0 };
		}

		if (!Array.isArray(extracted) || extracted.length === 0) {
			return { memoriesSaved: 0 };
		}

		const now = new Date().toISOString();

		const saved = getDbAccessor().withWriteTx((db) => {
			let count = 0;
			const stmt = db.prepare(
				`INSERT INTO memories
				 (id, content, type, importance, source_type, who, tags,
				  project, session_id, runtime_path, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);

			for (const item of extracted) {
				if (!item.content || typeof item.content !== "string") continue;

				const importance = Math.min(item.importance || 0.3, 0.5);

				if (isDuplicate(db as unknown as Database, item.content)) continue;

				const id = crypto.randomUUID();
				const type = item.type || inferType(item.content);

				stmt.run(
					id,
					item.content,
					type,
					importance,
					"session_end",
					req.harness,
					item.tags || null,
					req.cwd || null,
					req.sessionId || req.sessionKey || null,
					req.runtimePath || null,
					now,
					now,
				);
				count++;
			}
			return count;
		});

		logger.info("hooks", "Session end memories extracted", {
			extracted: extracted.length,
			saved,
		});

		return { memoriesSaved: saved };
	} catch (e) {
		const err = e as Error;
		// Graceful on no ollama
		if (
			err.message?.includes("ENOENT") ||
			err.message?.includes("not found") ||
			err.message?.includes("spawn")
		) {
			logger.warn("hooks", "Ollama not available, skipping memory extraction");
			return { memoriesSaved: 0 };
		}
		logger.error("hooks", "Session end failed", err);
		return { memoriesSaved: 0 };
	}
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
						   AND m.project = ?
						   LIMIT ?`
						: `SELECT m.id, m.content, m.type, m.importance, m.tags, m.created_at
						   FROM memories m
						   JOIN memories_fts f ON m.rowid = f.rowid
						   WHERE memories_fts MATCH ?
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
					   WHERE content LIKE ? AND project = ?
					   ORDER BY importance DESC
					   LIMIT ?`
					: `SELECT id, content, type, importance, tags, created_at
					   FROM memories
					   WHERE content LIKE ?
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
