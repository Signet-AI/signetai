/**
 * Unified ingest apply phase (#913).
 *
 * The deterministic, shared third phase of `ingest`. Both runners (daemon
 * in-process, agentic harness) converge here: validate the IngestPlan, re-run
 * the deterministic guards OUTSIDE the model, dispatch the three output
 * classes, complete the lease. Whatever produces a valid IngestPlan, apply
 * accepts.
 *
 * Op routing (per the locked decision: no split between graph-write surfaces):
 *   - memories    → the existing guard chain (normalize → durability → hash
 *                   dedup → write gate) then txIngestEnvelope + embedding insert
 *   - graphOps    → applyOntologyOperationBatch (direct apply, propose:false),
 *                   the full 19-op vocabulary with version chains + provenance
 *   - filePatches → file-patch.ts (per-file lock + before-state + patch-id dedup)
 *
 * Resumability: every op is independently idempotent (memories dedup by content
 * hash, graph ops upsert / INSERT OR IGNORE, file patches dedup by patch id), so
 * a half-applied plan re-applied converges rather than duplicates. There is no
 * checkpoint column (per #900/#926) — the DB state itself is the resume point.
 * The lease is fenced: apply verifies the token before any write and completes
 * via CAS, so a stale token cannot write or double-complete.
 *
 * Deterministic guards are reused, not reimplemented: normalizeAndHashContent,
 * assessDurability (#917), the agent/scope-scoped findByHash, assessWriteGate.
 * Embeddings are a derived representation computed downstream from memory
 * content (never model-authored), so apply owns them via the injected embedder.
 */

import { randomUUID } from "node:crypto";
import type { DbAccessor, WriteDb } from "../../db-accessor";
import { syncVecInsert } from "../../db-helpers";
import { normalizeAndHashContent } from "../../content-normalization";
import { applyOntologyOperationBatch } from "../../ontology-proposals";
import { txIngestEnvelope } from "../../transactions";
import { type DurabilityConfig, assessDurability } from "../durability-gate";
import { type WriteGateConfig, assessWriteGate } from "../write-gate";
import type { IngestPlan, MemoryOp } from "./ingest-plan";
import { completeIngestJob, verifyIngestLease } from "./lease";
import { applyFilePatch } from "./file-patch";

/** Produces an embedding vector for text, or null if unavailable. */
export interface IngestEmbedder {
	embed(text: string): Promise<readonly number[] | null>;
}

export interface IngestApplyConfig {
	readonly actor: string;
	readonly minImportanceForWrite: number;
	readonly writeGate: WriteGateConfig;
	readonly durability: DurabilityConfig;
	/** Source attribution stamped onto created memories (from the leased batch). */
	readonly sourceType: string;
	readonly sourceId: string;
	readonly extractionModel: string | null;
	readonly embeddingModel: string | null;
}

export interface MemoryApplyResult {
	readonly opIndex: number;
	readonly opId?: string;
	readonly outcome: "applied" | "skipped" | "failed";
	readonly reason?: string;
	readonly memoryId?: string;
}

export interface GraphApplyResult {
	readonly applied: number;
	readonly failed: number;
	readonly errors: readonly string[];
}

export interface FilePatchApplyResult {
	readonly opIndex: number;
	readonly opId: string;
	readonly outcome: "applied" | "skipped" | "failed";
	readonly reason?: string;
}

export interface IngestApplyResult {
	readonly jobId: string;
	readonly completed: boolean;
	readonly memories: readonly MemoryApplyResult[];
	readonly graph: GraphApplyResult;
	readonly filePatches: readonly FilePatchApplyResult[];
	readonly planHash: string;
}

/**
 * Hash the plan body into the idempotency-key component. Computed by apply
 * (never trusted from the model) so the model cannot game the key.
 */
export function computePlanHash(plan: IngestPlan): string {
	// Structural JSON with sorted keys for determinism across executors.
	const canonical = JSON.stringify({
		memories: plan.memories,
		graphOps: plan.graphOps,
		filePatches: plan.filePatches,
	});
	let h = 0;
	for (let i = 0; i < canonical.length; i++) {
		h = (Math.imul(31, h) + canonical.charCodeAt(i)) | 0;
	}
	return `plan_${(h >>> 0).toString(16)}`;
}

function findByHash(
	db: WriteDb,
	hash: string,
	agentId: string,
	visibility: "global" | "private" | "archived",
	scope: string | null,
): { id: string } | undefined {
	if (scope !== null) {
		return db
			.prepare(
				`SELECT id FROM memories
				 WHERE content_hash = ? AND is_deleted = 0
				   AND agent_id = ? AND visibility = ? AND scope = ?
				 LIMIT 1`,
			)
			.get(hash, agentId, visibility, scope) as { id: string } | undefined;
	}
	return db
		.prepare(
			`SELECT id FROM memories
			 WHERE content_hash = ? AND is_deleted = 0
			   AND agent_id = ? AND visibility = ? AND scope IS NULL
			 LIMIT 1`,
		)
		.get(hash, agentId, visibility) as { id: string } | undefined;
}

/**
 * Apply one memory op through the deterministic guard chain.
 *
 * The pure guards (importance floor, normalize, durability) and the async
 * embedding run OUTSIDE the write tx; the db-dependent dedup + write-gate +
 * ingest run INSIDE it, atomically. This is required because withWriteTx is a
 * synchronous transaction — an async callback would commit before the embedding
 * resolves — and it keeps the dedup-then-write window race-free.
 */
type MemoryOpInner = { outcome: "applied" | "skipped" | "failed"; reason?: string; memoryId?: string };

async function applyMemoryOp(
	accessor: DbAccessor,
	op: MemoryOp,
	agentId: string,
	cfg: IngestApplyConfig,
	embedder: IngestEmbedder,
): Promise<MemoryOpInner> {
	const importance = op.importance ?? 0.5;
	if (importance < cfg.minImportanceForWrite) {
		return { outcome: "skipped", reason: "low_importance" };
	}

	const normalized = normalizeAndHashContent(op.content);
	if (normalized.normalizedContent.length === 0) {
		return { outcome: "skipped", reason: "empty_content" };
	}

	const durability = assessDurability(op.content, op.type ?? "fact", cfg.durability);
	if (!durability.durable) {
		return { outcome: "skipped", reason: "transient_operational" };
	}

	const { storageContent, normalizedContent, contentHash } = normalized;
	const visibility = op.visibility ?? "global";
	const scope = op.scope ?? null;
	const factType = op.type ?? "fact";

	// Embedding is a derived representation computed downstream (never
	// model-authored). Computed outside the tx.
	const vector = await embedder.embed(storageContent);

	// Atomic write tx: dedup → write gate → ingest. Two concurrent applies that
	// both pass the read-time dedup cannot both write — the hash uniqueness +
	// re-check inside the tx serialize them.
	return accessor.withWriteTx((db): MemoryOpInner => {
		const existing = findByHash(db, contentHash, agentId, visibility, scope);
		if (existing) {
			return { outcome: "skipped", reason: "deduped_existing", memoryId: existing.id };
		}

		const gate = assessWriteGate(db, cfg.writeGate, {
			agentId,
			sourceMemoryId: cfg.sourceId,
			sourceProject: op.project ?? null,
			sourceScope: scope,
			sourceVisibility: visibility,
			factType,
			content: storageContent,
			vector: vector ?? null,
		});
		if (!gate.bypassed && !gate.pass) {
			return { outcome: "skipped", reason: "write_gate_low_surprisal" };
		}

		const now = new Date().toISOString();
		const newMemoryId = randomUUID();
		try {
			txIngestEnvelope(db, {
				id: newMemoryId,
				content: storageContent,
				normalizedContent,
				contentHash,
				who: "ingest",
				why: op.why ?? null,
				project: op.project ?? null,
				importance: Math.max(0, Math.min(1, importance)),
				type: factType,
				tags: op.tags && op.tags.length > 0 ? op.tags.join(",") : null,
				pinned: 0,
				isDeleted: 0,
				extractionStatus: "completed",
				embeddingModel: vector ? cfg.embeddingModel : null,
				extractionModel: cfg.extractionModel,
				sourceType: cfg.sourceType,
				sourceId: cfg.sourceId,
				scope,
				agentId,
				visibility,
				createdAt: now,
			});
			if (vector) syncVecInsert(db, newMemoryId, vector as number[]);
		} catch (e) {
			return { outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
		}
		return { outcome: "applied", memoryId: newMemoryId };
	});
}

/**
 * Apply a full IngestPlan under a verified lease. Returns per-op results + the
 * computed planHash. The lease is completed via CAS only if apply ran (a stale
 * token yields completed=false and no writes).
 */
export async function applyIngestPlan(
	accessor: DbAccessor,
	plan: IngestPlan,
	leaseToken: string,
	cfg: IngestApplyConfig,
	embedder: IngestEmbedder,
): Promise<IngestApplyResult> {
	const planHash = computePlanHash(plan);

	// Fence: verify the lease before any write. A reclaimed/expired lease stops here.
	const verified = accessor.withWriteTx((db) => verifyIngestLease(db, plan.jobId, leaseToken));
	if (!verified) {
		return {
			jobId: plan.jobId,
			completed: false,
			memories: [],
			graph: { applied: 0, failed: 0, errors: ["lease not verified — stale or unknown token"] },
			filePatches: [],
			planHash,
		};
	}

	// 1) Memories — guard chain + embedding + write. Each op is its own tx so a
	//    mid-batch crash leaves a convergent partial state.
	const memoryResults: MemoryApplyResult[] = [];
	for (let i = 0; i < plan.memories.length; i++) {
		const op = plan.memories[i];
		const r = await applyMemoryOp(accessor, op, plan.agentId, cfg, embedder);
		memoryResults.push({ opIndex: i, opId: op.id, ...r });
	}

	// 2) Graph ops — the full 19-op vocabulary via the direct-apply path
	//    (propose:false: no review queue, version chains + provenance per op).
	//    The apply path is itself upsert / INSERT OR IGNORE / versioned, so a
	//    re-apply converges.
	let graphApplied = 0;
	let graphFailed = 0;
	let graphErrors: readonly string[] = [];
	if (plan.graphOps.length > 0) {
		try {
			const batch = applyOntologyOperationBatch(accessor, {
				agentId: plan.agentId,
				actor: cfg.actor,
				operations: plan.graphOps.map((op) => ({
					operation: op.operation,
					payload: op.payload,
					reason: op.reason,
					evidence: op.evidence,
					confidence: op.confidence,
					risk: op.risk ?? null,
					sourceKind: op.sourceKind ?? null,
					sourceId: op.sourceId ?? null,
					sourcePath: op.sourcePath ?? null,
					sourceRoot: op.sourceRoot ?? null,
				})),
				propose: false,
			});
			graphApplied = batch.items.length;
			if (batch.errors && batch.errors.length > 0) {
				graphFailed = batch.errors.length;
				graphErrors = batch.errors.map((e) => `${e.operation}@${e.line}: ${e.error}`);
			}
		} catch (e) {
			graphFailed = plan.graphOps.length;
			graphErrors = [e instanceof Error ? e.message : String(e)];
		}
	}
	const graph: GraphApplyResult = { applied: graphApplied, failed: graphFailed, errors: graphErrors };

	// 3) File patches — per-file lock + before-state + patch-id dedup.
	const filePatchResults: FilePatchApplyResult[] = [];
	for (let i = 0; i < plan.filePatches.length; i++) {
		const op = plan.filePatches[i];
		try {
			const outcome = await applyFilePatch(op, { agentId: plan.agentId, actor: cfg.actor });
			filePatchResults.push({ opIndex: i, opId: op.id, ...outcome });
		} catch (e) {
			filePatchResults.push({
				opIndex: i,
				opId: op.id,
				outcome: "failed",
				reason: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Complete the lease via CAS on the token. A retried apply of the same plan
	// + token is a no-op (token cleared on complete). planHash recorded.
	const completed = accessor.withWriteTx((db) => completeIngestJob(db, plan.jobId, leaseToken, planHash));

	return {
		jobId: plan.jobId,
		completed,
		memories: memoryResults,
		graph,
		filePatches: filePatchResults,
		planHash,
	};
}
