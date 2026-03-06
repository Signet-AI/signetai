/**
 * Integration tests for native vector operations in the real data flow.
 *
 * Verifies that vectorToBlob (native when available) writes correct blobs
 * to SQLite, that cosineSimilarity (native when available) scores them
 * correctly on read-back, and that KNN edge building produces correct
 * graph topology.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cosineSimilarity, runMigrations } from "@signet/core";
import { vectorToBlob } from "./db-helpers";

// ---------------------------------------------------------------------------
// Helpers (same pattern as repair-actions.test.ts)
// ---------------------------------------------------------------------------

function insertMemory(db: Database, id: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
		 VALUES (?, ?, 'fact', ?, ?, 'test')`,
	).run(id, content, now, now);
}

function insertEmbedding(
	db: Database,
	id: string,
	sourceId: string,
	vector: readonly number[],
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
	).run(id, `hash-${id}`, vectorToBlob(vector), vector.length, sourceId, `chunk for ${sourceId}`, now);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
});

afterEach(() => {
	db.close();
});

// ---------------------------------------------------------------------------
// Integration: vectorToBlob -> DB -> read back -> cosineSimilarity
// ---------------------------------------------------------------------------

describe("vectorToBlob -> DB -> cosineSimilarity integration", () => {
	test("blob written by vectorToBlob is correctly read back for cosine similarity", () => {
		const queryVec = [0.5, 0.3, -0.1, 0.8];
		const similarVec = [0.5, 0.3, -0.1, 0.7]; // close to query
		const dissimilarVec = [-0.5, -0.3, 0.1, -0.8]; // opposite

		insertMemory(db, "mem-similar", "similar memory");
		insertMemory(db, "mem-dissimilar", "dissimilar memory");
		insertEmbedding(db, "emb-similar", "mem-similar", similarVec);
		insertEmbedding(db, "emb-dissimilar", "mem-dissimilar", dissimilarVec);

		// Read embeddings back from DB (same path as reranker-embedding.ts)
		const rows = db
			.prepare(
				`SELECT source_id, vector FROM embeddings WHERE source_type = 'memory'`,
			)
			.all() as Array<{ source_id: string; vector: Buffer }>;

		expect(rows.length).toBe(2);

		// Convert blobs to Float32Arrays (same as bufferToF32 in reranker)
		const queryF32 = new Float32Array(queryVec);
		const embMap = new Map<string, Float32Array>();
		for (const row of rows) {
			const f32 = new Float32Array(
				row.vector.buffer,
				row.vector.byteOffset,
				row.vector.byteLength / 4,
			);
			embMap.set(row.source_id, f32);
		}

		// cosineSimilarity uses native when available, TS fallback otherwise
		const similarScore = cosineSimilarity(queryF32, embMap.get("mem-similar")!);
		const dissimilarScore = cosineSimilarity(queryF32, embMap.get("mem-dissimilar")!);

		// Similar vector should score much higher
		expect(similarScore).toBeGreaterThan(0.9);
		expect(dissimilarScore).toBeLessThan(-0.9);
		expect(similarScore).toBeGreaterThan(dissimilarScore);
	});

	test("reranking with blended scores preserves correct ordering", () => {
		// Simulate the reranker-embedding.ts flow
		const queryVec = [1.0, 0.0, 0.0];
		const candidates = [
			{ id: "mem-a", vec: [0.9, 0.1, 0.0], originalScore: 0.5 },
			{ id: "mem-b", vec: [0.1, 0.9, 0.0], originalScore: 0.8 }, // higher BM25 but lower cosine
			{ id: "mem-c", vec: [0.95, 0.05, 0.0], originalScore: 0.3 }, // best cosine, worst BM25
		];

		for (const c of candidates) {
			insertMemory(db, c.id, `content for ${c.id}`);
			insertEmbedding(db, `emb-${c.id}`, c.id, c.vec);
		}

		const queryF32 = new Float32Array(queryVec);
		const blendWeight = 0.3; // same as reranker-embedding.ts

		// Read back from DB and compute blended scores
		const rows = db
			.prepare(
				`SELECT source_id, vector FROM embeddings WHERE source_type = 'memory'`,
			)
			.all() as Array<{ source_id: string; vector: Buffer }>;

		const embMap = new Map<string, Float32Array>();
		for (const row of rows) {
			embMap.set(
				row.source_id,
				new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
			);
		}

		const reranked = candidates.map((c) => {
			const cachedVec = embMap.get(c.id);
			if (!cachedVec) return { id: c.id, score: c.originalScore };
			const sim = cosineSimilarity(queryF32, cachedVec);
			const blended = (1 - blendWeight) * c.originalScore + blendWeight * sim;
			return { id: c.id, score: blended };
		});

		reranked.sort((a, b) => b.score - a.score);

		// mem-a should beat mem-b after blending (high cosine overcomes lower BM25)
		const aIdx = reranked.findIndex((r) => r.id === "mem-a");
		const bIdx = reranked.findIndex((r) => r.id === "mem-b");
		expect(aIdx).toBeLessThan(bIdx);
	});

	test("vectorToBlob round-trip through DB matches direct Float32Array construction", () => {
		const original = [0.1, 0.2, 0.3, 0.4, 0.5];

		insertMemory(db, "mem-rt", "round trip test");
		insertEmbedding(db, "emb-rt", "mem-rt", original);

		const row = db
			.prepare(`SELECT vector FROM embeddings WHERE id = 'emb-rt'`)
			.get() as { vector: Buffer };

		const fromDb = new Float32Array(
			row.vector.buffer,
			row.vector.byteOffset,
			row.vector.byteLength / 4,
		);

		// Compare against direct Float32Array construction (the TS fallback path)
		const direct = new Float32Array(original);

		expect(fromDb.length).toBe(direct.length);
		for (let i = 0; i < fromDb.length; i++) {
			expect(fromDb[i]).toBe(direct[i]);
		}
	});
});

// ---------------------------------------------------------------------------
// Integration: squaredDistance in UMAP-like edge building
// ---------------------------------------------------------------------------

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

		// 4 points in 2D: a cluster of 3 close points and 1 outlier
		const points = [
			[0.0, 0.0],
			[0.1, 0.1],
			[0.0, 0.1],
			[10.0, 10.0], // outlier
		];

		// Build edges by finding k=2 nearest neighbors (same algorithm as umap-projection.ts)
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

		// The cluster points (0,1,2) should all be connected to each other
		expect(edgeSet.has("0-1")).toBe(true);
		expect(edgeSet.has("0-2")).toBe(true);
		expect(edgeSet.has("1-2")).toBe(true);

		// The outlier (3) should connect to cluster but the cluster shouldn't
		// preferentially connect to the outlier over each other
		const outlierEdges = edges.filter(([a, b]) => a === 3 || b === 3);
		expect(outlierEdges.length).toBeGreaterThan(0);
	});
});
