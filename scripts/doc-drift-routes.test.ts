import { describe, expect, test } from "bun:test";
import { expandRoutePattern, normalizeRoutePath } from "./doc-drift-routes";

describe("route drift normalization", () => {
	test("removes parameter names but preserves parameter segment boundaries", () => {
		expect(normalizeRoutePath("/api/items/:itemId/child")).toBe("/api/items/:/child");
		expect(normalizeRoutePath("/api/items/:id/child")).toBe("/api/items/:/child");
		expect(normalizeRoutePath("/api/items/:id-child")).not.toBe(normalizeRoutePath("/api/items/:id/child"));
		expect(normalizeRoutePath("/api/sessions/:key{(?!summaries$)[^/]+}/transcript")).toBe("/api/sessions/:/transcript");
	});
	test("expands finite template expressions into real registered paths", () => {
		expect(expandRoutePattern("/api/jobs/:id/${action}", { action: ["start", "pause"] })).toEqual([
			"/api/jobs/:id/start",
			"/api/jobs/:id/pause",
		]);
	});
	test("does not invent routes for unsupported dynamic expressions", () => {
		expect(expandRoutePattern("/api/jobs/:id/${makeSuffix()}", {})).toEqual([]);
	});
});
