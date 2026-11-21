import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export interface NormalizedMemoryContent {
	readonly storageContent: string;
	readonly normalizedContent: string;
	readonly hashBasis: string;
	readonly contentHash: string;
}
let native: typeof import("@signet/native") | null = null;
try {
	const esmRequire = createRequire(import.meta.url);
	native = esmRequire("@signet/native");
} catch {}

const TRAILING_PUNCTUATION = /[.,!?;:]+$/;
const CRLF = /\r\n?/g;
const COLLAPSE_WHITESPACE = /\s+/g;

function tsNormalizeContentForStorage(content: string): string {
	return content.replace(CRLF, "\n").trim();
}

function tsDeriveNormalizedContent(storageContent: string): string {
	const lowered = storageContent.toLowerCase();
	return lowered.replace(COLLAPSE_WHITESPACE, " ").replace(TRAILING_PUNCTUATION, "").trim();
}

function tsNormalizeAndHashContent(content: string): NormalizedMemoryContent {
	const storageContent = tsNormalizeContentForStorage(content);
	const normalizedContent = tsDeriveNormalizedContent(storageContent);
	const hashBasis = normalizedContent.length > 0 ? normalizedContent : storageContent.toLowerCase();
	const contentHash = createHash("sha256").update(hashBasis).digest("hex");
	return { storageContent, normalizedContent, hashBasis, contentHash };
}

export const normalizeContentForStorage: (content: string) => string =
	native !== null ? native.normalizeContentForStorage : tsNormalizeContentForStorage;

export const deriveNormalizedContent: (storageContent: string) => string =
	native !== null ? native.deriveNormalizedContent : tsDeriveNormalizedContent;

export const normalizeAndHashContent: (content: string) => NormalizedMemoryContent =
	native !== null ? native.normalizeAndHashContent : tsNormalizeAndHashContent;
