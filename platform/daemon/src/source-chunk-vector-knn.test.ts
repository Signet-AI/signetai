import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadScope } from "@signet/core";
import { type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { loadMemoryConfig } from "./memory-config";
import { buildSourceChunkVectorHits } from "./memory-search";

const OWN: ReadScope = { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null };

interface SeedRow {
	readonly id: string;
	readonly degrees: number;
	readonly sourceType: string;
	readonly agentId: string;
	readonly chunkText: string;
}

function vectorAt(degrees: number): Float32Array {
	const vector = new Float32Array(768);
	const radians = (degrees * Math.PI) / 180;
	vector[0] = Math.cos(radians);
	vector[1] = Math.sin(radians);
	return vector;
}

function seed(db: WriteDb, rows: readonly SeedRow[]): void {
	const embedding = db.prepare(
		`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
		 VALUES (?, ?, ?, 768, ?, ?, ?, '2026-11-01T00:00:00.000Z', ?)`,
	);
	const projection = db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)");
	for (const row of rows) {
		const vector = vectorAt(row.degrees);
		embedding.run(
			row.id,
			`hash-${row.id}`,
			Buffer.from(vector.buffer),
			row.sourceType,
			`obsidian:vault:${row.id}.md#chunk:0`,
			row.chunkText,
			row.agentId,
		);
		projection.run(row.id, vector);
	}
}

function chunk(id: string): string {
	return `source_id: obsidian:vault\nsource_path: /vault/${id}.md\n${id} body`;
}

function denseFixture(): SeedRow[] {
	const rows: SeedRow[] = [];
	for (let index = 0; index < 8; index++)
		rows.push({
			id: `memory-${index}`,
			degrees: 1 + index,
			sourceType: "memory",
			agentId: "default",
			chunkText: "memory",
		});
	for (let index = 0; index < 6; index++)
		rows.push({
			id: `intruder-${index}`,
			degrees: 9 + index,
			sourceType: "source_chunk",
			agentId: "intruder",
			chunkText: chunk(`intruder-${index}`),
		});
	for (let index = 0; index < 6; index++)
		rows.push({
			id: `oversized-${index}`,
			degrees: 17 + index,
			sourceType: "source_chunk",
			agentId: "default",
			chunkText: "x".repeat(70 * 1024),
		});
	for (let index = 0; index < 30; index++)
		rows.push({
			id: `eligible-${String(index).padStart(2, "0")}`,
			degrees: index < 2 ? 15 + index : 30 + index,
			sourceType: "source_chunk",
			agentId: "default",
			chunkText: chunk(`eligible-${index}`),
		});
	return rows;
}

describe("source chunk exact KNN oversampling", () => {
	let dir = "";
	let previous: string | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-source-knn-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: SourceKnn\n");
		previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
		const embedding = loadMemoryConfig(dir).embedding;
		await getDbAccessor().withWriteTxAsync((db) => ensureEmbeddingIndexState(db, embedding));
	});

	afterEach(async () => {
		await closeDbAccessor();
		if (previous === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	async function search(limit: number, existing: ReadonlySet<string> = new Set()) {
		return await buildSourceChunkVectorHits(
			vectorAt(0),
			existing,
			limit,
			"default",
			loadMemoryConfig(dir).embedding,
			undefined,
			undefined,
			OWN,
		);
	}

	it("starts at four times k over materialized hits and doubles until k eligible rows are exact", async () => {
		await getDbAccessor().withWriteTxAsync((db) => seed(db, denseFixture()));
		const outcome = await search(4);
		expect(outcome.hits.map((hit) => hit.embeddingId)).toEqual([
			"eligible-00",
			"eligible-01",
			"eligible-02",
			"eligible-03",
		]);
		expect(outcome.completeness).toBe("complete");
		expect(outcome.diagnostics).toMatchObject({
			indexedQueries: 2,
			workUnits: 16 + 32,
			candidateRows: 4,
			termination: "enough-eligible",
		});
	});

	it("switches to one exact prefiltered scan when the first window holds under half of k", async () => {
		await getDbAccessor().withWriteTxAsync((db) => seed(db, denseFixture()));
		const outcome = await search(2);
		expect(outcome.hits.map((hit) => hit.embeddingId)).toEqual(["eligible-00", "eligible-01"]);
		expect(outcome.completeness).toBe("complete");
		expect(outcome.diagnostics).toMatchObject({
			indexedQueries: 2,
			workUnits: 8 + 2,
			candidateRows: 2,
			termination: "enough-eligible",
		});
	});

	it("caps oversampling at shard size and reports exhaustion as complete", async () => {
		await getDbAccessor().withWriteTxAsync((db) => seed(db, denseFixture()));
		const outcome = await search(40);
		expect(outcome.hits.map((hit) => hit.embeddingId)).toEqual(
			Array.from({ length: 30 }, (_, index) => `eligible-${String(index).padStart(2, "0")}`),
		);
		expect(outcome.completeness).toBe("complete");
		expect(outcome.diagnostics).toMatchObject({ indexedQueries: 1, workUnits: 50, termination: "exhausted" });
	});

	it("excludes already returned sources inside SQL before the eligible limit", async () => {
		await getDbAccessor().withWriteTxAsync((db) => seed(db, denseFixture()));
		const outcome = await search(2, new Set(["obsidian:vault:eligible-00.md#chunk:0"]));
		expect(outcome.hits.map((hit) => hit.embeddingId)).toEqual(["eligible-01", "eligible-02"]);
		expect(outcome.diagnostics).toMatchObject({ indexedQueries: 2, workUnits: 8 + 2, candidateRows: 2 });
	});

	it("returns without a KNN scan when the scope has no source chunks", async () => {
		await getDbAccessor().withWriteTxAsync((db) =>
			seed(
				db,
				Array.from({ length: 20 }, (_, index) => ({
					id: `memory-only-${index}`,
					degrees: index,
					sourceType: "memory",
					agentId: "default",
					chunkText: "memory",
				})).concat([
					{ id: "intruder-only", degrees: 1, sourceType: "source_chunk", agentId: "intruder", chunkText: chunk("x") },
				]),
			),
		);
		const outcome = await search(5);
		expect(outcome.hits).toEqual([]);
		expect(outcome.completeness).toBe("complete");
		expect(outcome.diagnostics).toMatchObject({ indexedQueries: 0, workUnits: 0, termination: "exhausted" });
	});

	it("keeps sparse eligible chunks exact behind nearer ineligible rows", async () => {
		await getDbAccessor().withWriteTxAsync((db) =>
			seed(
				db,
				Array.from({ length: 48 }, (_, index) => ({
					id: `near-memory-${index}`,
					degrees: index * 0.5,
					sourceType: "memory",
					agentId: "default",
					chunkText: "memory",
				})).concat([
					{ id: "sparse-a", degrees: 60, sourceType: "source_chunk", agentId: "default", chunkText: chunk("a") },
					{ id: "sparse-b", degrees: 70, sourceType: "source_chunk", agentId: "default", chunkText: chunk("b") },
				]),
			),
		);
		const outcome = await search(2);
		expect(outcome.hits.map((hit) => hit.embeddingId)).toEqual(["sparse-a", "sparse-b"]);
		expect(outcome.completeness).toBe("complete");
		expect(outcome.diagnostics).toMatchObject({ indexedQueries: 2, workUnits: 8 + 2, candidateRows: 2 });
	});
});
