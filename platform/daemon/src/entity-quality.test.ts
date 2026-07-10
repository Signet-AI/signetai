import { describe, expect, it } from "bun:test";
import { classifyEntityQuality } from "./entity-quality";

describe("entity-quality", () => {
	it("rejects standalone structural labels after Markdown normalization", () => {
		for (const name of ["Current", "**Status:**", "Status:**", "## Summary", "Result", "Update", "!!!"]) {
			expect(classifyEntityQuality(name).ok).toBe(false);
		}
	});

	it("preserves specific entity names containing structural words", () => {
		for (const name of ["Status Page", "Current Project", "Summary Report"]) {
			expect(classifyEntityQuality(name)).toEqual({ ok: true });
		}
	});

	it("allows short concrete tools and systems when the type is concrete", () => {
		for (const [name, type] of [
			["Bun", "tool"],
			["npm", "tool"],
			["Git", "tool"],
			["AWS", "system"],
			["Go", "tool"],
			["CI", "system"],
			["AI", "product"],
		] as const) {
			expect(classifyEntityQuality(name, type)).toEqual({ ok: true });
		}
	});

	it("still rejects short untyped fragments and generic scaffolding", () => {
		expect(classifyEntityQuality("50")).toEqual({ ok: false, reason: "numeric_only" });
		expect(classifyEntityQuality("cli")).toEqual({ ok: false, reason: "too_short" });
		expect(classifyEntityQuality("You", "person")).toEqual({
			ok: false,
			reason: "generic_or_scaffolding_name",
		});
		expect(classifyEntityQuality("Sender", "person")).toEqual({
			ok: false,
			reason: "generic_or_scaffolding_name",
		});
	});

	it("keeps event time and word signals behaviorally narrow", () => {
		for (const [name, expected] of [
			["Maybelline", false],
			["last banana", false],
			["Alpha 202X", false],
			["17:00", true],
			["1:00", true],
			["123:45", false],
			["2026-07-10", true],
			["last week", true],
		] as const) {
			expect(classifyEntityQuality(name, "event").ok).toBe(expected);
		}
	});
});
