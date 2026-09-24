import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get_encoding, init } from "tiktoken/init";

const tokenizerWasmOverride = process.env.SIGNET_TIKTOKEN_WASM_PATH?.trim();
const allowMissingTokenizer = process.env.SIGNET_MCP_STDIO === "1";
const bundledTokenizerWasmPath = join(dirname(fileURLToPath(import.meta.url)), "tiktoken_bg.wasm");
let tokenizerWasmPath = "";
let tok: ReturnType<typeof get_encoding> | null = null;
if (tokenizerWasmOverride) {
	tokenizerWasmPath = tokenizerWasmOverride;
} else if (existsSync(bundledTokenizerWasmPath)) {
	tokenizerWasmPath = bundledTokenizerWasmPath;
} else {
	try {
		tokenizerWasmPath = createRequire(import.meta.url).resolve("tiktoken/tiktoken_bg.wasm");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code !== "MODULE_NOT_FOUND") throw error;
	}
}
if (tokenizerWasmPath) {
	await init(async (imports) => WebAssembly.instantiate(await readFile(tokenizerWasmPath), imports));
	tok = get_encoding("cl100k_base");
} else {
	if (!allowMissingTokenizer) throw new Error("Exact tokenization is unavailable: tiktoken WASM is not installed");
	// The MCP stdio adapter can answer its protocol handshake without the
	// optional tokenizer asset. Operations that require exact tokenization
	// fail explicitly through requireTokenizer() below.
	tokenizerWasmPath = "";
}
const decoder = new TextDecoder("utf-8", { fatal: true });

function requireTokenizer(): NonNullable<typeof tok> {
	if (!tok) throw new Error("Exact tokenization is unavailable: tiktoken WASM is not installed");
	return tok;
}

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
	return requireTokenizer().encode(text).length;
}
export function truncateToTokens(text: string, limit: number): string {
	if (limit < 1) return "";
	const tokenizer = requireTokenizer();
	const tokens = tokenizer.encode(text);
	if (tokens.length <= limit) return text;
	let tokenCount = Math.min(limit, tokens.length);
	while (tokenCount > 0) {
		try {
			return decoder.decode(tokenizer.decode(tokens.slice(0, tokenCount))).trimEnd();
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			tokenCount -= 1;
		}
	}
	return "";
}
