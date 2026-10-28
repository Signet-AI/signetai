import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nativePackagePath = join(__dirname, "..");
let native: typeof import("@signet/native") | null = null;
try {
	native = require(nativePackagePath) as typeof import("@signet/native");
} catch {}
const describeNative = native && typeof native.PairTokenizer === "function" ? describe : describe.skip;

const special = (id: number, content: string) => ({
	id,
	content,
	single_word: false,
	lstrip: false,
	rstrip: false,
	normalized: false,
	special: true,
});
const tokenizerJson = {
	version: "1.0",
	truncation: null,
	padding: {
		strategy: "BatchLongest",
		direction: "Right",
		pad_to_multiple_of: null,
		pad_id: 3,
		pad_type_id: 0,
		pad_token: "[PAD]",
	},
	added_tokens: [special(0, "[UNK]"), special(1, "[CLS]"), special(2, "[SEP]"), special(3, "[PAD]")],
	normalizer: null,
	pre_tokenizer: { type: "WhitespaceSplit" },
	post_processor: {
		type: "TemplateProcessing",
		single: [
			{ SpecialToken: { id: "[CLS]", type_id: 0 } },
			{ Sequence: { id: "A", type_id: 0 } },
			{ SpecialToken: { id: "[SEP]", type_id: 0 } },
		],
		pair: [
			{ SpecialToken: { id: "[CLS]", type_id: 0 } },
			{ Sequence: { id: "A", type_id: 0 } },
			{ SpecialToken: { id: "[SEP]", type_id: 0 } },
			{ Sequence: { id: "B", type_id: 1 } },
			{ SpecialToken: { id: "[SEP]", type_id: 1 } },
		],
		special_tokens: {
			"[CLS]": { id: "[CLS]", ids: [1], tokens: ["[CLS]"] },
			"[SEP]": { id: "[SEP]", ids: [2], tokens: ["[SEP]"] },
		},
	},
	decoder: null,
	model: {
		type: "Unigram",
		unk_id: 0,
		vocab: [
			["[UNK]", 0],
			["[CLS]", 0],
			["[SEP]", 0],
			["[PAD]", 0],
			["alpha", -1],
			["beta", -1],
			["gamma", -1],
		],
		byte_fallback: false,
	},
};

const dir = mkdtempSync(join(tmpdir(), "signet-native-tokenizer-"));
const tokenizerPath = join(dir, "tokenizer.json");
writeFileSync(tokenizerPath, JSON.stringify(tokenizerJson));
afterAll(() => {
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describeNative("PairTokenizer", () => {
	test("returns padded query-document pair tensors as plain arrays", () => {
		const tokenizer = new (native as typeof import("@signet/native")).PairTokenizer(tokenizerPath, 512);
		const batch = tokenizer.encodePairs("alpha", ["beta gamma", "gamma"]);
		expect(batch.batchSize).toBe(2);
		expect(batch.sequenceLength).toBe(6);
		expect(batch.inputIds).toEqual([1, 4, 2, 5, 6, 2, 1, 4, 2, 6, 2, 3]);
		expect(batch.attentionMask).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
		expect(batch.tokenTypeIds).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0]);
		expect(tokenizer.encodePairs("gamma", ["gamma"]).cachedDocuments).toBe(1);
	});

	test("rejects a missing tokenizer file", () => {
		expect(() => new (native as typeof import("@signet/native")).PairTokenizer(join(dir, "missing.json"), 512)).toThrow(
			/tokenizer/,
		);
	});
});
