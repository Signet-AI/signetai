/**
 * Shared BPE tokenizer utilities.
 *
 * Uses cl100k_base (GPT-4 / Claude vocabulary), which is a close enough
 * approximation for all major hosted LLM APIs and far more accurate than
 * the length/4 character heuristic.
 *
 * The Tiktoken instance is initialised on first use and shared across all
 * callers (dreaming, summary-worker, memory-head). The cl100k vocabulary is
 * several megabytes on disk and substantially larger once parsed, so loading
 * it during module evaluation would dominate an otherwise idle edge daemon.
 */

import { createRequire } from "node:module";
import { Tiktoken } from "js-tiktoken/lite";

const require = createRequire(import.meta.url);
let tokenizer: Tiktoken | null = null;

function getTokenizer(): Tiktoken {
	if (tokenizer) return tokenizer;
	const rankModule = require("js-tiktoken/ranks/cl100k_base") as {
		readonly default?: ConstructorParameters<typeof Tiktoken>[0];
	};
	const ranks = rankModule.default ?? (rankModule as unknown as ConstructorParameters<typeof Tiktoken>[0]);
	tokenizer = new Tiktoken(ranks);
	return tokenizer;
}

/** Count the BPE tokens in `text`. */
export function countTokens(text: string): number {
	return getTokenizer().encode(text).length;
}

/**
 * Truncate `text` to at most `limit` tokens, preserving token boundaries
 * so the result is always valid UTF-8.  Returns an empty string when
 * `limit < 1`.
 */
export function truncateToTokens(text: string, limit: number): string {
	if (limit < 1) return "";
	const tok = getTokenizer();
	const tokens = tok.encode(text);
	if (tokens.length <= limit) return text;
	return tok.decode(tokens.slice(0, limit)).trimEnd();
}
