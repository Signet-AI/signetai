export interface NormalizedMemoryContent {
	storageContent: string;
	normalizedContent: string;
	hashBasis: string;
	contentHash: string;
}

export function normalizeContentForStorage(content: string): string;
export function deriveNormalizedContent(storageContent: string): string;
export function normalizeAndHashContent(content: string): NormalizedMemoryContent;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number;
export function squaredDistance(a: Float64Array, b: Float64Array): number;
export function vectorToBlob(vec: number[]): Buffer;
export function blobToVector(buf: Buffer): number[];
// TODO: wire into reranker or bulk search path — currently tested but
// not called from TS. Requires callers to pre-concatenate vectors into
// a flat buffer, which needs a fetch-path change to be worthwhile.
export function batchCosineSimilarity(query: Float32Array, matrix: Buffer, dim: number): number[];

export interface NormalisedAxes {
	xs: number[];
	ys: number[];
	zs: number[] | null;
}

export function normaliseAxes(xs: number[], ys: number[], zs: number[] | null, scale: number): NormalisedAxes;

export function buildKnnEdges(coords: number[][], k: number, exactThreshold: number): number[][];

export interface ScoredId {
	id: string;
	score: number;
	source: string;
}

export function mergeHybridScores(
	vectorIds: string[],
	vectorScores: number[],
	keywordIds: string[],
	keywordScores: number[],
	alpha: number,
	minScore: number,
): ScoredId[];
