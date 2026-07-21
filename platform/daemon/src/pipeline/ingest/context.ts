/**
 * Unified ingest lease/context phase (#913).
 *
 * The deterministic first phase shared by both runners. Given a leased job,
 * build the context bundle the plan phase reasons over: the source text, the
 * DREAMING.md runbook, a bounded slice of the existing graph (so the planner
 * dedups rather than duplicates), and the token budget derived from the
 * model's context window.
 *
 * Budget: ~80% of the configured context window (`routing.ts`
 * `RoutingModelConfig.contextWindow`) with the remainder reserved for the
 * system prompt + plan response. When the window is undetectable (Claude Code,
 * or a config that omits it), a single conservative 128k fallback is used for
 * BOTH runners — the daemon knows its model's window when configured; the
 * agentic runner may declare its own via `signet ingest lease --context-budget`.
 * An item whose source alone exceeds the input budget is flagged `oversize`
 * (the caller splits at a safe boundary or fails explicitly — never silent
 * truncation from the middle).
 *
 * The source readers here RE-HOME dream-promotion.ts (which is deleted in the
 * cutover). dream-promotion stays until Phase 6; this is the unified ingest
 * home for the same job.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSpecialIdentityFiles } from "@signet/core";
import type { ReadDb } from "../../db-accessor";
import { resolveFocalEntities } from "../graph-traversal";
import { countTokens, truncateToTokens } from "../tokenizer";
import type { IngestJobRow } from "./lease";

export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_CONTEXT_BUDGET_PCT = 0.8; // share of the window for input
const DEFAULT_GRAPH_SLICE_SHARE = 0.25; // of the input budget, for the existing-graph slice

export interface IngestSourceRecord {
	readonly kind: "memory" | "document" | "payload";
	readonly id: string;
	readonly content: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
}

export interface IngestBudget {
	readonly window: number;
	readonly inputBudget: number; // tokens available for source + dreamingMd + graph slice
	readonly reservedOverhead: number; // tokens reserved for system prompt + plan response
	readonly contextBudgetPct: number;
}

export interface IngestContext {
	readonly jobId: string;
	readonly agentId: string;
	readonly source: IngestSourceRecord;
	readonly dreamingMd: string;
	readonly graphSlice: string;
	readonly focalEntityIds: readonly string[];
	readonly budget: IngestBudget;
	readonly tokens: {
		readonly source: number;
		readonly dreamingMd: number;
		readonly graphSlice: number;
		readonly total: number;
	};
	/** Source alone exceeds the input budget — caller splits or fails explicitly. */
	readonly oversize: boolean;
}

export interface BuildIngestContextOptions {
	readonly job: IngestJobRow;
	readonly agentId: string;
	readonly agentsDir: string;
	readonly contextWindow?: number;
	readonly contextBudgetPct?: number;
	readonly graphSliceShare?: number;
}

function resolveSourceFromMemory(db: ReadDb, agentId: string, memoryId: string): IngestSourceRecord | null {
	const row = db
		.prepare(
			`SELECT id, content, project
			 FROM memories
			 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0 AND id = ?
			 LIMIT 1`,
		)
		.get(agentId, memoryId) as { id: string; content: string; project: string | null } | undefined;
	if (!row) return null;
	return {
		kind: "memory",
		id: row.id,
		content: row.content,
		sourceKind: "memory",
		sourceId: row.id,
		sourcePath: null,
		project: row.project,
	};
}

function resolveSourceFromDocument(db: ReadDb, agentId: string, documentId: string): IngestSourceRecord | null {
	const row = db
		.prepare(
			`SELECT id, raw_content, source_url, project
			 FROM documents
			 WHERE agent_id = ? AND id = ?
			 LIMIT 1`,
		)
		.get(agentId, documentId) as
		| { id: string; raw_content: string | null; source_url: string | null; project: string | null }
		| undefined;
	if (!row || !row.raw_content) return null;
	return {
		kind: "document",
		id: row.id,
		content: row.raw_content,
		sourceKind: "document",
		sourceId: row.id,
		sourcePath: row.source_url,
		project: row.project,
	};
}

function resolveSourceFromPayload(job: IngestJobRow): IngestSourceRecord | null {
	if (!job.payload) return null;
	try {
		const parsed = JSON.parse(job.payload) as { text?: string; content?: string; sourcePath?: string; project?: string };
		const content = parsed.text ?? parsed.content;
		if (typeof content !== "string" || content.length === 0) return null;
		return {
			kind: "payload",
			id: job.id,
			content,
			sourceKind: "payload",
			sourceId: job.id,
			sourcePath: parsed.sourcePath ?? null,
			project: parsed.project ?? null,
		};
	} catch {
		return null;
	}
}

/** Resolve the leased job's source text (memory → document → payload). */
export function resolveIngestSource(db: ReadDb, agentId: string, job: IngestJobRow): IngestSourceRecord | null {
	if (job.memory_id) {
		const mem = resolveSourceFromMemory(db, agentId, job.memory_id);
		if (mem) return mem;
	}
	if (job.document_id) {
		const doc = resolveSourceFromDocument(db, agentId, job.document_id);
		if (doc) return doc;
	}
	return resolveSourceFromPayload(job);
}

/** Load the DREAMING.md runbook via the existing identity resolver. */
export function loadDreamingMd(agentsDir: string): string {
	const entries = resolveSpecialIdentityFiles(agentsDir, "dreaming");
	const dreaming = entries.find((e) => e.path.split(/[\\/]/).pop() === "DREAMING.md");
	if (!dreaming) return "";
	try {
		return readFileSync(join(agentsDir, dreaming.path), "utf-8").trim();
	} catch {
		return "";
	}
}

/**
 * A compact, token-bounded view of the existing entities + their active claims
 * for the focal entities the source touches — the dedup context so the planner
 * updates rather than duplicates. Empty when there are no focal entities.
 */
function loadGraphSlice(
	db: ReadDb,
	agentId: string,
	focalEntityIds: readonly string[],
	tokenBudget: number,
): { text: string; tokens: number } {
	if (focalEntityIds.length === 0) return { text: "", tokens: 0 };
	const placeholders = focalEntityIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT e.canonical_name AS entity,
			        ea.content AS aspect,
			        eab.content AS claim,
			        eab.status AS claim_status
			 FROM entities e
			 LEFT JOIN entity_aspects ea ON ea.entity_id = e.id AND ea.agent_id = e.agent_id
			 LEFT JOIN entity_attributes eab ON eab.aspect_id = ea.id AND eab.agent_id = ea.agent_id
			    AND eab.status = 'active'
			 WHERE e.agent_id = ? AND e.id IN (${placeholders})
			 ORDER BY e.canonical_name, ea.ordinal
			 LIMIT 200`,
		)
		.all(agentId, ...focalEntityIds) as unknown as readonly {
			entity: string | null;
			aspect: string | null;
			claim: string | null;
			claim_status: string | null;
		}[];

	const lines: string[] = [];
	let used = 0;
	for (const row of rows) {
		if (!row.entity) continue;
		const line = `- ${row.entity}${row.aspect ? ` / ${row.aspect}` : ""}${row.claim ? ` = ${row.claim}` : ""}`;
		const t = countTokens(line);
		if (used + t > tokenBudget) break;
		lines.push(line);
		used += t;
	}
	const text = lines.length > 0 ? `## Existing graph (dedup context)\n${lines.join("\n")}\n` : "";
	return { text, tokens: countTokens(text) };
}

export function computeIngestBudget(
	contextWindow: number | undefined,
	contextBudgetPct: number | undefined,
): IngestBudget {
	const window = contextWindow ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
	const pct = contextBudgetPct ?? DEFAULT_CONTEXT_BUDGET_PCT;
	const inputBudget = Math.floor(window * pct);
	const reservedOverhead = window - inputBudget;
	return { window, inputBudget, reservedOverhead, contextBudgetPct: pct };
}

/**
 * Build the context bundle for a leased job. Deterministic: same job + window
 * → same bundle. The planner (Phase 3) consumes this; both runners receive an
 * identical bundle for the same job (the parity contract).
 */
export function buildIngestContext(db: ReadDb, opts: BuildIngestContextOptions): IngestContext {
	const budget = computeIngestBudget(opts.contextWindow, opts.contextBudgetPct);
	const source = resolveIngestSource(db, opts.agentId, opts.job) ?? {
		kind: "payload" as const,
		id: opts.job.id,
		content: "",
		sourceKind: "payload",
		sourceId: opts.job.id,
		sourcePath: null,
		project: null,
	};

	const dreamingMd = loadDreamingMd(opts.agentsDir);
	const dreamingTokens = countTokens(dreamingMd);

	// Focal entities from the source tokens — what the graph slice keys on.
	const focal = resolveFocalEntities(db, opts.agentId, {
		project: source.project ?? undefined,
		queryTokens: tokenizeForFocal(source.content),
	});
	const focalEntityIds = focal.entityIds;

	const sliceShare = opts.graphSliceShare ?? DEFAULT_GRAPH_SLICE_SHARE;
	const sliceBudget = Math.floor(budget.inputBudget * sliceShare);
	const slice = loadGraphSlice(db, opts.agentId, focalEntityIds, sliceBudget);

	// Source fills whatever is left of the input budget after the runbook + slice.
	const remainingForSource = Math.max(0, budget.inputBudget - dreamingTokens - slice.tokens);
	const sourceTokensFull = countTokens(source.content);
	// Oversize = the source alone exceeds the whole input budget (cannot fit even
	// without the runbook + slice). The caller splits at a safe boundary or fails
	// explicitly; we never truncate the middle silently.
	const oversize = sourceTokensFull > budget.inputBudget;
	const sourceContent = oversize ? source.content : truncateToTokens(source.content, remainingForSource);
	const sourceTokens = countTokens(sourceContent);

	return {
		jobId: opts.job.id,
		agentId: opts.agentId,
		source: { ...source, content: sourceContent },
		dreamingMd,
		graphSlice: slice.text,
		focalEntityIds,
		budget,
		tokens: {
			source: sourceTokens,
			dreamingMd: dreamingTokens,
			graphSlice: slice.tokens,
			total: sourceTokens + dreamingTokens + slice.tokens,
		},
		oversize,
	};
}

/** Cheap whitespace tokenization for focal-entity resolution. */
function tokenizeForFocal(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.filter((t) => t.length >= 3)
		.slice(0, 200);
}
