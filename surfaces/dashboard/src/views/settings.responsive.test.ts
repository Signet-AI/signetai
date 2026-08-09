import { describe, expect, test } from "bun:test";

const settingsSource = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();

describe("settings responsive layout", () => {
	test("keeps the dialog inside the viewport without a larger breakpoint override", () => {
		expect(settingsSource).toContain("w-[calc(100vw-24px)] max-w-[840px]");
		expect(settingsSource).not.toContain("w-[840px] max-w-[calc(100vw-48px)]");
		expect(settingsSource).toContain("max-h-[calc(100dvh-24px)]");
	});

	test("stacks the settings navigation and full-width controls on mobile", () => {
		expect(settingsSource).toMatch(/flex-row[\s\S]*sm:w-\[220px\][\s\S]*sm:flex-col/);
		expect(settingsSource).toContain("flex flex-col gap-2 rounded-[var(--radius)]");
		expect(settingsSource).toContain("w-full sm:w-[220px]");
	});

	test("gives the settings body a bounded vertical scroll path", () => {
		expect(settingsSource).toContain("flex min-h-0 min-w-0 flex-1 flex-col");
		expect(settingsSource).toContain("overflow-y-auto overscroll-contain");
	});
});
