/**
 * Shared BPE tokenizer utilities.
 *
 * Uses cl100k_base (GPT-4 / Claude vocabulary), which is a close enough
 * approximation for all major hosted LLM APIs and far more accurate than
 * the length/4 character heuristic.
 *
 * The Tiktoken instance is initialised once at module load and shared across
 * all callers (dreaming, memory-head) so we only pay the
 * vocabulary-load cost once per daemon process.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { get_encoding, init } from "tiktoken/init";

const tokenizerWasmOverride = process.env.SIGNET_TIKTOKEN_WASM_PATH?.trim();
const tokenizerWasmPath = tokenizerWasmOverride || createRequire(import.meta.url).resolve("tiktoken/tiktoken_bg.wasm");
await init(async (imports) => WebAssembly.instantiate(await readFile(tokenizerWasmPath), imports));
const tok = get_encoding("cl100k_base");
const decoder = new TextDecoder("utf-8", { fatal: true });

export { tokenizerWasmPath };

/**
 * Cheap character-based token estimate (~4 chars per token) for budget
 * decisions where an exact BPE count is unnecessary. Never performs an
 * encode, so it is safe on the daemon's main thread; keep `countTokens`
 * for decisions that must land inside a hard token budget.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Tokenizer encode accounting. Each full BPE encode is an O(n) pass that
 * blocks the calling thread, so hot paths (session-start inject builds)
 * must keep `encodeCalls` bounded per request. Tests reset these counters
 * to assert hot paths do not re-encode large context sections.
 */
export const tokenizerStats = {
	encodeCalls: 0,
	encodeChars: 0,
};

export function resetTokenizerStats(): void {
	tokenizerStats.encodeCalls = 0;
	tokenizerStats.encodeChars = 0;
}

/** Count the BPE tokens in `text`. */
export function countTokens(text: string): number {
	tokenizerStats.encodeCalls += 1;
	tokenizerStats.encodeChars += text.length;
	return tok.encode(text).length;
}

/**
 * Truncate `text` to at most `limit` tokens, preserving token boundaries
 * so the result is always valid UTF-8.  Returns an empty string when
 * `limit < 1`.
 */
export function truncateToTokens(text: string, limit: number): string {
	if (limit < 1) return "";
	const tokens = tok.encode(text);
	if (tokens.length <= limit) return text;
	let tokenCount = Math.min(limit, tokens.length);
	while (tokenCount > 0) {
		try {
			return decoder.decode(tok.decode(tokens.slice(0, tokenCount))).trimEnd();
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			tokenCount -= 1;
		}
	}
	return "";
}
