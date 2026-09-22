import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cosineSimilarity } from "@signet/core";
import { runMigrations } from "../../core/src/migrations";
import { vectorToBlob } from "./db-helpers";

function insertMemory(db: Database, id: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
		 VALUES (?, ?, 'fact', ?, ?, 'test')`,
	).run(id, content, now, now);
}

function insertEmbedding(db: Database, id: string, sourceId: string, vector: readonly number[]): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
	).run(id, `hash-${id}`, vectorToBlob(vector), vector.length, sourceId, `chunk for ${sourceId}`, now);
}

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
});

afterEach(() => {
	db.close();
});

describe("vectorToBlob -> DB -> cosineSimilarity integration", () => {
	test("blob written by vectorToBlob is correctly read back for cosine similarity", () => {
		const queryVec = [0.5, 0.3, -0.1, 0.8];
		const similarVec = [0.5, 0.3, -0.1, 0.7];
		const dissimilarVec = [-0.5, -0.3, 0.1, -0.8];

		insertMemory(db, "mem-similar", "similar memory");
		insertMemory(db, "mem-dissimilar", "dissimilar memory");
		insertEmbedding(db, "emb-similar", "mem-similar", similarVec);
		insertEmbedding(db, "emb-dissimilar", "mem-dissimilar", dissimilarVec);
		const rows = db.prepare(`SELECT source_id, vector FROM embeddings WHERE source_type = 'memory'`).all() as Array<{
			source_id: string;
			vector: Buffer;
		}>;

		expect(rows.length).toBe(2);
		const queryF32 = new Float32Array(queryVec);
		const embMap = new Map<string, Float32Array>();
		for (const row of rows) {
			const f32 = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
			embMap.set(row.source_id, f32);
		}
		const similar = embMap.get("mem-similar");
		const dissimilar = embMap.get("mem-dissimilar");
		if (!similar || !dissimilar) throw new Error("expected both embedding rows");
		const similarScore = cosineSimilarity(queryF32, similar);
		const dissimilarScore = cosineSimilarity(queryF32, dissimilar);
		expect(similarScore).toBeGreaterThan(0.9);
		expect(dissimilarScore).toBeLessThan(-0.9);
		expect(similarScore).toBeGreaterThan(dissimilarScore);
	});

	test("reranking with blended scores preserves correct ordering", () => {
		const queryVec = [1.0, 0.0, 0.0];
		const candidates = [
			{ id: "mem-a", vec: [0.9, 0.1, 0.0], originalScore: 0.5 },
			{ id: "mem-b", vec: [0.1, 0.9, 0.0], originalScore: 0.8 },
			{ id: "mem-c", vec: [0.95, 0.05, 0.0], originalScore: 0.3 },
		];

		for (const c of candidates) {
			insertMemory(db, c.id, `content for ${c.id}`);
			insertEmbedding(db, `emb-${c.id}`, c.id, c.vec);
		}

		const queryF32 = new Float32Array(queryVec);
		const blendWeight = 0.3;
		const rows = db.prepare(`SELECT source_id, vector FROM embeddings WHERE source_type = 'memory'`).all() as Array<{
			source_id: string;
			vector: Buffer;
		}>;

		const embMap = new Map<string, Float32Array>();
		for (const row of rows) {
			embMap.set(row.source_id, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
		}

		const reranked = candidates.map((c) => {
			const cachedVec = embMap.get(c.id);
			if (!cachedVec) return { id: c.id, score: c.originalScore };
			const sim = cosineSimilarity(queryF32, cachedVec);
			const blended = (1 - blendWeight) * c.originalScore + blendWeight * sim;
			return { id: c.id, score: blended };
		});

		reranked.sort((a, b) => b.score - a.score);
		const aIdx = reranked.findIndex((r) => r.id === "mem-a");
		const bIdx = reranked.findIndex((r) => r.id === "mem-b");
		expect(aIdx).toBeLessThan(bIdx);
	});

	test("vectorToBlob round-trip through DB matches direct Float32Array construction", () => {
		const original = [0.1, 0.2, 0.3, 0.4, 0.5];

		insertMemory(db, "mem-rt", "round trip test");
		insertEmbedding(db, "emb-rt", "mem-rt", original);

		const row = db.prepare(`SELECT vector FROM embeddings WHERE id = 'emb-rt'`).get() as { vector: Buffer };

		const fromDb = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
		const direct = new Float32Array(original);

		expect(fromDb.length).toBe(direct.length);
		for (let i = 0; i < fromDb.length; i++) {
			expect(fromDb[i]).toBe(direct[i]);
		}
	});
});

describe("KNN edge building (same algorithm as umap-projection.ts)", () => {
	test("KNN edges connect nearest points correctly", () => {
		function squaredDistance(left: readonly number[], right: readonly number[]): number {
			let distance = 0;
			for (let i = 0; i < left.length; i++) {
				const diff = left[i] - right[i];
				distance += diff * diff;
			}
			return distance;
		}
		const points = [
			[0.0, 0.0],
			[0.1, 0.1],
			[0.0, 0.1],
			[10.0, 10.0],
		];
		const k = 2;
		const edgeSet = new Set<string>();
		const edges: [number, number][] = [];

		for (let i = 0; i < points.length; i++) {
			const dists: { j: number; d: number }[] = [];
			for (let j = 0; j < points.length; j++) {
				if (i === j) continue;
				dists.push({ j, d: squaredDistance(points[i], points[j]) });
			}
			dists.sort((a, b) => a.d - b.d);
			for (let n = 0; n < Math.min(k, dists.length); n++) {
				const a = Math.min(i, dists[n].j);
				const b = Math.max(i, dists[n].j);
				const key = `${a}-${b}`;
				if (!edgeSet.has(key)) {
					edgeSet.add(key);
					edges.push([a, b]);
				}
			}
		}
		expect(edgeSet.has("0-1")).toBe(true);
		expect(edgeSet.has("0-2")).toBe(true);
		expect(edgeSet.has("1-2")).toBe(true);
		const outlierEdges = edges.filter(([a, b]) => a === 3 || b === 3);
		expect(outlierEdges.length).toBeGreaterThan(0);
	});
});
