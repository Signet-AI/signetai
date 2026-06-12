import { extractAnchorTerms } from "./anchor-terms";

const UNTRUSTED_METADATA_HEADER =
	/conversation info \(untrusted metadata\)\s*:|sender \(untrusted[^)]*\)\s*:|chat history since last reply\s*:|<<<EXTERNAL_UNTRUSTED_CONTENT|END_EXTERNAL_UNTRUSTED_CONTENT|untrusted context\s*:/i;

function findJsonObjectEnd(text: string, startIndex: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = startIndex; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			depth++;
			continue;
		}

		if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}

	return -1;
}

export function stripUntrustedMetadata(text: string): string {
	let remaining = text;

	while (true) {
		const match = UNTRUSTED_METADATA_HEADER.exec(remaining);
		if (!match || match.index === undefined) break;

		const blockStart = match.index;
		let blockEnd = blockStart + match[0].length;

		while (blockEnd < remaining.length && /\s/.test(remaining[blockEnd])) {
			blockEnd++;
		}

		if (remaining[blockEnd] === "{") {
			const jsonEnd = findJsonObjectEnd(remaining, blockEnd);
			if (jsonEnd > blockEnd) {
				blockEnd = jsonEnd + 1;
			}
		}

		const before = remaining.slice(0, blockStart).trimEnd();
		const after = remaining.slice(blockEnd).trimStart();
		remaining = [before, after].filter((part) => part.length > 0).join("\n\n");
	}

	return remaining.trim();
}

const RECALL_STOPWORDS = new Set([
	"a",
	"about",
	"actually",
	"after",
	"all",
	"also",
	"am",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"been",
	"before",
	"but",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"doing",
	"done",
	"for",
	"from",
	"get",
	"go",
	"had",
	"has",
	"have",
	"hey",
	"hi",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"just",
	"kind",
	"like",
	"make",
	"me",
	"more",
	"my",
	"need",
	"now",
	"of",
	"ok",
	"okay",
	"on",
	"or",
	"our",
	"out",
	"please",
	"pretty",
	"really",
	"right",
	"say",
	"should",
	"so",
	"some",
	"something",
	"still",
	"sure",
	"thanks",
	"thank",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"too",
	"uh",
	"um",
	"use",
	"very",
	"want",
	"was",
	"we",
	"well",
	"were",
	"what",
	"when",
	"which",
	"who",
	"why",
	"will",
	"with",
	"would",
	"yeah",
	"yes",
	"you",
	"your",
]);

export interface RecallQueryShape {
	readonly keywordTerms: string[];
	readonly vectorQuery: string;
}

export function extractSubstantiveWords(text: string): string[] {
	const cleaned = stripUntrustedMetadata(text).replace(/<@!?\d+>/g, ""); // strip Discord mention tags

	// Preserve hyphenated identifiers (e.g., "KA-6", "pre-compaction")
	const hyphenated = (cleaned.match(/[a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*/g) || []).map((t) =>
		t.toLowerCase(),
	);

	// Standard word extraction
	const words = cleaned
		.toLowerCase()
		.split(/\W+/)
		.filter((word) => word.length >= 3 && !RECALL_STOPWORDS.has(word) && !/^\d+$/.test(word));

	// Deduplicate: hyphenated first (more specific), then words
	const seen = new Set<string>();
	const result: string[] = [];
	for (const term of [...hyphenated, ...words]) {
		if (!seen.has(term)) {
			seen.add(term);
			result.push(term);
		}
	}
	return result;
}

export function countPromptTermOverlap(text: string, promptTerms: ReadonlyArray<string>): number {
	if (promptTerms.length === 0) return 0;
	const hay = new Set(extractSubstantiveWords(text));
	let overlap = 0;
	for (const term of promptTerms) {
		if (hay.has(term)) overlap++;
	}
	return overlap;
}

export function queryAnchorsMissingFromRecall(query: string, results: ReadonlyArray<{ content: string }>): boolean {
	const anchors = extractAnchorTerms(stripUntrustedMetadata(query));
	if (anchors.length === 0) return false;
	if (results.length === 0) return false;
	const anchorSet = new Set(anchors);
	for (const row of results.slice(0, 8)) {
		const rowAnchors = extractAnchorTerms(row.content);
		for (const rowAnchor of rowAnchors) {
			if (anchorSet.has(rowAnchor)) {
				return false;
			}
		}
	}
	return true;
}

export function buildRecallQueryShape(userPrompt: string): RecallQueryShape {
	// Pass cleaned raw text for both keyword and vector queries.
	// FTS5 with implicit AND + BM25 IDF handles term weighting naturally —
	// manual stopword stripping destroyed phrase semantics and let
	// individual OR'd terms match unrelated content.
	const vectorQuery = stripUntrustedMetadata(userPrompt).trim().slice(0, 200);

	// extractSubstantiveWords still used for display/telemetry only.
	const keywordTerms = extractSubstantiveWords(userPrompt);

	return { keywordTerms, vectorQuery };
}
