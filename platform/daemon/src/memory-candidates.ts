import { existsSync } from "node:fs";
import { type ReadScope, readScopeSql, redactCredentials } from "@signet/core";
import { yieldEvery } from "./async-yield";
import type { DbOwnerClient } from "./db-owner-client";
import { getDbOwner } from "./db-owner-runtime";
import { ownerReadAll } from "./db-owner-sql";
import { logger } from "./logger";
import { effectiveScore } from "./memory-classification";
import { currentMemorySql } from "./memory-search";
import { derivedScopeSql, evidenceScopeSql } from "./read-scope-tables";

export interface ScoredMemory {
	id: string;
	content: string;
	type: string;
	importance: number;
	tags: string | null;
	pinned: number;
	project: string | null;
	created_at: string;
	source_type: string | null;
	source_id: string | null;
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
	const redactedConstraints = constraints.map((item) => ({ ...item, content: redactCredentials(item.content) }));
	if (redactedConstraints.length === 0) return "";

	const header = "\n## Active Constraints\n\nConstraints for entities in scope. These always apply.\n";
	const fullLines = redactedConstraints.map((item) => `- [${item.entityName}] ${item.content}\n`);
	const fullSection = `${header}${fullLines.join("")}`.trimEnd();
	if (charBudget <= 0 || fullSection.length <= charBudget) return fullSection;

	const fixedOverhead = redactedConstraints.reduce(
		(acc, item) => acc + `- [${item.entityName}] \n`.length,
		header.length,
	);
	const availableForContent = Math.max(0, charBudget - fixedOverhead);
	const perConstraintBudget = Math.max(24, Math.floor(availableForContent / redactedConstraints.length));
	const compressedLines = redactedConstraints.map((item) => {
		const content =
			item.content.length <= perConstraintBudget
				? item.content
				: `${item.content.slice(0, Math.max(1, perConstraintBudget - 3))}...`;
		return `- [${item.entityName}] ${content}\n`;
	});
	const compressedSection = `${header}${compressedLines.join("")}`.trimEnd();

	logger.warn("hooks", "Constraint section exceeded budget; preserving all constraints", {
		constraintBudgetChars: charBudget,
		constraintCount: redactedConstraints.length,
		fullChars: fullSection.length,
		injectChars: compressedSection.length,
	});
	return compressedSection;
}
export const MAX_TRAVERSAL_CANDIDATE_IDS = 500;
const TRAVERSAL_CANDIDATE_BATCH_SIZE = 50;

async function readScoredMemoryRows(
	owner: DbOwnerClient,
	scope: ReadScope,
	filter: { readonly sql: string; readonly args: readonly unknown[] },
	tail: { readonly sql: string; readonly args: readonly unknown[] },
	options: { readonly operation: string; readonly estimatedWorkUnits: number },
): Promise<ScoredMemory[]> {
	const boost = derivedScopeSql("ea", scope, { memory: "memory_id", session: null, source: "source_id" });
	const visible = readScopeSql("m", scope);
	const rows = await ownerReadAll<ScoredMemory>(
		owner,
		`SELECT m.id, m.content, m.type, m.importance, m.tags, m.pinned, m.project, m.created_at,
		        m.source_type, m.source_id, COALESCE(m.access_count, 0) AS access_count,
		        COALESCE(
		          (SELECT MAX(ea.importance)
		           FROM entity_attributes ea
		           WHERE ea.memory_id = m.id
		             AND ea.status = 'active'${boost.sql}),
		          m.importance,
		          0.5
		        ) AS effScore
		 FROM memories m
		 WHERE ${filter.sql}${currentMemorySql("m")}${visible.sql}${tail.sql}`,
		[...boost.args, ...filter.args, ...visible.args, ...tail.args],
		{ ...options, lane: "read", deadlineMs: 5_000 },
	);
	return [...rows];
}

export async function fetchTraversalCandidates(
	memoryDbPath: string,
	memoryIds: ReadonlyArray<string>,
	scope: ReadScope,
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
		const rows: ScoredMemory[] = [];
		const yieldBetweenBatches = yieldEvery(1);

		for (let offset = 0; offset < boundedMemoryIds.length; offset += TRAVERSAL_CANDIDATE_BATCH_SIZE) {
			const batch = boundedMemoryIds.slice(offset, offset + TRAVERSAL_CANDIDATE_BATCH_SIZE);
			const batchRows = await readScoredMemoryRows(
				owner,
				scope,
				{ sql: `m.id IN (${batch.map(() => "?").join(", ")})`, args: batch },
				{ sql: "", args: [] },
				{
					operation: "session-start.traversal-candidate-hydration",
					estimatedWorkUnits: Math.max(1, Math.min(150, batch.length * 3)),
				},
			);
			rows.push(...batchRows);
			await yieldBetweenBatches();
		}

		return rows.map((row) => ({
			...row,
			content: redactCredentials(row.content),
			effScore: clampScore01(row.effScore),
		}));
	} catch {
		return [];
	}
}
export async function getAllScoredCandidates(
	memoryDbPath: string,
	project: string | undefined,
	limit: number,
	scope: ReadScope,
): Promise<ScoredMemory[]> {
	if (!existsSync(memoryDbPath)) return [];

	try {
		const owner = await getDbOwner(memoryDbPath);
		const rows = await readScoredMemoryRows(
			owner,
			scope,
			{ sql: "1 = 1", args: [] },
			{ sql: " ORDER BY m.created_at DESC LIMIT ?", args: [limit * 3] },
			{ operation: "session-start.candidate-pool", estimatedWorkUnits: Math.max(1, Math.min(10_000, limit * 3)) },
		);

		const scored: ScoredMemory[] = rows
			.map((r) => ({
				...r,
				content: redactCredentials(r.content),
				effScore: effectiveScore(r.importance, r.created_at, r.pinned === 1),
			}))
			.filter((r) => r.effScore > 0.2 || r.pinned === 1);
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

async function readableMemoryFtsTables(
	owner: DbOwnerClient,
	scope: ReadScope,
	options: { readonly operation: string; readonly lane: "read"; readonly deadlineMs: number },
): Promise<string[]> {
	const base = "memories_fts";
	const readable = scope.compartments === "all" ? null : new Set(scope.compartments);
	const rows = await ownerReadAll(
		owner,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND (name = ? OR name GLOB ?) ORDER BY name",
		[base, `${base}__c[0-9]*`],
		{ ...options, estimatedWorkUnits: 1 },
	);
	return rows.flatMap((row) => {
		const name = Reflect.get(row, "name");
		if (name === base) return [base];
		if (typeof name !== "string" || !/^memories_fts__c[1-9][0-9]*$/.test(name)) return [];
		const compartment = Number(name.slice(base.length + 3));
		return Number.isSafeInteger(compartment) && (readable === null || readable.has(compartment)) ? [name] : [];
	});
}

export async function getPredictedContextMemories(
	memoryDbPath: string,
	project: string | undefined,
	limit: number,
	charBudget: number,
	excludeIds: ReadonlySet<string>,
	scope: ReadScope,
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
		const transcriptScope = evidenceScopeSql("st", scope, {
			memory: null,
			session: "session_key",
			source: "source_id",
		});
		const transcriptRows = await ownerReadAll<{
			readonly session_key: string;
			readonly transcript: string;
		}>(
			owner,
			`SELECT st.session_key, st.content AS transcript
			 FROM session_transcripts st
			 WHERE st.project = ? AND st.completed_at IS NOT NULL${transcriptScope.sql}
			 ORDER BY COALESCE(st.updated_at, st.created_at) DESC LIMIT 5`,
			[project, ...transcriptScope.args],
			{ ...readOptions, operation: "session-start.predicted-context.transcripts" },
		);

		if (transcriptRows.length === 0) return [];
		const termFreq = new Map<string, number>();
		for (const row of transcriptRows) {
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
		const recurring = [...termFreq.entries()]
			.filter(([_, count]) => count >= 2)
			.sort((a, b) => b[1] - a[1])
			.slice(0, PREDICTED_CONTEXT_TERM_LIMIT)
			.map(([term]) => term);

		if (recurring.length === 0) return [];
		const ftsQuery = recurring.join(" OR ");
		const visible = readScopeSql("m", scope);
		const tables = await readableMemoryFtsTables(owner, scope, {
			...readOptions,
			operation: "session-start.predicted-context.shards",
		});
		if (tables.length === 0) return [];
		const rows = await ownerReadAll<{
			readonly id: string;
			readonly content: string;
			readonly type: string;
			readonly importance: number;
			readonly tags: string | null;
			readonly pinned: number;
			readonly project: string | null;
			readonly created_at: string;
			readonly source_type: string | null;
			readonly source_id: string | null;
			readonly access_count: number;
		}>(
			owner,
			`${tables
				.map(
					(table) => `SELECT m.id, m.content, m.type, m.importance, m.tags,
			        m.pinned, m.project, m.created_at, m.source_type, m.source_id,
			        COALESCE(m.access_count, 0) AS access_count, bm25(${table}) AS bm25_score
			 FROM ${table}
			 JOIN memories m ON ${table}.rowid = m.rowid
			 WHERE ${table} MATCH ?
			   ${currentMemorySql("m")}
			   AND m.project = ?${visible.sql}`,
				)
				.join(" UNION ALL ")} ORDER BY bm25_score, id LIMIT ?`,
			[...tables.flatMap(() => [ftsQuery, project, ...visible.args]), limit * 2],
			{ ...readOptions, operation: "session-start.predicted-context.fts" },
		);
		const selected: ScoredMemory[] = [];
		let used = 0;
		for (const r of rows) {
			if (excludeIds.has(r.id)) continue;
			if (selected.length >= limit) break;
			const content = redactCredentials(r.content);
			if (used + content.length > charBudget) break;
			selected.push({
				id: r.id,
				content,
				type: r.type,
				importance: r.importance,
				tags: r.tags,
				pinned: r.pinned,
				project: r.project,
				created_at: r.created_at,
				source_type: r.source_type,
				source_id: r.source_id,
				access_count: r.access_count,
				effScore: effectiveScore(r.importance, r.created_at, r.pinned === 1),
			});
			used += content.length;
		}

		return selected;
	} catch (e) {
		logger.warn("hooks", "Predicted context failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
		return [];
	}
}
