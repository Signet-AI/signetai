import { existsSync } from "node:fs";
import { type AgentRosterReadPolicy, scanMemoryContent } from "@signet/core";
import { yieldEvery } from "./async-yield";
import { getDbOwner } from "./db-owner-runtime";
import { ownerReadAll, ownerReadOne } from "./db-owner-sql";
import { logger } from "./logger";
import { effectiveScore } from "./memory-classification";
import { buildAgentScopeClause, currentMemorySql } from "./memory-search";

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
	const safeConstraints = constraints.filter((item) => scanMemoryContent(item.content).contextEligible);
	if (safeConstraints.length === 0) return "";

	const header = "\n## Active Constraints\n\nConstraints for entities in scope. These always apply.\n";
	const fullLines = safeConstraints.map((item) => `- [${item.entityName}] ${item.content}\n`);
	const fullSection = `${header}${fullLines.join("")}`.trimEnd();
	if (charBudget <= 0 || fullSection.length <= charBudget) return fullSection;

	const fixedOverhead = safeConstraints.reduce((acc, item) => acc + `- [${item.entityName}] \n`.length, header.length);
	const availableForContent = Math.max(0, charBudget - fixedOverhead);
	const perConstraintBudget = Math.max(24, Math.floor(availableForContent / safeConstraints.length));
	const compressedLines = safeConstraints.map((item) => {
		const content =
			item.content.length <= perConstraintBudget
				? item.content
				: `${item.content.slice(0, Math.max(1, perConstraintBudget - 3))}...`;
		return `- [${item.entityName}] ${content}\n`;
	});
	const compressedSection = `${header}${compressedLines.join("")}`.trimEnd();

	logger.warn("hooks", "Constraint section exceeded budget; preserving all constraints", {
		constraintBudgetChars: charBudget,
		constraintCount: safeConstraints.length,
		fullChars: fullSection.length,
		injectChars: compressedSection.length,
	});

	// Hard invariant: constraints for in-scope entities always surface.
	// We allow this section to exceed its soft budget rather than dropping rows.
	return compressedSection;
}

/** Maximum number of traversal IDs hydrated during one session start. */
export const MAX_TRAVERSAL_CANDIDATE_IDS = 500;
const TRAVERSAL_CANDIDATE_BATCH_SIZE = 50;

export async function fetchTraversalCandidates(
	memoryDbPath: string,
	memoryIds: ReadonlyArray<string>,
	agentId: string,
): Promise<ScoredMemory[]> {
	if (memoryIds.length === 0 || !existsSync(memoryDbPath)) return [];

	const boundedMemoryIds = memoryIds.slice(0, MAX_TRAVERSAL_CANDIDATE_IDS);
	if (boundedMemoryIds.length < memoryIds.length) {
		logger.warn("hooks", "Traversal candidate hydration exceeded its hard cap", {
			requested: memoryIds.length,
			cap: MAX_TRAVERSAL_CANDIDATE_IDS,
		});
	}

	try {
		const owner = await getDbOwner(memoryDbPath);
		const safetyTable = await ownerReadOne<{ readonly name: string }>(
			owner,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			["memory_content_safety"],
			{
				operation: "session-start.traversal-candidate-safety-table",
				lane: "read",
				deadlineMs: 5_000,
				estimatedWorkUnits: 1,
			},
		);
		const hasSafetyTable = safetyTable !== null;
		const safetyJoin = hasSafetyTable
			? " LEFT JOIN memory_content_safety safety ON safety.agent_id = ? AND safety.source_kind = 'memory' AND safety.source_id = m.id"
			: "";
		const safetySelect = hasSafetyTable
			? ", safety.status AS safety_status, safety.context_eligible AS safety_context_eligible"
			: ", NULL AS safety_status, NULL AS safety_context_eligible";
		const rows: ScoredMemory[] = [];
		const yieldBetweenBatches = yieldEvery(1);

		for (let offset = 0; offset < boundedMemoryIds.length; offset += TRAVERSAL_CANDIDATE_BATCH_SIZE) {
			const batch = boundedMemoryIds.slice(offset, offset + TRAVERSAL_CANDIDATE_BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(", ");
			const batchRows = await ownerReadAll<
				ScoredMemory & {
					readonly safety_status: string | null;
					readonly safety_context_eligible: number | null;
				}
			>(
				owner,
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
					 COALESCE(
						 (SELECT MAX(ea.importance)
						  FROM entity_attributes ea
						  WHERE ea.memory_id = m.id
						    AND ea.agent_id = ?
						    AND ea.status = 'active'),
						 m.importance,
						 0.5
					 ) AS effScore${safetySelect}
				 FROM memories m${safetyJoin}
				 WHERE m.id IN (${placeholders})${currentMemorySql("m")}`,
				hasSafetyTable ? [agentId, agentId, ...batch] : [agentId, ...batch],
				{
					operation: "session-start.traversal-candidate-hydration",
					lane: "read",
					deadlineMs: 5_000,
					estimatedWorkUnits: Math.max(1, Math.min(150, batch.length * 3)),
				},
			);
			rows.push(
				...batchRows.filter(
					(row) =>
						scanMemoryContent(row.content).contextEligible &&
						(!hasSafetyTable ||
							row.safety_status === null ||
							(row.safety_status === "clean" && row.safety_context_eligible === 1)),
				),
			);
			await yieldBetweenBatches();
		}

		return rows.map((row) => ({
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
export async function getAllScoredCandidates(
	memoryDbPath: string,
	project: string | undefined,
	limit: number,
	agentId = "default",
	readPolicy: AgentRosterReadPolicy = "isolated",
	policyGroup: string | null = null,
): Promise<ScoredMemory[]> {
	if (!existsSync(memoryDbPath)) return [];

	try {
		const scope = buildAgentScopeClause(agentId, readPolicy, policyGroup);
		const owner = await getDbOwner(memoryDbPath);
		const readOptions = {
			operation: "session-start.candidate-pool",
			lane: "read" as const,
			deadlineMs: 5_000,
			estimatedWorkUnits: Math.max(1, Math.min(10_000, limit * 3)),
		};
		// Legacy databases may predate the safety ledger. Discover that in the
		// owner before selecting rows so the parent never touches SQLite.
		const safetyTable = await ownerReadOne<{ readonly name: string }>(
			owner,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			["memory_content_safety"],
			{ ...readOptions, operation: "session-start.candidate-pool.safety-table" },
		);
		const hasSafetyTable = safetyTable != null;
		const safetyJoin = hasSafetyTable
			? " LEFT JOIN memory_content_safety safety ON safety.agent_id = ? AND safety.source_kind = 'memory' AND safety.source_id = m.id"
			: "";
		const safetyPredicate = hasSafetyTable
			? " AND (safety.agent_id IS NULL OR (safety.status = 'clean' AND safety.context_eligible = 1))"
			: "";
		const rows: ReadonlyArray<{
			id: string;
			content: string;
			type: string;
			importance: number;
			tags: string | null;
			pinned: number;
			project: string | null;
			created_at: string;
			access_count: number;
		}> = await ownerReadAll(
			owner,
			`SELECT m.id, m.content, m.type, m.importance, m.tags, m.pinned, m.project, m.created_at,
			        COALESCE(m.access_count, 0) AS access_count
			 FROM memories m${safetyJoin}
				 WHERE 1 = 1${currentMemorySql("m")}${scope.sql}${safetyPredicate}
			 ORDER BY m.created_at DESC LIMIT ?`,
			hasSafetyTable ? [agentId, ...scope.args, limit * 3] : [...scope.args, limit * 3],
			readOptions,
		);

		const scored: ScoredMemory[] = rows
			.filter((row) => scanMemoryContent(row.content).contextEligible)
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
export async function getPredictedContextMemories(
	memoryDbPath: string,
	project: string | undefined,
	limit: number,
	charBudget: number,
	excludeIds: ReadonlySet<string>,
	agentId: string,
	readPolicy: AgentRosterReadPolicy = "isolated",
	policyGroup: string | null = null,
): Promise<ScoredMemory[]> {
	if (!existsSync(memoryDbPath)) return [];
	if (!project || project.trim().length === 0) return [];

	try {
		const owner = await getDbOwner(memoryDbPath);
		const readOptions = {
			operation: "session-start.predicted-context",
			lane: "read" as const,
			deadlineMs: 5_000,
			estimatedWorkUnits: Math.max(1, Math.min(500, limit * 10)),
		};
		const safetyTable = await ownerReadOne<{ readonly name: string }>(
			owner,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			["memory_content_safety"],
			{ ...readOptions, operation: "session-start.predicted-context.safety-table" },
		);
		const hasSafetyTable = safetyTable !== null;
		const transcriptRows = await ownerReadAll<{
			readonly session_key: string;
			readonly transcript: string;
			readonly safety_status: string | null;
			readonly safety_context_eligible: number | null;
		}>(
			owner,
			`SELECT st.session_key, st.content AS transcript,
			        ${hasSafetyTable ? "safety.status" : "NULL"} AS safety_status,
			        ${hasSafetyTable ? "safety.context_eligible" : "NULL"} AS safety_context_eligible
			 FROM session_transcripts st
			 ${hasSafetyTable ? "LEFT JOIN memory_content_safety safety ON safety.agent_id = ? AND safety.source_kind = 'transcript' AND safety.source_id = st.session_key" : ""}
			 WHERE st.project = ? AND st.completed_at IS NOT NULL AND st.agent_id = ?
			 ORDER BY COALESCE(st.updated_at, st.created_at) DESC LIMIT 5`,
			hasSafetyTable ? [agentId, project, agentId] : [project, agentId],
			{ ...readOptions, operation: "session-start.predicted-context.transcripts" },
		);
		const eligibleTranscriptRows = transcriptRows.filter(
			(row) =>
				scanMemoryContent(row.transcript).contextEligible &&
				(!hasSafetyTable ||
					row.safety_status === null ||
					(row.safety_status === "clean" && row.safety_context_eligible === 1)),
		);

		if (eligibleTranscriptRows.length === 0) return [];

		// Extract recurring terms from recent sessions.
		const termFreq = new Map<string, number>();
		for (const row of eligibleTranscriptRows) {
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
		const rows = await ownerReadAll<{
			readonly id: string;
			readonly content: string;
			readonly type: string;
			readonly importance: number;
			readonly tags: string | null;
			readonly pinned: number;
			readonly project: string | null;
			readonly created_at: string;
			readonly access_count: number;
			readonly safety_status: string | null;
			readonly safety_context_eligible: number | null;
		}>(
			owner,
			`SELECT m.id, m.content, m.type, m.importance, m.tags,
			        m.pinned, m.project, m.created_at,
			        COALESCE(m.access_count, 0) AS access_count,
			        ${hasSafetyTable ? "safety.status" : "NULL"} AS safety_status,
			        ${hasSafetyTable ? "safety.context_eligible" : "NULL"} AS safety_context_eligible
			 FROM memories_fts
			 JOIN memories m ON memories_fts.rowid = m.rowid
			 ${hasSafetyTable ? "LEFT JOIN memory_content_safety safety ON safety.agent_id = ? AND safety.source_kind = 'memory' AND safety.source_id = m.id" : ""}
			 WHERE memories_fts MATCH ?
			   ${currentMemorySql("m")}
			   AND m.project = ?
			   ${scope.sql}
			 ORDER BY bm25(memories_fts)
			 LIMIT ?`,
			hasSafetyTable
				? [agentId, ftsQuery, project, ...scope.args, limit * 2]
				: [ftsQuery, project, ...scope.args, limit * 2],
			{ ...readOptions, operation: "session-start.predicted-context.fts" },
		);
		const eligibleRows = rows.filter(
			(row) =>
				scanMemoryContent(row.content).contextEligible &&
				(!hasSafetyTable ||
					row.safety_status === null ||
					(row.safety_status === "clean" && row.safety_context_eligible === 1)),
		);

		const selected: ScoredMemory[] = [];
		let used = 0;
		for (const r of eligibleRows) {
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
