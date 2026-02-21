import { createHash } from "node:crypto";

export interface NormalizedMemoryContent {
	readonly storageContent: string;
	readonly normalizedContent: string;
	readonly hashBasis: string;
	readonly contentHash: string;
}

const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

export function normalizeContentForStorage(content: string): string {
	return content.trim().replace(/\s+/g, " ");
}

export function deriveNormalizedContent(storageContent: string): string {
	const lowered = storageContent.toLowerCase();
	return lowered.replace(TRAILING_PUNCTUATION, "").trim();
}

export function normalizeAndHashContent(
	content: string,
): NormalizedMemoryContent {
	const storageContent = normalizeContentForStorage(content);
	const normalizedContent = deriveNormalizedContent(storageContent);
	const hashBasis =
		normalizedContent.length > 0
			? normalizedContent
			: storageContent.toLowerCase();
	const contentHash = createHash("sha256").update(hashBasis).digest("hex");
	return { storageContent, normalizedContent, hashBasis, contentHash };
}
