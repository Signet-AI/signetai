export interface NormalizedMemoryContent {
	storageContent: string;
	normalizedContent: string;
	hashBasis: string;
	contentHash: string;
}

export function normalizeContentForStorage(content: string): string;
export function deriveNormalizedContent(storageContent: string): string;
export function normalizeAndHashContent(
	content: string,
): NormalizedMemoryContent;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number;
export function squaredDistance(a: Float64Array, b: Float64Array): number;
export function vectorToBlob(vec: number[]): Buffer;
export function blobToVector(buf: Buffer): number[];
