import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
	countTokens,
	estimateTokens,
	resetTokenizerStats,
	resolveTokenizerWasmPath,
	tokenizerStats,
	tokenizerWasmPath,
	truncateToTokens,
} from "./pipeline/tokenizer";

describe("tokenizer", () => {
	it("resolves the WASM file used by the Bun loader", () => {
		expect(existsSync(tokenizerWasmPath)).toBe(true);
	});

	it("estimates tokens from characters without encoding", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("hello world")).toBe(Math.ceil("hello world".length / 4));
	});

	it("estimates never exceed the exact BPE count for plain prose", () => {
		const text = "the quick brown fox jumps over the lazy dog and keeps running";
		expect(countTokens(text)).toBeLessThanOrEqual(estimateTokens(text));
	});

	it("tracks encode calls so hot paths can be audited", () => {
		resetTokenizerStats();
		countTokens("some text");
		expect(tokenizerStats.encodeCalls).toBe(1);
		expect(tokenizerStats.encodeChars).toBe("some text".length);
	});

	it("preserves valid UTF-8 while truncating at exact token boundaries", () => {
		const truncated = truncateToTokens("Résumé 東京 🚀 carries multilingual evidence", 7);

		expect(countTokens(truncated)).toBeLessThanOrEqual(7);
		expect(truncated).not.toContain("\uFFFD");
		expect(truncateToTokens("🚀x", 1)).toBe("");
	});
});

describe("resolveTokenizerWasmPath", () => {
	it("resolves Bun file-loader relative paths against the importing module", () => {
		const emitted = "./tokenizer-fixture.wasm";
		const tokenizerModuleUrl = new URL("./pipeline/tokenizer.ts", import.meta.url);
		expect(resolveTokenizerWasmPath(emitted)).toBe(fileURLToPath(new URL(emitted, tokenizerModuleUrl)));
	});

	it("keeps Windows drive-letter paths emitted by the Bun loader verbatim", () => {
		const emitted = "D:\\a\\signetai\\signetai\\node_modules\\tiktoken\\tiktoken_bg.wasm";
		expect(resolveTokenizerWasmPath(emitted)).toBe(emitted);
	});

	it("keeps Windows drive-letter paths with forward slashes verbatim", () => {
		const emitted = "D:/a/signetai/signetai/node_modules/tiktoken/tiktoken_bg.wasm";
		expect(resolveTokenizerWasmPath(emitted)).toBe(emitted);
	});

	it("keeps Windows UNC paths emitted by the Bun loader verbatim", () => {
		const emitted = "\\\\runner\\node-modules\\tiktoken_bg.wasm";
		expect(resolveTokenizerWasmPath(emitted)).toBe(emitted);
	});

	it("converts file URLs emitted by the Bun loader to platform paths", () => {
		const emitted = "file:///opt/assets/tiktoken_bg.wasm";
		expect(resolveTokenizerWasmPath(emitted)).toBe(fileURLToPath(new URL(emitted)));
	});
});
