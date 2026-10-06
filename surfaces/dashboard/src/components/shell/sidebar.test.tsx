import { describe, expect, it } from "bun:test";
import { TOP_LEVEL_NAV_ITEMS } from "./navigation";

describe("dashboard navigation data", () => {
	it("keeps primary views in a compact header order", () => {
		expect(TOP_LEVEL_NAV_ITEMS.map((item) => item.view)).toEqual(["home", "memory", "dreaming", "skills"]);
	});

	it("gives Dreams its own header entry while Memory opens the graph", () => {
		expect(TOP_LEVEL_NAV_ITEMS.find((item) => item.view === "dreaming")?.label).toBe("Dreams");
		expect(TOP_LEVEL_NAV_ITEMS.some((item) => item.view === "graph")).toBe(false);
	});
});
