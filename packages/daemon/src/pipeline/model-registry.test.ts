import { describe, expect, it } from "bun:test";
import type { ModelRegistryEntry } from "@signet/core";
import { markDeprecatedVersions } from "./model-registry";

describe("markDeprecatedVersions", () => {
	it("marks older same-family models as deprecated", () => {
		const entries: ModelRegistryEntry[] = [
			{ id: "claude-opus-4.0", provider: "anthropic", label: "Claude Opus 4.0", tier: "high", deprecated: false },
			{ id: "claude-opus-4.6", provider: "anthropic", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		];
		const result = markDeprecatedVersions(entries);
		expect(result.find((e) => e.id === "claude-opus-4.0")?.deprecated).toBe(true);
		expect(result.find((e) => e.id === "claude-opus-4.6")?.deprecated).toBe(false);
	});

	it("does not mark unrelated models as deprecated", () => {
		const entries: ModelRegistryEntry[] = [
			{ id: "claude-opus-4.6", provider: "anthropic", label: "Claude Opus 4.6", tier: "high", deprecated: false },
			{ id: "claude-sonnet-4.0", provider: "anthropic", label: "Claude Sonnet 4.0", tier: "mid", deprecated: false },
		];
		const result = markDeprecatedVersions(entries);
		expect(result.every((e) => !e.deprecated)).toBe(true);
	});

	it("handles empty and single-entry arrays", () => {
		expect(markDeprecatedVersions([])).toEqual([]);
		const single: ModelRegistryEntry[] = [{ id: "claude-opus-4.0", provider: "anthropic", label: "Opus 4", tier: "high", deprecated: false }];
		const result = markDeprecatedVersions(single);
		expect(result[0].deprecated).toBe(false);
	});

	it("deprecates older OpenRouter-style provider/model IDs within same family", () => {
		const entries: ModelRegistryEntry[] = [
			{ id: "anthropic/claude-opus-4.0", provider: "openrouter", label: "Claude Opus 4", tier: "high", deprecated: false },
			{ id: "anthropic/claude-opus-4.6", provider: "openrouter", label: "Claude Opus 4.6", tier: "high", deprecated: false },
		];
		const result = markDeprecatedVersions(entries);
		expect(result.find((e) => e.id === "anthropic/claude-opus-4.0")?.deprecated).toBe(true);
		expect(result.find((e) => e.id === "anthropic/claude-opus-4.6")?.deprecated).toBe(false);
	});

	it("does not cross-deprecate models from different providers with similar suffixes", () => {
		const entries: ModelRegistryEntry[] = [
			{ id: "anthropic/claude-opus-4.6", provider: "openrouter", label: "Anthropic Opus", tier: "high", deprecated: false },
			{ id: "some-provider/claude-opus-4.0", provider: "openrouter", label: "Other Opus", tier: "mid", deprecated: false },
		];
		const result = markDeprecatedVersions(entries);
		expect(result.every((e) => !e.deprecated)).toBe(true);
	});
});
