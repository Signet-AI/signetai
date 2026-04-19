import { describe, expect, it } from "bun:test";
import { shapeByFacetCoverage, shapeStructuredEvidence } from "./structured-evidence";

describe("structured evidence shaping", () => {
	it("caps traversal-only candidates below anchored evidence", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "swordfish", source: "traversal", traversal: 1 },
			{ id: "commute", source: "hybrid", lexical: 0.6, semantic: 0.7, traversal: 0.3 },
		]);

		expect(shaped[0]?.id).toBe("commute");
		expect(shaped.find((row) => row.id === "swordfish")?.score).toBeLessThanOrEqual(0.35);
	});

	it("lets hint evidence rescue a class-to-instance match", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "netflix", source: "hybrid", lexical: 0.85, semantic: 0.6 },
			{ id: "spotify", source: "hint", lexical: 0.35, semantic: 0.6, hint: 1 },
		]);

		expect(shaped[0]?.id).toBe("spotify");
		expect(shaped[0]?.source).toBe("hint");
	});

	it("lets structured path evidence preserve SEC ranking gains", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "social-justice", source: "hybrid", lexical: 0.56, hint: 0.73, traversal: 0.9, structured: 0.28 },
			{ id: "virtual-coffee", source: "hybrid", lexical: 0.72, traversal: 0.9, structured: 0.82 },
		]);

		expect(shaped[0]?.id).toBe("virtual-coffee");
		expect(shaped[0]?.source).toBe("sec");
	});

	it("lets strong structured-only path evidence beat generic semantic neighbors", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "generic-streaming", source: "vector", semantic: 0.82 },
			{ id: "music-platform", source: "structured", structured: 0.53 },
		]);

		expect(shaped[0]?.id).toBe("music-platform");
		expect(shaped[0]?.source).toBe("structured");
	});

	it("lets moderate structured path matches beat generic lexical advice noise", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "mountain-trip", source: "hybrid", lexical: 0.38, semantic: 0.9 },
			{ id: "virtual-coffee", source: "hybrid", semantic: 0.82, structured: 0.39 },
		]);

		expect(shaped[0]?.id).toBe("virtual-coffee");
		expect(shaped[0]?.source).toBe("sec");
	});

	it("prefers candidates that add uncovered query facets", () => {
		const candidates = shapeStructuredEvidence([
			{ id: "commute", lexical: 0.7, semantic: 0.6 },
			{ id: "commute-duplicate", lexical: 0.68, semantic: 0.6 },
			{ id: "routine", lexical: 0.62, semantic: 0.6 },
		]);
		const content = new Map([
			["commute", "daily commute to work takes thirty minutes"],
			["commute-duplicate", "work commute includes podcasts"],
			["routine", "morning routine takes one hour to get ready"],
		]);

		const shaped = shapeByFacetCoverage("get ready and commute to work", candidates, content, 3);

		expect(shaped.slice(0, 2).map((row) => row.id)).toContain("routine");
		expect(shaped.slice(0, 2).map((row) => row.id)).toContain("commute");
	});
});
