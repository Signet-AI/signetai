import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { get_encoding, init } from "tiktoken/init";
import * as tokenizerWasmModule from "tiktoken/tiktoken_bg.wasm";

const tokenizerWasmOverride = process.env.SIGNET_TIKTOKEN_WASM_PATH?.trim();
const tokenizerWasmPathExport: unknown = Reflect.get(tokenizerWasmModule, "default");
if (typeof tokenizerWasmPathExport !== "string") {
	throw new TypeError("Bun did not expose the tokenizer WASM path");
}
const tokenizerWasmFile = tokenizerWasmPathExport;
const tokenizerWasmPath = tokenizerWasmOverride || fileURLToPath(new URL(tokenizerWasmFile, import.meta.url));
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
