import { describe, expect, it } from "bun:test";
import { MEMORY_NAV_ITEMS, TOP_LEVEL_NAV_ITEMS } from "./navigation";

describe("dashboard navigation data", () => {
	it("keeps primary views in a compact header order", () => {
		expect(TOP_LEVEL_NAV_ITEMS.map((item) => item.view)).toEqual(["home", "memory", "skills"]);
		expect(TOP_LEVEL_NAV_ITEMS.find((item) => item.view === "skills")?.disabled).toBe(true);
	});

	it("keeps graph and dreams inside the memory section", () => {
		expect(MEMORY_NAV_ITEMS.map((item) => item.view)).toEqual(["graph", "dreaming"]);
		expect(TOP_LEVEL_NAV_ITEMS.some((item) => item.view === "graph" || item.view === "dreaming")).toBe(false);
	});
});
