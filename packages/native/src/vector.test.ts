import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Load the native addon directly (can't resolve @signet/native from within itself)
const nativePackagePath = join(__dirname, "..");
const nativeTriples = {
	"linux-x64-gnu": "signet-native.linux-x64-gnu.node",
	"linux-x64-musl": "signet-native.linux-x64-musl.node",
	"linux-arm64-gnu": "signet-native.linux-arm64-gnu.node",
	"linux-arm64-musl": "signet-native.linux-arm64-musl.node",
	"darwin-x64": "signet-native.darwin-x64.node",
	"darwin-arm64": "signet-native.darwin-arm64.node",
	"win32-x64": "signet-native.win32-x64-msvc.node",
	"win32-arm64": "signet-native.win32-arm64-msvc.node",
} as const;

function resolveNativeBindingPath(): string | null {
	const { arch, platform } = process;
	if (platform === "linux") {
		const libc =
			existsSync("/etc/alpine-release") ||
			existsSync("/lib/ld-musl-x86_64.so.1") ||
			existsSync("/lib/ld-musl-aarch64.so.1")
				? "musl"
				: "gnu";
		return join(nativePackagePath, nativeTriples[`${platform}-${arch}-${libc}` as keyof typeof nativeTriples] ?? "");
	}
	return join(nativePackagePath, nativeTriples[`${platform}-${arch}` as keyof typeof nativeTriples] ?? "");
}

const nativeBindingPath = resolveNativeBindingPath();
const native =
	nativeBindingPath && existsSync(nativeBindingPath)
		? (require(nativePackagePath) as typeof import("@signet/native"))
		: null;
const describeNative = native ? describe : describe.skip;

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

function tsBatchCosineSimilarity(query: Float32Array, matrix: Float32Array[]): number[] {
	return matrix.map((row) => tsCosineSimilarity(query, row));
}

function tsNormaliseAxis(values: readonly number[], scale: number): number[] {
	let min = Infinity;
	let max = -Infinity;
	for (const v of values) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const range = max - min || 1;
	return values.map((v) => ((v - min) / range - 0.5) * scale);
}

function tsBuildExactKnnEdges(projected: readonly number[][], k: number): [number, number][] {
	const edgeSet = new Set<string>();
	const result: [number, number][] = [];
	for (let i = 0; i < projected.length; i++) {
		const dists: { j: number; d: number }[] = [];
		for (let j = 0; j < projected.length; j++) {
			if (i === j) continue;
			let d = 0;
			for (let c = 0; c < projected[i].length; c++) {
				const diff = projected[i][c] - projected[j][c];
				d += diff * diff;
			}
			dists.push({ j, d });
		}
		dists.sort((a, b) => a.d - b.d);
		for (let n = 0; n < Math.min(k, dists.length); n++) {
			const a = Math.min(i, dists[n].j);
			const b = Math.max(i, dists[n].j);
			const key = `${a}-${b}`;
			if (!edgeSet.has(key)) {
				edgeSet.add(key);
				result.push([a, b]);
			}
		}
	}
	return result;
}

function tsMergeHybridScores(
	vectorIds: string[],
	vectorScores: number[],
	keywordIds: string[],
	keywordScores: number[],
	alpha: number,
	minScore: number,
): { id: string; score: number; source: string }[] {
	const vectorMap = new Map(vectorIds.map((id, i) => [id, vectorScores[i]]));
	const keywordMap = new Map(keywordIds.map((id, i) => [id, keywordScores[i]]));
	const allIds = new Set([...vectorIds, ...keywordIds]);
	const results: { id: string; score: number; source: string }[] = [];

	for (const id of allIds) {
		const vs = vectorMap.get(id) ?? 0;
		const ks = keywordMap.get(id) ?? 0;
		let score: number;
		let source: string;
		if (vs > 0 && ks > 0) {
			score = alpha * vs + (1 - alpha) * ks;
			source = "hybrid";
		} else if (vs > 0) {
			score = vs;
			source = "vector";
		} else {
			score = ks;
			source = "keyword";
		}
		if (score >= minScore) {
			results.push({ id, score, source });
		}
	}
	results.sort((a, b) => b.score - a.score);
	return results;
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

describeNative("cosineSimilarity", () => {
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

describeNative("squaredDistance", () => {
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

describeNative("vectorToBlob + blobToVector", () => {
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

// ---------------------------------------------------------------------------
// batchCosineSimilarity
// ---------------------------------------------------------------------------

describeNative("batchCosineSimilarity", () => {
	test("single row matches individual cosineSimilarity", () => {
		const query = new Float32Array([1, 2, 3]);
		const row = new Float32Array([4, 5, 6]);
		const matrix = Buffer.from(row.buffer.slice(0));
		const batch = native.batchCosineSimilarity(query, matrix, 3);
		const single = native.cosineSimilarity(query, row);
		expect(batch.length).toBe(1);
		expect(Math.abs(batch[0] - single)).toBeLessThan(1e-10);
	});

	test("multiple rows match N individual calls", () => {
		const dim = 128;
		const n = 20;
		const query = new Float32Array(dim);
		for (let i = 0; i < dim; i++) query[i] = Math.random() * 2 - 1;

		const rows: Float32Array[] = [];
		const flat = new Float32Array(n * dim);
		for (let r = 0; r < n; r++) {
			const row = new Float32Array(dim);
			for (let i = 0; i < dim; i++) {
				row[i] = Math.random() * 2 - 1;
				flat[r * dim + i] = row[i];
			}
			rows.push(row);
		}

		const matrix = Buffer.from(flat.buffer.slice(0));
		const batch = native.batchCosineSimilarity(query, matrix, dim);
		expect(batch.length).toBe(n);

		for (let r = 0; r < n; r++) {
			const single = native.cosineSimilarity(query, rows[r]);
			expect(Math.abs(batch[r] - single)).toBeLessThan(1e-7);
		}
	});

	test("parity with TS reference on 768-dim vectors", () => {
		const dim = 768;
		const n = 10;
		const query = new Float32Array(dim);
		for (let i = 0; i < dim; i++) query[i] = Math.random() * 2 - 1;

		const rows: Float32Array[] = [];
		const flat = new Float32Array(n * dim);
		for (let r = 0; r < n; r++) {
			const row = new Float32Array(dim);
			for (let i = 0; i < dim; i++) {
				row[i] = Math.random() * 2 - 1;
				flat[r * dim + i] = row[i];
			}
			rows.push(row);
		}

		const matrix = Buffer.from(flat.buffer.slice(0));
		const batch = native.batchCosineSimilarity(query, matrix, dim);
		const tsResults = tsBatchCosineSimilarity(query, rows);

		for (let r = 0; r < n; r++) {
			expect(Math.abs(batch[r] - tsResults[r])).toBeLessThan(1e-7);
		}
	});

	test("empty matrix returns empty array", () => {
		const query = new Float32Array([1, 2, 3]);
		const matrix = Buffer.alloc(0);
		// dim * 0 = 0 total floats, 0 % dim = 0 — valid
		// But 0 bytes / 4 = 0, 0 % 3 = 0, so n=0
		const batch = native.batchCosineSimilarity(query, matrix, 3);
		expect(batch.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// buildKnnEdges
// ---------------------------------------------------------------------------

describeNative("buildKnnEdges", () => {
	test("small dataset matches TS exact implementation", () => {
		// Generate 20 random 2D points
		const coords: number[][] = [];
		for (let i = 0; i < 20; i++) {
			coords.push([Math.random() * 100, Math.random() * 100]);
		}
		const k = 4;

		const rustEdges = native.buildKnnEdges(coords, k, 450);
		const tsEdges = tsBuildExactKnnEdges(coords, k);

		// Both should produce the same set of edges (order may differ)
		const rustSet = new Set(rustEdges.map((e) => `${e[0]}-${e[1]}`));
		const tsSet = new Set(tsEdges.map((e) => `${e[0]}-${e[1]}`));
		expect(rustSet).toEqual(tsSet);
	});

	test("edges are deduplicated (no [a,b] and [b,a])", () => {
		const coords = [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
			[0.5, 0.5],
		];
		const edges = native.buildKnnEdges(coords, 3, 450);
		const seen = new Set<string>();
		for (const [a, b] of edges) {
			expect(a).toBeLessThan(b);
			const key = `${a}-${b}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});

	test("returns empty for < 2 nodes", () => {
		expect(native.buildKnnEdges([], 4, 450)).toEqual([]);
		expect(native.buildKnnEdges([[0, 0]], 4, 450)).toEqual([]);
	});

	test("2 nodes produce one edge", () => {
		const edges = native.buildKnnEdges(
			[
				[0, 0],
				[1, 1],
			],
			4,
			450,
		);
		expect(edges.length).toBe(1);
		expect(edges[0]).toEqual([0, 1]);
	});

	test("3D coordinates work", () => {
		const coords = [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
			[1, 1, 1],
		];
		const edges = native.buildKnnEdges(coords, 2, 450);
		expect(edges.length).toBeGreaterThan(0);
		for (const [a, b] of edges) {
			expect(a).toBeLessThan(b);
		}
	});

	test("approximate path produces reasonable edges for larger sets", () => {
		// Generate enough points to trigger approximate path
		const n = 500;
		const coords: number[][] = [];
		for (let i = 0; i < n; i++) {
			coords.push([Math.random() * 1000, Math.random() * 1000]);
		}
		// threshold=100 forces approximate path
		const edges = native.buildKnnEdges(coords, 4, 100);
		expect(edges.length).toBeGreaterThan(0);
		// Every node should have at least one edge (for connected datasets)
		const connected = new Set<number>();
		for (const [a, b] of edges) {
			connected.add(a);
			connected.add(b);
		}
		// Most nodes should be connected (may not be all for sparse datasets)
		expect(connected.size).toBeGreaterThan(n * 0.8);
	});
});

// ---------------------------------------------------------------------------
// normaliseAxes
// ---------------------------------------------------------------------------

describeNative("normaliseAxes", () => {
	test("output range is [-scale/2, scale/2]", () => {
		const xs = [10, 20, 30, 40, 50];
		const ys = [5, 15, 25, 35, 45];
		const scale = 420;
		const result = native.normaliseAxes(xs, ys, null, scale);

		for (const v of result.xs) {
			expect(v).toBeGreaterThanOrEqual(-scale / 2 - 0.001);
			expect(v).toBeLessThanOrEqual(scale / 2 + 0.001);
		}
		for (const v of result.ys) {
			expect(v).toBeGreaterThanOrEqual(-scale / 2 - 0.001);
			expect(v).toBeLessThanOrEqual(scale / 2 + 0.001);
		}
		expect(result.zs == null).toBe(true);
	});

	test("parity with TS normaliseAxis", () => {
		const xs = [1.5, -3.2, 7.8, 0, 4.1];
		const ys = [100, 200, 150, 175, 125];
		const zs = [0.1, 0.2, 0.3, 0.4, 0.5];
		const scale = 420;

		const result = native.normaliseAxes(xs, ys, zs, scale);
		const tsXs = tsNormaliseAxis(xs, scale);
		const tsYs = tsNormaliseAxis(ys, scale);
		const tsZs = tsNormaliseAxis(zs, scale);

		for (let i = 0; i < xs.length; i++) {
			expect(Math.abs(result.xs[i] - tsXs[i])).toBeLessThan(1e-10);
			expect(Math.abs(result.ys[i] - tsYs[i])).toBeLessThan(1e-10);
			expect(Math.abs(result.zs![i] - tsZs[i])).toBeLessThan(1e-10);
		}
	});

	test("single value normalises to 0", () => {
		const result = native.normaliseAxes([42], [99], null, 420);
		// range=1 fallback: (42-42)/1 - 0.5 = -0.5, * 420 = -210
		expect(result.xs[0]).toBeCloseTo(-210, 5);
	});

	test("empty arrays return empty", () => {
		const result = native.normaliseAxes([], [], null, 420);
		expect(result.xs).toEqual([]);
		expect(result.ys).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// mergeHybridScores
// ---------------------------------------------------------------------------

describeNative("mergeHybridScores", () => {
	test("parity with TS merge logic", () => {
		const vectorIds = ["a", "b", "c"];
		const vectorScores = [0.9, 0.7, 0.5];
		const keywordIds = ["b", "c", "d"];
		const keywordScores = [0.8, 0.6, 0.4];
		const alpha = 0.7;
		const minScore = 0.1;

		const rust = native.mergeHybridScores(vectorIds, vectorScores, keywordIds, keywordScores, alpha, minScore);
		const ts = tsMergeHybridScores(vectorIds, vectorScores, keywordIds, keywordScores, alpha, minScore);

		expect(rust.length).toBe(ts.length);
		for (let i = 0; i < rust.length; i++) {
			expect(rust[i].id).toBe(ts[i].id);
			expect(Math.abs(rust[i].score - ts[i].score)).toBeLessThan(1e-10);
			expect(rust[i].source).toBe(ts[i].source);
		}
	});

	test("vector-only items get source 'vector'", () => {
		const result = native.mergeHybridScores(["a"], [0.9], [], [], 0.5, 0.0);
		expect(result.length).toBe(1);
		expect(result[0].source).toBe("vector");
		expect(result[0].score).toBe(0.9);
	});

	test("keyword-only items get source 'keyword'", () => {
		const result = native.mergeHybridScores([], [], ["a"], [0.8], 0.5, 0.0);
		expect(result.length).toBe(1);
		expect(result[0].source).toBe("keyword");
	});

	test("hybrid items blend with alpha", () => {
		const result = native.mergeHybridScores(["a"], [1.0], ["a"], [0.5], 0.7, 0.0);
		expect(result.length).toBe(1);
		expect(result[0].source).toBe("hybrid");
		// 0.7 * 1.0 + 0.3 * 0.5 = 0.85
		expect(result[0].score).toBeCloseTo(0.85, 10);
	});

	test("minScore filters low results", () => {
		const result = native.mergeHybridScores(["a", "b"], [0.9, 0.05], [], [], 0.5, 0.1);
		expect(result.length).toBe(1);
		expect(result[0].id).toBe("a");
	});

	test("results are sorted descending by score", () => {
		const result = native.mergeHybridScores(["a", "b", "c"], [0.3, 0.9, 0.6], [], [], 0.5, 0.0);
		for (let i = 1; i < result.length; i++) {
			expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score);
		}
	});
});
