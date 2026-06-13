import { existsSync } from "node:fs";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { effectiveScore } from "./memory-classification";
import { buildAgentScopeClause } from "./memory-search";

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

export interface SimpleMemory {
	id: string;
	content: string;
	type: string;
	importance: number;
	created_at: string;
}

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

function clampScore01(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

export function buildActiveConstraintsSection(
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

export function fetchTraversalCandidates(
	memoryDbPath: string,
	memoryIds: ReadonlyArray<string>,
	agentId: string,
): ScoredMemory[] {
	if (memoryIds.length === 0 || !existsSync(memoryDbPath)) return [];

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
						.all(agentId, ...memoryIds) as unknown as ScoredMemory[],
			)
			.map((row) => ({
				...row,
				effScore: clampScore01(row.effScore),
			}));
	} catch {
		return [];
	}
}

/**
 * Return all memories that pass the 0.2 effective score threshold,
 * sorted by project match + score. No budget applied — caller
 * handles truncation via selectWithBudget().
 */
export function getAllScoredCandidates(
	memoryDbPath: string,
	project: string | undefined,
	limit: number,
	agentId = "default",
	readPolicy = "isolated",
	policyGroup: string | null = null,
): ScoredMemory[] {
	if (!existsSync(memoryDbPath)) return [];

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

		// Sort: project matches first, then by score.
		scored.sort((a, b) => {
			if (project) {
				const aMatch = a.project === project ? 1 : 0;
				const bMatch = b.project === project ? 1 : 0;
				if (aMatch !== bMatch) return bMatch - aMatch;
			}
			return b.effScore - a.effScore;
		});

		return scored.slice(0, limit);
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
export function getPredictedContextMemories(
	memoryDbPath: string,
	project: string | undefined,
	limit: number,
	charBudget: number,
	excludeIds: ReadonlySet<string>,
	agentId: string,
	readPolicy = "isolated",
	policyGroup: string | null = null,
): ScoredMemory[] {
	if (!existsSync(memoryDbPath)) return [];
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

		// Extract recurring terms from recent sessions.
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

		// Take terms that appear in 2+ sessions (recurring topics).
		const recurring = [...termFreq.entries()]
			.filter(([_, count]) => count >= 2)
			.sort((a, b) => b[1] - a[1])
			.slice(0, PREDICTED_CONTEXT_TERM_LIMIT)
			.map(([term]) => term);

		if (recurring.length === 0) return [];

		// Use recurring terms as FTS query.
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

export function updateAccessTracking(memoryDbPath: string, ids: string[]): void {
	if (ids.length === 0 || !existsSync(memoryDbPath)) return;

	try {
		getDbAccessor().withWriteTx((db: WriteDb) => {
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

export function getRecentMemories(memoryDbPath: string, limit: number, recencyBias = 0.7): SimpleMemory[] {
	if (!existsSync(memoryDbPath)) return [];

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

			return db.prepare(query).all(limit) as unknown as Array<SimpleMemory>;
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
export function getMemoriesSince(memoryDbPath: string, sinceMs: number, limit: number): SimpleMemory[] {
	if (!existsSync(memoryDbPath)) return [];

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
				.all(sinceIso, limit) as unknown as Array<SimpleMemory>;
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
