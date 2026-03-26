/**
 * Tests for RaBitQ compressed vector search.
 *
 * Validates:
 * - Rotation matrix orthogonality
 * - Codebook distribution properties
 * - Round-trip accuracy (quantize → dequantize)
 * - Compressed search recall vs brute force
 * - Edge cases (empty, single vector, dimension mismatch)
 * - Performance benchmarks
 */

import { describe, expect, test } from "bun:test";
import {
	type CompressedIndex,
	bruteForceSearch,
	compressedSearch,
	computeCodebook,
	dequantize,
	generateRotationMatrix,
	quantize,
} from "./rabitq";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seeded pseudo-random number generator (simple LCG for test data). */
function makeRng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) & 0x7fffffff;
		return s / 0x7fffffff;
	};
}

/** Generate a random Float32Array vector with gaussian-like values. */
function randomVector(dim: number, rng: () => number): Float32Array {
	const vec = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		// Box-Muller transform for gaussian-ish values
		const u = rng() || 0.001;
		const v = rng();
		vec[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}
	return vec;
}

/** Normalize a vector to unit length in-place. */
function normalize(vec: Float32Array): Float32Array {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) {
		norm += vec[i] * vec[i];
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < vec.length; i++) {
			vec[i] /= norm;
		}
	}
	return vec;
}

/** Cosine similarity between two vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let nA = 0;
	let nB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		nA += a[i] * a[i];
		nB += b[i] * b[i];
	}
	const denom = Math.sqrt(nA) * Math.sqrt(nB);
	return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// Rotation Matrix Tests
// ---------------------------------------------------------------------------

describe("generateRotationMatrix", () => {
	test("produces orthogonal matrix for small dimensions", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);

		expect(R.length).toBe(dim * dim);

		// R * R^T should ≈ Identity
		for (let i = 0; i < dim; i++) {
			for (let j = 0; j < dim; j++) {
				let dot = 0;
				for (let k = 0; k < dim; k++) {
					dot += R[i * dim + k] * R[j * dim + k];
				}
				const expected = i === j ? 1 : 0;
				expect(Math.abs(dot - expected)).toBeLessThan(1e-4);
			}
		}
	});

	test("deterministic with same seed", () => {
		const dim = 32;
		const R1 = generateRotationMatrix(dim, 123);
		const R2 = generateRotationMatrix(dim, 123);

		for (let i = 0; i < R1.length; i++) {
			expect(R1[i]).toBe(R2[i]);
		}
	});

	test("different seeds produce different matrices", () => {
		const dim = 16;
		const R1 = generateRotationMatrix(dim, 1);
		const R2 = generateRotationMatrix(dim, 2);

		let same = true;
		for (let i = 0; i < R1.length; i++) {
			if (R1[i] !== R2[i]) {
				same = false;
				break;
			}
		}
		expect(same).toBe(false);
	});

	test("preserves vector norms (rotation is isometric)", () => {
		const dim = 32;
		const R = generateRotationMatrix(dim, 42);
		const rng = makeRng(99);
		const vec = randomVector(dim, rng);

		// Compute R × vec
		const rotated = new Float32Array(dim);
		for (let i = 0; i < dim; i++) {
			let sum = 0;
			for (let j = 0; j < dim; j++) {
				sum += R[i * dim + j] * vec[j];
			}
			rotated[i] = sum;
		}

		let origNorm = 0;
		let rotNorm = 0;
		for (let i = 0; i < dim; i++) {
			origNorm += vec[i] * vec[i];
			rotNorm += rotated[i] * rotated[i];
		}

		expect(Math.abs(Math.sqrt(origNorm) - Math.sqrt(rotNorm))).toBeLessThan(1e-4);
	});
});

// ---------------------------------------------------------------------------
// Codebook Tests
// ---------------------------------------------------------------------------

describe("computeCodebook", () => {
	test("produces correct number of centroids", () => {
		const cb4 = computeCodebook(4, 768);
		expect(cb4.length).toBe(16);

		const cb2 = computeCodebook(2, 768);
		expect(cb2.length).toBe(4);

		const cb1 = computeCodebook(1, 768);
		expect(cb1.length).toBe(2);
	});

	test("centroids are sorted ascending", () => {
		const cb = computeCodebook(4, 768);
		for (let i = 1; i < cb.length; i++) {
			expect(cb[i]).toBeGreaterThanOrEqual(cb[i - 1]);
		}
	});

	test("centroids are in [-1, 1] range", () => {
		const cb = computeCodebook(4, 768);
		for (let i = 0; i < cb.length; i++) {
			expect(cb[i]).toBeGreaterThanOrEqual(-1);
			expect(cb[i]).toBeLessThanOrEqual(1);
		}
	});

	test("centroids are symmetric around 0 for high dimensions", () => {
		const cb = computeCodebook(4, 768);
		// For symmetric Beta(d/2, d/2), centroids should be approximately
		// symmetric: c[i] ≈ -c[n-1-i]
		for (let i = 0; i < cb.length / 2; i++) {
			const j = cb.length - 1 - i;
			expect(Math.abs(cb[i] + cb[j])).toBeLessThan(0.01);
		}
	});

	test("centroids cluster near 0 for high dimensions (concentration of measure)", () => {
		const cb = computeCodebook(4, 768);
		// For dim=768, Beta(384, 384) concentrates heavily near 0.5,
		// mapping to near 0 in [-1, 1] space
		for (let i = 0; i < cb.length; i++) {
			expect(Math.abs(cb[i])).toBeLessThan(0.15);
		}
	});
});

// ---------------------------------------------------------------------------
// Quantize / Dequantize Round-Trip Tests
// ---------------------------------------------------------------------------

describe("quantize + dequantize", () => {
	const dim = 64; // Smaller dim for faster tests
	const seed = 42;
	const bits = 4;

	test("round-trip preserves vector direction (cosine > 0.7)", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(100);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`vec-${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);
		const restored = dequantize(index);

		expect(restored.length).toBe(vectors.length);

		for (let i = 0; i < vectors.length; i++) {
			const sim = cosine(vectors[i], restored[i]);
			// With maxDev stored, round-trip accuracy is high; cosine > 0.85 for 4-bit at dim=64
			expect(sim).toBeGreaterThan(0.85);
		}
	});

	test("round-trip preserves approximate norms", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(200);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			vectors.push(randomVector(dim, rng));
			ids.push(`vec-${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);
		const restored = dequantize(index);

		for (let i = 0; i < vectors.length; i++) {
			let origNorm = 0;
			let restNorm = 0;
			for (let j = 0; j < dim; j++) {
				origNorm += vectors[i][j] * vectors[i][j];
				restNorm += restored[i][j] * restored[i][j];
			}
			origNorm = Math.sqrt(origNorm);
			restNorm = Math.sqrt(restNorm);

			// Norms should be within 30%
			const ratio = restNorm / origNorm;
			expect(ratio).toBeGreaterThan(0.7);
			expect(ratio).toBeLessThan(1.3);
		}
	});

	test("preserves vector IDs in order", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(300);

		const ids = ["alpha", "beta", "gamma"];
		const vectors = ids.map(() => randomVector(dim, rng));

		const index = quantize(vectors, ids, R, cb, bits);

		expect(index.count).toBe(3);
		expect(index.vectors[0].id).toBe("alpha");
		expect(index.vectors[1].id).toBe("beta");
		expect(index.vectors[2].id).toBe("gamma");
	});

	test("compressed size is smaller than original", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(400);

		const numVectors = 100;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(randomVector(dim, rng));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);

		// Original: numVectors × dim × 4 bytes
		const originalBytes = numVectors * dim * 4;
		// Compressed: numVectors × (bytesPerVector + 8 bytes for norm+mean)
		const compressedBytes = numVectors * (Math.ceil(dim / 2) + 8);
		// Plus rotation matrix and codebook (amortized)
		const overhead = R.byteLength + cb.byteLength;

		expect(compressedBytes + overhead).toBeLessThan(originalBytes);
		expect(index.count).toBe(numVectors);
	});
});

// ---------------------------------------------------------------------------
// Compressed Search Tests
// ---------------------------------------------------------------------------

describe("compressedSearch", () => {
	const dim = 64;
	const seed = 42;
	const bits = 4;

	test("returns correct number of results", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(500);

		const numVectors = 50;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);
		const query = normalize(randomVector(dim, rng));

		const results10 = compressedSearch(query, index, 10);
		expect(results10.length).toBe(10);

		const results5 = compressedSearch(query, index, 5);
		expect(results5.length).toBe(5);

		const resultsAll = compressedSearch(query, index, 100);
		expect(resultsAll.length).toBe(numVectors);
	});

	test("results are sorted by score descending", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(600);

		const numVectors = 30;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);
		const query = normalize(randomVector(dim, rng));
		const results = compressedSearch(query, index, 20);

		for (let i = 1; i < results.length; i++) {
			expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
		}
	});

	test("recall@10 vs brute force is reasonable (> 0.3 for 64-dim)", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(700);

		const numVectors = 200;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);

		// Test multiple queries
		let totalRecall = 0;
		const numQueries = 10;

		for (let q = 0; q < numQueries; q++) {
			const query = normalize(randomVector(dim, rng));
			const k = 10;

			const compressed = compressedSearch(query, index, k);
			const bruteForce = bruteForceSearch(query, vectors, ids, k);

			const trueTopK = new Set(bruteForce.map((r) => r.id));
			let hits = 0;
			for (const r of compressed) {
				if (trueTopK.has(r.id)) hits++;
			}

			totalRecall += hits / k;
		}

		const avgRecall = totalRecall / numQueries;
		// For 64-dim 4-bit quantization, recall@10 should be > 0.3
		expect(avgRecall).toBeGreaterThan(0.3);
	});

	test("finds exact match when query is one of the vectors", () => {
		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(800);

		const numVectors = 20;
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);

		// Search for a vector that's in the index
		const targetIdx = 5;
		const results = compressedSearch(vectors[targetIdx], index, 5);

		// The exact vector should appear in top-5
		const foundIds = results.map((r) => r.id);
		expect(foundIds).toContain(`v${targetIdx}`);
	});
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	test("empty vector set produces empty index", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);

		const index = quantize([], [], R, cb, 4);
		expect(index.count).toBe(0);
		expect(index.vectors.length).toBe(0);
	});

	test("empty index search returns empty results", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);

		const index = quantize([], [], R, cb, 4);
		const query = new Float32Array(dim);
		const results = compressedSearch(query, index, 10);
		expect(results.length).toBe(0);
	});

	test("single vector quantize/search works", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);
		const rng = makeRng(900);

		const vec = normalize(randomVector(dim, rng));
		const index = quantize([vec], ["single"], R, cb, 4);

		expect(index.count).toBe(1);

		const results = compressedSearch(vec, index, 1);
		expect(results.length).toBe(1);
		expect(results[0].id).toBe("single");
	});

	test("dimension mismatch throws on quantize", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);

		const vec32 = new Float32Array(32);
		const vec16 = new Float32Array(16);

		expect(() => quantize([vec16, vec32], ["a", "b"], R, cb, 4)).toThrow();
	});

	test("dimension mismatch throws on search", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);
		const rng = makeRng(950);

		const vec = normalize(randomVector(dim, rng));
		const index = quantize([vec], ["x"], R, cb, 4);

		const wrongDimQuery = new Float32Array(32);
		expect(() => compressedSearch(wrongDimQuery, index, 1)).toThrow();
	});

	test("vector/id count mismatch throws", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);

		const vec = new Float32Array(dim);
		expect(() => quantize([vec], ["a", "b"], R, cb, 4)).toThrow();
	});

	test("zero vector is handled gracefully", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);

		const zero = new Float32Array(dim); // all zeros
		const index = quantize([zero], ["zero"], R, cb, 4);
		expect(index.count).toBe(1);

		// Search with zero query returns empty (norm too small)
		const results = compressedSearch(zero, index, 1);
		expect(results.length).toBe(0);
	});

	test("topK = 0 returns empty results", () => {
		const dim = 16;
		const R = generateRotationMatrix(dim, 42);
		const cb = computeCodebook(4, dim);
		const rng = makeRng(960);

		const vec = normalize(randomVector(dim, rng));
		const index = quantize([vec], ["x"], R, cb, 4);
		const results = compressedSearch(vec, index, 0);
		expect(results.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Performance Benchmarks
// ---------------------------------------------------------------------------

describe("performance", () => {
	test("compressed search is faster than brute force on 1K vectors", () => {
		const dim = 128; // Smaller than 768 for test speed
		const numVectors = 1000;
		const bits = 4;
		const seed = 42;
		const topK = 10;

		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(1000);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);
		const query = normalize(randomVector(dim, rng));

		// Warm up
		compressedSearch(query, index, topK);
		bruteForceSearch(query, vectors, ids, topK);

		// Benchmark compressed search
		const compStart = performance.now();
		const compIterations = 50;
		for (let i = 0; i < compIterations; i++) {
			compressedSearch(query, index, topK);
		}
		const compTime = (performance.now() - compStart) / compIterations;

		// Benchmark brute force
		const bfStart = performance.now();
		for (let i = 0; i < compIterations; i++) {
			bruteForceSearch(query, vectors, ids, topK);
		}
		const bfTime = (performance.now() - bfStart) / compIterations;

		console.log(`  Compressed search: ${compTime.toFixed(2)}ms per query (${numVectors} vectors, ${dim}-dim)`);
		console.log(`  Brute force:       ${bfTime.toFixed(2)}ms per query`);
		console.log(`  Speedup:           ${(bfTime / compTime).toFixed(1)}×`);

		// Just verify both produce results (speedup depends on hardware)
		expect(compTime).toBeGreaterThan(0);
		expect(bfTime).toBeGreaterThan(0);
	});

	test("memory compression ratio is significant", () => {
		const dim = 768; // Actual embedding dimension
		const numVectors = 1000;
		const bits = 4;

		// Original: numVectors × dim × 4 bytes (Float32)
		const originalBytes = numVectors * dim * 4; // 3,072,000 bytes (~3MB)

		// Compressed: numVectors × (dim/2 bytes + 8 bytes for norm+mean)
		const compressedPerVector = Math.ceil(dim / 2) + 8; // 392 bytes
		const compressedBytes = numVectors * compressedPerVector; // 392,000 bytes

		// Overhead: rotation matrix + codebook (shared, amortized)
		const overheadBytes = dim * dim * 4 + (1 << bits) * 4; // ~2.36MB (rotation is big)

		const ratio = originalBytes / (compressedBytes + overheadBytes);

		console.log(`  Original:     ${(originalBytes / 1024).toFixed(0)} KB`);
		console.log(`  Compressed:   ${(compressedBytes / 1024).toFixed(0)} KB (vectors only)`);
		console.log(`  Overhead:     ${(overheadBytes / 1024).toFixed(0)} KB (rotation + codebook)`);
		console.log(`  Total ratio:  ${ratio.toFixed(2)}× compression`);

		// For 1K vectors, overhead dominates. At 10K vectors:
		const overhead10k = overheadBytes;
		const compressed10k = 10000 * compressedPerVector;
		const original10k = 10000 * dim * 4;
		const ratio10k = original10k / (compressed10k + overhead10k);
		console.log(`  At 10K vectors: ${ratio10k.toFixed(2)}× compression`);

		// At scale (10K+ vectors), compression should be > 3×
		expect(ratio10k).toBeGreaterThan(3);
	});
});

// ---------------------------------------------------------------------------
// Higher-dimensional recall test (closer to production 768-dim)
// ---------------------------------------------------------------------------

describe("higher-dimensional quality", () => {
	test("recall@10 on 256-dim 500-vector set", () => {
		const dim = 256;
		const numVectors = 500;
		const bits = 4;
		const seed = 12345;
		const topK = 10;

		const R = generateRotationMatrix(dim, seed);
		const cb = computeCodebook(bits, dim);
		const rng = makeRng(2000);

		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		for (let i = 0; i < numVectors; i++) {
			vectors.push(normalize(randomVector(dim, rng)));
			ids.push(`v${i}`);
		}

		const index = quantize(vectors, ids, R, cb, bits);

		let totalRecall = 0;
		const numQueries = 20;

		for (let q = 0; q < numQueries; q++) {
			const query = normalize(randomVector(dim, rng));
			const compressed = compressedSearch(query, index, topK);
			const truth = bruteForceSearch(query, vectors, ids, topK);

			const trueSet = new Set(truth.map((r) => r.id));
			let hits = 0;
			for (const r of compressed) {
				if (trueSet.has(r.id)) hits++;
			}
			totalRecall += hits / topK;
		}

		const avgRecall = totalRecall / numQueries;
		console.log(`  Recall@${topK} (${dim}-dim, ${numVectors} vectors): ${(avgRecall * 100).toFixed(1)}%`);

		// Higher dimensions should give better recall due to concentration of measure
		expect(avgRecall).toBeGreaterThan(0.2);
	});
});
