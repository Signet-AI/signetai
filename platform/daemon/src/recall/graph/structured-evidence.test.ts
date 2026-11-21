import { describe, expect, it } from "bun:test";
import {
	HINT_ONLY_SCORE_CAP,
	hasDirectEvidence,
	hintQueryCoverage,
	shapeByFacetCoverage,
	shapeStructuredEvidence,
} from "./structured-evidence";

describe("hasDirectEvidence", () => {
	it("counts traversal cosine as direct evidence even without a vector-search hit", () => {
		expect(hasDirectEvidence({ semantic: 0.42 })).toBe(true);
	});

	it("counts lexical and structured evidence", () => {
		expect(hasDirectEvidence({ lexical: 0.1 })).toBe(true);
		expect(hasDirectEvidence({ structured: 0.3 })).toBe(true);
	});

	it("treats rows with only hint or traversal evidence as indirect", () => {
		expect(hasDirectEvidence({})).toBe(false);
		expect(hasDirectEvidence({ lexical: 0, semantic: 0, structured: 0 })).toBe(false);
	});
});

describe("hintQueryCoverage", () => {
	it("scores a query that restates the hint close to 1", () => {
		const coverage = hintQueryCoverage(
			"What music streaming service have I been using lately?",
			"What music streaming service has the user been using lately?",
		);
		expect(coverage).toBeGreaterThan(0.8);
	});

	it("scores a single shared generic word low", () => {
		const coverage = hintQueryCoverage("undoing a completion event lost its guard check", "check data before summary");
		expect(coverage).toBeCloseTo(1 / Math.sqrt(18), 5);
	});

	it("returns 1 when the overlap cannot be measured", () => {
		expect(hintQueryCoverage("", "check data before summary")).toBe(1);
		expect(hintQueryCoverage("the and or", "check data before summary")).toBe(1);
	});

	it("returns 0 when both sides have tokens and share none", () => {
		expect(hintQueryCoverage("check", "日本語のヒント")).toBe(0);
		expect(hintQueryCoverage("alpha beta gamma", "delta epsilon")).toBe(0);
	});

	it("counts non-ASCII tokens that FTS can match", () => {
		expect(hintQueryCoverage("alpha beta gamma тест", "тест delta")).toBeCloseTo(1 / Math.sqrt(8), 5);
		expect(hintQueryCoverage("日本語のヒント", "日本語のヒント")).toBe(1);
		expect(hintQueryCoverage("Café menu", "cafe opening")).toBeCloseTo(1 / 2, 5);
	});
});

describe("structured evidence shaping", () => {
	it("caps traversal-only candidates below anchored evidence", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "swordfish", source: "traversal", traversal: 1 },
			{ id: "commute", source: "hybrid", lexical: 0.6, semantic: 0.7, traversal: 0.3 },
		]);

		expect(shaped[0]?.id).toBe("commute");
		expect(shaped.find((row) => row.id === "swordfish")?.score).toBeLessThanOrEqual(0.35);
	});

	it("keeps admitted semantic-only candidates while dropping weak graph-only candidates", () => {
		const shaped = shapeStructuredEvidence(
			[
				{ id: "spotify", source: "vector", semantic: 0.62, structured: 0.16 },
				{ id: "anchored", source: "hybrid", lexical: 0.6, semantic: 0.5, structured: 0.3 },
				{ id: "graph-noise", source: "traversal", traversal: 0.4 },
			],
			{ minScore: 0.3 },
		);

		expect(shaped.map((row) => row.id)).toEqual(["anchored", "spotify"]);
	});

	it("lets hint evidence rescue a class-to-instance match", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "netflix", source: "hybrid", lexical: 0.85, semantic: 0.6 },
			{ id: "spotify", source: "hint", lexical: 0.35, semantic: 0.6, hint: 1 },
		]);

		expect(shaped[0]?.id).toBe("spotify");
		expect(shaped[0]?.source).toBe("hint");
	});

	it("keeps the hint-only cap when traversal relabels a hint row as sec", () => {
		const shaped = shapeStructuredEvidence([
			{ id: "hint-and-graph", source: "hint", hint: 1, traversal: 0.9 },
			{ id: "hint-and-text", source: "hybrid", lexical: 0.4, hint: 1 },
		]);

		const capped = shaped.find((row) => row.id === "hint-and-graph");
		expect(capped?.source).toBe("sec");
		expect(capped?.score).toBe(HINT_ONLY_SCORE_CAP);
		expect(shaped.find((row) => row.id === "hint-and-text")?.score).toBe(1);
	});

	it("keeps the hint-only cap when custom weights favor hints", () => {
		const shaped = shapeStructuredEvidence([{ id: "hint-and-graph", source: "hint", hint: 1, traversal: 0.9 }], {
			weights: { lexical: 0.25, semantic: 0.3, hint: 1, traversal: 0.15, structured: 0.15 },
		});

		expect(shaped[0]?.score).toBe(HINT_ONLY_SCORE_CAP);
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
