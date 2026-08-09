import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("./app.tsx", import.meta.url)).text();

describe("dashboard responsive shell", () => {
	test("keeps a vertical scroll owner for page content instead of clipping it", () => {
		expect(appSource).toMatch(/sig-content[\s\S]*overflow-y-auto[\s\S]*overflow-x-hidden/);
	});

	test("uses the opaque sidebar surface when navigation becomes a mobile drawer", () => {
		expect(appSource).toMatch(/max-md:bg-sidebar/);
	});

	test("drops mobile navigation down from the top and lets the same menu button close it", () => {
		expect(appSource).toMatch(/max-md:top-\[52px\][\s\S]*max-md:-translate-y-full[\s\S]*max-md:invisible/);
		expect(appSource).toContain("setNavOpen((open) => !open)");
	});
});
