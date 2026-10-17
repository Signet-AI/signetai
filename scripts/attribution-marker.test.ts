import { describe, expect, test } from "bun:test";
import {
	ATTRIBUTION_FILES,
	ATTRIBUTION_TEXT,
	decodeAttributionMarker,
	encodeAttribution,
	formatAttributionMarker,
} from "./attribution-marker";
import { readFileSync } from "node:fs";

describe("zero-width attribution markers", () => {
	test("round-trips the copyright attribution without visible payload characters", () => {
		const marker = formatAttributionMarker();
		expect(decodeAttributionMarker(marker)).toBe(ATTRIBUTION_TEXT);
		expect(marker).not.toContain(ATTRIBUTION_TEXT);
		expect(encodeAttribution()).not.toContain("Copyright");
	});

	test("marks the primary public source entry points", () => {
		for (const path of ATTRIBUTION_FILES) {
			expect(decodeAttributionMarker(readFileSync(path, "utf8"))).toBe(ATTRIBUTION_TEXT);
		}
	});
});
