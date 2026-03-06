import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Load the native addon directly (can't resolve @signet/native from within itself)
const native: typeof import("@signet/native") = require(join(__dirname, ".."));

// TS reference implementations for parity checks
function tsCosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

function tsSquaredDistance(a: readonly number[], b: readonly number[]): number {
	let distance = 0;
	for (let i = 0; i < a.length; i++) {
		const diff = a[i] - b[i];
		distance += diff * diff;
	}
	return distance;
}

function tsVectorToBlob(vec: readonly number[]): Buffer {
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer.slice(0));
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
	test("identical vectors return 1", () => {
		const v = new Float32Array([1, 2, 3]);
		expect(native.cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
	});

	test("orthogonal vectors return 0", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0, 1, 0]);
		expect(native.cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
	});

	test("opposite vectors return -1", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([-1, 0, 0]);
		expect(native.cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
	});

	test("zero vector returns 0", () => {
		const a = new Float32Array([0, 0, 0]);
		const b = new Float32Array([1, 2, 3]);
		expect(native.cosineSimilarity(a, b)).toBe(0);
	});

	test("empty vectors return 0", () => {
		const a = new Float32Array([]);
		const b = new Float32Array([]);
		expect(native.cosineSimilarity(a, b)).toBe(0);
	});

	test("mismatched lengths truncate to shorter", () => {
		const a = new Float32Array([1, 0, 0, 99]);
		const b = new Float32Array([1, 0, 0]);
		// Should only compare first 3 elements
		expect(native.cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
	});

	test("parity with TS on random 768-dim vectors", () => {
		for (let t = 0; t < 50; t++) {
			const a = new Float32Array(768);
			const b = new Float32Array(768);
			for (let i = 0; i < 768; i++) {
				a[i] = Math.random() * 2 - 1;
				b[i] = Math.random() * 2 - 1;
			}
			const rust = native.cosineSimilarity(a, b);
			const ts = tsCosineSimilarity(a, b);
			expect(Math.abs(rust - ts)).toBeLessThan(1e-7);
		}
	});
});

// ---------------------------------------------------------------------------
// squaredDistance
// ---------------------------------------------------------------------------

describe("squaredDistance", () => {
	test("identical points return 0", () => {
		const v = new Float64Array([1, 2, 3]);
		expect(native.squaredDistance(v, v)).toBe(0);
	});

	test("known distance", () => {
		const a = new Float64Array([1, 2, 3]);
		const b = new Float64Array([4, 5, 6]);
		// (3^2 + 3^2 + 3^2) = 27
		expect(native.squaredDistance(a, b)).toBe(27);
	});

	test("mismatched lengths truncate to shorter", () => {
		const a = new Float64Array([1, 2, 3]);
		const b = new Float64Array([4, 5]);
		// only first 2: (3^2 + 3^2) = 18
		expect(native.squaredDistance(a, b)).toBe(18);
	});

	test("empty vectors return 0", () => {
		const a = new Float64Array([]);
		const b = new Float64Array([]);
		expect(native.squaredDistance(a, b)).toBe(0);
	});

	test("parity with TS on random 2D vectors", () => {
		for (let t = 0; t < 100; t++) {
			const a = [Math.random() * 100, Math.random() * 100];
			const b = [Math.random() * 100, Math.random() * 100];
			const rust = native.squaredDistance(new Float64Array(a), new Float64Array(b));
			const ts = tsSquaredDistance(a, b);
			expect(Math.abs(rust - ts)).toBeLessThan(1e-10);
		}
	});
});

// ---------------------------------------------------------------------------
// vectorToBlob / blobToVector round-trip
// ---------------------------------------------------------------------------

describe("vectorToBlob + blobToVector", () => {
	test("round-trip preserves values (f32 precision)", () => {
		const vec = [1.5, 2.5, 3.5, -4.0, 0.0];
		const blob = native.vectorToBlob(vec);
		const back = native.blobToVector(blob);
		expect(back.length).toBe(vec.length);
		for (let i = 0; i < vec.length; i++) {
			expect(back[i]).toBeCloseTo(vec[i], 6);
		}
	});

	test("empty vector round-trips", () => {
		const blob = native.vectorToBlob([]);
		const back = native.blobToVector(blob);
		expect(back.length).toBe(0);
	});

	test("blob format matches TS Float32Array layout", () => {
		const vec = [1.0, 2.0, 3.0];
		const rustBlob = native.vectorToBlob(vec);
		const tsBlob = tsVectorToBlob(vec);
		// Both should produce identical byte sequences
		expect(Buffer.compare(rustBlob, tsBlob)).toBe(0);
	});

	test("blobToVector returns number[] (not Float32Array)", () => {
		const blob = native.vectorToBlob([1.0]);
		const back = native.blobToVector(blob);
		expect(Array.isArray(back)).toBe(true);
	});

	test("round-trip on 768-dim random vector", () => {
		const vec = Array.from({ length: 768 }, () => Math.random() * 2 - 1);
		const blob = native.vectorToBlob(vec);
		const back = native.blobToVector(blob);
		expect(back.length).toBe(768);
		for (let i = 0; i < vec.length; i++) {
			// f64 -> f32 -> f64 loses precision
			expect(Math.abs(vec[i] - back[i])).toBeLessThan(1e-6);
		}
	});
});
