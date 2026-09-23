import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { WriteDb } from "./db-accessor";
import {
	type EpisodicCursor,
	readEpisodicMemory,
	readEpisodicSource,
	readRecentEpisodicSources,
} from "./episodic-sources";
import { renderDreamingEvidenceMeta } from "./pipeline/dreaming-evidence";
import { txForgetMemory, txIngestEnvelope, txModifyMemory } from "./transactions";

function asWriteDb(db: Database): WriteDb {
	return db as unknown as WriteDb;
}

function insertEpisodicMemory(
	db: Database,
	input: {
		id: string;
		content: string;
		contentHash: string;
		agentId?: string;
		visibility?: "global" | "private" | "archived";
		project?: string | null;
		scope?: string | null;
		type?: string;
		sourceType?: string;
		sourceId?: string | null;
		/** Defaults to 'episodic' when omitted. Pass null explicitly to model a derived row. */
		memoryKind?: string | null;
		isDeleted?: number;
		createdAt?: string;
	},
): void {
	const now = input.createdAt ?? new Date().toISOString();
	txIngestEnvelope(asWriteDb(db), {
		id: input.id,
		content: input.content,
		normalizedContent: input.content.toLowerCase(),
		contentHash: input.contentHash,
		who: "test",
		why: "explicit",
		project: input.project ?? null,
		importance: 0.6,
		type: input.type ?? "fact",
		tags: null,
		pinned: 0,
		isDeleted: input.isDeleted ?? 0,
		extractionStatus: "none",
		embeddingModel: null,
		extractionModel: null,
		updatedBy: "test",
		memoryKind: input.memoryKind === undefined ? "episodic" : input.memoryKind,
		sourceType: input.sourceType ?? "manual",
		sourceId: input.sourceId ?? null,
		sourcePath: null,
		runtimePath: null,
		idempotencyKey: null,
		scope: input.scope ?? null,
		agentId: input.agentId ?? "default",
		visibility: input.visibility ?? "global",
		createdAt: now,
	});
}

describe("episodic-evidence cutover: episodic-sources selector", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("reads non-deleted episodic memory rows and excludes other kinds and deleted rows", () => {
		insertEpisodicMemory(db, {
			id: "epi-1",
			content: "user prefers vim",
			contentHash: "hash-epi-1",
			sourceType: "manual",
		});
		insertEpisodicMemory(db, {
			id: "epi-deleted",
			content: "deleted evidence",
			contentHash: "hash-epi-del",
			isDeleted: 1,
		});
		// A non-episodic (derived) memory row is NOT primary evidence
		insertEpisodicMemory(db, {
			id: "derived-1",
			content: "derived semantic fact",
			contentHash: "hash-derived-1",
			sourceType: "extract",
			memoryKind: null,
		});

		const rows = readRecentEpisodicSources(
			db as unknown as Parameters<typeof readRecentEpisodicSources>[0],
			"default",
			10,
		);
		expect(rows.map((r) => r.id)).toEqual(["epi-1"]);
		expect(rows[0]).toMatchObject({
			kind: "memory",
			content: "user prefers vim",
			sourceKind: "manual",
		});
	});

	it("keeps private evidence but excludes archived and scoped episodic memories", () => {
		insertEpisodicMemory(db, {
			id: "private-episodic",
			content: "private evidence remains available to its agent",
			contentHash: "hash-private-episodic",
			visibility: "private",
		});
		insertEpisodicMemory(db, {
			id: "archived-episodic",
			content: "archived evidence must not be consolidated",
			contentHash: "hash-archived-episodic",
			visibility: "archived",
		});
		insertEpisodicMemory(db, {
			id: "scoped-episodic",
			content: "benchmark evidence must not enter the agent graph",
			contentHash: "hash-scoped-episodic",
			scope: "bench:run-1",
		});

		const readDb = db as unknown as Parameters<typeof readRecentEpisodicSources>[0];
		expect(readRecentEpisodicSources(readDb, "default", 10).map((record) => record.id)).toEqual(["private-episodic"]);
		expect(readEpisodicMemory(readDb, "default", "archived-episodic")).toBeNull();
		expect(readEpisodicMemory(readDb, "default", "scoped-episodic")).toBeNull();
	});

	it("resolves a single episodic memory by id with memory: prefix", () => {
		insertEpisodicMemory(db, {
			id: "epi-resolve",
			content: "structured payload retained",
			contentHash: "hash-resolve",
		});

		const record = readEpisodicSource(db as unknown as Parameters<typeof readEpisodicSource>[0], {
			agentId: "default",
			from: "memory:epi-resolve",
		});
		expect(record).toMatchObject({ kind: "memory", id: "epi-resolve", content: "structured payload retained" });

		const direct = readEpisodicMemory(
			db as unknown as Parameters<typeof readEpisodicMemory>[0],
			"default",
			"epi-resolve",
		);
		expect(direct?.id).toBe("epi-resolve");
	});

	it("does not cross agent boundaries", () => {
		insertEpisodicMemory(db, {
			id: "epi-agent-a",
			content: "agent a evidence",
			contentHash: "hash-a",
			agentId: "agent-a",
		});
		insertEpisodicMemory(db, {
			id: "epi-agent-b",
			content: "agent b evidence",
			contentHash: "hash-b",
			agentId: "agent-b",
		});

		const rows = readRecentEpisodicSources(
			db as unknown as Parameters<typeof readRecentEpisodicSources>[0],
			"agent-a",
			10,
		);
		expect(rows.map((r) => r.id)).toEqual(["epi-agent-a"]);
	});

	it("respects the cursor to avoid re-reading already-processed evidence", () => {
		insertEpisodicMemory(db, {
			id: "epi-old",
			content: "older",
			contentHash: "h-old",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		insertEpisodicMemory(db, {
			id: "epi-new",
			content: "newer",
			contentHash: "h-new",
			createdAt: "2026-02-01T00:00:00.000Z",
		});

		const readDb = db as unknown as Parameters<typeof readRecentEpisodicSources>[0];
		const first = readRecentEpisodicSources(readDb, "default", 1, undefined, null, "oldest");
		expect(first.map((r) => r.id)).toEqual(["epi-old"]);
		const cursor: EpisodicCursor = {
			capturedAt: first[0].capturedAt,
			kind: first[0].kind,
			id: first[0].id,
		};
		const next = readRecentEpisodicSources(readDb, "default", 10, undefined, null, "oldest", cursor);
		expect(next.map((r) => r.id)).toEqual(["epi-new"]);
	});

	it("metadata edits do not re-submit already-processed evidence (#946)", () => {
		// Evidence is ordered/cursored by immutable created_at, not updated_at.
		// A metadata edit (tags/importance/pinned) bumps updated_at but must not
		// move the row past the cursor, which would re-process it.
		insertEpisodicMemory(db, {
			id: "epi-stable",
			content: "first evidence",
			contentHash: "h-stable",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		insertEpisodicMemory(db, {
			id: "epi-after",
			content: "second evidence",
			contentHash: "h-after",
			createdAt: "2026-02-01T00:00:00.000Z",
		});

		const readDb = db as unknown as Parameters<typeof readRecentEpisodicSources>[0];
		const first = readRecentEpisodicSources(readDb, "default", 1, undefined, null, "oldest");
		expect(first.map((r) => r.id)).toEqual(["epi-stable"]);
		const cursor: EpisodicCursor = {
			capturedAt: first[0].capturedAt,
			kind: first[0].kind,
			id: first[0].id,
		};

		// Metadata edit bumps updated_at to a time AFTER the second evidence.
		txModifyMemory(asWriteDb(db), {
			memoryId: "epi-stable",
			patch: { tags: "re-ranked" },
			reason: "re-rank",
			changedBy: "curator",
			changedAt: "2026-03-01T00:00:00.000Z",
		});

		// The edited row must NOT reappear — cursor is by created_at.
		const next = readRecentEpisodicSources(readDb, "default", 10, undefined, null, "oldest", cursor);
		expect(next.map((r) => r.id)).toEqual(["epi-after"]);
	});
});

describe("episodic-evidence cutover: immutable content protection", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("rejects content changes on episodic memories", () => {
		insertEpisodicMemory(db, { id: "epi-imm", content: "original evidence", contentHash: "h-imm" });

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "epi-imm",
			patch: { content: "tampered evidence", normalizedContent: "tampered", contentHash: "h-imm-2" },
			reason: "attempt content rewrite",
			changedBy: "curator",
			changedAt: new Date().toISOString(),
		});
		expect(result.status).toBe("episodic_content_immutable");
		// Content is unchanged
		const row = db.prepare("SELECT content FROM memories WHERE id = ?").get("epi-imm") as { content: string };
		expect(row.content).toBe("original evidence");
	});

	it("rejects type changes on episodic memories", () => {
		insertEpisodicMemory(db, { id: "epi-type", content: "typed evidence", contentHash: "h-type" });

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "epi-type",
			patch: { type: "decision" },
			reason: "attempt type change",
			changedBy: "curator",
			changedAt: new Date().toISOString(),
		});
		expect(result.status).toBe("episodic_content_immutable");
	});

	it("rejects content changes on compaction recall projections", () => {
		insertEpisodicMemory(db, {
			id: "compaction-projection",
			content: "immutable compaction evidence",
			contentHash: "h-compaction-projection",
			type: "session_summary",
			memoryKind: null,
		});

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "compaction-projection",
			patch: { content: "rewritten projection", normalizedContent: "rewritten", contentHash: "h-compaction-rewritten" },
			reason: "attempt compaction rewrite",
			changedBy: "curator",
			changedAt: new Date().toISOString(),
		});

		expect(result.status).toBe("episodic_content_immutable");
	});

	it("allows metadata (tags, importance, pinned) updates on episodic memories", () => {
		insertEpisodicMemory(db, { id: "epi-meta", content: "metadata evidence", contentHash: "h-meta" });

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "epi-meta",
			patch: { tags: "re-ranked", importance: 0.9, pinned: 1 },
			reason: "re-rank and label",
			changedBy: "curator",
			changedAt: new Date().toISOString(),
		});
		expect(result.status).toBe("updated");
		const row = db.prepare("SELECT content, tags, importance, pinned FROM memories WHERE id = ?").get("epi-meta") as {
			content: string;
			tags: string;
			importance: number;
			pinned: number;
		};
		// Content unchanged, metadata updated
		expect(row.content).toBe("metadata evidence");
		expect(row.tags).toBe("re-ranked");
		expect(row.importance).toBe(0.9);
		expect(row.pinned).toBe(1);
	});

	it("allows content edits on non-episodic (derived) memories", () => {
		insertEpisodicMemory(db, {
			id: "derived-edit",
			content: "derived fact",
			contentHash: "h-derived-edit",
			memoryKind: null,
		});

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "derived-edit",
			patch: { content: "updated derived fact", normalizedContent: "updated", contentHash: "h-derived-edit-2" },
			reason: "semantic update",
			changedBy: "pipeline",
			changedAt: new Date().toISOString(),
		});
		expect(result.status).toBe("updated");
	});

	it("retains soft-delete (tombstone) behavior for episodic memories", () => {
		insertEpisodicMemory(db, { id: "epi-del", content: "soft-deletable evidence", contentHash: "h-del" });

		const result = txForgetMemory(asWriteDb(db), {
			memoryId: "epi-del",
			reason: "stale evidence",
			changedBy: "curator",
			changedAt: new Date().toISOString(),
			force: false,
		});
		expect(result.status).toBe("deleted");
		const row = db.prepare("SELECT is_deleted, deleted_at FROM memories WHERE id = ?").get("epi-del") as {
			is_deleted: number;
			deleted_at: string;
		};
		expect(row.is_deleted).toBe(1);
		expect(row.deleted_at).not.toBeNull();
		// Tombstoned evidence is excluded from episodic selection
		expect(
			readRecentEpisodicSources(db as unknown as Parameters<typeof readRecentEpisodicSources>[0], "default", 10).map(
				(r) => r.id,
			),
		).toEqual([]);
	});
});

describe("episodic-evidence cutover: structured payload persistence", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("stores canonical structured payload verbatim in evidence_meta", () => {
		const structured = {
			entities: [{ source: "vim", relationship: "preferred-by", target: "user", confidence: 0.9 }],
			aspects: [
				{
					entityName: "vim",
					aspect: "preferences",
					attributes: [{ content: "modal editing", confidence: 0.8 }],
				},
			],
		};
		const evidenceMeta = JSON.stringify({
			entities: structured.entities,
			aspects: structured.aspects,
		});

		txIngestEnvelope(asWriteDb(db), {
			id: "epi-struct",
			content: "User prefers vim",
			normalizedContent: "user prefers vim",
			contentHash: "h-struct",
			who: "test",
			why: "explicit",
			project: null,
			importance: 0.6,
			type: "fact",
			tags: null,
			pinned: 0,
			isDeleted: 0,
			extractionStatus: "none",
			embeddingModel: null,
			extractionModel: null,
			updatedBy: "test",
			memoryKind: "episodic",
			evidenceMeta,
			sourceType: "manual",
			sourceId: null,
			sourcePath: null,
			runtimePath: null,
			idempotencyKey: null,
			scope: null,
			agentId: "default",
			visibility: "global",
			createdAt: new Date().toISOString(),
		});

		// The evidence_meta column holds the canonical JSON blob
		const row = db.prepare("SELECT evidence_meta FROM memories WHERE id = ?").get("epi-struct") as {
			evidence_meta: string | null;
		};
		expect(row.evidence_meta).not.toBeNull();
		if (row.evidence_meta === null) throw new Error("Expected structured evidence metadata");
		const parsed = JSON.parse(row.evidence_meta);
		expect(parsed.entities).toEqual(structured.entities);
		expect(parsed.aspects).toEqual(structured.aspects);
	});

	it("structured evidence is visible to Dreaming via the episodic selector", () => {
		const evidenceMeta = JSON.stringify({
			entities: [{ source: "typescript", relationship: "used-for", target: "signet" }],
			aspects: [{ entityName: "signet", aspect: "stack", attributes: [{ content: "typescript" }] }],
		});

		insertEpisodicMemory(db, {
			id: "epi-visible",
			content: "Signet is built in TypeScript",
			contentHash: "h-visible",
		});
		// Patch evidence_meta directly — the helper doesn't expose it, but the
		// selector reads it from the column.
		db.prepare("UPDATE memories SET evidence_meta = ? WHERE id = ?").run(evidenceMeta, "epi-visible");

		// readRecentEpisodicSources surfaces evidenceMeta
		const records = readRecentEpisodicSources(
			db as unknown as Parameters<typeof readRecentEpisodicSources>[0],
			"default",
			10,
		);
		expect(records).toHaveLength(1);
		expect(records[0].evidenceMeta).toBe(evidenceMeta);

		// readEpisodicMemory also surfaces it
		const direct = readEpisodicMemory(
			db as unknown as Parameters<typeof readEpisodicMemory>[0],
			"default",
			"epi-visible",
		);
		expect(direct?.evidenceMeta).toBe(evidenceMeta);
	});

	it("structured evidence renders in the Dreaming prompt", () => {
		const evidenceMeta = JSON.stringify({
			entities: [{ source: "vim", relationship: "preferred-by", target: "user" }],
			aspects: [{ entityName: "vim", aspect: "editor", attributes: [{ content: "modal" }] }],
		});
		const rendered = renderDreamingEvidenceMeta(evidenceMeta);
		expect(rendered).toContain("structured_evidence:");
		expect(rendered).toContain("vim [preferred-by] user");
		expect(rendered).toContain("vim/editor");
	});

	it("renderEvidenceMeta returns empty for null or malformed JSON", () => {
		expect(renderDreamingEvidenceMeta(null)).toBe("");
		expect(renderDreamingEvidenceMeta("not json")).toBe("");
		expect(renderDreamingEvidenceMeta("[]")).toBe("");
	});

	it("structured remember save creates zero direct graph rows", () => {
		const structured = {
			entities: [{ source: "react", relationship: "framework", target: "frontend", confidence: 0.9 }],
			aspects: [
				{
					entityName: "react",
					entityType: "technology",
					aspect: "usage",
					attributes: [{ content: "component library", confidence: 0.8, importance: 0.7 }],
				},
			],
		};
		const evidenceMeta = JSON.stringify({
			entities: structured.entities,
			aspects: structured.aspects,
		});

		txIngestEnvelope(asWriteDb(db), {
			id: "epi-no-graph",
			content: "Project uses React",
			normalizedContent: "project uses react",
			contentHash: "h-no-graph",
			who: "test",
			why: "explicit",
			project: null,
			importance: 0.6,
			type: "fact",
			tags: null,
			pinned: 0,
			isDeleted: 0,
			extractionStatus: "none",
			embeddingModel: null,
			extractionModel: null,
			updatedBy: "test",
			memoryKind: "episodic",
			evidenceMeta,
			sourceType: "manual",
			sourceId: null,
			sourcePath: null,
			runtimePath: null,
			idempotencyKey: null,
			scope: null,
			agentId: "default",
			visibility: "global",
			createdAt: new Date().toISOString(),
		});

		// The memory row exists with the structured evidence preserved
		const mem = db.prepare("SELECT evidence_meta FROM memories WHERE id = ?").get("epi-no-graph") as {
			evidence_meta: string | null;
		};
		expect(mem.evidence_meta).not.toBeNull();

		// Zero direct semantic graph rows were created
		const entityCount = (
			db.prepare("SELECT COUNT(*) as n FROM entities WHERE name LIKE '%react%' OR name LIKE '%frontend%'").get() as {
				n: number;
			}
		).n;
		expect(entityCount).toBe(0);

		const mentionCount = (
			db.prepare("SELECT COUNT(*) as n FROM memory_entity_mentions WHERE memory_id = ?").get("epi-no-graph") as {
				n: number;
			}
		).n;
		expect(mentionCount).toBe(0);

		const attrCount = (db.prepare("SELECT COUNT(*) as n FROM entity_attributes").get() as { n: number }).n;
		expect(attrCount).toBe(0);
	});
});

/*
 * Classification consistency: fresh live-writer rows must match migration 094.
 *
 * Migration 094 classifies `reflection-answer` and `document` source_types as
 * episodic (they are NOT in the daemon-derived exclusion list
 * [extract, aggregate-recall, session_end, checkpoint]). The live writers for
 * those source types set `memoryKind: 'episodic'`; daemon-derived writers omit
 * it so fresh rows stay non-episodic (NULL), matching the migration's exclusion.
 */
describe("episodic-evidence cutover: live writer classification matches migration 094", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	function assertEpisodic(row: { memory_kind: string | null }): void {
		expect(row.memory_kind).toBe("episodic");
	}

	it("reflection-answer writer stamps memoryKind='episodic' (matches migration 094)", () => {
		// Mirror of the envelope built in routes/reflection-routes.ts answer route.
		txIngestEnvelope(asWriteDb(db), {
			id: "refl-1",
			content: "Ship the scoping fix.",
			contentHash: "reflection-a-refl-1",
			who: "agent-b",
			why: "daily-reflection-answer",
			project: null,
			importance: 0.6,
			type: "reflection",
			tags: "reflection,answered",
			pinned: 0,
			memoryKind: "episodic",
			sourceType: "reflection-answer",
			sourceId: "refl-1",
			agentId: "agent-b",
			createdAt: "2026-05-12T00:00:00.000Z",
		});

		const row = db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("refl-1") as {
			memory_kind: string | null;
		};
		assertEpisodic(row);

		// Selected by the episodic reader.
		const records = readRecentEpisodicSources(
			db as unknown as Parameters<typeof readRecentEpisodicSources>[0],
			"agent-b",
			10,
		);
		expect(records.map((r) => r.id)).toEqual(["refl-1"]);
		expect(records[0]).toMatchObject({ kind: "memory", sourceKind: "reflection-answer" });
	});

	it("document-ingest writer stamps memoryKind='episodic' (matches migration 094)", () => {
		// Mirror of the envelope built in pipeline/document-worker.ts.
		txIngestEnvelope(asWriteDb(db), {
			id: "doc-chunk-1",
			content: "document source chunk",
			normalizedContent: "document source chunk",
			contentHash: "doc-chunk-1-hash",
			who: "doc-1",
			why: "document_ingest",
			project: null,
			importance: 0.3,
			type: "document_chunk",
			tags: "document:title",
			pinned: 0,
			isDeleted: 0,
			extractionStatus: "none",
			embeddingModel: null,
			extractionModel: null,
			updatedBy: "document-worker",
			memoryKind: "episodic",
			sourceType: "document",
			sourceId: "doc-1",
			agentId: "default",
			visibility: "private",
			createdAt: "2026-05-12T00:00:00.000Z",
		});

		const row = db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("doc-chunk-1") as {
			memory_kind: string | null;
		};
		assertEpisodic(row);

		// Selected by the episodic reader.
		const records = readRecentEpisodicSources(
			db as unknown as Parameters<typeof readRecentEpisodicSources>[0],
			"default",
			10,
		);
		expect(records.map((r) => r.id)).toEqual(["doc-chunk-1"]);
		expect(records[0]).toMatchObject({ kind: "memory", sourceKind: "document" });
	});

	it("daemon-derived writers omit memoryKind so fresh rows stay non-episodic (NULL)", () => {
		// aggregate-recall is a daemon-synthesized output, NOT primary evidence.
		// Its writer (aggregate-recall.ts) omits memoryKind -> NULL -> excluded.
		txIngestEnvelope(asWriteDb(db), {
			id: "agg-1",
			content: "aggregate recall answer",
			normalizedContent: "aggregate recall answer",
			contentHash: "agg-1-hash",
			who: "signet",
			why: "aggregate recall",
			project: null,
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
			sourceId: "aggregate-recall:1",
			idempotencyKey: "aggregate-recall:1",
			scope: null,
			agentId: "default",
			visibility: "global",
			createdAt: "2026-05-12T00:00:00.000Z",
		});

		const row = db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("agg-1") as {
			memory_kind: string | null;
		};
		expect(row.memory_kind).toBeNull();

		// Excluded from the episodic reader, matching migration 094's exclusion list.
		const records = readRecentEpisodicSources(
			db as unknown as Parameters<typeof readRecentEpisodicSources>[0],
			"default",
			10,
		);
		expect(records).toEqual([]);
	});
});
