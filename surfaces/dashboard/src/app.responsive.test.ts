import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("./app.tsx", import.meta.url)).text();

describe("dashboard responsive shell", () => {
	test("keeps a vertical scroll owner for page content instead of clipping it", () => {
		expect(appSource).toMatch(/sig-content[\s\S]*overflow-y-auto[\s\S]*overflow-x-hidden/);
	});

	test("uses the 640px mobile cutoff so constrained desktop windows retain the desktop shell", () => {
		expect(appSource).toContain("sm:grid-cols-[248px_1fr]");
		expect(appSource).toMatch(/max-sm:bg-sidebar/);
		expect(appSource).not.toContain("max-md:fixed max-md:inset-x-0");
	});

	test("drops mobile navigation down from the top and lets the same menu button close it", () => {
		expect(appSource).toMatch(/max-sm:top-\[52px\][\s\S]*max-sm:-translate-y-full[\s\S]*max-sm:invisible/);
		expect(appSource).toContain("setNavOpen((open) => !open)");
	});
});
