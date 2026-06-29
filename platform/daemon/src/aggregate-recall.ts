import { createHash, randomUUID } from "node:crypto";
import type { LlmUsage, RouteRequest, RouterResult } from "@signet/core";
import { normalizeAndHashContent } from "./content-normalization";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert, vectorToBlob } from "./db-helpers";
import { logger } from "./logger";
import type { EmbeddingConfig, ResolvedMemoryConfig } from "./memory-config";
import {
	type AggregateRecallUsage,
	type AggregateRecallUsageStage,
	type EmbedFn,
	type RecallParams,
	type RecallResponse,
	type RecallResult,
	type RecallTimings,
	hybridRecall,
} from "./memory-search";
import { enqueueExtractionJobInTx } from "./pipeline/extraction-queue";
import { type IngestEnvelope, txIngestEnvelope } from "./transactions";

export type AggregateRecallBudget = "small" | "medium" | "large";
export type AggregateRecallStoppedReason = "complete" | "no_evidence" | "router_unavailable" | "synthesis_failed";

interface AggregateInferenceResult {
	readonly text: string;
	readonly usage?: LlmUsage | null;
	readonly attempts?: readonly AggregateInferenceAttempt[];
}

interface AggregateInferenceAttempt {
	readonly targetRef: string;
	readonly ok: boolean;
	readonly durationMs: number;
	readonly usage?: LlmUsage | null;
}

export interface AggregateInferenceRouter {
	execute(
		request: RouteRequest,
		prompt: string,
		opts?: {
			readonly timeoutMs?: number;
			readonly maxTokens?: number;
			readonly refresh?: boolean;
			readonly acpxHooks?: "disabled" | "inherit";
		},
	): Promise<RouterResult<AggregateInferenceResult>>;
}

interface AggregateRecallDeps {
	readonly hybridRecall?: typeof hybridRecall;
	readonly router: AggregateInferenceRouter | null;
	readonly embedFn: EmbedFn;
	readonly now?: () => Date;
	readonly idFactory?: () => string;
	readonly logger?: AggregateRecallLogger;
	readonly ingestEnvelope?: (db: WriteDb, mem: IngestEnvelope) => string;
}

interface AggregateRecallLogger {
	readonly warn: (category: "memory", message: string, data?: Record<string, unknown>) => void;
}

interface AggregateMemoryRow {
	readonly id: string;
	readonly content: string;
	readonly source_type?: string | null;
	readonly source_id: string | null;
	readonly type: string;
	readonly tags: string | null;
	readonly pinned: number;
	readonly importance: number;
	readonly who: string | null;
	readonly project: string | null;
	readonly visibility?: string | null;
	readonly created_at: string;
}

interface ContentHashMatch {
	readonly row: RecallResult;
	readonly visibleForAggregate: boolean;
	readonly aggregateRecallMemory: boolean;
}

interface AggregateDuplicateResolution {
	readonly row: RecallResult;
	readonly saved: boolean;
}

const BUDGET_QUERY_LIMITS: Record<AggregateRecallBudget, number> = {
	small: 3,
	medium: 5,
	large: 8,
};
const AGGREGATE_RECALL_TIMING_LOG_THRESHOLD_MS = 1000;

function roundAggregateDuration(ms: number): number {
	return Math.round(ms * 100) / 100;
}

function addNullableNumbers(left: number | null, right: number | null): number | null {
	if (left === null && right === null) return null;
	return (left ?? 0) + (right ?? 0);
}

function sumUsage(stages: readonly AggregateRecallUsageStage[]): LlmUsage {
	return stages.reduce<LlmUsage>(
		(total, stage) => ({
			inputTokens: addNullableNumbers(total.inputTokens, stage.inputTokens),
			outputTokens: addNullableNumbers(total.outputTokens, stage.outputTokens),
			cacheReadTokens: addNullableNumbers(total.cacheReadTokens, stage.cacheReadTokens),
			cacheCreationTokens: addNullableNumbers(total.cacheCreationTokens, stage.cacheCreationTokens),
			totalCost: addNullableNumbers(total.totalCost, stage.totalCost),
			totalDurationMs: addNullableNumbers(total.totalDurationMs, stage.totalDurationMs),
		}),
		{
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheCreationTokens: null,
			totalCost: null,
			totalDurationMs: null,
		},
	);
}

function usageStage(
	name: AggregateRecallUsageStage["name"],
	result: AggregateInferenceResult,
): AggregateRecallUsageStage {
	const okAttempt = result.attempts?.find((attempt) => attempt.ok) ?? null;
	const usage = result.usage ?? okAttempt?.usage ?? null;
	return {
		name,
		targetRef: okAttempt?.targetRef ?? null,
		attemptCount: result.attempts?.length ?? 1,
		fallbackCount: result.attempts?.filter((attempt) => !attempt.ok).length ?? 0,
		inputTokens: usage?.inputTokens ?? null,
		outputTokens: usage?.outputTokens ?? null,
		cacheReadTokens: usage?.cacheReadTokens ?? null,
		cacheCreationTokens: usage?.cacheCreationTokens ?? null,
		totalCost: usage?.totalCost ?? null,
		totalDurationMs: usage?.totalDurationMs ?? okAttempt?.durationMs ?? null,
	};
}

function buildAggregateUsage(stages: readonly AggregateRecallUsageStage[]): AggregateRecallUsage | undefined {
	if (stages.length === 0) return undefined;
	return {
		...sumUsage(stages),
		stages,
	};
}

function createAggregateTimingCollector(): {
	readonly time: <T>(name: string, fn: () => T) => T;
	readonly timeAsync: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
	readonly finish: () => RecallTimings;
} {
	const start = performance.now();
	const stages: RecallTimings["stages"] = [];
	const record = (name: string, stageStart: number): void => {
		stages.push({ name, durationMs: roundAggregateDuration(performance.now() - stageStart) });
	};
	return {
		time<T>(name: string, fn: () => T): T {
			const stageStart = performance.now();
			try {
				return fn();
			} finally {
				record(name, stageStart);
			}
		},
		async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
			const stageStart = performance.now();
			try {
				return await fn();
			} finally {
				record(name, stageStart);
			}
		},
		finish(): RecallTimings {
			return {
				totalMs: roundAggregateDuration(performance.now() - start),
				stages: [...stages],
			};
		},
	};
}

export class InvalidAggregateRecallBudgetError extends Error {
	constructor() {
		super("Invalid aggregateBudget. Expected one of: small, medium, large.");
		this.name = "InvalidAggregateRecallBudgetError";
	}
}

export function parseAggregateRecallBudget(raw: unknown): AggregateRecallBudget | null {
	if (raw === undefined) return "small";
	if (raw === "small" || raw === "medium" || raw === "large") return raw;
	return null;
}

export function readAggregateRecallBudgetInput(input: {
	readonly aggregateBudget?: unknown;
	readonly aggregate_budget?: unknown;
}): unknown {
	if (Object.hasOwn(input, "aggregateBudget")) return input.aggregateBudget;
	if (Object.hasOwn(input, "aggregate_budget")) return input.aggregate_budget;
	return undefined;
}

function normalizeBudget(raw: unknown): AggregateRecallBudget {
	const budget = parseAggregateRecallBudget(raw);
	if (!budget) throw new InvalidAggregateRecallBudgetError();
	return budget;
}

function emptyAggregateResponse(
	params: RecallParams,
	budget: AggregateRecallBudget,
	queries: readonly string[],
	sourceMemoryIds: readonly string[],
	stoppedReason: AggregateRecallStoppedReason,
): RecallResponse {
	return {
		results: [],
		query: params.query,
		method: "hybrid",
		meta: {
			totalReturned: 0,
			hasSupplementary: false,
			noHits: true,
			timings: { totalMs: 0, stages: [] },
		},
		aggregate: {
			savedMemoryId: null,
			saved: false,
			deduped: false,
			budget,
			queries,
			sourceMemoryIds,
			stoppedReason,
		},
	};
}

function normalizeQuery(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueQueries(query: string, candidates: readonly string[], max: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of [query, ...candidates]) {
		const trimmed = candidate.trim();
		const key = normalizeQuery(trimmed);
		if (!trimmed || seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
		if (result.length >= max) break;
	}
	return result;
}

function parsePlannerQueries(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === "string");
		}
		if (typeof parsed === "object" && parsed !== null) {
			const value = (parsed as { readonly queries?: unknown }).queries;
			if (Array.isArray(value)) {
				return value.filter((item): item is string => typeof item === "string");
			}
		}
	} catch {
		// Fall through to line parsing for permissive model output.
	}
	return trimmed
		.split(/\r?\n/)
		.map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
		.filter((line) => line.length > 0);
}

function isAggregateRecallRow(row: RecallResult): boolean {
	return row.source === "aggregate-recall" || row.source_id?.startsWith("aggregate-recall:") === true;
}

function isSourceMemoryRow(row: RecallResult): boolean {
	return (
		row.source !== "llm_summary" &&
		!isAggregateRecallRow(row) &&
		!row.id.startsWith("constructed:") &&
		!row.id.startsWith("summary:") &&
		!row.id.startsWith("source-chunk:") &&
		!row.id.startsWith("native-artifact:")
	);
}

function uniqueEvidence(rows: readonly RecallResult[]): RecallResult[] {
	const seen = new Set<string>();
	const result: RecallResult[] = [];
	for (const row of rows) {
		if (!isSourceMemoryRow(row) || seen.has(row.id)) continue;
		seen.add(row.id);
		result.push(row);
	}
	return result;
}

function evidenceCanSaveAsGlobalAggregate(rows: readonly RecallResult[]): boolean {
	return rows.every((row) => row.visibility === "global" && row.scope === null);
}

function isInsufficientAggregateAnswer(text: string): boolean {
	const normalized = normalizeQuery(text);
	return (
		normalized === "insufficient_evidence" ||
		/^(there (isn't|is not) enough|not enough|insufficient|no useful)\b.{0,80}\bevidence\b/.test(normalized) ||
		/^(can't|cannot|could not|unable to)\b.{0,80}\b(determine|answer|infer)\b/.test(normalized)
	);
}

function isConversationalAggregateAnswer(text: string): boolean {
	const normalized = normalizeQuery(text);
	return (
		/^(yes|no|probably|maybe)\b[.!?,:;-]?/.test(normalized) ||
		/\b(based on (the )?evidence|from the evidence|the evidence (says|shows|suggests)|the read is|so the read is)\b/.test(
			normalized,
		) ||
		/^(answer|response):/.test(normalized)
	);
}

function aggregateAnswerCanBeSaved(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length >= 12 && !isInsufficientAggregateAnswer(trimmed) && !isConversationalAggregateAnswer(trimmed);
}

function aggregateKey(input: {
	readonly agentId: string;
	readonly project: string | null;
	readonly query: string;
	readonly budget: AggregateRecallBudget;
	readonly sourceMemoryIds: readonly string[];
}): string {
	const hash = createHash("sha256")
		.update(input.agentId)
		.update("\0")
		.update(input.project ?? "")
		.update("\0")
		.update(normalizeQuery(input.query))
		.update("\0")
		.update(input.budget)
		.update("\0")
		.update([...input.sourceMemoryIds].sort().join("\0"))
		.digest("hex");
	return `aggregate-recall:${hash}`;
}

function sourceProject(params: RecallParams): string | null {
	return typeof params.project === "string" && params.project.trim().length > 0 ? params.project : null;
}

function rowToRecallResult(row: AggregateMemoryRow): RecallResult {
	const content = row.content;
	return {
		id: row.id,
		content,
		content_length: content.length,
		truncated: false,
		score: 1,
		source: "aggregate-recall",
		source_id: row.source_id ?? undefined,
		type: row.type,
		tags: row.tags,
		pinned: row.pinned === 1,
		importance: row.importance,
		who: row.who ?? "",
		project: row.project,
		created_at: row.created_at,
	};
}

function loadAggregateMemory(db: WriteDb, id: string): RecallResult | null {
	const row = db
		.prepare(
			`SELECT id, content, source_id, type, tags, pinned, importance, who, project, created_at
			 FROM memories
			 WHERE id = ? AND is_deleted = 0`,
		)
		.get(id) as AggregateMemoryRow | undefined;
	return row ? rowToRecallResult(row) : null;
}

function loadAggregateByKey(
	db: WriteDb,
	key: string,
	input: { readonly agentId: string; readonly project: string | null },
): RecallResult | null {
	const row = db
		.prepare(
			`SELECT id, content, source_id, type, tags, pinned, importance, who, project, created_at
			 FROM memories
			 WHERE idempotency_key = ?
			   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?
			   AND source_type = 'aggregate-recall'
			   AND visibility = 'global'
			   AND scope IS NULL
			   AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(key, input.agentId) as AggregateMemoryRow | undefined;
	if (!row) return null;
	if (input.project !== null && row.project !== input.project) return null;
	return rowToRecallResult(row);
}

function loadMemoryByContentHash(
	db: WriteDb,
	contentHash: string,
	input: { readonly agentId: string; readonly project: string | null },
): ContentHashMatch | null {
	const row = db
		.prepare(
			`SELECT id, content, source_type, source_id, type, tags, pinned, importance, who, project, visibility, created_at
			 FROM memories
			 WHERE content_hash = ?
			   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?
			   AND scope IS NULL
			   AND is_deleted = 0
			 LIMIT 1`,
		)
		.get(contentHash, input.agentId) as AggregateMemoryRow | undefined;
	if (!row) return null;
	return {
		row: rowToRecallResult(row),
		visibleForAggregate: row.visibility === "global" && (input.project === null || row.project === input.project),
		aggregateRecallMemory: row.source_type === "aggregate-recall",
	};
}

function linkAggregateSources(
	db: WriteDb,
	aggregateMemoryId: string,
	sourceMemoryIds: readonly string[],
	agentId: string,
	now: string,
): void {
	for (const sourceMemoryId of sourceMemoryIds) {
		db.prepare(
			`INSERT OR IGNORE INTO aggregate_memory_sources
			 (aggregate_memory_id, source_memory_id, agent_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		).run(aggregateMemoryId, sourceMemoryId, agentId, now);
	}
}

function linkAggregateQueryHint(
	db: WriteDb,
	aggregateMemoryId: string,
	agentId: string,
	query: string,
	now: string,
): void {
	const hint = query.trim();
	if (hint.length === 0) return;
	db.prepare(
		`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(randomUUID(), aggregateMemoryId, agentId, hint, now);
}

function resolveAggregateDuplicate(
	db: WriteDb,
	input: {
		readonly key: string;
		readonly agentId: string;
		readonly project: string | null;
		readonly query: string;
		readonly contentHash: string;
		readonly answer: string;
		readonly sourceMemoryIds: readonly string[];
		readonly now: string;
	},
): AggregateDuplicateResolution | null {
	const existing = loadAggregateByKey(db, input.key, { agentId: input.agentId, project: input.project });
	if (existing) {
		linkAggregateSources(db, existing.id, input.sourceMemoryIds, input.agentId, input.now);
		linkAggregateQueryHint(db, existing.id, input.agentId, input.query, input.now);
		return { row: existing, saved: true };
	}
	const duplicateContent = loadMemoryByContentHash(db, input.contentHash, {
		agentId: input.agentId,
		project: input.project,
	});
	if (!duplicateContent) return null;
	if (!duplicateContent.visibleForAggregate || !duplicateContent.aggregateRecallMemory) {
		return { row: unsavedAggregateResult(input.answer, input.key, input.project), saved: false };
	}
	linkAggregateSources(db, duplicateContent.row.id, input.sourceMemoryIds, input.agentId, input.now);
	linkAggregateQueryHint(db, duplicateContent.row.id, input.agentId, input.query, input.now);
	return { row: duplicateContent.row, saved: true };
}

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed|constraint failed/i.test(err.message);
}

async function embedAggregateMemory(
	memoryId: string,
	content: string,
	contentHash: string,
	createdAt: string,
	cfg: EmbeddingConfig,
	embedFn: EmbedFn,
): Promise<boolean> {
	const vec = await embedFn(content, cfg);
	if (!vec || vec.length !== cfg.dimensions) return false;
	getDbAccessor().withWriteTx((db) => {
		const embId = randomUUID();
		syncVecDeleteBySourceId(db, "memory", memoryId);
		db.prepare("DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?").run(memoryId);
		db.prepare(`
			INSERT INTO embeddings
			  (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
			VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
		`).run(embId, contentHash, vectorToBlob(vec), vec.length, memoryId, content, createdAt);
		syncVecInsert(db, embId, vec);
		db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(cfg.model, memoryId);
	});
	return true;
}

function unsavedAggregateResult(content: string, key: string, project: string | null): RecallResult {
	const now = new Date().toISOString();
	return {
		id: `${key}:unsaved`,
		content,
		content_length: content.length,
		truncated: false,
		score: 1,
		source: "aggregate-recall",
		source_id: key,
		type: "semantic",
		tags: "aggregate,recall",
		pinned: false,
		importance: 0.75,
		who: "signet",
		project,
		created_at: now,
	};
}

async function planQueries(input: {
	readonly router: AggregateInferenceRouter;
	readonly params: RecallParams;
	readonly budget: AggregateRecallBudget;
	readonly maxQueries: number;
	readonly initialRows: readonly RecallResult[];
}): Promise<{ readonly queries: readonly string[]; readonly usage?: AggregateRecallUsageStage }> {
	const remaining = input.maxQueries - 1;
	if (remaining <= 0) return { queries: [] };
	const prompt = [
		"Propose focused follow-up memory recall queries.",
		'Return only JSON with this shape: {"queries":["..."]}.',
		`Original query: ${input.params.query}`,
		`Budget: ${input.budget}; maximum follow-up queries: ${remaining}.`,
		"Current evidence:",
		...input.initialRows.slice(0, 8).map((row, index) => `${index + 1}. ${row.content}`),
	].join("\n");
	const result = await input.router.execute(
		{
			agentId: input.params.agentId,
			operation: "session_synthesis",
			promptPreview: input.params.query,
			expectedOutputTokens: 300,
		},
		prompt,
		{ maxTokens: 300, timeoutMs: 20_000, acpxHooks: "disabled" },
	);
	return result.ok
		? {
				queries: parsePlannerQueries(result.value.text).slice(0, remaining),
				usage: usageStage("planning", result.value),
			}
		: { queries: [] };
}

async function synthesize(input: {
	readonly router: AggregateInferenceRouter;
	readonly params: RecallParams;
	readonly evidence: readonly RecallResult[];
}): Promise<{ readonly answer: string | null; readonly usage?: AggregateRecallUsageStage }> {
	const prompt = [
		"Write one concise atomic memory note from the memory evidence below.",
		"Use only the evidence.",
		"Write in third person as a standalone memory, not as a direct reply to the question.",
		"Restate the question's subject or relationship in the memory so the note is useful without the original query.",
		"If the evidence partially answers the question, save the stable known facts and omit unknowns or speculation.",
		'Do not begin with "yes", "no", "based on the evidence", "the evidence says", or similar conversational framing.',
		"If there are no useful stable facts relevant to the question, return exactly: INSUFFICIENT_EVIDENCE",
		`Question: ${input.params.query}`,
		"",
		"Evidence:",
		...input.evidence.map((row, index) => {
			const createdAt = row.created_at.slice(0, 10);
			return `${index + 1}. [${row.id}; ${createdAt}; ${row.type}] ${row.content}`;
		}),
	].join("\n");
	const result = await input.router.execute(
		{
			agentId: input.params.agentId,
			operation: "session_synthesis",
			promptPreview: input.params.query,
			expectedOutputTokens: 700,
		},
		prompt,
		{ maxTokens: 700, timeoutMs: 30_000, acpxHooks: "disabled" },
	);
	if (!result.ok) return { answer: null };
	const text = result.value.text.trim();
	return {
		answer: text.length > 0 ? text : null,
		usage: usageStage("synthesis", result.value),
	};
}

export async function aggregateRecall(
	params: RecallParams,
	cfg: ResolvedMemoryConfig,
	deps: AggregateRecallDeps,
): Promise<RecallResponse> {
	const budget = normalizeBudget(params.aggregateBudget ?? params.aggregate_budget);
	const maxQueries = BUDGET_QUERY_LIMITS[budget];
	const recall = deps.hybridRecall ?? hybridRecall;
	const saveAggregate = params.saveAggregate !== false && params.save_aggregate !== false;
	const log = deps.logger ?? logger;
	const ingestEnvelope = deps.ingestEnvelope ?? txIngestEnvelope;
	const timings = createAggregateTimingCollector();
	const usageStages: AggregateRecallUsageStage[] = [];
	const now = (deps.now?.() ?? new Date()).toISOString();
	const finish = (response: RecallResponse): RecallResponse => {
		const recallTimings = timings.finish();
		const usage = buildAggregateUsage(usageStages);
		if (recallTimings.totalMs >= AGGREGATE_RECALL_TIMING_LOG_THRESHOLD_MS) {
			log.warn("memory", "Aggregate recall stage timings", {
				agentId: params.agentId ?? "default",
				budget,
				queryCount: response.aggregate?.queries.length ?? 1,
				sourceMemoryCount: response.aggregate?.sourceMemoryIds.length ?? 0,
				resultCount: response.meta.totalReturned,
				totalMs: recallTimings.totalMs,
				stages: recallTimings.stages,
				...(usage
					? {
							llmInputTokens: usage.inputTokens,
							llmOutputTokens: usage.outputTokens,
							llmTotalCost: usage.totalCost,
						}
					: {}),
			});
		}
		return {
			...response,
			meta: {
				...response.meta,
				timings: recallTimings,
			},
			aggregate: response.aggregate
				? {
						...response.aggregate,
						...(usage ? { usage } : {}),
					}
				: response.aggregate,
		};
	};
	const first = await timings.timeAsync("aggregate_initial_recall", () => recall(params, cfg, deps.embedFn));

	if (!deps.router) {
		const sourceMemoryIds = uniqueEvidence(first.results).map((row) => row.id);
		return finish(
			emptyAggregateResponse(
				params,
				budget,
				[params.query],
				sourceMemoryIds,
				sourceMemoryIds.length === 0 ? "no_evidence" : "router_unavailable",
			),
		);
	}

	const planned = await timings.timeAsync("aggregate_planning", () =>
		planQueries({
			router: deps.router,
			params,
			budget,
			maxQueries,
			initialRows: uniqueEvidence(first.results),
		}),
	);
	const queries = uniqueQueries(params.query, planned.queries, maxQueries);
	if (planned.usage) usageStages.push(planned.usage);
	const followupQueries = queries.slice(1);
	const followupRecalls =
		followupQueries.length === 0
			? []
			: await timings.timeAsync("aggregate_followup_recalls", () =>
					Promise.all(
						followupQueries.map((query) =>
							recall(
								{
									...params,
									query,
									aggregate: false,
								},
								cfg,
								deps.embedFn,
							),
						),
					),
				);
	const recalls = [first, ...followupRecalls];

	const evidence = uniqueEvidence(recalls.flatMap((result) => result.results));
	const sourceMemoryIds = evidence.map((row) => row.id);
	if (evidence.length === 0) {
		return finish(emptyAggregateResponse(params, budget, queries, [], "no_evidence"));
	}

	const synthesized = await timings.timeAsync("aggregate_synthesis", () =>
		synthesize({ router: deps.router, params, evidence }),
	);
	if (synthesized.usage) usageStages.push(synthesized.usage);
	const answer = synthesized.answer;
	if (!answer) {
		return finish(emptyAggregateResponse(params, budget, queries, sourceMemoryIds, "synthesis_failed"));
	}

	const agentId = params.agentId ?? "default";
	const project = sourceProject(params);
	const key = aggregateKey({ agentId, project, query: params.query, budget, sourceMemoryIds });

	let row: RecallResult | null;
	let deduped = false;
	let saved = false;
	if (saveAggregate && evidenceCanSaveAsGlobalAggregate(evidence) && aggregateAnswerCanBeSaved(answer)) {
		const normalized = normalizeAndHashContent(answer);
		row = timings.time("aggregate_save", () =>
			getDbAccessor().withWriteTx((db) => {
				const duplicate = resolveAggregateDuplicate(db, {
					key,
					agentId,
					project,
					query: params.query,
					contentHash: normalized.contentHash,
					answer,
					sourceMemoryIds,
					now,
				});
				if (duplicate) {
					deduped = true;
					saved = duplicate.saved;
					if (duplicate.saved) enqueueExtractionJobInTx(db, duplicate.row.id);
					return duplicate.row;
				}
				const id = deps.idFactory?.() ?? randomUUID();
				const envelope: IngestEnvelope = {
					id,
					content: normalized.storageContent,
					normalizedContent: normalized.normalizedContent || normalized.hashBasis,
					contentHash: normalized.contentHash,
					who: "signet",
					why: "aggregate recall",
					project,
					importance: 0.75,
					type: "semantic",
					tags: "aggregate,recall",
					pinned: 0,
					isDeleted: 0,
					extractionStatus: "none",
					embeddingModel: null,
					extractionModel: null,
					updatedBy: "signet",
					sourceType: "aggregate-recall",
					sourceId: key,
					idempotencyKey: key,
					scope: null,
					agentId,
					visibility: "global",
					createdAt: now,
				};
				try {
					ingestEnvelope(db, envelope);
				} catch (err) {
					if (!isUniqueConstraintError(err)) throw err;
					const racedDuplicate = resolveAggregateDuplicate(db, {
						key,
						agentId,
						project,
						query: params.query,
						contentHash: normalized.contentHash,
						answer,
						sourceMemoryIds,
						now,
					});
					if (!racedDuplicate) {
						deduped = true;
						saved = false;
						return unsavedAggregateResult(answer, key, project);
					}
					deduped = true;
					saved = racedDuplicate.saved;
					if (racedDuplicate.saved) enqueueExtractionJobInTx(db, racedDuplicate.row.id);
					return racedDuplicate.row;
				}
				linkAggregateSources(db, id, sourceMemoryIds, agentId, now);
				linkAggregateQueryHint(db, id, agentId, params.query, now);
				enqueueExtractionJobInTx(db, id);
				saved = true;
				return loadAggregateMemory(db, id);
			}),
		);
		if (row && !deduped) {
			let embedded = false;
			let embeddingError: unknown;
			try {
				embedded = await timings.timeAsync("aggregate_embedding", () =>
					embedAggregateMemory(row.id, row.content, normalized.contentHash, now, cfg.embedding, deps.embedFn),
				);
			} catch (err) {
				embeddingError = err;
			}
			if (!embedded) {
				log.warn("memory", "Aggregate recall memory saved without embedding", {
					memoryId: row.id,
					agentId,
					project,
					sourceId: key,
					contentHash: normalized.contentHash,
					sourceMemoryIds,
					reason: embeddingError instanceof Error ? "embedding_exception" : "embedding_unavailable",
					...(embeddingError instanceof Error
						? { errorName: embeddingError.name, errorMessage: embeddingError.message }
						: {}),
				});
			}
		}
	} else {
		row = unsavedAggregateResult(answer, key, project);
	}

	return finish({
		results: row ? [row] : [],
		query: params.query,
		method: "hybrid",
		meta: {
			totalReturned: row ? 1 : 0,
			hasSupplementary: false,
			noHits: !row,
			timings: { totalMs: 0, stages: [] },
		},
		aggregate: {
			savedMemoryId: saved && row ? row.id : null,
			saved,
			deduped,
			budget,
			queries,
			sourceMemoryIds,
			stoppedReason: "complete",
		},
	});
}
