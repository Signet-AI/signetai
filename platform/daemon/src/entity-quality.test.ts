import { describe, expect, it } from "bun:test";
import { classifyEntityQuality } from "./entity-quality";

describe("entity-quality", () => {
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
});
