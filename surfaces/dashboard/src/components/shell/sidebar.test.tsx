import { describe, expect, it } from "bun:test";
import { ASSET_ITEMS, BASE_GROUPS, type SidebarCounts, buildSidebarAssets, buildSidebarGroups } from "./sidebar";

function allItems(): Array<{ view: string; badge?: string }> {
	return [
		...buildSidebarGroups({
			agent: 1,
			memory: 2_502,
			sources: 1,
			graph: 2_419,
			dreaming: 3,
			skills: 120,
			secrets: 2,
		}),
		...[{ label: "Assets", items: buildSidebarAssets({ skills: 120, secrets: 2 }) }],
	].flatMap((group) => group.items);
}

describe("dashboard sidebar counts", () => {
	it("renders API-derived values instead of demo badge constants", () => {
		const items = allItems();

		expect(items.find((item) => item.view === "memory")?.badge).toBe("2502");
		expect(items.find((item) => item.view === "sources")?.badge).toBe("1");
		expect(items.find((item) => item.view === "skills")?.badge).toBe("120");
		expect(items.find((item) => item.view === "graph")?.badge).toBe("2.4k");
	});

	it("uses a dash when a resource count is unavailable", () => {
		const counts: SidebarCounts = {
			agent: null,
			memory: null,
			sources: null,
			graph: null,
			dreaming: null,
			skills: null,
			secrets: null,
		};
		const items = [...buildSidebarGroups(counts).flatMap((group) => group.items), ...buildSidebarAssets(counts)];

		expect(
			items
				.filter((item) => ["memory", "sources", "graph", "dreaming", "skills", "secrets"].includes(item.view))
				.every((item) => item.badge === "-"),
		).toBe(true);
	});

	it("keeps sidebar source data free of hard-coded count badges", () => {
		const baseItems = BASE_GROUPS.flatMap((group) => group.items);

		expect(baseItems.every((item) => item.badge === undefined)).toBe(true);
		expect(ASSET_ITEMS.every((item) => item.badge === undefined)).toBe(true);
	});
});
