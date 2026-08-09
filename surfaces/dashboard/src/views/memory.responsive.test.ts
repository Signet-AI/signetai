import { describe, expect, test } from "bun:test";

const memorySource = await Bun.file(new URL("./memory.tsx", import.meta.url)).text();

describe("memory responsive layout", () => {
	test("keeps filter groups available through a strictly mobile disclosure", () => {
		expect(memorySource).toMatch(/<details className="sm:hidden/);
		expect(memorySource).toMatch(/function MemoryFilterGroups/);
	});

	test("uses a desktop scroll rail above the strictly mobile cutoff", () => {
		expect(memorySource).toMatch(/sm:overflow-y-auto/);
	});

	test("makes the right filter rail materially narrower than the memory cards", () => {
		expect(memorySource).toMatch(/memory-workspace/);
		expect(memorySource).toMatch(/sm:grid-cols-\[minmax\(0,1fr\)_152px\]/);
	});
});
