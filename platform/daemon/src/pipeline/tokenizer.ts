import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { get_encoding, init } from "tiktoken/init";

const tokenizerWasmOverride = process.env.SIGNET_TIKTOKEN_WASM_PATH?.trim();
const tokenizerWasmPath = tokenizerWasmOverride || createRequire(import.meta.url).resolve("tiktoken/tiktoken_bg.wasm");
await init(async (imports) => WebAssembly.instantiate(await readFile(tokenizerWasmPath), imports));
const tok = get_encoding("cl100k_base");
const decoder = new TextDecoder("utf-8", { fatal: true });

export { tokenizerWasmPath };
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
export const tokenizerStats = {
	encodeCalls: 0,
	encodeChars: 0,
};

export function resetTokenizerStats(): void {
	tokenizerStats.encodeCalls = 0;
	tokenizerStats.encodeChars = 0;
}
export function countTokens(text: string): number {
	tokenizerStats.encodeCalls += 1;
	tokenizerStats.encodeChars += text.length;
	return tok.encode(text).length;
}
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
