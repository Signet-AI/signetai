import { describe, expect, test } from "bun:test";

const memorySource = await Bun.file(new URL("./memory.tsx", import.meta.url)).text();

describe("memory responsive layout", () => {
	test("keeps filter groups available through a mobile disclosure", () => {
		expect(memorySource).toMatch(/<details className="md:hidden/);
		expect(memorySource).toMatch(/function MemoryFilterGroups/);
	});

	test("lets the mobile feed flow through the main page scroll owner", () => {
		expect(memorySource).toMatch(/md:overflow-y-auto/);
	});
});
