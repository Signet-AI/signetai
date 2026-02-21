/**
 * Tests for the extraction pipeline module.
 */

import { describe, it, expect } from "bun:test";
import { extractFactsAndEntities } from "./extraction";
import type { LlmProvider } from "./provider";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function mockProvider(responses: string[]): LlmProvider {
	let i = 0;
	return {
		name: "mock",
		async generate() {
			return responses[i++] ?? "";
		},
		async available() {
			return true;
		},
	};
}

const VALID_RESPONSE = JSON.stringify({
	facts: [
		{ content: "User prefers dark mode", type: "preference", confidence: 0.9 },
		{
			content: "User uses vim keybindings in VS Code",
			type: "preference",
			confidence: 0.85,
		},
	],
	entities: [
		{
			source: "User",
			relationship: "prefers",
			target: "dark mode",
			confidence: 0.9,
		},
	],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractFactsAndEntities", () => {
	it("parses valid JSON response correctly", async () => {
		const provider = mockProvider([VALID_RESPONSE]);
		const result = await extractFactsAndEntities(
			"User prefers dark mode and uses vim keybindings",
			provider,
		);

		expect(result.facts).toHaveLength(2);
		expect(result.facts[0].content).toBe("User prefers dark mode");
		expect(result.facts[0].type).toBe("preference");
		expect(result.facts[0].confidence).toBe(0.9);
		expect(result.entities).toHaveLength(1);
		expect(result.entities[0].source).toBe("User");
		expect(result.entities[0].relationship).toBe("prefers");
		expect(result.entities[0].target).toBe("dark mode");
		expect(result.warnings).toHaveLength(0);
	});

	it("parses markdown-fenced JSON correctly", async () => {
		const fenced = "```json\n" + VALID_RESPONSE + "\n```";
		const provider = mockProvider([fenced]);
		const result = await extractFactsAndEntities(
			"User prefers dark mode and uses vim keybindings",
			provider,
		);

		expect(result.facts).toHaveLength(2);
		expect(result.entities).toHaveLength(1);
		expect(result.warnings).toHaveLength(0);
	});

	it("also handles unmarked code fences", async () => {
		const fenced = "```\n" + VALID_RESPONSE + "\n```";
		const provider = mockProvider([fenced]);
		const result = await extractFactsAndEntities(
			"User prefers dark mode and uses vim keybindings",
			provider,
		);

		expect(result.facts).toHaveLength(2);
	});

	it("truncates over-limit facts to 20", async () => {
		// Generate 25 valid facts
		const manyFacts = Array.from({ length: 25 }, (_, i) => ({
			content: `Fact number ${i + 1} that is long enough to pass validation`,
			type: "fact",
			confidence: 0.8,
		}));
		const response = JSON.stringify({ facts: manyFacts, entities: [] });
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some long enough input text for extraction",
			provider,
		);

		expect(result.facts).toHaveLength(20);
		expect(result.warnings.some((w) => w.includes("Truncated facts"))).toBe(
			true,
		);
	});

	it("rejects trivial facts (< 10 chars) with a warning", async () => {
		const response = JSON.stringify({
			facts: [
				{ content: "short", type: "fact", confidence: 0.9 },
				{
					content: "This one is long enough to pass",
					type: "fact",
					confidence: 0.8,
				},
			],
			entities: [],
		});
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough",
			provider,
		);

		// Only the long fact should survive
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0].content).toBe("This one is long enough to pass");
		expect(result.warnings.some((w) => w.includes("too short"))).toBe(true);
	});

	it("defaults invalid types to 'fact' with a warning", async () => {
		const response = JSON.stringify({
			facts: [
				{
					content: "Some fact that is definitely long enough",
					type: "bogustype",
					confidence: 0.7,
				},
			],
			entities: [],
		});
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough",
			provider,
		);

		expect(result.facts).toHaveLength(1);
		expect(result.facts[0].type).toBe("fact");
		expect(
			result.warnings.some(
				(w) => w.includes("Invalid type") && w.includes("bogustype"),
			),
		).toBe(true);
	});

	it("returns empty with warning on total parse failure", async () => {
		const provider = mockProvider(["this is not valid json at all"]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough to process",
			provider,
		);

		expect(result.facts).toHaveLength(0);
		expect(result.entities).toHaveLength(0);
		expect(
			result.warnings.some((w) => w.toLowerCase().includes("failed to parse")),
		).toBe(true);
	});

	it("clamps confidence to [0, 1]", async () => {
		const response = JSON.stringify({
			facts: [
				{
					content: "Fact with confidence above one point zero",
					type: "fact",
					confidence: 1.5,
				},
				{
					content: "Fact with negative confidence value here",
					type: "fact",
					confidence: -0.3,
				},
			],
			entities: [
				{
					source: "User",
					relationship: "uses",
					target: "vim",
					confidence: 2.0,
				},
			],
		});
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough to process",
			provider,
		);

		expect(result.facts[0].confidence).toBe(1);
		expect(result.facts[1].confidence).toBe(0);
		expect(result.entities[0].confidence).toBe(1);
	});

	it("returns early with warning when input is too short", async () => {
		const provider = mockProvider(["anything"]);
		// Less than 20 chars
		const result = await extractFactsAndEntities("short", provider);

		expect(result.facts).toHaveLength(0);
		expect(result.entities).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("too short"))).toBe(true);
	});

	it("returns early with warning when input is empty", async () => {
		const provider = mockProvider([]);
		const result = await extractFactsAndEntities("", provider);

		expect(result.facts).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("too short"))).toBe(true);
	});

	it("rejects entities with missing source or target", async () => {
		const response = JSON.stringify({
			facts: [],
			entities: [
				// missing source
				{
					source: "",
					relationship: "uses",
					target: "vim",
					confidence: 0.8,
				},
				// missing target
				{
					source: "User",
					relationship: "prefers",
					target: "",
					confidence: 0.8,
				},
				// valid entity
				{
					source: "User",
					relationship: "likes",
					target: "coffee",
					confidence: 0.9,
				},
			],
		});
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough to process",
			provider,
		);

		// Only the valid entity passes
		expect(result.entities).toHaveLength(1);
		expect(result.entities[0].target).toBe("coffee");
		expect(
			result.warnings.filter((w) =>
				w.includes("Entity missing source or target"),
			),
		).toHaveLength(2);
	});

	it("returns empty + warning on provider error", async () => {
		const errorProvider: LlmProvider = {
			name: "failing",
			async generate() {
				throw new Error("connection refused");
			},
			async available() {
				return false;
			},
		};
		const result = await extractFactsAndEntities(
			"Some content that is long enough to process",
			errorProvider,
		);

		expect(result.facts).toHaveLength(0);
		expect(result.entities).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("LLM error"))).toBe(true);
	});

	it("accepts all valid memory types", async () => {
		const validTypes = [
			"fact",
			"preference",
			"decision",
			"procedural",
			"semantic",
		];
		const facts = validTypes.map((type) => ({
			content: `A fact of type ${type} that is long enough`,
			type,
			confidence: 0.8,
		}));
		const response = JSON.stringify({ facts, entities: [] });
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough to process",
			provider,
		);

		expect(result.facts).toHaveLength(validTypes.length);
		for (let i = 0; i < validTypes.length; i++) {
			expect(result.facts[i].type).toBe(validTypes[i]);
		}
		// No type-related warnings
		expect(
			result.warnings.filter((w) => w.includes("Invalid type")),
		).toHaveLength(0);
	});

	it("handles non-array facts/entities gracefully", async () => {
		const response = JSON.stringify({ facts: "not an array", entities: null });
		const provider = mockProvider([response]);
		const result = await extractFactsAndEntities(
			"Some content that is long enough to process",
			provider,
		);

		expect(result.facts).toHaveLength(0);
		expect(result.entities).toHaveLength(0);
	});
});
