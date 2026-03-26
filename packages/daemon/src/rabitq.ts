/**
 * RaBitQ — Random Bit Quantization for compressed vector search.
 *
 * Pure TypeScript implementation of the RaBitQ algorithm for approximate
 * nearest neighbour search on high-dimensional embeddings. Compresses
 * 768-dim Float32 vectors into compact packed-bit representations,
 * enabling ~8–16× memory reduction with controllable recall loss.
 *
 * Key components:
 * - Householder QR decomposition for random orthogonal rotation
 * - Beta distribution codebook via inverse CDF (Newton bisection)
 * - Packed uint8 bit indices with per-vector norm + mean metadata
 * - Fast approximate dot-product search via centroid lookup tables
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a single compressed vector. */
export interface CompressedVector {
	/** Original vector ID (memory ID). */
	id: string;
	/** L2 norm of the original vector (pre-rotation). */
	norm: number;
	/** Mean of the rotated vector components. */
	mean: number;
	/** Max absolute deviation from mean (per-vector scale factor for dequantization). */
	maxDev: number;
	/** Packed quantized indices (2 indices per byte for 4-bit). */
	codes: Uint8Array;
}

/** Immutable compressed index holding all quantized vectors and metadata. */
export interface CompressedIndex {
	/** Number of bits per coordinate (e.g. 4 → 16 centroids). */
	bits: number;
	/** Dimensionality of the original vectors. */
	dim: number;
	/** Number of vectors in the index. */
	count: number;
	/** All compressed vectors. */
	vectors: ReadonlyArray<CompressedVector>;
	/** Codebook centroids (2^bits values). */
	codebook: Float32Array;
	/** Row-major rotation matrix (dim × dim). */
	rotationMatrix: Float32Array;
}

/** Search result from compressed search. */
export interface CompressedSearchResult {
	id: string;
	score: number;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (xoshiro128** — deterministic, fast)
// ---------------------------------------------------------------------------

/**
 * xoshiro128** PRNG — deterministic 32-bit generator.
 * Returns a function that produces uniform floats in [0, 1).
 */
function createRng(seed: number): () => number {
	// Splitmix32 to expand seed into 4 × 32-bit state
	function splitmix32(input: number): number {
		const s = (input + 0x9e3779b9) | 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
		t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
		return (t ^ (t >>> 15)) >>> 0;
	}

	let s0 = splitmix32(seed);
	let s1 = splitmix32(s0);
	let s2 = splitmix32(s1);
	let s3 = splitmix32(s2);

	return (): number => {
		const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
		const t = (s1 << 9) >>> 0;

		s2 ^= s0;
		s3 ^= s1;
		s1 ^= s2;
		s0 ^= s3;

		s2 ^= t;
		s3 = rotl(s3, 11) >>> 0;

		return result / 4294967296; // 2^32
	};
}

function rotl(x: number, k: number): number {
	return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Box-Muller transform: generate standard normal variate from uniform RNG.
 */
function gaussianRandom(rng: () => number): number {
	let u: number;

	// Avoid log(0)
	do {
		u = rng();
	} while (u === 0);
	const v = rng();

	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// QR Decomposition (Householder)
// ---------------------------------------------------------------------------

/**
 * Generate a random orthogonal rotation matrix via Householder QR
 * decomposition of a random Gaussian matrix.
 *
 * @param dim - Dimensionality (768 for nomic-embed)
 * @param seed - Optional seed for deterministic generation
 * @returns Row-major Float32Array of size dim×dim
 */
export function generateRotationMatrix(dim: number, seed?: number): Float32Array {
	const rng = createRng(seed ?? Date.now());

	// Generate random Gaussian matrix (dim × dim) — column-major for QR
	const A = new Float64Array(dim * dim);
	for (let i = 0; i < dim * dim; i++) {
		A[i] = gaussianRandom(rng);
	}

	// Householder QR decomposition (in-place on A)
	// After this, A contains Q implicitly via Householder reflectors.
	// We extract Q explicitly.
	const tau = new Float64Array(dim);

	for (let k = 0; k < dim; k++) {
		// Compute the Householder vector for column k
		let normSq = 0;
		for (let i = k; i < dim; i++) {
			const v = A[i * dim + k];
			normSq += v * v;
		}
		const norm = Math.sqrt(normSq);

		if (norm < 1e-14) {
			tau[k] = 0;
			continue;
		}

		const akk = A[k * dim + k];
		const sign = akk >= 0 ? 1 : -1;
		const alpha = -sign * norm;

		// v[k] = A[k,k] - alpha, rest stays
		A[k * dim + k] = akk - alpha;

		// Compute tau
		const vk = A[k * dim + k];
		let vNormSq = vk * vk;
		for (let i = k + 1; i < dim; i++) {
			vNormSq += A[i * dim + k] * A[i * dim + k];
		}
		tau[k] = vNormSq > 0 ? 2.0 / vNormSq : 0;

		// Apply reflector to remaining columns
		for (let j = k + 1; j < dim; j++) {
			let dot = 0;
			for (let i = k; i < dim; i++) {
				dot += A[i * dim + k] * A[i * dim + j];
			}
			dot *= tau[k];
			for (let i = k; i < dim; i++) {
				A[i * dim + j] -= dot * A[i * dim + k];
			}
		}

		// Store alpha on diagonal (R part)
		// But keep v below diagonal for Q reconstruction
		// We'll reconstruct Q separately, so store alpha temporarily
		// Actually, the diagonal of A after Householder is R[k,k] = alpha
		// The sub-diagonal of column k holds the Householder vector
	}

	// Reconstruct Q = H_0 * H_1 * ... * H_{n-1}
	// Start with identity and apply reflectors in reverse
	const Q = new Float64Array(dim * dim);
	// Initialize Q to identity
	for (let i = 0; i < dim; i++) {
		Q[i * dim + i] = 1.0;
	}

	for (let k = dim - 1; k >= 0; k--) {
		if (tau[k] === 0) continue;

		// Apply H_k = I - tau * v * v^T to Q
		for (let j = k; j < dim; j++) {
			let dot = 0;
			for (let i = k; i < dim; i++) {
				dot += A[i * dim + k] * Q[i * dim + j];
			}
			dot *= tau[k];
			for (let i = k; i < dim; i++) {
				Q[i * dim + j] -= dot * A[i * dim + k];
			}
		}
	}

	// Convert to Float32 row-major
	const result = new Float32Array(dim * dim);
	for (let i = 0; i < dim * dim; i++) {
		result[i] = Q[i];
	}

	return result;
}

// ---------------------------------------------------------------------------
// Beta Distribution Inverse CDF
// ---------------------------------------------------------------------------

/**
 * Log-gamma function via Lanczos approximation.
 * Accurate to ~15 significant digits.
 */
function logGamma(zInput: number): number {
	if (zInput < 0.5) {
		// Reflection formula
		return Math.log(Math.PI / Math.sin(Math.PI * zInput)) - logGamma(1 - zInput);
	}

	const z = zInput - 1;
	const g = 7;
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
		12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];

	let x = c[0];
	for (let i = 1; i < g + 2; i++) {
		x += c[i] / (z + i);
	}

	const t = z + g + 0.5;
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularized incomplete beta function I_x(a, b) via continued fraction.
 * Uses Lentz's method for the continued fraction evaluation.
 */
function regularizedBeta(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;

	// Use symmetry relation when x > (a+1)/(a+b+2)
	if (x > (a + 1) / (a + b + 2)) {
		return 1 - regularizedBeta(1 - x, b, a);
	}

	const logPrefix = a * Math.log(x) + b * Math.log(1 - x) - Math.log(a) - logBeta(a, b);
	const prefix = Math.exp(logPrefix);

	// Continued fraction via Lentz's modified method
	const maxIter = 200;
	const eps = 1e-14;
	const tiny = 1e-30;

	let c = 1;
	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < tiny) d = tiny;
	d = 1 / d;
	let h = d;

	for (let m = 1; m <= maxIter; m++) {
		// Even step
		const m2 = 2 * m;
		let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
		d = 1 + num * d;
		if (Math.abs(d) < tiny) d = tiny;
		c = 1 + num / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		h *= d * c;

		// Odd step
		num = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
		d = 1 + num * d;
		if (Math.abs(d) < tiny) d = tiny;
		c = 1 + num / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		const delta = d * c;
		h *= delta;

		if (Math.abs(delta - 1) < eps) break;
	}

	return prefix * h;
}

function logBeta(a: number, b: number): number {
	return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Inverse CDF of the Beta(a, b) distribution via Newton-bisection hybrid.
 *
 * Finds x such that I_x(a, b) = p.
 */
function betaInverseCdf(p: number, a: number, b: number): number {
	if (p <= 0) return 0;
	if (p >= 1) return 1;

	const eps = 1e-10;
	let lo = 0;
	let hi = 1;

	// Initial guess using normal approximation for symmetric beta
	let x = p; // simple initial guess

	// If a === b (symmetric), use simpler initial guess
	if (Math.abs(a - b) < 1e-10) {
		// For symmetric Beta, the median is ~0.5
		x = 0.5 + (p - 0.5) * 0.5; // rough linear
	}

	// Newton-bisection hybrid
	for (let iter = 0; iter < 100; iter++) {
		const cdf = regularizedBeta(x, a, b);
		const err = cdf - p;

		if (Math.abs(err) < eps) break;

		// Beta PDF for Newton step: f(x) = x^(a-1) * (1-x)^(b-1) / B(a,b)
		const logPdf =
			(a - 1) * Math.log(Math.max(x, 1e-300)) + (b - 1) * Math.log(Math.max(1 - x, 1e-300)) - logBeta(a, b);
		const pdf = Math.exp(logPdf);

		if (pdf > 1e-14) {
			// Newton step
			const step = err / pdf;
			const xNew = x - step;

			// Accept Newton step if it stays in bounds, else bisect
			if (xNew > lo && xNew < hi) {
				x = xNew;
			} else {
				x = (lo + hi) / 2;
			}
		} else {
			x = (lo + hi) / 2;
		}

		// Update bracket
		const cdfNew = regularizedBeta(x, a, b);
		if (cdfNew < p) {
			lo = x;
		} else {
			hi = x;
		}
	}

	return x;
}

/**
 * Compute the RaBitQ codebook: 2^bits centroids from the Beta(d/2, d/2)
 * distribution.
 *
 * For dimension d, the marginal distribution of each coordinate of a
 * uniformly-distributed unit vector is approximately Beta(d/2, d/2)
 * shifted to [-1, 1]. We compute quantile centroids to minimize
 * expected quantization error.
 *
 * @param bits - Number of quantization bits (e.g. 4 → 16 centroids)
 * @param dim - Vector dimensionality (768)
 * @returns Float32Array of 2^bits centroid values in [-1, 1]
 */
export function computeCodebook(bits: number, dim: number): Float32Array {
	const numCentroids = 1 << bits; // 2^bits
	const centroids = new Float32Array(numCentroids);
	const a = dim / 2;
	const b = dim / 2;

	for (let i = 0; i < numCentroids; i++) {
		// Midpoint of quantile bin [i/n, (i+1)/n]
		const pMid = (i + 0.5) / numCentroids;
		// Beta CDF gives value in [0, 1]; map to [-1, 1]
		const betaVal = betaInverseCdf(pMid, a, b);
		centroids[i] = 2 * betaVal - 1;
	}

	return centroids;
}

// ---------------------------------------------------------------------------
// Vector Rotation
// ---------------------------------------------------------------------------

/**
 * Rotate a vector by the orthogonal rotation matrix.
 * result = R × vec (matrix-vector product)
 */
function rotateVector(vec: Float32Array, rotation: Float32Array, dim: number): Float32Array {
	const result = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		let sum = 0;
		const rowOffset = i * dim;
		for (let j = 0; j < dim; j++) {
			sum += rotation[rowOffset + j] * vec[j];
		}
		result[i] = sum;
	}
	return result;
}

/**
 * Inverse-rotate a vector: result = R^T × vec (transpose = inverse for orthogonal).
 */
function inverseRotateVector(vec: Float32Array, rotation: Float32Array, dim: number): Float32Array {
	const result = new Float32Array(dim);
	for (let i = 0; i < dim; i++) {
		let sum = 0;
		for (let j = 0; j < dim; j++) {
			sum += rotation[j * dim + i] * vec[j]; // Transposed access
		}
		result[i] = sum;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

/**
 * Find the nearest centroid index for a scalar value.
 * Binary search over sorted codebook.
 */
function findNearestCentroid(value: number, codebook: Float32Array): number {
	let lo = 0;
	let hi = codebook.length - 1;

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		// Check if value is closer to mid or mid+1
		const midVal = codebook[mid];
		const nextVal = codebook[mid + 1];
		const boundary = (midVal + nextVal) / 2;

		if (value <= boundary) {
			hi = mid;
		} else {
			lo = mid + 1;
		}
	}

	return lo;
}

/**
 * Pack two 4-bit indices into a single byte.
 */
function pack4BitPair(high: number, low: number): number {
	return ((high & 0xf) << 4) | (low & 0xf);
}

/**
 * Unpack a byte into two 4-bit indices.
 */
function unpack4BitPair(byte: number): [number, number] {
	return [(byte >>> 4) & 0xf, byte & 0xf];
}

/**
 * Quantize a batch of vectors into a CompressedIndex.
 *
 * Algorithm:
 * 1. Rotate each vector using the orthogonal rotation matrix
 * 2. Compute norm and mean of rotated vector
 * 3. Normalize rotated coordinates to [-1, 1]
 * 4. Find nearest codebook centroid for each coordinate
 * 5. Pack centroid indices into bytes
 *
 * @param vectors - Array of Float32Array vectors (each dim-dimensional)
 * @param ids - Corresponding memory IDs for each vector
 * @param rotationMatrix - Row-major rotation matrix (dim × dim)
 * @param codebook - Centroid values from computeCodebook()
 * @param bits - Quantization bits (default 4)
 * @returns CompressedIndex
 */
export function quantize(
	vectors: ReadonlyArray<Float32Array>,
	ids: ReadonlyArray<string>,
	rotationMatrix: Float32Array,
	codebook: Float32Array,
	bits = 4,
): CompressedIndex {
	if (vectors.length !== ids.length) {
		throw new Error(`Vector count (${vectors.length}) must match ID count (${ids.length})`);
	}
	if (vectors.length === 0) {
		return {
			bits,
			dim: 0,
			count: 0,
			vectors: [],
			codebook,
			rotationMatrix,
		};
	}

	const dim = vectors[0].length;
	const bytesPerVector = bits === 4 ? Math.ceil(dim / 2) : Math.ceil((dim * bits) / 8);
	const compressed: CompressedVector[] = [];

	for (let vi = 0; vi < vectors.length; vi++) {
		const vec = vectors[vi];
		if (vec.length !== dim) {
			throw new Error(`Vector ${vi} has dimension ${vec.length}, expected ${dim}`);
		}

		// 1. Compute original norm
		let normSq = 0;
		for (let i = 0; i < dim; i++) {
			normSq += vec[i] * vec[i];
		}
		const norm = Math.sqrt(normSq);

		// 2. Rotate the vector
		const rotated = rotateVector(vec, rotationMatrix, dim);

		// 3. Compute mean of rotated coordinates
		let meanSum = 0;
		for (let i = 0; i < dim; i++) {
			meanSum += rotated[i];
		}
		const mean = meanSum / dim;

		// 4. Normalize: center and scale to [-1, 1]
		// We subtract the mean and divide by the max absolute deviation
		let maxDev = 0;
		for (let i = 0; i < dim; i++) {
			const dev = Math.abs(rotated[i] - mean);
			if (dev > maxDev) maxDev = dev;
		}
		const scale = maxDev > 0 ? maxDev : 1;

		// 5. Quantize each coordinate and pack
		const codes = new Uint8Array(bytesPerVector);

		if (bits === 4) {
			for (let i = 0; i < dim; i += 2) {
				const val0 = (rotated[i] - mean) / scale;
				const idx0 = findNearestCentroid(val0, codebook);

				let idx1 = 0;
				if (i + 1 < dim) {
					const val1 = (rotated[i + 1] - mean) / scale;
					idx1 = findNearestCentroid(val1, codebook);
				}

				codes[i >>> 1] = pack4BitPair(idx0, idx1);
			}
		} else {
			// Generic bit packing for other bit widths
			let bitPos = 0;
			for (let i = 0; i < dim; i++) {
				const val = (rotated[i] - mean) / scale;
				const idx = findNearestCentroid(val, codebook);
				// Write bits at bitPos
				const byteIdx = bitPos >>> 3;
				const bitOffset = bitPos & 7;
				codes[byteIdx] |= (idx << bitOffset) & 0xff;
				if (bitOffset + bits > 8 && byteIdx + 1 < codes.length) {
					codes[byteIdx + 1] |= (idx >>> (8 - bitOffset)) & 0xff;
				}
				bitPos += bits;
			}
		}

		compressed.push({
			id: ids[vi],
			norm,
			mean,
			maxDev: scale,
			codes,
		});
	}

	return {
		bits,
		dim,
		count: compressed.length,
		vectors: compressed,
		codebook,
		rotationMatrix,
	};
}

/**
 * Dequantize a CompressedIndex back to approximate Float32 vectors.
 *
 * Algorithm:
 * 1. Unpack centroid indices from bytes
 * 2. Look up centroid values from codebook
 * 3. Rescale by maxDev and add mean
 * 4. Inverse-rotate to recover original space
 * 5. Scale by original norm
 *
 * Note: This is lossy — the dequantized vectors approximate the originals.
 *
 * @returns Array of dequantized Float32Array vectors
 */
export function dequantize(index: CompressedIndex): Float32Array[] {
	const { dim, codebook, rotationMatrix, vectors, bits } = index;
	const result: Float32Array[] = [];

	for (const cv of vectors) {
		// 1. Unpack indices and look up centroids
		const rotated = new Float32Array(dim);

		if (bits === 4) {
			for (let i = 0; i < dim; i += 2) {
				const [hi, lo] = unpack4BitPair(cv.codes[i >>> 1]);
				rotated[i] = codebook[hi];
				if (i + 1 < dim) {
					rotated[i + 1] = codebook[lo];
				}
			}
		} else {
			let bitPos = 0;
			const mask = (1 << bits) - 1;
			for (let i = 0; i < dim; i++) {
				const byteIdx = bitPos >>> 3;
				const bitOffset = bitPos & 7;
				let idx = (cv.codes[byteIdx] >>> bitOffset) & mask;
				if (bitOffset + bits > 8 && byteIdx + 1 < cv.codes.length) {
					idx |= (cv.codes[byteIdx + 1] << (8 - bitOffset)) & mask;
				}
				rotated[i] = codebook[idx];
				bitPos += bits;
			}
		}

		// 2. Rescale centroid values from [-1, 1] back to original rotated space.
		// During quantization: normalized[i] = (rotated[i] - mean) / maxDev
		// So: rotated[i] = centroid[idx] * maxDev + mean
		const scale = cv.maxDev;
		for (let i = 0; i < dim; i++) {
			rotated[i] = rotated[i] * scale + cv.mean;
		}

		// 3. Inverse-rotate to original space
		const original = inverseRotateVector(rotated, rotationMatrix, dim);

		// 4. Rescale to match original norm
		let curNormSq = 0;
		for (let i = 0; i < dim; i++) {
			curNormSq += original[i] * original[i];
		}
		const curNorm = Math.sqrt(curNormSq);
		if (curNorm > 1e-12) {
			const rescale = cv.norm / curNorm;
			for (let i = 0; i < dim; i++) {
				original[i] *= rescale;
			}
		}

		result.push(original);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Compressed Vector Search
// ---------------------------------------------------------------------------

/**
 * Fast approximate nearest-neighbour search using compressed vectors.
 *
 * Instead of decompressing all vectors, this computes approximate dot
 * products using centroid lookup tables, avoiding the full inverse
 * rotation per vector.
 *
 * Algorithm:
 * 1. Rotate the query vector
 * 2. Build a lookup table: for each centroid, precompute the dot contribution
 * 3. Scan compressed vectors, summing lookup table entries per packed index
 * 4. Adjust scores by stored norm and mean
 * 5. Return top-K by score (approximate cosine similarity)
 *
 * @param query - Query vector (raw, not rotated)
 * @param index - Compressed index to search
 * @param topK - Number of results to return
 * @returns Sorted array of {id, score} with highest scores first
 */
export function compressedSearch(query: Float32Array, index: CompressedIndex, topK: number): CompressedSearchResult[] {
	if (index.count === 0 || topK <= 0) return [];

	const { dim, codebook, rotationMatrix, vectors, bits } = index;
	if (query.length !== dim) {
		throw new Error(`Query dimension (${query.length}) must match index dimension (${dim})`);
	}

	// 1. Compute query norm
	let queryNormSq = 0;
	for (let i = 0; i < dim; i++) {
		queryNormSq += query[i] * query[i];
	}
	const queryNorm = Math.sqrt(queryNormSq);
	if (queryNorm < 1e-12) return [];

	// 2. Rotate query
	const rotatedQuery = rotateVector(query, rotationMatrix, dim);

	// 3. Build per-dimension lookup tables
	// For each dimension i, and each centroid c:
	//   LUT[i][c] = rotatedQuery[i] * codebook[c]
	// But we can reorganize: for each centroid c, the contribution when
	// a vector has centroid c at dimension i is rotatedQuery[i] * codebook[c].
	//
	// For efficiency, precompute for each pair of centroid indices
	// (since 4-bit packing stores 2 per byte).
	const numCentroids = 1 << bits;

	// Per-dimension centroid contribution tables
	// lut[i * numCentroids + c] = rotatedQuery[i] * codebook[c]
	// But this is dim × numCentroids which for 768 × 16 = 12K floats — fine.
	const lut = new Float32Array(dim * numCentroids);
	for (let i = 0; i < dim; i++) {
		const qr = rotatedQuery[i];
		const offset = i * numCentroids;
		for (let c = 0; c < numCentroids; c++) {
			lut[offset + c] = qr * codebook[c];
		}
	}

	// 4. Score each compressed vector
	const scores: Array<{ idx: number; score: number }> = [];

	for (let vi = 0; vi < vectors.length; vi++) {
		const cv = vectors[vi];

		// Accumulate approximate dot product from lookup tables
		let dotApprox = 0;

		if (bits === 4) {
			// Fast path: 4-bit packed, 2 indices per byte
			for (let i = 0; i < dim; i += 2) {
				const byte = cv.codes[i >>> 1];
				const hi = (byte >>> 4) & 0xf;
				const lo = byte & 0xf;

				dotApprox += lut[i * numCentroids + hi];
				if (i + 1 < dim) {
					dotApprox += lut[(i + 1) * numCentroids + lo];
				}
			}
		} else {
			let bitPos = 0;
			const mask = (1 << bits) - 1;
			for (let i = 0; i < dim; i++) {
				const byteIdx = bitPos >>> 3;
				const bitOffset = bitPos & 7;
				let idx = (cv.codes[byteIdx] >>> bitOffset) & mask;
				if (bitOffset + bits > 8 && byteIdx + 1 < cv.codes.length) {
					idx |= (cv.codes[byteIdx + 1] << (8 - bitOffset)) & mask;
				}
				dotApprox += lut[i * numCentroids + idx];
				bitPos += bits;
			}
		}

		// The centroid values represent (rotated[i] - mean) / maxDev,
		// and we want dot(query, original_vector) ≈ dot(R*query, R*vec)
		// = dot(rotatedQuery, rotated).
		//
		// rotated[i] ≈ codebook[idx] * maxDev + mean
		// dot ≈ sum_i rotatedQuery[i] * (codebook[idx_i] * maxDev + mean)
		//      = maxDev * sum_i rotatedQuery[i] * codebook[idx_i] + mean * sum_i rotatedQuery[i]
		const scale = cv.maxDev;
		let queryRotatedSum = 0;
		for (let i = 0; i < dim; i++) {
			queryRotatedSum += rotatedQuery[i];
		}

		const approxDot = scale * dotApprox + cv.mean * queryRotatedSum;

		// Approximate cosine similarity = dot / (|q| * |v|)
		const cosine = approxDot / (queryNorm * cv.norm);

		scores.push({ idx: vi, score: cosine });
	}

	// 5. Partial sort for top-K (selection via partitioned sort)
	scores.sort((a, b) => b.score - a.score);

	const k = Math.min(topK, scores.length);
	const results: CompressedSearchResult[] = [];
	for (let i = 0; i < k; i++) {
		const s = scores[i];
		results.push({
			id: vectors[s.idx].id,
			score: s.score,
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// Utility: brute-force cosine search (for recall evaluation)
// ---------------------------------------------------------------------------

/**
 * Brute-force cosine similarity search (ground truth baseline).
 *
 * @param query - Query vector
 * @param vectors - Database vectors
 * @param ids - Corresponding IDs
 * @param topK - Number of results
 * @returns Sorted results by cosine similarity (highest first)
 */
export function bruteForceSearch(
	query: Float32Array,
	vectors: ReadonlyArray<Float32Array>,
	ids: ReadonlyArray<string>,
	topK: number,
): CompressedSearchResult[] {
	let queryNormSq = 0;
	for (let i = 0; i < query.length; i++) {
		queryNormSq += query[i] * query[i];
	}
	const queryNorm = Math.sqrt(queryNormSq);

	const scores: CompressedSearchResult[] = [];

	for (let vi = 0; vi < vectors.length; vi++) {
		const vec = vectors[vi];
		let dot = 0;
		let vecNormSq = 0;
		const len = Math.min(query.length, vec.length);
		for (let i = 0; i < len; i++) {
			dot += query[i] * vec[i];
			vecNormSq += vec[i] * vec[i];
		}
		const vecNorm = Math.sqrt(vecNormSq);
		const cosine = queryNorm > 0 && vecNorm > 0 ? dot / (queryNorm * vecNorm) : 0;
		scores.push({ id: ids[vi], score: cosine });
	}

	scores.sort((a, b) => b.score - a.score);
	return scores.slice(0, topK);
}
